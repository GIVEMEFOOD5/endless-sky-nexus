'use strict';

// ═══════════════════════════════════════════════════════════
//  supabaseClient.js  —  Endless Sky Ship Builder
//
//  Shared Supabase client + a generic pagination helper, used by
//  dataLoader.js, mapDataLoader.js, and missionLoader.js instead of
//  each fetching raw.githubusercontent.com JSON files directly.
//
//  Requires the Supabase UMD script to already be loaded on the page
//  (see index HTML files — added as a <script> tag right before this
//  one), which exposes the global `window.supabase.createClient`.
//
//  The key below is the public "anon"-equivalent key — safe to ship
//  in frontend code. Real access control is enforced by Row-Level
//  Security policies on the database, not by keeping this secret.
// ═══════════════════════════════════════════════════════════

(function () {

const SUPABASE_URL = 'https://lhbagnwfgsclywroxhqj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_6i_1psbc5BaaAyC6wdAkDQ_7L96Rq2s';

window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Fetches every row from a table, walking through pages automatically —
 * Supabase/PostgREST caps a single request at 1000 rows by default, and
 * ships/outfits/systems/etc. all exceed that, so a single .select() would
 * silently come back truncated without this.
 *
 * @param {string} table
 * @param {object} [opts]
 * @param {string} [opts.select]   column list, defaults to '*'
 * @param {function} [opts.filters] receives the query builder, returns it
 *        with .eq()/.in()/etc. applied — e.g. filters: q => q.eq('plugin_id', id)
 */
async function fetchAllRows(table, opts = {}) {
    const { select = '*', filters, orderBy, pageSize = 1000, concurrency = 6, onFirstPage } = opts;
    // The first page also asks how many rows there are in total; every other
    // page is then fetched AT THE SAME TIME (a few at once) instead of one
    // after another — with ~150 ms per round trip, 20 pages went from ~3 s to
    // ~0.5 s.
    const build = (from, withCount) => {
        let query = window.supabaseClient.from(table).select(select, withCount ? { count: 'exact' } : undefined);
        if (orderBy) query = query.order(orderBy, { ascending: true });
        query = query.range(from, from + pageSize - 1);
        if (filters) query = filters(query);
        return query;
    };
    // A timeout is usually transient (a slow moment on shared compute), not
    // a real failure — retry a couple of times before giving up.
    const run = async (from, withCount) => {
        let res;
        for (let attempt = 1; attempt <= 3; attempt++) {
            res = await build(from, withCount);
            if (!res.error) break;
            const isTimeout = /timeout/i.test(res.error.message ?? '');
            if (!isTimeout || attempt === 3) break;
            console.warn(`[fetchAllRows] "${table}" page timed out, retrying (attempt ${attempt}/3)...`);
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
        if (res.error) throw new Error(`Supabase fetch failed for "${table}": ${res.error.message}`);
        return res;
    };

    const first = await run(0, true);
    const rows = first.data || [];
    // lets a page show the first rows straight away while the rest arrive
    if (typeof onFirstPage === 'function') { try { onFirstPage(rows.slice(), Number.isFinite(first.count) ? first.count : rows.length); } catch (_) {} }
    if (rows.length < pageSize) return rows;
    const total = Number.isFinite(first.count) ? first.count : null;
    if (total == null) {
        // no count available — fall back to one page after another
        for (let from = pageSize; ; from += pageSize) {
            const { data } = await run(from, false);
            rows.push(...(data || []));
            if (!data || data.length < pageSize) return rows;
        }
    }
    const starts = [];
    for (let from = pageSize; from < total; from += pageSize) starts.push(from);
    const pages = new Array(starts.length);
    let next = 0;
    const worker = async () => { while (next < starts.length) { const k = next++; pages[k] = (await run(starts[k], false)).data || []; } };
    await Promise.all(Array.from({ length: Math.min(concurrency, starts.length) }, worker));
    for (const p of pages) rows.push(...p);
    return rows;
}

/** Groups an array of rows into a Map keyed by one of their own fields. */
function groupBy(rows, key) {
    const map = new Map();
    for (const row of rows) {
        if (!map.has(row[key])) map.set(row[key], []);
        map.get(row[key]).push(row);
    }
    return map;
}

// ── Ready-made data files (build/makeBundles.mjs, made when Cloudflare deploys) ──
// One plain file per plugin and kind ('catalog', 'map', 'missions'), served
// from Cloudflare's network next to the pages. Used only if they belong to the
// current data version; otherwise (or if anything fails) the caller loads from
// Supabase as before.
const Bundles = (() => {
    const base = new URL('../bundles/', document.currentScript ? document.currentScript.src : location.href).href;
    let manifestPromise = null;
    async function manifest() {
        if (!manifestPromise) manifestPromise = (async () => {
            try {
                const res = await fetch(base + 'manifest.json', { cache: 'no-cache' });
                if (!res.ok) return null;
                const m = await res.json();
                // only if made from the data that's live right now
                const live = window.EsCache ? await window.EsCache.getRemoteDataVersion() : null;
                if (live && m.version && live !== m.version) {
                    console.info('[Bundles] ready-made files are from an older parse — loading from Supabase instead.');
                    return null;
                }
                return m;
            } catch (_) { return null; }
        })();
        return manifestPromise;
    }
    /** The data for one plugin and kind, or null (then load it the usual way). */
    async function get(kind, outputName) {
        try {
            const m = await manifest();
            const files = m && m.plugins && m.plugins[outputName] && m.plugins[outputName][kind];
            if (!files || !files.length) return null;
            const parts = await Promise.all(files.map(async f => {
                const res = await fetch(base + f);
                if (!res.ok) throw new Error(`${f}: ${res.status}`);
                return res.json();
            }));
            let data;
            if (parts.length === 1) data = parts[0];
            else if (Array.isArray(parts[0])) data = parts.flat();
            else {   // split object: join each list back together
                data = {};
                for (const part of parts) for (const [k, v] of Object.entries(part)) {
                    if (Array.isArray(v)) data[k] = (data[k] || []).concat(v);
                    else if (v != null && data[k] === undefined) data[k] = v;
                }
            }
            console.info(`[Bundles] loaded ${outputName} ${kind} from ready-made files`);
            return data;
        } catch (err) {
            console.warn(`[Bundles] ${outputName} ${kind}: falling back to Supabase (${err.message})`);
            return null;
        }
    }
    return { manifest, get };
})();
window.Bundles = Bundles;

window.SupabaseHelpers = { fetchAllRows, groupBy };

})();
