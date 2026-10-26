'use strict';

// Attributes every ship must have (from the game's own checks), locked in the builder and filled in with defaults.

const RequiredAttrs = (() => {
    'use strict';

    // default values — the only fixed numbers here

    const DEFAULTS_BY_KEY = {
        'mass':             '1',
        'hull':             '1',
        'cost':             '1',
        'cargo space':      '1',
        'outfit space':     '1',
        'weapon capacity':  '1',
        'engine capacity':  '1',
        'gun ports':        '0',
        'turret mounts':    '0',
        'drag':             '0',
        'shields':          '0',
        'category':         '',
        'heat dissipation': '0.5',
    };

    const DEFAULT_FALLBACK = '0'; // for any required key not listed above

    // layout class for outfit-only mode

    const OUTFIT_MODE_CLASS = 'builder-layout--outfit-mode';

    // ── state (filled on install) ──

    let _requiredKeys     = new Set();   // level === 'required'
    let _requiredList     = [];          // [ { key, req, special, defaultValue }, … ]
    let _recommendedKeys  = new Set();   // level === 'recommended'
    let _recommendedList  = [];
    let _reqMeta          = new Map();   // key → shipRequirement (both levels)

    // required attributes from the definitions. Called by: _init

    function _deriveRequirements() {
        const out = { required: new Map(), recommended: new Map(), available: false };
        const attrs = window.attrDefs && window.attrDefs.attributes;
        if (!attrs) {
            console.warn('[RequiredAttrs] window.attrDefs not available yet.');
            return out;
        }
        for (const [key, meta] of Object.entries(attrs)) {
            const req = meta && meta.shipRequirement;
            if (!req) continue;
            out.available = true;
            if (req.level === 'required')    out.required.set(key, req);
            if (req.level === 'recommended') out.recommended.set(key, req);
        }
        if (!out.available) {
            console.warn('[RequiredAttrs] attrDefs has no shipRequirement data — re-run the ' +
                'parse workflow (attributeParser.js deriveShipRequirements) to enable locking.');
        }
        return out;
    }

    // default that meets the attribute's own minimum
    function _defaultFor(key, req) {
        let v = DEFAULTS_BY_KEY.hasOwnProperty(key) ? DEFAULTS_BY_KEY[key] : DEFAULT_FALLBACK;
        const n = parseFloat(v);
        if (req && req.min !== undefined && !isNaN(n) &&
            (req.minExclusive ? n <= req.min : n < req.min)) {
            v = req.engineDefault !== undefined ? String(req.engineDefault) : '1';
        }
        return v;
    }

    // build the required list

    function _buildList(reqMap) {
        return [...reqMap.entries()].map(([key, req]) => ({
            key, req,
            special:      key === 'mass' ? 'mass' : key === 'drag' ? 'drag' : 'attr',
            defaultValue: _defaultFor(key, req),
        }));
    }

    // is this attribute required? Called by: the builder

    function isRequired(key)    { return _requiredKeys.has(key); }
    // recommended but not required
    function isRecommended(key) { return _recommendedKeys.has(key); }

    // current value of an attribute
    function _getVal(ship, key) {
        if (key === 'mass') return ship.mass;
        if (key === 'drag') return ship.drag;
        return (ship.attributes || {})[key];
    }

    // error text, or null if fine
    function _checkValue(key, raw) {
        const req = _reqMeta.get(key);
        if (!req) return null;
        const blank = raw === undefined || raw === null || String(raw).trim() === '';
        if (blank) return _requiredKeys.has(key) ? `"${key}" is required on every ship and can't be blank.` : null;
        if (req.min === undefined) return null;
        const n = parseFloat(raw);
        if (isNaN(n)) return null;
        if (req.minExclusive && n <= req.min) return `"${key}" must be greater than ${req.min}.`;
        if (!req.minExclusive && n < req.min) return `"${key}" can't be below ${req.min}.`;
        return null;
    }

    // every required-attribute problem on a ship. Called by: export checks, builderToSave
    function validate(ship) {
        const problems = [];
        if (!ship) return problems;
        for (const key of _requiredKeys) {
            const err = _checkValue(key, _getVal(ship, key));
            if (err) problems.push({ key, message: err });
        }
        for (const key of _recommendedKeys) {
            const v = _getVal(ship, key);
            if (v === undefined || v === null || v === '') continue;
            const err = _checkValue(key, v);
            if (err) problems.push({ key, message: err });
        }
        return problems;
    }

    // add missing required attributes with defaults

    function _backfill(ship, list = _requiredList) {
        if (!ship) return;
        ship.attributes = ship.attributes || {};

        for (const def of list) {
            if (def.special === 'mass') {
                if (ship.mass === undefined || ship.mass === null || ship.mass === '')
                    ship.mass = def.defaultValue;
            } else if (def.special === 'drag') {
                if (ship.drag === undefined || ship.drag === null || ship.drag === '')
                    ship.drag = def.defaultValue;
            } else {
                if (ship.attributes[def.key] === undefined || ship.attributes[def.key] === null)
                    ship.attributes[def.key] = def.defaultValue;
            }
        }
    }

    // outfit-only mode: hide the attribute sidebar

    function _applyLayoutMode(mode) {
        const layout = document.querySelector('.builder-layout');
        if (!layout) return;
        if (mode === 'outfit') {
            layout.classList.add(OUTFIT_MODE_CLASS);
        } else {
            layout.classList.remove(OUTFIT_MODE_CLASS);
        }
    }

    // new ships start with the required attributes

    function _patchBlank() {
        if (typeof window.sbBlank !== 'function') {
            console.warn('[RequiredAttrs] sbBlank not found — skipping patch.');
            return;
        }
        const orig = window.sbBlank;
        window.sbBlank = function () {
            const ship = orig.apply(this, arguments);
            _backfill(ship);
            _backfill(ship, _recommendedList);   // new ships start with the usual stats
            return ship;
        };
    }

    // opened game ships get them too

    function _patchShipFromParsed() {
        if (typeof window.sbShipFromParsed !== 'function') {
            console.warn('[RequiredAttrs] sbShipFromParsed not found — skipping patch.');
            return;
        }
        const orig = window.sbShipFromParsed;
        window.sbShipFromParsed = function (src) {
            const ship = orig.apply(this, arguments);
            _backfill(ship);
            return ship;
        };
    }

    // required attributes can't be removed

    function _patchRemoveAttr() {
        if (typeof window.sbRemoveAttr !== 'function') {
            console.warn('[RequiredAttrs] sbRemoveAttr not found — skipping patch.');
            return;
        }
        const orig = window.sbRemoveAttr;
        window.sbRemoveAttr = function (key) {
            if (_requiredKeys.has(key)) {
                if (typeof sbToast === 'function')
                    sbToast(`"${key}" is required on every ship and cannot be removed.`, 'danger');
                return;
            }
            return orig.apply(this, arguments);
        };
    }

    // required attributes can't be emptied

    function _patchUpdateAttrVal() {
        if (typeof window.sbUpdateAttrVal !== 'function') {
            console.warn('[RequiredAttrs] sbUpdateAttrVal not found — skipping patch.');
            return;
        }
        const orig = window.sbUpdateAttrVal;
        window.sbUpdateAttrVal = function (inp) {
            const key = inp && inp.dataset ? inp.dataset.key : null;
            const err = key ? _checkValue(key, inp.value) : null;
            if (err) {
                if (typeof sbToast === 'function') sbToast(err, 'danger');
                const ship = window.sbCurrentShip || (typeof sbCurrentShip !== 'undefined' ? sbCurrentShip : null);
                if (ship) inp.value = String(_getVal(ship, key) ?? '');
                inp.style.borderColor = 'var(--c-danger-hi)';
                setTimeout(() => { inp.style.borderColor = ''; }, 1500);
                return;
            }
            return orig.apply(this, arguments);
        };
    }

    // required attributes can't be added twice
    function _patchConfirmAddAttr() {
        if (typeof window.confirmAddAttr !== 'function') return;
        const orig = window.confirmAddAttr;
        window.confirmAddAttr = function () {
            const k = (document.getElementById('new-attr-key') || {}).value;
            const v = (document.getElementById('new-attr-val') || {}).value;
            const err = k ? _checkValue(k.trim(), (v || '').trim()) : null;
            if (err) { if (typeof sbToast === 'function') sbToast(err, 'danger'); return; }
            return orig.apply(this, arguments);
        };
    }

    // lock icons on required rows

    function _patchRenderAttrList() {
        if (typeof window.sbRenderAttrList !== 'function') {
            console.warn('[RequiredAttrs] sbRenderAttrList not found — skipping patch.');
            return;
        }
        const orig = window.sbRenderAttrList;
        window.sbRenderAttrList = function () {
            orig.apply(this, arguments);
            _lockRequiredRows();
        };
    }

    // lock required rows
    function _lockRequiredRows() {
        const el = document.getElementById('attr-list');
        if (!el) return;

        el.querySelectorAll('.attr-row').forEach(row => {
            const input = row.querySelector('.attr-val-input');
            const key   = input ? input.dataset.key : null;
            if (!key) return;
            const req = _reqMeta.get(key);
            const keyEl = row.querySelector('.attr-key');
            if (req && keyEl) {
                const why = (req.reasons || []).join('; ');
                keyEl.title = (keyEl.title ? keyEl.title + '\n\n' : '') +
                    (_requiredKeys.has(key) ? 'Required' : 'Recommended') + (why ? ` — ${why}` : '');
            }
            if (_recommendedKeys.has(key)) row.classList.add('ra-recommended');
            if (!_requiredKeys.has(key)) return;

            row.classList.add('ra-required');
            if (input && _checkValue(key, input.value)) input.classList.add('ra-missing');
            const btn = row.querySelector('button');
            if (btn) btn.outerHTML = `<span class="ra-locked-icon" title="${key} is required and cannot be removed">🔒</span>`;
        });
    }

    // apply the layout when a ship opens

    function _patchPopulateBuilder() {
        if (typeof window.sbPopulateBuilder !== 'function') {
            console.warn('[RequiredAttrs] sbPopulateBuilder not found — skipping patch.');
            return;
        }
        const orig = window.sbPopulateBuilder;
        window.sbPopulateBuilder = function () {
            orig.apply(this, arguments);
            // sbMode is a global set by shipBuilder.js before sbPopulateBuilder runs
            const mode = (typeof sbMode !== 'undefined') ? sbMode : null;
            _applyLayoutMode(mode);
        };
    }

    // add the CSS once

    function _injectStyles() {
        if (document.getElementById('required-attrs-styles')) return;
        const style = document.createElement('style');
        style.id = 'required-attrs-styles';
        style.textContent = `

/* ── Locked attribute icon ───────────────────────────────────────── */
.ra-locked-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    font-size: 0.78rem;
    opacity: 0.55;
    cursor: default;
    flex-shrink: 0;
}

/* ── Required value missing / invalid ────────────────────────────── */
.attr-row.ra-required .attr-val-input.ra-missing {
    border-color: var(--c-danger-hi, #e05252);
    box-shadow: 0 0 0 1px var(--c-danger-hi, #e05252) inset;
}
.attr-row.ra-recommended .attr-key::after {
    content: ' •';
    opacity: 0.45;
}

/* ── Outfit-mode: collapse sidebar, span full width ──────────────── */
/*
   .builder-layout is a CSS grid with two columns:
       grid-template-columns: 320px 1fr   (from main.css line 2574)

   In outfit mode the sidebar panels (#sidebar-identity, #sidebar-description)
   are already hidden by shipBuilder.js (display:none).  We change the grid so
   that first column takes zero space, letting the main panel fill the full row.

   We use grid-template-columns rather than hiding the sidebar wrapper so that
   any padding/gap on .builder-layout doesn't leave a phantom gap either.
*/
.builder-layout.builder-layout--outfit-mode {
    grid-template-columns: 0 1fr;
    gap: 0 0;
}

/*
   The sidebar div itself still exists in the DOM (shipBuilder.js hides its
   children, not the wrapper).  Clamp it to zero so it doesn't peek through.
*/
.builder-layout.builder-layout--outfit-mode .builder-sidebar {
    width: 0;
    min-width: 0;
    overflow: hidden;
    padding: 0;
    gap: 0;
}

/*
   On narrow screens the grid already collapses to a single column, so the
   outfit-mode class has nothing extra to do — keep behaviour identical.
*/
@media (max-width: 900px) {
    .builder-layout.builder-layout--outfit-mode {
        grid-template-columns: 1fr;
    }
    .builder-layout.builder-layout--outfit-mode .builder-sidebar {
        width: auto;
        overflow: visible;
    }
}
`;
        document.head.appendChild(style);
    }

    // set it up. Called on page load

    function install() {
        _injectStyles();

        // needs the definitions — waits for them if not loaded yet
        function _init() {
            const d = _deriveRequirements();
            _requiredKeys    = new Set(d.required.keys());
            _recommendedKeys = new Set(d.recommended.keys());
            _requiredList    = _buildList(d.required);
            _recommendedList = _buildList(d.recommended);
            _reqMeta         = new Map([...d.required, ...d.recommended]);
            if (d.available) {
                console.log('[RequiredAttrs] Required (' + _requiredKeys.size + '): ' + [..._requiredKeys].sort().join(', '));
                console.log('[RequiredAttrs] Recommended (' + _recommendedKeys.size + '): ' + [..._recommendedKeys].sort().join(', '));
            }
        }

        _init(); // attempt immediately (works if attrDefs is inline in HTML)

        // Re-derive once live data arrives (DataLoader fires 'dataLoaded')
        document.addEventListener('dataLoaded', () => {
            _init();
            // Re-lock any already-rendered rows
            _lockRequiredRows();
        });

        _patchBlank();
        _patchShipFromParsed();
        _patchRemoveAttr();
        _patchUpdateAttrVal();
        _patchConfirmAddAttr();
        _patchRenderAttrList();
        _patchPopulateBuilder();
    }

    // ── window.ShipBuilderRequiredAttrs ──

    return { install, isRequired, isRecommended, validate, backfill: _backfill };

})();

document.addEventListener('DOMContentLoaded', () => {
    RequiredAttrs.install();
});
