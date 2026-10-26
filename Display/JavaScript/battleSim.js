;(function () {
'use strict';

// The battle simulator page: teams, ships, pilot skill, and the frame-by-frame fight.

const FPS          = 60;
const MAX_SIM_SECS = 6000;
const MAX_FRAMES   = MAX_SIM_SECS * FPS;
const SOLAR_POWER  = 1.0;
const SHIELD_BLEED_FRACTION = 0.5;

let _allShips          = [];
let _outfitIndex       = {};
let _attrDefs          = null;
let _damageTypes       = [];
let _statusDecayMap    = {};
let _statusDescriptors = [];
let _weaponDataKeys    = new Set();

let _simCancelled = false;

// ── teams ──
let _teams = [];
let _nextTeamId = 1;

const TEAM_PALETTE = [
    '#3b82f6','#ef4444','#22c55e','#f59e0b','#a855f7',
    '#06b6d4','#f43f5e','#84cc16','#fb923c','#8b5cf6',
    '#14b8a6','#ec4899','#eab308','#6366f1','#10b981',
    '#f97316','#d946ef','#0ea5e9','#dc2626','#16a34a',
    '#7c3aed','#0891b2','#db2777','#ca8a04','#059669',
    '#4f46e5','#9333ea','#0284c7','#b91c1c','#15803d',
];

// Fallbacks — firingStatusMap() / firingResourceKeys() read the weapon keys
// the parser extracted (gameKeys.js).
const FIRING_STATUS_MAP_FALLBACK = {
    ionization: 'firing ion',
    scrambling: 'firing scramble',
    disruption: 'firing disruption',
    discharge:  'firing discharge',
    corrosion:  'firing corrosion',
    leak:       'firing leak',
    burn:       'firing burn',
    slowing:    'firing slowing',
};

const FIRING_RESOURCE_KEYS_FALLBACK = ['firing energy', 'firing fuel', 'firing hull', 'firing shields'];
// weapon status effects → resource they drain
function firingStatusMap() {
    return window.GameKeys ? window.GameKeys.firingStatusMap(FIRING_STATUS_MAP_FALLBACK) : FIRING_STATUS_MAP_FALLBACK;
}
// pools a weapon can run dry of (heat fills up instead)
function firingResourceKeys() {
    const all = window.GameKeys ? window.GameKeys.firingCostKeys(null) : null;
    return all ? all.filter(k => k !== 'firing heat') : FIRING_RESOURCE_KEYS_FALLBACK;
}
const MISSILE_STRENGTH_KEY  = 'missile strength';
// label for a resource
function resourceLabel(key) { return key.replace(/^firing\s+/, ''); }

// ── formatting (from the stats display) ──
const fmt       = (...a) => window.BattleSimDisplay?.fmt(...a)     ?? String(a[0] ?? '—');
// seconds → "1m 20s"
const fmtT      = (...a) => window.BattleSimDisplay?.fmtT(...a)    ?? String(a[0] ?? '—');
const escHtml   = (...a) => window.BattleSimDisplay?.escHtml(...a) ?? String(a[0] ?? '');

// start: wait for DataLoader, then set up the page. Called on page load

async function init() {
    hideResults();
    setStatus('Loading plugin data…');

    // DataLoader handles all fetching, caching and localStorage plugin management.
    // We register a ready callback so we can pull _attrDefs and wire up the rest.
    if (!window.DataLoader) {
        setStatus('Error: dataLoader.js must be loaded before battleSim.js', true);
        return;
    }

    window.DataLoader.onReady(() => {
        // Pull attribute definitions that DataLoader already fetched
        _attrDefs = window.attrDefs || null;
        if (_attrDefs) {
            _damageTypes       = _attrDefs?.weapon?.damageTypes || [];
            const sed          = _attrDefs?.weapon?.statusEffectDecay;
            _statusDecayMap    = sed?.decayMap    || {};
            _statusDescriptors = sed?.descriptors || [];
            _weaponDataKeys    = new Set(_attrDefs?.weapon?.dataFileKeys || []);

            if (typeof initComputedStats       === 'function') initComputedStats(_attrDefs, _baseUrl());
            if (typeof window.DamageTypes?.init       === 'function') window.DamageTypes.init(_attrDefs);
            if (typeof window.MunitionTypes?.init     === 'function') window.MunitionTypes.init(() => _outfitIndex, _attrDefs);
            if (typeof window.AntiMissileAnalysis?.init === 'function') window.AntiMissileAnalysis.init(() => _outfitIndex, _attrDefs);
            if (typeof window.MovementStats?.init     === 'function') window.MovementStats.init(_attrDefs);
        }

        setStatus('');
        // rebuild team ships when the selected plugins change
        window._renderCardsFromManager = async () => { await onPluginsChanged(); };
        // initDefaultPlugin fires pluginsChanged → onPluginsChanged via the hook above
        window.PluginManager.initDefaultPlugin();
    });

    // Also rebuild ships/outfits whenever the active plugin set changes
    document.addEventListener('pluginsChanged', () => onPluginsChanged());
}

// GitHub base URL DataLoader uses
function _baseUrl() {
    const REPO_URL = 'GIVEMEFOOD5/endless-sky-nexus';
    return `https://raw.githubusercontent.com/${REPO_URL}/main/data`;
}

// status line under the fight button
function setStatus(msg, isError = false) {
    const el = document.getElementById('simStatus');
    if (!el) return;
    el.textContent   = msg;
    el.style.color   = isError ? 'var(--c-danger-text)' : 'var(--c-text-muted)';
    el.style.display = msg ? 'block' : 'none';
}

// plugins loaded or changed: refresh ship lists and teams. Called by: init, the plugin picker

async function onPluginsChanged() {
    try {
        _allShips    = [];
        _outfitIndex = {};

        const activePlugins = window.PluginManager.getActivePlugins();
        const allData       = window.allData || {};

        // Outfits come only from the selected plugins, in their selected order:
        // a ship can't use an outfit from a plugin that isn't installed.
        const searchOrder = [...activePlugins];

        // Handle both array and map formats for outfits
        for (const pid of searchOrder) {
            const d = allData[pid]; if (!d) continue;
            const outfitsRaw = d.outfits || [];
            const outfitsArr = Array.isArray(outfitsRaw)
                ? outfitsRaw
                : Object.values(outfitsRaw);
            for (const outfit of outfitsArr)
                if (outfit.name && !_outfitIndex[outfit.name])
                    _outfitIndex[outfit.name] = { ...outfit, _pluginId: pid };
        }

        for (const pid of activePlugins) {
            const d = allData[pid]; if (!d) continue;
            for (const ship of [...(d.ships || []), ...(d.variants || [])])
                _allShips.push({ ...ship, _pluginId: pid });
        }

        console.log(`[battleSim] onPluginsChanged: ${Object.keys(_outfitIndex).length} outfits indexed, ${_allShips.length} ships loaded`);

        const primaryPlugin = window.PluginManager.getPrimaryPlugin();
        if (primaryPlugin) {
            if (typeof window.setCurrentPlugin === 'function') window.setCurrentPlugin(primaryPlugin);
            if (typeof window.initImageIndex   === 'function') await window.initImageIndex(primaryPlugin);
        }

        document.getElementById('simPanel').style.display = 'block';
        renderAllTeams();
        updateSimButton();
        loadPendingMatchup();
        loadSharedBattle();

    } catch (err) {
        console.error('[battleSim] onPluginsChanged failed:', err);
    }
}

// start a fight once everything has loaded (from a link or auto-fit). Called by: loadSharedBattle, loadPendingMatchup
function runWhenReady(tries = 0) {
    if ((!_attrDefs || !window.DamageTypes?.isReady()) && tries < 30) { setTimeout(() => runWhenReady(tries + 1), 1000); return; }
    setTimeout(() => runSimulation(), 500);
}

// ── share links: game ships by name, your designs inside the link ──
function designFor(shipData) {
    if (shipData._isLocalBuild && shipData._localId != null) {
        try {
            const fleet = JSON.parse(localStorage.getItem('es_ship_builder_v4') || '[]');
            const d = fleet.find(s => s.id === shipData._localId);
            if (d) { const c = { ...d }; delete c.id; delete c.description; delete c.extraLines; return c; }
        } catch (_) {}
    }
    return null;
}
// 🔗 Share this battle
async function shareBattle() {
    if (!window.ShareLinks) return;
    const skipped = [];
    const teams = _teams.map(t => ({
        n: t.name,
        s: t.ships.map(e => {
            const isGame = !e.shipData._isLocalBuild && !String(e.shipData._pluginId || '').startsWith('__');
            if (isGame) return [e.shipData.name, e.count, e.skilled ?? e.count];
            const d = designFor(e.shipData) || e.shipData._design || null;
            if (!d) { skipped.push(e.shipData.name); return null; }
            return [{ design: d }, e.count, e.skilled ?? e.count];
        }).filter(Boolean),
    }));
    const url = await ShareLinks.make('BattleSim.html', 'battle', { teams });
    ShareLinks.show(url, 'this battle');
    if (skipped.length) setStatus(`Not included in the link (can't be shared): ${skipped.join(', ')}`, true);
}
window.shareBattle = shareBattle;
// open a shared battle link. Called by: onPluginsChanged
async function loadSharedBattle() {
    if (!window.ShareLinks || !/[#&]battle=/.test(location.hash)) return;
    const data = await ShareLinks.read('battle');
    ShareLinks.clear();
    if (!data || data._broken || !Array.isArray(data.teams)) { setStatus('That battle link is damaged or incomplete.', true); return; }
    while (_teams.length < data.teams.length) createTeam('Team ' + (_teams.length + 1));
    for (const t of _teams) t.ships = [];
    const missing = [];
    data.teams.forEach((td, i) => {
        const team = _teams[i];
        team.name = td.n || team.name;
        for (const [ref, count, skilled] of td.s || []) {
            let ship = null;
            if (typeof ref === 'string') ship = _allShips.find(s => s.name === ref);
            else if (ref && ref.design && window.DataLoader?.normaliseDesign)
                ship = { ...window.DataLoader.normaliseDesign(ref.design), _pluginId: '__local_builds__', _design: ref.design };
            if (!ship) { missing.push(typeof ref === 'string' ? ref : 'a custom design'); continue; }
            addShipToTeam(team.id, ship, count || 1);
            const e = team.ships[team.ships.length - 1];
            if (e) e.skilled = Math.max(0, Math.min(e.count, skilled ?? e.count));
        }
    });
    renderAllTeams(); syncSkillMaster(); updateSimButton();
    if (missing.length) setStatus(`Some ships in this link aren't in your selected plugins: ${[...new Set(missing)].join(', ')}`, true);
    // the page finishes loading plugins in a second pass — start the fight after that
    if (_teams.filter(t => t.ships.length).length >= 2) runWhenReady();
}

// "⚔ Test in Battle Simulator" from auto-fit: the fit vs its enemies. Called by: onPluginsChanged
function loadPendingMatchup() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem('ES_BS_PENDING') || 'null'); } catch (_) {}
    if (!p || !p.fit || !window.DataLoader?.normaliseDesign) return;
    localStorage.removeItem('ES_BS_PENDING');
    while (_teams.length < 2) createTeam('Team ' + (_teams.length + 1));
    for (const t of _teams) t.ships = [];
    const fit = { ...window.DataLoader.normaliseDesign(p.fit), _pluginId: '__local_builds__' };
    _teams[0].name = p.fitLabel || fit.name;
    addShipToTeam(_teams[0].id, fit, 1);
    _teams[1].name = p.opponentLabel || 'Opponents';
    const missing = [];
    for (const o of p.opponents || []) {
        const ship = _allShips.find(s => s.name === o.name);
        if (ship) addShipToTeam(_teams[1].id, ship, o.count || 1); else missing.push(o.name);
    }
    renderAllTeams(); updateSimButton();
    if (_teams[1].ships.length) runWhenReady();
    else setStatus(`None of the opponent ships (${missing.join(', ')}) are in your selected plugins.`, true);
}
// how the game stacks an attribute. Called by: resolveShipStats

function getStacking(key) { return (_attrDefs?.attributes?.[key]?.stacking) || 'additive'; }
// protection attributes
function getProtectionKeys() {
    if (!_attrDefs?.attributes) return [];
    return Object.keys(_attrDefs.attributes).filter(k => k.endsWith(' protection'));
}

const dmgKey    = t => t.toLowerCase() + ' damage';
const protKey   = t => t.toLowerCase() + ' protection';
const relDmgKey = t => '% ' + t.toLowerCase() + ' damage';

// ── outfit attributes ──

const OUTFIT_META_KEYS = new Set([
    '_pluginId','name','displayName','pluralName','category',
    'weapon','attributes','description','thumbnail','sprite',
    'licenses','series','index','ammoStored','cost','mass',
    'flareSprites','reverseFlareSprites','steeringFlareSprites',
    'flareSounds','jumpEffects','hyperSounds','jumpSounds',
    'flotsamSprite','ammo','isDefined',
]);

// outfit → its attributes
function extractOutfitAttributes(outfit) {
    const merged = {};
    for (const [key, val] of Object.entries(outfit)) {
        if (OUTFIT_META_KEYS.has(key)) continue;
        if (typeof val === 'number') merged[key] = val;
    }
    if (outfit.attributes && typeof outfit.attributes === 'object')
        for (const [key, val] of Object.entries(outfit.attributes))
            if (typeof val === 'number') merged[key] = val;
    return merged;
}

// ── a ship's fighting stats ──

function _lookupOutfit(outfitName, pluginId) {
    // Tier 1: direct lookup in the outfit's own plugin
    const _active = window.PluginManager ? window.PluginManager.getActivePlugins() : null;
    if (pluginId && window.allData?.[pluginId] && (!_active || _active.includes(pluginId))) {
        const raw = window.allData[pluginId].outfits || [];
        const arr = Array.isArray(raw) ? raw : Object.values(raw);
        const found = arr.find(o => o.name === outfitName);
        if (found) return { ...found, _pluginId: pluginId };
    }

    // Tier 2: pre-built index (fast path for remote ships)
    if (_outfitIndex[outfitName]) return _outfitIndex[outfitName];

    // Tier 3: brute-force search all loaded plugins
    for (const [pid, pluginData] of Object.entries((window.DataLoader && typeof window.DataLoader.getActiveData === 'function' ? window.DataLoader.getActiveData() : (window.allData || {})))) {
        const raw = pluginData.outfits || [];
        const arr = Array.isArray(raw) ? raw : Object.values(raw);
        const found = arr.find(o => o.name === outfitName);
        if (found) return { ...found, _pluginId: pid };
    }

    return null;
}

// a ship's fighting stats. Called by: addShipToTeam
function resolveShipStats(ship) {
    const rawAttrs = ship.attributes || {};
    const combined = {};
    for (const [k, v] of Object.entries(rawAttrs)) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'object') { combined[k] = v; continue; }
        const n = Number(v);
        combined[k] = (String(v).trim() !== '' && isFinite(n)) ? n : v;
    }

    const weapons             = [];
    const outfitContributions = {};

    // outfits as one list, whatever format
    const outfitEntries = [];
    const outfitSource = ship.outfits || ship.outfitMap;

    if (outfitSource && typeof outfitSource === 'object' && !Array.isArray(outfitSource)) {
        // Map format (both 'outfits' and 'outfitMap' keys use same { count, pluginId } structure)
        for (const [name, val] of Object.entries(outfitSource)) {
            const cleanName = name.replace(/^"([^"]*)"$/, '$1');
            const qty       = typeof val === 'object' ? (parseInt(val.count)  || 1) : (Number(val) || 1);
            const pluginId  = typeof val === 'object' ? (val.pluginId || null)       : null;
            if (cleanName) outfitEntries.push({ name: cleanName, count: qty, pluginId });
        }
    } else if (Array.isArray(outfitSource)) {
        // Legacy array format — kept as fallback for any old cached data
        for (const o of outfitSource) {
            const cleanName = (typeof o === 'string' ? o : (o.name || '')).replace(/^"([^"]*)"$/, '$1');
            const qty       = typeof o === 'object' ? (parseInt(o.count)  || 1) : 1;
            const pluginId  = typeof o === 'object' ? (o.pluginId || null)       : null;
            if (cleanName) outfitEntries.push({ name: cleanName, count: qty, pluginId });
        }
    }

    // weapons and attributes
    for (const { name: outfitName, count: qty, pluginId } of outfitEntries) {
        const outfit = _lookupOutfit(outfitName, pluginId);
        if (!outfit) continue;

        if (outfit.weapon)
            // _turret: mounted in a turret (turns on its own) rather than a fixed gun port
            for (let i = 0; i < qty; i++) weapons.push({ _name: outfitName, _turret: (Number(extractOutfitAttributes(outfit)['turret mounts']) || 0) < 0, ...outfit.weapon });

        const attrs = extractOutfitAttributes(outfit);
        for (const [key, rawVal] of Object.entries(attrs)) {
            const contrib = rawVal * qty;
            switch (getStacking(key)) {
                case 'maximum': combined[key] = Math.max(combined[key] ?? -Infinity, contrib); break;
                case 'minimum': combined[key] = Math.min(combined[key] ??  Infinity, contrib); break;
                default:        combined[key] = (combined[key] || 0) + contrib;
            }
            if (rawVal !== 0) {
                if (!outfitContributions[key]) outfitContributions[key] = { total: 0, sources: [] };
                outfitContributions[key].total += contrib;
                outfitContributions[key].sources.push({ name: outfitName, qty, perUnit: rawVal });
            }
        }
    }

    // mass / drag fallback
    if (combined['mass'] == null && ship.mass != null && ship.mass !== '') {
        const n = Number(ship.mass); if (isFinite(n)) combined['mass'] = n;
    }
    if (combined['drag'] == null && ship.drag != null && ship.drag !== '') {
        const n = Number(ship.drag); if (isFinite(n)) combined['drag'] = n;
    }

    const a = k => combined[k] || 0;
    const rawMass      = a('mass');
    const inertialMass = rawMass / (1 + a('inertia reduction'));
    const drag         = Math.min(a('drag') / (1 + a('drag reduction')), inertialMass);
    const maxShields   = a('shields') * (1 + a('shield multiplier'));
    const maxHull      = a('hull')    * (1 + a('hull multiplier'));
    const absThresh    = a('absolute threshold');
    const minHull      = absThresh > 0
        ? absThresh
        : Math.max(0, Math.floor(a('threshold percentage') * maxHull + a('hull threshold')));

    const x                      = a('cooling inefficiency');
    const coolEff                = 2 + 2 / (1 + Math.exp(x / -2)) - 4 / (1 + Math.exp(x / -4));
    const maxHeat                = 100 * (rawMass + a('heat capacity'));
    const heatDissipFrac         = 0.001 * a('heat dissipation');
    const coolingPerFrame        = coolEff * (a('cooling') + a('active cooling'));
    const shieldRegenPerFrame    = a('shield generation')         * (1 + a('shield generation multiplier'));
    const delayedShieldPerFrame  = a('delayed shield generation') * (1 + a('shield generation multiplier'));
    const hullRepairPerFrame     = a('hull repair rate')          * (1 + a('hull repair multiplier'));
    const delayedHullPerFrame    = a('delayed hull repair rate')  * (1 + a('hull repair multiplier'));

    const protections = {};
    for (const key of getProtectionKeys()) protections[key] = Math.max(0, Math.min(1, a(key)));
    const shieldProt  = protections['shield protection'] || 0;
    const hullProt    = protections['hull protection']   || 0;
    const piercingRes = Math.max(0, Math.min(1, a('piercing resistance')));
    const statusResist = {};
    for (const [statName, resistKey] of Object.entries(_statusDecayMap))
        statusResist[statName] = Math.max(0, a(resistKey));

    const energyCap                 = a('energy capacity');
    const energyGenPerFrame         = a('energy generation') + a('solar collection') * SOLAR_POWER + a('ram scoop');
    const energyConsumeIdlePerFrame = a('energy consumption');
    const movingEnergyPerFrame      = a('thrusting energy') + a('turning energy') + a('afterburner energy');
    const coolingEnergyPerFrame     = a('cooling energy');
    const heatGenIdlePerFrame       = a('heat generation');
    const movingHeatPerFrame        = a('thrusting heat') + a('turning heat') + a('afterburner heat');
    const fuelCap                   = a('fuel capacity');
    const fuelRegenPerFrame         = a('fuel generation') + a('ram scoop') * 0;

    // ammo carried
    const ammoInventory = {};
    for (const { name: outfitName, count: qty, pluginId } of outfitEntries) {
        const outfit = _lookupOutfit(outfitName, pluginId);
        if (!outfit) continue;

        const isAmmoOutfit =
            outfit.category === 'Ammunition' ||
            (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0) ||
            (typeof outfit.attributes?.[outfitName] === 'number' && outfit.attributes[outfitName] > 0);
        if (!isAmmoOutfit) continue;

        let roundsPerUnit = 0;
        if (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0) roundsPerUnit = outfit.ammoStored;
        if (roundsPerUnit === 0) {
            const attrs = extractOutfitAttributes(outfit);
            if (typeof attrs[outfitName] === 'number' && attrs[outfitName] > 0) roundsPerUnit = attrs[outfitName];
        }
        if (roundsPerUnit === 0) roundsPerUnit = 1;
        ammoInventory[outfitName] = (ammoInventory[outfitName] || 0) + roundsPerUnit * qty;
    }

    const thrustForVel = a('thrust') || a('afterburner thrust');
    const maxVelocity  = drag > 0 ? thrustForVel / drag : 0;
    const acceleration = inertialMass > 0 ? (a('thrust') / inertialMass) * (1 + a('acceleration multiplier')) : 0;
    
    return {
        name: ship.name, pluginId: ship._pluginId, rawShip: ship,
        combined, weapons, outfitContributions, protections,
        maxShields, maxHull, minHull,
        hullToDisable: Math.max(0, maxHull - minHull),
        shieldRegenPerFrame, delayedShieldPerFrame,
        hullRepairPerFrame,  delayedHullPerFrame,
        shieldRegenPerSec: (shieldRegenPerFrame + delayedShieldPerFrame) * FPS,
        hullRepairPerSec:  (hullRepairPerFrame  + delayedHullPerFrame)  * FPS,
        shieldDelay: a('shield delay'), repairDelay: a('repair delay'),
        depletedDelay: a('depleted shield delay'),
        shieldProt, hullProt, piercingRes, statusResist,
        energyCap, energyGenPerFrame, energyConsumeIdlePerFrame,
        movingEnergyPerFrame, coolingEnergyPerFrame,
        maxHeat, heatDissipFrac, coolingPerFrame, coolingPerSec: coolingPerFrame * FPS,
        heatGenIdlePerFrame, movingHeatPerFrame, coolEff,
        fuelCap, fuelRegenPerFrame,
        rawMass, inertialMass, drag,
        maxVelocity: maxVelocity * FPS,
        acceleration: acceleration * FPS * FPS,
        ammoInventory,
        ...analyzeWeapons(weapons),
    };
}

