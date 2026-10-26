'use strict';

// Loads missions for the selected plugins (ready-made files or Supabase) and turns them into what the Missions page shows.

(function () {

const REPO_URL  = 'GIVEMEFOOD5/endless-sky-nexus';
const BASE_URL  = `https://raw.githubusercontent.com/${REPO_URL}/main/data`;
// same selection key as DataLoader (one choice across pages)
const ACTIVE_KEY = 'es_sb_active_plugins';
const DEFAULT_PLUGIN = 'official-game/endless-sky';

// ── state ──
let _ready         = false;
let _loading       = false;
let _callbacks     = [];
let _activePlugins = [];

// window.allMissionData[outputName] = { sourceName, displayName, outputName, missions: [...] }
window.allMissionData = window.allMissionData || {};

// the plugin picker reads plugins via window.allData — point it at mission data here
window.allData = window.allMissionData;

// ── formatting ──
function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
// code-style tag
function mono(text)      { return `<span class="mission-tag">${esc(text)}</span>`; }

// ── display names for reward ships/outfits (small list the parser saves) ──
const MissionNames = (() => {
    let byPlugin = {}, pluginIdByOutput = new Map(), ready = null;
    // load once the names list arrives
    function load(pluginRows) {
        for (const p of pluginRows || []) pluginIdByOutput.set(p.output_name, p.plugin_id);
        if (!ready) ready = (async () => {
            try {
                const { data } = await window.supabaseClient.from('app_config').select('value').eq('key', 'displayNames').maybeSingle();
                byPlugin = (data && data.value) || {};
            } catch (_) { byPlugin = {}; }
        })();
        return ready;
    }
    // display name (null if none)
    function label(kind, name) {
        const active = (typeof _activePlugins !== 'undefined' ? _activePlugins : []);
        for (const out of active) {
            const pid = pluginIdByOutput.get(out);
            const dn = pid && byPlugin[pid] && byPlugin[pid][kind] && byPlugin[pid][kind][name];
            if (dn) return dn;
        }
        return null;
    }
    // display name with the internal name dimmed
    function tag(kind, name) {
        const dn = label(kind, name);
        return dn ? `${mono(dn)} <span class="ship-realname" title="Internal name">${esc(name)}</span>` : mono(name);
    }
    return { load, label, tag, text: (kind, name) => label(kind, name) || name };
})();
window.MissionNames = MissionNames;
function tag(text, cls)  { return `<span class="mission-badge ${cls ? 'mission-badge--' + cls : ''}">${esc(text)}</span>`; }

// "3–5"
function formatRange(r) {
    let out = r.commodity ? `${esc(r.commodity)}: ` : '';
    if (r.mode === 'fixed')              out += r.min;
    else if (r.mode === 'uniform')       out += `${r.min}–${r.max}`;
    else if (r.mode === 'negative-binomial') out += `~${r.expected} (min ${r.min}, up to ~${r.softMax})`;
    else out += esc(JSON.stringify(r));
    return out;
}

// deadline text
function formatDeadline(d) {
    return `${d.days} day${d.days === 1 ? '' : 's'}${d.multiplier ? `, +${d.multiplier}/jump` : ''}`;
}

// illegal text
function formatIllegal(i) {
    return `fine ${i.fine ?? '?'}${i.message ? ` — "${esc(i.message)}"` : ''}`;
}

// planet name
function planetName(ref) {
    if (!ref) return null;
    if (ref.type === 'planet') return ref.ref ? ref.ref.name : ref.value;
    return null;
}

// one filter entry as text
function summarizeEntry(e) {
    return e.values.length ? `${e.key} ${e.values.join(' ')}` : e.key;
}

// where it's offered
function formatLocationRef(ref) {
    if (ref.type === 'planet') {
        const name = ref.ref ? ref.ref.name : ref.value;
        const plugin = ref.ref && ref.ref.pluginId ? ` <span class="mission-field-label">(${esc(ref.ref.pluginId)})</span>` : '';
        return mono(name) + plugin;
    }
    if (ref.type === 'filter') {
        const conds = ref.value || [];
        if (!conds.length) return '<span class="mission-empty">any (unfiltered)</span>';
        return 'filtered by: ' + conds.map(c => mono(summarizeEntry(c))).join(', ');
    }
    return esc(JSON.stringify(ref));
}

// list of places
function formatNamedRefList(refs) {
    return refs.map(r => mono(r.name) + (r.count > 1 ? ` ×${r.count}` : '')).join(', ');
}

// payment text
function formatPayment(p) {
    const parts = [];
    if (p.apparentPayment !== null && p.apparentPayment !== undefined) parts.push(`apparent: ${p.apparentPayment}`);
    Object.entries(p.triggers || {}).forEach(([trigger, entries]) => {
        (entries || []).forEach(e => {
            parts.push(`${trigger}: base ${e.base}${e.multiplier ? ` + ${e.multiplier}/distance` : ''}`);
        });
    });
    return parts.length ? parts.join('<br>') : '<span class="mission-empty">none declared</span>';
}

// events it triggers
function formatEventTriggers(list) {
    return list.map(e =>
        `${mono(e.name)} on ${esc(e.trigger)}${e.delayDays ? ` (+${e.delayDays}${e.delayDaysMax ? `–${e.delayDaysMax}` : ''}d)` : ''}`
    ).join('<br>');
}

// conditions it sets
function formatSideEffects(list) {
    return list.map(e => `${mono(e.condition)} ${esc(e.op)}${e.value != null ? ' ' + esc(e.value) : ''} on ${esc(e.trigger)}`).join('<br>');
}

// flag label
function flagLabel(key, value) {
    if (value === true) return key;
    if (Array.isArray(value)) return `${key} ×${value.length}`;
    if (typeof value === 'object' && value !== null) return key;
    return `${key}: ${value}`;
}

// some plugins have huge mission bodies — stop drawing after a limit
const RAW_TREE_NODE_CAP = 1500;

// { key, values, children } tree → HTML (raw view, conditions). Called by: renderRawTree, formatMission
function renderTreeHtml(entries, depth = 0, budget) {
    budget = budget || { count: 0, truncated: false };
    if (!entries || !entries.length) return '<div class="mission-raw-line mission-empty">(empty)</div>';
    let html = '';
    for (const entry of entries) {
        if (budget.truncated) break;
        if (budget.count >= RAW_TREE_NODE_CAP) {
            budget.truncated = true;
            html += `<div class="mission-raw-line mission-raw-truncated">… truncated — this structure has 1500+ entries, cut off here to keep the page responsive</div>`;
            break;
        }
        budget.count++;
        const indent = '  '.repeat(depth);
        const looksLikeBareText = entry.values.length === 0 && !entry.children &&
            !/^[a-z][a-z0-9 _-]*$/i.test(entry.key || '');
        if (looksLikeBareText || (entry.key && entry.key.length > 40 && entry.values.length === 0)) {
            html += `<div class="mission-raw-line">${indent}<span class="mission-raw-text">"${esc(entry.key)}"</span></div>`;
        } else {
            const valuesStr = entry.values.length
                ? ' ' + entry.values.map(v => `<span class="mission-raw-value">${esc(String(v))}</span>`).join(' ')
                : '';
            html += `<div class="mission-raw-line">${indent}<span class="mission-raw-key">${esc(entry.key)}</span>${valuesStr}</div>`;
        }
        if (entry.children && entry.children.length) {
            html += renderTreeHtml(entry.children, depth + 1, budget);
            if (budget.truncated) break;
        }
    }
    return html;
}

// same limit for search text
const SEARCH_TEXT_CHAR_CAP = 4000;

// text worth searching in a raw tree (dialog, names …)
function _extractSearchableText(entries, budget) {
    budget = budget || { text: '' };
    if (!entries) return budget.text;
    for (const entry of entries) {
        if (budget.text.length >= SEARCH_TEXT_CHAR_CAP) break;
        if (entry.key && !/^-?[\d.]+$/.test(entry.key)) budget.text += ' ' + entry.key;
        if (entry.values) {
            for (const v of entry.values) {
                if (typeof v === 'string') budget.text += ' ' + v;
            }
        }
        if (entry.children && entry.children.length) _extractSearchableText(entry.children, budget);
        if (budget.text.length >= SEARCH_TEXT_CHAR_CAP) break;
    }
    return budget.text;
}

// mission row → what the page shows (fields, rewards, search text). Called by: getAllMissions
function formatMission(m, pluginId, pluginDisplay) {
    const badges = [];
    (m.locations || []).forEach(l => badges.push(tag(l, '')));
    if (m.repeatable) badges.push(tag('repeatable' + (m.repeatLimit ? ` (limit ${m.repeatLimit})` : ''), 'repeatable'));
    if (m.illegal) badges.push(tag('illegal', 'illegal'));
    Object.keys(m.flags || {}).forEach(k => badges.push(tag(flagLabel(k, m.flags[k]), 'flag')));

    let bodyHtml = '';
    if (badges.length) bodyHtml += `<div class="mission-badges">${badges.join('')}</div>`;
    if (m.description) bodyHtml += `<div class="mission-description">${esc(m.description)}</div>`;

    const rows = [];
    if (m.name) rows.push(['Internal name', mono(m.name)]);
    if (m.cargo) rows.push(['Cargo', formatRange(m.cargo)]);
    if (m.passengers) rows.push(['Passengers', formatRange(m.passengers)]);
    if (m.deadline) rows.push(['Deadline', formatDeadline(m.deadline)]);
    if (m.illegal) rows.push(['Illegal', formatIllegal(m.illegal)]);
    if (m.source) rows.push(['Source', formatLocationRef(m.source)]);
    if (m.destination) rows.push(['Destination', formatLocationRef(m.destination)]);
    if (m.stopovers && m.stopovers.length) rows.push(['Stopovers', formatNamedRefList(m.stopovers)]);
    if (m.waypoints && m.waypoints.length) rows.push(['Waypoints', formatNamedRefList(m.waypoints)]);
    if (m.payment && (m.payment.apparentPayment != null || Object.keys(m.payment.triggers || {}).length)) {
        rows.push(['Payment', formatPayment(m.payment)]);
    }
    if (m.hasNpcObjective) rows.push(['NPCs', `${m.npcCount} NPC block${m.npcCount === 1 ? '' : 's'} (see raw data)`]);
    if (m.eventTriggers && m.eventTriggers.length) rows.push(['Event triggers', formatEventTriggers(m.eventTriggers)]);
    if (m.conditionSideEffects && m.conditionSideEffects.length) rows.push(['Side effects', formatSideEffects(m.conditionSideEffects)]);

    if (rows.length) {
        bodyHtml += '<div class="mission-field-grid">';
        rows.forEach(([label, value]) => {
            bodyHtml += `<div class="mission-field-label">${esc(label)}</div><div class="mission-field-value">${value}</div>`;
        });
        bodyHtml += '</div>';
    }

    const outfitRewards = (m.rewards && m.rewards.outfits) || [];
    const shipRewards    = (m.rewards && m.rewards.ships) || [];
    if (outfitRewards.length || shipRewards.length) {
        bodyHtml += '<div class="mission-subhead">Rewards</div><ul class="mission-reward-list">';
        outfitRewards.forEach(o => {
            bodyHtml += `<li>Outfit: ${MissionNames.tag('outfits', o.name)} × ${o.count}${o.grantedIn ? ` <span class="mission-field-label">(on ${esc(o.grantedIn)})</span>` : ''}</li>`;
        });
        shipRewards.forEach(s => {
            bodyHtml += `<li>Ship: ${MissionNames.tag('ships', s.name)}${s.customName ? ` named "${esc(s.customName)}"` : ''}${s.grantedIn ? ` <span class="mission-field-label">(on ${esc(s.grantedIn)})</span>` : ''}</li>`;
        });
        bodyHtml += '</ul>';
    }

    if (m.conditions && Object.keys(m.conditions).length) {
        bodyHtml += '<div class="mission-subhead">Conditions</div>';
        Object.entries(m.conditions).forEach(([name, tree]) => {
            bodyHtml += `<div><span class="mission-field-label">to ${esc(name)}</span></div>${renderTreeHtml(tree)}`;
        });
    }

    const detailedFlags = Object.entries(m.flags || {}).filter(([, v]) => v !== true);
    if (detailedFlags.length) {
        bodyHtml += '<div class="mission-subhead">Other declared fields</div>';
        detailedFlags.forEach(([k, v]) => {
            bodyHtml += `<div><span class="mission-field-label">${esc(k)}</span></div>`;
            if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null && 'key' in v[0]) {
                bodyHtml += renderTreeHtml(v);
            } else {
                bodyHtml += `<div class="mission-field-value">${mono(JSON.stringify(v))}</div>`;
            }
        });
    }

    if (m.raw) {
        // raw view is filled in on first click
        bodyHtml += `<span class="mission-raw-toggle">▸ View full raw structure</span>` +
                    `<div class="mission-raw-tree" data-lazy="1"></div>`;
    }

    const rewardNames = [
        ...(m.rewards && m.rewards.outfits || []).flatMap(o => [o.name, MissionNames.label('outfits', o.name)]),
        ...(m.rewards && m.rewards.ships   || []).flatMap(s => [s.name, MissionNames.label('ships', s.name)]),
    ];

    const searchText = [
        m.name, m.displayName, m.description, pluginId, pluginDisplay,
        planetName(m.source), planetName(m.destination),
        ...(m.locations || []),
        ...rewardNames,
        m.raw ? _extractSearchableText(m.raw) : '',
    ].filter(Boolean).join(' ').toLowerCase();

    return {
        id: m._internalId || `${pluginId}::${m.name}`,
        name: m.name || '', // exact internal identifier — the join key missionStatusHelper.js
                             // matches save-file mission/condition names against. Unescaped on
                             // purpose: this is for exact string comparison, never injected as HTML.
        titleHtml: esc(m.displayName || m.name || '(unnamed mission)'),
        pluginId,
        pluginHtml: esc(pluginDisplay || pluginId || ''),
        searchText,
        bodyHtml,
        raw: m.raw || null, // rendered lazily — see MissionLoader.renderRawTree()
        // rewards as data (the page uses them for Complete)
        rewards: m.rewards || { outfits: [], ships: [] },
        payment: m.payment || { apparentPayment: null, triggers: {} },
        // can it be done more than once? (used by the save cleanup)
        repeatable: !!m.repeatable,
        repeatLimit: m.repeatLimit || null,
        // Location tags (job, spaceport, landing, ...) — lets a consumer
        // filter for e.g. job-board missions specifically.
        locations: m.locations || [],
    };
}

// ── plugin management ──
function _activeMissionData() {
    const result = {};
    for (const id of _activePlugins) {
        if (window.allMissionData[id]) result[id] = window.allMissionData[id];
    }
    return result;
}

// page event
function _fireEvent(name, detail = {}) {
    document.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
}

// tell the page the plugins changed (own event + the shared one)
function _firePluginsChanged() {
    const detail = { active: [..._activePlugins] };
    _fireEvent('missionPluginsChanged', detail);
    _fireEvent('pluginsChanged', detail);
}

// save the selection
function _saveActivePlugins() {
    try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(_activePlugins)); } catch (_) {}
}
// read the selection
function _loadActivePlugins() {
    try { return JSON.parse(localStorage.getItem(ACTIVE_KEY)); } catch (_) { return null; }
}

