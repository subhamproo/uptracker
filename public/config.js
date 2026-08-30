/* =============================================
   UPTRACKER — Supabase Configuration
   
   HOW TO SET UP (5 minutes, free):
   1. Go to https://supabase.com → New project (free)
   2. Go to SQL Editor → paste contents of supabase_schema.sql → Run
   3. Go to Settings → API → copy Project URL and anon public key
   4. Paste them below and save
   ============================================= */

window.UPTRACKER_CONFIG = {
  // Your Supabase project URL
  // e.g. https://xyzxyzxyz.supabase.co
  SUPABASE_URL: 'YOUR_SUPABASE_URL',

  // Your Supabase anon/public key (safe to expose — RLS protects data)
  // Found at: Supabase Dashboard → Settings → API → anon public
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY',
};
