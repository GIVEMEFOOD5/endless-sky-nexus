// The Data Viewer sorters: which fields you can sort by (from the items on screen), their values and averages.

'use strict';

// ── state ──

let activeSorters       = [];
let sorterCurrentTab    = 'ships';
let sorterPickerPending = [];
let _sorterItems        = [];   // post-filter items currently on screen
let _sorterAttrDefs     = null;
let _sorterPluginId     = null; // fallback when item has no own _pluginId
let _cachedOutfitIndex  = null;

// ── keys never offered ──

const SKIP_TOP_LEVEL = new Set([
    'name', 'description', 'category', 'thumbnail', 'sprite',
    'display name', 'plural', 'series',
    'flare sprite', 'flare sprite data', 'flare sound',
    'reverse flare sprite', 'reverse flare sprite data', 'reverse flare sound',
    'steering flare sprite', 'steering flare sprite data', 'steering flare sound',
    'flotsam sprite', 'afterburner effect', 'jump effect',
    'governments', 'locations', 'licenses', 'linked',
    'pluginId', '_pluginId', '_internalId', '_hash',
    'weapon', 'ammo',
]);

const SKIP_WEAPON = new Set([
    'sprite', 'sprite data', 'hardpoint sprite', 'icon',
    'hit effect', 'fire effect', 'die effect', 'live effect', 'target effect',
    'sound', 'stream', 'cluster', 'submunition', 'ammo',
]);

// Prefixes that mark keys produced by ComputedStats derived/fn/sys resolution.
const COMPUTED_PREFIXES = ['_fn_', '_derived_', '_sys_'];

// computed key?
function isComputedKey(key) {
    return COMPUTED_PREFIXES.some(p => key.startsWith(p));
}

// keys used for "per ton / per space" fields
const _SORTER_PER_DIVISOR_FALLBACK = ['outfit space', 'cargo space', 'weapon capacity', 'engine capacity'];
// divisor keys
function _sorterPerDivisorKeys() {
    const caps = window.GameKeys ? window.GameKeys.capacityKeys(_SORTER_PER_DIVISOR_FALLBACK) : _SORTER_PER_DIVISOR_FALLBACK;
    return [...caps, 'mass'].map(key => ({ key, label: key.replace(/\b\w/g, c => c.toUpperCase()) }));
}

// an attribute's display multiplier

function _getDisplayMultiplier(key) {
    if (!_sorterAttrDefs) return 1;
    const def = (_sorterAttrDefs.attributes || {})[key];
    return (def && typeof def.displayMultiplier === 'number' && def.displayMultiplier !== 0)
        ? def.displayMultiplier
        : 1;
}

// outfit index for the selected plugins

function _getOutfitIndex() {
    if (_cachedOutfitIndex) return _cachedOutfitIndex;

    // selected plugins only (see ItemStats.buildOutfitIndex)
    const allData = (window.DataLoader && typeof window.DataLoader.getActiveData === 'function' ? window.DataLoader.getActiveData() : (window.allData || {}));
    const merged  = {};

    // 1. Current plugin's own outfits first — matches ComputedStats giving the
    //    ship/outfit's own plugin priority over every other loaded plugin.
    const ownPluginData = _sorterPluginId ? allData[_sorterPluginId] : null;
    if (ownPluginData) {
        for (const o of (ownPluginData.outfits || []))
            if (o.name && !(o.name in merged)) merged[o.name] = o;
    }

    // 2. Everything else, first-seen-wins, as a fallback merge.
    for (const [pid, pd] of Object.entries(allData)) {
        if (pid === _sorterPluginId) continue;
        for (const o of (pd.outfits || []))
            if (o.name && !(o.name in merged)) merged[o.name] = o;
    }

    _cachedOutfitIndex = merged;
    return _cachedOutfitIndex;
}

// field key → safe id

function keyToId(key) {
    return key.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-]/g, '_');
}

// "energy capacity" → "Energy Capacity"
function toTitleCase(str) {
    return str.replace(/\b\w/g, c => c.toUpperCase());
}

// "per X" ratio with the right sign
function _signedPerDivisor(numerator, ratio) {
    if (ratio === 0 || isNaN(ratio)) return ratio;
    const mag = Math.abs(ratio);
    return numerator < 0 ? -mag : mag;
}

// every sortable field the items on screen have. Called by: buildFieldsForTab

