'use strict';

// Writes the attribute definitions into the attribute_* tables in Supabase. Used by parser.js.

// Attribute fields that live in dedicated columns / child tables.
// Anything NOT listed here is preserved in `extra`.
const COLUMN_FIELDS = new Set([
  'key', 'displayUnit', 'displayMultiplier', 'isBoolean', 'description', 'area',
  'shipPanelLabel', 'stacking', 'stackingDescription',
  'shipRequirement', 'isRequiredOnShip', 'isRecommendedOnShip', 'presencePctAll',
  'areaBadges', 'usedInNavFunctions', 'tooltip',
]);

// Top-level sections that are NOT stored in attribute_calculations.
const NON_CALC_SECTIONS = new Set(['attributes', 'tooltips']);

const LEVEL_TO_DB = { required: 'required', recommended: 'recommended', engineDerived: 'engine_derived' };

const CHUNK = 500;
// split into chunks
const chunk = (arr, n = CHUNK) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const round2 = v => (v === null || v === undefined || !isFinite(v)) ? null : Math.round(v * 100) / 100;
const orNull = v => (v === undefined ? null : v);

// which keys each table should hold
function computePresenceAll(shipRows) {
  const counts = {};
  let total = 0;
  for (const row of shipRows || []) {
    const attrs = row && row.attributes;
    if (!attrs || typeof attrs !== 'object') continue;
    total++;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || typeof v === 'object') continue; // skip weapon/licenses blocks
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  const pct = {};
  if (total) for (const [k, c] of Object.entries(counts)) pct[k] = round2((c / total) * 100);
  return { total, pct };
}

// definitions → table rows
function attrDefsToRows(attrDefs, { shipRows } = {}) {
  const attributes = attrDefs.attributes || {};
  const presenceAll = computePresenceAll(shipRows);
  const now = new Date().toISOString();

  const definitions = [], flags = [], badges = [], navFns = [];

  for (const [key, a] of Object.entries(attributes)) {
    const req = a.shipRequirement || null;
    const extra = {};
    for (const [f, v] of Object.entries(a)) {
      if (COLUMN_FIELDS.has(f)) continue;
      if (v === true) { flags.push({ attribute_key: key, flag_name: f }); continue; }
      if (v === false || v === undefined) continue;
      extra[f] = v;
    }

    definitions.push({
      key,
      display_unit:          orNull(a.displayUnit),
      display_multiplier:    orNull(a.displayMultiplier),
      is_boolean:            a.isBoolean === true,
      description:           orNull(a.description),
      area:                  typeof a.area === 'string' ? a.area : null,
      ship_panel_label:      orNull(a.shipPanelLabel),
      stacking:              orNull(a.stacking),
      stacking_description:  orNull(a.stackingDescription),
      required:              !!(req && req.level === 'required'),
      ship_requirement:      req && req.level ? (LEVEL_TO_DB[req.level] || null) : null,
      min_value:             req && req.min !== undefined ? req.min : null,
      min_exclusive:         req && req.minExclusive !== undefined ? !!req.minExclusive : null,
      engine_default:        req && req.engineDefault !== undefined ? req.engineDefault : null,
      requirement_reasons:   req && req.reasons && req.reasons.length ? req.reasons : null,
      presence_pct_official: req && req.coverage !== null && req.coverage !== undefined ? round2(req.coverage * 100) : null,
      presence_pct_all:      presenceAll.total ? (presenceAll.pct[key] ?? 0) : null,
      extra,
      updated_at: now,
    });

    for (const b of new Set(a.areaBadges || []))         badges.push({ attribute_key: key, badge: b });
    for (const fn of new Set(a.usedInNavFunctions || [])) navFns.push({ attribute_key: key, function_name: fn });
  }

  const tooltips = Object.entries(attrDefs.tooltips || {})
    .filter(([, t]) => typeof t === 'string' && t.length)
    .map(([key, tooltip]) => ({ key, tooltip }));

  const calculations = Object.entries(attrDefs)
    .filter(([section]) => !NON_CALC_SECTIONS.has(section))
    .map(([section, value]) => ({ section, value: value ?? null, updated_at: now }));

  return { definitions, flags, badges, navFns, tooltips, calculations, presenceAllShipCount: presenceAll.total };
}

