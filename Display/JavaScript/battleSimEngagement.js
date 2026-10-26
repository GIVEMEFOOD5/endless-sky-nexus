'use strict';

// How the fight is flown: distance, kiting, aim, dodging, turning and missile locks, with pilot skill. Used by battleSim.

(function () {
  const FPS = 60;
  const START_DISTANCE = 2500;     // px — both fleets begin outside nearly every weapon's reach
  const MIN_DISTANCE = 120;        // px — ships don't fly through each other
  const DODGE_SHARE = 0.6;         // a pilot also has to fight, so they don't dodge flat-out all the time
  const RAD = 180 / Math.PI;
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  // a team's speed, turning and size. Called by: side
  function movement(stats) {
    const entries = stats._teamShips && stats._teamShips.length ? stats._teamShips : [{ resolved: stats, count: 1 }];
    let n = 0, speed = 0, accel = 0, turn = 0, radius = 0, radar = 0, optical = 0;
    for (const e of entries) {
      const r = e.resolved, c = e.count || 1, cb = r.combined || {};
      const mass = Math.max(1, num(r.inertialMass) || num(r.rawMass) || num(cb.mass) || 100);
      n += c;
      speed += num(r.maxVelocity) * c;                       // px/s
      accel += num(r.acceleration) * c;                      // px/s²
      turn += (FPS * num(cb.turn) / mass) * c;               // °/s
      radius += 6 * Math.cbrt(Math.max(1, num(r.rawMass) || mass)) * c;
      radar += num(cb['radar jamming']) * c;
      optical += num(cb['optical jamming']) * c;
    }
    n = Math.max(1, n);
    return { speed: speed / n, accel: accel / n, turn: turn / n, radius: radius / n, radar: radar / n, optical: optical / n };
  }

  // what a weapon does in flight (range, speed, homing …)
  function weaponFacts(w, meta) {
    const vel = num(w.velocity) * FPS;                          // px/s
    const life = num(w.lifetime);
    const beam = life <= 1 || vel >= 60000;
    return {
      range: Math.max(0, num(meta && meta.range) || num(w['range override']) || num(w.velocity) * life),
      speed: vel, beam,
      inaccuracy: num(w.inaccuracy),                             // degrees (cone half-angle)
      homing: num(w.homing) > 0 || (w.homing && typeof w.homing === 'object'),
      track: { radar: num(w['radar tracking']), optical: num(w['optical tracking']), infrared: num(w['infrared tracking']), generic: num(w.tracking) },
      turret: !!(meta && meta.turret),
      turretTurn: num(w['turret turn']) * FPS,                  // °/s
      antiMissile: num(w['anti-missile']) > 0,
      damaging: !(num(w['anti-missile']) > 0) && !(num(w['tractor beam']) > 0),
    };
  }

  // ── hit and lock chances ──
  const jamAt = (j, d) => j > 0 ? j * (1 - Math.min(1, d / (500 + Math.sqrt(j) * 500))) : 0;
  // missile lock chance
  function lockChance(f, target, d, heatFrac) {
    const t = f.track;
    const any = t.radar + t.optical + t.infrared + t.generic;
    if (!any) return 0.9;                                          // homing with no listed seeker: assume it mostly finds you
    const p = [
      Math.min(1, t.radar / (1 + jamAt(target.radar, d))),
      Math.min(1, t.optical / (1 + jamAt(target.optical, d))),
      Math.min(1, t.infrared * Math.min(1, heatFrac * 1.5)),
      Math.min(1, t.generic),
    ];
    return 1 - p.reduce((miss, x) => miss * (1 - x), 1);
  }
  // skill 0–1: skilled pilots dodge, lead and track; ordinary ones charge in
  const skillOf = s => (s && Number.isFinite(s.skill) ? Math.max(0, Math.min(1, s.skill)) : 1);
  // chance an unguided shot hits
  function unguidedHit(f, attacker, target, d) {
    const t = f.beam || !f.speed ? 0 : d / f.speed;                // flight time (s)
    const dodge = DODGE_SHARE * skillOf(target) * Math.min(target.speedNow * t, 0.5 * target.accel * t * t);
    const spread = d * Math.tan(Math.min(89, f.inaccuracy) / RAD);
    const aim = 0.7 + 0.3 * skillOf(attacker);                      // leading the target
    return Math.max(0.03, Math.min(1, aim * target.radius / (target.radius + 0.5 * spread + dodge)));
  }
  // can the guns stay on target?
  function facing(f, attacker, target, d) {
    // the enemy's sideways motion, as an angle per second seen from here
    const omega = (target.speedNow * 0.5 / Math.max(MIN_DISTANCE, d)) * RAD;
    const canTurn = (f.turret ? (f.turretTurn || 60) : attacker.turnNow) * (0.6 + 0.4 * skillOf(attacker));
    return omega <= 0 ? 1 : Math.max(0.15, Math.min(1, canTurn / omega));
  }

  // one fight between A and B: create(), then step() every frame. Called by: battleSim.simulateBattle
  function create(sA, sB, metaA, metaB) {
    // one side's numbers
    const side = (stats, meta) => {
      const mv = movement(stats);
      return { stats, mv, facts: stats.weapons.map((w, i) => weaponFacts(w, meta && meta[i])), v: 0, speedNow: mv.speed, turnNow: mv.turn,
               accel: mv.accel, radius: mv.radius, radar: mv.radar, optical: mv.optical, running: false,
               skill: Number.isFinite(stats.skill) ? Math.max(0, Math.min(1, stats.skill)) : 1 };
    };
    const A = side(sA, metaA), B = side(sB, metaB);
    const sides = { A, B };
    let d = START_DISTANCE;
    let vel = 0;   // current rate of change of the distance, px/frame
    const log = { frames: 0, distSum: 0, engaged: 0, engagedDist: 0, inRangeA: 0, inRangeB: 0, hitA: 0, firedA: 0, hitB: 0, firedB: 0, kitedA: 0, kitedB: 0 };

    // expected damage per second at a distance (for planning)
    const nominal = (me, foe, x) => {
      let sum = 0;
      me.facts.forEach((f, i) => {
        const w = me.stats.weapons[i];
        if (!f.damaging || x > f.range) return;
        const reload = Math.max(1, num(w.reload) || 1);
        const dmg = num(w['shield damage']) + num(w['hull damage']) + 1;   // +1 so status-only weapons still count a little
        const p = f.homing ? lockChance(f, foe, x, 0.5) : unguidedHit(f, me, foe, x) * facing(f, me, foe, x);
        sum += dmg * (FPS / reload) * p;
      });
      return sum;
    };
    // distances worth considering
    const candidates = () => {
      // planned distances sit just inside or just outside someone's reach (never exactly on it)
      const r = new Set([MIN_DISTANCE]);
      for (const s of [A, B]) for (const f of s.facts) if (f.damaging && f.range > 0) { r.add(f.range * 0.95); r.add(f.range * 1.05); }
      return [...r].filter(x => x >= MIN_DISTANCE && x <= START_DISTANCE).sort((a, b) => a - b);
    };
    const regen = s => num(s.stats.shieldRegenPerSec) + num(s.stats.hullRepairPerSec);
    // pick a distance
    const plan = (me, foe) => {
      // best distance: where I wear them down fastest compared with them wearing me down
      let best = MIN_DISTANCE, bestScore = -Infinity;
      const myHp = me.stats.maxShields + me.stats.maxHull, foeHp = foe.stats.maxShields + foe.stats.maxHull;
      for (const x of candidates()) {
        const mine = Math.max(0, nominal(me, foe, x) - regen(foe)), theirs = Math.max(0, nominal(foe, me, x) - regen(me));
        const score = mine / Math.max(1, foeHp) - theirs / Math.max(1, myHp);
        if (score > bestScore + 1e-12) { bestScore = score; best = x; }
      }
      return best;
    };
    // skilled pilots fly to their best distance; ordinary ones close in
    const want = (me, foe) => MIN_DISTANCE + me.skill * (plan(me, foe) - MIN_DISTANCE);
    A.want = want(A, B); B.want = want(B, A);

    // Re-think every 5 s: if I'm not wearing them down where I am (their repairs
    // keep up), a good pilot moves in closer to where more of my weapons bite.
    const RETHINK = 5 * FPS;
    const hpOf = st => Math.max(0, st.shields) + Math.max(0, st.hull);
    // change plan if not getting through (skilled only)
    function rethink(me, foe, foeSt) {
      if (me.skill < 0.5) return;                       // only skilled pilots change their plan mid-fight
      if (me.lastFoeHp != null && hpOf(foeSt) >= me.lastFoeHp - 1) {
        const closer = candidates().filter(x => x < me.want - 20 && nominal(me, foe, x) > nominal(me, foe, me.want) * 1.1);
        if (closer.length) { me.want = closer[closer.length - 1]; me.replans = (me.replans || 0) + 1; }
      }
      me.lastFoeHp = hpOf(foeSt);
    }

    // move one frame
    function step(stA, stB) {
      // once one side is out of the fight there's nothing left to fly (and it would skew the report)
      if (stA.disabled || stA.destroyed || stB.disabled || stB.destroyed) return;
      if (log.frames && log.frames % RETHINK === 0 && (log.inRangeA || log.inRangeB)) { rethink(A, B, stB); rethink(B, A, stA); }
      for (const [s, st] of [[A, stA], [B, stB]]) {
        const stalled = st.isOverheated || st.isIonized || st.disabled || st.destroyed;
        const slow = 1 / (1 + num(st.statusEffects && st.statusEffects.slowing) / 100);
        s.speedNow = stalled ? 0 : s.mv.speed * slow;
        s.turnNow = stalled ? 0 : s.mv.turn;
      }
      // which way each pilot wants the distance to go (+1 away, −1 closer, 0 hold)
      const dirOf = s => (d < s.want - 20 ? 1 : d > s.want ? -1 : 0);
      A.dir = dirOf(A); B.dir = dirOf(B);
      let rate;   // change in distance, px/s
      if (A.dir === B.dir) rate = A.dir * (A.speedNow + B.speedNow);            // agree (or both holding)
      else if (!A.dir || !B.dir) {
        // one moves, the other holds its distance by matching it — only extra speed gets through
        const mover = A.dir ? A : B, holder = mover === A ? B : A;
        rate = mover.dir * Math.max(0, mover.speedNow - holder.speedNow);
      } else {
        // one runs, one chases: the difference in speed decides
        const runner = A.dir > 0 ? A : B, chaser = runner === A ? B : A;
        rate = runner.speedNow - chaser.speedNow;
      }
      // pilots brake in time to stop at the distance that's being fought for
      // (otherwise they'd overshoot and swing back and forth past it)
      let goal;
      if (A.dir === B.dir) goal = A.dir > 0 ? Math.min(A.want, B.want) : Math.max(A.want, B.want);
      else if (!A.dir || !B.dir) goal = (A.dir ? A : B).want;
      else goal = rate > 0 ? (A.dir > 0 ? A : B).want : (A.dir < 0 ? A : B).want;
      const accel = Math.max(1, Math.min(A.accel, B.accel));
      const brake = Math.sqrt(2 * accel * Math.abs(goal - d));
      rate = Math.max(-brake, Math.min(brake, rate));
      // getting up to speed takes time
      const target = rate / FPS;
      const dv = Math.max(-accel / (FPS * FPS), Math.min(accel / (FPS * FPS), target - vel));
      vel += dv;
      d = Math.max(MIN_DISTANCE, Math.min(START_DISTANCE * 1.5, d + vel));
      if (d === MIN_DISTANCE && vel < 0) vel = 0;
      // running = heading away while the other chases (forward guns rarely bear)
      A.running = A.dir > 0 && B.dir < 0; B.running = B.dir > 0 && A.dir < 0;
      log.frames++; log.distSum += d;
      const reach = s => s.reach ?? (s.reach = s.facts.reduce((m, f) => Math.max(m, f.damaging ? f.range : 0), 0));
      const inA = reach(A) >= d, inB = reach(B) >= d;
      if (inA || inB) { log.engaged++; log.engagedDist += d; }
      if (inA) log.inRangeA++;
      if (inB) log.inRangeB++;
      if (inA && !inB) log.kitedB++;     // A can hit, B can't reach
      if (inB && !inA) log.kitedA++;
    }

    // damage multiplier for a weapon this frame
    function factor(who, i, defSt) {
      const me = sides[who], foe = who === 'A' ? B : A;
      const f = me.facts[i];
      if (!f || !f.damaging) return 1;
      if (d > f.range) return 0;                                      // out of reach: hold fire
      const heatFrac = defSt && defSt.stats && defSt.stats.maxHeat ? Math.max(0, defSt.heat) / defSt.stats.maxHeat : 0.5;
      let p;
      if (f.homing) p = lockChance(f, foe, d, heatFrac);
      else {
        p = unguidedHit(f, me, foe, d) * facing(f, me, foe, d);
        if (me.running && !f.turret) p *= 0.25;                     // running away: forward guns only now and then
      }
      log['fired' + who]++; log['hit' + who] += p;
      return p;
    }

    // notes on how it was flown
    function summary(nameA, nameB) {
      const avgD = log.engaged ? log.engagedDist / log.engaged : (log.frames ? log.distSum / log.frames : d);
      const reachA = Math.max(0, ...A.facts.filter(f => f.damaging).map(f => f.range));
      const reachB = Math.max(0, ...B.facts.filter(f => f.damaging).map(f => f.range));
      const notes = [];
      const pct = x => `${Math.round(x * 100)}%`;
      if (A.skill < 1 || B.skill < 1) notes.push(`Pilots: ${nameA} ${pct(A.skill)} skilled, ${nameB} ${pct(B.skill)} skilled (ordinary pilots charge in, don't dodge and aim less well).`);
      notes.push(`Fought at ~${Math.round(avgD)} px on average. ${nameA} plans to fight at ~${Math.round(A.want)} px (reach ${Math.round(reachA)}), ${nameB} at ~${Math.round(B.want)} px (reach ${Math.round(reachB)}).`);
      notes.push(`Speed ${Math.round(A.mv.speed)} vs ${Math.round(B.mv.speed)}; turning ${Math.round(A.mv.turn)}°/s vs ${Math.round(B.mv.turn)}°/s.`);
      const eng = Math.max(1, log.engaged);
      if (log.kitedB > eng * 0.3) notes.push(`${nameA} kites ${nameB}: while fighting, it stays out of ${nameB}'s reach ${Math.round(100 * log.kitedB / eng)}% of the time.`);
      if (log.kitedA > eng * 0.3) notes.push(`${nameB} kites ${nameA}: while fighting, it stays out of ${nameA}'s reach ${Math.round(100 * log.kitedA / eng)}% of the time.`);
      for (const [s, n, foe] of [[A, nameA, nameB], [B, nameB, nameA]])
        if (s.replans) notes.push(`${n} wasn't getting through ${foe}'s repairs at range, so it moved in closer (${s.replans}×, ending at ~${Math.round(s.want)} px).`);
      const acc = w => log['fired' + w] ? Math.round(100 * log['hit' + w] / log['fired' + w]) : null;
      if (acc('A') != null) notes.push(`${nameA}'s shots land ~${acc('A')}% of the time; ${nameB}'s ~${acc('B') ?? 0}%.`);
      return { avgDistance: avgD, wantA: A.want, wantB: B.want, reachA, reachB, accuracyA: acc('A'), accuracyB: acc('B'),
               inRangeA: log.frames ? log.inRangeA / log.frames : 0, inRangeB: log.frames ? log.inRangeB / log.frames : 0, notes };
    }

    return { step, factor, summary, get distance() { return d; } };
  }

  window.BattleEngagement = { create, movement, weaponFacts };
})();
