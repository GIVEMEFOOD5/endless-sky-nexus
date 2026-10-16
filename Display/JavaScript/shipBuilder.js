'use strict';

// ═══════════════════════════════════════════════════════════
//  shipBuilder.js
//  Three modes:
//    'new'    — create a ship from scratch
//    'edit'   — edit an existing parsed/saved ship
//    'outfit' — outfit an existing ship (starts on outfits tab)
//
//  Fleet storage:
//    es_ship_builder_v4      →  main built fleet (sbFleet)
//    ES_SM_ACTIVE_SAVE_SHIPS →  current save's ships (sbSaveFleet)
//      sbSave() never touches ES_SM_ACTIVE_SAVE_SHIPS.
//      sbSaveSaveShips() never touches es_ship_builder_v4.
//      Both are loaded on init and kept in separate arrays.
//
//  Save-ship editing:
//    sbEditMode === 'save' means we are editing from sbSaveFleet.
//    saveShip() checks sbEditMode and writes to the correct store.
//    Duplicating a save ship promotes it into sbFleet.
//
//  ── CHANGELOG (internal-ID pass) ──────────────────────────────────────────
//    Outfit lookups throughout this file previously matched by bare NAME
//    only (sbGetOutfitLookup built a flat `{ name: outfit }` map, silently
//    overwritten whenever two loaded plugins defined a same-named outfit —
//    last one processed wins, with no warning). parser.js now stamps every
//    outfit with a `pluginId::name` internalId (see outfitMapToOutputFormat
//    / _registerOutfit), and every outfit reference already carried on a
//    ship (`ship.outfits[name] = { count, pluginId, internalId }`) carries
//    that same compound key. sbFindOutfit and everything that calls it now
//    accept an optional `pluginId` and prefer an exact internalId match,
//    falling back to the old name-only lookup only when no pluginId is
//    known (e.g. an outfit typed in manually via the free-text "Add
//    Outfit" dialog, which has no plugin to attach). Every call site that
//    already has an outfit entry object (which carries `.pluginId`) now
//    threads it through instead of discarding it.
// ═══════════════════════════════════════════════════════════

const SB_STORAGE_KEY      = 'es_ship_builder_v4';
const SB_SAVE_SHIPS_KEY   = 'ES_SM_ACTIVE_SAVE_SHIPS';

let sbFleet       = [];       // main built fleet
let sbSaveFleet   = [];       // ships from current save file
let sbEditIdx     = -1;       // index in sbFleet (-1 = new)
let sbSaveEditIdx = -1;       // index in sbSaveFleet (-1 = not editing a save ship)
let sbEditMode    = 'built';  // 'built' | 'save'
let sbCurrentShip = null;
let sbMode        = 'new';    // 'new' | 'edit' | 'outfit'

// Collapse state — save fleet starts collapsed, built fleet expanded
let sbSaveFleetCollapsed  = true;
let sbBuiltFleetCollapsed = false;

// Live data mirrors from DataViewer
let sbAllShips   = [];
let sbAllOutfits = [];
let sbAllEffects = [];
let sbAttrKeys   = [];

// ═══════════════════════════════════════════════════════════
//  DATA BRIDGE
// ═══════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────
//  Curated from the parser's attribute dictionary + tooltips.txt.
//  A handful of real ship attributes never made it into the structured
//  attribute dictionary (it's built from OutfitInfoDisplay.cpp's scale/
//  boolean/value-name tables, which don't cover everything) but they do
//  show up as attributesRead on Ship.cpp functions and/or in tooltips.txt:
//    - "required crew" / "mandatory crew" / "use crew equivalent as crew"
//      → read by Ship::RequiredCrew / Ship::FleetCost
//    - "disabled recovery energy/fuel/heat/ionization/scrambling/
//      disruption/slowing/discharge/corrosion/leak/burning"
//      → read by Ship::DoGeneration (only "disabled recovery time" made
//      it into the dictionary)
//    - "heat capacity", "absolute threshold", "landing speed",
//      "cloak hull threshold", "cloak phasing", "self destruct",
//      "capture attack", "capture defense", "jump base mass", "income",
//      "illegal", "maintenance costs", "operating costs",
//      "operating income", and the scan/jamming family
//      → documented only in data/_ui/tooltips.txt
//  These are folded in below alongside the dictionary-derived keys.
// ─────────────────────────────────────────────────────────
const _SB_ATTR_FALLBACK = [
  // Identity / basic
  'category','mass','drag','required crew','mandatory crew','bunks','cargo space',
  'fuel capacity','cost','automaton','use crew equivalent as crew','crew equivalent',
  'flotsam chance','income','illegal','maintenance costs','operating costs','operating income',
  // Hull / shields
  'shields','hull','hull repair rate','hull energy','hull fuel','hull heat',
  'delayed hull repair rate','delayed hull energy','delayed hull fuel','delayed hull heat',
  'hull multiplier','hull repair multiplier','hull energy multiplier','hull fuel multiplier','hull heat multiplier',
  'hull threshold','threshold percentage','absolute threshold',
  'shield generation','shield energy','shield fuel','shield heat',
  'delayed shield generation','delayed shield energy','delayed shield fuel','delayed shield heat',
  'shield multiplier','shield generation multiplier','shield energy multiplier','shield fuel multiplier','shield heat multiplier',
  'high shield permeability','low shield permeability',
  'repair delay','disabled repair delay','shield delay','depleted shield delay','disabled recovery time',
  'disabled recovery energy','disabled recovery fuel','disabled recovery heat','disabled recovery ionization',
  'disabled recovery scrambling','disabled recovery disruption','disabled recovery slowing',
  'disabled recovery discharge','disabled recovery corrosion','disabled recovery leak','disabled recovery burning',
  // Power / heat
  'energy capacity','energy generation','energy consumption','heat capacity','heat generation','heat dissipation',
  'cooling','cooling energy','active cooling','cooling inefficiency',
  'fuel generation','fuel consumption','fuel energy','fuel heat',
  'solar collection','solar heat','ramscoop',
  'overheat damage rate','overheat damage threshold',
  // Movement
  'thrust','thrusting energy','thrusting heat','thrusting shields','thrusting hull','thrusting fuel',
  'reverse thrust','reverse thrusting energy','reverse thrusting heat','reverse thrusting shields',
  'reverse thrusting hull','reverse thrusting fuel',
  'afterburner thrust','afterburner energy','afterburner fuel','afterburner heat','afterburner shields','afterburner hull',
  'turn','turning energy','turning heat','turning shields','turning hull','turning fuel',
  'turn multiplier','turret turn multiplier','acceleration multiplier','inertia reduction','drag reduction',
  'landing speed',
  // Capacity / hardpoints
  'outfit space','weapon capacity','engine capacity','gun ports','turret mounts',
  // Drives
  'hyperdrive','jump drive','scram drive','hyperdrive fuel','jump drive fuel','jump fuel','jump range',
  'jump speed','jump mass cost','jump base mass',
  // Cloaking
  'cloak','cloak by mass','cloaking energy','cloaking fuel','cloaking heat','cloaking shields','cloaking hull',
  'cloaking repair delay','cloaking shield delay','cloak hull threshold','cloak hull protection','cloak shield protection',
  'cloaked shield permeability','cloaked regen multiplier','cloaked repair multiplier','cloaked firing','cloak phasing',
  'cloaked afterburner','cloaked boarding','cloaked communication','cloaked deployment','cloaked pickup','cloaked scanning',
  // Resistances / protections
  'ion resistance','ion resistance energy','ion resistance fuel','ion resistance heat','ion protection',
  'scramble resistance','scramble resistance energy','scramble resistance fuel','scramble resistance heat','scramble protection',
  'disruption resistance','disruption resistance energy','disruption resistance fuel','disruption resistance heat','disruption protection',
  'slowing resistance','slowing resistance energy','slowing resistance fuel','slowing resistance heat','slowing protection',
  'discharge resistance','discharge resistance energy','discharge resistance fuel','discharge resistance heat','discharge protection',
  'corrosion resistance','corrosion resistance energy','corrosion resistance fuel','corrosion resistance heat','corrosion protection',
  'leak resistance','leak resistance energy','leak resistance fuel','leak resistance heat','leak protection',
  'burn resistance','burn resistance energy','burn resistance fuel','burn resistance heat','burn protection',
  'energy protection','fuel protection','heat protection','hull protection','shield protection',
  'force protection','piercing protection','piercing resistance','hitforce protection','scaling protection',
  // Scanning / detection
  'atmosphere scan','asteroid scan power','cargo scan','cargo scan power','cargo scan speed','cargo scan efficiency','cargo scan opacity',
  'outfit scan','outfit scan power','outfit scan speed','outfit scan efficiency','outfit scan opacity',
  'strategic scan power','tactical scan power','acceleration scan power','crew scan power','energy scan power',
  'fuel scan power','maneuver scan power','mobility scan power','range finder power','thermal scan power',
  'velocity scan power','weapon scan power','optical jamming','radar jamming','scan interference',
  'scan brightness','scan concealment','silent jumps','silent scans',
  // Misc
  'self destruct','capture attack','capture defense','map','map minables','minable','atrocity','unique',
  'unplunderable','installable',
];

function sbRefreshLiveData() {
  _sbOutfitLookup = null;
  const DL = window.DataLoader;
  if (DL && DL.isReady()) {
    sbAllShips   = DL.getAllShips().map(s => ({ ...s, _pn: s._pluginName, _pd: s._pluginDisplay }));
    sbAllOutfits = DL.getAllOutfits().map(o => ({ ...o, _pn: o._pluginName, _pd: o._pluginDisplay }));
    sbAllEffects = DL.getAllEffects().map(e => ({ ...e, _pn: e._pluginName, _pd: e._pluginDisplay }));
    const defKeys = DL.getAttrKeys();
    sbAttrKeys   = [...new Set([..._SB_ATTR_FALLBACK, ...defKeys])].sort();
  } else {
    sbAllShips   = [];
    sbAllOutfits = [];
    sbAllEffects = [];
    sbAttrKeys   = [..._SB_ATTR_FALLBACK].sort();
  }
}

function sbAttrHint(key) {
  if (window.DataLoader) return window.DataLoader.getAttrHint(key);
  return '';
}

// ═══════════════════════════════════════════════════════════
//  BLANK SHIP
// ═══════════════════════════════════════════════════════════
function sbBlank() {
  return {
    id: Date.now() + Math.random(),
    name: '', variant: '', plural: '', sprite: '', thumbnail: '',
    description: '', drag: '', mass: '',
    attributes: {},
    weapon: { 'blast radius': 0, 'shield damage': 0, 'hull damage': 0, 'hit force': 0 },
    outfits: [],
    guns: [], turrets: [], drones: [], fighters: [], engines: [],
    leaks: [], explode: [], finalExplode: [], extraLines: [],
    _sourceShip: null, _sourcePlugin: null,
  };
}

// ─────────────────────────────────────────────────────────
//  LEAK NORMALISATION
// ─────────────────────────────────────────────────────────
function _sbNormaliseLeak(raw) {
  if (!raw) return { name: '', openChance: 0, spreadChance: 0 };
  if (typeof raw === 'object' && raw.effect != null) {
    return { name: String(raw.effect), openChance: parseInt(raw.openChance) || 0, spreadChance: parseInt(raw.spreadChance) || 0 };
  }
  if (typeof raw === 'object' && raw.name != null && raw.openChance != null) {
    return { name: String(raw.name), openChance: parseInt(raw.openChance) || 0, spreadChance: parseInt(raw.spreadChance) || 0 };
  }
  if (typeof raw === 'object' && raw.name != null) {
    return { name: String(raw.name), openChance: parseInt(raw.count) || 0, spreadChance: 0 };
  }
  if (typeof raw === 'string') {
    const tok = raw.trim().match(/^("([^"]+)"|(\S+))(?:\s+(\d+))?(?:\s+(\d+))?$/);
    if (tok) return { name: (tok[2] || tok[3] || '').replace(/^"([^"]*)"$/, '$1'), openChance: parseInt(tok[4]) || 0, spreadChance: parseInt(tok[5]) || 0 };
    return { name: raw.trim(), openChance: 0, spreadChance: 0 };
  }
  return { name: '', openChance: 0, spreadChance: 0 };
}

// ═══════════════════════════════════════════════════════════
//  OUTFIT NORMALISATION
// ═══════════════════════════════════════════════════════════
//
// NEW (internal-ID pass): also carries through `internalId` when the
// source data has it (parser.js now stamps `pluginId::name` on every
// ship-outfit entry — see outfitMapToOutputFormat). Falls back to
// deriving it from pluginId+name when the source is older cached data
// that predates this field, and to null (name-only lookup) when pluginId
// itself is unknown.
function _sbNormaliseOutfitsToArray(outfits) {
  if (!outfits) return [];
  const withId = (name, pluginId, internalId) =>
    internalId || (pluginId ? `${pluginId}::${name}` : null);
  if (Array.isArray(outfits)) {
    return outfits.map(o => {
      const name     = (o.name || '').replace(/^"([^"]*)"$/, '$1');
      const pluginId = o.pluginId || null;
      return { name, count: parseInt(o.count) || 1, pluginId, internalId: withId(name, pluginId, o.internalId) };
    });
  }
  if (typeof outfits === 'object') {
    return Object.entries(outfits).map(([name, val]) => {
      const cleanName = name.replace(/^"([^"]*)"$/, '$1');
      const pluginId  = typeof val === 'object' ? (val.pluginId || null) : null;
      const internalId = typeof val === 'object' ? val.internalId : null;
      return {
        name:     cleanName,
        count:    typeof val === 'object' ? (parseInt(val.count) || 1) : (Number(val) || 1),
        pluginId,
        internalId: withId(cleanName, pluginId, internalId),
      };
    });
  }
  return [];
}

// ═══════════════════════════════════════════════════════════
//  PERSISTENCE — MAIN BUILT FLEET
// ═══════════════════════════════════════════════════════════

function sbSave() {
  // Only writes to es_ship_builder_v4 — never touches ES_SM_ACTIVE_SAVE_SHIPS
  const toStore = sbFleet.map(ship => ({
    ...ship,
    outfits: Object.fromEntries(
      (ship.outfits || []).map(o => [
        o.name.replace(/^"([^"]*)"$/, '$1'),
        { count: o.count ?? 1, pluginId: o.pluginId ?? null, internalId: o.internalId ?? null },
      ])
    ),
  }));
  try { localStorage.setItem(SB_STORAGE_KEY, JSON.stringify(toStore)); } catch(e) {}
}

function sbLoad() {
  try {
    const d = localStorage.getItem(SB_STORAGE_KEY);
    if (d) {
      const raw = JSON.parse(d);
      sbFleet = raw.map(ship => ({
        ...ship,
        outfits: _sbNormaliseOutfitsToArray(ship.outfits),
        leaks:   (ship.leaks || []).map(_sbNormaliseLeak),
      }));
    }
  } catch(e) { sbFleet = []; }
}

// ═══════════════════════════════════════════════════════════
//  PERSISTENCE — SAVE FLEET
//  Reads/writes ES_SM_ACTIVE_SAVE_SHIPS only.
//  Called by saveManager via sbLoadSaveShips() for hot-reload.
// ═══════════════════════════════════════════════════════════

function sbLoadSaveShips() {
  try {
    const d = localStorage.getItem(SB_SAVE_SHIPS_KEY);
    if (d) {
      const raw = JSON.parse(d);
      sbSaveFleet = raw.map(ship => ({
        ...ship,
        outfits: _sbNormaliseOutfitsToArray(ship.outfits),
        leaks:   (ship.leaks || []).map(_sbNormaliseLeak),
        _fromSave: true,
      }));
    } else {
      sbSaveFleet = [];
    }
  } catch(e) { sbSaveFleet = []; }
  renderFleet();
  renderExportChecklist();
}

function sbSaveSaveShips() {
  // Only writes to ES_SM_ACTIVE_SAVE_SHIPS — never touches es_ship_builder_v4
  const toStore = sbSaveFleet.map(ship => ({
    ...ship,
    outfits: Object.fromEntries(
      (ship.outfits || []).map(o => [
        o.name.replace(/^"([^"]*)"$/, '$1'),
        { count: o.count ?? 1, pluginId: o.pluginId ?? null, internalId: o.internalId ?? null },
      ])
    ),
  }));
  try { localStorage.setItem(SB_SAVE_SHIPS_KEY, JSON.stringify(toStore)); } catch(e) {}
}

