'use strict';

// Auto-fit: what a fit does — totals, derived stats, warnings and the checks every result goes through.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AfStats = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const FPS = 60;

  // damage keys counted as "damage" for DPS (the big two plus status effects)
  const DAMAGE_KEYS = ['shield damage', 'hull damage', 'heat damage', 'ion damage', 'scrambling damage',
    'disruption damage', 'slowing damage', 'corrosion damage', 'discharge damage', 'burn damage', 'leak damage'];

  // missile / launcher?
  function isSecondary(o) {
    const w = o && o.attributes && o.attributes.weapon || o && o.weapon;
    return (o && (o.category === 'Secondary Weapons' || o.attributes?.category === 'Secondary Weapons')) || !!(w && w.ammunition);
  }
  // the weapon part of an outfit
  function weaponOf(o) {
    const w = (o && o.attributes && o.attributes.weapon) || (o && o.weapon);
    return w && typeof w === 'object' ? w : null;
  }
  // outfit attributes, nested or flat
  function attrsOf(o) { return (o && o.attributes) || o || {}; }

  // numbers for one weapon. Called by: totals, afOptimizer.prepare
  function weaponStats(o) {
    const w = weaponOf(o);
    if (!w) return null;
    const reload = Math.max(1, num(w.reload) || 1);
    const burst = Math.max(1, num(w['burst count']) || 1);
    const burstReload = Math.max(1, num(w['burst reload']) || reload);
    // shots per second, accounting for bursts (burst shots fire every burstReload, then a full reload)
    const cycle = burst > 1 ? (burst - 1) * burstReload + reload : reload;
    const shotsPerSec = FPS * burst / cycle;
    const dmg = {};
    let total = 0;
    for (const k of DAMAGE_KEYS) { const v = num(w[k]); if (v) { dmg[k] = v * shotsPerSec; if (k === 'shield damage' || k === 'hull damage') total += v * shotsPerSec; } }
    // submunitions: count their direct damage too (one level), they often carry most of it
    for (const key of ['submunitions', 'submunition', 'submunition_2']) {
      const subs = w[key];
      const list = Array.isArray(subs) ? subs : subs && typeof subs === 'object' ? [subs] : [];
      for (const s of list) {
        const count = Math.max(1, num(s.count) || 1);
        for (const k of ['shield damage', 'hull damage']) { const v = num(s[k]); if (v) { dmg[k] = (dmg[k] || 0) + v * count * shotsPerSec; total += v * count * shotsPerSec; } }
      }
    }
    const range = num(w['range override']) || num(w.velocity) * num(w.lifetime) || 0;
    return {
      dps: total, damage: dmg, shotsPerSec, range,
      energyPerSec: num(w['firing energy']) * shotsPerSec,
      heatPerSec: num(w['firing heat']) * shotsPerSec,
      fuelPerSec: num(w['firing fuel']) * shotsPerSec,
      // ammunition: [{ type: "Torpedo", count: 1 }] (parser) or a plain name
      ammo: Array.isArray(w.ammunition) ? (w.ammunition[0] && w.ammunition[0].type) || null
          : typeof w.ammunition === 'string' ? w.ammunition : (w.ammunition && w.ammunition.type) || null,
      ammoPerShot: Array.isArray(w.ammunition) ? Math.max(1, num(w.ammunition[0] && w.ammunition[0].count) || 1) : 1,
      antiMissile: num(w['anti-missile']),
      // homing / interceptable projectiles (what anti-missile and jamming work against)
      missileStrength: num(w['missile strength']),
      isMissile: num(w['missile strength']) > 0 || !!w.homing,
      tracking: { generic: num(w.tracking), radar: num(w['radar tracking']), optical: num(w['optical tracking']), infrared: num(w['infrared tracking']) },
      piercing: num(w.piercing),
    };
  }

  // add a hull and its outfits together. Called by: derive
  function totals(base, outfits, index) {
    const t = {};
    for (const [k, v] of Object.entries(base || {})) if (typeof v === 'number' || (typeof v === 'string' && v !== '' && isFinite(v))) t[k] = num(v);
    const weapons = [];
    const unknown = [];
    for (const [name, count] of outfits || []) {
      const o = index && index.get(name);
      if (!o) { unknown.push(name); continue; }
      const a = attrsOf(o);
      for (const [k, v] of Object.entries(a)) if (typeof v === 'number') t[k] = (t[k] || 0) + v * count;
      const ws = weaponStats(o);
      if (ws) weapons.push({ name, count, secondary: isSecondary(o), ...ws });
    }
    return { t, weapons, unknown };
  }

  // hull attributes, with gun ports / turret mounts counted from hardpoints. Called by: afUI, afPeers, afThreat
  function hullAttrs(ship) {
    const a = { ...(ship && ship.attributes || {}) };
    for (const k of ['mass', 'drag']) if (ship && ship[k] !== undefined && ship[k] !== '' && a[k] === undefined) a[k] = num(ship[k]);
    for (const [k, v] of Object.entries(a)) if (typeof v === 'string' && v !== '' && isFinite(v)) a[k] = Number(v);
    const hp = (ship && ship.hardpoints) || ship || {};
    const guns = Array.isArray(hp.guns) ? hp.guns.length : 0, turrets = Array.isArray(hp.turrets) ? hp.turrets.length : 0;
    if (!a['gun ports']) a['gun ports'] = guns;
    if (!a['turret mounts']) a['turret mounts'] = turrets;
    return a;
  }

  // everything about one fit. Called by: afUI, afPeers, afThreat, afWorker
  function derive(base, outfits, index) {
    const { t, weapons, unknown } = totals(base, outfits, index);
    return fromTotals(base, t, weapons, outfits, unknown);
  }

  // same, from running totals (the optimiser adds outfits one at a time). Called by: derive, afOptimizer
  function fromTotals(base, t, weapons, outfits, unknown = []) {
    const g = k => t[k] || 0;
    const mass = Math.max(1, g('mass'));
    // Ship::Drag(): drag / (1 + drag reduction), capped at the inertial mass
    const inertialMass = mass / (1 + Math.max(0, g('inertia reduction')));
    const drag = Math.max(0.01, Math.min(inertialMass, g('drag') / (1 + Math.max(0, g('drag reduction')))));
    const thrust = g('thrust'), turn = g('turn'), ab = g('afterburner thrust');

    const primary = weapons.filter(w => !w.secondary), secondary = weapons.filter(w => w.secondary);
    // weighted sum
    const sumW = (list, f) => list.reduce((s, w) => s + f(w) * w.count, 0);
    const dps = {
      primary: sumW(primary, w => w.dps), secondary: sumW(secondary, w => w.dps),
      shield: sumW(weapons, w => w.damage['shield damage'] || 0), hull: sumW(weapons, w => w.damage['hull damage'] || 0),
    };
    dps.total = dps.primary + dps.secondary;

    // ── energy / heat per second in each situation ──
    const idleE = (g('energy generation') + g('solar collection')) - g('energy consumption') - g('cooling energy');
    const moveE = -(g('thrusting energy') + g('turning energy'));
    const regenE = -(g('shield energy') + g('hull energy'));
    const fireE = -sumW(weapons, w => w.energyPerSec) / FPS;   // per frame below
    const perFrame = { idle: idleE, flying: idleE + moveE, fighting: idleE + moveE + regenE + fireE };
    const energy = {
      capacity: g('energy capacity'),
      perSec: Object.fromEntries(Object.entries(perFrame).map(([k, v]) => [k, v * FPS])),
    };
    energy.uptime = {};   // seconds until empty when negative (null = sustainable)
    for (const [k, v] of Object.entries(energy.perSec)) energy.uptime[k] = v < 0 ? (energy.capacity / -v) : null;

    const heatGen = g('heat generation') + g('solar heat') - g('cooling') - g('active cooling');
    const heatPerFrame = {
      idle: heatGen,
      flying: heatGen + g('thrusting heat') + g('turning heat'),
      fighting: heatGen + g('thrusting heat') + g('turning heat') + g('shield heat') + g('hull heat') + sumW(weapons, w => w.heatPerSec) / FPS,
    };
    const maxHeat = 100 * (mass + g('heat capacity'));
    const loss = 0.001 * g('heat dissipation');
    const heat = { max: maxHeat, perSec: {}, equilibriumPct: {}, overheatAfter: {} };
    for (const [k, h] of Object.entries(heatPerFrame)) {
      heat.perSec[k] = h * FPS;
      const eq = loss > 0 ? h / loss : (h > 0 ? Infinity : 0);
      heat.equilibriumPct[k] = maxHeat ? Math.max(0, eq / maxHeat * 100) : 0;
      // time to reach max heat from cold, if it ever does: solve H(t) = eq·(1 − e^(−loss·frames))
      if (eq > maxHeat && h > 0) heat.overheatAfter[k] = loss > 0 ? -Math.log(1 - maxHeat / eq) / loss / FPS : maxHeat / h / FPS;
      else heat.overheatAfter[k] = null;
    }

    // ── fuel ──
    const jumpFuel = g('jump fuel') || (g('hyperdrive') ? 100 : g('jump drive') ? 200 : 100);
    const fuelUse = g('afterburner fuel') * FPS + g('thrusting fuel') * FPS + sumW(weapons, w => w.fuelPerSec);
    const fuelGain = (g('ramscoop') > 0 ? 0.03 * Math.sqrt(g('ramscoop')) : 0) * FPS + g('fuel generation') * FPS;
    const fuel = {
      // no hyperdrive / jump drive / scram drive = no jumps at all, however much fuel
      capacity: g('fuel capacity'), jumps: (g('hyperdrive') || g('jump drive') || g('scram drive')) && jumpFuel ? Math.floor(g('fuel capacity') / jumpFuel) : 0, perJump: jumpFuel,
      burnPerSec: fuelUse, regenPerSec: fuelGain,
      afterburnerUptime: g('afterburner fuel') > 0 ? g('fuel capacity') / Math.max(1e-9, g('afterburner fuel') * FPS - fuelGain) : null,
    };

    // ── ammunition: seconds of continuous fire per launcher type ──
    const ammo = [];
    for (const w of secondary) {
      if (!w.ammo) continue;
      const have = (outfits || []).find(([n]) => n === w.ammo);
      const rounds = have ? have[1] : 0;
      const usePerSec = w.shotsPerSec * w.count * (w.ammoPerShot || 1);
      ammo.push({ weapon: w.name, ammo: w.ammo, rounds, seconds: usePerSec ? rounds / usePerSec : null });
    }

    const cap = k => ({ total: num(base?.[k]), free: g(k) });   // outfits subtract from the hull's capacity
    return {
      mass, drag, unknown,
      maxSpeed: FPS * thrust / drag,
      afterburnerSpeed: FPS * (thrust + ab) / drag,
      acceleration: FPS * FPS * thrust / inertialMass,
      turnRate: FPS * turn / inertialMass,
      shields: g('shields'), hull: g('hull'),
      shieldRegen: g('shield generation') * FPS, hullRegen: g('hull repair rate') * FPS,
      cargo: g('cargo space'), bunks: g('bunks'), requiredCrew: g('required crew'),
      dps, weapons, energy, heat, fuel, ammo,
      space: {
        outfit: cap('outfit space'), weapon: cap('weapon capacity'), engine: cap('engine capacity'),
        guns: cap('gun ports'), turrets: cap('turret mounts'), cargo: { total: num(base?.['cargo space']), free: g('cargo space') },
      },
      cost: g('cost'),
      raw: t,
    };
  }

  const fmtTime = s => s == null ? 'indefinitely' : s >= 3600 ? '1h+' : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.max(0, s).toFixed(1)}s`;

  // plain-English warnings. Called by: afUI.resultHtml, afWorker.suggestions
  function warnings(d) {
    const out = [];
    const sp = d.space;
    for (const [k, label] of [['outfit', 'outfit space'], ['weapon', 'weapon capacity'], ['engine', 'engine capacity'], ['guns', 'gun ports'], ['turrets', 'turret mounts']])
      if (sp[k].free < -1e-9) out.push({ level: 'error', text: `Over ${label} by ${(-sp[k].free).toLocaleString()}.` });
    if (d.energy.perSec.idle < 0) out.push({ level: 'error', text: `Loses energy even sitting still (${d.energy.perSec.idle.toFixed(0)}/s) — the batteries last ${fmtTime(d.energy.uptime.idle)}.` });
    else if (d.energy.perSec.flying < 0) out.push({ level: 'warn', text: `Flying flat-out drains energy (${d.energy.perSec.flying.toFixed(0)}/s): engines stall after ${fmtTime(d.energy.uptime.flying)} at 100%.` });
    if (d.energy.perSec.fighting < 0) out.push({ level: 'warn', text: `In a full fight (moving, all weapons firing, shields recharging) energy runs out after ${fmtTime(d.energy.uptime.fighting)} (${d.energy.perSec.fighting.toFixed(0)}/s).` });
    for (const [k, label] of [['idle', 'sitting still'], ['flying', 'flying flat-out'], ['fighting', 'in a full fight']]) {
      if (d.heat.overheatAfter[k] != null) { out.push({ level: k === 'fighting' ? 'warn' : 'error', text: `Overheats ${label} after about ${fmtTime(d.heat.overheatAfter[k])} (heat settles at ${Math.round(d.heat.equilibriumPct[k])}% of max).` }); break; }
    }
    if (d.fuel.afterburnerUptime != null) out.push({ level: 'info', text: `Afterburner uses fuel: a full tank gives ${fmtTime(d.fuel.afterburnerUptime)} of afterburner (leaving nothing to jump with).` });
    if (d.fuel.burnPerSec > 0 && d.fuel.afterburnerUptime == null) out.push({ level: 'info', text: `Some outfits burn fuel in use (${d.fuel.burnPerSec.toFixed(1)}/s) — a full tank lasts ${fmtTime(d.fuel.capacity / d.fuel.burnPerSec)}.` });
    if (!(d.raw['hyperdrive'] || d.raw['jump drive'] || d.raw['scram drive'])) out.push({ level: 'error', text: 'No hyperdrive or jump drive — it can\'t leave the system.' });
    else if (d.fuel.jumps < 1) out.push({ level: 'error', text: 'Not enough fuel for a single jump.' });
    for (const a of d.ammo) {
      if (!a.rounds) out.push({ level: 'warn', text: `${a.weapon} has no ${a.ammo} loaded.` });
      else out.push({ level: 'info', text: `${a.weapon}: ${a.rounds} × ${a.ammo} = ${fmtTime(a.seconds)} of continuous fire.` });
    }
    if (!(d.maxSpeed > 0)) out.push({ level: 'error', text: 'No engines — this ship can\'t move.' });
    if (!(d.turnRate > 0)) out.push({ level: 'error', text: 'No steering — this ship can\'t turn.' });
    if (d.maxSpeed > 0 && d.maxSpeed < 100) out.push({ level: 'warn', text: `Very slow (top speed ${Math.round(d.maxSpeed)}) — add a Top speed target if you need it faster.` });
    if (d.turnRate > 0 && d.turnRate < 20) out.push({ level: 'warn', text: `Turns very slowly (${d.turnRate.toFixed(1)}°/s) — add a Turning target if you need it nimbler.` });
    if (d.requiredCrew > d.bunks && d.bunks >= 0) out.push({ level: 'error', text: `Needs ${d.requiredCrew} crew but only has ${d.bunks} bunks.` });
    if (d.unknown.length) out.push({ level: 'warn', text: `${d.unknown.length} outfit(s) not found in the loaded plugins: ${d.unknown.slice(0, 3).join(', ')}${d.unknown.length > 3 ? '…' : ''}` });
    return out;
  }

  // only the plugins switched on (DataLoader). Called by: the auto-fit files
  function activeData() {
    const all = (typeof window !== 'undefined' && window.allData) || (typeof globalThis !== 'undefined' && globalThis.allData) || {};
    const DL = typeof window !== 'undefined' && window.DataLoader;
    const ids = DL && typeof DL.getActivePlugins === 'function' ? DL.getActivePlugins() : null;
    if (!ids || !ids.length) return all;
    const on = new Set(ids);
    return Object.fromEntries(Object.entries(all).filter(([k]) => on.has(k)));
  }

  // selected plugins without Local Builds. Called by: afPeers, afThreat, afUI
  function gameData() {
    const out = {};
    for (const [k, v] of Object.entries(activeData())) if (k !== '__local_builds__' && !(v && v._isLocal)) out[k] = v;
    return out;
  }

  // ids the selected plugins go by (null = no filter). Called by: afPool
  function activePluginIds() {
    const DL = typeof window !== 'undefined' && window.DataLoader;
    if (DL && typeof DL.getActivePluginIds === 'function') return DL.getActivePluginIds();
    return null;
  }
  // location map cut to the selected plugins. Called by: afPool
  function activeLocations(locations) {
    const ids = activePluginIds();
    return Object.entries(locations || {}).filter(([k, v]) => v && typeof v === 'object' && (!ids || ids.has(k))).map(([, v]) => v);
  }

  // ── stats you can set targets on (id → label, unit, getter; any raw attribute works too) ──
  const STATS = [
    ['dps', 'Damage / s (all weapons)', '/s', d => d.dps.total],
    ['dps.primary', 'Damage / s — primary weapons', '/s', d => d.dps.primary],
    ['dps.secondary', 'Damage / s — secondary weapons', '/s', d => d.dps.secondary],
    ['dps.shield', 'Shield damage / s', '/s', d => d.dps.shield],
    ['dps.hull', 'Hull damage / s', '/s', d => d.dps.hull],
    ['speed', 'Top speed', '', d => d.maxSpeed],
    ['abSpeed', 'Top speed with afterburner', '', d => d.afterburnerSpeed],
    ['accel', 'Acceleration', '', d => d.acceleration],
    ['turn', 'Turning', '°/s', d => d.turnRate],
    ['shields', 'Shields', '', d => d.shields],
    ['hull', 'Hull', '', d => d.hull],
    ['shieldRegen', 'Shield regeneration / s', '/s', d => d.shieldRegen],
    ['hullRegen', 'Hull repair / s', '/s', d => d.hullRegen],
    ['toughness', 'Toughness (shields + hull + 30 s of repair)', '', d => d.shields + d.hull + (d.shieldRegen + d.hullRegen) * 30],
    ['cargo', 'Cargo space', '', d => d.cargo],
    ['bunks', 'Bunks', '', d => d.bunks],
    ['spareBunks', 'Spare bunks (passengers)', '', d => d.bunks - d.requiredCrew],
    ['crew', 'Required crew', '', d => d.requiredCrew],
    ['jumps', 'Jumps of fuel', '', d => d.fuel.jumps],
    ['fuel', 'Fuel capacity', '', d => d.fuel.capacity],
    ['energy.fight', 'Energy / s in a full fight', '/s', d => d.energy.perSec.fighting],
    ['energy.fly', 'Energy / s flying', '/s', d => d.energy.perSec.flying],
    ['energy.idle', 'Energy / s sitting still', '/s', d => d.energy.perSec.idle],
    ['energyCap', 'Energy capacity (batteries)', '', d => d.energy.capacity],
    ['fightTime', 'Seconds of full fight before energy runs out', 's', d => d.energy.uptime.fighting == null ? 3600 : d.energy.uptime.fighting],
    ['heat.fight', 'Heat in a full fight', '%', d => d.heat.equilibriumPct.fighting],
    ['heat.fly', 'Heat flying flat-out', '%', d => d.heat.equilibriumPct.flying],
    ['heat.idle', 'Heat sitting still', '%', d => d.heat.equilibriumPct.idle],
    ['mass', 'Mass', 't', d => d.mass],
    ['cost', 'Cost (hull + outfits)', 'cr', d => d.cost],
    ['free.outfit', 'Free outfit space', '', d => d.space.outfit.free],
    ['free.weapon', 'Free weapon capacity', '', d => d.space.weapon.free],
    ['free.engine', 'Free engine capacity', '', d => d.space.engine.free],
  ].map(([id, label, unit, get]) => ({ id, label, unit, get }));
  const STAT_BY_ID = new Map(STATS.map(x => [x.id, x]));
  // checks every result goes through (fits, moves, powered, cool, crew, fuel, ammo). Called by: afWorker, afUI
  function verify(d) {
    const sp = d.space, out = [];
    const add = (ok, label, detail, fix) => out.push({ ok: !!ok, label, detail, fix });
    const over = Object.entries({ outfit: 'outfit space', weapon: 'weapon capacity', engine: 'engine capacity', guns: 'gun ports', turrets: 'turret mounts' })
      .filter(([k]) => sp[k].free < -1e-9).map(([, l]) => l);
    add(!over.length, 'Everything fits', over.length ? `over on ${over.join(', ')}` : 'within every capacity and mount');
    add(d.maxSpeed > 0, 'It can move', `top speed ${Math.round(d.maxSpeed)}`);
    add(d.turnRate > 0, 'It can turn', `${d.turnRate.toFixed(1)}°/s`);
    add(d.energy.perSec.idle >= 0, 'Powers itself when idle', `${d.energy.perSec.idle.toFixed(0)} energy/s`, { id: 'energy.idle', mode: 'min', value: 0, priority: 'must' });
    add(d.energy.perSec.flying >= 0, 'Powers itself while flying', `${d.energy.perSec.flying.toFixed(0)} energy/s`, { id: 'energy.fly', mode: 'min', value: 0, priority: 'must' });
    add(d.heat.equilibriumPct.idle <= 100, 'Stays cool when idle', `heat settles at ${Math.round(d.heat.equilibriumPct.idle)}%`, { id: 'heat.idle', mode: 'max', value: 95, priority: 'must' });
    add(d.heat.equilibriumPct.flying <= 100, 'Stays cool while flying', `heat settles at ${Math.round(d.heat.equilibriumPct.flying)}%`, { id: 'heat.fly', mode: 'max', value: 95, priority: 'must' });
    add(d.bunks >= d.requiredCrew, 'Room for its crew', `${d.bunks} bunks for ${d.requiredCrew} crew`, { id: 'spareBunks', mode: 'min', value: 0, priority: 'must' });
    add(d.fuel.jumps >= 1, 'Can jump to other systems', `${d.fuel.jumps} jump${d.fuel.jumps === 1 ? '' : 's'} of fuel`, { id: 'jumps', mode: 'min', value: 1, priority: 'must' });
    const dry = d.ammo.filter(a => !a.rounds).map(a => a.weapon);
    add(!dry.length, 'Launchers have ammunition', dry.length ? `no ammo for ${dry.join(', ')}` : (d.ammo.length ? 'all loaded' : 'no launchers'));
    return out;
  }

  // value of a target stat for a fit. Called by: afOptimizer, afUI, afWorker
  function statValue(d, id) {
    if (id.startsWith('attr:')) return d.raw[id.slice(5)] || 0;
    const st = STAT_BY_ID.get(id);
    return st ? Number(st.get(d)) || 0 : 0;
  }
  // label for a target stat
  function statLabel(id) { return id.startsWith('attr:') ? `${id.slice(5)} (attribute)` : (STAT_BY_ID.get(id) || { label: id }).label; }

  return { derive, fromTotals, totals, weaponStats, warnings, isSecondary, hullAttrs, fmtTime, activeData, activePluginIds, activeLocations,
           STATS, statValue, statLabel, verify, gameData, DAMAGE_KEYS };
});
