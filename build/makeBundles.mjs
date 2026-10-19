// ═══════════════════════════════════════════════════════════════════════════
//  build/makeBundles.mjs — ready-made data files for faster first visits
//
//  Run by Cloudflare as the BUILD COMMAND, just before it deploys the site:
//      node build/makeBundles.mjs
//
//  For every plugin it asks Supabase (with the site's public key — the same
//  one every visitor's browser uses) for:
//      catalog   ships, variants, outfits, effects  (get_plugin_catalog)
//      map       systems, planets, jump links …       (get_plugin_map)
//      missions  every mission row
//  and writes them to Display/bundles/, with a manifest.json listing them and
//  the data version they belong to. The files only exist in the deployment —
//  they are never committed to the repo.
//
//  Never fails the deploy: anything that goes wrong is logged and skipped,
//  and the site simply loads that data from Supabase as before.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'Display', 'bundles');
const MAX_FILE = (Number(process.env.BUNDLE_MAX_MB) || 20) * 1024 * 1024;   // Cloudflare's limit is 25 MiB per file — keep well under
const CONCURRENCY = 4;

// The public URL and key, read from the site's own config so they're never out of step
const cfg = fs.readFileSync(path.join(ROOT, 'Display/JavaScript/supabaseClient.js'), 'utf8');
const URL_ = process.env.SUPABASE_URL || (cfg.match(/SUPABASE_URL\s*=\s*'([^']+)'/) || [])[1];
const KEY = process.env.SUPABASE_ANON_KEY || (cfg.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/) || [])[1];
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' };

const log = (...a) => console.log('[bundles]', ...a);
const mb = n => (n / 1048576).toFixed(1) + ' MB';

async function request(pathAndQuery, body, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, {
        method: body ? 'POST' : 'GET', headers: HEADERS, body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return await res.json();
      const text = await res.text();
      const busy = [502, 503, 504, 520, 522, 524].includes(res.status) || /timeout/i.test(text);
      if (!busy || attempt >= tries) throw new Error(`${res.status} ${text.slice(0, 200)}`);
    } catch (err) {
      if (attempt >= tries) throw err;
    }
    await new Promise(r => setTimeout(r, 1500 * attempt));
  }
}