function scanFieldsFromItems(tab, items) {
    const isShipLike = tab === 'ships' || tab === 'variants';
    const isOutfits  = tab === 'outfits';

    const shipBaseSeen   = new Set();
    const shipAccumSeen  = new Set();
    const outfitSeen     = new Set();
    const weaponSeen     = new Set();
    const effectSeen     = new Set();
    const perDivSeen     = new Set(); // dedupe across both raw-attr and weapon-damage per-divisor fields

    const shipBaseFields  = [];
    const shipAccumFields = [];
    const outfitFields    = [];
    const weaponFields    = [];
    const effectFields    = [];
    const perDivFields    = [];

    for (const item of (items || [])) {

        if (isShipLike) {
            // raw attributes
            const attrs = item.attributes;
            if (attrs && typeof attrs === 'object') {
                for (const [key, val] of Object.entries(attrs)) {
                    if (typeof val !== 'number') continue;
                    const id = 'raw_attr_' + keyToId(key);
                    if (shipBaseSeen.has(id)) continue;
                    shipBaseSeen.add(id);
                    const mult = _getDisplayMultiplier(key);
                    shipBaseFields.push({
                        id,
                        key,
                        label:             toTitleCase(key) + ' (base)',
                        path:              ['attributes', key],
                        raw:               true,
                        group:             'shipBase',
                        displayMultiplier: mult,
                    });
                }
            }

            // attributes with outfits added (ComputedStats)
            if (typeof getComputedStats === 'function') {
                const pluginId = item._pluginId || _sorterPluginId;
                if (pluginId) {
                    const computed = getComputedStats(item, pluginId);
                    if (computed && typeof computed === 'object') {
                        for (const [key, val] of Object.entries(computed)) {
                            if (typeof val !== 'number')   continue;
                            if (key.startsWith('_'))        continue;
                            if (isComputedKey(key))         continue;
                            const id = 'accum_attr_' + keyToId(key);
                            if (shipAccumSeen.has(id))      continue;
                            shipAccumSeen.add(id);
                            const mult = _getDisplayMultiplier(key);
                            shipAccumFields.push({
                                id,
                                key,
                                label:             toTitleCase(key) + ' (with outfits)',
                                path:              null,
                                useAccum:          true,
                                raw:               false,
                                group:             'shipAccum',
                                displayMultiplier: mult,
                            });
                        }

                        // weapon DPS fields (once any item has a weapon)
                        const WS_FIELDS = [
                            { wsKey: '_ws_totalDps',         label: 'Total DPS (with outfits)'         },
                            { wsKey: '_ws_shieldDps',        label: 'Shield DPS (with outfits)'        },
                            { wsKey: '_ws_hullDps',          label: 'Hull DPS (with outfits)'          },
                            { wsKey: '_ws_shieldHullDps',    label: 'Shield + Hull DPS (with outfits)' },
                            { wsKey: '_ws_weaponCount',      label: 'Weapon Types (with outfits)'      },
                            { wsKey: '_ws_totalWeaponMounts',label: 'Total Weapon Mounts'              },
                        ];
                        // per-damage-type DPS keys
                        for (const key of Object.keys(computed)) {
                            if (!key.startsWith('_ws_dps_')) continue;
                            const dmgType = key.slice('_ws_dps_'.length).replace(/_/g, ' ');
                            WS_FIELDS.push({
                                wsKey: key,
                                label: toTitleCase(dmgType) + ' DPS (with outfits)',
                            });
                        }

                        for (const { wsKey, label } of WS_FIELDS) {
                            // shield + hull DPS is worked out when read
                            const isSynthetic = wsKey === '_ws_shieldHullDps';
                            if (!isSynthetic && computed[wsKey] == null) continue;
                            const id = 'ship_ws_' + keyToId(wsKey);
                            if (shipAccumSeen.has(id)) continue;
                            shipAccumSeen.add(id);
                            shipAccumFields.push({
                                id,
                                key:              wsKey,
                                label,
                                path:             null,
                                useAccum:         !isSynthetic,
                                isShieldHullDpsShip: isSynthetic,
                                raw:              false,
                                group:            'shipAccum',
                                displayMultiplier: 1, // _ws_ keys are already /s
                            });
                        }

                        // firing costs per second
                        if (window.WeaponStats) {
                            const outfitMap = item.outfitMap || item.outfits || {};
                            const outfitIdx = _getOutfitIndex();
                            const wsStats   = window.WeaponStats.getShipWeaponStats({ outfits: outfitMap }, outfitIdx);

                            // Aggregate firing costs across all weapons
                            let firingEnergy = 0, firingHeat = 0, firingFuel = 0;
                            for (const w of (wsStats.weapons || [])) {
                                const fc = w.profile?.firingCosts;
                                if (!fc) continue;
                                const sps = w.profile.shotsPerSecond * w.count;
                                firingEnergy += (fc['firing energy'] || 0) * sps;
                                firingHeat   += (fc['firing heat']   || 0) * sps;
                                firingFuel   += (fc['firing fuel']   || 0) * sps;
                            }

                            const FIRING_FIELDS = [
                                { id: 'ship_firing_energy_ps', key: '_firing_energy_ps', label: 'Firing Energy/s (with outfits)', val: firingEnergy },
                                { id: 'ship_firing_heat_ps',   key: '_firing_heat_ps',   label: 'Firing Heat/s (with outfits)',   val: firingHeat   },
                                { id: 'ship_firing_fuel_ps',   key: '_firing_fuel_ps',   label: 'Firing Fuel/s (with outfits)',   val: firingFuel   },
                            ];
                            for (const { id, key, label, val } of FIRING_FIELDS) {
                                if (!val || shipAccumSeen.has(id)) continue;
                                shipAccumSeen.add(id);
                                shipAccumFields.push({
                                    id,
                                    key,
                                    label,
                                    path:              null,
                                    useAccum:          false,
                                    isFiringCost:      true,
                                    firingCostVal:     val,
                                    raw:               false,
                                    group:             'shipAccum',
                                    displayMultiplier: 1,
                                });
                            }
                        }
                    }
                }
            }

        } else if (isOutfits) {
            // numeric outfit fields
            for (const [key, val] of Object.entries(item)) {
                if (SKIP_TOP_LEVEL.has(key)) continue;
                if (typeof val !== 'number')  continue;
                if (key.startsWith('_'))       continue;

                const id = 'raw_' + keyToId(key);
                if (!outfitSeen.has(id)) {
                    outfitSeen.add(id);
                    const mult = _getDisplayMultiplier(key);
                    outfitFields.push({
                        id,
                        key,
                        label:             toTitleCase(key),
                        path:              [key],
                        raw:               true,
                        group:             'outfit',
                        displayMultiplier: mult,
                    });
                }

                // per ton / per space versions
                for (const { key: divKey, label: divLabel } of _sorterPerDivisorKeys()) {
                    if (key === divKey) continue;
                    const divVal = item[divKey];
                    if (typeof divVal !== 'number' || divVal === 0) continue;
                    const perDivId = 'per_' + keyToId(divKey) + '_' + keyToId(key);
                    if (perDivSeen.has(perDivId)) continue;
                    perDivSeen.add(perDivId);
                    const mult = _getDisplayMultiplier(key);
                    perDivFields.push({
                        id:                perDivId,
                        key,
                        label:             toTitleCase(key) + ' per ' + divLabel,
                        path:              [key],
                        raw:               false,
                        isPerDivisor:      true,
                        divisorKey:        divKey,
                        divisorLabel:      divLabel,
                        group:             'outfitPerDiv',
                        displayMultiplier: mult,
                    });
                }
            }

            // weapon fields
            if (item.weapon && typeof item.weapon === 'object') {
                for (const [key, val] of Object.entries(item.weapon)) {
                    if (SKIP_WEAPON.has(key))    continue;
                    if (typeof val !== 'number') continue;
                    if (/^[A-Z]/.test(key))      continue;

                    // per shot
                    const id = 'weapon_' + keyToId(key);
                    if (!weaponSeen.has(id)) {
                        weaponSeen.add(id);
                        weaponFields.push({
                            id,
                            key,
                            label: toTitleCase(key),
                            path:  ['weapon', key],
                            raw:   true,
                            group: 'weapon',
                        });
                    }

                    // per ton / per space for weapon fields
                    for (const { key: divKey, label: divLabel } of _sorterPerDivisorKeys()) {
                        const divVal = item[divKey];
                        if (typeof divVal !== 'number' || divVal === 0) continue;
                        const perDivWeaponAttrId = 'weapon_attr_per_' + keyToId(divKey) + '_' + keyToId(key);
                        if (perDivSeen.has(perDivWeaponAttrId)) continue;
                        perDivSeen.add(perDivWeaponAttrId);
                        perDivFields.push({
                            id:                perDivWeaponAttrId,
                            key,
                            label:             toTitleCase(key) + ' per ' + divLabel,
                            path:              ['weapon', key],
                            raw:               false,
                            isPerDivisor:      true,
                            divisorKey:        divKey,
                            divisorLabel:      divLabel,
                            group:             'weaponPerDiv',
                        });
                    }
                }

                // weapon summary fields
                if (!weaponSeen.has('weapon_computed_totalDps')) {
                    weaponSeen.add('weapon_computed_totalDps');
                    weaponFields.push({ id: 'weapon_computed_totalDps',  key: 'totalDps',       label: 'Total DPS',        path: null, group: 'weapon', isOutfitComputed: true });
                    weaponFields.push({ id: 'weapon_computed_shieldDps', key: 'shieldDps',      label: 'Shield DPS',       path: null, group: 'weapon', isOutfitComputed: true });
                    weaponFields.push({ id: 'weapon_computed_hullDps',   key: 'hullDps',        label: 'Hull DPS',         path: null, group: 'weapon', isOutfitComputed: true });
                    weaponFields.push({ id: 'weapon_computed_shieldHullDps', key: 'shieldHullDps', label: 'Shield + Hull DPS', path: null, group: 'weapon', isShieldHullDps: true });
                    weaponFields.push({ id: 'weapon_computed_range',     key: 'effectiveRange', label: 'Effective Range',  path: null, group: 'weapon', isOutfitComputed: true });
                    weaponFields.push({ id: 'weapon_computed_sps',       key: 'shotsPerSecond', label: 'Shots Per Second', path: null, group: 'weapon', isOutfitComputed: true });
                }

                // DPS per damage type
                if (window.WeaponStats) {
                    const profileForTypes = window.WeaponStats._calcWeaponProfile(item.weapon, item.name, _getOutfitIndex());
                    const discoveredDmgTypes = profileForTypes
                        ? Object.keys(profileForTypes.dpsBreakdown || {})
                            .filter(k => k.endsWith(' damage'))
                            .map(k => k.slice(0, -' damage'.length))
                        : [];

                    for (const dmgType of discoveredDmgTypes) {
                        const dpsId = 'weapon_dps_' + keyToId(dmgType);
                        if (weaponSeen.has(dpsId)) continue;
                        weaponSeen.add(dpsId);
                        weaponFields.push({
                            id:    dpsId,
                            key:   dmgType,
                            label: toTitleCase(dmgType) + ' DPS',
                            path:  null,
                            raw:   false,
                            group: 'weapon',
                            isDps: true,
                        });
                    }

                    // damage and DPS per ton / per space
                    for (const { key: divKey, label: divLabel } of _sorterPerDivisorKeys()) {
                        const divVal = item[divKey];
                        if (typeof divVal !== 'number' || divVal === 0) continue;
                        for (const dmgType of discoveredDmgTypes) {
                            const perDivDpsId = 'weapon_dps_per_' + keyToId(divKey) + '_' + keyToId(dmgType);
                            if (!perDivSeen.has(perDivDpsId)) {
                                perDivSeen.add(perDivDpsId);
                                perDivFields.push({
                                    id:           perDivDpsId,
                                    key:          dmgType,
                                    label:        toTitleCase(dmgType) + ' DPS per ' + divLabel,
                                    path:         null,
                                    raw:          false,
                                    isDpsPerDivisor: true,
                                    divisorKey:   divKey,
                                    divisorLabel: divLabel,
                                    group:        'weaponPerDiv',
                                });
                            }
                        }
                    }
                }
                // total DPS per ton / per space
                for (const { key: divKey, label: divLabel } of _sorterPerDivisorKeys()) {
                    const divVal = item[divKey];
                    if (typeof divVal !== 'number' || divVal === 0) continue;
                    const totalDpsPerDivId = 'weapon_total_dps_per_' + keyToId(divKey);
                    if (perDivSeen.has(totalDpsPerDivId)) continue;
                    perDivSeen.add(totalDpsPerDivId);
                    perDivFields.push({
                        id:              totalDpsPerDivId,
                        key:             'totalDps',
                        label:           'Total DPS per ' + divLabel,
                        path:            null,
                        raw:             false,
                        isOutfitComputedPerDivisor: true,
                        divisorKey:      divKey,
                        divisorLabel:    divLabel,
                        group:           'weaponPerDiv',
                    });
                }
            }

        } else {
            // numeric fields on effects and other tabs
            for (const [key, val] of Object.entries(item)) {
                if (typeof val !== 'number') continue;
                if (key.startsWith('_'))      continue;
                const id = 'raw_' + keyToId(key);
                if (effectSeen.has(id)) continue;
                effectSeen.add(id);
                effectFields.push({
                    id,
                    key,
                    label: toTitleCase(key),
                    path:  [key],
                    raw:   true,
                    group: 'effect',
                });
            }
        }
    }

    const alpha = (a, b) => a.label.localeCompare(b.label);
    return {
        shipBaseFields:  shipBaseFields.sort(alpha),
        shipAccumFields: shipAccumFields.sort(alpha),
        outfitFields:    outfitFields.sort(alpha),
        weaponFields:    weaponFields.sort(alpha),
        effectFields:    effectFields.sort(alpha),
        perDivFields:    perDivFields.sort(alpha),
    };
}

