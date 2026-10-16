'use strict';

// ═══════════════════════════════════════════════════════════
//  dataLoader.js  —  Endless Sky Ship Builder / Data Viewer
//
//  Loads all plugin data from GitHub, manages active plugin
//  selection, and synthesises a "Local Builds" pseudo-plugin
//  from localStorage saved ships.
//
//  Public API on window.DataLoader:
//    .load()                      → Promise — start/await loading
//    .onReady(fn)                 → register ready callback
//    .isReady()                   → boolean
//    .getPlugins()                → all loaded plugins
//    .getActivePlugins()          → ordered active outputNames
//    .setActivePlugins(arr)       → set active set, fires 'pluginsChanged'
//    .initDefaultPlugins()        → activate default (endless-sky) + local
//    .getAllShips()               → ships from active plugins + local builds
//    .getAllOutfits()             → outfits from active plugins
//    .getAllEffects()             → effects from active plugins
//    .getAttrKeys()              → sorted attribute keys from attrDefs
//    .getAttrDef(key)            → single attribute definition
//    .getAttrHint(key)           → "unit · stacking" string
//    .refreshLocalBuilds()       → re-read localStorage fleet + fire pluginsChanged
//    ._refreshLocalOnly()        → re-read localStorage fleet silently (no event)
//
//  Custom events fired on document:
//    'dataLoaded'      — all remote data fetched
//    'dataLoadError'   — fetch failed
//    'pluginsChanged'  — active plugin selection changed
// ═══════════════════════════════════════════════════════════

(function () {

const REPO_URL   = 'GIVEMEFOOD5/endless-sky-nexus';
const BASE_URL   = `https://raw.githubusercontent.com/${REPO_URL}/main/data`;
const LOCAL_KEY  = 'es_ship_builder_v4';
const LOCAL_PLUGIN_ID = '__local_builds__';
const DEFAULT_PLUGIN  = 'official-game/endless-sky';

// ── Internal state ─────────────────────────────────────────
let _ready          = false;
let _loading        = false;
let _callbacks      = [];
let _activePlugins  = [];

window.allData  = window.allData  || {};
window.attrDefs = window.attrDefs || null;

// ── Attribute value coercion ───────────────────────────────
//
// shipBuilder.js stores ALL attribute values as strings in localStorage
// (e.g. shields: "400", not shields: 400). battleSim.js and other consumers
// expect numbers. This helper converts a flat attributes object so every
// value that looks like a plain number becomes one, while genuine string
// values (e.g. category: "Light Warship") stay as strings.
// Nested objects (licenses, weapon) are left untouched.

function _coerceAttrs(attrs) {
    if (!attrs || typeof attrs !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'object') {
            // Preserve nested objects (licenses, weapon sub-block) as-is
            out[k] = v;
            continue;
        }
        const str = String(v).trim();
        const n   = Number(str);
        // Only coerce if the whole string is a valid finite number
        out[k] = (str !== '' && isFinite(n)) ? n : str;
    }
    return out;
}

// ── Parse outfit map from raw localStorage ship data ───────
//
// sbSave() always writes outfits as a plain object (map):
//   { "Hyperdrive": { count: 1, pluginId: "..." }, ... }
// sbLoad() converts this back to an array for shipBuilder's UI.
// _buildLocalPlugin reads directly from localStorage, so it always
// sees the map format. This helper normalises both formats into a
// consistent { name → { count, pluginId } } map object.

function _normaliseOutfitMap(outfits) {
    if (!outfits) return {};

    // Array format (e.g. loaded from sbFleet): [{ name, count, pluginId }]
    if (Array.isArray(outfits)) {
        const map = {};
        for (const o of outfits) {
            const name = (o.name || '').replace(/^"([^"]*)"$/, '$1');
            if (!name) continue;
            map[name] = {
                count:    parseInt(o.count)   || 1,
                pluginId: o.pluginId          || null,
            };
        }
        return map;
    }

    // Map format (direct from localStorage JSON):
    // { "Name": { count, pluginId } } or legacy { "Name": number }
    if (typeof outfits === 'object') {
        const map = {};
        for (const [rawName, val] of Object.entries(outfits)) {
            const name = rawName.replace(/^"([^"]*)"$/, '$1');
            if (!name) continue;
            map[name] = typeof val === 'object'
                ? { count: parseInt(val.count) || 1, pluginId: val.pluginId || null }
                : { count: Number(val) || 1,          pluginId: null };
        }
        return map;
    }

    return {};
}

// ── Local builds pseudo-plugin ─────────────────────────────
//
// FIX: The local plugin now carries an `outfits` index populated from
// the outfit maps of all active remote plugins. This means
// ComputedStats.getOutfitIndex(LOCAL_PLUGIN_ID) can find outfit
// attribute data when accumulating stats for local ships.
// Without this, every outfit lookup returned undefined and all
// computed stats were zero.

