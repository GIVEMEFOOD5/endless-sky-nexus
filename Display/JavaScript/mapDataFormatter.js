'use strict';

// ═══════════════════════════════════════════════════════════
//  mapDataFormatter.js  —  Endless Sky Ship Builder / Systems Map
//
//  STAGE 2 of the map pipeline: FORMAT THE DATA.
//  Takes the raw, per-plugin arrays handed over by mapDataLoader.js
//  (whatever shape mapParser.js happens to output that week — this
//  file is deliberately defensive about missing/renamed fields since
//  the parser is under active development) and reshapes them into a
//  single lean, merged structure the rest of the map pipeline can
//  rely on without knowing anything about plugins.
//
//  MERGE MODEL (mirrors mapParser.js's own doc comment)
//  ------------------------------------------------------
//  A system can be touched by more than one active plugin (an
//  overhaul mod editing a vanilla system's government, a small mod
//  only adding a link). So systems merge ADDITIVELY, in the same
//  order the plugins are active (PluginManager's order — first
//  plugin in the active list has lowest priority, matching parser.js
//  processing plugins.json top-to-bottom):
//    - links                → union, de-duplicated by name
//    - attributes           → union, de-duplicated
//    - government, pos      → last plugin to define it wins
//    - name / displayName   → first plugin to define it wins (stable identity)
//  Every merged system keeps `_definedBy` (every plugin that touched
//  it) so the display layer can show provenance on hover.
//
//  Public API on window.MapDataFormatter:
//    .formatSystems(pluginDataMap, activeOrder)  → Map<name, FormattedSystem>
//    .formatGalaxies(pluginDataMap)              → FormattedGalaxy[]
//    .formatWormholes(pluginDataMap)             → FormattedWormholeLink[]
//    .formatPlanets(pluginDataMap, activeOrder)  → Map<systemName, FormattedPlanet[]>
//    .attachPlanets(systemsMap, planetsBySystem) → mutates systemsMap in place
//    .formatMissions(pluginDataMap, activeOrder, planetsBySystem) → FormattedMission[]
//    .formatStars(pluginDataMap, activeOrder)    → Map<spriteName, StarAttributes>
//    .formatGovernments(pluginDataMap, activeOrder) → Map<govName, {color, swizzle}>
//
//  FormattedSystem shape:
//    { name, x, y, government, attributes: string[],
//      links: string[], wormhole: boolean, hasPlanets: boolean,
//      planets: FormattedPlanet[], objectTree: RawObjectNode[],
//      ramscoopModifier: {universal,addend,multiplier}|null,
//      habitableOverride: number|null, definedBy: string[] }
//  `objectTree` is kept verbatim from systems.json (star + planet + moon
//  nodes, recursively) — mapCalculations.js's computeSolarAttributes()
//  walks it to find which nodes are stars, and this file's own
//  attachPlanets() walks it to match each planet to its map-icon sprite.
//
//  FormattedPlanet shape (from planets.json, keyed back to its system
//  via the `systemName` field the parser already stamps on every
//  planet — this file just groups by that key):
//    { name, government, hasSpaceport, hasShipyard, hasOutfitter,
//      wormhole: string|null, attributes: string[],
//      landscapes: string[],   // landing-screen art, e.g. "land/earthrise"
//      sprite: string|null,    // map-icon sprite, e.g. "planet/earth" — attached by attachPlanets()
//      definedBy: string[] }
//
//  FormattedMission shape (from missions.json — see formatMissions()'s
//  own doc comment for how `source` gets split into these fields):
//    { name, displayName, isJob, repeatable, payment: number|null,
//      sourceType: 'planet'|'filter'|'unresolved'|'none',
//      sourceSystem: string|null,   // set only when sourceType === 'planet'
//      sourcePlanet: string|null,
//      sourceFilter: rawFilterTree|null,  // set only when sourceType === 'filter'
//      definedBy: string[] }
//
//  StarAttributes shape (from stars.json — see mapCalculations.js's
//  BASELINE_STAR_TABLE doc comment for where the vanilla numbers
//  ultimately come from, and why this file's output takes priority
//  over that baseline when both exist for the same sprite):
//    { power: number|null, wind: number|null, icon: string|null,
//      habitable: number|null, mass: number|null }
// ═══════════════════════════════════════════════════════════

