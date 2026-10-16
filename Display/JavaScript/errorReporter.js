'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  errorReporter.js — tells you when something breaks in a visitor's browser
//
//  Loaded first on every page. Catches uncaught errors, failed promises and
//  console.error() calls, and adds a row to Supabase's `client_errors` table
//  (supabase/client_errors.sql — anyone may add, only admins may read).
//
//  Careful by design:
//    • at most 5 reports per page visit, and each different message only once
//    • ignores browser-extension errors, other sites' scripts and known noise
//    • nothing personal: page, error, stack, browser type, site version
//    • off on localhost/codespaces and in automated tests
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  const MAX_PER_VISIT = 5;
  const host = location.hostname;
  const enabled = !navigator.webdriver && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host) && !/github\.dev$|app\.github\.dev$/.test(host);

  const IGNORE = [
    /ResizeObserver loop/i, /^Script error\.?$/i, /extension:\/\//i, /^Load failed$/i,
    /AbortError/i, /The user aborted a request/i, /NetworkError when attempting to fetch/i,
    /Failed to fetch dynamically imported module/i, /QuotaExceededError/i,
    /\[ImageGrabber\]/, /Failed to load resource/i,
  ];
  const seen = new Set();
  const queue = [];
  let sent = 0, flushing = false;

  const page = (location.pathname.split('/').pop() || 'index.html').slice(0, 200);
  const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

  function report(kind, message, extra = {}) {
    if (!enabled || sent + queue.length >= MAX_PER_VISIT) return;
    message = clip(message || 'Unknown error', 2000);
    if (IGNORE.some(re => re.test(message) || (extra.source && re.test(extra.source)))) return;
    const key = kind + '|' + message;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({
      kind, message, page,
      source: clip(extra.source, 500), line: extra.line ?? null, col: extra.col ?? null,
      stack: clip(extra.stack, 8000),
      user_agent: clip(navigator.userAgent, 500),
      url: clip(location.origin + location.pathname + location.search, 2000),   // never the #… (share links)
    });
    flush();
  }

  // Wait for the Supabase client (it loads later on the page), then send.
  async function flush(tries = 0) {
    if (flushing || !queue.length) return;
    const sb = window.supabaseClient;
    if (!sb) { if (tries < 60) setTimeout(() => flush(tries + 1), 500); return; }
    flushing = true;
    try {
      while (queue.length && sent < MAX_PER_VISIT) {
        const row = queue.shift();
        sent++;
        try { await sb.from('client_errors').insert(row); } catch (_) { /* never let reporting break the page */ }
      }
    } finally { flushing = false; }
  }

  window.addEventListener('error', e => {
    // errors loading images/scripts come through here too, without a message — skip those
    if (!e.message) return;
    report('error', e.message, { source: e.filename, line: e.lineno, col: e.colno, stack: e.error && e.error.stack });
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    report('promise', (r && (r.message || r.toString())) || 'Unhandled promise rejection', { stack: r && r.stack });
  });
  const origError = console.error;
  console.error = function (...args) {
    try {
      const text = args.map(a => (a instanceof Error ? `${a.message}` : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })())).join(' ');
      const err = args.find(a => a instanceof Error);
      report('console', text, { stack: err && err.stack });
    } catch (_) { /* ignore */ }
    return origError.apply(this, args);
  };

  window.ErrorReporter = { report: (message, extra) => report('manual', message, extra || {}) };
})();
