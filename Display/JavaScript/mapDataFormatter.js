'use strict';

// Turns the raw map data from Supabase into what the map draws: systems, planets, galaxies, wormholes, missions, stars, governments.

(function () {

// ── small readers (the parser's shapes vary a little) ──

function _readName(raw) {
    return raw?.name ?? raw?.displayName ?? null;
}

// position
function _readPos(raw) {
    const p = raw?.pos;
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
    return { x: p.x, y: p.y };
}

// link names
function _readLinkNames(raw) {
    const links = raw?.links;
    if (!Array.isArray(links)) return [];
    return links
        .map(l => (typeof l === 'string' ? l : l?.name))
        .filter(Boolean);
}

// attributes
function _readAttributes(raw) {
    const attrs = raw?.attributes;
    if (!Array.isArray(attrs)) return [];
    return attrs.filter(a => typeof a === 'string');
}

// government
function _readGovernment(raw) {
    const g = raw?.government;
    return (typeof g === 'string' && g.trim()) ? g.trim() : 'Uninhabited';
}


// object tree
function _readObjectTree(raw) {
    return Array.isArray(raw?.objectTree) ? raw.objectTree : [];
}

// a system's ramscoop override (universal/addend/multiplier)
function _readRamscoopModifier(raw) {
    const rs = raw?.ramscoop;
    if (!rs || typeof rs !== 'object') return null;
    return {
        universal: typeof rs.universal === 'number' ? rs.universal : 1,
        addend: typeof rs.addend === 'number' ? rs.addend : 0,
        multiplier: typeof rs.multiplier === 'number' ? rs.multiplier : 1,
    };
}

// habitable zone override
function _readHabitableOverride(raw) {
    return typeof raw?.habitable === 'number' ? raw.habitable : null;
}

// ── systems ──

// merge every plugin's systems into one map. Called by: mapDisplay._loadAndRender
function formatSystems(pluginDataMap, activeOrder) {
    const merged = new Map();

    for (const outputName of activeOrder) {
        const plugin = pluginDataMap.get(outputName);
        if (!plugin || !Array.isArray(plugin.systems)) continue;

        for (const raw of plugin.systems) {
            const name = _readName(raw);
            // labels and nameless nodes aren't real systems
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

// mark systems at either end of a wormhole
function applyWormholeFlags(systemsMap, wormholeLinks) {
    for (const link of wormholeLinks) {
        const from = systemsMap.get(link.from);
        const to = systemsMap.get(link.to);
        if (from) from.wormhole = true;
        if (to) to.wormhole = true;
    }
    return systemsMap;
}

// galaxy pictures and labels

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

// wormhole links (from → to)

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

// ── planets ──

// every planet, with its system
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

// put each system's planets on it
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

// ── missions ──

// missions with where they're offered (a planet, or a filter)
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

// one payment figure for the tooltip
function _readMissionPayment(raw) {
    const triggers = raw?.payment?.triggers?.onComplete;
    if (!Array.isArray(triggers) || triggers.length === 0) return null;
    return triggers.reduce((sum, t) => sum + (t.base || 0), 0) || null;
}

// ── stars ──

// each star sprite's power and wind
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

// ── governments ──

// each government's map colour
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