// Shared by both Local Builds and Public Builds — a saved ship (whether
// from localStorage or a saved_ships.build_data row) is stored as this
// same raw flat object; both callers normalize it identically so a ship
// looks and behaves the same whether it's yours or someone else's public
// build.
function _normaliseSavedShip(s, extra) {
    const rawAttrs = Object.assign({}, s.attributes || {});
    if (s.mass != null && s.mass !== '') rawAttrs.mass = s.mass;
    if (s.drag != null && s.drag !== '') rawAttrs.drag = s.drag;
    const attributes = _coerceAttrs(rawAttrs);
    const outfitsMap = _normaliseOutfitMap(s.outfits);

    return Object.assign({
        name:        s.name || 'Unnamed',
        variant:     s.variant || '',
        sprite:      s.sprite || '',
        thumbnail:   s.thumbnail || '',
        description: s.description || '',
        attributes,
        outfits:   outfitsMap,
        outfitMap: outfitsMap,
        guns: (s.guns || []).map(g => ({
            x:   parseFloat((g.coords || '0 0').split(' ')[0]) || 0,
            y:   parseFloat((g.coords || '0 0').split(' ')[1]) || 0,
            gun: g.over || '',
        })),
        turrets: (s.turrets || []).map(g => ({
            x:      parseFloat((g.coords || '0 0').split(' ')[0]) || 0,
            y:      parseFloat((g.coords || '0 0').split(' ')[1]) || 0,
            turret: g.over || '',
        })),
        bays: [
            ...(s.drones || []).map(b => ({
                type:            'Drone',
                x:               parseFloat((b.coords || '0 0').split(' ')[0]) || 0,
                y:               parseFloat((b.coords || '0 0').split(' ')[1]) || 0,
                'launch effect': b.launchEffect || '',
            })),
            ...(s.fighters || []).map(b => ({
                type:            'Fighter',
                x:               parseFloat((b.coords || '0 0').split(' ')[0]) || 0,
                y:               parseFloat((b.coords || '0 0').split(' ')[1]) || 0,
                'launch effect': b.launchEffect || '',
            })),
        ],
        engines: (s.engines || []).map(e => ({
            x:    parseFloat((e.coords || '0 0').split(' ')[0]) || 0,
            y:    parseFloat((e.coords || '0 0').split(' ')[1]) || 0,
            zoom: parseFloat(e.zoom) || 1,
        })),
    }, extra);
}

function _buildLocalPlugin() {
    let fleet = [];
    try {
        const raw = localStorage.getItem(LOCAL_KEY);
        if (raw) fleet = JSON.parse(raw);
    } catch (_) {}

    const ships = fleet.map(s => _normaliseSavedShip(s, { _isLocalBuild: true, _localId: s.id }));

    // Local Builds owns only your ship designs. (It used to copy in every
    // outfit from every loaded plugin — including ones you'd switched off —
    // which doubled outfit counts and leaked unselected plugins into
    // searches. Outfit lookups now search the selected plugins directly.)
    return {
        sourceName:  'Local Builds',
        displayName: 'Local Builds',
        outputName:  LOCAL_PLUGIN_ID,
        ships,
        variants: [],
        outfits:  [],
        effects:  [],
        _isLocal: true,
    };
}

// ── Public builds pseudo-plugins ───────────────────────────────
//
// Each user who has at least one public ship becomes their OWN pseudo-
// plugin, named after their username — not one shared "Public Builds"
// bucket. This means the existing plugin picker (generalPluginStuff.js)
// handles them as real, individually-selectable plugins with zero
// changes: it already groups by sourceName and labels a single-plugin
// group by that name directly, so sourceName = username is all it takes.
const PUBLIC_PLUGIN_PREFIX = 'public:';

async function _fetchPublicBuildPlugins() {
    const buckets = {};
    try {
        const { data: shipRows, error } = await window.supabaseClient
            .from('saved_ships').select('id, name, build_data, user_id, created_at')
            .eq('is_public', true)
            .order('created_at', { ascending: false });
        if (error || !shipRows?.length) return buckets;

        const userIds = [...new Set(shipRows.map(r => r.user_id))];
        const { data: profileRows } = await window.supabaseClient
            .from('profiles').select('id, username').in('id', userIds);
        const usernameByUserId = new Map((profileRows || []).map(p => [p.id, p.username]));

        const shipsByUsername = new Map();
        for (const row of shipRows) {
            const username = usernameByUserId.get(row.user_id);
            if (!username) continue; // no profile/username set — nothing sensible to label this plugin with
            if (!shipsByUsername.has(username)) shipsByUsername.set(username, []);
            shipsByUsername.get(username).push(_normaliseSavedShip(row.build_data || {}, {
                name: row.build_data?.name || row.name || 'Unnamed',
                _isPublicBuild: true,
                _publicShipId: row.id,
                _ownerUsername: username,
            }));
        }

        for (const [username, ships] of shipsByUsername) {
            const outputName = PUBLIC_PLUGIN_PREFIX + username;
            buckets[outputName] = {
                sourceName: username, displayName: username, outputName,
                // ships only — their outfits come from your selected plugins
                ships, variants: [], outfits: [], effects: [],
                _isPublicUserPlugin: true,
            };
        }
    } catch (err) {
        console.warn('[DataLoader] Could not load public builds:', err);
    }
    return buckets;
}

function _refreshLocalPlugin() {
    window.allData[LOCAL_PLUGIN_ID] = _buildLocalPlugin();
}

// ── Helpers ─────────────────────────────────────────────────
function _activeData() {
    const result = {};
    for (const id of _activePlugins) {
        if (id === LOCAL_PLUGIN_ID) {
            result[id] = _buildLocalPlugin(); // always fresh
        } else if (window.allData[id]) {
            result[id] = window.allData[id];
        }
    }
    return result;
}

function _fireEvent(name, detail = {}) {
    document.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
}

