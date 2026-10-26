;(function () {
'use strict';

// Weapon profiles: anti-missile, tracking, missile strength, ammo and submunition chains. Used by the Data Viewer and battle sim.

// ── state ──
let _getOutfitIndex = () => ({});
let _attrDefs       = null;
let _ready          = false;

// ── weapon keys (fallbacks; the parser's list is used when loaded) ──

// Tracking / guidance keys present in the weapon block
const TRACKING_KEYS_FALLBACK = [
    'homing',             // integer 0-4+; general homing level
    'tracking',           // generic tracking score (0–1 fraction)
    'optical tracking',   // tracks heat/visual signatures
    'infrared tracking',  // tracks engine heat
    'radar tracking',     // tracks radar cross-section; jammed by scrambling
];

// Anti-missile intercept key
const ANTI_MISSILE_KEY = 'anti-missile';

// Missile strength key (projectile side of interception)
const MISSILE_STRENGTH_KEY = 'missile strength';

// Ammo consumption key in the weapon block
// Ammo detection uses dual-format scan — see _buildAmmoProfile

// Firing-cost keys that represent consumable expenditure (not outfit attributes)
const FIRING_COST_KEYS_FALLBACK = [
    'firing energy',
    'firing heat',
    'firing fuel',
    'firing hull',
    'firing shields',
];

// Firing status-injection keys (carried on the shooter, not the target)
const FIRING_STATUS_KEYS_FALLBACK = [
    'firing ion',
    'firing scramble',
    'firing disruption',
    'firing discharge',
    'firing corrosion',
    'firing leak',
    'firing burn',
    'firing slowing',
];

// with the definitions loaded these come from the game's weapon code
const _gk = () => window.GameKeys || null;
// tracking keys
function trackingKeys()     { return _gk() ? _gk().trackingKeys(TRACKING_KEYS_FALLBACK) : TRACKING_KEYS_FALLBACK; }
// firing cost keys
function firingCostKeys()   { return _gk() ? _gk().firingCostKeys(FIRING_COST_KEYS_FALLBACK) : FIRING_COST_KEYS_FALLBACK; }
// firing status keys
function firingStatusKeys() { return _gk() ? _gk().firingStatusKeys(FIRING_STATUS_KEYS_FALLBACK) : FIRING_STATUS_KEYS_FALLBACK; }

// Submunition structural keys
const SUBMUNITION_KEYS = ['submunition', 'cluster', 'stream'];

// ── start ──

// remember the outfit index and definitions. Called on load
function init(getOutfitIndex, attrDefs) {
    if (typeof getOutfitIndex !== 'function')
        throw new Error('[MunitionTypes] init: getOutfitIndex must be a function');
    _getOutfitIndex = getOutfitIndex;
    _attrDefs       = attrDefs || null;
    _ready          = true;
    console.log('[MunitionTypes] Ready.');
}

// are the definitions loaded?
function isReady() { return _ready; }

// ── analysing one weapon ──

// everything about one weapon → a profile. Called by: analyseOutfit, buildRegistry
function analyseWeapon(weapon, outfitName) {
    if (!weapon || typeof weapon !== 'object')
        return null;

    const w = weapon;
    const name = outfitName || w._name || '(unknown)';

    // anti-missile
    const amStr   = w[ANTI_MISSILE_KEY] || 0;
    const antiMissile = _buildAntiMissileProfile(amStr);

    // tracking
    const tracking = _buildTrackingProfile(w);

    // missile strength
    const missileStrength = _buildMissileStrengthProfile(w);

    // ammo
    const ammo = _buildAmmoProfile(w, name);

    // submunitions
    const submunitions = _buildSubmunitionProfile(w, name);

    // timing
    const reload      = Math.max(1, w.reload      || 1);
    const burstCount  = Math.max(1, w['burst count']  || 1);
    const burstReload = Math.max(1, w['burst reload'] || reload);
    const framesPerCycle = burstCount > 1
        ? (burstCount - 1) * burstReload + reload
        : reload;
    const shotsPerSecond = (burstCount / framesPerCycle) * 60; // FPS = 60

    // range
    const velocity   = w.velocity   || 0;
    const lifetime   = w.lifetime   || 0;
    const effectiveRange = velocity * lifetime;

    // tags
    const tags = _buildTags(w, antiMissile, tracking, missileStrength, submunitions, burstCount, ammo);

    return {
        outfitName:    name,
        isWeapon:      true,
        antiMissile,
        tracking,
        missileStrength,
        ammo,
        submunitions,
        timing: {
            reload, burstCount, burstReload,
            shotsPerSecond: +shotsPerSecond.toFixed(3),
            burstDuration:  burstCount > 1 ? (burstCount - 1) * burstReload : 0,
        },
        range: {
            velocity,
            lifetime,
            effectiveRange,
            safeRange:     w['safe range']     || 0,
            blastRadius:   w['blast radius']   || 0,
            triggerRadius: w['trigger radius'] || 0,
            splitRange:    w['split range']    || 0,
        },
        tags,
    };
}

// anti-missile strength and costs
function _buildAntiMissileProfile(amStr) {
    const isAntiMissile = amStr > 0;
    const notes = [];
    if (isAntiMissile) {
        notes.push(
            `Intercept formula: P = antiMissile / (antiMissile + missileStrength)`,
            `vs missile strength 0: P = 1.0 (guaranteed)`,
            `vs missile strength ${amStr}: P = 0.50 (even match)`,
            `vs missile strength ${amStr * 3}: P = ${(amStr / (amStr + amStr * 3)).toFixed(2)}`,
            `Anti-missile weapons fire reactively each frame at missiles in range — ` +
            `they do NOT go through the normal weapon reload loop.`,
        );
    }
    return {
        isAntiMissile,
        strength:        amStr,
        interceptChance: isAntiMissile ? 1.0 : 0,  // vs strength-0 missile
        notes,
    };
}

// tracking: radar, optical, infrared, generic
const HOMING_LEVEL_NAMES = [
    'Unguided',
    'Partial (straight-line intercept)',
    'Seeking (steers toward target)',
    'Infrared-seeking (tracks engine heat)',
    'Radar-seeking (disrupted by scrambling)',
];

// tracking profile
function _buildTrackingProfile(w) {
    const homingLevel = Math.floor(w.homing || 0);
    const isHoming    = homingLevel > 0;

    const breakdown = [];
    let bestScore = 0;

    for (const key of trackingKeys()) {
        if (key === 'homing') continue;   // integer level, not a 0-1 score
        const val = w[key] || 0;
        if (val > 0) {
            breakdown.push({ key, value: val, contribution: val });
            if (val > bestScore) bestScore = val;
        }
    }

    // 'tracking' is the generic share; the others are sensor types
    const trackingScore = bestScore;

    return {
        isHoming,
        homingLevel,
        homingDescription: HOMING_LEVEL_NAMES[Math.min(homingLevel, HOMING_LEVEL_NAMES.length - 1)]
                         || `Level ${homingLevel}`,
        trackingScore:     +trackingScore.toFixed(4),
        trackingBreakdown: breakdown,
        turningRate:   w.turn         || 0,
        acceleration:  w.acceleration || 0,
        drag:          w.drag         || 0,
        notes: isHoming ? [
            `'turn' (${w.turn || 0} deg/frame) governs how sharply the missile steers.`,
            `Tracking score ${(trackingScore * 100).toFixed(1)}% = fraction of frames the ` +
            `missile actively homes. At 1.0 it homes every frame.`,
            breakdown.length > 1
                ? `Multiple sensor types present; game uses the best applicable type for the target.`
                : '',
        ].filter(Boolean) : [],
    };
}

// missile strength (how hard to shoot down)
function _buildMissileStrengthProfile(w) {
    const value = w[MISSILE_STRENGTH_KEY] || 0;
    const notes = [];

    if (value > 0) {
        notes.push(
            `Requires AM strength > ${value} for >50% intercept chance.`,
            `P(survive single AM shot) = missileStrength / (AM + missileStrength)`,
            `Example: vs AM-20 this missile has ${(value / (20 + value) * 100).toFixed(1)}% survival.`,
            `Example: vs AM-${value} this missile has 50.0% survival (even match).`,
        );
    } else {
        notes.push(
            value === 0 && (w.homing || 0) > 0
                ? `Homing missile with strength 0 — any AM weapon guarantees interception.`
                : `Non-missile projectile (missile strength 0, not homing) — ` +
                  `anti-missile weapons do not normally target this.`,
        );
    }

    return { value, notes };
}

// ammo used, carried and costs
function _buildAmmoProfile(w, outfitName) {
    const index = _getOutfitIndex();

    let ammoOutfitName    = null;
    let ammoPerShot       = 1;
    let ammoOutfitDetails = null;
    let storageCapacityKey = null;

    // new format: [{ type, count }]
    if (Array.isArray(w.ammunition) && w.ammunition.length > 0) {
        const first    = w.ammunition[0];
        ammoOutfitName = first?.type  ?? null;
        ammoPerShot    = first?.count ?? 1;
        if (ammoOutfitName)
            ammoOutfitDetails = index[ammoOutfitName] || null;
    }

    // old format A: weapon.ammo = name
    if (!ammoOutfitName) {
        const rawAmmoField = w['ammo'];
        if (typeof rawAmmoField === 'string' && rawAmmoField.length > 0) {
            ammoOutfitName    = rawAmmoField;
            ammoPerShot       = 1;
            ammoOutfitDetails = index[ammoOutfitName] || null;
        }
    }

    // old format B: outfit name as key
    if (!ammoOutfitName) {
        for (const key of Object.keys(w)) {
            if (key === 'ammo' || key === 'ammunition') continue;
            const val = w[key];
            if (val === false || val === 0 || val === null || val === undefined) continue;
            if (typeof val !== 'number' && val !== true) continue;

            const candidate = index[key];
            if (!candidate) continue;

            const isAmmo =
                candidate.category === 'Ammunition' ||
                (typeof candidate.ammoStored === 'number' && candidate.ammoStored > 0) ||
                (typeof candidate.attributes?.[key] === 'number' && candidate.attributes[key] > 0) ||
                (() => {
                    const entries = Object.entries(candidate.attributes || {});
                    return entries.some(([k, v]) => k.endsWith(' capacity') && typeof v === 'number' && v < 0) ||
                           Object.keys(candidate).some(k =>
                               !['name','category','cost','mass','thumbnail','description',
                                 'weapon','attributes','_pluginId','series','index'].includes(k) &&
                               k.endsWith(' capacity') && typeof candidate[k] === 'number' && candidate[k] < 0
                           );
                })();
            if (!isAmmo) continue;

            ammoOutfitName    = key;
            ammoPerShot       = val === true ? 1 : Math.max(1, Math.round(val));
            ammoOutfitDetails = candidate;
            break;
        }
    }

    // Resolve storage details
    if (ammoOutfitName && !ammoOutfitDetails)
        ammoOutfitDetails = index[ammoOutfitName] || null;

    if (ammoOutfitDetails) {
        if (typeof ammoOutfitDetails.ammoStored === 'number' && ammoOutfitDetails.ammoStored > 0)
            storageCapacityKey = 'ammoStored';
        else if (ammoOutfitDetails.attributes?.[ammoOutfitName] > 0)
            storageCapacityKey = ammoOutfitName;
        else
            storageCapacityKey = ammoOutfitName;
    }

    const hasAmmo = ammoOutfitName !== null;

    const firingCosts = {};
    for (const key of firingCostKeys()) {
        const val = w[key] || 0;
        if (val) firingCosts[key] = val;
    }

    const firingStatusInj = {};
    for (const key of firingStatusKeys()) {
        const val = w[key] || 0;
        if (val) firingStatusInj[key] = val;
    }

    return {
        hasAmmo,
        ammoOutfitName,
        ammoStorageKey:  storageCapacityKey,
        ammoPerShot,
        firingCosts:     Object.keys(firingCosts).length     ? firingCosts     : null,
        firingStatusInj: Object.keys(firingStatusInj).length ? firingStatusInj : null,
        ammoOutfitDetails,
        storageCapacityKey,
        notes: _buildAmmoNotes(hasAmmo, ammoOutfitName, ammoPerShot, firingCosts, ammoOutfitDetails),
    };
}

// ammo notes
function _buildAmmoNotes(hasAmmo, ammoOutfitName, ammoPerShot, firingCosts, ammoOutfitDetails) {
    const notes = [];
    if (hasAmmo) {
        notes.push(`Consumes ${ammoPerShot} × "${ammoOutfitName}" per shot.`);
        if (ammoOutfitDetails) {
            const stored = ammoOutfitDetails.ammoStored;
            if (typeof stored === 'number' && stored > 0)
                notes.push(`Each "${ammoOutfitName}" outfit unit provides ${stored} rounds of storage.`);
            const cat = ammoOutfitDetails.category;
            if (cat) notes.push(`Ammo category: ${cat}.`);
        } else {
            notes.push(`Ammo outfit "${ammoOutfitName}" not found in current outfit index — may be from a different plugin.`);
        }
    } else {
        notes.push(`No ammo requirement — fires indefinitely as long as firing costs are met.`);
    }
    const costSummary = Object.entries(firingCosts || {})
        .map(([k, v]) => `${k.replace('firing ', '')}: ${v}`)
        .join(', ');
    if (costSummary) notes.push(`Per-shot resource costs: ${costSummary}.`);
    return notes;
}

// submunitions, all the way down

const MAX_SUBMUNITION_DEPTH = 12;

// submunition names and counts (all formats)
function _resolveSubmunitionRefs(w) {
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
            const subCount = typeof entry === 'object' && entry !== null
                           ? (entry.count ?? 1) : 1;
            if (subName) results.push({ subName, subCount });
        }
        if (results.length > 0) return results;
    }

    // old format A2: "submunition Name"
    for (const key of Object.keys(w)) {
        if (!key.startsWith('submunition ')) continue;
        const subName = key.slice('submunition '.length).trim();
        if (!subName) continue;
        const val = w[key];
        const subCount = Array.isArray(val) ? val.length
                       : typeof val === 'number' ? Math.max(1, val)
                       : 1;
        results.push({ subName, subCount });
    }
    if (results.length > 0) return results;

    // old format B: outfit name as key
    const index = _getOutfitIndex();
    for (const key of Object.keys(w)) {
        if (key === 'submunition' || key === 'submunitions') continue;
        if (key.startsWith('submunition ')) continue;
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

        const subCount = val === true ? 1 : Math.max(1, Math.round(val));
        results.push({ subName: key, subCount });
    }

    return results;
}

