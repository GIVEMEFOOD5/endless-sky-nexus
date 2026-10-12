'use strict';

// ─── DataViewer.js ─────────────────────────────────────────────────────────
//
// Top-level orchestrator: tab switching, card rendering, modal display,
// and utility helpers.
//
// Data loading is fully delegated to dataLoader.js via window.DataLoader.
//
// Dependencies (loaded before this file):
//   dataLoader.js          — DataLoader, window.allData, window.attrDefs
//   generalPluginStuff.js  — PluginManager
//   generalFilterStuff.js  — filterItems (search, category and government filters), _filterGeneration
//   CheckBoxFilter.js      — getSelectedCategories, savedCategoryFilterState
//   GovernmentsFilter.js   — getSelectedGovernments, itemMatchesGovernmentFilter
//   Sorter.js              — applySorters, setSorterItems
//   AttributeDisplay.js    — window.AttributeDisplay
//   LocationDisplay.js     — window.LocationDisplay
//   ImageGrabber.js        — window.fetchSprite
//   ComputedStats.js       — initComputedStats
// ─────────────────────────────────────────────────────────────────────────────

let currentPlugin   = null;
let currentTab      = 'ships';
let filteredData    = [];
let currentModalTab = 'attributes';
let attrDefs        = null;

// ── Card → item reference (avoids JSON round-trips) ──────────────────────────
const _cardItemMap = new WeakMap();

// ─── Data loading — delegated to DataLoader ───────────────────────────────────

function loadData() {
    const loadingEl = document.getElementById('loadingIndicator');
    const errorEl   = document.getElementById('errorContainer');
    const mainEl    = document.getElementById('mainContent');

    if (loadingEl) loadingEl.style.display = 'block';
    if (errorEl)   errorEl.innerHTML       = '';
    if (mainEl)    mainEl.style.display    = 'none';

    if (typeof initImageIndex === 'function') initImageIndex();

    if (!window.DataLoader) {
        if (loadingEl) loadingEl.style.display = 'none';
        showError('Error: dataLoader.js must be loaded before DataViewer.js');
        return;
    }

    window.DataLoader.onReady((loadedData) => {
        // Pull globals populated by DataLoader
        window.allData = loadedData;
        attrDefs = window.attrDefs || null;

        if (attrDefs) {
            if (typeof setSorterAttrDefs === 'function') setSorterAttrDefs(attrDefs);
            if (typeof initComputedStats === 'function') {
                const REPO_URL = 'GIVEMEFOOD5/endless-sky-nexus';
                initComputedStats(attrDefs, `https://raw.githubusercontent.com/${REPO_URL}/main/data`);
            }
        }

        if (typeof initImageIndex  === 'function') initImageIndex();
        if (typeof setEffectPlugin === 'function')
            Object.keys(loadedData).forEach(n => setEffectPlugin(n));

        if (loadingEl) loadingEl.style.display = 'none';
        if (mainEl)    mainEl.style.display    = 'block';

        // PluginManager.initDefaultPlugin fires pluginsChanged → _renderCardsFromManager
        window.PluginManager.initDefaultPlugin();
    });

    // Handle load errors
    document.addEventListener('dataLoadError', (e) => {
        if (loadingEl) loadingEl.style.display = 'none';
        showError(`Error loading data: ${e.detail?.message || 'Unknown error'}`);
    }, { once: true });

    // Kick off the load (no-op if already loading or ready)
    window.DataLoader.load().catch(err => {
        if (loadingEl) loadingEl.style.display = 'none';
        showError(`Error loading data: ${err.message}`);
    });
}

// ─── Plugin selection ─────────────────────────────────────────────────────────

async function selectPlugin(outputName) {
    await window.PluginManager.setActivePlugins([outputName]);
}

// ─── Hook called by PluginManager after active plugins change ─────────────────

window._renderCardsFromManager = async function (resetTab = false) {
    currentPlugin = window.PluginManager.getPrimaryPlugin();

    if (resetTab) {
        currentTab = 'ships';
        document.querySelectorAll('.tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === 'ships');
        });
        if (typeof onSorterTabChange === 'function') onSorterTabChange('ships');
    }

    await renderCards();
};