// ── Public API ──────────────────────────────────────────────
window.DataLoader = {

    load() {
        if (_ready)   return Promise.resolve(window.allData);
        if (_loading) return new Promise(resolve => _callbacks.push(() => resolve(window.allData)));
        return _doLoad();
    },

    // Safety net: call this before switching to / displaying a plugin that
    // might not have loaded yet (Phase A only loads what was already
    // active, Phase B fills the rest in the background and may not have
    // reached this one). Resolves instantly if it's already loaded.
    ensurePluginLoaded(outputName) { return ensurePluginLoaded(outputName); },

    onReady(fn) {
        if (_ready) { fn(window.allData); return; }
        _callbacks.push(fn);
        if (!_loading) _doLoad();
    },

    isReady() { return _ready; },

    // ── Plugin management ──────────────────────────────────
    getPlugins() {
        const local = _buildLocalPlugin();
        const remote = Object.entries(window.allData)
            .filter(([id]) => id !== LOCAL_PLUGIN_ID)
            .map(([id, p]) => ({
                outputName:   id,
                displayName:  p.displayName || id,
                sourceName:   p.sourceName  || id,
                shipCount:    (p.ships    || []).length,
                variantCount: (p.variants || []).length,
                outfitCount:  (p.outfits  || []).length,
                effectCount:  (p.effects  || []).length,
                isDefault:    id === DEFAULT_PLUGIN,
                isLocal:      false,
            }));
        return [
            {
                outputName:   LOCAL_PLUGIN_ID,
                displayName:  'Local Builds',
                sourceName:   'Local Builds',
                shipCount:    local.ships.length,
                variantCount: 0,
                outfitCount:  0,
                effectCount:  0,
                isLocal:      true,
                isDefault:    false,
            },
            ...remote,
        ];
    },

    getActivePlugins() { return [..._activePlugins]; },
    /** A ship-builder design as a ship object other pages can use (e.g. the battle simulator). */
    normaliseDesign(design) { return _normaliseSavedShip(design, { _isLocalBuild: true }); },
    /** { outputName: pluginData } for the selected plugins only (Local Builds included when on). */
    getActiveData() { return _activeData(); },
    /**
     * Every id a selected plugin goes by: its output name plus the plugin_id
     * ("Source/folder") used in internal ids and in location lists.
     */
    getActivePluginIds() {
        const ids = new Set();
        for (const [name, p] of Object.entries(_activeData())) {
            ids.add(name);
            const s = (p.ships || []).find(x => x && x._pluginId); if (s) ids.add(s._pluginId);
            const o = (p.outfits || []).find(x => x && x.pluginId); if (o) ids.add(o.pluginId);
            const v = (p.variants || []).find(x => x && x._pluginId); if (v) ids.add(v._pluginId);
        }
        return ids;
    },

    async setActivePlugins(arr) {
        const withLocal = arr.includes(LOCAL_PLUGIN_ID) ? arr : [LOCAL_PLUGIN_ID, ...arr];
        // Same safety net as generalPluginStuff.js's setActivePlugins —
        // this is a separate call path (saveManager.js calls it directly),
        // so it needs its own copy of the "load it if it's missing" check.
        await Promise.all(
            withLocal
                .filter(id => id !== LOCAL_PLUGIN_ID)
                .map(id => ensurePluginLoaded(id).catch(err =>
                    console.warn(`[DataLoader] Could not load "${id}":`, err)
                ))
        );
        _activePlugins = withLocal.filter(id =>
            id === LOCAL_PLUGIN_ID || window.allData[id]
        );
        _saveActivePlugins();
        if (window.EsAuth) window.EsAuth.saveActivePluginsPreference(_activePlugins);
        _fireEvent('pluginsChanged', { active: [..._activePlugins] });
    },

    async initDefaultPlugins() {
        // Account preference takes priority when logged in; falls through
        // to localStorage if signed out or nothing saved yet, so anonymous
        // use still works exactly as before.
        let saved = null;
        if (window.EsAuth) {
            try { saved = await window.EsAuth.getActivePluginsPreference(); } catch (_) { /* fall through */ }
        }
        if (!saved) saved = _loadActivePlugins();

        if (saved && saved.length > 0) {
            const valid = saved.filter(id =>
                id === LOCAL_PLUGIN_ID
                    ? !!(window.allData[LOCAL_PLUGIN_ID]?.ships?.length > 0)
                    : !!window.allData[id]
            );
            if (valid.length > 0) {
                _activePlugins = valid;
                _fireEvent('pluginsChanged', { active: [..._activePlugins] });
                return;
            }
        }
        // FIX: DEFAULT_PLUGIN is written in plugin_id format
        // ("official-game/endless-sky"), but window.allData is keyed by
        // output_name ("endless-sky") — those never matched, so this
        // silently fell through to "whichever plugin happens to be
        // first" instead of actually picking the base game. Match on
        // sourceName instead, which is reliably "official-game" for the
        // base game regardless of its output folder name.
        const baseGameEntry = Object.values(window.allData).find(p =>
            p && p.outputName && (p.sourceName === 'official-game' || p.outputName === DEFAULT_PLUGIN)
        );
        const defaultRemote = baseGameEntry
            ? baseGameEntry.outputName
            : Object.keys(window.allData).find(k => k !== LOCAL_PLUGIN_ID);
        _activePlugins = defaultRemote
            ? [LOCAL_PLUGIN_ID, defaultRemote]
            : [LOCAL_PLUGIN_ID];
        _saveActivePlugins();
        if (window.EsAuth) window.EsAuth.saveActivePluginsPreference(_activePlugins);
        _fireEvent('pluginsChanged', { active: [..._activePlugins] });
    },

    // ── Data accessors (active plugins only) ──────────────
    getAllShips() {
        const ships = [];
        for (const [id, plugin] of Object.entries(_activeData())) {
            const display = plugin.displayName || id;
            const isLocal = id === LOCAL_PLUGIN_ID;
            for (const s of (plugin.ships || []))
                ships.push({ ...s, _pluginName: id, _pluginDisplay: display, _isLocal: isLocal });
            for (const s of (plugin.variants || []))
                ships.push({ ...s, _pluginName: id, _pluginDisplay: display, _isVariant: true, _isLocal: isLocal });
        }
        return ships;
    },

    getAllOutfits() {
        const outfits = [];
        for (const [id, plugin] of Object.entries(_activeData())) {
            if (id === LOCAL_PLUGIN_ID) continue;
            const display = plugin.displayName || id;
            for (const o of (plugin.outfits || []))
                outfits.push({ ...o, _pluginName: id, _pluginDisplay: display });
        }
        return outfits;
    },

    getAllEffects() {
        const effects = [];
        for (const [id, plugin] of Object.entries(_activeData())) {
            if (id === LOCAL_PLUGIN_ID) continue;
            const display = plugin.displayName || id;
            for (const e of (plugin.effects || []))
                effects.push({ ...e, _pluginName: id, _pluginDisplay: display });
        }
        return effects;
    },

    // Fire pluginsChanged so all listeners (generalPluginStuff, shipBuilder) refresh
    refreshLocalBuilds() {
        _refreshLocalPlugin();
        _fireEvent('pluginsChanged', { active: [..._activePlugins] });
    },

    // Silent refresh — updates window.allData[LOCAL_PLUGIN_ID] WITHOUT firing
    // pluginsChanged. Used by generalPluginStuff.js to avoid infinite event loops.
    _refreshLocalOnly() {
        _refreshLocalPlugin();
    },

    // ── Attribute helpers ──────────────────────────────────
    getAttrKeys() {
        if (!window.attrDefs || !window.attrDefs.attributes) return [];
        return Object.keys(window.attrDefs.attributes).sort();
    },

    getAttrDef(key) {
        if (!window.attrDefs || !window.attrDefs.attributes) return null;
        return window.attrDefs.attributes[key] || null;
    },

    getAttrHint(key) {
        const def = this.getAttrDef(key);
        if (!def) return '';
        const parts = [];
        if (def.displayUnit) parts.push(def.displayUnit);
        if (def.stacking)    parts.push(def.stacking);
        return parts.join(' · ');
    },

    _setActivePluginsSilent(arr) {
        _activePlugins = arr.filter(id => id === LOCAL_PLUGIN_ID || window.allData[id]);
        _saveActivePlugins();
    },

    LOCAL_PLUGIN_ID,
    DEFAULT_PLUGIN,
};