// a whole team as one combatant. Called by: runSimulation

function mergeTeamStats(entries) {
    if (!entries.length) return null;
    const totalCount = entries.reduce((s, e) => s + e.count, 0);

    const addFields = [
        'maxShields','maxHull','minHull','hullToDisable',
        'shieldRegenPerFrame','delayedShieldPerFrame',
        'hullRepairPerFrame','delayedHullPerFrame',
        'shieldRegenPerSec','hullRepairPerSec',
        'energyCap','energyGenPerFrame','energyConsumeIdlePerFrame',
        'movingEnergyPerFrame','coolingEnergyPerFrame',
        'maxHeat','coolingPerFrame','coolingPerSec',
        'heatGenIdlePerFrame','movingHeatPerFrame',
        'fuelCap','fuelRegenPerFrame',
        'rawMass','inertialMass',
        'shieldDPS','hullDPS','heatDPS','ionDPS','disruptionDPS','slowingDPS',
        'firingEnergyPerSec','firingHeatPerSec','firingFuelPerSec',
        'firingHullCostPerSec','firingShieldCostPerSec',
    ];
    const protFields = ['shieldProt','hullProt','piercingRes'];

    const merged = {};
    for (const f of addFields)
        merged[f] = entries.reduce((s, e) => s + (e.resolved[f] || 0) * e.count, 0);
    for (const f of protFields)
        merged[f] = entries.reduce((s, e) => s + (e.resolved[f] || 0) * e.count, 0) / totalCount;

    const allProtKeys = new Set();
    for (const e of entries) for (const k of Object.keys(e.resolved.protections || {})) allProtKeys.add(k);
    merged.protections = {};
    for (const k of allProtKeys)
        merged.protections[k] = entries.reduce((s, e) => s + (e.resolved.protections?.[k] || 0) * e.count, 0) / totalCount;

    merged.statusResist = {};
    const allStatNames = new Set();
    for (const e of entries) for (const k of Object.keys(e.resolved.statusResist || {})) allStatNames.add(k);
    for (const k of allStatNames)
        merged.statusResist[k] = entries.reduce((s, e) => s + (e.resolved.statusResist?.[k] || 0) * e.count, 0) / totalCount;

    merged.weapons = [];
    for (const e of entries)
        for (let c = 0; c < e.count; c++)
            for (const w of e.resolved.weapons) merged.weapons.push(w);

    merged.weaponDetails = [];
    for (const e of entries)
        for (let c = 0; c < e.count; c++)
            for (const wd of (e.resolved.weaponDetails || [])) merged.weaponDetails.push(wd);

    merged.ammoInventory = {};
    for (const e of entries)
        for (const [k, v] of Object.entries(e.resolved.ammoInventory || {}))
            merged.ammoInventory[k] = (merged.ammoInventory[k] || 0) + v * e.count;

    merged.shieldDelay   = entries.reduce((m, e) => Math.max(m, e.resolved.shieldDelay   || 0), 0);
    merged.repairDelay   = entries.reduce((m, e) => Math.max(m, e.resolved.repairDelay   || 0), 0);
    merged.depletedDelay = entries.reduce((m, e) => Math.max(m, e.resolved.depletedDelay || 0), 0);

    merged.heatDissipFrac = entries.reduce((s, e) => s + (e.resolved.heatDissipFrac || 0) * e.count, 0) / totalCount;
    merged.coolEff        = entries.reduce((s, e) => s + (e.resolved.coolEff        || 0) * e.count, 0) / totalCount;

    merged.dps = {};
    for (const t of _damageTypes)
        merged.dps[t] = entries.reduce((s, e) => s + (e.resolved.dps?.[t] || 0) * e.count, 0);
    for (const t of _damageTypes)
        merged[t.toLowerCase() + 'DPS'] = merged.dps[t] || 0;

    merged.name       = '?';
    merged.pluginId   = null;
    merged.rawShip    = entries[0].resolved.rawShip;
    merged._teamShips = entries;

    merged.movementProfile = entries[0]?.resolved?.movementProfile ?? null;

    return merged;
}