// ─── Tab switching ────────────────────────────────────────────────────────────

function switchTab(tab) {
    // Ships and Variants share one search; moving to or from Outfits starts fresh
    const shipLike = t => t === 'ships' || t === 'variants';
    if (currentTab !== tab && !(shipLike(currentTab) && shipLike(tab))) {
        const searchBar = document.getElementById('searchInput');
        if (searchBar) searchBar.value = "";
    }

    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    if (typeof onSorterTabChange === 'function') onSorterTabChange(tab);
    window.CompareManager?.setActiveTab(tab);
    renderCards();
}

// ─── Card rendering ───────────────────────────────────────────────────────────

async function renderCards() {
    const items = window.PluginManager
        ? window.PluginManager.getMergedItems(currentTab)
        : [];

    filteredData = items;
    if (typeof getFilterData             === 'function') getFilterData(items);
    if (typeof populateCategoryFilters   === 'function') populateCategoryFilters(items);
    if (typeof populateGovernmentFilters === 'function') populateGovernmentFilters(items);
    if (typeof filterItems               === 'function') await filterItems();
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function updateStats() {
    if (!window.PluginManager) return;
    const activePlugins = window.PluginManager.getActivePlugins();
    const allData = window.allData || {};
    let ships = 0, variants = 0, outfits = 0;
    for (const n of activePlugins) {
        const d = allData[n];
        if (!d) continue;
        ships    += d.ships?.length    || 0;
        variants += d.variants?.length || 0;
        outfits  += d.outfits?.length  || 0;
    }
    const el = document.getElementById('stats');
    if (!el) return;
    el.innerHTML = `
        <div class="stat-card"><div class="stat-value">${ships}</div><div class="stat-label">Base Ships</div></div>
        <div class="stat-card"><div class="stat-value">${variants}</div><div class="stat-label">Variants</div></div>
        <div class="stat-card"><div class="stat-value">${outfits}</div><div class="stat-label">Outfits</div></div>
        <div class="stat-card"><div class="stat-value">${ships + variants + outfits}</div><div class="stat-label">Total Items</div></div>
    `;
}

// ─── Card placeholder ─────────────────────────────────────────────────────────

function createCardPlaceholder(item) {
    item._compareTab = currentTab;
    
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.spriteLoaded = 'false';
    _cardItemMap.set(card, item);
    card.onclick = () => showDetails(item);
    card.dataset.itemId = item._internalId || item.name || Math.random();
    
    const imgWrap = document.createElement('div');
    imgWrap.className = 'card-image card-image--placeholder';
    imgWrap.innerHTML = '<div style="width:100%;height:100%;background:rgba(15,23,42,0.5);border-radius:4px;"></div>';
 
    const content = document.createElement('div');
    content.className = 'card-content';
 
    // ── Title block ──────────────────────────────────────────────────────────
    // If a "display name" exists, show it large and the internal name smaller.
    const dn = item['display name'] || item.displayName || item.attributes?.['display name'];
    const displayName = dn && dn !== item.name ? dn : null;
    const internalName = item.name || 'Unknown';
 
    const title = document.createElement('div');
    title.className   = 'card-title';
    title.textContent = displayName || internalName;
    content.appendChild(title);
 
    if (displayName) {
        const subtitle = document.createElement('div');
        subtitle.className   = 'internal-name';
        subtitle.textContent = internalName;
        content.appendChild(subtitle);
    }
    // ── End title block ──────────────────────────────────────────────────────
 
    const details = document.createElement('div');
    details.className = 'card-details';
 
    if (currentTab === 'ships' || currentTab === 'variants') {
        details.innerHTML = `
            <div class="detail-item"><div class="detail-label">Category</div><div class="detail-value">${item.attributes?.category || 'N/A'}</div></div>
            <div class="detail-item"><div class="detail-label">Cost</div><div class="detail-value">${formatNumber(item.attributes?.cost) || '0'}</div></div>
            <div class="detail-item"><div class="detail-label">Hull</div><div class="detail-value">${formatNumber(item.attributes?.hull) || 'N/A'}</div></div>
            <div class="detail-item"><div class="detail-label">Shields</div><div class="detail-value">${formatNumber(item.attributes?.shields) || 'N/A'}</div></div>
        `;
    } else {
        details.innerHTML = `
            <div class="detail-item"><div class="detail-label">Category</div><div class="detail-value">${item.category || 'N/A'}</div></div>
            <div class="detail-item"><div class="detail-label">Cost</div><div class="detail-value">${formatNumber(item.cost) || '0'}</div></div>
            <div class="detail-item"><div class="detail-label">Mass</div><div class="detail-value">${item.mass || 'N/A'}</div></div>
            <div class="detail-item"><div class="detail-label">Outfit Space</div><div class="detail-value">${item['outfit space'] || 'N/A'}</div></div>
        `;
    }
 
    content.appendChild(details);
    card.appendChild(imgWrap);
    card.appendChild(content);

    const inner = document.createElement('div');
    inner.className = 'card-inner';
    inner.appendChild(imgWrap);
    inner.appendChild(content);
    card.appendChild(inner);
    
    const sorterBadges = document.createElement('div');
    sorterBadges.className = 'sorter-badges';
    card.appendChild(sorterBadges);

    const compareBtn = document.createElement('button');
    compareBtn.className = 'btn-compare';
    compareBtn.textContent = window.CompareManager?.isInList(item) ? '✓ In Compare' : '+ Compare';
    compareBtn.classList.toggle('btn-compare--active', window.CompareManager?.isInList(item));
    compareBtn.onclick = (e) => {
        e.stopPropagation();
        const added = window.CompareManager.toggle(item, currentTab);
        compareBtn.textContent   = window.CompareManager.isInList(item) ? '✓ In Compare' : '+ Compare';
        compareBtn.classList.toggle('btn-compare--active', window.CompareManager.isInList(item));
    };
    // Keep the button label in sync if the item is removed from elsewhere
    window.addEventListener('compareListChanged', () => {
        if (!document.body.contains(card)) return;
        const inList = window.CompareManager.isInList(item);
        compareBtn.textContent = inList ? '✓ In Compare' : '+ Compare';
        compareBtn.classList.toggle('btn-compare--active', inList);
    });
    card.appendChild(compareBtn);

    if (item._ownerUsername) {
        const ownerLine = document.createElement('div');
        ownerLine.className = 'card-owner-line';
        ownerLine.textContent = `by ${item._ownerUsername}`;
        card.appendChild(ownerLine);
    }

    return card;
}

// ─── Lazy sprite loader ───────────────────────────────────────────────────────

let _lazyObserver = null;

function initLazySprites(generation) {
    if (_lazyObserver) {
        _lazyObserver.disconnect();
        _lazyObserver = null;
    }

    _lazyObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const card = entry.target;
            if (card.dataset.spriteLoaded === 'true') continue;
            card.dataset.spriteLoaded = 'true';
            _lazyObserver.unobserve(card);
            _loadSpriteForCard(card, generation);
        }
    }, { rootMargin: '200px', threshold: 0 });

    document.querySelectorAll('#cardsContainer .card[data-sprite-loaded="false"]')
        .forEach(c => _lazyObserver.observe(c));
}

