'use strict';

// The Saves & Account page: your saves, the overview tabs (fleet, cargo, licences, plugins) and sending ships to the builder.

const SM_REGISTRY_KEY     = 'ES_SM_REGISTRY';
const SM_SAVE_PREFIX      = 'ES_SM_SAVE_';
const SM_CURRENT_KEY      = 'ES_SM_CURRENT';
const SM_ACTIVE_SHIPS_KEY = 'ES_SM_ACTIVE_SAVE_SHIPS';

let parsedSave    = null;
let currentSaveId = null;
let activeFilter  = '';
let activeSort    = 'default';

const el = id => document.getElementById(id);

// ── storage (this browser) ──

function smGetRegistry() {
  try {
    const raw = localStorage.getItem(SM_REGISTRY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('[saveManager] Could not read registry:', e);
    return [];
  }
}

// save the saves list
function smSetRegistry(list) {
  try {
    localStorage.setItem(SM_REGISTRY_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    console.warn('[saveManager] Could not write registry:', e);
    return false;
  }
}

// one save's data
function smGetSaveData(id) {
  try {
    const raw = localStorage.getItem(SM_SAVE_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[saveManager] Could not read save', id, e);
    return null;
  }
}

// store one save's data
function smSetSaveData(id, data) {
  try {
    localStorage.setItem(SM_SAVE_PREFIX + id, JSON.stringify(data));
    return true;
  } catch (e) {
    console.warn('[saveManager] Could not write save', id, e);
    return false;
  }
}

// delete one save's data
function smDeleteSaveData(id) {
  try { localStorage.removeItem(SM_SAVE_PREFIX + id); } catch (e) { /* ignore */ }
}

// the open save's id
function smGetCurrentId() {
  try {
    const raw = localStorage.getItem(SM_CURRENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
// set the open save
function smSetCurrentId(id) {
  try { localStorage.setItem(SM_CURRENT_KEY, JSON.stringify(id)); } catch (e) { /* ignore */ }
}
// no open save
function smClearCurrentId() {
  try { localStorage.removeItem(SM_CURRENT_KEY); } catch (e) { /* ignore */ }
}

// ── ships from the open save, for the builder ──

function smGetActiveSaveShips() {
  try {
    const raw = localStorage.getItem(SM_ACTIVE_SHIPS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[saveManager] Could not read active save ships:', e);
    return null;
  }
}

// store the save's ships for the builder
function smSetActiveSaveShips(shipsInMapFormat) {
  try {
    localStorage.setItem(SM_ACTIVE_SHIPS_KEY, JSON.stringify(shipsInMapFormat));
    return true;
  } catch (e) {
    console.warn('[saveManager] Could not write active save ships:', e);
    return false;
  }
}


// new save id (a UUID — the same id is used for its account copy)
function smMakeId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.random() * 256 | 0; });
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map(v => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// add a save
function smAddSave(parsed, originalFileName) {
  const id = smMakeId();
  const summary = {
    id,
    label:      parsed.pilot.name || originalFileName || 'Unnamed Save',
    pilotName:  parsed.pilot.name || '',
    importedAt: Date.now(),
  };
  const registry = smGetRegistry();
  registry.push(summary);
  smSetRegistry(registry);
  smSetSaveData(id, parsed);
  smSetCurrentId(id);
  return id;
}

// remove a save
function smRemoveSave(id) {
  const registry = smGetRegistry().filter(s => s.id !== id);
  smSetRegistry(registry);
  smDeleteSaveData(id);
  if (smGetCurrentId() === id) smClearCurrentId();
}

// ── which plugins a save uses ──

// plugins.json sits at the site root, two folders up from these pages — try that
// first so the browser console isn't filled with 404s from the guesses.
const PLUGIN_REGISTRY_CANDIDATES = [
  '../../plugins.json',
  '/plugins.json',
  '../plugins.json',
  './plugins.json',
];

let _pluginRegistryCache = null;

// plugin list for matching
async function smLoadPluginRegistry() {
  if (_pluginRegistryCache) return _pluginRegistryCache;
  for (const path of PLUGIN_REGISTRY_CANDIDATES) {
    try {
      const res = await fetch(path);
      if (!res.ok) continue;
      const json = await res.json();
      if (Array.isArray(json.plugins)) {
        _pluginRegistryCache = json.plugins;
        return _pluginRegistryCache;
      }
    } catch (e) { /* try next */ }
  }
  console.warn('[saveManager] Could not load plugins.json from any of:', PLUGIN_REGISTRY_CANDIDATES);
  _pluginRegistryCache = [];
  return _pluginRegistryCache;
}

// plugin name for comparing
function _smNormalisePluginName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/['’"()]/g, '')
    .replace(/[\s_-]+/g, '');
}
// drop a branch suffix
function _smStripBranchSuffix(name) {
  return String(name || '').replace(/-(main|master)$/i, '');
}
// name with possible branch suffixes
function _smWithBranchSuffixes(name) {
  const base = String(name || '');
  return [base + '-main', base + '-master'];
}

let _indexDisplayNameCache = null;

// plugin display names
async function smLoadIndexDisplayNames() {
  if (_indexDisplayNameCache) return _indexDisplayNameCache;
  const map = {};
  try {
    const { data, error } = await window.supabaseClient.from('plugins').select('output_name, display_name');
    if (!error && data) {
      for (const row of data) {
        if (row.output_name && row.display_name) map[row.output_name] = row.display_name;
      }
    }
  } catch (e) {
    console.warn('[saveManager] Could not load plugin display names from Supabase:', e);
  }
  _indexDisplayNameCache = map;
  return _indexDisplayNameCache;
}

// plugin label
function _smDisplayLabel(data, outputName, indexDisplayNames) {
  return (indexDisplayNames && indexDisplayNames[outputName])
    || data?.displayPluginName || data?.displayName || data?.name || '';
}
// repo slug
function _smRepoSlug(url) {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!m) return '';
  return (m[1] + '/' + m[2]).toLowerCase().replace(/\.git$/, '');
}

// which of our plugins the save's plugins match. Called by: renderPluginsPanel, saveHealthCheck
async function smMatchSavePlugins(saveNames) {
  const registry          = await smLoadPluginRegistry();
  const indexDisplayNames = await smLoadIndexDisplayNames();
  const allData           = (window.allData || {});
  const localId           = window.DataLoader?.LOCAL_PLUGIN_ID || '__local_builds__';
  const loadedEntries     = Object.entries(allData).filter(([id]) => id !== localId);

  const matched   = [];
  const unmatched = [];

  for (const saveName of saveNames) {
    const normSave        = _smNormalisePluginName(saveName);
    const normSaveStrip   = _smNormalisePluginName(_smStripBranchSuffix(saveName));
    const normSaveSuffixed = _smWithBranchSuffixes(saveName).map(_smNormalisePluginName);

    let foundEntry = null;
    let matchedBy  = null;

    // 1 — Direct match against outputName (the literal data/<pluginName> folder name)
    foundEntry = loadedEntries.find(([outputName]) => _smNormalisePluginName(outputName) === normSave);
    if (foundEntry) matchedBy = 'folder-name';

    // 2 — Match allowing a "-main"/"-master" suffix on either side
    if (!foundEntry) {
      foundEntry = loadedEntries.find(([outputName]) => {
        const normOutput      = _smNormalisePluginName(outputName);
        const normOutputStrip = _smNormalisePluginName(_smStripBranchSuffix(outputName));
        return normSaveSuffixed.includes(normOutput) || normOutputStrip === normSave || normOutputStrip === normSaveStrip;
      });
      if (foundEntry) matchedBy = 'folder-name-main-suffix';
    }

    // 3 — Match against the plugin's display label
    if (!foundEntry) {
      foundEntry = loadedEntries.find(([outputName, data]) =>
        _smNormalisePluginName(_smDisplayLabel(data, outputName, indexDisplayNames)) === normSave
      );
      if (foundEntry) matchedBy = 'display-name';
    }

    // 4 — Registry fallback: save name → plugins.json → repository → repo slug
    if (!foundEntry) {
      const regEntry = registry.find(r => _smNormalisePluginName(r.name) === normSave);
      if (regEntry) {
        const targetSlug = _smRepoSlug(regEntry.repository);
        foundEntry = loadedEntries.find(([outputName]) =>
          targetSlug && outputName.toLowerCase().includes(targetSlug)
        );
        if (!foundEntry) {
          foundEntry = loadedEntries.find(([, data]) =>
            _smNormalisePluginName(data.sourceName) === normSave
          );
        }
        if (foundEntry) matchedBy = 'registry';
      } else if (!foundEntry) {
        unmatched.push({ saveName, reason: 'not-in-registry' });
        continue;
      }
    }

    if (foundEntry) {
      const [outputName, data] = foundEntry;
      matched.push({
        saveName,
        outputName,
        sourceName:  data.sourceName || outputName,
        displayName: _smDisplayLabel(data, outputName, indexDisplayNames) || outputName,
        matchedBy,
      });
    } else {
      unmatched.push({ saveName, reason: 'not-loaded' });
    }
  }

  return { matched, unmatched };
}

// the base game's plugin name
function smFindEndlessSkyOutputName() {
  const allData = window.allData || {};
  const localId = window.DataLoader?.LOCAL_PLUGIN_ID || '__local_builds__';
  const officialEntry = Object.entries(allData).find(
    ([id, data]) => id !== localId && data?.sourceName === 'official-game'
  );
  if (officialEntry) return officialEntry[0];
  const fallback = window.DataLoader?.DEFAULT_PLUGIN;
  if (fallback && allData[fallback]) return fallback;
  return null;
}

// select the matched plugins
function smActivateMatchedPlugins(matched) {
  if (!window.DataLoader || typeof window.DataLoader.setActivePlugins !== 'function') {
    console.warn('[saveManager] DataLoader.setActivePlugins is not available on this page.');
    return false;
  }
  const endlessSkyOutput = smFindEndlessSkyOutputName();
  const outputNames = matched.map(m => m.outputName);
  if (endlessSkyOutput) {
    const existingIdx = outputNames.indexOf(endlessSkyOutput);
    if (existingIdx !== -1) outputNames.splice(existingIdx, 1);
    outputNames.unshift(endlessSkyOutput);
  }
  if (!outputNames.length) return false;
  window.DataLoader.setActivePlugins(outputNames);
  return true;
}

// ── start: pick up the last open save ──

let _dataReady = false;

// open the last save on load
function smBootstrap() {
  _dataReady = true;

  // Work out the current save BEFORE drawing the list, so the list never
  // shows "No save" as current while the save itself is on screen.
  const curId = smGetCurrentId();
  if (curId) {
    const data = smGetSaveData(curId);
    if (data) {
      parsedSave    = data;
      currentSaveId = curId;
      renderSavesLibrary();
      renderResults();
      return;
    }
    // big saves are rebuilt from their file a moment later
    if (!smGetRegistry().some(s => s.id === curId)) smClearCurrentId();
  }
  renderSavesLibrary();
}

// ── messages ──

let _toastTimer = null;
// short message
function toast(msg, type = '') {
  const t = el('toast');
  t.textContent = msg;
  t.className   = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ── opening a save file ──

const fileInput = el('fileInput');
const dropzone  = el('dropzone');

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

['dragover', 'dragenter'].forEach(evt =>
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--c-accent)';
    dropzone.style.background  = 'rgba(59,130,246,0.10)';
  })
);
['dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.style.borderColor = '';
    dropzone.style.background  = '';
  })
);
dropzone.addEventListener('drop', e => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// show an error
function showError(msg) {
  const box = el('errorBox');
  box.textContent = msg;
  box.classList.remove('hidden');
  // also as a pop-up message, and bring the box into view (on phones it can be off-screen)
  toast(msg, 'danger');
  try { box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
}
// clear it
function clearError() {
  el('errorBox').classList.add('hidden');
}

// read an uploaded save file. Called by: the upload box, saveSync
async function handleFile(file) {
  clearError();

  // don't accept a file before the page has loaded its data
  if (!_dataReady) {
    showError('Still loading game and plugin data — please wait a moment and try again.');
    return;
  }
  if (!file.name.toLowerCase().endsWith('.txt')) {
    showError('That doesn\u2019t look like a .txt save file. Endless Sky save files are exported as plain text.');
    return;
  }

  try {
    const text   = await file.text();
    if (!text.trim()) { showError('That file is empty — choose an Endless Sky save file (.txt) from your saves folder.'); return; }
    const parsed = parseESSaveFile(text);
    if (!parsed.ships.length && !parsed.pilot.name) {
      showError('No pilot or ship data was found in this file. Make sure it\u2019s an unmodified Endless Sky save.');
      return;
    }

    const baseName = file.name.replace(/\.txt$/i, '');
    const id       = smAddSave(parsed, baseName);

    parsedSave    = parsed;
    currentSaveId = id;

    fileInput.value = '';
    renderSavesLibrary();
    renderResults();
    toast('Save file loaded — ' + parsed.ships.length + ' ship(s) found.', 'success');
  } catch (err) {
    showError('Could not parse this file: ' + err.message);
    console.error(err);
  }
}

// your saves list (with "No save" at the top). Called by: after any save change

function renderSavesLibrary() {
  const wrap     = el('savesLibrary');
  const registry = smGetRegistry();

  if (!registry.length) {
    wrap.innerHTML = `<div class="ld-empty" style="padding:10px 0;">No saves stored yet — upload one below.</div>`;
    return;
  }

  // "No save": keep your saves stored but browse the site without a pilot
  // (missions, the map, auto-fit … all behave as if no save were open).
  const noneCurrent = !currentSaveId;
  const noneRow = `<div class="list-row" data-no-save="1" role="button" tabindex="0" style="${noneCurrent ? 'border-color:var(--c-accent); background:rgba(59,130,246,0.10);' : ''} margin-bottom:8px; cursor:pointer;">
        <span class="list-row__label">
          ⊘ No save
          <span style="display:block;font-size:0.74rem;color:var(--c-text-dim);font-weight:400;">Use the site without a pilot — your saves stay stored</span>
        </span>
        ${noneCurrent ? '<span style="font-size:0.72rem; background:var(--c-success); color:var(--c-success-text); padding:2px 8px; border-radius:10px; font-weight:600;">Current</span>' : ''}
      </div>`;

  wrap.innerHTML = noneRow + registry
    .slice()
    .sort((a, b) => b.importedAt - a.importedAt)
    .map(s => {
      const isCurrent = s.id === currentSaveId;
      return `<div class="list-row" data-save-id="${esc(s.id)}" style="${isCurrent ? 'border-color:var(--c-accent); background:rgba(59,130,246,0.10);' : ''} margin-bottom:8px; cursor:pointer;">
        <span class="list-row__label">
          ${esc(s.label)}
          ${isCurrent ? '<span style="margin-left:8px; font-size:0.72rem; background:var(--c-success); color:var(--c-success-text); padding:2px 8px; border-radius:10px; font-weight:600;">Current</span>' : ''}
        </span>
        <span style="font-size:0.78rem; color:var(--c-text-dim); margin-right:8px;">${esc(formatImportedAt(s.importedAt))}</span>
        <button class="btn-remove sm-delete-btn" data-save-id="${esc(s.id)}" title="Delete this save">✕</button>
      </div>`;
    })
    .join('');

  wrap.querySelectorAll('.list-row[data-save-id]').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.sm-delete-btn')) return;
      switchToSave(row.dataset.saveId);
    });
  });
  const none = wrap.querySelector('[data-no-save]');
  if (none) {
    none.addEventListener('click', selectNoSave);
    none.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectNoSave(); } });
  }
  wrap.querySelectorAll('.sm-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      confirmDeleteSave(btn.dataset.saveId);
    });
  });
}

