'use strict';

// Stops builder edits that would put the ship over a capacity, and offers to remove outfits to fit.

const CapacityGuard = (() => {
    'use strict';

    // capacity attributes (same list the builder uses)

    // From the parser (gameKeys.js): attributes Ship::FinishLoading won't
    // allow below zero. The list is only the fallback before attrDefs loads.
    const _CAPACITY_FALLBACK = ['outfit space', 'engine capacity', 'weapon capacity', 'cargo space'];
    // capacity keys. Called by: the builder, ItemStats, sorters
    const capacityKeys = () => (window.GameKeys ? window.GameKeys.capacityKeys(_CAPACITY_FALLBACK) : _CAPACITY_FALLBACK);

    // ── highlighting rows that are over ──

    const HIGHLIGHT_MS = 3500;
    let _highlightTimer = null;

    // mark rows that are over
    function _highlightViolations(violatedKeys) {
        _clearHighlights();
        if (!violatedKeys || !violatedKeys.length) return;
        const panel = document.getElementById('sbs-root');
        if (!panel) return;
        const lowerKeys = violatedKeys.map(k => k.toLowerCase());
        panel.querySelectorAll('.sbs-card').forEach(card => {
            const labelEl = card.querySelector('.sbs-label');
            if (!labelEl) return;
            if (lowerKeys.some(k => labelEl.textContent.toLowerCase().includes(k)))
                card.classList.add('sbs-card--violation');
        });
        clearTimeout(_highlightTimer);
        _highlightTimer = setTimeout(_clearHighlights, HIGHLIGHT_MS);
    }

    // clear the marks
    function _clearHighlights() {
        document.querySelectorAll('.sbs-card--violation')
            .forEach(el => el.classList.remove('sbs-card--violation'));
    }

    // redraw the stats panel

    function _sbsRefresh() {
        if (typeof SBS !== 'undefined' && typeof SBS.refresh === 'function')
            SBS.refresh();
    }

    // capacities that would go negative. Called by: the guards

    function _checkViolations(hypotheticalOutfits) {
        const violations = [];

        for (const key of capacityKeys()) {
            const max = sbShipCapacity(key);
            if (max <= 0) continue;

            let used = 0;
            for (const entry of hypotheticalOutfits) {
                const name   = (entry.name || '').replace(/^"([^"]*)"$/, '$1');
                const count  = parseInt(entry.count) || 1;
                const effect = sbGetOutfitCapacityEffect(name, key);
                // Same formula as sbUsedCapacity: net cost = -effect * count
                used += (-effect) * count;
            }
            used = Math.max(0, used);

            if (used > max) {
                violations.push({ key, used, max, over: used - max });
            }
        }

        return violations;
    }

    // same, with some attributes changed first. Called by: attribute guards

    function _checkViolationsWithAttrOverrides(overrides) {
        if (!sbCurrentShip) return [];
        const violations = [];

        for (const key of capacityKeys()) {
            const max = (key in overrides) ? (Number(overrides[key]) || 0) : sbShipCapacity(key);
            if (max <= 0) continue;

            // Outfit list hasn't changed — use shipBuilder's current used value
            const used = sbUsedCapacity(key);
            if (used > max) {
                violations.push({ key, used, max, over: used - max });
            }
        }

        return violations;
    }

    // remove the fewest outfits to fit again (asks first). Called by: the guards

    function _smartBulkRemove(outfits, i, originalFn) {
        const target     = outfits[i];
        const targetName = (target.name || '').replace(/^"([^"]*)"$/, '$1');
        const oldCount   = parseInt(target.count) || 1;

        // Walk keepCount from 0 upward; stop at the first count that causes
        // no violation — that is the minimum needed.
        let minNeeded = oldCount; // pessimistic: assume we must keep all

        for (let keepCount = 0; keepCount < oldCount; keepCount++) {
            const hypo = outfits
                .map((o, idx) => idx === i ? { ...o, count: keepCount } : { ...o })
                .filter(o => (parseInt(o.count) || 0) > 0);

            if (!_checkViolations(hypo).length) {
                minNeeded = keepCount;
                break;
            }
        }

        if (minNeeded === oldCount) {
            // Cannot remove even one copy — hard block
            const hypoWithout = outfits.filter((_, idx) => idx !== i).map(o => ({ ...o }));
            _showModal(`remove "${targetName}"`, _checkViolations(hypoWithout), null);
            _highlightViolations(capacityKeys());
            _sbsRefresh();
            return;
        }

        const removedCount = oldCount - minNeeded;

        if (minNeeded === 0) {
            // All copies safe to remove — use original function for clean teardown
            originalFn.call(window, i);
        } else {
            // Reduce count in-place and re-render
            sbCurrentShip.outfits[i].count = minNeeded;
            sbRenderOutfitsList();
            sbRenderGunsTurrets();
            sbUpdateQuickStats();
            sbRenderRaw();
        }

        _showModal(null, null, {
            type:    'partial',
            name:    targetName,
            removed: removedCount,
            kept:    minNeeded,
        });
        _sbsRefresh();
    }

    // guard: removing an outfit

    function _guardRemoveOutfit(originalFn) {
        return function(i) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, i);

            const outfits = ship.outfits || [];
            const target  = outfits[i];
            if (!target) return originalFn.call(this, i);

            const targetName = (target.name || '').replace(/^"([^"]*)"$/, '$1');

            const hypoWithout = outfits
                .filter((_, idx) => idx !== i)
                .map(o => ({ ...o }));

            const violations = _checkViolations(hypoWithout);

            if (!violations.length) {
                return originalFn.call(this, i); // no problem — allow
            }

            // Outfit provides capacity that others depend on — try smart removal
            const providesCapacity = capacityKeys().some(
                key => sbGetOutfitCapacityEffect(targetName, key) > 0
            );

            if (providesCapacity) {
                _smartBulkRemove(outfits, i, originalFn);
            } else {
                _showModal(`remove "${targetName}"`, violations, null);
                _highlightViolations(violations.map(v => v.key));
                _sbsRefresh();
            }
        };
    }

    // guard: changing an outfit count

    function _guardUpdateOutfitCount(originalFn) {
        return function(i, newCountRaw) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, i, newCountRaw);

            const newCount = Math.max(1, parseInt(newCountRaw) || 1);
            const outfits  = ship.outfits || [];
            const target   = outfits[i];
            if (!target) return originalFn.call(this, i, newCountRaw);

            const oldCount = parseInt(target.count) || 1;
            if (newCount === oldCount) return originalFn.call(this, i, newCountRaw);

            if (newCount > oldCount) {
                // Increase — sbCheckOutfitSpace handles the block inside originalFn
                const result = originalFn.call(this, i, newCountRaw);
                _sbsRefresh();
                return result;
            }

            // Decrease — simulate and check
            const hypo = outfits.map((o, idx) =>
                idx === i ? { ...o, count: newCount } : { ...o }
            );
            const violations = _checkViolations(hypo);

            if (!violations.length) {
                return originalFn.call(this, i, newCountRaw);
            }

            _smartBulkRemove(outfits, i, (idx) => originalFn.call(window, idx));
        };
    }

    // guard: removing an attribute

    function _guardRemoveAttr(originalFn) {
        return function(key) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, key);

            if (!capacityKeys().includes(key)) return originalFn.call(this, key);

            const violations = _checkViolationsWithAttrOverrides({ [key]: 0 });

            if (violations.length) {
                _showModal(`remove attribute "${key}"`, violations, null);
                _highlightViolations(violations.map(v => v.key));
                _sbsRefresh();
                return; // block
            }

            return originalFn.call(this, key);
        };
    }

    // guard: changing an attribute

    function _guardUpdateAttrVal(originalFn) {
        return function(inp) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, inp);

            const key    = inp.dataset.key;
            const newVal = parseFloat(inp.value);
            const oldVal = sbShipCapacity(key); // current max from builder

            if (!capacityKeys().includes(key)) return originalFn.call(this, inp);
            if (isNaN(newVal) || newVal >= oldVal) return originalFn.call(this, inp);

            const violations = _checkViolationsWithAttrOverrides({ [key]: newVal });

            if (violations.length) {
                _showModal(`reduce "${key}" to ${newVal}`, violations, null);
                inp.value = String(oldVal); // restore displayed value
                _highlightViolations(violations.map(v => v.key));
                _sbsRefresh();
                return; // block
            }

            return originalFn.call(this, inp);
        };
    }

    // guard: adding an attribute

    function _guardConfirmAddAttr(originalFn) {
        return function(...args) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.apply(this, args);

            const keyEl = document.getElementById('new-attr-key');
            const valEl = document.getElementById('new-attr-val');
            const key   = keyEl?.value?.trim() || '';
            const val   = parseFloat(valEl?.value);

            // Only guard capacity keys being set to a lower value than current
            if (!capacityKeys().includes(key) || isNaN(val))
                return originalFn.apply(this, args);

            const currentMax = sbShipCapacity(key);
            if (val >= currentMax) return originalFn.apply(this, args);

            const violations = _checkViolationsWithAttrOverrides({ [key]: val });

            if (violations.length) {
                _showModal(`set "${key}" to ${val}`, violations, null);
                _highlightViolations(violations.map(v => v.key));
                _sbsRefresh();
                return; // block
            }

            return originalFn.apply(this, args);
        };
    }

    // guard: adding a gun/turret/bay

    function _guardAddGunTurret(originalFn) {
        return function(type, ...rest) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.call(this, type, ...rest);

            // Only guard gun and turret hardpoints
            const attrKey = type === 'gun'    ? 'gun ports'
                          : type === 'turret' ? 'turret mounts'
                          : null;
            if (!attrKey) return originalFn.call(this, type, ...rest);

            const maxPorts = Number((ship.attributes || {})[attrKey]) || 0;
            if (maxPorts <= 0) return originalFn.call(this, type, ...rest); // no attr = no limit

            const field        = type === 'gun' ? 'guns' : 'turrets';
            const currentCount = (ship[field] || []).length;

            if (currentCount >= maxPorts) {
                _showModal(
                    `add ${type} port`,
                    [{ key: attrKey, used: currentCount + 1, max: maxPorts, over: 1 }],
                    null
                );
                _highlightViolations([attrKey]);
                _sbsRefresh();
                return; // block
            }

            return originalFn.call(this, type, ...rest);
        };
    }

    // would adding this outfit break an attribute rule (e.g. a minimum)? Called by: _guardAddOutfit

    function _checkAttrViolationsOnAdd(outfitName, count) {
        if (!sbCurrentShip) return [];

        const outfit = sbFindOutfit(outfitName);
        if (!outfit) return [];

        // Collect every numeric attribute the outfit touches
        const outfitAttrs = {};
        for (const src of [outfit.attributes || {}, outfit]) {
            for (const [k, v] of Object.entries(src)) {
                const n = Number(v);
                if (!isNaN(n) && n !== 0) outfitAttrs[k] = n;
            }
        }

        if (!Object.keys(outfitAttrs).length) return [];

        const violations = [];

        for (const [key, perUnitEffect] of Object.entries(outfitAttrs)) {
            // Skip non-attribute fields
            if (['name','displayName','category','cost','thumbnail','sprite',
                 'description','pluginId','weapon','_pn','_pd'].includes(key)) continue;

            const totalEffect = perUnitEffect * count;

            // Only care about effects that make an attribute DECREASE
            if (totalEffect >= 0) continue;

            // Compute the current net value of this attribute on the ship
            // = ship base value + sum of all currently installed outfit contributions
            const shipBase = Number((sbCurrentShip.attributes || {})[key]) || 0;
            let outfitNet = 0;
            for (const entry of (sbCurrentShip.outfits || [])) {
                const n = (entry.name || '').replace(/^"([^"]*)"$/, '$1');
                const c = parseInt(entry.count) || 1;
                outfitNet += sbGetOutfitAttrValue(n, key) * c;
            }
            const currentNet = shipBase + outfitNet;
            const wouldBe    = currentNet + totalEffect;

            // Only flag if the result would be negative AND the attribute must
            // stay non-negative according to AttrValidation rules
            if (wouldBe >= 0) continue;

            // Use AttrValidation if available, otherwise default to min=0
            let min = 0;
            if (typeof AttrValidation !== 'undefined' && typeof AttrValidation.getRule === 'function') {
                const rule = AttrValidation.getRule(key);
                // If min is null the attribute is allowed to go negative — skip
                if (rule.min === null) continue;
                min = rule.min;
            }

            if (wouldBe < min) {
                violations.push({
                    key,
                    currentNet,
                    wouldBe,
                    deficit: min - wouldBe,
                });
            }
        }

        return violations;
    }

    // guard: adding an outfit

    function _guardAddOutfit(originalFn) {
        return function(...args) {
            const ship = (typeof sbCurrentShip !== 'undefined') ? sbCurrentShip : null;
            if (!ship) return originalFn.apply(this, args);

            // name and count from whichever add window is open
            let outfitName = null;
            let count      = 1;

            if (args[0] && typeof args[0] === 'string') {
                // sbAddOutfitFromPicker path
                try {
                    const payload = JSON.parse(decodeURIComponent(escape(atob(args[0]))));
                    outfitName = (payload.name || '').replace(/^"([^"]*)"$/, '$1').trim();
                } catch(e) {}
                const countEl = document.getElementById('sb-outfit-count-input');
                count = parseInt(countEl?.value) || 1;
            } else {
                // confirmAddOutfit path
                const nameEl  = document.getElementById('new-outfit-name');
                const countEl = document.getElementById('new-outfit-count');
                outfitName = (nameEl?.value || '').trim().replace(/^"([^"]*)"$/, '$1');
                count      = parseInt(countEl?.value) || 1;
            }

            if (!outfitName) return originalFn.apply(this, args);

            // Check non-capacity attribute violations (capacity is handled by
            // sbCheckOutfitSpace inside the original function)
            const attrViolations = _checkAttrViolationsOnAdd(outfitName, count);

            if (attrViolations.length) {
                _showModal(
                    `add ${count > 1 ? count + '× ' : ''}"${outfitName}"`,
                    attrViolations.map(v => ({
                        key:  v.key,
                        used: -v.wouldBe,          // how far below zero it would go
                        max:  Math.max(0, v.currentNet), // current value (the "budget")
                        over: v.deficit,
                    })),
                    null
                );
                _highlightViolations(attrViolations.map(v => v.key));
                _sbsRefresh();
                return; // block — do not call original
            }

            const result = originalFn.apply(this, args);
            _sbsRefresh();
            return result;
        };
    }

    // ── styles and the warning window ──

    const MODAL_ID = 'modal-cap-guard';

    // add the CSS once
    function _injectStyles() {
        if (!document.getElementById('cap-guard-styles')) {
            const style = document.createElement('style');
            style.id = 'cap-guard-styles';
            style.textContent = `
.sbs-card--violation {
    outline: 2px solid var(--c-danger-hi, #fc8181) !important;
    background: rgba(252,129,129,0.12) !important;
    animation: cap-guard-pulse 0.4s ease-in-out 3;
}
@keyframes cap-guard-pulse {
    0%,100% { outline-color: var(--c-danger-hi, #fc8181); }
    50%      { outline-color: transparent; }
}
#modal-cap-guard .cap-guard-violations {
    margin: 4px 0 14px; padding: 0; list-style: none;
}
#modal-cap-guard .cap-guard-violations li {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 6px 10px; margin-bottom: 5px;
    border-radius: var(--r-sm, 6px);
    background: rgba(252,129,129,0.10);
    border: 1px solid rgba(252,129,129,0.25);
    font-size: 0.86rem; color: var(--c-text-mid, #cbd5e0);
}
#modal-cap-guard .cgv-name {
    font-weight: 700; color: var(--c-danger-hi, #fc8181);
}
#modal-cap-guard .cgv-nums {
    font-variant-numeric: tabular-nums; font-size: 0.82rem;
    color: var(--c-text-dim, #718096); white-space: nowrap; margin-left: 12px;
}
#modal-cap-guard .cap-guard-partial-info {
    padding: 10px 14px; margin-bottom: 12px;
    border-radius: var(--r-sm, 6px);
    background: rgba(129,200,252,0.10);
    border: 1px solid rgba(129,200,252,0.25);
    font-size: 0.86rem; color: var(--c-text-mid, #cbd5e0);
}
#modal-cap-guard .cap-guard-partial-info strong { color: var(--c-info-hi, #90cdf4); }
#modal-cap-guard .cap-guard-hint {
    font-size: 0.82rem; color: var(--c-text-muted, #64748b); margin: 0;
}`;
            document.head.appendChild(style);
        }

        if (!document.getElementById(MODAL_ID)) {
            const wrap = document.createElement('div');
            wrap.innerHTML = `
<div id="modal-cap-guard" class="modal-overlay">
  <div class="modal-box" style="width:min(440px,96vw);">
    <div class="modal-header">
      <div class="modal-title" id="cgm-title">Cannot Make Change</div>
      <button class="modal-close"
        onclick="document.getElementById('modal-cap-guard').classList.remove('active')">×</button>
    </div>
    <p class="confirm-text" id="cgm-action" style="margin-bottom:12px;"></p>
    <div id="cgm-partial"></div>
    <ul class="cap-guard-violations" id="cgm-list"></ul>
    <p class="cap-guard-hint" id="cgm-hint"></p>
    <div class="btn-group btn-group-right" style="margin-top:16px;">
      <button class="btn btn-secondary"
        onclick="document.getElementById('modal-cap-guard').classList.remove('active')">OK</button>
    </div>
  </div>
</div>`;
            document.body.appendChild(wrap.firstElementChild);
            document.getElementById(MODAL_ID).addEventListener('click', function(e) {
                if (e.target === this) this.classList.remove('active');
            });
        }
    }

    // "outfit space" → "Outfit Space"
    function _capWords(s) {
        return String(s).split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    // the warning window
    function _showModal(actionDesc, violations, partialInfo) {
        _injectStyles();

        const titleEl   = document.getElementById('cgm-title');
        const actionEl  = document.getElementById('cgm-action');
        const listEl    = document.getElementById('cgm-list');
        const partialEl = document.getElementById('cgm-partial');
        const hintEl    = document.getElementById('cgm-hint');

        if (partialEl) partialEl.innerHTML = '';
        if (listEl)    listEl.innerHTML    = '';
        if (actionEl)  actionEl.textContent = '';
        if (hintEl)    hintEl.textContent   = '';

        if (partialInfo?.type === 'partial') {
            if (titleEl)  titleEl.textContent = 'Partial Removal';
            if (actionEl) actionEl.textContent =
                `Not all copies of "${partialInfo.name}" could be removed.`;

            if (partialEl) {
                const keptLine = partialInfo.kept > 0
                    ? ` <strong>${partialInfo.kept}</strong> cop${partialInfo.kept === 1 ? 'y' : 'ies'} must remain to support other installed outfits.`
                    : '';
                partialEl.innerHTML = `<div class="cap-guard-partial-info">
                    <strong>${partialInfo.removed}</strong>
                    cop${partialInfo.removed === 1 ? 'y' : 'ies'} removed.${keptLine}
                </div>`;
            }
            if (hintEl) hintEl.textContent =
                'Remove outfits that depend on this capacity first to free up more.';

        } else {
            if (titleEl)  titleEl.textContent  = 'Cannot Make Change';
            if (actionEl) actionEl.textContent =
                `This action would exceed capacity: ${actionDesc}`;

            if (listEl && violations?.length) {
                listEl.innerHTML = violations.map(v => `<li>
                    <span class="cgv-name">${_capWords(v.key)}</span>
                    <span class="cgv-nums">
                        ${Math.round(v.used)} used / ${Math.round(v.max)} max
                        &nbsp;(${Math.round(v.over)} over)
                    </span>
                </li>`).join('');
            }
            if (hintEl) hintEl.textContent = 'Remove other outfits first to free up space.';
        }

        document.getElementById(MODAL_ID).classList.add('active');
    }

    // wrap the builder functions with the guards. Called on page load

    function install() {
        _injectStyles();

        // wrap one builder function
        const wrap = (name, guardFn) => {
            if (typeof window[name] === 'function') {
                window[name] = guardFn(window[name]);
            } else {
                console.warn(`[CapacityGuard] ${name} not found — skipping.`);
            }
        };

        wrap('sbRemoveOutfit',        _guardRemoveOutfit);
        wrap('sbUpdateOutfitCount',   _guardUpdateOutfitCount);
        wrap('sbRemoveAttr',          _guardRemoveAttr);
        wrap('sbUpdateAttrVal',       _guardUpdateAttrVal);
        wrap('confirmAddAttr',        _guardConfirmAddAttr);
        wrap('addGunTurret',          _guardAddGunTurret);
        wrap('sbAddOutfitFromPicker', _guardAddOutfit);
        wrap('confirmAddOutfit',      _guardAddOutfit);

        console.log('[CapacityGuard] Installed on 8 functions.');
    }

    return { install };

})();

document.addEventListener('DOMContentLoaded', () => {
    CapacityGuard.install();
});
