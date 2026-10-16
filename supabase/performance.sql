-- ═══════════════════════════════════════════════════════════════════════════
--  performance.sql — makes the site load much faster. Run once in the
--  Supabase SQL editor (safe to run again after any parser change).
--
--  1. Indexes on the columns every page filters or joins on.
--  2. get_plugin_catalog(plugin) — a plugin's ships, variants, outfits,
--     effects and their outfit lists in ONE request (was 8–15 requests).
--  3. get_plugin_map(plugin) — a plugin's whole map (systems, planets, jump
--     links, fleets, trade …) in ONE request (was ~90 requests).
--
--  The site checks for these functions and quietly uses the old way if they
--  aren't installed, so nothing breaks before or after running this.
--  Both functions run with the visitor's own permissions (security invoker),
--  so they can only return what the public can already read.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Indexes ──────────────────────────────────────────────────────────────
do $$
declare spec text[];
begin
  foreach spec slice 1 in array array[
    array['ships','plugin_id, id'], array['variants','plugin_id, id'], array['outfits','plugin_id, id'],
    array['effects','plugin_id, id'], array['missions','plugin_id, id'], array['systems','plugin_id, id'],
    array['planets','plugin_id, id'], array['galaxies','plugin_id, id'], array['wormholes','plugin_id, id'],
    array['stars','plugin_id, id'], array['governments','plugin_id, id'], array['game_events','plugin_id, id'],
    array['ship_outfits','ship_id'], array['variant_outfits','variant_id'],
    array['system_links','system_id'], array['system_fleets','system_id'], array['system_hazards','system_id'],
    array['system_asteroids','system_id'], array['system_minables','system_id'], array['system_planets','system_id'],
    array['system_trade','system_id'], array['wormhole_links','wormhole_id'],
    array['planet_shipyards','planet_id'], array['planet_outfitters','planet_id'],
    array['plugins','output_name']
  ] loop
    if to_regclass('public.' || spec[1]) is not null then
      execute format('create index if not exists %I on public.%I (%s)',
                     spec[1] || '_' || replace(replace(spec[2], ', ', '_'), ' ', '') || '_idx', spec[1], spec[2]);
    end if;
  end loop;
end $$;

-- ── 2. One plugin's catalog in one request ──────────────────────────────────
create or replace function public.get_plugin_catalog(p_plugin_id text)
returns jsonb
language sql stable security invoker
set search_path = public
as $$
  with s  as (select * from ships    where plugin_id = p_plugin_id),
       v  as (select * from variants where plugin_id = p_plugin_id),
       o  as (select * from outfits  where plugin_id = p_plugin_id),
       e  as (select * from effects  where plugin_id = p_plugin_id),
       so as (select x.* from ship_outfits    x where x.ship_id    in (select id from s)),
       vo as (select x.* from variant_outfits x where x.variant_id in (select id from v)),
       xo as (select y.* from outfits y
              where y.id in (select outfit_id from so union select outfit_id from vo)
                and y.plugin_id is distinct from p_plugin_id)
  select jsonb_build_object(
    'ships',           coalesce((select jsonb_agg(to_jsonb(s)  order by s.id)  from s),  '[]'::jsonb),
    'variants',        coalesce((select jsonb_agg(to_jsonb(v)  order by v.id)  from v),  '[]'::jsonb),
    'outfits',         coalesce((select jsonb_agg(to_jsonb(o)  order by o.id)  from o),  '[]'::jsonb),
    'effects',         coalesce((select jsonb_agg(to_jsonb(e)  order by e.id)  from e),  '[]'::jsonb),
    'ship_outfits',    coalesce((select jsonb_agg(to_jsonb(so)) from so), '[]'::jsonb),
    'variant_outfits', coalesce((select jsonb_agg(to_jsonb(vo)) from vo), '[]'::jsonb),
    'extra_outfits',   coalesce((select jsonb_agg(to_jsonb(xo)) from xo), '[]'::jsonb)
  );
$$;

-- ── 3. One plugin's map in one request ──────────────────────────────────────
create or replace function public.get_plugin_map(p_plugin_id text)
returns jsonb
language sql stable security invoker
set search_path = public
as $$
  with sy as (select * from systems   where plugin_id = p_plugin_id),
       wh as (select * from wormholes where plugin_id = p_plugin_id),
       mi as (select * from missions  where plugin_id = p_plugin_id)
  select jsonb_build_object(
    'systems',     coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from sy x), '[]'::jsonb),
    'galaxies',    coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from galaxies x    where x.plugin_id = p_plugin_id), '[]'::jsonb),
    'wormholes',   coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from wh x), '[]'::jsonb),
    'planets',     coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from planets x     where x.plugin_id = p_plugin_id), '[]'::jsonb),
    'stars',       coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from stars x       where x.plugin_id = p_plugin_id), '[]'::jsonb),
    'governments', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from governments x where x.plugin_id = p_plugin_id), '[]'::jsonb),
    -- missions without their big parts (the map doesn't need them) …
    'missions',    coalesce((select jsonb_agg(to_jsonb(x) - 'raw' - 'conditions' - 'condition_side_effects' - 'description' order by x.id) from mi x), '[]'::jsonb),
    -- … except the raw tree of missions that trigger story events (for the timeline)
    'mission_raws', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'raw', x.raw)) from mi x
                              where jsonb_typeof(x.event_triggers) = 'array' and jsonb_array_length(x.event_triggers) > 0), '[]'::jsonb),
    'system_links',     coalesce((select jsonb_agg(to_jsonb(x)) from system_links x     where x.system_id in (select id from sy)), '[]'::jsonb),
    'system_fleets',    coalesce((select jsonb_agg(to_jsonb(x)) from system_fleets x    where x.system_id in (select id from sy)), '[]'::jsonb),
    'system_hazards',   coalesce((select jsonb_agg(to_jsonb(x)) from system_hazards x   where x.system_id in (select id from sy)), '[]'::jsonb),
    'system_asteroids', coalesce((select jsonb_agg(to_jsonb(x)) from system_asteroids x where x.system_id in (select id from sy)), '[]'::jsonb),
    'system_minables',  coalesce((select jsonb_agg(to_jsonb(x)) from system_minables x  where x.system_id in (select id from sy)), '[]'::jsonb),
    'system_planets',   coalesce((select jsonb_agg(to_jsonb(x)) from system_planets x   where x.system_id in (select id from sy)), '[]'::jsonb),
    'system_trade',     coalesce((select jsonb_agg(to_jsonb(x)) from system_trade x     where x.system_id in (select id from sy)), '[]'::jsonb),
    'wormhole_links',   coalesce((select jsonb_agg(to_jsonb(x)) from wormhole_links x   where x.wormhole_id in (select id from wh)), '[]'::jsonb)
  );
$$;

grant execute on function public.get_plugin_catalog(text) to anon, authenticated;
grant execute on function public.get_plugin_map(text)     to anon, authenticated;

-- Big plugins (e.g. Galactic War's 2,400 systems) can take a moment to
-- package; give these two calls more time than the default for visitors.
alter function public.get_plugin_catalog(text) set statement_timeout = '20s';
alter function public.get_plugin_map(text)     set statement_timeout = '20s';