// "imported 2 days ago"
function formatImportedAt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// open another save
function switchToSave(id) {
  if (id === currentSaveId) return;
  const data = smGetSaveData(id);
  if (!data) {
    toast('That save could not be loaded — it may have been removed.', 'danger');
    renderSavesLibrary();
    return;
  }
  parsedSave    = data;
  currentSaveId = id;
  smSetCurrentId(id);
  renderSavesLibrary();
  renderResults();
  document.dispatchEvent(new CustomEvent('esSaveSelected', { detail: { id } }));
  toast('Switched save.', 'success');
}

// stop using a save (they stay stored)
function selectNoSave() {
  if (!currentSaveId) return;
  parsedSave    = null;
  currentSaveId = null;
  smClearCurrentId();
  closeSaveView();
  renderSavesLibrary();
  document.dispatchEvent(new CustomEvent('esSaveSelected', { detail: { id: null } }));
  toast('No save selected — the site now works without a pilot. Pick a save to use it again.', 'success');
}

// hide the open save's overview
function closeSaveView() {
  el('results').classList.add('hidden');
  el('resultButtons').querySelectorAll('button').forEach(b => b.classList.add('hidden'));
}

// delete a save (asks first)
function confirmDeleteSave(id) {
  const registry = smGetRegistry();
  const entry    = registry.find(s => s.id === id);
  const label    = entry ? entry.label : 'this save';
  if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return;

  const wasCurrent = id === currentSaveId;
  smRemoveSave(id);

  if (wasCurrent) {
    parsedSave    = null;
    currentSaveId = null;
    closeSaveView();
  }

  renderSavesLibrary();
  toast('Save removed.', 'success');
}

