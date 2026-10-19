'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  autoFitting/afUI.js — the "⚡ Auto-fit" window in the ship builder
//
//  Pick a goal, choose which outfits count as "available to you" (factions,
//  buying, stealing with its story consequences, mission rewards, licences,
//  what you already own), set the turning/speed you won't go below, and it
//  builds the best fit it can for the hull you're editing — with the
//  stats before/after, where to get every outfit, what stealing would cost
//  and how to undo that, and warnings (energy, heat, fuel, ammo uptimes).
//
//  Needs: AfStats, AfPool, AfOptimizer, shipBuilder.js (sbCurrentShip …),
//         ShipDefinition (for enemy ships' loadouts).
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  const S = () => window.AfStats, P = () => window.AfPool, O = () => window.AfOptimizer;
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = (n, d = 0) => (Number.isFinite(n) ? n : 0).toLocaleString(undefined, { maximumFractionDigits: d });

  const GOALS = [
    ['counter', '🎯 Beat an enemy'], ['dps', '💥 Damage'], ['accel', '🚀 Acceleration'], ['speed', '⚡ Top speed'], ['tank', '🛡 Tank'],
    ['cargo', '📦 Cargo'], ['bunks', '🛏 Bunks'], ['general', '⚖ All-round'], ['custom', '🎛 Just my targets'],
  ];

  let ui = null;   // state while the window is open
  let lastTargets = [];   // targets carry over between openings on this page

  // Remembered between visits: never use secondary weapons, and outfits never to use.
  const PREFS_KEY = 'af_prefs_v1';
  function loadPrefs() { try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); return { noSecondary: !!p.noSecondary, exclude: Array.isArray(p.exclude) ? p.exclude : [] }; } catch (_) { return { noSecondary: false, exclude: [] }; } }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ noSecondary: ui.prefs.noSecondary, exclude: ui.prefs.exclude })); } catch (_) {} }

  // Small removable chip (ship or outfit name + ×)
  function chip(inner, act, name) {
    return `<span class="af-chip">${inner}<button type="button" class="af-chip__x" data-af="${act}" data-name="${h(name)}" aria-label="Remove ${h(name)}" title="Remove">×</button></span>`;
  }
  let styled = false;
  function addStyles() {
    if (styled) return; styled = true;
    const css = document.createElement('style');
    css.textContent = `
      .af-chip{display:inline-flex;align-items:center;gap:4px;margin:3px 4px 3px 0;padding:3px 4px 3px 10px;border-radius:999px;
        background:var(--c-surface-2, rgba(51,65,85,.55));border:1px solid var(--c-border, #334155);font-size:0.82rem;line-height:1.2;max-width:100%;}
      .af-chip__x{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;min-width:22px;min-height:22px;padding:0;
        border:0;border-radius:50%;background:transparent;color:var(--c-text-dim, #94a3b8);font-size:15px;line-height:1;cursor:pointer;}
      .af-chip__x:hover,.af-chip__x:focus-visible{background:rgba(239,68,68,.18);color:var(--c-danger-text, #f87171);outline:none;}
      @media (pointer: coarse){ .af-chip__x{width:28px;height:28px;min-width:28px;min-height:28px;} }
      .af-progress{margin-top:12px;}
      .af-progress__track{height:10px;border-radius:999px;background:var(--c-surface-2, rgba(51,65,85,.55));overflow:hidden;border:1px solid var(--c-border,#334155);}
      .af-progress__bar{height:100%;width:3%;border-radius:999px;background:linear-gradient(90deg,var(--c-accent,#3b82f6),#60a5fa);transition:width .25s ease;}
      .af-progress__row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px;font-size:0.84rem;color:var(--c-text-dim);}
      @media (prefers-reduced-motion: reduce){.af-progress__bar{transition:none;}}
      .af-excl-btn{border:0;background:transparent;color:var(--c-text-dim);cursor:pointer;font-size:0.76rem;padding:2px 6px;border-radius:6px;}
      .af-excl-btn:hover{color:var(--c-danger-text,#f87171);background:rgba(239,68,68,.12);}
    `;
    document.head.appendChild(css);
  }

  // ── data helpers ─────────────────────────────────────────────────────────
  function outfitIndex() {
    const m = new Map();
    for (const p of Object.values(window.AfStats.activeData())) for (const o of p.outfits || []) if (o && o.name && !m.has(o.name)) m.set(o.name, o);
    return m;
  }
  function designOutfits(design) {
    return (design.outfits || []).map(o => [String(o.name).replace(/^"([^"]*)"$/, '$1'), Number(o.count) || 1]);
  }
  function allShips() {
    const m = new Map();
    for (const p of Object.values(window.AfStats.activeData())) for (const s of [...(p.ships || []), ...(p.variants || [])]) if (s && s.name && !m.has(s.name)) m.set(s.name, s);
    return m;
  }
  function shipLoadout(s, ships) {
    const D = window.ShipDefinition;
    const outs = D ? D.outfitList(s.outfits) : [];
    const hull = s.baseShip ? ships.get(s.baseShip) : s;
    return { base: S().hullAttrs(hull || s), outs };
  }
  /** Damage mix of chosen enemies (or of every armed ship, weighted by damage). */
  function enemyProfile(names) {
    const ships = allShips(), idx = outfitIndex();
    const pick = names && names.length ? names.map(n => ships.get(n)).filter(Boolean) : [...ships.values()];
    const ds = [];
    for (const s of pick) {
      try { const { base, outs } = shipLoadout(s, ships); const d = S().derive(base, outs, idx); if (d.dps.total > 0) ds.push(d); } catch (_) {}
    }
    return O().damageProfile(ds);
  }

  // Ship names as players know them: display name first, internal name after.
  const SN = () => window.ShipNames;
  const shipLabel = name => { const s = allShips().get(name); return s && SN() ? SN().label(s) : name; };
  const outfitHtml = name => (window.OutfitNames ? window.OutfitNames.html(name) : h(name));
  const shipHtml = name => { const s = allShips().get(name); return s && SN() ? SN().html(s) : h(name); };
  // Type-ahead for ships: matches the display name or the internal name, and
  // lists the display name first with the internal name dimmed underneath.
  function shipSearch(q) {
    if (window.NameSearch) return window.NameSearch.search('ships', q);
    const SNs = SN(), out = [];
    for (const s of allShips().values()) {
      const label = SNs ? SNs.label(s) : s.name, internal = SNs ? SNs.internal(s) : '';
      const score = window.UiKit ? Math.max(window.UiKit.match(q, label), internal ? window.UiKit.match(q, internal) * 0.9 : 0)
                                 : ((label + ' ' + internal).toLowerCase().includes(q.toLowerCase()) ? 1 : 0);
      if (score > 0) out.push([score, { value: s.name, label, sub: [internal, s.attributes?.category].filter(Boolean).join(' · ') }]);
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, 50).map(x => x[1]);
  }
  function outfitSearch(q) {
    if (window.NameSearch) return window.NameSearch.search('outfits', q).filter(it => !ui.prefs.exclude.includes(it.value));
    const out = [];
    for (const o of ui.idx.values()) {
      if (ui.prefs.exclude.includes(o.name)) continue;
      const sc = window.UiKit ? window.UiKit.match(q, o.name) : (o.name.toLowerCase().includes(q.toLowerCase()) ? 1 : 0);
      if (sc > 0) out.push([sc, { value: o.name, label: o.name, sub: o.category || (o.attributes && o.attributes.category) || '' }]);
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, 50).map(x => x[1]);
  }
  function bindShipPickers() {
    if (!window.UiKit) return;
    const tg = document.getElementById('af-tgt-add');
    if (tg) window.UiKit.combobox(tg, { source: async q => targetSearch(q), placeholderEmpty: 'Nothing matches',
      onPick: it => {
        tg.value = '';
        const now = S().statValue(ui.current, it.value);
        ui.targets.push({ id: it.value, mode: 'min', value: Math.round(now * 100) / 100, priority: 'normal' });
        lastTargets = ui.targets.map(x => ({ ...x })); ui.result = null; render();
      } });
    const ex = document.getElementById('af-excl-add');
    if (ex) window.UiKit.combobox(ex, { source: async q => outfitSearch(q), placeholderEmpty: 'No outfits match',
      onPick: it => { ex.value = ''; if (!ui.prefs.exclude.includes(it.value)) { ui.prefs.exclude.push(it.value); savePrefs(); } ui.result = null; render(); } });
    const hook = (id, onPick) => { const el = document.getElementById(id); if (el) window.UiKit.combobox(el, { source: async q => shipSearch(q), onPick: it => { el.value = ''; onPick(it.value); }, placeholderEmpty: 'No ships match' }); };
    hook('af-foe-add', name => { if (!ui.foe.ships.includes(name)) ui.foe.ships.push(name); refreshFoe(); render(); });
    hook('af-enemy-add', name => { if (!ui.enemies.includes(name)) ui.enemies.push(name); ui.result = null; render(); });
  }

  // ── window ───────────────────────────────────────────────────────────────
  function modal() {
    let m = document.getElementById('af-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'af-modal'; m.className = 'modal-overlay';
    m.innerHTML = `<div class="modal-box" style="width:min(760px,96vw);max-height:92dvh;overflow-y:auto;">
      <div class="modal-header"><div class="modal-title">⚡ Auto-fit</div>
        <button class="modal-close" data-af="close" aria-label="Close">×</button></div>
      <div id="af-body"></div></div>`;
    m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-af="close"]')) return close();
      const b = e.target.closest('[data-af]');
      if (!b) return;
      const act = b.dataset.af;
      if (act === 'goal') { ui.goal = b.dataset.goal; ui.result = null; render(); }
      else if (act === 'run') run();
      else if (act === 'apply') apply();
      else if (act === 'battle') testInBattle();
      else if (act === 'cancel') cancelRun();
      else if (act === 'share') shareFit();
      else if (act === 'fac-all') { ui.factions = new Set(ui.ctx.factions.map(f => f.name)); render(); }
      else if (act === 'fac-none') { ui.factions = new Set(); render(); }
      else if (act === 'fac-visited') { ui.factions = new Set(ui.ctx.factions.filter(f => f.visited).map(f => f.name)); render(); }
      else if (act === 'enemy-rm') { ui.enemies = ui.enemies.filter(n => n !== b.dataset.name); ui.result = null; render(); }
      else if (act === 'tgt-rm') { ui.targets.splice(Number(b.dataset.i), 1); lastTargets = ui.targets.map(x => ({ ...x })); ui.result = null; render(); }
      else if (act === 'tgt-up') { const i = Number(b.dataset.i); if (i > 0) { [ui.targets[i - 1], ui.targets[i]] = [ui.targets[i], ui.targets[i - 1]]; lastTargets = ui.targets.map(x => ({ ...x })); render(); } }
      else if (act === 'excl-rm') { ui.prefs.exclude = ui.prefs.exclude.filter(n => n !== b.dataset.name); savePrefs(); render(); }
      else if (act === 'excl-clear') { ui.prefs.exclude = []; savePrefs(); render(); }
      else if (act === 'excl-add') {
        const n = b.dataset.name;
        if (n && !ui.prefs.exclude.includes(n)) { ui.prefs.exclude.push(n); savePrefs(); }
        ui.notice = `“${n}” won't be used any more — press Fit again for a fit without it.`;
        render();
      }
      else if (act === 'foe-rm') { ui.foe.ships = ui.foe.ships.filter(n => n !== b.dataset.name); refreshFoe(); render(); }
    });
    m.addEventListener('change', e => {
      const t = e.target;
      if (!ui) return;
      if (t.dataset.fac) { t.checked ? ui.factions.add(t.dataset.fac) : ui.factions.delete(t.dataset.fac); return; }
      if (t.id === 'af-weapons') ui.opts.weapons = t.value;
      else if (t.id === 'af-nosec') {
        ui.prefs.noSecondary = t.checked; savePrefs();
        if (t.checked && ui.opts.weapons !== 'primary') ui.opts.weapons = 'primary';
        ui.result = null; render();
      }
      else if (t.dataset.tgt != null) {
        const tg = ui.targets[Number(t.dataset.tgt)]; if (!tg) return;
        tg[t.dataset.field] = t.dataset.field === 'value' ? Number(t.value) : t.value;
        lastTargets = ui.targets.map(x => ({ ...x })); ui.result = null;
        if (t.dataset.field === 'mode') render();
        return;
      }
      else if (t.id === 'af-fight') ui.opts.fightSeconds = Math.max(5, Number(t.value) || 60);
      else if (t.name && t.name.startsWith('af-f-')) {
        ui.filters[t.name.slice(5)] = t.type === 'checkbox' ? t.checked : t.value;
        if (t.name === 'af-f-allowPlunder') render();   // shows/hides the stealing policy
      }
      else if (t.id === 'af-foe-gov') { ui.foe.government = t.value; ui.foe.ships = []; refreshFoe(); render(); }

      else if (t.id === 'af-foe-count') { ui.foe.count = Math.max(1, Math.min(10, Number(t.value) || 1)); ui.result = null; }
      else if (t.id === 'af-foe-speed') { ui.foe.matchSpeed = t.checked; ui.result = null; }

    });
    document.body.appendChild(m);
    return m;
  }
  function close() { runId++; if (worker) { worker.terminate(); worker = null; } document.getElementById('af-modal')?.classList.remove('active'); ui = null; }

  async function open() {
    if (!S() || !P() || !O()) return;
    if (typeof onBuilderChange === 'function') onBuilderChange();
    const design = typeof sbCurrentShip !== 'undefined' ? sbCurrentShip : null;
    if (!design) return;
    const base = S().hullAttrs(design);
    const idx = outfitIndex();
    const current = S().derive(base, designOutfits(design), idx);
    ui = {
      design, base, idx, current, ctx: null, loading: true, result: null, goal: 'general', enemies: [],
      opts: { weapons: 'both', minTurn: 0, minSpeed: 0, minCargo: 0, fightSeconds: 60 },
      peers: null,
      foe: { government: '', ships: [], count: 2, matchSpeed: false, profile: null, describe: null },
      prefs: loadPrefs(),
      filters: { allowBuy: true, visitedOnly: false, allowPlunder: false, plunderPolicy: 'fixable', allowMissions: false, requireLicences: true, includeOwned: true },
      factions: null,
    };
    // Handling to aim for: what similar ships (class & weight) manage, not a fixed number
    try { ui.peers = window.AfPeers ? window.AfPeers.reference(design) : null; } catch (_) { ui.peers = null; }
    // No preset limits: each goal does its best on its own; anything else is a target you add.
    ui.targets = lastTargets.map(t => ({ ...t }));
    addStyles();
    if (ui.prefs.noSecondary) ui.opts.weapons = 'primary';
    modal().classList.add('active');
    render();
    try { ui.ctx = await P().load(); }
    catch (err) { ui.error = 'Could not load outfit availability: ' + err.message; }
    if (!ui) return;
    ui.loading = false;
    const visited = ui.ctx?.factions.filter(f => f.visited).map(f => f.name) || [];
    ui.factions = new Set(visited.length ? visited : (ui.ctx?.factions || []).map(f => f.name));
    ui.filters.visitedOnly = false;
    render();
  }

  // ── render ───────────────────────────────────────────────────────────────
  function render() {
    const body = document.getElementById('af-body');
    if (!ui || !body) return;
    const c = ui.current, d = ui.design, save = ui.ctx?.save;
    const tab = ([id, label]) => `<button class="btn btn-${ui.goal === id ? 'primary' : 'secondary'} btn-sm" data-af="goal" data-goal="${id}">${label}</button>`;
    const chk = (k, label, hint) => `<label style="display:flex;gap:8px;align-items:flex-start;margin:4px 0;font-size:0.86rem;">
      <input type="checkbox" name="af-f-${k}"${ui.filters[k] ? ' checked' : ''}><span>${label}${hint ? `<span style="display:block;font-size:0.76rem;color:var(--c-text-dim);">${hint}</span>` : ''}</span></label>`;
    const T = window.AfThreat;
    const goalOptions = {
      counter: !T ? '' : (() => {
        const govs = T.governments();
        const f = ui.foe;
        return `<div style="font-size:0.86rem;">
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
            <label>Government <select id="af-foe-gov" class="text-input" style="width:auto;display:inline-block;">
              <option value="">— pick one —</option>
              ${govs.map(g => `<option value="${h(g.name)}"${f.government === g.name ? ' selected' : ''}>${h(g.name)} (${g.ships} ships)</option>`).join('')}</select></label>
            <span style="color:var(--c-text-dim);">or specific ships:</span>
            <span style="display:inline-block;min-width:220px;max-width:320px;flex:1;"><input id="af-foe-add" class="text-input" placeholder="Add a ship…" autocomplete="off"></span>
          </div>
          ${f.ships.length ? `<div style="margin-top:6px;">${f.ships.map(n => chip(shipHtml(n), 'foe-rm', n)).join('')}</div>` : ''}
          ${!govs.length ? '<div style="color:var(--c-warn-text,#fbbf24);margin-top:6px;">No government data yet — run the Parse workflow once, or add specific ships.</div>' : ''}
          <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;">
            <label>How many at once <input id="af-foe-count" type="number" min="1" max="10" class="text-input" value="${f.count}" style="width:64px;display:inline-block;"></label>
            ${f.profile ? `<label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="af-foe-speed"${f.matchSpeed ? ' checked' : ''}> At least as fast as them (~${fmt(f.profile.defence.speed)}) — so they can't run or chase you down</label>` : ''}
          </div>
          ${f.profile ? `<div style="margin-top:10px;padding:10px 12px;border:1px solid var(--c-border);border-radius:8px;">
            <div style="font-weight:600;margin-bottom:4px;">What you're up against (${f.profile.count} ship${f.profile.count === 1 ? '' : 's'})</div>
            <ul style="margin:0;padding-left:18px;">${f.describe.lines.map(l => `<li>${h(l)}</li>`).join('')}</ul>
            ${f.describe.priorities.length ? `<div style="margin-top:6px;">The fit will look for: <strong>${h(f.describe.priorities.join(', '))}</strong> — and weapons that suit their shields and hull.</div>` : ''}
            <div style="margin-top:4px;color:var(--c-text-dim);font-size:0.78rem;">Hardest hitters: ${f.profile.worst.map(w => h(shipLabel(w.name))).join(', ')}</div>
          </div>` : (f.government || f.ships.length ? '<p style="color:var(--c-text-dim);">None of those ships could be measured.</p>' : '')}
        </div>`;
      })(),
      dps: `<label style="font-size:0.86rem;">Weapons <select id="af-weapons" class="text-input" style="width:auto;display:inline-block;margin-left:6px;">
          ${[['both', 'Primary and secondary'], ['primary', 'Primary only (guns & turrets)'], ['secondary', 'Secondary only (missiles, launchers)']]
            .map(([v, l]) => `<option value="${v}"${ui.opts.weapons === v ? ' selected' : ''}${ui.prefs.noSecondary && v !== 'primary' ? ' disabled' : ''}>${l}</option>`).join('')}</select></label>
          ${ui.prefs.noSecondary ? '<span style="font-size:0.78rem;color:var(--c-text-dim);margin-left:6px;">(secondary weapons are switched off below)</span>' : ''}`,
      tank: `<div style="font-size:0.86rem;">Protect against
          ${ui.enemies.length ? ui.enemies.map(n => chip(shipHtml(n), 'enemy-rm', n)).join('') : '<em style="color:var(--c-text-dim);">the average damage of every armed ship</em>'}
          <div style="margin-top:6px;max-width:360px;"><input id="af-enemy-add" class="text-input" placeholder="Add an enemy ship…" autocomplete="off"></div></div>`,
    };
    body.innerHTML = `
      <p style="margin:0 0 10px;font-size:0.86rem;color:var(--c-text-mid);">Fitting <strong>${h(d.name || 'this ship')}</strong>${d._sourceShip ? ` (${h(shipLabel(d._sourceShip))} hull)` : ''}.
        ${save ? `Using <strong>${h(save.pilot)}</strong>'s save for what you can reach.` : 'Open a save on Saves &amp; Account and it will use where you\'ve been, your licences and reputations.'}
        <span style="display:block;font-size:0.78rem;color:var(--c-text-dim);">Only outfits and ships from your selected plugins are used (${Object.keys(window.AfStats.activeData()).filter(k => k !== '__local_builds__').map(h).join(', ') || 'none'}) — change them with ☰ Select Plugins.</span></p>
      ${missingHull().length ? `<p style="margin:0 0 10px;padding:8px 10px;border:1px solid var(--c-warn-text,#fbbf24);border-radius:8px;font-size:0.84rem;">
        ⚠ Auto-fit needs a hull to work with. This ship is missing: <strong>${missingHull().map(h).join(', ')}</strong>.
        Set them in the Attributes section, or use ✏️ Edit Existing / 🔧 Outfit Existing to start from a game ship.</p>` : ''}
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">${GOALS.map(tab).join('')}</div>
      ${goalOptions[ui.goal] || ''}

      ${targetsHtml()}

      <details style="margin-top:12px;"><summary style="cursor:pointer;font-weight:600;">Settings</summary>
        <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:0.86rem;">
          <label>Fight length <input id="af-fight" type="number" class="text-input" value="${ui.opts.fightSeconds}" style="width:70px;display:inline-block;"> s</label>
        </div>
        <div style="font-size:0.76rem;color:var(--c-text-dim);margin-top:4px;">Batteries may cover a fight that long; flying around must be sustainable.</div>
      </details>
      ${ui.goal === 'general' ? `<div style="font-size:0.78rem;color:var(--c-text-dim);margin-top:8px;">${peerNote()}</div>` : ''}

      <details style="margin-top:10px;" ${ui.result ? '' : 'open'}><summary style="cursor:pointer;font-weight:600;">Outfits to leave out${ui.prefs.noSecondary || ui.prefs.exclude.length ? ` (${[ui.prefs.noSecondary && 'no secondaries', ui.prefs.exclude.length && `${ui.prefs.exclude.length} excluded`].filter(Boolean).join(', ')})` : ''}</summary>
        <label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0 4px;font-size:0.86rem;">
          <input type="checkbox" id="af-nosec"${ui.prefs.noSecondary ? ' checked' : ''}>
          <span>Don't use secondary weapons<span style="display:block;font-size:0.76rem;color:var(--c-text-dim);">No missiles, rockets, torpedoes or other launchers (or their ammunition), for every goal. Anti-missile turrets still count.</span></span></label>
        <div style="font-size:0.86rem;margin-top:8px;">Never use these outfits:</div>
        <div style="margin:4px 0;">${ui.prefs.exclude.length ? ui.prefs.exclude.map(n => chip(outfitHtml(n), 'excl-rm', n)).join('') + ' <button class="btn btn-secondary btn-sm" data-af="excl-clear">Clear all</button>' : '<em style="color:var(--c-text-dim);font-size:0.82rem;">none yet — add any you don\'t want here, or press “Exclude” next to an outfit in a result</em>'}</div>
        <div style="max-width:360px;"><input id="af-excl-add" class="text-input" placeholder="Add an outfit to leave out…" autocomplete="off"></div>
        <div style="font-size:0.76rem;color:var(--c-text-dim);margin-top:4px;">Remembered on this device for every ship you fit.</div>
      </details>

      <details style="margin-top:10px;" ${ui.result ? '' : 'open'}><summary style="cursor:pointer;font-weight:600;">Where outfits can come from</summary>
        ${ui.loading ? '<p>Loading what\'s available…</p>' : ui.error ? `<p style="color:var(--c-danger-text);">${h(ui.error)}</p>` : `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:4px 16px;margin-top:6px;">
          <div>
            ${chk('allowBuy', 'Buy from outfitters')}
            ${save ? chk('visitedOnly', 'Only outfitters I\'ve visited') : ''}
            ${chk('allowPlunder', 'Steal (plunder) from ships', 'Boarding or destroying ships costs reputation with whoever flies them.')}
            ${ui.filters.allowPlunder ? `<select name="af-f-plunderPolicy" class="text-input" style="margin:2px 0 6px 28px;width:calc(100% - 28px);">
              ${[['safe', 'Only when it costs nothing (they\'re already hostile)'], ['fixable', 'Also when a story mission I haven\'t done repairs it'], ['any', 'Anything — I don\'t mind the reputation hit']]
                .map(([v, l]) => `<option value="${v}"${ui.filters.plunderPolicy === v ? ' selected' : ''}>${l}</option>`).join('')}</select>` : ''}
            ${chk('allowMissions', 'Mission rewards')}
            ${save ? chk('requireLicences', 'Only outfits my licences allow') : ''}
            ${save ? chk('includeOwned', 'Outfits I already own') : ''}
          </div>
          <div>
            <div style="font-size:0.86rem;margin:4px 0;">Factions / species
              <button class="btn btn-secondary btn-sm" data-af="fac-all">All</button>
              <button class="btn btn-secondary btn-sm" data-af="fac-none">None</button>
              ${save ? '<button class="btn btn-secondary btn-sm" data-af="fac-visited">Ones I\'ve met</button>' : ''}</div>
            <div style="max-height:150px;overflow-y:auto;border:1px solid var(--c-border);border-radius:6px;padding:4px 8px;">
              ${ui.ctx.factions.map(f => `<label style="display:flex;gap:6px;align-items:center;font-size:0.82rem;margin:2px 0;">
                <input type="checkbox" data-fac="${h(f.name)}"${ui.factions.has(f.name) ? ' checked' : ''}> ${h(f.name)}
                <span style="color:var(--c-text-dim);">${f.count}${f.visited ? ' · met' : ''}</span></label>`).join('')}
            </div>
          </div>
        </div>`}
      </details>

      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
        <button class="btn btn-primary" data-af="run"${ui.loading ? ' disabled' : ''}>${ui.running ? 'Working…' : ui.result ? 'Fit again' : 'Find the best fit'}</button>
        ${ui.result ? '<button class="btn btn-secondary" data-af="apply">Use this fit</button>' : ''}
        ${ui.result ? '<button class="btn btn-secondary" data-af="battle" title="Fight it in the Battle Simulator (opens a new tab)">⚔ Test in Battle Simulator</button>' : ''}
        ${ui.result ? '<button class="btn btn-secondary" data-af="share" title="Copy a link that opens this fit — no account needed">🔗 Share this fit</button>' : ''}
      </div>
      ${ui.running ? `<div class="af-progress" role="progressbar" aria-label="Auto-fit progress" aria-valuemin="0" aria-valuemax="100">
          <div class="af-progress__track"><div class="af-progress__bar" id="af-progress-bar" style="width:${ui.progressPct || 3}%"></div></div>
          <div class="af-progress__row"><span id="af-progress-text">${h(ui.progressText || 'Starting…')}</span>
            <button type="button" class="af-excl-btn" data-af="cancel">Cancel</button></div>
        </div>` : ''}
      ${ui.notice ? `<p style="color:var(--c-warn-text,#fbbf24);margin:8px 0 0;">${h(ui.notice)}</p>` : ''}
      <div id="af-result">${ui.result && !ui.running ? resultHtml() : ''}</div>`;
    bindShipPickers();
  }

  // ── Targets: any stat or attribute, at least / at most / about / as much / as little ──
  const MODES = [['min', 'at least'], ['max', 'at most'], ['near', 'as close as possible to'], ['more', 'as much as possible'], ['less', 'as little as possible']];
  const PRIOS = [['must', 'Must'], ['high', 'High'], ['normal', 'Normal'], ['low', 'Low']];
  function targetsHtml() {
    const rows = ui.targets.map((t, i) => {
      const now = S().statValue(ui.current, t.id);
      const needsValue = t.mode !== 'more' && t.mode !== 'less';
      return `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0;padding:6px 8px;border:1px solid var(--c-border);border-radius:8px;">
        <strong style="flex:1 1 180px;font-size:0.86rem;">${h(S().statLabel(t.id))} <span style="font-weight:400;color:var(--c-text-dim);font-size:0.76rem;">now ${fmt(now, 1)}</span></strong>
        <span style="display:flex;gap:6px;align-items:center;flex:0 1 auto;flex-wrap:nowrap;max-width:100%;">
        <select class="text-input" style="width:auto;min-width:0;" data-tgt="${i}" data-field="mode" aria-label="How">${MODES.map(([v, l]) => `<option value="${v}"${t.mode === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        ${needsValue ? `<input type="number" class="text-input" style="width:96px;min-width:0;" data-tgt="${i}" data-field="value" value="${h(t.value ?? '')}" aria-label="Value">` : ''}
        <select class="text-input" style="width:auto;" data-tgt="${i}" data-field="priority" aria-label="Priority" title="How much this matters">${PRIOS.map(([v, l]) => `<option value="${v}"${(t.priority || 'normal') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <span style="display:inline-flex;width:24px;justify-content:center;">${i > 0 ? `<button type="button" class="af-excl-btn" data-af="tgt-up" data-i="${i}" title="Move up (more important)">↑</button>` : ''}</span>
        <button type="button" class="af-chip__x" data-af="tgt-rm" data-i="${i}" aria-label="Remove target" title="Remove">×</button>
        </span>
      </div>`;
    }).join('');
    return `<details style="margin-top:12px;" ${ui.targets.length || ui.goal === 'custom' ? 'open' : ''}><summary style="cursor:pointer;font-weight:600;">🎯 Targets${ui.targets.length ? ` (${ui.targets.length})` : ' (optional)'}</summary>
      <div style="font-size:0.78rem;color:var(--c-text-dim);margin:6px 0;">Leave empty and the goal does its best on its own. Add anything you care about — e.g. <em>Damage / s at least 5,000</em>, <em>Turning as close as possible to 90</em>, <em>Cargo as much as possible</em> — and give each a priority.</div>
      ${rows}
      <div style="max-width:380px;margin-top:6px;"><input id="af-tgt-add" class="text-input" placeholder="＋ Add a target: damage, turning, cargo, any attribute…" autocomplete="off"></div>
      ${ui.goal === 'custom' && !ui.targets.length ? '<div style="color:var(--c-warn-text,#fbbf24);font-size:0.82rem;margin-top:6px;">“Just my targets” needs at least one target.</div>' : ''}
    </details>`;
  }
  function targetSearch(q) {
    const out = [];
    const U = window.UiKit;
    for (const st of S().STATS) {
      const sc = U ? U.match(q, st.label) : (st.label.toLowerCase().includes(q.toLowerCase()) ? 1 : 0);
      if (sc > 0) out.push([sc + 100, { value: st.id, label: st.label, sub: `now ${fmt(S().statValue(ui.current, st.id), 1)}${st.unit ? ' ' + st.unit : ''}` }]);
    }
    // any numeric attribute the hull or an outfit has
    const keys = new Set(Object.keys(ui.current.raw || {}));
    for (const o of ui.idx.values()) for (const [k, v] of Object.entries(o.attributes || o)) if (typeof v === 'number') keys.add(k);
    for (const k of keys) {
      if (['index', 'cost', 'mass'].includes(k)) continue;
      const sc = U ? U.match(q, k) : (k.toLowerCase().includes(q.toLowerCase()) ? 1 : 0);
      if (sc > 0) out.push([sc, { value: 'attr:' + k, label: k, sub: `attribute · now ${fmt(ui.current.raw[k] || 0, 2)}` }]);
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, 50).map(x => x[1]);
  }

  function peerNote() {
    const p = ui.peers;
    if (!p) return 'All-round compares against this ship\'s own stock loadout (no similar ships to compare with).';
    const src = Object.entries(p.bySource).filter(([, n]) => n).map(([k, n]) => `${n} ${k === 'game' ? 'base game' : k === 'plugin' ? 'plugin' : 'of your own'}`).join(', ');
    const t = Math.round(p.turn), sp = Math.round(p.speed);
    const why = p.basis === 'same class and weight' ? `${h(p.category)}s weighing ${fmt(p.mass.min)}–${fmt(p.mass.max)} t`
      : p.basis === 'same class' ? `${h(p.category)}s (no others this weight)` : `ships weighing ${fmt(p.mass.min)}–${fmt(p.mass.max)} t`;
    return `All-round scores damage, speed, turning, toughness and cargo against similar ships — ${p.count} ${why} (${src}); typically turning ${t}°/s, top speed ${sp}, cargo ${fmt(p.cargo)}. Closest: ${p.examples.map(n => h(shipLabel(n))).join(', ')}.`;
  }

  function checksHtml(r) {
    if (!r.checks) return '';
    const bad = r.checks.filter(c => !c.ok);
    return `<details style="margin:12px 0 0;" ${bad.length ? 'open' : ''}><summary style="cursor:pointer;font-weight:600;font-size:0.9rem;">
        ${bad.length ? `⚠ ${bad.length} check${bad.length === 1 ? '' : 's'} failed` : '✅ Passed every check'} — tested before showing you</summary>
      ${r.repaired ? `<div style="font-size:0.8rem;color:var(--c-text-dim);margin:4px 0;">The first fit failed “${h(r.repaired.join('”, “'))}”, so it was fitted again to fix that.</div>` : ''}
      <ul style="margin:6px 0 0;padding-left:0;list-style:none;font-size:0.84rem;">${r.checks.map(c => `<li>${c.ok ? '✅' : '❌'} ${h(c.label)} <span style="color:var(--c-text-dim);">— ${h(c.detail)}</span></li>`).join('')}</ul>
      <div style="font-size:0.78rem;color:var(--c-text-dim);margin-top:4px;">Want to see it fight? Use ⚔ Test in Battle Simulator.</div>
    </details>`;
  }

  // Send the fit (and what it's up against) to the battle simulator.
  // The design with this result's outfits (and weapons on the hardpoints)
  function fitDesign() {
    const d = JSON.parse(JSON.stringify(ui.design));
    d.outfits = ui.result.outfits.map(([name, count]) => ({ name, count }));
    for (const hp of [...(d.guns || []), ...(d.turrets || [])]) hp.over = '';
    const weaponsLeft = new Map(ui.result.outfits);
    const slot = (list, isTurret) => { for (const hp of list || []) for (const [n, k] of weaponsLeft) {
      const o = ui.idx.get(n) || {}; const a = o.attributes || o;
      if (k > 0 && (a.weapon || o.weapon) && ((Number(a['turret mounts']) || 0) < 0) === isTurret) { hp.over = n; weaponsLeft.set(n, k - 1); break; } } };
    slot(d.guns, false); slot(d.turrets, true);
    d.name = `${d.name || 'Ship'} (auto-fit)`;
    return d;
  }
  function shareFit() {
    if (!ui || !ui.result || typeof window.sbShareShip !== 'function') return;
    window.sbShareShip(fitDesign(), 'this auto-fit');
  }

  function testInBattle() {
    if (!ui || !ui.result) return;
    const d = fitDesign();
    let opponents, opponentLabel;
    if (ui.goal === 'counter' && ui.foe.profile) {
      const names = ui.foe.ships.length ? ui.foe.ships : ui.foe.profile.worst.map(w => w.name);
      // "How many at once": that many enemies, taking the chosen ships in turn
      const tally = new Map();
      for (let i = 0; i < Math.max(1, ui.foe.count); i++) { const n = names[i % names.length]; tally.set(n, (tally.get(n) || 0) + 1); }
      opponents = [...tally].map(([name, count]) => ({ name, count }));
      opponentLabel = ui.foe.ships.length ? 'Your chosen enemies' : `${ui.foe.government} (hardest hitters)`;
    } else {
      const stock = ui.design._sourceShip || ui.design.name;
      opponents = [{ name: stock, count: 1 }];
      opponentLabel = `${shipLabel(stock)} (stock)`;
    }
    try { localStorage.setItem('ES_BS_PENDING', JSON.stringify({ fit: d, fitLabel: d.name, opponents, opponentLabel })); } catch (_) {}
    window.open('BattleSim.html', '_blank');
  }

  function targetsResultHtml(d) {
    if (!ui.targets.length) return '';
    const label = { min: 'at least', max: 'at most', near: 'about', more: 'as much as possible', less: 'as little as possible' };
    const rows = ui.targets.map(t => {
      const x = S().statValue(d, t.id), now = S().statValue(ui.current, t.id), v = Number(t.value) || 0;
      let ok;
      if (t.mode === 'min') ok = x >= v - 1e-6; else if (t.mode === 'max') ok = x <= v + 1e-6;
      else if (t.mode === 'near') ok = Math.abs(x - v) <= Math.max(1, Math.abs(v)) * 0.05;
      else ok = t.mode === 'more' ? x >= now : x <= now;
      const close = !ok && t.mode !== 'more' && t.mode !== 'less' && Math.abs(x - v) <= Math.max(1, Math.abs(v)) * 0.15;
      return `<tr><td style="padding:3px 8px 3px 0;">${ok ? '✅' : close ? '🟡' : '❌'} ${h(S().statLabel(t.id))}</td>
        <td style="color:var(--c-text-dim);">${label[t.mode]}${t.mode === 'more' || t.mode === 'less' ? '' : ' ' + fmt(v, 1)} · ${h((PRIOS.find(p => p[0] === (t.priority || 'normal')) || [, 'Normal'])[1])}</td>
        <td style="text-align:right;font-weight:600;">${fmt(x, 1)}</td></tr>`;
    }).join('');
    return `<h4 style="margin:14px 0 4px;font-size:0.9rem;">Your targets</h4><div style="overflow-x:auto;"><table style="width:100%;font-size:0.84rem;">${rows}</table></div>`;
  }

  function statRows(a, b, peer) {
    const P = peer || {};
    const rows = [
      ['Damage / s', a.dps.total, b.dps.total], ['  primary', a.dps.primary, b.dps.primary], ['  secondary', a.dps.secondary, b.dps.secondary],
      ['Top speed', a.maxSpeed, b.maxSpeed], ['Acceleration', a.acceleration, b.acceleration], ['Turning °/s', a.turnRate, b.turnRate],
      ['Shields', a.shields, b.shields], ['Shield regen / s', a.shieldRegen, b.shieldRegen], ['Hull', a.hull, b.hull], ['Hull repair / s', a.hullRegen, b.hullRegen],
      ['Cargo', a.cargo, b.cargo], ['Bunks', a.bunks, b.bunks], ['Jumps of fuel', a.fuel.jumps, b.fuel.jumps],
      ['Energy / s in a fight', a.energy.perSec.fighting, b.energy.perSec.fighting], ['Heat in a fight', a.heat.equilibriumPct.fighting, b.heat.equilibriumPct.fighting, '%'],
      ['Outfit cost', a.cost, b.cost],
    ];
    const typical = { 'Damage / s': P.dps, 'Top speed': P.speed, 'Acceleration': P.accel, 'Turning °/s': P.turn,
                      'Shields': P.shields, 'Hull': P.hull, 'Cargo': P.cargo, 'Bunks': P.bunks };
    return rows.map(([l, x, y, unit]) => {
      const diff = y - x, better = l.startsWith('Heat') || l === 'Outfit cost' ? diff < 0 : diff > 0;
      const t = typical[l];
      const peerCell = peer ? `<td style="text-align:right;color:var(--c-text-dim);">${t != null ? fmt(t, 0) : ''}</td>` : '';
      return `<tr><td style="padding:3px 8px 3px 0;">${h(l)}</td><td style="text-align:right;">${fmt(x, 1)}${unit || ''}</td>
        <td style="text-align:right;font-weight:600;">${fmt(y, 1)}${unit || ''}</td>${peerCell}
        <td style="text-align:right;color:${Math.abs(diff) < 1e-6 ? 'var(--c-text-dim)' : better ? 'var(--c-success-text, #4ade80)' : 'var(--c-danger-text, #f87171)'};">${Math.abs(diff) < 1e-6 ? '—' : (diff > 0 ? '+' : '') + fmt(diff, 1)}</td></tr>`;
    }).join('');
  }

  // For outfits that add room (outfit space, weapon/engine capacity, mounts …):
  // what they add and what they cost, so it's clear why they're in the fit.
  const ROOM_KEYS = ['outfit space', 'weapon capacity', 'engine capacity', 'gun ports', 'turret mounts', 'cargo space', 'bunks'];
  function expanderNote(name) {
    const o = ui.idx.get(name) || {};
    const a = o.attributes || o;
    const adds = Object.entries(a).filter(([k, v]) => typeof v === 'number' && v > 0 && (ROOM_KEYS.includes(k) || / capacity$/.test(k)) && k !== 'energy capacity' && k !== 'fuel capacity');
    if (!adds.length) return '';
    const costs = Object.entries(a).filter(([k, v]) => typeof v === 'number' && v < 0 && k !== 'cost');
    return `Adds ${adds.map(([k, v]) => `+${fmt(v, 4)} ${k}`).join(', ')}${costs.length ? ` · costs ${costs.map(([k, v]) => `${fmt(v, 4)} ${k}`).join(', ')}` : ''}`;
  }

  function resultHtml() {
    const r = ui.result, d = r.derived;
    const icon = { buy: '🛒', plunder: '⚔', mission: '📜', owned: '📦', keep: '📌' };
    const rows = r.outfits.map(([n, k]) => {
      const src = r.access.get(n) || {};
      const ex = expanderNote(n);
      return `<tr><td style="padding:3px 8px 3px 0;">${k}× ${outfitHtml(n)}${ex ? `<span style="display:block;font-size:0.74rem;color:var(--c-text-dim);">${h(ex)}</span>` : ''}</td><td style="font-size:0.78rem;color:var(--c-text-dim);">${icon[src.how] || ''} ${h(src.note || '')}</td>
        <td style="text-align:right;white-space:nowrap;"><button type="button" class="af-excl-btn" data-af="excl-add" data-name="${h(n)}" title="Never use this outfit">Exclude</button></td></tr>`;
    }).join('');
    const steals = [...r.access.values()].filter(a => a.how === 'plunder' && a.steal);
    const stealNotes = [...new Map(steals.map(a => [a.steal.gov, a.steal])).values()].map(v => {
      if (v.status === 'hostile') return `<li>Stealing from <strong>${h(v.gov)}</strong> ships costs nothing more — you're already hostile to them (reputation ${fmt(v.rep, 1)}).</li>`;
      if (v.status === 'fixable') return `<li>Stealing from <strong>${h(v.gov)}</strong> ships lowers your reputation with them, but you can repair it:
        ${v.fix.map(f => `<em>${h(f.label)}</em> (${f.kind}${f.op === '+=' ? `, +${f.value}` : `, sets it to ${f.value}`}${f.via && f.via.length ? `, started by ${h(f.via.join(' / '))}` : ''})`).join('; ')} — you haven't done ${v.fix.length === 1 ? 'it' : 'these'} yet.</li>`;
      if (v.status === 'costly') return `<li>Stealing from <strong>${h(v.gov)}</strong> ships lowers your reputation with them, and nothing left in your story raises it again.</li>`;
      return `<li>Stealing from <strong>${h(v.gov)}</strong> ships may cost reputation — open a save to check.${v.fix && v.fix.length ? ` Missions that raise it: ${v.fix.map(f => h(f.label)).join(', ')}.` : ''}</li>`;
    }).join('');
    const warns = S().warnings(d);
    const col = { error: 'var(--c-danger-text, #f87171)', warn: 'var(--c-warn-text, #fbbf24)', info: 'var(--c-text-mid)' };
    return `
      <h3 style="margin:18px 0 6px;font-size:1rem;">Result</h3>
      <div style="overflow-x:auto;"><table style="width:100%;font-size:0.84rem;border-collapse:collapse;">
        <thead><tr><th style="text-align:left;">&nbsp;</th><th style="text-align:right;">Now</th><th style="text-align:right;">Auto-fit</th>${ui.peers && ui.goal === 'general' ? '<th style="text-align:right;" title="Median of similar ships (same class and weight)">Similar ships</th>' : ''}<th style="text-align:right;">Change</th></tr></thead>
        <tbody>${statRows(ui.current, d, ui.goal === 'general' ? ui.peers : null)}</tbody></table></div>
      ${targetsResultHtml(d)}
      ${checksHtml(r)}
      ${r.counterNotes ? `<div style="margin:12px 0 0;padding:10px 12px;border:1px solid var(--c-border);border-radius:8px;font-size:0.86rem;">
        <div style="font-weight:600;margin-bottom:4px;">Against ${h(ui.foe.ships.length ? ui.foe.ships.map(shipLabel).join(', ') : ui.foe.government)}</div>
        <ul style="margin:0;padding-left:18px;">${r.counterNotes.map(l => `<li>${l}</li>`).join('')}</ul>
        <div style="margin-top:4px;color:var(--c-text-dim);font-size:0.76rem;">An estimate from each side's average damage, defences, missiles vs anti-missile/jamming, range and speed — not a full battle simulation.</div></div>` : ''}
      ${warns.length ? `<ul style="margin:10px 0 0;padding-left:18px;font-size:0.84rem;">${warns.map(w => `<li style="color:${col[w.level]};">${h(w.text)}</li>`).join('')}</ul>` : ''}
      ${stealNotes ? `<h4 style="margin:14px 0 4px;font-size:0.9rem;">Stealing and your story</h4><ul style="margin:0;padding-left:18px;font-size:0.84rem;">${stealNotes}</ul>` : ''}
      ${r.suggestions && r.suggestions.length ? `<h4 style="margin:14px 0 4px;font-size:0.9rem;">To push it further</h4>
        <ul style="margin:0;padding-left:18px;font-size:0.84rem;">${r.suggestions.map(s => `<li>${s}</li>`).join('')}</ul>` : ''}
      <h4 style="margin:14px 0 4px;font-size:0.9rem;">Outfits (${r.outfits.reduce((s, [, k]) => s + k, 0)})</h4>
      <div style="overflow-x:auto;"><table style="width:100%;font-size:0.84rem;">${rows}</table></div>`;
  }

  function refreshFoe() {
    const T = window.AfThreat; if (!T || !ui) return;
    ui.result = null;
    const ships = T.shipsFor({ government: ui.foe.ships.length ? '' : ui.foe.government, ships: ui.foe.ships });
    ui.foe.profile = ships.length ? T.profile(ships) : null;
    ui.foe.describe = ui.foe.profile ? T.describe(ui.foe.profile) : null;
  }

  // ── run ──────────────────────────────────────────────────────────────────
  function candidates() {
    const f = { ...ui.filters, factions: ui.factions && ui.factions.size ? ui.factions : null };
    const access = new Map(), list = [];
    const excluded = new Set(ui.prefs.exclude);
    for (const e of ui.ctx.list) {
      if (excluded.has(e.name)) continue;
      if (ui.prefs.noSecondary && S().isSecondary(e.outfit)) continue;
      const a = P().access(ui.ctx, e, f);
      if (!a.ok) continue;
      access.set(e.name, a);
      list.push({ name: e.name, outfit: e.outfit, unique: e.unique, isAmmo: e.isAmmo, maxCount: a.maxCount });
    }
    return { list, access };
  }

  // A hull needs these before anything can be fitted to it: weight and drag (so it
  // can move at all), room for outfits, and room for engines.
  const HULL_NEEDS = [['mass', 'mass'], ['drag', 'drag'], ['outfit space', 'outfit space'], ['engine capacity', 'engine capacity']];
  function missingHull() { return HULL_NEEDS.filter(([k]) => !(Number(ui.base[k]) > 0)).map(([, l]) => l); }

  function run() {
    if (!ui || ui.loading) return;
    ui.notice = null;
    const need = missingHull();
    if (need.length) { ui.notice = `This ship has no hull to fit yet — set ${need.join(', ')} in its Attributes (or start from an existing ship), then try again.`; render(); return; }
    ui.running = true; ui.progressPct = 3; ui.progressText = 'Starting…'; ui.result = null; render();
    let job;
    try {
      const { list, access } = candidates();
      // keep the jump drive / hyperdrive the ship already has (a fit that can't leave the system is no use)
      const mine = designOutfits(ui.design);
      const attrsOf = o => (o && (o.attributes || o)) || {};   // site outfits keep their attributes at the top level
      const keep = mine.filter(([n]) => { const a = attrsOf(ui.idx.get(n)); return (a.hyperdrive || a['jump drive']) && !ui.prefs.exclude.includes(n); });
      for (const [n] of keep) if (!access.has(n)) { access.set(n, { how: 'keep', note: 'Kept from your current fit' }); const o = ui.idx.get(n); if (o) list.push({ name: n, outfit: o }); }
      if (!keep.length) {
        const hd = list.find(c => attrsOf(c.outfit).hyperdrive);
        if (hd) keep.push([hd.name, 1]);
      }
      const opts = { ...ui.opts };
      if (ui.peers && ui.goal === 'general') opts.peerRef = ui.peers;   // only All-round is judged against similar ships
      opts.targets = ui.targets.map((t, i) => ({ ...t,
        // earlier targets matter a little more when priorities tie
        priority: t.priority || 'normal', order: i, ref: S().statValue(ui.current, t.id) }));
      if (ui.goal === 'custom' && !opts.targets.length) { ui.running = false; ui.notice = 'Add at least one target for “Just my targets”.'; render(); return; }
      if (ui.prefs.noSecondary) opts.weapons = 'primary';
      if (ui.goal === 'tank') opts.profile = enemyProfile(ui.enemies);
      delete opts.minTurn; delete opts.minCargo; delete opts.minSpeed;
      let counter = null;
      if (ui.goal === 'counter') {
        if (!ui.foe.profile) { ui.running = false; ui.notice = 'Pick a government or some ships to fit against first.'; render(); return; }
        counter = { profile: ui.foe.profile, count: ui.foe.count };
        if (ui.foe.matchSpeed) opts.minSpeed = Math.max(opts.minSpeed || 0, Math.round(ui.foe.profile.defence.speed));
      }
      job = { base: ui.base, list, goal: ui.goal, opts, keep, mine, idx: ui.idx, counter, access };
    } catch (err) {
      console.error(err); ui.running = false; ui.error = 'Auto-fit failed: ' + err.message; render(); return;
    }
    runJob(job);
  }

  // ── Running the search in the background (Web Worker) with a progress bar ──
  let worker = null, runId = 0;
  function setProgress(pct, text) {
    ui.progressPct = Math.max(ui.progressPct || 0, Math.min(99, pct));
    ui.progressText = text;
    const bar = document.getElementById('af-progress-bar'), t = document.getElementById('af-progress-text');
    if (bar) bar.style.width = ui.progressPct + '%';
    if (t) t.textContent = text;
    const box = bar && bar.closest('.af-progress'); if (box) box.setAttribute('aria-valuenow', String(Math.round(ui.progressPct)));
  }
  function onProgress(m) {
    if (m.pass === 3) { setProgress(95, 'Looking for the best next upgrades…'); return; }
    if (m.pass === 2) {
      if (m.phase === 'repairing') setProgress(88, `Fixing: ${(m.fixing || []).join(', ')}…`);
      else setProgress(88 + 10 * (1 - Math.exp(-(m.steps || 0) / 25)), 'Fitting again so every check passes…');
      return;
    }
    if (m.phase === 'adding') setProgress(5 + 70 * (1 - Math.exp(-(m.steps || 0) / 25)), `Trying outfits… ${m.outfits} chosen so far`);
    else if (m.phase === 'expanding') setProgress(78, 'Trying outfits that make more room…');
    else if (m.phase === 'suggestions') setProgress(95, 'Looking for the best next upgrades…');
    else if (m.phase === 'cleanup') setProgress(84, 'Fine-tuning — swapping and removing outfits that don\'t pull their weight…');
  }
  function finish(job, r) {
    try {
      setProgress(99, 'Checking the result…');
      r.access = job.access;
      r.counterNotes = ui.goal === 'counter' ? window.AfThreat.explain(ui.current, r.derived, ui.foe.profile, ui.foe.count) : null;
      const unit = { 'more damage': ' dps', 'more speed': ' speed', 'faster turning': '°/s', 'more shields': ' shield (incl. 30 s regen)', 'more cargo': ' cargo' };
      r.suggestions = ui.goal !== 'general' ? []
        : r.suggestionsRaw ? r.suggestionsRaw.map(b => `For ${b.label}: ${b.rm ? `swap 1× ${h(b.rm)} for` : 'add'} 1× ${h(b.add)} (+${fmt(b.gain, 1)}${unit[b.label]}).`)
        : suggestions(r, job.list);
      if (r.workerMs) console.info(`[AfUI] auto-fit took ${(r.workerMs / 1000).toFixed(1)} s in the background`);
      if (ui.goal === 'tank') r.suggestions.unshift(`Damage it's built against: ${Math.round(job.opts.profile.shield * 100)}% shield damage, ${Math.round(job.opts.profile.hull * 100)}% hull damage${ui.enemies.length ? ` (${h(ui.enemies.map(shipLabel).join(', '))})` : ' (average of every armed ship)'}.`);
      ui.result = r;
    } catch (err) {
      console.error(err); ui.result = null; ui.error = 'Auto-fit failed: ' + err.message;
    }
    ui.running = false; render();
  }
  function runJob(job) {
    const id = ++runId;
    const { access, ...msg } = job;
    let useWorker = typeof Worker === 'function';
    if (useWorker) {
      try {
        if (worker) worker.terminate();
        worker = new Worker(new URL('../JavaScript/autoFitting/afWorker.js', location.href));
      } catch (_) { useWorker = false; }
    }
    if (!useWorker) {
      // fallback: same work on the page itself (it may pause briefly)
      setTimeout(() => {
        try {
          const opts = { ...msg.opts };
          if (msg.counter) opts.counter = window.AfThreat.makeCounter(msg.counter.profile, msg.counter.count);
          const r = O().optimize({ base: msg.base, candidates: msg.list, goal: msg.goal, options: opts, keep: msg.keep, reference: msg.mine, referenceIndex: msg.idx });
          r.checks = S().verify(r.derived); r.repaired = null;
          if (id === runId) finish(job, r);
        } catch (err) { console.error(err); ui.running = false; ui.error = 'Auto-fit failed: ' + err.message; render(); }
      }, 30);
      return;
    }
    worker.onmessage = e => {
      if (id !== runId) return;
      const m = e.data;
      if (m.type === 'progress') onProgress(m);
      else if (m.type === 'done') { worker.terminate(); worker = null; finish(job, m.result); }
      else if (m.type === 'error') { worker.terminate(); worker = null; ui.running = false; ui.error = 'Auto-fit failed: ' + m.message; render(); }
    };
    worker.onerror = err => {
      if (id !== runId) return;
      console.error('[AfUI] worker error', err.message);
      worker = null; ui.running = false; ui.error = 'Auto-fit failed: ' + (err.message || 'the background search stopped'); render();
    };
    worker.postMessage(msg);
  }
  function cancelRun() {
    runId++;
    if (worker) { worker.terminate(); worker = null; }
    ui.running = false; ui.notice = 'Auto-fit cancelled.'; render();
  }

  // For the all-round build: the single best swap or addition toward each feature.
  function suggestions(r, list) {
    const out = [];
    const base = ui.base, idx = ui.idx;
    const now = r.derived;
    const metric = {
      'more damage': d => d.dps.total, 'more speed': d => d.maxSpeed, 'faster turning': d => d.turnRate,
      'more shields': d => d.shields + d.shieldRegen * 30, 'more cargo': d => d.cargo,
    };
    const unit = { 'more damage': ' dps', 'more speed': ' speed', 'faster turning': '°/s', 'more shields': ' shield (incl. 30 s regen)', 'more cargo': ' cargo' };
    for (const [label, f] of Object.entries(metric)) {
      let best = null;
      // remove one outfit (not the hyperdrive) and add one candidate in its place
      const removable = r.outfits.filter(([n]) => { const o = idx.get(n) || {}; const a = o.attributes || o; return !(a.hyperdrive || a['jump drive']); });
      for (const [rm] of [[null], ...removable]) {
        const outs = r.outfits.map(([n, k]) => [n, n === rm ? k - 1 : k]).filter(([, k]) => k > 0);
        for (const c of list) {
          if (c.isAmmo) continue;
          const trial = [...outs];
          const i = trial.findIndex(([n]) => n === c.name);
          if (i >= 0) trial[i] = [c.name, trial[i][1] + 1]; else trial.push([c.name, 1]);
          const d = S().derive(base, trial, idx);
          if (S().warnings(d).some(w => w.level === 'error' && /^Over /.test(w.text))) continue;
          const gain = f(d) - f(now);
          if (gain > 0 && (!best || gain > best.gain)) best = { gain, add: c.name, rm };
        }
      }
      if (best) out.push(`For ${label}: ${best.rm ? `swap 1× ${h(best.rm)} for` : 'add'} 1× ${h(best.add)} (+${fmt(best.gain, 1)}${unit[label]}).`);
    }
    return out;
  }

  // ── apply to the ship being edited ──────────────────────────────────────
  function apply() {
    if (!ui || !ui.result || typeof sbCurrentShip === 'undefined') return;
    const idx = ui.idx;
    if (window.BuilderExtras) window.BuilderExtras.snapshot();   // so ↶ Undo brings the old fit back
    const ship = sbCurrentShip;
    ship.outfits = ui.result.outfits.map(([name, count]) => {
      const o = idx.get(name);
      const pluginId = o && (o._pluginName || o._pn || o.pluginId) || null;
      return { name, count, pluginId, internalId: pluginId ? `${pluginId}::${name}` : null };
    });
    for (const hp of [...(ship.guns || []), ...(ship.turrets || [])]) hp.over = '';
    if (typeof sbAutoSlotWeapons === 'function') for (const [name, count] of ui.result.outfits) sbAutoSlotWeapons(name, count, idx.get(name));
    close();
    if (typeof sbPopulateBuilder === 'function') sbPopulateBuilder();
    if (typeof sbToast === 'function') sbToast('Auto-fit applied — press Save Ship to keep it (or ↶ Undo).', 'success');
  }

  window.AfUI = { open };
})();
