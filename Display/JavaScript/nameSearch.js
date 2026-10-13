'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  nameSearch.js — one type-ahead for every "type a name" box
//
//  Start typing and a list appears under the box with matches from the
//  plugins you've selected (☰ Select Plugins). Each match shows what it is
//  and which plugin it comes from. Kinds:
//    outfits      — every outfit
//    ships        — ships and variants (display name first, internal name dimmed)
//    licenses     — licences: from "… License" outfits and from what ships and
//                   outfits require (type "republic" → Republic …)
//    commodities  — trade goods (the game's standard ones plus any the
//                   selected plugins' systems trade)
//
//    NameSearch.attach(input, kind, { onPick(name, item), keepText })
//    NameSearch.search(kind, query) → [{ value, label, sub }]
//
//  Needs uiKit.js (UiKit.combobox). Reads DataLoader's selected plugins.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  const STANDARD_COMMODITIES = ['Food', 'Clothing', 'Metal', 'Plastic', 'Equipment', 'Medical', 'Industrial',
    'Electronics', 'Heavy Metals', 'Luxury Goods'];

  function active() {
    const DL = window.DataLoader;
    return DL && typeof DL.getActiveData === 'function' ? DL.getActiveData() : (window.allData || {});
  }
  const pluginName = (id, p) => (p && p.displayName) || id;
  const attrs = o => (o && (o.attributes || o)) || {};

  // Index per kind, rebuilt when the selected plugins change.
  let cacheKey = '', cache = {};
  function index(kind) {
    const data = active();
    const key = Object.keys(data).join('|');
    if (key !== cacheKey) { cacheKey = key; cache = {}; }
    if (cache[kind]) return cache[kind];
    const out = new Map();   // value → item
    const add = (value, label, sub, plugin, extra) => {
      if (!value || out.has(value)) return;
      out.set(value, { value, label: label || value, sub: [sub, plugin].filter(Boolean).join(' · '), ...extra });
    };
    // real plugins first, so a match is credited to the plugin that defines it; your
    // own Local Builds only add what no selected plugin has (e.g. your designs)
    const entries = Object.entries(data).sort(([a], [b]) => (a === '__local_builds__') - (b === '__local_builds__'));
    for (const [id, p] of entries) {
      const pl = pluginName(id, p);
      if (kind === 'outfits') {
        for (const o of p.outfits || []) {
          if (!o || !o.name) continue;
          const ON = window.OutfitNames;
          const label = ON ? ON.label(o) : o.name, internal = ON ? ON.internal(o) : '';
          add(o.name, label, [internal, o.category || attrs(o).category || ''].filter(Boolean).join(' · '), pl, { internal });
        }
      } else if (kind === 'ships') {
        for (const s of [...(p.ships || []), ...(p.variants || [])]) {
          if (!s || !s.name) continue;
          const SN = window.ShipNames;
          const label = SN ? SN.label(s) : s.name, internal = SN ? SN.internal(s) : '';
          add(s.name, label, [internal, attrs(s).category || (s.baseShip ? `variant of ${s.baseShip}` : '')].filter(Boolean).join(' · '), pl, { internal });
        }
      } else if (kind === 'licenses') {
        for (const o of p.outfits || []) {
          if (!o || !o.name) continue;
          const a = attrs(o);
          if ((o.category || a.category) === 'Licenses') add(o.name.replace(/ License$/i, ''), null, 'licence', pl);
          if (a.licenses && typeof a.licenses === 'object') for (const l of Object.keys(a.licenses)) add(l, null, `needed for ${o.name}`, pl);
        }
        for (const s of [...(p.ships || []), ...(p.variants || [])]) {
          const a = attrs(s);
          if (a.licenses && typeof a.licenses === 'object') for (const l of Object.keys(a.licenses)) add(l, null, `needed for ${s.name}`, pl);
        }
      } else if (kind === 'commodities') {
        for (const c of STANDARD_COMMODITIES) add(c, null, 'trade good', 'Endless Sky');
        for (const c of commodityExtras) add(c, null, 'trade good', 'plugin');
      }
    }
    cache[kind] = [...out.values()];
    return cache[kind];
  }

  // Commodities traded by the selected plugins' systems (fetched once)
  let commodityExtras = [];
  (async () => {
    try {
      const sb = window.supabaseClient;
      if (!sb) return;
      const { data } = await sb.from('system_trade').select('commodity_name').limit(5000);
      const set = new Set((data || []).map(r => r.commodity_name).filter(Boolean));
      for (const c of STANDARD_COMMODITIES) set.delete(c);
      commodityExtras = [...set].sort();
      delete cache.commodities;
    } catch (_) { /* offline: the standard list still works */ }
  })();

  function search(kind, q) {
    const U = window.UiKit;
    const items = index(kind), out = [];
    for (const it of items) {
      const sc = U ? Math.max(U.match(q, it.label), it.internal ? U.match(q, it.internal) * 0.9 : 0, U.match(q, it.value) * 0.9)
                   : ((it.label + ' ' + it.value).toLowerCase().includes(String(q).toLowerCase()) ? 1 : 0);
      if (sc > 0) out.push([sc, it]);
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, 50).map(x => x[1]);
  }

  /**
   * Turn a text box into a type-ahead. By default picking a match puts its
   * name in the box (ready for the Add button); pass onPick to act at once.
   */
  function attach(input, kind, { onPick, keepText = true } = {}) {
    if (!input || !window.UiKit) return;
    input.removeAttribute('list');
    window.UiKit.combobox(input, {
      source: async q => search(kind, q),
      placeholderEmpty: 'Nothing in your selected plugins matches',
      onPick: it => {
        if (keepText) input.value = it.value; else input.value = '';
        if (onPick) onPick(it.value, it);
      },
    });
  }

  window.NameSearch = { attach, search };
})();
