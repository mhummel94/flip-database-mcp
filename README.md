# Flip Database MCP

A standalone MCP server exposing 3 read-only tools over your PropertyRadar
flip-tracking Supabase database (the `properties` table). Built to let
Claude answer questions and summarize data from that database directly,
independent of the Deal Analysis Tool.

## Tools

- **search_flip_database** — filtered search (city, zip, spread %, days
  held, price range) → matching rows, sorted by spread % descending
- **get_property_flip_history** — look up one property by address or
  RadarID → its full transfer history record
- **summarize_flip_metrics** — aggregate stats (avg spread %, avg days
  held, top performers) for a city/zip/date range — the "advise decisions"
  tool
- **run_sql_query** — open-ended, read-only SQL for questions the other
  3 tools can't answer: correlations (`corr(sqft, spread_pct)`), threshold/
  bucket analysis (`width_bucket(...)`), multi-dimensional grouping
  ("which areas do best with condos specifically"). Runs as a dedicated
  `flip_readonly` Postgres role with **only SELECT on `properties`** —
  no write access anywhere, enforced by the database itself, not just by
  this code. Also enforces: SELECT-only, single-statement-only, a 5-second
  timeout, and a hard 500-row cap on every query.

All four only ever **read** from the `properties` table. Nothing here
writes to it — that stays the job of the separate Python
webhook/backfill pipeline.

## Setup

### 1. Create the read-only role
In your flip-tracking Supabase project's SQL Editor, run the
`flip_readonly` role creation block from `schema.sql` (in the Python
pipeline's repo) — replace the placeholder password with a real strong
one first.

### 2. Build the read-only connection string
Supabase's Database settings → Connection string gives you the host/port
format. Swap in the `flip_readonly` role and its password:
```
postgresql://flip_readonly:YOUR_PASSWORD@YOUR_PROJECT_HOST:5432/postgres
```

### 3. Environment variables
Copy `.env.example` to `.env` locally for testing, and set the same six
in Railway's Variables tab for deployment:

| Variable | Where it comes from |
|---|---|
| `FLIP_SUPABASE_URL` | Your flip-tracking Supabase project → Settings → API |
| `FLIP_SUPABASE_SERVICE_KEY` | Same page — the **legacy `service_role`** key (not the new `sb_secret_...` format — see note below) |
| `FLIP_DB_READONLY_URL` | The connection string from step 2, using the `flip_readonly` role |
| `OAUTH_ISSUER` | Your deployed Railway URL, e.g. `https://flip-database-mcp-production.up.railway.app` |
| `JWT_SECRET` | Make up a long random string |
| `MCP_AUTH_TOKEN` | Make up another random string (a static-token fallback, same pattern as deal-analysis-mcp) |

**Important:** use the **legacy `service_role` key**, not the new-format
`sb_secret_...` key. The same library-compatibility issue we hit on the
Python webhook service applies here too — the installed `@supabase/supabase-js`
version may not yet support the new key format cleanly.

### 4. Local dev
```
npm install
npm run dev
```

### 5. Deploy to Railway
Same pattern as deal-analysis-mcp: connect this repo, Railway auto-detects
the Dockerfile, set the environment variables above, generate a public
domain.

### 6. Connect it to Claude
Once deployed, add it as a new connector in Claude using its URL:
```
https://your-app-name.up.railway.app/mcp
```
Claude will walk through the OAuth flow automatically (dynamic client
registration → authorize → token) — same mechanism already proven working
with the Deal Analysis Tool connector.

## Notes on future integration

If you later want these same 3 tools available *inside* the Deal
Analysis Tool as well (for cross-referencing during comp analysis), the
query logic in `src/tools/*.ts` here is written as plain, dependency-free
functions — they can be copied into `deal-analysis-mcp`'s `src/tools/`
folder with only the Supabase client import changed to point at this
project's credentials (registered there under different env var names,
e.g. `FLIP_SUPABASE_URL`, so it never collides with that project's
existing `SUPABASE_URL` used for `deal_analyses`).
