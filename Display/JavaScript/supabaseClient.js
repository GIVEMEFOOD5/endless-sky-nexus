'use strict';

// The shared Supabase client, a paging helper, and the ready-made data files. Loaded on every data page.

(function () {

const SUPABASE_URL = 'https://lhbagnwfgsclywroxhqj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_6i_1psbc5BaaAyC6wdAkDQ_7L96Rq2s';

window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// every row of a table, page by page. Called by: dataLoader, mapDataLoader, missionLoader, afPool and other loaders
async function fetchAllRows(table, opts = {}) {
    const { select = '*', filters, orderBy, pageSize = 1000, concurrency = 6, onFirstPage } = opts;
    // first page also gets the total, then the rest are fetched side by side
    const build = (from, withCount) => {
        let query = window.supabaseClient.from(table).select(select, withCount ? { count: 'exact' } : undefined);
        if (orderBy) query = query.order(orderBy, { ascending: true });
        query = query.range(from, from + pageSize - 1);
        if (filters) query = filters(query);
        return query;
    };
    // timeouts are usually a slow moment — retry twice
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

// rows → Map by one field. Called by: mapDataLoader
function groupBy(rows, key) {
    const map = new Map();
    for (const row of rows) {
        if (!map.has(row[key])) map.set(row[key], []);
        map.get(row[key]).push(row);
    }
    return map;
}

// ── ready-made data files (made by build/makeBundles.mjs at deploy) — used only if they match the live data version ──
const Bundles = (() => {
    const base = new URL('../bundles/', document.currentScript ? document.currentScript.src : location.href).href;
    let manifestPromise = null;
    // the files' manifest, once per page (null if missing or out of date). Called by: get
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
    // one plugin's data from the files, or null (then load the usual way). Called by: dataLoader, mapDataLoader, missionLoader
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
