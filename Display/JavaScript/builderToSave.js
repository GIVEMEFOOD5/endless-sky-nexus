'use strict';

// "➜ Put in a save" in the builder: add the ship to a save, or refit a ship in it, with a before/after view.

(function () {
  const E = window.EsSaveFile, V = window.SaveVault, D = window.ShipDefinition;
  if (!E || !V || !D) return;
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const readJSON = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } };
  const toast = (m, t) => (typeof sbToast === 'function' ? sbToast(m, t) : alert(m));

  let state = null;   // { design, saves, saveId, doc, mode, targetUuid, name }

  // name → game ship / outfit. Called by: the stats helpers
  function gameIndex() {
    const ships = new Map(), outfits = new Map();
    for (const p of Object.values((window.DataLoader && typeof window.DataLoader.getActiveData === 'function' ? window.DataLoader.getActiveData() : (window.allData || {})))) {
      for (const s of p.ships || []) if (s && s.name && !ships.has(s.name)) ships.set(s.name, s);
      for (const o of p.outfits || []) if (o && o.name && !outfits.has(o.name)) outfits.set(o.name, o);
    }
    return { ships, outfits };
  }

  // ── before/after numbers and cost ──
  function statsOfDesign(design) {
    const A = window.AfStats; if (!A) return null;
    const { outfits } = gameIndex();
    return A.derive(A.hullAttrs(design), D.outfitList(design.outfits), outfits);
  }
  // numbers for a ship in the save
  function statsOfSaveShip(sh) {
    const A = window.AfStats; if (!A || !sh) return null;
    const { ships, outfits } = gameIndex();
    let hull = ships.get(sh.model);
    if (!hull) for (const p of Object.values((window.DataLoader && typeof window.DataLoader.getActiveData === 'function' ? window.DataLoader.getActiveData() : (window.allData || {})))) { const v = (p.variants || []).find(x => x.name === sh.model); if (v) { hull = ships.get(v.baseShip) || v; break; } }
    if (!hull) return null;
    return A.derive(A.hullAttrs(hull), Object.entries(sh.outfits || {}).map(([n, c]) => [n, Number(c) || 0]), outfits);
  }
  // before/after table
  function compareHtml(a, b) {
    const fmt = n => (Number.isFinite(n) ? n : 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const rows = [['Shields', x => x.shields], ['Hull', x => x.hull], ['Top speed', x => x.maxSpeed], ['Acceleration', x => x.acceleration],
      ['Turning', x => x.turnRate], ['Damage / s', x => x.dps.total], ['Cargo', x => x.cargo], ['Bunks', x => x.bunks], ['Jumps', x => x.fuel.jumps]];
    return `<div style="overflow-x:auto;margin:8px 0 0 28px;"><table style="font-size:0.8rem;width:100%;">
      <tr><th></th><th style="text-align:right;">Now</th><th style="text-align:right;">After</th></tr>
      ${rows.map(([l, f]) => { const x = f(a), y = f(b), up = y > x + 1e-6, down = y < x - 1e-6;
        return `<tr><td>${l}</td><td style="text-align:right;">${fmt(x)}</td><td style="text-align:right;font-weight:600;color:${up ? 'var(--c-success-text,#4ade80)' : down ? 'var(--c-danger-text,#f87171)' : 'inherit'};">${fmt(y)}</td></tr>`; }).join('')}
    </table></div>`;
  }
  // what the change costs
  function priceOf(stats) { return stats ? Math.max(0, Math.round(stats.cost)) : null; }

  // the window
  function modal() {
    let m = document.getElementById('b2s-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'b2s-modal'; m.className = 'modal-overlay';
    m.innerHTML = `<div class="modal-box" style="width:min(520px,96vw);max-height:90dvh;overflow-y:auto;">
      <div class="modal-header"><div class="modal-title">Put this ship in a save</div>
        <button class="modal-close" data-b2s="close" aria-label="Close">×</button></div>
      <div id="b2s-body"></div></div>`;
    m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-b2s="close"]')) return close();
      const act = e.target.closest('[data-b2s]')?.dataset.b2s;
      if (act === 'apply') apply();
    });
    m.addEventListener('change', async e => {
      const t = e.target;
      if (!state) return;
      if (t.id === 'b2s-save') { await loadSave(t.value); render(); }
      else if (t.name === 'b2s-mode') { state.mode = t.value; render(); }
      else if (t.id === 'b2s-target') { state.targetUuid = t.value; }
      else if (t.id === 'b2s-name') { state.name = t.value; }
      else if (t.id === 'b2s-charge') { state.charge = t.checked; render(); }
    });
    document.body.appendChild(m);
    return m;
  }
  function close() { document.getElementById('b2s-modal')?.classList.remove('active'); state = null; }

  // load the chosen save
  async function loadSave(id) {
    state.saveId = id;
    state.doc = null;
    const text = await V.text(id).catch(() => null);
    if (!text) { state.error = 'This save\'s original file isn\'t stored in this browser — open it on Saves & Account and upload it again.'; return; }
    state.error = null;
    state.doc = E.SaveFile.fromText(text);
    // a ship that came from this save → refit that ship by default
    const fromHere = state.design._uuid && state.doc.ships.find(s => s.uuid === state.design._uuid);
    state.mode = fromHere ? 'refit' : (state.mode === 'refit' && state.doc.ships.length ? 'refit' : 'add');
    state.targetUuid = fromHere ? fromHere.uuid : (state.doc.flagship?.uuid || state.doc.ships[0]?.uuid || null);
  }

  // draw the window
  function render() {
    const body = document.getElementById('b2s-body');
    if (!state || !body) return;
    const s = state;
    if (!s.saves.length) {
      body.innerHTML = `<p style="color:var(--c-text-mid);">There are no saves in this browser yet. Open one on the
        <a href="UserManager.html">Saves &amp; Account</a> page first, then come back.</p>`;
      return;
    }
    const doc = s.doc;
    const { outfits } = gameIndex();
    const missing = D.outfitList(s.design.outfits).map(([n]) => n).filter(n => !outfits.has(n));
    const after = statsOfDesign(s.design);
    const target = doc && s.mode === 'refit' ? doc.ships.find(x => x.uuid === s.targetUuid) : null;
    const before = target ? statsOfSaveShip(target) : null;
    const newPrice = priceOf(after), oldPrice = priceOf(before);
    // a refit pays the difference (old outfits and hull traded in at full value — the game may give less)
    s.price = newPrice == null ? null : s.mode === 'refit' ? Math.max(0, newPrice - (oldPrice || 0)) : newPrice;
    const credits = doc ? Number(doc.credits) : 0;
    s.cantAfford = !!(s.charge && s.price != null && s.price > credits);
    body.innerHTML = `
      <label style="display:block;font-size:0.85rem;margin-bottom:10px;">Save
        <select id="b2s-save" class="text-input" style="margin-top:4px;">${s.saves.map(r =>
          `<option value="${h(r.id)}"${r.id === s.saveId ? ' selected' : ''}>${h(r.pilotName || r.label || r.id)}</option>`).join('')}</select></label>
      ${s.error ? `<p style="color:var(--c-danger-text);">${h(s.error)}</p>` : !doc ? '<p>Loading…</p>' : `
        <p style="font-size:0.82rem;color:var(--c-text-dim);margin:0 0 10px;">${h(doc.pilot.first + ' ' + doc.pilot.last)} ·
          ${doc.ships.length} ship${doc.ships.length === 1 ? '' : 's'} · at ${h(doc.planet || doc.system || 'unknown')}</p>
        <label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;"><input type="radio" name="b2s-mode" value="add"${s.mode === 'add' ? ' checked' : ''}>
          <span>Add it as a new ship<span style="display:block;font-size:0.78rem;color:var(--c-text-dim);">Appears where the pilot is, repaired, refuelled and crewed.</span></span></label>
        ${s.mode === 'add' ? `<input id="b2s-name" class="text-input" style="margin:0 0 8px 28px;width:calc(100% - 28px);box-sizing:border-box;" value="${h(s.name)}" placeholder="Ship name">` : ''}
        <label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;"><input type="radio" name="b2s-mode" value="refit"${s.mode === 'refit' ? ' checked' : ''}${doc.ships.length ? '' : ' disabled'}>
          <span>Refit a ship that's already in the save<span style="display:block;font-size:0.78rem;color:var(--c-text-dim);">Replaces its design and outfits; keeps its name, location and history.</span></span></label>
        ${s.mode === 'refit' ? `<select id="b2s-target" class="text-input" style="margin:0 0 8px 28px;width:calc(100% - 28px);">${doc.ships.map(sh =>
          `<option value="${h(sh.uuid)}"${sh.uuid === s.targetUuid ? ' selected' : ''}>${h(sh.name || sh.model)} — ${h(sh.model)}${sh.isFlagship ? ' (flagship)' : ''}${sh.parked ? ' (parked)' : ''}</option>`).join('')}</select>` : ''}
        ${s.mode === 'refit' && before && after ? compareHtml(before, after) : ''}
        ${s.price != null ? `<label style="display:flex;gap:8px;align-items:flex-start;margin:10px 0 0;font-size:0.86rem;">
          <input type="checkbox" id="b2s-charge"${s.charge ? ' checked' : ''}>
          <span>Pay for it — ${s.price.toLocaleString()} credits${s.mode === 'refit' ? ' (new value minus the old ship\'s)' : ''}
            <span style="display:block;font-size:0.76rem;color:${s.cantAfford ? 'var(--c-danger-text,#f87171)' : 'var(--c-text-dim)'};">
              ${h(doc.pilot.first)} has ${credits.toLocaleString()} credits${s.cantAfford ? ' — not enough' : ''}.</span></span></label>` : ''}
        ${missing.length ? `<p style="font-size:0.8rem;color:var(--c-warn-text, #fbbf24);">⚠ ${missing.length} outfit${missing.length === 1 ? '' : 's'} aren't in your selected plugins
          (${h(missing.slice(0, 4).join(', '))}${missing.length > 4 ? '…' : ''}) — the game drops ${missing.length === 1 ? 'it' : 'them'} unless that plugin is installed.</p>` : ''}
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
          <button class="btn btn-primary" data-b2s="apply"${s.cantAfford ? ' disabled' : ''}>${s.mode === 'refit' ? 'Refit the ship' : 'Add to the save'}</button>
          <button class="btn btn-secondary" data-b2s="close">Cancel</button></div>`}`;
  }

  // write the ship into the save
  async function apply() {
    const s = state;
    if (!s || !s.doc) return;
    const doc = s.doc;
    const { ships, outfits } = gameIndex();
    const def = D.fromBuild(s.design, new Set(ships.keys()));
    const attrs = { ...(s.design._sourceShip ? ships.get(s.design._sourceShip)?.attributes : {}), ...(s.design.attributes || {}) };
    const levels = D.maxLevels(attrs, D.outfitList(s.design.outfits), outfits);
    let what;
    try {
      if (s.mode === 'refit') {
        const target = doc.ships.find(x => x.uuid === s.targetUuid) || doc.ships[0];
        doc.replaceShipDefinition(target.index, def, { levels });
        what = `Refitted “${target.name || target.model}”`;
      } else {
        const name = (s.name || '').trim() || s.design.name || 'New ship';
        doc.addShip(def, { name, levels });
        what = `Added “${name}”`;
      }
      if (s.charge && s.price) { doc.addCredits(-BigInt(s.price)); what += ` for ${s.price.toLocaleString()} credits`; }
      const problems = doc.validate();
      await V.setEdited(s.saveId, doc.toString());
      // the Saves page keeps a parsed copy; drop it so it's rebuilt from the edited text
      try { localStorage.removeItem('ES_SM_SAVE_' + s.saveId); } catch (_) {}
      const pilot = s.saves.find(r => r.id === s.saveId);
      close();
      toast(`${what} in ${pilot?.pilotName || pilot?.label || 'the save'}. Open Saves & Account to download it.`, 'success');
      if (problems.length) console.warn('[builderToSave] save checks:', problems);
    } catch (err) {
      toast('Could not change the save: ' + err.message, 'danger');
    }
  }

  // open for a fleet ship (index) or the ship being edited. Called by: the builder buttons
  async function open(fleetIndex, which = 'built') {
    let design;
    if (typeof fleetIndex === 'number') {
      const list = which === 'save' ? (typeof sbSaveFleet !== 'undefined' ? sbSaveFleet : []) : (typeof sbFleet !== 'undefined' ? sbFleet : []);
      design = list[fleetIndex];
    }
    else {
      if (typeof onBuilderChange === 'function') onBuilderChange();   // pick up unsaved form edits
      design = typeof sbCurrentShip !== 'undefined' ? sbCurrentShip : null;
    }
    if (!design) return;
    design = JSON.parse(JSON.stringify(design));
    const saves = (readJSON('ES_SM_REGISTRY') || []).filter(r => r && r.id);
    const current = readJSON('ES_SM_CURRENT');
    state = { design, saves, saveId: null, doc: null, mode: 'add', targetUuid: null, charge: false, price: null,
              name: design.customName || design.name || '', error: null };
    modal().classList.add('active');
    render();
    if (saves.length) { await loadSave(saves.some(r => r.id === current) ? current : saves[0].id); render(); }
  }

  window.BuilderToSave = { open };
})();