// what a weapon's submunitions are (old and new formats). Called by: resolveSubmunitionDamage, resolveEffectiveRange

function resolveSubmunitionRefs(w) {
    const results = [];

    // new format: [{ type, count }]
    if (Array.isArray(w.submunitions)) {
        for (const entry of w.submunitions) {
            const subName  = entry?.type  ?? null;
            const subCount = entry?.count ?? 1;
            if (subName) results.push({ subName, subCount });
        }
        if (results.length > 0) return results;
    }

    // old format A
    const rawSub = w.submunition;
    if (rawSub != null) {
        const entries = Array.isArray(rawSub) ? rawSub : [rawSub];
        for (const entry of entries) {
            const subName  = typeof entry === 'string' ? entry
                           : typeof entry === 'object' ? (entry?.name ?? null) : null;
            const subCount = typeof entry === 'object' && entry !== null ? (entry.count ?? 1) : 1;
            if (subName) results.push({ subName, subCount });
        }
        if (results.length > 0) return results;
    }

    // old format A2
    for (const key of Object.keys(w)) {
        if (!key.startsWith('submunition ')) continue;
        const subName = key.slice('submunition '.length).trim();
        if (!subName) continue;
        const val = w[key];
        const subCount = Array.isArray(val) ? val.length : typeof val === 'number' ? Math.max(1, val) : 1;
        results.push({ subName, subCount });
    }
    if (results.length > 0) return results;

    // old format B
    for (const key of Object.keys(w)) {
        if (key === 'submunition' || key === 'submunitions') continue;
        if (key.startsWith('submunition ')) continue;
        const val = w[key];
        if (val === false || val === 0 || val === null || val === undefined) continue;
        if (typeof val !== 'number' && val !== true) continue;
        const outfit = _outfitIndex[key];
        if (!outfit?.weapon) continue;
        const isAmmo =
            (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0)
         || outfit.category === 'Ammunition'
         || (typeof outfit.attributes?.[key] === 'number' && outfit.attributes[key] > 0);
        if (isAmmo) continue;
        const subCount = val === true ? 1 : Math.max(1, Math.round(val));
        results.push({ subName: key, subCount });
    }
    return results;
}

// weapon range incl. submunitions
function resolveEffectiveRange(w, visited, depth, inheritedVelocity) {
    if (depth > 8) return null;
    const vel      = (w.velocity || 0) > 0 ? (w.velocity || 0) : (inheritedVelocity || 0);
    const life     = w.lifetime  || 0;
    const ownRange = vel * life;
    const subs = resolveSubmunitionRefs(w);
    if (!subs.length) return ownRange > 0 ? ownRange : null;
    let maxSubRange = 0, anySubHasRange = false;
    for (const { subName } of subs) {
        if (visited && visited.has(subName)) continue;
        const subOutfit = _outfitIndex[subName];
        if (!subOutfit?.weapon) continue;
        const nv = new Set(visited || []); nv.add(subName);
        const subRange = resolveEffectiveRange(subOutfit.weapon, nv, depth + 1, vel);
        if (subRange !== null) { anySubHasRange = true; if (subRange > maxSubRange) maxSubRange = subRange; }
    }
    const total = ownRange + maxSubRange;
    return (total > 0 || anySubHasRange) ? total : null;
}

// damage incl. submunitions
function resolveSubmunitionDamage(weapon, multiplier, visited, depth) {
    if (depth > 8) return {};
    const totals = {};
    for (const typeName of _damageTypes) {
        const val = weapon[dmgKey(typeName)] || 0;
        if (val) totals[typeName] = (totals[typeName] || 0) + val * multiplier;
    }
    for (const { subName, subCount } of resolveSubmunitionRefs(weapon)) {
        if (visited.has(subName)) continue;
        const nv = new Set(visited); nv.add(subName);
        const sub = _outfitIndex[subName];
        if (!sub?.weapon) continue;
        const subDmg = resolveSubmunitionDamage(sub.weapon, multiplier * subCount, nv, depth + 1);
        for (const [t, v] of Object.entries(subDmg)) totals[t] = (totals[t] || 0) + v;
    }
    return totals;
}

