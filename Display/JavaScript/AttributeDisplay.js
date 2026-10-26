'use strict';

// Turns ItemStats rows into the attribute tab's HTML (Data Viewer pop-up, builder outfit expander). No calculations here.

// a titled section of rows. Called by: renderSectionMap, renderWeaponChainHtml, renderAttributesTabEnhanced

function buildSection(title, rows) {
    if (!rows.length) return '';
    return `${title ? `<h3 class="ad-section-title">${title}</h3>` : ''}<div class="ad-grid">${rows.join('')}</div>`;
}

// one label/value row. Called by: rowToHtml, renderWeaponChainHtml, renderAttributesTabEnhanced
function attrRow(label, displayValue, unit, tipAttrs, extra) {
    const badge = unit ? `<span class="ad-unit">${unit}</span>` : '';
    const cls   = extra ? ` ad-row--${extra}` : '';
    return `<div class="ad-row${cls}"${tipAttrs || ''}><div class="ad-label">${label}</div><div class="ad-value">${displayValue}${badge}</div></div>`;
}

// data-tooltip="…" (empty if no text). Called by: rowToHtml
function tooltipAttr(text) {
    if (!text) return '';
    return ` data-tooltip="${String(text).replace(/"/g, '&quot;')}"`;
}

// one row as HTML ('extra' = CSS variant, e.g. 'derived'). Called by: rowsToSections, renderWeaponChainHtml, renderAttributesTabEnhanced
function rowToHtml(row, extra) {
    const label = row.isComputedOutfit ? `⚡ ${row.label}` : row.label;
    // raw stored number added after it when enhanced details is on
    const displayValue = window.ItemStats.formatRowDisplay(row);
    // With enhanced details on, the tooltip also says WHY the row is in its
    // section (game code, parser flag, game display table, or name fallback).
    let tip = row.tooltip;
    if (row.key && !String(row.key).startsWith('_') && window.ItemStats.isEnhancedDetailsEnabled?.() && window.AttributeSections.explain) {
        const why = window.AttributeSections.explain(window.attrDefs, row.key);
        tip = `${tip ? tip + ' | ' : ''}Section: ${why.section} — decided by ${why.reason}`;
    }
    return attrRow(label, displayValue, row.unit, tooltipAttr(tip), extra);
}

// rows → { section: [html rows] }. Called by: renderAttributesTabEnhanced
function rowsToSections(rows, extra) {
    const sections = {};
    for (const row of rows) {
        if (!sections[row.section]) sections[row.section] = [];
        sections[row.section].push(rowToHtml(row, extra));
    }
    return sections;
}

// { section: rows } → HTML in section order. Called by: renderAttributesTabEnhanced
function renderSectionMap(sections) {
    let out = '';
    const keys = window.AttributeSections.orderSections(Object.keys(sections));
    for (const s of keys) if (sections[s]?.length) out += buildSection(s, sections[s]);
    return out;
}

// weapon → submunitions → ammo, as HTML. Called by: renderAttributesTabEnhanced

function renderWeaponChainHtml(attrDefs, weapon, pluginId) {
    const data = window.ItemStats.getWeaponChainData(attrDefs, weapon, pluginId);
    if (!data) return '';
    let html = '';

    const excludeWeapon = new Set(['sprite','spriteData','sound','hit effect','fire effect','die effect','live effect','submunition','submunitions','ammunition','ammo','stream','cluster','hardpoint sprite','hardpoint offset','icon']);
    const excludeOutfit = new Set(['name','weapon','sprite','spriteData','thumbnail','description','flare sprite','steering flare sprite','reverse flare sprite','afterburner effect']);

    for (const { title, weapon: w, outfit: o, derivedRows } of data.sections) {
        const wRows = [];
        if (o) {
            if (o.description) wRows.push(`<div class="ad-description">${o.description}</div>`);
            for (const row of window.ItemStats.getRawAttributeRows(attrDefs, o, { skip: excludeOutfit }))
                wRows.push(rowToHtml(row));
        }
        for (const row of window.ItemStats.getRawAttributeRows(attrDefs, w, { skip: excludeWeapon }))
            wRows.push(rowToHtml(row));

        for (const effectKey of ['hit effect', 'fire effect', 'die effect', 'live effect']) {
            const val = w[effectKey];
            if (!val) continue;
            for (const e of (Array.isArray(val) ? val : [val])) {
                if (typeof e === 'object') wRows.push(attrRow(`${window.ItemStats.labelForKey(effectKey)}: ${e.name ?? e}`, (e.count ?? 1) > 1 ? String(e.count) : '✓', '', ''));
                else if (typeof e === 'string') wRows.push(attrRow(`${window.ItemStats.labelForKey(effectKey)}: ${e}`, '✓', '', ''));
                else if (typeof e === 'number') wRows.push(attrRow(window.ItemStats.labelForKey(effectKey), String(e), '', ''));
            }
        }

        if (wRows.length) html += buildSection(title, wRows);
        if (derivedRows.length) html += buildSection(`${title} — Derived`,
            derivedRows.map(d => attrRow(d.label, d.value, d.unit, '', 'derived')));
    }

    if (data.hasChain && Object.keys(data.totalDamagePerShot).length) {
        const perShotRows = Object.entries(data.totalDamagePerShot)
            .filter(([, v]) => v !== 0)
            .map(([k, v]) => attrRow(window.ItemStats.labelForKey(k), window.ItemStats.fmtNum(v), 'per shot', ''));
        if (perShotRows.length) html += buildSection('Total Damage Per Shot (full chain)', perShotRows);

        if (data.totalDps) {
            const dpsRows = Object.entries(data.totalDps)
                .filter(([, v]) => v !== 0)
                .map(([k, v]) => attrRow(window.ItemStats.labelForKey(k).replace(/ Damage$/, '') + ' DPS', window.ItemStats.fmtNum(v), 'dmg/s', ''));
            if (dpsRows.length) html += buildSection(`Total DPS (${window.ItemStats.fmtNum(data.rootSps)} shots/s)`, dpsRows);
        }
    }

    return html;
}