// computed fields (ComputedStats)

function buildComputedFields() {
    if (typeof getComputedSorterFields !== 'function') return [];
    return getComputedSorterFields().map(f => ({ ...f, useComputed: true }));
}

// ── hardpoints ──

const HARDPOINT_FIELDS = [
    { id: '_gunCount',            label: 'Gun Ports',            fn: i => (i.guns            || []).length },
    { id: '_turretCount',         label: 'Turret Ports',         fn: i => (i.turrets         || []).length },
    { id: '_bayCount',            label: 'Bay Count',            fn: i => (i.bays            || []).length },
    { id: '_engineCount',         label: 'Engine Points',        fn: i => (i.engines         || []).length },
    { id: '_reverseEngineCount',  label: 'Reverse Eng. Points',  fn: i => (i.reverseEngines  || []).length },
    { id: '_steeringEngineCount', label: 'Steering Eng. Points', fn: i => (i.steeringEngines || []).length },
];

// fields for a tab (cached)

function buildFieldsForTab(tab, items) {
    const isShipLike = tab === 'ships' || tab === 'variants';
    const isOutfits  = tab === 'outfits';

    const { shipBaseFields, shipAccumFields, outfitFields, weaponFields, effectFields, perDivFields } =
        scanFieldsFromItems(tab, items);

    const all    = [];
    const seenId = new Set();
    const add    = f => { if (!seenId.has(f.id)) { all.push(f); seenId.add(f.id); } };

    if (isShipLike) {
        for (const f of buildComputedFields())      add(f);
        for (const f of shipAccumFields)            add(f);
        for (const f of shipBaseFields)             add(f);
        for (const { id, label, fn } of HARDPOINT_FIELDS) {
            add({ id, key: id, label, computed: fn });
        }

    } else if (isOutfits) {
        for (const f of outfitFields) add(f);
        for (const f of weaponFields) add(f);
        for (const f of perDivFields) add(f);

    } else {
        for (const f of effectFields) add(f);
    }

    return all;
}