// every weapon's numbers. Called by: resolveShipStats
function analyzeWeapons(weapons) {
    const firingCostKeys = (_attrDefs?.outfitDisplay?.valueNames || [])
        .map(v => v.key).filter(k => k.startsWith('firing '));
    const totalDPS    = {};
    const totalFiring = {};
    for (const t of _damageTypes) totalDPS[t]    = 0;
    for (const k of firingCostKeys) totalFiring[k] = 0;
    const details = [];

    for (const w of weapons) {
        const munitionInfo   = window.MunitionTypes?.analyseWeapon?.(w, w._name) ?? null;
        const reload         = Math.max(1, w.reload || 1);
        const burstCount     = w['burst count']  || 1;
        const burstReload    = w['burst reload'] || reload;
        const framesPerCycle = (burstCount - 1) * burstReload + reload;
        const sps            = (burstCount / framesPerCycle) * FPS;
        const piercing       = Math.max(0, Math.min(1, w.piercing || 0));
        const visited        = new Set([w._name].filter(Boolean));
        const dmgPerShot     = resolveSubmunitionDamage(w, 1, visited, 0);
        for (const t of _damageTypes) if (dmgPerShot[t] === undefined) dmgPerShot[t] = 0;
        for (const t of _damageTypes) totalDPS[t] = (totalDPS[t] || 0) + dmgPerShot[t] * sps;
        for (const k of firingCostKeys) totalFiring[k] = (totalFiring[k] || 0) + (w[k] || 0) * sps;

        const detail = {
            name: w._name || 'Unknown', munition: munitionInfo,
            reload, burstCount, burstReload, framesPerCycle,
            sps: +sps.toFixed(3), piercing: +(piercing * 100).toFixed(0),
            range: resolveEffectiveRange(w, new Set([w._name].filter(Boolean)), 0, 0),
            homing: (w.homing || 0) > 0, antiMissile: (w['anti-missile'] || 0) > 0,
            hasSubmunitions: resolveSubmunitionRefs(w).length > 0, dmgPerShot,
            relShield: +((w['% shield damage'] || 0) * 100).toFixed(1),
            relHull:   +((w['% hull damage']   || 0) * 100).toFixed(1),
        };
        for (const t of _damageTypes) detail[t.toLowerCase() + 'DPS'] = +(dmgPerShot[t] * sps).toFixed(2);
        details.push(detail);
    }

    const result = { dps: totalDPS, weaponDetails: details };
    for (const t of _damageTypes) result[t.toLowerCase() + 'DPS'] = totalDPS[t] || 0;
    result.shieldDPS     = totalDPS['Shield']     || 0;
    result.hullDPS       = totalDPS['Hull']       || 0;
    result.heatDPS       = totalDPS['Heat']       || 0;
    result.ionDPS        = totalDPS['Ion']        || 0;
    result.disruptionDPS = totalDPS['Disruption'] || 0;
    result.slowingDPS    = totalDPS['Slowing']    || 0;
    result.firingEnergyPerSec     = +(totalFiring['firing energy']  || 0).toFixed(3);
    result.firingHeatPerSec       = +(totalFiring['firing heat']    || 0).toFixed(3);
    result.firingFuelPerSec       = +(totalFiring['firing fuel']    || 0).toFixed(3);
    result.firingHullCostPerSec   = +(totalFiring['firing hull']    || 0).toFixed(3);
    result.firingShieldCostPerSec = +(totalFiring['firing shields'] || 0).toFixed(3);
    return result;
}

// ammo that's really a capacity (negative)

function _isNegativeCapacityAmmo(outfit, outfitName) {
    const attrs = extractOutfitAttributes(outfit);
    for (const [key, val] of Object.entries(attrs))
        if (key.endsWith(' capacity') && typeof val === 'number' && val < 0) return true;
    return false;
}

// which ammo a weapon uses
function resolveAmmoRef(w) {
    // new format: [{ type, count }]
    if (Array.isArray(w.ammunition) && w.ammunition.length > 0) {
        const first = w.ammunition[0];
        if (first?.type) return { ammoName: first.type, ammoCount: first.count ?? 1 };
    }

    // old format: weapon.ammo = name
    const rawAmmoField = w['ammo'];
    if (typeof rawAmmoField === 'string' && rawAmmoField.length > 0)
        return { ammoName: rawAmmoField, ammoCount: 1 };

    // old format: outfit name as key
    for (const key of Object.keys(w)) {
        if (key === 'ammo' || key === 'ammunition') continue;
        const val = w[key];
        if (val === false || val === 0 || val === null || val === undefined) continue;
        if (typeof val !== 'number' && val !== true) continue;
        const outfit = _outfitIndex[key];
        if (outfit) {
            const isAmmo =
                outfit.category === 'Ammunition' ||
                (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0) ||
                (typeof outfit.attributes?.[key] === 'number' && outfit.attributes[key] > 0) ||
                _isNegativeCapacityAmmo(outfit, key);
            if (!isAmmo) continue;
            return { ammoName: key, ammoCount: val === true ? 1 : Math.max(1, Math.round(val)) };
        }
        if (typeof val === 'number' && val >= 1 && !_weaponDataKeys.has(key))
            return { ammoName: key, ammoCount: Math.max(1, Math.round(val)) };
    }
    return null;
}

// can it fire right now?
function canWeaponFire(w, st, stats) {
    const fe = w['firing energy'] || 0;
    if (fe > 0 && (st.isIonized || st.energy < fe)) return 'firing energy';
    const ff = w['firing fuel'] || 0;
    if (ff > 0 && st.fuel < ff) return 'firing fuel';
    const fh = w['firing hull'] || 0;
    if (fh > 0 && st.hull - fh < stats.minHull) return 'firing hull';
    const fs = w['firing shields'] || 0;
    if (fs > 0 && st.shields < fs) return 'firing shields';
    const ammoRef = resolveAmmoRef(w);
    if (ammoRef?.ammoName) {
        const have = st.ammoInventory[ammoRef.ammoName] ?? 0;
        if (have < ammoRef.ammoCount) return 'ammo:' + ammoRef.ammoName;
    }
    return null;
}

// pay a shot's costs
function consumeFiringCosts(w, st) {
    st.energy  -= (w['firing energy']  || 0);
    st.fuel    -= (w['firing fuel']    || 0);
    st.hull    -= (w['firing hull']    || 0);
    st.shields -= (w['firing shields'] || 0);
    st.heat    += (w['firing heat']    || 0);
    const ammoRef = resolveAmmoRef(w);
    if (ammoRef?.ammoName && st.ammoInventory[ammoRef.ammoName] != null)
        st.ammoInventory[ammoRef.ammoName] =
            Math.max(0, st.ammoInventory[ammoRef.ammoName] - ammoRef.ammoCount);
}

// weapon running out of something (energy, ammo …) — for the fight log

function _isAmmoReason(r) { return typeof r === 'string' && r.startsWith('ammo:'); }

const STALL_CONFIRM_FRAMES  = 2 * 60;
const RESUME_CONFIRM_FRAMES = 1 * 60;

// start-of-fight sustain state
function createSustainState() {
    const resourceState = {};
    for (const key of firingResourceKeys())
        resourceState[key] = { reported:false, stallFrames:0, resumeFrames:0, reportedNames:[] };
    return { resourceState, ammoExhausted: new Set() };
}

// log when weapons run dry
function checkWeaponSustainEvents(st, stats, side, t, sus, phases) {
    const weapons = stats.weapons;
    if (!weapons.length) return;
    for (let i = 0; i < weapons.length; i++) {
        const w      = weapons[i];
        const reason = canWeaponFire(w, st, stats);
        if (!_isAmmoReason(reason)) continue;
        const name     = w._name || ('Weapon '+(i+1));
        const ammoName = reason.slice(5);
        const key      = name + '::' + ammoName;
        if (!sus.ammoExhausted.has(key)) {
            sus.ammoExhausted.add(key);
            phases.push({
                time: t, type: side, icon: '📦',
                text: `<strong>${escHtml(stats.name)}</strong>'s ` +
                      `<em>${escHtml(name)}</em> ran out of <em>${escHtml(ammoName)}</em> at ${fmtT(t)} — offline`,
            });
        }
    }
    for (const key of firingResourceKeys()) {
        const rs = sus.resourceState[key];
        const blocked = [];
        for (let i = 0; i < weapons.length; i++) {
            const w = weapons[i];
            if ((w[key] || 0) === 0) continue;
            if (canWeaponFire(w, st, stats) === key) blocked.push(w._name || ('Weapon '+(i+1)));
        }
        if (blocked.length > 0) {
            rs.stallFrames++; rs.resumeFrames = 0;
            if (!rs.reported && rs.stallFrames === STALL_CONFIRM_FRAMES) {
                rs.reported = true; rs.reportedNames = [...new Set(blocked)];
                const label   = resourceLabel(key);
                const nameStr = rs.reportedNames.map(n => `<em>${escHtml(n)}</em>`).join(', ');
                const verb    = rs.reportedNames.length === 1 ? 'is' : 'are';
                phases.push({ time:t, type:side, icon:'⚠️',
                    text:`<strong>${escHtml(stats.name)}</strong>'s ${nameStr} ${verb} unable to sustain — ${escHtml(label)} low at ${fmtT(t)}` });
            }
        } else {
            rs.resumeFrames++; rs.stallFrames = 0;
            if (rs.reported && rs.resumeFrames === RESUME_CONFIRM_FRAMES) {
                rs.reported = false;
                const label   = resourceLabel(key);
                const nameStr = rs.reportedNames.map(n => `<em>${escHtml(n)}</em>`).join(', ');
                const verb    = rs.reportedNames.length === 1 ? 'has' : 'have';
                phases.push({ time:t, type:side, icon:'🔄',
                    text:`<strong>${escHtml(stats.name)}</strong>'s ${nameStr} ${verb} resumed — ${escHtml(label)} restored at ${fmtT(t)}` });
                rs.reportedNames = [];
            }
        }
    }
}

// a side's state at the start of a fight. Called by: simulateBattle

function createCombatantState(stats) {
    const statusEffects = {};
    for (const statName of Object.keys(_statusDecayMap)) statusEffects[statName] = 0;
    return {
        stats,
        shields: stats.maxShields, hull: stats.maxHull,
        energy: stats.energyCap, heat: 0,
        fuel: stats.fuelCap > 0 ? stats.fuelCap : 0,
        ammoInventory: { ...(stats.ammoInventory || {}) },
        statusEffects,
        shieldDelayCounter: 0, repairDelayCounter: 0, depletedFlag: false,
        weaponReloadCounters: stats.weapons.map(() => 0),
        weaponBurstCounters:  stats.weapons.map(() => 0),
        disabled: false, disabledAt: Infinity,
        destroyed: false, destroyedAt: Infinity,
        isOverheated: false, isIonized: false,
        totalShieldDamageReceived: 0, totalHullDamageReceived: 0,
    };
}