// ═══════════════════════════════════════════════════════════
//  VIEW SWITCHING
// ═══════════════════════════════════════════════════════════
function showFleetView() {
  document.getElementById('fleet-view').classList.remove('hidden');
  document.getElementById('builder-view').classList.add('hidden');
  renderFleet();
  renderExportChecklist();
}
function showBuilderView() {
  document.getElementById('fleet-view').classList.add('hidden');
  document.getElementById('builder-view').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════
//  FLEET RENDER — two collapsible sections
// ═══════════════════════════════════════════════════════════
function renderFleet() {
  const grid = document.getElementById('fleet-grid');
  if (!grid) return;

  const hasSaveShips  = sbSaveFleet.length  > 0;
  const hasBuiltShips = sbFleet.length > 0;

  if (!hasSaveShips && !hasBuiltShips) {
    grid.innerHTML = `<div class="fleet-empty"><div class="fleet-empty__icon">🛸</div>
      <p>No ships yet. Add one to start:</p>${sbAddShipOptionsHtml()}</div>`;
    return;
  }

  // ── Save Fleet Section ──────────────────────────────────
  let saveSection = '';
  if (hasSaveShips) {
    const saveCards = sbSaveFleet.map((s, i) => {
      const a = s.attributes || {};
      return `<div class="fleet-card" onclick="sbEditSaveShip(${i})">
        <div class="fleet-card__name">
          ${esc(s.customName || s.name || 'Unnamed Ship')}
          <span class="badge" style="font-size:0.62rem;margin-left:6px;background:var(--c-accent);color:#fff;padding:2px 7px;border-radius:10px;vertical-align:middle;">💾 Save</span>
          ${s._parked ? '<span class="badge" style="font-size:0.62rem;margin-left:4px;background:var(--c-warn);color:var(--c-warn-text);padding:2px 7px;border-radius:10px;vertical-align:middle;">Parked</span>' : ''}
        </div>
        <div class="fleet-card__variant">${esc(s.name || '')}${s._system ? ' <span style="color:var(--c-text-dim);font-size:0.78rem;">· ' + esc(s._system) + '</span>' : ''}</div>
        <div class="fleet-card__stats">
          <div class="fleet-card__stat"><div class="fleet-card__stat-label">Shields</div><div class="fleet-card__stat-value">${a.shields || s._shields || '—'}</div></div>
          <div class="fleet-card__stat"><div class="fleet-card__stat-label">Hull</div><div class="fleet-card__stat-value">${a.hull || s._hull || '—'}</div></div>
          <div class="fleet-card__stat"><div class="fleet-card__stat-label">Category</div><div class="fleet-card__stat-value" style="font-size:0.8rem;">${a.category || '—'}</div></div>
          <div class="fleet-card__stat"><div class="fleet-card__stat-label">Outfits</div><div class="fleet-card__stat-value">${(s.outfits || []).length}</div></div>
        </div>
        <div class="fleet-card__actions" onclick="event.stopPropagation()">
          <button class="btn btn-primary btn-sm"   onclick="sbEditSaveShip(${i})">✏️ Edit</button>
          <button class="btn btn-secondary btn-sm" onclick="sbPromoteSaveShip(${i})" title="Copy into main fleet">⬆ Promote</button>
          ${window.BuilderToSave ? `<button class="btn btn-secondary btn-sm" onclick="BuilderToSave.open(${i},'save')" title="Write this ship back into the save it came from">➜ Save file</button>` : ''}
          <button class="btn btn-danger btn-sm"    onclick="sbConfirmDeleteSaveShip(${i})">🗑</button>
        </div>
      </div>`;
    }).join('');

    saveSection = `
      <div class="fleet-section" id="save-fleet-section">
        <div class="fleet-section-header" onclick="sbToggleSaveFleet()" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--c-surface-2);border-radius:var(--r-md);margin-bottom:${sbSaveFleetCollapsed ? '0' : '12px'};user-select:none;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:1rem;font-weight:700;color:var(--c-text-hi);">💾 Current Save Fleet</span>
            <span class="badge" style="background:var(--c-accent);color:#fff;font-size:0.72rem;padding:2px 9px;border-radius:10px;">${sbSaveFleet.length} ship${sbSaveFleet.length !== 1 ? 's' : ''}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();sbClearSaveFleet()" title="Clear all save ships">🗑</button>
            <span style="font-size:1.1rem;color:var(--c-text-dim);transition:transform .2s;" id="save-fleet-chevron">${sbSaveFleetCollapsed ? '▶' : '▼'}</span>
          </div>
        </div>
        <div id="save-fleet-cards" style="display:${sbSaveFleetCollapsed ? 'none' : 'grid'};grid-template-columns:repeat(auto-fill, minmax(min(280px, 100%), 1fr));gap:16px;margin-bottom:24px;">
          ${saveCards}
        </div>
      </div>`;
  }

  // ── Built Fleet Section ─────────────────────────────────
  let builtSection = '';
  if (hasBuiltShips) {
    const builtCards = sbFleet.map((s, i) => {
      const a = s.attributes || {};
      const src = s._sourceShip
        ? `<span class="badge badge-blue" style="font-size:0.65rem;margin-left:6px;">based on ${esc(sbShipLabel(s._sourceShip))}</span>`
        : '';
      return `<div class="fleet-card" onclick="sbEditFleetShip(${i})">
        <div class="fleet-card__name">${esc(s.name || 'Unnamed Ship')}${src}${(window.PluginAvailability ? window.PluginAvailability.badgeHtml(s) : '')}</div>
        <div class="fleet-card__variant">${s.variant ? esc(s.variant) : '<em style="color:var(--c-text-dim)">No variant</em>'}</div>
        <div class="fleet-card__stats">
          <div class="fleet-card__stat"><div class="fleet-card__stat-label">Shields</div><div class="fleet-card__stat-value">${a.shields || '—'}</div></div>
          <div class="fleet-card__stat"><div class="fleet-card__stat-label">Hull</div><div class="fleet-card__stat-value">${a.hull || '—'}</div></div>
          <div class="fleet-card__stat"><div class="fleet-card__stat-label">Category</div><div class="fleet-card__stat-value" style="font-size:0.8rem;">${a.category || '—'}</div></div>
          <div class="fleet-card__stat"><div class="fleet-card__stat-label">Outfits</div><div class="fleet-card__stat-value">${(s.outfits || []).length}</div></div>
        </div>
        <div class="fleet-card__actions" onclick="event.stopPropagation()">
          <button class="btn btn-primary btn-sm"   onclick="sbEditFleetShip(${i})">✏️ Edit</button>
          <button class="btn btn-secondary btn-sm" onclick="sbDuplicate(${i})">⧉ Copy</button>
          <button class="btn btn-secondary btn-sm" onclick="sbShareFleetShip(${i})" title="Copy a link that opens this ship — no account needed">🔗 Link</button>
          <button class="btn btn-secondary btn-sm" onclick="sbOpenCloudSaveModal(${i})" title="Share this ship — you choose whether other people can see it">🌐 Share</button>
          ${window.BuilderToSave ? `<button class="btn btn-secondary btn-sm" onclick="BuilderToSave.open(${i})" title="Add this ship to one of your saves, or refit a ship in it">➜ Save file</button>` : ''}
          <button class="btn btn-danger btn-sm"    onclick="sbConfirmDelete(${i})">🗑</button>
        </div>
      </div>`;
    }).join('');

    builtSection = `
      <div class="fleet-section" id="built-fleet-section">
        <div class="fleet-section-header" onclick="sbToggleBuiltFleet()" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--c-surface-2);border-radius:var(--r-md);margin-bottom:${sbBuiltFleetCollapsed ? '0' : '12px'};user-select:none;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:1rem;font-weight:700;color:var(--c-text-hi);">🛸 My Built Fleet</span>
            <span class="badge" style="background:var(--c-surface-4);color:var(--c-text-mid);font-size:0.72rem;padding:2px 9px;border-radius:10px;">${sbFleet.length} ship${sbFleet.length !== 1 ? 's' : ''}</span>
          </div>
          <span style="font-size:1.1rem;color:var(--c-text-dim);transition:transform .2s;" id="built-fleet-chevron">${sbBuiltFleetCollapsed ? '▶' : '▼'}</span>
        </div>
        <div id="built-fleet-cards" style="display:${sbBuiltFleetCollapsed ? 'none' : 'grid'};grid-template-columns:repeat(auto-fill, minmax(min(280px, 100%), 1fr));gap:16px;margin-bottom:24px;">
          ${builtCards}
        </div>
      </div>`;
  } else if (!hasSaveShips) {
    // neither fleet has ships — already handled above
  } else {
    builtSection = `
      <div class="fleet-section" id="built-fleet-section">
        <div class="fleet-section-header" style="padding:12px 16px;background:var(--c-surface-2);border-radius:var(--r-md);margin-bottom:0;">
          <span style="font-size:1rem;font-weight:700;color:var(--c-text-hi);">🛸 My Built Fleet</span>
          <span style="margin-left:10px;font-size:0.82rem;color:var(--c-text-dim);">No ships yet — create one below.</span>
        </div>
      </div>`;
  }

  grid.innerHTML = saveSection + builtSection;
}

// ── Collapse toggles ──────────────────────────────────────
function sbToggleSaveFleet() {
  sbSaveFleetCollapsed = !sbSaveFleetCollapsed;
  const cards   = document.getElementById('save-fleet-cards');
  const chevron = document.getElementById('save-fleet-chevron');
  const header  = document.querySelector('#save-fleet-section .fleet-section-header');
  if (cards)   cards.style.display   = sbSaveFleetCollapsed ? 'none' : 'grid';
  if (chevron) chevron.textContent   = sbSaveFleetCollapsed ? '▶' : '▼';
  if (header)  header.style.marginBottom = sbSaveFleetCollapsed ? '0' : '12px';
}
function sbToggleBuiltFleet() {
  sbBuiltFleetCollapsed = !sbBuiltFleetCollapsed;
  const cards   = document.getElementById('built-fleet-cards');
  const chevron = document.getElementById('built-fleet-chevron');
  const header  = document.querySelector('#built-fleet-section .fleet-section-header');
  if (cards)   cards.style.display   = sbBuiltFleetCollapsed ? 'none' : 'grid';
  if (chevron) chevron.textContent   = sbBuiltFleetCollapsed ? '▶' : '▼';
  if (header)  header.style.marginBottom = sbBuiltFleetCollapsed ? '0' : '12px';
}

// ═══════════════════════════════════════════════════════════
//  SAVE FLEET ACTIONS
// ═══════════════════════════════════════════════════════════

function sbEditSaveShip(i) {
  sbRefreshLiveData();
  sbMode        = 'edit';
  sbEditMode    = 'save';
  sbSaveEditIdx = i;
  sbEditIdx     = -1;
  sbCurrentShip = JSON.parse(JSON.stringify(sbSaveFleet[i]));
  sbCurrentShip.outfits = _sbNormaliseOutfitsToArray(sbCurrentShip.outfits);
  sbCurrentShip.leaks   = (sbCurrentShip.leaks || []).map(_sbNormaliseLeak);
  sbPopulateBuilder();
  showBuilderView();
}

/** Copy a save ship into the main built fleet (promotes it). */
function sbPromoteSaveShip(i) {
  const c = JSON.parse(JSON.stringify(sbSaveFleet[i]));
  c.id       = Date.now() + Math.random();
  c.outfits  = _sbNormaliseOutfitsToArray(c.outfits);
  c.leaks    = (c.leaks || []).map(_sbNormaliseLeak);
  c._fromSave = false;
  sbFleet.push(c);
  sbSave();
  renderFleet();
  renderExportChecklist();
  sbToast(`"${c.customName || c.name || 'Ship'}" promoted to main fleet.`, 'success');
}

function sbConfirmDeleteSaveShip(i) {
  const label = sbSaveFleet[i].customName || sbSaveFleet[i].name || 'Unnamed Ship';
  document.getElementById('confirm-text').textContent =
    `Remove "${label}" from the save fleet? This cannot be undone.`;
  document.getElementById('confirm-ok-btn').onclick = () => {
    sbSaveFleet.splice(i, 1);
    sbSaveSaveShips();
    closeModal('modal-confirm');
    renderFleet();
    sbToast('Ship removed from save fleet.', 'danger');
  };
  openModal('modal-confirm');
}

function sbClearSaveFleet() {
  if (!sbSaveFleet.length) return;
  document.getElementById('confirm-text').textContent =
    `Clear all ${sbSaveFleet.length} ships from the save fleet? This cannot be undone.`;
  document.getElementById('confirm-ok-btn').onclick = () => {
    sbSaveFleet = [];
    sbSaveSaveShips();
    closeModal('modal-confirm');
    renderFleet();
    sbToast('Save fleet cleared.', 'danger');
  };
  openModal('modal-confirm');
}

// ═══════════════════════════════════════════════════════════
//  MAIN FLEET ACTIONS
// ═══════════════════════════════════════════════════════════
function sbEditFleetShip(i) {
  sbRefreshLiveData();
  sbMode        = 'edit';
  sbEditMode    = 'built';
  sbEditIdx     = i;
  sbSaveEditIdx = -1;
  sbCurrentShip = JSON.parse(JSON.stringify(sbFleet[i]));
  sbCurrentShip.outfits = _sbNormaliseOutfitsToArray(sbCurrentShip.outfits);
  sbCurrentShip.leaks   = (sbCurrentShip.leaks || []).map(_sbNormaliseLeak);
  sbPopulateBuilder();
  showBuilderView();
}

function sbDuplicate(i) {
  const c = JSON.parse(JSON.stringify(sbFleet[i]));
  c.id      = Date.now() + Math.random();
  c.variant = (c.variant || '') + ' (Copy)';
  c.outfits = _sbNormaliseOutfitsToArray(c.outfits);
  c.leaks   = (c.leaks || []).map(_sbNormaliseLeak);
  sbFleet.push(c);
  sbSave();
  renderFleet();
  sbToast('Ship duplicated!', 'success');
}

function sbConfirmDelete(i) {
  document.getElementById('confirm-text').textContent =
    `Delete "${sbFleet[i].name || 'Unnamed Ship'}"? This cannot be undone.`;
  document.getElementById('confirm-ok-btn').onclick = () => {
    sbFleet.splice(i, 1);
    sbSave();
    closeModal('modal-confirm');
    renderFleet();
    sbToast('Ship deleted.', 'danger');
  };
  openModal('modal-confirm');
}

// ═══════════════════════════════════════════════════════════
//  SAVE TO ACCOUNT — uploads one built ship into the logged-in
//  user's save_files/saved_ships, optionally marking it public.
//  Entirely separate from sbSave() above, which only auto-persists
//  the whole local fleet to localStorage — this is an explicit,
//  per-ship action the user opts into.
// ═══════════════════════════════════════════════════════════

let _sbCloudSaveIndex = null;

function sbOpenCloudSaveModal(i) {
  if (!window.EsAuth) {
    sbToast('Account features are not available on this page.', 'danger');
    return;
  }
  _sbCloudSaveIndex = i;
  const ship = sbFleet[i];
  const loggedOutBox = document.getElementById('cloud-save-logged-out');
  const form = document.getElementById('cloud-save-form');
  const user = window.EsAuth.getCurrentUser();

  if (!user) {
    loggedOutBox.style.display = 'block';
    form.style.display = 'none';
  } else {
    loggedOutBox.style.display = 'none';
    form.style.display = 'block';
    document.getElementById('cloud-save-name').value = ship.name || ship.variant || 'My Ship';
    document.getElementById('cloud-save-public').checked = false;
    document.getElementById('cloud-save-error').innerHTML = '';
    // Sharing the same builder ship again updates its existing row, so
    // pre-fill from it (public/private and name) if there is one.
    window.supabaseClient.from('saved_ships').select('id, name, is_public')
      .eq('user_id', user.id).eq('source_ship_id', String(ship.id)).maybeSingle()
      .then(({ data }) => {
        if (!data || _sbCloudSaveIndex !== i) return;
        document.getElementById('cloud-save-name').value = data.name;
        document.getElementById('cloud-save-public').checked = !!data.is_public;
        document.getElementById('cloud-save-error').innerHTML =
          '<div class="auth-form-success">Already shared — saving again updates it.</div>';
      }, () => {});
  }
  openModal('modal-cloud-save');
}

/** Every user gets one default save file, created on first cloud save and
 * reused after that — the schema supports multiple save files per user,
 * but a dedicated "manage save files" UI is a separate feature; this
 * keeps the common case (just save my ship) to one click. */
async function _sbEnsureDefaultSaveFile(userId) {
  const { data: existing } = await window.supabaseClient
    .from('save_files').select('id').eq('user_id', userId).order('created_at', { ascending: true }).limit(1);
  if (existing && existing.length) return existing[0].id;

  const { data: created, error } = await window.supabaseClient
    .from('save_files').insert({ user_id: userId, name: 'My Save' }).select('id').single();
  if (error) throw error;
  return created.id;
}

(function initCloudSaveForm() {
  const form = document.getElementById('cloud-save-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById('cloud-save-error');
    const submitBtn = document.getElementById('cloud-save-submit-btn');
    errorBox.innerHTML = '';

    const user = window.EsAuth.getCurrentUser();
    if (!user || _sbCloudSaveIndex == null) return;
    const ship = sbFleet[_sbCloudSaveIndex];
    if (!ship) return;

    const name = document.getElementById('cloud-save-name').value.trim() || 'My Ship';
    const isPublic = document.getElementById('cloud-save-public').checked;

    // Same shape sbSave() already writes for local persistence, so a
    // build read back from the cloud looks identical to a local one.
    const buildData = {
      ...ship,
      name,
      outfits: Object.fromEntries(
        (ship.outfits || []).map(o => [
          o.name.replace(/^"([^"]*)"$/, '$1'),
          { count: o.count ?? 1, pluginId: o.pluginId ?? null, internalId: o.internalId ?? null },
        ])
      ),
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    try {
      const saveFileId = await _sbEnsureDefaultSaveFile(user.id);
      // One row per builder ship: sharing again updates it instead of
      // creating another copy (unique on user_id + source_ship_id).
      const { data: row, error } = await window.supabaseClient.from('saved_ships').upsert({
        save_file_id: saveFileId,
        user_id: user.id,
        source_ship_id: String(ship.id),
        name,
        build_data: buildData,
        is_public: isPublic,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,source_ship_id' }).select('id').single();
      if (error) throw error;

      if (isPublic && row) {
        const link = new URL('shipBuilder.html', location.href);
        link.searchParams.set('shared', row.id);
        try { await navigator.clipboard.writeText(link.href); } catch (_) { /* clipboard blocked — link still shown below */ }
        errorBox.innerHTML = `<div class="auth-form-success">Shared! Anyone with this link can open it (copied):<br>
          <input class="text-input" readonly value="${esc(link.href)}" onclick="this.select()" style="margin-top:6px;"></div>`;
        sbToast('Ship shared publicly — link copied.', 'success');
      } else {
        closeModal('modal-cloud-save');
        sbToast('Saved privately to your account — only you can see it.', 'success');
      }
    } catch (err) {
      errorBox.innerHTML = `<div class="auth-form-error">${err.message || 'Could not save — try again.'}</div>`;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save';
    }
  });
})();

// ═══════════════════════════════════════════════════════════
//  MODE ENTRY POINTS
// ═══════════════════════════════════════════════════════════
// Every way to put a ship into the fleet — shown in the empty fleet and in "＋ Add ship".
function sbAddShipOptionsHtml() {
  let hasSave = false;
  try { hasSave = !!JSON.parse(localStorage.getItem('ES_SM_CURRENT') || 'null'); } catch (_) {}
  const opt = (onclick, icon, title, hint) => `<button type="button" class="sb-add-opt" onclick="${onclick}">
      <span class="sb-add-opt__icon">${icon}</span><span><strong>${title}</strong><span class="sb-add-opt__hint">${hint}</span></span></button>`;
  return `<div class="sb-add-opts">
    ${opt("sbCloseAddShip();openOutfitExisting()", '🔧', 'Outfit a game ship', 'Start from any ship in your selected plugins and change its outfits')}
    ${opt("sbCloseAddShip();openEditExisting()", '✏️', 'Edit a game ship', 'Copy a ship and change anything — hull, hardpoints, outfits')}
    ${opt("sbCloseAddShip();newShip()", '＋', 'New ship from scratch', 'Set every attribute yourself')}
    ${opt("sbCloseAddShip();openImport()", '↑', 'Paste ship data', 'Paste ship definitions from a plugin or data file')}
    <a class="sb-add-opt" href="UserManager.html"><span class="sb-add-opt__icon">💾</span><span><strong>Ships from my save</strong>
      <span class="sb-add-opt__hint">${hasSave ? 'On Saves &amp; Account, use “Import Fleet to Builder” or a ship\'s 🛠 Builder button' : 'Open a save on Saves &amp; Account, then use “Import Fleet to Builder”'}</span></span></a>
  </div>`;
}
function sbOpenAddShip() {
  let m = document.getElementById('sb-add-ship-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'sb-add-ship-modal'; m.className = 'modal-overlay';
    m.addEventListener('click', e => { if (e.target === m) sbCloseAddShip(); });
    document.body.appendChild(m);
  }
  m.innerHTML = `<div class="modal-box" style="width:min(560px,96vw);">
    <div class="modal-header"><div class="modal-title">Add a ship to this fleet</div>
      <button class="modal-close" onclick="sbCloseAddShip()" aria-label="Close">×</button></div>
    ${sbAddShipOptionsHtml()}</div>`;
  m.classList.add('active');
}
function sbCloseAddShip() { const m = document.getElementById('sb-add-ship-modal'); if (m) m.classList.remove('active'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') sbCloseAddShip(); });

function newShip() {
  sbRefreshLiveData();
  sbMode = 'new'; sbEditIdx = -1; sbSaveEditIdx = -1; sbEditMode = 'built';
  sbCurrentShip = sbBlank();
  sbPopulateBuilder();
  showBuilderView();
}

function openOutfitExisting() {
  sbRefreshLiveData();
  if (!sbAllShips.length) { sbToast('No ship data loaded yet.', 'danger'); return; }
  sbMode = 'outfit';
  sbOpenShipPicker();
}

function openEditExisting() {
  sbRefreshLiveData();
  if (!sbAllShips.length) { sbToast('No ship data loaded yet.', 'danger'); return; }
  sbMode = 'edit';
  sbOpenShipPicker();
}

// ═══════════════════════════════════════════════════════════
//  SHIP PICKER
// ═══════════════════════════════════════════════════════════
function sbOpenShipPicker() {
  const title = document.getElementById('sb-ship-picker-title');
  if (title) title.textContent = sbMode === 'outfit' ? 'Choose a Ship to Outfit' : 'Choose a Ship to Edit';

  const list = document.getElementById('sb-ship-picker-list');
  const byPlugin = {};
  for (const s of sbAllShips) {
    const key = s._pd || s._pn || 'Unknown';
    (byPlugin[key] = byPlugin[key] || []).push(s);
  }

  list.innerHTML = Object.entries(byPlugin).map(([plugin, ships]) => `
    <div class="sb-picker-group">
      <div class="sb-picker-group-label">${esc(plugin)}</div>
      ${ships.map(s => {
        const cat = (s.attributes && s.attributes.category) || '';
        const varTag = s._isVariant ? ' <em style="font-size:0.78em;color:var(--c-text-dim)">(variant)</em>' : '';
        const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(s))));
        return `<div class="sb-picker-row" onclick="sbPickShip('${encoded}')">
          <span class="sb-picker-name">${window.ShipNames ? ShipNames.html(s) : esc(s.name || 'Unknown')}${varTag}</span>
          <span class="sb-picker-meta">${esc(cat)}</span>
        </div>`;
      }).join('')}
    </div>`).join('');

  document.getElementById('sb-ship-picker-search').value = '';
  openModal('modal-sb-ship-picker');
}

/** What players see for a game ship's internal name (its display name, if it has one). */
function sbShipLabel(name) {
  const ship = sbAllShips.find(x => x.name === name);
  return ship && window.ShipNames ? ShipNames.label(ship) : name;
}

function sbFilterShipPicker(val) {
  const q = val.toLowerCase();
  document.querySelectorAll('#sb-ship-picker-list .sb-picker-row').forEach(r => {
    r.style.display = r.querySelector('.sb-picker-name').textContent.toLowerCase().includes(q) ? '' : 'none';
  });
  document.querySelectorAll('#sb-ship-picker-list .sb-picker-group').forEach(g => {
    g.style.display = [...g.querySelectorAll('.sb-picker-row')].some(r => r.style.display !== 'none') ? '' : 'none';
  });
}

// ═══════════════════════════════════════════════════════════
//  SHARE LINKS — a ship inside a link (no account, nothing saved online)
//  Only what differs from the game ship it's based on goes in the link,
//  so most links stay short enough for Discord.
// ═══════════════════════════════════════════════════════════
function sbCompactDesign(s) {
  const src = s._sourceShip ? sbAllShips.find(x => x.name === s._sourceShip) : null;
  const base = src ? sbShipFromParsed(src) : sbBlank();
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const out = { src: s._sourceShip || null, o: (s.outfits || []).map(o => [o.name, o.count || 1]) };
  const diff = {};
  for (const k of Object.keys(s)) {
    if (['id', 'attributes', 'outfits', '_sourcePlugin', 'customName', '_fromSave', '_uuid'].includes(k) || k.startsWith('_')) continue;
    if (!same(s[k], base[k])) diff[k] = s[k];
  }
  const ad = {};
  const keys = new Set([...Object.keys(s.attributes || {}), ...Object.keys(base.attributes || {})]);
  for (const k of keys) if (!same((s.attributes || {})[k], (base.attributes || {})[k])) ad[k] = (s.attributes || {})[k] ?? null;
  if (Object.keys(diff).length) out.d = diff;
  if (Object.keys(ad).length) out.a = ad;
  return out;
}
function sbExpandDesign(c) {
  const src = c.src ? sbAllShips.find(x => x.name === c.src) : null;
  const s = src ? sbShipFromParsed(src) : sbBlank();
  Object.assign(s, c.d || {});
  for (const [k, v] of Object.entries(c.a || {})) { if (v === null) delete s.attributes[k]; else s.attributes[k] = v; }
  s.outfits = (c.o || []).map(([name, count]) => ({ name, count }));
  s.id = Date.now() + Math.random();
  return { ship: s, missingHull: !!(c.src && !src) };
}
async function sbShareShip(design, what = 'this ship') {
  if (!window.ShareLinks) return;
  const url = await ShareLinks.make('shipBuilder.html', 'ship', { ship: sbCompactDesign(design) });
  ShareLinks.show(url, what);
}
function sbShareCurrent() { onBuilderChange(); sbShareShip(sbCurrentShip, `“${sbCurrentShip.name || 'this ship'}”`); }
function sbShareFleetShip(i) { const s = sbFleet[i]; if (s) sbShareShip(s, `“${s.name || 'this ship'}”`); }
// Opening a shared link: show the ship as a new, unsaved design
async function sbOpenSharedShip() {
  if (!window.ShareLinks || !/[#&]ship=/.test(location.hash)) return;
  const data = await ShareLinks.read('ship');
  ShareLinks.clear();
  if (!data || data._broken || !data.ship) { sbToast('That share link is damaged or incomplete.', 'danger'); return; }
  sbRefreshLiveData();
  const { ship, missingHull } = sbExpandDesign(data.ship);
  sbMode = 'edit'; sbEditMode = 'built'; sbEditIdx = -1; sbSaveEditIdx = -1;
  sbCurrentShip = ship;
  sbPopulateBuilder();
  showBuilderView();
  sbToast(missingHull
    ? `Shared ship opened — but its hull “${data.ship.src}” isn't in your selected plugins, so some stats are missing.`
    : 'Shared ship opened — 💾 Save Ship to keep it in your fleet.', missingHull ? 'danger' : 'success');
}
window.sbShareShip = sbShareShip; window.sbShareCurrent = sbShareCurrent; window.sbShareFleetShip = sbShareFleetShip;
window.sbCompactDesign = sbCompactDesign; window.sbExpandDesign = sbExpandDesign;
document.addEventListener('DOMContentLoaded', () => {
  if (window.DataLoader) window.DataLoader.onReady(() => setTimeout(sbOpenSharedShip, 150));
});

function sbPickShip(encoded) {
  closeModal('modal-sb-ship-picker');
  const src = JSON.parse(decodeURIComponent(escape(atob(encoded))));
  sbCurrentShip = sbShipFromParsed(src);
  sbEditIdx = -1; sbSaveEditIdx = -1; sbEditMode = 'built';
  sbPopulateBuilder();
  showBuilderView();
  if (sbMode === 'outfit') sbSwitchTab('outfits');
}

function sbShipFromParsed(src) {
  const s = sbBlank();
  s.name        = src.name        || '';
  s.variant     = src.variant     || '';
  s.plural      = src.plural      || '';
  s.sprite      = src.sprite      || '';
  s.thumbnail   = src.thumbnail   || '';
  s.description = src.description || '';
  s._sourceShip   = src.name || null;
  s._sourcePlugin = src._pn  || null;

  if (src.attributes && typeof src.attributes === 'object') {
    for (const [k, v] of Object.entries(src.attributes)) {
      if (k === 'mass' || k === 'drag') continue;
      if (k === 'weapon') continue;
      if (k === 'licenses' && typeof v === 'object') { s.attributes[k] = v; }
      else if (typeof v !== 'object') { s.attributes[k] = String(v); }
    }
  }

  const weaponSrc = src.attributes?.weapon || src.weapon || null;
  if (weaponSrc && typeof weaponSrc === 'object') {
    s.weapon = {
      'blast radius':  Number(weaponSrc['blast radius']  ?? 0) || 0,
      'shield damage': Number(weaponSrc['shield damage'] ?? 0) || 0,
      'hull damage':   Number(weaponSrc['hull damage']   ?? 0) || 0,
      'hit force':     Number(weaponSrc['hit force']     ?? 0) || 0,
    };
  }

  const rawMass = src.mass ?? src.attributes?.mass;
  const rawDrag = src.drag ?? src.attributes?.drag;
  if (rawMass != null && rawMass !== '') s.mass = String(rawMass);
  if (rawDrag != null && rawDrag !== '') s.drag = String(rawDrag);

  // NEW (internal-ID pass): thread `internalId` through from whichever
  // source shape the ship's outfits came in as, deriving it from
  // pluginId+name when the source predates the internalId field.
  const sourcePluginId = src._pn || src._pluginName || null;
  const outfitSource = src.outfits || src.outfitMap;
  if (outfitSource && typeof outfitSource === 'object' && !Array.isArray(outfitSource)) {
    for (const [n, val] of Object.entries(outfitSource)) {
      const cleanName = n.replace(/^"([^"]*)"$/, '$1');
      const count    = typeof val === 'object' ? (parseInt(val.count) || 1) : (Number(val) || 1);
      const pluginId = (typeof val === 'object' && val.pluginId) ? val.pluginId : sourcePluginId;
      const internalId = (typeof val === 'object' && val.internalId)
        ? val.internalId
        : (pluginId ? `${pluginId}::${cleanName}` : null);
      s.outfits.push({ name: cleanName, count, pluginId, internalId });
    }
  } else if (Array.isArray(outfitSource)) {
    for (const o of outfitSource) {
      const cleanName = (o.name || '').replace(/^"([^"]*)"$/, '$1');
      const pluginId  = o.pluginId || sourcePluginId;
      const internalId = o.internalId || (pluginId ? `${pluginId}::${cleanName}` : null);
      s.outfits.push({ name: cleanName, count: parseInt(o.count) || 1, pluginId, internalId });
    }
  }

  for (const g of (src.guns || [])) {
    const over  = g.gun || g.over || g.weapon || '';
    const attrs = _sbParsedHardpointToAttrs(g, ['x','y','gun','over','weapon']);
    s.guns.push({ coords: [g.x, g.y].filter(v => v != null).join(' ') || '0 0', over, attrs: Object.keys(attrs).length ? attrs : undefined });
  }
  for (const g of (src.turrets || [])) {
    const over  = g.turret || g.over || g.weapon || '';
    const attrs = _sbParsedHardpointToAttrs(g, ['x','y','turret','over','weapon']);
    s.turrets.push({ coords: [g.x, g.y].filter(v => v != null).join(' ') || '0 0', over, attrs: Object.keys(attrs).length ? attrs : undefined });
  }
  for (const e of (src.engines || [])) {
    const attrs = _sbParsedHardpointToAttrs(e, ['x','y']);
    s.engines.push({ coords: [e.x, e.y].filter(v => v != null).join(' ') || '0 0', type: 'engine', attrs: Object.keys(attrs).length ? attrs : undefined });
  }
  for (const e of (src.reverseEngines || [])) {
    const attrs = _sbParsedHardpointToAttrs(e, ['x','y']);
    s.engines.push({ coords: [e.x, e.y].filter(v => v != null).join(' ') || '0 0', type: 'reverse', attrs: Object.keys(attrs).length ? attrs : undefined });
  }
  for (const e of (src.steeringEngines || [])) {
    const attrs = _sbParsedHardpointToAttrs(e, ['x','y']);
    s.engines.push({ coords: [e.x, e.y].filter(v => v != null).join(' ') || '0 0', type: 'steering', attrs: Object.keys(attrs).length ? attrs : undefined });
  }
  for (const b of (src.bays || [])) {
    const coords = [b.x, b.y].filter(v => v != null).join(' ') || '0 0';
    const launchEffect = b['launch effect'] || '';
    const position = b.position || '';
    const attrs = _sbParsedHardpointToAttrs(b, ['x','y','type','category','launch effect','position']);
    const bayObj = { coords, launchEffect, position, attrs: Object.keys(attrs).length ? attrs : undefined };
    if (b.type === 'Fighter' || b.category === 'fighter') s.fighters.push(bayObj);
    else if (b.type === 'Drone' || b.category === 'drone') s.drones.push(bayObj);
  }
  for (const l of (src.leaks || [])) s.leaks.push(_sbNormaliseLeak(l));

  const explodeSrc = src.explode || [];
  for (const e of explodeSrc) s.explode.push({ name: typeof e === 'string' ? e : (e.name || 'tiny explosion'), count: e.count || 1 });
  for (const key of ['tiny explosion','small explosion','medium explosion','large explosion','huge explosion']) {
    if (src[key] != null) s.explode.push({ name: key, count: Number(src[key]) });
  }

  const finalSrc = src.finalExplode || src['final explode'] || [];
  if (typeof finalSrc === 'string') {
    s.finalExplode.push({ name: finalSrc.replace(/^"([^"]*)"$/, '$1'), count: 1 });
  } else {
    for (const e of (Array.isArray(finalSrc) ? finalSrc : [])) {
      s.finalExplode.push({ name: typeof e === 'string' ? e.replace(/^"([^"]*)"$/, '$1') : (e.name || 'final explosion large'), count: e.count || 1 });
    }
  }

  sbAutoSlotAllOutfits(s);
  return s;
}

// ─────────────────────────────────────────────────────────
//  Converts a parser.js-shaped hardpoint object (which uses
//  "arc": {arc_1:-90, arc_2:50} for multi-number lines, and
//  "under" / "under_2" for repeated-key occurrences — see
//  PARSER_DOCUMENTATION.md §5.2-§5.4) into our internal
//  { key: [occurrence, occurrence, ...] } shape, where each
//  occurrence is `true` (bare flag) or an array of values.
// ─────────────────────────────────────────────────────────
function _sbParsedHardpointToAttrs(obj, excludeKeys) {
  const attrs = {};
  if (!obj || typeof obj !== 'object') return attrs;
  const exSet = new Set(excludeKeys || []);
  const baseOccurrences = {}; // base key -> { occurrenceIndex: rawValue }

  for (const [k, v] of Object.entries(obj)) {
    if (exSet.has(k)) continue;
    const m = k.match(/^(.*)_(\d+)$/);
    if (m && Object.prototype.hasOwnProperty.call(obj, m[1]) && !exSet.has(m[1])) {
      // Repeated occurrence of an already-seen base key (e.g. "under_2", "zoom_2")
      const base = m[1];
      const n    = parseInt(m[2], 10);
      baseOccurrences[base] = baseOccurrences[base] || {};
      baseOccurrences[base][n] = v;
      continue;
    }
    baseOccurrences[k] = baseOccurrences[k] || {};
    baseOccurrences[k][1] = v;
  }

  for (const [base, occMap] of Object.entries(baseOccurrences)) {
    const indices = Object.keys(occMap).map(Number).sort((a, b) => a - b);
    attrs[base] = indices.map(idx => {
      const val = occMap[idx];
      if (val === true) return true;
      if (val && typeof val === 'object') {
        // Nested multi-value object for a single line, e.g. {arc_1:-90, arc_2:50}
        return Object.entries(val)
          .sort((a, b) => {
            const na = parseInt((a[0].match(/_(\d+)$/) || [])[1]) || 0;
            const nb = parseInt((b[0].match(/_(\d+)$/) || [])[1]) || 0;
            return na - nb;
          })
          .map(([, vv]) => vv);
      }
      return [val];
    });
  }
  return attrs;
}

// ═══════════════════════════════════════════════════════════
//  BUILDER POPULATE
// ═══════════════════════════════════════════════════════════
function sbPopulateBuilder() {
  const s = sbCurrentShip;
  const modeLabel = { new: '✏️ New Ship', edit: '✏️ Edit Ship', outfit: '🔧 Outfit Ship' }[sbMode] || '';
  const titleEl = document.getElementById('builder-page-title');
  if (titleEl) titleEl.textContent = s.name ? `${modeLabel}: ${s.customName || s.name}` : modeLabel;

  const subtitleEl = document.getElementById('builder-page-subtitle');
  if (subtitleEl) subtitleEl.textContent = {
    new:    'Define your ship from scratch.',
    edit:   sbEditMode === 'save' ? 'Editing a ship from your save file.' : 'Edit attributes, metadata, and hardpoints.',
    outfit: 'Manage outfits on this ship.',
  }[sbMode] || '';

  // Show a banner when editing a save ship
  const saveBanner = document.getElementById('sb-save-edit-banner');
  if (saveBanner) {
    saveBanner.style.display = (sbMode === 'edit' && sbEditMode === 'save') ? '' : 'none';
  }

  const idSide = document.getElementById('sidebar-identity');
  const deSide = document.getElementById('sidebar-description');
  if (idSide) idSide.style.display = sbMode === 'outfit' ? 'none' : '';
  if (deSide) deSide.style.display = sbMode === 'outfit' ? 'none' : '';

  const badge = document.getElementById('sb-mode-badge');
  if (badge) {
    badge.className = 'badge ' + ({ new:'badge-blue', edit:'badge-green', outfit:'badge-purple' }[sbMode] || 'badge-blue');
    badge.textContent = sbMode.toUpperCase();
    badge.style.display = '';
  }

  document.getElementById('ship-name').value        = s.name        || '';
  document.getElementById('ship-variant').value     = s.variant     || '';
  document.getElementById('ship-plural').value      = s.plural      || '';
  document.getElementById('ship-sprite').value      = s.sprite      || '';
  document.getElementById('ship-thumbnail').value   = s.thumbnail   || '';
  document.getElementById('ship-description').value = s.description || '';
  sbRenderAttrList();
  sbRenderOutfitsList();
  sbRenderGunsTurrets();
  sbRenderExplodeLists();
  sbRenderWeaponBlock();
  sbRawDirty = false;
  sbRenderRaw();
  sbUpdateQuickStats();
  sbSwitchTab(sbMode === 'outfit' ? 'outfits' : 'attributes');
}

function onBuilderChange() {
  if (!sbCurrentShip) return;
  const s = sbCurrentShip;
  s.name        = document.getElementById('ship-name').value.trim();
  s.variant     = document.getElementById('ship-variant').value.trim();
  s.plural      = document.getElementById('ship-plural').value.trim();
  s.sprite      = document.getElementById('ship-sprite').value.trim();
  s.thumbnail   = document.getElementById('ship-thumbnail').value.trim();
  s.description = document.getElementById('ship-description').value;
  const titleEl = document.getElementById('builder-page-title');
  const modeLabel = { new: '✏️ New Ship', edit: '✏️ Edit Ship', outfit: '🔧 Outfit Ship' }[sbMode] || '';
  if (titleEl) titleEl.textContent = s.name ? `${modeLabel}: ${s.customName || s.name}` : modeLabel;
  sbUpdateQuickStats();
  sbRenderRaw();
}

// ═══════════════════════════════════════════════════════════
//  SAVE SHIP — routes to correct store based on sbEditMode
// ═══════════════════════════════════════════════════════════
function saveShip() {
  onBuilderChange();
  if (!sbCurrentShip.name) {
    sbToast('Ship must have a name.', 'danger');
    document.getElementById('ship-name').focus();
    return;
  }

  if (sbEditMode === 'save') {
    // Write back into sbSaveFleet and ES_SM_ACTIVE_SAVE_SHIPS
    const copy = JSON.parse(JSON.stringify(sbCurrentShip));
    copy._fromSave = true;
    if (sbSaveEditIdx === -1) {
      sbSaveFleet.push(copy);
      sbSaveEditIdx = sbSaveFleet.length - 1;
    } else {
      sbSaveFleet[sbSaveEditIdx] = copy;
    }
    sbSaveSaveShips();
    const titleEl = document.getElementById('builder-page-title');
    if (titleEl) titleEl.textContent = `✏️ Editing: ${sbCurrentShip.customName || sbCurrentShip.name}`;
    sbToast('Save ship updated!', 'success');
  } else {
    // Write into sbFleet and es_ship_builder_v4
    const copy = JSON.parse(JSON.stringify(sbCurrentShip));
    if (sbEditIdx === -1) {
      sbFleet.push(copy);
      sbEditIdx = sbFleet.length - 1;
    } else {
      sbFleet[sbEditIdx] = copy;
    }
    sbSave();
    if (window.DataLoader && window.DataLoader.refreshLocalBuilds) {
      window.DataLoader.refreshLocalBuilds();
    }
    const titleEl = document.getElementById('builder-page-title');
    if (titleEl) titleEl.textContent = `✏️ Editing: ${sbCurrentShip.name}`;
    sbToast('Ship saved!', 'success');
  }
}

// ═══════════════════════════════════════════════════════════
//  CAPACITY TRACKING
// ═══════════════════════════════════════════════════════════

// Capacity attributes come from the parser (gameKeys.js → Ship::FinishLoading's
// "can't be negative" list); this is only the fallback before attrDefs loads.
const SB_CAPACITY_FALLBACK = ['outfit space', 'engine capacity', 'weapon capacity', 'cargo space'];
function sbCapacityKeys() {
  return window.GameKeys ? window.GameKeys.capacityKeys(SB_CAPACITY_FALLBACK) : SB_CAPACITY_FALLBACK;
}
const sbTitleCase = k => String(k).replace(/\b\w/g, c => c.toUpperCase());

// ── NEW (internal-ID pass) ──────────────────────────────────────────────
// _sbOutfitLookup is now TWO maps in one object:
//   byId[internalId]   → exact-plugin match, no collision risk at all.
//   byName[name]        → first-loaded fallback bucket, used ONLY when no
//                          pluginId/internalId is known for the outfit
//                          being looked up (e.g. free-typed outfit names).
// Previously this was a single flat `{ name: outfit }` map that silently
// overwrote same-named outfits from different plugins — the exact
// collision class this pass exists to close.
let _sbOutfitLookup = null;
function sbGetOutfitLookup() {
  if (_sbOutfitLookup) return _sbOutfitLookup;
  const byId = {};
  const byName = {};
  for (const o of sbAllOutfits) {
    const name = (o.name || o.displayName || '').trim().replace(/^"([^"]*)"$/, '$1');
    if (!name) continue;
    const pluginId = o._pn || o._pluginId || null;
    const internalId = o.internalId || o._internalId || (pluginId ? `${pluginId}::${name}` : null);
    if (internalId) byId[internalId] = o;
    if (!(name in byName)) byName[name] = o; // first plugin loaded wins, same as before this pass
  }
  _sbOutfitLookup = { byId, byName };
  return _sbOutfitLookup;
}

/**
 * Look up an outfit by name, preferring an exact `pluginId::name` match
 * when `pluginId` is provided. Falls back to the old ambiguous name-only
 * lookup only when no pluginId is known — e.g. an outfit typed manually
 * into the free-text "Add Outfit" dialog, which was never attached to a
 * specific plugin in the first place.
 */
function sbFindOutfit(outfitName, pluginId) {
  const lookup = sbGetOutfitLookup();
  const cleanName = outfitName.replace(/^"([^"]*)"$/, '$1');
  if (pluginId) {
    const hit = lookup.byId[`${pluginId}::${cleanName}`];
    if (hit) return hit;
  }
  return lookup.byName[cleanName] || null;
}

function sbGetOutfitAttrValue(outfitName, attrKey, pluginId) {
  const o = sbFindOutfit(outfitName, pluginId);
  if (!o) return 0;
  let val = (o.attributes && o.attributes[attrKey] != null) ? o.attributes[attrKey] : o[attrKey];
  if (val == null) return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

function sbGetOutfitCapacityEffect(outfitName, capacityKey, pluginId) { return sbGetOutfitAttrValue(outfitName, capacityKey, pluginId); }

function sbUsedCapacity(capacityKey) {
  if (!sbCurrentShip) return 0;
  const net = (sbCurrentShip.outfits || []).reduce((total, o) => {
    const effect = sbGetOutfitCapacityEffect(o.name, capacityKey, o.pluginId);
    return total + (-(effect)) * (parseInt(o.count) || 1);
  }, 0);
  return Math.max(0, net);
}

function sbUsedOutfitSpace()    { return sbUsedCapacity('outfit space'); }
function sbUsedEngineCapacity() { return sbUsedCapacity('engine capacity'); }
function sbUsedWeaponCapacity() { return sbUsedCapacity('weapon capacity'); }
function sbUsedCargoSpace()     { return sbUsedCapacity('cargo space'); }

function sbShipCapacity(key) { return Number((sbCurrentShip?.attributes || {})[key]) || 0; }
function sbMaxOutfitSpace()    { return sbShipCapacity('outfit space'); }
function sbMaxEngineCapacity() { return sbShipCapacity('engine capacity'); }
function sbMaxWeaponCapacity() { return sbShipCapacity('weapon capacity'); }
function sbMaxCargoSpace()     { return sbShipCapacity('cargo space'); }

function sbCapacityBarHTML(label, used, max) {
  if (max <= 0) return '';
  const remaining = max - used;
  const pct       = Math.min(100, Math.round(used / max * 100));
  const over      = used > max;
  const barColor  = over ? 'var(--c-danger-hi)' : pct > 90 ? '#f59e0b' : 'var(--c-accent)';
  const textColor = over ? 'var(--c-danger-hi)' : pct > 90 ? 'var(--c-warn-text)' : 'var(--c-accent-text)';
  return `
    <div class="sb-cap-bar" style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
        <span style="font-size:0.72rem;font-weight:700;color:#63b3ed;text-transform:uppercase;letter-spacing:.1em;">${label}</span>
        <span style="font-size:0.82rem;font-weight:700;color:${textColor};font-variant-numeric:tabular-nums;">
          ${used} / ${max}
          <span style="font-size:0.72rem;color:var(--c-text-dim);font-weight:400;margin-left:4px;">
            ${remaining >= 0 ? remaining + ' free' : Math.abs(remaining) + ' over'}${over ? ' ⚠' : ''}
          </span>
        </span>
      </div>
      <div class="sb-space-bar-track">
        <div class="sb-space-bar-fill" style="width:${pct}%;background:${barColor};"></div>
      </div>
    </div>`;
}

function sbRenderOutfitSpaceBar() {
  const el = document.getElementById('outfit-space-bar-wrap');
  if (!el || !sbCurrentShip) return;
  const bars = sbCapacityKeys()
    .map(key => ({ label: sbTitleCase(key), used: sbUsedCapacity(key), max: sbShipCapacity(key) }))
    .filter(b => b.max > 0);
  if (!bars.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = bars.map(b => sbCapacityBarHTML(b.label, b.used, b.max)).join('');
}

// ═══════════════════════════════════════════════════════════
//  ATTRIBUTE VALIDATION
// ═══════════════════════════════════════════════════════════

const SB_SIGNED_ATTRS = new Set([
  'shield protection','hull protection','energy protection','fuel protection',
  'heat protection','force protection','piercing protection',
  'shield permeability','high shield permeability','low shield permeability',
  'cloaked shield permeability',
  'shield damage','hull damage','energy damage','fuel damage','heat damage',
  'ion damage','scrambling damage','slowing damage','disruption damage',
  'discharge damage','corrosion damage','burn damage','leak damage',
  'relative shield damage','relative hull damage','relative energy damage',
  'relative fuel damage','relative heat damage','relative minable damage',
  '% shield damage','% hull damage','% energy damage','% fuel damage',
  '% heat damage','% minable damage',
  'firing energy','firing fuel','firing heat','firing shields','firing hull',
  'relative firing energy','relative firing fuel','relative firing heat',
  'relative firing shields','relative firing hull',
  'outfit space','engine capacity','weapon capacity','cargo space',
  'gun ports','turret mounts',
  'drag reduction','inertia reduction','acceleration multiplier',
  'turn multiplier','hull multiplier','shield multiplier',
  'hull repair multiplier','shield generation multiplier',
  'mass','drag',
]);

function sbValidateAttrValue(key, rawValue) {
  const v = parseFloat(rawValue);
  if (isNaN(v)) return { ok: true };
  if (SB_SIGNED_ATTRS.has(key)) return { ok: true };
  if (v < 0) return { ok: false, message: `"${key}" cannot be negative. Use a value ≥ 0.` };
  return { ok: true };
}

const SB_HARDPOINT_KEYS = {
  'gun ports':     { field: 'guns',    label: 'gun' },
  'turret mounts': { field: 'turrets', label: 'turret' },
};

function sbSyncHardpoints(key, newVal) {
  const hp = SB_HARDPOINT_KEYS[key];
  if (!hp) return false;
  const target  = parseInt(newVal) || 0;
  const current = (sbCurrentShip[hp.field] || []).length;
  if (target > current) {
    const toAdd = target - current;
    sbCurrentShip[hp.field] = sbCurrentShip[hp.field] || [];
    for (let i = 0; i < toAdd; i++) sbCurrentShip[hp.field].push({ coords: '0 0', over: '' });
    sbToast(`Added ${toAdd} ${hp.label} port${toAdd > 1 ? 's' : ''} at 0 0 — set coordinates in Guns & Turrets tab`, 'success');
    sbRenderGunsTurrets();
    return true;
  }
  return false;
}

function sbAutoSlotWeapons(outfitName, count, outfitObj) {
  if (!outfitObj) return;
  const gunCost    = _sbGetPortCost(outfitObj, 'gun ports');
  const turretCost = _sbGetPortCost(outfitObj, 'turret mounts');
  if (gunCost    > 0) _sbFillEmptyPorts(sbCurrentShip.guns,    outfitName, gunCost * count);
  if (turretCost > 0) _sbFillEmptyPorts(sbCurrentShip.turrets, outfitName, turretCost * count);
}

function _sbGetPortCost(outfitObj, portKey) {
  let val = (outfitObj.attributes && outfitObj.attributes[portKey] != null)
    ? outfitObj.attributes[portKey] : outfitObj[portKey];
  if (val == null) return 0;
  const n = Number(val);
  return n < 0 ? Math.abs(n) : 0;
}

function _sbFillEmptyPorts(hardpoints, outfitName, needed) {
  if (!hardpoints || needed <= 0) return;
  const clean = outfitName.replace(/^"([^"]*)"$/, '$1');
  let filled = 0;
  for (const hp of hardpoints) {
    if (filled >= needed) break;
    if (!hp.over || hp.over.trim() === '') { hp.over = clean; filled++; }
  }
}

function sbUpdateAttrVal(inp) {
  const key = inp.dataset.key;
  const val = inp.value;
  const check = sbValidateAttrValue(key, val);
  if (!check.ok) {
    sbToast(check.message, 'danger');
    if (key === 'mass') inp.value = String(sbCurrentShip.mass ?? '');
    else if (key === 'drag') inp.value = String(sbCurrentShip.drag ?? '');
    else inp.value = String(sbCurrentShip.attributes[key] ?? '');
    inp.style.borderColor = 'var(--c-danger-hi)';
    setTimeout(() => { inp.style.borderColor = ''; }, 1500);
    return;
  }
  inp.style.borderColor = '';
  if (key === 'mass') { sbCurrentShip.mass = val; }
  else if (key === 'drag') { sbCurrentShip.drag = val; }
  else { sbCurrentShip.attributes[key] = val; const changed = sbSyncHardpoints(key, val); if (changed) sbRenderAttrList(); }
  sbUpdateQuickStats();
  sbRenderOutfitSpaceBar();
  sbRenderRaw();
}

function sbRemoveAttr(k) {
  if (k === 'mass') sbCurrentShip.mass = '';
  else if (k === 'drag') sbCurrentShip.drag = '';
  else delete sbCurrentShip.attributes[k];
  sbRenderAttrList(); sbUpdateQuickStats(); sbRenderRaw();
}

function sbUpdateQuickStats() {
  const el = document.getElementById('quick-stats');
  if (!el || !sbCurrentShip) return;
  const s = sbCurrentShip;
  const a = s.attributes || {};

  const oUsed = sbUsedOutfitSpace(),    oMax = sbMaxOutfitSpace();
  const eUsed = sbUsedEngineCapacity(), eMax = sbMaxEngineCapacity();
  const wUsed = sbUsedWeaponCapacity(), wMax = sbMaxWeaponCapacity();
  const cUsed = sbUsedCargoSpace(),     cMax = sbMaxCargoSpace();

  function capVal(used, max) {
    if (max <= 0) return '—';
    const over  = used > max;
    const color = over ? 'var(--c-danger-hi)' : 'var(--c-accent-text)';
    return `<span style="color:${color}">${used}/${max}</span>`;
  }

  const qs = [
    { label: 'Shields',      value: a.shields         || '—' },
    { label: 'Hull',         value: a.hull            || '—' },
    { label: 'Mass',         value: s.mass || a.mass  || '—' },
    { label: 'Outfit Space', value: capVal(oUsed, oMax) },
    { label: 'Engine Cap.',  value: capVal(eUsed, eMax) },
    { label: 'Weapon Cap.',  value: capVal(wUsed, wMax) },
    { label: 'Cargo Space',  value: capVal(cUsed, cMax) },
    { label: 'Guns',         value: (s.guns     || []).length },
    { label: 'Turrets',      value: (s.turrets  || []).length },
    { label: 'Drones',       value: (s.drones   || []).length },
    { label: 'Fighters',     value: (s.fighters || []).length },
    { label: 'Engines',      value: (s.engines  || []).length },
  ];

  el.innerHTML = qs.map(q =>
    `<div class="qs-card"><div class="qs-label">${q.label}</div><div class="qs-value">${q.value}</div></div>`
  ).join('');

  sbRenderOutfitSpaceBar();

  // ── How this calls into ComputedStats ─────────────────────────────────
  // getComputedStats() (defined in ComputedStats.js — not included in this
  // pass) takes the WHOLE ship object plus a pluginId string, then does
  // its own internal outfit resolution against window.allData for every
  // outfit on the ship. It is NOT given per-outfit pluginId/internalId
  // here — only sbCurrentShip and one plugin id (LOCAL_ID, the synthetic
  // "local builds" plugin, not each individual outfit's real owning
  // plugin). That means ComputedStats' own outfit resolution is a
  // SEPARATE code path from sbFindOutfit/sbGetOutfitLookup above, and is
  // NOT covered by this pass's internalId fix — it can only be fixed
  // inside ComputedStats.js itself, which wasn't provided. If
  // ComputedStats.js resolves outfits by name only (the same pattern this
  // pass just fixed here), it has the same collision exposure and should
  // get the equivalent fix: accept per-entry pluginId/internalId from
  // sbCurrentShip.outfits (already present as of this pass) instead of
  // re-deriving a name-only lookup internally.
  if (typeof getComputedStats === 'function' && sbCurrentShip) {
    const LOCAL_ID = window.DataLoader?.LOCAL_PLUGIN_ID || '__local_builds__';
    const computed = getComputedStats(sbCurrentShip, LOCAL_ID);
    const statsEl  = document.getElementById('computed-stats-panel');
    if (statsEl && computed) {
      const fnKeys = Object.keys(computed).filter(k => k.startsWith('_fn_'));
      if (fnKeys.length) {
        statsEl.innerHTML = fnKeys.map(k => {
          const fnName = k.slice(4);
          const fnData = window.attrDefs?.shipFunctions?.[fnName];
          const scale  = fnData?.displayScale ?? 1;
          const unit   = fnData?.displayUnit  ?? '';
          const val    = (computed[k] * scale).toFixed(2);
          const label  = fnName.replace(/([A-Z])/g, ' $1').trim();
          return `<div class="qs-card"><div class="qs-label">${label}</div><div class="qs-value">${val}${unit ? ' ' + unit : ''}</div></div>`;
        }).join('');
      }
    }
  }
}

// ── Tabs ──────────────────────────────────────────────────
function sbSwitchTab(name) {
  document.querySelectorAll('.builder-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.builder-tab-content').forEach(t => t.classList.remove('active'));
  const btn = document.querySelector(`.builder-tab[data-tab="${name}"]`);
  const cnt = document.getElementById(`tab-${name}`);
  if (btn) btn.classList.add('active');
  if (cnt) cnt.classList.add('active');
  if (name === 'raw') sbRenderRaw();
}
function initBuilderTabs() {
  document.querySelectorAll('.builder-tab').forEach(btn => {
    btn.addEventListener('click', () => sbSwitchTab(btn.dataset.tab));
  });
}

// ═══════════════════════════════════════════════════════════
//  ATTRIBUTES
// ═══════════════════════════════════════════════════════════
const SB_ATTR_GROUPS = {
  'Identity':  ['category','mass','drag','required crew','bunks','cargo space','fuel capacity','cost'],
  'Combat':    ['shields','hull','hull repair rate','shield generation','shield energy','hull energy','hull heat','heat dissipation','energy capacity'],
  'Movement':  ['thrust','thrusting energy','thrusting heat','turn','turning energy','turning heat','reverse thrust','reverse thrusting energy','reverse thrusting heat','afterburner thrust','afterburner fuel','afterburner heat','afterburner energy'],
  'Power':     ['energy generation','energy consumption','solar collection','ramscoop','fuel generation','fuel consumption'],
  'Capacity':  ['engine capacity','weapon capacity','outfit space','gun ports','turret mounts'],
  'Drives':    ['hyperdrive','jump drive','jump fuel','jump range','scram drive'],
  'Cloaking':  ['cloak','cloaking energy','cloaking fuel','cloaking heat'],
};

// Groups for the attribute list. With attrDefs loaded, every attribute is
// placed by AttributeSections.classify() — the same parser-driven sections
// the Data Viewer and stats panels use — so new attributes from game updates
// land in the right group automatically. SB_ATTR_GROUPS is the fallback.
function sbAttrGroups(keys) {
  const AS = window.AttributeSections;
  if (!AS || !window.attrDefs || !window.attrDefs.attributes) return SB_ATTR_GROUPS;
  const groups = {};
  for (const k of keys.filter(k => k !== 'weapon')) {
    let section = k === 'category' || k === 'mass' || k === 'drag' || k === 'cost' ? 'General' : AS.classify(window.attrDefs, k);
    if (!section) section = 'Other';
    (groups[section] = groups[section] || []).push(k);
  }
  const ordered = {};
  for (const name of AS.orderSections(Object.keys(groups))) ordered[name] = groups[name].sort();
  return ordered;
}

function sbRenderAttrList() {
  const el = document.getElementById('attr-list');
  if (!el || !sbCurrentShip) return;
  const s     = sbCurrentShip;
  const attrs = s.attributes || {};

  const syntheticAttrs = { ...attrs };
  if (s.mass && s.mass !== '') syntheticAttrs['mass'] = s.mass;
  if (s.drag && s.drag !== '') syntheticAttrs['drag'] = s.drag;

  const allKeys = Object.keys(syntheticAttrs);
  if (!allKeys.length) {
    el.innerHTML = '<div style="color:var(--c-text-muted);font-size:0.88rem;font-style:italic;padding:10px 0;">No attributes. Click "+ Add Attribute" to add one.</div>';
    return;
  }

  const assigned = new Set();
  let html = '';
  for (const [group, gkeys] of Object.entries(sbAttrGroups(allKeys))) {
    const present = gkeys.filter(k => k in syntheticAttrs);
    if (!present.length) continue;
    html += `<div class="attr-section"><div class="attr-section-title">${group}</div>`;
    for (const k of present) {
      assigned.add(k);
      const v = (k === 'mass') ? s.mass : (k === 'drag') ? s.drag : attrs[k];
      html += sbAttrRow(k, v);
    }
    html += '</div>';
  }

  const other = allKeys.filter(k => !assigned.has(k) && k !== 'mass' && k !== 'drag' && k !== 'weapon');
  if (other.length) {
    html += '<div class="attr-section"><div class="attr-section-title">Other</div>';
    for (const k of other) html += sbAttrRow(k, attrs[k]);
    html += '</div>';
  }
  el.innerHTML = html;
}

function sbAttrRow(k, v) {
  const sk = esc(k), sv = esc(String(v ?? ''));
  const hint = sbAttrHint(k);
  const tip  = hint ? ` title="${esc(hint)}"` : '';
  return `<div class="attr-row">
    <span class="attr-key"${tip}>${sk}</span>
    <input class="attr-val-input" type="text" value="${sv}" data-key="${sk}"
      onchange="sbUpdateAttrVal(this)" onblur="sbUpdateAttrVal(this)">
    <button class="btn btn-danger btn-xs" onclick="sbRemoveAttr('${sk.replace(/'/g,"\\'")}')">✕</button>
  </div>`;
}

function openAddAttr() {
  document.getElementById('new-attr-key').value = '';
  document.getElementById('new-attr-val').value = '';
  document.getElementById('attr-key-ac').classList.remove('open');
  openModal('modal-add-attr');
  setTimeout(() => document.getElementById('new-attr-key').focus(), 80);
}
function confirmAddAttr() {
  const k = document.getElementById('new-attr-key').value.trim();
  const v = document.getElementById('new-attr-val').value.trim();
  if (!k) { sbToast('Please enter a key.', 'danger'); return; }
  const check = sbValidateAttrValue(k, v);
  if (!check.ok) { sbToast(check.message, 'danger'); return; }
  if (k === 'mass') sbCurrentShip.mass = v;
  else if (k === 'drag') sbCurrentShip.drag = v;
  else { sbCurrentShip.attributes[k] = v; sbSyncHardpoints(k, v); }
  closeModal('modal-add-attr');
  sbRenderAttrList(); sbUpdateQuickStats(); sbRenderRaw();
}
function attrKeyAc(val) {
  const ac = document.getElementById('attr-key-ac');
  const matches = sbAttrKeys.filter(k => k.toLowerCase().includes(val.toLowerCase()));
  if (!val || !matches.length) { ac.classList.remove('open'); return; }
  ac.innerHTML = matches.slice(0, 16).map(k => {
    const hint = sbAttrHint(k);
    return `<div class="ac-item" onclick="sbSelectAttrKey('${esc(k).replace(/'/g,"\\'")}')">
      ${esc(k)}${hint ? `<span style="color:var(--c-text-dim);font-size:0.74rem;margin-left:8px;">${esc(hint)}</span>` : ''}
    </div>`;
  }).join('');
  ac.classList.add('open');
}
function sbSelectAttrKey(k) {
  document.getElementById('new-attr-key').value = k;
  document.getElementById('attr-key-ac').classList.remove('open');
  document.getElementById('new-attr-val').focus();
}

// ═══════════════════════════════════════════════════════════
//  OUTFITS
// ═══════════════════════════════════════════════════════════

function sbRenderOutfitsList() {
  const outfits = sbCurrentShip.outfits || [];
  const emptyEl = document.getElementById('outfits-empty');
  if (emptyEl) emptyEl.style.display = outfits.length ? 'none' : 'block';
  const el = document.getElementById('outfits-list');
  if (!el) return;

  el.innerHTML = outfits.map((o, i) => {
    const count   = parseInt(o.count) || 1;
    const rawName = o.name.replace(/^"([^"]*)"$/, '$1');

    const capDefs = [
      { key: 'outfit space',    label: 'sp' },
      { key: 'engine capacity', label: 'eng' },
      { key: 'weapon capacity', label: 'wpn' },
      { key: 'cargo space',     label: 'cargo' },
    ];
    const costTags = capDefs.map(c => {
      const effect = sbGetOutfitCapacityEffect(rawName, c.key, o.pluginId);
      if (effect === 0) return '';
      const total  = Math.abs(effect) * count;
      const isGrant = effect > 0;
      const style  = isGrant ? 'background:rgba(72,187,120,0.15);color:#68d391;border-color:rgba(72,187,120,0.3);' : '';
      const prefix = isGrant ? '+' : '';
      return `<span class="sb-outfit-size" title="${isGrant ? 'grants' : 'uses'} ${c.key}" style="${style}">${prefix}${Math.abs(effect)}${count > 1 ? `×${count}=${prefix}${total}` : ''} ${c.label}</span>`;
    }).filter(Boolean).join('');

    return `<div class="outfit-item">
      <span class="outfit-item__name" title="${esc(rawName)}">${window.OutfitNames ? OutfitNames.html(rawName) : esc(rawName)}</span>
      ${costTags}
      <input class="outfit-item__count" type="number" min="1" value="${esc(String(count))}"
        onchange="sbUpdateOutfitCount(${i},this.value)">
      <button class="btn btn-danger btn-xs" onclick="sbRemoveOutfit(${i})">✕</button>
    </div>`;
  }).join('');

  sbRenderOutfitSpaceBar();
}

function openAddOutfit() {
  sbRefreshLiveData();
  if (sbAllOutfits.length) { sbOpenOutfitPicker(); }
  else {
    document.getElementById('new-outfit-name').value  = '';
    document.getElementById('new-outfit-count').value = '1';
    openModal('modal-add-outfit');
    setTimeout(() => document.getElementById('new-outfit-name').focus(), 80);
  }
}

function confirmAddOutfit() {
  const rawName = document.getElementById('new-outfit-name').value.trim().replace(/^"([^"]*)"$/, '$1');
  const count   = parseInt(document.getElementById('new-outfit-count').value) || 1;
  if (!rawName) { sbToast('Please enter an outfit name.', 'danger'); return; }
  if (!sbCheckOutfitSpace(rawName, count, null)) return;
  // Manually-typed outfit — no plugin context available, so pluginId/internalId
  // stay null and this will always resolve via the ambiguous name-only fallback.
  sbCurrentShip.outfits.push({ name: rawName, count, pluginId: null, internalId: null });
  const outfitObj = sbFindOutfit(rawName, null);
  sbAutoSlotWeapons(rawName, count, outfitObj);
  closeModal('modal-add-outfit');
  sbRenderOutfitsList(); sbRenderGunsTurrets(); sbUpdateQuickStats(); sbRenderRaw();
}

function sbUpdateOutfitCount(i, v) {
  const newCount = parseInt(v) || 1;
  const oldCount = parseInt(sbCurrentShip.outfits[i].count) || 1;
  const diff     = newCount - oldCount;
  const rawName  = sbCurrentShip.outfits[i].name.replace(/^"([^"]*)"$/, '$1');
  const pluginId = sbCurrentShip.outfits[i].pluginId || null;
  if (diff > 0) {
    if (!sbCheckOutfitSpace(rawName, diff, pluginId)) { const inputs = document.querySelectorAll('.outfit-item__count'); if (inputs[i]) inputs[i].value = oldCount; return; }
    sbAutoSlotWeapons(rawName, diff, sbFindOutfit(rawName, pluginId));
  } else if (diff < 0) { _sbUnslotWeapons(rawName, Math.abs(diff)); }
  sbCurrentShip.outfits[i].count = newCount;
  sbRenderOutfitsList(); sbRenderGunsTurrets(); sbUpdateQuickStats(); sbRenderRaw();
}

function sbRemoveOutfit(i) {
  const outfit  = sbCurrentShip.outfits[i];
  const rawName = outfit.name.replace(/^"([^"]*)"$/, '$1');
  _sbUnslotWeapons(rawName, parseInt(outfit.count) || 1);
  sbCurrentShip.outfits.splice(i, 1);
  sbRenderOutfitsList(); sbRenderGunsTurrets(); sbUpdateQuickStats(); sbRenderRaw();
}

// NOTE: hardpoint `over` matching stays name-only, deliberately — a gun/
// turret's "over" field in real Endless Sky syntax is just the outfit
// name (there's no plugin-qualified form in the actual .txt grammar), so
// there is no internalId to match against here even in principle.
function _sbUnslotWeapons(outfitName, count) {
  const clean = outfitName.replace(/^"([^"]*)"$/, '$1');
  let remaining = count;
  for (const arr of [sbCurrentShip.guns, sbCurrentShip.turrets]) {
    for (let i = (arr||[]).length - 1; i >= 0 && remaining > 0; i--) {
      if ((arr[i].over || '').replace(/^"([^"]*)"$/, '$1').trim() === clean) { arr[i].over = ''; remaining--; }
    }
  }
}