// submunition tree
function resolveSubmunitionTree(weapon, rootName, _visited, _depth, _multiplier) {
    const visited    = _visited    || new Set([rootName].filter(Boolean));
    const depth      = _depth      || 0;
    const multiplier = _multiplier || 1;

    if (!weapon || depth > MAX_SUBMUNITION_DEPTH) return null;

    const subRefs = _resolveSubmunitionRefs(weapon);
    if (!subRefs.length) return { name: rootName, count: 1, depth, weapon, children: [], leaf: true, multiplier };

    const children = [];

    for (const { subName, subCount: subCount } of subRefs) {

        if (!subName) continue;
        if (visited.has(subName)) {
            children.push({ name: subName, count: subCount, depth: depth + 1,
                            weapon: null, children: [], cycleRef: true, multiplier: multiplier * subCount });
            continue;
        }

        const nv = new Set(visited);
        nv.add(subName);

        const index    = _getOutfitIndex();
        const subOutfit = index[subName] || null;
        const subWeapon = subOutfit?.weapon || null;

        const child = resolveSubmunitionTree(
            subWeapon, subName, nv, depth + 1, multiplier * subCount
        );

        children.push({
            ...(child || {}),
            name:   subName,
            count:  subCount,
            depth:  depth + 1,
            weapon: subWeapon,
            outfit: subOutfit,
            multiplier: multiplier * subCount,
        });
    }

    return {
        name:     rootName,
        count:    1,
        depth,
        weapon,
        children,
        leaf:     children.length === 0,
        multiplier,
    };
}

