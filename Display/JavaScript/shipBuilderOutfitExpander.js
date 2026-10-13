'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  shipBuilderOutfitExpander.js  —  Expandable Outfit Detail Panels
//
//  INTEGRATION
//  ─────────────────────────────────────────────────────────────────────────────
//  Load AFTER all other builder scripts:
//
//      <script src="../JavaScript/shipBuilder.js"></script>
//      <script src="../JavaScript/shipBuilderRequiredAttrs.js"></script>
//      <script src="../JavaScript/shipBuilderAttrValidation.js"></script>
//      <script src="../JavaScript/shipBuilderCapacityGuard.js"></script>
//      <script src="../JavaScript/computedStats.js"></script>
//      <script src="../JavaScript/AttributeDisplay.js"></script>
//      <script src="../JavaScript/shipBuilderStats.js"></script>
//      <script src="../JavaScript/shipBuilderOutfitExpander.js"></script>
//
//  WHAT THIS DOES
//  ─────────────────────────────────────────────────────────────────────────────
//  Adds a ▶ expand toggle to:
//
//    1. Every installed-outfit row in the ship builder outfit list
//       (#outfits-list .outfit-item)
//
//    2. Every outfit row in the outfit picker modal
//       (#sb-outfit-picker-list .sb-picker-row)
//
//  Multiple panels can be open simultaneously — each wrapper is self-contained.
//
//  DESIGN
//  ─────────────────────────────────────────────────────────────────────────────
//  • CSS tokens are all var(--c-*) / var(--r-*) from main.css — nothing hardcoded
//  • Each wrapper independently tracks open/closed via aria-expanded on its toggle
//  • Panel is injected as a child of the wrapper div
//  • Re-hooks automatically whenever sbRenderOutfitsList or sbOpenOutfitPicker
//    re-renders their lists (both are patched below)
//  • MutationObserver is NOT used (it interfered with the picker search filter)
// ═══════════════════════════════════════════════════════════════════════════════