function sbAutoSlotAllOutfits(s) {
  if (!sbAllOutfits.length) return;
  for (const o of (s.outfits || [])) {
    const rawName   = o.name.replace(/^"([^"]*)"$/, '$1');
    const outfitObj = sbFindOutfit(rawName, o.pluginId);
    if (!outfitObj) continue;
    const count      = parseInt(o.count) || 1;
    const gunCost    = _sbGetPortCost(outfitObj, 'gun ports');
    const turretCost = _sbGetPortCost(outfitObj, 'turret mounts');
    if (gunCost    > 0) _sbFillEmptyPorts(s.guns,    rawName, gunCost    * count);
    if (turretCost > 0) _sbFillEmptyPorts(s.turrets, rawName, turretCost * count);
  }
}

function _sbEmptyPortCount(hardpoints) { return (hardpoints || []).filter(hp => !hp.over || hp.over.trim() === '').length; }

function sbCheckOutfitSpace(outfitName, count, pluginId) {
  const capacityChecks = [
    { key: 'outfit space',    label: 'Outfit space',    max: sbMaxOutfitSpace(),    used: sbUsedOutfitSpace() },
    { key: 'engine capacity', label: 'Engine capacity', max: sbMaxEngineCapacity(), used: sbUsedEngineCapacity() },
    { key: 'weapon capacity', label: 'Weapon capacity', max: sbMaxWeaponCapacity(), used: sbUsedWeaponCapacity() },
    { key: 'cargo space',     label: 'Cargo space',     max: sbMaxCargoSpace(),     used: sbUsedCargoSpace() },
  ];
  for (const c of capacityChecks) {
    if (c.max <= 0) continue;
    const effect = sbGetOutfitCapacityEffect(outfitName, c.key, pluginId);
    if (effect >= 0) continue;
    const cost    = Math.abs(effect);
    const newUsed = c.used + cost * count;
    if (newUsed > c.max) { sbToast(`Not enough ${c.label}. Need ${cost * count}, have ${Math.max(0, c.max - c.used)} free.`, 'danger'); return false; }
  }
  const outfitObj = sbFindOutfit(outfitName, pluginId);
  if (outfitObj) {
    const gunCost    = _sbGetPortCost(outfitObj, 'gun ports');
    const turretCost = _sbGetPortCost(outfitObj, 'turret mounts');
    if (gunCost > 0) { const needed = gunCost * count; const freeGuns = _sbEmptyPortCount(sbCurrentShip.guns); if (freeGuns < needed) { sbToast(`Not enough gun ports. Need ${needed}, only ${freeGuns} available.`, 'danger'); return false; } }
    if (turretCost > 0) { const needed = turretCost * count; const freeTurrets = _sbEmptyPortCount(sbCurrentShip.turrets); if (freeTurrets < needed) { sbToast(`Not enough turret mounts. Need ${needed}, only ${freeTurrets} available.`, 'danger'); return false; } }
  }
  return true;
}