// ── field cache ──

const _fieldCache = {};

// fields for a tab
function getFieldsForTab(tab) {
    if (!_fieldCache[tab]) {
        _fieldCache[tab] = buildFieldsForTab(tab, _sorterItems);
    }
    return _fieldCache[tab];
}

// forget cached fields
function clearFieldCache() {
    for (const k of Object.keys(_fieldCache)) delete _fieldCache[k];
}

// use these attribute definitions

function setSorterAttrDefs(defs) {
    _sorterAttrDefs = defs;
    clearFieldCache();
}

// plugin for computed stats
function setSorterPluginId(pluginId) {
    _sorterPluginId    = pluginId;
    _cachedOutfitIndex = null;
    clearFieldCache();
    if (typeof clearComputedCache === 'function') clearComputedCache();
}

// items on screen. Called by: generalFilterStuff
function setSorterItems(items) {
    _sorterItems = items || [];
    delete _fieldCache[sorterCurrentTab];
    renderSorterBox();
    if (typeof stampSorterValues === 'function') stampSorterValues();
}

// a field's value for one item (works out computed fields as needed)

function getFieldValue(item, field) {

    // per ton / per space outfit attribute
    if (field.isPerDivisor) {
        const divisor = item[field.divisorKey];
        if (typeof divisor !== 'number' || divisor === 0) return undefined;
        let obj = item;
        for (const k of field.path) {
            if (obj == null) return undefined;
            obj = obj[k];
        }
        if (typeof obj !== 'number') return undefined;
        const mult = field.displayMultiplier || _getDisplayMultiplier(field.key);
        const numerator = obj * mult;
        return _signedPerDivisor(numerator, numerator / divisor);
    }

    // per ton / per space damage-type DPS
    if (field.isDpsPerDivisor) {
        if (!item.weapon || !window.WeaponStats) return undefined;
        const divisor = item[field.divisorKey];
        if (typeof divisor !== 'number' || divisor === 0) return undefined;
        const profile = window.WeaponStats._calcWeaponProfile(item.weapon, item.name, _getOutfitIndex());
        if (!profile) return undefined;
        const dmgKey = field.key + ' damage';
        const val = profile.dpsBreakdown?.[dmgKey];
        if (val == null || val === 0) return undefined;
        return _signedPerDivisor(val, val / divisor);
    }

    // per ton / per space total DPS
    if (field.isOutfitComputedPerDivisor) {
        if (!item.weapon || !window.WeaponStats) return undefined;
        const divisor = item[field.divisorKey];
        if (typeof divisor !== 'number' || divisor === 0) return undefined;
        const profile = window.WeaponStats.getOutfitWeaponStats(item, _getOutfitIndex());
        if (!profile) return undefined;
        const val = profile[field.key];
        if (val == null || val === 0) return undefined;
        return _signedPerDivisor(val, val / divisor);
    }

    // shield + hull DPS (outfits)
    if (field.isShieldHullDps) {
        if (!item.weapon || !window.WeaponStats) return undefined;
        const profile = window.WeaponStats._calcWeaponProfile(item.weapon, item.name, _getOutfitIndex());
        if (!profile) return undefined;
        const shieldDps = profile.shieldDps ?? 0;
        const hullDps   = profile.hullDps   ?? 0;
        return (shieldDps || hullDps) ? shieldDps + hullDps : undefined;
    }

    // shield + hull DPS (ships)
    if (field.isShieldHullDpsShip) {
        if (typeof getComputedStats !== 'function') return undefined;
        const pluginId = item._pluginId || _sorterPluginId;
        if (!pluginId) return undefined;
        const stats = getComputedStats(item, pluginId);
        if (!stats) return undefined;
        const shieldDps = stats['_ws_shieldDps'] ?? 0;
        const hullDps   = stats['_ws_hullDps']   ?? 0;
        return (shieldDps || hullDps) ? shieldDps + hullDps : undefined;
    }

    // 0a-i. Firing cost fields (energy/heat/fuel per second from WeaponStats)
    if (field.isFiringCost) {
        // Value was pre-computed at scan time and stored on the field descriptor.
        // Re-compute live here so it reflects the actual item being evaluated.
        if (!window.WeaponStats) return undefined;
        const outfitMap = item.outfitMap || item.outfits || {};
        const outfitIdx = _getOutfitIndex();
        const wsStats   = window.WeaponStats.getShipWeaponStats({ outfits: outfitMap }, outfitIdx);
        let firingEnergy = 0, firingHeat = 0, firingFuel = 0;
        for (const w of (wsStats.weapons || [])) {
            const fc = w.profile?.firingCosts;
            if (!fc) continue;
            const sps = w.profile.shotsPerSecond * w.count;
            firingEnergy += (fc['firing energy'] || 0) * sps;
            firingHeat   += (fc['firing heat']   || 0) * sps;
            firingFuel   += (fc['firing fuel']   || 0) * sps;
        }
        if (field.key === '_firing_energy_ps') return firingEnergy || undefined;
        if (field.key === '_firing_heat_ps')   return firingHeat   || undefined;
        if (field.key === '_firing_fuel_ps')   return firingFuel   || undefined;
        return undefined;
    }

    // 0a. Outfit computed weapon profile (range, sps, totalDps, shieldDps, hullDps)
    if (field.isOutfitComputed) {
        if (!item.weapon || !window.WeaponStats) return undefined;
        const profile = window.WeaponStats.getOutfitWeaponStats(item, _getOutfitIndex());
        if (!profile) return undefined;
        return profile[field.key] ?? undefined;
    }

    // DPS per damage type (outfits)
    if (field.isDps) {
        if (!item.weapon || !window.WeaponStats) return undefined;
        const profile = window.WeaponStats._calcWeaponProfile(item.weapon, item.name, _getOutfitIndex());
        if (!profile) return undefined;
        const dmgKey = field.key + ' damage';
        const val = profile.dpsBreakdown?.[dmgKey];
        return (val != null && val !== 0) ? val : undefined;
    }

    // 1. Inline computed (hardpoint counts)
    if (field.computed) return field.computed(item);

    // 2. ComputedStats — _fn_/_derived_/_sys_ physics stats
    if ((field.isComputed || field.useComputed) && typeof getComputedStats === 'function') {
        const pluginId = item._pluginId || _sorterPluginId;
        if (pluginId) {
            const stats = getComputedStats(item, pluginId);
            const val   = stats?.[field.key];
            if (val != null) {
                // _fn_ keys need displayScale applied (ComputedStats stores raw value)
                if (field.key.startsWith('_fn_') && _sorterAttrDefs) {
                    const fnName = field.key.slice(4);
                    const fnData = (_sorterAttrDefs.shipFunctions || {})[fnName];
                    const scale  = fnData?.displayScale ?? 1;
                    return val * scale;
                }
                return val;
            }
        }
    }

    // 3. Accumulated attribute (base + outfit contributions stacked)
    if (field.useAccum && typeof getComputedStats === 'function') {
        const pluginId = item._pluginId || _sorterPluginId;
        if (pluginId) {
            const stats = getComputedStats(item, pluginId);
            const val   = stats?.[field.key];
            if (val != null) {
                const mult = field.displayMultiplier || _getDisplayMultiplier(field.key);
                return val * mult;
            }
        }
    }

    // 4. Walk path on the raw item
    if (field.path && field.path.length > 0) {
        let obj = item;
        for (const k of field.path) {
            if (obj == null) return undefined;
            obj = obj[k];
        }
        if (typeof obj === 'number') {
            const mult = field.displayMultiplier || _getDisplayMultiplier(field.key || (field.path[field.path.length - 1]));
            return obj * mult;
        }
        return obj;
    }

    return undefined;
}