(function () {

// ── Small defensive readers (parser output shape drifts sometimes) ──

function _readName(raw) {
    return raw?.name ?? raw?.displayName ?? null;
}

function _readPos(raw) {
    const p = raw?.pos;
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
    return { x: p.x, y: p.y };
}

function _readLinkNames(raw) {
    const links = raw?.links;
    if (!Array.isArray(links)) return [];
    return links
        .map(l => (typeof l === 'string' ? l : l?.name))
        .filter(Boolean);
}

function _readAttributes(raw) {
    const attrs = raw?.attributes;
    if (!Array.isArray(attrs)) return [];
    return attrs.filter(a => typeof a === 'string');
}

function _readGovernment(raw) {
    const g = raw?.government;
    return (typeof g === 'string' && g.trim()) ? g.trim() : 'Uninhabited';
}


function _readObjectTree(raw) {
    return Array.isArray(raw?.objectTree) ? raw.objectTree : [];
}

/** System-level `ramscoop` override — universal/addend/multiplier, each
 *  defaulting per the wiki when the system doesn't define that particular
 *  sub-field (not when the whole block is absent, which instead means
 *  "no override at all", kept as null so the display layer can tell the
 *  difference between "default because unset" and "explicitly default"). */
function _readRamscoopModifier(raw) {
    const rs = raw?.ramscoop;
    if (!rs || typeof rs !== 'object') return null;
    return {
        universal: typeof rs.universal === 'number' ? rs.universal : 1,
        addend: typeof rs.addend === 'number' ? rs.addend : 0,
        multiplier: typeof rs.multiplier === 'number' ? rs.multiplier : 1,
    };
}

function _readHabitableOverride(raw) {
    return typeof raw?.habitable === 'number' ? raw.habitable : null;
}

// ── Systems ──────────────────────────────────────────────────

/**
 * @param {Map<string, RawPluginMapData>} pluginDataMap  keyed by outputName
 * @param {string[]} activeOrder  outputNames in PluginManager priority order
 *                                (index 0 = lowest priority, last = highest)
 * @returns {Map<string, FormattedSystem>}
 */
function formatSystems(pluginDataMap, activeOrder) {
    const merged = new Map();

    for (const outputName of activeOrder) {
        const plugin = pluginDataMap.get(outputName);
        if (!plugin || !Array.isArray(plugin.systems)) continue;

        for (const raw of plugin.systems) {
            const name = _readName(raw);
            // Labels (e.g. "label core") and namesless nodes aren't real
            // systems — mapParser.js stores galaxy background labels in
            // the galaxies array, but some plugin output has historically
            // leaked them into systems too. Skip anything without a
            // usable position; it can't be placed on the map anyway.
            const pos = _readPos(raw);
            if (!name || !pos) continue;

            const linkNames = _readLinkNames(raw);
            const attrs = _readAttributes(raw);
            const government = _readGovernment(raw);
            const hasPlanets = Array.isArray(raw.planets) && raw.planets.length > 0;
            const objectTree = _readObjectTree(raw);
            const ramscoopModifier = _readRamscoopModifier(raw);
            const habitableOverride = _readHabitableOverride(raw);

            let entry = merged.get(name);
            if (!entry) {
                entry = {
                    name,
                    x: pos.x, y: pos.y,
                    government,
                    attributes: new Set(attrs),
                    links: new Set(linkNames),
                    wormhole: false,
                    hasPlanets,
                    planets: [], // filled in later by attachPlanets(), from planets.json
                    objectTree,
                    ramscoopModifier,
                    habitableOverride,
                    definedBy: [],
                };
                merged.set(name, entry);
            } else {
                // Scalar fields: last write (highest-priority active plugin) wins.
                entry.x = pos.x;
                entry.y = pos.y;
                entry.government = government;
                entry.hasPlanets = entry.hasPlanets || hasPlanets;
                if (objectTree.length) entry.objectTree = objectTree;
                if (ramscoopModifier) entry.ramscoopModifier = ramscoopModifier;
                if (habitableOverride != null) entry.habitableOverride = habitableOverride;
                // List fields: union.
                attrs.forEach(a => entry.attributes.add(a));
                linkNames.forEach(l => entry.links.add(l));
            }
            if (!entry.definedBy.includes(outputName)) entry.definedBy.push(outputName);
        }
    }

    // Freeze Sets into arrays for a plain, serialisable-looking result.
    const out = new Map();
    for (const [name, e] of merged) {
        out.set(name, {
            name: e.name,
            x: e.x, y: e.y,
            government: e.government,
            attributes: [...e.attributes],
            links: [...e.links],
            wormhole: e.wormhole,
            hasPlanets: e.hasPlanets,
            planets: e.planets,
            objectTree: e.objectTree,
            ramscoopModifier: e.ramscoopModifier,
            habitableOverride: e.habitableOverride,
            definedBy: e.definedBy,
        });
    }
    return out;
}

/** Marks systems that are one end of a wormhole link (for a distinct display treatment). */
function applyWormholeFlags(systemsMap, wormholeLinks) {
    for (const link of wormholeLinks) {
        const from = systemsMap.get(link.from);
        const to = systemsMap.get(link.to);
        if (from) from.wormhole = true;
        if (to) to.wormhole = true;
    }
    return systemsMap;
}

// ── Galaxies (background cluster labels / sprites) ──────────

function formatGalaxies(pluginDataMap) {
    const seen = new Map();
    for (const plugin of pluginDataMap.values()) {
        if (!Array.isArray(plugin.galaxies)) continue;
        for (const raw of plugin.galaxies) {
            const name = _readName(raw);
            const pos = _readPos(raw);
            if (!name || !pos) continue;
            // Skip pure background-label sprites ("label core", "label deep"...)
            // — they clutter the legend without being navigable systems.
            const isLabel = /^label\b/i.test(name);
            seen.set(name, { name, x: pos.x, y: pos.y, sprite: raw.sprite || null, isLabel });
        }
    }
    return [...seen.values()];
}

// ── Wormholes ────────────────────────────────────────────────

function formatWormholes(pluginDataMap) {
    const out = [];
    const seen = new Set();
    for (const plugin of pluginDataMap.values()) {
        if (!Array.isArray(plugin.wormholes)) continue;
        for (const w of plugin.wormholes) {
            const links = Array.isArray(w.links) ? w.links : [];
            for (const l of links) {
                if (!l?.from || !l?.to) continue;
                const key = `${l.from}→${l.to}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ from: l.from, to: l.to, name: w.name || null, mappable: !!w.mappable });
            }
        }
    }
    return out;
}

// ── Planets ──────────────────────────────────────────────────

/**
 * planets.json is a flat array of every planet across every system,
 * each one carrying the name of the system it belongs to. This groups
 * them back by that `systemName` key and merges duplicates (a planet
 * redefined by a higher-priority active plugin) the same way systems
 * merge: scalars last-write-wins, `definedBy` accumulates.
 *
 * @param {Map<string, RawPluginMapData>} pluginDataMap
 * @param {string[]} activeOrder  same priority order used in formatSystems
 * @returns {Map<string, FormattedPlanet[]>} keyed by systemName
 */
function formatPlanets(pluginDataMap, activeOrder) {
    const byPlanetName = new Map(); // planet name -> merged entry (handles redefinition)

    for (const outputName of activeOrder) {
        const plugin = pluginDataMap.get(outputName);
        if (!plugin || !Array.isArray(plugin.planets)) continue;

        for (const raw of plugin.planets) {
            const name = _readName(raw);
            const systemName = raw?.systemName;
            if (!name || !systemName) continue; // an unplaced/abstract planet can't go on the map

            const hasShipyard = Array.isArray(raw.shipyards) && raw.shipyards.length > 0;
            const hasOutfitter = Array.isArray(raw.outfitters) && raw.outfitters.length > 0;
            const hasSpaceport = !!raw.spaceport;
            const government = _readGovernment(raw);
            const wormhole = (typeof raw.wormhole === 'string' && raw.wormhole) ? raw.wormhole : null;
            const attributes = _readAttributes(raw);
            const landscapes = Array.isArray(raw.landscapes)
                ? raw.landscapes.map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
                : [];

            let entry = byPlanetName.get(name);
            if (!entry) {
                entry = { name, systemName, government, hasSpaceport, hasShipyard, hasOutfitter, wormhole, attributes, landscapes, sprite: null, definedBy: [] };
                byPlanetName.set(name, entry);
            } else {
                entry.systemName = systemName;
                entry.government = government;
                entry.hasSpaceport = hasSpaceport;
                entry.hasShipyard = hasShipyard;
                entry.hasOutfitter = hasOutfitter;
                entry.wormhole = wormhole;
                entry.attributes = attributes;
                if (landscapes.length) entry.landscapes = landscapes;
            }
            if (!entry.definedBy.includes(outputName)) entry.definedBy.push(outputName);
        }
    }

    const bySystem = new Map();
    for (const entry of byPlanetName.values()) {
        if (!bySystem.has(entry.systemName)) bySystem.set(entry.systemName, []);
        bySystem.get(entry.systemName).push(entry);
    }
    return bySystem;
}

/**
 * Attaches each system's planet list (from formatPlanets) onto the
 * already-merged systems Map, and refines `hasPlanets` — the flag
 * formatSystems() sets is only a "some plugin listed a planet ref
 * here" guess from systems.json; this replaces it with the real
 * count from planets.json when that data is available. Also attaches
 * each planet's map-icon `sprite` (e.g. "planet/earth"), read from the
 * system's objectTree and matched back to the planet by name — that
 * sprite lives on the system's object definition, not in planets.json.
 */
function attachPlanets(systemsMap, planetsBySystem) {
    for (const [systemName, planetList] of planetsBySystem) {
        const system = systemsMap.get(systemName);
        if (!system) continue; // planet's system was filtered out (inactive plugin, etc.)
        system.planets = planetList;
        system.hasPlanets = planetList.length > 0;

        const spriteByName = new Map();
        const walk = (nodes) => {
            for (const obj of (nodes || [])) {
                if (obj.name && obj.sprite) spriteByName.set(obj.name, obj.sprite);
                walk(obj.children);
            }
        };
        walk(system.objectTree);
        for (const p of planetList) p.sprite = spriteByName.get(p.name) ?? null;
    }
    return systemsMap;
}

// ── Missions ─────────────────────────────────────────────────

/**
 * A mission's `source` is one of:
 *   { type: 'planet', ref: { name } }   — concrete: exactly one planet
 *   { type: 'filter', value: [...raw filter tree...] }  — generic: any
 *                                          planet/system matching the filter
 *                                          (job-board template missions
 *                                          mostly look like this)
 *   null                                 — no explicit source (chained /
 *                                          event-triggered; not placeable)
 * This reads that + the `job` location tag and hands back a flat,
 * still-plugin-merged-by-priority list. Concrete sources are resolved
 * to a system name right here (using the planet→system map
 * formatPlanets() already built) so mapCalculations.js never needs to
 * know planets.json exists; filter trees are left untouched for
 * mapCalculations.evaluateMissionFilter() to walk.
 *
 * @param {Map<string, RawPluginMapData>} pluginDataMap
 * @param {string[]} activeOrder
 * @param {Map<string, FormattedPlanet[]>} planetsBySystem  from formatPlanets()
 * @returns {FormattedMission[]}
 */
function formatMissions(pluginDataMap, activeOrder, planetsBySystem) {
    // planet name -> system name, built once from the same grouped data
    // attachPlanets() uses, so this is guaranteed consistent with it.
    const systemOfPlanet = new Map();
    for (const [systemName, planets] of planetsBySystem) {
        for (const p of planets) systemOfPlanet.set(p.name, systemName);
    }

    const byName = new Map(); // mission name -> merged entry (redefinition handling)

    for (const outputName of activeOrder) {
        const plugin = pluginDataMap.get(outputName);
        if (!plugin || !Array.isArray(plugin.missions)) continue;

        for (const raw of plugin.missions) {
            const name = _readName(raw);
            if (!name) continue;

            const isJob = Array.isArray(raw.locations) && raw.locations.includes('job');
            const src = raw.source;

            let sourceType = 'none', sourceSystem = null, sourcePlanet = null, sourceFilter = null;
            if (src && src.type === 'planet') {
                sourcePlanet = src.ref?.name ?? src.value ?? null;
                sourceSystem = sourcePlanet ? (systemOfPlanet.get(sourcePlanet) ?? null) : null;
                sourceType = sourceSystem ? 'planet' : 'unresolved';
            } else if (src && src.type === 'filter') {
                sourceFilter = Array.isArray(src.value) ? src.value : [];
                sourceType = 'filter';
            }

            const payment = _readMissionPayment(raw);

            const entry = {
                name,
                displayName: raw.displayName || name,
                isJob,
                repeatable: !!raw.repeatable,
                payment,
                sourceType, sourceSystem, sourcePlanet, sourceFilter,
                definedBy: [outputName],
            };

            const existing = byName.get(name);
            if (existing) entry.definedBy = [...existing.definedBy, outputName];
            byName.set(name, entry); // last-write-wins, same as system scalars
        }
    }

    return [...byName.values()];
}

/** Best-effort single payment figure for tooltip display — Endless Sky
 *  payments are base + multiplier*distance, evaluated at mission-accept
 *  time, so this can only report the flat "onComplete" base amount, not
 *  the true final payout. Good enough as a rough guide, not a promise. */
function _readMissionPayment(raw) {
    const triggers = raw?.payment?.triggers?.onComplete;
    if (!Array.isArray(triggers) || triggers.length === 0) return null;
    return triggers.reduce((sum, t) => sum + (t.base || 0), 0) || null;
}

// ── Stars (solar power/wind attributes, per sprite) ─────────

/**
 * stars.json is one entry per distinct star sprite a plugin defines —
 * vanilla's own star types (g0, m3, black-hole, ...) plus anything a
 * mod adds. Later-active plugins can override a sprite's numbers
 * (last-write-wins), which is how a mod could reasonably reskin a
 * star type's behaviour, not just its picture.
 *
 * @param {Map<string, RawPluginMapData>} pluginDataMap
 * @param {string[]} activeOrder
 * @returns {Map<string, {power:number|null, wind:number|null, icon:string|null, habitable:number|null, mass:number|null}>}
 */
function formatStars(pluginDataMap, activeOrder) {
    const out = new Map();
    for (const outputName of activeOrder) {
        const plugin = pluginDataMap.get(outputName);
        if (!plugin || !Array.isArray(plugin.stars)) continue;
        for (const raw of plugin.stars) {
            const sprite = raw?.sprite;
            if (!sprite) continue;
            out.set(sprite, {
                power: typeof raw.power === 'number' ? raw.power : null,
                wind: typeof raw.wind === 'number' ? raw.wind : null,
                icon: raw.icon || null,
                habitable: typeof raw.habitable === 'number' ? raw.habitable : null,
                mass: typeof raw.mass === 'number' ? raw.mass : null,
            });
        }
    }
    return out;
}

// ── Governments (real map colors, per name) ─────────────────

/**
 * governments.json is one entry per distinct government name a plugin
 * defines or overrides — vanilla's own factions (Republic, Free Worlds,
 * Pirate, ...) plus anything a mod adds or re-colors. Later-active
 * plugins win on conflict, same merge rule as stars.
 *
 * Not every government defines a `color` line (many vanilla ones don't
 * — e.g. "Alpha", "Author", "Escort"), so `color` can legitimately be
 * null here; mapCalculations.buildGovernmentPalette() falls back to an
 * assigned palette color for those rather than guessing a real one.
 *
 * @returns {Map<string, {color:[r,g,b]|null, swizzle:number|string|null}>}
 */
function formatGovernments(pluginDataMap, activeOrder) {
    const out = new Map();
    for (const outputName of activeOrder) {
        const plugin = pluginDataMap.get(outputName);
        if (!plugin || !Array.isArray(plugin.governments)) continue;
        for (const raw of plugin.governments) {
            if (!raw?.name) continue;
            out.set(raw.name, {
                color: Array.isArray(raw.color) && raw.color.length === 3 ? raw.color : null,
                swizzle: raw.swizzle ?? null,
            });
        }
    }
    return out;
}

window.MapDataFormatter = {
    formatSystems,
    formatGalaxies,
    formatWormholes,
    formatPlanets,
    formatMissions,
    formatStars,
    formatGovernments,
    applyWormholeFlags,
    attachPlanets,
};

})();