// the fight itself, frame by frame. Called by: runSimulation
async function simulateBattle(sA, sB, onProgress, opts = {}) {
    const result = { winner:null, ttkA:Infinity, ttkB:Infinity,
        projectedTtkA:null, projectedTtkB:null, phases:[], warnings:[],
        interceptsA: 0, interceptsB: 0,
    };
    const stA = createCombatantState(sA);
    const stB = createCombatantState(sB);
    const susA = createSustainState(sA), susB = createSustainState(sB);
    const milestones = {
        A: { shieldsBroken:false, halfHull:false, disabled:false, energyBlackout:false, overheated:false, heavilySlowed:false },
        B: { shieldsBroken:false, halfHull:false, disabled:false, energyBlackout:false, overheated:false, heavilySlowed:false },
    };
    const timelineA = [], timelineB = [];
    let frame = 0;

    // skilled-pilot model (battleSimEngagement.js)
    const meta = s => s.weapons.map(w => ({ range: resolveEffectiveRange(w, new Set([w._name].filter(Boolean)), 0, 0), turret: !!w._turret }));
    const eng = opts.skilled && window.BattleEngagement ? window.BattleEngagement.create(sA, sB, meta(sA), meta(sB)) : null;
    const hitA = eng ? (i, def) => eng.factor('A', i, def) : null;
    const hitB = eng ? (i, def) => eng.factor('B', i, def) : null;

    const YIELD_EVERY = 600;
    let endAt = null, lowA = Infinity, lowB = Infinity, lastProgress = 0;

    while (frame < MAX_FRAMES) {
        const t = frame / FPS;

        if (frame % YIELD_EVERY === 0) {
            if (_simCancelled) throw new Error('CANCELLED');
            const pct = (frame / MAX_FRAMES) * 100;
            const elapsed = (frame / FPS).toFixed(0);
            if (onProgress) onProgress(pct, `${elapsed}s simulated`);
            await new Promise(r => setTimeout(r, 0));
        }

        if (frame % 6 === 0) {
            timelineA.push({ t, shields:stA.shields, hull:stA.hull, energy:stA.energy, heat:stA.heat });
            timelineB.push({ t, shields:stB.shields, hull:stB.hull, energy:stB.energy, heat:stB.heat });
        }
        if (!stA.disabled && !stA.destroyed) checkWeaponSustainEvents(stA, sA, 'A', t, susA, result.phases);
        if (!stB.disabled && !stB.destroyed) checkWeaponSustainEvents(stB, sB, 'B', t, susB, result.phases);

        const missilesVsB = [];
        const missilesVsA = [];

        const preShieldsA = stA.shields, preHullA = stA.hull;
        const preShieldsB = stB.shields, preHullB = stB.hull;

        if (eng) eng.step(stA, stB);
        if (!stA.disabled && !stA.destroyed) shootFrame(stA, stB, sA, missilesVsB, hitA);
        if (!stB.disabled && !stB.destroyed) shootFrame(stB, stA, sB, missilesVsA, hitB);

        if (!stB.disabled && !stB.destroyed) resolveAntiMissile(stB, sB, missilesVsB, result, 'B');
        if (!stA.disabled && !stA.destroyed) resolveAntiMissile(stA, sA, missilesVsA, result, 'A');

        applyQueuedMissiles(missilesVsB, stB);
        applyQueuedMissiles(missilesVsA, stA);

        stA.totalShieldDamageReceived += Math.max(0, preShieldsA - stA.shields);
        stA.totalHullDamageReceived   += Math.max(0, preHullA   - stA.hull);
        stB.totalShieldDamageReceived += Math.max(0, preShieldsB - stB.shields);
        stB.totalHullDamageReceived   += Math.max(0, preHullB   - stB.hull);

        doGeneration(stA, sA); doGeneration(stB, sB);
        doRegen(stA, sA);      doRegen(stB, sB);
        decayStatusEffects(stA, sA); decayStatusEffects(stB, sB);
        stA.isOverheated = stA.heat >= sA.maxHeat;
        stB.isOverheated = stB.heat >= sB.maxHeat;
        stA.isIonized    = sA.movingEnergyPerFrame > 0 && (stA.statusEffects.ionization || 0) > stA.energy;
        stB.isIonized    = sB.movingEnergyPerFrame > 0 && (stB.statusEffects.ionization || 0) > stB.energy;
        stA.shields = Math.max(0, Math.min(sA.maxShields, stA.shields));
        stB.shields = Math.max(0, Math.min(sB.maxShields, stB.shields));
        stA.energy  = Math.max(0, Math.min(sA.energyCap,  stA.energy));
        stB.energy  = Math.max(0, Math.min(sB.energyCap,  stB.energy));
        stA.heat = Math.max(0, stA.heat);
        stB.heat = Math.max(0, stB.heat);
        if (sA.fuelCap > 0) stA.fuel = Math.max(0, Math.min(sA.fuelCap, stA.fuel));
        if (sB.fuelCap > 0) stB.fuel = Math.max(0, Math.min(sB.fuelCap, stB.fuel));

        checkMilestones(stA, sA, 'A', t, milestones.A, result.phases);
        checkMilestones(stB, sB, 'B', t, milestones.B, result.phases);

        if (!stA.disabled && stA.hull < sA.minHull) {
            stA.disabled = true; stA.disabledAt = t; result.ttkA = t;
            if (!milestones.A.disabled) { milestones.A.disabled = true;
                result.phases.push({ time:t, type:'A', icon:'💥',
                    text:`<strong>${escHtml(sA.name)}</strong> disabled at ${fmtT(t)}` }); }
        }
        if (!stB.disabled && stB.hull < sB.minHull) {
            stB.disabled = true; stB.disabledAt = t; result.ttkB = t;
            if (!milestones.B.disabled) { milestones.B.disabled = true;
                result.phases.push({ time:t, type:'B', icon:'💥',
                    text:`<strong>${escHtml(sB.name)}</strong> disabled at ${fmtT(t)}` }); }
        }
        if (!stA.destroyed && stA.hull < 0) { stA.destroyed = true; stA.destroyedAt = t; }
        if (!stB.destroyed && stB.hull < 0) { stB.destroyed = true; stB.destroyedAt = t; }
        if ((stA.disabled || stA.destroyed) && (stB.disabled || stB.destroyed)) break;
        // one side out → stop 5 s later (missiles in flight); stalemate → stop
        const outA = stA.disabled || stA.destroyed, outB = stB.disabled || stB.destroyed;
        if ((outA || outB) && endAt == null) endAt = frame + 5 * FPS;
        if (endAt != null && frame >= endAt) break;
        // Stalemate: if for two minutes neither side has dropped below its lowest
        // shields + hull so far, nobody can win — stop and call it.
        if (frame % FPS === 0) {
            const hpA = stA.shields + stA.hull, hpB = stB.shields + stB.hull;
            if (hpA < lowA - 1e-6 || hpB < lowB - 1e-6) { lowA = Math.min(lowA, hpA); lowB = Math.min(lowB, hpB); lastProgress = frame; }
            if (frame - lastProgress > 120 * FPS) break;
        }
        frame++;
    }

    if (onProgress) onProgress(100, 'Resolving outcome…');

    const finalT = frame / FPS;
    if (!timelineA.length || timelineA[timelineA.length-1].t < finalT) {
        timelineA.push({ t:finalT, shields:stA.shields, hull:stA.hull, energy:stA.energy, heat:stA.heat });
        timelineB.push({ t:finalT, shields:stB.shields, hull:stB.hull, energy:stB.energy, heat:stB.heat });
    }
    result.timelineA = timelineA; result.timelineB = timelineB;
    if (eng) result.engagement = eng.summary(sA.name, sB.name);
    result.finalStateA = stA;     result.finalStateB = stB;

    const aKilled=isFinite(result.ttkA), bKilled=isFinite(result.ttkB);
    if (!aKilled && !bKilled) {
        result.winner = 'draw';
        result.phases.push({ time:finalT, type:'neutral', icon:'🤝', text:'Neither side could disable the other — draw.' });
    } else if (aKilled && bKilled) {
        result.winner = Math.abs(result.ttkA - result.ttkB) < (1 / FPS) ? 'draw'
            : result.ttkB < result.ttkA ? 'A' : 'B';
    } else {
        result.winner = bKilled ? 'A' : 'B';
    }

    if (aKilled && !bKilled && result.ttkA > 0) {
        const avgS = stB.totalShieldDamageReceived / result.ttkA;
        const avgH = stB.totalHullDamageReceived   / result.ttkA;
        result.projectedTtkB = projectSurvival(sB, stB, avgS, avgH);
    }
    if (bKilled && !aKilled && result.ttkB > 0) {
        const avgS = stA.totalShieldDamageReceived / result.ttkB;
        const avgH = stA.totalHullDamageReceived   / result.ttkB;
        result.projectedTtkA = projectSurvival(sA, stA, avgS, avgH);
    }

    result.phases.sort((a, b) => a.time - b.time);

    const defenderHasAM  = s => s.weapons.some(w => (w['anti-missile'] || 0) > 0);
    const attackerHasMsl = s => s.weapons.some(w =>
        (w.homing || 0) > 0 ||
        (typeof window.AntiMissileAnalysis?.resolveEffectiveMissileStrength === 'function'
            ? window.AntiMissileAnalysis.resolveEffectiveMissileStrength(w)
            : (w['missile strength'] || 0)) > 0
    );

    if (defenderHasAM(sA) && attackerHasMsl(sB) && result.interceptsA > 0) {
        result.phases.push({ time: Infinity, type: 'A', icon: '🛡',
            text: `<strong>${escHtml(sA.name)}</strong> intercepted <strong>${result.interceptsA}</strong> missile${result.interceptsA !== 1 ? 's' : ''} during the battle` });
    }
    if (defenderHasAM(sB) && attackerHasMsl(sA) && result.interceptsB > 0) {
        result.phases.push({ time: Infinity, type: 'B', icon: '🛡',
            text: `<strong>${escHtml(sB.name)}</strong> intercepted <strong>${result.interceptsB}</strong> missile${result.interceptsB !== 1 ? 's' : ''} during the battle` });
    }

    result.phases.sort((a, b) => a.time - b.time);
    return result;
}

