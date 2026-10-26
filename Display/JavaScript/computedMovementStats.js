;(function () {
'use strict';

// Flattens movementStats output into "_mv_…" keys for ComputedStats.

function isReady() {
    return !!(window.MovementStats && window.MovementStats.isReady && window.MovementStats.isReady());
}

// profile object → "_mv_a_b" keys (numbers only)
function _flatten(obj, prefix, out) {
    for (const [k, v] of Object.entries(obj || {})) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'boolean' || typeof v === 'string') continue;
        if (Array.isArray(v)) continue;
        const path = prefix ? `${prefix}_${k}` : k;
        if (typeof v === 'number') {
            if (v !== 0) out[`_mv_${path}`] = v;
        } else if (typeof v === 'object') {
            _flatten(v, path, out);
        }
    }
    return out;
}

// flat movement stats. Called by: computedStats._mergeMovementStats
function getMovementStats(combinedAttrs) {
    if (!isReady() || !combinedAttrs) return {};
    let profile;
    try { profile = window.MovementStats.compute(combinedAttrs); }
    catch (_) { return {}; }
    if (!profile) return {};
    return _flatten(profile, '', {});
}

window.ComputedMovementStats = { isReady, getMovementStats };

})();