// tree → list
function _flattenTree(node, out) {
    if (!node) return;
    out.push(node);
    for (const child of (node.children || [])) _flattenTree(child, out);
}

// submunition profile
function _buildSubmunitionProfile(w, outfitName) {
    const isCluster = !!(w.cluster);
    const isStream  = !!(w.stream);
    const hasSubmunitions = _resolveSubmunitionRefs(w).length > 0;

    if (!hasSubmunitions) {
        return {
            hasSubmunitions: false,
            isCluster, isStream,
            tree: null,
            totalDamageTypes: [],
            maxDepth:  0,
            leafCount: 0,
        };
    }

    const tree = resolveSubmunitionTree(w, outfitName);

    // Collect all damage types across every node
    const allDmgTypes = new Set();
    const nodes       = [];
    _flattenTree(tree, nodes);

    let maxDepth  = 0;
    let leafCount = 0;

    for (const node of nodes) {
        if (node.depth > maxDepth) maxDepth = node.depth;
        if (node.leaf || (!node.children || node.children.length === 0)) leafCount += node.count || 1;
        const nw = node.weapon;
        if (!nw) continue;
        // Collect damage type keys (Shield damage, Hull damage, etc.)
        for (const key of Object.keys(nw)) {
            const lower = key.toLowerCase();
            if (lower.endsWith(' damage') && !lower.startsWith('%')) {
                const typeName = key.replace(/ damage$/i, '');
                allDmgTypes.add(typeName);
            }
        }
    }

    return {
        hasSubmunitions: true,
        isCluster,
        isStream,
        tree,
        totalDamageTypes: [...allDmgTypes].sort(),
        maxDepth,
        leafCount,
        notes: _buildSubmunitionNotes(isCluster, isStream, maxDepth, leafCount, tree),
    };
}

