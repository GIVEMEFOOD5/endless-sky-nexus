'use strict';

// Builder extras: undo (↶ / Ctrl+Z), opening a ship from the save editor, outfit type-ahead.

(function () {
  const MAX = 40;
  let stack = [], current = null;
  // the ship being edited
  const cur = () => (typeof sbCurrentShip !== 'undefined' ? sbCurrentShip : null);
  const btn = () => document.getElementById('sb-undo-btn');
  // enable/disable the undo button
  const refresh = () => { const b = btn(); if (b) { b.disabled = !stack.length; b.textContent = stack.length ? `↶ Undo (${stack.length})` : '↶ Undo'; } };
  // add a snapshot to the history
  function track() {
    const s = cur();
    if (s !== current) { current = s; stack = []; refresh(); }
  }

  // remember the ship before changing it from code. Called by: afUI.apply
  function snapshot() {
    track();
    const s = cur(); if (!s) return;
    const json = JSON.stringify(s);
    if (stack[stack.length - 1] !== json) { stack.push(json); if (stack.length > MAX) stack.shift(); }
    refresh();
  }

  // go back one step. Called by: ↶ and Ctrl+Z
  function undo() {
    track();
    if (!stack.length || typeof sbCurrentShip === 'undefined') return;
    const prev = JSON.parse(stack.pop());
    // restore in place so other code holding the object keeps working
    for (const k of Object.keys(sbCurrentShip)) delete sbCurrentShip[k];
    Object.assign(sbCurrentShip, prev);
    if (typeof sbPopulateBuilder === 'function') sbPopulateBuilder();
    refresh();
    if (typeof sbToast === 'function') sbToast('Undone.', 'success');
  }

  // remember the ship before edits in the builder. Called on page load
  function watch() {
    const view = document.getElementById('builder-view');
    if (!view) return;
    let before = null;
    const start = () => { track(); const s = cur(); before = s ? JSON.stringify(s) : null; };
    const finish = () => {
      setTimeout(() => {
        if (typeof onBuilderChange === 'function' && document.activeElement && view.contains(document.activeElement)) { /* form edits sync on change */ }
        const s = cur();
        if (!s || before === null) return;
        const after = JSON.stringify(s);
        if (after !== before && s === current) { stack.push(before); if (stack.length > MAX) stack.shift(); refresh(); }
        before = null;
      }, 0);
    };
    view.addEventListener('pointerdown', start, true);
    view.addEventListener('focusin', start, true);
    view.addEventListener('click', finish, true);
    view.addEventListener('change', finish, true);
    // outfit picker and other pop-ups live outside the view
    document.addEventListener('click', e => {
      if (e.target.closest('#modal-sb-outfit-picker .sb-picker-row')) { start(); finish(); }
    }, true);
    document.addEventListener('keydown', e => {
      if (view.classList.contains('hidden')) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing && stack.length) { e.preventDefault(); undo(); }
    });
  }

  // open a ship sent from the save editor. Called on page load
  function openFromSave() {
    let uuid = null;
    try { uuid = localStorage.getItem('ES_SB_OPEN_SAVE_SHIP'); } catch (_) {}
    if (!uuid) return;
    // try again until the builder is ready. Called by: openFromSave
    const tryOpen = () => {
      if (typeof sbSaveFleet === 'undefined' || typeof sbEditSaveShip !== 'function') return false;
      const i = sbSaveFleet.findIndex(s => s._uuid === uuid);
      if (i === -1) return false;
      try { localStorage.removeItem('ES_SB_OPEN_SAVE_SHIP'); } catch (_) {}
      sbEditSaveShip(i);
      if (typeof sbToast === 'function') sbToast('Opened from your save — use ➜ Put in a save to send it back.', 'success');
      return true;
    };
    if (tryOpen()) return;
    if (window.DataLoader) window.DataLoader.onReady(() => setTimeout(tryOpen, 50));
  }

  // outfit-name boxes get the shared type-ahead
  function nameBoxes() {
    if (!window.NameSearch) return;
    const el = document.getElementById('new-outfit-name');
    if (el) window.NameSearch.attach(el, 'outfits');
  }

  document.addEventListener('DOMContentLoaded', () => { watch(); nameBoxes(); setTimeout(openFromSave, 0); });
  window.BuilderExtras = { undo, snapshot };
})();
