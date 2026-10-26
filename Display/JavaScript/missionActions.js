'use strict';

// Completing a mission in a save: what it would do (rewards, events) and doing it.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MissionActions = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const clean = v => String(v ?? '').replace(/^"([^"]*)"$/, '$1');
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };

  // ── calendar (the game uses the normal Gregorian calendar) ──
  function addDays({ day, month, year }, days) {
    const d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCDate(d.getUTCDate() + Math.round(days));
    return { day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
  }

  // one block of the mission
  function block(raw, trigger) {
    return (raw || []).find(e => e && e.key === 'on' && Array.isArray(e.values) && e.values[0] === trigger) || null;
  }

  // what completing it would do. Called by: saveEditor
  function summarize(raw) {
    const out = { credits: 0, paymentNote: null, outfits: [], ships: [], conditions: [], events: [], skipped: [] };
    const b = block(raw, 'complete');
    if (b) for (const e of b.children || []) {
      const k = clean(e.key), v = (e.values || []).map(clean);
      if (k === 'payment') {
        const base = n(v[0]);
        if (base !== null) out.credits += base;
        if (base === null || v[1] !== undefined) out.paymentNote = 'plus a distance/cargo-based amount the game works out itself';
      } else if (k === 'outfit') {
        out.outfits.push({ name: v[0], count: v[1] === undefined ? 1 : (n(v[1]) ?? 1) });
      } else if (k === 'give' && v[0] === 'ship') {
        out.ships.push({ model: v[1], name: v[2] || v[1] });
      } else if (k === 'give' && v[0] === 'outfit') {
        out.outfits.push({ name: v[1], count: v[2] === undefined ? 1 : (n(v[2]) ?? 1) });
      } else if (k === 'event') {
        out.events.push({ name: v[0], delay: n(v[1]) ?? 0, maxDelay: n(v[2]) });
      } else if (k === 'set' || k === 'clear') {
        if (v[0]) out.conditions.push({ name: v[0], op: k });
      } else if (['=', '+=', '-=', '*=', '/=', '++', '--', '<?=', '>?='].includes(v[0])) {
        out.conditions.push({ name: k, op: v[0], value: v[1] !== undefined ? v[1] : null });
      } else if (['dialog', 'conversation', 'log', 'require', 'mark', 'unmark', 'music', 'fail', 'mute', 'debt'].includes(k)) {
        out.skipped.push(k);
      } else {
        out.skipped.push(k);
      }
    }
    return out;
  }

  // that in plain English. Called by: saveEditor, UserManagerMissionDisplay
  function describe(sum) {
    const lines = [];
    if (sum.credits) lines.push(`${sum.credits.toLocaleString()} credits${sum.paymentNote ? ` (${sum.paymentNote})` : ''}`);
    else if (sum.paymentNote) lines.push(`Payment: ${sum.paymentNote} — not added`);
    for (const o of sum.outfits) lines.push(o.count < 0 ? `Takes ${-o.count} × ${o.name}` : `${o.count} × ${o.name} (into cargo)`);
    for (const s of sum.ships) lines.push(`Ship: ${s.model}${s.name && s.name !== s.model ? ` “${s.name}”` : ''}`);
    for (const c of sum.conditions) lines.push(c.op === 'set' ? `Sets ${c.name}` : c.op === 'clear' ? `Clears ${c.name}` : `${c.name} ${c.op}${c.value != null ? ' ' + c.value : ''}`);
    for (const e of sum.events) lines.push(`Event “${e.name}”${e.delay ? ` in ${e.delay}${e.maxDelay ? '–' + e.maxDelay : ''} days` : ' tomorrow'}`);
    return lines;
  }

  // condition arithmetic as the game does it (whole numbers)
  function applyOp(cur, op, value, getCond) {
    const rhs = value == null ? 0 : (n(value) ?? (getCond ? getCond(clean(value)) : 0));
    switch (op) {
      case 'set': return 1;
      case 'clear': return 0;
      case '=': return rhs;
      case '+=': return cur + rhs;
      case '-=': return cur - rhs;
      case '*=': return cur * rhs;
      case '/=': return rhs ? Math.trunc(cur / rhs) : cur;
      case '++': return cur + 1;
      case '--': return cur - 1;
      case '<?=': return Math.min(cur, rhs);
      case '>?=': return Math.max(cur, rhs);
      default: return cur;
    }
  }

  // apply to a save (mode: 'rewards' = done + rewards, 'done' = just done). Called by: saveEditor, UserManagerMissionDisplay
  function apply(doc, missionName, sum, { mode = 'rewards', addShip } = {}) {
    const done = [];
    const get = c => Number(doc.getCondition(c)) || 0;
    if (mode === 'reset') {
      for (const s of ['offered', 'done', 'failed', 'declined', 'aborted'])
        if (get(`${missionName}: ${s}`)) { doc.deleteCondition(`${missionName}: ${s}`); done.push(`Cleared “${missionName}: ${s}”`); }
      if (!done.length) done.push('It already had no history — nothing to change');
      return done;
    }
    if (!get(`${missionName}: offered`)) doc.setCondition(`${missionName}: offered`, 1);
    doc.setCondition(`${missionName}: done`, 1);
    done.push(`Marked “${missionName}” as completed`);
    if (mode !== 'rewards') return done;

    if (sum.credits) { doc.addCredits(BigInt(Math.trunc(sum.credits))); done.push(`+${sum.credits.toLocaleString()} credits`); }
    for (const o of sum.outfits) {
      const cur = Number(doc.cargo.outfits[o.name]) || 0;
      doc.setCargoOutfit(o.name, Math.max(0, cur + o.count));
      done.push(o.count < 0 ? `Removed ${-o.count} × ${o.name} from cargo` : `${o.count} × ${o.name} added to cargo`);
    }
    for (const s of sum.ships) {
      if (addShip && addShip(s.model, s.name)) done.push(`Ship “${s.name}” (${s.model}) added`);
      else done.push(`⚠ Couldn't add ship ${s.model} — its plugin isn't loaded on this page`);
    }
    for (const c of sum.conditions) {
      const next = applyOp(get(c.name), c.op, c.value, get);
      doc.setCondition(c.name, next);
      done.push(next ? `${c.name} = ${next}` : `Cleared ${c.name}`);
    }
    const today = doc.date;
    for (const e of sum.events) {
      const when = addDays(today, Math.max(1, e.delay || 0));
      doc.scheduleEvent(e.name, when);
      done.push(`Event “${e.name}” scheduled for ${when.day}/${when.month}/${when.year}`);
    }
    return done;
  }

  return { summarize, describe, apply, addDays, applyOp };
});