async function _loadSpriteForCard(card, generation) {
    if (generation !== window._filterGeneration) return;

    const item = _cardItemMap.get(card);
    if (!item) return;

    const imgWrap = card.querySelector('.card-image');
    if (!imgWrap) return;

    try {
        let element = null;

        if (currentTab === 'ships' || currentTab === 'variants') {
            if (item.sprite)    element = await window.fetchSprite(item.sprite, null);
            if (!element && item.thumbnail) element = await window.fetchSprite(item.thumbnail, null);
        } else {
            if (item.thumbnail) element = await window.fetchSprite(item.thumbnail, null);
        }

        if (generation !== window._filterGeneration) return;

        if (element) {
            element.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;image-rendering:pixelated;display:block;margin:auto;';
            imgWrap.innerHTML = '';
            imgWrap.appendChild(element);
        } else {
            const img = document.createElement('img');
            img.src   = 'https://GIVEMEFOOD5.github.io/endless-sky-nexus/data/endless-sky/images/outfit/unknown.png';
            img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;image-rendering:pixelated;display:block;margin:auto;';
            imgWrap.innerHTML = '';
            imgWrap.appendChild(img);
        }
    } catch (e) {
        console.warn('Failed to fetch sprite for', item.name, e);
    }
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function hasString(val) {
    return typeof val === 'string' && val.trim().length > 0;
}

function getAvailableTabs(item) {
    const tabs = [{ id: 'attributes', label: 'Attributes' }];
    if (item.locations && Object.keys(item.locations).length > 0)
        tabs.push({ id: 'locations', label: 'Locations' });
    if (hasString(item.thumbnail))
        tabs.push({ id: 'thumbnail', label: 'Thumbnail' });
    if (hasString(item.weapon?.['hardpoint sprite']))
        tabs.push({ id: 'hardpointSprite', label: 'Hardpoint' });
    if (hasString(item.sprite) || hasString(item.weapon?.sprite))
        tabs.push({ id: 'sprite', label: 'Sprite' });
    if (hasString(item['steering flare sprite']))
        tabs.push({ id: 'steeringFlare', label: 'Steering Flare' });
    if (hasString(item['flare sprite']))
        tabs.push({ id: 'flare', label: 'Flare' });
    if (hasString(item['reverse flare sprite']))
        tabs.push({ id: 'reverseFlare', label: 'Reverse Flare' });
    if (hasString(item.projectile))
        tabs.push({ id: 'projectile', label: 'Projectile' });
    if (hasString(item['afterburner effect']))
        tabs.push({ id: 'afterburnerEffect', label: 'Afterburner Effect' });
    return tabs;
}

async function showDetails(item) {
    const modal      = document.getElementById('detailModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody  = document.getElementById('modalBody');

    if (typeof clearSpriteCache === 'function') clearSpriteCache();

    {
        // display name first, the internal name smaller beside it
        const dn = item['display name'] || item.displayName || item.attributes?.['display name'];
        modalTitle.textContent = (dn && dn !== item.name ? dn : item.name) || 'Unknown';
        if (dn && dn !== item.name) {
            const sub = document.createElement('span');
            sub.className = 'ship-realname'; sub.title = 'Internal name'; sub.textContent = item.name;
            modalTitle.appendChild(sub);
        }
    }

    modalBody.innerHTML = '';

    if (item._ownerUsername) {
        const ownerLine = document.createElement('div');
        ownerLine.className = 'modal-owner-line';
        ownerLine.textContent = `by ${item._ownerUsername}`;
        modalBody.appendChild(ownerLine);
    }

    const availableTabs = getAvailableTabs(item);
    currentModalTab = availableTabs.length > 0 ? availableTabs[0].id : 'attributes';

    if (availableTabs.length > 0) {
        const tabBar = document.createElement('div');
        tabBar.className = 'modal-tabs';

        const tabContents = document.createElement('div');
        tabContents.className = 'modal-tab-contents';

        for (const tab of availableTabs) {
            const btn = document.createElement('button');
            btn.className   = 'modal-tab' + (tab.id === currentModalTab ? ' active' : '');
            btn.dataset.tab = tab.id;
            btn.textContent = tab.label;
            btn.onclick     = () => switchModalTab(tab.id);
            tabBar.appendChild(btn);

            const pane = document.createElement('div');
            pane.className   = 'modal-tab-content';
            pane.dataset.tab = tab.id;
            pane.style.display = 'none';
            tabContents.appendChild(pane);
        }

        modalBody.appendChild(tabBar);
        modalBody.appendChild(tabContents);
    }

    if (item.description) {
        const desc = document.createElement('div');
        desc.innerHTML = `
            <h3 style="color:#93c5fd;margin-top:30px;margin-bottom:10px;padding-top:20px;border-top:2px solid rgba(59,130,246,0.3);">Description</h3>
            <p style="margin-top:10px;line-height:1.6;color:#cbd5e1;">${item.description}</p>
        `;
        modalBody.appendChild(desc);
    }

    modalBody._item = item;
    
    const existingCmpBtn = document.getElementById('modalCompareBtn');
    if (existingCmpBtn) existingCmpBtn.remove();

    const modalCompareBtn = document.createElement('button');
    modalCompareBtn.id        = 'modalCompareBtn';
    modalCompareBtn.className = 'btn-compare';
    modalCompareBtn.style.cssText = 'margin-right:12px;';
    const _updateModalBtn = () => {
        const inList = window.CompareManager?.isInList(item);
        modalCompareBtn.textContent = inList ? '✓ In Compare' : '+ Compare';
        modalCompareBtn.classList.toggle('btn-compare--active', !!inList);
    };
    _updateModalBtn();
    modalCompareBtn.onclick = () => {
        window.CompareManager?.toggle(item, currentTab);
        _updateModalBtn();
    };
    // Insert before the close button inside .modal-header
    const modalHeader = document.querySelector('.modal-header');
    const closeBtn    = modalHeader?.querySelector('.btn-close');
    if (closeBtn) modalHeader.insertBefore(modalCompareBtn, closeBtn);
    
    modal.classList.add('active');
    await switchModalTab(currentModalTab);
}

async function switchModalTab(tabId) {
    currentModalTab = tabId;

    document.querySelectorAll('.modal-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tabId);
    });

    const modalBody = document.getElementById('modalBody');
    const item      = modalBody._item;
    if (!item) return;

    document.querySelectorAll('.modal-tab-content').forEach(c => {
        c.style.display = 'none';
        c.innerHTML     = '';
    });
    if (typeof clearSpriteCache === 'function') clearSpriteCache();

    const tabContent = document.querySelector(`.modal-tab-content[data-tab="${tabId}"]`);
    if (!tabContent) return;
    tabContent.style.display = 'block';

    if (tabId === 'attributes') {
        const pluginId = item._pluginId || currentPlugin;
        tabContent.innerHTML = renderAttributesTab(item, pluginId);
        return;
    }

    if (tabId === 'locations') {
        const pluginId = item._pluginId || currentPlugin;
        window.LocationDisplay.renderLocationsTab(tabContent, item, pluginId);
        return;
    }

    tabContent.innerHTML = '<p style="color:#94a3b8;text-align:center;">Loading…</p>';

    const pathMap = {
        thumbnail:         item.thumbnail,
        sprite:            item.sprite || item.weapon?.sprite,
        hardpointSprite:   item.weapon?.['hardpoint sprite'],
        steeringFlare:     item['steering flare sprite'],
        flare:             item['flare sprite'],
        reverseFlare:      item['reverse flare sprite'],
        projectile:        item.projectile,
        afterburnerEffect: item['afterburner effect'],
    };

    const element = await renderImageTab(pathMap[tabId], tabId, item.spriteData || {});
    if (currentModalTab !== tabId) return;

    tabContent.innerHTML = '';
    if (element) tabContent.appendChild(element);
}

async function renderImageTab(spritePath, altText, spriteParams) {
    if (!spritePath) return null;
    const element = await window.fetchSprite(spritePath, spriteParams || {});
    if (!element) {
        const p = document.createElement('p');
        p.style.color = '#ef4444';
        p.textContent = 'Failed to load: ' + (altText || 'Image');
        return p;
    }
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;justify-content:center;align-items:center;padding:20px;background:rgba(15,23,42,0.5);border-radius:8px;';
    wrap.appendChild(element);
    return wrap;
}

function renderAttributesTab(item, pluginIdOverride) {
    const pluginId = pluginIdOverride || item._pluginId || currentPlugin;

    if (attrDefs && window.AttributeDisplay) {
        return window.AttributeDisplay.renderAttributesTabEnhanced(item, attrDefs, currentTab, pluginId);
    }

    // ── Fallback plain renderer ───────────────────────────────────────────────
    let html = '';

    if (currentTab === 'ships' || currentTab === 'variants') {
        if (currentTab === 'variants' && item.baseShip)
            html += `<p style="color:#93c5fd;margin-bottom:20px;">Base Ship: ${item.baseShip}</p>`;
        html += '<div class="attribute-grid">';
        if (item.attributes) {
            for (const [key, value] of Object.entries(item.attributes)) {
                if (typeof value !== 'object')
                    html += `<div class="attribute"><div class="attribute-name">${key}</div><div class="attribute-value">${formatValue(value)}</div></div>`;
            }
        }
        html += '</div>';
        if (item.guns || item.turrets || item.bays || item.engines) {
            html += '<h3 style="color:#93c5fd;margin-top:20px;">Hardpoints</h3><div class="attribute-grid">';
            html += `
                <div class="attribute"><div class="attribute-name">Guns</div><div class="attribute-value">${item.guns?.length ?? 0}</div></div>
                <div class="attribute"><div class="attribute-name">Turrets</div><div class="attribute-value">${item.turrets?.length ?? 0}</div></div>
                <div class="attribute"><div class="attribute-name">Bays</div><div class="attribute-value">${item.bays?.length ?? 0}</div></div>
                <div class="attribute"><div class="attribute-name">Engines</div><div class="attribute-value">${item.engines?.length ?? 0}</div></div>
            `;
            html += '</div>';
        }
    } else if (currentTab === 'effects') {
        html += '<div class="attribute-grid">';
        const skip = new Set(['name','description','sprite','spriteData','_pluginId']);
        for (const [key, value] of Object.entries(item)) {
            if (!skip.has(key) && typeof value !== 'object')
                html += `<div class="attribute"><div class="attribute-name">${key}</div><div class="attribute-value">${formatValue(value)}</div></div>`;
        }
        html += '</div>';
    } else {
        html += '<div class="attribute-grid">';
        const skip = new Set(['name','description','thumbnail','sprite','hardpointSprite','hardpoint sprite',
            'steering flare sprite','flare sprite','reverse flare sprite','afterburner effect',
            'projectile','weapon','spriteData','_pluginId']);
        for (const [key, value] of Object.entries(item)) {
            if (!skip.has(key) && typeof value !== 'object')
                html += `<div class="attribute"><div class="attribute-name">${key}</div><div class="attribute-value">${formatValue(value)}</div></div>`;
        }
        html += '</div>';
        if (item.weapon) {
            html += '<h3 style="color:#93c5fd;margin-top:20px;">Weapon Stats</h3><div class="attribute-grid">';
            const weaponSkip = new Set(['sprite','spriteData','sound','hit effect','fire effect','die effect','submunition','stream','cluster']);
            for (const [key, value] of Object.entries(item.weapon)) {
                if (!weaponSkip.has(key) && typeof value !== 'object' && !Array.isArray(value))
                    html += `<div class="attribute"><div class="attribute-name">${key}</div><div class="attribute-value">${formatValue(value)}</div></div>`;
            }
            html += '</div>';
        }
    }

    return html;
}

// ─── Modal close ──────────────────────────────────────────────────────────────

function closeModal() {
    if (typeof clearSpriteCache === 'function') clearSpriteCache();
    document.querySelectorAll('.modal-tab-content').forEach(c => { c.innerHTML = ''; });
    const modal = document.getElementById('detailModal');
    modal.classList.remove('active');
    const modalBody = document.getElementById('modalBody');
    if (modalBody) delete modalBody._item;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatNumber(num) {
    if (num == null) return 'N/A';
    return num.toLocaleString();
}

function formatValue(value) {
    return typeof value === 'number' ? formatNumber(value) : value;
}

function showError(message) {
    const el = document.getElementById('errorContainer');
    if (el) el.innerHTML = `<div class="error">${message}</div>`;
}


// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    if (window.AttributeDisplay) window.AttributeDisplay.initTooltips();

    document.getElementById('detailModal').addEventListener('click', e => {
        if (e.target.id === 'detailModal') closeModal();
    });

    document.getElementById('pluginPickerOverlay').addEventListener('click', e => {
        if (e.target.id === 'pluginPickerOverlay') closePluginPicker();
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closeModal();
            closePluginPicker();
        }
    });

    // Kick off loading via DataLoader — no direct fetching here
    loadData();
});

// ─── Global exports ───────────────────────────────────────────────────────────

window.loadData              = loadData;
window.switchTab             = switchTab;
window.closeModal            = closeModal;
window.selectPlugin          = selectPlugin;
window.switchModalTab        = switchModalTab;
window.updateStats           = updateStats;
window.renderCards           = renderCards;
window.createCardPlaceholder = createCardPlaceholder;
window.filteredData          = filteredData;