// ── Persistence for active plugin selection ─────────────────
const _ACTIVE_KEY = 'es_sb_active_plugins';
function _saveActivePlugins() {
    try { localStorage.setItem(_ACTIVE_KEY, JSON.stringify(_activePlugins)); } catch(_) {}
}
function _loadActivePlugins() {
    try { return JSON.parse(localStorage.getItem(_ACTIVE_KEY)); } catch(_) { return null; }
}

// ── Remote data loader ───────────────────────────────────────
//
// Two phases:
//   Phase A — fetch only the plugins the user actually has active
//   (read from the same localStorage key initDefaultPlugins() uses),
//   reconstruct them, and let the page render. This is what the user
//   sees load.
//   Phase B — everything else loads afterward, in the background,
//   without blocking anything already on screen. Each plugin's bundle
//   is cached independently (not as one giant blob), so if the user
//   navigates to another page before Phase B finishes — which kills
//   this background work entirely, since a page navigation is a fresh
//   JS context — the next page just resumes from whatever's already
//   cached and fetches only what it's still missing. No plugin is ever
//   blocked waiting on a background process it can't see.

function reconstructShip(row, outfitsByOwnerId) {
    const h  = row.hardpoints || {};
    const ex = row.explosions || {};
    return {
        name: row.name,
        // the name the game shows players, when the data gives one ("display name")
        displayName: (row.attributes && row.attributes['display name']) || null,
        sprite: row.sprite,
        thumbnail: row.thumbnail,
        description: row.description,
        attributes: row.attributes || {},
        guns: h.guns || [], turrets: h.turrets || [], bays: h.bays || [],
        engines: h.engines || [], leaks: h.leaks || [],
        reverseEngines: h.reverseEngines || [], steeringEngines: h.steeringEngines || [],
        'tiny explosion': ex.tiny, 'small explosion': ex.small,
        'medium explosion': ex.medium, 'large explosion': ex.large,
        'huge explosion': ex.huge, 'final explode': ex.final,
        locations: row.locations || {},
        outfits: outfitsByOwnerId.get(row.id) || {},
        _pluginId: row.plugin_id,
        _internalId: row.internal_id,
    };
}
function reconstructVariant(row, outfitsByOwnerId) {
    const v = reconstructShip(row, outfitsByOwnerId);
    v.baseShip = row.base_ship_name;
    v._variantPluginId = row.variant_plugin_id;
    return v;
}
function reconstructOutfit(row) {
    // Note: outfits use non-underscore "pluginId"/"internalId" — matches
    // the original JSON output's naming, kept as-is so nothing downstream
    // that reads o.pluginId (vs. a ship's s._pluginId) silently breaks.
    return {
        ...(row.attributes || {}),
        name: row.name, category: row.category, cost: row.cost, mass: row.mass,
        thumbnail: row.thumbnail, description: row.description,
        pluginId: row.plugin_id, internalId: row.internal_id,
    };
}
function reconstructEffect(row) {
    return {
        name: row.name, sprite: row.sprite, sound: row.sound,
        lifetime: row.lifetime,
        'random angle': row.random_angle, 'random frame rate': row.random_frame_rate,
        'random spin': row.random_spin, 'random velocity': row.random_velocity,
        'velocity scale': row.velocity_scale,
        spriteData: row.sprite_data, 'sprite data': row.sprite_data,
        pluginId: row.plugin_id,
    };
}