// submunition notes
function _buildSubmunitionNotes(isCluster, isStream, maxDepth, leafCount, tree) {
    const notes = [];
    if (isCluster) notes.push(`CLUSTER: all submunitions release simultaneously in a spread.`);
    if (isStream)  notes.push(`STREAM: submunitions released one per frame over the lifetime.`);
    if (maxDepth > 1) notes.push(`Multi-stage payload: ${maxDepth} level(s) of nesting.`);
    if (leafCount > 1) notes.push(`Total end-stage projectiles per shot: ${leafCount}.`);
    return notes;
}

// short tags (anti-missile, homing, …)
function _buildTags(w, antiMissile, tracking, missileStrength, submunitions, burstCount, ammo) {
    const tags = [];
    if (antiMissile.isAntiMissile)        tags.push('anti-missile');
    if (tracking.isHoming)                tags.push('homing');
    if (tracking.homingLevel >= 3)        tags.push('infrared-tracking');
    if (tracking.homingLevel >= 4)        tags.push('radar-tracking');
    if (missileStrength.value > 0)        tags.push('missile');
    if (submunitions.hasSubmunitions)     tags.push('submunition');
    if (submunitions.isCluster)           tags.push('cluster');
    if (submunitions.isStream)            tags.push('stream');
    if (burstCount > 1)                   tags.push('burst');
    if (w['blast radius'] > 0)            tags.push('aoe');
    if ((w.piercing || 0) > 0)            tags.push('piercing');
    if (w['safe range'] > 0)             tags.push('safe-range');
    if ((w['trigger radius'] || 0) > 0)  tags.push('proximity-fused');
    if (ammo && ammo.hasAmmo)              tags.push('ammo');
    return tags;
}