// wear-off times as their own section

function renderEffectWearOff(attrs) {
    const rows = window.ItemStats.getWearOffRows(attrs);
    if (!rows.length) return '';
    return buildSection('Status Effect Wear-off (per unit of damage, no stacking)',
        rows.map(r => attrRow(r.label, r.value, r.unit, tooltipAttr(r.tooltip))));
}

// the whole attributes tab for a ship, outfit or effect. Called by: DataViewer.renderAttributesTab, shipBuilderOutfitExpander._populatePanel

function renderAttributesTabEnhanced(item, attrDefs, currentTab, pluginId) {
    attrDefs = attrDefs || {};
    let html = '';

    if (currentTab === 'ships' || currentTab === 'variants') {
        if (currentTab === 'variants' && item.baseShip)
            html += `<p class="ad-base-ship">Base Ship: <strong>${item.baseShip}</strong></p>`;

        const attrs = item.attributes || {};
        if (attrs.licenses && typeof attrs.licenses === 'object')
            html += buildSection('General', [attrRow('Licenses', Object.keys(attrs.licenses).join(', '), '', '')]);

        const stats = window.ItemStats.getShipStats(item, attrDefs, pluginId, { includeOutfits: false });
        const withOutfitsStats = window.ItemStats.getShipStats(item, attrDefs, pluginId, { includeOutfits: true });

        // base sections: raw rows plain, calculated rows marked
        const seenLabel = new Set();
        const norm = l => String(l).toLowerCase().replace(/[^a-z0-9]/g, '');
        // calculated rows stuck in Special / Derived Stats / Other go to their real section
        const home = row => {
            if (!['Special', 'Derived Stats', 'Other'].includes(row.section)) return row;
            const s = window.AttributeSections.classify(attrDefs, String(row.label).toLowerCase());
            return s && s !== 'Other' ? { ...row, section: s } : row;
        };
        // first time this label (or this formula value) is seen in the section?
        const firstOnly = (row, prefix) => {
            const key = prefix + '|' + norm(row.label);
            if (seenLabel.has(key)) return false;
            // same value in the same section = same stat under another name (only for game formulas)
            const S = window.ItemStats.SOURCE;
            const isComputed = [S.SHIP_FN, S.FN_VARIANT, S.HEAT_DERIVED, S.COMPUTED_STATS].includes(row.source);
            const vkey = prefix + '|v|' + row.section + '|' + row.value + '|' + (row.unit || '');
            if (isComputed && seenLabel.has(vkey)) return false;
            seenLabel.add(key); seenLabel.add(vkey); return true;
        };
        const baseSections = {};
        for (let row of stats.rows) {
            row = home(row);
            if (!firstOnly(row, 'base')) continue;
            const isDerived = row.source !== window.ItemStats.SOURCE.RAW && row.source !== window.ItemStats.SOURCE.HARDPOINT;
            const html_ = rowToHtml(row, isDerived ? 'derived' : null);
            (baseSections[row.section] = baseSections[row.section] || []).push(html_);
        }

        // "(with outfits)" sections: derived + outfit-contribution rows only
        // present once outfits are included.
        const withOutfitsSections = {};
        // computed stats (max speed, acceleration, turn rate, energy/heat …)
        // count as "with outfits" when installing the outfits changes them
        const baseValue = new Map(stats.rows.map(r => [norm(r.label), String(r.value)]));
        const isRaw = r => r.source === window.ItemStats.SOURCE.RAW || r.source === window.ItemStats.SOURCE.HARDPOINT;
        for (let row of withOutfitsStats.rows) {
            const changedComputed = !isRaw(row) && baseValue.get(norm(row.label)) !== String(row.value);
            if (!row.isComputedOutfit && !changedComputed) continue; // only rows that change because of outfits
            row = home(row);
            if (!firstOnly(row, 'with')) continue;
            (withOutfitsSections[row.section] = withOutfitsSections[row.section] || []).push(rowToHtml(row, 'derived'));
        }
        for (let row of withOutfitsStats.outfitContribRows)
            if ((row = home(row)) && firstOnly(row, 'with')) (withOutfitsSections[row.section] = withOutfitsSections[row.section] || []).push(rowToHtml(row, 'derived'));

        const allSectionNames = window.AttributeSections.orderSections(
            [...new Set([...Object.keys(baseSections), ...Object.keys(withOutfitsSections)])]
        );
        for (const section of allSectionNames) {
            if (baseSections[section]?.length) html += buildSection(section, baseSections[section]);
            if (withOutfitsSections[section]?.length) html += buildSection(`${section} (with outfits)`, withOutfitsSections[section]);
        }

        const outfitMap = item.outfitMap || item.outfits || {};
        if (Object.keys(outfitMap).length) {
            const outfitRows = Object.entries(outfitMap)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([name, qtyVal]) => {
                    const count = typeof qtyVal === 'object' ? (parseInt(qtyVal.count) || 1) : (Number(qtyVal) || 1);
                    return attrRow(name, count > 0 ? `×${count}` : '✓', '', '');
                });
            html += buildSection('Outfits', outfitRows);
        }
        // (wear-off times are already in the Resistance section — see ItemStats.getShipStats)

    } else if (currentTab === 'effects') {
        const effStats = window.ItemStats.getEffectStats(item, attrDefs);
        html += renderSectionMap(rowsToSections(effStats.rows));
        if (effStats.doseRows.length)
            html += buildSection('Status Effect Doses', effStats.doseRows.map(r => attrRow(r.label, r.value, r.unit, tooltipAttr(r.tooltip))));

    } else {
        // Outfits and other items
        const outStats = window.ItemStats.getOutfitStats(item, attrDefs, pluginId);
        html += renderSectionMap(rowsToSections(outStats.rows));
        if (item.weapon) html += renderWeaponChainHtml(attrDefs, item.weapon, pluginId);

        if (outStats.stackingNotes.length) {
            const noteRows = outStats.stackingNotes.map(n =>
                `<div class="ad-stacking-note"><span class="ad-stacking-key">${n.label}</span><span class="ad-stacking-rule">${n.rule}${n.description ? ' — ' + n.description : ''}</span></div>`
            );
            html += `<div class="ad-stacking-section"><h3 class="ad-section-title">Stacking Notes</h3>${noteRows.join('')}</div>`;
        }
    }

    return html;
}

