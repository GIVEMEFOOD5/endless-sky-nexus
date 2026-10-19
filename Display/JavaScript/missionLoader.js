'use strict';

// ═══════════════════════════════════════════════════════════
//  missionLoader.js  —  Endless Sky Mission Loader
//
//  Same shape as dataLoader.js: loads per-plugin mission data
//  from GitHub, manages active plugin selection, and persists
//  that selection to localStorage.
//
//  UNLIKE dataLoader.js, this module also owns ALL formatting.
//  getAllMissions() doesn't hand back raw mission objects — it
//  hands back ready-to-render view models (title, badges, and
//  a fully-built bodyHtml string) so the display layer never
//  has to know what a mission object looks like internally.
//
//  Public API on window.MissionLoader:
//    .load()                      → Promise — start/await loading
//    .onReady(fn)                 → register ready callback
//    .isReady()                   → boolean
//    .getPlugins()                → all loaded plugins + mission counts
//    .getActivePlugins()          → ordered active outputNames
//    .setActivePlugins(arr)       → set active set, fires 'missionPluginsChanged'
//    .initDefaultPlugins()        → activate saved set, or ALL loaded plugins
//    .getAllMissions()            → formatted view models from active plugins
//    .getMissionsByPlugin(id)     → formatted view models from one plugin
//
//  Custom events fired on document:
//    'missionsLoaded'         — all remote mission data fetched
//    'missionsLoadError'      — fetch failed
//    'missionPluginsChanged'  — active plugin selection changed
// ═══════════════════════════════════════════════════════════

