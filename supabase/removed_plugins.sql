-- ═══════════════════════════════════════════════════════════════════════════
--  removed_plugins.sql — run once in the Supabase SQL editor
--
--  When a plugin is taken out of plugins.json (or disappears from its
--  repository) the parser now deletes all of its game data. These tables
--  remember what was removed, so people whose ships use it can see what's
--  missing and how to get it back.
-- ═══════════════════════════════════════════════════════════════════════════

-- One row per removed plugin. Deleted again automatically if the plugin is
-- ever re-added.
create table if not exists public.removed_plugins (
  plugin_id    text primary key,          -- e.g. "Midnight Expansion/Midnight-Expansion"
  output_name  text,                      -- folder name the site used for it
  display_name text,
  source_name  text,                      -- the plugins.json entry it came from
  repository   text,                      -- where it can be found
  removed_at   timestamptz not null default now()
);
alter table public.removed_plugins enable row level security;
drop policy if exists "removed plugins are public" on public.removed_plugins;
create policy "removed plugins are public" on public.removed_plugins for select using (true);

-- Shared ships that use a removed plugin. Kept in its own table so flagging
-- a ship never changes the ship itself (or its "updated" date).
create table if not exists public.saved_ship_plugin_flags (
  saved_ship_id text primary key,
  user_id       uuid,
  missing       jsonb not null,           -- [{plugin_id, display_name, repository, removed_at, uses: [names]}]
  flagged_at    timestamptz not null default now()
);
alter table public.saved_ship_plugin_flags enable row level security;
drop policy if exists "ship flags are public" on public.saved_ship_plugin_flags;
create policy "ship flags are public" on public.saved_ship_plugin_flags for select using (true);

-- Fleets (private) that contain ships using a removed plugin.
create table if not exists public.fleet_plugin_flags (
  fleet_id   text primary key,
  user_id    uuid not null,
  missing    jsonb not null,              -- [{plugin_id, display_name, repository, removed_at, ships: [names], uses: [names]}]
  flagged_at timestamptz not null default now()
);
alter table public.fleet_plugin_flags enable row level security;
drop policy if exists "own fleet flags" on public.fleet_plugin_flags;
create policy "own fleet flags" on public.fleet_plugin_flags for select using (user_id = (select auth.uid()));

-- Make sure deleting a removed plugin's ships doesn't fail on other plugins'
-- variants that were based on them (they just lose the link).
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.variants'::regclass and contype = 'f'
     and pg_get_constraintdef(oid) like '%(base_ship_id)%';
  if c is not null then
    execute format('alter table public.variants drop constraint %I', c);
    alter table public.variants add constraint variants_base_ship_id_fkey
      foreign key (base_ship_id) references public.ships(id) on delete set null;
  end if;
end $$;

-- the website reads these (newer Supabase projects need this spelled out)
grant select on public.removed_plugins          to anon, authenticated;
grant select on public.saved_ship_plugin_flags  to anon, authenticated;
grant select on public.fleet_plugin_flags       to authenticated;
