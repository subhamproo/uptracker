-- =============================================
-- UPTRACKER — Supabase Database Schema
-- Run this in: Supabase Dashboard → SQL Editor
-- =============================================

-- 1. SITES table — stores all monitored websites
create table if not exists sites (
  id           text primary key,
  name         text not null,
  url          text not null,
  interval     integer not null default 30,
  webhook_url  text default '',
  alert_mode   text default 'offline',
  added_at     timestamptz default now(),
  updated_at   timestamptz default now()
);

-- 2. CHECKS table — every single check result (1 year retention)
create table if not exists checks (
  id          bigserial primary key,
  site_id     text not null references sites(id) on delete cascade,
  status      text not null,        -- 'up' | 'down'
  response_ms integer,
  status_code integer,
  checked_at  timestamptz default now()
);

-- 3. INCIDENTS table — status change events only
create table if not exists incidents (
  id          bigserial primary key,
  site_id     text not null references sites(id) on delete cascade,
  status      text not null,        -- 'up' | 'down'
  response_ms integer,
  status_code integer,
  event       text not null,
  occurred_at timestamptz default now()
);

-- Indexes for fast queries
create index if not exists idx_checks_site_time    on checks(site_id, checked_at desc);
create index if not exists idx_incidents_site_time on incidents(site_id, occurred_at desc);

-- Row Level Security — allow anonymous read/write (public dashboard)
alter table sites    enable row level security;
alter table checks   enable row level security;
alter table incidents enable row level security;

create policy "public_all_sites"     on sites     for all using (true) with check (true);
create policy "public_all_checks"    on checks    for all using (true) with check (true);
create policy "public_all_incidents" on incidents for all using (true) with check (true);

-- Auto-cleanup: delete checks older than 1 year (run as a cron job in Supabase)
-- You can enable pg_cron in Supabase Dashboard → Database → Extensions
-- select cron.schedule('cleanup-old-checks', '0 0 * * *', $$
--   delete from checks where checked_at < now() - interval '1 year';
-- $$);