// ── Outfit picker ─────────────────────────────────────────
function sbOpenOutfitPicker() {
  const list = document.getElementById('sb-outfit-picker-list');
  const caps = {
    'outfit space':    sbMaxOutfitSpace()    - sbUsedOutfitSpace(),
    'engine capacity': sbMaxEngineCapacity() - sbUsedEngineCapacity(),
    'weapon capacity': sbMaxWeaponCapacity() - sbUsedWeaponCapacity(),
    'cargo space':     sbMaxCargoSpace()     - sbUsedCargoSpace(),
  };

  const spaceInfoEl = document.getElementById('sb-outfit-picker-space');
  if (spaceInfoEl) {
    const lines = [];
    if (sbMaxOutfitSpace()    > 0) lines.push(`Outfit: ${caps['outfit space']} free`);
    if (sbMaxEngineCapacity() > 0) lines.push(`Engine: ${caps['engine capacity']} free`);
    if (sbMaxWeaponCapacity() > 0) lines.push(`Weapon: ${caps['weapon capacity']} free`);
    if (sbMaxCargoSpace()     > 0) lines.push(`Cargo: ${caps['cargo space']} free`);
    const freeGuns    = _sbEmptyPortCount(sbCurrentShip.guns);
    const freeTurrets = _sbEmptyPortCount(sbCurrentShip.turrets);
    if ((sbCurrentShip.guns    || []).length > 0) lines.push(`Guns: ${freeGuns} port${freeGuns !== 1 ? 's' : ''} free`);
    if ((sbCurrentShip.turrets || []).length > 0) lines.push(`Turrets: ${freeTurrets} mount${freeTurrets !== 1 ? 's' : ''} free`);
    spaceInfoEl.textContent = lines.join('  ·  ');
    spaceInfoEl.style.display = lines.length ? '' : 'none';
  }

  const byPlugin = {};
  for (const o of sbAllOutfits) {
    const key = o._pd || o._pn || 'Unknown';
    (byPlugin[key] = byPlugin[key] || []).push(o);
  }

  const freeGunsForPicker    = _sbEmptyPortCount(sbCurrentShip.guns);
  const freeTurretsForPicker = _sbEmptyPortCount(sbCurrentShip.turrets);
  const hasGunPorts    = (sbCurrentShip.guns    || []).length > 0;
  const hasTurretPorts = (sbCurrentShip.turrets || []).length > 0;

  list.innerHTML = Object.entries(byPlugin).map(([plugin, outfits]) => `
    <div class="sb-picker-group">
      <div class="sb-picker-group-label">${esc(plugin)}</div>
      ${outfits.map(o => {
        const name = o.name || o.displayName || '';
        const cat  = o.category || (o.attributes && o.attributes.category) || '';
        const cost = (o.cost || (o.attributes && o.attributes.cost)) ? `${Number(o.cost || o.attributes.cost).toLocaleString()} cr` : '';
        const costBadges = [];
        let wouldBlock = false;
        const oPluginId = o._pn || o._pluginId || null;
        for (const [capKey, free] of Object.entries(caps)) {
          const effect = sbGetOutfitCapacityEffect(name, capKey, oPluginId);
          if (effect === 0) continue;
          const maxVal = sbShipCapacity(capKey);
          if (maxVal <= 0) continue;
          const shortLabels = { 'outfit space':'sp','engine capacity':'eng','weapon capacity':'wpn','cargo space':'cargo' };
          if (effect < 0) {
            const capCost = Math.abs(effect);
            const over = capCost > free;
            if (over) wouldBlock = true;
            costBadges.push(`<span class="sb-picker-size${over ? ' sb-picker-size--over' : ''}">${capCost} ${shortLabels[capKey]||capKey}</span>`);
          } else {
            costBadges.push(`<span class="sb-picker-size" style="background:rgba(72,187,120,0.15);color:#68d391;border-color:rgba(72,187,120,0.3);">+${effect} ${shortLabels[capKey]||capKey}</span>`);
          }
        }
        const gunCost    = _sbGetPortCost(o, 'gun ports');
        const turretCost = _sbGetPortCost(o, 'turret mounts');
        if (gunCost > 0 && hasGunPorts)    { const over = gunCost > freeGunsForPicker;    if (over) wouldBlock = true; costBadges.push(`<span class="sb-picker-size${over ? ' sb-picker-size--over' : ''}">${gunCost} gun${gunCost > 1 ? 's' : ''}</span>`); }
        if (turretCost > 0 && hasTurretPorts) { const over = turretCost > freeTurretsForPicker; if (over) wouldBlock = true; costBadges.push(`<span class="sb-picker-size${over ? ' sb-picker-size--over' : ''}">${turretCost} turret${turretCost > 1 ? 's' : ''}</span>`); }
        const encoded = btoa(unescape(encodeURIComponent(JSON.stringify({ name, pluginId: oPluginId }))));
        return `<div class="sb-picker-row${wouldBlock ? ' sb-picker-row--over' : ''}" onclick="sbAddOutfitFromPicker('${encoded}')">
          <span class="sb-picker-name" data-name="${esc(name || '')}">${(window.OutfitNames ? OutfitNames.html(o) : esc(name || 'Unknown'))}</span>
          <span class="sb-picker-meta" style="display:flex;align-items:center;gap:4px;flex-shrink:0;">${esc([cat, cost].filter(Boolean).join(' · '))}${costBadges.join('')}</span>
        </div>`;
      }).join('')}
    </div>`).join('');

  document.getElementById('sb-outfit-picker-search').value = '';
  document.getElementById('sb-outfit-count-input').value   = '1';
  openModal('modal-sb-outfit-picker');
}