/**
 * Fetches and reconstructs ONE plugin's ships/variants/outfits/effects.
 * A ship can equip an outfit defined by a *different* plugin (that's the
 * whole reason ship_outfits is a separate table) — so this doesn't just
 * filter outfits by this plugin's own id, it also resolves whichever
 * outfits this plugin's ships/variants actually reference, wherever
 * they're defined, via one small extra by-id lookup.
 */
// One request for a plugin's whole catalog, or null if the database function
// isn't installed yet (then the caller fetches table by table, as before).
let _rpcCatalogMissing = false;
async function _rpcCatalog(pluginId) {
    if (_rpcCatalogMissing) return null;
    try {
        const { data, error } = await window.supabaseClient.rpc('get_plugin_catalog', { p_plugin_id: pluginId });
        if (error || !data || !Array.isArray(data.ships)) {
            if (error && /function|does not exist|PGRST202/i.test(error.message || error.code || '')) _rpcCatalogMissing = true;
            return null;
        }
        return data;
    } catch (_) { return null; }
}

async function _fetchPluginBundleFresh(outputName, pluginRow) {
    const { fetchAllRows } = window.SupabaseHelpers;
    if (!pluginRow) {
        return { sourceName: outputName, displayName: outputName, outputName, ships: [], variants: [], outfits: [], effects: [] };
    }
    const byPlugin = q => q.eq('plugin_id', pluginRow.plugin_id);

    // Fast path: the whole catalog in ONE request (supabase/performance.sql,
    // get_plugin_catalog). If that function isn't installed, fall back to
    // fetching table by table below.
    let shipRows, variantRows, ownOutfitRows, effectRows, shipOutfitRows, variantOutfitRows, crossPluginOutfitRows;
    const rpc = await _rpcCatalog(pluginRow.plugin_id);
    if (rpc) {
        ({ ships: shipRows, variants: variantRows, outfits: ownOutfitRows, effects: effectRows,
           ship_outfits: shipOutfitRows, variant_outfits: variantOutfitRows, extra_outfits: crossPluginOutfitRows } = rpc);
    } else {
    [shipRows, variantRows, ownOutfitRows, effectRows] = await Promise.all([
        fetchAllRows('ships',    { filters: byPlugin, orderBy: 'id' }),
        fetchAllRows('variants', { filters: byPlugin, orderBy: 'id' }),
        fetchAllRows('outfits',  { filters: byPlugin, orderBy: 'id', pageSize: 200 }),
        fetchAllRows('effects',  { filters: byPlugin, orderBy: 'id' }),
    ]);

    const shipIds    = shipRows.map(s => s.id);
    const variantIds  = variantRows.map(v => v.id);
    [shipOutfitRows, variantOutfitRows] = await Promise.all([
        shipIds.length    ? fetchAllRows('ship_outfits',    { filters: q => q.in('ship_id', shipIds) })    : [],
        variantIds.length ? fetchAllRows('variant_outfits', { filters: q => q.in('variant_id', variantIds) }) : [],
    ]);

    // Which referenced outfits aren't already covered by this plugin's own outfits?
    const ownOutfitIds  = new Set(ownOutfitRows.map(o => o.id));
    const referencedIds = new Set([...shipOutfitRows.map(r => r.outfit_id), ...variantOutfitRows.map(r => r.outfit_id)]);
    const missingIds    = [...referencedIds].filter(id => !ownOutfitIds.has(id));
    crossPluginOutfitRows = missingIds.length
        ? await fetchAllRows('outfits', { filters: q => q.in('id', missingIds), pageSize: 200 })
        : [];
    }

    const outfitById = new Map([...ownOutfitRows, ...crossPluginOutfitRows].map(o => [o.id, o]));
    function buildOutfitMaps(junctionRows, ownerKey) {
        const byOwner = new Map();
        for (const row of junctionRows) {
            const outfit = outfitById.get(row.outfit_id);
            if (!outfit) continue;
            if (!byOwner.has(row[ownerKey])) byOwner.set(row[ownerKey], {});
            byOwner.get(row[ownerKey])[outfit.name] = { count: row.count, pluginId: outfit.plugin_id, internalId: outfit.internal_id };
        }
        return byOwner;
    }
    const shipOutfitsByShipId       = buildOutfitMaps(shipOutfitRows, 'ship_id');
    const variantOutfitsByVariantId = buildOutfitMaps(variantOutfitRows, 'variant_id');

    return {
        sourceName: pluginRow.source_name,
        displayName: pluginRow.display_name || outputName,
        outputName,
        ships:    shipRows.map(row => reconstructShip(row, shipOutfitsByShipId)),
        variants: variantRows.map(row => reconstructVariant(row, variantOutfitsByVariantId)),
        outfits:  ownOutfitRows.map(reconstructOutfit),
        effects:  effectRows.map(reconstructEffect),
    };
}

