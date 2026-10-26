'use strict';

// Shared UI bits: fuzzy matching, type-ahead box, pagination, undo message.

(function () {
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // does text match a search? (strict: every word as typed)
  function match(query, text, { strict = false } = {}) {
    const q = String(query || '').toLowerCase().trim(), t = String(text || '').toLowerCase();
    if (!q) return 1;
    if (strict) {
      const words = q.split(/\s+/);
      if (!words.every(w => t.includes(w))) return 0;
      return t.startsWith(q) ? 800 : t.includes(q) ? 500 : 200;
    }
    if (t === q) return 1000;
    if (t.startsWith(q)) return 800 - t.length;
    const at = t.indexOf(q);
    if (at !== -1) return (/[\s:(\-"]/.test(t[at - 1] || ' ') ? 600 : 400) - at;
    // every word of the query must start a word of the text, in order ("hvy las")
    const words = q.split(/\s+/);
    let pos = 0, score = 300;
    for (const w of words) {
      let found = -1;
      for (let i = pos; i <= t.length - 1; i++) {
        if ((i === 0 || /[\s:(\-"]/.test(t[i - 1])) && fuzzyStart(t, i, w)) { found = i; break; }
      }
      if (found === -1) return 0;
      score -= found - pos; pos = found + 1;
    }
    return Math.max(1, score);
  }
  // letters in order within one word
  function fuzzyStart(t, i, w) {
    let j = 0;
    for (let k = i; k < t.length && j < w.length; k++) {
      if (/\s/.test(t[k]) && j < w.length) return false;
      if (t[k] === w[j]) j++;
    }
    return j === w.length && t[i] === w[0];
  }

  // highlight the matched part
  function highlight(text, query) {
    const t = String(text ?? ''), q = String(query || '').trim();
    if (!q) return h(t);
    const at = t.toLowerCase().indexOf(q.toLowerCase());
    if (at === -1) return h(t);
    return h(t.slice(0, at)) + '<mark>' + h(t.slice(at, at + q.length)) + '</mark>' + h(t.slice(at + q.length));
  }

  // ── type-ahead box ──
  let styled = false;
  // add the CSS once
  function addStyles() {
    if (styled) return; styled = true;
    const css = document.createElement('style');
    css.textContent = `
      .uk-combo{position:relative;display:inline-block;width:100%;max-width:420px;}
      .uk-combo__list{position:absolute;z-index:50;left:0;right:0;top:100%;margin-top:4px;max-height:320px;overflow-y:auto;
        background:#111a2e;border:1px solid var(--c-border, #334155);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:4px;}
      .uk-combo__item{padding:7px 10px;border-radius:6px;cursor:pointer;font-size:0.88rem;}
      .uk-combo__item[aria-selected="true"],.uk-combo__item:hover{background:var(--c-accent-bg, rgba(59,130,246,.18));}
      .uk-combo__sub{display:block;font-size:0.75rem;color:var(--c-text-dim, #94a3b8);}
      .uk-combo__empty{padding:8px 10px;color:var(--c-text-dim, #94a3b8);font-size:0.85rem;}
      .uk-combo mark,.uk-hl mark{background:transparent;color:var(--c-accent-text, #60a5fa);font-weight:600;}
      .uk-pager{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;font-size:0.82rem;color:var(--c-text-dim);}
      .uk-pager button{min-width:32px;}
      .uk-toast-unused{
        background:#111a2e;border:1px solid var(--c-border, #334155);border-radius:10px;padding:10px 14px;box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:0.9rem;}
    `;
    document.head.appendChild(css);
  }

  // turn an input into a type-ahead. Called by: nameSearch, afUI, saveEditor
  function combobox(input, { source, onPick, minChars = 1, placeholderEmpty = 'No matches' } = {}) {
    addStyles();
    if (input._ukCombo) return input._ukCombo;
    const wrap = document.createElement('span');
    wrap.className = 'uk-combo';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    const list = document.createElement('div');
    list.className = 'uk-combo__list'; list.hidden = true; list.setAttribute('role', 'listbox');
    wrap.appendChild(list);
    let items = [], active = -1, seq = 0, timer = null;

    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    const draw = () => {
      const q = input.value;
      list.innerHTML = items.length
        ? items.map((it, i) => `<div class="uk-combo__item" role="option" data-i="${i}" aria-selected="${i === active}">
            ${highlight(it.label ?? it.value, q)}${it.sub ? `<span class="uk-combo__sub">${h(it.sub)}</span>` : ''}</div>`).join('')
        : `<div class="uk-combo__empty">${h(placeholderEmpty)}</div>`;
      list.hidden = false; input.setAttribute('aria-expanded', 'true');
      const el = list.querySelector('[aria-selected="true"]'); if (el) el.scrollIntoView({ block: 'nearest' });
    };
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < minChars) { close(); return; }
        const my = ++seq;
        let res = [];
        try { res = await source(q); } catch (_) { res = []; }
        if (my !== seq) return;
        items = res.slice(0, 50); active = items.length ? 0 : -1; draw();
      }, 120);
    };
    const pick = i => { const it = items[i]; if (!it) return; input.value = it.value; close(); onPick && onPick(it); };

    input.addEventListener('input', refresh);
    input.addEventListener('focus', () => { if (input.value.trim().length >= minChars) refresh(); });
    input.addEventListener('keydown', e => {
      if (list.hidden) { if (e.key === 'ArrowDown') refresh(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); draw(); }
      else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); pick(active); } }
      else if (e.key === 'Escape') { close(); }
    });
    list.addEventListener('mousedown', e => { const el = e.target.closest('[data-i]'); if (el) { e.preventDefault(); pick(Number(el.dataset.i)); } });
    input.addEventListener('blur', () => setTimeout(close, 150));
    return (input._ukCombo = { close, refresh });
  }

  // ── pages ──
  function paginate(items, page, size) {
    const pages = Math.max(1, Math.ceil(items.length / size));
    const p = Math.min(Math.max(1, page || 1), pages);
    const from = (p - 1) * size;
    return { slice: items.slice(from, from + size), page: p, pages, from: items.length ? from + 1 : 0, to: Math.min(items.length, from + size), total: items.length };
  }
  // page buttons
  function pager({ page, pages, total, from, to, id }) {
    addStyles();
    if (pages <= 1) return total ? `<div class="uk-pager">${total} shown</div>` : '';
    const btn = (p, label, dis, cur) => `<button class="btn btn-${cur ? 'primary' : 'secondary'} btn-sm" data-page-of="${h(id)}" data-page="${p}"${dis ? ' disabled' : ''}${cur ? ' aria-current="page"' : ''}>${label}</button>`;
    const nums = [];
    const show = new Set([1, pages, page - 1, page, page + 1].filter(n => n >= 1 && n <= pages));
    let last = 0;
    for (const n of [...show].sort((a, b) => a - b)) { if (n - last > 1) nums.push('<span>…</span>'); nums.push(btn(n, n, false, n === page)); last = n; }
    return `<nav class="uk-pager" aria-label="Pages">
      ${btn(page - 1, '‹ Prev', page === 1)}${nums.join('')}${btn(page + 1, 'Next ›', page === pages)}
      <span style="margin-left:6px;">${from}–${to} of ${total}</span></nav>`;
  }

  // ── undo message ──
  let toastEl = null, toastTimer = null;
  // "Undone — Undo" message
  function undoToast(message, onUndo, ms = 8000) {
    addStyles();
    clearTimeout(toastTimer);
    // Use the page's own message box (#toast) when there is one, so only one
    // message shows at a time and it looks like every other message on the site.
    const shared = document.getElementById('toast');
    if (toastEl && toastEl !== shared) toastEl.remove();
    toastEl = shared || document.createElement('div');
    toastEl.className = 'toast show toast--action'; toastEl.setAttribute('role', 'status');
    toastEl.innerHTML = `<span>${h(message)}</span>${onUndo ? '<button class="btn btn-secondary btn-sm">↶ Undo</button>' : ''}`;
    if (!shared) document.body.appendChild(toastEl);
    const hide = () => { if (!toastEl) return; if (toastEl === shared) { toastEl.classList.remove('show'); } else toastEl.remove(); toastEl = null; };
    const b = toastEl.querySelector('button');
    if (b) b.onclick = () => { onUndo(); hide(); };
    toastTimer = setTimeout(hide, ms);
  }

  window.UiKit = { match, highlight, combobox, paginate, pager, undoToast };
})();