// ── shortcuts ──

// profile for an outfit (null if not a weapon)
function analyseOutfit(outfit) {
    if (!outfit?.weapon) return null;
    return analyseWeapon(outfit.weapon, outfit.name);
}

// the ammo supply chain for an outfit
function getAmmoTree(outfitName) {
    const index  = _getOutfitIndex();
    const outfit = index[outfitName];
    if (!outfit?.weapon) return null;

    const profile = analyseWeapon(outfit.weapon, outfitName);
    const ammo    = profile.ammo;

    let roundsPerStorageUnit = null;
    if (ammo.ammoOutfitDetails) {
        const stored = ammo.ammoOutfitDetails.ammoStored;
        if (typeof stored === 'number') roundsPerStorageUnit = stored;
        else {
            // Try reading from the outfit's own attribute (compiled form)
            const attrVal = ammo.ammoOutfitDetails[ammo.ammoOutfitName];
            if (typeof attrVal === 'number') roundsPerStorageUnit = attrVal;
        }
    }

    return {
        outfitName,
        weaponProfile:        profile,
        ammoOutfitName:       ammo.ammoOutfitName,
        ammoOutfit:           ammo.ammoOutfitDetails,
        ammoPerShot:          ammo.ammoPerShot,
        storageCapacityKey:   ammo.storageCapacityKey,
        roundsPerStorageUnit,
    };
}

