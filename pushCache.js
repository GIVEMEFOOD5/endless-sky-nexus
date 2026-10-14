'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  pushCache.js — remembers what the last successful parse pushed, so the
//  next run only sends what changed.
//
//  A content hash of every row (and of every parent's junction rows) is
//  kept in .parse-cache/pushed.json, which the workflow saves and restores
//  with actions/cache. On the next run:
//    • rows whose hash is unchanged aren't upserted again,
//    • junction rows (ship_outfits, planet_shipyards, system_links, …) are
//      only rebuilt for parents whose junction content changed,
//    • the attribute parser is skipped when the game's commit and the
//      parser code are both unchanged.
//
//  Safety:
//    • The cache is tied to a hash of the parser's own code — change any
//      parser file and the next run is a full push.
//    • PARSE_FULL=1 (the workflow's "full refresh" option) ignores it.
//    • Before trusting a table's cache, the table's row count in Supabase is
//      compared with what the cache says was pushed; if rows have gone
//      missing (a restore, manual deletes, a new database), that table is
//      pushed in full.
//    • The cache is only written after every write succeeded.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 1;
const hash = v => crypto.createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('base64').slice(0, 22);

// Stable stringify: same content → same text regardless of key order.
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

function codeHash(files) {
  const h = crypto.createHash('sha1');
  for (const f of files) { try { h.update(f + '\0' + fs.readFileSync(f)); } catch (_) { h.update(f + '\0missing'); } }
  return h.digest('hex').slice(0, 16);
}

class PushCache {
  constructor({ dir, code, full }) {
    this.file = path.join(dir, 'pushed.json');
    this.dir = dir;
    this.code = code;
    this.pending = {};       // table → { key: hash }  (accepted; written on commit)
    this.candidate = {};     // table → { key: hash }  (staged until that table's writes succeed)
    this.trusted = new Set();
    this.state = { version: CACHE_VERSION, code, tables: {}, meta: {} };
    this.reason = 'no cache from an earlier run';
    if (full) { this.reason = 'full refresh requested'; return; }
    try {
      const prev = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (prev.version !== CACHE_VERSION) this.reason = 'cache format changed';
      else if (prev.code !== code) this.reason = 'parser code changed since the cached run';
      else { this.state = prev; this.reason = null; }
    } catch (_) { /* no cache yet */ }
  }

  get usable() { return this.reason === null; }

  /** Trust a table's cache only if Supabase still has at least as many rows as were pushed. */
  async verify(supabase, tables) {
    if (!this.usable) return;
    await Promise.all(tables.map(async t => {
      const cached = Object.keys(this.state.tables[t] || {}).length;
      if (!cached) return;
      try {
        const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
        if (!error && typeof count === 'number' && count >= cached) this.trusted.add(t);
        else console.log(`  ↺ ${t}: Supabase has ${count ?? '?'} rows but ${cached} were pushed last time — pushing it in full`);
      } catch (_) { /* untrusted → full push */ }
    }));
  }

  /**
   * Split rows into the ones that need pushing and the count that don't.
   * Records the new hashes (committed only at the end).
   */
  diff(table, rows, keyOf) {
    const prev = this.trusted.has(table) ? (this.state.tables[table] || {}) : {};
    const next = this.candidate[table] = {};
    const changed = [];
    for (const row of rows) {
      const k = String(keyOf(row));
      const hsh = hash(stable(row));
      next[k] = hsh;
      if (prev[k] !== hsh) changed.push(row);
    }
    return { changed, skipped: rows.length - changed.length };
  }

  /** For junction tables: which parents' child rows changed. `childrenOf(parentKey)` → plain data. */
  /** Forget what was pushed for this junction cache, so every parent is rebuilt. */
  distrust(table) { (this.distrusted = this.distrusted || new Set()).add(table); }

  changedParents(table, parentTable, parentKeys, childrenOf) {
    // junction caches are only as trustworthy as their parent table's —
    // and not at all if the rows in the database don't add up (distrust())
    const prev = this.trusted.has(parentTable) && !(this.distrusted && this.distrusted.has(table)) ? (this.state.tables[table] || {}) : {};
    const next = this.candidate[table] = {};
    const out = new Set();
    for (const k of parentKeys) {
      const hsh = hash(stable(childrenOf(k)));
      next[k] = hsh;
      if (prev[k] !== hsh) out.add(k);
    }
    return out;
  }

  /** Call once a table's writes have succeeded; only then is its new state remembered. */
  accept(...tables) { for (const t of tables) if (this.candidate[t]) { this.pending[t] = this.candidate[t]; delete this.candidate[t]; } }

  meta(key) { return this.usable ? this.state.meta[key] : undefined; }
  setMeta(key, value) { this.pendingMeta = { ...(this.pendingMeta || {}), [key]: value }; }

  commit() {
    const tables = { ...this.state.tables, ...this.pending };
    const out = { version: CACHE_VERSION, code: this.code, savedAt: new Date().toISOString(), tables,
                  meta: { ...(this.usable ? this.state.meta : {}), ...(this.pendingMeta || {}) } };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(out));
  }
}

module.exports = { PushCache, codeHash, hash, stable };