(function () {

const REPO_URL  = 'GIVEMEFOOD5/endless-sky-nexus';
const BASE_URL  = `https://raw.githubusercontent.com/${REPO_URL}/main/data`;
// This is the SAME key dataLoader.js uses for ships/outfits/effects — see
// generalPluginStuff.js's own header comment: "both systems share a single
// storage key". Plugin selection is meant to be one app-wide choice, not a
// separate one per page — a plugin's outputName folder (data/<outputName>/)
// holds ships.json AND missions.json side by side, so "active plugins" means
// the same thing on every page. Using a different key here was the bug:
// whatever was already selected on the ship builder page was invisible to
// this page, so it always fell back to "every plugin" on its own empty key.
const ACTIVE_KEY = 'es_sb_active_plugins';
const DEFAULT_PLUGIN = 'official-game/endless-sky';

// ── Internal state ─────────────────────────────────────────
let _ready         = false;
let _loading       = false;
let _callbacks     = [];
let _activePlugins = [];

// window.allMissionData[outputName] = { sourceName, displayName, outputName, missions: [...] }
window.allMissionData = window.allMissionData || {};

// generalPluginStuff.js (the shared plugin-picker module) reads plugin data
// through `window.allData` and drives selection through `window.DataLoader`.
// This page doesn't load the ship builder's dataLoader.js, so MissionLoader
// stands in for it: `window.allData` is the SAME object as
// `window.allMissionData` (not a copy), so every plugin.missions write below
// is automatically visible to generalPluginStuff.js's `_allData()` helper.
window.allData = window.allMissionData;

// ═════════════════════════════════════════════════════════════
//  Formatting helpers — ported from the standalone mission
//  viewer, now living here so the display layer stays dumb.
// ═════════════════════════════════════════════════════════════
function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function mono(text)      { return `<span class="mission-tag">${esc(text)}</span>`; }

// ── Display names (what the game shows) for ships and outfits ───────────────
// This page doesn't load full ship/outfit data, so the parser saves a small
// list ({ pluginId: { ships: {...}, outfits: {...} } } in app_config).
// Only the selected plugins count. The raw mission view keeps internal names.
const MissionNames = (() => {
    let byPlugin = {}, pluginIdByOutput = new Map(), ready = null;
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
    function label(kind, name) {
        const active = (typeof _activePlugins !== 'undefined' ? _activePlugins : []);
        for (const out of active) {
            const pid = pluginIdByOutput.get(out);
            const dn = pid && byPlugin[pid] && byPlugin[pid][kind] && byPlugin[pid][kind][name];
            if (dn) return dn;
        }
        return null;
    }
    // e.g. "Vertical Launch Array (9)" with the internal "Tiny VLS" dimmed after it
    function tag(kind, name) {
        const dn = label(kind, name);
        return dn ? `${mono(dn)} <span class="ship-realname" title="Internal name">${esc(name)}</span>` : mono(name);
    }
    return { load, label, tag, text: (kind, name) => label(kind, name) || name };
})();
window.MissionNames = MissionNames;
function tag(text, cls)  { return `<span class="mission-badge ${cls ? 'mission-badge--' + cls : ''}">${esc(text)}</span>`; }

function formatRange(r) {
    let out = r.commodity ? `${esc(r.commodity)}: ` : '';
    if (r.mode === 'fixed')              out += r.min;
    else if (r.mode === 'uniform')       out += `${r.min}–${r.max}`;
    else if (r.mode === 'negative-binomial') out += `~${r.expected} (min ${r.min}, up to ~${r.softMax})`;
    else out += esc(JSON.stringify(r));
    return out;
}

function formatDeadline(d) {
    return `${d.days} day${d.days === 1 ? '' : 's'}${d.multiplier ? `, +${d.multiplier}/jump` : ''}`;
}

function formatIllegal(i) {
    return `fine ${i.fine ?? '?'}${i.message ? ` — "${esc(i.message)}"` : ''}`;
}

function planetName(ref) {
    if (!ref) return null;
    if (ref.type === 'planet') return ref.ref ? ref.ref.name : ref.value;
    return null;
}

function summarizeEntry(e) {
    return e.values.length ? `${e.key} ${e.values.join(' ')}` : e.key;
}

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

function formatNamedRefList(refs) {
    return refs.map(r => mono(r.name) + (r.count > 1 ? ` ×${r.count}` : '')).join(', ');
}

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

function formatEventTriggers(list) {
    return list.map(e =>
        `${mono(e.name)} on ${esc(e.trigger)}${e.delayDays ? ` (+${e.delayDays}${e.delayDaysMax ? `–${e.delayDaysMax}` : ''}d)` : ''}`
    ).join('<br>');
}

function formatSideEffects(list) {
    return list.map(e => `${mono(e.condition)} ${esc(e.op)}${e.value != null ? ' ' + esc(e.value) : ''} on ${esc(e.trigger)}`).join('<br>');
}

function flagLabel(key, value) {
    if (value === true) return key;
    if (Array.isArray(value)) return `${key} ×${value.length}`;
    if (typeof value === 'object' && value !== null) return key;
    return `${key}: ${value}`;
}

// Some plugins generate mission bodies with tens of thousands of near-
// identical lines (e.g. one action per ship in the game) — one mission in
// the wild has ~37,000 raw nodes. Rendering that eagerly, for every mission,
// on every page load, is what actually blew up memory during testing. So:
// raw trees are built lazily (only when a card's toggle is clicked — see
// UserManagerMissionDisplay.js) AND capped, so even opening that one
// mission can't freeze the tab.
const RAW_TREE_NODE_CAP = 1500;

// Generic { key, values, children } tree → HTML string. Used for `raw`
// and for `conditions`, since missionParser.js gives both the exact same
// shape. depth just controls indentation. `budget` tracks how many nodes
// have been emitted across the whole (possibly recursive) call so the cap
// applies to the tree as a whole, not per branch.
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

// Same reasoning as RAW_TREE_NODE_CAP above, applied to search text
// instead of rendered HTML: the one real mission with ~37,000 raw nodes
// would otherwise dwarf every other mission's searchText combined, for
// zero practical benefit (nobody searches for node #30,000 of a bulk-
// action mission). Capped in characters here rather than node count
// since that's what actually matters for memory/string-search cost.
const SEARCH_TEXT_CHAR_CAP = 4000;

// Walks a raw tree collecting anything text-like — bare narrative/
// dialogue lines (which show up as the entry's own `key`, per
// renderTreeHtml's isBareText handling) and string values — so a
// mission can be found by searching for a line of dialogue, a
// condition name, or any other detail buried in its structure, not
// just its name/description. Numeric-only keys/values are skipped;
// they're never what someone is searching for.
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

// ═════════════════════════════════════════════════════════════
//  Mission → view model. Everything the display layer needs,
//  pre-built. `bodyHtml` is a complete, ready-to-inject string.
// ═════════════════════════════════════════════════════════════
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
        // Left empty on purpose — filled in lazily on first click by
        // UserManagerMissionDisplay.js via MissionLoader.renderRawTree(),
        // using the `raw` field on this view model. See RAW_TREE_NODE_CAP
        // above for why this can't be eager.
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
        // Structured (not HTML-formatted) reward/payment data — already
        // baked into bodyHtml for display, but a "complete this mission"
        // action needs the actual numbers/names, not formatted strings.
        rewards: m.rewards || { outfits: [], ships: [] },
        payment: m.payment || { apparentPayment: null, triggers: {} },
        // Whether this mission can be completed more than once — needed
        // by saveCleanupHelper.js's completeMission() to decide whether
        // leftover failed/declined history should be cleared (non-
        // repeatable) or preserved alongside the new done (repeatable).
        repeatable: !!m.repeatable,
        repeatLimit: m.repeatLimit || null,
        // Location tags (job, spaceport, landing, ...) — lets a consumer
        // filter for e.g. job-board missions specifically.
        locations: m.locations || [],
    };
}

// ═════════════════════════════════════════════════════════════
//  Plugin management
// ═════════════════════════════════════════════════════════════
function _activeMissionData() {
    const result = {};
    for (const id of _activePlugins) {
        if (window.allMissionData[id]) result[id] = window.allMissionData[id];
    }
    return result;
}

function _fireEvent(name, detail = {}) {
    document.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
}

// Fires MissionLoader's own event AND the generic 'pluginsChanged' event that
// generalPluginStuff.js (the shared picker module) listens for, so both this
// page's own display code and the shared picker UI stay in sync off one
// state change.
function _firePluginsChanged() {
    const detail = { active: [..._activePlugins] };
    _fireEvent('missionPluginsChanged', detail);
    _fireEvent('pluginsChanged', detail);
}