// one frame of firing
function shootFrame(attSt, defSt, attStats, missileQueue, hitFn) {
    if (attSt.isOverheated) return;
    for (let i = 0; i < attStats.weapons.length; i++) {
        const w = attStats.weapons[i];
        if ((w['anti-missile'] || 0) > 0) {
            if (attSt.weaponReloadCounters[i] > 0) attSt.weaponReloadCounters[i]--;
            continue;
        }
        if (attSt.weaponReloadCounters[i] > 0) { attSt.weaponReloadCounters[i]--; continue; }
        // Skilled pilots: share of this shot expected to land (0 = target out of reach → hold fire)
        const landed = hitFn ? hitFn(i, defSt) : 1;
        if (landed <= 0) continue;
        const reload      = Math.max(1, w.reload || 1);
        const burstCount  = w['burst count']  || 1;
        const burstReload = w['burst reload'] || reload;
        if (canWeaponFire(w, attSt, attStats) !== null) { advanceBurst(attSt, i, burstCount, burstReload, reload); continue; }
        const scrambling = attSt.statusEffects.scrambling || 0;
        if (scrambling > 0.1 && Math.random() < (1 - Math.pow(2, -scrambling / 70))) { advanceBurst(attSt, i, burstCount, burstReload, reload); continue; }
        consumeFiringCosts(w, attSt);
        for (const [statName, firingKey] of Object.entries(firingStatusMap())) {
            const val = w[firingKey] || 0;
            if (val > 0) attSt.statusEffects[statName] = (attSt.statusEffects[statName] || 0) + val;
        }
        const resolvedMS = typeof window.AntiMissileAnalysis?.resolveEffectiveMissileStrength === 'function'
            ? window.AntiMissileAnalysis.resolveEffectiveMissileStrength(w)
            : (w['missile strength'] || 0);
        const isMissile = (w.homing || 0) > 0 || resolvedMS > 0;
        if (isMissile && missileQueue) {
            missileQueue.push({ weapon: w, multiplier: landed, visited: new Set([w._name].filter(Boolean)), depth: 0, intercepted: false });
        } else {
            applyWeaponDamage(w, defSt, defSt.stats, landed, new Set([w._name].filter(Boolean)), 0);
        }
        advanceBurst(attSt, i, burstCount, burstReload, reload);
    }
}

// anti-missile shooting down missiles
function resolveAntiMissile(defenderSt, defenderStats, missileQueue, result, side) {
    if (!missileQueue || missileQueue.length === 0) return;
    const weapons = defenderStats.weapons;
    for (const entry of missileQueue) {
        if (entry.intercepted) continue;
        const ms = typeof window.AntiMissileAnalysis?.resolveEffectiveMissileStrength === 'function'
            ? Math.max(0, window.AntiMissileAnalysis.resolveEffectiveMissileStrength(entry.weapon))
            : Math.max(0, entry.weapon[MISSILE_STRENGTH_KEY] || 0);
        for (let i = 0; i < weapons.length; i++) {
            const w = weapons[i];
            const amStr = w['anti-missile'] || 0;
            if (amStr <= 0) continue;
            if (defenderSt.weaponReloadCounters[i] > 0) continue;
            if (canWeaponFire(w, defenderSt, defenderStats) !== null) continue;
            const p = amStr / (amStr + ms);
            if (Math.random() < p) {
                entry.intercepted = true;
                if (result && side) result['intercepts' + side]++;
                consumeFiringCosts(w, defenderSt);
                advanceBurst(defenderSt, i, w['burst count'] || 1, w['burst reload'] || Math.max(1, w.reload || 1), Math.max(1, w.reload || 1));
                break;
            } else {
                consumeFiringCosts(w, defenderSt);
                advanceBurst(defenderSt, i, w['burst count'] || 1, w['burst reload'] || Math.max(1, w.reload || 1), Math.max(1, w.reload || 1));
            }
        }
    }
}

// missiles that arrive this frame
function applyQueuedMissiles(missileQueue, defSt) {
    for (const entry of missileQueue) {
        if (entry.intercepted) continue;
        applyWeaponDamage(entry.weapon, defSt, defSt.stats, entry.multiplier, entry.visited, entry.depth);
    }
}

// burst fire timing
function advanceBurst(attSt, i, burstCount, burstReload, reload) {
    if (burstCount > 1) {
        attSt.weaponBurstCounters[i]++;
        if (attSt.weaponBurstCounters[i] >= burstCount) {
            attSt.weaponBurstCounters[i]  = 0;
            attSt.weaponReloadCounters[i] = reload - 1;
        } else {
            attSt.weaponReloadCounters[i] = burstReload - 1;
        }
    } else {
        attSt.weaponReloadCounters[i] = reload - 1;
    }
}

// apply a hit
function applyWeaponDamage(w, defSt, defStats, multiplier, visited, depth) {
    multiplier = multiplier || 1; depth = depth || 0;
    if (depth > 8) return;
    _applyDirectDamage(w, defSt, defStats, multiplier);
    for (const { subName, subCount } of resolveSubmunitionRefs(w)) {
        if (!subName || (visited && visited.has(subName))) continue;
        const subOutfit = _outfitIndex[subName];
        if (!subOutfit?.weapon) continue;
        const nv = new Set(visited || []); nv.add(subName);
        applyWeaponDamage(subOutfit.weapon, defSt, defStats, multiplier * subCount, nv, depth + 1);
    }
}

// shield/hull damage
function _applyDirectDamage(w, defSt, defStats, multiplier) {
    const disruptMult       = 1 + (defSt.statusEffects.disruption || 0) * 0.01;
    const effectivePiercing = Math.max(0, Math.min(1, w.piercing || 0)) * (1 - defStats.piercingRes);
    const relShieldDmg = (w['% shield damage'] || 0) * Math.min(Math.max(0, defSt.shields), defStats.maxShields) * multiplier;
    const relHullDmg   = (w['% hull damage']   || 0) * Math.min(Math.max(0, defSt.hull),    defStats.maxHull)    * multiplier;
    const rawShieldDmg = (w['shield damage'] || 0) * multiplier + relShieldDmg;
    const rawHullDmg   = (w['hull damage']   || 0) * multiplier + relHullDmg;
    const hasAnyDmg = rawShieldDmg > 0 || rawHullDmg > 0
        || _damageTypes.some(t => (w[dmgKey(t)] || 0) + (w[relDmgKey(t)] || 0) > 0);
    if (!hasAnyDmg) return;

    const shieldDmgTotal   = rawShieldDmg * (1 - defStats.shieldProt) * disruptMult;
    const hullDmgAfterProt = rawHullDmg   * (1 - defStats.hullProt);
    const hullPiercedDmg   = shieldDmgTotal * effectivePiercing;
    const shieldDmgApplied = shieldDmgTotal * (1 - effectivePiercing);

    if (defSt.shields > 0) {
        defSt.shields -= shieldDmgApplied;
        defSt.hull    -= hullPiercedDmg;
        if (defSt.shields < 0) {
            const overflow = -defSt.shields; defSt.shields = 0;
            defSt.hull -= overflow * (1 - defStats.hullProt);
            defSt.hull -= hullDmgAfterProt;
        }
    } else {
        defSt.hull -= hullDmgAfterProt + rawShieldDmg * (1 - defStats.shieldProt);
    }

    defSt.shieldDelayCounter = Math.max(defSt.shieldDelayCounter, defStats.shieldDelay  || 0);
    defSt.repairDelayCounter = Math.max(defSt.repairDelayCounter, defStats.repairDelay  || 0);
    if (defSt.depletedFlag)
        defSt.shieldDelayCounter = Math.max(defSt.shieldDelayCounter, defStats.depletedDelay || 0);

    const shieldsUp = defSt.shields > 0;
    for (const typeName of _damageTypes) {
        if (typeName === 'Shield' || typeName === 'Hull') continue;
        const raw = (w[dmgKey(typeName)] || 0) * multiplier;
        const rel = (w[relDmgKey(typeName)] || 0) * multiplier;
        const totalDmg = raw + rel;
        if (!totalDmg) continue;
        const prot       = defStats.protections[protKey(typeName)] || 0;
        const shieldMult = window.DamageTypes?.getShieldMultiplier(typeName, shieldsUp) ?? 1.0;
        const effectiveDmg = totalDmg * (1 - prot) * shieldMult;
        if (effectiveDmg > 0) applyStatusOrInstantDamage(defSt, typeName, effectiveDmg);
    }
}

// status damage (ion, heat …)
function applyStatusOrInstantDamage(defSt, typeName, dmg) {
    switch (typeName) {
        case 'Energy':     defSt.energy -= dmg; break;
        case 'Heat':       defSt.heat   += dmg; break;
        case 'Fuel':       defSt.fuel   -= dmg; break;
        case 'Discharge':  defSt.statusEffects.discharge  = Math.max(0, (defSt.statusEffects.discharge  || 0) + dmg); break;
        case 'Corrosion':  defSt.statusEffects.corrosion  = Math.max(0, (defSt.statusEffects.corrosion  || 0) + dmg); break;
        case 'Burn':       defSt.statusEffects.burn       = Math.max(0, (defSt.statusEffects.burn       || 0) + dmg); break;
        case 'Leak':       defSt.statusEffects.leak       = Math.max(0, (defSt.statusEffects.leak       || 0) + dmg); break;
        case 'Ion':        defSt.statusEffects.ionization = Math.max(0, (defSt.statusEffects.ionization || 0) + dmg); break;
        case 'Scrambling': defSt.statusEffects.scrambling = Math.max(0, (defSt.statusEffects.scrambling || 0) + dmg); break;
        case 'Disruption': defSt.statusEffects.disruption = Math.max(0, (defSt.statusEffects.disruption || 0) + dmg); break;
        case 'Slowing':    defSt.statusEffects.slowing    = Math.max(0, (defSt.statusEffects.slowing    || 0) + dmg); break;
        default: break;
    }
}

// energy/heat generation per frame
function doGeneration(st, stats) {
    st.energy += stats.energyGenPerFrame - stats.energyConsumeIdlePerFrame
               - stats.movingEnergyPerFrame - stats.coolingEnergyPerFrame;
    st.heat   += stats.heatGenIdlePerFrame + stats.movingHeatPerFrame - stats.coolingPerFrame;
    st.heat   -= st.heat * stats.heatDissipFrac;
    if (stats.fuelRegenPerFrame > 0) st.fuel += stats.fuelRegenPerFrame;
    if ((st.statusEffects.discharge || 0) > 0) st.shields -= st.statusEffects.discharge;
    if ((st.statusEffects.corrosion || 0) > 0) st.hull    -= st.statusEffects.corrosion;
    if ((st.statusEffects.burn      || 0) > 0) st.heat    += st.statusEffects.burn;
    if ((st.statusEffects.leak      || 0) > 0) st.fuel    -= st.statusEffects.leak;
}

// shield/hull regen per frame
function doRegen(st, stats) {
    if (st.shieldDelayCounter > 0) st.shieldDelayCounter--;
    else if (st.shields < stats.maxShields)
        st.shields += stats.shieldRegenPerFrame + stats.delayedShieldPerFrame;
    if (st.repairDelayCounter > 0) st.repairDelayCounter--;
    else if (st.hull < stats.maxHull && !st.disabled)
        st.hull += stats.hullRepairPerFrame + stats.delayedHullPerFrame;
}

