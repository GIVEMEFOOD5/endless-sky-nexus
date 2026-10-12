'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  shipBuilderFleets.js — multiple fleets in the ship builder
//
//  Load AFTER shipBuilder.js (and fleetStore.js before it). It swaps the
//  builder's single-fleet persistence for FleetStore:
//    sbLoad()  → sbFleet = the ACTIVE fleet's ships
//    sbSave()  → writes sbFleet back into the active fleet
//  Everything else in shipBuilder.js keeps using sbFleet unchanged, so
//  new/edit/duplicate/import/export all act on whichever fleet is selected.
//
//  Adds: a fleet bar above the ship grid (switch, new, rename, duplicate,
//  delete, sync status) and a "Move" button on each built ship card.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  if (!window.FleetStore) { console.warn('[Fleets] fleetStore.js not loaded — multiple fleets disabled.'); return; }
  const FS = window.FleetStore;

  const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toast = (m, t) => (typeof sbToast === 'function' ? sbToast(m, t) : console.log(m));

  // Same storage shape the original sbSave() wrote (outfits as a name → entry map).
  function serialise(ships) {
    return ships.map(ship => ({
      ...ship,
      outfits: Object.fromEntries((ship.outfits || []).map(o => [
        String(o.name).replace(/^"([^"]*)"$/, '$1'),
        { count: o.count ?? 1, pluginId: o.pluginId ?? null, internalId: o.internalId ?? null },
      ])),
    }));
  }
  function deserialise(ships) {
    return (ships || []).map(ship => ({
      ...ship,
      outfits: typeof _sbNormaliseOutfitsToArray === 'function' ? _sbNormaliseOutfitsToArray(ship.outfits) : (ship.outfits || []),
      leaks: typeof _sbNormaliseLeak === 'function' ? (ship.leaks || []).map(_sbNormaliseLeak) : (ship.leaks || []),
    }));
  }

  // ── persistence overrides ────────────────────────────────────────────────
  let writing = false;
  window.sbLoad = function () {
    try { sbFleet = deserialise(FS.active().ships); } catch (e) { console.warn('[Fleets] load failed', e); sbFleet = []; }
  };
  window.sbSave = function () {
    writing = true;
    try { FS.setShips(FS.activeId, serialise(sbFleet)); } finally { writing = false; }
  };

  function refreshLocalBuilds() {
    if (window.DataLoader && window.DataLoader.refreshLocalBuilds) window.DataLoader.refreshLocalBuilds();
  }
  const inBuilder = () => { const v = document.getElementById('builder-view'); return v && !v.classList.contains('hidden'); };

  // Reload the grid when the active fleet changes underneath us (sync pull,
  // another tab, fleet switch) — but never while a ship is open for editing,
  // since sbEditIdx points into the current sbFleet.
  let pendingReload = false;
  FS.onChange(({ reason }) => {
    renderBar();
    if (reason === 'status') return;
    if (writing) { refreshLocalBuilds(); return; }
    if (['pulled', 'external', 'active', 'removed', 'moved', 'copied', 'created'].includes(reason)) {
      if (inBuilder()) { pendingReload = true; return; }
      reloadGrid();
    }
  });
  function reloadGrid() {
    pendingReload = false;
    sbLoad();
    if (typeof renderFleet === 'function') renderFleet();
    if (typeof renderExportChecklist === 'function') renderExportChecklist();
    refreshLocalBuilds();
  }
  const origShowFleetView = window.showFleetView;
  if (typeof origShowFleetView === 'function') {
    window.showFleetView = function () {
      if (pendingReload) sbLoad();
      pendingReload = false;
      return origShowFleetView.apply(this, arguments);
    };
  }

  // ── fleet bar ────────────────────────────────────────────────────────────
  const STATUS_TEXT = {
    local:       'Saved in this browser — log in to keep fleets in your account',
    syncing:     'Saving to your account…',
    synced:      'Saved to your account',
    error:       'Could not reach your account — changes are kept in this browser',
    unavailable: 'Saved in this browser (account sync not set up yet)',
  };

  function ensureBar() {
    let bar = document.getElementById('sbf-bar');
    if (bar) return bar;
    const grid = document.getElementById('fleet-grid');
    if (!grid) return null;
    bar = document.createElement('div');
    bar.id = 'sbf-bar';
    bar.className = 'panel';
    bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 16px;margin-bottom:16px;';
    grid.parentNode.insertBefore(bar, grid);
    return bar;
  }

  function renderBar() {
    const bar = ensureBar();
    if (!bar) return;
    const fleets = FS.list();
    const activeId = FS.activeId;
    bar.innerHTML = `
      <label for="sbf-select" style="font-weight:700;color:var(--c-text-hi);">Fleet</label>
      <select id="sbf-select" class="text-input" style="width:auto;min-width:200px;flex:0 1 auto;"
        onchange="SBFleets.switchTo(this.value)">
        ${fleets.map(f => `<option value="${escHtml(f.id)}"${f.id === activeId ? ' selected' : ''}>${escHtml(f.name)} (${f.shipCount})</option>`).join('')}
      </select>
      <div class="btn-group" style="margin:0;">
        <button class="btn btn-primary btn-sm" onclick="sbOpenAddShip()" title="Add a ship to this fleet">＋ Add ship</button>
        <button class="btn btn-secondary btn-sm" onclick="SBFleets.promptNew()">+ New fleet</button>
        <button class="btn btn-secondary btn-sm" onclick="SBFleets.promptRename()">Rename</button>
        <button class="btn btn-secondary btn-sm" onclick="SBFleets.duplicateActive()">Duplicate</button>
        <button class="btn btn-danger btn-sm" onclick="SBFleets.confirmDelete()">Delete</button>
      </div>
      <span id="sbf-status" style="margin-left:auto;font-size:0.8rem;color:${FS.status === 'error' ? 'var(--c-danger-hi)' : 'var(--c-text-dim)'};"
        title="${escHtml(FS.statusDetail)}">${escHtml(STATUS_TEXT[FS.status] || '')}</span>`;
  }

  // ── name modal (reused for new + rename) ─────────────────────────────────
  function ensureNameModal() {
    if (document.getElementById('modal-sbf-name')) return;
    const m = document.createElement('div');
    m.id = 'modal-sbf-name';
    m.className = 'modal-overlay';
    m.innerHTML = `
      <div class="modal-box" style="width:min(400px,96vw);">
        <div class="modal-header">
          <div class="modal-title" id="sbf-name-title">New fleet</div>
          <button class="modal-close" onclick="closeModal('modal-sbf-name')">×</button>
        </div>
        <div class="input-group">
          <label for="sbf-name-input">Fleet name</label>
          <input id="sbf-name-input" class="text-input" type="text" maxlength="80" placeholder="e.g. Pirate hunters">
        </div>
        <div class="btn-group btn-group-right">
          <button class="btn btn-secondary" onclick="closeModal('modal-sbf-name')">Cancel</button>
          <button class="btn btn-primary" id="sbf-name-ok">Create fleet</button>
        </div>
      </div>`;
    m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); });
    document.body.appendChild(m);
    document.getElementById('sbf-name-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('sbf-name-ok').click();
    });
  }
  function askName({ title, button, value }, done) {
    ensureNameModal();
    document.getElementById('sbf-name-title').textContent = title;
    const ok = document.getElementById('sbf-name-ok');
    ok.textContent = button;
    const input = document.getElementById('sbf-name-input');
    input.value = value || '';
    ok.onclick = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      closeModal('modal-sbf-name');
      done(v);
    };
    openModal('modal-sbf-name');
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }

  // ── move/copy modal ──────────────────────────────────────────────────────
  function ensureMoveModal() {
    if (document.getElementById('modal-sbf-move')) return;
    const m = document.createElement('div');
    m.id = 'modal-sbf-move';
    m.className = 'modal-overlay';
    m.innerHTML = `
      <div class="modal-box" style="width:min(420px,96vw);">
        <div class="modal-header">
          <div class="modal-title" id="sbf-move-title">Move ship</div>
          <button class="modal-close" onclick="closeModal('modal-sbf-move')">×</button>
        </div>
        <div class="input-group">
          <label for="sbf-move-target">To fleet</label>
          <select id="sbf-move-target" class="text-input"></select>
        </div>
        <div class="btn-group btn-group-right">
          <button class="btn btn-secondary" onclick="closeModal('modal-sbf-move')">Cancel</button>
          <button class="btn btn-secondary" id="sbf-copy-ok">Copy</button>
          <button class="btn btn-primary" id="sbf-move-ok">Move</button>
        </div>
      </div>`;
    m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); });
    document.body.appendChild(m);
  }

  // ── actions ──────────────────────────────────────────────────────────────
  const SBFleets = {
    switchTo(id) {
      if (id === FS.activeId) return;
      sbEditIdx = -1;
      FS.setActive(id);            // triggers reloadGrid via onChange('active')
    },
    promptNew() {
      askName({ title: 'New fleet', button: 'Create fleet', value: '' }, name => {
        const f = FS.create(name);
        FS.setActive(f.id);
        toast(`Created fleet "${f.name}".`, 'success');
      });
    },
    promptRename() {
      const f = FS.active();
      askName({ title: 'Rename fleet', button: 'Rename fleet', value: f.name }, name => {
        FS.rename(f.id, name);
        renderFleet();
        toast(`Renamed to "${name}".`, 'success');
      });
    },
    duplicateActive() {
      const copy = FS.duplicate(FS.activeId);
      FS.setActive(copy.id);
      toast(`Duplicated as "${copy.name}".`, 'success');
    },
    confirmDelete() {
      const f = FS.active();
      const n = f.ships.length;
      document.getElementById('confirm-text').textContent =
        `Delete the fleet "${f.name}"${n ? ` and its ${n} ship${n === 1 ? '' : 's'}` : ''}? This cannot be undone.`;
      document.getElementById('confirm-ok-btn').onclick = () => {
        FS.remove(f.id);
        closeModal('modal-confirm');
        toast(`Deleted fleet "${f.name}".`, 'danger');
      };
      openModal('modal-confirm');
    },
    openMove(index) {
      const others = FS.list().filter(f => f.id !== FS.activeId);
      const ship = sbFleet[index];
      if (!ship) return;
      if (!others.length) {
        askName({ title: 'Move to a new fleet', button: 'Create and move', value: '' }, name => {
          const f = FS.create(name);
          sbSave();
          FS.moveShip(FS.activeId, index, f.id);
          toast(`Moved "${ship.name || 'ship'}" to "${f.name}".`, 'success');
        });
        return;
      }
      ensureMoveModal();
      document.getElementById('sbf-move-title').textContent = `Move "${ship.name || 'Unnamed ship'}"`;
      document.getElementById('sbf-move-target').innerHTML =
        others.map(f => `<option value="${escHtml(f.id)}">${escHtml(f.name)} (${f.shipCount})</option>`).join('');
      const go = copy => {
        const toId = document.getElementById('sbf-move-target').value;
        const target = FS.get(toId);
        sbSave();                                   // make sure the store has the latest sbFleet first
        FS.moveShip(FS.activeId, index, toId, { copy });
        closeModal('modal-sbf-move');
        toast(`${copy ? 'Copied' : 'Moved'} "${ship.name || 'ship'}" to "${target.name}".`, 'success');
      };
      document.getElementById('sbf-move-ok').onclick = () => go(false);
      document.getElementById('sbf-copy-ok').onclick = () => go(true);
      openModal('modal-sbf-move');
    },
  };
  window.SBFleets = SBFleets;

  // ── renderFleet: label the built section with the fleet name, add Move ──
  const origRenderFleet = window.renderFleet;
  if (typeof origRenderFleet === 'function') {
    window.renderFleet = function () {
      const r = origRenderFleet.apply(this, arguments);
      const name = FS.active() ? FS.active().name : 'My Built Fleet';
      document.querySelectorAll('#built-fleet-section .fleet-section-header span').forEach(span => {
        if (span.textContent.trim() === '🛸 My Built Fleet') span.textContent = `🛸 ${name}`;
      });
      // empty-state text when this fleet has no ships but others might
      if (!sbFleet.length && !sbSaveFleet.length) {
        const grid = document.getElementById('fleet-grid');
        const empty = grid && grid.querySelector('.fleet-empty p');
        if (empty) empty.textContent = `"${name}" has no ships yet. Add one to start:`;
      }
      document.querySelectorAll('#built-fleet-cards .fleet-card').forEach((card, i) => {
        const actions = card.querySelector('.fleet-card__actions');
        if (!actions || actions.querySelector('.sbf-move-btn')) return;
        const b = document.createElement('button');
        b.className = 'btn btn-secondary btn-sm sbf-move-btn';
        b.title = 'Move or copy this ship to another fleet';
        b.textContent = '⇄ Move';
        b.onclick = e => { e.stopPropagation(); SBFleets.openMove(i); };
        const del = actions.querySelector('.btn-danger');
        actions.insertBefore(b, del || null);
      });
      renderBar();
      return r;
    };
  }

  // ── Export All → this fleet (+ save ships), named after the fleet ────────
  if (typeof window.exportAll === 'function') {
    window.exportAll = function () {
      const ships = [...sbSaveFleet, ...sbFleet];
      if (!ships.length) { toast('This fleet has no ships to export.', 'danger'); return; }
      const t = ships.map(s => sbGenerateES(s)).join('\n\n');
      const file = (FS.active().name || 'fleet').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'fleet';
      sbDL(t, `${file}.txt`);
      toast(`Downloaded ${file}.txt`, 'success');
    };
  }

  document.addEventListener('DOMContentLoaded', renderBar);
})();
