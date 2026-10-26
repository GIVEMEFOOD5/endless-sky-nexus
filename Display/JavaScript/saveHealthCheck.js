'use strict';

// 🩺 Save health check: ships, outfits and places your save uses that your selected plugins don't have.

(function () {
  if (!window.EsSaveFile) return;
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const KINDS = [
    { key: 'ship',       table: 'ships',       label: 'Ship models' },
    { key: 'outfit',     table: 'outfits',     label: 'Outfits' },
    { key: 'system',     table: 'systems',     label: 'Systems' },
    { key: 'planet',     table: 'planets',     label: 'Planets' },
    { key: 'mission',    table: 'missions',    label: 'Missions' },
    { key: 'event',      table: 'game_events', label: 'Events' },
    { key: 'government', table: 'governments', label: 'Governments' },
  ];
  let catalog = null;       // { kind: Map<name, Set<plugin_id>> }, plugins: Map<plugin_id, {output, display}>
  let catalogPromise = null;
  const resultsBySave = new Map();

  // ── everything the game would look up ──
  function collectReferences(doc) {
    const refs = new Map(KINDS.map(k => [k.key, new Map()]));   // kind → name → Set(where)
    const add = (kind, name, where) => {
      if (!name) return;
      const m = refs.get(kind);
      if (!m.has(name)) m.set(name, new Set());
      if (m.get(name).size < 4) m.get(name).add(where);
    };
    const top = k => doc.topAll(k);
    const val = (n, k) => n.children.find(c => c.tokens && c.tokens[0] === k)?.tokens[1];

    for (const k of ['system', 'previous system', 'travel']) for (const n of top(k)) add('system', n.tokens[1], k === 'travel' ? 'travel plan' : 'pilot location');
    for (const k of ['planet', 'previous planet', 'travel destination']) for (const n of top(k)) add('planet', n.tokens[1], 'pilot location');

    for (const s of doc.ships) {
      const where = `ship “${s.name || s.model}”`;
      add('ship', s.model, where);
      for (const o of Object.keys(s.outfits)) add('outfit', o, where);
      for (const hp of s.hardpoints) if (hp.outfit) add('outfit', hp.outfit, `${where} (mounted)`);
      if (s.system) add('system', s.system, where);
      if (s.planet) add('planet', s.planet, where);
    }
    const cargo = doc.cargo;
    for (const o of Object.keys(cargo.outfits)) add('outfit', o, 'cargo');
    for (const st of doc.storage) {
      add('planet', st.planet, 'planetary storage');
      for (const o of Object.keys(st.outfits)) add('outfit', o, `storage on ${st.planet}`);
    }
    for (const m of doc.missions) {
      const where = `${m.kind === 'mission' ? 'accepted mission' : m.kind} “${m.displayName}”`;
      add('mission', m.id, where);
      for (const k of ['destination', 'source']) { const p = val(m.node, k); if (p) add('planet', p, where); }
      for (const c of m.node.children) {
        if (!c.tokens) continue;
        if (c.tokens[0] === 'stopover') add('planet', c.tokens[1], where);
        if (c.tokens[0] === 'waypoint') add('system', c.tokens[1], where);
      }
    }
    for (const e of doc.events) if (e.name) add('event', e.name, 'scheduled event');
    for (const n of doc.changes) if (n.tokens && n.tokens[0] === 'event') add('event', n.tokens[1], 'story history');
    for (const g of Object.keys(doc.reputations)) add('government', g, 'reputation');
    for (const s of doc.visitedSystems) add('system', s, 'visited');
    for (const p of doc.visitedPlanets) add('planet', p, 'visited');
    for (const hv of doc.harvested) { add('system', hv.system, 'harvested'); add('outfit', hv.outfit, 'harvested'); }
    for (const n of (doc.top('gifted ships')?.children || [])) if (n.tokens) add('ship', n.tokens[1] || n.tokens[0], 'gifted ships');
    return refs;
  }

  // ── names each plugin defines ──
  function loadCatalog() {
    if (catalogPromise) return catalogPromise;
    catalogPromise = (async () => {
      const { fetchAllRows } = window.SupabaseHelpers;
      const plugins = new Map((await fetchAllRows('plugins', { select: 'plugin_id, output_name, display_name' }))
        .map(p => [p.plugin_id, { output: p.output_name, display: p.display_name || p.output_name }]));
      const out = { plugins, unavailable: [] };
      await Promise.all(KINDS.map(async k => {
        try {
          let rows = await fetchAllRows(k.table, { select: 'name, plugin_id', orderBy: 'name', pageSize: 1000 });
          // a save's ship model can also be a ship defined only as a variant
          if (k.key === 'ship') rows = rows.concat(await fetchAllRows('variants', { select: 'name, plugin_id', orderBy: 'name', pageSize: 1000 }).catch(() => []));
          const m = new Map();
          for (const r of rows) { if (!m.has(r.name)) m.set(r.name, new Set()); m.get(r.name).add(r.plugin_id); }
          out[k.key] = m;
        } catch (err) { out[k.key] = null; out.unavailable.push(k.label); }
      }));
      catalog = out;
      return out;
    })();
    return catalogPromise;
  }

  // ── run the check ──
  async function check(saveId) {
    const text = window.SaveVault ? await window.SaveVault.text(saveId).catch(() => null) : null;
    if (!text) return { noText: true };
    const doc = window.EsSaveFile.SaveFile.fromText(text);
    const cat = await loadCatalog();

    // the plugins this save loads: its own list, matched to known plugins, plus the base game
    let saveOutputs = new Set();
    try {
      const { matched } = await smMatchSavePlugins(doc.plugins);
      saveOutputs = new Set(matched.map(m => m.outputName));
    } catch (_) { /* matching unavailable — fall back to every plugin */ }
    const inSave = pid => {
      const p = cat.plugins.get(pid);
      if (!p) return false;
      return !saveOutputs.size || saveOutputs.has(p.output) || /^official-game\//.test(pid);
    };

    const refs = collectReferences(doc);
    const problems = [];
    let checked = 0;
    for (const k of KINDS) {
      const known = cat[k.key];
      if (!known) continue;
      if (k.key === 'event' && known.size === 0) continue;   // table empty until the parser has stored events
      for (const [name, where] of refs.get(k.key)) {
        checked++;
        const defs = known.get(name);
        if (defs && [...defs].some(inSave)) continue;
        const elsewhere = defs ? [...defs].map(pid => cat.plugins.get(pid)?.display || pid) : [];
        problems.push({ kind: k.key, label: k.label, name, where: [...where], elsewhere });
      }
    }
    return { problems, checked, plugins: doc.plugins, matchedCount: saveOutputs.size, unavailable: cat.unavailable,
             eventsSkipped: !cat.event || cat.event.size === 0 };
  }

  // ── the panel ──
  function ensurePanel() {
    let p = document.getElementById('sh-panel');
    if (p) return p;
    const tabs = document.getElementById('resultTabs');
    if (!tabs) return null;
    p = document.createElement('section');
    p.id = 'sh-panel'; p.className = 'panel'; p.style.marginBottom = '20px';
    tabs.parentNode.insertBefore(p, tabs);
    return p;
  }

  // draw the results
  function render(saveId, result, running) {
    const p = ensurePanel();
    if (!p) return;
    const head = `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <h2 class="section-title" style="margin:0;">🩺 Health check</h2>
        <button class="btn btn-secondary btn-sm" id="sh-run"${running ? ' disabled' : ''}>${running ? 'Checking…' : result ? 'Check again' : 'Check this save'}</button>
        <span style="font-size:0.82rem;color:var(--c-text-dim);">Finds ships, outfits, places, missions and events this save mentions that its plugins don't define.</span>
      </div>`;
    let body = '';
    if (result && result.noText) {
      body = `<p style="color:var(--c-text-mid);margin:10px 0 0;">Upload this save's .txt again (in the ✏️ Edit save tab) so it can be checked.</p>`;
    } else if (result) {
      const groups = {};
      for (const pr of result.problems) (groups[pr.label] = groups[pr.label] || []).push(pr);
      const notes = [];
      if (result.eventsSkipped) notes.push('Events weren’t checked — they need the parse workflow to have stored event definitions.');
      if (result.unavailable.length) notes.push(`Couldn’t load: ${result.unavailable.join(', ')}.`);
      if (!result.matchedCount && result.plugins.length) notes.push('None of this save’s plugins could be matched, so it was checked against every known plugin.');
      body = result.problems.length
        ? `<p style="margin:10px 0;color:var(--c-warn-text);">⚠ ${result.problems.length} of ${result.checked} names in this save aren’t defined by its plugins. The game drops or ignores these when it loads the save.</p>
           ${Object.entries(groups).map(([label, list]) => `
             <details style="margin-bottom:8px;" ${list.length <= 8 ? 'open' : ''}>
               <summary style="cursor:pointer;font-weight:600;">${h(label)} (${list.length})</summary>
               <ul style="margin:6px 0 0;padding-left:20px;font-size:0.88rem;color:var(--c-text-mid);">
                 ${list.map(pr => `<li><strong>${h(pr.name)}</strong> — ${h(pr.where.join(', '))}${pr.elsewhere.length
                   ? `<br><span style="color:var(--c-text-dim);">Defined by ${h(pr.elsewhere.join(', '))}, which this save doesn’t list.</span>`
                   : '<br><span style="color:var(--c-text-dim);">Not defined by any plugin this site knows.</span>'}</li>`).join('')}
               </ul></details>`).join('')}`
        : `<p style="margin:10px 0 0;color:var(--c-success-text);">✓ All ${result.checked} names in this save are defined by its plugins.</p>`;
      if (notes.length) body += `<p style="margin:8px 0 0;font-size:0.8rem;color:var(--c-text-dim);">${notes.map(h).join(' ')}</p>`;
    }
    p.innerHTML = head + body;
    document.getElementById('sh-run').onclick = () => run(saveId);
  }

  // run it (button)
  async function run(saveId) {
    render(saveId, resultsBySave.get(saveId), true);
    try {
      const r = await check(saveId);
      resultsBySave.set(saveId, r);
      if (saveId === currentSaveId) render(saveId, r, false);
    } catch (err) {
      console.error('[SaveHealth]', err);
      const p = ensurePanel();
      if (p) p.insertAdjacentHTML('beforeend', `<p style="color:var(--c-danger-text);">Health check failed: ${h(err.message)}</p>`);
    }
  }

  const origRender = window.renderResults;
  window.renderResults = function () {
    const r = origRender.apply(this, arguments);
    if (currentSaveId) render(currentSaveId, resultsBySave.get(currentSaveId), false);
    return r;
  };

  window.SaveHealthCheck = { check, collectReferences, invalidate: id => resultsBySave.delete(id) };
})();
