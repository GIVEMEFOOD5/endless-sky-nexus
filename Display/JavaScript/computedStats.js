;(function () {
'use strict';

// Works out ship and outfit stats from the game's own formulas (via the attribute definitions). Used by ItemStats, the sorters and the battle sim.

// ── state ──
let _attrDefs = null;
let _cache    = {};
let _ready    = false;
let _knownDisplayFns = null;
let _byIdIndexCache  = null; // NEW: internalId -> outfit, across ALL loaded plugins

// ── plugin / outfit index ──
let _pluginOrder  = null;
let _indexBaseUrl = null;

// start once the attribute definitions are loaded. Called by: the pages that use it, on load

function init(attrDefs, baseUrl) {
    _attrDefs        = attrDefs;
    _cache           = {};
    _knownDisplayFns = null;
    _byIdIndexCache  = null;
    _ready           = !!_attrDefs;
    if (baseUrl) _ensurePluginOrder(baseUrl);
    if (_ready)
        console.log('[ComputedStats] Ready.');
    else
        console.warn('[ComputedStats] init called without attrDefs.');
}

// are the attribute definitions loaded? Called by: ItemStats and anything that needs computed stats
function isReady() { return _ready; }

// forget cached results (e.g. after the builder changes a ship). Called by: shipBuilderStats

function clearCache() {
    _cache = {};
    _byIdIndexCache = null; // NEW
    const allData = window.allData || {};
    for (const [, pluginData] of Object.entries(allData)) {
        for (const key of Object.keys(pluginData)) {
            if (key.startsWith('_mergedOutfitIndex_')) delete pluginData[key];
        }
    }
}

// plugin order, so the right plugin wins when two define the same outfit. Called by: init

async function _ensurePluginOrder(baseUrl) {
    if (_pluginOrder) return;
    _indexBaseUrl = baseUrl;
    try {
        const { data, error } = await window.supabaseClient
            .from('plugins').select('output_name').order('source_priority', { ascending: true });
        _pluginOrder = (!error && data) ? data.map(r => r.output_name) : [];
    } catch (_) { _pluginOrder = []; }
}

// outfit index for one plugin. Called by: _getOutfitIndex
function _buildSinglePluginIndex(pluginId) {
    const pluginData = window.allData?.[pluginId];
    if (!pluginData) return {};
    if (!pluginData._outfitIndex) {
        pluginData._outfitIndex = {};
        (pluginData.outfits || []).forEach(o => { if (o.name) pluginData._outfitIndex[o.name] = o; });
    }
    return pluginData._outfitIndex;
}

// merged outfit index (selected plugins, priority order). Called by: getComputedStats, antiMissileAnalysis
function _getOutfitIndex(pluginId) {
    // selected plugins only — outfits from plugins that aren't switched on don't exist in-game
    const allData    = (window.DataLoader && typeof window.DataLoader.getActiveData === 'function' ? window.DataLoader.getActiveData() : (window.allData || {}));
    const cacheKey   = `_mergedOutfitIndex_${pluginId}`;
    const pluginData = (window.allData || {})[pluginId];
    if (pluginData?.[cacheKey]) return pluginData[cacheKey];
    const merged       = {};
    const order        = _pluginOrder || [];
    const allPluginIds = Object.keys(allData);
    const searchOrder  = [
        ...(allData[pluginId] ? [pluginId] : []),
        ...order.filter(id => id !== pluginId && allData[id]),
        ...allPluginIds.filter(id => id !== pluginId && !order.includes(id)),
    ];
    for (const pid of searchOrder) {
        const idx = _buildSinglePluginIndex(pid);
        for (const [name, outfit] of Object.entries(idx))
            if (!(name in merged)) merged[name] = outfit;
    }
    if (pluginData) pluginData[cacheKey] = merged;
    return merged;
}

// internal id → outfit across every loaded plugin (cached). Called by: getComputedStats
function _getOutfitIndexById() {
    if (_byIdIndexCache) return _byIdIndexCache;
    const allData = (window.DataLoader && typeof window.DataLoader.getActiveData === 'function' ? window.DataLoader.getActiveData() : (window.allData || {}));
    const byId = {};
    for (const [pid, pluginData] of Object.entries(allData)) {
        for (const outfit of (pluginData.outfits || [])) {
            if (!outfit.name) continue;
            const internalId = outfit.internalId || outfit._internalId || `${pid}::${outfit.name}`;
            byId[internalId] = outfit;
        }
    }
    _byIdIndexCache = byId;
    return byId;
}

// find an outfit, preferring the exact plugin it's recorded from. Called by: _accumulateOutfits
function _resolveOutfitScoped(entry, byIdIndex, mergedIdx) {
    const { name, pluginId, internalId } = entry;
    const idKey = internalId || (pluginId ? `${pluginId}::${name}` : null);
    if (idKey && byIdIndex && byIdIndex[idKey]) return byIdIndex[idKey];
    if (pluginId) {
        const active = window.DataLoader?.getActivePluginIds ? window.DataLoader.getActivePluginIds() : null;
        const pluginData = (!active || active.has(pluginId)) ? window.allData?.[pluginId] : null;
        const found = (pluginData?.outfits || []).find(o => o.name === name);
        if (found) return found;
    }
    return (mergedIdx && mergedIdx[name]) || null;
}

// outfit map or list → one consistent list. Called by: _accumulateOutfits
function _normaliseOutfitEntries(outfitSource) {
    if (!outfitSource) return [];
    const entries = [];
    if (Array.isArray(outfitSource)) {
        for (const o of outfitSource) {
            if (!o) continue;
            const name = (o.name || '').replace(/^"([^"]*)"$/, '$1');
            if (!name) continue;
            entries.push({
                name,
                qty: parseInt(o.count) || 1,
                pluginId: o.pluginId || null,
                internalId: o.internalId || null,
            });
        }
        return entries;
    }
    for (const [key, val] of Object.entries(outfitSource)) {
        const name = key.replace(/^"([^"]*)"$/, '$1');
        if (!name) continue;
        if (typeof val === 'object' && val !== null) {
            entries.push({
                name,
                qty: parseInt(val.count) || 1,
                pluginId: val.pluginId || null,
                internalId: val.internalId || null,
            });
        } else {
            entries.push({ name, qty: Number(val) || 1, pluginId: null, internalId: null });
        }
    }
    return entries;
}

