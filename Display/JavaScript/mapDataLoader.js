'use strict';

// ═══════════════════════════════════════════════════════════
//  mapDataLoader.js  —  Endless Sky Ship Builder / Systems Map
//
//  STAGE 1 of the map pipeline: GRAB THE DATA, PUSH IT FORWARD.
//  This file's only job is fetching raw map data (systems /
//  galaxies / wormholes / planets / missions / stars) per plugin and
//  handing it, unmodified, to whoever asks for it. It does NOT
//  reshape, merge, or compute anything — see mapDataFormatter.js
//  for that.
//
//  Mirrors dataLoader.js's plugin-discovery pattern (data/index.json)
//  so the Systems page lists exactly the same plugins as every other
//  page, but only downloads the (large) map files for plugins that
//  are actually active — ships/outfits/effects are never touched here.
//
//  LOCAL HOST SUPPORT
//  -------------------
//  When this page is served from localhost/127.0.0.1/file-relative
//  dev servers, data is read from the repo's own `data/` folder
//  (two levels up from Display/HTML) instead of GitHub raw. This
//  means local edits to data/*.json show up immediately without
//  waiting on a commit + the monthly Action, and the page still
//  works with no network access at all. Anywhere else (GitHub Pages,
//  production) it falls back to raw.githubusercontent.com, same as
//  dataLoader.js.
//
//  SLIM FILES (forward-compatible)
//  --------------------------------
//  Full `systems.json` / `planets.json` / `missions.json` files can
//  be tens of megabytes (they carry the entire objectTree,
//  descriptions, conversation text, etc. — none of which the map
//  needs). This loader always tries a slim companion file first:
//      dataFiles/systemsMap.json   →  [{name,pos,government,links,attributes}, ...]
//      dataFiles/galaxiesMap.json  →  [{name,pos,sprite}, ...]
//      dataFiles/planetsMap.json   →  [{name,systemName,government,hasSpaceport,
//                                        hasShipyard,hasOutfitter,wormhole}, ...]
//      dataFiles/missionsMap.json  →  [{name,displayName,locations,repeatable,
//                                        payment,source}, ...]
//  and transparently falls back to the full `systems.json` /
//  `galaxies.json` / `planets.json` / `missions.json` if the slim
//  file doesn't exist (404). If the parser is ever updated to emit
//  these slim files (recommended — see this repo's README), every
//  page using this loader gets the bandwidth win for free, no code
//  changes needed elsewhere.
//
//  Public API on window.MapDataLoader:
//    .discoverPlugins()            → Promise<{sourceName: [{outputName, displayPluginName}]}>
//    .loadPlugins(outputNames)     → Promise<Map<outputName, RawPluginMapData>>
//    .getCached(outputName)        → RawPluginMapData | null
//    .isCached(outputName)         → boolean
//    .clearCache()                 → drop everything and refetch next time
//
//  RawPluginMapData shape:
//    { outputName, sourceName, displayName,
//      systems: [...], galaxies: [...], wormholes: [...], planets: [...],
//      missions: [...], stars: [...], governments: [...],
//      slim: boolean }   // true if the slim map files were used
//
//  Custom events fired on document:
//    'mapDataLoadStart'   { detail: { outputNames } }
//    'mapPluginLoaded'    { detail: { outputName, index, total } }
//    'mapPluginLoadError' { detail: { outputName, message } }
//    'mapDataLoadEnd'     { detail: { loaded: [outputName, ...] } }
// ═══════════════════════════════════════════════════════════

