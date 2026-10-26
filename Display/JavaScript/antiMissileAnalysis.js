;(function () {
'use strict';

// Anti-missile: how much of a missile threat a ship's anti-missile stops (game formulas from the definitions).

// ── state ──
let _getOutfitIndex = () => ({});
let _attrDefs       = null;
let _ready          = false;

const FPS = 60;
const MAX_SUBMUNITION_DEPTH = 12;

// anti-missile key in weapon data
const ANTI_MISSILE_KEY_FALLBACK = 'anti-missile';
const MISSILE_STRENGTH_KEY      = 'missile strength';
const VELOCITY_KEY              = 'velocity';
const RELOAD_KEY                = 'reload';
const FIRING_ENERGY_KEY         = 'firing energy';
const FIRING_HEAT_KEY           = 'firing heat';
const FIRING_FUEL_KEY           = 'firing fuel';
const BURST_COUNT_KEY           = 'burst count';
const BURST_RELOAD_KEY          = 'burst reload';

// ── helpers ──

function _antiMissileKey() {
    if (_attrDefs?.attributes?.['anti-missile']) return 'anti-missile';
    return ANTI_MISSILE_KEY_FALLBACK;
}

// firing cost keys
function _firingCostKeys() {
    if (_attrDefs?.outfitDisplay?.valueNames) {
        return _attrDefs.outfitDisplay.valueNames
            .map(v => v.key)
            .filter(k => typeof k === 'string' && k.startsWith('firing '));
    }
    return [FIRING_ENERGY_KEY, FIRING_HEAT_KEY, FIRING_FUEL_KEY,
            'firing hull', 'firing shields'];
}

// remember the outfit index. Called on load

function init(getOutfitIndex, attrDefs) {
    if (typeof getOutfitIndex !== 'function')
        throw new Error('[AntiMissileAnalysis] init: getOutfitIndex must be a function');
    _getOutfitIndex = getOutfitIndex;
    _attrDefs       = attrDefs || null;
    _ready          = true;
    console.log('[AntiMissileAnalysis] Ready.');
}

// ready?
function isReady() { return _ready; }

// how hard a missile is to shoot down (incl. submunitions)

function resolveEffectiveMissileStrength(weapon, _visited, _depth) {
    if (!weapon) return 0;
    const visited = _visited || new Set([weapon._name].filter(Boolean));
    const depth   = _depth   || 0;
    if (depth > MAX_SUBMUNITION_DEPTH) return 0;

    // Own missile strength takes priority
    const own = weapon[MISSILE_STRENGTH_KEY] || 0;
    if (own > 0) return own;

    // Walk submunitions depth-first
    const index = _getOutfitIndex();
    const subRefs = _resolveSubmunitionRefs(weapon);
    for (const { subName } of subRefs) {
        if (!subName || visited.has(subName)) continue;
        const subOutfit = index[subName];
        if (!subOutfit?.weapon) continue;
        const nv = new Set(visited); nv.add(subName);
        const subStr = resolveEffectiveMissileStrength(subOutfit.weapon, nv, depth + 1);
        if (subStr > 0) return subStr;
    }
    return 0;
}

// submunition names and counts
function _resolveSubmunitionRefs(w) {
    const results = [];
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
    for (const key of Object.keys(w)) {
        if (!key.startsWith('submunition ')) continue;
        const subName = key.slice('submunition '.length).trim();
        if (!subName) continue;
        const val = w[key];
        const subCount = Array.isArray(val) ? val.length
                       : typeof val === 'number' ? Math.max(1, val) : 1;
        results.push({ subName, subCount });
    }
    if (results.length > 0) return results;
    const index = _getOutfitIndex();
    for (const key of Object.keys(w)) {
        if (key === 'submunition' || key.startsWith('submunition ')) continue;
        const val = w[key];
        if (val === false || val === 0 || val === null || val === undefined) continue;
        if (typeof val !== 'number' && val !== true) continue;
        const outfit = index[key];
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

// typical missile strengths to compare against

function deriveStrengthBenchmarks() {
    const index  = _getOutfitIndex();
    const found  = new Set();

    for (const outfit of Object.values(index)) {
        if (!outfit?.weapon) continue;
        const ms = resolveEffectiveMissileStrength(outfit.weapon);
        if (ms > 0) found.add(ms);
    }

    // Always include 0 (100% intercept baseline)
    found.add(0);

    // Build sorted array
    const sorted = [...found].sort((a, b) => a - b);
    const max    = sorted[sorted.length - 1] || 100;

    // Fill in intermediate steps so no gap is larger than ~10% of the max range
    // This keeps the table readable without hardcoding any specific values.
    const step     = Math.max(1, Math.round(max / 20));
    const enriched = new Set(sorted);
    for (let v = 0; v <= max + step; v += step) enriched.add(Math.round(v));

    return [...enriched].sort((a, b) => a - b);
}

// one anti-missile weapon

function analyseWeapon(weapon, outfitName) {
    if (!weapon || typeof weapon !== 'object') return null;

    const amKey    = _antiMissileKey();
    const strength = weapon[amKey] || 0;
    if (strength <= 0) return null;

    const reload      = Math.max(1, weapon[RELOAD_KEY]       || 1);
    const burstCount  = Math.max(1, weapon[BURST_COUNT_KEY]  || 1);
    const burstReload = Math.max(1, weapon[BURST_RELOAD_KEY] || reload);

    const framesPerCycle = burstCount > 1
        ? (burstCount - 1) * burstReload + reload
        : reload;
    const shotsPerSecond = (burstCount / framesPerCycle) * FPS;

    const velocity = weapon[VELOCITY_KEY] || 0;
    const lifetime = weapon.lifetime      || 0;
    const range    = velocity * lifetime;

    const costKeys   = _firingCostKeys();
    const firingCosts = {};
    const firingCostsPerSecond = {};
    for (const key of costKeys) {
        const val = weapon[key] || 0;
        if (val !== 0) {
            firingCosts[key]          = val;
            firingCostsPerSecond[key] = +(val * shotsPerSecond).toFixed(4);
        }
    }

    // intercept probability
    const pIntercept = (ms) => calcInterceptChance(strength, ms);

    // Intercept probabilities use real missile strength values from the index
    // rather than hardcoded benchmarks — derive them dynamically
    const benchmarks   = deriveStrengthBenchmarks();
    const interceptVs  = {};
    // Always include a few key relative values regardless of benchmarks
    interceptVs['strength0']  = 1.0;
    interceptVs['strengthEq'] = pIntercept(strength);
    for (const ms of benchmarks) {
        const key = `strength${ms}`;
        if (!(key in interceptVs)) interceptVs[key] = +pIntercept(ms).toFixed(4);
    }

    const notes = [
        `Engages missiles within ~${range > 0 ? range.toFixed(0) : '?'} px.`,
        `Fires every ${reload} frame${reload !== 1 ? 's' : ''} (${shotsPerSecond.toFixed(2)} shots/s sustained).`,
        `P(intercept) = ${strength} / (${strength} + missileStrength)`,
        `vs MS=0:  100.0%  (guaranteed)`,
        `vs MS=${strength}:  50.0%  (even match)`,
        Object.keys(firingCosts).length > 0
            ? `Per-shot costs: ${Object.entries(firingCosts).map(([k, v]) => `${k.replace('firing ', '')} ${v}`).join(', ')}.`
            : `No per-shot resource costs.`,
    ];

    return {
        outfitName: outfitName || weapon._name || '(unknown)',
        isAntiMissile: true,
        strength,
        range,
        reload,
        burstCount,
        burstReload,
        shotsPerSecond: +shotsPerSecond.toFixed(3),
        firingCosts:    Object.keys(firingCosts).length ? firingCosts : null,
        firingCostsPerSecond: Object.keys(firingCostsPerSecond).length ? firingCostsPerSecond : null,
        interceptVs,
        notes,
    };
}

// chance several systems together stop a missile

function combinedInterceptChance(weaponProfiles, missileStrength) {
    if (!weaponProfiles || weaponProfiles.length === 0) return 0;
    const ms = Math.max(0, missileStrength || 0);
    let surviveProbability = 1;
    for (const wp of weaponProfiles) {
        const p = calcInterceptChance(wp.strength, ms);
        surviveProbability *= (1 - p);
    }
    return 1 - surviveProbability;
}

// a whole ship's anti-missile

function analyseShip(resolvedShipStats) {
    const name    = resolvedShipStats?.name || '(unknown)';
    const weapons = resolvedShipStats?.weapons || [];

    const weaponProfiles = [];
    for (const w of weapons) {
        const profile = analyseWeapon(w, w._name);
        if (profile) weaponProfiles.push(profile);
    }

    if (weaponProfiles.length === 0) {
        return {
            shipName:       name,
            hasAntiMissile: false,
            weaponProfiles:    [],
            weaponCount:       0,
            distinctWeapons:   [],
            totalStrength:     0,
            maxStrength:       0,
            totalShotsPerSecond: 0,
            interceptTable:    null,
            totalFiringCostsPerSecond: {},
            combinedInterceptVs: null,
            notes: ['No anti-missile weapons installed.'],
        };
    }

    const distinctMap = {};
    for (const wp of weaponProfiles) {
        const key = wp.outfitName;
        if (!distinctMap[key]) {
            distinctMap[key] = { outfitName: key, count: 0, profile: wp };
        }
        distinctMap[key].count++;
    }
    const distinctWeapons = Object.values(distinctMap);

    const totalStrength      = weaponProfiles.reduce((s, p) => s + p.strength, 0);
    const maxStrength        = Math.max(...weaponProfiles.map(p => p.strength));
    const totalShotsPerSecond = +weaponProfiles.reduce((s, p) => s + p.shotsPerSecond, 0).toFixed(3);

    const totalFiringCostsPerSecond = {};
    for (const wp of weaponProfiles) {
        for (const [key, val] of Object.entries(wp.firingCostsPerSecond || {})) {
            totalFiringCostsPerSecond[key] = +((totalFiringCostsPerSecond[key] || 0) + val).toFixed(4);
        }
    }

    // Derive benchmarks dynamically from the actual outfit index
    const benchmarkStrengths = deriveStrengthBenchmarks();
    const interceptTable     = buildInterceptTable(weaponProfiles, benchmarkStrengths);

    // Combined intercept at all benchmark values
    const combinedInterceptVs = {};
    for (const ms of benchmarkStrengths) {
        combinedInterceptVs[`strength${ms}`] = +combinedInterceptChance(weaponProfiles, ms).toFixed(4);
    }

    const notes = [];
    if (weaponProfiles.length === 1) {
        notes.push(`1 anti-missile weapon: ${weaponProfiles[0].outfitName} (strength ${weaponProfiles[0].strength}).`);
    } else {
        const summary = distinctWeapons.map(d => `${d.count}× ${d.outfitName} (strength ${d.profile.strength})`).join(', ');
        notes.push(`${weaponProfiles.length} anti-missile weapons: ${summary}.`);
        notes.push(`Combined single-frame intercept (all weapons fire simultaneously):`);
        for (const ms of benchmarkStrengths) {
            const p = combinedInterceptVs[`strength${ms}`];
            if (p !== undefined) notes.push(`  vs MS=${ms}: ${(p * 100).toFixed(1)}%`);
        }
    }
    notes.push(`Total anti-missile shots/s: ${totalShotsPerSecond}.`);
    if (Object.keys(totalFiringCostsPerSecond).length > 0) {
        const costStr = Object.entries(totalFiringCostsPerSecond)
            .map(([k, v]) => `${k.replace('firing ', '')} ${v}/s`).join(', ');
        notes.push(`Total AM firing costs at full rate: ${costStr}.`);
    }

    return {
        shipName:       name,
        hasAntiMissile: true,
        weaponProfiles,
        weaponCount:    weaponProfiles.length,
        distinctWeapons,
        totalStrength,
        maxStrength,
        totalShotsPerSecond,
        interceptTable,
        totalFiringCostsPerSecond,
        combinedInterceptVs,
        notes,
    };
}

// intercept chance table

function buildInterceptTable(weaponProfiles, missileStrengths) {
    const strengths = (missileStrengths || []).map(v => Math.max(0, v));

    const perWeapon = weaponProfiles.map(wp => ({
        outfitName:    wp.outfitName,
        strength:      wp.strength,
        probabilities: strengths.map(ms => +calcInterceptChance(wp.strength, ms).toFixed(4)),
    }));

    const combined = strengths.map(ms => +combinedInterceptChance(weaponProfiles, ms).toFixed(4));

    return { missileStrengths: strengths, perWeapon, combined };
}

// chance one shot stops one missile

function calcInterceptChance(antiMissileStrength, missileStrength) {
    const am = Math.max(0, antiMissileStrength || 0);
    const ms = Math.max(0, missileStrength     || 0);
    if (am === 0) return 0;
    if (ms === 0) return 1;
    return am / (am + ms);
}

// profile as text

function formatProfile(profile) {
    if (!profile) return '(null profile)';

    const lines = [
        `╔══ Anti-Missile Profile: ${profile.shipName} ${'═'.repeat(Math.max(0, 38 - profile.shipName.length))}`,
    ];

    if (!profile.hasAntiMissile) {
        lines.push(`║  No anti-missile weapons installed.`);
        lines.push(`╚${'═'.repeat(52)}`);
        return lines.join('\n');
    }

    lines.push(`║  Weapons installed: ${profile.weaponCount}`);
    for (const d of profile.distinctWeapons)
        lines.push(`║    ${d.count}× ${d.outfitName}  (AM strength ${d.profile.strength}, ${d.profile.range.toFixed(0)}px range, reload ${d.profile.reload}f)`);
    lines.push(`║`);

    lines.push(`║  Max single-weapon strength: ${profile.maxStrength}`);
    lines.push(`║  Total shots/s (all weapons): ${profile.totalShotsPerSecond}`);
    if (profile.totalFiringCostsPerSecond && Object.keys(profile.totalFiringCostsPerSecond).length > 0) {
        lines.push(`║  Firing costs/s (all weapons):`);
        for (const [k, v] of Object.entries(profile.totalFiringCostsPerSecond))
            lines.push(`║    ${k}: ${v}`);
    }
    lines.push(`║`);

    if (profile.weaponCount > 1) {
        lines.push(`║  Combined intercept chance (all weapons fire simultaneously):`);
    } else {
        lines.push(`║  Intercept chance:`);
    }

    if (profile.interceptTable) {
        const t = profile.interceptTable;
        const headerParts = t.perWeapon.map(pw => pw.outfitName.slice(0, 14).padEnd(14));
        if (profile.weaponCount > 1) headerParts.push('Combined'.padEnd(10));
        lines.push(`║    ${'MS'.padEnd(6)} ${headerParts.join('  ')}`);
        lines.push(`║    ${'──────'.padEnd(6)} ${headerParts.map(() => '──────────────').join('  ')}`);

        // Print every row — no hardcoded index selection
        for (let idx = 0; idx < t.missileStrengths.length; idx++) {
            const ms   = t.missileStrengths[idx];
            const cols = t.perWeapon.map(pw => `${(pw.probabilities[idx] * 100).toFixed(1)}%`.padEnd(14));
            if (profile.weaponCount > 1) cols.push(`${(t.combined[idx] * 100).toFixed(1)}%`.padEnd(10));
            lines.push(`║    ${String(ms).padEnd(6)} ${cols.join('  ')}`);
        }
    }

    lines.push(`║`);
    for (const note of profile.notes) lines.push(`║  · ${note}`);
    lines.push(`╚${'═'.repeat(52)}`);
    return lines.join('\n');
}

// ── window.AntiMissileAnalysis ──

window.AntiMissileAnalysis = {
    // Lifecycle
    init,
    isReady,

    // Analysis
    analyseWeapon,
    analyseShip,

    // Multi-weapon helpers
    combinedInterceptChance,
    buildInterceptTable,

    // Missile strength resolution
    resolveEffectiveMissileStrength,

    // Dynamic benchmark derivation
    deriveStrengthBenchmarks,

    // Formatting
    formatProfile,

    // Utility
    calcInterceptChance,
};

})();
