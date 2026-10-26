;(function () {
'use strict';

// Damage types, protections and resistances, read from the attribute definitions (game rules). Used by the battle sim.

let _ready     = false;
let _typeMap   = {};   // lowercase typeName  → entry
let _protMap   = {};   // attribute key        → entry
let _resistMap = {};   // statName / resistKey → entry
let _registry  = null;

// build the lists once the definitions load. Called on load
function initDamageTypes(attrDefs) {
    _ready     = false;
    _typeMap   = {};
    _protMap   = {};
    _resistMap = {};
    _registry  = null;

    if (!attrDefs) {
        console.error('[damageTypes] initDamageTypes: attrDefs is null — registry not built');
        return;
    }

    const attrs       = attrDefs.attributes                             || {};
    const typeNames   = attrDefs.weapon?.damageTypes                    || [];
    const typeDetails = attrDefs.weapon?.damageTypeDetails              || [];
    const decayMap    = attrDefs.weapon?.statusEffectDecay?.decayMap    || {};
    const descriptors = attrDefs.weapon?.statusEffectDecay?.descriptors || [];

    // Index typeDetails by lowercase typeName for O(1) lookup
    const detailsByName = {};
    for (const d of typeDetails)
        if (d.typeName) detailsByName[d.typeName.toLowerCase()] = d;

    // 1. damage types
    const damageTypes = [];
    for (const typeName of typeNames) {
        const d = detailsByName[typeName.toLowerCase()];
        if (!d) {
            console.warn(
                `[damageTypes] No damageTypeDetails for "${typeName}". ` +
                `Run attributeParser.js to regenerate attributeDefinitions.json.`
            );
            continue;
        }
        const entry = {
            typeName:          d.typeName,
            category:          d.category,
            resourceKey:       d.resourceKey,
            relativeKey:       d.relativeKey       ?? null,
            shieldInteraction: d.shieldInteraction,
            statusEffect:      d.statusEffect      ?? null,
            resistanceKey:     d.resistanceKey     ?? null,
            protectionKey:     d.protectionKey     ?? null,
            description:       d.description       ?? '',
            applyFormula:      d.applyFormula      ?? '',
            notes:             d.notes             ?? [],
            isWeaponDataKey:    attrs[d.resourceKey]?.isWeaponDataKey    ?? false,
            shownInOutfitPanel: attrs[d.resourceKey]?.shownInOutfitPanel ?? false,
        };
        damageTypes.push(entry);
        _typeMap[typeName.toLowerCase()] = entry;
    }

    // 2. protections
    const protections = [];
    const seenProt = new Set();

    for (const [key, a] of Object.entries(attrs)) {
        if (!a.isProtection && key !== 'piercing resistance') continue;
        if (seenProt.has(key)) continue;
        seenProt.add(key);
        const entry = {
            key,
            appliesTo:    a.protectionAppliesTo ?? (key.replace(' protection', '') + ' damage'),
            formula:      a.protectionFormula   ?? `effectiveDose = rawDose * (1 - [${key}])`,
            note:         a.protectionNote      ?? a.stackingDescription ?? '',
            stackingNote: a.stackingDescription ?? '',
            clampRange:   a.clampRange          ?? '[0, 1]',
        };
        protections.push(entry);
        _protMap[key] = entry;
    }

    // 3. resistances
    const resistances = [];
    const seenResist = new Set();

    // Build from descriptors (existing behavior)
    for (const desc of descriptors) {
        const rk = desc.resistKey;
        if (!rk || seenResist.has(rk)) continue;
        seenResist.add(rk);

        const a = attrs[rk] || {};

        const entry = {
            statName: desc.statName,
            resistKey: rk,
            decayFormula: desc.decayFormula ?? '',
            costKeys: desc.costKeys ?? [],
            note: desc.description ?? '',
            passiveHalfLifeFrames: desc.passiveHalfLifeFrames ?? null,
            passiveHalfLifeSecs: desc.passiveHalfLifeFrames != null
                ? (desc.passiveHalfLifeFrames / 60).toFixed(2)
                : null,
            stackingNote: a.stackingDescription ?? '',
            ...(desc.jamChanceFormula ? { jamChanceFormula: desc.jamChanceFormula } : {}),
        };

        resistances.push(entry);
        _resistMap[desc.statName] = entry;
        _resistMap[rk] = entry;
    }

    // Fallback: include any attribute marked as resistance
    for (const [key, a] of Object.entries(attrs)) {
        if (!a.isStatusResistance) continue;
        if (seenResist.has(key)) continue;

        const entry = {
            statName: key.replace(' resistance', ''),
            resistKey: key,
            decayFormula: '',
            costKeys: [],
            note: a.description ?? '',
            passiveHalfLifeFrames: null,
            passiveHalfLifeSecs: null,
            stackingNote: a.stackingDescription ?? '',
        };

        resistances.push(entry);
        _resistMap[key] = entry;
    }

    _registry = { damageTypes, protections, resistances };
    _ready    = true;

    console.log(
        `[damageTypes] Ready — ` +
        `${damageTypes.length} damage types, ` +
        `${protections.length} protections, ` +
        `${resistances.length} resistances`
    );
}

// ── public ──
function isReady()          { return _ready; }
// everything
function getRegistry()      { return _registry; }
// all damage types
function getAllDamageTypes() { return _registry?.damageTypes  ?? []; }
// all protections
function getAllProtections() { return _registry?.protections  ?? []; }
// all resistances
function getAllResistances() { return _registry?.resistances  ?? []; }

// one damage type
function getDamageType(typeName)  { return _typeMap  [(typeName  || '').toLowerCase()] ?? null; }
// one protection
function getProtection(key)       { return _protMap  [key]                             ?? null; }
// one resistance
function getResistance(keyOrStat) { return _resistMap[keyOrStat]                       ?? null; }

// how a type behaves against shields
function getShieldInteraction(typeName) {
    return getDamageType(typeName)?.shieldInteraction ?? 'half';
}

// how much of a damage type gets through shields (0, 0.5 or 1)
function getShieldMultiplier(typeName, shieldsUp) {
    if (!shieldsUp) return 1.0;
    switch (getShieldInteraction(typeName)) {
        case 'full':    return 1.0;
        case 'half':    return 0.5;
        case 'blocked': return 0.0;
        default:        return 1.0;
    }
}

window.DamageTypes = {
    init: initDamageTypes,
    isReady,
    getRegistry,
    getDamageType,
    getProtection,
    getResistance,
    getAllDamageTypes,
    getAllProtections,
    getAllResistances,
    getShieldInteraction,
    getShieldMultiplier,
};

})();
