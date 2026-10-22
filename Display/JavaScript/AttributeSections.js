'use strict';

// ─── AttributeSections.js ─────────────────────────────────────────────
//
// SINGLE SOURCE OF TRUTH for grouping attribute keys into display sections.
// Used by CompareDisplay.js, AttributeDisplay.js, and shipBuilderStats.js so
// a given attribute always lands in the same bucket everywhere it's shown.
//
// DESIGN GOAL: minimise invented keyword lists. attrDefs.json (produced by
// attributeParser.js) already encodes most of what we need as real signals
// pulled straight from the Endless Sky C++ source, not guesses:
//
//   • rec.usedInNavFunctions   — this key is read by a ShipJumpNavigation::
//                                 method (Calibrate, JumpFuel, etc). If it's
//                                 populated at all, the key is Jump-domain,
//                                 full stop — no pattern matching needed.
//   • rec.isStatusResistance / isStatusResistanceCost
//                                 — set directly from weapon.statusEffectDecay
//                                 descriptors (resistKey / costKeys).
//   • rec.isProtection / isStatusProtection
//                                 — set directly from weapon.damageTypeDetails
//                                 protectionKey + Outfit.cpp MINIMUM_OVERRIDES.
//   • rec.isWeaponStat          — set from OutfitInfoDisplay's VALUE_NAMES /
//                                 PERCENT_NAMES / OTHER_NAMES tables.
//   • shipDisplay.capacityDisplay
//                                 — the exact 5 capacity keys ShipInfoDisplay
//                                 itself groups together (outfit/weapon/engine
//                                 space, gun ports, turret mounts).
//   • rec.usedInShipFunctions   — the real Ship:: method(s) that read the key.
//                                 A method's own name already encodes its
//                                 subsystem (MaxShields, CloakingSpeed,
//                                 IdleHeat, TurnRate, RequiredCrew, Scan...),
//                                 so we pattern-match the FUNCTION NAME, not
//                                 attribute names — much higher precision,
//                                 and it's one dictionary shared with steps
//                                 below instead of three separate lists.
//
// NEW IN v3 — rec.area (attribute-area-classification.md):
//   attributeParser.js now also computes a coarser, independent ~10-bucket
//   classification (rec.area / rec.areaBadges) via deriveFrontendArea(),
//   folding in evidence this file doesn't have access to on its own —
//   notably data/ category co-occurrence (the strongest signal available:
//   what an attribute is actually FOR in shipped content) and an Economy
//   bucket (income/maintenance/operating-cost keys, via
//   usedInOtherSystems containing "PlayerInfo::MaintenanceAndReturns").
//
//   classify() below keeps ALL of its existing fine-grained logic exactly
//   as before — it already produces a BETTER-differentiated answer than
//   rec.area's coarse buckets for anything it already recognises (e.g. it
//   splits "Power, Heat & Life Support" into separate Shields & Hull /
//   Energy / Heat sections, which rec.area deliberately does not). rec.area
//   is consulted ONLY as a last-resort fallback, immediately before the
//   final 'Other' catch-all, and ONLY for the two buckets this file had
//   literally zero coverage for previously — Economy and Special/Flags —
//   both of which used to silently land in 'Other'. See AREA_FALLBACK below.
// ─────────────────────────────────────────────────────────────────────────

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

    // ── The one shared domain dictionary ──────────────────────────────────
    // Reused against: (a) usedInShipFunctions entries, (b) the attribute's
    // own key, (c) its tooltip text. Order = priority when multiple tokens
    // could match (checked top to bottom, first hit wins). Heat is checked
    // BEFORE Energy so compound keys like "heat generation"/"heat
    // dissipation" land in Heat rather than being grabbed by Energy's
    // "generation" token.
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


    function _matchDomain(text) {
        if (!text) return null;
        for (const [section, re] of DOMAIN_WORDS) if (re.test(text)) return section;
        return null;
    }


    // Ship/outfit identity & economy fields with no dedicated engine
    // subsystem of their own — everything else that doesn't match falls
    // through to 'Other' rather than being force-fit here.
    const GENERAL_RE = /\b(mass|cost|category|series|index)\b/i;

    // rec.area → this file's canonical section, for the last-resort
    // fallback (see v3 note above). Only areas this file has NO existing
    // equivalent-or-better bucket for are mapped — every other area value
    // (Weapons, Movement & Engines, Scanners & Detection, Defense /
    // Protection, Status Effects, Power/Heat/Life Support, General Outfit/
    // Ship Stats, Custom / Modder-Defined) is deliberately left unmapped
    // here: classify()'s own logic above already produces an equal-or-finer
    // answer for those before this fallback is ever reached, so mapping
    // them too would just risk silently overriding a more precise result
    // in some edge case rather than only filling real gaps.
    const AREA_FALLBACK = {
        'Economy':          'Economy',
        'Special / Flags':  'Special',
    };

    function _getAttrRecord(attrDefs, key) {
        const attrs = attrDefs?.attributes || {};
        return attrs[key] || attrs[key?.toLowerCase()] || null;
    }

    /**
     * Classify a single attribute key into its canonical display section.
     * @param {object} attrDefs - parsed attrDefs.json (window.attrDefs)
     * @param {string} key - attribute key, e.g. "shield generation"
     * @param {object} [overrides] - optional { key: sectionName } escape hatch
     *   for the rare attribute nothing else can resolve. Keep this short —
     *   it's a pressure release, not the primary mechanism.
     */
    // Lists the parser read out of the game's own source, cached per attrDefs.
    let _structCache = { defs: null };
    function _structure(attrDefs) {
        if (_structCache.defs === attrDefs) return _structCache;
        const refs = text => new Set([...String(text || '').matchAll(/\[([^\]]+)\]/g)].map(m => m[1]));
        const energy = new Set(), heat = new Set();
        for (const row of attrDefs?.shipDisplay?.energyHeatTable || []) {
            for (const k of refs(row.energyFormula)) energy.add(k);
            for (const k of refs(row.heatFormula)) heat.add(k);
        }
        _structCache = {
            defs: attrDefs,
            movement: new Set(attrDefs?.movementSystem?.attributes || []),            // the game's motion physics
            capacity: new Set((attrDefs?.shipDisplay?.capacityDisplay || []).map(c => c.attributeKey)), // the game's "space" list
            energy, heat,                                                             // the game's energy/heat table
        };
        return _structCache;
    }

    function classify(attrDefs, key, overrides) {
        if (overrides && overrides[key]) return overrides[key];
        const k = String(key || '').toLowerCase();
        const rec = _getAttrRecord(attrDefs, key);
        const st = _structure(attrDefs);

        // 1. Where the GAME uses it, from the attribute definitions:
        //    its motion physics, its jump navigation.
        if (st.movement.has(k)) return 'Engines';
        if (rec?.usedInNavFunctions?.length) return 'Jump';

        // 2. What KIND of attribute it is (parser flags).
        if (rec) {
            if (rec.isStatusResistance || rec.isStatusResistanceCost) return 'Resistance';
            if (rec.isProtection || rec.isStatusProtection)           return 'Protection';
            if (rec.isBoolean || rec.area === 'Special / Flags')       return 'Special';
        }
        if (/ resistance$/.test(k)) return 'Resistance';
        if (/ protection$/.test(k)) return 'Protection';
        if (/ damage$/.test(k)) return 'Weapon DPS';                    // what weapons deal
        if (rec?.isWeaponStat) return 'Weapon DPS';

        // 3. Its own name, read with a general vocabulary (shield…, cargo…,
        //    scan…, heat…). This comes before "which code reads it": the
        //    cloaking code reads shield generation, the scan code reads cargo
        //    space — but the name says what they are.
        const nameHit = _matchDomain(k);
        if (nameHit) return nameHit;
        if (GENERAL_RE.test(k)) return 'General';
        if (/\bmounts?\b|\bports?\b|\banchor\b|\bbays?\b/.test(k)) return 'Hardpoints';
        // "sidewinder capacity", "torpedo capacity" … — how much a launcher holds
        if (/ capacity$/.test(k) && !st.capacity.has(k)) return 'Ammo Consumption';

        // 4. The game's own display tables: its capacity list, its energy/heat table.
        if (st.capacity.has(k)) return 'Cargo';
        if (st.heat.has(k)) return 'Heat';
        if (st.energy.has(k)) return 'Energy';

        if (!rec) return 'Other';

        // 5. What its description says, then the names of the game functions that read it.
        const purposeHit = _matchDomain(rec.tooltip || rec.description);
        if (purposeHit) return purposeHit;
        if (rec.usedInShipFunctions?.length) {
            for (const fnName of rec.usedInShipFunctions) {
                const hit = _matchDomain(fnName);
                if (hit) return hit;
            }
        }
        if (rec.isWeaponDataKey) return 'Weapon DPS';

        const areaHit = AREA_FALLBACK[rec.area];
        if (areaHit) return areaHit;

        return 'Other';
    }

    /**
     * Group every key of an attrs-like object { key: value } into
     * { sectionName: [key, key, ...] } using classify().
     */
    function groupKeys(attrDefs, attrsObj, overrides) {
        const groups = {};
        for (const key of Object.keys(attrsObj || {})) {
            const section = classify(attrDefs, key, overrides);
            (groups[section] = groups[section] || []).push(key);
        }
        return groups;
    }

    /** Sort section names per SECTION_ORDER; unknowns appended alphabetically. */
    function orderSections(sectionNames) {
        const known  = SECTION_ORDER.filter(s => sectionNames.includes(s));
        const extras = sectionNames.filter(s => !SECTION_ORDER.includes(s)).sort();
        return [...known, ...extras];
    }

    /**
     * Convenience for consumers (e.g. shipBuilderStats.js) that want a "tab"
     * made of several canonical sections merged together, instead of their
     * own separate keyword-token list. Returns every key in attrsObj whose
     * classify() result is one of `sectionNames`.
     */
    function keysInSections(attrDefs, attrsObj, sectionNames, overrides) {
        const wanted = new Set(sectionNames);
        return Object.keys(attrsObj || {})
            .filter(key => wanted.has(classify(attrDefs, key, overrides)));
    }

    /** Public access to the domain-word matcher, for callers that need to
     * classify free text (a function name, a display label) rather than a
     * real attribute key — e.g. AttributeDisplay.js placing a computed stat
     * next to the raw attributes it's related to. Returns a section name or
     * null if nothing matched. */
    function matchDomainWord(text) {
        return _matchDomain(text);
    }

    /**
     * Public access to the raw parser-derived area/badges for a key, for
     * callers that want the coarser attribute-area-classification.md
     * taxonomy directly (e.g. a simpler alternate view) rather than this
     * file's finer-grained sections. Returns { area, areaBadges } — area
     * may be null if the parser left it unclassified (see attributeParser.js
     * deriveFrontendArea's notes on rule 9 being intentionally skipped).
     */
    function getFrontendArea(attrDefs, key) {
        const rec = _getAttrRecord(attrDefs, key);
        return { area: rec?.area ?? null, areaBadges: rec?.areaBadges ?? [] };
    }

    /**
     * Classify a COMPUTED stat key (as produced by ComputedStats.js / the
     * calcDerivedStats helpers) into the same canonical section its driving
     * raw attribute(s) belong to — so e.g. the computed "Max Shields" value
     * lands next to the raw "shields" / "shield generation" attributes
     * instead of in a separate undifferentiated "Derived Stats" pile.
     *
     * Priority:
     *   1. _fn_<ShipFunctionName>       — classify() each attribute the real
     *                                      Ship:: function reads; first
     *                                      non-'Other' result wins. Falls
     *                                      back to matching the function's
     *                                      own name (e.g. "MaxShields").
     *   2. _derived_energy_ / _derived_heat_ — always 'Energy' (that's what
     *                                      the prefix means).
     *   3. _derived_<var>               — classify() the attributes referenced
     *                                      by that intermediate var's formula.
     *   4. _sys_*                       — system-aware formulas (solar
     *                                      collection, ramscoop) → 'Energy'.
     *   5. _ws_* / _ammo_* / *dps*      — 'Weapon DPS'.
     *   6. _outfitMass / _totalOutfitCost / _totalOutfits → 'General'.
     *   7. Fallback: domain-word match on the key text, else 'Derived Stats'.
     */
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
        SECTION_ORDER, classify, groupKeys, orderSections, keysInSections,
        matchDomainWord, classifyComputedKey, getFrontendArea,
    };
})();
