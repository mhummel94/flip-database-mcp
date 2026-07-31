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

export async function summarizeFlipMetrics(filters: SummaryFilters) {
  let query = supabase
    .from('properties')
    .select('address, city, zip, property_type, latest_transfer_date, latest_price, spread_amount, spread_pct, days_held')
    .eq('status', 'complete');

  if (filters.city) query = query.ilike('city', filters.city);
  if (filters.zip) query = query.eq('zip', filters.zip);
  if (filters.propertyType) query = query.eq('property_type', filters.propertyType);
  if (filters.sinceDate) query = query.gte('latest_transfer_date', filters.sinceDate);

  const { data, error } = await query;
  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  const rows = data ?? [];
  if (rows.length === 0) {
    return { count: 0, message: 'No matching properties found for these filters.' };
  }

  const avg = (nums: number[]) => nums.reduce((a, b) => a + b, 0) / nums.length;

  const spreadPcts = rows.map(r => r.spread_pct).filter((v): v is number => v != null);
  const spreadAmounts = rows.map(r => r.spread_amount).filter((v): v is number => v != null);
  const daysHeldVals = rows.map(r => r.days_held).filter((v): v is number => v != null);

  const topBySpreadPct = [...rows]
    .filter(r => r.spread_pct != null)
    .sort((a, b) => (b.spread_pct ?? 0) - (a.spread_pct ?? 0))
    .slice(0, 5);

  return {
    count: rows.length,
    avgSpreadPct: spreadPcts.length ? Math.round(avg(spreadPcts) * 100) / 100 : null,
    medianSpreadPct: spreadPcts.length ? Math.round(median(spreadPcts)! * 100) / 100 : null,
    avgSpreadAmount: spreadAmounts.length ? Math.round(avg(spreadAmounts)) : null,
    medianSpreadAmount: spreadAmounts.length ? Math.round(median(spreadAmounts)!) : null,
    avgDaysHeld: daysHeldVals.length ? Math.round(avg(daysHeldVals)) : null,
    medianDaysHeld: daysHeldVals.length ? Math.round(median(daysHeldVals)!) : null,
    topPerformers: topBySpreadPct.map(r => ({
      address: r.address,
      city: r.city,
      latestPrice: r.latest_price,
      spreadAmount: r.spread_amount,
      spreadPct: r.spread_pct,
      daysHeld: r.days_held,
    })),
  };
}