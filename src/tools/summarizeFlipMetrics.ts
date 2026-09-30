import { supabase } from '../lib/supabase.js';

export interface SummaryFilters {
  city?: string;
  zip?: string;
  propertyType?: string; // e.g. 'SFR', 'CND' — matches the `property_type` column exactly
  sinceDate?: string; // filters on latest_transfer_date >=
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

const COLUMNS =
  'address, city, zip, property_type, latest_transfer_date, latest_price, spread_amount, spread_pct, days_held, ' +
  'days_on_market, list_to_sold_ratio, mls_status';

// Supabase caps every request at 1000 rows, so page through all matches —
// otherwise summaries silently cover only the first 1000 properties.
async function fetchAllRows(filters: SummaryFilters) {
  const PAGE = 1000;
  const rows: any[] = [];
  for (let start = 0; ; start += PAGE) {
    let query = supabase.from('properties').select(COLUMNS).eq('status', 'complete');
    if (filters.city) query = query.ilike('city', filters.city);
    if (filters.zip) query = query.eq('zip', filters.zip);
    if (filters.propertyType) query = query.eq('property_type', filters.propertyType);
    if (filters.sinceDate) query = query.gte('latest_transfer_date', filters.sinceDate);

    const { data, error } = await query.order('radar_id').range(start, start + PAGE - 1);
    if (error) throw new Error(`Supabase query failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

export async function summarizeFlipMetrics(filters: SummaryFilters) {
  const rows = await fetchAllRows(filters);
  if (rows.length === 0) {
    return { count: 0, message: 'No matching properties found for these filters.' };
  }

  const avg = (nums: number[]) => nums.reduce((a, b) => a + b, 0) / nums.length;
  const nums = (key: string) =>
    rows.map(r => r[key]).filter((v): v is number => v != null).map(Number);

  const spreadPcts = nums('spread_pct');
  const spreadAmounts = nums('spread_amount');
  const daysHeldVals = nums('days_held');
  const domVals = nums('days_on_market');
  const lsVals = nums('list_to_sold_ratio');

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const round4 = (n: number) => Math.round(n * 10000) / 10000;

  const topBySpreadPct = [...rows]
    .filter(r => r.spread_pct != null)
    .sort((a, b) => (b.spread_pct ?? 0) - (a.spread_pct ?? 0))
    .slice(0, 5);

  return {
    count: rows.length,
    avgSpreadPct: spreadPcts.length ? round2(avg(spreadPcts)) : null,
    medianSpreadPct: spreadPcts.length ? round2(median(spreadPcts)!) : null,
    avgSpreadAmount: spreadAmounts.length ? Math.round(avg(spreadAmounts)) : null,
    medianSpreadAmount: spreadAmounts.length ? Math.round(median(spreadAmounts)!) : null,
    avgDaysHeld: daysHeldVals.length ? Math.round(avg(daysHeldVals)) : null,
    medianDaysHeld: daysHeldVals.length ? Math.round(median(daysHeldVals)!) : null,
    // MLS resale metrics — only rows matched to an MLS listing contribute
    offMarketSaleCount: rows.filter(r => r.mls_status === 'off_market_sale').length,
    // daysOnMarket = listed -> closed (includes escrow), not MLS-standard DOM
    avgDaysOnMarket: domVals.length ? Math.round(avg(domVals)) : null,
    medianDaysOnMarket: domVals.length ? Math.round(median(domVals)!) : null,
    avgListToSoldRatio: lsVals.length ? round4(avg(lsVals)) : null,
    medianListToSoldRatio: lsVals.length ? round4(median(lsVals)!) : null,
    topPerformers: topBySpreadPct.map(r => ({
      address: r.address,
      city: r.city,
      latestPrice: r.latest_price,
      spreadAmount: r.spread_amount,
      spreadPct: r.spread_pct,
      daysHeld: r.days_held,
      daysOnMarket: r.days_on_market,
      listToSoldRatio: r.list_to_sold_ratio,
    })),
  };
}