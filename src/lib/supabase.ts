import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// Points at the flip-tracking Supabase project — a DIFFERENT project than
// the one deal-analysis-mcp uses for its `deal_analyses` table. Uses its
// own env var names (FLIP_SUPABASE_*) specifically so this can never be
// confused with, or accidentally overwrite, the other project's credentials
// if these two services ever share an environment.
export const supabase = createClient(
  process.env.FLIP_SUPABASE_URL!,
  process.env.FLIP_SUPABASE_SERVICE_KEY!
);
