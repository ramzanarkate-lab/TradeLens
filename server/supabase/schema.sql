-- Run once in the Supabase SQL Editor.
-- TradeLens keeps its settings, signals, users and runner state as JSON documents in one key-value table.

create table if not exists public.kv_store (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Row level security ON with no policies: the public anon key can read and write nothing.
-- Only the server's service key (which bypasses RLS) can reach this table. Never put that key in the app.
alter table public.kv_store enable row level security;
