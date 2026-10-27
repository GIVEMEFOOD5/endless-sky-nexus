-- Lets the website read (and, for error reports, add to) the tables the newer
-- SQL files created. Newer Supabase projects don't do this automatically, which
-- shows up as "403 (Forbidden)". Safe to run more than once.
-- Row Level Security still decides WHICH rows each person can see.

-- removed plugins (removed_plugins.sql): public lists
grant select on public.removed_plugins          to anon, authenticated;
grant select on public.saved_ship_plugin_flags  to anon, authenticated;
grant select on public.fleet_plugin_flags       to authenticated;

-- site error reports (client_errors.sql): anyone can add, only admins can read/delete
grant insert          on public.client_errors         to anon, authenticated;
grant select, delete  on public.client_errors         to authenticated;
grant select          on public.client_errors_summary to authenticated;
grant usage, select on sequence public.client_errors_id_seq to anon, authenticated;

-- tell the API about the change straight away
notify pgrst, 'reload schema';
