import { supabase } from '../lib/supabase.js';

export interface SearchFilters {
  city?: string;
  zip?: string;
  minSpreadPct?: number;
  maxDaysHeld?: number;
  minLatestPrice?: number;
  maxLatestPrice?: number;
  limit?: number;
}

export async function searchFlipDatabase(filters: SearchFilters) {
  let query = supabase
    .from('properties')
    .select('*')
    .eq('status', 'complete'); // only rows with a real latest+prior transfer pair

  if (filters.city) query = query.ilike('city', filters.city);
  if (filters.zip) query = query.eq('zip', filters.zip);
  if (filters.minSpreadPct !== undefined) query = query.gte('spread_pct', filters.minSpreadPct);
  if (filters.maxDaysHeld !== undefined) query = query.lte('days_held', filters.maxDaysHeld);
  if (filters.minLatestPrice !== undefined) query = query.gte('latest_price', filters.minLatestPrice);
  if (filters.maxLatestPrice !== undefined) query = query.lte('latest_price', filters.maxLatestPrice);

  query = query.order('spread_pct', { ascending: false }).limit(filters.limit ?? 25);

  const { data, error } = await query;
  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  return {
    count: data?.length ?? 0,
    results: data ?? [],
  };
}
