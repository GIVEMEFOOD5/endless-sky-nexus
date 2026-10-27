-- ═══════════════════════════════════════════════════════════════════════════
--  client_errors — errors that happen in visitors' browsers (errorReporter.js)
--
--  Run once in the Supabase SQL editor. Safe to run again.
--  • Anyone (logged in or not) can ADD an error report — nothing else.
--  • Only admins (is_admin(), from user_management.sql) can read or delete them.
--  • No personal data: the page, the error, the browser type and the site
--    version. If someone is logged in, their user id is attached so you can
--    ask them about it; it's never shown publicly.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.client_errors (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  page        text,
  message     text not null,
  source      text,
  line        int,
  col         int,
  stack       text,
  user_agent  text,
  url         text,
  kind        text,                       -- 'error' | 'promise' | 'console'
  user_id     uuid default auth.uid()
);
create index if not exists client_errors_created_idx on public.client_errors (created_at desc);

alter table public.client_errors enable row level security;

drop policy if exists "anyone can report an error" on public.client_errors;
create policy "anyone can report an error" on public.client_errors
  for insert to anon, authenticated
  with check (
    char_length(message) <= 2000
    and coalesce(char_length(stack), 0) <= 8000
    and coalesce(char_length(page), 0) <= 200
    and coalesce(char_length(url), 0) <= 2000
    and coalesce(char_length(user_agent), 0) <= 500
    and (user_id is null or user_id = auth.uid())
  );

drop policy if exists "admins read errors" on public.client_errors;
create policy "admins read errors" on public.client_errors
  for select to authenticated using (public.is_admin());

drop policy if exists "admins delete errors" on public.client_errors;
create policy "admins delete errors" on public.client_errors
  for delete to authenticated using (public.is_admin());

-- Keep it tidy: anything older than 60 days can be cleared with
--   delete from public.client_errors where created_at < now() - interval '60 days';

-- Handy view: the most common errors this week
create or replace view public.client_errors_summary
with (security_invoker = true) as
select message, page, count(*) as times, max(created_at) as last_seen, min(created_at) as first_seen
from public.client_errors
where created_at > now() - interval '7 days'
group by message, page
order by times desc;

-- the website adds reports; admins read them (newer Supabase projects need this spelled out)
grant insert          on public.client_errors         to anon, authenticated;
grant select, delete  on public.client_errors         to authenticated;
grant select          on public.client_errors_summary to authenticated;
grant usage, select on sequence public.client_errors_id_seq to anon, authenticated;
notify pgrst, 'reload schema';
