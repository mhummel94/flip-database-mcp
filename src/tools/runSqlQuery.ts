import { Pool } from 'pg';

// Uses a DIRECT Postgres connection (not the Supabase JS client, which
// can't run arbitrary SQL) — authenticated as the `flip_readonly` role
// created in schema.sql (+ migration 001), which has ONLY SELECT on `properties`
// and `mls_listings` and
// nothing else. That database-level restriction is the real safety net;
// everything below is a second, defense-in-depth layer on top of it.

const pool = new Pool({
  connectionString: process.env.FLIP_DB_READONLY_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

const MAX_ROWS = 500;
const STATEMENT_TIMEOUT_MS = 5000;

export async function runSqlQuery(query: string) {
  const trimmed = query.trim();

  if (!/^select\b/i.test(trimmed)) {
    throw new Error('Only SELECT queries are allowed.');
  }

  // Block stacked statements (e.g. "SELECT ...; DROP ...") — allow at most
  // one trailing semicolon, reject any semicolon before that.
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw new Error('Multiple statements are not allowed — submit one SELECT query at a time.');
  }

  // Wrap in an outer query with a hard LIMIT, regardless of whether the
  // inner query already has one — guarantees a row cap either way.
  const wrapped = `SELECT * FROM (${withoutTrailingSemicolon}) AS user_query LIMIT ${MAX_ROWS}`;

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const result = await client.query(wrapped);
    return {
      rowCount: result.rowCount,
      truncated: result.rowCount === MAX_ROWS,
      rows: result.rows,
    };
  } finally {
    client.release();
  }
}