function _saveActivePlugins() {
    try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(_activePlugins)); } catch (_) {}
}
function _loadActivePlugins() {
    try { return JSON.parse(localStorage.getItem(ACTIVE_KEY)); } catch (_) { return null; }
}

// ═════════════════════════════════════════════════════════════
//  Public API
// ═════════════════════════════════════════════════════════════
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

    // ── Plugin management ──────────────────────────────────
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

    // Sets the active list and persists it WITHOUT firing an event — mirrors
    // dataLoader.js's own _setActivePluginsSilent. generalPluginStuff.js calls
    // this after it has already updated its own UI, so MissionLoader doesn't
    // need to (and shouldn't) trigger another render pass on top of that.
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
        // No usable saved selection — default to every plugin that's
        // ACTUALLY loaded so far (excludes placeholders for plugins
        // Phase B hasn't reached yet), so nothing appears "active" before
        // it really has data.
        _activePlugins = Object.entries(window.allMissionData)
            .filter(([, p]) => !p._placeholder)
            .map(([id]) => id);
        _saveActivePlugins();
        _firePluginsChanged();
    },

    // ── Data accessors (active plugins only, fully formatted) ──
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

    // Renders a mission's raw parse tree to HTML on demand. Deliberately
    // NOT baked into bodyHtml — see RAW_TREE_NODE_CAP above.
    renderRawTree(rawEntries) {
        return renderTreeHtml(rawEntries);
    },

    DEFAULT_PLUGIN,
};

// ═════════════════════════════════════════════════════════════
//  Compatibility shim for generalPluginStuff.js
//
//  generalPluginStuff.js is the app's shared plugin-picker module. It's
//  written against dataLoader.js's API (window.DataLoader.setActivePlugins,
//  _setActivePluginsSilent, LOCAL_PLUGIN_ID) rather than MissionLoader's.
//  This page doesn't load dataLoader.js, so we stand in for it here —
//  purely so generalPluginStuff.js can be dropped onto this page unmodified.
//  If a real window.DataLoader is ever also loaded on this page, this shim
//  steps aside and leaves it alone.
// ═════════════════════════════════════════════════════════════
if (!window.DataLoader) {
    window.DataLoader = {
        // Missions have no "Local Builds" concept, but generalPluginStuff.js
        // reads this constant unconditionally, so it needs to exist as a
        // harmless value that will simply never match a real plugin id.
        LOCAL_PLUGIN_ID: '__local_builds__',
        setActivePlugins(arr)        { window.MissionLoader.setActivePlugins(arr); },
        _setActivePluginsSilent(arr) { window.MissionLoader._setActivePluginsSilent(arr); },
    };
}

// ═════════════════════════════════════════════════════════════
//  Remote data loader — per-plugin, same shape as dataLoader.js.
//  Was: one bulk fetch of every mission across every plugin, always —
//  missions are the heaviest row-for-row data type in this whole
//  project (raw AST trees, conditions, rewards), so doing that
//  unconditionally on every page load was the actual cause of
//  UserMissionHelper.html loading much slower than everywhere else.
//  Formatting (formatMission, etc. above) is untouched — it only ever
//  receives a plain mission object regardless of how it got fetched.
// ═════════════════════════════════════════════════════════════

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

async function _fetchMissionBundleFresh(outputName, pluginRow, onFirst) {
    const { fetchAllRows } = window.SupabaseHelpers;
    if (!pluginRow) {
        return { sourceName: outputName, displayName: outputName, outputName, missions: [] };
    }
    const missionRows = await fetchAllRows('missions', {
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

async function _loadMissionBundle(outputName, pluginRow, onFirst) {
    const build = () => _fetchMissionBundleFresh(outputName, pluginRow, onFirst);
    return window.EsCache
        ? await window.EsCache.loadWithCache(`missionBundle:${outputName}`, build)
        : await build();
}

/** Phase B — loads whatever Phase A didn't, one plugin at a time, without
 * blocking. Same reasoning as dataLoader.js's version: only runs for as
 * long as this page stays open, and per-plugin caching is what carries
 * progress forward if the user navigates away before it finishes. */
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

/** Safety net for code that needs a SPECIFIC plugin's missions right now —
 * e.g. the user switches to a plugin that wasn't in Phase A and whose
 * background load hasn't reached it yet. Mirrors dataLoader.js's
 * ensurePluginLoaded exactly. */
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

async function _doLoad() {
    _loading = true;
    _fireEvent('missionsLoadStart');

    try {
        const { fetchAllRows } = window.SupabaseHelpers;

        // The plugin list itself is small (~110 rows, no heavy columns) —
        // always cheap to fetch in full, so the picker can show every
        // plugin immediately even before its missions have loaded.
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

        // Phase A: whichever plugins are already active (account
        // preference, then localStorage), or just the default plugin if
        // this is the first visit ever. This is the only thing standing
        // between page load and the page being usable.
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