async function _loadPluginBundle(outputName, pluginRow) {
    const build = () => _fetchPluginBundleFresh(outputName, pluginRow);
    return window.EsCache
        ? await window.EsCache.loadWithCache(`pluginBundle:${outputName}`, build)
        : await build();
}

/** Phase B — loads whatever Phase A didn't, one plugin at a time, without
 * blocking. Only runs for as long as this page stays open; the per-plugin
 * cache is what carries progress forward if the user navigates away. */
async function _backgroundFillRemainingPlugins(pluginRows, alreadyLoaded) {
    const remaining = pluginRows.filter(p => !alreadyLoaded.has(p.output_name));
    if (!remaining.length) return;
    // This is only a head start for switching plugins later (a plugin you
    // switch on is loaded on demand anyway), so it must never slow the page
    // down: skip it on slow or data-saving connections, wait until the page
    // has settled, and only work while the browser is idle.
    const conn = navigator.connection || {};
    if (conn.saveData || /(^|-)2g|3g/.test(conn.effectiveType || '')) {
        console.log('[DataLoader] Background: skipped (slow or data-saving connection) — plugins load when you switch them on.');
        return;
    }
    const idle = () => new Promise(r => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 4000 }) : setTimeout(r, 300)));
    await new Promise(r => setTimeout(r, 5000));
    console.log(`[DataLoader] Background: loading ${remaining.length} remaining plugin(s)...`);
    for (const pluginRow of remaining) {
        await idle();
        try {
            const bundle = await _loadPluginBundle(pluginRow.output_name, pluginRow);
            window.allData[pluginRow.output_name] = bundle;
            _fireEvent('pluginDataAvailable', { outputName: pluginRow.output_name });
        } catch (err) {
            console.warn(`[DataLoader] Background load failed for "${pluginRow.output_name}":`, err);
        }
    }
    console.log('[DataLoader] Background fill complete — every plugin is now loaded.');
    _fireEvent('allPluginsLoaded', {});
}

// ─────────────────────────────────────────────────────────────────────────
//  ATTRIBUTE TABLES → window.attrDefs
//  Inverse of attrDefsToRows() in attributeSync.js — keep the two in step.
// ─────────────────────────────────────────────────────────────────────────

const _DB_TO_LEVEL = { required: 'required', recommended: 'recommended', engine_derived: 'engineDerived' };

function rebuildAttrDefsFromTables({ definitions, flags, badges, navFns, tooltips, calculations }) {
    const tooltipMap = {};
    for (const t of tooltips || []) tooltipMap[t.key] = t.tooltip;

    const attributes = {};
    for (const d of definitions || []) {
        const a = { key: d.key, ...(d.extra || {}) };
        if (d.display_unit         != null) a.displayUnit         = d.display_unit;
        if (d.display_multiplier   != null) a.displayMultiplier   = Number(d.display_multiplier);
        if (d.is_boolean)                   a.isBoolean           = true;
        if (d.description          != null) a.description         = d.description;
        a.area = d.area ?? null;
        if (d.ship_panel_label     != null) a.shipPanelLabel      = d.ship_panel_label;
        if (d.stacking             != null) a.stacking            = d.stacking;
        if (d.stacking_description != null) a.stackingDescription = d.stacking_description;
        a.areaBadges = [];

        const tip = tooltipMap[d.key.toLowerCase()];
        if (tip) a.tooltip = tip;

        if (d.ship_requirement || d.min_value != null) {
            const req = {
                level:    _DB_TO_LEVEL[d.ship_requirement] || null,
                reasons:  d.requirement_reasons || [],
                coverage: d.presence_pct_official != null ? Number(d.presence_pct_official) / 100 : null,
            };
            if (d.min_value      != null) req.min           = Number(d.min_value);
            if (d.min_exclusive  != null) req.minExclusive  = !!d.min_exclusive;
            if (d.engine_default != null) req.engineDefault = Number(d.engine_default);
            a.shipRequirement     = req;
            a.isRequiredOnShip    = req.level === 'required';
            a.isRecommendedOnShip = req.level === 'recommended';
        }
        if (d.presence_pct_all != null) a.presencePctAll = Number(d.presence_pct_all);
        attributes[d.key] = a;
    }

    for (const f of flags  || []) if (attributes[f.attribute_key]) attributes[f.attribute_key][f.flag_name] = true;
    for (const b of badges || []) if (attributes[b.attribute_key]) attributes[b.attribute_key].areaBadges.push(b.badge);
    for (const n of navFns || []) {
        const a = attributes[n.attribute_key];
        if (a) (a.usedInNavFunctions = a.usedInNavFunctions || []).push(n.function_name);
    }

    const out = {};
    for (const c of calculations || []) out[c.section] = c.value;
    out.attributes = attributes;
    out.tooltips   = tooltipMap;
    return out;
}

