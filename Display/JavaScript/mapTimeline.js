'use strict';

// The 🕰 Timeline panel on the map: preview story events, step through your pilot's history.

(function () {
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const S = () => window.MapSaveState;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = d => d ? `${d.day} ${MONTHS[d.month - 1] || d.month} ${d.year}` : '';
  const dayNum = d => d ? Date.UTC(d.year, d.month - 1, d.day) / 86400000 : null;
  const TRIGGER_TEXT = {
    offer: 'when it is offered', accept: 'if you accept it', decline: 'if you decline it', defer: 'if you put it off',
    complete: 'if you complete it', fail: 'if it fails', abort: 'if you abort it', visit: 'when you visit its destination',
    stopover: 'at a stopover', waypoint: 'at a waypoint', enter: 'when you enter a system', daily: 'every day it is active',
    disabled: 'if your flagship is disabled',
  };
  const PAGE = 30;

  let allEvents = null;           // [name] for the active plugins
  let allEventsKey = '';
  let search = '';
  let limits = { branches: PAGE, all: PAGE };
  let expanded = new Set();
  let renderTimer = null;

  // ── data ──
  async function loadEventNames() {
    const order = S().pluginOrder();
    const key = order.join('|');
    if (allEvents && allEventsKey === key) return allEvents;
    allEventsKey = key;
    if (!order.length || !window.SupabaseHelpers) { allEvents = []; return allEvents; }
    try {
      const rows = await window.SupabaseHelpers.fetchAllRows('game_events', {
        select: 'name, plugin_id', orderBy: 'name', filters: q => q.in('plugin_id', order),
      });
      allEvents = [...new Set(rows.map(r => r.name))].sort((a, b) => a.localeCompare(b));
    } catch (err) {
      console.warn('[MapTimeline] game_events unavailable', err);
      allEvents = [];
    }
    return allEvents;
  }

  // event → missions that trigger it
  function triggerIndex() {
    const map = S().lastMap();
    const idx = new Map(), missions = new Map();
    if (!map) return { idx, missions };
    for (const out of map.activeOutputNames) {
      for (const m of map.pluginDataMap.get(out)?.missions || []) {
        if (!m || !Array.isArray(m.eventTriggers) || !m.eventTriggers.length) continue;
        missions.set(m.name, m);
        const byChoice = choiceEvents(m.raw);
        for (const t of m.eventTriggers) {
          if (!t || !t.name) continue;
          if (!idx.has(t.name)) idx.set(t.name, []);
          idx.get(t.name).push({ mission: m.displayName || m.name, missionName: m.name, trigger: t.trigger, delay: t.delayDays, delayMax: t.delayDaysMax,
                                 choice: byChoice.has(t.name) });
        }
      }
    }
    return { idx, missions };
  }

  // events inside a conversation only happen if the pilot picks that choice
  function choiceEvents(raw) {
    const out = new Set();
    const walk = (nodes, inConv) => {
      for (const n of nodes || []) {
        if (!n) continue;
        const conv = inConv || n.key === 'conversation';
        if (conv && n.key === 'event' && n.values && n.values[0]) out.add(String(n.values[0]));
        walk(n.children, conv);
      }
    };
    if (Array.isArray(raw)) walk(raw, false);
    return out;
  }

  // can this pilot still get the mission? (the game's own offer rule)
  function missionStillPossible(m, conds) {
    if (!conds) return true;
    const limit = m.repeatable ? (Number(m.repeatLimit) || 0) : 1;
    const offered = Number(conds[`${m.name}: offered`] || 0);
    const active = !!conds[`${m.name}: active`];
    return active || !(limit > 0 && offered >= limit);
  }

  // what an event changes, in words
  function describeChanges(name) {
    const nodes = S().eventChangeNodes(name, S().pluginOrder());
    const lines = [];
    for (const n of nodes) {
      const [k, a, b] = n.tokens;
      if (k === 'system' || k === 'planet') {
        const bits = n.children.filter(c => c.tokens).map(c => c.tokens.join(' ')).slice(0, 4);
        lines.push(`${k === 'system' ? '🌌' : '🪐'} ${a}: ${bits.join('; ')}${n.children.length > 4 ? '…' : ''}`);
      } else if (k === 'link' || k === 'unlink') lines.push(`${k === 'link' ? '🔗 New link' : '✂ Link removed'}: ${a} ↔ ${b}`);
      else if (k === 'government') lines.push(`🏛 ${a}: ${n.children.filter(c => c.tokens).map(c => c.tokens[0]).join(', ')}`);
      else if (k === 'event') lines.push(`↪ also triggers “${a}”`);
      else if (['fleet', 'news', 'outfitter', 'shipyard', 'substitutions', 'galaxy', 'wormhole', 'phrase'].includes(k)) lines.push(`• ${k} ${a || ''}`.trim());
    }
    return lines;
  }

  // ── panel ──
  function panel() {
    let p = document.getElementById('mapTimelinePanel');
    if (p) return p;
    const after = document.getElementById('mapDetailsPanel');
    if (!after) return null;
    p = document.createElement('div');
    p.id = 'mapTimelinePanel'; p.className = 'panel'; p.style.marginTop = '16px';
    after.insertAdjacentElement('afterend', p);
    return p;
  }

  // one event row
  function eventRow(name, { happened, scheduled, triggers, previews, disabledReason }) {
    const on = previews.includes(name);
    const isOpen = expanded.has(name);
    const badges = [];
    if (happened !== undefined) badges.push(`<span class="mtl-badge mtl-badge--done">happened${happened ? ' ' + h(fmtDate(happened)) : ''}</span>`);
    if (scheduled) badges.push(`<span class="mtl-badge mtl-badge--soon">scheduled ${h(fmtDate(scheduled))}</span>`);
    const trig = (triggers || []).slice(0, 3).map(t =>
      `${h(t.mission)} — ${h(TRIGGER_TEXT[t.trigger] || t.trigger)}${t.delay ? `, after ${t.delay}${t.delayMax ? '–' + t.delayMax : ''} day${t.delay === 1 && !t.delayMax ? '' : 's'}` : ''}` +
      (t.choice ? ' <em>(depends on what you choose in its conversation)</em>' : '')).join('<br>');
    return `<div class="mtl-row" data-ev="${h(name)}">
      <label class="mtl-check" title="${h(disabledReason || 'Show the map as if this had happened')}">
        <input type="checkbox" data-preview="${h(name)}"${on || happened !== undefined ? ' checked' : ''}${happened !== undefined ? ' disabled' : ''}>
        <span class="mtl-name">${h(name)}</span></label>
      ${badges.join('')}
      <button type="button" class="mtl-more" data-expand="${h(name)}" aria-expanded="${isOpen}">${isOpen ? 'Hide' : 'What changes?'}</button>
      ${trig ? `<div class="mtl-sub">${trig}${(triggers || []).length > 3 ? `<br>…and ${triggers.length - 3} more` : ''}</div>` : ''}
      ${isOpen ? `<div class="mtl-sub mtl-changes" data-changes="${h(name)}">Loading…</div>` : ''}
    </div>`;
  }

  // draw the panel. Called by: mapDisplay after loading
  async function render() {
    const p = panel();
    if (!p || !S()) return;
    const st = S();
    const tl = st.timeline();
    const usingSave = st.usingSave();
    const ctx = st.context();
    const previews = tl.previews;
    const q = search.toLowerCase();
    const match = n => !q || n.toLowerCase().includes(q);

    const happened = usingSave ? st.happenedEvents() : new Map();
    // events past the history cut haven't "happened" in the current view
    let shownHappened = happened;
    const steps = usingSave ? st.historySteps() : [];
    if (usingSave && tl.cutIndex != null) {
      shownHappened = new Map();
      const kept = (ctx.changes || []).slice(0, tl.cutIndex);
      let date = null;
      for (const n of kept) {
        if (n.tokens[0] === 'date') date = { day: +n.tokens[1], month: +n.tokens[2], year: +n.tokens[3] };
        else if (n.tokens[0] === 'event' && n.tokens[1]) shownHappened.set(n.tokens[1], date);
      }
    }
    const today = usingSave && ctx.doc ? ctx.doc.date : null;
    const scheduled = usingSave && ctx.doc ? ctx.doc.events.filter(e => e.name && e.date).sort((a, b) => dayNum(a.date) - dayNum(b.date)) : [];
    const { idx, missions } = triggerIndex();
    const conds = usingSave ? ctx.conditions : null;
    const rowOpts = name => ({
      happened: shownHappened.has(name) ? shownHappened.get(name) : undefined,
      scheduled: scheduled.find(e => e.name === name)?.date || null,
      triggers: idx.get(name), previews,
      disabledReason: shownHappened.has(name) ? 'Already happened for this pilot' : null,
    });

    // history slider position: index into steps (steps.length = today)
    const pos = tl.cutIndex == null ? steps.length : Math.max(0, steps.findIndex(s2 => s2.end === tl.cutIndex) + 1);
    const posLabel = !steps.length ? '' : pos === steps.length ? `Today${today ? ' — ' + h(fmtDate(today)) : ''}`
      : pos === 0 ? 'Before any story changes' : `As of ${h(fmtDate(steps[pos - 1].date) || 'step ' + pos)}`;
    const stepEvents = steps.length && pos > 0 ? steps[pos - 1].events : [];

    // branches: missions with event triggers (the pilot can still get, with a save)
    const branchMissions = [...missions.values()]
      .filter(m => !conds || missionStillPossible(m, conds))
      .filter(m => !q || (m.displayName || m.name).toLowerCase().includes(q) || m.eventTriggers.some(t => t.name && t.name.toLowerCase().includes(q)))
      .sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));

    const names = (allEvents || []).filter(match);

    p.innerHTML = `
      <style>
        .mtl-row{border-top:1px solid var(--c-border);padding:8px 0;display:flex;flex-wrap:wrap;align-items:center;gap:8px;}
        .mtl-check{display:flex;align-items:center;gap:8px;cursor:pointer;flex:1 1 240px;min-width:0;}
        .mtl-name{word-break:break-word;}
        .mtl-sub{flex-basis:100%;font-size:0.8rem;color:var(--c-text-dim);padding-left:26px;}
        .mtl-changes{color:var(--c-text-mid);white-space:pre-line;}
        .mtl-badge{font-size:0.72rem;padding:2px 8px;border-radius:999px;border:1px solid var(--c-border);}
        .mtl-badge--done{color:var(--c-success-text);border-color:currentColor;}
        .mtl-badge--soon{color:var(--c-warn-text);border-color:currentColor;}
        .mtl-more{background:none;border:none;color:var(--c-accent-text);cursor:pointer;font:inherit;font-size:0.8rem;text-decoration:underline;}
        .mtl-h{font-size:0.95rem;margin:16px 0 4px;}
        .mtl-chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0;}
        .mtl-mission{border-top:1px solid var(--c-border);padding:8px 0;}
        .mtl-mission summary{cursor:pointer;}
      </style>
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;">
        <h2 class="section-title" style="margin:0;">🕰 Timeline</h2>
        <span style="font-size:0.82rem;color:var(--c-text-dim);">${usingSave
          ? `Starting from ${h(ctx.pilot)}'s galaxy. Tick an event to see what the map looks like if it happens.`
          : 'Tick an event to see what the default galaxy looks like if it happens. Open a save to start from a pilot’s own history.'}</span>
      </div>

      ${usingSave && steps.length ? `
        <h3 class="mtl-h">History</h3>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" data-step="first" title="Before any story changes">⏮</button>
          <button class="btn btn-secondary btn-sm" data-step="prev" title="Previous day with changes">◀</button>
          <input type="range" id="mtlSlider" min="0" max="${steps.length}" value="${pos}" style="flex:1 1 200px;" aria-label="History position">
          <button class="btn btn-secondary btn-sm" data-step="next" title="Next day with changes">▶</button>
          <button class="btn btn-secondary btn-sm" data-step="last" title="Today">⏭</button>
        </div>
        <div style="font-size:0.85rem;margin-top:6px;"><strong id="mtlPosLabel">${posLabel}</strong>
          ${stepEvents.length ? `<span style="color:var(--c-text-dim);"> — ${h(stepEvents.slice(0, 4).join(', '))}${stepEvents.length > 4 ? ` +${stepEvents.length - 4} more` : ''}</span>` : ''}</div>` : ''}

      ${previews.length ? `
        <h3 class="mtl-h">Previewing</h3>
        <div class="mtl-chips">${previews.map(n => `<span class="ld-pill">${h(n)} <button class="btn-remove" data-unpreview="${h(n)}" aria-label="Stop previewing ${h(n)}">✕</button></span>`).join('')}
          <button class="btn btn-secondary btn-sm" data-clear>Clear all</button></div>
        <p style="font-size:0.78rem;color:var(--c-text-dim);margin:0;">Applied in the order you ticked them. Click a changed system on the map to see what each one did.</p>` : ''}

      <input class="text-input" id="mtlSearch" placeholder="Search events and missions…" value="${h(search)}" style="margin-top:14px;max-width:420px;">

      ${scheduled.length ? `
        <h3 class="mtl-h">Coming up in this save</h3>
        ${scheduled.filter(e => match(e.name)).map(e => {
          const days = today ? dayNum(e.date) - dayNum(today) : null;
          return eventRow(e.name, { ...rowOpts(e.name), scheduled: null }).replace('</label>',
            `</label><span class="mtl-badge mtl-badge--soon">${h(fmtDate(e.date))}${days != null ? ` · ${days <= 0 ? 'next day' : `in ${days} day${days === 1 ? '' : 's'}`}` : ''}</span>`);
        }).join('') || '<p class="mtl-sub" style="padding:0;">No scheduled events match.</p>'}` : ''}

      <h3 class="mtl-h">Story branches <span style="font-weight:400;color:var(--c-text-dim);">(${branchMissions.length} mission${branchMissions.length === 1 ? '' : 's'}${conds ? ' this pilot can still get' : ''})</span></h3>
      <p style="font-size:0.78rem;color:var(--c-text-dim);margin:0 0 4px;">What each mission sets in motion. Events inside a mission’s conversation can depend on what you choose in-game.</p>
      ${branchMissions.slice(0, limits.branches).map(m => `
        <details class="mtl-mission"><summary>${h(m.displayName || m.name)}
          <span style="font-size:0.78rem;color:var(--c-text-dim);">— ${m.eventTriggers.length} event${m.eventTriggers.length === 1 ? '' : 's'}</span></summary>
          ${[...new Set(m.eventTriggers.map(t => t.name).filter(Boolean))].map(n => {
            const t = m.eventTriggers.filter(x => x.name === n);
            const choice = choiceEvents(m.raw).has(n);
            return eventRow(n, { ...rowOpts(n), triggers: t.map(x => ({ mission: TRIGGER_TEXT[x.trigger] ? 'Happens' : 'On', trigger: x.trigger, delay: x.delayDays, delayMax: x.delayDaysMax, choice })) });
          }).join('')}
        </details>`).join('')}
      ${branchMissions.length > limits.branches ? `<button class="btn btn-secondary btn-sm" data-more="branches">Show more missions</button>` : ''}

      <h3 class="mtl-h">All events <span style="font-weight:400;color:var(--c-text-dim);">(${allEvents ? names.length : '…'})</span></h3>
      ${allEvents === null ? '<p class="mtl-sub" style="padding:0;">Loading…</p>'
        : !allEvents.length ? '<p class="mtl-sub" style="padding:0;">No events found — run the parse workflow once after adding the game_events table.</p>'
        : names.slice(0, limits.all).map(n => eventRow(n, rowOpts(n))).join('')}
      ${allEvents && names.length > limits.all ? `<button class="btn btn-secondary btn-sm" data-more="all" style="margin-top:8px;">Show ${Math.min(PAGE, names.length - limits.all)} more</button>` : ''}`;

    bind(p, steps);
    // fill "What changes?" sections
    const open = [...p.querySelectorAll('[data-changes]')];
    if (open.length) {
      const map = S().lastMap();
      await S().fetchEvents(open.map(el => el.dataset.changes), map ? map.activeOutputNames : []);
      for (const el of open) {
        const lines = describeChanges(el.dataset.changes);
        el.textContent = lines.length ? lines.join('\n') : 'Nothing on the map — this event changes things like news, fleets or conditions.';
      }
    }
  }

  // wire up its buttons
  function bind(p, steps) {
    const st = S();
    const slider = p.querySelector('#mtlSlider');
    const toCut = pos => pos >= steps.length ? null : pos === 0 ? 0 : steps[pos - 1].end;
    if (slider) {
      slider.oninput = () => {
        const pos = Number(slider.value);
        const label = p.querySelector('#mtlPosLabel');
        if (label) label.textContent = pos === steps.length ? 'Today' : pos === 0 ? 'Before any story changes' : `As of ${fmtDate(steps[pos - 1].date)}`;
      };
      slider.onchange = () => st.setTimeline({ cutIndex: toCut(Number(slider.value)) });
    }
    p.onclick = e => {
      const t = e.target.closest('[data-step],[data-unpreview],[data-clear],[data-expand],[data-more]');
      if (!t) return;
      if (t.dataset.step && slider) {
        const cur = Number(slider.value), max = steps.length;
        const pos = { first: 0, prev: Math.max(0, cur - 1), next: Math.min(max, cur + 1), last: max }[t.dataset.step];
        st.setTimeline({ cutIndex: toCut(pos) });
      } else if (t.dataset.unpreview) {
        st.setTimeline({ previews: st.timeline().previews.filter(n => n !== t.dataset.unpreview) });
      } else if (t.hasAttribute('data-clear')) {
        st.setTimeline({ previews: [] });
      } else if (t.dataset.expand) {
        const n = t.dataset.expand;
        if (expanded.has(n)) expanded.delete(n); else expanded.add(n);
        render();
      } else if (t.dataset.more) {
        limits[t.dataset.more] += PAGE;
        render();
      }
    };
    p.onchange = e => {
      const box = e.target.closest('[data-preview]');
      if (!box) return;
      const n = box.dataset.preview;
      const cur = st.timeline().previews.filter(x => x !== n);
      st.setTimeline({ previews: box.checked ? [...cur, n] : cur });
    };
    const s = p.querySelector('#mtlSearch');
    if (s) {
      let t = null;
      s.oninput = () => {
        clearTimeout(t);
        t = setTimeout(() => {
          search = s.value.trim(); limits = { branches: PAGE, all: PAGE };
          const pos = s.selectionStart;
          render().then(() => { const s2 = document.getElementById('mtlSearch'); if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); } });
        }, 250);
      };
    }
  }

  document.addEventListener('mapSaveStateApplied', () => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(async () => {
      if (!S()) return;
      if (allEvents === null || allEventsKey !== S().pluginOrder().join('|')) { render(); await loadEventNames(); }
      render();
    }, 0);
  });

  window.MapTimeline = { render };
})();
