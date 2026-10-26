'use strict';

// Auto-fit "🎯 Beat an enemy": what an enemy brings (from their loadouts) and a duel model using the game's own formulas.

(function () {
  const S = () => window.AfStats;
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const ENGAGE = 400;   // typical missile-to-target distance for jamming falloff (px)
  const STATUS = ['ion', 'heat', 'slowing', 'scrambling', 'disruption', 'corrosion', 'discharge', 'burn', 'leak'];
  const RES_KEY = { ion: 'ion', heat: 'heat', slowing: 'slowing', scrambling: 'scramble', disruption: 'disruption', corrosion: 'corrosion', discharge: 'discharge', burn: 'burn', leak: 'leak' };

  function outfitList(o) { return window.ShipDefinition ? window.ShipDefinition.outfitList(o) : Object.entries(o || {}).map(([n, v]) => [n, Number(v) || 1]); }
  // every ship and outfit we may use
  function catalogue() {
    const hulls = new Map(), all = new Map(), outfits = new Map();
    for (const p of Object.values(window.AfStats.gameData())) {
      for (const s of p.ships || []) { if (s && s.name && !hulls.has(s.name)) hulls.set(s.name, s); if (s && s.name && !all.has(s.name)) all.set(s.name, s); }
      for (const s of p.variants || []) if (s && s.name && !all.has(s.name)) all.set(s.name, s);
      for (const o of p.outfits || []) if (o && o.name && !outfits.has(o.name)) outfits.set(o.name, o);
    }
    return { hulls, all, outfits };
  }
  // who flies a ship (selected plugins only)
  const govsOf = s => [...new Set(S().activeLocations(s.locations).flatMap(l => l.Governments || []))];

  // governments that fly at least one known ship. Called by: afUI
  function governments() {
    const { all } = catalogue();
    const count = new Map();
    for (const s of all.values()) for (const g of govsOf(s)) count.set(g, (count.get(g) || 0) + 1);
    return [...count.entries()].map(([name, ships]) => ({ name, ships })).sort((a, b) => b.ships - a.ships || a.name.localeCompare(b.name));
  }

  // the ships an enemy choice stands for. Called by: afUI.refreshFoe
  function shipsFor({ government, ships }) {
    const { all } = catalogue();
    if (ships && ships.length) return ships.map(n => all.get(n)).filter(Boolean);
    if (government) return [...all.values()].filter(s => govsOf(s).includes(government));
    return [];
  }

  // one enemy ship's numbers
  function measure(ship, cat) {
    const hull = ship.baseShip ? cat.hulls.get(ship.baseShip) : ship;
    if (!hull) return null;
    const d = S().derive(S().hullAttrs(hull), outfitList(ship.outfits), cat.outfits);
    return d;
  }

  // ── one ship's attack and defence ──
  function offence(d) {
    const out = { shield: 0, hull: 0, missileShield: 0, missileHull: 0, missileRate: 0, missileStrength: 0, piercing: 0,
                  status: Object.fromEntries(STATUS.map(k => [k, 0])), track: { radar: 0, optical: 0, infrared: 0, generic: 0 }, range: 0, am: [] };
    let strengthW = 0, pierceW = 0;
    for (const w of d.weapons) {
      const n = w.count, sh = (w.damage['shield damage'] || 0) * n, hu = (w.damage['hull damage'] || 0) * n;
      out.shield += sh; out.hull += hu;
      for (const k of STATUS) out.status[k] += (w.damage[`${k} damage`] || (k === 'scrambling' ? w.damage['scrambling damage'] : 0) || 0) * n;
      if (w.antiMissile) out.am.push({ strength: w.antiMissile, rate: w.shotsPerSec * n });   // anti-missile shots / s
      if (sh + hu > 0) { out.range = Math.max(out.range, w.range); out.piercing += w.piercing * (sh + hu); pierceW += sh + hu; }
      if (w.isMissile && sh + hu > 0) {
        out.missileShield += sh; out.missileHull += hu;
        out.missileRate += w.shotsPerSec * n;
        out.missileStrength += w.missileStrength * w.shotsPerSec * n; strengthW += w.shotsPerSec * n;
        for (const t of Object.keys(out.track)) out.track[t] += (w.tracking[t] || 0) * (sh + hu);
      }
    }
    const mDmg = out.missileShield + out.missileHull;
    if (mDmg > 0) for (const t of Object.keys(out.track)) out.track[t] /= mDmg;   // damage-weighted average tracking
    out.missileStrength = strengthW ? out.missileStrength / strengthW : 0;
    out.piercing = pierceW ? out.piercing / pierceW : 0;
    return out;
  }
  // how hard a ship is to hurt
  function defence(d) {
    const g = k => num(d.raw[k]);
    const res = {}, prot = {};
    for (const k of STATUS) { res[k] = g(`${RES_KEY[k]} resistance`); prot[k] = g(`${RES_KEY[k]} protection`); }
    return {
      shields: d.shields, hull: d.hull, shieldRegen: d.shieldRegen, hullRegen: d.hullRegen,
      shieldProt: g('shield protection'), hullProt: g('hull protection'), piercingProt: g('piercing protection'), piercingRes: g('piercing resistance'),
      radarJam: g('radar jamming'), opticalJam: g('optical jamming'), heatPct: d.heat.equilibriumPct.fighting,
      res, prot, speed: d.maxSpeed, turn: d.turnRate, mass: d.mass,
    };
  }

  // average enemy from a list of ships. Called by: afUI.refreshFoe
  function profile(ships) {
    const cat = catalogue();
    const off = [], def = [], names = [];
    for (const s of ships) {
      try {
        const d = measure(s, cat);
        if (!d) continue;
        const o = offence(d);
        off.push(o); def.push(defence(d)); names.push({ name: s.name, dps: o.shield + o.hull });
      } catch (_) { /* skip incomplete ships */ }
    }
    if (!off.length) return null;
    const a = k => avg(off.map(o => o[k]));
    const status = Object.fromEntries(STATUS.map(k => [k, avg(off.map(o => o.status[k]))]));
    const track = Object.fromEntries(['radar', 'optical', 'infrared', 'generic'].map(t => [t, avg(off.filter(o => o.missileShield + o.missileHull > 0).map(o => o.track[t]))]));
    const armed = off.filter(o => o.shield + o.hull > 0);
    return {
      count: off.length,
      offence: { shield: a('shield'), hull: a('hull'), missileShield: a('missileShield'), missileHull: a('missileHull'), missileRate: a('missileRate'),
                 missileStrength: avg(armed.filter(o => o.missileRate).map(o => o.missileStrength)), piercing: avg(armed.map(o => o.piercing)),
                 status, track, range: median(armed.map(o => o.range)),
                 // the average ship's anti-missile: every ship's guns, weighted 1/count
                 am: off.flatMap(o => o.am.map(x => ({ strength: x.strength, rate: x.rate / off.length }))) },
      defence: {
        shields: avg(def.map(x => x.shields)), hull: avg(def.map(x => x.hull)), shieldRegen: avg(def.map(x => x.shieldRegen)), hullRegen: avg(def.map(x => x.hullRegen)),
        shieldProt: avg(def.map(x => x.shieldProt)), hullProt: avg(def.map(x => x.hullProt)),
        radarJam: avg(def.map(x => x.radarJam)), opticalJam: avg(def.map(x => x.opticalJam)), heatPct: avg(def.map(x => x.heatPct)),
        speed: median(def.map(x => x.speed)), turn: median(def.map(x => x.turn)), mass: median(def.map(x => x.mass)),
        antiMissileShare: off.filter(o => o.am.length).length / off.length,
      },
      worst: names.sort((x, y) => y.dps - x.dps).slice(0, 5),
    };
  }

  // ── duel model ──
  const jamFall = j => j > 0 ? j * (1 - Math.min(1, ENGAGE / (500 + Math.sqrt(j) * 500))) : 0;
  // share of missiles still finding the target with these defences
  function missileHitShare(track, target) {
    const p = (r, o, i, g) => 1 - (1 - Math.min(1, r)) * (1 - Math.min(1, o)) * (1 - Math.min(1, i)) * (1 - Math.min(1, g));
    const base = p(track.radar, track.optical, track.infrared, track.generic);
    if (base <= 0) return 1;
    const irScale = Math.min(1, (target.heatPct / 100) * 1.5);
    const withDef = p(track.radar / (1 + jamFall(target.radarJam)), track.optical / (1 + jamFall(target.opticalJam)), track.infrared * irScale, track.generic);
    return Math.max(0.05, withDef / base);
  }
  // share of incoming missiles shot down (anti-missile vs missiles/s)
  const killChance = (am, ms) => { ms = Math.max(1, ms); return am > ms ? 1 - ms / (2 * am) : am / (2 * ms); };
  // share intercepted
  function interceptShare(amList, missileRate, missileStrength) {
    if (!missileRate || !amList || !amList.length) return 0;
    const killsPerSec = amList.reduce((s, x) => s + x.rate * killChance(x.strength, missileStrength), 0);
    return Math.min(0.9, (killsPerSec / missileRate) * 0.7);    // ~70%: turrets aren't always in range or facing
  }
  // shield damage after protection
  function scaleShield(dmg, prot) { return dmg / (1 + prot); }

  // our fit vs the enemy profile → times to kill, DPS, notes. Called by: makeCounter, explain
  function duel(me, p, n = 1) {
    n = Math.max(1, Math.round(n));
    const mOff = offence(me), mDef = defence(me);
    const e = p.offence, ed = p.defence;
    // ── their damage reaching us ──
    const hitShare = missileHitShare(e.track, mDef);
    const intercept = interceptShare(mOff.am, e.missileRate, e.missileStrength);
    const missileFactor = hitShare * (1 - intercept);
    const gunShield = e.shield - e.missileShield, gunHull = e.hull - e.missileHull;
    const pierce = Math.max(0, Math.min(1, e.piercing / (1 + mDef.piercingProt) - mDef.piercingRes));
    let inShield = (gunShield + e.missileShield * missileFactor);
    let inHull = (gunHull + e.missileHull * missileFactor);
    // disruption makes shields leak (+ up to ~50%), piercing goes straight to hull
    const disrupt = Math.min(0.5, e.status.disruption / (1 + mDef.prot.disruption) / 600);
    inShield = scaleShield(inShield * (1 - pierce), mDef.shieldProt) * (1 + disrupt);
    inHull = inHull / (1 + mDef.hullProt);
    const pierced = scaleShield(e.shield, 0) * pierce / (1 + mDef.hullProt);
    // status damage: ion drains energy, heat heats, slowing slows, scrambling jams (shields block half)
    const st = k => Math.max(0, e.status[k] * 0.5 / (1 + mDef.prot[k]) - mDef.res[k] * 60);
    const ionDrain = st('ion'), heatIn = st('heat'), slow = st('slowing'), scramble = st('scrambling');
    // ── our damage reaching them ──
    const myMissileHit = missileHitShare(mOff.track, ed);
    const theirIntercept = interceptShare(e.am, mOff.missileRate, mOff.missileStrength);
    const myMf = myMissileHit * (1 - theirIntercept);
    const outShield = scaleShield((mOff.shield - mOff.missileShield) + mOff.missileShield * myMf, ed.shieldProt);
    const outHull = ((mOff.hull - mOff.missileHull) + mOff.missileHull * myMf) / (1 + ed.hullProt);
    // ── range & speed: whoever out-ranges AND out-runs the other can stay out of reach ──
    const mySpeed = me.maxSpeed / (1 + slow / 1000);
    let mine = 1, theirs = 1;
    if (mOff.range > e.range * 1.15 && mySpeed > ed.speed) theirs *= 0.55;
    if (e.range > mOff.range * 1.15 && ed.speed > mySpeed) mine *= 0.6;
    mine *= 1 / (1 + scramble / 300);
    // ── energy: shields/hull only regenerate, and weapons only fire, while there's energy ──
    const t0 = me.raw || {};
    const income = ((t0['energy generation'] || 0) + (t0['solar collection'] || 0)) * 60;
    const per = me.energy.perSec.fighting - ionDrain;
    const sustain = per >= 0 ? 1 : Math.max(0, Math.min(1, income / Math.max(1, income - per)));
    const lasts = per >= 0 ? Infinity : me.energy.capacity / -per;     // seconds before the batteries are flat
    const fightShare = s => (per >= 0 ? 1 : Math.max(sustain, Math.min(1, lasts / Math.max(1, s))));
    // ── times to kill ──
    const ttk = (sh, hu, inS, inH, regS, regH) => {
      const s = Math.max(1e-3, inS - regS), h = Math.max(1e-3, inH - regH);
      return Math.min(3600, sh / s + hu / h);
    };
    // n enemies at once: you face all their guns while they last (on average about
    // half of them are still alive across the fight), and must chew through all of them
    const together = (n + 1) / 2;
    let ttkThem = n * ttk(ed.shields, ed.hull, outShield * mine, outHull * mine, ed.shieldRegen, ed.hullRegen);
    const fsh = fightShare(ttkThem);
    ttkThem = n * ttk(ed.shields, ed.hull, outShield * mine * fsh, outHull * mine * fsh, ed.shieldRegen, ed.hullRegen);
    const ttkMe = ttk(me.shields, me.hull, inShield * theirs * together, (inHull + pierced) * theirs * together,
                      me.shieldRegen * fightShare(ttkThem), me.hullRegen * fightShare(ttkThem));
    return {
      score: ttkMe / ttkThem, ttkThem, ttkMe,
      myDps: (outShield + outHull) * mine, theirDps: (inShield + inHull + pierced) * theirs * together, n,
      parts: { sustain: fsh, hitShare, intercept, missileFactor, myMissileHit, theirIntercept, ionDrain, heatIn, slow, scramble, pierce, disrupt, mine, theirs },
    };
  }

  // score function for the optimiser. Called by: afWorker, afUI
  function makeCounter(p, n = 1) {
    return (d, f) => {
      const r = duel(d, p, n);
      // ion drain and heat damage make our own energy/heat budget worse
      const extraE = r.parts.ionDrain, extraH = r.parts.heatIn;
      const eF = extraE > 0 ? Math.max(0.02, Math.min(1, (d.energy.capacity / Math.max(1, -d.energy.perSec.fighting + extraE)) / f.fight + (d.energy.perSec.fighting - extraE >= 0 ? 1 : 0))) : f.energyFactor(d, 'fighting', f.fight);
      const hF = extraH > 0 ? Math.min(f.heatFactor(d, 'fighting'), d.heat.max / Math.max(1, d.heat.max * d.heat.equilibriumPct.fighting / 100 + extraH * 10)) : f.heatFactor(d, 'fighting');
      return r.score * eF * f.energyFactor(d, 'flying', f.fight) * hF * f.mobility(d) * f.basics(d);
    };
  }

  // ── words ──
  const pct = x => `${Math.round(x * 100)}%`;
  const fmt = (n, dp = 0) => (Number.isFinite(n) ? n : 0).toLocaleString(undefined, { maximumFractionDigits: dp });
  // one-line enemy summary. Called by: afUI
  function describe(p) {
    const e = p.offence, d = p.defence, tot = e.shield + e.hull;
    const lines = [], priorities = [];
    const missileShare = tot ? (e.missileShield + e.missileHull) / tot : 0;
    lines.push(`An average one deals ${fmt(tot)} damage/s — ${pct(tot ? e.shield / tot : 0)} to shields, ${pct(tot ? e.hull / tot : 0)} to hull.`);
    if (missileShare > 0.05) {
      const tr = Object.entries(e.track).filter(([, v]) => v > 0.05).sort((a, b) => b[1] - a[1]).map(([k]) => k === 'generic' ? 'plain tracking' : k);
      lines.push(`${pct(missileShare)} of it comes from missiles${tr.length ? `, guided by ${tr.join(' and ')}` : ''} (missile strength ~${fmt(e.missileStrength)}).`);
      priorities.push('anti-missile');
      if (e.track.radar > 0.05) priorities.push('radar jamming');
      if (e.track.optical > 0.05) priorities.push('optical jamming');
      if (e.track.infrared > 0.05) priorities.push('running cool (infrared seekers home in on heat)');
    }
    const statusLines = STATUS.filter(k => e.status[k] > 1).map(k => `${k} ${fmt(e.status[k])}/s`);
    if (statusLines.length) {
      lines.push(`They also deal ${statusLines.join(', ')}.`);
      const { outfits } = catalogue();
      const exists = key => [...outfits.values()].some(o => num((o.attributes || o)[key]) > 0);
      for (const k of STATUS) if (e.status[k] > 1) {
        const r = `${RES_KEY[k]} resistance`, pr = `${RES_KEY[k]} protection`;
        if (exists(r)) priorities.push(r); else if (exists(pr)) priorities.push(pr);
        else if (k === 'heat') priorities.push('cooling');
        else if (k === 'ion') priorities.push('spare energy');
      }
    }
    if (e.piercing > 0.05) { lines.push(`Their shots pierce shields (~${pct(e.piercing)}).`); priorities.push('hull and piercing protection'); }
    lines.push(`Their weapons reach ~${fmt(e.range)}; they fly at ~${fmt(d.speed)} and turn ~${fmt(d.turn)}°/s.`);
    lines.push(`They have ~${fmt(d.shields)} shields and ~${fmt(d.hull)} hull${d.shieldProt ? ` (shield protection ${fmt(d.shieldProt * 100)}%)` : ''} — ${d.shields > d.hull * 1.5 ? 'mostly shields, so shield damage matters most' : d.hull > d.shields * 1.5 ? 'mostly hull, so hull damage matters most' : 'a mix of both'}.`);
    if (d.antiMissileShare > 0.2) { lines.push(`${pct(d.antiMissileShare)} of them carry anti-missile, so your missiles lose value.`); priorities.push('guns over missiles'); }
    if (d.radarJam > 0 || d.opticalJam > 0) lines.push(`They jam ${[d.radarJam > 0 && 'radar', d.opticalJam > 0 && 'optical'].filter(Boolean).join(' and ')} guidance.`);
    return { lines, priorities: [...new Set(priorities)] };
  }

  // why the new fit works, in a few lines. Called by: afUI.finish
  function explain(before, after, p, n = 1) {
    const a = duel(before, p, n), b = duel(after, p, n), out = [];
    const who = n > 1 ? `${n} average ones at once` : 'an average one';
    const t = s => s >= 3600 ? 'over an hour' : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)}s`;
    const never = s => s >= 3600 ? 'can\'t out-damage your shield and hull repair' : `would need <strong>${t(s)}</strong> to destroy you`;
    out.push(`Against ${who}: you'd destroy ${n > 1 ? 'them' : 'it'} in <strong>${t(b.ttkThem)}</strong> (now ${t(a.ttkThem)}); ${n > 1 ? 'they' : 'it'} ${never(b.ttkMe)} (now ${a.ttkMe >= 3600 ? 'couldn\'t either' : t(a.ttkMe)}).`);
    const e = p.offence;
    if (e.missileShield + e.missileHull > 0) {
      out.push(`Their missiles: ${pct(b.parts.intercept)} shot down by your anti-missile and ${pct(1 - b.parts.hitShare)} thrown off by jamming/heat — ${pct(1 - b.parts.missileFactor)} of their missile damage avoided (now ${pct(1 - a.parts.missileFactor)}).`);
    }
    if (b.parts.ionDrain > 0.5 || a.parts.ionDrain > 0.5) out.push(`Ion drain on your energy after resistance: ${fmt(b.parts.ionDrain)}/s (now ${fmt(a.parts.ionDrain)}/s).`);
    if (b.parts.sustain < 0.95) out.push(`⚠ Energy runs short in this fight — weapons and shield regeneration work ~${pct(b.parts.sustain)} of the time.`);
    if (b.parts.theirs < 1) out.push('You out-range and out-run them, so you can hit them from where they can\'t reply.');
    if (b.parts.mine < 1) out.push('⚠ They out-range and out-run this fit — expect them to pick you apart at range.');
    if (b.parts.theirIntercept > 0.1) out.push(`Their anti-missile stops ~${pct(b.parts.theirIntercept)} of your missiles.`);
    return out;
  }

  window.AfThreat = { governments, shipsFor, profile, duel, makeCounter, describe, explain };
})();
