'use strict';

// Parsed saves too big for localStorage: rebuilt from the stored text and kept in memory.

(function () {
  const mem = new Map();
  const readJSON = k => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (_) { return null; } };

  // cached parsed save
  function get(id) { return id ? (mem.get(id) || null) : null; }
  // cache one
  function set(id, parsed) { if (id && parsed) mem.set(id, parsed); }
  // forget one
  function drop(id) { mem.delete(id); }

  // parsed save: localStorage, then memory, then rebuilt from the text
  async function ensure(id) {
    if (!id) return null;
    const stored = readJSON('ES_SM_SAVE_' + id);
    if (stored) return stored;
    if (mem.has(id)) return mem.get(id);
    if (!window.SaveVault || typeof parseESSaveFile !== 'function') return null;
    const text = await window.SaveVault.text(id).catch(() => null);
    if (!text) return null;
    const parsed = parseESSaveFile(text);
    mem.set(id, parsed);
    // try to store it again — it may fit now that other saves were removed
    try { localStorage.setItem('ES_SM_SAVE_' + id, JSON.stringify(parsed)); } catch (_) { /* stays in memory */ }
    return parsed;
  }

  const ready = (async () => {
    const reg = readJSON('ES_SM_REGISTRY') || [];
    const current = readJSON('ES_SM_CURRENT');
    // the open save first, so it's usable as soon as possible
    const ids = [...new Set([current, ...reg.map(r => r.id)].filter(Boolean))];
    for (const id of ids) { try { await ensure(id); } catch (e) { console.warn('[EsSaveCache]', id, e); } }
    document.dispatchEvent(new CustomEvent('esSaveCacheReady'));
  })();

  window.EsSaveCache = { get, set, drop, ensure, ready };
})();