// average as text
function formatAvgValue(val) {
    if (val == null) return '—';
    if (typeof val === 'number') {
        if (val >= 10000) return val.toLocaleString(undefined, { maximumFractionDigits: 0 });
        if (Number.isInteger(val)) return val.toLocaleString();
        return val.toFixed(2);
    }
    return String(val);
}

// sort the items by the chosen sorters. Called by: generalFilterStuff

function applySorters(items) {
    if (activeSorters.length === 0) return items;

    const fields = getFieldsForTab(sorterCurrentTab);

    return [...items].sort((a, b) => {
        for (const sorter of activeSorters) {
            const field = fields.find(f => f.id === sorter.id);
            if (!field) continue;

            const av = getFieldValue(a, field);
            const bv = getFieldValue(b, field);

            const aMissing = av == null || (typeof av === 'number' && isNaN(av));
            const bMissing = bv == null || (typeof bv === 'number' && isNaN(bv));

            if (aMissing && bMissing) continue;
            if (aMissing) return 1;
            if (bMissing) return -1;

            const diff = sorter.dir === 'asc' ? av - bv : bv - av;
            if (diff !== 0) return diff;
        }
        return 0;
    });
}

// average of a field over the items

function computeAverage(sorter) {
    const fields = getFieldsForTab(sorterCurrentTab);
    const field  = fields.find(f => f.id === sorter.id);
    if (!field || _sorterItems.length === 0) return '—';

    const vals = _sorterItems
        .map(item => getFieldValue(item, field))
        .filter(v => v != null && typeof v === 'number' && !isNaN(v));

    if (vals.length === 0) return '—';
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return formatAvgValue(avg);
}