// profiles for every weapon. Called by: whoever needs them all
function buildRegistry() {
    const index  = _getOutfitIndex();
    const all    = [];
    const ammoOutfits = [];

    for (const [name, outfit] of Object.entries(index)) {
        if (!outfit) continue;
        if (outfit.weapon) {
            const profile = analyseWeapon(outfit.weapon, name);
            if (profile) all.push(profile);
        } else if (outfit.category === 'Ammunition' ||
                   (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0)) {
            ammoOutfits.push(outfit);
        }
    }

    const antiMissileWeapons   = all.filter(p => p.antiMissile.isAntiMissile)
        .sort((a, b) => b.antiMissile.strength - a.antiMissile.strength);

    const homingWeapons        = all.filter(p => p.tracking.isHoming)
        .sort((a, b) => b.tracking.trackingScore - a.tracking.trackingScore
                     || b.tracking.homingLevel   - a.tracking.homingLevel);

    const missilesWithStrength = all.filter(p => p.missileStrength.value > 0)
        .sort((a, b) => b.missileStrength.value - a.missileStrength.value);

    const ammoWeapons          = all.filter(p => p.ammo.hasAmmo);
    const freeWeapons          = all.filter(p => !p.ammo.hasAmmo);
    const submunitionWeapons   = all.filter(p => p.submunitions.hasSubmunitions)
        .sort((a, b) => b.submunitions.leafCount - a.submunitions.leafCount);

    const burstWeapons         = all.filter(p => p.timing.burstCount > 1)
        .sort((a, b) => b.timing.burstCount - a.timing.burstCount);

    return {
        antiMissileWeapons,
        homingWeapons,
        missilesWithStrength,
        ammoWeapons,
        freeWeapons,
        submunitionWeapons,
        burstWeapons,
        allWeapons:   all,
        ammoOutfits,
        summary: {
            total:                all.length,
            antiMissile:          antiMissileWeapons.length,
            homing:               homingWeapons.length,
            withMissileStrength:  missilesWithStrength.length,
            withAmmo:             ammoWeapons.length,
            withSubmunitions:     submunitionWeapons.length,
            withBurst:            burstWeapons.length,
        },
    };
}

// profile as text