// ── window.MissionLoader ──
window.MissionLoader = {

    load() {
        if (_ready)   return Promise.resolve(window.allMissionData);
        if (_loading) return new Promise(resolve => _callbacks.push(() => resolve(window.allMissionData)));
        return _doLoad();
    },

    onReady(fn) {
        if (_ready) { fn(window.allMissionData); return; }
        _callbacks.push(fn);
        if (!_loading) _doLoad();
    },

    isReady() { return _ready; },

    // ── plugins ──
    getPlugins() {
        return Object.entries(window.allMissionData).map(([id, p]) => ({
            outputName:   id,
            displayName:  p.displayName || id,
            sourceName:   p.sourceName  || id,
            missionCount: (p.missions || []).length,
            isDefault:    id === DEFAULT_PLUGIN,
        }));
    },

    getActivePlugins() { return [..._activePlugins]; },

    async setActivePlugins(arr) {
        await Promise.all(arr.map(id => ensureMissionPluginLoaded(id).catch(err =>
            console.warn(`[MissionLoader] Could not load "${id}":`, err)
        )));
        _activePlugins = arr.filter(id => window.allMissionData[id]);
        _saveActivePlugins();
        if (window.EsAuth) window.EsAuth.saveActivePluginsPreference(_activePlugins);
        _firePluginsChanged();
    },

    // set the selection without firing an event
    async _setActivePluginsSilent(arr) {
        await Promise.all(arr.map(id => ensureMissionPluginLoaded(id).catch(err =>
            console.warn(`[MissionLoader] Could not load "${id}":`, err)
        )));
        _activePlugins = arr.filter(id => window.allMissionData[id]);
        _saveActivePlugins();
        if (window.EsAuth) window.EsAuth.saveActivePluginsPreference(_activePlugins);
    },

    async initDefaultPlugins() {
        // Account preference takes priority when logged in, same as
        // dataLoader.js — falls back to localStorage if signed out.
        let saved = null;
        if (window.EsAuth) {
            try { saved = await window.EsAuth.getActivePluginsPreference(); } catch (_) { /* fall through */ }
        }
        if (!saved) saved = _loadActivePlugins();

        if (saved && saved.length) {
            const valid = saved.filter(id => window.allMissionData[id]);
            if (valid.length) {
                _activePlugins = valid;
                _firePluginsChanged();
                return;
            }
        }
        // nothing saved — use every plugin loaded so far
        _activePlugins = Object.entries(window.allMissionData)
            .filter(([, p]) => !p._placeholder)
            .map(([id]) => id);
        _saveActivePlugins();
        _firePluginsChanged();
    },

    // ── data (selected plugins only) ──
    getAllMissions() {
        const out = [];
        for (const [id, plugin] of Object.entries(_activeMissionData())) {
            const display = plugin.displayName || id;
            for (const m of (plugin.missions || [])) out.push(formatMission(m, id, display));
        }
        return out;
    },

    getMissionsByPlugin(pluginId) {
        const plugin = window.allMissionData[pluginId];
        if (!plugin) return [];
        const display = plugin.displayName || pluginId;
        return (plugin.missions || []).map(m => formatMission(m, pluginId, display));
    },

    // raw tree as HTML, made on demand. Called by: UserManagerMissionDisplay
    renderRawTree(rawEntries) {
        return renderTreeHtml(rawEntries);
    },

    DEFAULT_PLUGIN,
};

