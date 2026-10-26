'use strict';

// The compare bar and panel. ItemStats works out every number; this file just lays them out.

window.CompareDisplay = (() => {

    let _panelOpen = false;
    let _viewMode  = 'columns';
    let _quantities = {}; // qKey(item) → integer ≥ 1
    // group member → how many ("groupId|index")
    let _groupMemberQtys = {};

    // own copy: "Outfit: X" / "Weapon: X" sections get added to it while drawing
    const SECTION_ORDER = window.AttributeSections.SECTION_ORDER.slice();

    const _attrDefs = () => window.attrDefs || null;

    function _fmt(v) {
        return window.ItemStats.fmtNum(v);
    }

    // quantity per item

    function _qKey(item) {
        return (item.name || '') + '|' + (item._compareTab || '');
    }

    function _getQty(item) {
        return _quantities[_qKey(item)] || 1;
    }

    function _setQty(item, n) {
        _quantities[_qKey(item)] = Math.max(1, Math.floor(n) || 1);
        _renderPanelContent();
    }

    // quantity per group member

    function _gmKey(groupId, idx) { return groupId + '|' + idx; }

    function _getGroupMemberQty(groupId, idx) {
        return _groupMemberQtys[_gmKey(groupId, idx)] || 1;
    }

    function _setGroupMemberQty(groupId, idx, n) {
        _groupMemberQtys[_gmKey(groupId, idx)] = Math.max(1, Math.floor(n) || 1);
        _renderPanelContent();
    }

    // "Outfit: X" / "Weapon: X" blocks aren't colour-compared

    function _isDetailSection(section) {
        return section.startsWith('Outfit: ') || section.startsWith('Weapon: ');
    }


    // one ItemStats row → what the panel shows (times the quantity if it adds up). Called by: CompareDisplay._buildAttrMap
    function _toDisplayRow(row, qty) {
        const scaled = (typeof row.raw === 'number' && row.scalesWithQty)
            ? _fmt(row.raw * qty)
            : row.value;
        // raw value added after it when enhanced details is on
        const display = window.ItemStats.formatRowDisplay(row, { baseValue: scaled });
        return { key: row.key, label: row.label, value: display, unit: row.unit || '', lowerBetter: !!row.lowerBetter };
    }

    // every row for one item, grouped by section. Called by: CompareDisplay._buildGroupAttrMap, _renderColumns, _renderTable
    function _buildAttrMap(item, qty, includeOutfits = true) {
        qty = (typeof qty === 'number' && qty >= 1) ? qty : 1;
        const sections = {};
        const addRow = (section, row) => (sections[section] = sections[section] || []).push(row);

        if (window.ItemStats.isShipItem(item)) {
            const stats = window.ItemStats.getShipStats(item, _attrDefs(), item._pluginId, { includeOutfits });
            for (const row of stats.rows) addRow(row.section, _toDisplayRow(row, qty));

            if (includeOutfits) {
                for (const [sectionKey, rows] of Object.entries(stats.outfitDetailSections)) {
                    if (!SECTION_ORDER.includes(sectionKey)) SECTION_ORDER.push(sectionKey);
                    for (const row of rows) addRow(sectionKey, _toDisplayRow(row, qty));
                }
            }
        } else {
            const stats = window.ItemStats.getOutfitStats(item, _attrDefs(), item._pluginId);
            for (const row of stats.rows) addRow(row.section, _toDisplayRow(row, qty));

            // the weapon's own fields (speed, range, reload …)
            if (item.weapon && typeof item.weapon === 'object') {
                const weapSkip = new Set(['sprite', 'spriteData', 'sound', 'hit effect', 'fire effect',
                    'die effect', 'submunition', 'submunitions', 'stream', 'cluster',
                    'hardpoint sprite', 'hardpoint offset', 'icon', 'ammunition', 'ammo']);
                for (const row of window.ItemStats.getRawAttributeRows(_attrDefs(), item.weapon, { skip: weapSkip }))
                    addRow('Weapon DPS', _toDisplayRow({ ...row, section: 'Weapon DPS' }, qty));
            }

            for (const row of stats.efficiencyRows) addRow(row.section, _toDisplayRow(row, qty));
        }

        return sections;
    }

    // one column for a whole group: members' stats added up. Called by: CompareDisplay._renderColumns, _renderTable
    function _buildGroupAttrMap(group, includeOutfits = true) {
        const isShipGroup = window.CompareManager.getGroupType() === 'ship';

        const resolvedMembers = group.members.map((m, i) => ({
            item: m.item,
            qty:  _getGroupMemberQty(group._groupId, i),
        }));

        // add up every member's stats
        const combined = {};

        for (const { item, qty } of resolvedMembers) {
            const useOutfits = isShipGroup ? includeOutfits : true;
            const memberMap  = _buildAttrMap(item, qty, useOutfits);

            for (const [section, rows] of Object.entries(memberMap)) {
                if (_isDetailSection(section)) continue;

                for (const { key, label, value, unit, lowerBetter } of rows) {
                    if (!combined[key]) {
                        const n = _parseDisplayNum(value);
                        combined[key] = {
                            label, unit, section, lowerBetter,
                            numeric:  n !== null,
                            rawSum:   n !== null ? n : null,
                            strValue: n === null ? value : null,
                        };
                    } else if (combined[key].numeric) {
                        const n = _parseDisplayNum(value);
                        if (n !== null) combined[key].rawSum += n;
                    }
                }
            }
        }

        const sections = {};
        // back into sections
        for (const [key, entry] of Object.entries(combined)) {
            const s = entry.section;
            if (!sections[s]) sections[s] = [];
            sections[s].push({
                key,
                label: entry.label,
                value: entry.numeric ? _fmt(entry.rawSum) : entry.strValue,
                unit:  entry.unit || '',
                lowerBetter: entry.lowerBetter,
            });
        }

        // one block per outfit, built once
        if (includeOutfits) {
            const outfitIdx = window.ItemStats.buildOutfitIndex();
            const detailSections = {}; // sectionKey → { rows, countSum }

            for (const { item, qty } of resolvedMembers) {
                const entries = window.ItemStats.outfitEntries(item.outfitMap || item.outfits || {});

                for (const [outfitName, installCount] of entries) {
                    if (!outfitName) continue;
                    const outfit = outfitIdx[outfitName];
                    if (!outfit) continue;

                    const isWeapon   = outfit.weapon && typeof outfit.weapon === 'object';
                    const sectionKey = isWeapon ? `Weapon: ${outfitName}` : `Outfit: ${outfitName}`;

                    if (!detailSections[sectionKey]) {
                        let rawRows;
                        if (isWeapon) {
                            const profile = window.ItemStats.getOutfitWeaponProfile(outfit, outfitIdx);
                            rawRows = profile
                                ? window.ItemStats.getWeaponDetailRows(_attrDefs(), outfitName, outfit, profile, 1, 1)
                                : window.ItemStats.getOutfitDetailRows(_attrDefs(), outfitName, outfit, 1, 1);
                        } else {
                            rawRows = window.ItemStats.getOutfitDetailRows(_attrDefs(), outfitName, outfit, 1, 1);
                        }

                        detailSections[sectionKey] = {
                            rows: rawRows.map(r => ({
                                key: r.key, label: r.label, value: r.value, unit: r.unit || '',
                                lowerBetter: !!r.lowerBetter, isDivider: !!r.isDivider,
                            })),
                            countSum: 0,
                        };

                        if (!SECTION_ORDER.includes(sectionKey)) SECTION_ORDER.push(sectionKey);
                    }

                    // fitted × member quantity, across every member
                    detailSections[sectionKey].countSum += installCount * qty;
                }
            }

            // show the real count
            for (const [sectionKey, { rows, countSum }] of Object.entries(detailSections)) {
                sections[sectionKey] = rows.map(row =>
                    (row.key === '_od_count' || row.key === '_wd_count')
                        ? { ...row, value: `×${countSum}` }
                        : row
                );
            }
        }

        return sections;
    }

    // rows that change or appear once outfits are added (ships only). Called by: CompareDisplay._renderColumns, _renderTable

    function _diffSectionMaps(baseMap, outfitMap) {
        const diff = {};
        for (const [section, outfitRows] of Object.entries(outfitMap)) {
            const baseRows  = baseMap[section] || [];
            const baseLookup = {};
            for (const r of baseRows) baseLookup[r.key] = r.value + (r.unit ? ' ' + r.unit : '');

            const changedRows = [];
            for (const r of outfitRows) {
                const outfitDisplayVal = r.value + (r.unit ? ' ' + r.unit : '');
                const baseDisplayVal   = baseLookup[r.key];
                if (outfitDisplayVal !== baseDisplayVal) changedRows.push(r);
            }
            if (changedRows.length) diff[section] = changedRows;
        }
        return diff;
    }

    // ── colouring: best and worst value per row ("lower is better" comes from ItemStats) ──

    // "1,234.5 dmg/s" → 1234.5 (null if not a number). Called by: CompareDisplay._buildGroupAttrMap, _getRawFromMaps
    function _parseDisplayNum(str) {
        if (typeof str !== 'string' || str === '—' || str === '') return null;
        const cleaned = str.replace(/,/g, '').trim().split(/\s+/)[0];
        if (cleaned.startsWith('×')) return parseFloat(cleaned.slice(1));
        const n = parseFloat(cleaned);
        return isNaN(n) ? null : n;
    }

    // best/worst class for each value (null = missing, left plain). Called by: CompareDisplay._buildColourMap
    function _colourClasses(nums, lowerBetter) {
        const present = nums.filter(n => n !== null);
        if (present.length < 1) return nums.map(() => '');
        const min = Math.min(...present);
        const max = Math.max(...present);
        if (min === max) return nums.map(n => n === null ? '' : 'compare-val--best');
        const bestVal  = lowerBetter ? min : max;
        const worstVal = lowerBetter ? max : min;
        return nums.map(n => {
            if (n === null)     return '';
            if (n === bestVal)  return 'compare-val--best';
            if (n === worstVal) return 'compare-val--worst';
            return '';
        });
    }

    // one item's number for a key. Called by: CompareDisplay._buildColourMap
    function _getRawFromMaps(maps, itemIdx, key) {
        for (const rows of Object.values(maps[itemIdx])) {
            const r = rows.find(r => r.key === key);
            if (r) return _parseDisplayNum(r.value);
        }
        return null;
    }

    // colours for every row of every item ('wo::key' = the with-outfits rows). Called by: CompareDisplay._renderColumns, _renderTable
    function _buildColourMap(baseMaps, outfitMaps, diffMaps, itemCount) {
        const allBaseKeys = new Map(); // key → lowerBetter
        for (const map of baseMaps)
            for (const [section, rows] of Object.entries(map))
                if (!_isDetailSection(section))
                    for (const r of rows)
                        if (!allBaseKeys.has(r.key)) allBaseKeys.set(r.key, !!r.lowerBetter);

        const allWoKeys = new Map();
        for (const dMap of diffMaps)
            for (const [section, rows] of Object.entries(dMap))
                if (!_isDetailSection(section))
                    for (const r of rows)
                        if (!allWoKeys.has(r.key)) allWoKeys.set(r.key, !!r.lowerBetter);

        const colourMap = {};

        for (const [key, lowerBetter] of allBaseKeys) {
            const nums = Array.from({ length: itemCount }, (_, i) =>
                _getRawFromMaps(baseMaps, i, key));
            colourMap[key] = _colourClasses(nums, lowerBetter);
        }

        for (const [key, lowerBetter] of allWoKeys) {
            const nums = Array.from({ length: itemCount }, (_, i) => {
                const n = _getRawFromMaps(outfitMaps, i, key);
                return n !== null ? n : _getRawFromMaps(baseMaps, i, key);
            });
            colourMap['wo::' + key] = _colourClasses(nums, lowerBetter);
        }

        return colourMap;
    }

    // set up the bar and panel. Called on page load (bottom of this file)

    function init() {
        _injectBar();
        _injectPanel();
        window.addEventListener('compareListChanged', () => {
            _refreshBar();
            if (_panelOpen) _renderPanelContent();
        });
        // enhanced details can be switched in another tab
        window.addEventListener('enhancedDetailsChanged', () => {
            if (_panelOpen) _renderPanelContent();
        });
    }

    // the bar along the bottom. Called by: CompareDisplay.init

    function _injectBar() {
        const bar = document.createElement('div');
        bar.id        = 'compareBar';
        bar.className = 'compare-bar';
        bar.innerHTML = `
            <div class="compare-bar__left">
                <span class="compare-bar__icon">⚖</span>
                <div class="compare-bar__scroll" id="compareBarScroll">
                    <span class="compare-bar__label" id="compareBarLabel">Compare — nothing selected</span>
                    <div class="compare-bar__chips" id="compareBarChips"></div>
                </div>
            </div>
            <div class="compare-bar__right">
                <button class="compare-bar__clear" id="compareBarClear" onclick="window.CompareDisplay.clearAll()">Clear</button>
                <button class="compare-bar__open"  id="compareBarOpen"  onclick="window.CompareDisplay.togglePanel()">
                    <span id="compareBarOpenLabel">Open Compare ▲</span>
                </button>
            </div>
        `;
        document.body.appendChild(bar);
        _refreshBar();
    }

    // redraw the bar's item chips. Called by: CompareDisplay.init, _injectBar, togglePanel
    function _refreshBar() {
        const items     = window.CompareManager.getItems();
        const count     = items.length;
        const label     = document.getElementById('compareBarLabel');
        const chips     = document.getElementById('compareBarChips');
        const clearBtn  = document.getElementById('compareBarClear');
        const openBtn   = document.getElementById('compareBarOpen');
        const openLabel = document.getElementById('compareBarOpenLabel');
        const bar       = document.getElementById('compareBar');
        if (!label) return;

        const groupType = window.CompareManager.getGroupType();
        const groupStr  = groupType === 'ship' ? 'ships/variants' : 'outfits';
        label.textContent = count === 0
            ? 'Compare — nothing selected'
            : `Compare — ${count} ${groupStr}`;

        chips.innerHTML = '';
        items.forEach(item => {
            const chip = document.createElement('span');
            chip.className = 'compare-bar__chip';
            const nameSpan = document.createElement('span');
            nameSpan.textContent = item['display name'] || item.name || '?';
            chip.appendChild(nameSpan);
            const x = document.createElement('button');
            x.className   = 'compare-bar__chip-remove';
            x.textContent = '×';
            x.onclick = (e) => { e.stopPropagation(); window.CompareManager.remove(item); };
            chip.appendChild(x);
            chips.appendChild(chip);
        });

        clearBtn.style.display = count > 0 ? '' : 'none';
        openBtn.style.display  = count > 1 ? '' : 'none';
        openLabel.textContent  = _panelOpen ? 'Close Compare ▼' : 'Open Compare ▲';
        bar.classList.toggle('compare-bar--has-items', count > 0);

        // "Create Group" button
        let createGroupBtn = document.getElementById('compareCreateGroup');
        const singles = items.filter(i => !i._isGroup);
        if (!createGroupBtn) {
            createGroupBtn = document.createElement('button');
            createGroupBtn.id        = 'compareCreateGroup';
            createGroupBtn.className = 'compare-bar__create-group';
            createGroupBtn.textContent = '+ Group';
            const rightBar = document.getElementById('compareBarClear');
            if (rightBar?.parentNode) rightBar.parentNode.insertBefore(createGroupBtn, rightBar);
        }
        createGroupBtn.style.display = singles.length >= 2 ? '' : 'none';
        createGroupBtn.onclick = () => _openGroupBuilder(null);
    }

    // the panel. Called by: CompareDisplay.init

    function _injectPanel() {
        const panel = document.createElement('div');
        panel.id        = 'comparePanel';
        panel.className = 'compare-panel';
        panel.innerHTML = `
            <div class="compare-panel__header">
                <h2 class="compare-panel__title">⚖ Compare</h2>
                <div class="compare-panel__controls">
                    <div class="compare-toggle" id="compareToggle">
                        <button class="compare-toggle__btn compare-toggle__btn--active" data-mode="columns" onclick="window.CompareDisplay.setViewMode('columns')">Columns</button>
                        <button class="compare-toggle__btn" data-mode="table" onclick="window.CompareDisplay.setViewMode('table')">Table</button>
                    </div>
                    <button class="compare-panel__close" onclick="window.CompareDisplay.togglePanel()">✕</button>
                </div>
            </div>
            <div class="compare-panel__body" id="comparePanelBody">
                <p class="compare-empty">Add at least two items to compare.</p>
            </div>
        `;
        document.body.appendChild(panel);
    }

    // redraw the panel. Called by: quantity changes, togglePanel, setViewMode
    function _renderPanelContent() {
        const body  = document.getElementById('comparePanelBody');
        const items = window.CompareManager.getItems();
        if (!body) return;
        body.innerHTML = '';
        if (items.length < 2) {
            body.innerHTML = '<p class="compare-empty">Add at least two items to compare.</p>';
            return;
        }

        if (_viewMode === 'columns') _renderColumns(body, items);
        else                         _renderTable(body, items);
    }


    // typed quantity box in a spinner. Called by: CompareDisplay._makeQtyControl, _makeGroupMemberQtyControl, _renderColumns, _renderTable
    function _makeQtyInput(getVal, setVal) {
        const input = document.createElement('input');
        input.type      = 'number';
        input.min       = '1';
        input.step      = '1';
        input.className = 'compare-qty__val compare-qty__input';
        input.value     = getVal();

        const commit = () => {
            const n = parseInt(input.value, 10);
            setVal(!isNaN(n) && n >= 1 ? n : 1);
            input.value = getVal();
        };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') input.blur();
        });
        // don't let clicks in the box reach the column
        input.addEventListener('click', e => e.stopPropagation());

        return input;
    }

    // − / box / + for one item. Called by: CompareDisplay._renderColumns, _renderTable
    function _makeQtyControl(item) {
        const wrap = document.createElement('div');
        wrap.className = 'compare-qty';

        const dec = document.createElement('button');
        dec.className   = 'compare-qty__btn';
        dec.textContent = '−';
        dec.title       = 'Decrease quantity';

        const prefix = document.createElement('span');
        prefix.className   = 'compare-qty__prefix';
        prefix.textContent = '×';

        const input = _makeQtyInput(
            () => _getQty(item),
            (n) => _setQty(item, n)
        );

        const inc = document.createElement('button');
        inc.className   = 'compare-qty__btn';
        inc.textContent = '+';
        inc.title       = 'Increase quantity';

        dec.onclick = () => {
            const newQty = _getQty(item) - 1;
            _setQty(item, newQty);
            input.value = _getQty(item);
        };

        inc.onclick = () => {
            const newQty = _getQty(item) + 1;
            _setQty(item, newQty);
            input.value = _getQty(item);
        };

        wrap.appendChild(dec);
        wrap.appendChild(prefix);
        wrap.appendChild(input);
        wrap.appendChild(inc);
        return wrap;
    }

    // one section's rows in a column. Called by: CompareDisplay._renderColumns
    function _appendSectionRows(col, rows, colourMap, itemIdx, withOutfits) {
        for (const rowData of rows) {
            const { key, label, value, unit, isDivider } = rowData;

            // Group member quantity spinner row
            if (rowData._isGroupMemberQtyRow) {
                const row = document.createElement('div');
                row.className = 'compare-col__row compare-col__row--qty';
                const k = document.createElement('div');
                k.className   = 'compare-col__key';
                k.textContent = label;
                const qCtrl = _makeGroupMemberQtyControl(rowData._groupId, rowData._memberIdx, value);
                row.appendChild(k);
                row.appendChild(qCtrl);
                col.appendChild(row);
                continue;
            }

            if ((label.startsWith('—') && !value) || isDivider) {
                const div = document.createElement('div');
                div.className   = 'compare-col__divider';
                div.textContent = label;
                col.appendChild(div);
                continue;
            }
            const row = document.createElement('div');
            row.className = 'compare-col__row';
            const k = document.createElement('div');
            k.className   = 'compare-col__key';
            k.textContent = label;
            const v = document.createElement('div');
            let colourCls = '';
            if (colourMap && key) {
                const lookup = colourMap[withOutfits ? 'wo::' + key : key];
                colourCls = (lookup && itemIdx < lookup.length) ? lookup[itemIdx] : '';
            }
            v.className   = 'compare-col__val' + (colourCls ? ' ' + colourCls : '');
            v.textContent = unit ? `${value} ${unit}` : value;
            row.appendChild(k);
            row.appendChild(v);
            col.appendChild(row);
        }
    }

    // − / box / + for a group member. Called by: CompareDisplay._appendSectionRows
    function _makeGroupMemberQtyControl(groupId, memberIdx, currentDisplay) {
        const wrap = document.createElement('div');
        wrap.className = 'compare-qty';

        const dec = document.createElement('button');
        dec.className = 'compare-qty__btn';
        dec.textContent = '−';

        const prefix = document.createElement('span');
        prefix.className   = 'compare-qty__prefix';
        prefix.textContent = '×';

        const input = _makeQtyInput(
            () => _getGroupMemberQty(groupId, memberIdx),
            (n) => _setGroupMemberQty(groupId, memberIdx, n)
        );

        const inc = document.createElement('button');
        inc.className = 'compare-qty__btn';
        inc.textContent = '+';

        dec.onclick = () => {
            const n = _getGroupMemberQty(groupId, memberIdx) - 1;
            _setGroupMemberQty(groupId, memberIdx, n);
            input.value = _getGroupMemberQty(groupId, memberIdx);
        };
        inc.onclick = () => {
            const n = _getGroupMemberQty(groupId, memberIdx) + 1;
            _setGroupMemberQty(groupId, memberIdx, n);
            input.value = _getGroupMemberQty(groupId, memberIdx);
        };

        wrap.appendChild(dec);
        wrap.appendChild(prefix);
        wrap.appendChild(input);
        wrap.appendChild(inc);
        return wrap;
    }

    // side-by-side columns. Called by: CompareDisplay._renderPanelContent

    function _renderColumns(container, items) {
        const isShipGroup = window.CompareManager.getGroupType() === 'ship';

        const baseMaps   = items.map(entry => entry._isGroup
            ? _buildGroupAttrMap(entry, false)
            : (isShipGroup ? _buildAttrMap(entry, _getQty(entry), false)
                           : _buildAttrMap(entry, _getQty(entry), true)));
        const outfitMaps = items.map(entry => entry._isGroup
            ? _buildGroupAttrMap(entry, true)
            : (isShipGroup ? _buildAttrMap(entry, _getQty(entry), true)
                           : _buildAttrMap(entry, _getQty(entry), true)));
        const diffMaps   = isShipGroup
            ? items.map((entry, i) => _diffSectionMaps(baseMaps[i], outfitMaps[i]))
            : items.map(() => ({}));

        const colourMap = _buildColourMap(baseMaps, outfitMaps, diffMaps, items.length);

        const grid = document.createElement('div');
        grid.className = 'compare-columns';
        grid.style.gridTemplateColumns = `repeat(${items.length}, minmax(240px, 1fr))`;

        items.forEach((item, idx) => {
            const col = document.createElement('div');
            col.className = 'compare-col' + (item._isGroup ? ' compare-col--group' : '');

            // Header
            const header = document.createElement('div');
            header.className = 'compare-col__header';

            const removeBtn = document.createElement('button');
            removeBtn.className   = 'compare-col__remove';
            removeBtn.textContent = '× Remove';
            removeBtn.onclick     = () => item._isGroup
                ? window.CompareManager.removeGroup(item._groupId)
                : window.CompareManager.remove(item);

            const nameEl = document.createElement('div');
            nameEl.className   = 'compare-col__name';
            nameEl.textContent = item._isGroup ? item.name : (item['display name'] || item.name || 'Unknown');

            header.appendChild(removeBtn);

            if (item._isGroup) {
                header.appendChild(nameEl);

                const groupMeta = document.createElement('div');
                groupMeta.className = 'compare-col__group-meta';

                const memberCount = document.createElement('div');
                memberCount.className   = 'compare-col__member-count';
                memberCount.textContent = `${item.members.length} item${item.members.length !== 1 ? 's' : ''}`;

                const editBtn = document.createElement('button');
                editBtn.className   = 'compare-col__edit-group';
                editBtn.textContent = '✎ Edit group';
                editBtn.onclick     = () => _openGroupBuilder(item);

                groupMeta.appendChild(memberCount);
                groupMeta.appendChild(editBtn);
                header.appendChild(groupMeta);

                // Member list with per-member qty spinners
                const memberList = document.createElement('div');
                memberList.className = 'compare-col__member-list';

                item.members.forEach((m, i) => {
                    const memberName = m.item['display name'] || m.item.name || `Member ${i + 1}`;

                    const row = document.createElement('div');
                    row.className = 'compare-col__member-row';

                    const nameSpan = document.createElement('span');
                    nameSpan.className   = 'compare-col__member-name';
                    nameSpan.textContent = memberName;

                    const qtyWrap = document.createElement('div');
                    qtyWrap.className = 'compare-qty compare-qty--sm';

                    const dec = document.createElement('button');
                    dec.className   = 'compare-qty__btn';
                    dec.textContent = '−';

                    const prefix = document.createElement('span');
                    prefix.className   = 'compare-qty__prefix';
                    prefix.textContent = '×';

                    const input = _makeQtyInput(
                        () => _getGroupMemberQty(item._groupId, i),
                        (n) => _setGroupMemberQty(item._groupId, i, n)
                    );

                    const inc = document.createElement('button');
                    inc.className   = 'compare-qty__btn';
                    inc.textContent = '+';

                    dec.onclick = () => {
                        const n = _getGroupMemberQty(item._groupId, i) - 1;
                        _setGroupMemberQty(item._groupId, i, n);
                        input.value = _getGroupMemberQty(item._groupId, i);
                    };
                    inc.onclick = () => {
                        const n = _getGroupMemberQty(item._groupId, i) + 1;
                        _setGroupMemberQty(item._groupId, i, n);
                        input.value = _getGroupMemberQty(item._groupId, i);
                    };

                    qtyWrap.appendChild(dec);
                    qtyWrap.appendChild(prefix);
                    qtyWrap.appendChild(input);
                    qtyWrap.appendChild(inc);

                    row.appendChild(nameSpan);
                    row.appendChild(qtyWrap);
                    memberList.appendChild(row);
                });

                header.appendChild(memberList);
            } else {
                const imgEl = document.createElement('div');
                imgEl.className = 'compare-col__img';
                _loadThumb(item, imgEl);
                const subEl = document.createElement('div');
                subEl.className   = 'compare-col__sub';
                subEl.textContent = item['display name']
                    ? item.name
                    : (item.attributes?.category || item.category || '');
                const qtyCtrl = _makeQtyControl(item);
                header.appendChild(imgEl);
                header.appendChild(nameEl);
                if (subEl.textContent) header.appendChild(subEl);
                header.appendChild(qtyCtrl);
            }
            col.appendChild(header);

            // Sections — use base map as the canonical section list
            const sectionMap = baseMaps[idx];
            const diffMap    = diffMaps[idx];

            const orderedSections = [
                ...SECTION_ORDER.filter(s => sectionMap[s] || outfitMaps[idx][s]),
                ...Object.keys(outfitMaps[idx]).filter(s =>
                    !SECTION_ORDER.includes(s) && !sectionMap[s]),
            ].filter((s, i, a) => a.indexOf(s) === i);

            for (const section of orderedSections) {
                const baseRows   = sectionMap[section] || [];
                const diffRows   = diffMap[section]    || [];

                // Only render the section block if there's something to show
                if (!baseRows.length && !diffRows.length) continue;

                // Base section header + rows
                if (baseRows.length) {
                    const secHeader = document.createElement('div');
                    secHeader.className   = 'compare-col__section';
                    secHeader.textContent = section;
                    col.appendChild(secHeader);
                    _appendSectionRows(col, baseRows, colourMap, idx, false);
                }

                // (with outfits) sub-section — only if there are differences
                if (diffRows.length) {
                    const subHeader = document.createElement('div');
                    subHeader.className   = 'compare-col__section compare-col__section--with-outfits';
                    subHeader.textContent = `${section} (with outfits)`;
                    col.appendChild(subHeader);
                    _appendSectionRows(col, diffRows, colourMap, idx, true);
                }

                // a section that only exists once outfits are added
                if (!baseRows.length && diffRows.length === 0) {
                    const outfitOnlyRows = outfitMaps[idx][section] || [];
                    if (outfitOnlyRows.length) {
                        const subHeader = document.createElement('div');
                        subHeader.className   = 'compare-col__section compare-col__section--with-outfits';
                        subHeader.textContent = `${section} (with outfits)`;
                        col.appendChild(subHeader);
                        _appendSectionRows(col, outfitOnlyRows, colourMap, idx, true);
                    }
                }
            }

            grid.appendChild(col);
        });

        container.appendChild(grid);
    }

    // one big table. Called by: CompareDisplay._renderPanelContent

    function _renderTable(container, items) {
        const isShipGroup = window.CompareManager.getGroupType() === 'ship';

        // Groups must use _buildGroupAttrMap; singles use _buildAttrMap
        const baseMaps   = items.map(item => item._isGroup
            ? _buildGroupAttrMap(item, false)
            : (isShipGroup ? _buildAttrMap(item, _getQty(item), false)
                           : _buildAttrMap(item, _getQty(item), true)));
        const outfitMaps = items.map(item => item._isGroup
            ? _buildGroupAttrMap(item, true)
            : (isShipGroup ? _buildAttrMap(item, _getQty(item), true)
                           : _buildAttrMap(item, _getQty(item), true)));
        const diffMaps   = isShipGroup
            ? items.map((item, i) => _diffSectionMaps(baseMaps[i], outfitMaps[i]))
            : items.map(() => ({}));

        const colourMap = _buildColourMap(baseMaps, outfitMaps, diffMaps, items.length);

        // each section's rows, then its "(with outfits)" rows
        const sectionKeyOrder = [];
        const seenSectionKeys = new Set();

        const allSections = [
            ...SECTION_ORDER,
            ...new Set([
                ...baseMaps.flatMap(m => Object.keys(m)),
                ...outfitMaps.flatMap(m => Object.keys(m)),
            ]),
        ].filter((s, i, a) => a.indexOf(s) === i);

        for (const section of allSections) {
            let baseSectionAdded = false;
            for (const map of baseMaps) {
                for (const { key, label } of (map[section] || [])) {
                    const sk = section + '::' + key;
                    if (seenSectionKeys.has(sk)) continue;
                    seenSectionKeys.add(sk);
                    if (!baseSectionAdded) {
                        sectionKeyOrder.push({ isSectionHeader: true, section, withOutfits: false });
                        baseSectionAdded = true;
                    }
                    sectionKeyOrder.push({ isSectionHeader: false, section, key, label, withOutfits: false });
                }
            }

            let diffSectionAdded = false;
            for (const dMap of diffMaps) {
                for (const { key, label } of (dMap[section] || [])) {
                    const sk = section + '::wo::' + key;
                    if (seenSectionKeys.has(sk)) continue;
                    seenSectionKeys.add(sk);
                    if (!diffSectionAdded) {
                        sectionKeyOrder.push({ isSectionHeader: true, section, withOutfits: true });
                        diffSectionAdded = true;
                    }
                    sectionKeyOrder.push({ isSectionHeader: false, section, key, label, withOutfits: true });
                }
            }

            if (!baseSectionAdded) {
                let outfitOnlySectionAdded = false;
                for (const map of outfitMaps) {
                    for (const { key, label } of (map[section] || [])) {
                        const sk = section + '::wo::' + key;
                        if (seenSectionKeys.has(sk)) continue;
                        seenSectionKeys.add(sk);
                        if (!outfitOnlySectionAdded) {
                            sectionKeyOrder.push({ isSectionHeader: true, section, withOutfits: true });
                            outfitOnlySectionAdded = true;
                        }
                        sectionKeyOrder.push({ isSectionHeader: false, section, key, label, withOutfits: true });
                    }
                }
            }
        }

        const baseLookups = baseMaps.map(map => {
            const lut = {};
            for (const [section, rows] of Object.entries(map))
                for (const { key, value, unit } of rows)
                    lut[section + '::' + key] = unit ? `${value} ${unit}` : value;
            return lut;
        });
        const outfitLookups = outfitMaps.map(map => {
            const lut = {};
            for (const [section, rows] of Object.entries(map))
                for (const { key, value, unit } of rows)
                    lut[section + '::' + key] = unit ? `${value} ${unit}` : value;
            return lut;
        });

        const wrap = document.createElement('div');
        wrap.className = 'compare-table-wrap';

        const table = document.createElement('table');
        table.className = 'compare-table';

        const thead   = document.createElement('thead');
        const headRow = document.createElement('tr');
        const corner  = document.createElement('th');
        corner.className   = 'compare-table__corner';
        corner.textContent = 'Attribute';
        headRow.appendChild(corner);

        items.forEach(item => {
            const th = document.createElement('th');
            th.className = 'compare-table__item-header';

            const removeBtn = document.createElement('button');
            removeBtn.className   = 'compare-col__remove';
            removeBtn.textContent = '× Remove';
            removeBtn.onclick     = () => item._isGroup
                ? window.CompareManager.removeGroup(item._groupId)
                : window.CompareManager.remove(item);
            th.appendChild(removeBtn);

            if (item._isGroup) {
                // Group header — name + member list with per-member qty spinners
                const nameEl = document.createElement('div');
                nameEl.className   = 'compare-table__item-name';
                nameEl.textContent = item.name || 'Group';
                th.appendChild(nameEl);

                const memberList = document.createElement('div');
                memberList.className = 'compare-col__member-list';

                item.members.forEach((m, i) => {
                    const memberName = m.item['display name'] || m.item.name || `Member ${i + 1}`;

                    const row = document.createElement('div');
                    row.className = 'compare-col__member-row';

                    const nameSpan = document.createElement('span');
                    nameSpan.className   = 'compare-col__member-name';
                    nameSpan.textContent = memberName;

                    const qtyWrap = document.createElement('div');
                    qtyWrap.className = 'compare-qty compare-qty--sm';

                    const dec = document.createElement('button');
                    dec.className   = 'compare-qty__btn';
                    dec.textContent = '−';

                    const prefix = document.createElement('span');
                    prefix.className   = 'compare-qty__prefix';
                    prefix.textContent = '×';

                    const input = _makeQtyInput(
                        () => _getGroupMemberQty(item._groupId, i),
                        (n) => _setGroupMemberQty(item._groupId, i, n)
                    );

                    const inc = document.createElement('button');
                    inc.className   = 'compare-qty__btn';
                    inc.textContent = '+';

                    dec.onclick = () => {
                        const n = _getGroupMemberQty(item._groupId, i) - 1;
                        _setGroupMemberQty(item._groupId, i, n);
                        input.value = _getGroupMemberQty(item._groupId, i);
                    };
                    inc.onclick = () => {
                        const n = _getGroupMemberQty(item._groupId, i) + 1;
                        _setGroupMemberQty(item._groupId, i, n);
                        input.value = _getGroupMemberQty(item._groupId, i);
                    };

                    qtyWrap.appendChild(dec);
                    qtyWrap.appendChild(prefix);
                    qtyWrap.appendChild(input);
                    qtyWrap.appendChild(inc);
                    row.appendChild(nameSpan);
                    row.appendChild(qtyWrap);
                    memberList.appendChild(row);
                });

                th.appendChild(memberList);

                const editBtn = document.createElement('button');
                editBtn.className   = 'compare-col__edit-group';
                editBtn.style.marginTop = '8px';
                editBtn.textContent = '✎ Edit group';
                editBtn.onclick     = () => _openGroupBuilder(item);
                th.appendChild(editBtn);

            } else {
                // Single item header — thumb + name + sub + qty spinner
                const img = document.createElement('div');
                img.className = 'compare-table__thumb';
                _loadThumb(item, img);

                const nameEl = document.createElement('div');
                nameEl.className   = 'compare-table__item-name';
                nameEl.textContent = item['display name'] || item.name || 'Unknown';

                const subEl = document.createElement('div');
                subEl.className   = 'compare-table__item-sub';
                subEl.textContent = item['display name']
                    ? item.name : (item.attributes?.category || item.category || '');

                const qtyCtrl = _makeQtyControl(item);

                th.appendChild(img);
                th.appendChild(nameEl);
                if (subEl.textContent) th.appendChild(subEl);
                th.appendChild(qtyCtrl);
            }

            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody  = document.createElement('tbody');
        let rowIdx   = 0;

        for (const entry of sectionKeyOrder) {
            if (entry.isSectionHeader) {
                const tr = document.createElement('tr');
                tr.className = entry.withOutfits
                    ? 'compare-table__section-row compare-table__section-row--with-outfits'
                    : 'compare-table__section-row';
                const td = document.createElement('td');
                td.colSpan   = items.length + 1;
                td.className = entry.withOutfits
                    ? 'compare-table__section-header compare-table__section-header--with-outfits'
                    : 'compare-table__section-header';
                td.textContent = entry.withOutfits
                    ? `${entry.section} (with outfits)`
                    : entry.section;
                tr.appendChild(td);
                tbody.appendChild(tr);
                continue;
            }

            if (entry.label?.startsWith('—')) continue;

            const sk   = entry.section + '::' + entry.key;
            const tr   = document.createElement('tr');
            tr.className  = (rowIdx % 2 === 0 ? 'compare-table__row--even' : 'compare-table__row--odd') +
                            (entry.withOutfits ? ' compare-table__row--with-outfits' : '');
            rowIdx++;

            const keyTd = document.createElement('td');
            keyTd.className   = 'compare-table__key' + (entry.withOutfits ? ' compare-table__key--with-outfits' : '');
            keyTd.textContent = entry.label;
            tr.appendChild(keyTd);

            const anyDiff = entry.withOutfits &&
                diffMaps.some(dMap => (dMap[entry.section] || []).some(r => r.key === entry.key));

            items.forEach((_, i) => {
                const td = document.createElement('td');
                let cellText = '—';
                if (entry.withOutfits) {
                    if (anyDiff) {
                        cellText = outfitLookups[i][sk] ?? (baseLookups[i][sk] ?? '—');
                    } else {
                        cellText = '—';
                    }
                } else {
                    cellText = baseLookups[i][sk] ?? '—';
                }
                const colourKey = entry.withOutfits ? 'wo::' + entry.key : entry.key;
                const lookup    = colourMap[colourKey];
                const colourCls = (lookup && i < lookup.length) ? lookup[i] : '';
                const applyCls  = (cellText === '—') ? '' : colourCls;
                td.className   = 'compare-table__val' +
                    (entry.withOutfits ? ' compare-table__val--with-outfits' : '') +
                    (applyCls ? ' ' + applyCls : '');
                td.textContent = cellText;
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        wrap.appendChild(table);
        container.appendChild(wrap);
    }

    // create or edit a group (null = create). Called by: CompareDisplay.openGroupBuilder, the bar's group buttons

    function _openGroupBuilder(existingGroup) {
        // Remove any existing modal
        const old = document.getElementById('compareGroupModal');
        if (old) old.remove();

        const items   = window.CompareManager.getItems();
        const singles = items.filter(i => !i._isGroup);

        const overlay = document.createElement('div');
        overlay.id        = 'compareGroupModal';
        overlay.className = 'compare-modal-overlay';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:10000',
            'display:flex', 'align-items:center', 'justify-content:center',
            'background:rgba(0,0,0,0.65)', 'backdrop-filter:blur(2px)',
        ].join(';');

        const modal = document.createElement('div');
        modal.className = 'compare-modal';

        // Detect dark/light: check body bg, then html bg, then fall back to dark
        const _detectDark = () => {
            for (const el of [document.body, document.documentElement]) {
                const bg = getComputedStyle(el).backgroundColor;
                const m  = bg.match(/\d+/g);
                if (m && !(parseInt(m[3] ?? '1') === 0)) {
                    return (parseInt(m[0]) + parseInt(m[1]) + parseInt(m[2])) / 3 < 128;
                }
                // Also check explicit style
                if (el.style.background || el.style.backgroundColor) {
                    const s = (el.style.background + el.style.backgroundColor).toLowerCase();
                    if (s.includes('#f') || s.includes('white') || s.includes('255,255')) return false;
                }
            }
            // Try reading a CSS variable as a proxy
            const accent = getComputedStyle(document.documentElement).getPropertyValue('--bg') ||
                           getComputedStyle(document.documentElement).getPropertyValue('--background') || '';
            if (accent.includes('#f') || accent.includes('255')) return false;
            return true; // default to dark
        };
        const isDark = _detectDark();

        modal.style.cssText = [
            'display:flex', 'flex-direction:column', 'gap:1rem',
            'min-width:340px', 'max-width:520px', 'width:90vw',
            'max-height:80vh', 'overflow-y:auto',
            'padding:1.5rem', 'border-radius:10px',
            'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
            isDark ? 'background:#1e2028' : 'background:#f5f6fa',
            isDark ? 'color:#e8e8e8'     : 'color:#1a1a1a',
            isDark ? 'border:1px solid #3a3d4a' : 'border:1px solid #c8cad0',
        ].join(';');

        const title = document.createElement('h3');
        title.className   = 'compare-modal__title';
        title.textContent = existingGroup ? 'Edit Group' : 'Create Group';
        title.style.cssText = 'margin:0;font-size:1.1rem;font-weight:600;';

        // Name input
        const nameWrap = document.createElement('div');
        nameWrap.className = 'compare-modal__field';
        nameWrap.style.cssText = 'display:flex;flex-direction:column;gap:.3rem;';
        const nameLabel = document.createElement('label');
        nameLabel.textContent = 'Group name';
        nameLabel.style.cssText = 'font-size:.8rem;opacity:.7;';
        const nameInput = document.createElement('input');
        nameInput.type      = 'text';
        nameInput.className = 'compare-modal__input';
        nameInput.style.cssText = [
            'padding:.4rem .7rem','border-radius:5px','font-size:.9rem',
            'background:' + (isDark ? '#2a2d38' : '#fff'),
            'color:'      + (isDark ? '#e8e8e8' : '#1a1a1a'),
            'border:1px solid ' + (isDark ? '#4a4d5a' : '#c0c2c8'),
            'outline:none',
        ].join(';');
        nameInput.value     = existingGroup ? existingGroup.name : 'Group ' + (Date.now() % 1000);
        nameInput.placeholder = 'Group name…';
        nameWrap.appendChild(nameLabel);
        nameWrap.appendChild(nameInput);

        // Member list — for edit mode show existing members; for create show current singles
        const listWrap = document.createElement('div');
        listWrap.className = 'compare-modal__list';
        listWrap.style.cssText = [
            'display:flex','flex-direction:column','gap:.35rem',
            'max-height:300px','overflow-y:auto',
            'padding:.5rem','border-radius:6px',
            'border:1px solid ' + (isDark ? '#3a3d4a' : '#d0d2d8'),
            'background:' + (isDark ? '#161820' : '#eef0f5'),
        ].join(';');

        const listTitle = document.createElement('div');
        listTitle.className   = 'compare-modal__list-title';
        listTitle.textContent = 'Select items to include:';
        listTitle.style.cssText = 'font-size:.75rem;opacity:.6;padding-bottom:.2rem;';
        listWrap.appendChild(listTitle);

        // everything in the compare list (ticked if already in this group)
        const existingNames = new Set(
            existingGroup ? existingGroup.members.map(m => m.item.name + '|' + (m.item._compareTab || '')) : []
        );
        const existingQtyMap = {};
        if (existingGroup) {
            existingGroup.members.forEach((m, i) => {
                const k = m.item.name + '|' + (m.item._compareTab || '');
                existingQtyMap[k] = _getGroupMemberQty(existingGroup._groupId, i);
            });
        }

        const checkboxes = []; // { item, checkbox, qtyInput }
        singles.forEach(item => {
            const itemKey = item.name + '|' + (item._compareTab || '');
            const row = document.createElement('div');
            row.className = 'compare-modal__item-row';
            row.style.cssText = 'display:flex;align-items:center;gap:.5rem;padding:.2rem .3rem;border-radius:4px;';

            const cb = document.createElement('input');
            cb.type    = 'checkbox';
            cb.checked = !existingGroup || existingNames.has(itemKey);
            cb.style.cssText = 'cursor:pointer;flex-shrink:0;';

            const lbl = document.createElement('span');
            lbl.className   = 'compare-modal__item-label';
            lbl.textContent = item['display name'] || item.name || '?';
            lbl.style.cssText = 'flex:1;font-size:.88rem;cursor:pointer;';
            lbl.onclick = () => { cb.checked = !cb.checked; };

            const qtyWrap = document.createElement('div');
            qtyWrap.className = 'compare-modal__item-qty';

            const qDec = document.createElement('button');
            qDec.textContent = '−';
            qDec.className   = 'compare-qty__btn';

            const qPrefix = document.createElement('span');
            qPrefix.className   = 'compare-qty__prefix';
            qPrefix.textContent = '×';

            const initQty  = existingQtyMap[itemKey] || 1;
            let currentQty = initQty;
            const qInput = _makeQtyInput(
                () => currentQty,
                (n) => { currentQty = n; }
            );

            const qInc = document.createElement('button');
            qInc.textContent = '+';
            qInc.className   = 'compare-qty__btn';

            qDec.onclick = () => { currentQty = Math.max(1, currentQty - 1); qInput.value = currentQty; };
            qInc.onclick = () => { currentQty = currentQty + 1;              qInput.value = currentQty; };

            qtyWrap.appendChild(qDec);
            qtyWrap.appendChild(qPrefix);
            qtyWrap.appendChild(qInput);
            qtyWrap.appendChild(qInc);

            row.appendChild(cb);
            row.appendChild(lbl);
            row.appendChild(qtyWrap);
            listWrap.appendChild(row);
            checkboxes.push({ item, checkbox: cb, getQty: () => currentQty });
        });

        if (singles.length === 0) {
            const empty = document.createElement('div');
            empty.className   = 'compare-modal__empty';
            empty.textContent = 'No individual items in compare list to group.';
            listWrap.appendChild(empty);
        }

        // Buttons
        const btnRow = document.createElement('div');
        btnRow.className = 'compare-modal__btns';
        btnRow.style.cssText = 'display:flex;gap:.5rem;justify-content:flex-end;padding-top:.25rem;';

        const _btnBase = 'padding:.4rem 1rem;border-radius:5px;cursor:pointer;font-size:.85rem;border:none;font-weight:500;';
        const cancelBtn = document.createElement('button');
        cancelBtn.className   = 'compare-modal__btn compare-modal__btn--cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = _btnBase + (isDark ? 'background:#2a2d38;color:#c0c2c8;' : 'background:#d8dae0;color:#333;');
        cancelBtn.onclick     = () => overlay.remove();

        const confirmBtn = document.createElement('button');
        confirmBtn.className   = 'compare-modal__btn compare-modal__btn--confirm';
        confirmBtn.textContent = existingGroup ? 'Save' : 'Create Group';
        confirmBtn.style.cssText = _btnBase + 'background:#3a7bd5;color:#fff;';
        confirmBtn.onclick     = () => {
            const selected = checkboxes
                .filter(c => c.checkbox.checked)
                .map(c => ({ item: c.item, qty: c.getQty() }));
            if (selected.length === 0) {
                nameInput.setCustomValidity('Select at least one item.');
                nameInput.reportValidity();
                return;
            }
            const name = nameInput.value.trim() || 'Group';
            if (existingGroup) {
                // Rebuild group member qty map with new indices
                const newQtys = {};
                selected.forEach((s, i) => { newQtys[existingGroup._groupId + '|' + i] = s.qty; });
                Object.assign(_groupMemberQtys, newQtys);
                // Clear old indices beyond new length
                for (let i = selected.length; i < existingGroup.members.length + 10; i++)
                    delete _groupMemberQtys[existingGroup._groupId + '|' + i];
                window.CompareManager.updateGroup(existingGroup._groupId, name, selected);
            } else {
                const group = window.CompareManager.addGroup(name, selected);
                if (group) {
                    // Seed the qty map with chosen quantities
                    selected.forEach((s, i) => {
                        _groupMemberQtys[group._groupId + '|' + i] = s.qty;
                    });
                }
            }
            overlay.remove();
            _renderPanelContent();
        };

        // Delete button for edit mode
        if (existingGroup) {
            const deleteBtn = document.createElement('button');
            deleteBtn.className   = 'compare-modal__btn compare-modal__btn--delete';
            deleteBtn.textContent = 'Delete Group';
            deleteBtn.style.cssText = _btnBase + 'background:#c0392b;color:#fff;margin-right:auto;';
            deleteBtn.onclick     = () => {
                window.CompareManager.removeGroup(existingGroup._groupId);
                overlay.remove();
            };
            btnRow.appendChild(deleteBtn);
        }

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(confirmBtn);

        modal.appendChild(title);
        modal.appendChild(nameWrap);
        modal.appendChild(listWrap);
        modal.appendChild(btnRow);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Close on overlay click outside modal
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        nameInput.focus();
        nameInput.select();
    }

    // sprite thumbnail in a header. Called by: CompareDisplay._renderColumns, _renderTable

    function _loadThumb(item, container) {
        container.innerHTML = '<div class="compare-thumb-placeholder"></div>';
        const spritePath = item.thumbnail || item.sprite;
        if (!spritePath || !window.fetchSprite) return;
        window.fetchSprite(spritePath, null).then(el => {
            if (!el) return;
            el.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;image-rendering:pixelated;display:block;margin:auto;';
            container.innerHTML = '';
            container.appendChild(el);
        }).catch(() => {});
    }

    // ── public: window.CompareDisplay ──

    // open/close the panel. Called by: the bar, openPanel, closePanel
    function togglePanel() {
        _panelOpen = !_panelOpen;
        const panel = document.getElementById('comparePanel');
        if (panel) panel.classList.toggle('compare-panel--open', _panelOpen);
        _refreshBar();
        if (_panelOpen) _renderPanelContent();
    }

    function openPanel()  { if (!_panelOpen) togglePanel(); }
    function closePanel() { if (_panelOpen)  togglePanel(); }

    function setViewMode(mode) {
        _viewMode = mode;
        document.querySelectorAll('.compare-toggle__btn').forEach(btn => {
            btn.classList.toggle('compare-toggle__btn--active', btn.dataset.mode === mode);
        });
        _renderPanelContent();
    }

    function clearAll() {
        window.CompareManager.clear();
        _quantities = {};
        _groupMemberQtys = {};
        closePanel();
    }

    function openGroupBuilder() { _openGroupBuilder(null); }

    return { init, togglePanel, openPanel, closePanel, setViewMode, clearAll, openGroupBuilder };

})();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.CompareDisplay.init());
} else {
    window.CompareDisplay.init();
}
