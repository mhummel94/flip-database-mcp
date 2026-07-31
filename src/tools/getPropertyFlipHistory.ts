import { supabase } from '../lib/supabase.js';

export async function getPropertyFlipHistory(params: { address?: string; radarId?: string }) {
  if (!params.address && !params.radarId) {
    throw new Error('Provide at least one of: address, radarId');
  }

  let query = supabase.from('properties').select('*');

  if (params.radarId) {
    query = query.eq('radar_id', params.radarId);
  } else if (params.address) {
    query = query.ilike('address', `%${params.address}%`);
  }

  const { data, error } = await query.limit(10);
  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  if (!data || data.length === 0) {
    return { found: false, message: 'No matching property found in the flip database.' };
  }

  if (data.length === 1) {
    return { found: true, property: data[0] };
  }

  // Multiple matches (ambiguous partial address) — return all so Claude/the
  // user can disambiguate rather than silently guessing.
  return { found: true, multipleMatches: true, count: data.length, properties: data };
}