// ── for the shared plugin picker ──
if (!window.DataLoader) {
    window.DataLoader = {
        // missions have no Local Builds, but the picker expects the name
        LOCAL_PLUGIN_ID: '__local_builds__',
        setActivePlugins(arr)        { window.MissionLoader.setActivePlugins(arr); },
        _setActivePluginsSilent(arr) { window.MissionLoader._setActivePluginsSilent(arr); },
    };
}

// database row → mission

function _reconstructMission(m) {
    return {
        name: m.name, displayName: m.display_name, sourcePlugin: m.source_plugin,
        source: m.source, destination: m.destination, stopovers: m.stopovers, waypoints: m.waypoints,
        cargo: m.cargo, passengers: m.passengers, payment: m.payment, rewards: m.rewards,
        deadline: m.deadline, illegal: m.illegal, repeatable: m.repeatable, repeatLimit: m.repeat_limit,
        npcCount: m.npc_count, hasNpcObjective: m.has_npc_objective, flags: m.flags,
        conditions: m.conditions, conditionSideEffects: m.condition_side_effects,
        eventTriggers: m.event_triggers, locations: m.locations, raw: m.raw,
        _pluginId: m.plugin_id, _internalId: m.internal_id,
    };
}

// fetch from Supabase (first page shown early)
async function _fetchMissionBundleFresh(outputName, pluginRow, onFirst) {
    const { fetchAllRows } = window.SupabaseHelpers;
    if (!pluginRow) {
        return { sourceName: outputName, displayName: outputName, outputName, missions: [] };
    }
    // ready-made file first (one download), else from Supabase in pages
    const ready = window.Bundles ? await window.Bundles.get('missions', outputName) : null;
    const missionRows = Array.isArray(ready) ? ready : await fetchAllRows('missions', {
        filters: q => q.eq('plugin_id', pluginRow.plugin_id), orderBy: 'id', pageSize: 100, concurrency: 12,
        // show the first 100 missions while the rest download
        onFirstPage: onFirst ? (rows, total) => onFirst({
            sourceName: pluginRow.source_name, displayName: pluginRow.display_name || outputName, outputName,
            missions: rows.map(_reconstructMission), _partial: { loaded: rows.length, total },
        }) : undefined,
    });
    return {
        sourceName: pluginRow.source_name,
        displayName: pluginRow.display_name || outputName,
        outputName,
        missions: missionRows.map(_reconstructMission),
    };
}