// ── the open save's overview ──

function renderResults() {
  el('exportJsonBtn').classList.remove('hidden');
  el('importFleetBtn').classList.remove('hidden');
  el('removeSaveBtn').classList.remove('hidden');
  el('results').classList.remove('hidden');

  el('pilotName').textContent = '👤 ' + (parsedSave.pilot.name || 'Unnamed Pilot');
  const loc = [parsedSave.pilot.planet, parsedSave.pilot.system].filter(Boolean).join(', ');
  el('pilotMeta').textContent = [
    loc                       ? 'Location: ' + loc                                    : null,
    parsedSave.pilot.date     ? 'Date: '     + formatDate(parsedSave.pilot.date)      : null,
    parsedSave.pilot.playtime ? 'Played: '   + formatPlaytime(parsedSave.pilot.playtime) : null,
  ].filter(Boolean).join('   ·   ');

  renderStatStrip();
  renderFleetGrid();
  renderCargoStorage();
  renderAccountLicenses();
  renderPluginsPanel();
}

// game date as text
function formatDate(d) {
  if (!d) return '—';
  const parts = d.trim().split(/\s+/);
  if (parts.length === 3) {
    const [day, month, year] = parts;
    const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${day} ${months[parseInt(month)] || month} ${year}`;
  }
  return d;
}
// playtime as text
function formatPlaytime(seconds) {
  if (!seconds) return '—';
  return Math.floor(seconds / 3600).toLocaleString() + ' hrs';
}
function fmtNum(n) {
  if (n == null) return '—';
  return Math.round(n).toLocaleString();
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// the stat strip
function renderStatStrip() {
  const ships        = parsedSave.ships;
  const active       = ships.filter(s => !s._parked).length;
  const parked       = ships.length - active;
  const totalOutfits = ships.reduce((sum, s) => sum + s.outfits.reduce((a, o) => a + (o.count || 1), 0), 0);

  const cells = [
    { label: 'Credits',         value: (parsedSave.account.credits || 0).toLocaleString() },
    // account "score" is the credit score (mortgage terms, 400–800); combat
    // rating is the "combat rating" condition
    { label: 'Combat Rating',   value: (Number(parsedSave.pilot?.conditions?.['combat rating']) || 0).toLocaleString() },
    { label: 'Ships',           value: ships.length },
    { label: 'Active',          value: active },
    { label: 'Parked',          value: parked },
    { label: 'Outfits Carried', value: totalOutfits },
    { label: 'Licenses',        value: parsedSave.licenses.length },
  ];
  el('statStrip').innerHTML = cells.map(c => `
    <div class="stat-card">
      <div class="stat-value">${esc(String(c.value))}</div>
      <div class="stat-label">${esc(c.label)}</div>
    </div>`).join('');
}

// fleet after search and sort
function getFilteredSortedShips() {
  let ships = parsedSave.ships.map((s, i) => ({ ship: s, idx: i }));

  if (activeFilter) {
    const q = activeFilter.toLowerCase();
    ships = ships.filter(({ ship }) =>
      (ship._customName || '').toLowerCase().includes(q) ||
      (ship._modelName  || '').toLowerCase().includes(q) ||
      smModelLabel(ship._modelName).toLowerCase().includes(q) ||
      (ship._system     || '').toLowerCase().includes(q) ||
      (ship._planet     || '').toLowerCase().includes(q)
    );
  }

  switch (activeSort) {
    case 'name':   ships.sort((a, b) => (a.ship._customName || '').localeCompare(b.ship._customName || '')); break;
    case 'model':  ships.sort((a, b) => (a.ship._modelName  || '').localeCompare(b.ship._modelName  || '')); break;
    case 'hull':   ships.sort((a, b) => (b.ship._hull || 0) - (a.ship._hull || 0)); break;
    case 'parked': ships.sort((a, b) => (b.ship._parked ? 1 : 0) - (a.ship._parked ? 1 : 0)); break;
  }
  return ships;
}

// fleet cards
function renderFleetGrid() {
  const grid = el('fleetGrid');
  const list = getFilteredSortedShips();

  if (!list.length) {
    grid.innerHTML = `<div class="fleet-empty"><div class="fleet-empty__icon">🛸</div>
      <p>No ships match your search.</p></div>`;
    return;
  }

  grid.innerHTML = list.map(({ ship, idx }) => {
    const statusBadge = ship._parked
      ? `<span style="font-size:0.7rem; background:var(--c-warn); color:var(--c-warn-text); padding:2px 8px; border-radius:10px; font-weight:600; white-space:nowrap;">Parked</span>`
      : `<span style="font-size:0.7rem; background:var(--c-success); color:var(--c-success-text); padding:2px 8px; border-radius:10px; font-weight:600; white-space:nowrap;">Active</span>`;
    const outfitCount = ship.outfits.reduce((sum, o) => sum + (o.count || 1), 0);
    const loc         = [ship._planet, ship._system].filter(Boolean).join(', ');

    return `<div class="fleet-card" data-idx="${idx}">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <div class="fleet-card__name">${ship._customName ? esc(ship._customName) : smModelHtml(ship._modelName)}</div>
        ${statusBadge}
      </div>
      <div class="fleet-card__variant">${smModelHtml(ship._modelName)}</div>
      <div class="fleet-card__stats">
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Hull</div><div class="fleet-card__stat-value">${fmtNum(ship._hull)}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Shields</div><div class="fleet-card__stat-value">${fmtNum(ship._shields)}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Outfits</div><div class="fleet-card__stat-value">${outfitCount}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Crew</div><div class="fleet-card__stat-value">${ship._crew ?? '—'}</div></div>
      </div>
      <div class="internal-name" style="margin-top:12px; padding-bottom:0;">${esc(loc || '—')}</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.fleet-card').forEach(card => {
    card.addEventListener('click', () => openShipModal(parseInt(card.dataset.idx)));
  });
}