async function allRows(table, query) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await request(`${table}?${query}&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

// ── Table-by-table fallback ──────────────────────────────────────────────
// Visitors' requests are limited to a few seconds by Supabase. Big plugins
// can need longer than that to package in one go (error 57014, "canceling
// statement due to statement timeout"), so if the one-request function
// fails, build exactly the same answer from ordinary page-by-page requests.
const eqPlugin = id => `plugin_id=eq.${encodeURIComponent(id)}`;
async function byIds(table, column, ids, select = '*') {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const list = ids.slice(i, i + 100).join(',');
    out.push(...await allRows(table, `select=${select}&${column}=in.(${list})&order=${column}`));
  }
  return out;
}
async function catalogFromTables(pluginId) {
  const [ships, variants, outfits, effects] = await Promise.all(
    ['ships', 'variants', 'outfits', 'effects'].map(t => allRows(t, `select=*&${eqPlugin(pluginId)}&order=id`)));
  const [ship_outfits, variant_outfits] = await Promise.all([
    byIds('ship_outfits', 'ship_id', ships.map(r => r.id)),
    byIds('variant_outfits', 'variant_id', variants.map(r => r.id)),
  ]);
  const own = new Set(outfits.map(o => o.id));
  const missing = [...new Set([...ship_outfits, ...variant_outfits].map(r => r.outfit_id))].filter(id => !own.has(id));
  const extra_outfits = missing.length ? await byIds('outfits', 'id', missing) : [];
  return { ships, variants, outfits, effects, ship_outfits, variant_outfits, extra_outfits };
}
const MAP_MISSION_COLUMNS = 'id,name,display_name,source_plugin,source,destination,stopovers,waypoints,cargo,passengers,payment,rewards,deadline,illegal,repeatable,repeat_limit,npc_count,has_npc_objective,flags,event_triggers,locations,plugin_id,internal_id';
async function mapFromTables(pluginId) {
  const [systems, galaxies, wormholes, planets, stars, governments, missions] = await Promise.all([
    ...['systems', 'galaxies', 'wormholes', 'planets', 'stars', 'governments'].map(t => allRows(t, `select=*&${eqPlugin(pluginId)}&order=id`)),
    allRows('missions', `select=${MAP_MISSION_COLUMNS}&${eqPlugin(pluginId)}&order=id`),
  ]);
  const sysIds = systems.map(r => r.id);
  const SYS = ['system_links', 'system_fleets', 'system_hazards', 'system_asteroids', 'system_minables', 'system_planets', 'system_trade'];
  const parts = await Promise.all(SYS.map(t => byIds(t, 'system_id', sysIds)));
  const wormhole_links = await byIds('wormhole_links', 'wormhole_id', wormholes.map(r => r.id));
  const withEvents = missions.filter(m => Array.isArray(m.event_triggers) && m.event_triggers.length).map(m => m.id);
  const mission_raws = withEvents.length ? await byIds('missions', 'id', withEvents, 'id,raw') : [];
  const out = { systems, galaxies, wormholes, planets, stars, governments, missions, mission_raws, wormhole_links };
  SYS.forEach((t, i) => { out[t] = parts[i]; });
  return out;
}
let rpcMissing = false;   // functions not installed: don't keep asking for every plugin
async function viaRpcOrTables(fn, args, fallback) {
  if (!rpcMissing) {
    try { return await request(`rpc/${fn}`, args, 1); }
    catch (err) {
      if (/PGRST202|Could not find the function/i.test(err.message)) rpcMissing = true;
      // timeouts and everything else: build it the slower way below
    }
  }
  return fallback();
}

// Write one file, or several parts if it would be too big for Cloudflare.
// Every part has the same keys; the site joins the arrays back together.
function writeBundle(name, data) {
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) <= MAX_FILE) {
    fs.writeFileSync(path.join(OUT, `${name}.json`), json);
    return { files: [`${name}.json`], bytes: Buffer.byteLength(json) };
  }
  const isArray = Array.isArray(data);
  const parts = Math.ceil(Buffer.byteLength(json) / MAX_FILE) + 1;
  const slice = (arr, k) => { const n = Math.ceil(arr.length / parts); return arr.slice(k * n, (k + 1) * n); };
  const files = []; let bytes = 0;
  for (let k = 0; k < parts; k++) {
    const part = isArray ? slice(data, k)
      : Object.fromEntries(Object.entries(data).map(([key, v]) => [key, Array.isArray(v) ? slice(v, k) : (k === 0 ? v : null)]));
    const text = JSON.stringify(part);
    const file = `${name}.part${k + 1}.json`;
    fs.writeFileSync(path.join(OUT, file), text);
    files.push(file); bytes += Buffer.byteLength(text);
  }
  return { files, bytes };
}

async function main() {
  if (!URL_ || !KEY) { log('No Supabase URL/key found — skipping (the site will load from Supabase).'); return; }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const started = Date.now();

  const [plugins, versionRow] = await Promise.all([
    request('plugins?select=plugin_id,output_name,source_name,display_name,source_priority&order=source_priority'),
    request('app_config?select=value&key=eq.dataVersion'),
  ]);
  const version = versionRow?.[0]?.value?.updatedAt || null;
  log(`${plugins.length} plugins, data version ${version}`);

  const manifest = { version, built: new Date().toISOString(), plugins: {} };
  let next = 0, totalBytes = 0, failures = 0;
  const work = async () => {
    while (next < plugins.length) {
      const p = plugins[next++];
      const entry = { plugin_id: p.plugin_id };
      const safe = p.output_name.replace(/[^A-Za-z0-9._-]+/g, '_');
      const kinds = {
        catalog:  () => viaRpcOrTables('get_plugin_catalog', { p_plugin_id: p.plugin_id }, () => catalogFromTables(p.plugin_id)),
        map:      () => viaRpcOrTables('get_plugin_map',     { p_plugin_id: p.plugin_id }, () => mapFromTables(p.plugin_id)),
        missions: () => allRows('missions', `select=*&plugin_id=eq.${encodeURIComponent(p.plugin_id)}&order=id`),
      };
      const notes = [];
      for (const [kind, get] of Object.entries(kinds)) {
        try {
          const data = await get();
          if (!data || (kind !== 'missions' && typeof data !== 'object')) throw new Error('empty answer');
          const { files, bytes } = writeBundle(`${safe}.${kind}`, data);
          entry[kind] = files; totalBytes += bytes;
          notes.push(`${kind} ${mb(bytes)}${files.length > 1 ? ` in ${files.length} parts` : ''}`);
        } catch (err) {
          failures++;
          notes.push(`${kind} skipped (${String(err.message).slice(0, 80)})`);
        }
      }
      manifest.plugins[p.output_name] = entry;
      log(`✓ ${p.output_name}: ${notes.join(', ')}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));
  log(`Done in ${((Date.now() - started) / 1000).toFixed(0)} s — ${Object.keys(manifest.plugins).length} plugins, ${mb(totalBytes)} total${failures ? `, ${failures} part(s) skipped` : ''}.`);
}

main().catch(err => {
  // never fail the deploy — the site falls back to Supabase
  log('Could not build the ready-made files:', err.message);
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (_) {}
});
