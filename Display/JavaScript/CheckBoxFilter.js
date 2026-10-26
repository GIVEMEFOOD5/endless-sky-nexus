let categoryFilterExpanded = false;
let lastCategoryFilter = [];
let savedCategoryFilterState = {};

// categories on the items
function extractCategories(data) {
    const categories = new Set();

    if (Array.isArray(data)) {
        data.forEach(item => {
            const category = item.category || item.attributes?.category;
            if (category) categories.add(category);
        });
    } else if (typeof data === 'object') {
        Object.values(data).forEach(item => {
            if (item) {
                const category = item.category || item.attributes?.category;
                if (category) categories.add(category);
            }
        });
    }

    const hasUncategorised = Array.isArray(data)
        ? data.some(item => !item.category && !item.attributes?.category)
        : Object.values(data).some(item => item && !item.category && !item.attributes?.category);
    if (hasUncategorised) categories.add('N/A');
    
    return Array.from(categories).sort();
}

// category tick boxes
function populateCategoryFilters(data) {
    lastCategoryFilter = data;
    const categories = extractCategories(data);
    const filterOptions = document.getElementById('filterOptions');
    const filterSection = document.getElementById('filterSection');

    if (categories.length === 0) {
        filterSection.classList.add("hidden");
        filterSection.classList.remove("shown");
        return;
    } else {
        filterSection.classList.remove("hidden");
        filterSection.classList.add("shown");
    }

    if (!categoryFilterExpanded) {
        filterOptions.innerHTML = '';
        return;
    }

    filterOptions.innerHTML = '';

    categories.forEach(category => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'filter-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `filter-${category}`;
        checkbox.value = category;
        // Restore saved state, default to false
        checkbox.checked = savedCategoryFilterState[category] ?? false;
        checkbox.onchange = filterItems;

        const label = document.createElement('label');
        label.htmlFor = `filter-${category}`;
        label.textContent = category;

        optionDiv.appendChild(checkbox);
        optionDiv.appendChild(label);
        filterOptions.appendChild(optionDiv);
    });
}

// ticked categories
function getSelectedCategories() {
    const checkboxes = document.querySelectorAll('#filterOptions input[type="checkbox"]');
    
    // If dropdowns are collapsed, read from saved state instead
    if (checkboxes.length === 0) {
        return Object.entries(savedCategoryFilterState)
            .filter(([_, checked]) => checked)
            .map(([value]) => value);
    }

    const selected = [];
    checkboxes.forEach(cb => { if (cb.checked) selected.push(cb.value); });
    return selected;
}

// clear every filter
function clearFilters() {
    savedCategoryFilterState = {};
    const checkboxes = document.querySelectorAll('#filterOptions input[type="checkbox"]');
    const searchBar = document.getElementById('searchInput');
    checkboxes.forEach(cb => { cb.checked = false; });
    searchBar.value = "";
    if (typeof clearGovernmentFilters === 'function') clearGovernmentFilters();
    filterItems();
}

// show/hide the category filter
function categoryFilterDisplay() {
    const filterOptions = document.getElementById('filterOptions');
    const filterTitle = document.getElementById('categoryFilterTitle');

    if (!filterOptions) return;

    categoryFilterExpanded = !categoryFilterExpanded;

    if (categoryFilterExpanded) {
        if (lastCategoryFilter.length) {
            filterTitle.classList.remove("filter-title-no-margin");
            filterTitle.classList.add("filter-title");
            filterTitle.innerHTML = 'Filter by Category: ▶';
            populateCategoryFilters(lastCategoryFilter);
        }
    } else {
        // Save state before clearing
        document.querySelectorAll('#filterOptions input[type="checkbox"]').forEach(cb => {
            savedCategoryFilterState[cb.value] = cb.checked;
        });

        filterOptions.innerHTML = '';
        filterTitle.classList.remove("filter-title");
        filterTitle.classList.add("filter-title-no-margin");
        filterTitle.innerHTML = 'Filter by Category: ▼';
    }
}

window.clearFilters = clearFilters;
window.populateCategoryFilters = populateCategoryFilters;
window.getSelectedCategories = getSelectedCategories;
window.categoryFilterDisplay = categoryFilterDisplay;