async function _loadAttrDefsFromTables() {
    const { fetchAllRows } = window.SupabaseHelpers;
    const [definitions, flags, badges, navFns, tooltips, calculations] = await Promise.all([
        fetchAllRows('attribute_definitions',   { orderBy: 'key' }),
        fetchAllRows('attribute_flags',         { select: 'attribute_key, flag_name', orderBy: 'id' }),
        fetchAllRows('attribute_area_badges',   { select: 'attribute_key, badge', orderBy: 'id' }),
        fetchAllRows('attribute_nav_functions', { select: 'attribute_key, function_name', orderBy: 'id' }),
        fetchAllRows('attribute_tooltips',      { orderBy: 'key' }),
        fetchAllRows('attribute_calculations',  { orderBy: 'section' }),
    ]);
    if (!definitions.length) return null;   // tables not populated yet → caller falls back
    return rebuildAttrDefsFromTables({ definitions, flags, badges, navFns, tooltips, calculations });
}

window.rebuildAttrDefsFromTables = rebuildAttrDefsFromTables;

async function _doLoad() {
    _loading = true;
    _fireEvent('dataLoadStart');

    // Seed local builds immediately so it's always available
    _refreshLocalPlugin();

    try {
        // 1 + 2 together — attribute definitions and the plugin list don't
        // depend on each other, so ask for both at once. Attribute
        // definitions only change when the parser runs, so they're cached in
        // the browser (EsCache, checked against the data version).
        const { fetchAllRows } = window.SupabaseHelpers;
        const pluginRowsPromise = fetchAllRows('plugins', { orderBy: 'source_priority' });
        const loadAttrDefs = async () => {
            try {
                const defs = await _loadAttrDefsFromTables();
                if (defs) return defs;
            } catch (err) {
                console.warn('[DataLoader] Attribute tables unavailable, falling back to app_config:', err.message);
            }
            try {
                const { data, error } = await window.supabaseClient
                    .from('app_config').select('value').eq('key', 'attributeDefinitions').maybeSingle();
                if (!error && data) return data.value;
            } catch (_) {
                console.warn('[DataLoader] Could not load attributeDefinitions from app_config');
            }
            return null;
        };
        window.attrDefs = window.EsCache ? await window.EsCache.loadWithCache('attrDefs', loadAttrDefs) : await loadAttrDefs();
        if (window.attrDefs?.attributes) console.log(`[DataLoader] attrDefs ready (${Object.keys(window.attrDefs.attributes).length} attributes)`);

        // 2 — The plugin list itself is small (~110 rows, no heavy JSON
        // columns) — always cheap enough to fetch in full up front, so we
        // know what exists and can decide what Phase A actually needs.
        const pluginRows = await pluginRowsPromise;
        if (!pluginRows.length) throw new Error('No plugins found in Supabase');

        // The picker (generalPluginStuff.js) reads plugin names from
        // window.allData's keys, and only shows what's actually there —
        // so without this, it'd only show whatever Phase A/B happened to
        // have loaded so far, not every plugin that exists. A placeholder
        // with empty arrays is enough for it to show up as selectable;
        // Phase A/B/ensurePluginLoaded below replace it with real data
        // the moment that plugin actually loads (they just assign over
        // window.allData[outputName] wholesale, so this is never stale
        // once real data arrives).
        for (const p of pluginRows) {
            if (!window.allData[p.output_name]) {
                window.allData[p.output_name] = {
                    sourceName: p.source_name, displayName: p.display_name || p.output_name,
                    outputName: p.output_name, ships: [], variants: [], outfits: [], effects: [],
                    _placeholder: true,
                };
            }
        }

        // 3 — Phase A: whichever plugins are already active — preferring
        // the logged-in user's account preference over localStorage, so
        // it follows them across devices — or a sensible default if
        // nothing's saved anywhere yet. This is the ONLY thing standing
        // between page load and the page being usable — everything else
        // happens after.
        let saved = null;
        if (window.EsAuth) {
            try { saved = await window.EsAuth.getActivePluginsPreference(); } catch (_) { /* fall through */ }
        }
        if (!saved) saved = _loadActivePlugins();
        saved = saved || [];
        let phaseANames = new Set(saved.filter(id => id !== LOCAL_PLUGIN_ID));
        phaseANames = new Set([...phaseANames].filter(n => pluginRows.some(p => p.output_name === n)));
        if (phaseANames.size === 0) {
            const def = pluginRows.find(p =>
                p.plugin_id === DEFAULT_PLUGIN || p.output_name === DEFAULT_PLUGIN || p.source_name === 'official-game'
            ) || pluginRows[0];
            if (def) phaseANames.add(def.output_name);
        }

        await Promise.all([
            ...[...phaseANames].map(async outputName => {
                const pluginRow = pluginRows.find(p => p.output_name === outputName);
                window.allData[outputName] = await _loadPluginBundle(outputName, pluginRow);
            }),
            (async () => { Object.assign(window.allData, await _fetchPublicBuildPlugins()); })(),
        ]);

        const hasData = Object.values(window.allData).some(p =>
            (p.ships?.length > 0) || (p.variants?.length > 0) || (p.outfits?.length > 0)
        );
        if (!hasData) throw new Error('No data could be loaded from Supabase');

        _ready   = true;
        _loading = false;

        // Rebuild local plugin now that remote outfits are loaded, so the
        // local plugin's outfit index is populated for ComputedStats.
        _refreshLocalPlugin();

        await window.DataLoader.initDefaultPlugins();

        for (const fn of _callbacks) {
            try { fn(window.allData); } catch(e) { console.error('[DataLoader] callback error:', e); }
        }
        _callbacks = [];

        _fireEvent('dataLoaded', { allData: window.allData, attrDefs: window.attrDefs });

        // 4 — Phase B: fill in everything else in the background. Not
        // awaited — the page is already usable at this point, this just
        // keeps going quietly so switching to a plugin that wasn't in
        // Phase A is instant (or close to it) if it finishes in time.
        _backgroundFillRemainingPlugins(pluginRows, phaseANames).catch(err =>
            console.warn('[DataLoader] Background fill errored:', err)
        );

        return window.allData;

    } catch (error) {
        _loading = false;
        console.error('[DataLoader] Load failed:', error);
        _fireEvent('dataLoadError', { message: error.message });
        throw error;
    }
}