// game functions already shown elsewhere. Called by: _shouldSuppressFn

function _getKnownDisplayFns() {
    if (_knownDisplayFns) return _knownDisplayFns;
    _knownDisplayFns = new Set();
    const fns = _attrDefs?.shipFunctions || {};
    for (const [name, fn] of Object.entries(fns)) {
        if (
            fn.attributesRead?.length &&
            fn.formulas?.length &&
            (fn.displayScale ?? 1) > 1 &&
            !/^(bool|void|string|const string|shared_ptr|vector|map|set|pair|.*[*&])/.test(fn.returnType || '')
        ) {
            _knownDisplayFns.add(name);
        }
    }
    return _knownDisplayFns;
}

// skip game functions not worth showing. Called by: _resolveDerivedValues, getComputedSorterFields
function _shouldSuppressFn(fnName, fnData) {
    const ret     = (fnData.returnType || '').trim();
    const attrs   = fnData.attributesRead || [];
    const formula = fnData.formulas?.[fnData.formulas.length - 1]?.formula ?? '';

    if (/^(bool|void|string|const string|shared_ptr|vector|map|set|pair|.*[*&])/.test(ret)) return true;
    if (!fnData.formulas?.length) return true;
    if (!attrs.length) {
        const displayFns    = _getKnownDisplayFns();
        const callsDisplayFn = [...displayFns].some(fn => formula.includes(`${fn}(`));
        if (!callsDisplayFn) return true;
    }
    if (formula.includes('min(1.'))                                      return true;
    if (formula.includes('/ maximum'))                                   return true;
    if (formula && !formula.includes('[') && !formula.includes('(') &&
        /^\w+$/.test(formula.trim()))                                    return true;
    if (/^0[.\s]*$/.test(formula.trim()))                                return true;
    if (formula.includes('>= mass') && formula.includes('/ mass'))      return true;
    if (formula.includes('sqrt(') && attrs.length === 1 &&
        attrs[0].includes('cargo'))                                      return true;
    return false;
}

