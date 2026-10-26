let governmentFilterExpanded = false;
let lastGovernmentData = [];
let savedGovernmentFilterState = {};

// governments for an item
function getGovernmentsForItem(item) {
    if (!item) return [];
    const governments = new Set();
    // who flies / sells an item comes from its locations ("Governments" list)
    const locs = item.locations || (item.attributes && item.attributes.locations);
    if (typeof item.governments !== 'object' && locs && typeof locs === 'object') {
        const ids = window.DataLoader && window.DataLoader.getActivePluginIds ? window.DataLoader.getActivePluginIds() : null;
        for (const [pid, entry] of Object.entries(locs)) {
            if (ids && !ids.has(pid)) continue;
            for (const g of (entry && entry.Governments) || []) {
                const normalized = normalizeGovernmentName(String(g).trim());
                if (normalized) governments.add(normalized);
            }
        }
        return [...governments];
    }
    if (typeof item.governments !== 'object') return [];

    const activePlugins = new Set(window.PluginManager ? window.PluginManager.getActivePlugins() : []);

    for (const [govKey, govMap] of Object.entries(item.governments)) {
        if (typeof govMap !== 'object') continue;

        const isActive = [...activePlugins].some(pluginId =>
            govKey === pluginId || govKey.endsWith('/' + pluginId) || govKey === item._pluginId
        );

        if (!isActive) continue;

        for (const govName of Object.keys(govMap)) {
            const normalized = normalizeGovernmentName(govName.trim());
            if (normalized) governments.add(normalized);
        }
    }

    return [...governments];
}

// clean a government name
function normalizeGovernmentName(name) {
    return name.replace(/\s*\(.*?\)\s*$/, '').trim();
}

// every government on the items
function extractGovernments(data) {
    const governments = new Set();

    const processItem = item => {
        getGovernmentsForItem(item).forEach(g => governments.add(g));
    };

    if (Array.isArray(data)) {
        data.forEach(processItem);
    } else if (data && typeof data === 'object') {
        Object.values(data).forEach(processItem);
    }

    return Array.from(governments).sort();
}

// government tick boxes
function populateGovernmentFilters(data) {
    lastGovernmentData = data;

    const governments = extractGovernments(data);
    const filterOptions = document.getElementById('governmentFilterOptions');
    const filterSection = document.getElementById('governmentFilterSection');

    if (!filterOptions || !filterSection) return;

    if (governments.length === 0) {
        filterSection.classList.add("hidden");
        filterSection.classList.remove("shown");
        return;
    }

    filterSection.classList.remove("hidden");

    // If not expanded, don't touch the DOM at all — just update the data
    if (!governmentFilterExpanded) return;

    // Re-render checkboxes preserving checked state
    filterOptions.innerHTML = '';

    governments.forEach(government => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'filter-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `gov-filter-${CSS.escape(government)}`;
        checkbox.value = government;
        checkbox.checked = savedGovernmentFilterState[government] ?? false;
        checkbox.onchange = () => {
            savedGovernmentFilterState[government] = checkbox.checked;
            filterItems();
        };

        const label = document.createElement('label');
        label.htmlFor = `gov-filter-${CSS.escape(government)}`;
        label.textContent = government;

        optionDiv.appendChild(checkbox);
        optionDiv.appendChild(label);
        filterOptions.appendChild(optionDiv);
    });
}

// ticked governments
function getSelectedGovernments() {
    const checkboxes = document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]');

    if (checkboxes.length === 0) {
        return Object.entries(savedGovernmentFilterState)
            .filter(([_, checked]) => checked)
            .map(([value]) => value);
    }

    const selected = [];
    checkboxes.forEach(cb => { if (cb.checked) selected.push(cb.value); });
    return selected;
}

// does an item match?
function itemMatchesGovernmentFilter(item, selected) {
    if (selected.length === 0) return true;
    // the same governments the filter lists for this item (selected plugins only)
    const govs = new Set(getGovernmentsForItem(item));
    return selected.some(g => govs.has(normalizeGovernmentName(String(g).trim())));
}

// untick all
function clearGovernmentFilters() {
    savedGovernmentFilterState = {};
    const checkboxes = document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]');
    checkboxes.forEach(cb => { cb.checked = false; });
}

// show/hide the government filter
function governmentFilterDisplay() {
    const filterOptions = document.getElementById('governmentFilterOptions');
    const filterTitle = document.getElementById('governmentFilterTitle');

    if (!filterOptions) return;

    governmentFilterExpanded = !governmentFilterExpanded;

    if (governmentFilterExpanded) {
        filterTitle.classList.remove("filter-title-no-margin");
        filterTitle.classList.add("filter-title");
        filterTitle.innerHTML = 'Filter by Government: ▶';
        if (lastGovernmentData.length) {
            populateGovernmentFilters(lastGovernmentData);
        }
    } else {
        // Save state before collapsing
        document.querySelectorAll('#governmentFilterOptions input[type="checkbox"]').forEach(cb => {
            savedGovernmentFilterState[cb.value] = cb.checked;
        });

        filterOptions.innerHTML = '';
        filterTitle.classList.remove("filter-title");
        filterTitle.classList.add("filter-title-no-margin");
        filterTitle.innerHTML = 'Filter by Government: ▼';
    }
}

window.extractGovernments          = extractGovernments;
window.populateGovernmentFilters   = populateGovernmentFilters;
window.getSelectedGovernments      = getSelectedGovernments;
window.itemMatchesGovernmentFilter = itemMatchesGovernmentFilter;
window.clearGovernmentFilters      = clearGovernmentFilters;
window.governmentFilterDisplay     = governmentFilterDisplay;