// status effects wear off
function decayStatusEffects(st, stats) {
    for (const statName of Object.keys(_statusDecayMap)) {
        const cur = st.statusEffects[statName] || 0;
        if (cur <= 0) continue;
        const passive        = 0.99 * cur;
        const resistPerFrame = stats.statusResist[statName] || 0;
        st.statusEffects[statName] = Math.max(0, passive - Math.min(resistPerFrame, passive));
    }
}

// milestones for the fight log
function checkMilestones(st, stats, side, t, m, phases) {
    if (!m.shieldsBroken && stats.maxShields > 0 && st.shields <= 0) {
        m.shieldsBroken = true;
        phases.push({ time:t, type:side, icon:'🛡', text:`<strong>${escHtml(stats.name)}</strong>'s shields broken at ${fmtT(t)}` });
    }
    if (!m.halfHull && st.hull < stats.maxHull * 0.5 && st.hull > 0) {
        m.halfHull = true;
        phases.push({ time:t, type:side, icon:'⚠️', text:`<strong>${escHtml(stats.name)}</strong> hull below 50% at ${fmtT(t)}` });
    }
    if (!m.energyBlackout && stats.energyCap > 0 && st.energy <= 0) {
        m.energyBlackout = true;
        phases.push({ time:t, type:side, icon:'⚡', text:`<strong>${escHtml(stats.name)}</strong> energy depleted at ${fmtT(t)}` });
    }
    if (!m.overheated && stats.maxHeat > 0 && st.heat >= stats.maxHeat) {
        m.overheated = true;
        phases.push({ time:t, type:side, icon:'🔥', text:`<strong>${escHtml(stats.name)}</strong> overheated at ${fmtT(t)}` });
    }
    if (!m.heavilySlowed && (st.statusEffects.slowing || 0) >= 20) {
        m.heavilySlowed = true;
        const pct = Math.round((1 - 1/(1+(st.statusEffects.slowing||0)*0.05))*100);
        phases.push({ time:t, type:side, icon:'🐌',
            text:`<strong>${escHtml(stats.name)}</strong> heavily slowed (~${pct}%) at ${fmtT(t)}` });
    }
}

// time to disable if the fight went on
function projectSurvival(stats, finalState, avgShieldDps, avgHullDps) {
    if (avgShieldDps <= 0 && avgHullDps <= 0) return Infinity;
    let shields = Math.max(0, finalState.shields);
    let hull    = Math.max(stats.minHull, finalState.hull);
    const shieldRegenPerSec = (stats.shieldRegenPerFrame + stats.delayedShieldPerFrame) * FPS;
    const hullRegenPerSec   = (stats.hullRepairPerFrame  + stats.delayedHullPerFrame)  * FPS;
    const STEP = 0.5;
    for (let elapsed = 0; elapsed < 3600; elapsed += STEP) {
        shields -= avgShieldDps * STEP;
        if (shields < 0) { hull += shields * SHIELD_BLEED_FRACTION; shields = 0; }
        hull    -= avgHullDps * STEP;
        shields  = Math.min(stats.maxShields, shields + shieldRegenPerSec * STEP);
        hull     = Math.min(stats.maxHull,    hull    + hullRegenPerSec   * STEP);
        if (hull < stats.minHull) return elapsed;
    }
    return Infinity;
}

// ── teams ──

function createTeam(name) {
    const idx   = _teams.length;
    const id    = 'team_' + (_nextTeamId++);
    const color = TEAM_PALETTE[idx % TEAM_PALETTE.length];
    const team  = { id, name, color, ships: [] };
    _teams.push(team);
    return team;
}

// remove a team
function removeTeam(teamId) {
    _teams = _teams.filter(t => t.id !== teamId);
    renderAllTeams();
    updateSimButton();
    hideResults();
}

// add a ship to a team
function addShipToTeam(teamId, shipData, count) {
    const team = _teams.find(t => t.id === teamId);
    if (!team) return;
    const resolved = resolveShipStats(shipData);
    if (typeof window.MovementStats?.compute === 'function')
        resolved.movementProfile = window.MovementStats.compute(resolved.combined);
    const allSkilled = document.getElementById('skilledPilots')?.checked !== false;
    const n = Math.max(1, count);
    team.ships.push({ shipData, count: n, skilled: allSkilled ? n : 0, resolved });
    renderTeamCard(team);
    updateSimButton();
    hideResults();
}

// remove a ship
function removeShipFromTeam(teamId, shipIdx) {
    const team = _teams.find(t => t.id === teamId);
    if (!team) return;
    team.ships.splice(shipIdx, 1);
    renderTeamCard(team);
    updateSimButton();
    hideResults();
}

// change a ship's count
function updateShipCount(teamId, shipIdx, newCount) {
    const team = _teams.find(t => t.id === teamId);
    if (!team || !team.ships[shipIdx]) return;
    const e = team.ships[shipIdx];
    const wasAll = e.skilled >= e.count;
    e.count = Math.max(1, parseInt(newCount) || 1);
    // keep "all skilled" ships all skilled; otherwise never more skilled than there are ships
    e.skilled = wasAll ? e.count : Math.min(e.skilled || 0, e.count);
    const sk = document.getElementById(`skilled_${teamId}_${shipIdx}`);
    if (sk) { sk.max = e.count; sk.value = e.skilled; }
    syncSkillMaster();
    updateSimButton();
    hideResults();
}

// ── Pilot skill: per ship (how many of a stack are skilled), per team, or everyone ──
function setShipSkilled(teamId, shipIdx, value) {
    const team = _teams.find(t => t.id === teamId);
    const e = team && team.ships[shipIdx];
    if (!e) return;
    e.skilled = typeof value === 'boolean' ? (value ? e.count : 0) : Math.max(0, Math.min(e.count, parseInt(value) || 0));
    // redraw after this event finishes (redrawing removes the box being edited)
    setTimeout(() => { renderTeamCard(team); syncSkillMaster(); }, 0);
    hideResults();
}
// Make all / none skilled
function setTeamSkilled(teamId, on) {
    const team = _teams.find(t => t.id === teamId);
    if (!team) return;
    for (const e of team.ships) e.skilled = on ? e.count : 0;
    renderTeamCard(team); syncSkillMaster(); hideResults();
}
// the bottom "every ship skilled" box
function setEveryoneSkilled(on) {
    for (const t of _teams) for (const e of t.ships) e.skilled = on ? e.count : 0;
    renderAllTeams(); hideResults();
}
// bottom "every ship skilled" box follows the teams
function syncSkillMaster() {
    const box = document.getElementById('skilledPilots');
    if (!box) return;
    const ships = _teams.flatMap(t => t.ships);
    box.checked = !ships.length ? box.checked : ships.every(e => (e.skilled || 0) >= e.count);
    box.indeterminate = ships.length > 0 && !box.checked && ships.some(e => (e.skilled || 0) > 0);
}
// skilled share of a team (weighted by toughness × count)
function teamSkill(team) {
    let tot = 0, sk = 0;
    for (const e of team.ships) {
        const w = Math.max(1, (e.resolved.maxShields || 0) + (e.resolved.maxHull || 0));
        tot += w * e.count; sk += w * Math.min(e.count, e.skilled || 0);
    }
    return tot ? sk / tot : 1;
}
window.setShipSkilled = setShipSkilled;
window.setTeamSkilled = setTeamSkilled;
window.setEveryoneSkilled = setEveryoneSkilled;

// rename a team
function renameTeam(teamId, newName) {
    const team = _teams.find(t => t.id === teamId);
    if (team) team.name = newName || team.name;
}

// ── ship search ──

const _blurTimers = {};

// ship search for a team
function searchShipsForTeam(teamId, query) {
    const lq = (query || '').toLowerCase().trim();
    const dd = document.getElementById('dropdown_' + teamId);
    if (!dd) return;
    dd.innerHTML = '';
    const hits = lq.length < 1
        ? _allShips.slice(0, 80)
        : _allShips.filter(s => window.ShipNames ? ShipNames.matches(s, lq) : s.name?.toLowerCase().includes(lq)).slice(0, 80);
    if (!hits.length) {
        dd.innerHTML = '<div class="ship-dropdown-empty">No ships found</div>';
    } else {
        for (const ship of hits) {
            const row = document.createElement('div');
            row.className = 'ship-dropdown-item';
            const pl = (window.allData?.[ship._pluginId]?.displayName || window.allData?.[ship._pluginId]?.sourceName) || '';
            row.innerHTML = `<span>${window.ShipNames ? ShipNames.html(ship) : escHtml(ship.name)}</span><span class="sdi-plugin">${escHtml(pl)}</span>`;
            row.onmousedown = () => {
                const countEl = document.getElementById('addCount_' + teamId);
                const count   = clampCount(countEl);
                addShipToTeam(teamId, ship, count);
                const inputEl = document.getElementById('search_' + teamId);
                if (inputEl) inputEl.value = '';
                dd.classList.remove('open');
            };
            dd.appendChild(row);
        }
    }
    dd.classList.add('open');
}

// open its dropdown
function openTeamDropdown(teamId) {
    clearTimeout(_blurTimers[teamId]);
    searchShipsForTeam(teamId, document.getElementById('search_' + teamId)?.value);
}

// close it
function blurTeamDropdown(teamId) {
    _blurTimers[teamId] = setTimeout(() => {
        document.getElementById('dropdown_' + teamId)?.classList.remove('open');
    }, 180);
}

// ── drawing the teams ──

function renderAllTeams() {
    const container = document.getElementById('teamsContainer');
    if (!container) return;
    container.innerHTML = '';
    for (const team of _teams) container.appendChild(createTeamCardElement(team));
    const addBtn = document.getElementById('addTeamBtn');
    if (addBtn) addBtn.style.display = _teams.length >= 30 ? 'none' : '';
}

// redraw one team card
function renderTeamCard(team) {
    const existing = document.getElementById('teamCard_' + team.id);
    if (!existing) { renderAllTeams(); return; }
    existing.replaceWith(createTeamCardElement(team));
}