function formatProfile(profile) {
    if (!profile) return '(null profile)';

    const lines = [
        `╔══ ${profile.outfitName} ${'═'.repeat(Math.max(0, 48 - profile.outfitName.length))}`,
        `║  Tags: ${profile.tags.join(', ') || 'none'}`,
        `║`,
    ];

    // Anti-missile
    if (profile.antiMissile.isAntiMissile) {
        lines.push(`║  ANTI-MISSILE`);
        lines.push(`║    Strength: ${profile.antiMissile.strength}`);
        for (const n of profile.antiMissile.notes) lines.push(`║    · ${n}`);
        lines.push(`║`);
    }

    // Tracking
    if (profile.tracking.isHoming) {
        lines.push(`║  TRACKING`);
        lines.push(`║    Homing level: ${profile.tracking.homingLevel} — ${profile.tracking.homingDescription}`);
        lines.push(`║    Effective tracking score: ${(profile.tracking.trackingScore * 100).toFixed(1)}%`);
        lines.push(`║    Turn rate: ${profile.tracking.turningRate} deg/frame`);
        for (const bd of profile.tracking.trackingBreakdown)
            lines.push(`║      ${bd.key}: ${bd.value}`);
        lines.push(`║`);
    }

    // Missile strength
    if (profile.missileStrength.value > 0) {
        lines.push(`║  MISSILE STRENGTH: ${profile.missileStrength.value}`);
        for (const n of profile.missileStrength.notes) lines.push(`║    · ${n}`);
        lines.push(`║`);
    }

    // Ammo
    lines.push(`║  AMMO`);
    if (profile.ammo.hasAmmo) {
        lines.push(`║    Outfit:      ${profile.ammo.ammoOutfitName}`);
        lines.push(`║    Per shot:    ${profile.ammo.ammoPerShot}`);
        lines.push(`║    Storage key: ${profile.ammo.storageCapacityKey || '(same as outfit name)'}`);
        if (profile.ammo.ammoOutfitDetails)
            lines.push(`║    Rounds/unit: ${profile.ammo.ammoOutfitDetails.ammoStored ?? '?'}`);
    } else {
        lines.push(`║    No ammo required.`);
    }
    if (profile.ammo.firingCosts) {
        lines.push(`║    Firing costs:`);
        for (const [k, v] of Object.entries(profile.ammo.firingCosts))
            lines.push(`║      ${k}: ${v}`);
    }
    lines.push(`║`);

    // Submunitions
    if (profile.submunitions.hasSubmunitions) {
        lines.push(`║  SUBMUNITIONS`);
        lines.push(`║    Max depth: ${profile.submunitions.maxDepth}`);
        lines.push(`║    Leaf projectiles: ${profile.submunitions.leafCount}`);
        lines.push(`║    Damage types: ${profile.submunitions.totalDamageTypes.join(', ') || 'none detected'}`);
        if (profile.submunitions.isCluster) lines.push(`║    MODE: cluster (simultaneous spread)`);
        if (profile.submunitions.isStream)  lines.push(`║    MODE: stream (one per frame)`);
        _formatSubTree(profile.submunitions.tree, lines, '║    ');
        lines.push(`║`);
    }

    // Timing
    const t = profile.timing;
    lines.push(`║  TIMING: reload=${t.reload} burst=${t.burstCount}×${t.burstReload} → ${t.shotsPerSecond}/s`);

    // Range
    const r = profile.range;
    if (r.effectiveRange > 0)
        lines.push(`║  RANGE: ${r.velocity} px/f × ${r.lifetime} f = ${r.effectiveRange} px`);
    if (r.blastRadius > 0)   lines.push(`║    Blast radius: ${r.blastRadius}`);
    if (r.triggerRadius > 0) lines.push(`║    Trigger radius: ${r.triggerRadius}`);

    lines.push(`╚${'═'.repeat(52)}`);
    return lines.join('\n');
}

// tree as text
function _formatSubTree(node, lines, indent) {
    if (!node) return;
    const marker = node.leaf ? '◆' : '▼';
    lines.push(`${indent}${marker} ${node.name} ×${node.count || 1}` +
               (node.cycleRef ? ' [CYCLE REF]' : ''));
    for (const child of (node.children || []))
        _formatSubTree(child, lines, indent + '  ');
}

// ── interception ──

// chance anti-missile stops a missile
function calcInterceptChance(antiMissileStrength, missileStrength) {
    const am = Math.max(0, antiMissileStrength  || 0);
    const ms = Math.max(0, missileStrength || 0);
    if (am === 0) return 0;
    if (ms === 0) return 1;
    return am / (am + ms);
}

// effective 0–1 tracking score
function calcEffectiveTrackingScore(weapon) {
    let best = 0;
    for (const key of trackingKeys()) {
        if (key === 'homing') continue;
        const val = (weapon && weapon[key]) || 0;
        if (val > best) best = val;
    }
    return best;
}

// ── window.MunitionTypes ──

window.MunitionTypes = {
    // Lifecycle
    init,
    isReady,

    // Analysis
    analyseWeapon,
    analyseOutfit,
    resolveSubmunitionTree,
    getAmmoTree,
    buildRegistry,
    formatProfile,

    // Utilities
    calcInterceptChance,
    calcEffectiveTrackingScore,

    // read-only copies of the key lists
    get TRACKING_KEYS()      { return [...trackingKeys()]; },
    ANTI_MISSILE_KEY,
    MISSILE_STRENGTH_KEY,
    get FIRING_COST_KEYS()   { return [...firingCostKeys()]; },
    get FIRING_STATUS_KEYS() { return [...firingStatusKeys()]; },
    SUBMUNITION_KEYS:    [...SUBMUNITION_KEYS],
    MAX_SUBMUNITION_DEPTH,
    HOMING_LEVEL_NAMES:  [...HOMING_LEVEL_NAMES],
};

})();
