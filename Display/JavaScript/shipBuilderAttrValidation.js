'use strict';

// Allowed ranges for builder attributes (from the attribute definitions and the game's rules).

const AttrValidation = window.AttrValidation = (() => {
    'use strict';

    // { min, max, reason } for an attribute. Called by: validate

    function _getRule(key) {
        const ad       = window.attrDefs;
        const attrMeta = ad?.attributes?.[key] || {};
        const lk       = key.toLowerCase();

        // 1. range from the definitions
        if (Array.isArray(attrMeta.clampRange)) {
            const [cMin, cMax] = attrMeta.clampRange;
            return {
                min:    typeof cMin === 'number' ? cMin : null,
                max:    typeof cMax === 'number' ? cMax : null,
                reason: `clamped to [${cMin}, ${cMax}] by game engine`,
            };
        }

        // 2. multipliers: -1 or more
        if (attrMeta.isMultiplier) {
            return { min: -1, max: null, reason: 'multiplier attribute (min −1)' };
        }

        // anything ending in " multiplier"
        if (lk.endsWith(' multiplier')) {
            return { min: -1, max: null, reason: 'multiplier attribute (min −1)' };
        }

        // 3. expected-negative attributes: the ship's own value can't go below 0
        if (attrMeta.isExpectedNegative) {
            return { min: 0, max: null, reason: 'capacity attribute — ship base value must be ≥ 0' };
        }

        // 4. protections
        if (attrMeta.isProtection) {
            return { min: 0, max: null, reason: 'protection attribute must be ≥ 0' };
        }

        // 5. status resistances
        if (attrMeta.isStatusResistance || attrMeta.isStatusProtection) {
            return { min: 0, max: null, reason: 'resistance/protection attribute must be ≥ 0' };
        }

        // 6. name patterns

        // Special hard rules for specific physical properties
        if (lk === 'drag') {
            return { min: 0.001, max: null, reason: 'drag must be > 0 (zero drag crashes the physics engine)' };
        }
        if (lk === 'mass') {
            return { min: 0.001, max: null, reason: 'mass must be > 0' };
        }

        // costs on generators etc. can be negative (per the wiki)
        if (!lk.endsWith(' capacity') && !lk.endsWith(' generation') && !lk.endsWith(' consumption')) {
            if (lk.endsWith(' energy') || lk.endsWith(' heat') || lk.endsWith(' fuel')) {
                return { min: null, max: null, reason: 'cost attribute — negative values are valid (grants resource)' };
            }
        }

        // Afterburner/cloaking shield/hull drain costs — can be negative
        if (lk.endsWith(' shields') || lk.endsWith(' hull')) {
            // Only the "cost" variants — those that have "firing", "afterburner", "cloaking" etc.
            // We identify these as attributes that contain a verb prefix before the resource name.
            const costPrefixes = [
                'firing ', 'afterburner ', 'cloaking ', 'thrusting ',
                'turning ', 'reverse ', 'disabled recovery ',
            ];
            if (costPrefixes.some(p => lk.startsWith(p))) {
                return { min: null, max: null, reason: 'cost attribute — negative values valid' };
            }
        }

        // Attributes that must be ≥ 0
        const nonNegSuffixes = [
            ' damage', ' resistance', ' delay', ' time', ' chance',
            ' speed', ' range', ' capacity', ' space', ' ports', ' mounts',
            ' generation', ' consumption', ' collection',
        ];
        for (const suffix of nonNegSuffixes) {
            if (lk.endsWith(suffix)) {
                return { min: 0, max: null, reason: `"${suffix.trim()}" attributes must be ≥ 0` };
            }
        }

        // Reduction attributes — can't be negative (they reduce by a fraction)
        if (lk.endsWith(' reduction')) {
            return { min: 0, max: null, reason: 'reduction attribute must be ≥ 0' };
        }

        // default: 0 or more
        return { min: 0, max: null, reason: 'default — attributes must be ≥ 0' };
    }

    // error message, or null if fine. Called by: sbValidateAttrValue

    function validate(key, rawValue) {
        // Empty / non-numeric values are allowed (treated as 0 by the game)
        if (rawValue === '' || rawValue == null) return { ok: true };
        const v = parseFloat(rawValue);
        if (isNaN(v)) return { ok: true }; // non-numeric — let other validation handle it

        const rule = _getRule(key);

        if (rule.min !== null && v < rule.min) {
            const minStr = rule.min === 0 ? '0' : rule.min.toString();
            return {
                ok:      false,
                message: `"${key}" must be ≥ ${minStr} (${rule.reason}).`,
                min:     rule.min,
                max:     rule.max,
            };
        }

        if (rule.max !== null && v > rule.max) {
            return {
                ok:      false,
                message: `"${key}" must be ≤ ${rule.max} (${rule.reason}).`,
                min:     rule.min,
                max:     rule.max,
            };
        }

        return { ok: true };
    }

    // replace the builder's validator. Called on page load

    function install() {
        // Replace the existing function from shipBuilder.js
        window.sbValidateAttrValue = function(key, rawValue) {
            return validate(key, rawValue);
        };

        // Also expose the rule-getter for debugging / external use

        console.log('[AttrValidation] Installed data-driven sbValidateAttrValue.');
    }

    return { install, validate, getRule: _getRule };

})();

document.addEventListener('DOMContentLoaded', () => {
    AttrValidation.install();
});
