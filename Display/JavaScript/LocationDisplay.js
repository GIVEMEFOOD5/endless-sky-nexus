'use strict';

// The Locations tab in the item window: where to buy it, who flies it, missions — per selected plugin.

// ── categories (icons, labels) ──

const LOCATION_CATEGORIES = [
    { key: 'Planets',         label: 'Planets',           icon: '🌍' },
    { key: 'Systems',         label: 'Systems',           icon: '✨' },
    { key: 'Missions',        label: 'Missions',          icon: '📋' },
    { key: 'Outfitters',      label: 'Outfitters',        icon: '🛒' },
    { key: 'Ships',           label: 'Ships with Outfit', icon: '🚀' },
    { key: 'ShipyardPlanets', label: 'Shipyard Planets',  icon: '🏭' },
];

const CATEGORY_KEY_SET = new Set(LOCATION_CATEGORIES.map(c => c.key));

// ── helpers ──

// every location key a selected plugin goes by
function _getActivePluginSet() {
    if (!window.PluginManager?.getActivePlugins) return null;

    const active = window.PluginManager.getActivePlugins();
    if (!Array.isArray(active) || active.length === 0) return null;

    const keys = new Set();
    const allData = window.allData || {};

    for (const outputName of active) {
        // Always include the bare outputName
        keys.add(outputName);

        // Also include "sourceName/outputName" if we can look it up
        const sourceName = allData[outputName]?.sourceName;
        if (sourceName) {
            keys.add(`${sourceName}/${outputName}`);
        }
    }

    return keys;
}

// plugin display name
function _pluginLabel(outputName) {
    return window.allData?.[outputName]?.displayName || outputName;
}

// one pill
function _makePill(text) {
    const pill = document.createElement('span');
    pill.className = 'ld-pill';
    pill.textContent = text;
    return pill;
}

// one category with its pills
function _buildCategorySection(cfg, values) {
    const section = document.createElement('div');
    section.className = 'ld-category';

    const header = document.createElement('div');
    header.className = 'ld-category-header';
    header.innerHTML =
        `<span class="ld-category-icon">${cfg.icon}</span>` +
        `<span class="ld-category-label">${cfg.label}</span>` +
        `<span class="ld-category-count">${values.length}</span>`;
    section.appendChild(header);

    const pills = document.createElement('div');
    pills.className = 'ld-pills';
    const frag = document.createDocumentFragment();
    for (const v of values) frag.appendChild(_makePill(v));
    pills.appendChild(frag);
    section.appendChild(pills);

    return section;
}

// a plugin block's contents (built when opened)
function _buildPluginContent(pluginData) {
    const content = document.createElement('div');
    content.className = 'ld-plugin-content';

    if (pluginData['_deprecated/unused']) {
        const badge = document.createElement('div');
        badge.className = 'ld-unused';
        badge.textContent = 'Not used anywhere in this plugin';
        content.appendChild(badge);
        return content;
    }

    let hasAny = false;
    for (const cfg of LOCATION_CATEGORIES) {
        const values = pluginData[cfg.key];
        if (!Array.isArray(values) || values.length === 0) continue;
        content.appendChild(_buildCategorySection(cfg, values));
        hasAny = true;
    }

    // Catch any future category keys not yet in LOCATION_CATEGORIES
    for (const [key, values] of Object.entries(pluginData)) {
        if (CATEGORY_KEY_SET.has(key) || key === '_deprecated/unused') continue;
        if (!Array.isArray(values) || values.length === 0) continue;
        const fallbackCfg = { key, label: key, icon: '📌' };
        content.appendChild(_buildCategorySection(fallbackCfg, values));
        hasAny = true;
    }

    if (!hasAny) {
        const empty = document.createElement('div');
        empty.className = 'ld-unused';
        empty.textContent = 'No location data found for this plugin';
        content.appendChild(empty);
    }

    return content;
}

// a collapsible plugin block
function _buildPluginBlock(outputName, pluginData, startExpanded) {
    const block = document.createElement('div');
    block.className = 'ld-plugin-block ld-plugin-active';

    // header
    const header = document.createElement('div');
    header.className = 'ld-plugin-header';
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', String(startExpanded));
    header.setAttribute('tabindex', '0');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'ld-plugin-name';
    nameSpan.textContent = _pluginLabel(outputName);

    const activeBadge = document.createElement('span');
    activeBadge.className = 'ld-plugin-badge';
    activeBadge.textContent = 'Active';

    const arrow = document.createElement('span');
    arrow.className = 'ld-arrow';
    arrow.textContent = startExpanded ? '▾' : '▸';

    header.appendChild(nameSpan);
    header.appendChild(activeBadge);
    header.appendChild(arrow);
    block.appendChild(header);

    // contents (built on first open)
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'ld-plugin-content-wrapper';
    contentWrapper.style.display = startExpanded ? 'block' : 'none';
    block.appendChild(contentWrapper);

    let contentBuilt = false;

    // open
    function expand() {
        if (!contentBuilt) {
            contentWrapper.appendChild(_buildPluginContent(pluginData));
            contentBuilt = true;
        }
        contentWrapper.style.display = 'block';
        arrow.textContent = '▾';
        header.setAttribute('aria-expanded', 'true');
    }

    // close
    function collapse() {
        contentWrapper.style.display = 'none';
        arrow.textContent = '▸';
        header.setAttribute('aria-expanded', 'false');
    }

    if (startExpanded) {
        contentWrapper.appendChild(_buildPluginContent(pluginData));
        contentBuilt = true;
    }

    header.addEventListener('click', () => {
        const expanded = contentWrapper.style.display !== 'none';
        expanded ? collapse() : expand();
    });
    header.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const expanded = contentWrapper.style.display !== 'none';
            expanded ? collapse() : expand();
        }
    });

    return block;
}

// ── main ──

// draw the tab. Called by: DataViewer.switchModalTab
function renderLocationsTab(container, item, pluginId) {
    container.innerHTML = '';

    const locations = item?.locations;

    if (!locations || Object.keys(locations).length === 0) {
        const empty = document.createElement('p');
        empty.className = 'ld-empty';
        empty.textContent = 'No location data available for this item.';
        container.appendChild(empty);
        return;
    }

    // needs the plugin list to be ready
    const activePlugins = _getActivePluginSet();

    if (!activePlugins) {
        const notice = document.createElement('p');
        notice.className = 'ld-empty';
        notice.textContent = 'Plugin list not ready. Please wait and reopen this tab.';
        container.appendChild(notice);
        return;
    }

    // only selected plugins
    const activeEntries = Object.entries(locations)
        .filter(([outputName]) => activePlugins.has(outputName));

    if (activeEntries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'ld-empty';
        empty.textContent = 'No location data available for any active plugin.';
        container.appendChild(empty);
        return;
    }

    // Sort alphabetically by display label
    activeEntries.sort(([a], [b]) => _pluginLabel(a).localeCompare(_pluginLabel(b)));

    // one block per plugin with data
    const autoExpand = activeEntries.length === 1;

    const frag = document.createDocumentFragment();
    for (const [outputName, pluginData] of activeEntries) {
        frag.appendChild(_buildPluginBlock(outputName, pluginData, autoExpand));
    }
    container.appendChild(frag);
}

// ── tab registration ──

// ── globals ──

window.LocationDisplay = { renderLocationsTab, injectStyles };