function sbFilterOutfitPicker(val) {
  const q = val.toLowerCase();
  document.querySelectorAll('#sb-outfit-picker-list .sb-picker-row').forEach(r => {
    r.style.display = r.querySelector('.sb-picker-name').textContent.toLowerCase().includes(q) ? '' : 'none';
  });
  document.querySelectorAll('#sb-outfit-picker-list .sb-picker-group').forEach(g => {
    g.style.display = [...g.querySelectorAll('.sb-picker-row')].some(r => r.style.display !== 'none') ? '' : 'none';
  });
}

function sbAddOutfitFromPicker(encoded) {
  const payload  = JSON.parse(decodeURIComponent(escape(atob(encoded))));
  const rawName  = payload.name.replace(/^"([^"]*)"$/, '$1');
  const pluginId = payload.pluginId || null;
  const internalId = pluginId ? `${pluginId}::${rawName}` : null;
  const count    = parseInt(document.getElementById('sb-outfit-count-input').value) || 1;
  if (!sbCheckOutfitSpace(rawName, count, pluginId)) return;
  // Match the SAME outfit (same plugin), not just any same-named one, when
  // merging into an existing stack.
  const existing = sbCurrentShip.outfits.find(o => o.name === rawName && (o.pluginId || null) === pluginId);
  if (existing) { existing.count += count; if (!existing.internalId && internalId) existing.internalId = internalId; }
  else { sbCurrentShip.outfits.push({ name: rawName, count, pluginId, internalId }); }
  sbAutoSlotWeapons(rawName, count, sbFindOutfit(rawName, pluginId));
  closeModal('modal-sb-outfit-picker');
  sbRenderOutfitsList(); sbRenderGunsTurrets(); sbUpdateQuickStats(); sbRenderRaw();
}