// Cargo & Storage tab
function renderCargoStorage() {
  const cargoEntries = Object.entries(parsedSave.cargo.outfits || {});
  const commodityEntries = Object.entries(parsedSave.cargo.commodities || {}).filter(([, t]) => t > 0);
  el('cargoList').innerHTML = (cargoEntries.length || commodityEntries.length)
    ? `<div class="ld-pills">${commodityEntries.map(([name, tons]) =>
        `<span class="ld-pill">${esc(name)} · ${tons.toLocaleString()} t</span>`).join('')}${cargoEntries.map(([name, count]) =>
        `<span class="ld-pill">${smOutfitHtml(name)}${count > 1 ? ` ×${count}` : ''}</span>`).join('')}</div>`
    : `<div class="ld-empty">No cargo carried.</div>`;

  const storage = parsedSave.storage || [];
  el('storageList').innerHTML = storage.length
    ? storage.map(s => {
        const entries = Object.entries(s.cargo.outfits || {});
        return `<div class="ld-plugin-block ld-plugin-active" style="margin-bottom:14px;">
          <div class="ld-plugin-header" style="cursor:default;">
            <span class="ld-plugin-name">${esc(s.planet)}</span>
            <span class="ld-plugin-badge" style="background:var(--c-success); color:var(--c-success-text);">${entries.length} item${entries.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="ld-plugin-content-wrapper">
            ${entries.length
              ? `<div class="ld-pills">${entries.map(([name, count]) =>
                  `<span class="ld-pill">${smOutfitHtml(name)}${count > 1 ? ` ×${count}` : ''}</span>`).join('')}</div>`
              : `<div class="ld-unused">Nothing stored here.</div>`}
          </div>
        </div>`;
      }).join('')
    : `<div class="ld-empty">No planetary storage recorded.</div>`;
}

