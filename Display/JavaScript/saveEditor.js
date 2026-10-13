'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  saveEditor.js — "Edit save" tab on UserManager.html
//
//  Edits the save's ORIGINAL text (kept by saveVault.js) through the
//  lossless esSaveFile.js reader, so everything the editor doesn't touch is
//  written back exactly as the game wrote it. Every change is kept as the
//  save's edited version; "Download edited save" gives a .txt the game can
//  load, and "Revert to original" throws the edits away.
//
//  Also adds to the saves library: which saves are kept in the account,
//  saves from the account that aren't on this device yet, and an upload
//  prompt for saves that are only in this browser.
//
//  Load after saveManager.js, esSaveFile.js and saveVault.js.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  if (!window.EsSaveFile || !window.SaveVault) { console.warn('[SaveEditor] esSaveFile.js / saveVault.js missing'); return; }
  const V = window.SaveVault;
  const E = window.EsSaveFile;
  const $ = id => document.getElementById(id);
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const say = (m, t) => (typeof toast === 'function' ? toast(m, t) : console.log(m));
  const loggedIn = () => !!(window.EsAuth && window.EsAuth.getCurrentUser());

  // ── capture the original text of every new upload ────────────────────────
  let pendingText = null;
  const origHandleFile = window.handleFile;
  window.handleFile = async function (file) {
    try { pendingText = await file.text(); } catch (_) { pendingText = null; }
    try { return await origHandleFile.apply(this, arguments); } finally { pendingText = null; }
  };
  const origAddSave = window.smAddSave;
  window.smAddSave = function (parsed, name) {
    const id = origAddSave.apply(this, arguments);
    if (pendingText != null) {
      V.put(id, { original: pendingText, label: parsed?.pilot?.name || name, parsed })
        .then(() => { renderCloudLibrary(); if (id === currentSaveId) loadEditor(); })
        .catch(err => say('Could not store the original save text: ' + err.message, 'danger'));
    }
    return id;
  };
  const origRemoveSave = window.smRemoveSave;
  window.smRemoveSave = function (id) {
    origRemoveSave.apply(this, arguments);
    V.remove(id).catch(() => {});
    renderCloudLibrary();
  };
  const origRenderResults = window.renderResults;
  window.renderResults = function () {
    const r = origRenderResults.apply(this, arguments);
    ensureTab();
    if (activeTab() === 'edit') loadEditor();
    return r;
  };
  const origRenderLibrary = window.renderSavesLibrary;
  window.renderSavesLibrary = function () {
    const r = origRenderLibrary.apply(this, arguments);
    renderCloudLibrary();
    return r;
  };

  // ── cloud library (under the saves list) ─────────────────────────────────
  let cloudRenderSeq = 0;
  async function renderCloudLibrary() {
    const lib = $('savesLibrary');
    if (!lib) return;
    let box = $('sv-cloud');
    if (!box) { box = document.createElement('div'); box.id = 'sv-cloud'; lib.insertAdjacentElement('afterend', box); }
    const seq = ++cloudRenderSeq;
    const registry = typeof smGetRegistry === 'function' ? smGetRegistry() : [];

    // badges on the existing rows
    const local = {};
    for (const s of registry) local[s.id] = await V.get(s.id).catch(() => null);
    if (seq !== cloudRenderSeq) return;
    lib.querySelectorAll('.list-row[data-save-id]').forEach(row => {
      const rec = local[row.dataset.saveId];
      const label = row.querySelector('.list-row__label');
      if (!label || label.querySelector('.sv-badge')) return;
      const b = document.createElement('span');
      b.className = 'sv-badge';
      b.style.cssText = 'margin-left:8px;font-size:0.72rem;color:var(--c-text-dim);';
      b.textContent = !rec ? '· view only (re-upload to edit)' : rec.cloud ? '· ☁ in your account' : rec.edited ? '· edited' : '';
      if (rec && rec.edited && rec.cloud) b.textContent = '· edited · ☁ in your account';
      label.appendChild(b);
    });

    if (!loggedIn()) {
      box.innerHTML = `<p style="font-size:0.82rem;color:var(--c-text-dim);margin:0 0 16px;">Saves are kept in this browser only. Log in to keep them in your account and open them on any device.</p>`;
      return;
    }
    let rows = [], missing = [];
    try { [rows, missing] = await Promise.all([V.listAccountSaves(), V.localIdsMissingFromAccount()]); }
    catch (err) { box.innerHTML = `<p style="color:var(--c-danger-text);font-size:0.85rem;">Could not reach your account: ${h(err.message)}</p>`; return; }
    if (seq !== cloudRenderSeq) return;
    const here = new Set(registry.map(s => s.id));
    const remoteOnly = rows.filter(r => !here.has(r.id));
    const uploadable = missing.filter(id => here.has(id));

    box.innerHTML = `
      ${uploadable.length ? `
        <div class="list-row" style="margin-bottom:10px;border-style:dashed;">
          <span class="list-row__label">${uploadable.length} save${uploadable.length === 1 ? ' is' : 's are'} only in this browser.</span>
          <button class="btn btn-primary btn-sm" id="sv-upload-all">Upload to my account</button>
        </div>` : ''}
      ${remoteOnly.length ? `
        <div style="font-size:0.85rem;color:var(--c-text-mid);margin:6px 0;">In your account, not on this device:</div>
        ${remoteOnly.map(r => `
          <div class="list-row" style="margin-bottom:8px;">
            <span class="list-row__label">${h(r.label)}${r.has_edits ? ' <span style="font-size:0.72rem;color:var(--c-text-dim);">· edited</span>' : ''}</span>
            <span style="font-size:0.78rem;color:var(--c-text-dim);margin-right:8px;">${h(new Date(r.updated_at).toLocaleDateString())}</span>
            <button class="btn btn-secondary btn-sm sv-fetch" data-id="${h(r.id)}">Open here</button>
            <button class="btn-remove sv-cloud-del" data-id="${h(r.id)}" title="Delete from your account">✕</button>
          </div>`).join('')}` : ''}`;

    const up = $('sv-upload-all');
    if (up) up.onclick = async () => {
      up.disabled = true; up.textContent = 'Uploading…';
      let ok = 0;
      for (const id of uploadable) { try { await V.uploadToAccount(id); ok++; } catch (e) { console.warn(e); } }
      say(`Uploaded ${ok} save${ok === 1 ? '' : 's'} to your account.`, ok ? 'success' : 'danger');
      renderCloudLibrary();
    };
    box.querySelectorAll('.sv-fetch').forEach(b => b.onclick = async () => {
      const row = rows.find(r => r.id === b.dataset.id);
      b.disabled = true; b.textContent = 'Opening…';
      try {
        const { original, edited } = await V.downloadFromAccount(row);
        const parsed = parseESSaveFile(edited || original);
        // register under the SAME id so it stays linked to the account copy
        const registry = smGetRegistry();
        registry.push({ id: row.id, label: row.label, pilotName: row.pilot_name || '', importedAt: Date.parse(row.created_at) || Date.now() });
        smSetRegistry(registry);
        smSetSaveData(row.id, parsed);
        smSetCurrentId(row.id);
        parsedSave = parsed; currentSaveId = row.id;
        renderSavesLibrary(); renderResults();
        say(`Opened "${row.label}".`, 'success');
      } catch (err) { say(err.message, 'danger'); b.disabled = false; b.textContent = 'Open here'; }
    });
    box.querySelectorAll('.sv-cloud-del').forEach(b => b.onclick = async () => {
      const row = rows.find(r => r.id === b.dataset.id);
      if (!confirm(`Delete "${row.label}" from your account? This cannot be undone.`)) return;
      await V.remove(row.id);
      renderCloudLibrary();
      say('Deleted from your account.', 'success');
    });
  }

  // ── tab plumbing ─────────────────────────────────────────────────────────
  function ensureTab() {
    const tabs = $('resultTabs');
    if (!tabs || tabs.querySelector('[data-tab="edit"]')) return;
    const tab = document.createElement('div');
    tab.className = 'tab'; tab.dataset.tab = 'edit'; tab.textContent = '✏️ Edit save';
    tabs.appendChild(tab);
    const pane = document.createElement('div');
    pane.className = 'tab-content hidden'; pane.id = 'tab-edit';
    $('results').appendChild(pane);
    tab.addEventListener('click', () => {
      document.querySelectorAll('#resultTabs .tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      tab.classList.add('active'); pane.classList.remove('hidden');
      loadEditor();
    });
    // the original tabs don't know about this pane — hide it when they're clicked
    tabs.querySelectorAll('.tab:not([data-tab="edit"])').forEach(t => t.addEventListener('click', () => pane.classList.add('hidden')));
  }
  const activeTab = () => document.querySelector('#resultTabs .tab.active')?.dataset.tab;

  // ── editor state ─────────────────────────────────────────────────────────
  let doc = null;          // EsSaveFile.SaveFile
  let docId = null;
  let hasEdits = false;
  let saveTimer = null;
  let openShip = null;     // index whose outfit list is expanded
  let search = '';         // one search box filters every list in the editor
  const PAGE_SIZE = { ships: 40, reps: 60, missions: 25, events: 25, conds: 50 };
  let pages = { ships: 1, reps: 1, missions: 1, events: 1, conds: 1 };
  let undoStack = [];      // earlier versions of the save text (newest last)
  let lastText = null;     // the save text as of the last change
  let pendingMission = null;   // { row, summary } chosen in "Add a mission"
  let pendingEvent = null;     // { name, plugin_id, summary } chosen in "Schedule an event"
  const U = () => window.UiKit;
  const matches = text => !search || (U() ? U().match(search, text, { strict: true }) > 0 : String(text).toLowerCase().includes(search.toLowerCase()));

  async function loadEditor() {
    const pane = $('tab-edit');
    if (!pane || !currentSaveId) return;
    const rec = await V.get(currentSaveId).catch(() => null);
    if (!rec) { renderNoOriginal(pane); return; }
    if (docId !== currentSaveId) {
      search = ''; openShip = null; undoStack = []; pendingMission = null; pendingEvent = null;
      pages = { ships: 1, reps: 1, missions: 1, events: 1, conds: 1 };
    }
    docId = currentSaveId;
    doc = E.SaveFile.fromText(rec.edited || rec.original);
    lastText = doc.toString();
    hasEdits = !!rec.edited;
    render();
  }

  function renderNoOriginal(pane) {
    pane.innerHTML = `
      <section class="panel">
        <h2 class="section-title">Upload the save file again to edit it</h2>
        <p style="color:var(--c-text-mid);">This save was imported before editing was available, so its original text wasn't kept. Choose the same .txt file and it will be attached to this save.</p>
        <input type="file" id="sv-reattach" accept=".txt" class="text-input" style="max-width:420px;">
      </section>`;
    $('sv-reattach').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const text = await f.text();
      const parsed = parseESSaveFile(text);
      if ((parsed.pilot.name || '') !== (parsedSave.pilot.name || '') &&
          !confirm(`That file is for "${parsed.pilot.name}", but this save is "${parsedSave.pilot.name}". Attach it anyway?`)) return;
      await V.put(currentSaveId, { original: text, label: parsed.pilot.name, parsed });
      smSetSaveData(currentSaveId, parsed); parsedSave = parsed;
      origRenderResults(); ensureTab(); loadEditor(); renderCloudLibrary();
      say('Save file attached — you can edit it now.', 'success');
    };
  }

  // Apply a change: persist the edited text, refresh the other tabs.
  function changed(message, { undoable = false } = {}) {
    hasEdits = true;
    clearTimeout(saveTimer);
    const id = docId;
    const snapshot = doc.toString();
    if (lastText !== null && lastText !== snapshot) { undoStack.push(lastText); if (undoStack.length > 30) undoStack.shift(); }
    lastText = snapshot;
    saveTimer = setTimeout(async () => {
      try {
        const parsed = parseESSaveFile(snapshot);
        await V.setEdited(id, snapshot, parsed);
        if (id === currentSaveId) {
          smSetSaveData(id, parsed); parsedSave = parsed;
          origRenderResults(); ensureTab();
        }
        setStatus(loggedIn() ? 'Changes saved in your account' : 'Changes saved in this browser');
        renderCloudLibrary();
      } catch (err) { setStatus('Could not save changes: ' + err.message, true); }
    }, 400);
    setStatus('Saving…');
    render();
    if (message && undoable && U()) U().undoToast(message, undo);
    else if (message) say(message, 'success');
  }
  function undo() {
    if (!undoStack.length) return;
    const prev = undoStack.pop();
    doc = E.SaveFile.fromText(prev);
    lastText = null;               // don't push the undone version back on
    changed();
    lastText = doc.toString();
    say('Undone.', 'success');
  }
  function setStatus(text, bad) {
    const s = $('sv-status');
    if (s) { s.textContent = text; s.style.color = bad ? 'var(--c-danger-text)' : 'var(--c-text-dim)'; }
  }

  // ── render ───────────────────────────────────────────────────────────────
  const numIn = (attr, value, extra = '') =>
    `<input type="number" class="text-input" style="width:100px;" ${attr} value="${h(value)}" ${extra}>`;

  function render() {
    const pane = $('tab-edit');
    if (!pane || !doc) return;
    const p = doc.pilot, d = doc.date || { day: 1, month: 1, year: 3013 };
    const ships = doc.ships;
    // active ships (and the flagship) first, then parked; filtered by the search box
    const pg = (key, items) => {
      const r = U() ? U().paginate(items, pages[key], PAGE_SIZE[key]) : { slice: items, page: 1, pages: 1, from: 1, to: items.length, total: items.length };
      pages[key] = r.page; return r;
    };
    const pagerHtml = (key, r) => U() ? U().pager({ ...r, id: key }) : '';
    const matchingShips = ships.filter(s => matches(`${s.name} ${s.model} ${modelLabel(s.model)}`))
      .sort((a, b) => (b.isFlagship - a.isFlagship) || (a.parked - b.parked) || (a.index - b.index));
    const shipPage = pg('ships', matchingShips);
    const shownShips = shipPage.slice.slice();
    if (openShip !== null && !shownShips.some(s => s.index === openShip)) { const o = ships[openShip]; if (o) shownShips.push(o); }
    const cargo = doc.cargo;
    const conds = Object.entries(doc.conditions);
    const condPage = pg('conds', conds.filter(([k]) => matches(k)));
    const shown = condPage.slice;
    const reps = Object.entries(doc.reputations);
    const repPage = pg('reps', reps.filter(([g]) => matches(g)));
    const missionList = doc.missions.map((m, i) => ({ m, i })).filter(({ m }) => matches(`${m.displayName} ${m.id}`));
    const missionPage = pg('missions', missionList);
    const eventList = doc.events.filter(e => e.name).filter(e => matches(e.name))
      .sort((a, b) => (a.date ? a.date.year * 400 + a.date.month * 32 + a.date.day : 0) - (b.date ? b.date.year * 400 + b.date.month * 32 + b.date.day : 0));
    const eventPage = pg('events', eventList);
    const count = (shownN, all) => search ? `${shownN} of ${all}` : `${all}`;
    const fmtDate = d => d ? `${d.day}/${d.month}/${d.year}` : '—';

    pane.innerHTML = `
      <div id="sv-bar" style="position:sticky;top:0;z-index:5;background:var(--c-bg, #0f172a);padding:10px 0 12px;margin-bottom:8px;
           display:flex;flex-wrap:wrap;gap:8px;align-items:center;border-bottom:1px solid var(--c-border);">
        <input class="text-input" id="sv-search" type="search" placeholder="Search ships, missions, events, conditions…  ( / )"
               value="${h(search)}" style="max-width:360px;flex:1 1 220px;" aria-label="Search this save">
        <button class="btn btn-secondary btn-sm" data-act="undo"${undoStack.length ? '' : ' disabled'} title="Undo the last change (Ctrl+Z)">↶ Undo${undoStack.length ? ` (${undoStack.length})` : ''}</button>
        <nav class="sv-jump" aria-label="Jump to section">
          ${[['pilot', 'Pilot'], ['ships', `Ships ${count(matchingShips.length, ships.length)}`], ['cargo', 'Cargo'], ['licenses', 'Licenses'],
             ['reputation', `Reputation ${count(repPage.total, reps.length)}`], ['missions', `Missions ${count(missionList.length, doc.missions.length)}`],
             ['events', `Events ${count(eventList.length, doc.events.filter(e => e.name).length)}`], ['conditions', `Conditions ${count(condPage.total, conds.length)}`]]
            .map(([id, label]) => `<a href="#sv-sec-${id}" class="ld-pill" style="text-decoration:none;">${h(label)}</a>`).join('')}
        </nav>
      </div>
      <section class="panel" style="margin-bottom:20px;display:flex;flex-wrap:wrap;align-items:center;gap:12px;">
        <button class="btn btn-primary" data-act="download">⬇ Download edited save</button>
        ${window.SaveSync && window.SaveSync.supported ? '<button class="btn btn-secondary" data-act="writegame" title="Write the edited save straight into the linked file in your Endless Sky saves folder">💾 Save into game file</button>' : ''}
        <button class="btn btn-secondary" data-act="revert"${hasEdits ? '' : ' disabled'}>Revert to original</button>
        <span id="sv-status" style="font-size:0.85rem;color:var(--c-text-dim);">${hasEdits ? 'This save has edits.' : 'No edits yet — changes save automatically.'}</span>
        <p style="flex-basis:100%;margin:0;font-size:0.8rem;color:var(--c-text-dim);">Close Endless Sky before replacing a save file, and keep a copy of the original.</p>
      </section>
      ${(() => { const junk = doc.trailingJunk(); return junk.length ? `
      <section class="panel" style="margin-bottom:20px;border-color:var(--c-warn-text, #f59e0b);">
        <h2 class="section-title" style="margin-top:0;">⚠ This save file is damaged</h2>
        <p style="color:var(--c-text-mid);margin:0 0 10px;">After the end of the save there are ${junk.length} leftover blocks from an older copy of the file
          (it was overwritten without the old ending being cleared). The game loads them on top of your real save, so older story progress,
          conditions and prices can come back. Repairing removes everything after the save's plugin list.</p>
        <button class="btn btn-primary btn-sm" data-act="repair">🩹 Remove the leftover data</button>
      </section>` : ''; })()}

      <section class="panel" style="margin-bottom:20px;" id="sv-sec-pilot">
        <h2 class="section-title">Pilot</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(min(180px, 100%), 1fr));gap:14px;">
          <label>First name<input class="text-input" data-f="first" value="${h(p.first)}"></label>
          <label>Last name<input class="text-input" data-f="last" value="${h(p.last)}"></label>
          <label>Credits<input class="text-input" data-f="credits" inputmode="numeric" value="${h(String(doc.credits))}"></label>
          <label>Day${numIn('data-f="day" min="1" max="31"', d.day)}</label>
          <label>Month${numIn('data-f="month" min="1" max="12"', d.month)}</label>
          <label>Year${numIn('data-f="year" min="1"', d.year)}</label>
          <label>System<input class="text-input" data-f="system" value="${h(doc.system || '')}"></label>
          <label>Planet<input class="text-input" data-f="planet" value="${h(doc.planet || '')}"></label>
        </div>
      </section>

      <section class="panel" style="margin-bottom:20px;" id="sv-sec-ships">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
          <h2 class="section-title" style="margin:0;">Ships (${count(matchingShips.length, ships.length)})</h2>
          ${window.SaveShipPicker ? '<button class="btn btn-primary btn-sm" data-act="addship">＋ Add a ship</button>' : ''}
        </div>
        ${!matchingShips.length && search ? `<p style="color:var(--c-text-dim);">No ships match “${h(search)}”.</p>` : ''}
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.88rem;">
          <thead><tr style="text-align:left;color:var(--c-text-dim);">
            <th>Flagship</th><th>Name</th><th>Model</th><th>Crew</th><th>Fuel</th><th>Shields</th><th>Hull</th><th>Parked</th><th></th>
          </tr></thead>
          <tbody>
          ${shownShips.map(s => `
            <tr data-ship="${s.index}" style="border-top:1px solid var(--c-border);">
              <td><input type="radio" name="sv-flag" data-s="flagship"${s.isFlagship ? ' checked' : ''} aria-label="Make flagship"></td>
              <td><input class="text-input" data-s="name" value="${h(s.name)}" style="min-width:140px;"></td>
              <td>${modelHtml(s.model)}</td>
              <td>${numIn('data-s="crew" min="0" step="1"', s.crew)}</td>
              <td>${numIn('data-s="fuel" min="0"', s.fuel)}</td>
              <td>${numIn('data-s="shields" min="0"', s.shields)}</td>
              <td>${numIn('data-s="hull" min="0"', s.hull)}</td>
              <td><input type="checkbox" data-s="parked"${s.parked ? ' checked' : ''} aria-label="Parked"></td>
              <td style="white-space:nowrap;">
                <button class="btn btn-secondary btn-sm" data-act="outfits">${openShip === s.index ? 'Hide outfits' : 'Outfits'}</button>
                ${window.SaveShipPicker ? '<button class="btn btn-secondary btn-sm" data-act="refit" title="Replace this ship\'s design with one of yours, a shared one or a game ship">Refit</button>' : ''}
                ${typeof smConvertShipToBuilderFormat === 'function' && typeof parseESSaveFile === 'function' ? '<button class="btn btn-secondary btn-sm" data-act="tobuilder" title="Open this ship in the Ship Builder; ➜ Put in a save there sends it back">🛠 Builder</button>' : ''}
                <button class="btn btn-secondary btn-sm" data-act="dup">Duplicate</button>
                <button class="btn btn-danger btn-sm" data-act="rmship">Remove</button>
              </td>
            </tr>
            ${openShip === s.index ? `<tr data-ship="${s.index}"><td colspan="9">${outfitEditor(s)}</td></tr>` : ''}`).join('')}
          </tbody>
        </table></div>
        ${pagerHtml('ships', shipPage)}
      </section>

      <section class="panel" style="margin-bottom:20px;" id="sv-sec-cargo">
        <h2 class="section-title">Cargo</h2>
        ${itemTable('cargo-c', 'Commodity', cargo.commodities, 'tons')}
        ${itemTable('cargo-o', 'Outfit', cargo.outfits, 'count')}
      </section>

      <section class="panel" style="margin-bottom:20px;" id="sv-sec-licenses">
        <h2 class="section-title">Licenses</h2>
        <div class="ld-pills" style="margin-bottom:10px;">
          ${doc.licenses.map(l => `<span class="ld-pill">${h(l)} <button class="btn-remove" data-act="rmlic" data-name="${h(l)}" aria-label="Remove ${h(l)}">✕</button></span>`).join('') || '<span style="color:var(--c-text-dim);">No licenses.</span>'}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;"><span style="flex:1 1 200px;max-width:300px;"><input class="text-input" id="sv-new-lic" placeholder="Start typing a licence, e.g. Republic…" autocomplete="off"></span>
          <button class="btn btn-secondary btn-sm" data-act="addlic">Add license</button></div>
      </section>

      <section class="panel" style="margin-bottom:20px;" id="sv-sec-reputation">
        <h2 class="section-title">Reputation (${count(repPage.total, reps.length)})</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(min(230px, 100%), 1fr));gap:8px;">
          ${repPage.slice.map(([g, v]) => `
            <label style="display:flex;align-items:center;justify-content:space-between;gap:8px;">${h(g)}
              <input type="number" class="text-input" data-rep="${h(g)}" value="${h(v)}" style="width:110px;"></label>`).join('')}
        </div>
        ${pagerHtml('reps', repPage)}
      </section>

      <section class="panel" style="margin-bottom:20px;" id="sv-sec-missions">
        <h2 class="section-title">Missions (${count(missionList.length, doc.missions.length)})</h2>
        ${missionPage.slice.length ? missionPage.slice.map(({ m, i }) => `
          <div class="list-row" style="margin-bottom:6px;">
            <span class="list-row__label">${U() ? `<span class="uk-hl">${U().highlight(m.displayName, search)}</span>` : h(m.displayName)}
              <span style="font-size:0.75rem;color:var(--c-text-dim);">${m.kind === 'mission' ? 'accepted' : m.kind}${m.destination ? ' · to ' + h(m.destination) : ''}</span></span>
            <button class="btn btn-danger btn-sm" data-act="rmmission" data-i="${i}">Remove</button>
          </div>`).join('') : `<p style="color:var(--c-text-dim);">${search ? `No missions match “${h(search)}”.` : 'No missions in this save.'}</p>`}
        ${pagerHtml('missions', missionPage)}
        <label style="display:flex;gap:8px;align-items:center;margin-top:8px;font-size:0.85rem;">
          <input type="checkbox" id="sv-mission-conds"> Also clear the removed mission's offered/active/done/failed/declined history</label>

        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--c-border);">
          <div style="font-weight:600;margin-bottom:6px;">Complete a mission</div>
          <p style="font-size:0.8rem;color:var(--c-text-dim);margin:0 0 8px;">Start typing a mission's name — every mission from this save's plugins is listed.</p>
          <input class="text-input" id="sv-mission-pick" placeholder="Mission name, e.g. Deep Archaeology 1" value="${h(pendingMission ? pendingMission.label : '')}">
          ${pendingMission ? missionPanel() : ''}
        </div>
      </section>

      <section class="panel" style="margin-bottom:20px;" id="sv-sec-events">
        <h2 class="section-title">Scheduled events (${count(eventList.length, doc.events.filter(e => e.name).length)})</h2>
        <p style="font-size:0.8rem;color:var(--c-text-dim);margin-top:0;">Story events waiting for their date. The game applies each one when that day comes.</p>
        ${eventPage.slice.length ? eventPage.slice.map(e => `
          <div class="list-row" style="margin-bottom:4px;">
            <span class="list-row__label">${U() ? `<span class="uk-hl">${U().highlight(e.name, search)}</span>` : h(e.name)}
              <span style="font-size:0.75rem;color:var(--c-text-dim);">${fmtDate(e.date)}</span></span>
            <button class="btn-remove" data-act="rmevent" data-name="${h(e.name)}" aria-label="Remove ${h(e.name)}">✕</button>
          </div>`).join('') : `<p style="color:var(--c-text-dim);">${search ? `No events match “${h(search)}”.` : 'No events are scheduled.'}</p>`}
        ${pagerHtml('events', eventPage)}
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--c-border);">
          <div style="font-weight:600;margin-bottom:6px;">Schedule an event</div>
          <input class="text-input" id="sv-event-pick" placeholder="Event name, e.g. war begins" value="${h(pendingEvent ? pendingEvent.name : '')}">
          ${pendingEvent ? eventPanel() : ''}
        </div>
      </section>

      <section class="panel" id="sv-sec-conditions">
        <h2 class="section-title">Conditions (${count(condPage.total, conds.length)})</h2>
        <p style="font-size:0.8rem;color:var(--c-text-dim);margin-top:0;">Story progress flags. Setting one to 0 removes it. Changing these can break missions — only edit ones you understand.</p>
        <div>${shown.map(([k, v]) => `
          <div class="list-row" style="margin-bottom:4px;">
            <span class="list-row__label uk-hl" style="word-break:break-word;">${U() ? U().highlight(k, search) : h(k)}</span>
            <input type="number" class="text-input" data-cond="${h(k)}" value="${h(v)}" style="width:110px;">
            <button class="btn-remove" data-act="rmcond" data-name="${h(k)}" aria-label="Remove ${h(k)}">✕</button>
          </div>`).join('')}
          ${!shown.length && search ? `<p style="color:var(--c-text-dim);">No conditions match “${h(search)}”.</p>` : ''}
        </div>
        ${pagerHtml('conds', condPage)}
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
          <input class="text-input" id="sv-new-cond" placeholder="New condition name" style="max-width:280px;">
          <input type="number" class="text-input" id="sv-new-cond-val" value="1" style="width:90px;">
          <button class="btn btn-secondary btn-sm" data-act="addcond">Add condition</button>
        </div>
      </section>`;
    bind(pane);
  }

  // A model's display name (what the game shows), with the internal name dimmed beside it.
  let modelIdx = null, modelKey = '';
  function modelShip(model) {
    const key = Object.keys(window.allData || {}).map(k => k + ':' + ((window.allData[k].ships || []).length)).join('|');
    if (!modelIdx || key !== modelKey) {
      modelIdx = new Map(); modelKey = key;
      for (const p of Object.values(window.allData || {}))
        for (const s of [...(p.ships || []), ...(p.variants || [])]) if (s && s.name && !modelIdx.has(s.name)) modelIdx.set(s.name, s);
    }
    return modelIdx.get(model) || null;
  }
  function modelLabel(model) { const s = modelShip(model); return s && window.ShipNames ? window.ShipNames.label(s) : ''; }
  function modelHtml(model) {
    const s = modelShip(model);
    return s && window.ShipNames ? window.ShipNames.html(s) : h(model);
  }

  // ── mission / event catalogues (from Supabase, for this save's plugins) ──
  const catalog = { missions: null, events: null, pluginIds: null };
  // Mission/event pickers list what your selected plugins (☰ Select Plugins) contain.
  async function savePluginIds() {
    if (catalog.pluginIds) return catalog.pluginIds;
    const DL = window.DataLoader;
    const ids = DL && typeof DL.getActivePluginIds === 'function' ? [...DL.getActivePluginIds()] : null;
    return (catalog.pluginIds = ids && ids.length ? ids : null);
  }
  async function fetchNames(table, cols) {
    const sb = window.supabaseClient;
    if (!sb) return [];
    const ids = await savePluginIds();
    const rows = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from(table).select(cols).order('name').range(from, from + 999);
      if (ids && ids.length) q = q.in('plugin_id', ids);
      const { data, error } = await q;
      if (error) break;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return rows;
  }
  const pluginLabel = id => String(id || '').split('/').pop();
  async function missionCatalog() {
    if (!catalog.missions) catalog.missions = fetchNames('missions', 'id, name, display_name, plugin_id');
    return catalog.missions;
  }
  async function eventCatalog() {
    if (!catalog.events) catalog.events = fetchNames('game_events', 'name, plugin_id');
    return catalog.events;
  }
  function searchList(rows, q, labelOf, subOf, valueOf) {
    const scored = [];
    for (const r of rows) {
      const sc = Math.max(U().match(q, labelOf(r)), U().match(q, r.name) * 0.9);
      if (sc > 0) scored.push([sc, r]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, 50).map(([, r]) => ({ value: valueOf(r), label: labelOf(r), sub: subOf(r), data: r }));
  }

  function missionState(name) {
    const g = k => Number(doc.getCondition(`${name}: ${k}`)) || 0;
    if (doc.missions.some(m => m.id === name)) return 'in this save (accepted or on offer)';
    if (g('done')) return 'already completed';
    if (g('failed')) return 'failed';
    if (g('declined')) return 'declined';
    if (g('offered')) return 'offered before';
    return 'never offered';
  }
  function missionPanel() {
    const m = pendingMission, sum = m.summary;
    const lines = window.MissionActions ? window.MissionActions.describe(sum) : [];
    const radio = (v, label, hint) => `<label style="display:flex;gap:8px;align-items:flex-start;margin:4px 0;">
      <input type="radio" name="sv-mission-mode" value="${v}"${m.mode === v ? ' checked' : ''}>
      <span>${label}${hint ? `<span style="display:block;font-size:0.78rem;color:var(--c-text-dim);">${hint}</span>` : ''}</span></label>`;
    return `<div style="margin-top:10px;padding:12px;border:1px solid var(--c-border);border-radius:8px;">
      <div><strong>${h(m.row.display_name || m.row.name)}</strong>
        <span style="font-size:0.78rem;color:var(--c-text-dim);">${h(pluginLabel(m.row.plugin_id))} · ${h(missionState(m.row.name))}</span></div>
      ${radio('rewards', 'Mark it completed and give me its rewards', 'Like finishing it in the game.')}
      ${radio('done', 'Mark it completed — no rewards', 'Story missions that depend on it can be offered.')}
      ${radio('reset', 'Make it available again', 'Forgets it was offered, completed, failed or declined, so the game can offer it again.')}
      ${m.mode === 'rewards' ? `<div style="font-size:0.85rem;margin:8px 0 0;">${lines.length
        ? `You'll get:<ul style="margin:4px 0 0;padding-left:18px;">${lines.map(l => `<li>${h(l)}</li>`).join('')}</ul>`
        : '<span style="color:var(--c-text-dim);">This mission has no rewards to give.</span>'}
        ${sum.skipped.length ? `<div style="font-size:0.78rem;color:var(--c-text-dim);margin-top:4px;">Not applied here: ${h([...new Set(sum.skipped)].join(', '))} (story text and other things only the game can do).</div>` : ''}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="btn btn-primary btn-sm" data-act="applymission">Apply</button>
        <button class="btn btn-secondary btn-sm" data-act="cancelmission">Cancel</button></div>
    </div>`;
  }
  function eventPanel() {
    const ev = pendingEvent, d = ev.date;
    return `<div style="margin-top:10px;padding:12px;border:1px solid var(--c-border);border-radius:8px;">
      <div><strong>${h(ev.name)}</strong> <span style="font-size:0.78rem;color:var(--c-text-dim);">${h(pluginLabel(ev.plugin_id))}</span></div>
      <div style="font-size:0.85rem;margin:6px 0;">${h(ev.summary || 'Loading what it changes…')}</div>
      <label style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:0.85rem;">Happens on
        <input type="number" class="text-input" id="sv-ev-day" value="${d.day}" min="1" max="31" style="width:70px;" aria-label="Day">
        <input type="number" class="text-input" id="sv-ev-month" value="${d.month}" min="1" max="12" style="width:70px;" aria-label="Month">
        <input type="number" class="text-input" id="sv-ev-year" value="${d.year}" style="width:90px;" aria-label="Year">
        <span style="color:var(--c-text-dim);">(default: tomorrow in your save)</span></label>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="btn btn-primary btn-sm" data-act="applyevent">Schedule it</button>
        <button class="btn btn-secondary btn-sm" data-act="cancelevent">Cancel</button></div>
    </div>`;
  }
  // "Changes 3 systems, 1 planet, 2 links" from an event's raw definition
  function summarizeEvent(raw) {
    const counts = {};
    try {
      for (const ev of E.parse(raw).root.children) for (const c of ev.children || []) {
        if (!c.tokens) continue;
        const k = c.tokens[0];
        if (k === 'date') continue;
        counts[k] = (counts[k] || 0) + 1;
      }
    } catch (_) {}
    const names = { system: ['system', 'systems'], planet: ['planet', 'planets'], link: ['new link', 'new links'], unlink: ['removed link', 'removed links'],
      fleet: ['fleet', 'fleets'], government: ['government', 'governments'], news: ['news item', 'news items'], shipyard: ['shipyard', 'shipyards'],
      outfitter: ['outfitter', 'outfitters'], conversation: ['conversation', 'conversations'], galaxy: ['galaxy', 'galaxies'] };
    const parts = Object.entries(counts).map(([k, c]) => `${c} ${(names[k] || [k, k + 's'])[c === 1 ? 0 : 1]}`);
    return parts.length ? `Changes ${parts.join(', ')}.` : 'This event has no map changes (it may only set story flags).';
  }
  function addGameShip(model, name) {
    const D = window.ShipDefinition;
    if (!D) return false;
    let found = null;
    for (const p of Object.values(window.allData || {})) {
      found = (p.ships || []).find(x => x.name === model) || (p.variants || []).find(x => x.name === model);
      if (found) break;
    }
    if (!found) return false;
    const { ships, outfits } = gameIndex();
    const attrs = (found.baseShip ? ships.get(found.baseShip)?.attributes : found.attributes) || {};
    doc.addShip(D.fromGameShip(found), { name, levels: D.maxLevels(attrs, D.outfitList(found.outfits), outfits) });
    return true;
  }
  function bindPickers() {
    if (!U()) return;
    const mi = $('sv-mission-pick');
    if (mi) U().combobox(mi, {
      placeholderEmpty: 'No missions match — check the spelling, or that its plugin is on the site',
      source: async q => searchList(await missionCatalog(), q, r => r.display_name || r.name,
        r => `${r.display_name && r.display_name !== r.name ? r.name + ' · ' : ''}${pluginLabel(r.plugin_id)} · ${missionState(r.name)}`, r => r.display_name || r.name),
      onPick: async it => {
        const { data, error } = await window.supabaseClient.from('missions').select('id, name, display_name, plugin_id, raw').eq('id', it.data.id).maybeSingle();
        if (error || !data) return say('Could not load that mission.', 'danger');
        pendingMission = { row: data, label: it.label, summary: window.MissionActions.summarize(data.raw), mode: 'rewards' };
        render();
      },
    });
    // name boxes: matches from the selected plugins, with the plugin shown
    if (window.NameSearch) {
      window.NameSearch.attach($('sv-add-outfit'), 'outfits');
      window.NameSearch.attach($('sv-add-cargo-o'), 'outfits');
      window.NameSearch.attach($('sv-add-cargo-c'), 'commodities');
      window.NameSearch.attach($('sv-new-lic'), 'licenses');
    }
    const ei = $('sv-event-pick');
    if (ei) U().combobox(ei, {
      placeholderEmpty: 'No events match',
      source: async q => searchList(await eventCatalog(), q, r => r.name, r => pluginLabel(r.plugin_id), r => r.name),
      onPick: async it => {
        const tomorrow = window.MissionActions.addDays(doc.date || { day: 1, month: 1, year: 3013 }, 1);
        pendingEvent = { name: it.data.name, plugin_id: it.data.plugin_id, date: tomorrow, summary: null };
        render();
        const { data } = await window.supabaseClient.from('game_events').select('raw').eq('plugin_id', it.data.plugin_id).eq('name', it.data.name).maybeSingle();
        if (pendingEvent && pendingEvent.name === it.data.name) { pendingEvent.summary = data ? summarizeEvent(data.raw) : 'Its definition could not be loaded.'; render(); }
      },
    });
  }

  function outfitEditor(s) {
    const entries = Object.entries(s.outfits);
    return `<div style="padding:10px 0 14px;">
      ${entries.map(([n, c]) => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <input type="number" class="text-input" data-outfit="${h(n)}" value="${c}" min="0" step="1" style="width:80px;">
          <span>${window.OutfitNames ? OutfitNames.html(n) : h(n)}</span></div>`).join('') || '<p style="color:var(--c-text-dim);">No outfits installed.</p>'}
      <div style="display:flex;gap:8px;margin-top:8px;">
        <span style="flex:1 1 220px;max-width:320px;"><input class="text-input" id="sv-add-outfit" placeholder="Start typing an outfit…" autocomplete="off"></span>
        <input type="number" class="text-input" id="sv-add-outfit-n" value="1" min="1" style="width:80px;">
        <button class="btn btn-secondary btn-sm" data-act="addoutfit">Install</button>
      </div>
      <p style="font-size:0.78rem;color:var(--c-text-dim);">Installed weapons are not mounted on hardpoints automatically — the game assigns free hardpoints when it loads the ship.</p>
    </div>`;
  }

  function itemTable(kind, label, items, unit, list) {
    return `<div style="margin-bottom:14px;">
      <div style="font-weight:600;margin-bottom:6px;">${label === 'Commodity' ? 'Commodities' : label + 's'}</div>
      ${Object.entries(items).map(([n, c]) => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <input type="number" class="text-input" data-item="${kind}" data-name="${h(n)}" value="${c}" min="0" step="1" style="width:90px;">
          <span>${kind === 'cargo-o' && window.OutfitNames ? OutfitNames.html(n) : h(n)}</span></div>`).join('') || `<p style="color:var(--c-text-dim);margin:0 0 6px;">None.</p>`}
      <div style="display:flex;gap:8px;">
        <span style="flex:1 1 200px;max-width:300px;"><input class="text-input" id="sv-add-${kind}" placeholder="Start typing a${label === 'Outfit' ? 'n outfit' : ' commodity'}…" autocomplete="off"></span>
        <input type="number" class="text-input" id="sv-add-${kind}-n" value="1" min="1" style="width:90px;" aria-label="${unit}">
        <button class="btn btn-secondary btn-sm" data-act="additem" data-kind="${kind}">Add</button>
      </div></div>`;
  }

  // ── events ───────────────────────────────────────────────────────────────
  const nonNeg = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };

  function bind(pane) {
    pane.onchange = e => {
      const t = e.target;
      try {
        if (t.name === 'sv-mission-mode' && pendingMission) { pendingMission.mode = t.value; return render(); }
        if (t.id === 'sv-search' || t.id === 'sv-mission-pick' || t.id === 'sv-event-pick' || /^sv-ev-/.test(t.id)) return;
        if (t.dataset.f) return pilotField(t);
        const row = t.closest('[data-ship]');
        if (t.dataset.s && row) return shipField(doc.ship(Number(row.dataset.ship)), t);
        if (t.dataset.outfit !== undefined && row) {
          const n = nonNeg(t.value); if (n === null) return render();
          doc.ship(Number(row.dataset.ship)).setOutfit(t.dataset.outfit, Math.trunc(n));
          return changed();
        }
        if (t.dataset.item) {
          const n = nonNeg(t.value); if (n === null) return render();
          if (t.dataset.item === 'cargo-c') doc.setCargoCommodity(t.dataset.name, n); else doc.setCargoOutfit(t.dataset.name, n);
          return changed();
        }
        if (t.dataset.rep !== undefined) { const n = Number(t.value); if (!Number.isFinite(n)) return render(); doc.setReputation(t.dataset.rep, n); return changed(); }
        if (t.dataset.cond !== undefined) { doc.setCondition(t.dataset.cond, Math.trunc(Number(t.value) || 0)); return changed(); }
      } catch (err) { say(err.message, 'danger'); render(); }
    };
    const sb = $('sv-search');
    let searchTimer = null;
    if (sb) sb.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        search = sb.value.trim();
        pages = { ships: 1, reps: 1, missions: 1, events: 1, conds: 1 };
        const pos = sb.selectionStart;
        render();
        const s2 = $('sv-search'); s2.focus(); s2.setSelectionRange(pos, pos);
      }, 150);
    };
    bindPickers();

    pane.onclick = e => {
      const pgBtn = e.target.closest('[data-page-of]');
      if (pgBtn) {
        pages[pgBtn.dataset.pageOf] = Number(pgBtn.dataset.page);
        render();
        const sec = { ships: 'ships', reps: 'reputation', missions: 'missions', events: 'events', conds: 'conditions' }[pgBtn.dataset.pageOf];
        const el = $('sv-sec-' + sec); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const row = b.closest('[data-ship]');
      const ship = row ? doc.ship(Number(row.dataset.ship)) : null;
      try {
        switch (b.dataset.act) {
          case 'download': return download();
          case 'repair': {
            if (!confirm('Remove everything after the end of the save (the leftover old data)? You can undo this with “Revert to original”.')) return;
            const n = doc.removeTrailingJunk();
            return changed(`Removed ${n} leftover blocks of old data.`);
          }
          case 'writegame': {
            const problems = doc.validate();
            if (problems.length && !confirm(`This save has problems the game may not like:\n\n• ${problems.join('\n• ')}\n\nWrite it anyway?`)) return;
            return window.SaveSync.writeToGameFile(docId, doc.toString());
          }
          case 'revert': return revert();
          case 'undo': return undo();
          case 'cancelmission': pendingMission = null; return render();
          case 'cancelevent': pendingEvent = null; return render();
          case 'applymission': {
            const m = pendingMission; if (!m) return;
            const lines = window.MissionActions.apply(doc, m.row.name, m.summary, { mode: m.mode, addShip: addGameShip });
            pendingMission = null;
            return changed(`${m.label}: ${lines.join(' · ')}`, { undoable: true });
          }
          case 'applyevent': {
            const ev = pendingEvent; if (!ev) return;
            const d = { day: Number($('sv-ev-day').value), month: Number($('sv-ev-month').value), year: Number($('sv-ev-year').value) };
            if (!(d.day >= 1 && d.day <= 31 && d.month >= 1 && d.month <= 12 && Number.isFinite(d.year))) return say('That date isn\'t valid.', 'danger');
            doc.scheduleEvent(ev.name, d);
            pendingEvent = null;
            return changed(`Scheduled “${ev.name}” for ${d.day}/${d.month}/${d.year}.`, { undoable: true });
          }
          case 'rmevent': {
            const e2 = doc.events.find(x => x.name === b.dataset.name); if (!e2) return;
            doc.removeEvent(e2.node);
            return changed(`Removed the event “${b.dataset.name}”.`, { undoable: true });
          }
          case 'outfits': openShip = openShip === ship.index ? null : ship.index; return render();
          case 'tobuilder': {
            // Hand this save's ships to the builder (its "💾 Current Save Fleet") and open this one.
            if (!ship.uuid) return say('This ship has no id in the save, so the builder can\'t match it back — save it in the game once first.', 'danger');
            const parsed = parseESSaveFile(doc.toString());
            smSetActiveSaveShips(_smSerialiseForBuilder(parsed.ships.map(smConvertShipToBuilderFormat)));
            try { localStorage.setItem('ES_SB_OPEN_SAVE_SHIP', ship.uuid); } catch (_) {}
            location.href = 'shipBuilder.html';
            return;
          }
          case 'dup': doc.duplicateShip(ship.index, `${ship.name || ship.model} (copy)`); return changed('Ship duplicated.');
          case 'addship':
            return window.SaveShipPicker.open({ mode: 'add', title: 'Add a ship to this save', onPick: c => applyPicked(c, null) });
          case 'refit':
            return window.SaveShipPicker.open({ mode: 'refit', title: `Refit “${ship.name || ship.model}” with…`, onPick: c => applyPicked(c, ship.index) });
          case 'rmship': {
            const nm = ship.name || ship.model;
            doc.removeShip(ship.index); openShip = null;
            return changed(`Removed “${nm}” (and its cargo).`, { undoable: true });
          }
          case 'addoutfit': {
            const name = $('sv-add-outfit').value.trim(); const n = Math.trunc(nonNeg($('sv-add-outfit-n').value) || 0);
            if (!name || !n) return;
            doc.ship(openShip).setOutfit(name, (doc.ship(openShip).outfits[name] || 0) + n);
            return changed(`Installed ${n} × ${name}.`);
          }
          case 'additem': {
            const kind = b.dataset.kind; const name = $(`sv-add-${kind}`).value.trim();
            const n = Math.trunc(nonNeg($(`sv-add-${kind}-n`).value) || 0);
            const what = kind === 'cargo-c' ? 'commodity' : 'outfit';
            if (!name) return say(`Type ${what === 'outfit' ? 'an outfit' : 'a commodity'} name first.`, 'danger');
            if (!n) return say('Enter how many to add (1 or more).', 'danger');
            const cur = doc.cargo[kind === 'cargo-c' ? 'commodities' : 'outfits'][name] || 0;
            if (kind === 'cargo-c') doc.setCargoCommodity(name, cur + n); else doc.setCargoOutfit(name, cur + n);
            changed(`Added ${n} × ${name}.`);
            // warn (but still allow) — names the game won't know, or more than the fleet can carry
            const notes = [];
            if (kind === 'cargo-o' && !gameIndex().outfits.has(name)) notes.push(`“${name}” isn't an outfit in your selected plugins — the game drops it unless its plugin is installed.`);
            if (kind === 'cargo-c' && window.NameSearch && !window.NameSearch.search('commodities', name).some(it => it.value.toLowerCase() === name.toLowerCase()))
              notes.push(`“${name}” isn't a commodity the game or your plugins trade.`);
            const hold = fleetHold();
            if (hold && hold.used > hold.capacity) notes.push(`That's ${hold.used.toLocaleString()} t of cargo, but the ships you're flying hold ${hold.capacity.toLocaleString()} t — the game won't let you carry the rest.`);
            if (notes.length) say(`Added ${n} × ${name} — but: ${notes.join(' ')}`, 'danger');
            return;
          }
          case 'rmlic': doc.removeLicense(b.dataset.name); return changed();
          case 'addlic': {
            const v = $('sv-new-lic').value.trim();
            if (!v) return say('Type a licence name first.', 'danger');
            if (doc.licenses.includes(v)) return say(`The pilot already has the ${v} licence.`, 'danger');
            doc.addLicense(v); return changed(`Added license ${v}.`);
          }
          case 'rmcond': doc.deleteCondition(b.dataset.name); return changed(`Removed “${b.dataset.name}”.`, { undoable: true });
          case 'addcond': {
            const k = $('sv-new-cond').value.trim(); if (!k) return;
            doc.setCondition(k, Math.trunc(Number($('sv-new-cond-val').value) || 0)); return changed(`Set ${k}.`);
          }
          case 'rmmission': {
            const m = doc.missions[Number(b.dataset.i)];
            if (!m) return;
            doc.removeMission(m.id, { kinds: [m.kind], conditions: $('sv-mission-conds').checked });
            return changed(`Removed the mission “${m.displayName}”.`, { undoable: true });
          }
        }
      } catch (err) { say(err.message, 'danger'); render(); }
    };
  }

  // Keyboard: "/" jumps to the search box, Ctrl/Cmd+Z undoes (when not typing).
  document.addEventListener('keydown', e => {
    const pane = $('tab-edit');
    if (!pane || pane.classList.contains('hidden') || !doc) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing) { e.preventDefault(); const sb = $('sv-search'); if (sb) { sb.focus(); sb.select(); } }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !typing && undoStack.length) { e.preventDefault(); undo(); }
  });

  // ── add / refit from the ship picker ─────────────────────────────────────
  // Cargo the ships you're flying (not parked) can hold, and what's in the hold now
  // (commodities by the ton, outfits by their mass).
  function fleetHold() {
    const { ships, outfits } = gameIndex();
    const num = v => Number(v) || 0;
    const attrs = o => (o && (o.attributes || o)) || {};
    let capacity = 0;
    for (const sh of doc.ships) {
      if (sh.parked) continue;
      let hull = ships.get(sh.model);
      if (!hull) for (const p of Object.values(window.allData || {})) { const v = (p.variants || []).find(x => x.name === sh.model); if (v) { hull = ships.get(v.baseShip) || v; break; } }
      if (!hull) return null;   // a ship we don't know — can't tell
      capacity += num(attrs(hull)['cargo space']);
      for (const [n, c] of Object.entries(sh.outfits || {})) capacity += num(attrs(outfits.get(n))['cargo space']) * num(c);
    }
    let used = 0;
    for (const v of Object.values(doc.cargo.commodities || {})) used += num(v);
    for (const [n, c] of Object.entries(doc.cargo.outfits || {})) used += num(attrs(outfits.get(n)).mass) * num(c);
    return { capacity: Math.max(0, Math.round(capacity)), used: Math.round(used) };
  }

  function gameIndex() {
    const ships = new Map(), outfits = new Map();
    for (const p of Object.values(window.allData || {})) {
      for (const s of p.ships || []) if (s && s.name && !ships.has(s.name)) ships.set(s.name, s);
      for (const o of p.outfits || []) if (o && o.name && !outfits.has(o.name)) outfits.set(o.name, o);
    }
    return { ships, outfits };
  }

  function applyPicked(choice, refitIndex) {
    const D = window.ShipDefinition;
    if (!D || !doc) return;
    const { ships, outfits } = gameIndex();
    let def, attrs, outs;
    if (choice.kind === 'game') {
      def = D.fromGameShip(choice.ship);
      attrs = (choice.ship.baseShip ? ships.get(choice.ship.baseShip)?.attributes : choice.ship.attributes) || {};
      outs = D.outfitList(choice.ship.outfits);
    } else {
      def = D.fromBuild(choice.build, new Set(ships.keys()));
      attrs = { ...(choice.build._sourceShip ? ships.get(choice.build._sourceShip)?.attributes : {}), ...(choice.build.attributes || {}) };
      outs = D.outfitList(choice.build.outfits);
    }
    const levels = D.maxLevels(attrs, outs, outfits);
    const unknown = outs.map(([n]) => n).filter(n => !outfits.has(n));
    const warn = unknown.length ? `\n\n${unknown.length} outfit${unknown.length === 1 ? ' isn’t' : 's aren’t'} in the plugins loaded here (${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? '…' : ''}) — the game will drop ${unknown.length === 1 ? 'it' : 'them'} unless that plugin is installed.` : '';

    try {
      if (refitIndex === null) {
        const name = prompt(`Name for the new ship (it starts at ${doc.planet || doc.system || 'your location'}, repaired and fuelled):${warn}`, choice.label);
        if (name === null) return;
        doc.addShip(def, { name: name.trim() || choice.label, levels });
        return changed(`Added “${name.trim() || choice.label}” to the save.`);
      }
      const target = doc.ship(refitIndex);
      if (!confirm(`Refit “${target.name || target.model}” as ${choice.label}?\n\nIts design and installed outfits are replaced (outfits it had aren’t kept anywhere). It keeps its name, location and history, and is repaired, refuelled and crewed.${warn}`)) return;
      doc.replaceShipDefinition(refitIndex, def, { levels });
      openShip = null;
      return changed(`Refitted “${target.name || target.model}”.`);
    } catch (err) { say(err.message, 'danger'); }
  }

  function pilotField(t) {
    const v = t.value.trim();
    switch (t.dataset.f) {
      case 'first': case 'last': {
        const p = doc.pilot;
        if (!v) { say('The pilot needs a first and last name.', 'danger'); return render(); }
        doc.setPilot(t.dataset.f === 'first' ? v : p.first, t.dataset.f === 'last' ? v : p.last);
        return changed();
      }
      case 'credits':
        if (!/^-?\d+$/.test(v)) { say('Credits must be a whole number.', 'danger'); return render(); }
        // the game stores credits as a 64-bit number
        if (BigInt(v) > 9223372036854775807n || BigInt(v) < -9223372036854775808n) { say('That\'s more credits than the game can hold (the most is 9,223,372,036,854,775,807).', 'danger'); return render(); }
        doc.setCredits(v); return changed();
      case 'day': case 'month': case 'year': {
        const d = { ...(doc.date || { day: 1, month: 1, year: 3013 }), [t.dataset.f]: Math.trunc(Number(v)) };
        const max = new Date(Date.UTC(2000, d.month, 0)).getUTCDate();
        if (!(d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= max && d.year >= 1)) { say('That date does not exist.', 'danger'); return render(); }
        doc.setDate(d.day, d.month, d.year); return changed();
      }
      case 'system': if (!v) return render(); doc.setLocation(v, doc.planet); return changed();
      case 'planet': doc.setLocation(doc.system, v || null); return changed();
    }
  }

  function shipField(s, t) {
    switch (t.dataset.s) {
      case 'flagship': doc.setFlagshipIndex(s.index); return changed(`${s.name || s.model} is now your flagship.`);
      case 'name': s.name = t.value; return changed();
      case 'parked':
        if (t.checked && s.isFlagship) { say('Your flagship cannot be parked — choose another flagship first.', 'danger'); return render(); }
        s.parked = t.checked; return changed();
      default: {
        const n = nonNeg(t.value); if (n === null) { say('Enter a number of 0 or more.', 'danger'); return render(); }
        s[t.dataset.s] = t.dataset.s === 'crew' ? Math.trunc(n) : n; return changed();
      }
    }
  }

  function download() {
    const problems = doc.validate();
    if (problems.length && !confirm(`This save has problems the game may not like:\n\n• ${problems.join('\n• ')}\n\nDownload anyway?`)) return;
    const p = doc.pilot;
    const name = `${p.first} ${p.last}`.trim().replace(/[\\/:*?"<>|]+/g, '') || 'save';
    const url = URL.createObjectURL(new Blob([doc.toString()], { type: 'text/plain' }));
    Object.assign(document.createElement('a'), { href: url, download: `${name}.txt` }).click();
    URL.revokeObjectURL(url);
    say(`Downloaded ${name}.txt`, 'success');
  }

  async function revert() {
    if (!confirm('Throw away all edits to this save and go back to the file you uploaded?')) return;
    const rec = await V.revert(docId);
    doc = E.SaveFile.fromText(rec.original);
    hasEdits = false;
    const parsed = parseESSaveFile(rec.original);
    smSetSaveData(docId, parsed); parsedSave = parsed;
    origRenderResults(); ensureTab();
    render();
    say('Reverted to the original save.', 'success');
  }
  // registered last: onAuthChange calls back immediately
  if (window.EsAuth) window.EsAuth.onAuthChange(() => { renderCloudLibrary(); if (activeTab() === 'edit') loadEditor(); });
})();