// ═══════════════════════════════════════════════════════════
//  GUNS / TURRETS / BAYS / ENGINES
// ═══════════════════════════════════════════════════════════
function sbRenderGunsTurrets() {
  sbRenderHP('guns',    'guns-list',    'gun',    true);
  sbRenderHP('turrets', 'turrets-list', 'turret', true);
  sbRenderBays('drones',   'drones-list',   'drone');
  sbRenderBays('fighters', 'fighters-list', 'fighter');
  sbRenderEngines();
}

// ─────────────────────────────────────────────────────────
//  GENERIC HARDPOINT SUB-ATTRIBUTES (angle, arc, under, zoom,
//  etc. — see PARSER_DOCUMENTATION.md §5.2-§5.4). Stored as
//  hp.attrs = { key: [occurrence, occurrence, ...] } where an
//  occurrence is `true` (bare flag, e.g. "under") or an array
//  of values (one entry per number/word on that line).
// ─────────────────────────────────────────────────────────
function _sbParseHardpointAttrLine(rawLine) {
  const p = sbTok(rawLine.trim());
  if (!p.length) return null;
  const key = sbStripQ(p[0]);
  if (!key) return null;
  const rest = p.slice(1);
  if (!rest.length) return { key, occurrence: true };
  const allNumeric = rest.every(tok => /^-?[0-9]*\.?[0-9]+$/.test(tok));
  if (allNumeric) return { key, occurrence: rest.map(Number) };
  return { key, occurrence: rest.map(sbStripQ) };
}

function _sbAttrsToESLines(attrs, indent) {
  const lines = [];
  if (!attrs) return lines;
  for (const [key, occurrences] of Object.entries(attrs)) {
    const qk = /\s/.test(key) ? `"${key}"` : key;
    for (const occ of (occurrences || [])) {
      if (occ === true) { lines.push(`${indent}${qk}`); continue; }
      if (Array.isArray(occ)) {
        const vals = occ.map(v => (/^-?[0-9]*\.?[0-9]+$/.test(String(v))) ? String(v) : `"${v}"`).join(' ');
        lines.push(`${indent}${qk}${vals ? ' ' + vals : ''}`);
      }
    }
  }
  return lines;
}

// Pulls the first occurrence of `key` out of an attrs object so it can be
// written inline on the hardpoint's own line (e.g. engine zoom). Any
// additional occurrences of that same key are left behind and still emitted
// as their own indented lines.
function _sbExtractInlineToken(attrs, key) {
  if (!attrs || !attrs[key] || !attrs[key].length) return { value: '', rest: attrs };
  const occs  = attrs[key];
  const first = occs[0];
  const value = (first === true) ? '' : first.join(' ');
  const rest  = { ...attrs };
  const remaining = occs.slice(1);
  if (remaining.length) rest[key] = remaining;
  else delete rest[key];
  return { value, rest };
}

function _sbAttrsSummaryHTML(field, idx, attrs) {
  if (!attrs) return '';
  const tags = [];
  for (const [k, occs] of Object.entries(attrs)) {
    (occs || []).forEach((occ, oi) => {
      const label = occ === true ? k : `${k} ${occ.join(' ')}`;
      tags.push(`<span class="sb-outfit-size" style="cursor:pointer;" title="Click to remove" onclick="sbRemoveHPAttr('${field}',${idx},'${esc(k).replace(/'/g,"\\'")}',${oi})">${esc(label)} ✕</span>`);
    });
  }
  return tags.length ? `<div style="width:100%;display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;">${tags.join('')}</div>` : '';
}

// ── Hardpoint Extra Attributes modal (angle, arc, under, zoom, ...) ──────
let _sbHPAttrTarget = null;  // { field, idx }
let _sbHPAttrValues = [];    // value boxes currently being composed for the "add/edit line" row
let _sbHPAttrEditing = null; // { key, occIdx } — set while an existing line is loaded for editing

function sbOpenHPAttrEditor(field, idx) {
  _sbHPAttrTarget = { field, idx };
  _sbHPAttrEditing = null;
  const titleEl = document.getElementById('sb-hp-attrs-title');
  if (titleEl) titleEl.textContent = `Extra Attributes — ${field} #${idx + 1}`;
  document.getElementById('sb-hp-attr-key').value = '';
  _sbHPAttrValues = []; // defaults to no value boxes (a bare flag) until the user adds one
  sbRenderHPAttrValueBoxes();
  sbRenderHPAttrsModalList();
  sbUpdateHPAttrComposeUI();
  openModal('modal-sb-hp-attrs');
}

function sbUpdateHPAttrComposeUI() {
  const btn = document.getElementById('sb-hp-attr-confirm-btn');
  const cancelBtn = document.getElementById('sb-hp-attr-cancel-edit-btn');
  if (btn) btn.textContent = _sbHPAttrEditing ? '✓ Update Line' : '+ Add Line';
  if (cancelBtn) cancelBtn.style.display = _sbHPAttrEditing ? '' : 'none';
}

function sbRenderHPAttrValueBoxes() {
  const el = document.getElementById('sb-hp-attr-values');
  if (!el) return;
  el.innerHTML = _sbHPAttrValues.map((v, i) => `
    <span style="display:inline-flex;align-items:center;gap:2px;">
      <input class="text-input" type="text" style="width:70px;padding:4px 6px;font-size:0.8rem;" value="${esc(v)}" onchange="sbUpdateHPAttrValueBox(${i},this.value)">
      <button class="btn btn-danger btn-xs" onclick="sbRemoveHPAttrValueBox(${i})">✕</button>
    </span>`).join('');
}
function sbAddHPAttrValueBox()        { _sbHPAttrValues.push(''); sbRenderHPAttrValueBoxes(); }
function sbUpdateHPAttrValueBox(i, v) { _sbHPAttrValues[i] = v; }
function sbRemoveHPAttrValueBox(i)    { _sbHPAttrValues.splice(i, 1); sbRenderHPAttrValueBoxes(); }

function sbRenderHPAttrsModalList() {
  const el = document.getElementById('sb-hp-attrs-list');
  if (!el || !_sbHPAttrTarget) return;
  const { field, idx } = _sbHPAttrTarget;
  const hp = sbCurrentShip[field] && sbCurrentShip[field][idx];
  const attrs = hp ? hp.attrs : null;
  if (!attrs || !Object.keys(attrs).length) {
    el.innerHTML = '<div style="color:var(--c-text-muted);font-size:0.86rem;font-style:italic;">No extra attributes yet.</div>';
    return;
  }
  const rows = [];
  for (const [k, occs] of Object.entries(attrs)) {
    (occs || []).forEach((occ, oi) => {
      const label = occ === true ? k : `${k} ${occ.join(' ')}`;
      const isEditing = _sbHPAttrEditing && _sbHPAttrEditing.key === k && _sbHPAttrEditing.occIdx === oi;
      rows.push(`<div class="attr-row"${isEditing ? ' style="outline:1px solid var(--c-accent);border-radius:var(--r-sm);"' : ''}>
        <span class="attr-key">${esc(label)}</span>
        <button class="btn btn-secondary btn-xs" onclick="sbEditHPAttrFromModal('${field}',${idx},'${esc(k).replace(/'/g,"\\'")}',${oi})" title="Edit this line">✎</button>
        <button class="btn btn-danger btn-xs" onclick="sbRemoveHPAttrFromModal('${field}',${idx},'${esc(k).replace(/'/g,"\\'")}',${oi})">✕</button>
      </div>`);
    });
  }
  el.innerHTML = rows.join('');
}

// Loads an existing hardpoint attribute line back into the compose fields so
// it can be edited, rather than only being deletable and re-addable.
function sbEditHPAttrFromModal(field, idx, key, occIdx) {
  const hp = sbCurrentShip[field] && sbCurrentShip[field][idx];
  if (!hp || !hp.attrs || !hp.attrs[key] || hp.attrs[key][occIdx] === undefined) return;
  const occ = hp.attrs[key][occIdx];
  document.getElementById('sb-hp-attr-key').value = key;
  _sbHPAttrValues = (occ === true) ? [] : occ.map(v => String(v));
  _sbHPAttrEditing = { key, occIdx };
  sbRenderHPAttrValueBoxes();
  sbRenderHPAttrsModalList();
  sbUpdateHPAttrComposeUI();
  document.getElementById('sb-hp-attr-key').focus();
}

function sbCancelHPAttrEdit() {
  _sbHPAttrEditing = null;
  document.getElementById('sb-hp-attr-key').value = '';
  _sbHPAttrValues = [];
  sbRenderHPAttrValueBoxes();
  sbRenderHPAttrsModalList();
  sbUpdateHPAttrComposeUI();
}

function sbConfirmAddHPAttr() {
  if (!_sbHPAttrTarget) return;
  const { field, idx } = _sbHPAttrTarget;
  const key = document.getElementById('sb-hp-attr-key').value.trim();
  if (!key) { sbToast('Please enter a key.', 'danger'); return; }
  const cleanVals = _sbHPAttrValues.map(v => v.trim()).filter(v => v !== '');
  const occurrence = cleanVals.length
    ? cleanVals.map(v => (/^-?[0-9]*\.?[0-9]+$/.test(v)) ? Number(v) : v)
    : true;
  const hp = sbCurrentShip[field] && sbCurrentShip[field][idx];
  if (!hp) return;
  hp.attrs = hp.attrs || {};

  // If a line was loaded for editing, remove the old occurrence first so we
  // replace it rather than appending a duplicate.
  if (_sbHPAttrEditing) {
    const { key: oldKey, occIdx: oldOccIdx } = _sbHPAttrEditing;
    if (hp.attrs[oldKey] && hp.attrs[oldKey][oldOccIdx] !== undefined) {
      hp.attrs[oldKey].splice(oldOccIdx, 1);
      if (!hp.attrs[oldKey].length) delete hp.attrs[oldKey];
    }
    _sbHPAttrEditing = null;
  }

  (hp.attrs[key] = hp.attrs[key] || []).push(occurrence);

  document.getElementById('sb-hp-attr-key').value = '';
  _sbHPAttrValues = [];
  sbRenderHPAttrValueBoxes();
  sbRenderHPAttrsModalList();
  sbUpdateHPAttrComposeUI();
  sbRenderGunsTurrets();
  sbRenderRaw();
}