// Account & Licences tab
function renderAccountLicenses() {
  const a = parsedSave.account;
  const cells = [
    { label: 'Credits',      value: (a.credits || 0).toLocaleString() },
    { label: 'Credit Score',  value: (a.score   || 0).toLocaleString() },
    { label: 'Combat Rating', value: (Number(parsedSave.pilot?.conditions?.['combat rating']) || 0).toLocaleString() },
    ...Object.entries(a.salaries || {}).map(([k, v]) => ({ label: 'Salary: ' + k, value: v.toLocaleString() + ' cr' })),
  ];
  el('accountGrid').innerHTML = cells.map(c => `
    <div class="attribute">
      <div class="attribute-name">${esc(c.label)}</div>
      <div class="attribute-value">${esc(String(c.value))}</div>
    </div>`).join('');

  el('licenseList').innerHTML = parsedSave.licenses.length
    ? parsedSave.licenses.map(l => `<span class="ld-pill">${esc(l)}</span>`).join('')
    : `<div class="ld-empty">No licenses recorded.</div>`;
}

// ── plugins panel (waits for DataLoader) ──

function smWaitForDataLoader(timeoutMs = 15000) {
  return new Promise(resolve => {
    if (!window.DataLoader || typeof window.DataLoader.isReady !== 'function') {
      resolve(false); return;
    }
    if (window.DataLoader.isReady()) { resolve(true); return; }
    let done = false;
    const finish = ok => { if (done) return; done = true; resolve(ok); };
    if (typeof window.DataLoader.onReady === 'function') {
      window.DataLoader.onReady(() => finish(true));
    }
    document.addEventListener('dataLoadError', () => finish(false), { once: true });
    setTimeout(() => finish(window.DataLoader.isReady ? window.DataLoader.isReady() : false), timeoutMs);
  });
}

// Plugins tab
async function renderPluginsPanel() {
  const box = el('pluginsPanel');
  if (!box) return;

  const names = parsedSave.plugins || [];
  if (!names.length) {
    box.innerHTML = `<div class="ld-empty">No plugins were recorded in this save.</div>`;
    return;
  }
  if (!window.DataLoader) {
    box.innerHTML = `<div class="ld-empty">Plugin data isn\u2019t available on this page (dataLoader.js isn\u2019t loaded), so plugins from this save can\u2019t be matched here.</div>`;
    return;
  }

  box.innerHTML = `<div class="ld-empty" style="padding:10px 0;">Loading plugin data\u2026</div>`;
  await smWaitForDataLoader();
  box.innerHTML = `<div class="ld-empty" style="padding:10px 0;">Checking plugins against loaded data…</div>`;

  const { matched, unmatched } = await smMatchSavePlugins(names);

  const matchedHtml = matched.length
    ? `<div class="ld-pills" style="margin-bottom:10px;">${matched.map(m =>
        `<span class="ld-pill" title="${esc(m.outputName)}">✅ ${esc(m.displayName)}</span>`).join('')}</div>`
    : `<div class="ld-empty" style="padding:4px 0 10px;">None of this save's plugins are currently loaded.</div>`;

  const unmatchedHtml = unmatched.length
    ? `<div class="ld-pills">${unmatched.map(u =>
        `<span class="ld-pill" style="opacity:0.6;" title="${u.reason === 'not-in-registry' ? 'Not found in the plugin registry' : 'Found in the registry, but no data is loaded for it'}">⚠️ ${esc(u.saveName)}</span>`).join('')}</div>`
    : '';

  box.innerHTML = `
    <div class="ad-section-title" style="margin-top:0;">Installed in this save (${names.length})</div>
    ${matchedHtml}
    ${unmatched.length ? `
      <div class="ad-section-title">Could not match (${unmatched.length})</div>
      ${unmatchedHtml}
      <p style="font-size:0.8rem; color:var(--c-text-dim); margin-top:8px;">
        These are listed in the save but either aren't in the plugin registry, or no data is currently loaded for them on this page.
      </p>
    ` : ''}
    <div class="button-group" style="margin-top:16px;">
      ${matched.length ? `<button class="btn btn-primary" id="activatePluginsBtn">Activate ${matched.length} matched plugin${matched.length !== 1 ? 's' : ''}</button>` : ''}
      <button class="btn btn-secondary" id="recheckPluginsBtn">Re-check plugins</button>
    </div>
  `;

  el('activatePluginsBtn')?.addEventListener('click', () => {
    const ok = smActivateMatchedPlugins(matched);
    toast(
      ok ? 'Activated ' + matched.length + ' plugin(s) from this save.'
         : 'Could not activate plugins — plugin system isn\u2019t available on this page.',
      ok ? 'success' : 'danger'
    );
  });
  el('recheckPluginsBtn')?.addEventListener('click', () => renderPluginsPanel());
}

