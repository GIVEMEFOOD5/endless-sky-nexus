'use strict';

// Decides which section (Shields & Hull, Engines …) every attribute goes in. Used by the Data Viewer, Compare and the builder.

window.AttributeSections = (() => {

    // Canonical section list, in display order. Every file should render
    // sections in this order, alphabetising anything not listed here.
    const SECTION_ORDER = [
        'General', 'Shields & Hull', 'Energy', 'Heat', 'Engines', 'Jump',
        'Cargo', 'Crew', 'Scanning', 'Cloaking', 'Resistance', 'Protection',
        'Hardpoints', 'Weapon DPS', 'Weapon DPS — Efficiency',
        'Ammo Consumption', 'Economy', 'Special', 'Derived Stats',
        'Licenses', 'Other',
    ];

    // words that point to a section — used on names, tooltips and function names
    const DOMAIN_WORDS = [
        ['Cloaking',       /cloak/i],
        ['Shields & Hull', /shield|hull/i],
        ['Jump',           /jump|hyperdrive|hyperspace|scram|warp|\bfuel\b|ramscoop/i],
        ['Cargo',          /cargo|passenger/i],
        ['Scanning',       /scan|jamming|interference|tactical|atmosphere|asteroid/i],
        ['Crew',           /crew|bunk|capture|boarding/i],
        ['Heat',           /heat|cool|dissipation/i],
        ['Energy',         /energy|solar|battery|generation|consumption/i],
        ['Engines',        /thrust|turn|steer|veloc|drag|inertia|reverse|afterburner|acceleration|engine/i],
    ];


    // first section whose words appear in the text. Called by: explain, matchDomainWord, classifyComputedKey
    function _matchDomain(text) {
        if (!text) return null;
        for (const [section, re] of DOMAIN_WORDS) if (re.test(text)) return section;
        return null;
    }


    // cost, mass, category … that belong to no engine system
    const GENERAL_RE = /\b(mass|cost|category|series|index)\b/i;

    // the parser's rough area → our section, used only as a last resort
    const AREA_FALLBACK = {
        'Economy':          'Economy',
        'Special / Flags':  'Special',
    };

    // the attribute's record in the definitions. Called by: explain, getFrontendArea
    function _getAttrRecord(attrDefs, key) {
        const attrs = attrDefs?.attributes || {};
        return attrs[key] || attrs[key?.toLowerCase()] || null;
    }

    let _structCache = { defs: null };
    // lists read from the game's code: motion physics, energy/heat table, capacity list (cached). Called by: explain
    function _structure(attrDefs) {
        if (_structCache.defs === attrDefs) return _structCache;
        const refs = text => [...String(text || '').matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
        // the game's energy/heat table: for each attribute, the row it's in and
        // the column (energy or heat) — e.g. "thrusting" / energy
        const table = new Map();
        for (const row of attrDefs?.shipDisplay?.energyHeatTable || []) {
            for (const k of refs(row.energyFormula)) if (!table.has(k)) table.set(k, { row: row.label, column: 'energy' });
            for (const k of refs(row.heatFormula))   if (!table.has(k) || table.get(k).column !== 'energy') table.set(k, { row: row.label, column: 'heat' });
        }
        _structCache = {
            defs: attrDefs,
            movement: new Set(attrDefs?.movementSystem?.attributes || []),             // the game's motion physics
            capacity: new Map((attrDefs?.shipDisplay?.capacityDisplay || []).map(c => [c.attributeKey, c.displayLabel])), // the game's "space" list
            table,                                                                     // the game's energy/heat table
        };
        return _structCache;
    }

    // which section an attribute goes in, and why: game evidence first, its name only as a fallback.
    // Called by: classify, AttributeDisplay.rowToHtml
    function explain(attrDefs, key, overrides) {
        if (overrides && overrides[key]) return { section: overrides[key], reason: 'override' };
        const k = String(key || '').toLowerCase();
        const rec = _getAttrRecord(attrDefs, key);
        const st = _structure(attrDefs);
        const is = (section, reason) => ({ section, reason });

        // 1. game code: motion physics, jump navigation
        if (st.movement.has(k)) return is('Engines', 'game code: motion physics (movementSystem)');
        if (rec?.usedInNavFunctions?.length) return is('Jump', `game code: jump navigation (${rec.usedInNavFunctions.join(', ')})`);

        // 2. parser flags
        if (rec) {
            if (rec.isStatusResistance || rec.isStatusResistanceCost) return is('Resistance', 'parser flag: status resistance');
            if (rec.isProtection || rec.isStatusProtection)           return is('Protection', 'parser flag: protection');
            if (rec.isBoolean || rec.area === 'Special / Flags')       return is('Special', 'parser flag: yes/no attribute');
            if (rec.isWeaponStat)                                      return is('Weapon DPS', 'parser flag: weapon stat');
        }

        // 3. the game's own display tables
        const cell = st.table.get(k);
        if (cell) {
            // the row's own label decides first ("shields / hull / …" → Shields & Hull),
            // otherwise the column ("thrusting" + energy → Energy)
            const s = _matchDomain(`${cell.row} ${cell.column}`);
            if (s) return is(s, `game display: energy/heat table, row "${cell.row}", ${cell.column} column`);
        }
        if (st.capacity.has(k)) {
            const label = st.capacity.get(k) || k;
            const s = _matchDomain(label) || (/\bmounts?\b|\bports?\b/.test(label) ? 'Hardpoints' : 'Cargo');
            return is(s, `game display: capacity list ("${label}")`);
        }

        // 4. fallback: the attribute's name …
        if (/ resistance$/.test(k)) return is('Resistance', 'name');
        if (/ protection$/.test(k)) return is('Protection', 'name');
        if (/ damage$/.test(k)) return is('Weapon DPS', 'name: damage a weapon deals');
        const nameHit = _matchDomain(k);
        if (nameHit) return is(nameHit, 'name');
        if (GENERAL_RE.test(k)) return is('General', 'name');
        if (/\bmounts?\b|\bports?\b|\banchor\b|\bbays?\b/.test(k)) return is('Hardpoints', 'name');
        // "sidewinder capacity", "torpedo capacity" … — how much a launcher holds
        if (/ capacity$/.test(k)) return is('Ammo Consumption', 'name: launcher capacity');

        if (!rec) return is('Other', 'no information');

        // … then its tooltip, the game functions that read it, the parser's area
        const purposeHit = _matchDomain(rec.tooltip || rec.description);
        if (purposeHit) return is(purposeHit, 'tooltip');
        for (const fnName of rec.usedInShipFunctions || []) {
            const hit = _matchDomain(fnName);
            if (hit) return is(hit, `game function name (${fnName})`);
        }
        if (rec.isWeaponDataKey) return is('Weapon DPS', 'parser flag: weapon data key');
        const areaHit = AREA_FALLBACK[rec.area];
        if (areaHit) return is(areaHit, `parser area (${rec.area})`);
        return is('Other', 'no information');
    }

    // just the section name. Called by: ItemStats, AttributeDisplay, groupKeys and anything else that sorts attributes
    function classify(attrDefs, key, overrides) {
        return explain(attrDefs, key, overrides).section;
    }

    // { section: [keys] } for an attributes object. Called by: anything grouping a whole ship's attributes
    function groupKeys(attrDefs, attrsObj, overrides) {
        const groups = {};
        for (const key of Object.keys(attrsObj || {})) {
            const section = classify(attrDefs, key, overrides);
            (groups[section] = groups[section] || []).push(key);
        }
        return groups;
    }

    // section names in display order (unknown ones last, A–Z). Called by: AttributeDisplay.renderSectionMap, renderAttributesTabEnhanced, shipBuilder.sbAttrGroups, shipBuilderStats._tabEverything
    function orderSections(sectionNames) {
        const known  = SECTION_ORDER.filter(s => sectionNames.includes(s));
        const extras = sectionNames.filter(s => !SECTION_ORDER.includes(s)).sort();
        return [...known, ...extras];
    }

    // keys from several sections merged into one list. Called by: shipBuilderStats
    function keysInSections(attrDefs, attrsObj, sectionNames, overrides) {
        const wanted = new Set(sectionNames);
        return Object.keys(attrsObj || {})
            .filter(key => wanted.has(classify(attrDefs, key, overrides)));
    }

    // the word matcher, for free text (a function name, a label). Called by: ItemStats.calcDerivedStats
    function matchDomainWord(text) {
        return _matchDomain(text);
    }

    // the parser's raw area and badges for a key
    function getFrontendArea(attrDefs, key) {
        const rec = _getAttrRecord(attrDefs, key);
        return { area: rec?.area ?? null, areaBadges: rec?.areaBadges ?? [] };
    }

    // section for a calculated stat (_fn_…, _ws_… keys), going by the attributes behind it. Called by: ItemStats.calcDerivedStats, getComputedStatRows
    function classifyComputedKey(attrDefs, key) {
        if (!key) return 'Derived Stats';

        if (key.startsWith('_fn_')) {
            const fnName = key.slice(4);
            const fnDef  = attrDefs?.shipFunctions?.[fnName];
            for (const attrKey of (fnDef?.attributesRead || [])) {
                const section = classify(attrDefs, attrKey);
                if (section && section !== 'Other') return section;
            }
            return _matchDomain(fnName) || 'Derived Stats';
        }

        if (key.startsWith('_derived_energy_') || key.startsWith('_derived_heat_')) return 'Energy';

        if (key.startsWith('_derived_')) {
            const varName = key.slice('_derived_'.length);
            const formula = attrDefs?.shipDisplay?.intermediateVars?.[varName];
            const refs = formula ? [...formula.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]) : [];
            for (const attrKey of refs) {
                const section = classify(attrDefs, attrKey);
                if (section && section !== 'Other') return section;
            }
            return _matchDomain(varName) || 'Derived Stats';
        }

        if (key.startsWith('_sys_')) return 'Energy';

        if (key.startsWith('_ws_') || key.startsWith('_ammo_') || /dps/i.test(key)) return 'Weapon DPS';

        if (key === '_outfitMass' || key === '_totalOutfitCost' || key === '_totalOutfits') return 'General';

        return _matchDomain(key) || 'Derived Stats';
    }

    return {
        SECTION_ORDER, classify, explain, groupKeys, orderSections, keysInSections,
        matchDomainWord, classifyComputedKey, getFrontendArea,
    };
})();
