'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  autoFitting/afPeers.js — what "good handling" means for this kind of ship
//
//  Instead of a fixed turn limit, the auto-fitter asks: how well do similar
//  ships turn and move? "Similar" means, in order of preference:
//    1. same class (category) AND a hull weight within ±35%
//    2. same class, any weight
//    3. any class with a hull weight within ±35%
//  (the first group with at least 5 ships wins). Ships are taken from the
//  base game, every active plugin (variants included, with their own
//  loadouts) and the user's own saved designs (all builder fleets).
//
//  Each peer is measured with its stock loadout (AfStats); the median turn
//  rate, top speed and acceleration become the auto-fitter's minimums.
//
//  window.AfPeers. Needs AfStats and ShipDefinition (outfit lists).
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const MASS_BAND = 0.35, MIN_PEERS = 5;

  function isBaseGame(pluginKey) { return /^(official-game|endless-sky)\b/i.test(String(pluginKey || '')); }

  function outfitList(outfits) {
    if (window.ShipDefinition) return window.ShipDefinition.outfitList(outfits);
    if (Array.isArray(outfits)) return outfits.map(o => [o.name, Number(o.count) || 1]);
    return Object.entries(outfits || {}).map(([n, v]) => [n, typeof v === 'object' ? Number(v.count) || 1 : Number(v) || 1]);
  }

  /** Every ship we can compare against: { name, source, category, hullMass, base, outs }. */
  function collect(excludeId) {
    const S = window.AfStats;
    const out = [];
    const hulls = new Map();
    for (const p of Object.values(window.AfStats.activeData())) for (const s of p.ships || []) if (s && s.name && !hulls.has(s.name)) hulls.set(s.name, s);
    const seen = new Set();
    for (const [key, p] of Object.entries(window.AfStats.activeData())) {
      if (key === '__local_builds__') continue;
      const source = isBaseGame(key) ? 'game' : 'plugin';
      for (const s of [...(p.ships || []), ...(p.variants || [])]) {
        if (!s || !s.name || seen.has(s.name)) continue;
        seen.add(s.name);
        const hull = s.baseShip ? hulls.get(s.baseShip) : s;
        if (!hull) continue;
        const base = S.hullAttrs(hull);
        out.push({ name: s.name, source, category: base.category || hull.category || null, hullMass: num(base.mass), base, outs: outfitList(s.outfits) });
      }
    }
    // the user's own designs, from every builder fleet
    const fleets = window.FleetStore && typeof window.FleetStore.list === 'function' ? window.FleetStore.list() : [];
    const designs = fleets.length ? fleets.flatMap(f => f.ships || []) : (typeof sbFleet !== 'undefined' ? sbFleet : []);
    const outfitNames = new Set();
    for (const p of Object.values(window.AfStats.gameData())) for (const o of p.outfits || []) if (o && o.name) outfitNames.add(o.name);
    const allHulls = new Set(seen);
    for (const d of designs) {
      if (!d || (excludeId != null && d.id === excludeId)) continue;
      // a design built with a plugin you've since switched off isn't a fair comparison
      if (d._sourceShip && !allHulls.has(d._sourceShip)) continue;
      if (outfitList(d.outfits).some(([n]) => !outfitNames.has(n))) continue;
      const base = S.hullAttrs(d);
      if (!num(base.mass)) continue;
      out.push({ name: d.name || 'Unnamed design', source: 'yours', category: base.category || null, hullMass: num(base.mass), base, outs: outfitList(d.outfits) });
    }
    return out;
  }

  function outfitIndex() {
    const m = new Map();
    for (const p of Object.values(window.AfStats.activeData())) for (const o of p.outfits || []) if (o && o.name && !m.has(o.name)) m.set(o.name, o);
    return m;
  }

  /**
   * Typical handling for ships like `design`.
   * → { turn, speed, accel, count, basis, category, mass, bySource, examples }  (null if nothing to compare)
   */
  function reference(design) {
    const S = window.AfStats;
    if (!S) return null;
    const base = S.hullAttrs(design);
    const category = base.category || null, mass = num(base.mass);
    const all = collect(design && design.id);
    const near = p => mass > 0 && p.hullMass > 0 && Math.abs(p.hullMass - mass) / mass <= MASS_BAND;
    const groups = [
      ['same class and weight', p => category && p.category === category && near(p)],
      ['same class', p => category && p.category === category],
      ['similar weight', near],
    ];
    const idx = outfitIndex();
    for (const [basis, test] of groups) {
      const pick = all.filter(test);
      if (pick.length < MIN_PEERS) continue;
      const measured = [];
      for (const p of pick) {
        try {
          const d = S.derive(p.base, p.outs, idx);
          if (d.turnRate > 0 && d.maxSpeed > 0) measured.push({ name: p.name, source: p.source, turn: d.turnRate, speed: d.maxSpeed, accel: d.acceleration,
            cargo: Math.max(0, d.cargo), bunks: Math.max(0, d.bunks), dps: d.dps.total,
            // toughness the way All-round counts it: shields + hull + 30 s of regeneration
            ehp: d.shields + d.hull + (d.shieldRegen + d.hullRegen) * 30,
            shields: d.shields, hull: d.hull, mass: p.hullMass });
        } catch (_) { /* skip ships whose data is incomplete */ }
      }
      if (measured.length < MIN_PEERS) continue;
      const bySource = { game: 0, plugin: 0, yours: 0 };
      for (const m of measured) bySource[m.source]++;
      const masses = measured.map(m => m.mass);
      return {
        turn: median(measured.map(m => m.turn)),
        speed: median(measured.map(m => m.speed)),
        cargo: median(measured.map(m => m.cargo)),
        bunks: median(measured.map(m => m.bunks)),
        dps: median(measured.map(m => m.dps)),
        ehp: median(measured.map(m => m.ehp)),
        shields: median(measured.map(m => m.shields)),
        hull: median(measured.map(m => m.hull)),
        accel: median(measured.map(m => m.accel)),
        count: measured.length, basis, category,
        mass: { min: Math.min(...masses), max: Math.max(...masses) },
        bySource,
        examples: measured.sort((a, b) => Math.abs(a.mass - mass) - Math.abs(b.mass - mass)).slice(0, 6).map(m => m.name),
      };
    }
    return null;
  }

  window.AfPeers = { reference };
})();