// ── ship window ──

function openShipModal(idx) {
  const ship = parsedSave.ships[idx];
  const a    = ship.attributes || {};

  el('modalShipName').textContent = ship._customName || ship._modelName;
  el('modalShipSub').textContent  = `${ship._modelName} · ${ship._parked ? 'Parked' : 'Active'} at ${ship._planet || 'unknown'}${ship._system ? ', ' + ship._system : ''}`;

  const quickStats = [
    { label: 'Hull',         value: fmtNum(ship._hull) },
    { label: 'Shields',      value: fmtNum(ship._shields) },
    { label: 'Fuel',         value: fmtNum(ship._fuel) },
    { label: 'Crew',         value: ship._crew ?? '—' },
    { label: 'Guns',         value: ship.guns.length },
    { label: 'Turrets',      value: ship.turrets.length },
    { label: 'Fighter Bays', value: ship.fighters.length },
    { label: 'Drone Bays',   value: ship.drones.length },
  ];

  const outfitChips     = ship.outfits.length
    ? `<div class="ld-pills">${ship.outfits.map(o => `<span class="ld-pill">${smOutfitHtml(o.name)}${o.count > 1 ? ` ×${o.count}` : ''}</span>`).join('')}</div>`
    : `<div class="ld-empty">No outfits installed.</div>`;
  const gunList         = ship.guns.length    ? ship.guns.map(g    => g.over ? esc(g.over) : '(empty mount)').join(', ') : null;
  const turretList      = ship.turrets.length ? ship.turrets.map(t => t.over ? esc(t.over) : '(empty mount)').join(', ') : null;
  const attrKeys        = Object.keys(a).filter(k => k !== 'licenses');
  const leakRows        = ship.leaks.length        ? ship.leaks.map(l        => `<div class="ad-row"><span class="ad-label">${esc(l.name)}</span><span class="ad-value">open ${l.openChance}% · spread ${l.spreadChance}%</span></div>`).join('') : null;
  const explodeStr      = ship.explode.length      ? ship.explode.map(e      => `${esc(e.name)} ×${e.count}`).join(', ') : null;
  const finalExplodeStr = ship.finalExplode.length ? ship.finalExplode.map(e => `${esc(e.name)} ×${e.count}`).join(', ') : null;

  el('modalBody').innerHTML = `
    <div class="attribute-grid" style="margin-bottom:25px;">
      ${quickStats.map(q => `
        <div class="attribute">
          <div class="attribute-name">${esc(q.label)}</div>
          <div class="attribute-value">${esc(String(q.value))}</div>
        </div>`).join('')}
    </div>
    <div class="ad-section-title">Hardpoints</div>
    ${gunList    ? `<div class="ad-row"><span class="ad-label">Guns</span><span class="ad-value">${gunList}</span></div>`       : ''}
    ${turretList ? `<div class="ad-row"><span class="ad-label">Turrets</span><span class="ad-value">${turretList}</span></div>` : ''}
    ${(!gunList && !turretList) ? `<div class="ld-empty">None recorded.</div>` : ''}
    <div class="ad-section-title">Outfits</div>
    ${outfitChips}
    ${attrKeys.length ? `
      <div class="ad-section-title">Attributes</div>
      <div class="attribute-grid">${attrKeys.map(k => `
        <div class="attribute">
          <div class="attribute-name">${esc(k)}</div>
          <div class="attribute-value">${esc(String(a[k]))}</div>
        </div>`).join('')}</div>
    ` : ''}
    ${(leakRows || explodeStr || finalExplodeStr) ? `
      <div class="ad-section-title">Effects</div>
      ${leakRows || ''}
      ${explodeStr      ? `<div class="ad-row"><span class="ad-label">Explode</span><span class="ad-value">${explodeStr}</span></div>`            : ''}
      ${finalExplodeStr ? `<div class="ad-row"><span class="ad-label">Final explode</span><span class="ad-value">${finalExplodeStr}</span></div>` : ''}
    ` : ''}
  `;

  el('shipModal').classList.add('active');
}

el('modalCloseBtn').addEventListener('click', () => el('shipModal').classList.remove('active'));
el('shipModal').addEventListener('click', e => {
  if (e.target === el('shipModal')) el('shipModal').classList.remove('active');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') el('shipModal').classList.remove('active');
});

// ── fleet search / sort ──

el('searchInput').addEventListener('input', e => { activeFilter = e.target.value; renderFleetGrid(); });
el('sortSelect').addEventListener('change', e => { activeSort   = e.target.value; renderFleetGrid(); });

// ── sending ships to the builder ──

// outfits map or list → list
function _smNormaliseOutfitsArray(outfits) {
  if (!outfits) return [];
  if (Array.isArray(outfits)) {
    return outfits.map(o => ({
      name:     (o.name || '').replace(/^"([^"]*)"$/, '$1'),
      count:    parseInt(o.count) || 1,
      pluginId: o.pluginId || null,
    }));
  }
  if (typeof outfits === 'object') {
    return Object.entries(outfits).map(([name, val]) => ({
      name:     name.replace(/^"([^"]*)"$/, '$1'),
      count:    typeof val === 'object' ? (parseInt(val.count) || 1) : (Number(val) || 1),
      pluginId: typeof val === 'object' ? (val.pluginId || null)     : null,
    }));
  }
  return [];
}