// the sorter box

async function renderSorterBox() {
    const box = document.getElementById('sorterActiveList');
    if (!box) return;

    if (activeSorters.length === 0) {
        box.innerHTML = '<span class="sorter-empty">No sorters active. Click "Add Sorter" to begin.</span>';
        return;
    }

    box.innerHTML = '';

    activeSorters.forEach((sorter, idx) => {
        const row = document.createElement('div');
        row.className = 'sorter-row';

        const label = document.createElement('span');
        label.className   = 'sorter-label';
        label.textContent = sorter.label;

        const avg = document.createElement('span');
        avg.className   = 'sorter-avg';
        avg.textContent = `avg: ${computeAverage(sorter)}`;

        const dirBtn = document.createElement('button');
        dirBtn.className   = 'sorter-dir-btn';
        dirBtn.textContent = sorter.dir === 'asc' ? '↑ Asc' : '↓ Desc';
        dirBtn.onclick = async () => {
            sorter.dir = sorter.dir === 'asc' ? 'desc' : 'asc';
            renderSorterBox();
            await _triggerFilterItems();
        };

        const upBtn = document.createElement('button');
        upBtn.className   = 'sorter-move-btn';
        upBtn.textContent = '▲';
        upBtn.disabled    = idx === 0;
        upBtn.onclick = async () => {
            [activeSorters[idx - 1], activeSorters[idx]] = [activeSorters[idx], activeSorters[idx - 1]];
            renderSorterBox();
            await _triggerFilterItems();
        };

        const downBtn = document.createElement('button');
        downBtn.className   = 'sorter-move-btn';
        downBtn.textContent = '▼';
        downBtn.disabled    = idx === activeSorters.length - 1;
        downBtn.onclick = async () => {
            [activeSorters[idx], activeSorters[idx + 1]] = [activeSorters[idx + 1], activeSorters[idx]];
            renderSorterBox();
            await _triggerFilterItems();
        };

        const removeBtn = document.createElement('button');
        removeBtn.className   = 'sorter-remove-btn';
        removeBtn.textContent = '✕';
        removeBtn.onclick = async () => {
            activeSorters.splice(idx, 1);
            renderSorterBox();
            await _triggerFilterItems();
        };

        row.appendChild(label);
        row.appendChild(avg);
        row.appendChild(dirBtn);
        row.appendChild(upBtn);
        row.appendChild(downBtn);
        row.appendChild(removeBtn);
        box.appendChild(row);
    });
}

