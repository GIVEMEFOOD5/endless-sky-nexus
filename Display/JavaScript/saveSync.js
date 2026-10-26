'use strict';

// Keeps saves up to date with the game: update an existing save instead of duplicating, re-read or write the game's file (Chrome / Edge).

(function () {
  const V = window.SaveVault, C = window.EsSaveCache;
  if (!V || !C) return;
  const $ = id => document.getElementById(id);
  // message
  const say = (m, t) => (typeof toast === 'function' ? toast(m, t) : console.log(m));
  const supported = typeof window.showOpenFilePicker === 'function';
  const PICKER = { types: [{ description: 'Endless Sky save', accept: { 'text/plain': ['.txt'] } }], excludeAcceptAllOption: false, multiple: false };
  const readJSON = k => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (_) { return null; } };
  const startCurrent = readJSON('ES_SM_CURRENT');

  // ── parsed data is always kept ──
  const origGet = window.smGetSaveData, origSet = window.smSetSaveData;
  window.smGetSaveData = function (id) { return origGet.apply(this, arguments) || C.get(id); };
  window.smSetSaveData = function (id, data) {
    const ok = origSet.apply(this, arguments);
    C.set(id, data);                          // memory copy either way
    if (!ok) console.info('[SaveSync] Save too large for localStorage — kept from the stored file instead.');
    return true;
  };
  const origRemove = window.smRemoveSave;
  window.smRemoveSave = function (id) { C.drop(id); return origRemove.apply(this, arguments); };

  // If the page started before the stored text was parsed, open the save now.
  document.addEventListener('esSaveCacheReady', () => {
    if (typeof currentSaveId === 'undefined' || currentSaveId || !startCurrent) return;
    if (!smGetRegistry().some(s => s.id === startCurrent)) return;
    const data = smGetSaveData(startCurrent);
    if (!data || !_dataReady) return;
    smSetCurrentId(startCurrent);
    parsedSave = data; currentSaveId = startCurrent;
    renderSavesLibrary(); renderResults();
  });

  // ── update a save with newer text ──
  async function updateExisting(id, text, { handle, parsed } = {}) {
    parsed = parsed || parseESSaveFile(text);
    const rec = await V.get(id);
    if (rec && rec.edited && !confirm('This save has edits made on this site that aren’t in the new file.\n\nOK = use the new file from the game (the edits are discarded)\nCancel = keep the save as it is')) return false;
    await V.replaceOriginal(id, text, { parsed });
    if (handle) await V.setHandle(id, handle);
    smSetSaveData(id, parsed);
    const reg = smGetRegistry();
    const entry = reg.find(s => s.id === id);
    if (entry) { entry.label = parsed.pilot.name || entry.label; entry.pilotName = parsed.pilot.name || entry.pilotName; entry.importedAt = Date.now(); smSetRegistry(reg); }
    smSetCurrentId(id);
    parsedSave = parsed; currentSaveId = id;
    if (window.SaveHealthCheck && window.SaveHealthCheck.invalidate) window.SaveHealthCheck.invalidate(id);
    renderSavesLibrary(); renderResults();
    return true;
  }

  // ── uploads: offer to update instead of making a copy ──
  let handleForNextUpload = null;
  const innerHandleFile = window.handleFile;
  window.handleFile = async function (file) {
    let text;
    try { text = await file.text(); } catch (_) { return innerHandleFile.apply(this, arguments); }
    const handle = handleForNextUpload; handleForNextUpload = null;
    let parsed = null;
    try { parsed = parseESSaveFile(text); } catch (_) { /* let the normal path report it */ }
    const pilot = parsed && parsed.pilot && parsed.pilot.name;
    const existing = pilot ? smGetRegistry().filter(s => (s.pilotName || s.label) === pilot) : [];
    if (existing.length && _dataReady) {
      const target = existing.find(s => s.id === currentSaveId) || existing.sort((a, b) => b.importedAt - a.importedAt)[0];
      if (confirm(`You already have a save for “${pilot}”.\n\nOK = update that save with this file\nCancel = add it as a separate save`)) {
        if (await updateExisting(target.id, text, { handle, parsed })) say(`Updated “${pilot}” from the file.`, 'success');
        if ($('fileInput')) $('fileInput').value = '';
        return;
      }
    }
    const result = await innerHandleFile.call(this, new File([text], file.name, { type: 'text/plain' }));
    if (handle && currentSaveId) {
      // saveEditor.js stores the original asynchronously — wait for it, then remember the file
      for (let i = 0; i < 20; i++) { if (await V.get(currentSaveId)) break; await new Promise(r => setTimeout(r, 100)); }
      await V.setHandle(currentSaveId, handle);
      renderButtons();
    }
    return result;
  };

  // ── the game's file (Chrome / Edge) ──
  async function permitted(handle, mode) {
    const opts = { mode };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  }
  // choose a file
  async function pickFile() {
    try { const [h] = await window.showOpenFilePicker(PICKER); return h; }
    catch (err) { if (err && err.name !== 'AbortError') say(err.message, 'danger'); return null; }
  }

  // open a save and remember its file
  async function openAndRemember() {
    const h = await pickFile();
    if (!h) return;
    handleForNextUpload = h;
    await window.handleFile(await h.getFile());
  }

  // link the open save to its file
  async function linkCurrent() {
    const id = currentSaveId; if (!id) return;
    const h = await pickFile(); if (!h) return;
    const text = await (await h.getFile()).text();
    const parsed = parseESSaveFile(text);
    if ((parsed.pilot.name || '') !== (parsedSave.pilot.name || '') &&
        !confirm(`That file is for “${parsed.pilot.name}”, not “${parsedSave.pilot.name}”. Link it anyway?`)) return;
    await V.setHandle(id, h);
    const rec = await V.get(id);
    if (!rec || rec.original !== text) {
      if (confirm('Linked. The file on disk is different from the copy here — load it now?')) await updateExisting(id, text, { parsed });
    }
    say('Linked to the game’s save file.', 'success');
    renderButtons();
  }

  // re-read from the game
  async function reloadFromGame() {
    const id = currentSaveId; if (!id) return;
    const h = await V.getHandle(id);
    if (!h) return linkCurrent();
    try {
      if (!(await permitted(h, 'read'))) return say('The browser needs permission to read the save file.', 'danger');
      const text = await (await h.getFile()).text();
      const rec = await V.get(id);
      if (rec && rec.original === text && !rec.edited) { await rescan(); return; }
      if (await updateExisting(id, text)) say('Reloaded from the game’s save file.', 'success');
    } catch (err) {
      say(err.name === 'NotFoundError' ? 'The linked file has moved or been deleted — link it again.' : err.message, 'danger');
      if (err.name === 'NotFoundError') { await V.setHandle(id, null); renderButtons(); }
    }
  }

  // re-read without asking
  async function rescan() {
    const id = currentSaveId; if (!id) return;
    const text = await V.text(id);
    if (!text) return say('This save was imported before the original file was kept — upload it once more and it won’t be needed again.', 'danger');
    const parsed = parseESSaveFile(text);
    smSetSaveData(id, parsed);
    parsedSave = parsed;
    if (window.SaveHealthCheck && window.SaveHealthCheck.invalidate) window.SaveHealthCheck.invalidate(id);
    renderSavesLibrary(); renderResults();
    say('Re-scanned the save.', 'success');
  }

  // write into the linked game save. Called by: saveEditor
  async function writeToGameFile(id, text) {
    const h = await V.getHandle(id);
    if (!h) { say('Link this save to its file first (🔗 Link to game file).', 'danger'); return false; }
    if (!confirm('Overwrite the game’s save file with the edited save?\n\nClose Endless Sky first — the game rewrites the file when it saves, which would undo this.')) return false;
    try {
      if (!(await permitted(h, 'readwrite'))) { say('The browser needs permission to change the save file.', 'danger'); return false; }
      const w = await h.createWritable();
      await w.write(text); await w.close();
      say('Saved into the game’s save file.', 'success');
      return true;
    } catch (err) { say(err.message, 'danger'); return false; }
  }

  // ── buttons ──
  async function renderButtons() {
    const group = $('resultButtons');
    if (!group) return;
    let box = $('ss-buttons');
    if (!box) { box = document.createElement('span'); box.id = 'ss-buttons'; box.style.display = 'contents'; group.appendChild(box); }
    if (!currentSaveId) { box.innerHTML = ''; return; }
    const id = currentSaveId;
    const linked = supported && !!(await V.getHandle(id).catch(() => null));
    if (id !== currentSaveId) return;
    box.innerHTML = `
      <button class="btn btn-secondary" id="ss-rescan" title="Read the stored save again — after plugin changes or site updates">🔄 Re-scan</button>
      ${supported ? (linked
        ? '<button class="btn btn-secondary" id="ss-reload" title="Read the latest version of the linked save file from your computer">⟳ Reload from game</button><button class="btn btn-secondary" id="ss-relink" title="Pick a different file for this save">🔗 Change linked file</button>'
        : '<button class="btn btn-secondary" id="ss-link" title="Pick this save’s file in your Endless Sky saves folder so it can be reloaded later in one click">🔗 Link to game file</button>') : ''}`;
    $('ss-rescan').onclick = rescan;
    if ($('ss-reload')) $('ss-reload').onclick = reloadFromGame;
    if ($('ss-link')) $('ss-link').onclick = linkCurrent;
    if ($('ss-relink')) $('ss-relink').onclick = linkCurrent;
  }

  // "Open a save from the game" button
  function addOpenButton() {
    const zone = $('dropzone');
    if (!zone || $('ss-open') || !supported) return;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:10px;';
    wrap.innerHTML = `<button class="btn btn-secondary" id="ss-open">📂 Open a save and remember its file</button>
      <span style="font-size:0.8rem;color:var(--c-text-dim);">Then use “⟳ Reload from game” after playing. Saves are in
      <code>%APPDATA%\\endless-sky\\saves</code> (Windows), <code>~/Library/Application Support/endless-sky/saves</code> (Mac) or
      <code>~/.local/share/endless-sky/saves</code> (Linux).</span>`;
    zone.insertAdjacentElement('afterend', wrap);
    $('ss-open').onclick = openAndRemember;
  }

  const origRender = window.renderResults;
  window.renderResults = function () { const r = origRender.apply(this, arguments); renderButtons(); return r; };
  addOpenButton();

  window.SaveSync = { supported, rescan, reloadFromGame, linkCurrent, writeToGameFile, updateExisting };
})();