// one save ship → a builder design
function smConvertShipToBuilderFormat(ship) {
  const outfits = (ship.outfits || []).map(o => ({
    name:     (o.name || '').replace(/^"([^"]*)"$/, '$1'),
    count:    parseInt(o.count) || 1,
    pluginId: o.pluginId || null,
  }));

  const leaks = (ship.leaks || []).map(l => ({
    name:         String(l.name || l.effect || ''),
    openChance:   parseInt(l.openChance)   || 0,
    spreadChance: parseInt(l.spreadChance) || 0,
  }));

  const guns    = (ship.guns    || []).map(g => ({ coords: g.coords || '0 0', over: g.over || '' }));
  const turrets = (ship.turrets || []).map(g => ({ coords: g.coords || '0 0', over: g.over || '' }));
  const engines = (ship.engines || []).map(e => ({
    coords: e.coords || '0 0',
    zoom:   e.zoom  != null ? String(e.zoom)  : '',
    angle:  e.angle != null ? String(e.angle) : '',
  }));
  const fighters     = (ship.fighters     || []).map(f => ({ coords: f.coords || '0 0', launchEffect: f.launchEffect || '' }));
  const drones       = (ship.drones       || []).map(d => ({ coords: d.coords || '0 0', launchEffect: d.launchEffect || '' }));
  const explode      = (ship.explode      || []).map(e => ({ name: e.name || '', count: parseInt(e.count) || 1 }));
  const finalExplode = (ship.finalExplode || []).map(e => ({ name: e.name || '', count: parseInt(e.count) || 1 }));

  // mass/drag: parser stores at top-level; shipBuilder keeps them separate from attributes{}
  const attrs = { ...(ship.attributes || {}) };
  const mass  = ship.mass != null && ship.mass !== '' ? String(ship.mass)
              : attrs.mass != null ? String(attrs.mass) : '';
  const drag  = ship.drag != null && ship.drag !== '' ? String(ship.drag)
              : attrs.drag != null ? String(attrs.drag) : '';
  delete attrs.mass;
  delete attrs.drag;

  const weapon = ship.weapon && typeof ship.weapon === 'object'
    ? {
        'blast radius':  Number(ship.weapon['blast radius']  ?? 0) || 0,
        'shield damage': Number(ship.weapon['shield damage'] ?? 0) || 0,
        'hull damage':   Number(ship.weapon['hull damage']   ?? 0) || 0,
        'hit force':     Number(ship.weapon['hit force']     ?? 0) || 0,
      }
    : { 'blast radius': 0, 'shield damage': 0, 'hull damage': 0, 'hit force': 0 };

  return {
    id:          Date.now() + Math.random(),
    name:        ship._modelName  || ship.name       || '',
    customName:  ship._customName || ship.customName || '',
    variant:     ship.variant     || '',
    plural:      ship.plural      || '',
    sprite:      ship.sprite      || '',
    thumbnail:   ship.thumbnail   || '',
    description: ship.description || '',
    mass,
    drag,
    attributes:      ship.displayName ? { ...attrs, 'display name': ship.displayName } : attrs,
    weapon,
    outfits,
    guns,
    turrets,
    drones,
    fighters,
    engines,
    reverseEngines:  (ship.reverseEngines  || []),
    steeringEngines: (ship.steeringEngines || []),
    leaks,
    explode,
    finalExplode,
    extraLines:      [...(ship.extraLines || [])],
    _sourceShip:     ship._modelName    || null,
    _sourcePlugin:   ship._sourcePlugin || null,
    // Save-file runtime metadata
    _uuid:      ship._uuid      || '',
    _swizzle:   ship._swizzle   ?? null,
    _crew:      ship._crew      ?? null,
    _fuel:      ship._fuel      ?? null,
    _shields:   ship._shields   ?? null,
    _hull:      ship._hull      ?? null,
    _position:  ship._position  ?? null,
    _system:    ship._system    || '',
    _planet:    ship._planet    || '',
    _parked:    ship._parked    || false,
    _formation: ship._formation || '',
    // ← tag so shipBuilder can show a "From save" badge
    _fromSave:  true,
  };
}

// ships → the builder's stored format
function _smSerialiseForBuilder(shipArray) {
  return shipArray.map(ship => ({
    ...ship,
    outfits: Object.fromEntries(
      (ship.outfits || []).map(o => [
        o.name.replace(/^"([^"]*)"$/, '$1'),
        { count: o.count ?? 1, pluginId: o.pluginId ?? null },
      ])
    ),
  }));
}

// save the open save's ships for the builder (asks first)
function smWriteActiveSaveShips(save) {
  const existing = smGetActiveSaveShips();

  if (existing && existing.length) {
    const replace = window.confirm(
      `Your Ship Builder already has ${existing.length} ship${existing.length !== 1 ? 's' : ''} loaded from a previous save.\n\nReplace them with the ${save.ships.length} ships from "${save.pilot.name || 'this save'}"?\n\nOK = replace  |  Cancel = keep existing`
    );
    if (!replace) return false;
  }

  const converted = save.ships.map(smConvertShipToBuilderFormat);
  smSetActiveSaveShips(_smSerialiseForBuilder(converted));
  return true;
}

