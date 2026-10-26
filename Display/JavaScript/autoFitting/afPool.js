'use strict';

// Auto-fit: which outfits this pilot can actually get (selected plugins, factions, outfitters, licences, owned, stealing).

(function () {
  const EXCLUDED_CATEGORIES = new Set(['Licenses', 'Minerals', 'Hand to Hand', 'Special', 'Unique']);
  const clean = v => String(v ?? '').replace(/^"([^"]*)"$/, '$1');
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  let cache = null;   // shared per page: { planets, menders }

  // all rows of a table (fallback)
  async function fetchAll(table, cols, filter) {
    const sb = window.supabaseClient;
    if (!sb) return [];
    const out = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from(table).select(cols).range(from, from + 999);
      if (filter) q = filter(q);
      const { data, error } = await q;
      if (error) break;
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return out;
  }

  // planet → government, and every way the story raises a reputation. Called by: load
  async function worldData() {
    const key = [...(window.AfStats.activePluginIds() || [])].sort().join('|');
    if (cache && cache.key === key) return cache;
    // selected plugins only, filtered by the database; only missions that matter
    const ids = [...(window.AfStats.activePluginIds() || [])];
    const mine = q => (ids.length ? q.in('plugin_id', ids) : q);
    const H = window.SupabaseHelpers;
    // rows for the selected plugins
    const rows = (table, select, filter) => (H && H.fetchAllRows)
      ? H.fetchAllRows(table, { select, orderBy: 'id', filters: q => filter(mine(q)) }).catch(() => [])
      : fetchAll(table, select, q => filter(mine(q)));
    const [planets, missions, events] = await Promise.all([
      rows('planets', 'id, name, government', q => q),
      rows('missions', 'id, name, display_name, plugin_id, condition_side_effects, event_triggers, repeatable',
           q => q.or('condition_side_effects.not.is.null,event_triggers.not.is.null')),
      rows('game_events', 'id, name, plugin_id, raw', q => q.ilike('raw', '%reputation: %')),
    ]);
    const planetGov = new Map(planets.map(p => [p.name, p.government || null]));
    // government → [{ kind, name, label, value, op }]
    const menders = new Map();
    const add = (gov, entry) => { if (!menders.has(gov)) menders.set(gov, []); menders.get(gov).push(entry); };
    // which reputations a mission/event raises
    const raises = (op, value) => (op === '+=' && num(value) > 0) || ((op === '=' || op === '>?=') && num(value) >= 0);
    const on = window.AfStats.activePluginIds();
    const active = r => !on || !r.plugin_id || on.has(r.plugin_id);
    for (const m of missions.filter(active)) {
      for (const e of m.condition_side_effects || []) {
        const g = /^reputation: (.+)$/.exec(e.condition || '');
        if (g && raises(e.op, e.value) && (e.trigger === 'onComplete' || e.trigger === 'onAccept'))
          add(g[1], { kind: 'mission', name: m.name, label: m.display_name || m.name, op: e.op, value: num(e.value), repeatable: !!m.repeatable });
      }
    }
    for (const ev of events.filter(active)) {
      for (const line of String(ev.raw || '').split('\n')) {
        const mm = /^\s*"reputation: ([^"]+)"\s*(=|\+=|>\?=)\s*(-?\d+(?:\.\d+)?)/.exec(line);
        if (mm && raises(mm[2], mm[3])) add(mm[1], { kind: 'event', name: ev.name, label: ev.name, op: mm[2], value: num(mm[3]) });
      }
    }
    // which missions start each event (so an event can be suggested via its mission)
    const eventMissions = new Map();
    for (const m of missions.filter(active)) for (const t of m.event_triggers || []) {
      if (!eventMissions.has(t.name)) eventMissions.set(t.name, []);
      eventMissions.get(t.name).push(m.display_name || m.name);
    }
    return (cache = { key, planetGov, menders, eventMissions });
  }

  // what the open save tells us (or null). Called by: load
  async function saveInfo() {
    try {
      const id = JSON.parse(localStorage.getItem('ES_SM_CURRENT') || 'null');
      if (!id || !window.SaveVault || !window.EsSaveFile) return null;
      const text = await window.SaveVault.text(id);
      if (!text) return null;
      const doc = window.EsSaveFile.SaveFile.fromText(text);
      const conds = doc.conditions;
      const happened = new Set(doc.changes.filter(n => n.tokens[0] === 'event').map(n => clean(n.tokens[1])));
      for (const k of Object.keys(conds)) { const m = /^event: (.+)$/.exec(k); if (m) happened.add(m[1]); }
      const owned = new Map();
      for (const s of doc.ships) for (const [n, c] of Object.entries(s.outfits || {})) owned.set(n, (owned.get(n) || 0) + Number(c || 0));
      for (const [n, c] of Object.entries(doc.cargo.outfits || {})) owned.set(n, (owned.get(n) || 0) + Number(c || 0));
      return {
        pilot: `${doc.pilot.first} ${doc.pilot.last}`.trim(),
        visitedPlanets: new Set(doc.visitedPlanets),
        licenses: new Set(doc.licenses),
        reputations: doc.reputations,
        conditions: conds,
        happened, owned,
        credits: Number(doc.credits),
      };
    } catch (_) { return null; }
  }

  // only what the selected plugins say
  function pluginEntries(locations) { return window.AfStats.activeLocations(locations); }

  // availability for every outfit. Called by: afUI.open
  async function load() {
    const world = await worldData();
    const save = await saveInfo();
    const ships = new Map();
    for (const p of Object.values(window.AfStats.activeData())) {
      for (const s of [...(p.ships || []), ...(p.variants || [])]) if (s && s.name && !ships.has(s.name)) ships.set(s.name, s);
    }
    const list = [];
    const seen = new Set();
    const factionCount = new Map();
    for (const [pid, p] of Object.entries(window.AfStats.activeData())) {
      for (const o of p.outfits || []) {
        if (!o || !o.name || seen.has(o.name)) continue;
        seen.add(o.name);
        const a = o.attributes || o;
        const category = o.category || a.category || null;
        const locs = pluginEntries(a.locations || o.locations);
        const planets = [...new Set(locs.flatMap(l => l.Planets || []))];
        const buyGovs = new Set(planets.map(pl => world.planetGov.get(pl)).filter(g => g && g !== 'Uninhabited'));
        const carriers = [...new Set(locs.flatMap(l => l.Ships || []))];
        const flyGovs = new Set();
        for (const sn of carriers) {
          const sh = ships.get(sn);
          for (const l of pluginEntries(sh && sh.locations)) for (const g of l.Governments || []) flyGovs.add(g);
        }
        if (!flyGovs.size) for (const l of locs) for (const g of l.Governments || []) if (!buyGovs.has(g)) flyGovs.add(g);
        const licences = a.licenses && typeof a.licenses === 'object' ? Object.keys(a.licenses) : [];
        const entry = {
          name: o.name, outfit: o, pluginId: pid, category,
          cost: num(a.cost),
          unique: num(a.unique) > 0,
          isAmmo: category === 'Ammunition',
          excluded: EXCLUDED_CATEGORIES.has(category) || num(a.installable) < 0 || (category == null && !a.weapon && !num(a['outfit space'])),
          unplunderable: num(a.unplunderable) > 0,
          buy: { planets, govs: buyGovs, visited: save ? planets.filter(pl => save.visitedPlanets.has(pl)) : [] },
          plunder: { ships: carriers, govs: flyGovs },
          missions: [...new Set(locs.flatMap(l => l.Missions || []))],
          licences,
          owned: save ? (save.owned.get(o.name) || 0) : 0,
        };
        for (const g of buyGovs) factionCount.set(g, (factionCount.get(g) || 0) + 1);
        list.push(entry);
      }
    }
    // factions the pilot has been to (an outfitter planet they've visited)
    const visitedFactions = new Set();
    if (save) for (const e of list) for (const pl of e.buy.visited) { const g = world.planetGov.get(pl); if (g) visitedFactions.add(g); }
    const factions = [...factionCount.entries()].sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count, visited: visitedFactions.has(name) }));
    return { list, factions, save, world };
  }

  // what stealing from a government costs you (hostile / fixable / costly). Called by: access
  function stealVerdict(ctx, gov) {
    const save = ctx.save;
    const menders = (ctx.world.menders.get(gov) || []);
    if (!save) return { status: 'unknown', gov, fix: menders.slice(0, 3) };
    const rep = num(save.reputations[gov]);
    if (rep < 0) return { status: 'hostile', gov, rep };
    const todo = menders.filter(m => m.kind === 'mission'
      ? !num(save.conditions[`${m.name}: done`]) || m.repeatable
      : !save.happened.has(m.name));
    const seenFix = new Set();
    const uniq = todo.filter(m => { const k = m.kind + ':' + m.name; if (seenFix.has(k)) return false; seenFix.add(k); return true; });
    if (uniq.length) return { status: 'fixable', gov, rep, fix: uniq.slice(0, 3).map(m => ({ ...m,
      via: m.kind === 'event' ? (ctx.world.eventMissions.get(m.name) || []).slice(0, 2) : [] })) };
    return { status: 'costly', gov, rep };
  }
  const RANK = { hostile: 0, fixable: 1, unknown: 2, costly: 3 };

  // can this pilot get this outfit under these filters? Called by: afUI.candidates
  function access(ctx, e, f) {
    if (e.excluded) return { ok: false };
    const other = otherSources(ctx, e, f);
    if (f.includeOwned && e.owned > 0) {
      if (other.ok) return { ...other, note: `You own ${e.owned} · ${other.note}` };
      return { ok: true, how: 'owned', note: `You already own ${e.owned}`, maxCount: e.owned };
    }
    return other;
  }

  // other ways to get it
  function otherSources(ctx, e, f) {
    if (f.requireLicences && ctx.save && e.licences.some(l => !ctx.save.licenses.has(l)))
      return { ok: false, note: `Needs licence: ${e.licences.join(', ')}` };
    if (f.allowBuy) {
      const planets = f.visitedOnly && ctx.save ? e.buy.visited : e.buy.planets;
      const okPlanets = planets.filter(pl => !f.factions || f.factions.has(ctx.world.planetGov.get(pl)));
      if (okPlanets.length) return { ok: true, how: 'buy', note: `Sold at ${okPlanets.slice(0, 3).join(', ')}${okPlanets.length > 3 ? ` +${okPlanets.length - 3}` : ''}`, planets: okPlanets };
    }
    if (f.allowPlunder && !e.unplunderable && e.plunder.ships.length) {
      // only ships of factions you can reach (the faction filter) count
      const govs = [...e.plunder.govs].filter(g => !f.factions || f.factions.has(g));
      if (e.plunder.govs.size && !govs.length) return f.allowMissions && e.missions.length
        ? { ok: true, how: 'mission', note: `Reward from ${e.missions.slice(0, 2).join(', ')}` } : { ok: false };
      const verdicts = (govs.length ? govs : ['unknown']).map(g => stealVerdict(ctx, g)).sort((a, b) => RANK[a.status] - RANK[b.status]);
      const best = verdicts[0];
      const allowed = best.status === 'hostile' || (best.status === 'fixable' && f.plunderPolicy !== 'safe')
        || (f.plunderPolicy === 'any') || (best.status === 'unknown' && f.plunderPolicy !== 'safe');
      if (allowed) return { ok: true, how: 'plunder', steal: best,
        note: `Plunder from ${e.plunder.ships.slice(0, 2).join(', ')}${best.gov && best.gov !== 'unknown' ? ` (${best.gov})` : ''}` };
    }
    if (f.allowMissions && e.missions.length) return { ok: true, how: 'mission', note: `Reward from ${e.missions.slice(0, 2).join(', ')}` };
    return { ok: false };
  }

  window.AfPool = { load, access, stealVerdict, worldData, saveInfo };
})();