// hover tooltips for rows. Called by: the Data Viewer on load

function initTooltips() {
    if (document.getElementById('ad-tooltip')) return;
    const tooltip = document.createElement('div');
    tooltip.id = 'ad-tooltip';
    tooltip.style.cssText = [
        'position:fixed','z-index:9999','max-width:320px','padding:10px 14px',
        'background:rgba(15,23,42,0.97)','border:1px solid rgba(99,179,237,0.35)',
        'border-radius:8px','color:#e2e8f0','font-size:12px','line-height:1.55',
        'pointer-events:none','opacity:0','transition:opacity 0.15s ease',
        'box-shadow:0 8px 32px rgba(0,0,0,0.6)','white-space:pre-wrap',
    ].join(';');
    document.body.appendChild(tooltip);

    let _mouseX = 0, _mouseY = 0, _rafPending = false;

    document.addEventListener('mouseover', e => {
        const t = e.target.closest('[data-tooltip]');
        if (!t) return;
        tooltip.textContent = t.dataset.tooltip.replace(/ \| /g, '\n');
        tooltip.style.opacity = '1';
    });

    document.addEventListener('mouseout', e => {
        if (e.target.closest('[data-tooltip]')) tooltip.style.opacity = '0';
    });

    document.addEventListener('mousemove', e => {
        _mouseX = e.clientX;
        _mouseY = e.clientY;
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(() => {
            tooltip.style.left = Math.min(_mouseX + 16, window.innerWidth  - 340) + 'px';
            tooltip.style.top  = Math.min(_mouseY + 12, window.innerHeight - 120) + 'px';
            _rafPending = false;
        });
    }, { passive: true });
}

// adds this file's CSS once. Called by: on load
function injectStyles() { /* Styles live in CSS file */ }

window.AttributeDisplay = {
    renderAttributesTabEnhanced,
    initTooltips,
    injectStyles,
    // old names kept for anything still calling them — they just pass through to ItemStats
    calcDerivedStats:        (...a) => window.ItemStats.calcDerivedStats(...a),
    calcWeaponDerived:       (...a) => window.ItemStats.calcWeaponDerived(...a),
    calcEffectWearOffTimes:  (...a) => window.ItemStats.calcEffectWearOffTimes(...a),
    calcWeaponEffectDuration:(...a) => window.ItemStats.calcWeaponEffectDuration(...a),
    computeOutfitContributions: (...a) => window.ItemStats.computeOutfitContributions(...a),
    fmtNum: (...a) => window.ItemStats.fmtNum(...a),
};