// also add them to a builder fleet
function smImportFleetToBuilder(save, mode = 'append') {
  if (!save?.ships?.length) return { added: 0, total: 0 };

  // Multiple fleets: each imported save becomes its own fleet, named after
  // the pilot. 'replace' refreshes that fleet instead of adding a second one.
  if (window.FleetStore) {
    const converted = _smSerialiseForBuilder(save.ships.map(smConvertShipToBuilderFormat));
    const name = `${save.pilot?.name || 'Imported save'} (save)`;
    const existing = window.FleetStore.list().find(f => f.name === name);
    let fleetId;
    if (existing && mode === 'replace') {
      window.FleetStore.setShips(existing.id, converted);
      fleetId = existing.id;
    } else if (existing) {
      window.FleetStore.addShips(existing.id, converted);
      fleetId = existing.id;
    } else {
      fleetId = window.FleetStore.create(name, converted).id;
    }
    window.FleetStore.setActive(fleetId);
    return { added: converted.length, total: window.FleetStore.get(fleetId).ships.length, fleetName: window.FleetStore.get(fleetId).name };
  }

  const SB_KEY = 'es_ship_builder_v4';
  let existing = [];
  try {
    const raw = localStorage.getItem(SB_KEY);
    if (raw) {
      existing = JSON.parse(raw).map(s => ({
        ...s,
        outfits: _smNormaliseOutfitsArray(s.outfits),
      }));
    }
  } catch (e) {
    console.warn('[saveManager] Could not read existing builder fleet:', e);
  }

  if (mode === 'replace') existing = [];

  const converted = save.ships.map(smConvertShipToBuilderFormat);
  const merged    = [...existing, ...converted];

  try {
    localStorage.setItem(SB_KEY, JSON.stringify(_smSerialiseForBuilder(merged)));
  } catch (e) {
    console.warn('[saveManager] Could not write builder fleet:', e);
    return { added: 0, total: 0 };
  }

  // Hot-reload shipBuilder if it's live on the same page
  if (typeof sbLoad === 'function' && typeof renderFleet === 'function') {
    sbLoad();
    renderFleet();
    if (typeof renderExportChecklist === 'function') renderExportChecklist();
  }

  return { added: converted.length, total: merged.length };
}

// ── buttons ──

el('exportJsonBtn').addEventListener('click', () => {
  if (!parsedSave) return;
  const blob = new Blob([JSON.stringify(parsedSave, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), {
    href:     url,
    download: (parsedSave.pilot.name || 'fleet').replace(/\s+/g, '_') + '_parsed.json',
  }).click();
  URL.revokeObjectURL(url);
  toast('Exported parsed JSON.', 'success');
});

el('importFleetBtn').addEventListener('click', () => {
  if (!parsedSave) return;

  const shipCount = parsedSave.ships.length;
  const pilotName = parsedSave.pilot.name || 'this save';

  // Step 1 — write to the dedicated active-save-ships area
  // (asks before replacing if it's already populated)
  const written = smWriteActiveSaveShips(parsedSave);
  if (!written) return;

  // Hot-reload the save-ships section in shipBuilder if it's live
  if (typeof sbLoadSaveShips === 'function') sbLoadSaveShips();

  // Step 2 — optionally also push into the main builder fleet
  const fleetName = `${pilotName} (save)`;
  const alsoAddToFleet = window.confirm(window.FleetStore
    ? `${shipCount} ship${shipCount !== 1 ? 's' : ''} from "${pilotName}" are now in the Ship Builder's save-ships area.\n\nAlso copy them into a builder fleet called "${fleetName}"?\n\nOK = yes  |  Cancel = save-ships area only`
    : `${shipCount} ship${shipCount !== 1 ? 's' : ''} from "${pilotName}" are now in the Ship Builder's save-ships area.\n\nAlso copy them into your main builder fleet?\n\nOK = yes, add to main fleet  |  Cancel = save-ships area only`
  );

  if (alsoAddToFleet) {
    const fleetExists = window.FleetStore && window.FleetStore.list().some(f => f.name === fleetName);
    const doReplace = (!window.FleetStore || fleetExists) && window.confirm(window.FleetStore
      ? `A fleet called "${fleetName}" already exists. Replace its ships with this save's ships?\n\nOK = replace  |  Cancel = add to it`
      : `Add to your existing main fleet, or replace it?\n\nOK = replace  |  Cancel = append`
    );
    const { added, total } = smImportFleetToBuilder(parsedSave, doReplace ? 'replace' : 'append');
    toast(
      added > 0
        ? `${added} ship${added !== 1 ? 's' : ''} added to the fleet "${window.FleetStore ? fleetName : 'main fleet'}" (${total} total).`
        : 'Main fleet import failed.',
      added > 0 ? 'success' : 'danger'
    );
  } else {
    toast(
      `${shipCount} ship${shipCount !== 1 ? 's' : ''} loaded into Ship Builder — open the Ship Builder to edit them.`,
      'success'
    );
  }
});

el('removeSaveBtn').addEventListener('click', () => {
  if (!currentSaveId) return;
  confirmDeleteSave(currentSaveId);
});

// ── tabs ──

document.querySelectorAll('#resultTabs .tab').forEach(tabEl => {
  tabEl.addEventListener('click', () => {
    document.querySelectorAll('#resultTabs .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    tabEl.classList.add('active');
    el('tab-' + tabEl.dataset.tab).classList.remove('hidden');
  });
});

// ── start ──

document.addEventListener('saveReaderDataReady', smBootstrap);

// A ship model as players know it: its display name, with the internal model name dimmed beside it.
let _smModelIdx = null, _smModelKey = '';
// the game ship a save ship is
function smModelShip(model) {
  const key = Object.keys(window.allData || {}).map(k => k + ':' + ((window.allData[k].ships || []).length)).join('|');
  if (!_smModelIdx || key !== _smModelKey) {
    _smModelIdx = new Map(); _smModelKey = key;
    for (const p of Object.values(window.allData || {}))
      for (const s of [...(p.ships || []), ...(p.variants || [])]) if (s && s.name && !_smModelIdx.has(s.name)) _smModelIdx.set(s.name, s);
  }
  return _smModelIdx.get(model) || null;
}
// its name
function smModelLabel(model) { const s = smModelShip(model); return s && window.ShipNames ? window.ShipNames.label(s) : (model || ''); }
// its name as HTML
function smModelHtml(model) { const s = smModelShip(model); return s && window.ShipNames ? window.ShipNames.html(s) : esc(model || ''); }

// outfit display name with the internal name dimmed
function smOutfitHtml(name) { return window.OutfitNames ? window.OutfitNames.html(name) : esc(name); }
