'use strict';

// Reads an Endless Sky save file into data the site can use (pilot, ships, cargo, missions, conditions …). Also runs in Node.

// ── split a line into tokens (quotes and backticks respected) ──
function _esTok(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (c === ' ' || c === '\t') { i++; continue; }

    if (c === '"') {
      const end = str.indexOf('"', i + 1);
      if (end === -1) { tokens.push(str.slice(i)); break; }
      tokens.push(str.slice(i, end + 1)); // keep quotes
      i = end + 1;
      continue;
    }

    if (c === '`') {
      const end = str.indexOf('`', i + 1);
      if (end === -1) { tokens.push(str.slice(i)); break; }
      // backtick strings: strip backticks, keep inner content as-is
      tokens.push(str.slice(i + 1, end));
      i = end + 1;
      continue;
    }

    // bare word
    let j = i;
    while (j < str.length && str[j] !== ' ' && str[j] !== '\t') j++;
    tokens.push(str.slice(i, j));
    i = j;
  }
  return tokens;
}

// strip quotes from a token
function _esStrip(s) {
  if (!s) return '';
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// clean name (no quotes, trimmed)
function _esName(tok) {
  return _esStrip(tok || '');
}

// ── attribute lines (same rules as the main parser) ──

// one attribute line → [key, values]
function _esAttrLine(stripped) {
  let key, rest;
  const qk = stripped.match(/^"([^"]+)"\s*(.*)$/) ||
             stripped.match(/^`([^`]+)`\s*(.*)$/) ||
             stripped.match(/^'([^']+)'\s*(.*)$/);
  if (qk) {
    key = qk[1]; rest = qk[2].trim();
  } else {
    const sp = stripped.indexOf(' ');
    if (sp === -1) { key = stripped; rest = ''; }
    else { key = stripped.slice(0, sp); rest = stripped.slice(sp + 1).trim(); }
  }
  if (!key) return null;
  if (rest === '') return [key, [true]];

  const qv = rest.match(/^"([^"]*)"$/) || rest.match(/^`([^`]*)`$/) || rest.match(/^'([^']*)'$/);
  if (qv) return [key, [qv[1]]];

  const qvPlus = rest.match(/^"([^"]*)"\s+(.+)$/) ||
                 rest.match(/^`([^`]*)`\s+(.+)$/) ||
                 rest.match(/^'([^']*)'\s+(.+)$/);
  if (qvPlus) return [key, [qvPlus[1]]];

  const tokens = rest.split(/\s+/);
  const isNumericToken = t => /^-?[\d.]+$/.test(t);
  if (tokens.every(isNumericToken)) {
    return [key, tokens.map(t => parseFloat(t))];
  }

  return [key, [rest]];
}

// add a parsed line to an attribute bag (repeated keys add up / become lists)
function _esMergeAttr(data, key, values) {
  let outerKey = key;
  if (outerKey in data) {
    let n = 2;
    while ((`${key}_${n}`) in data) n++;
    outerKey = `${key}_${n}`;
  }
  if (values.length === 1) {
    data[outerKey] = values[0];
  } else {
    const nested = {};
    values.forEach((v, idx) => { nested[`${outerKey}_${idx + 1}`] = v; });
    data[outerKey] = nested;
  }
}

// ── indentation tree for mission blocks ──
function _esBuildRawTree(rawLines, baseIndent) {
  // each line → { indent, key, values }
  const parsedLines = rawLines.map(({ indent, text }) => {
    // two-word mission keywords ("to offer", "on complete" …) stay together
    const bareTwoWord = text.match(/^(to|on)\s+([a-zA-Z][a-zA-Z]*)\b\s*(.*)$/);
    if (bareTwoWord) {
      const [, lead, second, rest] = bareTwoWord;
      const values = [second];
      // A trailing argument, e.g. `on enter "Some System"`, becomes an
      // additional value; a bare structural line like `to offer` has none.
      if (rest) values.push(_esName(rest));
      return { indent, key: lead, values };
    }
    const [key, values] = _esAttrLine(text) || [text, []];
    return { indent, key, values: values === true ? [] : (Array.isArray(values) ? values.filter(v => v !== true) : []) };
  });

  // build the tree with a stack (one node per depth)
  const root = [];
  const stack = [{ indent: baseIndent - 1, children: root }];

  for (const line of parsedLines) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= line.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    const node = { key: line.key, values: line.values, children: [] };
    parent.children.push(node);
    stack.push({ indent: line.indent, children: node.children, node });
  }

  // drop empty children lists
  const prune = nodes => {
    for (const n of nodes) {
      if (n.children.length) prune(n.children);
      else delete n.children;
    }
  };
  prune(root);
  return root;
}


// empty ship
function _esBlankShip() {
  return {
    id: Date.now() + Math.random(),
    // Identity
    name: '',         // model/class name e.g. "Peregrine"
    customName: '',   // in-game pilot-given name e.g. "Great Fox"
    variant: '',
    plural: '',
    displayName: '',
    sprite: '',
    thumbnail: '',
    description: '',
    mass: '',
    drag: '',
    // Stats
    attributes: {},
    weapon: { 'blast radius': 0, 'shield damage': 0, 'hull damage': 0, 'hit force': 0 },
    // Loadout
    outfits: [],
    // Hardpoints
    guns: [],
    turrets: [],
    drones: [],
    fighters: [],
    engines: [],
    reverseEngines: [],
    steeringEngines: [],
    // Effects
    leaks: [],
    explode: [],
    finalExplode: [],
    extraLines: [],
    // Save-file metadata
    _modelName: '',
    _customName: '',
    _uuid: '',
    _swizzle: null,
    _crew: null,
    _fuel: null,
    _shields: null,
    _hull: null,
    _position: null,
    _system: '',
    _planet: '',
    _parked: false,
    _formation: '',
    _groups: null,       // fleet hotkey group(s) — see pendingGroups note in parseESSaveFile
    _sourceShip: null,
    _sourcePlugin: null,
  };
}

// an engine / hardpoint line
function _esMakeEngineEntry(coords) {
  return { coords, zoom: '', angle: '', gimbal: '', over: false, under: false, extra: {} };
}
// a steering engine line
function _esMakeSteeringEntry(coords) {
  return { coords, zoom: '', angle: '', gimbal: '', over: false, under: false, side: '', extra: {} };
}

// a bay line
function _esMakeBayEntry(coords) {
  return { coords, angle: '', launchEffect: '', extra: {} };
}

// the whole save → { pilot, ships, missions, … }. Called by: saveManager, saveEditor, the Node tests
function parseESSaveFile(text) {
  const lines = text.split('\n');

  // ── Result containers ──
  const result = {
    pilot: {
      name: '',
      originalName: '',
      date: '',
      system: '',
      planet: '',
      playtime: null,
      flagshipIndex: null,
      reputations: {},
      conditions: {},
      raw: {},          // other top-level key→value pairs we don't specially handle
    },
    ships: [],
    missions: [],        // see "MISSION BLOCK PARSING" below for shape + caveats
    storage: [],        // [{ planet, cargo: { outfits: {name→count}, commodities: {} } }]
    licenses: [],
    plugins: [],         // installed plugin names, exactly as written in the save file
    account: { credits: 0, score: 0, salaries: {}, history: [] },
    cargo: { outfits: {}, commodities: {} },
    // blocks without their own handler are kept as-is
    blocks: {},
  };

  // ── Parser state ──
  let topBlock    = null;   // current top-level block name
  let cur         = null;   // current ship being built
  let attrBlock   = false;  // inside ship > attributes
  let outfitBlock = false;  // inside ship > outfits
  let attrSub     = null;   // 'licenses' | 'weapon' | null
  let lastHP      = null;   // { type:'engine'|'reverseEngine'|'steeringEngine'|'gun'|'turret'|'bay', arr, idx }
  let lastBayArr  = null;   // pointer to the bay array being filled
  let lastBayIdx  = -1;

  // Sprite sub-block: indent-2 lines under sprite/thumbnail are sprite params, skip them
  let inSpriteBlock = false;

  // storage parser state
  let storageEntry   = null;   // { planet, cargo }
  let inStorageCargo = false;
  let inStorageOutfits = false;

  // account parser state
  let inAccountSalaries = false;
  let inAccountHistory  = false;

  // cargo (player carried) parser state
  let inTopCargo       = false;
  let inTopCargoOutfits = false; let inTopCargoCommodities = false; let inStorageCommodities = false;

  // reputation block
  let inReputation = false;

  // conditions block
  let inConditions = false;

  // mission blocks are captured as raw trees
  let missionName   = null;   // identifier of the mission currently being captured
  // `groups N` comes after the ship it belongs to
  let pendingGroups = null;   // kept for compatibility; no longer used
  let lastShip = null;
  let missionBuffer = [];     // [{ indent, text }] for every line inside it so far

  // ── any other top-level block is kept verbatim ──
  let genericBlockName = null;   // e.g. 'event', 'changes', 'visited'
  let genericBlockArg  = null;   // the block's own quoted argument, if any
  let genericBuffer    = [];     // [{ indent, text }] for the currently open block

  // ── Line iterator ──
  for (let li = 0; li < lines.length; li++) {
    const raw    = lines[li];
    const t      = raw.trim();
    if (!t || t.startsWith('#')) continue;

    const indent = raw.length - raw.trimStart().length;
    const toks   = _esTok(t);
    const key0   = _esStrip(toks[0] || '');

    // ── top level ──
    if (indent === 0) {
      // Close any open ship
      if (cur) { result.ships.push(cur); cur = null; }

      // Close any open mission capture
      if (missionName !== null) {
        result.missions.push({ name: missionName, raw: _esBuildRawTree(missionBuffer, 1) });
        missionName   = null;
        missionBuffer = [];
      }

      // Close any open generic block capture
      if (genericBlockName !== null) {
        (result.blocks[genericBlockName] = result.blocks[genericBlockName] || [])
          .push({ name: genericBlockArg, raw: _esBuildRawTree(genericBuffer, 1) });
        genericBlockName = null;
        genericBlockArg  = null;
        genericBuffer    = [];
      }

      // Reset all block flags
      attrBlock = false; outfitBlock = false; attrSub = null;
      lastHP = null; lastBayArr = null; lastBayIdx = -1;
      inSpriteBlock = false;
      storageEntry = null; inStorageCargo = false; inStorageOutfits = false;
      inAccountSalaries = false; inAccountHistory = false;
      inTopCargo = false; inTopCargoOutfits = false;
      inReputation = false; inConditions = false;

      topBlock = key0;
      // forget a stashed `groups` unless this line is its ship
      if (key0 !== 'ship' && key0 !== 'groups') pendingGroups = null;

      // ── ship ──
      if (key0 === 'ship') {
        cur = _esBlankShip();
        // model name is toks[1]; save files don't have variants at this line
        cur._modelName = _esName(toks[1] || '');
        cur.name       = cur._modelName;
        lastShip       = cur;
        continue;
      }

      if (key0 === 'groups') { if (lastShip) lastShip._groups = toks[1] != null ? _esName(toks[1]) : null; continue; }

      // ── pilot header fields ──
      if (key0 === 'pilot')              { result.pilot.name         = toks.slice(1).map(_esName).join(' '); continue; }
      if (key0 === 'original name')    { result.pilot.originalName = toks.slice(1).map(_esName).join(' '); continue; }
      if (key0 === 'date')               { result.pilot.date         = toks.slice(1).join(' '); continue; }
      if (key0 === 'system')             { result.pilot.system       = _esName(toks[1]); continue; }
      if (key0 === 'planet')             { result.pilot.planet       = _esName(toks[1]); continue; }
      if (key0 === 'playtime')           { result.pilot.playtime     = parseFloat(toks[1]) || 0; continue; }
      if (key0 === 'flagship index')   { result.pilot.flagshipIndex= parseInt(toks[1]) || 0; continue; }
      if (key0 === 'reputation with')  { inReputation = true; continue; }
      if (key0 === 'conditions')         { inConditions = true; continue; }
      if (key0 === 'licenses')           { topBlock = 'licenses'; continue; }
      if (key0 === 'plugins')            { topBlock = 'plugins'; continue; }
      if (key0 === 'account')            { topBlock = 'account'; continue; }
      if (key0 === 'storage')            { topBlock = 'storage'; continue; }
      if (key0 === 'cargo')              { inTopCargo = true; topBlock = 'cargo'; continue; }
      if (key0 === 'mission') {
        // capture this mission block
        topBlock    = 'mission';
        missionName = _esName(toks[1] || '');
        missionBuffer = [];
        continue;
      }
      // event / changes / economy / visited … go to the generic capture

      // anything else: generic capture
      result.pilot.raw[key0] = toks.slice(1).join(' ');
      genericBlockName = key0;
      genericBlockArg  = toks[1] != null ? _esName(toks[1]) : null;
      genericBuffer    = [];
      continue;
    }

    // ── blocks kept verbatim ──
    if (topBlock === 'mission') {
      // Capture verbatim for _esBuildRawTree() rather than discarding —
      // see the MISSION BLOCK PARSING note at the top of this file.
      missionBuffer.push({ indent, text: t });
      continue;
    }
    if (genericBlockName !== null) {
      genericBuffer.push({ indent, text: t });
      continue;
    }

    // ── reputation ──
    if (inReputation && indent === 1) {
      const faction = _esName(toks[0]);
      const val     = parseFloat(toks[1]) || 0;
      result.pilot.reputations[faction] = val;
      continue;
    }

    // ── conditions ──
    if (inConditions && indent === 1) {
      const ckey = _esName(toks[0]);
      const cval = toks[1] != null ? (parseFloat(toks[1]) || toks[1]) : true;
      result.pilot.conditions[ckey] = cval;
      continue;
    }

    // ── licences ──
    if (topBlock === 'licenses' && indent === 1) {
      result.licenses.push(_esName(toks[0]));
      continue;
    }

    // ── plugins (the save lists the plugins it was made with) ──
    if (topBlock === 'plugins' && indent === 1) {
      result.plugins.push(_esName(toks[0]));
      continue;
    }

    // ── account ──
    if (topBlock === 'account') {
      if (indent === 1) {
        inAccountSalaries = false;
        inAccountHistory  = false;
        if (key0 === 'credits')           { result.account.credits = parseInt(toks[1]) || 0; continue; }
        if (key0 === 'score')             { result.account.score   = parseInt(toks[1]) || 0; continue; }
        if (key0 === 'salaries income') { inAccountSalaries = true; continue; }
        if (key0 === 'history')           { inAccountHistory  = true; continue; }
        continue;
      }
      if (indent === 2) {
        if (inAccountSalaries) { result.account.salaries[_esName(toks[0])] = parseInt(toks[1]) || 0; continue; }
        if (inAccountHistory)  { result.account.history.push(parseInt(toks[0]) || 0); continue; }
      }
      continue;
    }

    // ── cargo ──
    if (topBlock === 'cargo') {
      if (indent === 1) {
        inTopCargoOutfits = (key0 === 'outfits');
        inTopCargoCommodities = (key0 === 'commodities');
        continue;
      }
      if (indent === 2 && inTopCargoOutfits) {
        const oname = _esName(toks[0]);
        const ocount = parseInt(toks[1]) || 1;
        result.cargo.outfits[oname] = (result.cargo.outfits[oname] || 0) + ocount;
        continue;
      }
      // commodities (tons) — CargoHold::Save writes them before outfits
      if (indent === 2 && inTopCargoCommodities) {
        const cname = _esName(toks[0]);
        result.cargo.commodities[cname] = (result.cargo.commodities[cname] || 0) + (parseInt(toks[1]) || 0);
        continue;
      }
      continue;
    }

    // ── storage ──
    if (topBlock === 'storage') {
      if (indent === 1) {
        // new planet
        storageEntry = { planet: _esName(toks[1]), cargo: { outfits: {}, commodities: {} } };
        result.storage.push(storageEntry);
        inStorageCargo   = false;
        inStorageOutfits = false;
        continue;
      }
      if (indent === 2 && key0 === 'cargo')   { inStorageCargo = true; inStorageOutfits = false; inStorageCommodities = false; continue; }
      if (indent === 3) { inStorageOutfits = key0 === 'outfits'; inStorageCommodities = key0 === 'commodities'; continue; }
      if (indent === 4 && storageEntry && inStorageCommodities) {
        const cname = _esName(toks[0]);
        storageEntry.cargo.commodities[cname] = (storageEntry.cargo.commodities[cname] || 0) + (parseInt(toks[1]) || 0);
        continue;
      }
      if (indent === 4 && storageEntry && inStorageOutfits) {
        const oname  = _esName(toks[0]);
        const ocount = parseInt(toks[1]) || 1;
        storageEntry.cargo.outfits[oname] = (storageEntry.cargo.outfits[oname] || 0) + ocount;
        continue;
      }
      continue;
    }

    // ── ship ──
    if (!cur) continue;

    // ── indent 1 ──
    if (indent === 1) {
      // Leaving any sub-blocks
      attrBlock   = false;
      outfitBlock = false;
      attrSub     = null;
      lastHP      = null;
      lastBayArr  = null;
      lastBayIdx  = -1;
      inSpriteBlock = false;

      if (key0 === 'name')       { cur._customName = _esName(toks[1]); cur.customName = cur._customName; continue; }
      if (key0 === 'plural')     { cur.plural    = _esName(toks[1]); continue; }
      if (key0 === 'display name') { cur.displayName = _esName(toks[1]); continue; }
      if (key0 === 'thumbnail')  { cur.thumbnail = _esName(toks[1]); continue; }
      if (key0 === 'uuid')       { cur._uuid     = toks[1] || ''; continue; }
      if (key0 === 'swizzle')    { cur._swizzle  = parseInt(toks[1]) || 0; continue; }
      if (key0 === 'crew')       { cur._crew     = parseInt(toks[1]) || 0; continue; }
      if (key0 === 'fuel')       { cur._fuel     = parseFloat(toks[1]) || 0; continue; }
      if (key0 === 'shields')    { cur._shields  = parseFloat(toks[1]) || 0; continue; }
      if (key0 === 'hull')       { cur._hull     = parseFloat(toks[1]) || 0; continue; }
      if (key0 === 'system')     { cur._system   = _esName(toks[1]); continue; }
      if (key0 === 'planet')     { cur._planet   = _esName(toks[1]); continue; }
      if (key0 === 'parked')     { cur._parked   = true; continue; }
      if (key0 === 'formation')  { cur._formation = _esName(toks[1]); continue; }

      if (key0 === 'position') {
        cur._position = { x: parseFloat(toks[1]) || 0, y: parseFloat(toks[2]) || 0 };
        continue;
      }

      if (key0 === 'sprite') {
        cur.sprite    = _esName(toks[1]);
        inSpriteBlock = true;   // next indent-2 lines are sprite animation params
        continue;
      }

      if (key0 === 'description') {
        const para = _esName(toks.slice(1).join(' '));
        cur.description = cur.description ? cur.description + '\n' + para : para;
        continue;
      }

      if (key0 === 'attributes') { attrBlock = true; continue; }
      if (key0 === 'outfits')    { outfitBlock = true; continue; }

      // ── engine / reverse engine / steering engine ──
      if (key0 === 'engine') {
        const coords = toks.slice(1, 3).join(' ');
        const entry  = _esMakeEngineEntry(coords);
        // Optional inline zoom as a 3rd token: `engine x y [zoom]`
        if (toks[3] != null && toks[3] !== '') {
          const z = parseFloat(toks[3]);
          if (!isNaN(z)) { entry.zoom = z; entry.extra.zoom = z; }
        }
        cur.engines.push(entry);
        lastHP = { type: 'engine', arr: cur.engines, idx: cur.engines.length - 1 };
        continue;
      }
      if (key0 === 'reverse engine') {
        const coords = toks.slice(1, 3).join(' ');
        const entry  = _esMakeEngineEntry(coords);
        if (toks[3] != null && toks[3] !== '') {
          const z = parseFloat(toks[3]);
          if (!isNaN(z)) { entry.zoom = z; entry.extra.zoom = z; }
        }
        cur.reverseEngines.push(entry);
        lastHP = { type: 'reverseEngine', arr: cur.reverseEngines, idx: cur.reverseEngines.length - 1 };
        continue;
      }
      if (key0 === 'steering engine') {
        const coords = toks.slice(1, 3).join(' ');
        const entry  = _esMakeSteeringEntry(coords);
        if (toks[3] != null && toks[3] !== '') {
          const z = parseFloat(toks[3]);
          if (!isNaN(z)) { entry.zoom = z; entry.extra.zoom = z; }
        }
        cur.steeringEngines.push(entry);
        lastHP = { type: 'steeringEngine', arr: cur.steeringEngines, idx: cur.steeringEngines.length - 1 };
        continue;
      }

      // ── gun / turret ──
      if (key0 === 'gun') {
        const coords = toks.slice(1, 3).join(' ');
        const over   = toks[3] ? _esName(toks[3]) : '';
        cur.guns.push({ coords, over, extra: {} });
        lastHP = { type: 'gun', arr: cur.guns, idx: cur.guns.length - 1 };
        continue;
      }
      if (key0 === 'turret') {
        const coords = toks.slice(1, 3).join(' ');
        const over   = toks[3] ? _esName(toks[3]) : '';
        cur.turrets.push({ coords, over, extra: {} });
        lastHP = { type: 'turret', arr: cur.turrets, idx: cur.turrets.length - 1 };
        continue;
      }

      // ── bay ──
      if (key0 === 'bay') {
        const bayType  = _esName(toks[1] || '');
        const coords   = toks.slice(2, 4).join(' ');
        const entry    = _esMakeBayEntry(coords);
        if (bayType === 'Fighter') {
          cur.fighters.push(entry);
          lastBayArr = cur.fighters;
          lastBayIdx = cur.fighters.length - 1;
        } else {
          // Drone or anything else
          cur.drones.push(entry);
          lastBayArr = cur.drones;
          lastBayIdx = cur.drones.length - 1;
        }
        lastHP = null;  // bay sub-lines handled separately
        continue;
      }

      // leak "effect" openChance spreadChance
      if (key0 === 'leak') {
        cur.leaks.push({
          name:         _esName(toks[1] || ''),
          openChance:   parseInt(toks[2]) || 0,
          spreadChance: parseInt(toks[3]) || 0,
        });
        continue;
      }

      // ── explode / final explode ──
      if (key0 === 'explode') {
        cur.explode.push({
          name:  _esName(toks[1] || 'tiny explosion'),
          count: parseInt(toks[2]) || 1,
        });
        continue;
      }
      if (key0 === 'final explode') {
        cur.finalExplode.push({
          name:  _esName(toks[1] || ''),
          count: parseInt(toks[2]) || 1,
        });
        continue;
      }

      // Anything else at indent-1 inside a ship → extraLines
      cur.extraLines.push(raw);
      continue;
    }

    // ── indent 2 ──
    if (indent === 2) {

      // Sprite animation sub-params — just skip
      if (inSpriteBlock) continue;

      // engine / turret / gun details, kept generically
      if (lastHP && lastHP.arr) {
        const entry = lastHP.arr[lastHP.idx];
        entry.extra = entry.extra || {};
        const parsed = _esAttrLine(t);
        if (parsed) {
          const [k, v] = parsed;
          _esMergeAttr(entry.extra, k, v);
          if (lastHP.type !== 'gun' && lastHP.type !== 'turret') {
            const scalar = v.length === 1 ? v[0] : null;
            if (k === 'zoom'   && scalar != null && entry.zoom   === '') entry.zoom   = scalar;
            if (k === 'angle'  && scalar != null && entry.angle  === '') entry.angle  = scalar;
            if (k === 'gimbal' && scalar != null && entry.gimbal === '') entry.gimbal = scalar;
            if (k === 'over')  entry.over  = true;
            if (k === 'under') entry.under = true;
            if (lastHP.type === 'steeringEngine') {
              if (k === 'left')  entry.side = 'left';
              if (k === 'right') entry.side = 'right';
            }
          }
          continue;
        }
      }

      // ── bay sub-properties ──
      if (lastBayArr && lastBayIdx >= 0) {
        const bayEntry = lastBayArr[lastBayIdx];
        bayEntry.extra = bayEntry.extra || {};
        const parsed = _esAttrLine(t);
        if (parsed) {
          const [k, v] = parsed;
          const scalar = v.length === 1 ? v[0] : null;
          if (k === 'launch effect') { bayEntry.launchEffect = scalar != null ? scalar : v.join(' '); continue; }
          if (k === 'angle' && bayEntry.angle === '' && scalar != null) { bayEntry.angle = scalar; continue; }
          _esMergeAttr(bayEntry.extra, k, v);
          continue;
        }
      }

      // ── attributes block ──
      if (attrBlock) {
        if (!toks.length) continue;

        if (key0 === 'licenses') { attrSub = 'licenses'; cur.attributes.licenses = cur.attributes.licenses || {}; continue; }
        if (key0 === 'weapon')   {
          attrSub = 'weapon';
          // replace the placeholder weapon values with the real ones
          cur.weapon = {};
          continue;
        }
        // sprite / flare / sound sub-entries inside attributes — just skip
        if (key0 === 'flare sprite' || key0 === 'reverse flare sprite' ||
            key0 === 'steering flare sprite' || key0 === 'flare sound' ||
            key0 === 'reverse flare sound' || key0 === 'steering flare sound') {
          attrSub = 'spriteParam'; continue;
        }
        if (attrSub === 'spriteParam') {
          // Check if still at indent 2 — this line IS at indent 2, so it's a new attr
          // (the frame rate sub-line would be at indent 3, handled below)
          attrSub = null;
        }

        const valStr = toks.slice(1).join(' ');
        if (key0 === 'mass') { cur.mass = valStr; continue; }
        if (key0 === 'drag') { cur.drag = valStr; continue; }
        cur.attributes[key0] = valStr;
        continue;
      }

      // ── outfits block ──
      if (outfitBlock) {
        // toks[0] is the outfit name (may be quoted or bare or backtick-stripped)
        const oname  = _esName(toks[0]);
        const ocount = parseInt(toks[1]) || 1;
        // Check if we already have this outfit (aggregate duplicates)
        const existing = cur.outfits.find(o => o.name === oname);
        if (existing) {
          existing.count += ocount;
        } else {
          cur.outfits.push({ name: oname, count: ocount, pluginId: null });
        }
        continue;
      }

      // fallthrough
      cur.extraLines.push(raw);
      continue;
    }

    // ── indent 3 ──
    if (indent === 3) {
      if (attrBlock) {
        if (attrSub === 'licenses') {
          cur.attributes.licenses[_esName(toks[0])] = true;
          continue;
        }
        if (attrSub === 'weapon') {
          // nested attributes merged like outfit weapon blocks
          const parsed = _esAttrLine(t);
          if (parsed) {
            const [k, v] = parsed;
            _esMergeAttr(cur.weapon, k, v);
          }
          continue;
        }
        // sub-params of flare sprites (frame rate, rewind, etc.) — skip
        continue;
      }
      // Steering engine left/right can appear at indent 3 in some formats
      if (lastHP && lastHP.type === 'steeringEngine') {
        const entry = lastHP.arr[lastHP.idx];
        if (key0 === 'left')  { entry.side = 'left';  entry.extra.left  = true; continue; }
        if (key0 === 'right') { entry.side = 'right'; entry.extra.right = true; continue; }
      }
      cur.extraLines.push(raw);
      continue;
    }

    // Deeper indents — skip / extraLines
    if (cur) cur.extraLines.push(raw);
  }

  // Don't forget the last ship
  if (cur) result.ships.push(cur);
  // ...or the last mission, if the file ends mid-block
  if (missionName !== null) {
    result.missions.push({ name: missionName, raw: _esBuildRawTree(missionBuffer, 1) });
  }
  // ...or the last generically-captured block
  if (genericBlockName !== null) {
    (result.blocks[genericBlockName] = result.blocks[genericBlockName] || [])
      .push({ name: genericBlockArg, raw: _esBuildRawTree(genericBuffer, 1) });
  }

  // Convenience aliases onto generic-block names callers are most likely to
  // want directly, without digging into `result.blocks`.
  result.events  = result.blocks.event  || [];
  result.changes = result.blocks.changes || [];

  // "available job" is its own keyword (not "mission")
  result.availableJobs = result.blocks['available job'] || [];

  // visited / visited planet are single lines, not blocks
  result.visitedSystems = (result.blocks.visited || []).map(b => b.name).filter(Boolean);
  result.visitedPlanets = (result.blocks['visited planet'] || []).map(b => b.name).filter(Boolean);

  // `harvested` is a single block listing flat material names with no
  // values — flatten to a plain string list for the same reason.
  result.harvested = ((result.blocks.harvested || [])[0]?.raw || []).map(n => n.key);

  return result;
}

// ── helpers ──

// save ship → builder design
function saveShipToBuilderFormat(ship) {
  return {
    id:          ship.id,
    name:        ship._modelName,     // model/class name used by shipBuilder as "name"
    customName:  ship._customName,    // pilot-assigned name — extra field not in original format
    variant:     ship.variant   || '',
    plural:      ship.plural    || '',
    displayName: ship.displayName || '',
    sprite:      ship.sprite    || '',
    thumbnail:   ship.thumbnail || '',
    description: ship.description || '',
    mass:        ship.mass || '',
    drag:        ship.drag || '',
    attributes:  { ...ship.attributes },
    weapon:      { ...ship.weapon },
    outfits:     ship.outfits.map(o => ({ ...o })),
    guns:        ship.guns.map(g => ({ coords: g.coords, over: g.over, extra: { ...(g.extra || {}) } })),
    turrets:     ship.turrets.map(g => ({ coords: g.coords, over: g.over, extra: { ...(g.extra || {}) } })),
    drones:      ship.drones.map(d => ({ coords: d.coords, launchEffect: d.launchEffect, extra: { ...(d.extra || {}) } })),
    fighters:    ship.fighters.map(f => ({ coords: f.coords, launchEffect: f.launchEffect, extra: { ...(f.extra || {}) } })),
    engines:     ship.engines.map(e => ({ coords: e.coords, zoom: e.zoom, angle: e.angle, gimbal: e.gimbal, extra: { ...(e.extra || {}) } })),
    reverseEngines:  ship.reverseEngines.map(e => ({ coords: e.coords, zoom: e.zoom, angle: e.angle, gimbal: e.gimbal, extra: { ...(e.extra || {}) } })),
    steeringEngines: ship.steeringEngines.map(e => ({ coords: e.coords, zoom: e.zoom, angle: e.angle, gimbal: e.gimbal, side: e.side, extra: { ...(e.extra || {}) } })),
    leaks:       ship.leaks.map(l => ({ ...l })),
    explode:     ship.explode.map(e => ({ ...e })),
    finalExplode: ship.finalExplode.map(e => ({ ...e })),
    extraLines:  [...ship.extraLines],
    _sourceShip:   ship._modelName || null,
    _sourcePlugin: null,
    // Save-file fields preserved
    _uuid:       ship._uuid,
    _swizzle:    ship._swizzle,
    _crew:       ship._crew,
    _fuel:       ship._fuel,
    _shields:    ship._shields,
    _hull:       ship._hull,
    _position:   ship._position,
    _system:     ship._system,
    _planet:     ship._planet,
    _parked:     ship._parked,
    _formation:  ship._formation,
  };
}

// ── in the browser: read an <input type=file> ──
async function parseSaveFileFromInput(fileInput) {
  const file = fileInput.files[0];
  if (!file) throw new Error('No file selected');
  const text = await file.text();
  return parseESSaveFile(text);
}

// ── in Node ──
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseESSaveFile, saveShipToBuilderFormat, parseSaveFileFromInput, _esAttrLine, _esMergeAttr };
}