// build a team card
function createTeamCardElement(team) {
    const el = document.createElement('div');
    el.className = 'team-card';
    el.id = 'teamCard_' + team.id;
    el.style.setProperty('--team-color', team.color);

    const totalShips = team.ships.reduce((s, e) => s + e.count, 0);

    const header = document.createElement('div');
    header.className = 'team-card-header';
    header.innerHTML = `
        <div class="team-color-dot" style="background:${team.color}"></div>
        <input class="team-name-input" value="${escHtml(team.name)}"
               placeholder="Team name"
               onchange="renameTeam('${team.id}', this.value)">
        <span class="team-ship-count">${totalShips} ship${totalShips !== 1 ? 's' : ''}</span>
        <button class="team-remove-btn" title="Remove team" onclick="removeTeam('${team.id}')">✕</button>
    `;
    if (team.ships.length) {
        const skilledShips = team.ships.reduce((n, e) => n + Math.min(e.count, e.skilled || 0), 0);
        const allSk = skilledShips >= totalShips;
        const bar = document.createElement('div');
        bar.className = 'team-skill-bar';
        bar.innerHTML = `<span>✈ ${skilledShips} of ${totalShips} skilled</span>
            <button type="button" class="team-skill-btn" onclick="setTeamSkilled('${team.id}', ${!allSk})">${allSk ? 'Make none skilled' : 'Make all skilled'}</button>`;
        el._skillBar = bar;
    }
    el.appendChild(header);
    if (el._skillBar) el.appendChild(el._skillBar);

    const shipList = document.createElement('div');
    shipList.className = 'team-ship-list';
    if (team.ships.length === 0) {
        shipList.innerHTML = '<div class="team-no-ships">No ships added yet</div>';
    } else {
        team.ships.forEach((entry, idx) => {
            const row = document.createElement('div');
            row.className = 'team-ship-row';
            const stats = entry.resolved;
            row.innerHTML = `
                <div class="team-ship-info">
                    <div class="team-ship-name">${window.ShipNames ? ShipNames.html(entry.shipData) : escHtml(entry.shipData.name)}</div>
                    <div class="team-ship-stats">
                        <span>Shld ${fmt(stats.maxShields)}</span>
                        <span>Hull ${fmt(stats.maxHull)}</span>
                        <span>sDPS ${fmt(stats.shieldDPS)}</span>
                        <span>hDPS ${fmt(stats.hullDPS)}</span>
                    </div>
                </div>
                <div class="team-ship-controls">
                    ${entry.count > 1
                        ? `<label class="team-skill" title="How many of these ${entry.count} ships have skilled pilots">✈
                             <input class="team-skill-input" id="skilled_${team.id}_${idx}" type="number" min="0" max="${entry.count}" value="${Math.min(entry.count, entry.skilled || 0)}"
                                    aria-label="Skilled pilots" onchange="setShipSkilled('${team.id}', ${idx}, this.value)"> skilled</label>`
                        : `<label class="team-skill" title="This ship has a skilled pilot"><input type="checkbox" ${(entry.skilled || 0) >= 1 ? 'checked' : ''}
                             aria-label="Skilled pilot" onchange="setShipSkilled('${team.id}', ${idx}, this.checked)"> ✈ skilled</label>`}
                    <input class="team-count-input" type="number" min="1" max="9999"
                           value="${entry.count}" aria-label="Number of ships"
                           onchange="updateShipCount('${team.id}', ${idx}, this.value)"
                           oninput="updateShipCount('${team.id}', ${idx}, this.value)">
                    <button class="team-remove-btn" title="Remove" onclick="removeShipFromTeam('${team.id}', ${idx})">✕</button>
                </div>
            `;
            shipList.appendChild(row);
        });
    }
    el.appendChild(shipList);

    const addSection = document.createElement('div');
    addSection.className = 'team-add-section';
    addSection.innerHTML = `
        <div class="team-add-row">
            <div class="ship-search-wrap" style="flex:1;">
                <input type="text" id="search_${team.id}" class="team-search-input"
                       placeholder="🔍 Add ship…" autocomplete="off"
                       oninput="searchShipsForTeam('${team.id}', this.value)"
                       onfocus="openTeamDropdown('${team.id}')"
                       onblur="blurTeamDropdown('${team.id}')">
                <div class="ship-dropdown" id="dropdown_${team.id}"></div>
            </div>
            <input class="team-count-input" id="addCount_${team.id}" type="number" min="1" max="9999" value="1" style="width:60px;">
        </div>
    `;
    el.appendChild(addSection);

    return el;
}

// ── running the simulation ──

function updateSimButton() {
    const btn = document.getElementById('fightBtn');
    if (!btn) return;
    const validTeams = _teams.filter(t => t.ships.length > 0 && t.ships.some(e => e.count > 0));
    btn.disabled = validTeams.length < 2;
    btn.textContent = validTeams.length >= 2
        ? `⚔ SIMULATE BATTLE (${validTeams.length} teams)`
        : '⚔ SIMULATE BATTLE';
}

// hide old results
function hideResults() {
    const el = document.getElementById('simResults');
    if (el) el.style.display = 'none';
}

// ⚔ SIMULATE BATTLE
async function runSimulation() {
    if (!_attrDefs) { setStatus('Attribute definitions not loaded — please wait.', true); return; }
    if (!window.DamageTypes?.isReady()) { setStatus('Damage type registry not ready — please wait.', true); return; }

    const validTeams = _teams.filter(t => t.ships.length > 0 && t.ships.some(e => e.count > 0));
    if (validTeams.length < 2) { setStatus('Add ships to at least 2 teams first.', true); return; }

    const resEl = document.getElementById('simResults');
    if (resEl) resEl.style.display = 'none';

    if (typeof window.BattleSimDisplay?.showProgressModal === 'function')
        window.BattleSimDisplay.showProgressModal(cancelSimulation);

    await new Promise(r => setTimeout(r, 30));
    _simCancelled = false;

    try {
        const teamStats = validTeams.map(team => {
            const entries = team.ships.filter(e => e.count > 0).map(e => ({ resolved: e.resolved, count: e.count }));
            const merged  = mergeTeamStats(entries);
            merged._teamShips = entries;   // per-ship speed/size for the pilot model
            merged.skill = teamSkill(team); // share of the team flown by skilled pilots
            merged.name   = team.name;
            merged.color  = team.color;
            merged._team  = team;
            return merged;
        });

        const payload = { damageTypes: _damageTypes, outfitIndex: _outfitIndex, attrDefs: _attrDefs, teamStats };
        // Pilots always fly the fight now; how well depends on each team's skilled share.
        const simOpts = { skilled: true };
        const updateProgress = typeof window.BattleSimDisplay?.updateProgressModal === 'function'
            ? window.BattleSimDisplay.updateProgressModal : () => {};

        if (teamStats.length === 2) {
            const nameA = teamStats[0].name, nameB = teamStats[1].name;
            updateProgress(0, `Fight 1 of 1: ${nameA} vs ${nameB}`, 0, 'Starting…');
            payload.mode    = '2team';
            payload.results = await simulateBattle(teamStats[0], teamStats[1], (fightPct, fightLabel) => {
                updateProgress(fightPct, `Fight 1 of 1: ${nameA} vs ${nameB}`, fightPct, fightLabel);
            }, simOpts);
            updateProgress(100, `Fight 1 of 1: ${nameA} vs ${nameB}`, 100, 'Done');
        } else {
            const n = teamStats.length;
            let totalFights = 0;
            for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) totalFights++;
            let fightsDone = 0;
            const matrix = [];
            for (let i = 0; i < n; i++) matrix[i] = new Array(n).fill(null);
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    const nameA = teamStats[i].name, nameB = teamStats[j].name;
                    const overallLabel = `Fight ${fightsDone + 1} of ${totalFights}: ${nameA} vs ${nameB}`;
                    updateProgress((fightsDone / totalFights) * 100, overallLabel, 0, 'Starting…');
                    matrix[i][j] = await simulateBattle(teamStats[i], teamStats[j], (fightPct, fightLabel) => {
                        updateProgress((fightsDone / totalFights) * 100 + fightPct / totalFights, overallLabel, fightPct, fightLabel);
                    }, simOpts);
                    fightsDone++;
                }
            }
            updateProgress(100, `All ${totalFights} fights complete`, 100, 'Done');
            payload.mode    = 'nteam';
            payload.results = matrix;
        }

        if (typeof window.BattleSimDisplay?.renderResults === 'function')
            window.BattleSimDisplay.renderResults(payload);
        else
            setStatus('Display module missing.', true);

    } catch (err) {
        if (err.message === 'CANCELLED') setStatus('Simulation cancelled.', false);
        else { console.error('runSimulation error:', err); setStatus('Simulation error: ' + err.message, true); }
    } finally {
        if (typeof window.BattleSimDisplay?.hideProgressModal === 'function')
            window.BattleSimDisplay.hideProgressModal();
    }
}

// stop a running fight
function cancelSimulation() { _simCancelled = true; }

// ── window.BattleSim ──
window.searchShipsForTeam  = searchShipsForTeam;
window.openTeamDropdown    = openTeamDropdown;
window.blurTeamDropdown    = blurTeamDropdown;
window.removeTeam          = removeTeam;
window.removeShipFromTeam  = removeShipFromTeam;
window.updateShipCount     = updateShipCount;
window.renameTeam          = renameTeam;
window.runSimulation       = runSimulation;

// ship count boxes: 1–9,999, put right if not
function clampCount(el) {
    if (!el) return 1;
    const raw = Number(el.value);
    const n = Math.max(1, Math.min(9999, Math.trunc(raw) || 1));
    if (String(n) !== String(el.value).trim()) {
        el.value = n;
        let tip = el.parentElement && el.parentElement.querySelector('.team-count-tip');
        if (!tip && el.parentElement) {
            tip = document.createElement('span');
            tip.className = 'team-count-tip';
            tip.style.cssText = 'font-size:0.75rem;color:var(--c-warn-text,#fbbf24);margin-left:6px;';
            el.insertAdjacentElement('afterend', tip);
        }
        if (tip) { tip.textContent = `Ship count must be 1–9,999 — using ${n}.`; clearTimeout(tip._t); tip._t = setTimeout(() => { tip.textContent = ''; }, 4000); }
    }
    return n;
}
document.addEventListener('change', e => { if (e.target.classList && e.target.classList.contains('team-count-input')) clampCount(e.target); });
// Lets other pages/tools fill the teams (e.g. "test this fit in the battle simulator")
window.BattleSimTeams = {
    teams: () => _teams, ships: () => _allShips,
    create: name => createTeam(name), add: (teamId, ship, n) => addShipToTeam(teamId, ship, n),
    clear: () => { for (const t of _teams) t.ships = []; renderAllTeams(); updateSimButton(); },
    refresh: () => { renderAllTeams(); updateSimButton(); },
};
window.cancelSimulation    = cancelSimulation;

window.addNewTeam = function() {
    createTeam('Team ' + (_teams.length + 1));
    renderAllTeams();
    updateSimButton();
};

document.addEventListener('DOMContentLoaded', () => {
    createTeam('Team 1');
    createTeam('Team 2');
    renderAllTeams();

    const btn = document.getElementById('fightBtn');
    if (btn) btn.addEventListener('click', runSimulation);

    // DataLoader must be loaded first — it seeds window.allData and window.attrDefs
    init();
});

})();