function sbRemoveHPAttr(field, idx, key, occIdx) {
  const hp = sbCurrentShip[field] && sbCurrentShip[field][idx];
  if (!hp || !hp.attrs || !hp.attrs[key]) return;
  hp.attrs[key].splice(occIdx, 1);
  if (!hp.attrs[key].length) delete hp.attrs[key];
  sbRenderGunsTurrets();
  sbRenderRaw();
}

function sbRemoveHPAttrFromModal(field, idx, key, occIdx) {
  // If the line being removed is the one currently loaded for editing,
  // clear the compose fields so we don't try to "update" a deleted line.
  if (_sbHPAttrEditing && _sbHPAttrEditing.key === key && _sbHPAttrEditing.occIdx === occIdx) {
    _sbHPAttrEditing = null;
    document.getElementById('sb-hp-attr-key').value = '';
    _sbHPAttrValues = [];
    sbRenderHPAttrValueBoxes();
    sbUpdateHPAttrComposeUI();
  }
  sbRemoveHPAttr(field, idx, key, occIdx);
  sbRenderHPAttrsModalList();
}

function sbRenderHP(field, elId, label, showOver) {
  const el = document.getElementById(elId); if (!el) return;
  const items = sbCurrentShip[field] || [];
  const count = items.length;
  el.innerHTML = (count > 0 ? `<div class="sb-hp-count-badge">${count} ${label}${count !== 1 ? 's' : ''}</div>` : '') +
    (items.length ? items.map((g, i) =>
      `<div class="outfit-item" style="gap:4px;flex-wrap:wrap;">
        <span class="sb-hp-idx">${i + 1}</span>
        <input class="text-input" style="flex:1;min-width:70px;padding:4px 6px;font-size:0.78rem;" type="text" value="${esc(g.coords||'')}" placeholder="x y" onchange="sbUpdateHP('${field}',${i},'coords',this.value)">
        ${showOver ? `<input class="text-input sb-hp-over" style="width:140px;padding:4px 6px;font-size:0.78rem;" type="text" value="${esc(g.over||'')}" placeholder='outfit "Name"' onchange="sbUpdateHP('${field}',${i},'over',this.value)">` : ''}
        <button class="btn btn-secondary btn-xs" onclick="sbOpenHPAttrEditor('${field}',${i})" title="Extra attributes (angle, arc, under, zoom...)">⚙</button>
        <button class="btn btn-danger btn-xs" onclick="sbRemoveHP('${field}',${i})">✕</button>
        ${_sbAttrsSummaryHTML(field, i, g.attrs)}
      </div>`).join('')
    : `<div style="color:var(--c-text-dim);font-size:0.82rem;font-style:italic;padding:6px 0;">No ${label}s defined.</div>`);
}

function sbRenderBays(field, elId, label) {
  const el = document.getElementById(elId); if (!el) return;
  const items = sbCurrentShip[field] || [];
  const count = items.length;
  el.innerHTML = (count > 0 ? `<div class="sb-hp-count-badge">${count} ${label} bay${count !== 1 ? 's' : ''}</div>` : '') +
    (items.length ? items.map((b, i) =>
      `<div class="outfit-item" style="gap:4px;flex-wrap:wrap;">
        <span class="sb-hp-idx">${i + 1}</span>
        <input class="text-input" style="flex:1;min-width:70px;padding:4px 6px;font-size:0.78rem;" type="text" value="${esc(b.coords||'')}" placeholder="x y" onchange="sbUpdateHP('${field}',${i},'coords',this.value)">
        <input class="text-input" style="width:150px;padding:4px 6px;font-size:0.78rem;" type="text" value="${esc(b.launchEffect||'')}" placeholder="launch effect" onchange="sbUpdateHP('${field}',${i},'launchEffect',this.value)">
        <input class="text-input" style="width:72px;padding:4px 6px;font-size:0.78rem;" type="text" value="${esc(b.position||'')}" placeholder="left/right" title="Optional position token (4th value on the bay line)" onchange="sbUpdateHP('${field}',${i},'position',this.value)">
        <button class="btn btn-secondary btn-xs" onclick="sbOpenHPAttrEditor('${field}',${i})" title="Extra attributes">⚙</button>
        <button class="btn btn-danger btn-xs" onclick="sbRemoveHP('${field}',${i})">✕</button>
        ${_sbAttrsSummaryHTML(field, i, b.attrs)}
      </div>`).join('')
    : `<div style="color:var(--c-text-dim);font-size:0.82rem;font-style:italic;padding:6px 0;">No ${label} bays defined.</div>`);
}

const SB_ENGINE_TYPE_LABEL = { engine: 'Engine', reverse: 'Reverse', steering: 'Steering' };

function sbRenderEngines() {
  const el = document.getElementById('engines-list'); if (!el) return;
  const items = sbCurrentShip.engines || [];
  const count = items.length;
  el.innerHTML = (count > 0 ? `<div class="sb-hp-count-badge">${count} engine point${count !== 1 ? 's' : ''}</div>` : '') +
    (items.length ? items.map((e, i) =>
      `<div class="outfit-item" style="gap:4px;flex-wrap:wrap;">
        <span class="sb-hp-idx">${i + 1}</span>
        <select class="text-input" style="width:96px;padding:4px 6px;font-size:0.76rem;" onchange="sbUpdateHP('engines',${i},'type',this.value)" title="Engine, reverse engine, or steering engine">
          ${['engine','reverse','steering'].map(t => `<option value="${t}" ${(e.type||'engine')===t?'selected':''}>${SB_ENGINE_TYPE_LABEL[t]}</option>`).join('')}
        </select>
        <input class="text-input" style="flex:1;min-width:70px;padding:4px 6px;font-size:0.78rem;" type="text" value="${esc(e.coords||'')}" placeholder="x y" onchange="sbUpdateHP('engines',${i},'coords',this.value)">
        <button class="btn btn-secondary btn-xs" onclick="sbOpenHPAttrEditor('engines',${i})" title="Extra attributes (zoom, angle, under...)">⚙</button>
        <button class="btn btn-danger btn-xs" onclick="sbRemoveHP('engines',${i})">✕</button>
        ${_sbAttrsSummaryHTML('engines', i, e.attrs)}
      </div>`).join('')
    : `<div style="color:var(--c-text-dim);font-size:0.82rem;font-style:italic;padding:6px 0;">No engine points defined.</div>`);
}

function addGunTurret(type) {
  if (type === 'engine')  { (sbCurrentShip.engines  = sbCurrentShip.engines  || []).push({ coords:'0 0', type:'engine' }); sbRenderEngines(); sbRenderRaw(); return; }
  if (type === 'drone')   { (sbCurrentShip.drones    = sbCurrentShip.drones   || []).push({ coords:'0 0', launchEffect:'', position:'' }); sbRenderBays('drones',   'drones-list',   'drone');   sbRenderRaw(); return; }
  if (type === 'fighter') { (sbCurrentShip.fighters  = sbCurrentShip.fighters || []).push({ coords:'0 0', launchEffect:'', position:'' }); sbRenderBays('fighters', 'fighters-list', 'fighter'); sbRenderRaw(); return; }
  const field = { gun:'guns', turret:'turrets' }[type];
  if (!field) return;
  (sbCurrentShip[field] = sbCurrentShip[field] || []).push({ coords:'0 0', over:'' });
  sbRenderHP(field, `${field}-list`, type, true); sbRenderRaw();
}
function sbUpdateHP(f, i, p, v) { sbCurrentShip[f][i][p] = v; sbRenderRaw(); }
function sbRemoveHP(f, i) { sbCurrentShip[f].splice(i,1); sbRenderGunsTurrets(); sbUpdateQuickStats(); sbRenderRaw(); }

// ═══════════════════════════════════════════════════════════
//  LEAKS
// ═══════════════════════════════════════════════════════════
function sbRenderLeaksList() {
  const el = document.getElementById('leaks-list'); if (!el) return;
  const leaks = sbCurrentShip.leaks || [];
  el.innerHTML = leaks.length ? leaks.map((l, i) => `
    <div class="outfit-item" style="display:grid;grid-template-columns:1fr 60px 60px 28px;gap:4px;align-items:center;">
      <span class="outfit-item__name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(l.name || '')}">${esc(l.name || '')}</span>
      <input class="outfit-item__count" type="number" min="0" max="100" value="${esc(String(l.openChance ?? 0))}" style="width:100%;text-align:center;" onchange="sbUpdateLeakField(${i}, 'openChance', this.value)" title="Open chance (0–100)">
      <input class="outfit-item__count" type="number" min="0" max="100" value="${esc(String(l.spreadChance ?? 0))}" style="width:100%;text-align:center;" onchange="sbUpdateLeakField(${i}, 'spreadChance', this.value)" title="Spread chance (0–100)">
      <button class="btn btn-danger btn-xs" onclick="sbRemoveLeak(${i})">✕</button>
    </div>`).join('')
  : `<div style="color:var(--c-text-dim);font-size:0.82rem;font-style:italic;padding:6px 0;">No leak effects.</div>`;
}
function sbUpdateLeakField(i, field, v) { sbCurrentShip.leaks[i][field] = parseInt(v) || 0; sbRenderLeaksList(); sbRenderRaw(); }
function sbUpdateLeak(i, v) { sbUpdateLeakField(i, 'openChance', v); }
function sbRemoveLeak(i) { sbCurrentShip.leaks.splice(i, 1); sbRenderLeaksList(); sbRenderRaw(); }

function sbOpenEffectPicker(targetField) {
  sbRefreshLiveData();
  const list    = document.getElementById('sb-effect-picker-list');
  const titleEl = document.getElementById('sb-effect-picker-title');
  if (titleEl) titleEl.textContent = targetField === 'leaks' ? 'Add Leak Effect' : 'Add Effect';
  const byPlugin = {};
  for (const e of sbAllEffects) { const key = e._pd || e._pn || 'Unknown'; (byPlugin[key] = byPlugin[key] || []).push(e); }
  if (!sbAllEffects.length) {
    list.innerHTML = '<div style="color:var(--c-text-dim);font-size:0.88rem;padding:12px;">No effects loaded yet.</div>';
  } else {
    list.innerHTML = Object.entries(byPlugin).map(([plugin, effects]) => `
      <div class="sb-picker-group">
        <div class="sb-picker-group-label">${esc(plugin)}</div>
        ${effects.map(e => `<div class="sb-picker-row" data-effect-name="${esc(e.name || '')}" data-effect-field="${esc(targetField)}"><span class="sb-picker-name">${esc(e.name || 'Unknown')}</span></div>`).join('')}
      </div>`).join('');
  }
  document.getElementById('sb-effect-picker-search').value = '';
  document.getElementById('sb-effect-count-input').value   = '1';
  document.getElementById('modal-sb-effect-picker').dataset.targetField = targetField;
  const listEl = document.getElementById('sb-effect-picker-list');
  const newList = listEl.cloneNode(true);
  listEl.parentNode.replaceChild(newList, listEl);
  newList.addEventListener('click', e => {
    const row = e.target.closest('.sb-picker-row');
    if (!row) return;
    if (row.dataset.effectName) sbAddEffectFromPicker(JSON.stringify(row.dataset.effectName), row.dataset.effectField);
  });
  openModal('modal-sb-effect-picker');
}

function sbFilterEffectPicker(val) {
  const q = val.toLowerCase();
  document.querySelectorAll('#sb-effect-picker-list .sb-picker-row').forEach(r => {
    r.style.display = r.querySelector('.sb-picker-name').textContent.toLowerCase().includes(q) ? '' : 'none';
  });
  document.querySelectorAll('#sb-effect-picker-list .sb-picker-group').forEach(g => {
    g.style.display = [...g.querySelectorAll('.sb-picker-row')].some(r => r.style.display !== 'none') ? '' : 'none';
  });
}

function sbAddEffectFromPicker(nameJson, targetField) {
  const name  = JSON.parse(nameJson);
  const count = parseInt(document.getElementById('sb-effect-count-input').value) || 1;
  const field = document.getElementById('modal-sb-effect-picker').dataset.targetField || targetField;
  if (field === 'leaks') {
    const existing = (sbCurrentShip.leaks || []).find(l => l.name === name);
    if (existing) existing.openChance = (existing.openChance || 0) + count;
    else (sbCurrentShip.leaks = sbCurrentShip.leaks || []).push({ name, openChance: count, spreadChance: 0 });
    closeModal('modal-sb-effect-picker'); sbRenderLeaksList(); sbRenderRaw();
  } else if (field === 'explode') {
    const existing = (sbCurrentShip.explode || []).find(e => e.name === name);
    if (existing) existing.count += count;
    else (sbCurrentShip.explode = sbCurrentShip.explode || []).push({ name, count });
    closeModal('modal-sb-effect-picker'); sbRenderExplodeLists(); sbRenderRaw();
  } else if (field === 'finalExplode') {
    const existing = (sbCurrentShip.finalExplode || []).find(e => e.name === name);
    if (existing) existing.count += count;
    else (sbCurrentShip.finalExplode = sbCurrentShip.finalExplode || []).push({ name, count });
    closeModal('modal-sb-effect-picker'); sbRenderExplodeLists(); sbRenderRaw();
  }
}

// ═══════════════════════════════════════════════════════════
//  WEAPON SUB-BLOCK
// ═══════════════════════════════════════════════════════════
const SB_WEAPON_FIELDS = ['blast radius', 'shield damage', 'hull damage', 'hit force'];

function sbRenderWeaponBlock() {
  const el = document.getElementById('weapon-block'); if (!el) return;
  const w = sbCurrentShip.weapon || {};
  el.innerHTML = SB_WEAPON_FIELDS.map(k => `
    <div class="attr-row">
      <span class="attr-key">${esc(k)}</span>
      <input class="attr-val-input" type="number" step="1" value="${esc(String(w[k] ?? 0))}" data-wkey="${esc(k)}" onchange="sbUpdateWeaponField(this)" onblur="sbUpdateWeaponField(this)">
    </div>`).join('');
}
function sbUpdateWeaponField(inp) {
  if (!sbCurrentShip.weapon) sbCurrentShip.weapon = {};
  sbCurrentShip.weapon[inp.dataset.wkey] = parseFloat(inp.value) || 0;
  sbRenderRaw();
}

// ═══════════════════════════════════════════════════════════
//  EXPLODE
// ═══════════════════════════════════════════════════════════
function sbRenderExplodeLists() { sbRenderExplodeList('explode','explode-list'); sbRenderExplodeList('finalExplode','final-explode-list'); sbRenderLeaksList(); }
function sbRenderExplodeList(field, elId) {
  const el = document.getElementById(elId); if (!el) return;
  const items = sbCurrentShip[field] || [];
  el.innerHTML = items.length ? items.map((e, i) =>
    `<div class="outfit-item">
      <span class="outfit-item__name">${esc(e.name || '')}</span>
      <input class="outfit-item__count" type="number" min="1" value="${esc(String(e.count || 1))}" onchange="sbUpdateExplode('${field}',${i},'count',this.value)">
      <button class="btn btn-danger btn-xs" onclick="sbRemoveExplode('${field}',${i})">✕</button>
    </div>`).join('')
  : `<div style="color:var(--c-text-dim);font-size:0.82rem;font-style:italic;padding:6px 0;">None.</div>`;
}
function addExplodeEffect(type) { sbOpenEffectPicker(type === 'explode' ? 'explode' : 'finalExplode'); }
function addLeakEffect()        { sbOpenEffectPicker('leaks'); }
function sbUpdateExplode(f, i, p, v) { sbCurrentShip[f][i][p] = p === 'count' ? (parseInt(v) || 1) : v; sbRenderRaw(); }
function sbRemoveExplode(f, i) { sbCurrentShip[f].splice(i, 1); sbRenderExplodeLists(); sbRenderRaw(); }

// ═══════════════════════════════════════════════════════════
//  ES GENERATOR
// ═══════════════════════════════════════════════════════════
function _sbEngineKeyword(type) {
  if (type === 'reverse')  return '"reverse engine"';
  if (type === 'steering') return '"steering engine"';
  return 'engine';
}