// every row of a table
async function fetchAll(supabase, table, select) {
  let from = 0, rows = [];
  for (;;) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`select ${table}: ${error.message}`);
    rows = rows.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

// upsert
async function upsertAll(supabase, table, rows, onConflict, opts = {}) {
  for (const part of chunk(rows)) {
    const { error } = await supabase.from(table).upsert(part, { onConflict, ...opts });
    if (error) throw new Error(`upsert ${table}: ${error.message}`);
  }
}

// delete
async function deleteIn(supabase, table, column, values) {
  for (const part of chunk(values, 200)) {
    const { error } = await supabase.from(table).delete().in(column, part);
    if (error) throw new Error(`delete ${table}: ${error.message}`);
  }
}

// child tables: add new pairs, remove old ones
async function mirrorChild(supabase, table, nameCol, rows) {
  const existing = await fetchAll(supabase, table, `id, attribute_key, ${nameCol}`);
  const want = new Set(rows.map(r => `${r.attribute_key}\u0000${r[nameCol]}`));
  const have = new Set(existing.map(r => `${r.attribute_key}\u0000${r[nameCol]}`));
  const stale = existing.filter(r => !want.has(`${r.attribute_key}\u0000${r[nameCol]}`)).map(r => r.id);
  const fresh = rows.filter(r => !have.has(`${r.attribute_key}\u0000${r[nameCol]}`));
  if (stale.length) await deleteIn(supabase, table, 'id', stale);
  if (fresh.length) await upsertAll(supabase, table, fresh, `attribute_key,${nameCol}`, { ignoreDuplicates: true });
  return { added: fresh.length, removed: stale.length };
}

// keyed tables
async function mirrorKeyed(supabase, table, keyCol, rows) {
  if (rows.length) await upsertAll(supabase, table, rows, keyCol);
  const existing = await fetchAll(supabase, table, keyCol);
  const want = new Set(rows.map(r => r[keyCol]));
  const stale = existing.map(r => r[keyCol]).filter(k => !want.has(k));
  if (stale.length) await deleteIn(supabase, table, keyCol, stale);
  return { written: rows.length, removed: stale.length };
}

// sync every table. Called by: parser.js
async function syncAttributeTables(supabase, attrDefs, { shipRows } = {}) {
  const rows = attrDefsToRows(attrDefs, { shipRows });
  if (!rows.definitions.length) throw new Error('attributeDefinitions has no attributes — refusing to wipe the tables');

  // 1. Parents first so child foreign keys resolve.
  await upsertAll(supabase, 'attribute_definitions', rows.definitions, 'key');

  // 2. Children.
  const f = await mirrorChild(supabase, 'attribute_flags',         'flag_name',     rows.flags);
  const b = await mirrorChild(supabase, 'attribute_area_badges',   'badge',         rows.badges);
  const n = await mirrorChild(supabase, 'attribute_nav_functions', 'function_name', rows.navFns);

  // 3. Independent tables.
  const t = await mirrorKeyed(supabase, 'attribute_tooltips',     'key',     rows.tooltips);
  const c = await mirrorKeyed(supabase, 'attribute_calculations', 'section', rows.calculations);

  // 4. Stale parents last — cascade removes any children they still had.
  const existingKeys = (await fetchAll(supabase, 'attribute_definitions', 'key')).map(r => r.key);
  const want = new Set(rows.definitions.map(r => r.key));
  const staleKeys = existingKeys.filter(k => !want.has(k));
  if (staleKeys.length) await deleteIn(supabase, 'attribute_definitions', 'key', staleKeys);

  const summary = {
    definitions: rows.definitions.length, staleDefinitionsRemoved: staleKeys.length,
    flags: f, badges: b, navFunctions: n, tooltips: t, calculations: c,
    presenceAllShipCount: rows.presenceAllShipCount,
  };
  console.log(`  ✓ attribute tables: ${summary.definitions} definitions (${staleKeys.length} stale removed), ` +
    `flags +${f.added}/-${f.removed}, badges +${b.added}/-${b.removed}, nav fns +${n.added}/-${n.removed}, ` +
    `${t.written} tooltips, ${c.written} calculation sections, presence_pct_all over ${rows.presenceAllShipCount} ships`);
  return summary;
}

module.exports = { syncAttributeTables, attrDefsToRows, computePresenceAll };