/**
 * Safety net for code that needs a SPECIFIC plugin's data right now —
 * e.g. the user switches to a plugin that wasn't in Phase A and whose
 * background load (this page's or a previous page's) hasn't reached it
 * yet. Loads it directly in the foreground rather than waiting on
 * whatever background progress may or may not exist.
 */
async function ensurePluginLoaded(outputName) {
    if (outputName === LOCAL_PLUGIN_ID) return window.allData[LOCAL_PLUGIN_ID];
    if (window.allData[outputName]?.ships || window.allData[outputName]?.outfits) {
        return window.allData[outputName]; // already loaded, nothing to do
    }
    // Public-build pseudo-plugins have no row in the plugins table (they're
    // synthetic, built from saved_ships) — querying for one would find
    // nothing and silently produce an empty bundle. These are normally
    // already loaded eagerly during Phase A; this only matters if one
    // became public after this page's load already ran.
    if (outputName.startsWith(PUBLIC_PLUGIN_PREFIX)) {
        const buckets = await _fetchPublicBuildPlugins();
        Object.assign(window.allData, buckets);
        _fireEvent('pluginDataAvailable', { outputName });
        return window.allData[outputName];
    }
    const { fetchAllRows } = window.SupabaseHelpers;
    const pluginRows = await fetchAllRows('plugins', { filters: q => q.eq('output_name', outputName) });
    const pluginRow = pluginRows[0];
    const bundle = await _loadPluginBundle(outputName, pluginRow);
    window.allData[outputName] = bundle;
    _fireEvent('pluginDataAvailable', { outputName });
    return bundle;
}

})();

// ═══════════════════════════════════════════════════════════════════════════
//  ShipNames — one way to show and search ship names everywhere.
//  A ship with a "display name" (what the game shows, e.g. "Modified
//  Carrier") is shown by that name, with its internal name ("Carrier
//  (Alpha)") smaller and dimmer beside it. Searches match either.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const display = s => (s && (s.displayName || (s.attributes && s.attributes['display name']) || s['display name'])) || null;
    const ShipNames = {
        /** The main name to show. */
        label(s) { if (!s) return ''; const d = display(s); return d && d !== s.name ? d : (s.name || ''); },
        /** The internal name when it differs from the label (else ''). */
        internal(s) { if (!s) return ''; const d = display(s); return d && d !== s.name ? (s.name || '') : ''; },
        /** "Display  internal" — for search haystacks. */
        text(s) { return `${ShipNames.label(s)} ${ShipNames.internal(s)}`.trim(); },
        /** Does the ship match a search (name or display name)? */
        matches(s, q) {
            q = String(q || '').trim().toLowerCase();
            if (!q) return true;
            return ShipNames.text(s).toLowerCase().includes(q);
        },
        /** HTML: display name, then the internal name small and dim. `wrap` escapes/highlights the main part. */
        html(s, wrap) {
            const main = ShipNames.label(s), sub = ShipNames.internal(s);
            return `${wrap ? wrap(main) : esc(main)}${sub ? ` <span class="ship-realname" title="Internal name">${esc(sub)}</span>` : ''}`;
        },
    };
    window.ShipNames = ShipNames;

    // OutfitNames — the same for outfits ("Tiny VLS" shows as "Vertical Launch
    // Array (9)"). Works on an outfit object, or on just its internal name
    // (looked up in the selected plugins).
    let idxKey = '', idx = new Map();
    function outfitByName(name) {
        const data = (window.DataLoader && window.DataLoader.getActiveData) ? window.DataLoader.getActiveData() : (window.allData || {});
        const key = Object.keys(data).map(k => k + ':' + ((data[k].outfits || []).length)).join('|');
        if (key !== idxKey) {
            idxKey = key; idx = new Map();
            for (const p of Object.values(data)) for (const o of p.outfits || []) if (o && o.name && !idx.has(o.name)) idx.set(o.name, o);
        }
        return idx.get(name) || null;
    }
    const asOutfit = o => (typeof o === 'string' ? (outfitByName(o) || { name: o }) : o);
    const OutfitNames = {
        label(o) { return ShipNames.label(asOutfit(o)); },
        internal(o) { return ShipNames.internal(asOutfit(o)); },
        text(o) { return ShipNames.text(asOutfit(o)); },
        matches(o, q) { return ShipNames.matches(asOutfit(o), q); },
        html(o, wrap) { return ShipNames.html(asOutfit(o), wrap); },
        get: outfitByName,
    };
    window.OutfitNames = OutfitNames;
})();
