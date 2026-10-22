;(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  ItemStats.js  —  SINGLE BACKEND DATA LAYER for ship/outfit/effect stats
//
//  Every number shown anywhere in the UI — raw attributes, ship-function
//  derived stats, energy/heat table rows, label/value pairs, time-to-full,
//  scan range/evasion, system-aware stats, status-effect wear-off, outfit
//  contributions, weapon DPS chains, per-divisor efficiency ratios, and the
//  ComputedStats.js _fn_/_derived_/_sys_/_ws_/_mv_ outputs — is computed
//  and classified HERE, exactly once.
//
//  AttributeDisplay.js and CompareDisplay.js do NOT calculate, classify, or
//  format numbers. They call the orchestrators below (getShipStats /
//  getOutfitStats / getEffectStats) and turn the returned `rows` into HTML
//  or DOM. That's the whole contract.
//
//  ROW SHAPE
//  ─────────
//  Every row pushed anywhere in this file has this shape:
//    {
//      key,              // stable, unique dedup key
//      label,            // display label
//      raw,              // number|string|null — the UNSCALED (qty=1) value
//      value,            // fmtNum(raw) at qty=1 — convenience for callers
//                         //   that don't need to rescale (AttributeDisplay)
//      unit,             // display unit string ('', 'dmg/s', 's', ...)
//      section,          // canonical AttributeSections bucket, OR an
//                         // ad-hoc "Outfit: X" / "Weapon: X" detail section
//      source,           // where this row came from (see SOURCE_* below)
//      scalesWithQty,    // whether a fleet-qty multiplier should apply
//      lowerBetter,      // true|false — colour-engine direction hint
//      isComputedOutfit, // true if this row only appears once outfits are
//                         // factored in (drives "(with outfits)" sub-UI)
//      formula,          // optional formula string, for tooltips
//      tooltip,          // optional pre-built tooltip string
//      isDivider,        // true for spacer/header rows in detail blocks
//    }
//
//  DEPENDENCIES: window.AttributeSections (required), window.ComputedStats
//  and window.WeaponStats (optional — features silently no-op without them).
// ═══════════════════════════════════════════════════════════════════════════

// ── Source tags ──────────────────────────────────────────────────────────
const SOURCE = {
    RAW:            'raw',            // straight from item.attributes / outfit
    SHIP_FN:        'shipFn',         // a real Ship:: function formula
    ENERGY_HEAT:    'energyHeat',     // an energy/heat table row
    LABEL_PAIR:     'labelPair',      // a ShipInfoDisplay label/value pair
    FN_VARIANT:     'fnVariant',      // a game function shown both ways (e.g. with afterburner)
    TIME_TO_FULL:   'timeToFull',     // time-to-full shields/hull
    SCAN_RANGE:     'scanRange',      // scan range from scan power
    SCAN_EVASION:   'scanEvasion',    // scan evasion from scan interference
    SYSTEM_AWARE:   'systemAware',    // a systemAwareFormulas entry
    COMPUTED_STATS: 'computedStats',  // window.ComputedStats output
    WEAR_OFF:       'wearOff',        // status effect wear-off time
    HEAT_DERIVED:   'heatDerived',    // total heat capacity / max sustainable heat
    HARDPOINT:      'hardpoint',      // gun/turret/bay/engine counts
    OUTFIT_CONTRIB: 'outfitContrib',  // merged outfit contribution to a raw key
    WEAPON_DPS:     'weaponDps',      // fleet-level weapon DPS summary
    OUTFIT_DETAIL:  'outfitDetail',   // per-outfit detail block row
    WEAPON_DETAIL:  'weaponDetail',   // per-weapon detail block row
    EFFICIENCY:     'efficiency',     // per-divisor ratio row (outfits)
    STACKING_NOTE:  'stackingNote',
};

// ─────────────────────────────────────────────────────────────────────────
//  BASIC HELPERS
// ─────────────────────────────────────────────────────────────────────────

// Anything smaller than this in magnitude is floating-point noise, not a
// real value — e.g. two outfits contributing +1 and -1 "shield energy"
// should net to exactly 0, but IEEE754 summation can land on something
// like -6.66e-12 instead. fmtNum clamps that to a clean "0" for display.
// This does NOT suppress or hide anything — a row that legitimately
// computes to 0 (or a genuine negative value) still shows; this only
// stops floating-point residue from being displayed as garbage scientific
// notation in its place.
const ZERO_EPSILON = 1e-9;

function fmtNum(v) {
    if (v === undefined || v === null) return '—';
    if (typeof v !== 'number') { const n = parseFloat(v); if (isNaN(n)) return String(v); v = n; }
    if (Math.abs(v) < ZERO_EPSILON) v = 0;
    if (Number.isInteger(v) && Math.abs(v) >= 10000) return v.toLocaleString();
    return parseFloat(v.toPrecision(4)).toString();
}

function getAttrRecord(attrDefs, key) {
    const attrs = attrDefs?.attributes || {};
    return attrs[key] || attrs[key?.toLowerCase()] || null;
}

function getSection(attrDefs, key) {
    return window.AttributeSections.classify(attrDefs, key);
}

function getStacking(attrDefs, key) {
    const rec = getAttrRecord(attrDefs, key);
    return rec ? { rule: rec.stacking, description: rec.stackingDescription } : null;
}

// Pretty label for ANY key — raw attribute ("energy capacity") or computed/
// internal ("_fn_MaxShields", "_derived_energy_foo", "_ws_totalDps", ...).
function labelForKey(key) {
    let s = key;
    if (s.startsWith('_fn_'))                  s = s.slice(4);
    else if (s.startsWith('_derived_energy_')) s = s.slice('_derived_energy_'.length) + ' Energy/s';
    else if (s.startsWith('_derived_heat_'))   s = s.slice('_derived_heat_'.length)   + ' Heat/s';
    else if (s.startsWith('_derived_'))        s = s.slice('_derived_'.length);
    else if (s.startsWith('_sys_'))            s = s.slice('_sys_'.length).replace(/_/g, ' ') + ' (system)';
    else if (s === '_ws_totalDps')             return 'Total DPS';
    else if (s === '_ws_shieldDps')            return 'Shield DPS';
    else if (s === '_ws_hullDps')              return 'Hull DPS';
    else if (s === '_ws_weaponCount')          return 'Weapon Types';
    else if (s === '_ws_totalWeaponMounts')    return 'Total Weapon Mounts';
    else if (s === '_outfitMass')              return 'Outfit Mass';
    else if (s === '_totalOutfitCost')         return 'Total Outfit Cost';
    else if (s === '_totalOutfits')            return 'Total Outfits';
    else if (s.startsWith('_ws_dps_')) {
        s = s.slice('_ws_dps_'.length).replace(/_/g, ' ');
        s = s.replace(/\s*damage\s*$/, '').trim() + ' DPS';
    }
    return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // "hullDPS" → "hull DPS", not "hull D P S"
            .replace(/_/g, ' ').replace(/\s+/g, ' ').replace(/^./, c => c.toUpperCase()).trim();
}

// Returns the value STRING to display for a row, honouring the enhanced-
// details toggle. `opts.baseValue`, if given, overrides row.value as the
// "actual" figure to show — CompareDisplay needs this since its displayed
// value is row.raw scaled by fleet quantity, not the qty=1 row.value.
//
// When enhanced details is ON and the row carries a `rawUnscaled` that
// actually differs from its scaled/multiplied `raw` (i.e. there's a real
// displayScale/displayMultiplier step in between worth surfacing), the raw
// stored number is appended after the normal value. Rows with no such
// distinction (rawUnscaled missing, non-numeric, or equal to raw) are
// returned unchanged — nothing to add.
// Yes/no attributes (marked in the attribute definitions): the game only checks
// whether they're there, so a total like "Unplunderable 900" means nothing.
function isFlagAttribute(key) {
    const rec = window.attrDefs?.attributes?.[String(key || '').toLowerCase()];
    return !!(rec && (rec.isBoolean || rec.area === 'Special / Flags'));
}

function formatRowDisplay(row, opts) {
    if (row && isFlagAttribute(row.key) && Number(row.raw) > 0) return 'Yes';
    const base = (opts && opts.baseValue !== undefined) ? opts.baseValue : row?.value;
    if (!row || !isEnhancedDetailsEnabled()) return base;
    const rawU = row.rawUnscaled;
    if (typeof rawU !== 'number' || typeof row.raw !== 'number') return base;
    if (Math.abs(rawU - row.raw) < 1e-9) return base;
    return `${base} (raw: ${fmtNum(rawU)})`;
}

function tooltipParts(rec, formulaOverride) {
    if (!rec && !formulaOverride) return '';
    const parts = [];
    if (rec?.description) parts.push(rec.description);
    if (rec?.stacking)    parts.push(`Stacking: ${rec.stacking}${rec.stackingDescription ? ' — ' + rec.stackingDescription : ''}`);
    const formula = formulaOverride || rec?.formula;
    if (formula)          parts.push(`Formula: ${formula}`);
    if (rec?.displayUnit) parts.push(`Unit: ${rec.displayUnit}`);
    return parts.join(' | ');
}

const _FN_RATE_RE = /rate|per.?second|generation|consumption|dissipation|production|output|input|recharge|repair/i;
function inferFnUnit(attrDefs, fnName) {
    const rec = attrDefs?.shipFunctions?.[fnName];
    if (rec?.displayUnit) return rec.displayUnit;
    if (_FN_RATE_RE.test(fnName)) return '/s';
    return '';
}

function isShipItem(item) {
    return !!(item?.attributes && typeof item.attributes === 'object');
}

// ─────────────────────────────────────────────────────────────────────────
//  ENHANCED DETAILS TOGGLE
//
//  A single, site-wide, localStorage-backed on/off flag. When ON, rows that
//  carry a distinct `rawUnscaled` value (the number as actually stored/
//  computed, before the display multiplier/scale that turns it into the
//  friendly on-screen figure) show that raw number alongside the normal
//  display value — see formatRowDisplay() below, the single place this
//  flag is actually consumed.
//
//  The toggle UI itself lives on whichever page wires it up; this module
//  only owns the stored value and notifies listeners when it changes —
//  including changes made on a DIFFERENT already-open tab/page, via the
//  native 'storage' event (which only fires in tabs other than the one
//  that made the change, so localStorage.setItem's caller also gets a
//  same-tab 'enhancedDetailsChanged' dispatch directly).
// ─────────────────────────────────────────────────────────────────────────

const ENHANCED_DETAILS_KEY = 'es-enhanced-details';

function isEnhancedDetailsEnabled() {
    try {
        return localStorage.getItem(ENHANCED_DETAILS_KEY) === 'true';
    } catch (_) { return false; }
}

function setEnhancedDetailsEnabled(enabled) {
    enabled = !!enabled;
    try { localStorage.setItem(ENHANCED_DETAILS_KEY, enabled ? 'true' : 'false'); } catch (_) { /* storage unavailable — flag just won't persist */ }
    window.dispatchEvent(new CustomEvent('enhancedDetailsChanged', { detail: { enabled } }));
    return enabled;
}

function toggleEnhancedDetails() {
    return setEnhancedDetailsEnabled(!isEnhancedDetailsEnabled());
}

if (typeof window !== 'undefined') {
    window.addEventListener('storage', e => {
        if (e.key !== ENHANCED_DETAILS_KEY) return;
        window.dispatchEvent(new CustomEvent('enhancedDetailsChanged', { detail: { enabled: e.newValue === 'true' } }));
    });
}

// ── Outfit index / lookup ───────────────────────────────────────────────

// Only the selected plugins: an outfit from a plugin you haven't switched on
// isn't in your game, so it mustn't count towards a ship's stats.
function buildOutfitIndex() {
    const allData = (window.DataLoader && typeof window.DataLoader.getActiveData === 'function' ? window.DataLoader.getActiveData() : (window.allData || {}));
    const merged  = {};
    for (const pd of Object.values(allData))
        (pd.outfits || []).forEach(o => { if (o.name && !merged[o.name]) merged[o.name] = o; });
    return merged;
}

function lookupOutfit(name, pluginId) {
    const allData = (window.DataLoader && typeof window.DataLoader.getActiveData === 'function' ? window.DataLoader.getActiveData() : (window.allData || {}));
    const order = [pluginId, ...Object.keys(allData).filter(k => k !== pluginId)];
    for (const pid of order) {
        const outfit = (allData[pid]?.outfits || []).find(o => o.name === name);
        if (outfit) return outfit;
    }
    return null;
}

// Normalise outfit map / array into [[name, count], ...]
function outfitEntries(src) {
    if (Array.isArray(src))
        return src.map(e => [e.name || '', typeof e.count === 'number' ? e.count : 1]);
    return Object.entries(src || {}).map(([name, qv]) => [
        name,
        typeof qv === 'object' ? (parseInt(qv.count) || 1) : (Number(qv) || 1)
    ]);
}

// ── Lower-is-better classification (colour engine data, not UI) ──────────

const _ALWAYS_LOWER_BETTER = new Set([
    'mass', 'drag', 'cost',
    'energy consumption', 'fuel consumption', 'heat generation',
    'cooling energy', 'cooling inefficiency',
    'required crew', 'mandatory crew',
]);
const _COST_PREFIX_RE = /^(firing |thrusting |turning |afterburner |reverse thrusting |cloaking |delayed shield |delayed hull )/;
const _COST_SUFFIX_RE = / (energy|heat|fuel|shields|hull)$/;
const _RESISTANCE_COST_RE = /^(burn|corrosion|discharge|disruption|ion|scramble|slowing|leak) resistance (energy|fuel|heat)$/;

function isLowerBetter(attrDefs, key, label) {
    const rec = getAttrRecord(attrDefs, key);

    if (rec?.isStatusResistanceCost) return true;
    if (rec?.isExpectedNegative)     return false;
    if (rec?.displayUnit === 's')    return true;

    // Durations produced by this file's derived/wear-off rows.
    if (key.startsWith('_cds_Time to Full') || key.startsWith('_wo_')) return true;

    if (_ALWAYS_LOWER_BETTER.has(key)) return true;
    if (_COST_PREFIX_RE.test(key) && _COST_SUFFIX_RE.test(key)) return true;
    if (_RESISTANCE_COST_RE.test(key)) return true;
    if (/^(shield|hull) (energy|heat|fuel)$/.test(key)) return true;

    if (key.startsWith('_')) {
        const l = (label || key).toLowerCase();
        if (/(cost|consumption|heat gen|delay|mass)/.test(l)) return true;
    }
    return false;
}

// Pure weapon behaviour keys (reload, velocity, lifetime, ...) don't scale
// with a fleet-quantity multiplier; ship movement attrs that happen to also
// appear on weapon data (turn, thrust) DO scale. Distinguished by whether a
// real Ship:: function reads the key.
function scalesWithQtyFor(attrDefs, key) {
    const rec = getAttrRecord(attrDefs, key);
    const isShipMovementAttr = rec?.usedInShipFunctions?.length > 0;
    const isBehaviourKey = rec?.isWeaponDataKey && !rec?.isWeaponStat && !isShipMovementAttr;
    return !isBehaviourKey;
}

// ─────────────────────────────────────────────────────────────────────────
//  RAW ATTRIBUTES
// ─────────────────────────────────────────────────────────────────────────

// attrsObj: flat { key: numberOrString } map (already outfit-merged, or not)
function getRawAttributeRows(attrDefs, attrsObj, opts) {
    opts = opts || {};
    const skip = opts.skip || new Set();
    const rows = [];
    for (const [key, value] of Object.entries(attrsObj || {})) {
        if (skip.has(key) || key.startsWith('_')) continue;
        if (value === '' || value == null || typeof value === 'object') continue;

        const rec     = getAttrRecord(attrDefs, key);
        const section = getSection(attrDefs, key);
        const mult    = rec?.displayUnit !== undefined ? (rec?.displayMultiplier ?? 1) : (rec?.displayMultiplier ?? 1);
        const rawNum  = parseFloat(value);
        const isNum   = !isNaN(rawNum);
        const raw     = isNum ? rawNum * mult : value;

        rows.push({
            key, label: labelForKey(key),
            raw, rawUnscaled: isNum ? rawNum : value, value: isNum ? fmtNum(raw) : String(raw),
            unit: rec?.displayUnit ?? '', section, source: SOURCE.RAW,
            scalesWithQty: isNum ? scalesWithQtyFor(attrDefs, key) : false,
            lowerBetter: isLowerBetter(attrDefs, key, labelForKey(key)),
            formula: rec?.formula || '', tooltip: tooltipParts(rec),
        });
    }
    return rows;
}

// ── Effective (outfit-merged) attributes ──────────────────────────────────
// outfitIdx: null/omitted => base-only. Passing an index merges every
// installed outfit's numeric attributes in (additive; stacking rules for
// non-additive attrs are surfaced separately via getStackingNotes).

const _META_KEYS = new Set([
    'name','display name','category','series','index','cost','thumbnail','sprite',
    'description','pluginId','weapon','governments','locations',
    '_internalId','_pluginId','_hash','_pn','_pd','_isVariant','_compareTab',
    '_variantPluginId','displayName','spriteData','attributes',
    'leaks','engines','guns','turrets','bays','reverseEngines','steeringEngines',
    'outfitMap','outfits',
]);

function buildEffectiveAttrs(item, outfitIdx) {
    const eff = {};
    const attrs = item.attributes || {};
    for (const [k, v] of Object.entries(attrs)) {
        if (typeof v === 'number')      eff[k] = v;
        else if (typeof v === 'string') { const n = parseFloat(v); if (!isNaN(n)) eff[k] = n; }
    }
    if (!outfitIdx) return eff;

    for (const [name, count] of outfitEntries(item.outfitMap || item.outfits || {})) {
        const outfit = outfitIdx[name];
        if (!outfit) continue;
        const src = (outfit.attributes && Object.keys(outfit.attributes).length)
            ? { ...outfit, ...outfit.attributes } : outfit;
        for (const [key, rawVal] of Object.entries(src)) {
            if (_META_KEYS.has(key) || key.startsWith('_')) continue;
            if (typeof rawVal !== 'number' || rawVal === 0)  continue;
            eff[key] = (eff[key] || 0) + rawVal * count;
        }
    }
    return eff;
}

// ── Which outfits contribute what to which attribute ─────────────────────

function computeOutfitContributions(item, pluginId) {
    const outfitMap = item.outfitMap || item.outfits || {};
    const contributions = {};
    for (const [outfitName, qtyVal] of Object.entries(outfitMap)) {
        const qty = typeof qtyVal === 'object' ? (parseInt(qtyVal.count) || 1) : (Number(qtyVal) || 1);
        const outfit = lookupOutfit(outfitName, pluginId);
        if (!outfit) continue;
        const outfitAttrs = (outfit.attributes && Object.keys(outfit.attributes).length)
            ? outfit.attributes : outfit;
        for (const [key, rawVal] of Object.entries(outfitAttrs)) {
            if (typeof rawVal !== 'number' || key.startsWith('_') || rawVal === 0) continue;
            if (!contributions[key]) contributions[key] = { total: 0, sources: [] };
            contributions[key].total += rawVal * qty;
            contributions[key].sources.push({ name: outfitName, qty, perUnit: rawVal });
        }
    }
    return contributions;
}

// Rows showing base+outfit EFFECTIVE totals for every attribute outfits
// touch, each carrying its source breakdown in `tooltip`. Used by
// AttributeDisplay's single-ship "(with outfits)" panel.
function getOutfitContributionRows(attrDefs, item, pluginId) {
    const attrs = item.attributes || {};
    const contributions = computeOutfitContributions(item, pluginId);
    const rows = [];
    for (const [key, info] of Object.entries(contributions).sort((a, b) => a[0].localeCompare(b[0]))) {
        if (!info.sources.length) continue;
        const rec  = getAttrRecord(attrDefs, key);
        const mult = rec?.displayMultiplier ?? 1;
        const unit = rec?.displayUnit ?? '';
        const baseVal        = parseFloat(attrs[key]);
        const effectiveTotal = (isNaN(baseVal) ? 0 : baseVal) + info.total;
        const sourceStr = info.sources.map(s => {
            const perDisplay = fmtNum(s.perUnit * mult * s.qty) + (unit ? ' ' + unit : '');
            return s.qty > 1
                ? `${s.name} ×${s.qty} (${s.perUnit >= 0 ? '+' : ''}${perDisplay})`
                : `${s.name} (${s.perUnit >= 0 ? '+' : ''}${fmtNum(s.perUnit * mult)}${unit ? ' ' + unit : ''})`;
        }).join(', ');
        rows.push({
            key, label: labelForKey(key),
            raw: effectiveTotal * mult, rawUnscaled: effectiveTotal, value: fmtNum(effectiveTotal * mult), unit,
            section: getSection(attrDefs, key), source: SOURCE.OUTFIT_CONTRIB,
            scalesWithQty: true, isComputedOutfit: true,
            lowerBetter: isLowerBetter(attrDefs, key, labelForKey(key)),
            tooltip: `Sources: ${sourceStr}`,
        });
    }
    return rows;
}

// ─────────────────────────────────────────────────────────────────────────
//  HARDPOINTS
// ─────────────────────────────────────────────────────────────────────────

function getHardpointRows(item) {
    const rows = [];
    const push = (label, n) => rows.push({
        key: `_hp_${label}`, label, raw: n, value: String(n), unit: '',
        section: 'Hardpoints', source: SOURCE.HARDPOINT, scalesWithQty: true, lowerBetter: false,
    });
    for (const [field, label] of [
        ['guns', 'Guns'], ['turrets', 'Turrets'], ['engines', 'Engines'],
        ['reverseEngines', 'Reverse Engines'], ['steeringEngines', 'Steering Engines'],
    ]) if (item[field]?.length) push(label, item[field].length);

    if (item.bays?.length) {
        const byType = {};
        item.bays.forEach(b => { byType[b.type || 'Bay'] = (byType[b.type || 'Bay'] || 0) + 1; });
        Object.entries(byType).forEach(([t, n]) => push(`${t} Bays`, n));
    }
    return rows;
}

// ─────────────────────────────────────────────────────────────────────────
//  HEAT DERIVED (total heat capacity, max sustainable heat/s)
// ─────────────────────────────────────────────────────────────────────────

const MAX_TEMP = 100;

function getHeatDerivedRows(item, eff, outfitIdx) {
    const shipMass = parseFloat(item.attributes?.mass ?? item.mass ?? 0) || 0;
    let outfitMassSum = 0;
    if (outfitIdx) {
        for (const [name, count] of outfitEntries(item.outfitMap || item.outfits || {})) {
            const outfit = outfitIdx[name];
            if (!outfit) continue;
            const massKey = Object.keys(outfit).find(k => k.toLowerCase() === 'mass');
            if (massKey && typeof outfit[massKey] === 'number') outfitMassSum += outfit[massKey] * count;
        }
    }
    const totalMass   = shipMass + outfitMassSum;
    const heatCapKey  = Object.keys(eff).find(k => k.toLowerCase() === 'heat capacity');
    const heatDissKey = Object.keys(eff).find(k => k.toLowerCase().includes('heat dissipation'));
    const heatCap     = heatCapKey  ? (eff[heatCapKey]  || 0) : 0;
    const heatDiss     = heatDissKey ? (eff[heatDissKey] || 0) : 0;

    const rows = [];
    if (totalMass > 0) {
        const v = totalMass * MAX_TEMP;
        rows.push({ key: '_hd_totalHeatCap', label: 'Total Heat Capacity', raw: v, value: fmtNum(v), unit: '',
            section: 'Heat', source: SOURCE.HEAT_DERIVED, scalesWithQty: true, lowerBetter: false });
    }
    if (heatDiss > 0 && (totalMass + heatCap) > 0) {
        const v = (totalMass + heatCap) * heatDiss * 6;
        rows.push({ key: '_hd_maxSustHeat', label: 'Max Sustainable Heat/s', raw: v, value: fmtNum(v), unit: '/s',
            section: 'Heat', source: SOURCE.HEAT_DERIVED, scalesWithQty: true, lowerBetter: false });
    }
    return rows;
}

// ─────────────────────────────────────────────────────────────────────────
//  SHIP-FUNCTION FORMULA EVALUATION  (display-side thin evaluator)
// ─────────────────────────────────────────────────────────────────────────

function _buildKnownDisplayFns(attrDefs) {
    const fns   = attrDefs?.shipFunctions || {};
    const known = new Set();
    for (const [name, fn] of Object.entries(fns)) {
        if (
            fn.attributesRead?.length &&
            fn.formulas?.length &&
            (fn.displayScale ?? 1) > 1 &&
            !/^(bool|void|string|const string|shared_ptr|vector|map|set|pair|.*[*&])/.test(fn.returnType || '')
        ) known.add(name);
    }
    return known;
}

function shouldSuppressFn(fnName, fnData, knownDisplayFns) {
    const ret     = (fnData.returnType || '').trim();
    const attrs   = fnData.attributesRead || [];
    const formula = fnData.formulas?.[fnData.formulas.length - 1]?.formula ?? '';

    if (/^(bool|void|string|const string|shared_ptr|vector|map|set|pair|.*[*&])/.test(ret)) return true;
    if (!fnData.formulas?.length) return true;
    if (!attrs.length) {
        const callsDisplayFn = knownDisplayFns && [...knownDisplayFns].some(fn => formula.includes(`${fn}()`));
        if (!callsDisplayFn) return true;
    }
    if (formula.includes('min(1.'))                                     return true;
    if (formula.includes('/ maximum'))                                  return true;
    if (formula && !formula.includes('[') && !formula.includes('(') &&
        /^\w+$/.test(formula.trim()))                                   return true;
    if (/^0[.\s]*$/.test(formula.trim()))                               return true;
    if (formula.includes('>= mass') && formula.includes('/ mass'))     return true;
    if (formula.includes('sqrt(') && attrs.length === 1 &&
        attrs[0].includes('cargo'))                                     return true;
    return false;
}

function shouldSuppressIntermediateVar(varName, formula) {
    if (/PerFrame$/i.test(varName)) return true;
    const bracketCount = (formula.match(/\[/g) || []).length;
    const hasDivision  = formula.includes('/');
    const hasFnCall    = /[A-Z][a-zA-Z]+\s*\(/.test(formula);
    const hasMaxMin    = /\bmax\s*\(|\bmin\s*\(/.test(formula);
    if (!hasDivision && !hasFnCall && !hasMaxMin && bracketCount <= 1) return true;
    if (!hasDivision && !hasFnCall && bracketCount === 2 && formula.includes('?')) return true;
    if (/^\d+\.\s*\*/.test(formula.trim())) return true;
    return false;
}

function evalFormulaDisplay(formulaStr, attrs, fnResolver) {
    if (!formulaStr) return NaN;
    try {
        let js = formulaStr.replace(/\[([^\]]+)\]/g, (_, k) => {
            const v = parseFloat((attrs || {})[k] ?? 0);
            return isNaN(v) ? '0' : String(v);
        });
        for (const [fn, impl] of Object.entries(fnResolver || {})) {
            const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            js = js.replace(new RegExp('\\b' + escaped + '\\s*\\(\\s*\\)', 'g'), `(${impl})`);
        }
        const massVal = String(parseFloat((attrs || {})['mass'] ?? 0));
        const eCap    = String(parseFloat((attrs || {})['energy capacity'] ?? 0));
        const fCap    = String(parseFloat((attrs || {})['fuel capacity'] ?? 0));
        const solar   = '1';

        js = js
            .replace(/\bMAXIMUM_TEMPERATURE\b/g, '100')
            .replace(/cargo\.Used\(\)/g, '0')
            .replace(/attributes\.Mass\(\)/g, massVal)
            .replace(/\bcarriedMass\b/g, '0')
            .replace(/(?<![[\w])\bmass\b(?!["\]\w])/g, massVal)
            .replace(/\bsolar_power\b/g, solar)
            .replace(/\bwithAfterburner\b/g, '0')
            .replace(/\bslowness\b/g, '0')
            .replace(/\bdisruption\b/g, '0')
            .replace(/\bionization\b/g, '0')
            .replace(/\benergy\b(?!\s*capacity|\s*generation|\s*consumption|\s*protection|\s*damage|\s*multiplier|\s*\[)/g, eCap)
            .replace(/\bfuel\b(?!\s*capacity|\s*generation|\s*consumption|\s*protection|\s*damage|\s*energy|\s*heat|\s*\[)/g, fCap)
            .replace(/\bMax\s*\(/g, 'Math.max(')
            .replace(/\bmin\s*\(/g, 'Math.min(')
            .replace(/\bmax\s*\(/g, 'Math.max(')
            .replace(/\bexp\s*\(/g, 'Math.exp(')
            .replace(/\bfloor\s*\(/g, 'Math.floor(')
            .replace(/\bsqrt\s*\(/g, 'Math.sqrt(')
            .replace(/\babs\s*\(/g, 'Math.abs(')
            .replace(/\bpow\s*\(/g, 'Math.pow(')
            .replace(/\b(?!Math\b)[A-Z][a-zA-Z]+\(\)/g, '0')
            .replace(/\b(?!Math\b|return\b|true\b|false\b)[a-z][a-zA-Z_]*\b(?!\s*[\[(])/g, '0')
            .replace(/numeric_limits<[^>]+>::max\(\)/g, '1e308');

        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${js});`)();
        return typeof result === 'number' && isFinite(result) ? result : NaN;
    } catch (_) { return NaN; }
}

function buildFnResolver(attrDefs, attrs) {
    const fns   = attrDefs?.shipFunctions || {};
    const cache = {};

    function resolve(fnName, depth) {
        if (depth > 6) return 0;
        if (cache[fnName] !== undefined) return cache[fnName];
        const fn = fns[fnName];
        if (!fn?.formulas?.length) return 0;
        const formula   = fn.formulas[fn.formulas.length - 1].formula;
        // first work out every other game function this formula calls, so e.g.
        // Drag() can use InertialMass() — whatever order they were listed in
        cache[fnName] = 0;   // guards against a function that (indirectly) calls itself
        for (const m of formula.matchAll(/\b([A-Z][A-Za-z]+)\s*\(\s*\)/g)) {
            if (m[1] !== fnName && fns[m[1]]) resolve(m[1], depth + 1);
        }
        delete cache[fnName];
        for (const v of Object.values(fn.attributeVariables || {}))
            for (const m of String(v).matchAll(/\b([A-Z][A-Za-z]+)\s*\(\s*\)/g)) if (m[1] !== fnName && fns[m[1]]) resolve(m[1], depth + 1);
        const localVars = {};
        for (const [varName, varFormula] of Object.entries(fn.attributeVariables || {})) {
            const vv = evalFormulaDisplay(varFormula, attrs, cache);
            if (!isNaN(vv)) localVars[varName] = vv;
        }
        const mergedResolver = { ...cache, ...Object.fromEntries(Object.entries(localVars).map(([k, v]) => [k, String(v)])) };
        let val = evalFormulaDisplay(formula, attrs, mergedResolver);
        if (fnName === 'CoolingEfficiency' && (isNaN(val) || val < 0 || val > 2.5)) {
            const x = parseFloat((attrs || {})['cooling inefficiency'] ?? 0);
            val = 2 + 2 / (1 + Math.exp(x / -2)) - 4 / (1 + Math.exp(x / -4));
        }
        cache[fnName] = isNaN(val) ? 0 : val;
        return cache[fnName];
    }

    const coreOrder = ['Mass', 'Drag', 'DragForce', 'InertialMass', 'HeatDissipation',
        'MaximumHeat', 'CoolingEfficiency', 'IdleHeat', 'MaxShields', 'MaxHull',
        'MinimumHull', 'CloakingSpeed', 'TurnRate', 'Acceleration', 'MaxVelocity',
        'ReverseAcceleration', 'MaxReverseVelocity', 'RequiredCrew'];
    for (const fn of coreOrder) resolve(fn, 0);
    for (const fnName of Object.keys(fns)) { if (cache[fnName] === undefined) resolve(fnName, 0); }
    return cache;
}

function computedKeyToLabel(key) {
    let s = key;
    if (s.startsWith('_fn_'))                  s = s.slice(4);
    else if (s.startsWith('_derived_energy_')) s = s.slice('_derived_energy_'.length) + ' Energy/s';
    else if (s.startsWith('_derived_heat_'))   s = s.slice('_derived_heat_'.length)   + ' Heat/s';
    else if (s.startsWith('_derived_'))        s = s.slice('_derived_'.length);
    else if (s.startsWith('_sys_'))            s = s.slice('_sys_'.length).replace(/_/g, ' ') + ' (system)';
    else if (s.startsWith('_total'))           s = s.slice(1);
    else if (s.startsWith('_'))                s = s.slice(1);
    return s.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/\s+/g, ' ')
            .replace(/^./, c => c.toUpperCase()).trim();
}

// ─────────────────────────────────────────────────────────────────────────
//  DERIVED STATS  (ship functions, energy/heat table, label pairs,
//  time-to-full, scan range/evasion, system-aware, + ComputedStats merge)
//
//  Every row is tagged with `source` so callers can select just the subset
//  they need — e.g. CompareDisplay only wants the rows tagged LABEL_PAIR /
//  TIME_TO_FULL / SCAN_RANGE / SCAN_EVASION here, since everything else
//  this function computes is already available (identically) via
//  getComputedStatRows() below, reading straight from window.ComputedStats.
// ─────────────────────────────────────────────────────────────────────────

function calcDerivedStats(attrDefs, item, pluginId) {
    const attrs          = item?.attributes || item || {};
    const fns            = attrDefs?.shipFunctions       || {};
    const tableRows      = attrDefs?.shipDisplay?.energyHeatTable   || [];
    const labelPairs     = attrDefs?.shipDisplay?.labelValuePairs   || [];
    const intVars        = attrDefs?.shipDisplay?.intermediateVars  || {};
    const results        = [];
    const seen           = new Set();
    const renderedFnKeys = new Set();

    const fnCache         = buildFnResolver(attrDefs, attrs);
    const fnResolver      = Object.fromEntries(Object.entries(fnCache).map(([k, v]) => [k, String(v)]));
    const knownDisplayFns = _buildKnownDisplayFns(attrDefs);

    function push(label, rawValue, displayScale, unit, formulaStr, isComputedOutfit, section, source) {
        const scale = (typeof displayScale === 'number' && displayScale > 0) ? displayScale : 1;
        const value = rawValue * scale;
        if (isNaN(value) || value === 0) return;
        if (seen.has(label)) return;
        seen.add(label);
        results.push({
            key: `_cds_${label}`, label, value: fmtNum(value), raw: value, rawUnscaled: rawValue, unit: unit || '',
            formula: formulaStr || '', tooltip: formulaStr ? `Formula: ${formulaStr}` : '',
            isComputedOutfit: !!isComputedOutfit,
            section: section || 'Derived Stats',
            source: source || 'other',
            scalesWithQty: (source === SOURCE.TIME_TO_FULL || source === SOURCE.SCAN_RANGE ||
                            source === SOURCE.SCAN_EVASION || source === SOURCE.LABEL_PAIR) ? false : true,
            lowerBetter: (source === SOURCE.TIME_TO_FULL),
        });
    }

    // 1b. Game functions with a single on/off setting — e.g. MaxVelocity(bool
    //     withAfterburner) — shown both ways, labelled from the setting's own
    //     name ("with afterburner"). Then any other movement function that
    //     reads everything that setting switches on gets the same "with …"
    //     version, scaled by how much the setting adds (straight from the game's
    //     formula): that's how "acceleration with afterburner" is worked out.
    const humanise = p => p.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    for (const [fnName, fnData] of Object.entries(fns)) {
        const pm = String(fnData.params || '').trim().match(/^bool\s+(\w+)$/);
        if (!pm || !fnData.formulas?.length || /^bool|void/.test(fnData.returnType || '')) continue;
        const param = pm[1];
        const formula = fnData.formulas[fnData.formulas.length - 1].formula;
        if (!new RegExp('\\b' + param + '\\b').test(formula)) continue;
        const withOn  = evalFormulaDisplay(formula.replace(new RegExp('\\b' + param + '\\b', 'g'), '1'), attrs, fnResolver);
        const withOff = evalFormulaDisplay(formula.replace(new RegExp('\\b' + param + '\\b', 'g'), '0'), attrs, fnResolver);
        if (!isFinite(withOn) || !isFinite(withOff) || withOn === 0) continue;
        const scale  = fnData.displayScale ?? 1, unit = fnData.displayUnit ?? '';
        const base   = fnName.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
        const section = window.AttributeSections.classifyComputedKey(attrDefs, `_fn_${fnName}`);
        if (withOff) push(base, withOff, scale, unit, formula, false, section, SOURCE.FN_VARIANT);
        if (withOn === withOff) continue;
        push(`${base} (${humanise(param)})`, withOn, scale, unit, formula, false, section, SOURCE.FN_VARIANT);
        // the attributes that only count when the setting is on
        const switched = [...formula.matchAll(new RegExp('\\[([^\\]]+)\\]\\)*\\s*\\*\\s*' + param + '\\b', 'g'))].map(m => m[1]);
        const readsAll = new Set(fnData.attributesRead || []);
        if (!switched.length || !withOff) continue;
        const ratio = withOn / withOff;
        for (const [otherName, other] of Object.entries(fns)) {
            if (otherName === fnName || other.params || !other.formulas?.length) continue;
            const reads = new Set(other.attributesRead || []);
            if (!switched.every(a => reads.has(a)) || ![...readsAll].every(a => reads.has(a))) continue;
            const v = fnCache[otherName];
            if (!v || !isFinite(v)) continue;
            const oLabel = otherName.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
            push(`${oLabel} (${humanise(param)})`, v * ratio, other.displayScale ?? 1, other.displayUnit ?? '',
                 `${oLabel} × ${base} ${humanise(param)} ÷ ${base}`, false,
                 window.AttributeSections.classifyComputedKey(attrDefs, `_fn_${otherName}`), SOURCE.FN_VARIANT);
        }
    }

    // 1. Ship function formulas
    const present = k => { const v = parseFloat(attrs[k]); return isFinite(v) && v !== 0; };
    for (const [fnName, fnData] of Object.entries(fns)) {
        if (shouldSuppressFn(fnName, fnData, knownDisplayFns)) continue;
        const formula = fnData.formulas[fnData.formulas.length - 1].formula;
        // Not relevant to this ship: it only reads attributes the ship doesn't have
        // (e.g. turret turn multiplier, inertia reduction)
        const reads = fnData.attributesRead || [];
        if (reads.length && !reads.some(present)) continue;
        // A wrapper that only re-states another game function (e.g. TrueAcceleration
        // = Acceleration() adjusted for status effects): the same number again
        const calls = [...new Set([...formula.matchAll(/\b([A-Z][A-Za-z]+)\s*\(\s*\)/g)].map(m => m[1]).filter(n => fns[n]))];
        if (!reads.length && calls.length === 1) continue;
        const rawVal  = fnCache[fnName] ?? evalFormulaDisplay(formula, attrs, fnResolver);
        if (isNaN(rawVal) || rawVal === 0) continue;
        const scale   = fnData.displayScale  ?? 1;
        const unit    = fnData.displayUnit   ?? '';
        const prefix  = fnData.labelPrefix   ?? '';
        const label   = prefix + fnName.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
        const section = window.AttributeSections.classifyComputedKey(attrDefs, `_fn_${fnName}`);

        if (fnName === 'IdleHeat') {
            const maxHeat = fnCache['MaximumHeat'] ?? 0;
            if (maxHeat > 0) {
                const heatPct = rawVal / maxHeat * 100;
                push('Idle Heat %', heatPct, 1, '%', formula, false, section, SOURCE.SHIP_FN);
            }
            push(label, rawVal, scale, unit, formula, false, section, SOURCE.SHIP_FN);
            continue;
        }
        push(label, rawVal, scale, unit, formula, false, section, SOURCE.SHIP_FN);
        renderedFnKeys.add(`_fn_${fnName}`);
    }

    // 2. Energy/heat table rows
    for (const row of tableRows) {
        if (!row.label) continue;
        const eVal = evalFormulaDisplay(row.energyFormula, attrs, fnResolver);
        const hVal = evalFormulaDisplay(row.heatFormula,   attrs, fnResolver);
        if (!isNaN(eVal) && eVal !== 0) push(`${row.label} energy`, eVal, 1, '/s', row.energyFormula, false, 'Energy', SOURCE.ENERGY_HEAT);
        if (!isNaN(hVal) && hVal !== 0) push(`${row.label} heat`,   hVal, 1, '/s', row.heatFormula, false, 'Energy', SOURCE.ENERGY_HEAT);
    }

    // 3. Label/value pairs — UNIQUE to this function, nothing else computes these
    for (const pair of labelPairs) {
        if (!pair.label || !pair.formula) continue;
        const val = evalFormulaDisplay(pair.formula, attrs, fnResolver);
        if (!isNaN(val) && val !== 0) {
            const section = /licen[cs]e/i.test(pair.label)
                ? 'Licenses'
                : (window.AttributeSections.matchDomainWord(pair.label) || 'General');
            push(pair.label, val, 1, '', pair.formula, false, section, SOURCE.LABEL_PAIR);
        }
    }

    // 4. Time-to-full — UNIQUE
    const shieldRegen = parseFloat(attrs['shield generation'] ?? 0) * 60;
    const hullRepair  = parseFloat(attrs['hull repair rate']  ?? 0) * 60;
    const maxShields  = fnCache['MaxShields'] ?? 0;
    const maxHull     = fnCache['MaxHull']    ?? 0;
    if (maxShields && shieldRegen) push('Time to Full Shields', maxShields / shieldRegen, 1, 's', '', false, 'Shields & Hull', SOURCE.TIME_TO_FULL);
    if (maxHull    && hullRepair)  push('Time to Full Hull',    maxHull    / hullRepair,  1, 's', '', false, 'Shields & Hull', SOURCE.TIME_TO_FULL);

    // 5. Scan range — UNIQUE
    for (const [key] of Object.entries(attrDefs?.attributes || {})) {
        if (!key.endsWith('scan power')) continue;
        const val = parseFloat(attrs[key] ?? 0);
        if (!val) continue;
        const label = labelForKey(key).replace(' Power', ' Range');
        push(label, 100 * Math.sqrt(val), 1, 'px', `100 * sqrt([${key}])`, false, 'Scanning', SOURCE.SCAN_RANGE);
    }

    // 6. Scan evasion — UNIQUE
    const si = parseFloat(attrs['scan interference'] ?? 0);
    if (si) push('Scan Evasion', si / (1 + si) * 100, 1, '%', '', false, 'Scanning', SOURCE.SCAN_EVASION);

    // 7. System-aware stats (solar, ramscoop)
    const sysFormulas = attrDefs?.systemAwareFormulas || {};
    const solar = attrDefs?.systemContext?.referenceSolarPower ?? 1.0;
    for (const [attrKey, info] of Object.entries(sysFormulas)) {
        const attrVal = parseFloat(attrs[attrKey] ?? 0);
        if (!attrVal) continue;
        const rawVal = evalFormulaDisplay(info.formula, attrs, fnResolver);
        if (isNaN(rawVal) || rawVal === 0) continue;
        const displayVal = rawVal * (info.displayScale ?? 1);
        const label = labelForKey(attrKey) + ' (at solar ×' + solar + ')';
        push(label, displayVal, 1, info.displayUnit ?? '/s', info.formula, false, 'Energy', SOURCE.SYSTEM_AWARE);
    }

    // 8. Merge in window.ComputedStats output (only reachable when pluginId
    // is supplied — see getComputedStatRows() for the standalone version
    // that doesn't require a real ship._internalId cache key).
    if (pluginId && typeof window.getComputedStats === 'function') {
        const computed = window.getComputedStats(item, pluginId);
        for (const [statKey, val] of Object.entries(computed)) {
            const isComputedKey = statKey.startsWith('_derived_') || statKey.startsWith('_fn_')
                               || statKey.startsWith('_total') || statKey.startsWith('_sys_')
                               || statKey.startsWith('_ws_')    || statKey === '_outfitMass';
            if (!isComputedKey) continue;
            if (val == null || (typeof val === 'number' && (isNaN(val) || val === 0))) continue;

            let displayVal = val;
            if (statKey.startsWith('_fn_') && renderedFnKeys.has(statKey)) {
                const fnName = statKey.slice(4);
                const fnData = fns[fnName];
                if (fnData && shouldSuppressFn(fnName, fnData, knownDisplayFns)) continue;
                displayVal = val * (fnData?.displayScale ?? 1);
            }
            if (statKey.startsWith('_derived_')) {
                const varName = statKey.slice('_derived_'.length).replace(/^energy_|^heat_/, '');
                const ivar    = intVars[varName];
                if (ivar && shouldSuppressIntermediateVar(varName, ivar)) continue;
            }

            const label   = computedKeyToLabel(statKey);
            const section = window.AttributeSections.classifyComputedKey(attrDefs, statKey);
            if (seen.has(label)) {
                const existing = results.find(r => r.label === label);
                if (existing) { existing.value = fmtNum(displayVal); existing.raw = displayVal; existing.rawUnscaled = val; existing.isComputedOutfit = true; existing.section = section; }
                continue;
            }
            seen.add(label);
            const unit = (statKey.startsWith('_ws_') && statKey.toLowerCase().includes('dps')) ? 'dmg/s' : '';
            results.push({
                key: `_cds_${label}`, label, value: fmtNum(displayVal), raw: displayVal, rawUnscaled: val, unit, formula: '',
                isComputedOutfit: true, section, source: SOURCE.COMPUTED_STATS,
                scalesWithQty: true, lowerBetter: isLowerBetter(attrDefs, statKey, label),
            });
        }
    }

    return results;
}

// Just the rows that ONLY this function computes (nothing else in the app
// produces label/value pairs, time-to-full, scan range, or scan evasion).
function getUniqueDerivedRows(attrDefs, attrsObj) {
    // game functions too (acceleration, turn rate, max speed …): worked out here in the order
    // their formulas need, so they don't depend on a fixed list elsewhere
    const UNIQUE = new Set([SOURCE.LABEL_PAIR, SOURCE.TIME_TO_FULL, SOURCE.SCAN_RANGE, SOURCE.SCAN_EVASION, SOURCE.FN_VARIANT, SOURCE.SHIP_FN]);
    return calcDerivedStats(attrDefs, { attributes: attrsObj }).filter(r => UNIQUE.has(r.source));
}

// ─────────────────────────────────────────────────────────────────────────
//  STATUS EFFECT WEAR-OFF
// ─────────────────────────────────────────────────────────────────────────

// Fallback only — statusEffectDecay() reads the list the parser extracted
// from Ship.cpp (attrDefs.weapon.statusEffectDecay) via gameKeys.js.
const STATUS_EFFECT_DECAY_FALLBACK = [
    { damageKey: 'ion damage',         resistKey: 'ion resistance',         label: 'Ion' },
    { damageKey: 'scrambling damage',  resistKey: 'scramble resistance',    label: 'Scrambling' },
    { damageKey: 'disruption damage',  resistKey: 'disruption resistance',  label: 'Disruption' },
    { damageKey: 'slowing damage',     resistKey: 'slowing resistance',     label: 'Slowing' },
    { damageKey: 'burn damage',        resistKey: 'burn resistance',        label: 'Burn' },
    { damageKey: 'discharge damage',   resistKey: 'discharge resistance',   label: 'Discharge' },
    { damageKey: 'corrosion damage',   resistKey: 'corrosion resistance',   label: 'Corrosion' },
    { damageKey: 'leak damage',        resistKey: 'leak resistance',        label: 'Leak' },
];
function statusEffectDecay() {
    return window.GameKeys ? window.GameKeys.statusEffects(STATUS_EFFECT_DECAY_FALLBACK) : STATUS_EFFECT_DECAY_FALLBACK;
}

function calcEffectWearOffTimes(attrs) {
    const results = [];
    for (const { resistKey, label } of statusEffectDecay()) {
        const resist = parseFloat((attrs || {})[resistKey] ?? 0);
        if (!resist || resist <= 0) continue;
        results.push({
            label, resistPerFrame: resist,
            wearOffSecondsPerUnit: (1 / resist) / 60,
        });
    }
    return results;
}

function calcWeaponEffectDuration(weapon, targetAttrs) {
    const results = [];
    for (const { damageKey, resistKey, label } of statusEffectDecay()) {
        const dose   = parseFloat(weapon[damageKey] ?? 0);
        const resist = parseFloat((targetAttrs || {})[resistKey] ?? 0);
        if (!dose) continue;
        if (!resist || resist <= 0) results.push({ label, dose, resistPerFrame: 0, wearOffSeconds: Infinity });
        else results.push({ label, dose, resistPerFrame: resist, wearOffSeconds: (dose / resist) / 60 });
    }
    return results;
}

function getWearOffRows(attrsObj) {
    return calcEffectWearOffTimes(attrsObj).map(w => ({
        key: `_wo_${w.label}`, label: `${w.label} wear-off`,
        raw: w.wearOffSecondsPerUnit, value: fmtNum(w.wearOffSecondsPerUnit), unit: 's/unit',
        section: 'Resistance', source: SOURCE.WEAR_OFF, scalesWithQty: false, lowerBetter: true,
        tooltip: `Resistance: ${fmtNum(w.resistPerFrame)}/frame | Wear-off: ${fmtNum(w.wearOffSecondsPerUnit)}s per unit of ${w.label} damage received`,
    }));
}

// ─────────────────────────────────────────────────────────────────────────
//  WEAPON DPS / CHAIN
// ─────────────────────────────────────────────────────────────────────────

function calcWeaponDerived(attrDefs, weapon, pluginId, rootReload) {
    if (!weapon) return [];
    const results = [], seen = new Set();
    function push(label, value, unit, dedupKey) {
        const key = dedupKey ?? label;
        if (isNaN(value) || value === 0 || seen.has(key)) return;
        seen.add(key); results.push({ label, value: fmtNum(value), raw: value, unit: unit || '' });
    }

    const hasRefireRate = rootReload != null || weapon.reload != null || weapon['burst reload'] != null;
    const reload = hasRefireRate ? (parseFloat(rootReload ?? weapon.reload ?? weapon['burst reload']) || 0) : 0;
    const sps    = reload > 0 ? 60 / reload : 0;
    const burstCount  = parseFloat(weapon['burst count']  ?? 1) || 1;
    const burstReload = parseFloat(weapon['burst reload']  ?? reload) || reload;

    function resolveRange(w, inheritedVel, visited, depth) {
        if (depth > 8) return 0;
        const vel      = (parseFloat(w.velocity ?? 0) || 0) > 0 ? parseFloat(w.velocity) : (inheritedVel || 0);
        const ownRange = vel * (parseFloat(w.lifetime ?? 0) || 0);
        const refs = [];
        if (Array.isArray(w.submunitions)) for (const e of w.submunitions) { if (e?.type) refs.push(e.type); }
        if (!refs.length && w.submunition != null) {
            const arr = Array.isArray(w.submunition) ? w.submunition : [w.submunition];
            for (const e of arr) { const n = typeof e === 'string' ? e : (typeof e === 'object' ? e?.name : null); if (n) refs.push(n); }
        }
        if (!refs.length) for (const key of Object.keys(w)) if (key.startsWith('submunition ')) refs.push(key.slice('submunition '.length).trim());

        let maxSubRange = 0;
        for (const name of refs) {
            if (!name || visited.has(name)) continue;
            const subOutfit = pluginId ? lookupOutfit(name, pluginId) : null;
            if (!subOutfit?.weapon) continue;
            const nv = new Set(visited); nv.add(name);
            const sr = resolveRange(subOutfit.weapon, vel, nv, depth + 1);
            if (sr > maxSubRange) maxSubRange = sr;
        }
        return ownRange + maxSubRange;
    }

    const range = resolveRange(weapon, 0, new Set(), 0);
    if (range > 0) push('Range', range, 'px');

    if (sps > 0) {
        push('Fire Rate', sps, 'shots/s');
        if (burstCount > 1) {
            const framesPerCycle = (burstCount - 1) * burstReload + reload;
            if (framesPerCycle > 0) push('Sustained Rate', (burstCount / framesPerCycle) * 60, 'shots/s');
        }
    }

    const damageTypes = attrDefs?.weapon?.damageTypes?.length
        ? attrDefs.weapon.damageTypes
        : Object.keys(weapon).filter(k => k.endsWith(' damage')).map(k => k.replace(/ damage$/, ''));

    for (const dtype of damageTypes) {
        const dmgKey    = dtype.endsWith(' damage') ? dtype : `${dtype} damage`;
        const searchKey = [dmgKey, dmgKey.toLowerCase(), dtype.toLowerCase() + ' damage'].find(k => weapon[k] !== undefined);
        const val = searchKey !== undefined ? parseFloat(weapon[searchKey] ?? 0) : 0;
        if (!val) continue;
        const rec  = attrDefs ? getAttrRecord(attrDefs, dmgKey) : null;
        const mult = rec?.displayMultiplier ?? 1;
        push(labelForKey(dmgKey), val * mult, 'dmg/shot', dmgKey + '__shot');
        if (sps > 0) push(labelForKey(dmgKey), val * mult * sps, 'dmg/s', dmgKey + '__dps');
    }

    const am = parseFloat(weapon['anti-missile'] ?? 0);
    if (am) {
        const ms = parseFloat(weapon['missile strength'] ?? 1) || 1;
        push('Intercept Chance', am / (am + ms) * 100, `% vs str ${ms}`);
    }

    for (const [key, rawVal] of Object.entries(weapon)) {
        if (typeof rawVal !== 'number') continue;
        if (!key.startsWith('firing ') && !key.startsWith('relative firing ')) continue;
        if (!rawVal) continue;
        const label = labelForKey(key);
        push(label, rawVal, '/shot', key + '__shot');
        if (sps > 0) push(label, rawVal * sps, '/s', key + '__ps');
    }

    for (const { damageKey, label } of statusEffectDecay()) {
        const dose = parseFloat(weapon[damageKey] ?? 0);
        if (dose) push(`${label} dose/shot`, dose, 'units');
    }

    return results;
}

// Structured (non-HTML) weapon → submunitions → ammo chain data.
// Returns { sections: [{title, weapon, outfit, multiplier, rows, derivedRows}],
//           totalDamagePerShot: {key: val}, totalDps: {key: val}|null, rootSps }
function getWeaponChainData(attrDefs, weapon, pluginId) {
    if (!weapon) return null;
    const totalDamage = {}, visited = new Set();

    const hasRefireRate = weapon.reload != null || weapon['burst reload'] != null;
    const rootReload = hasRefireRate ? (parseFloat(weapon.reload ?? weapon['burst reload']) || 0) : 0;
    const rootSps = rootReload > 0 ? 60 / rootReload : 0;

    function collectDamage(w, multiplier) {
        const dmg = {};
        for (const [key, val] of Object.entries(w || {})) {
            if (typeof val !== 'number') continue;
            if (key.endsWith(' damage') || key === 'anti-missile' || key === 'blast radius') {
                const rec  = getAttrRecord(attrDefs, key);
                const mult = rec?.displayMultiplier ?? 1;
                dmg[key] = (dmg[key] || 0) + val * mult * multiplier;
            }
        }
        return dmg;
    }
    function mergeInto(target, source) { for (const [k, v] of Object.entries(source)) target[k] = (target[k] || 0) + v; }

    const queue = [{ weapon, outfit: null, title: 'Weapon Stats', multiplier: 1, depth: 0 }];
    const sections = [];

    while (queue.length > 0) {
        const { weapon: w, outfit: o, title, multiplier, depth } = queue.shift();
        sections.push({
            title, weapon: w, outfit: o, multiplier,
            derivedRows: calcWeaponDerived(attrDefs, w, pluginId,
                (o === null) ? (rootReload || undefined) : undefined),
        });
        mergeInto(totalDamage, collectDamage(w, multiplier));
        if (depth >= 8) continue;

        const refs = [];
        if (Array.isArray(w.submunitions)) for (const entry of w.submunitions) { const name = entry?.type ?? null; if (name) refs.push({ name, count: entry?.count ?? 1 }); }
        if (!refs.length && w.submunition != null) {
            const entries = Array.isArray(w.submunition) ? w.submunition : [w.submunition];
            for (const entry of entries) {
                const name  = typeof entry === 'string' ? entry : (typeof entry === 'object' ? (entry?.name ?? null) : null);
                const count = typeof entry === 'object' && entry !== null ? (entry.count ?? 1) : 1;
                if (name) refs.push({ name, count });
            }
        }
        if (!refs.length) for (const key of Object.keys(w)) {
            if (!key.startsWith('submunition ')) continue;
            const name = key.slice('submunition '.length).trim();
            const val = w[key];
            const count = Array.isArray(val) ? val.length : typeof val === 'number' ? Math.max(1, val) : 1;
            if (name) refs.push({ name, count });
        }
        for (const { name, count } of refs) {
            if (visited.has(name)) continue;
            visited.add(name);
            const subOutfit = lookupOutfit(name, pluginId);
            if (!subOutfit?.weapon) continue;
            queue.push({ weapon: subOutfit.weapon, outfit: subOutfit, title: `Submunition: ${name}${count > 1 ? ` ×${count}` : ''}`, multiplier: multiplier * count, depth: depth + 1 });
        }

        let ammoName = null;
        if (Array.isArray(w.ammunition) && w.ammunition.length > 0) ammoName = w.ammunition[0]?.type ?? null;
        if (!ammoName && typeof w.ammo === 'string' && w.ammo.length > 0) ammoName = w.ammo;
        if (ammoName && !visited.has(ammoName)) {
            visited.add(ammoName);
            const ammo = lookupOutfit(ammoName, pluginId);
            if (ammo?.weapon) queue.push({ weapon: ammo.weapon, outfit: ammo, title: `Ammo: ${ammoName}`, multiplier, depth: depth + 1 });
        }
    }

    let totalDps = null;
    if (sections.length > 1 && rootSps > 0) {
        totalDps = {};
        for (const [k, v] of Object.entries(totalDamage)) if (v !== 0) totalDps[k] = v * rootSps;
    }

    return { sections, totalDamagePerShot: totalDamage, totalDps, rootSps, hasChain: sections.length > 1 };
}

// ── Fleet-level & per-outfit weapon DPS via WeaponStats ───────────────────

function getShipWeaponData(item, outfitIdx) {
    if (!window.WeaponStats) return null;
    const outfitMap = {};
    for (const [name, count] of outfitEntries(item.outfitMap || item.outfits || {}))
        if (name) outfitMap[name] = (outfitMap[name] || 0) + count;
    try { return window.WeaponStats.getShipWeaponStats({ outfits: outfitMap }, outfitIdx); }
    catch (_) { return null; }
}

function getOutfitWeaponProfile(outfit, outfitIdx) {
    if (!window.WeaponStats || !outfit?.weapon) return null;
    try { return window.WeaponStats.getOutfitWeaponStats(outfit, outfitIdx); }
    catch (_) { return null; }
}

// Fleet-summary rows (Total/Shield/Hull DPS, per-type DPS, ammo consumption)
function getWeaponSummaryRows(wData) {
    if (!wData || !wData.weaponCount) return [];
    const rows = [];
    const push = (key, label, raw, unit) => rows.push({
        key, label, raw, value: fmtNum(raw), unit, section: 'Weapon DPS',
        source: SOURCE.WEAPON_DPS, scalesWithQty: true, lowerBetter: false,
    });
    push('_ws_totalDps', 'Total DPS', wData.totalDps, 'dmg/s');
    push('_ws_shieldDps', 'Shield DPS', wData.shieldDps, 'dmg/s');
    push('_ws_hullDps', 'Hull DPS', wData.hullDps, 'dmg/s');
    rows.push({ key: '_ws_weaponCount', label: 'Weapon Types', raw: wData.weaponCount, value: String(wData.weaponCount), unit: '',
        section: 'Weapon DPS', source: SOURCE.WEAPON_DPS, scalesWithQty: false, lowerBetter: false });
    rows.push({ key: '_ws_totalMounts', label: 'Total Mounts', raw: wData.totalWeaponMounts, value: String(wData.totalWeaponMounts), unit: '',
        section: 'Weapon DPS', source: SOURCE.WEAPON_DPS, scalesWithQty: true, lowerBetter: false });
    for (const [dmgKey, val] of Object.entries(wData.dpsByType || {}).sort())
        if (val) push(`_ws_dps_${dmgKey.replace(/\s+/g, '_')}`, labelForKey(dmgKey.replace(/ damage$/, '')) + ' DPS', val, 'dmg/s');
    if (wData.hasAmmoWeapons)
        for (const a of (wData.ammoRequired || []))
            rows.push({
                key: `_ammo_${a.ammoOutfitName}`, label: a.ammoOutfitName, raw: a.totalShotsPerSecond,
                value: fmtNum(a.totalShotsPerSecond), unit: 'rounds/s', section: 'Ammo Consumption',
                source: SOURCE.WEAPON_DPS, scalesWithQty: true, lowerBetter: false,
            });
    return rows;
}

// Per-outfit unscaled (count=1, qty=1) attribute rows for one installed
// outfit — used to build "Outfit: X" detail blocks. `count`/`qty` are only
// used to format the Count row's display text; every other value stays
// per-unit so the caller can rescale for its own display purposes.
function getOutfitDetailRows(attrDefs, outfitName, outfit, count, qty) {
    count = count || 1; qty = qty || 1;
    const skip = new Set([
        'name','display name','description','sprite','thumbnail','spriteData',
        '_pluginId','_internalId','_compareTab','_hash','_variantPluginId',
        'locations','governments','weapon','outfitMap','outfits',
        'leaks','engines','guns','turrets','bays','reverseEngines','steeringEngines',
    ]);
    const rows = [{ key: '_od_count', label: 'Count', raw: count * qty, value: `×${count * qty}`, unit: '',
        section: `Outfit: ${outfitName}`, source: SOURCE.OUTFIT_DETAIL, scalesWithQty: false, lowerBetter: false }];

    const src = (outfit.attributes && Object.keys(outfit.attributes).length) ? { ...outfit, ...outfit.attributes } : outfit;
    const attrRows = getRawAttributeRows(attrDefs, src, { skip }).map(r => ({
        ...r, key: `_od_${r.key}`, section: `Outfit: ${outfitName}`, source: SOURCE.OUTFIT_DETAIL,
    }));
    attrRows.sort((a, b) => a.label.localeCompare(b.label));
    rows.push(...attrRows);

    if (window.ComputedStats?.isReady()) {
        try {
            const flat = {};
            for (const [k, v] of Object.entries(src)) if (typeof v === 'number') flat[k] = v;
            const outfitAttrKeys = new Set(Object.keys(flat));
            const computed = window.ComputedStats.getComputedStatsForAttrs(flat);
            filterComputedStats(computed, outfitAttrKeys, false, attrDefs);
            const computedRows = getComputedStatRows(attrDefs, computed, `Outfit: ${outfitName}`)
                .map(r => ({ ...r, key: `_od_${r.key}` }));
            if (computedRows.length) {
                rows.push({ key: '_od_div', label: '— Computed /s —', raw: null, value: '', unit: '', section: `Outfit: ${outfitName}`, source: SOURCE.OUTFIT_DETAIL, isDivider: true });
                rows.push(...computedRows);
            }
        } catch (_) {}
    }
    return rows;
}

// Per-weapon unscaled detail rows — mirrors getOutfitDetailRows but also
// includes the weapon sub-object's raw stats and per-second DPS/costs.
function getWeaponDetailRows(attrDefs, outfitName, outfit, profile, count, qty) {
    count = count || 1; qty = qty || 1;
    const w = outfit.weapon || {};
    const sps = profile.shotsPerSecond || 0;
    const section = `Weapon: ${outfitName}`;
    const rows = [{ key: '_wd_count', label: 'Count', raw: count * qty, value: `×${count * qty}`, unit: '',
        section, source: SOURCE.WEAPON_DETAIL, scalesWithQty: false, lowerBetter: false }];

    const outfitAttrSkip = new Set([
        'name','display name','description','sprite','thumbnail','spriteData',
        '_pluginId','_internalId','_compareTab','_hash','_variantPluginId',
        'locations','governments','weapon','outfitMap','outfits',
        'leaks','engines','guns','turrets','bays','reverseEngines','steeringEngines',
    ]);
    const src = (outfit.attributes && Object.keys(outfit.attributes).length) ? { ...outfit, ...outfit.attributes } : outfit;
    const flatRows = getRawAttributeRows(attrDefs, src, { skip: outfitAttrSkip })
        .map(r => ({ ...r, key: `_wd_${r.key}`, section, source: SOURCE.WEAPON_DETAIL }));
    flatRows.sort((a, b) => a.label.localeCompare(b.label));
    rows.push(...flatRows);

    const weapSkip = new Set(['sprite','spriteData','sound','hit effect','fire effect',
        'die effect','live effect','submunition','submunitions','stream','cluster',
        'hardpoint sprite','hardpoint offset','icon','ammunition','ammo']);
    rows.push({ key: '_wd_div1', label: '— Weapon Stats —', raw: null, value: '', unit: '', section, source: SOURCE.WEAPON_DETAIL, isDivider: true });
    for (const [key, val] of Object.entries(w).sort((a, b) => a[0].localeCompare(b[0]))) {
        const lk = key.toLowerCase();
        if (weapSkip.has(lk) || lk.startsWith('firing ') || lk.endsWith(' damage')) continue;
        if (val === null || val === undefined) continue;
        let display = null, raw = null, rawUnscaled = null;
        if (typeof val === 'boolean') { display = val ? '✓' : '✗'; raw = val ? 1 : 0; rawUnscaled = raw; }
        else if (typeof val === 'number' && val !== 0) {
            const rec = getAttrRecord(attrDefs, key);
            raw = val * (rec?.displayMultiplier ?? 1); rawUnscaled = val; display = fmtNum(raw);
        } else if (typeof val === 'string' && val.trim()) display = val.trim();
        else if (Array.isArray(val) && val.length) display = val.map(el => typeof el === 'object' ? (el.type ?? el.name ?? JSON.stringify(el)) : String(el)).join(', ');
        else if (typeof val === 'object' && val) display = val.type ?? val.name ?? JSON.stringify(val);
        if (display === null) continue;
        rows.push({ key: `_wd_w_${key}`, label: labelForKey(key), raw, rawUnscaled, value: display,
            unit: getAttrRecord(attrDefs, key)?.displayUnit ?? '', section, source: SOURCE.WEAPON_DETAIL, scalesWithQty: false, lowerBetter: false });
    }

    rows.push({ key: '_wd_div2', label: '— Per Second —', raw: null, value: '', unit: '', section, source: SOURCE.WEAPON_DETAIL, isDivider: true });
    rows.push({ key: '_wd_sps', label: 'Shots/s', raw: sps, value: fmtNum(sps), unit: '', section, source: SOURCE.WEAPON_DETAIL, scalesWithQty: false, lowerBetter: false });
    if (profile.effectiveRange)
        rows.push({ key: '_wd_range', label: 'Range', raw: profile.effectiveRange, value: fmtNum(profile.effectiveRange), unit: 'px', section, source: SOURCE.WEAPON_DETAIL, scalesWithQty: false, lowerBetter: false });
    for (const [dmgKey, dps] of Object.entries(profile.dpsBreakdown || {}).sort())
        if (dps) rows.push({ key: `_wd_dps_${dmgKey}`, label: labelForKey(dmgKey.replace(/ damage$/, '')) + ' DPS', raw: dps, value: fmtNum(dps), unit: 'dmg/s', section, source: SOURCE.WEAPON_DETAIL, scalesWithQty: true, lowerBetter: false });
    for (const [costKey, costVal] of Object.entries(profile.firingCosts || {}).sort())
        if (costVal) {
            const rec = getAttrRecord(attrDefs, costKey);
            const raw = costVal * profile.shotsPerSecond * (rec?.displayMultiplier ?? 1);
            // rawUnscaled here is the per-shot cost as stored on the weapon
            // (before the ×shots/s×displayMultiplier that turns it into the
            // "/s" figure shown) — the most useful "raw" reading for this row.
            rows.push({ key: `_wd_cost_${costKey}`, label: labelForKey(costKey.replace(/^firing /, '')) + '/s', raw, rawUnscaled: costVal, value: fmtNum(raw),
                unit: rec?.displayUnit ?? '', section, source: SOURCE.WEAPON_DETAIL, scalesWithQty: true, lowerBetter: true });
        }

    if (window.ComputedStats?.isReady()) {
        try {
            const flat = {};
            for (const [k, v] of Object.entries(src)) if (typeof v === 'number') flat[k] = v;
            const computed = window.ComputedStats.getComputedStatsForAttrs(flat);
            const computedRows = getComputedStatRows(attrDefs, computed, section).map(r => ({ ...r, key: `_wd_${r.key}` }));
            if (computedRows.length) {
                rows.push({ key: '_wd_div3', label: '— Computed /s —', raw: null, value: '', unit: '', section, source: SOURCE.WEAPON_DETAIL, isDivider: true });
                rows.push(...computedRows);
            }
        } catch (_) {}
    }
    return rows;
}

// ─────────────────────────────────────────────────────────────────────────
//  window.ComputedStats OUTPUT  →  classified rows
// ─────────────────────────────────────────────────────────────────────────

const COMPUTED_SKIP = new Set(['_ws_hasAmmoWeapons', '_totalOutfits']);

// Filters a computed-stats map in place down to keys whose driving raw
// attributes are actually present on THIS item (window.ComputedStats
// evaluates every formula generically, defaulting missing attrs to 0).
// Resolves any computed-stat key to the list of raw attribute keys its
// formula actually references, regardless of which of the (currently 4)
// underlying sources produced it. This is the ONE place that knowledge
// lives — filterComputedStats below just asks "does the ship/outfit have
// any of these?" using effectiveAttrKeys (already the full ship+outfits
// union, built by buildEffectiveAttrs before this ever runs). Returns []
// if the key's shape can't be resolved to a formula at all.
function _resolveComputedKeyDependencies(key, attrDefs) {
    const fns     = attrDefs.shipFunctions              || {};
    const intVars = attrDefs.shipDisplay?.intermediateVars || {};
    const table   = attrDefs.shipDisplay?.energyHeatTable  || [];
    const sysF    = attrDefs.systemAwareFormulas           || {};

    if (key.startsWith('_fn_'))
        return fns[key.slice(4)]?.attributesRead || [];

    if (key.startsWith('_derived_energy_') || key.startsWith('_derived_heat_')) {
        const isEnergy  = key.startsWith('_derived_energy_');
        const safeLabel = key.slice(isEnergy ? '_derived_energy_'.length : '_derived_heat_'.length);
        // Same transform ComputedStats.js uses to BUILD this key from the
        // row's label — matching it here, rather than trying to reverse
        // it, is what makes this lookup correct instead of guessing.
        const row = table.find(r => r.label && r.label.replace(/[^a-zA-Z0-9]/g, '_') === safeLabel);
        if (!row) return [];
        const formula = isEnergy ? row.energyFormula : row.heatFormula;
        return formula ? [...formula.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]) : [];
    }

    if (key.startsWith('_derived_')) {
        const formula = intVars[key.slice('_derived_'.length)];
        return formula ? [...formula.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]) : [];
    }

    if (key.startsWith('_sys_')) {
        const formula = sysF[key.slice(5).replace(/_/g, ' ')]?.formula;
        return formula ? [...formula.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]) : [];
    }

    return []; // not a formula-backed key (_ws_/_total*/_outfitMass) — caller doesn't filter these
}

function filterComputedStats(computed, effectiveAttrKeys, isShip, attrDefs) {
    if (!computed || !effectiveAttrKeys || !attrDefs) return computed;

    for (const k of Object.keys(computed)) {
        const isFormulaBacked = k.startsWith('_fn_') || k.startsWith('_derived_') || k.startsWith('_sys_');
        if (!isFormulaBacked) continue; // _ws_/_total*/_outfitMass: already correctly ungated, leave as-is

        const refs = _resolveComputedKeyDependencies(k, attrDefs);
        if (refs.length === 0) { delete computed[k]; continue; }

        const matchingRefs = refs.filter(a => effectiveAttrKeys.has(a));
        if (matchingRefs.length === 0) { delete computed[k]; continue; }

        // Ship-function keys only, and only for outfits (isShip === false):
        // a pure outfit incidentally sharing ONE attribute name with a
        // ship-aggregate function (Drag, RequiredCrew, InertialMass, ...)
        // shouldn't make that function "relevant" to the outfit — require
        // at least 2 matching reads when the function reads more than 1
        // attribute, same threshold as before.
        if (!isShip && k.startsWith('_fn_') && matchingRefs.length < 2 && refs.length > 1) {
            delete computed[k]; continue;
        }
    }
    return computed;
}

// Turns a raw window.ComputedStats output map into classified rows.
// `sectionOverride`, if given, forces every row into one section (used by
// the per-outfit/per-weapon detail blocks); otherwise each key routes to
// its own canonical AttributeSections bucket.
function getComputedStatRows(attrDefs, computed, sectionOverride) {
    if (!computed) return [];
    const rows = [];
    for (const [k, v] of Object.entries(computed)) {
        if (COMPUTED_SKIP.has(k)) continue;
        if (v === null || v === undefined) continue;
        // Only NaN is excluded here — that means "couldn't be computed at
        // all". A value that computes to exactly 0 (or negative) is kept:
        // relevance (does this ship/outfit even reference this stat at
        // all?) is already decided upstream by filterComputedStats(), on
        // attribute PRESENCE, not on the resulting value — so a stat this
        // item genuinely has, that happens to net to zero or below from
        // combined effects, still shows.
        if (typeof v === 'number' && isNaN(v)) continue;
        if (typeof v === 'object') continue;
        const isComputedKey = k.startsWith('_fn_') || k.startsWith('_derived_') || k.startsWith('_sys_') ||
                               k.startsWith('_ws_') || k.startsWith('_total') || k === '_outfitMass';
        if (!isComputedKey) continue;

        const section = sectionOverride || window.AttributeSections.classifyComputedKey(attrDefs, k);
        let display = v, unit = '';
        if (k.startsWith('_fn_')) {
            const fnName = k.slice(4);
            const scale  = attrDefs?.shipFunctions?.[fnName]?.displayScale;
            display = (typeof scale === 'number' && scale !== 0 && scale !== 1) ? v * scale : v;
            unit = inferFnUnit(attrDefs, fnName);
        } else if (k.startsWith('_derived_energy_')) unit = 'e/s';
        else if (k.startsWith('_derived_heat_'))     unit = 'h/s';
        else if (k.startsWith('_sys_'))               unit = '/s';
        else if (k.startsWith('_ws_') && k.toLowerCase().includes('dps')) unit = 'dmg/s';

        const label = labelForKey(k);
        rows.push({
            key: k, label, raw: display, rawUnscaled: v, value: typeof display === 'number' ? fmtNum(display) : String(display),
            unit, section, source: SOURCE.COMPUTED_STATS, scalesWithQty: true,
            lowerBetter: isLowerBetter(attrDefs, k, label),
        });
    }
    return rows;
}

// ─────────────────────────────────────────────────────────────────────────
//  PER-DIVISOR EFFICIENCY RATIOS (outfits only)
// ─────────────────────────────────────────────────────────────────────────

// "per ton of X" divisors: every capacity attribute the parser knows
// (gameKeys.js — Ship::FinishLoading's can't-be-negative list) plus mass.
const _PER_DIVISOR_FALLBACK = ['outfit space', 'cargo space', 'weapon capacity', 'engine capacity'];
function perDivisorKeys() {
    const caps = window.GameKeys ? window.GameKeys.capacityKeys(_PER_DIVISOR_FALLBACK) : _PER_DIVISOR_FALLBACK;
    return [...caps, 'mass'].map(key => ({ key, label: key.replace(/\b\w/g, c => c.toUpperCase()) }));
}
const PER_DIVISOR_EXCLUDE_NONWEAPON = new Set([]);
const PER_DIVISOR_EXCLUDE_WEAPON    = new Set([]);

function _signedPerDivisor(numerator, ratio) {
    if (ratio === 0 || isNaN(ratio)) return ratio;
    const mag = Math.abs(ratio);
    return numerator < 0 ? -mag : mag;
}

function _effectiveUnit(attrDefs, key) {
    if (key.startsWith('_fn_')) {
        const fnDef = attrDefs?.shipFunctions?.[key.slice(4)];
        return fnDef?.displayUnit || inferFnUnit(attrDefs, key.slice(4));
    }
    if (key.startsWith('_derived_energy_')) return 'e/s';
    if (key.startsWith('_derived_heat_'))   return 'h/s';
    if (key.startsWith('_derived_'))        return '';
    if (key.startsWith('_sys_'))            return '/s';
    return getAttrRecord(attrDefs, key)?.displayUnit ?? '';
}

function _isRatioEligible(attrDefs, key, excludeSet) {
    if (excludeSet.has(key)) return false;
    const rec = getAttrRecord(attrDefs, key);
    if (rec?.isBoolean) return false;
    const unit = _effectiveUnit(attrDefs, key);
    return unit !== '%' && unit !== '%/s';
}

// item: a flat outfit object. weaponProfile: getOutfitWeaponProfile() result, or null.
function getEfficiencyRatioRows(attrDefs, item, weaponProfile) {
    const rows = [];
    const pushRatios = (section, numKey, numLabel, numVal, excludeSet) => {
        if (typeof numVal !== 'number' || !numVal || isNaN(numVal)) return;
        if (!_isRatioEligible(attrDefs, numKey, excludeSet)) return;
        for (const { key: divKey, label: divLabel } of perDivisorKeys()) {
            if (numKey === divKey) continue;
            const divisor = item[divKey];
            if (typeof divisor !== 'number' || divisor === 0) continue;
            const raw = _signedPerDivisor(numVal, numVal / divisor);
            rows.push({
                key: `_pd_${numKey.replace(/\s+/g, '_')}_per_${divKey.replace(/\s+/g, '_')}`,
                label: `${numLabel} per ${divLabel}`, raw, value: fmtNum(raw), unit: '',
                section, source: SOURCE.EFFICIENCY, scalesWithQty: false, lowerBetter: false,
            });
        }
    };

    if (window.ComputedStats?.isReady()) {
        const flat = {};
        for (const [k, v] of Object.entries(item)) if (typeof v === 'number') flat[k] = v;
        const effectiveAttrKeys = new Set(Object.keys(flat));
        let calcStats = {};
        try { calcStats = window.ComputedStats.getComputedStatsForAttrs(flat) || {}; } catch (_) {}
        filterComputedStats(calcStats, effectiveAttrKeys, false, attrDefs);
        for (const [k, v] of Object.entries(calcStats)) {
            if (typeof v !== 'number' || isNaN(v) || v === 0) continue;
            if (!(k.startsWith('_fn_') || k.startsWith('_derived_') || k.startsWith('_sys_'))) continue;
            const mult = getAttrRecord(attrDefs, k)?.displayMultiplier ?? 1;
            pushRatios('Attribute Efficiency', k, labelForKey(k), v * mult, PER_DIVISOR_EXCLUDE_NONWEAPON);
        }
    }

    if (item.weapon && typeof item.weapon === 'object' && weaponProfile) {
        const sps = weaponProfile.shotsPerSecond || 0;
        pushRatios('Weapon Efficiency', 'shots per second', 'Fire Rate', sps, PER_DIVISOR_EXCLUDE_WEAPON);
        pushRatios('Weapon Efficiency', 'total dps', 'Total DPS', weaponProfile.totalDps, PER_DIVISOR_EXCLUDE_WEAPON);
        pushRatios('Weapon Efficiency', 'shield dps', 'Shield DPS', weaponProfile.shieldDps, PER_DIVISOR_EXCLUDE_WEAPON);
        pushRatios('Weapon Efficiency', 'hull dps', 'Hull DPS', weaponProfile.hullDps, PER_DIVISOR_EXCLUDE_WEAPON);
        for (const [dmgKey, dps] of Object.entries(weaponProfile.dpsBreakdown || {})) {
            if (dmgKey === 'shield damage' || dmgKey === 'hull damage') continue;
            pushRatios('Weapon Efficiency', `dps_${dmgKey}`, labelForKey(dmgKey.replace(/ damage$/, '')) + ' DPS', dps, PER_DIVISOR_EXCLUDE_WEAPON);
        }
        for (const [costKey, costVal] of Object.entries(weaponProfile.firingCosts || {})) {
            const mult = getAttrRecord(attrDefs, costKey)?.displayMultiplier ?? 1;
            pushRatios('Weapon Efficiency', costKey, labelForKey(costKey.replace(/^firing /, '')) + '/s', costVal * sps * mult, PER_DIVISOR_EXCLUDE_WEAPON);
        }
        if (weaponProfile.hasAmmo && sps)
            pushRatios('Weapon Efficiency', 'ammo consumption', 'Ammo Consumption', (weaponProfile.ammoPerShot || 1) * sps, PER_DIVISOR_EXCLUDE_WEAPON);
    }
    return rows;
}

// ─────────────────────────────────────────────────────────────────────────
//  STACKING NOTES
// ─────────────────────────────────────────────────────────────────────────

function getStackingNotes(attrDefs, item) {
    const notes = [];
    for (const [key] of Object.entries(item)) {
        const stacking = getStacking(attrDefs, key);
        if (!stacking?.rule || stacking.rule === 'additive') continue;
        notes.push({ key, label: labelForKey(key), rule: stacking.rule, description: stacking.description || '' });
    }
    return notes;
}

// ─────────────────────────────────────────────────────────────────────────
//  TOP-LEVEL ORCHESTRATORS
// ─────────────────────────────────────────────────────────────────────────

// Full stat resolution for a ship or variant.
// opts: { includeOutfits: bool (default true), pluginId }
function getShipStats(item, attrDefs, pluginId, opts) {
    opts = opts || {};
    const includeOutfits = opts.includeOutfits !== false;
    const outfitIdx = includeOutfits ? buildOutfitIndex() : null;
    const eff = buildEffectiveAttrs(item, outfitIdx);
    const effectiveAttrKeys = new Set(Object.keys(eff));

    const rows = [];
    rows.push(...getRawAttributeRows(attrDefs, eff));
    rows.push(...getHardpointRows(item));
    rows.push(...getHeatDerivedRows(item, eff, outfitIdx));
    rows.push(...getUniqueDerivedRows(attrDefs, eff));
    rows.push(...getWearOffRows(eff));

    let weaponData = null;
    const outfitDetailSections = {}; // sectionName -> rows[]

    if (includeOutfits) {
        weaponData = getShipWeaponData(item, outfitIdx);
        if (weaponData) {
            rows.push(...getWeaponSummaryRows(weaponData));
            for (const w of (weaponData.weapons || [])) {
                const outfit = outfitIdx[w.outfitName];
                if (!outfit?.weapon) continue;
                outfitDetailSections[`Weapon: ${w.outfitName}`] =
                    getWeaponDetailRows(attrDefs, w.outfitName, outfit, w.profile, w.count, 1);
            }
        }
        const outfitEntriesList = outfitEntries(item.outfitMap || item.outfits || {}).sort((a, b) => a[0].localeCompare(b[0]));
        for (const [outfitName, count] of outfitEntriesList) {
            if (!outfitName) continue;
            const outfit = outfitIdx[outfitName];
            if (!outfit || (outfit.weapon && typeof outfit.weapon === 'object')) continue;
            outfitDetailSections[`Outfit: ${outfitName}`] = getOutfitDetailRows(attrDefs, outfitName, outfit, count, 1);
        }
    }

    if (window.ComputedStats?.isReady() && pluginId) {
        const computed = window.ComputedStats.getComputedStats(item, pluginId);
        filterComputedStats(computed, effectiveAttrKeys, true, attrDefs);
        rows.push(...getComputedStatRows(attrDefs, computed));
    }

    const outfitContribRows = includeOutfits ? getOutfitContributionRows(attrDefs, item, pluginId) : [];

    return {
        isShip: true, rows: tidyRows(attrDefs, rows), outfitDetailSections, outfitContribRows,
        effectiveAttrs: eff, weaponData, includeOutfits,
    };
}

// One pass shared by everything that shows ship stats:
//  • a computed row that landed in a catch-all section ("Special", "Derived
//    Stats", "Other") goes where an attribute of the same name would;
//  • the same stat arriving twice (raw + computed copy, "Required crew" /
//    "Required Crew", "Hull DPS" twice) is shown once — the first wins, and raw
//    attributes come first;
//  • a computed row with exactly the same value as another computed row in its
//    section is the same thing under another name ("Max Heat" = "Total Heat
//    Capacity").
function tidyRows(attrDefs, rows) {
    const norm = l => String(l).toLowerCase().replace(/[^a-z0-9]/g, '');
    const seen = new Set(), seenValue = new Set(), out = [];
    for (let row of rows) {
        const computed = row.source !== SOURCE.RAW && row.source !== SOURCE.HARDPOINT;
        if (computed && ['Special', 'Derived Stats', 'Other'].includes(row.section)) {
            const s = window.AttributeSections.classify(attrDefs, String(row.label).toLowerCase());
            if (s && s !== 'Other') row = { ...row, section: s };
        }
        const k = norm(row.label);
        if (seen.has(k)) continue;
        const vk = `${row.section}|${row.value}|${row.unit || ''}`;
        if (computed && seenValue.has(vk)) continue;
        seen.add(k);
        seenValue.add(vk);
        out.push(row);
    }
    return out;
}

// Full stat resolution for a standalone outfit.
function getOutfitStats(item, attrDefs, pluginId) {
    const skip = new Set([
        'name','display name','description','thumbnail','sprite','hardpointSprite',
        'hardpoint sprite','steering flare sprite','flare sprite',
        'reverse flare sprite','afterburner effect','projectile','weapon',
        'spriteData','_internalId','_pluginId','_hash','governments',
        '_variantPluginId','licenses',
    ]);
    // Outfits may store their gameplay attributes nested under
    // item.attributes (same shape as ships) OR flat on the object itself,
    // same ambiguity handled everywhere else in this file (see
    // buildEffectiveAttrs, computeOutfitContributions, getOutfitDetailRows).
    // Reading `item` directly here — the previous behaviour — silently
    // dropped every attribute whenever the nested shape was used, since
    // `typeof item.attributes === 'object'` caused getRawAttributeRows to
    // skip it entirely, leaving only whatever weapon/computed data could
    // be derived from item's own top-level fields.
    const src = (item.attributes && Object.keys(item.attributes).length)
        ? { ...item, ...item.attributes } : item;
    const rows = getRawAttributeRows(attrDefs, src, { skip });

    if (item.licenses && typeof item.licenses === 'object')
        rows.push({ key: '_licenses', label: 'Licenses', raw: null,
            value: Object.keys(item.licenses).join(', '), unit: '', section: 'General',
            source: SOURCE.RAW, scalesWithQty: false, lowerBetter: false });

    const outfitIdx = buildOutfitIndex();
    let weaponChain = null, weaponProfile = null;
    if (item.weapon && typeof item.weapon === 'object') {
        weaponChain = getWeaponChainData(attrDefs, item.weapon, pluginId);
        weaponProfile = getOutfitWeaponProfile(item, outfitIdx);
        if (weaponProfile) {
            const dS = 'Weapon DPS';
            const push = (key, label, raw, unit, lowerBetter) => { if (raw) rows.push({
                key, label, raw, value: fmtNum(raw), unit, section: dS, source: SOURCE.WEAPON_DPS,
                scalesWithQty: true, lowerBetter: !!lowerBetter,
            }); };
            push('_ws_totalDps', 'Total DPS', weaponProfile.totalDps, 'dmg/s');
            push('_ws_shieldDps', 'Shield DPS', weaponProfile.shieldDps, 'dmg/s');
            push('_ws_hullDps', 'Hull DPS', weaponProfile.hullDps, 'dmg/s');
            if (weaponProfile.effectiveRange) rows.push({ key: '_ws_range', label: 'Range', raw: weaponProfile.effectiveRange,
                value: fmtNum(weaponProfile.effectiveRange), unit: 'px', section: dS, source: SOURCE.WEAPON_DPS, scalesWithQty: false, lowerBetter: false });
            if (weaponProfile.shotsPerSecond) rows.push({ key: '_ws_sps', label: 'Fire Rate', raw: weaponProfile.shotsPerSecond,
                value: fmtNum(weaponProfile.shotsPerSecond), unit: 'shots/s', section: dS, source: SOURCE.WEAPON_DPS, scalesWithQty: true, lowerBetter: false });
            for (const [dmgKey, dps] of Object.entries(weaponProfile.dpsBreakdown || {}).sort())
                if (dps && dmgKey !== 'shield damage' && dmgKey !== 'hull damage')
                    push(`_ws_dps_${dmgKey.replace(/\s+/g, '_')}`, labelForKey(dmgKey.replace(/ damage$/, '')) + ' DPS', dps, 'dmg/s');
            for (const [costKey, costVal] of Object.entries(weaponProfile.firingCosts || {}).sort())
                if (costVal) {
                    const rec = getAttrRecord(attrDefs, costKey);
                    push(`_ws_cost_${costKey}`, labelForKey(costKey.replace(/^firing /, '')) + '/s',
                        costVal * weaponProfile.shotsPerSecond * (rec?.displayMultiplier ?? 1), rec?.displayUnit ?? '', true);
                }
        }
    }

    // Same nested-vs-flat ambiguity as above — use `src` (the flattened
    // view) so ratios and computed stats see the real gameplay attributes
    // (mass, outfit space, etc.) regardless of which shape this outfit uses.
    const efficiencyRows = getEfficiencyRatioRows(attrDefs, src, weaponProfile);

    if (window.ComputedStats?.isReady()) {
        const OUTFIT_META_SKIP = new Set(['name','category','series','index','cost','thumbnail','sprite',
            'description','pluginId','governments','locations','_internalId','_pluginId','_hash']);
        const flat = {};
        for (const [k, v] of Object.entries(src)) { if (!OUTFIT_META_SKIP.has(k) && typeof v === 'number') flat[k] = v; }
        const effectiveAttrKeys = new Set(Object.keys(flat));
        const computed = window.ComputedStats.getComputedStatsForAttrs(flat);
        filterComputedStats(computed, effectiveAttrKeys, false, attrDefs);
        rows.push(...getComputedStatRows(attrDefs, computed));
    }

    const stackingNotes = getStackingNotes(attrDefs, src);

    return { isShip: false, rows, weaponChain, weaponProfile, efficiencyRows, stackingNotes };
}

// Full stat resolution for an effect item.
function getEffectStats(item, attrDefs) {
    const skip = new Set(['name', 'description', 'sprite', 'spriteData']);
    const rows = getRawAttributeRows(attrDefs, item, { skip });

    const effectAttrs = {};
    for (const { damageKey } of statusEffectDecay()) {
        const val = parseFloat(item[damageKey] ?? 0);
        if (val) effectAttrs[damageKey] = val;
    }
    const doseRows = Object.entries(effectAttrs).map(([k, v]) => {
        const label = statusEffectDecay().find(e => e.damageKey === k)?.label ?? k;
        return {
            key: `_dose_${k}`, label: `${label} dose`, raw: v, value: fmtNum(v), unit: 'units',
            section: 'Status Effect Doses', source: SOURCE.WEAR_OFF, scalesWithQty: false, lowerBetter: false,
            tooltip: `Wear-off time depends on target ship's ${k.replace('damage', 'resistance')}`,
        };
    });

    return { isShip: false, rows, doseRows };
}

// ─────────────────────────────────────────────────────────────────────────
//  PUBLIC EXPORT
// ─────────────────────────────────────────────────────────────────────────

window.ItemStats = {
    SOURCE,
    fmtNum, labelForKey, getAttrRecord, getSection, getStacking, tooltipParts,
    isShipItem, isLowerBetter, scalesWithQtyFor,
    isEnhancedDetailsEnabled, setEnhancedDetailsEnabled, toggleEnhancedDetails, formatRowDisplay,
    buildOutfitIndex, outfitEntries, lookupOutfit,
    buildEffectiveAttrs, computeOutfitContributions, getOutfitContributionRows,
    getRawAttributeRows, getHardpointRows, getHeatDerivedRows,
    calcDerivedStats, getUniqueDerivedRows,
    calcEffectWearOffTimes, calcWeaponEffectDuration, getWearOffRows,
    calcWeaponDerived, getWeaponChainData,
    getShipWeaponData, getOutfitWeaponProfile, getWeaponSummaryRows,
    getOutfitDetailRows, getWeaponDetailRows,
    filterComputedStats, getComputedStatRows, _resolveComputedKeyDependencies,
    getEfficiencyRatioRows, getStackingNotes,
    getShipStats,
    tidyRows,
    isFlagAttribute, getOutfitStats, getEffectStats,
};

})();