(function () {

const REPO_URL = 'GIVEMEFOOD5/endless-sky-nexus';

// ── Environment detection: local dev server vs. production ─────
function _isLocalHost() {
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '' || location.protocol === 'file:';
}

// Display/HTML/Systems.html → ../../data is the repo's data/ folder.
const BASE_URL = _isLocalHost()
    ? '../../data'
    : `https://raw.githubusercontent.com/${REPO_URL}/main/data`;

// ── Internal state ───────────────────────────────────────────
const _cache = new Map(); // outputName -> RawPluginMapData
let _pluginIndex = null;  // data/index.json, cached once per page load

function _fireEvent(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
}

// ── Plugin discovery (same source of truth as dataLoader.js) ───
// Was a fetch of data/index.json; now a query against the plugins table,
// grouped back into the same {sourceName: [{outputName, displayPluginName}]}
// shape _findPluginMeta below already expects.
async function discoverPlugins() {
    if (_pluginIndex) return _pluginIndex;
    const { fetchAllRows } = window.SupabaseHelpers;
    const pluginRows = await fetchAllRows('plugins');
    const index = {};
    for (const p of pluginRows) {
        if (!index[p.source_name]) index[p.source_name] = [];
        index[p.source_name].push({ outputName: p.output_name, displayPluginName: p.display_name || p.output_name, pluginId: p.plugin_id });
    }
    _pluginIndex = index;
    return _pluginIndex;
}

function _findPluginMeta(index, outputName) {
    for (const [sourceName, list] of Object.entries(index)) {
        const hit = list.find(p => p.outputName === outputName);
        if (hit) return { sourceName, displayName: hit.displayPluginName || outputName, pluginId: hit.pluginId };
    }
    return { sourceName: outputName, displayName: outputName };
}

/**
 * Loads one plugin's map data via filtered Supabase queries instead of
 * fetching JSON files. No "slim" variant needed anymore — a filtered
 * query already only pulls this one plugin's rows, which is the same
 * bandwidth win the slim files existed for, without needing a second
 * parser output format to maintain.
 */
// The whole map for one plugin in one request, or null (function not installed).
let _rpcMapMissing = false;
async function _rpcMap(pluginId) {
    if (_rpcMapMissing) return null;
    try {
        const { data, error } = await window.supabaseClient.rpc('get_plugin_map', { p_plugin_id: pluginId });
        if (error || !data || !Array.isArray(data.systems)) {
            if (error && /function|does not exist|PGRST202/i.test(error.message || error.code || '')) _rpcMapMissing = true;
            return null;
        }
        return data;
    } catch (_) { return null; }
}

async function _loadOnePlugin(outputName, meta) {
    async function buildFresh() {
    const { fetchAllRows, groupBy } = window.SupabaseHelpers;

    // plugin_id usually comes with the plugin list already (one less round trip)
    let pluginId = meta && meta.pluginId;
    if (!pluginId) {
        const { data: pluginRows, error: pluginErr } = await window.supabaseClient
            .from('plugins').select('plugin_id').eq('output_name', outputName);
        if (pluginErr || !pluginRows?.length) throw new Error(`Unknown plugin "${outputName}"`);
        pluginId = pluginRows[0].plugin_id;
    }
    const byPlugin = q => q.eq('plugin_id', pluginId);

    // Fast path: the plugin's whole map in ONE request (supabase/performance.sql,
    // get_plugin_map). Falls back to table-by-table requests if it isn't installed.
    let systemRows, galaxyRows, wormholeRows, planetRows, missionRows, starRows, governmentRows,
        fleetRows, hazardRows, asteroidRows, minableRows, linkRows, sysPlanetRows, tradeRows, whLinkRows;
    const rpc = await _rpcMap(pluginId);
    if (rpc) {
        ({ systems: systemRows, galaxies: galaxyRows, wormholes: wormholeRows, planets: planetRows, missions: missionRows,
           stars: starRows, governments: governmentRows, system_fleets: fleetRows, system_hazards: hazardRows,
           system_asteroids: asteroidRows, system_minables: minableRows, system_links: linkRows,
           system_planets: sysPlanetRows, system_trade: tradeRows, wormhole_links: whLinkRows } = rpc);
        const rawById = new Map((rpc.mission_raws || []).map(r => [r.id, r.raw]));
        for (const m of missionRows) m.raw = rawById.get(m.id) ?? null;
    } else {
        [systemRows, galaxyRows, wormholeRows, planetRows, missionRows, starRows, governmentRows] =
            await Promise.all([
                fetchAllRows('systems',     { filters: byPlugin, orderBy: 'id' }),
                fetchAllRows('galaxies',    { filters: byPlugin, orderBy: 'id' }),
                fetchAllRows('wormholes',   { filters: byPlugin, orderBy: 'id' }),
                fetchAllRows('planets',     { filters: byPlugin, orderBy: 'id' }),
                // The map only needs a few mission fields — not the big raw trees —
                // so fetch a slim copy (raw trees follow below, only where needed).
                fetchAllRows('missions',    { filters: byPlugin, orderBy: 'id', pageSize: 1000,
                    select: 'id,name,display_name,source_plugin,source,destination,stopovers,waypoints,cargo,passengers,payment,rewards,deadline,illegal,repeatable,repeat_limit,npc_count,has_npc_objective,flags,event_triggers,locations,plugin_id,internal_id' }),
                fetchAllRows('stars',       { filters: byPlugin, orderBy: 'id' }),
                fetchAllRows('governments', { filters: byPlugin, orderBy: 'id' }),
            ]);

        const systemIds   = systemRows.map(s => s.id);
        const wormholeIds = wormholeRows.map(w => w.id);
        // Ask for a few hundred ids at a time: a list of every system id in one
        // request makes the web address too long for big plugins (the request
        // then fails and the map would have no jump links, fleets or trade).
        const byIds = async (table, column, ids, select) => {
            const parts = [];
            for (let i = 0; i < ids.length; i += 100) parts.push(ids.slice(i, i + 100));
            // several groups at once; order by the parent id (every link table has it) so paging is stable
            const out = new Array(parts.length);
            let next = 0;
            const worker = async () => { while (next < parts.length) { const k = next++;
                out[k] = await fetchAllRows(table, { filters: q => q.in(column, parts[k]), orderBy: column, ...(select ? { select } : {}) }); } };
            await Promise.all(Array.from({ length: Math.min(4, parts.length) }, worker));
            return out.flat();
        };
        // the timeline needs raw mission trees, but only for missions that trigger events
        const rawFor = missionRows.filter(m => Array.isArray(m.event_triggers) && m.event_triggers.length).map(m => m.id);
        const rawRows = rawFor.length ? await byIds('missions', 'id', rawFor, 'id,raw') : [];
        const rawById = new Map(rawRows.map(r => [r.id, r.raw]));
        for (const m of missionRows) m.raw = rawById.get(m.id) ?? null;
        [fleetRows, hazardRows, asteroidRows, minableRows, linkRows, sysPlanetRows, tradeRows, whLinkRows] =
            await Promise.all([
                byIds('system_fleets',    'system_id', systemIds),
                byIds('system_hazards',   'system_id', systemIds),
                byIds('system_asteroids', 'system_id', systemIds),
                byIds('system_minables',  'system_id', systemIds),
                byIds('system_links',     'system_id', systemIds),
                byIds('system_planets',   'system_id', systemIds),
                byIds('system_trade',     'system_id', systemIds),
                byIds('wormhole_links',   'wormhole_id', wormholeIds),
            ]);
    }
    const systemIds = systemRows.map(s => s.id);
    console.info(`[MapDataLoader] ${outputName}: ${systemIds.length} systems, ${linkRows.length} jump-link rows, ${whLinkRows.length} wormhole links`);
    if (systemIds.length > 20 && !linkRows.length)
        console.warn(`[MapDataLoader] "${outputName}" has ${systemIds.length} systems but no jump links in the database — run the Parse workflow with "full refresh" ticked.`);

    const fleetsBySystem    = groupBy(fleetRows, 'system_id');
    const hazardsBySystem   = groupBy(hazardRows, 'system_id');
    const asteroidsBySystem = groupBy(asteroidRows, 'system_id');
    const minablesBySystem  = groupBy(minableRows, 'system_id');
    const linksBySystem     = groupBy(linkRows, 'system_id');
    const planetsBySystem   = groupBy(sysPlanetRows, 'system_id');
    const tradeBySystem     = groupBy(tradeRows, 'system_id');
    const linksByWormhole   = groupBy(whLinkRows, 'wormhole_id');

    const systems = systemRows.map(sy => ({
        name: sy.name, displayName: sy.display_name, government: sy.government,
        pos: { x: sy.pos_x, y: sy.pos_y }, habitable: sy.habitable, jumpRange: sy.jump_range,
        haze: sy.haze, music: sy.music, starfieldDensity: sy.starfield_density,
        ramscoop: sy.ramscoop, invisibleFence: sy.invisible_fence, noRaids: sy.no_raids,
        attributes: sy.attributes?.attributes, belts: sy.attributes?.belts,
        arrival: sy.attributes?.arrival, departure: sy.attributes?.departure,
        flags: sy.flags, raids: sy.raids, objectTree: sy.object_tree,
        fleets: (fleetsBySystem.get(sy.id) || []).map(f => ({ name: f.fleet_name, period: f.period, toSpawn: f.to_spawn })),
        hazards: (hazardsBySystem.get(sy.id) || []).map(h => ({ name: h.hazard_name, period: h.period, toSpawn: h.to_spawn })),
        asteroids: (asteroidsBySystem.get(sy.id) || []).map(a => ({ name: a.asteroid_name, count: a.asteroid_count, energy: a.energy })),
        minables: (minablesBySystem.get(sy.id) || []).map(m => ({ name: m.minable_name, count: m.asteroid_count, energy: m.energy })),
        links: (linksBySystem.get(sy.id) || []).map(l => ({ name: l.linked_system_name, explicit: l.explicit })),
        planets: (planetsBySystem.get(sy.id) || []).map(p => ({ name: p.planet_name })),
        trade: (tradeBySystem.get(sy.id) || []).map(t => ({ name: t.commodity_name, cost: t.cost })),
        _pluginId: sy.plugin_id, _internalId: sy.internal_id,
    }));

    const galaxies = galaxyRows.map(g => ({
        name: g.name, sprite: g.sprite, pos: { x: g.pos_x, y: g.pos_y },
        _pluginId: g.plugin_id, _internalId: g.internal_id,
    }));

    const wormholes = wormholeRows.map(w => ({
        name: w.name, displayName: w.display_name, mappable: w.mappable, color: w.color,
        links: (linksByWormhole.get(w.id) || []).map(l => ({ from: l.from_system, to: l.to_system, count: l.count })),
        _pluginId: w.plugin_id, _internalId: w.internal_id,
    }));

    const planets = planetRows.map(p => ({
        name: p.name, displayName: p.display_name, systemName: p.system_name,
        government: p.government, governmentInherited: p.government_inherited,
        security: p.security, bribe: p.bribe, bribeThreshold: p.bribe_threshold,
        bribeFraction: p.bribe_fraction, requiredReputation: p.required_reputation,
        wormhole: p.wormhole, attributes: p.attributes, requires: p.requires,
        description: p.description, spaceport: p.spaceport, port: p.port,
        landscapes: p.landscapes, tribute: p.tribute, tributeHails: p.tribute_hails,
        music: p.music, toKnow: p.to_know, toLand: p.to_land,
        toAccessOutfitter: p.to_access_outfitter, toAccessShipyard: p.to_access_shipyard,
        _pluginId: p.plugin_id, _internalId: p.internal_id,
    }));

    const missions = missionRows.map(m => ({
        name: m.name, displayName: m.display_name, sourcePlugin: m.source_plugin,
        source: m.source, destination: m.destination, stopovers: m.stopovers, waypoints: m.waypoints,
        cargo: m.cargo, passengers: m.passengers, payment: m.payment, rewards: m.rewards,
        deadline: m.deadline, illegal: m.illegal, repeatable: m.repeatable, repeatLimit: m.repeat_limit,
        npcCount: m.npc_count, hasNpcObjective: m.has_npc_objective, flags: m.flags,
        conditions: m.conditions, conditionSideEffects: m.condition_side_effects,
        eventTriggers: m.event_triggers, locations: m.locations, raw: m.raw,
        _pluginId: m.plugin_id, _internalId: m.internal_id,
    }));

    const stars = starRows.map(s => ({
        internalId: s.internal_id, pluginId: s.plugin_id, sprite: s.sprite,
        icon: s.icon, power: s.power, wind: s.wind, habitable: s.habitable, mass: s.mass,
    }));
    const governments = governmentRows.map(g => ({
        name: g.name, pluginId: g.plugin_id,
        color: g.color, colorRef: g.color_ref, swizzle: g.swizzle,
    }));

    return {
        outputName,
        sourceName: meta.sourceName,
        displayName: meta.displayName,
        systems, galaxies, wormholes, planets, missions, stars, governments,
        slim: false,
    };
    } // end buildFresh

    return window.EsCache
        // v2: re-downloads once, replacing any copy saved while link data was missing
        ? await window.EsCache.loadWithCache(`mapData3:${outputName}`, buildFresh)
        : await buildFresh(); // graceful fallback if esCache.js isn't on this page yet
}

/**
 * Loads (or returns cached copies of) every outputName requested.
 * Fetches run sequentially per-plugin (not Promise.all) so the
 * 'mapPluginLoaded' progress events arrive in a sane order for a
 * loading UI — these files are large enough that progress matters,
 * especially on mobile connections.
 */
// One in-flight load per plugin, shared by everyone who asks (e.g. the early
// prefetch below and the real render) — never downloads the same map twice.
const _inflight = new Map();
function _loadShared(index, outputName) {
    if (_cache.has(outputName)) return Promise.resolve(_cache.get(outputName));
    if (_inflight.has(outputName)) return _inflight.get(outputName);
    const p = (async () => {
        const data = await _loadOnePlugin(outputName, _findPluginMeta(index, outputName));
        _cache.set(outputName, data);
        return data;
    })().finally(() => _inflight.delete(outputName));
    _inflight.set(outputName, p);
    return p;
}

async function loadPlugins(outputNames) {
    const wanted = [...new Set(outputNames)].filter(Boolean);
    _fireEvent('mapDataLoadStart', { outputNames: wanted });

    const index = await discoverPlugins();
    const results = new Map();

    // all selected plugins at once (each is a single request)
    await Promise.all(wanted.map(async (outputName, i) => {
        const cached = _cache.has(outputName);
        try {
            const data = await _loadShared(index, outputName);
            results.set(outputName, data);
            _fireEvent('mapPluginLoaded', { outputName, index: i, total: wanted.length, cached });
        } catch (err) {
            console.warn(`[MapDataLoader] Failed loading "${outputName}":`, err);
            _fireEvent('mapPluginLoadError', { outputName, message: err.message });
        }
    }));

    // keep the caller's order (it decides which plugin wins on conflicts)
    const ordered = new Map(wanted.filter(n => results.has(n)).map(n => [n, results.get(n)]));
    _fireEvent('mapDataLoadEnd', { loaded: [...ordered.keys()] });
    return ordered;
}

/**
 * Start downloading the map straight away, before the rest of the page is
 * ready — for the plugins the visitor had selected last time (or the base
 * game). The real render picks up the same download when it gets there.
 */
async function prefetch() {
    try {
        let names = null;
        try { names = JSON.parse(localStorage.getItem('es_sb_active_plugins') || 'null'); } catch (_) {}
        const index = await discoverPlugins();
        const all = Object.values(index).flat().map(p => p.outputName);
        names = (Array.isArray(names) ? names : []).filter(n => all.includes(n));
        if (!names.length) {
            const base = (index['official-game'] || [])[0];
            if (base) names = [base.outputName];
        }
        await Promise.all(names.map(n => _loadShared(index, n).catch(() => null)));
    } catch (_) { /* the normal load will report any problem */ }
}

function getCached(outputName) { return _cache.get(outputName) || null; }
function isCached(outputName) { return _cache.has(outputName); }
function clearCache() { _cache.clear(); }

window.MapDataLoader = {
    discoverPlugins,
    loadPlugins,
    prefetch,
    getCached,
    isCached,
    clearCache,
    BASE_URL,
};

})();
