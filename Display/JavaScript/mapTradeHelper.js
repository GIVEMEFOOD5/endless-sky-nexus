'use strict';

// The 💰 Trade panel on the map: best buy-here, sell-there runs within a few jumps.

(function () {
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = n => Math.round(n).toLocaleString();
  const PREF = 'es_map_trade_prefs';
  let prefs = (() => { try { return { maxJumps: 4, visitedOnly: true, ...(JSON.parse(localStorage.getItem(PREF)) || {}) }; } catch (_) { return { maxJumps: 4, visitedOnly: true }; } })();
  // save the panel settings
  const savePrefs = () => { try { localStorage.setItem(PREF, JSON.stringify(prefs)); } catch (_) {} };

  // error function (for the game's price curve)
  function erf(x) {
    const s = Math.sign(x); x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }

  // each commodity's base price
  function basePrices(pluginDataMap, activeOutputNames) {
    const out = new Map();       // system → Map(commodity → base)
    for (const name of activeOutputNames) {
      for (const raw of pluginDataMap.get(name)?.systems || []) {
        if (!raw?.name || !Array.isArray(raw.trade) || !raw.trade.length) continue;
        const m = out.get(raw.name) || new Map();
        for (const t of raw.trade) if (t && t.name != null && Number.isFinite(Number(t.cost))) m.set(t.name, Number(t.cost));
        out.set(raw.name, m);
      }
    }
    return out;
  }

  // what each system sells
  function supplies(doc) {
    const eco = doc.topAll('economy').pop();   // a damaged save can have several; the game keeps the last
    const out = new Map();
    if (!eco) return out;
    let header = null;
    for (const n of eco.children) {
      if (!n.tokens) continue;
      if (n.tokens[0] === 'purchases') continue;
      if (n.tokens[0] === 'system') { header = n.tokens.slice(1); continue; }
      if (!header) continue;
      const m = new Map();
      header.forEach((c, i) => { const v = Number(n.tokens[i + 1]); if (Number.isFinite(v)) m.set(c, v); });
      out.set(n.tokens[0], m);
    }
    return out;
  }

  // name → outfit
  function outfitIndex() {
    const idx = new Map();
    for (const p of Object.values(window.allData || {})) for (const o of p.outfits || []) if (o && o.name && !idx.has(o.name)) idx.set(o.name, o);
    return idx;
  }

  // your ship's cargo space
  function cargoSpace(doc) {
    const outfits = outfitIndex();
    const here = doc.system;
    let total = 0, ships = 0;
    for (const s of doc.ships) {
      if (s.parked || (s.system && s.system !== here)) continue;
      ships++;
      total += Number(s.attributes['cargo space']) || 0;
      for (const [name, count] of Object.entries(s.outfits)) total += (Number(outfits.get(name)?.['cargo space']) || 0) * count;
    }
    const carried = doc.cargo;
    let used = Object.values(carried.commodities).reduce((a, b) => a + b, 0);
    for (const [name, count] of Object.entries(carried.outfits)) used += (Number(outfits.get(name)?.mass) || 0) * count;
    return { total: Math.max(0, total), free: Math.max(0, Math.floor(total - used)), used: Math.ceil(used), ships };
  }

  // work out the best runs
  function compute() {
    const ss = window.MapSaveState;
    const ctx = ss && ss.context();
    const map = ss && ss.lastMap();
    if (!ctx || !ctx.doc || !map) return null;
    const { systemsByName, pluginDataMap, activeOutputNames } = map;
    const doc = ctx.doc;
    const start = doc.system;
    if (!start || !systemsByName.has(start)) return { error: `Your pilot's system (${start || 'unknown'}) isn't on this map.` };

    const base = basePrices(pluginDataMap, activeOutputNames);
    // System::Price::Update constants, as the parser read them from System.cpp
    const GK = window.GameKeys;
    const scale = Number(GK ? GK.gameRule('trade.priceScale', -100) : -100);
    const limit = Number(GK ? GK.gameRule('trade.supplyLimit', 20000) : 20000) || 20000;
    const supply = supplies(doc);
    const canTrade = name => {
      const s = systemsByName.get(name);
      return s && base.has(name) && (s.planets || []).some(p => p.hasSpaceport) &&
             (!prefs.visitedOnly || ctx.visitedSystems.has(name) || name === start);
    };
    // price in a system (the game's formula)
    const priceAt = (sys, c) => {
      const b = base.get(sys)?.get(c);
      if (b == null) return null;
      return b + Math.trunc(scale * erf((supply.get(sys)?.get(c) || 0) / limit));
    };

    // jumps from the pilot's system
    const dist = new Map([[start, 0]]), prev = new Map();
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      const d = dist.get(cur);
      if (d >= prefs.maxJumps) continue;
      for (const next of systemsByName.get(cur)?.links || []) {
        if (!systemsByName.has(next) || dist.has(next)) continue;
        dist.set(next, d + 1); prev.set(next, cur); queue.push(next);
      }
    }
    const pathTo = name => { const p = [name]; while (prev.has(p[0])) p.unshift(prev.get(p[0])); return p; };
    const reachable = [...dist.keys()].filter(canTrade);

    // jumps between systems (breadth-first search)
    const jumpsBetween = (a, b) => {
      if (a === b) return 0;
      const seen = new Map([[a, 0]]); const q = [a];
      while (q.length) {
        const c = q.shift(); const d = seen.get(c);
        if (d > prefs.maxJumps * 2) break;
        for (const n of systemsByName.get(c)?.links || []) {
          if (seen.has(n) || !systemsByName.has(n)) continue;
          if (n === b) return d + 1;
          seen.set(n, d + 1); q.push(n);
        }
      }
      return null;
    };

    const cargo = cargoSpace(doc);
    const fromHere = [], anywhere = [];
    const commodities = new Set(); for (const m of base.values()) for (const c of m.keys()) commodities.add(c);
    for (const c of commodities) {
      const prices = reachable.map(s => ({ s, p: priceAt(s, c) })).filter(x => x.p != null);
      if (prices.length < 2) continue;
      const here = prices.find(x => x.s === start);
      if (here && canTrade(start)) {
        const best = prices.filter(x => x.s !== start).sort((a, b) => b.p - a.p)[0];
        if (best && best.p > here.p) fromHere.push({ c, buyAt: start, buy: here.p, sellAt: best.s, sell: best.p, jumps: dist.get(best.s), toStart: 0 });
      }
      const cheapest = prices.slice().sort((a, b) => a.p - b.p).slice(0, 4);
      const dearest = prices.slice().sort((a, b) => b.p - a.p).slice(0, 4);
      for (const lo of cheapest) for (const hi of dearest) {
        if (lo.s === hi.s || hi.p <= lo.p) continue;
        const j = jumpsBetween(lo.s, hi.s);
        if (j == null || j > prefs.maxJumps) continue;
        anywhere.push({ c, buyAt: lo.s, buy: lo.p, sellAt: hi.s, sell: hi.p, jumps: j, toStart: dist.get(lo.s) });
      }
    }
    const score = r => { r.perTon = r.sell - r.buy; r.total = r.perTon * cargo.free; r.perJump = r.total / Math.max(1, r.jumps + r.toStart); return r; };
    fromHere.forEach(score); anywhere.forEach(score);
    fromHere.sort((a, b) => b.perJump - a.perJump);
    anywhere.sort((a, b) => b.perJump - a.perJump);
    // best few rows per buy/sell/commodity
    const uniq = arr => { const seen = new Set(); return arr.filter(r => { const k = `${r.c}|${r.buyAt}|${r.sellAt}`; if (seen.has(k)) return false; seen.add(k); return true; }); };
    return { start, cargo, fromHere: uniq(fromHere).slice(0, 8), anywhere: uniq(anywhere).slice(0, 12), pathTo,
             reachable: reachable.length, pilot: ctx.pilot, hasEconomy: supply.size > 0 };
  }

  // ── panel ──
  function panel() {
    let p = document.getElementById('mapTradePanel');
    if (p) return p;
    const after = document.getElementById('mapDetailsPanel');
    if (!after) return null;
    p = document.createElement('div');
    p.id = 'mapTradePanel'; p.className = 'panel'; p.style.marginTop = '16px';
    after.insertAdjacentElement('afterend', p);
    return p;
  }

  const sysLink = name => `<button type="button" class="map-trade-sys" data-sys="${h(name)}" style="background:none;border:none;padding:0;color:var(--c-accent-text);cursor:pointer;text-decoration:underline;font:inherit;">${h(name)}</button>`;

  // results table
  function table(rows, showStart) {
    if (!rows.length) return '<p style="color:var(--c-text-dim);margin:6px 0 0;">Nothing profitable within reach.</p>';
    return `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.86rem;">
      <thead><tr style="text-align:left;color:var(--c-text-dim);">
        <th>Commodity</th>${showStart ? '<th>Buy at</th>' : ''}<th>Buy</th><th>Sell at</th><th>Sell</th><th>Profit / ton</th><th>Jumps</th><th>Full load</th>
      </tr></thead><tbody>
      ${rows.map(r => `<tr style="border-top:1px solid var(--c-border);">
        <td>${h(r.c)}</td>${showStart ? `<td>${sysLink(r.buyAt)}${r.toStart ? ` <span style="color:var(--c-text-dim);">(${r.toStart} away)</span>` : ''}</td>` : ''}
        <td>${fmt(r.buy)}</td><td>${sysLink(r.sellAt)}</td><td>${fmt(r.sell)}</td>
        <td style="color:var(--c-success-text);">+${fmt(r.perTon)}</td><td>${r.jumps}</td>
        <td>${r.total > 0 ? '+' + fmt(r.total) : '—'}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  // draw the panel
  function render() {
    const p = panel();
    if (!p) return;
    const ss = window.MapSaveState;
    if (!ss || !ss.isActive()) { p.style.display = 'none'; return; }
    p.style.display = '';
    const r = compute();
    const controls = `
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:10px;">
        <h2 class="section-title" style="margin:0;">💰 Trade runs</h2>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;">Within
          <select id="mapTradeJumps">${[1, 2, 3, 4, 5, 6, 8, 10].map(n => `<option value="${n}"${n === prefs.maxJumps ? ' selected' : ''}>${n} jump${n === 1 ? '' : 's'}</option>`).join('')}</select></label>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;"><input type="checkbox" id="mapTradeVisited"${prefs.visitedOnly ? ' checked' : ''}> Only systems you've visited</label>
      </div>`;
    if (!r) { p.innerHTML = controls + '<p style="color:var(--c-text-dim);">Re-upload this save on the Saves page to get trade suggestions.</p>'; bind(p); return; }
    if (r.error) { p.innerHTML = controls + `<p style="color:var(--c-text-dim);">${h(r.error)}</p>`; bind(p); return; }
    p.innerHTML = controls + `
      <p style="font-size:0.85rem;color:var(--c-text-mid);margin:0 0 12px;">
        ${h(r.pilot)} is in ${sysLink(r.start)} with <strong>${fmt(r.cargo.free)}</strong> tons free
        (${fmt(r.cargo.total)} cargo space across ${r.cargo.ships} ship${r.cargo.ships === 1 ? '' : 's'}${r.cargo.used ? `, ${fmt(r.cargo.used)} in use` : ''}).
        ${r.reachable} trading system${r.reachable === 1 ? '' : 's'} in range.
        ${r.hasEconomy ? '' : 'This save has no price data yet, so base prices are used.'}
      </p>
      <h3 style="margin:0 0 4px;font-size:0.95rem;">Buy here, sell nearby</h3>
      ${table(r.fromHere, false)}
      <h3 style="margin:16px 0 4px;font-size:0.95rem;">Best runs in range</h3>
      ${table(r.anywhere, true)}
      <p style="font-size:0.78rem;color:var(--c-text-dim);margin:10px 0 0;">Prices move as you buy and sell, and drift day to day, so large loads earn a little less than shown. Jumps count hyperspace links only.</p>`;
    bind(p);
  }

  // wire up its inputs
  function bind(p) {
    const j = p.querySelector('#mapTradeJumps'), v = p.querySelector('#mapTradeVisited');
    if (j) j.onchange = () => { prefs.maxJumps = Number(j.value); savePrefs(); render(); };
    if (v) v.onchange = () => { prefs.visitedOnly = v.checked; savePrefs(); render(); };
    p.onclick = e => {
      const b = e.target.closest('.map-trade-sys');
      if (b && window.MapView) window.MapView.selectSystem(b.dataset.sys);
    };
  }

  document.addEventListener('mapSaveStateApplied', () => setTimeout(render, 0));
  window.MapTradeHelper = { compute, render, _erf: erf };
})();