// skip intermediate values not worth showing

function _shouldSuppressIntermediateVar(varName, formula) {
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

// evaluate one game formula with these attributes. Called by: _resolveLocalVars, _resolveShipFunctions, _resolveDerivedValues

function _evalFormula(formulaStr, attrs, resolvedFns, localVars, solarPower) {
    if (!formulaStr || typeof formulaStr !== 'string') return NaN;
    const solar = (typeof solarPower === 'number' && !isNaN(solarPower)) ? solarPower : 1.0;

    try {
        let js = formulaStr;

        js = js.replace(/\[([^\]]+)\]/g, (_, k) => {
            const v = parseFloat((attrs || {})[k] ?? 0);
            return isNaN(v) ? '0' : String(v);
        });

        for (const [fn, val] of Object.entries(resolvedFns || {})) {
            const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            js = js.replace(new RegExp('\\b' + escaped + '\\s*\\(\\s*\\)', 'g'), '(' + String(val) + ')');
        }

        if (localVars && Object.keys(localVars).length > 0) {
            const sorted = Object.entries(localVars).sort((a, b) => b[0].length - a[0].length);
            for (const [varName, val] of sorted) {
                const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                js = js.replace(
                    new RegExp('\\b' + escaped + '\\b(?!\\s*[\\[(])', 'g'),
                    '(' + String(val) + ')'
                );
            }
        }

        js = js.replace(/\b(max|min)<[^>]+>\s*\(/g, '__MATH_$1__(');
        js = js.replace(/static_cast<[^>]+>\s*\(([^)]+)\)/g, '($1)');

        const massVal = String(parseFloat((attrs || {})['mass'] ?? 0));
        const eCap    = String(parseFloat((attrs || {})['energy capacity'] ?? 0));
        const fCap    = String(parseFloat((attrs || {})['fuel capacity'] ?? 0));
        const coolEff = resolvedFns?.['CoolingEfficiency'] != null
                          ? String(resolvedFns['CoolingEfficiency']) : '1';
        const minHull = String(
            parseFloat((attrs || {})['threshold percentage'] ?? 0) *
            parseFloat((attrs || {})['hull'] ?? 0)
        );

        js = js
            .replace(/\bMAXIMUM_TEMPERATURE\b/g,  '100')
            .replace(/numeric_limits<[^>]+>::max\(\)/g, '1e308')
            .replace(/cargo\.Used\(\)/g,           '0')
            .replace(/attributes\.Mass\(\)/g,      massVal)
            .replace(/\bcarriedMass\b/g,           '0')
            .replace(/(?<![[\w])\bmass\b(?!["\]\w])/g, massVal)
            .replace(/\bsolar_power\b/g,           String(solar))
            .replace(/\bwithAfterburner\b/g,       '0')
            .replace(/\bslowness\b/g,              '0')
            .replace(/\bdisruption\b/g,            '0')
            .replace(/\bionization\b/g,            '0')
            .replace(/\bscrambling\b/g,            '0')
            .replace(/\bhullDelay\b/g,             '0')
            .replace(/\bshieldDelay\b/g,           '0')
            .replace(/\bminimumHull\b/g,           minHull)
            .replace(/\bcoolingEfficiency\b/g,     coolEff);

        js = js
            .replace(/(?<![a-zA-Z\[])\benergy\b(?!\s*(capacity|generation|consumption|protection|damage|multiplier|[a-zA-Z\]]))/g, eCap)
            .replace(/(?<![a-zA-Z\[])\bfuel\b(?!\s*(capacity|generation|consumption|protection|damage|energy|heat|[a-zA-Z\]]))/g, fCap);

        js = js
            .replace(/\bMax\s*\(/g,   'Math.max(')
            .replace(/\bmin\s*\(/g,   'Math.min(')
            .replace(/\bmax\s*\(/g,   'Math.max(')
            .replace(/\bexp\s*\(/g,   'Math.exp(')
            .replace(/\bfloor\s*\(/g, 'Math.floor(')
            .replace(/\bsqrt\s*\(/g,  'Math.sqrt(')
            .replace(/\babs\s*\(/g,   'Math.abs(')
            .replace(/\bpow\s*\(/g,   'Math.pow(')
            .replace(/\blog\s*\(/g,   'Math.log(');

        js = js.replace(/\b(?!Math\b)[A-Za-z_][A-Za-z0-9_:]*(?:->|\.)[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)/g, '0');
        js = js.replace(/\b(?!Math\b)[A-Z][a-zA-Z]+\s*\(\s*\)/g, '0');
        js = js.replace(/\b(?!Math\b|return\b|true\b|false\b|Infinity\b)[a-z][a-zA-Z_]*\b(?!\s*[\[(])/g, '0');

        js = js.replace(/__MATH_(max|min)__\(/g, 'Math.$1(');

        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + js + ');')();
        return typeof result === 'number' && isFinite(result) ? result : NaN;
    } catch (_) {
        return NaN;
    }
}

// work out the local variables a formula uses. Called by: _evalFormula

function _resolveLocalVars(attributeVariables, attrs, resolvedFns, solarPower) {
    const localVals = {};
    if (!attributeVariables || !Object.keys(attributeVariables).length) return localVals;

    const sorted = Object.entries(attributeVariables).sort((a, b) => b[0].length - a[0].length);
    let changed = true;
    let passes  = 0;
    const MAX_PASSES = sorted.length + 2;

    while (changed && passes < MAX_PASSES) {
        changed = false;
        passes++;
        for (const [varName, formula] of sorted) {
            const val = _evalFormula(formula, attrs, resolvedFns, localVals, solarPower);
            if (!isNaN(val) && isFinite(val)) {
                const prev = localVals[varName];
                if (prev === undefined || Math.abs(val - (prev ?? NaN)) > 1e-12) {
                    localVals[varName] = val;
                    changed = true;
                }
            }
        }
    }
    return localVals;
}

// ── adding outfits to a ship ──

// ship attributes + every outfit's attributes. Called by: getComputedStats
function _accumulateOutfits(baseAttrs, outfitSource, outfitIdx, byIdIndex) {
    const attrDefs = _attrDefs?.attributes || {};
    const result   = {};
    for (const [key, val] of Object.entries(baseAttrs))
        if (typeof val === 'number') result[key] = val;

    const entries = _normaliseOutfitEntries(outfitSource);
    let totalCount = 0;

    for (const entry of entries) {
        const qty = entry.qty;
        totalCount += qty;

        const outfit = _resolveOutfitScoped(entry, byIdIndex, outfitIdx);
        if (!outfit) continue;

        const META_KEYS = new Set([
            'name','category','series','index','cost','thumbnail','sprite',
            'description','pluginId','internalId','governments','locations',
            'weapon',
            '_internalId','_pluginId','_hash',
        ]);
        const outfitAttrs = Object.fromEntries(
            Object.entries(outfit).filter(([k, v]) => typeof v === 'number' && !META_KEYS.has(k))
        );

        for (const [key, rawVal] of Object.entries(outfitAttrs)) {
            if (typeof rawVal !== 'number') continue;
            if (key.startsWith('_'))        continue;
            const stacking = attrDefs[key]?.stacking || 'additive';
            const contrib  = rawVal * qty;
            switch (stacking) {
                case 'maximum':              result[key] = Math.max(result[key] ?? -Infinity, contrib); break;
                case 'minimum':              result[key] = Math.min(result[key] ??  Infinity, contrib); break;
                case 'additive-then-multiply': /* falls through */
                default:                     result[key] = (result[key] || 0) + contrib; break;
            }
        }
        if (typeof outfit.cost === 'number')
            result['_totalOutfitCost'] = (result['_totalOutfitCost'] || 0) + outfit.cost * qty;
        if (typeof outfit.mass === 'number')
            result['_outfitMass'] = (result['_outfitMass'] || 0) + outfit.mass * qty;
    }
    result['_totalOutfits'] = totalCount;
    return result;
}

// every game ship function for these attributes. Called by: getComputedStats

function _resolveShipFunctions(attrs, solarPower) {
    const fns   = _attrDefs?.shipFunctions || {};
    const solar = (typeof solarPower === 'number') ? solarPower
                : (_attrDefs?.systemContext?.referenceSolarPower ?? 1.0);
    const cache = {};
    const done  = new Set();

    // evaluate one function. Called by: ensure
    function resolveOne(fnName) {
        const fn = fns[fnName];
        if (!fn?.formulas?.length) return NaN;
        const formula   = fn.formulas[fn.formulas.length - 1].formula;
        const localVars = _resolveLocalVars(fn.attributeVariables || {}, attrs, cache, solar);
        return _evalFormula(formula, attrs, cache, localVars, solar);
    }

    // run each function after the ones its formula calls (fixed order broke Drag → max speed)
    const callsIn = fnName => {
        const fn = fns[fnName];
        if (!fn?.formulas?.length) return [];
        const text = fn.formulas[fn.formulas.length - 1].formula + ' ' + Object.values(fn.attributeVariables || {}).join(' ');
        return [...new Set([...text.matchAll(/\b([A-Z][A-Za-z]+)\s*\(\s*\)/g)].map(m => m[1]))].filter(n => n !== fnName && fns[n]);
    };
    const inProgress = new Set();
    // work out a function after its dependencies. Called by: _resolveShipFunctions
    function ensure(fnName, depth) {
        if (done.has(fnName) || inProgress.has(fnName) || depth > 12) return;
        inProgress.add(fnName);
        for (const dep of callsIn(fnName)) ensure(dep, depth + 1);
        const val = resolveOne(fnName);
        // the game keeps this one in a hidden cache; use the game's own curve for it
        if (fnName === 'CoolingEfficiency' && (isNaN(val) || val < 0 || val > 2.5)) {
            const x = parseFloat((attrs || {})['cooling inefficiency'] ?? 0);
            cache['CoolingEfficiency'] = 2 + 2 / (1 + Math.exp(x / -2)) - 4 / (1 + Math.exp(x / -4));
        } else if (!isNaN(val)) {
            cache[fnName] = val;
        }
        inProgress.delete(fnName);
        done.add(fnName);
    }
    for (const fnName of Object.keys(fns)) ensure(fnName, 0);

    return cache;
}

// energy/heat table, label pairs, system-aware values. Called by: getComputedStats

function _resolveDerivedValues(attrs, fnCache, solarPower) {
    const derived  = {};
    const display  = _attrDefs?.shipDisplay || {};
    const intVars  = display.intermediateVars || {};
    const table    = display.energyHeatTable  || [];
    const solar    = (typeof solarPower === 'number') ? solarPower
                   : (_attrDefs?.systemContext?.referenceSolarPower ?? 1.0);
    const varCache = { ...fnCache };

    const resolvedVars = new Set();
    let changed = true;
    let pass    = 0;
    const maxPasses = Object.keys(intVars).length + 1;

    while (changed && pass < maxPasses) {
        changed = false; pass++;
        for (const [varName, formula] of Object.entries(intVars)) {
            if (resolvedVars.has(varName)) continue;
            if (_shouldSuppressIntermediateVar(varName, formula)) continue;
            const val = _evalFormula(formula, attrs, varCache, {}, solar);
            if (!isNaN(val) && isFinite(val)) {
                const prev = varCache[varName];
                varCache[varName] = val;
                derived[`_derived_${varName}`] = val;
                resolvedVars.add(varName);
                if (prev === undefined || Math.abs(val - prev) > 1e-10) changed = true;
            }
        }
    }

    // keep values that come out as exactly 0 (e.g. outfits cancelling out) — relevance is checked later
    for (const row of table) {
        if (!row.label) continue;
        const eVal = _evalFormula(row.energyFormula, attrs, varCache, {}, solar);
        const hVal = _evalFormula(row.heatFormula,   attrs, varCache, {}, solar);
        const safeLabel = row.label.replace(/[^a-zA-Z0-9]/g, '_');
        if (!isNaN(eVal)) derived[`_derived_energy_${safeLabel}`] = eVal;
        if (!isNaN(hVal)) derived[`_derived_heat_${safeLabel}`]   = hVal;
    }

    const fns = _attrDefs?.shipFunctions || {};
    for (const [fnName, fnData] of Object.entries(fns)) {
        if (fnCache[fnName] === undefined) continue;
        if (_shouldSuppressFn(fnName, fnData)) continue;
        derived[`_fn_${fnName}`] = fnCache[fnName];
    }

    // same for solar collection / ramscoop
    const sysFormulas = _attrDefs?.systemAwareFormulas || {};
    for (const [attrKey, info] of Object.entries(sysFormulas)) {
        const val = _evalFormula(info.formula, attrs, varCache, {}, solar);
        if (!isNaN(val))
            derived[`_sys_${attrKey.replace(/\s+/g, '_')}`] = val * (info.displayScale ?? 1);
    }

    return derived;
}

// adds ComputedMovementStats' results if that file is loaded. Called by: getComputedStats
function _mergeMovementStats(attrs, target) {
    if (typeof window === 'undefined') return;
    if (!window.ComputedMovementStats?.isReady?.()) return;
    try {
        Object.assign(target, window.ComputedMovementStats.getMovementStats(attrs));
    } catch (_) { /* movement stats are best-effort — never break computed stats */ }
}

// every computed stat for a ship or outfit. Called by: ItemStats, battleSim, generalSorterStuff

function getComputedStats(ship, pluginId, options) {
    const id       = ship._internalId || ship.name;
    const cacheKey = id + (pluginId || '') + (options?.solarPower ?? '');
    if (_cache[cacheKey]) return _cache[cacheKey];

    const solar     = options?.solarPower
                    ?? _attrDefs?.systemContext?.referenceSolarPower
                    ?? 1.0;
    const baseAttrs = ship.attributes || {};
    const outfitIdx = _getOutfitIndex(pluginId);
    const byIdIndex = _getOutfitIndexById(); // NEW
    const result    = _accumulateOutfits(baseAttrs, ship.outfitMap || ship.outfits || {}, outfitIdx, byIdIndex);

    for (const [key, val] of Object.entries(ship))
        if (typeof val === 'number' && !key.startsWith('_') && !(key in result)) result[key] = val;

    const fnCache = _resolveShipFunctions(result, solar);
    const derived = _resolveDerivedValues(result, fnCache, solar);
    Object.assign(result, derived);

    if (typeof window.WeaponStats !== 'undefined') {
        const outfitMap = ship.outfitMap || ship.outfits || {};
        const wsFlat    = window.WeaponStats.resolveWeaponStats(outfitMap, outfitIdx);
        Object.assign(result, wsFlat);
        Object.defineProperty(result, '_weaponStats', {
            value:        wsFlat['_weaponStats'],
            enumerable:   false,
            writable:     true,
            configurable: true,
        });
        delete result['_weaponStats'];
    }

    // movement stats from the same attributes
    _mergeMovementStats(result, result);

    _cache[cacheKey] = result;
    return result;
}

// one computed stat by key
function getComputedStat(ship, pluginId, statKey, options) {
    return getComputedStats(ship, pluginId, options)?.[statKey];
}

// computed stats offered in the sorter. Called by: generalSorterStuff

function getComputedSorterFields() {
    if (!_attrDefs) return [];
    const fields  = [];
    const display = _attrDefs.shipDisplay || {};
    const intVars = display.intermediateVars || {};
    const fns     = _attrDefs.shipFunctions || {};

    for (const [varName, formula] of Object.entries(intVars)) {
        if (_shouldSuppressIntermediateVar(varName, formula)) continue;
        const id    = `_derived_${varName}`;
        const label = varName.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim() + ' (computed)';
        fields.push({ id, key: id, label, path: null, isComputed: true });
    }
    for (const row of (display.energyHeatTable || [])) {
        if (!row.label) continue;
        const safeLabel = row.label.replace(/[^a-zA-Z0-9]/g, '_');
        const baseLabel = row.label.charAt(0).toUpperCase() + row.label.slice(1);
        fields.push({ id: `_derived_energy_${safeLabel}`, key: `_derived_energy_${safeLabel}`, label: `${baseLabel} Energy/s (computed)`, path: null, isComputed: true });
        fields.push({ id: `_derived_heat_${safeLabel}`,   key: `_derived_heat_${safeLabel}`,   label: `${baseLabel} Heat/s (computed)`,   path: null, isComputed: true });
    }
    for (const [fnName, fnData] of Object.entries(fns)) {
        if (_shouldSuppressFn(fnName, fnData)) continue;
        const id    = `_fn_${fnName}`;
        const label = fnName.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim() + ' (computed)';
        fields.push({ id, key: id, label, path: null, isComputed: true });
    }
    for (const [attrKey, info] of Object.entries(_attrDefs?.systemAwareFormulas || {})) {
        const id    = `_sys_${attrKey.replace(/\s+/g, '_')}`;
        const label = attrKey.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ') + ' (system)';
        fields.push({ id, key: id, label, path: null, isComputed: true, isSystemAware: true });
    }
    const wsLabels = {
        '_ws_totalDps':    'Total DPS (computed)',
        '_ws_shieldDps':   'Shield DPS (computed)',
        '_ws_hullDps':     'Hull DPS (computed)',
        '_ws_weaponCount': 'Weapon Types (computed)',
    };
    for (const [id, label] of Object.entries(wsLabels))
        fields.push({ id, key: id, label, path: null, isComputed: true });

    return fields;
}

// computed stats for a bare attribute map (no outfits added)

function getComputedStatsForAttrs(attrs, options) {
    const solar   = options?.solarPower ?? _attrDefs?.systemContext?.referenceSolarPower ?? 1.0;
    const fnCache = _resolveShipFunctions(attrs, solar);
    const derived = _resolveDerivedValues(attrs, fnCache, solar);
    const result  = { ...attrs, ...derived };
    _mergeMovementStats(attrs, result);
    return result;
}

// ── debugging from the console ──

function debugComputedStats(pluginId, shipName) {
    const plugin = window.allData?.[pluginId];
    if (!plugin) { console.error('Plugin not found:', pluginId); return; }
    const ship = (plugin.ships || []).find(s => s.name === shipName)
              || (plugin.variants || []).find(s => s.name === shipName);
    if (!ship) { console.error('Ship not found:', shipName); return; }
    if (!_attrDefs) { console.error('attrDefs not loaded'); return; }
    const stats = getComputedStats(ship, pluginId);
    console.group(`ComputedStats: ${shipName}`);
    console.log('_fn_ keys:', Object.keys(stats).filter(k => k.startsWith('_fn_')));
    console.log('_derived_ keys:', Object.keys(stats).filter(k => k.startsWith('_derived_')));
    console.log('_sys_ keys:', Object.keys(stats).filter(k => k.startsWith('_sys_')));
    console.log('_mv_ keys:', Object.keys(stats).filter(k => k.startsWith('_mv_')));
    console.groupEnd();
    return stats;
}

// console: show how each function was worked out
function debugFnResolution(pluginId, shipName) {
    const plugin = window.allData?.[pluginId];
    const ship   = (plugin?.ships || []).find(s => s.name === shipName);
    if (!ship || !_attrDefs) { console.error('Ship or attrDefs not found'); return; }
    const outfitIdx = _getOutfitIndex(pluginId);
    const byIdIndex = _getOutfitIndexById();
    const attrs     = _accumulateOutfits(ship.attributes || {}, ship.outfitMap || {}, outfitIdx, byIdIndex);
    const solar     = _attrDefs?.systemContext?.referenceSolarPower ?? 1.0;
    const fns       = _attrDefs.shipFunctions || {};
    const PRIORITY  = [
        'Mass','Drag','InertialMass','CoolingEfficiency','HeatDissipation',
        'MaximumHeat','MaxShields','MaxHull','TurnRate','Acceleration','MaxVelocity',
        'IdleHeat','CloakingSpeed',
    ];
    const testCache = {};
    console.group(`FnResolution: ${shipName}`);
    for (const fnName of PRIORITY) {
        const fn = fns[fnName];
        if (!fn?.formulas?.length) { console.log(`  ${fnName}: no formulas`); continue; }
        const localVars = _resolveLocalVars(fn.attributeVariables || {}, attrs, testCache, solar);
        const formula   = fn.formulas[fn.formulas.length - 1].formula;
        const val       = _evalFormula(formula, attrs, testCache, localVars, solar);
        const scale     = fn.displayScale ?? 1;
        const sup       = _shouldSuppressFn(fnName, fn);
        console.log(`  ${fnName}: raw=${val?.toFixed(4)}  display=${(val * scale)?.toFixed(4)}  suppressed=${sup}`);
        console.log(`    formula: ${formula}`);
        if (Object.keys(localVars).length) console.log(`    localVars:`, localVars);
        if (!isNaN(val)) testCache[fnName] = val;
    }
    console.groupEnd();
}

// console: show an outfit's computed stats
function debugOutfitStats(pluginId, outfitName) {
    const plugin = window.allData?.[pluginId];
    if (!plugin || !_attrDefs) { console.error('Plugin or attrDefs not found'); return; }
    const outfit = (plugin.outfits || []).find(o => o.name === outfitName);
    if (!outfit) { console.error('Outfit not found:', outfitName); return; }
    const attrs  = outfit.attributes ?? {};
    const result = getComputedStatsForAttrs(attrs);
    console.group(`OutfitStats: ${outfitName}`);
    console.log('fn_ keys:', Object.keys(result).filter(k => k.startsWith('_fn_')));
    console.log('All attrs:', attrs);
    console.groupEnd();
    return result;
}

// ── window.ComputedStats ──

window.ComputedStats = {
    init,
    isReady,
    getComputedStats,
    getComputedStat,
    getComputedStatsForAttrs,
    getComputedSorterFields,
    clearCache,
    debugComputedStats,
    debugFnResolution,
    debugOutfitStats,
    _evalFormula,
    _resolveShipFunctions,
    _resolveLocalVars,
    _accumulateOutfits,
    _shouldSuppressFn,
    _shouldSuppressIntermediateVar,
};

window.initComputedStats        = init;
window.clearComputedCache       = clearCache;
window.getComputedStats         = getComputedStats;
window.getComputedStat          = getComputedStat;
window.getComputedSorterFields  = getComputedSorterFields;
window.getComputedStatsForAttrs = getComputedStatsForAttrs;
window.debugComputedStats       = debugComputedStats;
window.debugFnResolution        = debugFnResolution;
window.debugOutfitStats         = debugOutfitStats;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.ComputedStats;
}

})();
