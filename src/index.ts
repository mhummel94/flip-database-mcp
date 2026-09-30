import 'dotenv/config';
import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import oauthRouter from './oauth.js';
import { searchFlipDatabase } from './tools/searchFlipDatabase.js';
import { getPropertyFlipHistory } from './tools/getPropertyFlipHistory.js';
import { summarizeFlipMetrics } from './tools/summarizeFlipMetrics.js';
import { runSqlQuery } from './tools/runSqlQuery.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'flip-database-mcp' });
});

// ─── OAuth Routes ─────────────────────────────────────────────────────────────
app.use(oauthRouter);

// ─── Auth Middleware ──────────────────────────────────────────────────────────
app.use('/mcp', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="${process.env.OAUTH_ISSUER}", ` +
      `resource_metadata_uri="${process.env.OAUTH_ISSUER}/.well-known/oauth-authorization-server"`
    );
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.replace('Bearer ', '');

  if (token === process.env.MCP_AUTH_TOKEN) {
    next();
    return;
  }

  try {
    jwt.verify(token, process.env.JWT_SECRET!, {
      issuer: process.env.OAUTH_ISSUER!,
    });
    next();
  } catch {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="${process.env.OAUTH_ISSUER}", ` +
      `resource_metadata_uri="${process.env.OAUTH_ISSUER}/.well-known/oauth-authorization-server"`
    );
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// ─── Tool Registration ────────────────────────────────────────────────────────
function registerTools(server: McpServer) {

  // ── 1. Search Flip Database ─────────────────────────────────────────────────
  server.tool(
    'search_flip_database',
    {
      city: z.string().optional().describe('Filter by city name'),
      zip: z.string().optional().describe('Filter by ZIP code'),
      minSpreadPct: z.number().optional().describe('Minimum spread percentage between prior and latest sale'),
      maxDaysHeld: z.number().optional().describe('Maximum days between prior and latest sale'),
      minLatestPrice: z.number().optional().describe('Minimum latest sale price'),
      maxLatestPrice: z.number().optional().describe('Maximum latest sale price'),
      maxDaysOnMarket: z.number().optional().describe('Maximum days on market (listed to closed, includes escrow)'),
      minListToSoldRatio: z.number().optional().describe('Minimum list-to-sold ratio as a decimal, e.g. 0.98 = sold at 98% of highest list price'),
      limit: z.number().optional().describe('Max results to return (default 25)'),
    },
    async (filters) => {
      try {
        const result = await searchFlipDatabase(filters);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`search_flip_database error: ${message}`);
        return {
          content: [{ type: 'text', text: `Error searching flip database: ${message}` }],
        };
      }
    }
  );

  // ── 2. Get Property Flip History ────────────────────────────────────────────
  server.tool(
    'get_property_flip_history',
    {
      address: z.string().optional().describe('Street address (partial match supported)'),
      radarId: z.string().optional().describe('PropertyRadar RadarID, if known'),
    },
    async (params) => {
      try {
        const result = await getPropertyFlipHistory(params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`get_property_flip_history error: ${message}`);
        return {
          content: [{ type: 'text', text: `Error looking up property: ${message}` }],
        };
      }
    }
  );

  // ── 3. Summarize Flip Metrics ───────────────────────────────────────────────
  server.tool(
    'summarize_flip_metrics',
    {
      city: z.string().optional().describe('Filter by city name'),
      zip: z.string().optional().describe('Filter by ZIP code'),
      propertyType: z.string().optional().describe("Filter by property type, e.g. 'SFR' or 'CND' — omit to include all types"),
      sinceDate: z.string().optional().describe('Only include sales on/after this date (YYYY-MM-DD)'),
    },
    async (filters) => {
      try {
        const result = await summarizeFlipMetrics(filters);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`summarize_flip_metrics error: ${message}`);
        return {
          content: [{ type: 'text', text: `Error summarizing flip metrics: ${message}` }],
        };
      }
    }
  );

  // ── 4. Run SQL Query ────────────────────────────────────────────────────────
  // Read-only, SELECT-only access for open-ended statistical questions that
  // the other 3 tools can't answer (correlations, threshold/bucket analysis,
  // multi-dimensional grouping). Runs against a dedicated `flip_readonly`
  // Postgres role with ONLY SELECT on `properties` and `mls_listings` — no write access
  // anywhere, enforced at the database level, not just in this code.
  server.tool(
    'run_sql_query',
    {
      query: z.string().describe(
        'A single read-only SQL SELECT statement (Postgres syntax) against the `properties` and `mls_listings` tables. ' +
        'Only SELECT is allowed — no INSERT/UPDATE/DELETE, no multiple statements. ' +
        'A LIMIT 500 is always enforced automatically, even if your query doesn\'t include one.\n\n' +
        'Table schema (properties):\n' +
        '  radar_id text, address text, city text, state text, zip text,\n' +
        '  property_type text, sqft numeric, lot_sqft numeric, year_built numeric,\n' +
        '  beds numeric, baths numeric, stories numeric, garage numeric, pool text,\n' +
        '  latest_transfer_date date, latest_price numeric, latest_seller text, latest_buyer text,\n' +
        '  prior_transfer_date date, prior_price numeric, prior_seller text, prior_buyer text,\n' +
        '  spread_amount numeric, spread_pct numeric, days_held integer,\n' +
        '  status text (filter to status = \'complete\' for rows with a real spread to analyze),\n' +
        '  created_at timestamptz, updated_at timestamptz,\n' +
        '  apn text (PropertyRadar format, e.g. 157-791-64-00), apn_digits text (digits only; matches MLS ParcelNumber),\n' +
        '  -- MLS resale metrics (the flipper\'s renovated listing; relists within 30 days are merged into one timeline):\n' +
        '  days_on_market integer, dom_source text (\'cumulative\' = MLS CumulativeDaysOnMarket, \'computed\' = OnMarketDate->PurchaseContractDate),\n' +
        '  mls_cdom integer, dom_computed integer, mls_highest_list_price numeric (max OriginalListPrice in the chain),\n' +
        '  mls_close_price numeric, list_to_sold_ratio numeric (close / highest list, e.g. 0.9812),\n' +
        '  mls_listing_count integer (1 = no relist), mls_listing_keys text[], mls_first_on_market date,\n' +
        '  mls_contract_date date, mls_close_date date,\n' +
        '  mls_status text (filter to mls_status = \'matched\' for rows with MLS metrics), mls_checked_at timestamptz.\n\n' +
        'Table schema (mls_listings) — raw MLS records per property, including ones NOT merged into the chain; join on radar_id:\n' +
        '  radar_id text, listing_key text, listing_id text, parcel_number text, standard_status text,\n' +
        '  on_market_date date, off_market_date date, purchase_contract_date date, close_date date,\n' +
        '  original_list_price numeric, list_price numeric, close_price numeric,\n' +
        '  cumulative_days_on_market integer, days_on_market integer (these two are the MLS\'s own per-listing counts, NOT our DOM),\n' +
        '  in_chain boolean (true = merged into the resale timeline), raw jsonb, fetched_at timestamptz.\n\n' +
        'Postgres has built-in corr(x, y) for correlation and width_bucket() for threshold/bucket analysis — ' +
        'both work well for questions like "does sqft or bedroom count correlate more with spread_pct", ' +
        '"does list_to_sold_ratio drop when days_on_market is long", or ' +
        '"is there a sqft threshold with notably better ROI".'
      ),
    },
    async ({ query }) => {
      try {
        const result = await runSqlQuery(query);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`run_sql_query error: ${message}`);
        return {
          content: [{ type: 'text', text: `Error running query: ${message}` }],
        };
      }
    }
  );
}

// ─── Session Store ────────────────────────────────────────────────────────────
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

async function handleMcp(req: Request, res: Response) {
  req.headers.accept = 'application/json';

  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  const newSessionId = randomUUID();
  const server = new McpServer({ name: 'flip-database', version: '1.0.0' });
  registerTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
    enableJsonResponse: true,
  });

  sessions.set(newSessionId, { server, transport });
  console.error(`Session created: ${newSessionId}`);

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

app.get('/mcp', handleMcp);
app.post('/mcp', handleMcp);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.error(`Flip Database MCP server running on port ${PORT}`);
});