// re-run the filter
async function _triggerFilterItems() {
    if (typeof filterItems === 'function') await filterItems();
}

// open the field picker

function openSorterPicker() {
    sorterPickerPending = activeSorters.map(s => s.id);

    const overlay = document.getElementById('sorterPickerOverlay');
    const search  = document.getElementById('sorterPickerSearch');
    if (!overlay) return;

    search.value = '';
    renderPickerList('');
    overlay.classList.add('sorter-overlay-visible');
    search.focus();
}

// close the picker
function closeSorterPicker() {
    const overlay = document.getElementById('sorterPickerOverlay');
    if (overlay) overlay.classList.remove('sorter-overlay-visible');
}

// apply the picker
async function confirmSorterPicker() {
    const fields = getFieldsForTab(sorterCurrentTab);

    for (const id of sorterPickerPending) {
        if (!activeSorters.find(s => s.id === id)) {
            const field = fields.find(f => f.id === id);
            if (field) {
                activeSorters.push({
                    id:               field.id,
                    key:              field.key,
                    label:            field.label,
                    path:             field.path             || null,
                    computed:         field.computed         || null,
                    useComputed:      field.useComputed      || false,
                    isComputed:       field.isComputed       || false,
                    useAccum:         field.useAccum         || false,
                    isDps:            field.isDps            || false,
                    isOutfitComputed: field.isOutfitComputed || false,
                    isFiringCost:     field.isFiringCost     || false,
                    isShieldHullDps:     field.isShieldHullDps     || false,
                    isShieldHullDpsShip: field.isShieldHullDpsShip || false,
                    isPerDivisor:                field.isPerDivisor                || false,
                    isDpsPerDivisor:             field.isDpsPerDivisor             || false,
                    isOutfitComputedPerDivisor:  field.isOutfitComputedPerDivisor  || false,
                    divisorKey:                  field.divisorKey                 || null,
                    divisorLabel:                field.divisorLabel               || null,
                    displayMultiplier: field.displayMultiplier || 1,
                    dir:              'desc',
                });
            }
        }
    }

    activeSorters = activeSorters.filter(s => sorterPickerPending.includes(s.id));

    closeSorterPicker();
    renderSorterBox();
    await _triggerFilterItems();
}

// show each card's value for the sorted field

function stampSorterValues() {
    const container = document.getElementById('cardsContainer');
    if (!container) return;

    container.querySelectorAll('.sorter-badges').forEach(el => { el.innerHTML = ''; });

    if (activeSorters.length === 0) return;

    const fields = getFieldsForTab(sorterCurrentTab);

    for (const card of container.querySelectorAll('.card')) {
        const itemId = card.dataset.itemId;
        if (!itemId) continue;

        const item = _sorterItems.find(
            i => (i._internalId || i.name || '') == itemId
        );
        if (!item) continue;

        const badgeArea = card.querySelector('.sorter-badges');
        if (!badgeArea) continue;

        for (const sorter of activeSorters) {
            const field = fields.find(f => f.id === sorter.id);
            if (!field) continue;

            const val = getFieldValue(item, field);
            if (val == null) continue;

            const badge = document.createElement('div');
            badge.className = 'sorter-badge';
            badge.innerHTML = `<span class="sorter-badge-label">${field.label}</span>`
                            + `<span class="sorter-badge-value">${formatAvgValue(val)}</span>`;
            badgeArea.appendChild(badge);
        }
    }
}

// the picker list