function sbGenerateES(s) {
  const T = '\t', TT = '\t\t';
  const L = [];

  L.push(`ship "${s.name || 'Unnamed'}"${s.variant ? ' ' + s.variant : ''}`);
  // "display name" lives in the Attributes section here, but the game reads it
  // directly under the ship line (Ship.cpp), not inside the attributes block
  const displayName = (s.attributes && s.attributes['display name']) || '';
  if (displayName && displayName !== s.name) L.push(`${T}"display name" "${displayName}"`);
  if (s.plural)    L.push(`${T}plural "${s.plural}"`);
  if (s.sprite)    L.push(`${T}sprite "${s.sprite}"`);
  if (s.thumbnail) L.push(`${T}thumbnail "${s.thumbnail}"`);

  const attrs    = { ...(s.attributes || {}) };
  delete attrs['display name'];   // written above, not inside attributes
  const attrKeys = Object.keys(attrs);
  const hasMass  = s.mass && s.mass !== '';
  const hasDrag  = s.drag && s.drag !== '';

  if (attrKeys.length || hasMass || hasDrag) {
    L.push(`${T}attributes`);
    if (attrs.category != null) L.push(`${TT}category "${attrs.category}"`);
    if (attrs.licenses && typeof attrs.licenses === 'object') {
      const licKeys = Object.keys(attrs.licenses);
      if (licKeys.length) { L.push(`${TT}licenses`); for (const lic of licKeys) L.push(`${TT}${T}"${lic}"`); }
    }
    if (hasMass) L.push(`${TT}mass ${s.mass}`);
    if (hasDrag) L.push(`${TT}drag ${s.drag}`);
    const SKIP = new Set(['category','licenses','mass','drag','weapon']);
    for (const k of attrKeys) {
      if (SKIP.has(k)) continue;
      const v = attrs[k];
      if (v === '' || v == null) continue;
      const vStr  = String(v);
      const isNum = /^-?[0-9]*\.?[0-9]+$/.test(vStr);
      L.push(`${TT}"${k}" ${isNum ? vStr : `"${vStr}"`}`);
    }
    const w = s.weapon || {};
    if (Object.values(w).some(v => Number(v) !== 0)) {
      L.push(`${TT}weapon`);
      for (const wk of SB_WEAPON_FIELDS) { const wv = w[wk]; if (wv == null || Number(wv) === 0) continue; L.push(`${TT}\t"${wk}" ${wv}`); }
    }
  }

  if ((s.outfits || []).length) {
    L.push(`${T}outfits`);
    for (const o of s.outfits) {
      const count  = parseInt(o.count) || 1;
      const quoted = o.name.startsWith('"') ? o.name : `"${o.name}"`;
      L.push(`${TT}${quoted}${count > 1 ? ' ' + count : ''}`);
    }
  }

  // Engines (including reverse/steering variants) — zoom is edited through
  // the extra-attributes popup like everything else, but the first zoom
  // value is written inline on the hardpoint line itself to match the ES
  // format; any further occurrences and all other attrs (angle, under,
  // arc, ...) round-trip generically (see §5.2-§5.4 of the parser docs).
  for (const e of (s.engines || [])) {
    const parts = (e.coords || '0 0').split(/\s+/);
    const { value: zoomVal, rest: engineAttrs } = _sbExtractInlineToken(e.attrs, 'zoom');
    L.push(`${T}${_sbEngineKeyword(e.type)} ${parts[0] || '0'} ${parts[1] || '0'}${zoomVal !== '' ? ' ' + zoomVal : ''}`);
    L.push(..._sbAttrsToESLines(engineAttrs, TT));
  }
  for (const g of (s.guns    || [])) {
    const raw = (g.over || '').trim().replace(/^"([^"]*)"$/, '$1');
    L.push(`${T}gun ${g.coords || '0 0'}${raw ? ` "${raw}"` : ''}`);
    L.push(..._sbAttrsToESLines(g.attrs, TT));
  }
  for (const g of (s.turrets || [])) {
    const raw = (g.over || '').trim().replace(/^"([^"]*)"$/, '$1');
    L.push(`${T}turret ${g.coords || '0 0'}${raw ? ` "${raw}"` : ''}`);
    L.push(..._sbAttrsToESLines(g.attrs, TT));
  }
  for (const d of (s.drones   || [])) {
    const p = (d.coords || '0 0').split(/\s+/);
    L.push(`${T}bay "Drone" ${p[0]||'0'} ${p[1]||'0'}${d.position ? ' ' + d.position : ''}`);
    if (d.launchEffect) L.push(`${TT}"launch effect" "${d.launchEffect}"`);
    L.push(..._sbAttrsToESLines(d.attrs, TT));
  }
  for (const f of (s.fighters || [])) {
    const p = (f.coords || '0 0').split(/\s+/);
    L.push(`${T}bay "Fighter" ${p[0]||'0'} ${p[1]||'0'}${f.position ? ' ' + f.position : ''}`);
    if (f.launchEffect) L.push(`${TT}"launch effect" "${f.launchEffect}"`);
    L.push(..._sbAttrsToESLines(f.attrs, TT));
  }

  for (const l of (s.leaks || [])) {
    if (!l.name) continue;
    const nameOut = l.name.includes(' ') ? `"${l.name}"` : l.name;
    L.push(`${T}leak ${nameOut} ${parseInt(l.openChance) || 0} ${parseInt(l.spreadChance) || 0}`);
  }
  for (const e of (s.explode      || [])) L.push(`${T}explode "${e.name}"${(parseInt(e.count)||1) > 1 ? ' ' + e.count : ''}`);
  for (const e of (s.finalExplode || [])) L.push(`${T}"final explode" "${e.name}"`);

  if (s.description) {
    for (const para of s.description.split(/\n/)) {
      if (para.trim() !== '') L.push(`${T}description "${para}"`);
    }
  }
  for (const l of (s.extraLines || [])) L.push(l);
  return L.join('\n');
}

// ═══════════════════════════════════════════════════════════
//  ES PARSER
// ═══════════════════════════════════════════════════════════
function sbParseES(text) {
  const ships = []; let cur = null, block = null, subblock = null, lastHardpoint = null;
  const flush = () => { if (cur) ships.push(cur); };
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      const m = t.match(/^ship\s+("([^"]+)"|(\S+))\s*(.*)$/);
      if (m) { flush(); cur = sbBlank(); cur.name = m[2] || m[3] || ''; cur.variant = (m[4] || '').trim(); block = null; subblock = null; lastHardpoint = null; continue; }
      flush(); cur = null; continue;
    }
    if (!cur) continue;
    if (indent === 1) {
      block = null; subblock = null; lastHardpoint = null;
      if (t.startsWith('sprite '))          { cur.sprite = sbStripQ(t.slice(7)); continue; }
      if (t.startsWith('thumbnail '))       { cur.thumbnail = sbStripQ(t.slice(10)); continue; }
      if (t.startsWith('plural '))          { cur.plural = sbStripQ(t.slice(7)); continue; }
      if (/^["`]display name["`]\s/.test(t)) { cur.attributes = cur.attributes || {}; cur.attributes['display name'] = sbStripQ(t.replace(/^["`]display name["`]\s+/, '')); continue; }
      if (t === 'attributes')               { block = 'attributes'; continue; }
      if (t === 'outfits')                  { block = 'outfits'; continue; }
      if (t.startsWith('description '))     { const para = sbStripQ(t.slice(12)); cur.description = cur.description ? cur.description + '\n' + para : para; continue; }
      if (t.startsWith('"reverse engine"'))  { lastHardpoint = _sbPushEngine(cur, t, 'reverse');  continue; }
      if (t.startsWith('"steering engine"')) { lastHardpoint = _sbPushEngine(cur, t, 'steering'); continue; }
      if (t.startsWith('engine '))          { lastHardpoint = _sbPushEngine(cur, t, 'engine');   continue; }
      if (t.startsWith('gun '))             { sbPHP(cur, 'guns',    t.slice(4)); lastHardpoint = { field:'guns',    idx: cur.guns.length-1    }; continue; }
      if (t.startsWith('turret '))          { sbPHP(cur, 'turrets', t.slice(7)); lastHardpoint = { field:'turrets', idx: cur.turrets.length-1 }; continue; }
      if (t.startsWith('bay '))             {
        const p = sbTok(t.slice(4));
        const type = sbStripQ(p[0]||'');
        const coords = p.slice(1,3).join(' ');
        const position = p[3] ? sbStripQ(p[3]) : '';
        if (type === 'Fighter') { cur.fighters.push({ coords, launchEffect:'', position }); lastHardpoint = { field:'fighters', idx: cur.fighters.length-1 }; }
        else { cur.drones.push({ coords, launchEffect:'', position }); lastHardpoint = { field:'drones', idx: cur.drones.length-1 }; }
        continue;
      }
      if (t === 'drone')                    { cur.drones.push({ coords:'', launchEffect:'', position:'' }); continue; }
      if (t === 'fighter')                  { cur.fighters.push({ coords:'', launchEffect:'', position:'' }); continue; }
      if (t.startsWith('leak '))            { const p = sbTok(t.slice(5)); cur.leaks.push({ name: sbStripQ(p[0]||''), openChance: parseInt(p[1])||0, spreadChance: parseInt(p[2])||0 }); continue; }
      if (t.startsWith('explode '))         { sbPEx(cur, 'explode',      t.slice(8));  continue; }
      if (t.startsWith('"final explode" ')) { sbPEx(cur, 'finalExplode', t.slice(16)); continue; }
      cur.extraLines.push(raw); continue;
    }
    if (indent === 2) {
      if (lastHardpoint && t.startsWith('"launch effect"')) { const p = sbTok(t); cur[lastHardpoint.field][lastHardpoint.idx].launchEffect = sbStripQ(p[1]||''); continue; }
      if (lastHardpoint && block === null) {
        // Generic hardpoint sub-attribute (angle, arc, under, repeated zoom, ...)
        const parsed = _sbParseHardpointAttrLine(t);
        if (parsed) {
          const hp = cur[lastHardpoint.field][lastHardpoint.idx];
          hp.attrs = hp.attrs || {};
          (hp.attrs[parsed.key] = hp.attrs[parsed.key] || []).push(parsed.occurrence);
          continue;
        }
      }
      if (block === 'attributes') {
        const p = sbTok(t); if (!p.length) continue;
        const key = sbStripQ(p[0]);
        if (key === 'licenses') { subblock = 'licenses'; continue; }
        if (key === 'weapon')   { subblock = 'weapon'; cur.weapon = cur.weapon || {}; continue; }
        const val = p.slice(1).join(' ');
        if (key === 'mass') { cur.mass = val; continue; }
        if (key === 'drag') { cur.drag = val; continue; }
        cur.attributes[key] = val; continue;
      }
      if (block === 'outfits') { const p = sbTok(t); if (p.length) { const name = p[0].startsWith('"') ? p[0] : `"${p[0]}"`; cur.outfits.push({ name, count: parseInt(p[1])||1, pluginId: null, internalId: null }); } continue; }
      cur.extraLines.push(raw); continue;
    }
    if (indent === 3 && block === 'attributes') {
      const p = sbTok(t); const key = sbStripQ(p[0]||''); const val = p.slice(1).join(' ');
      if (subblock === 'licenses') { cur.attributes.licenses = cur.attributes.licenses || {}; cur.attributes.licenses[key] = true; continue; }
      if (subblock === 'weapon')   { cur.weapon = cur.weapon || {}; cur.weapon[key] = parseFloat(val) || 0; continue; }
    }
    cur.extraLines.push(raw);
  }
  flush();
  return ships;
}
function _sbPushEngine(cur, t, type) {
  const p = sbTok(t).slice(1);
  const eObj = { coords: p.slice(0, 2).join(' '), type };
  if (p[2] != null && p[2] !== '') {
    const n = Number(p[2]);
    eObj.attrs = { zoom: [[isNaN(n) ? p[2] : n]] };
  }
  cur.engines.push(eObj);
  return { field: 'engines', idx: cur.engines.length - 1 };
}
function sbPHP(cur, f, rest) { const p=sbTok(rest); cur[f].push({ coords:p.slice(0,2).join(' '), over:p.slice(2).join(' ') }); }
function sbPEx(cur, f, rest) { const p=sbTok(rest); (cur[f]=cur[f]||[]).push({ name:sbStripQ(p[0]||'tiny explosion'), count:parseInt(p[1])||1 }); }
function sbTok(str) {
  const t=[]; let i=0;
  while(i<str.length){
    if(str[i]===' '||str[i]==='\t'){i++;continue;}
    if(str[i]==='"'){const e=str.indexOf('"',i+1);if(e===-1){t.push(str.slice(i));break;}t.push(str.slice(i,e+1));i=e+1;}
    else{let j=i;while(j<str.length&&str[j]!==' '&&str[j]!=='\t')j++;t.push(str.slice(i,j));i=j;}
  }
  return t;
}
function sbStripQ(s){s=s.trim();return(s.startsWith('"')&&s.endsWith('"'))?s.slice(1,-1):s;}

// ═══════════════════════════════════════════════════════════
//  RAW TAB
// ═══════════════════════════════════════════════════════════
let sbRawDirty = false;
function sbRenderRaw() {
  if (sbRawDirty) return;
  const el = document.getElementById('raw-output');
  if (el && sbCurrentShip) el.value = sbGenerateES(sbCurrentShip);
}
function onRawEdit() { sbRawDirty = true; }
function importRaw() {
  const parsed = sbParseES(document.getElementById('raw-output').value);
  if (!parsed.length) { sbToast('Could not parse ship data.', 'danger'); return; }
  Object.assign(sbCurrentShip, parsed[0]);
  sbRawDirty = false;
  sbPopulateBuilder();
  sbToast('Imported from raw text.', 'success');
}
function copyOutput() {
  navigator.clipboard.writeText(document.getElementById('raw-output').value)
    .then(() => sbToast('Copied!', 'success')).catch(() => sbToast('Copy failed.', 'danger'));
}

// ═══════════════════════════════════════════════════════════
//  EXPORT
// ═══════════════════════════════════════════════════════════
function renderExportChecklist() {
  const cl = document.getElementById('export-checklist'); if (!cl) return;
  const allShips = [
    ...sbSaveFleet.map((s, i) => ({ s, key: `save-${i}`,  label: (s.customName || s.name || 'Unnamed') + ' 💾' })),
    ...sbFleet.map(    (s, i) => ({ s, key: `built-${i}`, label: s.name || 'Unnamed' })),
  ];
  if (!allShips.length) { cl.innerHTML='<div style="color:var(--c-text-muted);font-style:italic;">No ships in any fleet.</div>'; return; }
  cl.innerHTML = allShips.map(({ s, key, label }) =>
    `<label style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:var(--r-sm);background:var(--c-surface-3);margin-bottom:6px;cursor:pointer;">
      <input type="checkbox" id="export-chk-${key}" checked style="accent-color:var(--c-accent);width:16px;height:16px;">
      <span style="font-size:0.92rem;color:var(--c-text-mid);">${esc(label)} <span style="color:var(--c-text-dim);font-size:0.82rem;">${esc(s.variant||'')}</span></span>
    </label>`
  ).join('');
}

function sbGetExportText() {
  const allShips = [
    ...sbSaveFleet.map((s, i) => ({ s, key: `save-${i}` })),
    ...sbFleet.map(    (s, i) => ({ s, key: `built-${i}` })),
  ];
  return allShips
    .filter(({ key }) => document.getElementById(`export-chk-${key}`)?.checked)
    .map(({ s }) => sbGenerateES(s))
    .join('\n\n');
}

function generateExport() { const el=document.getElementById('export-output'); if(el) el.textContent=sbGetExportText()||'(No ships selected)'; }
function copyExport()     { const t=sbGetExportText(); if(!t){sbToast('Nothing to copy.','danger');return;} navigator.clipboard.writeText(t).then(()=>sbToast('Copied!','success')).catch(()=>sbToast('Copy failed.','danger')); }
function downloadExport() { const t=sbGetExportText(); if(!t){sbToast('Nothing to export.','danger');return;} sbDL(t,'ships.txt'); sbToast('Downloaded ships.txt','success'); }
function exportAll()      { const t=[...sbSaveFleet,...sbFleet].map(s=>sbGenerateES(s)).join('\n\n'); if(!t){sbToast('No ships.','danger');return;} sbDL(t,'fleet.txt'); sbToast('Downloaded fleet.txt','success'); }
function sbDL(text, name) { const u=URL.createObjectURL(new Blob([text],{type:'text/plain'})); Object.assign(document.createElement('a'),{href:u,download:name}).click(); URL.revokeObjectURL(u); }

// ═══════════════════════════════════════════════════════════
//  IMPORT (paste)
// ═══════════════════════════════════════════════════════════
function openImport() { document.getElementById('import-text').value=''; openModal('modal-import'); }
function doImport() {
  const parsed = sbParseES(document.getElementById('import-text').value);
  if (!parsed.length) { sbToast('Could not parse any ships.', 'danger'); return; }
  for (const s of parsed) { s.id = Date.now()+Math.random(); sbFleet.push(s); }
  sbSave(); closeModal('modal-import'); renderFleet(); renderExportChecklist();
  sbToast(`Imported ${parsed.length} ship(s)!`, 'success');
}

// ═══════════════════════════════════════════════════════════
//  MODALS / TOAST / UTIL
// ═══════════════════════════════════════════════════════════
function openModal(id)  { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

let _sbToastTimer = null;
function sbToast(msg, type='') {
  const el = document.getElementById('toast'); if (!el) return;
  el.textContent = msg;
  el.className   = 'toast show' + (type ? ' '+type : '');
  clearTimeout(_sbToastTimer);
  _sbToastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  sbLoad();
  sbLoadSaveShips();
  renderFleet();
  renderExportChecklist();
  initBuilderTabs();

  document.querySelectorAll('.modal-overlay').forEach(o =>
    o.addEventListener('click', e => { if (e.target === o) closeModal(o.id); })
  );
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.active').forEach(o => closeModal(o.id));
  });

  const akEl = document.getElementById('new-attr-key');
  const avEl = document.getElementById('new-attr-val');
  if (akEl) akEl.addEventListener('keydown', e => { if (e.key==='Enter') confirmAddAttr(); });
  if (avEl) avEl.addEventListener('keydown', e => { if (e.key==='Enter') confirmAddAttr(); });

  if (window.DataLoader) {
    window.DataLoader.onReady(() => {
      sbRefreshLiveData();
      if (window.PluginManager) window.PluginManager.renderActiveList();
      sbToast('Game data loaded — ship & outfit pickers ready.', 'success');
    });
  } else {
    console.warn('[shipBuilder] dataLoader.js not loaded — outfit/ship pickers will be empty.');
  }

  document.addEventListener('pluginsChanged', () => { sbRefreshLiveData(); });
  document.addEventListener('dataLoaded',     () => { sbRefreshLiveData(); });

  SBS.hookIntoBuilder();
});

// Ships that use a plugin removed from the site get a "⚠ Needs …" badge
// (pluginAvailability.js) — redraw the fleet once that list has loaded.
document.addEventListener('pluginAvailabilityReady', () => { try { renderFleet(); } catch (_) {} });