// one plugin's missions (browser cache first)
async function _loadMissionBundle(outputName, pluginRow, onFirst) {
    const build = () => _fetchMissionBundleFresh(outputName, pluginRow, onFirst);
    return window.EsCache
        ? await window.EsCache.loadWithCache(`missionBundle:${outputName}`, build)
        : await build();
}

// Phase B: the other plugins in the background
async function _backgroundFillRemainingMissionPlugins(pluginRows, alreadyLoaded) {
    const remaining = pluginRows.filter(p => !alreadyLoaded.has(p.output_name));
    if (!remaining.length) return;
    console.log(`[MissionLoader] Background: loading ${remaining.length} remaining plugin(s)...`);
    for (const pluginRow of remaining) {
        try {
            const bundle = await _loadMissionBundle(pluginRow.output_name, pluginRow);
            window.allMissionData[pluginRow.output_name] = bundle;
            _fireEvent('missionPluginDataAvailable', { outputName: pluginRow.output_name });
        } catch (err) {
            console.warn(`[MissionLoader] Background load failed for "${pluginRow.output_name}":`, err);
        }
    }
    console.log('[MissionLoader] Background fill complete — every plugin is now loaded.');
    _fireEvent('allMissionPluginsLoaded', {});
}

// load one plugin's missions now
async function ensureMissionPluginLoaded(outputName) {
    if (window.allMissionData[outputName]?.missions?.length) {
        return window.allMissionData[outputName];
    }
    const { fetchAllRows } = window.SupabaseHelpers;
    const pluginRows = await fetchAllRows('plugins', { filters: q => q.eq('output_name', outputName) });
    const bundle = await _loadMissionBundle(outputName, pluginRows[0]);
    window.allMissionData[outputName] = bundle;
    _fireEvent('missionPluginDataAvailable', { outputName });
    return bundle;
}