const OutfitExpander = (() => {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    //  CONSTANTS
    // ─────────────────────────────────────────────────────────────────────────

    const CLS = {
        toggle:        'oe-toggle',
        panel:         'oe-panel',
        panelOpen:     'oe-panel--open',
        imgWrap:       'oe-img-wrap',
        imgInitials:   'oe-img-initials',
        noStats:       'oe-no-stats',
        wrapper:       'oe-wrapper',
        pickerWrapper: 'oe-picker-wrapper',
    };

    // ─────────────────────────────────────────────────────────────────────────
    //  OUTFIT LOOKUP
    // ─────────────────────────────────────────────────────────────────────────

    function _findOutfit(name) {
        const clean = name.replace(/^"([^"]*)"$/, '$1').trim();

        if (typeof sbFindOutfit === 'function') {
            const found = sbFindOutfit(clean);
            if (found) return found;
        }

        const allData = (window.DataLoader && typeof window.DataLoader.getActiveData === 'function' ? window.DataLoader.getActiveData() : (window.allData || {}));   // selected plugins only
        for (const pluginData of Object.values(allData)) {
            const found = (pluginData.outfits || []).find(o =>
                (o.name || o.displayName || '').replace(/^"([^"]*)"$/, '$1').trim() === clean
            );
            if (found) return found;
        }
        return null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  ESCAPE
    // ─────────────────────────────────────────────────────────────────────────

    function _esc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PANEL HTML SCAFFOLD
    // ─────────────────────────────────────────────────────────────────────────

    function _buildStatPanel(outfit) {
        if (!outfit) {
            return `<div class="${CLS.panel}">
                <div class="${CLS.noStats}">Outfit data not found.</div>
            </div>`;
        }

        const initials = (outfit.name || '?')
            .replace(/^"([^"]*)"$/, '$1').trim()
            .split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();

        return `<div class="${CLS.panel}">
            <div class="${CLS.imgWrap}">
                <div class="${CLS.imgInitials}">${_esc(initials)}</div>
            </div>
            <div class="oe-stats-body"></div>
        </div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  POPULATE PANEL  — image + stats via AttributeDisplay / ComputedStats
    // ─────────────────────────────────────────────────────────────────────────

    function _populatePanel(panel, outfit) {
        const pluginId = outfit._pluginId || outfit._pn || null;

        // ── Image ──────────────────────────────────────────────────────────
        const imgWrap    = panel.querySelector('.' + CLS.imgWrap);
        const spritePath = outfit.thumbnail || outfit.sprite || null;

        if (spritePath && typeof window.fetchSprite === 'function' && imgWrap) {
            if (pluginId && typeof window.setCurrentPlugin === 'function') {
                window.setCurrentPlugin(pluginId);
            }
            if (typeof window.initImageIndex === 'function') {
                window.initImageIndex(pluginId || undefined);
            }
            window.fetchSprite(spritePath, outfit.spriteData || {})
                .then(element => {
                    if (!element || !imgWrap.isConnected) return;
                    element.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;image-rendering:pixelated;display:block;margin:auto;';
                    imgWrap.innerHTML = '';
                    imgWrap.appendChild(element);
                })
                .catch(() => {});
        }

        // ── Stats ──────────────────────────────────────────────────────────
        const statsBody = panel.querySelector('.oe-stats-body');
        if (!statsBody) return;

        if (!window.AttributeDisplay?.renderAttributesTabEnhanced || !window.attrDefs) {
            statsBody.innerHTML = `<div class="${CLS.noStats}">Stats unavailable — data still loading.</div>`;
            return;
        }

        // Normalise: merge attributes sub-object to top level so both
        // AttributeDisplay and ComputedStats can find all keys regardless
        // of whether data came from a remote plugin or local build.
        const subAttrs   = outfit.attributes || {};
        const normalised = { ...outfit };

        for (const [k, v] of Object.entries(subAttrs)) {
            if (!(k in normalised)) normalised[k] = v;
        }
        if (!normalised.attributes)            normalised.attributes  = subAttrs;
        if (!normalised._pluginId && pluginId) normalised._pluginId   = pluginId;

        // Pre-warm ComputedStats cache so calcDerivedStats hits it instantly
        if (
            typeof window.getComputedStats === 'function' &&
            typeof ComputedStats !== 'undefined' &&
            ComputedStats.isReady() &&
            normalised._pluginId
        ) {
            try { window.getComputedStats(normalised, normalised._pluginId); }
            catch (e) { console.warn('[OE] ComputedStats pre-warm error:', e); }
        }

        statsBody.innerHTML = window.AttributeDisplay.renderAttributesTabEnhanced(
            normalised, window.attrDefs, 'outfits', normalised._pluginId
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TOGGLE LOGIC  — each wrapper is fully self-contained, no shared state
    // ─────────────────────────────────────────────────────────────────────────

    function _closePanel(wrapper, toggle) {
        const panel = wrapper.querySelector('.' + CLS.panel);
        if (panel) {
            panel.classList.remove(CLS.panelOpen);
            panel.addEventListener('transitionend', () => panel.remove(), { once: true });
            setTimeout(() => { if (panel.parentNode) panel.remove(); }, 320);
        }
        toggle.textContent = '▶';
        toggle.setAttribute('aria-expanded', 'false');
    }

    function _openPanel(wrapper, toggle, outfitName) {
        const outfit = _findOutfit(outfitName);
        if (!outfit && !outfitName) return;

        const div     = document.createElement('div');
        div.innerHTML = _buildStatPanel(outfit || { name: outfitName });
        const panel   = div.firstElementChild;
        wrapper.appendChild(panel);

        if (outfit) _populatePanel(panel, outfit);

        requestAnimationFrame(() => {
            requestAnimationFrame(() => panel.classList.add(CLS.panelOpen));
        });

        toggle.textContent = '▼';
        toggle.setAttribute('aria-expanded', 'true');
    }

    function _handleToggle(wrapper, toggle, outfitName) {
        if (toggle.getAttribute('aria-expanded') === 'true') {
            _closePanel(wrapper, toggle);
        } else {
            _openPanel(wrapper, toggle, outfitName);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  HOOK: installed outfit list  (#outfits-list)
    // ─────────────────────────────────────────────────────────────────────────

    function _hookInstalledList() {
        const listEl = document.getElementById('outfits-list');
        if (!listEl) return;

        listEl.querySelectorAll('.outfit-item:not([data-oe-hooked])').forEach(item => {
            item.setAttribute('data-oe-hooked', '1');

            const nameEl = item.querySelector('.outfit-item__name');
            if (!nameEl) return;
            const outfitName = nameEl.getAttribute('title') || nameEl.textContent.trim();

            const btn = document.createElement('button');
            btn.className   = CLS.toggle + ' oe-toggle--installed';
            btn.textContent = '▶';
            btn.title       = 'Show outfit details';
            btn.setAttribute('aria-expanded', 'false');
            btn.type        = 'button';

            const wrapper = document.createElement('div');
            wrapper.className = CLS.wrapper;
            item.parentNode.insertBefore(wrapper, item);
            wrapper.appendChild(item);
            item.insertBefore(btn, item.firstChild);

            btn.addEventListener('click', e => {
                e.stopPropagation();
                _handleToggle(wrapper, btn, outfitName);
            });
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  HOOK: outfit picker rows  (#sb-outfit-picker-list)
    // ─────────────────────────────────────────────────────────────────────────

    function _hookPickerList() {
        const listEl = document.getElementById('sb-outfit-picker-list');
        if (!listEl) return;

        listEl.querySelectorAll('.sb-picker-row:not([data-oe-hooked])').forEach(row => {
            row.setAttribute('data-oe-hooked', '1');

            const nameEl = row.querySelector('.sb-picker-name');
            if (!nameEl) return;
            // the internal name (the visible text may be the display name)
            const outfitName = nameEl.dataset.name || nameEl.textContent.trim();

            const btn = document.createElement('button');
            btn.className   = CLS.toggle + ' oe-toggle--picker';
            btn.textContent = '▶';
            btn.title       = 'Show outfit details';
            btn.setAttribute('aria-expanded', 'false');
            btn.type        = 'button';

            const wrapper = document.createElement('div');
            wrapper.className = CLS.pickerWrapper;
            row.parentNode.insertBefore(wrapper, row);
            wrapper.appendChild(row);
            row.appendChild(btn);

            btn.addEventListener('click', e => {
                e.stopPropagation();
                _handleToggle(wrapper, btn, outfitName);
            });
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PATCH builder functions so hooks re-run after every render
    // ─────────────────────────────────────────────────────────────────────────

    function _patchBuilderFunctions() {
        if (typeof window.sbRenderOutfitsList === 'function') {
            const orig = window.sbRenderOutfitsList;
            window.sbRenderOutfitsList = function (...args) {
                const r = orig.apply(this, args);
                requestAnimationFrame(_hookInstalledList);
                setTimeout(_hookInstalledList, 50);
                return r;
            };
        }

        if (typeof window.sbOpenOutfitPicker === 'function') {
            const orig = window.sbOpenOutfitPicker;
            window.sbOpenOutfitPicker = function (...args) {
                const r = orig.apply(this, args);
                requestAnimationFrame(_hookPickerList);
                setTimeout(_hookPickerList, 50);
                return r;
            };
        }

        // sbFilterOutfitPicker only toggles display on existing .sb-picker-row
        // and .sb-picker-group elements. Our .oe-picker-wrapper sits as the
        // parent of each row, so it also gets shown/hidden correctly because
        // sbFilterOutfitPicker targets the inner .sb-picker-row directly via
        // its own display toggle — the wrapper follows along naturally.
        // We deliberately do NOT patch sbFilterOutfitPicker to avoid
        // double-wrapping rows or interfering with the search behaviour.
        if (typeof window.sbFilterOutfitPicker === 'function') {
            const orig = window.sbFilterOutfitPicker;
            window.sbFilterOutfitPicker = function (...args) {
                const r = orig.apply(this, args);
                // Also hide/show the wrapper so hidden rows collapse fully
                document.querySelectorAll('#sb-outfit-picker-list .oe-picker-wrapper').forEach(w => {
                    const row = w.querySelector('.sb-picker-row');
                    w.style.display = row?.style.display === 'none' ? 'none' : '';
                });
                return r;
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  STYLES — all in main.css
    // ─────────────────────────────────────────────────────────────────────────

    function _injectStyles() { return; }

    // ─────────────────────────────────────────────────────────────────────────
    //  INSTALL
    // ─────────────────────────────────────────────────────────────────────────

    function install() {
        _injectStyles();
        _patchBuilderFunctions();

        requestAnimationFrame(() => {
            _hookInstalledList();
            _hookPickerList();
        });

        // Ensure attrDefs is set on the builder page — DataViewer sets it in
        // its own onReady callback but the builder page may not load DataViewer.
        document.addEventListener('dataLoaded', () => {
            if (!window.attrDefs && typeof window.DataLoader?.getAttrDefs === 'function') {
                window.attrDefs = window.DataLoader.getAttrDefs();
            }
        });

        console.log('[OutfitExpander] Installed.');
    }

    return { install };

})();

document.addEventListener('DOMContentLoaded', () => {
    OutfitExpander.install();
});
