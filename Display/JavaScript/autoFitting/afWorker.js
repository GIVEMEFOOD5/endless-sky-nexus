'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  autoFitting/afWorker.js — runs auto-fit in the background
//
//  The search can take a few seconds. Running it here (a Web Worker) keeps
//  the page fully responsive — scrolling, clicking, typing all keep working
//  — while it sends back progress for the loading bar.
//
//  In:  { base, list, goal, opts, keep, mine, idx, counter: {profile, count} | null }
//  Out: { type: 'progress', phase, steps, outfits, pass }
//       { type: 'done', result }  |  { type: 'error', message }
// ═══════════════════════════════════════════════════════════════════════════

self.window = self;              // the shared modules expect a `window`
importScripts('afStats.js', 'afOptimizer.js', 'afThreat.js');

self.onmessage = e => {
  const job = e.data;
  const started = Date.now();
  try {
    const S = self.AfStats, O = self.AfOptimizer;
    const opts = { ...job.opts };
    if (job.counter) opts.counter = self.AfThreat.makeCounter(job.counter.profile, job.counter.count);

    const run = (options, pass) => O.optimize({
      base: job.base, candidates: job.list, goal: job.goal, options, keep: job.keep,
      reference: job.mine, referenceIndex: job.idx,
      onProgress: info => self.postMessage({ type: 'progress', pass, ...info }),
    });

    let r = run(opts, 1);
    // Check the result; if something basic fails (power, cooling, crew, fuel …),
    // fit again with each failure made a must-have.
    let checks = S.verify(r.derived);
    let repaired = null;
    const failing = checks.filter(c => !c.ok && c.fix);
    if (failing.length) {
      self.postMessage({ type: 'progress', pass: 2, phase: 'repairing', steps: 0, outfits: 0, fixing: failing.map(c => c.label) });
      const opts2 = { ...opts, targets: [...(opts.targets || []), ...failing.map((c, i) => ({ ...c.fix, order: -1 - i, ref: S.statValue(r.derived, c.fix.id) }))] };
      const r2 = run(opts2, 2);
      const checks2 = S.verify(r2.derived);
      if (checks2.filter(c => !c.ok).length < checks.filter(c => !c.ok).length) { repaired = failing.map(c => c.label); r = r2; checks = checks2; }
    }
    r.checks = checks; r.repaired = repaired;
    // All-round: the single best swap or addition toward each feature (heavy — done here too)
    if (job.goal === 'general') {
      self.postMessage({ type: 'progress', pass: 3, phase: 'suggestions', steps: 0, outfits: 0 });
      r.suggestionsRaw = suggestions(S, r, job);
    }
    r.workerMs = Date.now() - started;
    self.postMessage({ type: 'done', result: r });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};

function suggestions(S, r, job) {
  const out = [], base = job.base, idx = job.idx, now = r.derived;
  const metric = {
    'more damage': d => d.dps.total, 'more speed': d => d.maxSpeed, 'faster turning': d => d.turnRate,
    'more shields': d => d.shields + d.shieldRegen * 30, 'more cargo': d => d.cargo,
  };
  for (const [label, f] of Object.entries(metric)) {
    let best = null;
    // remove one outfit (not the hyperdrive) and add one candidate in its place
    const removable = r.outfits.filter(([n]) => { const o = idx.get(n) || {}; const a = o.attributes || o; return !(a.hyperdrive || a['jump drive']); });
    for (const [rm] of [[null], ...removable]) {
      const outs = r.outfits.map(([n, k]) => [n, n === rm ? k - 1 : k]).filter(([, k]) => k > 0);
      for (const c of job.list) {
        if (c.isAmmo) continue;
        const trial = [...outs];
        const i = trial.findIndex(([n]) => n === c.name);
        if (i >= 0) trial[i] = [c.name, trial[i][1] + 1]; else trial.push([c.name, 1]);
        const d = S.derive(base, trial, idx);
        if (S.warnings(d).some(w => w.level === 'error' && /^Over /.test(w.text))) continue;
        const gain = f(d) - f(now);
        if (gain > 0 && (!best || gain > best.gain)) best = { gain, add: c.name, rm };
      }
    }
    if (best) out.push({ label, ...best });
  }
  return out;
}
