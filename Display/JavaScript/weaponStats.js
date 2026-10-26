;(function () {
'use strict';

// Per-weapon and per-ship DPS from weapon data (follows submunitions and ammo). Used by ItemStats and the battle sim.

const FPS = 60;

// submunition refs

// submunition list (all formats)


function _getSubmunitionRefs(w, outfitIndex) {
    const results = [];

    // NEW FORMAT: submunitions: [{type, count}]
    if (Array.isArray(w.submunitions)) {
        for (const entry of w.submunitions) {
            const subName  = entry?.type  ?? null;
            const subCount = entry?.count ?? 1;
            if (subName) results.push({ subName, subCount });
        }
        if (results.length > 0) return results;
    }

    // LEGACY A: w.submunition = string | {name,count} | array
    const rawSub = w.submunition;
    if (rawSub != null) {
        const entries = Array.isArray(rawSub) ? rawSub : [rawSub];
        for (const entry of entries) {
            const subName  = typeof entry === 'string' ? entry
                           : typeof entry === 'object' ? (entry?.name ?? null) : null;
            const subCount = typeof entry === 'object' && entry !== null
                           ? (entry.count ?? 1) : 1;
            if (subName) results.push({ subName, subCount });
        }
        if (results.length > 0) return results;
    }

    // LEGACY A2: "submunition OutfitName" prefixed keys
    for (const key of Object.keys(w)) {
        if (!key.startsWith('submunition ')) continue;
        const subName  = key.slice('submunition '.length).trim();
        if (!subName) continue;
        const val      = w[key];
        const subCount = Array.isArray(val) ? val.length
                       : typeof val === 'number' ? Math.max(1, val) : 1;
        results.push({ subName, subCount });
    }
    if (results.length > 0) return results;

    // LEGACY B: outfit name as key with numeric count
    for (const key of Object.keys(w)) {
        if (key === 'submunition' || key === 'submunitions') continue;
        if (key.startsWith('submunition ')) continue;
        const val = w[key];
        if (val === false || val === 0 || val === null || val === undefined) continue;
        if (typeof val !== 'number' && val !== true) continue;
        const outfit = outfitIndex[key];
        if (!outfit?.weapon) continue;
        const isAmmo =
            (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0)
         || outfit.category === 'Ammunition'
         || (typeof outfit.attributes?.[key] === 'number' && outfit.attributes[key] > 0);
        if (isAmmo) continue;
        results.push({ subName: key, subCount: val === true ? 1 : Math.max(1, Math.round(val)) });
    }

    return results;
}

// which ammo a weapon uses
function _resolveAmmoRef(w, outfitIndex) {
    // NEW FORMAT: ammunition: [{type, count}]
    if (Array.isArray(w.ammunition) && w.ammunition.length > 0) {
        const first = w.ammunition[0];
        if (first?.type) return { ammoName: first.type, ammoCount: first.count ?? 1 };
    }

    // LEGACY A: w.ammo = "OutfitName"
    const rawAmmoField = w['ammo'];
    if (typeof rawAmmoField === 'string' && rawAmmoField.length > 0)
        return { ammoName: rawAmmoField, ammoCount: 1 };

    // LEGACY B: outfit name as key
    for (const key of Object.keys(w)) {
        if (key === 'ammo' || key === 'ammunition') continue;
        const val = w[key];
        if (val === false || val === 0 || val === null || val === undefined) continue;
        if (typeof val !== 'number' && val !== true) continue;
        const outfit = outfitIndex[key];
        if (!outfit) continue;
        const isAmmo =
            outfit.category === 'Ammunition' ||
            (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0) ||
            (typeof outfit.attributes?.[key] === 'number' && outfit.attributes[key] > 0) ||
            Object.entries(outfit.attributes || {}).some(([k, v]) =>
                k.endsWith(' capacity') && typeof v === 'number' && v < 0);
        if (!isAmmo) continue;
        return { ammoName: key, ammoCount: val === true ? 1 : Math.max(1, Math.round(val)) };
    }

    return null;
}

// damage incl. submunitions
function _resolveSubmunitionDamage(weapon, outfitIndex, visited, depth) {
    visited = visited || new Set();
    depth   = depth   || 0;

    const totals = {};
    if (!weapon || depth > 8) return totals;

    // Own damage keys at this node
    for (const [key, val] of Object.entries(weapon)) {
        if (typeof val !== 'number') continue;
        if (!key.endsWith(' damage'))  continue;
        if (val === 0)                 continue;
        totals[key] = (totals[key] || 0) + val;
    }

    // Recurse into submunitions
    for (const { subName, subCount } of _getSubmunitionRefs(weapon, outfitIndex)) {
        if (visited.has(subName)) continue;
        const subOutfit = outfitIndex[subName];
        if (!subOutfit?.weapon) continue;
        const nv = new Set(visited);
        nv.add(subName);
        const childTotals = _resolveSubmunitionDamage(subOutfit.weapon, outfitIndex, nv, depth + 1);
        for (const [key, val] of Object.entries(childTotals))
            totals[key] = (totals[key] || 0) + val * subCount;
    }

    return totals;
}

// range incl. submunitions
function _resolveEffectiveRange(w, outfitIndex, visited, depth, inheritedVelocity) {
    if (depth > 8) return null;
    // Use own velocity if set, otherwise inherit from parent
    const vel      = (w.velocity || 0) > 0 ? (w.velocity || 0) : (inheritedVelocity || 0);
    const ownRange = vel * (w.lifetime || 0);
    const subs     = _getSubmunitionRefs(w, outfitIndex);
    if (!subs.length) return ownRange > 0 ? ownRange : null;
    let maxSubRange = 0, anySubHasRange = false;
    for (const { subName } of subs) {
        if (visited && visited.has(subName)) continue;
        const subOutfit = outfitIndex[subName];
        if (!subOutfit?.weapon) continue;
        const nv = new Set(visited || []); nv.add(subName);
        const subRange = _resolveEffectiveRange(subOutfit.weapon, outfitIndex, nv, depth + 1, vel);
        if (subRange !== null) { anySubHasRange = true; if (subRange > maxSubRange) maxSubRange = subRange; }
    }
    const total = ownRange + maxSubRange;
    return (total > 0 || anySubHasRange) ? total : null;
}

// shots per second (reload, burst, …)

function _resolveShotsPerSecond(weapon) {
    /*const reload      = Math.max(1, weapon.reload       || 1);
    const burstCount  = Math.max(1, weapon['burst count']  || 1);
    const burstReload = Math.max(1, weapon['burst reload'] || reload);
    const framesPerCycle = burstCount > 1
        ? (burstCount - 1) * burstReload + reload
        : reload;
    return (burstCount / framesPerCycle) * FPS;*/
    const hasRefireRate = weapon.reload != null || weapon['burst reload'] != null;
    if (!hasRefireRate) return 1;
    const reload = Math.max(1, weapon.reload ?? weapon['burst reload'] ?? 1);
    return FPS / reload;
}

// one weapon's numbers. Called by: getOutfitWeaponStats, getShipWeaponStats

function _calcWeaponProfile(weapon, outfitName, outfitIndex) {
    const w          = weapon;
    const visited    = new Set([outfitName].filter(Boolean));
    const sps        = _resolveShotsPerSecond(w);
    const ammoRef    = _resolveAmmoRef(w, outfitIndex);
    const dmgPerShot = _resolveSubmunitionDamage(w, outfitIndex, visited, 0);
    const range      = _resolveEffectiveRange(w, outfitIndex, new Set([outfitName].filter(Boolean)), 0, 0);

    // firing costs: any key starting with "firing "
    const attrDefs = window.attrDefs?.attributes || null;
    const firingCosts = {};
    for (const [key, val] of Object.entries(w)) {
        if (!key.startsWith('firing ')) continue;
        if (typeof val !== 'number' || !val) continue;
        if (attrDefs && attrDefs[key] && !attrDefs[key].isWeaponStat) continue;
        firingCosts[key] = val;
    }

    // each damage type's own display multiplier from the definitions
    const dpsBreakdown = {};
    let totalDps = 0;
    for (const [key, val] of Object.entries(dmgPerShot)) {
        const mult = attrDefs?.[key]?.displayMultiplier ?? 1;
        const dps  = val * sps * mult;
        dpsBreakdown[key] = dps;
        totalDps += dps;
    }

    return {
        outfitName,
        isAntiMissile:   (w['anti-missile'] || 0) > 0,
        isHoming:        !!(w.homing),
        hasAmmo:         ammoRef !== null,
        ammoOutfitName:  ammoRef?.ammoName  ?? null,
        ammoPerShot:     ammoRef?.ammoCount ?? 1,
        firingCosts:     Object.keys(firingCosts).length ? firingCosts : null,
        shotsPerSecond:  +sps.toFixed(4),
        effectiveRange:  range != null ? +range.toFixed(1) : 0,
        hasSubmunitions: _getSubmunitionRefs(w, outfitIndex).length > 0,
        damagePerShot:   dmgPerShot,
        dpsBreakdown,
        totalDps:        +totalDps.toFixed(4),
        shieldDps:       +(dpsBreakdown['shield damage'] || 0).toFixed(4),
        hullDps:         +(dpsBreakdown['hull damage']   || 0).toFixed(4),
    };
}

// one outfit's weapon stats

function getOutfitWeaponStats(outfit, outfitIndex) {
    if (!outfit?.weapon) return null;
    const profile = _calcWeaponProfile(outfit.weapon, outfit.name, outfitIndex || {});
    if (profile.isAntiMissile)
        profile.antiMissileStrength = outfit.weapon['anti-missile'] || 0;
    return profile;
}

// a ship's total DPS and each weapon's

function getShipWeaponStats(ship, outfitIndex) {
    const idx       = outfitIndex || {};
    const outfitMap = ship.outfits || ship.outfitMap || {};
    const weapons   = [];
    const dpsByType = {};
    const ammoMap   = {};

    for (const [outfitName, qtyVal] of Object.entries(outfitMap)) {
        const count  = typeof qtyVal === 'object'
            ? (parseInt(qtyVal.count) || 1)
            : (Number(qtyVal) || 1);

        const outfit = idx[outfitName];
        if (!outfit?.weapon) continue;

        const profile      = _calcWeaponProfile(outfit.weapon, outfitName, idx);
        const scaledByType = {};

        for (const [key, val] of Object.entries(profile.dpsBreakdown)) {
            scaledByType[key] = val * count;
            dpsByType[key]    = (dpsByType[key] || 0) + val * count;
        }

        weapons.push({
            outfitName,
            count,
            profile,
            scaledDps:  +(profile.totalDps * count).toFixed(4),
            scaledByType,
        });

        if (profile.hasAmmo && profile.ammoOutfitName) {
            const aName = profile.ammoOutfitName;
            if (!ammoMap[aName]) {
                ammoMap[aName] = {
                    ammoOutfitName:      aName,
                    ammoOutfit:          idx[aName] || null,
                    perShot:             profile.ammoPerShot,
                    totalShotsPerSecond: 0,
                };
            }
            ammoMap[aName].totalShotsPerSecond += profile.shotsPerSecond * count;
        }
    }

    weapons.sort((a, b) => b.scaledDps - a.scaledDps);

    const totalDps  = weapons.reduce((s, w) => s + w.scaledDps, 0);
    const shieldDps = dpsByType['shield damage'] || 0;
    const hullDps   = dpsByType['hull damage']   || 0;

    const roundObj = obj => {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = +v.toFixed(4);
        return out;
    };

    return {
        weapons,
        totalDps:          +totalDps.toFixed(4),
        shieldDps:         +shieldDps.toFixed(4),
        hullDps:           +hullDps.toFixed(4),
        dpsByType:         roundObj(dpsByType),
        weaponCount:       weapons.length,
        totalWeaponMounts: weapons.reduce((s, w) => s + w.count, 0),
        hasAmmoWeapons:    Object.keys(ammoMap).length > 0,
        ammoRequired:      Object.values(ammoMap).map(a => ({
            ...a,
            totalShotsPerSecond: +a.totalShotsPerSecond.toFixed(4),
        })),
    };
}

// resolve an outfit name to weapon stats

function resolveWeaponStats(outfitMap, outfitIndex) {
    const stats = getShipWeaponStats({ outfits: outfitMap }, outfitIndex || {});
    const flat  = {};

    flat['_ws_totalDps']          = stats.totalDps;
    flat['_ws_shieldDps']         = stats.shieldDps;
    flat['_ws_hullDps']           = stats.hullDps;
    flat['_ws_weaponCount']       = stats.weaponCount;
    flat['_ws_totalWeaponMounts'] = stats.totalWeaponMounts;
    flat['_ws_hasAmmoWeapons']    = stats.hasAmmoWeapons ? 1 : 0;

    for (const [key, val] of Object.entries(stats.dpsByType))
        flat[`_ws_dps_${key.replace(/\s+/g, '_')}`] = val;

    flat['_weaponStats'] = stats;
    return flat;
}

// ── window.WeaponStats ──

const WeaponStats = {
    getOutfitWeaponStats,
    getShipWeaponStats,
    resolveWeaponStats,
    // Internals for testing
    _calcWeaponProfile,
    _getSubmunitionRefs,
    _resolveAmmoRef,
    _resolveShotsPerSecond,
    _resolveSubmunitionDamage,
};

if (typeof window !== 'undefined') window.WeaponStats = WeaponStats;
if (typeof module !== 'undefined' && module.exports) module.exports = WeaponStats;

})();