// the whole load. Called by: load
async function _doLoad() {
    _loading = true;
    _fireEvent('missionsLoadStart');

    try {
        const { fetchAllRows } = window.SupabaseHelpers;

        // the plugin list is small — fetch it in full
        const pluginRows = await fetchAllRows('plugins', { orderBy: 'source_priority' });
        if (!pluginRows.length) throw new Error('No plugins found in Supabase');
        await MissionNames.load(pluginRows);   // tiny; needed before missions are shown

        for (const p of pluginRows) {
            if (!window.allMissionData[p.output_name]) {
                window.allMissionData[p.output_name] = {
                    sourceName: p.source_name, displayName: p.display_name || p.output_name,
                    outputName: p.output_name, missions: [], _placeholder: true,
                };
            }
        }

        // Phase A: the selected plugins
        let saved = null;
        if (window.EsAuth) {
            try { saved = await window.EsAuth.getActivePluginsPreference(); } catch (_) { /* fall through */ }
        }
        if (!saved) saved = _loadActivePlugins();
        saved = saved || [];

        let phaseANames = new Set(saved.filter(n => pluginRows.some(p => p.output_name === n)));
        if (phaseANames.size === 0) {
            const def = pluginRows.find(p =>
                p.plugin_id === DEFAULT_PLUGIN || p.output_name === DEFAULT_PLUGIN || p.source_name === 'official-game'
            ) || pluginRows[0];
            if (def) phaseANames.add(def.output_name);
        }

        // The page becomes usable as soon as the FIRST page of missions is in
        // (partial) — the rest keep downloading and the list fills in.
        let readyPromise = null;
        // page usable once the first missions are in
        const markReady = () => readyPromise || (readyPromise = (async () => {
            _ready   = true;
            _loading = false;
            await window.MissionLoader.initDefaultPlugins();
            for (const fn of _callbacks) {
                try { fn(window.allMissionData); } catch (e) { console.error('[MissionLoader] callback error:', e); }
            }
            _callbacks = [];
            _fireEvent('missionsLoaded', { allMissionData: window.allMissionData });
            // Generic event generalPluginStuff.js listens for as a safety net
            // (it double-checks a remote plugin is active once data is in).
            _fireEvent('dataLoaded', { allData: window.allData });
        })());
        // "first 100 of 2,344" note
        const progress = () => {
            let loaded = 0, total = 0;
            for (const n of phaseANames) { const b = window.allMissionData[n]; if (!b) continue;
                loaded += b._partial ? b._partial.loaded : (b.missions || []).length;
                total  += b._partial ? b._partial.total  : (b.missions || []).length; }
            _fireEvent('missionsProgress', { loaded, total, done: loaded >= total });
        };

        await Promise.all([...phaseANames].map(async outputName => {
            const pluginRow = pluginRows.find(p => p.output_name === outputName);
            const full = await _loadMissionBundle(outputName, pluginRow, partial => {
                if (window.allMissionData[outputName] && !window.allMissionData[outputName]._placeholder && !window.allMissionData[outputName]._partial) return;
                window.allMissionData[outputName] = partial;
                progress();
                if ((partial.missions || []).length) markReady();
            });
            window.allMissionData[outputName] = full;
            progress();
            // the list is already on screen with the first missions — fill in the rest
            if (readyPromise) { await readyPromise; if (typeof window._renderCardsFromManager === 'function') window._renderCardsFromManager(); }
        }));

        const hasData = Object.values(window.allMissionData).some(p => (p.missions || []).length > 0);
        if (!hasData) throw new Error('No mission data could be loaded from Supabase');
        await markReady();

        // Phase B: fill in everything else in the background, unawaited —
        // the page is already usable at this point.
        _backgroundFillRemainingMissionPlugins(pluginRows, phaseANames).catch(err =>
            console.warn('[MissionLoader] Background fill errored:', err)
        );

        return window.allMissionData;

    } catch (error) {
        _loading = false;
        console.error('[MissionLoader] Load failed:', error);
        _fireEvent('missionsLoadError', { message: error.message });
        throw error;
    }
}

})();