function renderPickerList(query) {
    const list = document.getElementById('sorterPickerList');
    if (!list) return;

    const fields = getFieldsForTab(sorterCurrentTab);
    const lq     = query.toLowerCase().trim();

    list.innerHTML = '';

    const filtered = lq
        ? fields.filter(f =>
            f.label.toLowerCase().includes(lq) ||
            (f.key && f.key.toLowerCase().includes(lq)))
        : fields;

    if (filtered.length === 0) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color:#94a3b8;font-style:italic;font-size:0.9rem;padding:8px;';
        empty.textContent   = 'No matching fields.';
        list.appendChild(empty);
        return;
    }

    let groups;

    if (sorterCurrentTab === 'ships' || sorterCurrentTab === 'variants') {
        const computed  = filtered.filter(f => f.isComputed || f.useComputed);
        const accum     = filtered.filter(f => (f.useAccum || f.isShieldHullDpsShip) && !f.isComputed && !f.useComputed);
        const hardpoint = filtered.filter(f => f.computed && !f.isComputed && !f.useComputed && !f.useAccum);
        const base      = filtered.filter(f => !f.isComputed && !f.useComputed && !f.computed && !f.useAccum && !f.isShieldHullDpsShip);

        groups = [
            { label: '⚡ Computed — Physics (with outfits)',     fields: computed  },
            { label: '📦 Accumulated Attributes (with outfits)', fields: accum     },
            { label: '🔩 Base Attributes (hull only)',            fields: base      },
            { label: '🎯 Hardpoints',                            fields: hardpoint },
        ];

    } else if (sorterCurrentTab === 'outfits') {
        const outfitAttrs    = filtered.filter(f => f.group === 'outfit');
        const perDivAttr     = filtered.filter(f => f.group === 'outfitPerDiv');
        const perDivWeaponDps   = filtered.filter(f => f.group === 'weaponPerDiv' && (f.isDpsPerDivisor || f.isOutfitComputedPerDivisor));
        const perDivWeaponAttr  = filtered.filter(f => f.group === 'weaponPerDiv' && f.isPerDivisor);
        const weaponPerShot  = filtered.filter(f => f.group === 'weapon' && !f.isDps && !f.isOutfitComputed && !f.isShieldHullDps);
        const weaponDps      = filtered.filter(f => f.group === 'weapon' && f.isDps);
        const weaponComputed = filtered.filter(f => f.group === 'weapon' && (f.isOutfitComputed || f.isShieldHullDps));

        groups = [
            { label: 'Outfit Attributes',                fields: outfitAttrs    },
            { label: '📐 Efficiency (per Outfit Space, Cargo, etc.)', fields: perDivAttr   },
            { label: '⚡ Weapon — Computed Stats',        fields: weaponComputed },
            { label: '💥 Weapon — DPS',                   fields: weaponDps      },
            { label: '🎯 Weapon — Per Shot',              fields: weaponPerShot  },
            { label: '💥📐 Weapon DPS — Efficiency',      fields: perDivWeaponDps  },
            { label: '🔥📐 Weapon Attributes — Efficiency (firing costs, blast radius, etc.)', fields: perDivWeaponAttr },
        ];

    } else {
        groups = [{ label: null, fields: filtered }];
    }

    for (const { label: groupLabel, fields: groupFields } of groups) {
        if (groupFields.length === 0) continue;

        if (groupLabel) {
            const header = document.createElement('div');
            header.style.cssText =
                'color:#63b3ed;font-size:11px;font-weight:700;letter-spacing:.1em;' +
                'text-transform:uppercase;padding:8px 8px 4px;margin-top:4px;' +
                'border-top:1px solid rgba(59,130,246,0.2);';
            header.textContent = groupLabel;
            list.appendChild(header);
        }

        for (const field of groupFields) {
            const row = document.createElement('div');
            row.className = 'sorter-picker-row';

            const checkbox    = document.createElement('input');
            checkbox.type     = 'checkbox';
            checkbox.id       = `sp-${field.id}`;
            checkbox.checked  = sorterPickerPending.includes(field.id);
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    if (!sorterPickerPending.includes(field.id))
                        sorterPickerPending.push(field.id);
                } else {
                    sorterPickerPending = sorterPickerPending.filter(id => id !== field.id);
                }
            };

            const lbl       = document.createElement('label');
            lbl.htmlFor     = `sp-${field.id}`;
            lbl.textContent = field.label;

            row.onclick = e => { if (e.target !== checkbox) checkbox.click(); };
            row.appendChild(checkbox);
            row.appendChild(lbl);
            list.appendChild(row);
        }
    }
}

// tab changed: reset the fields

function onSorterTabChange(tab) {
    sorterCurrentTab = tab;
    activeSorters    = [];
    delete _fieldCache[tab];
    renderSorterBox();
}

// ── globals ──

window.applySorters        = applySorters;
window.setSorterItems      = setSorterItems;
window.setSorterAttrDefs   = setSorterAttrDefs;
window.setSorterPluginId   = setSorterPluginId;
window.renderSorterBox     = renderSorterBox;
window.openSorterPicker    = openSorterPicker;
window.closeSorterPicker   = closeSorterPicker;
window.confirmSorterPicker = confirmSorterPicker;
window.renderPickerList    = renderPickerList;
window.onSorterTabChange   = onSorterTabChange;
window.stampSorterValues   = stampSorterValues;

// The outfit index depends on which plugins are selected.
document.addEventListener('pluginsChanged', () => { _cachedOutfitIndex = null; });


// Close the "Add Sorters" picker with Escape or a click on the dimmed background,
// like every other pop-up on the site.
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const overlay = document.getElementById('sorterPickerOverlay');
    if (overlay && overlay.classList.contains('sorter-overlay-visible')) closeSorterPicker();
});
document.addEventListener('click', e => {
    const overlay = document.getElementById('sorterPickerOverlay');
    if (overlay && e.target === overlay && overlay.classList.contains('sorter-overlay-visible')) closeSorterPicker();
});
