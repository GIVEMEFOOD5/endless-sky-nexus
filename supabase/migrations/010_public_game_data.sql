-- Everyone can read the game data tables (it's public game data).
-- Row Level Security stays on; this adds a "public read" rule to each.
do $$
declare t text;
begin
  foreach t in array array[
    'plugins','ships','variants','outfits','effects','ship_outfits','variant_outfits',
    'systems','planets','wormholes','galaxies','stars','governments','missions','game_events',
    'system_links','system_fleets','system_hazards','system_asteroids','system_minables',
    'system_planets','system_trade','planet_shipyards','planet_outfitters','wormhole_links','app_config',
    'attribute_definitions','attribute_flags','attribute_area_badges','attribute_nav_functions',
    'attribute_tooltips','attribute_calculations'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists "public read" on public.%I', t);
      execute format('create policy "public read" on public.%I for select using (true)', t);
      execute format('grant select on public.%I to anon, authenticated', t);
    end if;
  end loop;
end $$;
