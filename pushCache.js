'use strict';

// Remembers what each parser run sent to Supabase, so the next run only sends what changed (stored in the Actions cache).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 1;
const hash = v => crypto.createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('base64').slice(0, 22);

// same content → same text, whatever the key order
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

// hash of the parser code
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

  // trust a table's cache only if Supabase still has the rows
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

  // rows that need sending, and how many don't
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

  // for junction tables: whose child rows changed
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

  // remember the new state once writes succeed
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
