'use strict';

// Which plugins a saved design needs, and which of those have been removed from the site.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PluginRefs = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const clean = v => String(v ?? '').replace(/^"([^"]*)"$/, '$1');

  // [[plugin, item]] a design uses
  function refsOf(design) {
    const out = [];
    if (!design || typeof design !== 'object') return out;
    if (design._sourcePlugin) out.push([design._sourcePlugin, design._sourceShip || design.name || 'ship']);
    const add = (name, info) => {
      if (!info || typeof info !== 'object') return;
      let key = info.pluginId || null;
      if (!key && typeof info.internalId === 'string' && info.internalId.includes('::')) key = info.internalId.split('::')[0];
      if (key) out.push([key, clean(name || info.name)]);
    };
    const outs = design.outfits;
    if (Array.isArray(outs)) for (const o of outs) add(o && o.name, o);
    else if (outs && typeof outs === 'object') for (const [n, v] of Object.entries(outs)) add(n, v);
    return out;
  }

  // removed plugins by every name a design might use
  function indexRemoved(rows) {
    const map = new Map();
    for (const r of rows || []) {
      if (!r || !r.plugin_id) continue;
      map.set(r.plugin_id, r);
      if (r.output_name && !map.has(r.output_name)) map.set(r.output_name, r);
    }
    return map;
  }

  // removed plugins a design needs
  function missingFor(design, removedIndex) {
    if (!removedIndex || !removedIndex.size) return [];
    const byPlugin = new Map();
    for (const [key, item] of refsOf(design)) {
      const r = removedIndex.get(key);
      if (!r) continue;
      if (!byPlugin.has(r.plugin_id)) byPlugin.set(r.plugin_id, {
        plugin_id: r.plugin_id, display_name: r.display_name || r.output_name || r.plugin_id,
        source_name: r.source_name || null, repository: r.repository || null, removed_at: r.removed_at || null, uses: [],
      });
      const entry = byPlugin.get(r.plugin_id);
      if (item && !entry.uses.includes(item)) entry.uses.push(item);
    }
    return [...byPlugin.values()];
  }

  return { refsOf, indexRemoved, missingFor };
});
