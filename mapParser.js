// Parses the game's map data (galaxies, systems, planets, wormholes, stars, governments) and merges every plugin's changes. Used by parser.js.

'use strict';

const crypto = require('crypto');

// indent depth of a line

function indentOf(line) {
  return line.length - line.replace(/^\t+/, '').length;
}

// `keyword "Name"` → Name
function matchNamedLine(stripped, keyword) {
  const re = new RegExp(`^${keyword}\\s+(?:"([^"]+)"|\`([^\`]+)\`|(\\S+))\\s*$`);
  const m = stripped.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

// same, allowing more tokens after the name
function matchNamedLinePrefix(stripped, keyword) {
  const re = new RegExp(`^${keyword}\\s+(?:"([^"]+)"|\`([^\`]+)\`|(\\S+))(?:\\s+(.*))?$`);
  const m = stripped.match(re);
  if (!m) return null;
  return { name: m[1] ?? m[2] ?? m[3] ?? null, rest: (m[4] || '').trim() };
}

// skip an indented block
function skipIndentedBlock(lines, i, baseIndent) {
  i++;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (indentOf(l) <= baseIndent) break;
    i++;
  }
  return i;
}

// one attribute line → [key, values]
function parseNumericAwareLine(stripped) {
  let key, rest;
  const qk = stripped.match(/^"([^"]+)"\s*(.*)$/) ||
             stripped.match(/^`([^`]+)`\s*(.*)$/) ||
             stripped.match(/^'([^']+)'\s*(.*)$/);
  if (qk) { key = qk[1]; rest = qk[2].trim(); }
  else {
    const sp = stripped.indexOf(' ');
    if (sp === -1) { key = stripped; rest = ''; }
    else { key = stripped.slice(0, sp); rest = stripped.slice(sp + 1).trim(); }
  }
  if (!key) return null;
  if (rest === '') return [key, [true]];

  const qv = rest.match(/^"([^"]+)"$/) || rest.match(/^`([^`]+)`$/) || rest.match(/^'([^']+)'$/);
  if (qv) return [key, [qv[1]]];

  const tokens = rest.split(/\s+/);
  const isNum = t => /^-?[\d.]+$/.test(t);
  if (tokens.every(isNum)) return [key, tokens.map(Number)];
  return [key, [rest]];
}

// a nested key/value block
function parseGenericBlock(lines, startIdx, baseIndent) {
  const data = {};
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const indent = indentOf(line);
    if (indent <= baseIndent) break;
    const stripped = line.trim();
    if (i + 1 < lines.length && indentOf(lines[i + 1]) > indent) {
      const key = stripped.replace(/^["'`]([^"'`]+)["'`]$/, '$1');
      const [nd, ni] = parseGenericBlock(lines, i + 1, indent);
      if (key in data) {
        if (!Array.isArray(data[key])) data[key] = [data[key]];
        data[key].push(nd);
      } else data[key] = nd;
      i = ni; continue;
    }
    const kv = parseNumericAwareLine(stripped);
    if (kv) {
      const [k, v] = kv;
      const val = v.length === 1 ? v[0] : v;
      if (k in data) {
        if (!Array.isArray(data[k])) data[k] = [data[k]];
        data[k].push(val);
      } else data[k] = val;
    }
    i++;
  }
  return [data, i];
}

// a multi-line text block (descriptions)
function parseTextBlock(lines, i, baseIndent, keyword) {
  const stripped = lines[i].trim();
  const single = stripped.match(new RegExp(`^${keyword}\\s+"([^"]*)"$`)) ||
                 stripped.match(new RegExp(`^${keyword}\\s+\`([^\`]*)\`$`));
  if (single) {
    // still need to check for a following `to display` sub-block
    return maybeAttachToDisplay(lines, i + 1, baseIndent, single[1]);
  }
  const start = stripped.match(new RegExp(`^${keyword}\\s+"(.*)$`)) ||
                stripped.match(new RegExp(`^${keyword}\\s+\`(.*)$`));
  const textLines = [];
  if (start) {
    const st = start[1];
    if (st.endsWith('`') || st.endsWith('"')) {
      return maybeAttachToDisplay(lines, i + 1, baseIndent, st.slice(0, -1));
    }
    if (st) textLines.push(st);
    i++;
    while (i < lines.length) {
      const dl = lines[i], ds = dl.trim();
      if (ds.endsWith('`') || ds.endsWith('"')) {
        if (ds.slice(0, -1)) textLines.push(ds.slice(0, -1));
        return maybeAttachToDisplay(lines, i + 1, baseIndent, textLines.join(' '));
      }
      if (indentOf(dl) <= baseIndent && dl.trim()) break;
      if (ds) textLines.push(ds);
      i++;
    }
    return maybeAttachToDisplay(lines, i, baseIndent, textLines.join(' '));
  }
  // bare `description` / `spaceport` header with indented body lines
  i++;
  while (i < lines.length) {
    const dl = lines[i];
    if (indentOf(dl) <= baseIndent) break;
    if (dl.trim()) textLines.push(dl.trim());
    i++;
  }
  return [{ text: textLines.join(' '), toDisplay: null }, i];
}

// attach a description
function maybeAttachToDisplay(lines, i, baseIndent, text) {
  if (i < lines.length && lines[i].trim() === 'to display' && indentOf(lines[i]) === baseIndent + 1) {
    const toDisplayIndent = indentOf(lines[i]);
    const toDisplay = [];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      if (indentOf(l) <= toDisplayIndent) break;
      toDisplay.push(l.trim());
      i++;
    }
    return [{ text, toDisplay }, i];
  }
  return [{ text, toDisplay: null }, i];
}

// split a line like the game does (quotes, backticks)

function tokenizeESLine(line) {
  const tokens = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    const ch = line[i];
    if (ch === '"' || ch === '`' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n && line[j] !== quote) j++;
      tokens.push(line.slice(i + 1, j));
      i = (j < n) ? j + 1 : j;
    } else {
      let j = i;
      while (j < n && !/\s/.test(line[j])) j++;
      tokens.push(line.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

// token → number
function coerceToken(tok) {
  if (tok !== '' && /^-?\d+(\.\d+)?$/.test(tok)) return parseFloat(tok);
  return tok;
}

// indentation tree
function parseIndentTree(lines, startIdx, baseIndent) {
  const entries = [];
  let i = startIdx;
  while (i < lines.length) {
    const rawLine = lines[i];
    if (!rawLine.trim()) { i++; continue; }
    const indent = indentOf(rawLine);
    if (indent < baseIndent) break;
    const stripped = rawLine.trim();
    if (stripped.startsWith('#')) { i++; continue; }

    const tokens = tokenizeESLine(stripped);
    const key = tokens.length > 0 ? tokens[0] : stripped;
    const values = tokens.slice(1).map(coerceToken);
    i++;

    let k = i;
    while (k < lines.length && !lines[k].trim()) k++;
    let children = null;
    if (k < lines.length && indentOf(lines[k]) > baseIndent) {
      const [childEntries, ni] = parseIndentTree(lines, k, indentOf(lines[k]));
      children = childEntries;
      i = ni;
    }
    entries.push({ key, values, children });
  }
  return [entries, i];
}

// { name, count, pluginId, internalId } reference
function namedRef(name, pluginId, kind, extra = {}) {
  return {
    name,
    count: 1,
    pluginId: pluginId ?? null,
    internalId: (pluginId && name) ? `${pluginId}::${kind}:${name}` : null,
    ...extra,
  };
}

// merge reference lists (counts add up)
function mergeNamedRefList(existing, incoming) {
  for (const ref of incoming) {
    const dupe = existing.find(e => e.name === ref.name);
    if (dupe) { dupe.count += ref.count; }
    else existing.push({ ...ref });
  }
  return existing;
}

// ---------------------------------------------------------------------------
class EndlessSkyMapParser {
  constructor() {
    this.galaxies  = new Map(); // name -> galaxy node
    this.systems   = new Map(); // name -> system node
    this.planets   = new Map(); // name -> planet node
    this.wormholes = new Map(); // name -> wormhole node
    this.stars     = [];        // solar-attribute blocks, order doesn't matter
    this.governments = [];      // government color/swizzle blocks, order doesn't matter
    this.namedColors = new Map(); // name -> [r,g,b], from standalone `color "Name" r g b` lines
    this.landingMessages = [];

    this._sourcePriority = new Map();
  }

  setSourcePriority(sources) {
    this._sourcePriority.clear();
    sources.forEach((source, index) => this._sourcePriority.set(source.name, index));
  }

  // new entity, stamped with its first plugin
  _stampNew(node, name, pluginId) {
    node.name        = name;
    node._pluginId   = pluginId;
    node._internalId = `${pluginId}::${name}`;
    node._definedBy  = [pluginId];
    node._lastModifiedBy = pluginId;
    return node;
  }

  _stampTouched(node, pluginId) {
    if (!node._definedBy.includes(pluginId)) node._definedBy.push(pluginId);
    node._lastModifiedBy = pluginId;
    return node;
  }

  // galaxy block
  parseGalaxyBlock(lines, i, pluginId) {
    const name = matchNamedLine(lines[i].trim(), 'galaxy');
    const baseIndent = indentOf(lines[i]);
    if (!name) return skipIndentedBlock(lines, i, baseIndent);

    const partial = { pos: null, sprite: null };
    i++;
    while (i < lines.length) {
      const line = lines[i];
      const indent = indentOf(line);
      if (indent <= baseIndent && line.trim()) break;
      const stripped = line.trim();
      const posM = matchNamedLinePrefix(stripped, 'pos');
      if (stripped.startsWith('pos ')) {
        const nums = stripped.slice(4).trim().split(/\s+/).map(Number);
        partial.pos = { x: nums[0] ?? null, y: nums[1] ?? null };
        i++; continue;
      }
      const spriteM = matchNamedLine(stripped, 'sprite');
      if (spriteM !== null) { partial.sprite = spriteM; i++; continue; }
      i++;
    }
    this._mergeGalaxy(name, partial, pluginId);
    return i;
  }

  _mergeGalaxy(name, partial, pluginId) {
    let node = this.galaxies.get(name);
    if (!node) {
      node = this._stampNew({ pos: null, sprite: null }, name, pluginId);
      this.galaxies.set(name, node);
    } else {
      this._stampTouched(node, pluginId);
    }
    if (partial.pos != null) node.pos = partial.pos;
    if (partial.sprite != null) node.sprite = partial.sprite;
    return node;
  }

  // system block
  parseSystemBlock(lines, i, pluginId) {
    const name = matchNamedLine(lines[i].trim(), 'system');
    const baseIndent = indentOf(lines[i]);
    if (!name) return skipIndentedBlock(lines, i, baseIndent);

    const partial = {
      displayName: null,
      flags: {},
      pos: null,
      government: null,
      attributes: [],
      music: null,
      arrival: null,
      departure: null,
      ramscoop: null,
      habitable: null,
      belts: [],
      invisibleFence: null,
      jumpRange: null,
      haze: null,
      links: [],
      asteroids: [],
      minables: [],
      trade: [],
      fleets: [],
      raids: [],
      noRaids: false,
      hazards: [],
      starfieldDensity: null,
      objectTree: [],
      // redefined systems: add adds, remove removes, a plain line replaces the list
      plainKeys: new Set(),
      removals: [],
    };

    const LIST_KEY = { link: 'links', asteroids: 'asteroids', minables: 'minables', trade: 'trade',
                       fleet: 'fleets', hazard: 'hazards', raid: 'raids', belt: 'belts', attributes: 'attributes' };
    const systemBodyStart = i + 1;
    i++;
    while (i < lines.length) {
      const line = lines[i];
      const indent = indentOf(line);
      if (indent <= baseIndent && line.trim()) break;
      let stripped = line.trim();

      if (indent === baseIndent + 1) {
        // "add …" / "remove …" modifiers on list keys
        const mod = stripped.match(/^(add|remove)\s+(.+)$/);
        if (mod) {
          const rest = mod[2].trim();
          const key = (rest.match(/^"([^"]+)"|^`([^`]+)`|^(\S+)/) || [])[0]?.replace(/["`]/g, '');
          if (mod[1] === 'remove' && LIST_KEY[key]) {
            const after = rest.slice(rest.match(/^("[^"]+"|`[^`]+`|\S+)/)[0].length).trim();
            const nm = after ? (after.match(/^"([^"]+)"|^`([^`]+)`|^(\S+)/) || []).slice(1).find(x => x != null) : null;
            partial.removals.push({ list: LIST_KEY[key], name: nm });   // name null = remove all
            i++; continue;
          }
          if (mod[1] === 'add') stripped = rest;                         // parsed below as a normal line, but not "plain"
        } else {
          const key = (stripped.match(/^"([^"]+)"|^`([^`]+)`|^(\S+)/) || [])[0]?.replace(/["`]/g, '');
          if (LIST_KEY[key]) partial.plainKeys.add(LIST_KEY[key]);
        }
        if (stripped === 'inaccessible') { partial.flags.inaccessible = true; i++; continue; }
        if (stripped === 'hidden')       { partial.flags.hidden = true; i++; continue; }
        if (stripped === 'shrouded')     { partial.flags.shrouded = true; i++; continue; }
        if (stripped === '"no raids"')   { partial.noRaids = true; i++; continue; }

        const dispM = stripped.match(/^"display name"\s+"([^"]+)"/) || stripped.match(/^"display name"\s+`([^`]+)`/);
        if (dispM) { partial.displayName = dispM[1]; i++; continue; }

        if (stripped.startsWith('pos ')) {
          const nums = stripped.slice(4).trim().split(/\s+/).map(Number);
          partial.pos = { x: nums[0] ?? null, y: nums[1] ?? null };
          i++; continue;
        }

        const govM = matchNamedLine(stripped, 'government');
        if (govM !== null) { partial.government = govM; i++; continue; }

        if (stripped.startsWith('attributes ')) {
          partial.attributes.push(...stripped.slice(11).trim().split(/\s+/).map(s => s.replace(/["`]/g, '')));
          i++; continue;
        }

        const musicM = matchNamedLine(stripped, 'music');
        if (musicM !== null) { partial.music = musicM; i++; continue; }

        if (stripped === 'arrival' || stripped.startsWith('arrival ')) {
          const [arr, ni] = this._parseArrivalDeparture(lines, i, indent, stripped, 'arrival');
          partial.arrival = arr; i = ni; continue;
        }
        if (stripped === 'departure' || stripped.startsWith('departure ')) {
          const [dep, ni] = this._parseArrivalDeparture(lines, i, indent, stripped, 'departure');
          partial.departure = dep; i = ni; continue;
        }

        if (stripped === 'ramscoop') {
          const [rs, ni] = parseGenericBlock(lines, i + 1, indent);
          partial.ramscoop = rs; i = ni; continue;
        }

        const habM = matchNamedLinePrefix(stripped, 'habitable');
        if (habM) { partial.habitable = Number(habM.name ?? habM.rest); i++; continue; }

        if (stripped.startsWith('belt ')) {
          const nums = stripped.slice(5).trim().split(/\s+/).map(Number);
          partial.belts.push({ distance: nums[0] ?? null, weight: nums[1] ?? null, pluginId });
          i++; continue;
        }

        const fenceM = stripped.match(/^"invisible fence"\s+(-?[\d.]+)/);
        if (fenceM) { partial.invisibleFence = Number(fenceM[1]); i++; continue; }

        const jrM = stripped.match(/^"jump range"\s+(-?[\d.]+)/);
        if (jrM) { partial.jumpRange = Number(jrM[1]); i++; continue; }

        const hazeM = matchNamedLine(stripped, 'haze');
        if (hazeM !== null) { partial.haze = hazeM; i++; continue; }

        const linkM = matchNamedLine(stripped, 'link');
        if (linkM !== null) {
          partial.links.push(namedRef(linkM, pluginId, 'link', { explicit: true }));
          i++; continue;
        }

        const astM = stripped.match(/^asteroids\s+(?:"([^"]+)"|`([^`]+)`|(\S+))\s+(-?\d+)\s+(-?[\d.]+)/);
        if (astM) {
          partial.asteroids.push(namedRef(astM[1] ?? astM[2] ?? astM[3], pluginId, 'asteroids',
            { asteroidCount: Number(astM[4]), energy: Number(astM[5]) }));
          i++; continue;
        }
        const minM = stripped.match(/^minables\s+(?:"([^"]+)"|`([^`]+)`|(\S+))\s+(-?\d+)\s+(-?[\d.]+)/);
        if (minM) {
          partial.minables.push(namedRef(minM[1] ?? minM[2] ?? minM[3], pluginId, 'minables',
            { asteroidCount: Number(minM[4]), energy: Number(minM[5]) }));
          i++; continue;
        }

        const tradeM = stripped.match(/^trade\s+(?:"([^"]+)"|`([^`]+)`|(\S+))\s+(-?\d+)/);
        if (tradeM) {
          partial.trade.push(namedRef(tradeM[1] ?? tradeM[2] ?? tradeM[3], pluginId, 'trade',
            { cost: Number(tradeM[4]) }));
          i++; continue;
        }

        if (stripped.startsWith('fleet ')) {
          const fm = matchNamedLinePrefix(stripped, 'fleet');
          const period = fm.rest ? Number(fm.rest.split(/\s+/)[0]) : null;
          const fleetIndent = indent;
          i++;
          // optional nested `to spawn` condition-set
          let toSpawn = null;
          if (i < lines.length && lines[i].trim() === 'to spawn' && indentOf(lines[i]) === fleetIndent + 1) {
            const [ts, ni] = this._captureRawBlock(lines, i + 1, fleetIndent + 1);
            toSpawn = ts; i = ni;
          }
          partial.fleets.push(namedRef(fm.name, pluginId, 'systemFleet', { period, toSpawn }));
          continue;
        }

        const raidM = stripped.match(/^raid\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(-?\d+))?(?:\s+(-?\d+))?/);
        if (raidM) {
          partial.raids.push(namedRef(raidM[1] ?? raidM[2] ?? raidM[3], pluginId, 'raid',
            { min: raidM[4] != null ? Number(raidM[4]) : null, max: raidM[5] != null ? Number(raidM[5]) : null }));
          i++; continue;
        }

        if (stripped.startsWith('hazard ')) {
          const hm = matchNamedLinePrefix(stripped, 'hazard');
          const period = hm.rest ? Number(hm.rest.split(/\s+/)[0]) : null;
          const hazardIndent = indent;
          i++;
          let toSpawn = null;
          if (i < lines.length && lines[i].trim() === 'to spawn' && indentOf(lines[i]) === hazardIndent + 1) {
            const [ts, ni] = this._captureRawBlock(lines, i + 1, hazardIndent + 1);
            toSpawn = ts; i = ni;
          }
          partial.hazards.push(namedRef(hm.name, pluginId, 'hazard', { period, toSpawn }));
          continue;
        }

        const sfdM = stripped.match(/^"starfield density"\s+(-?[\d.]+)/);
        if (sfdM) { partial.starfieldDensity = Number(sfdM[1]); i++; continue; }

        if (stripped === 'object' || stripped.startsWith('object ')) {
          const [objNode, ni] = this.parseObjectTree(lines, i, indent, pluginId);
          partial.objectTree.push(objNode);
          i = ni; continue;
        }
      }
      i++;
    }

    const [rawEntries] = parseIndentTree(lines, systemBodyStart, baseIndent + 1);
    this._mergeSystem(name, partial, pluginId, rawEntries);
    return i;
  }

  _parseArrivalDeparture(lines, i, baseIndent, headerStripped, key) {
    const m = headerStripped.match(new RegExp(`^${key}\\s+(-?[\\d.]+)`));
    const result = { distance: m ? Number(m[1]) : null, link: null, jump: null };
    i++;
    while (i < lines.length) {
      const line = lines[i];
      const indent = indentOf(line);
      if (indent <= baseIndent) break;
      const stripped = line.trim();
      const linkM = stripped.match(/^link\s+(-?[\d.]+)/);
      const jumpM = stripped.match(/^jump\s+(-?[\d.]+)/);
      if (linkM) result.link = Number(linkM[1]);
      else if (jumpM) result.jump = Number(jumpM[1]);
      i++;
    }
    return [result, i];
  }

  // keep an indented block as raw lines
  _captureRawBlock(lines, i, baseIndent) {
    const out = [];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (indentOf(line) <= baseIndent) break;
      out.push(line.trim());
      i++;
    }
    return [out, i];
  }

  // a system's object tree (planets, moons, stations)
  parseObjectTree(lines, i, baseIndent, pluginId) {
    const headerStripped = lines[i].trim();
    const nameM = headerStripped.match(/^object\s+"([^"]+)"/) ||
                  headerStripped.match(/^object\s+`([^`]+)`/) ||
                  headerStripped.match(/^object\s+(\S+)\s*$/);
    const name = nameM ? nameM[1] : null;

    const node = {
      name,
      isLandable: name != null,
      sprite: null,
      spriteScale: null,
      distance: null,
      period: null,
      offset: null,
      visibility: null,
      hazards: [],
      children: [],
      pluginId,
      internalId: name != null ? `${pluginId}::object:${name}` : null,
      _planetData: null, // attached later by resolveObjectPlanets()
    };

    i++;
    while (i < lines.length) {
      const line = lines[i];
      const indent = indentOf(line);
      if (indent <= baseIndent && line.trim()) break;
      const stripped = line.trim();

      if (indent === baseIndent + 1) {
        const spriteM = matchNamedLine(stripped, 'sprite');
        if (spriteM !== null) {
          node.sprite = spriteM;
          if (i + 1 < lines.length && indentOf(lines[i + 1]) > indent &&
              lines[i + 1].trim().startsWith('scale')) {
            const scaleM = lines[i + 1].trim().match(/^scale\s+(-?[\d.]+)/);
            if (scaleM) node.spriteScale = Number(scaleM[1]);
            i += 2; continue;
          }
          i++; continue;
        }
        const distM = stripped.match(/^distance\s+(-?[\d.]+)/);
        if (distM) { node.distance = Number(distM[1]); i++; continue; }
        const periodM = stripped.match(/^period\s+(-?[\d.]+)/);
        if (periodM) { node.period = Number(periodM[1]); i++; continue; }
        const offsetM = stripped.match(/^offset\s+(-?[\d.]+)/);
        if (offsetM) { node.offset = Number(offsetM[1]); i++; continue; }
        const visM = stripped.match(/^visibility\s+(.+)$/);
        if (visM) {
          const nums = visM[1].trim().split(/\s+/).map(Number);
          node.visibility = { max: nums[0] ?? null, min: nums[1] ?? null };
          i++; continue;
        }
        if (stripped.startsWith('hazard ')) {
          const hm = matchNamedLinePrefix(stripped, 'hazard');
          const period = hm.rest ? Number(hm.rest.split(/\s+/)[0]) : null;
          const hazardIndent = indent;
          i++;
          let toSpawn = null;
          if (i < lines.length && lines[i].trim() === 'to spawn' && indentOf(lines[i]) === hazardIndent + 1) {
            const [ts, ni] = this._captureRawBlock(lines, i + 1, hazardIndent + 1);
            toSpawn = ts; i = ni;
          }
          node.hazards.push(namedRef(hm.name, pluginId, 'hazard', { period, toSpawn }));
          continue;
        }
        if (stripped === 'object' || stripped.startsWith('object ')) {
          const [child, ni] = this.parseObjectTree(lines, i, indent, pluginId);
          node.children.push(child);
          i = ni; continue;
        }
      }
      i++;
    }
    return [node, i];
  }

  _mergeSystem(name, partial, pluginId, rawEntries = null) {
    let node = this.systems.get(name);
    const existed = !!node;
    if (!node) {
      node = this._stampNew({
        displayName: null, flags: { inaccessible: false, hidden: false, shrouded: false },
        pos: null, government: null, attributes: [], music: null,
        arrival: null, departure: null, ramscoop: null, habitable: null,
        belts: [], invisibleFence: null, jumpRange: null, haze: null,
        links: [], asteroids: [], minables: [], trade: [], fleets: [],
        raids: [], noRaids: false, hazards: [], starfieldDensity: null,
        objectTree: [], planets: [], rawByPlugin: [],
      }, name, pluginId);
      this.systems.set(name, node);
    } else {
      this._stampTouched(node, pluginId);
    }
    if (rawEntries) node.rawByPlugin.push({ pluginId, entries: rawEntries });

    // Scalars: last write wins (see file header comment).
    if (partial.displayName != null) node.displayName = partial.displayName;
    if (partial.pos != null) node.pos = partial.pos;
    if (partial.government != null) node.government = partial.government;
    if (partial.music != null) node.music = partial.music;
    if (partial.arrival != null) node.arrival = partial.arrival;
    if (partial.departure != null) node.departure = partial.departure;
    if (partial.ramscoop != null) node.ramscoop = partial.ramscoop;
    if (partial.habitable != null) node.habitable = partial.habitable;
    if (partial.invisibleFence != null) node.invisibleFence = partial.invisibleFence;
    if (partial.jumpRange != null) node.jumpRange = partial.jumpRange;
    if (partial.haze != null) node.haze = partial.haze;
    if (partial.starfieldDensity != null) node.starfieldDensity = partial.starfieldDensity;
    if (partial.noRaids) node.noRaids = true;
    Object.assign(node.flags, partial.flags);

    // Lists. Redefining a system follows the game: a plain list line replaces
    // that list, "remove" takes entries out, "add" (and a first definition) appends.
    if (existed && partial.plainKeys) for (const list of partial.plainKeys) if (Array.isArray(node[list])) node[list] = [];
    for (const r of partial.removals || []) {
      if (!Array.isArray(node[r.list])) continue;
      node[r.list] = r.name == null ? [] : node[r.list].filter(x => (typeof x === 'string' ? x : x.name) !== r.name);
    }
    node.attributes.push(...partial.attributes);
    node.belts.push(...partial.belts);
    mergeNamedRefList(node.links, partial.links);
    mergeNamedRefList(node.asteroids, partial.asteroids);
    mergeNamedRefList(node.minables, partial.minables);
    mergeNamedRefList(node.trade, partial.trade);
    node.fleets.push(...partial.fleets);
    node.raids.push(...partial.raids);
    node.hazards.push(...partial.hazards);

    // merge objects by name (moons as children)
    node.objectTree = this._mergeObjectList(node.objectTree, partial.objectTree);

    // Derived flat "which planets does this system contain" list -
    // recomputed from the merged tree every merge (cheap; trees are small).
    node.planets = [];
    const walk = (objs) => {
      for (const o of objs) {
        if (o.isLandable) {
          node.planets.push(namedRef(o.name, o.pluginId, 'systemPlanet'));
        }
        if (o.children.length) walk(o.children);
      }
    };
    walk(node.objectTree);

    return node;
  }

  _mergeObjectList(existing, incoming) {
    for (const inc of incoming) {
      if (inc.name != null) {
        const dupe = existing.find(e => e.name === inc.name);
        if (dupe) {
          // Merge scalar fields (last write wins) + append children.
          for (const k of ['sprite', 'spriteScale', 'distance', 'period', 'offset', 'visibility']) {
            if (inc[k] != null) dupe[k] = inc[k];
          }
          dupe.hazards.push(...inc.hazards);
          dupe.children = this._mergeObjectList(dupe.children, inc.children);
          continue;
        }
      }
      existing.push(inc);
    }
    return existing;
  }

  // planet block
  parsePlanetBlock(lines, i, pluginId) {
    const headerStripped = lines[i].trim();
    const name =
      matchNamedLine(headerStripped, 'planet') ??
      matchNamedLine(headerStripped, '"planet"');
    const baseIndent = indentOf(lines[i]);
    if (!name) return skipIndentedBlock(lines, i, baseIndent);

    const partial = {
      displayName: null, attributes: [], requires: [], landscapes: [],
      music: null, description: null, spaceport: null,
      toKnow: null, toLand: null, toAccessOutfitter: null, toAccessShipyard: null,
      port: null, government: null, shipyards: [], outfitters: [],
      requiredReputation: null, bribe: null, bribeThreshold: null, bribeFraction: null,
      security: null, wormhole: null, tribute: null, tributeHails: {},
    };

    const planetBodyStart = i + 1;
    i++;
    while (i < lines.length) {
      const line = lines[i];
      const indent = indentOf(line);
      if (indent <= baseIndent && line.trim()) break;
      const stripped = line.trim();

      if (indent === baseIndent + 1) {
        const dispM = stripped.match(/^"display name"\s+"([^"]+)"/) || stripped.match(/^"display name"\s+`([^`]+)`/);
        if (dispM) { partial.displayName = dispM[1]; i++; continue; }

        if (stripped.startsWith('attributes ')) {
          for (const tok of stripped.slice(11).trim().split(/\s+/)) {
            const clean = tok.replace(/["`]/g, '');
            if (clean.startsWith('requires:')) partial.requires.push(clean.slice(9));
            else partial.attributes.push(clean);
          }
          i++; continue;
        }

        if (stripped === 'landscape' || stripped.startsWith('landscape ')) {
          const oneLine = matchNamedLine(stripped, 'landscape');
          const landIndent = indent;
          if (oneLine !== null && !(i + 1 < lines.length && indentOf(lines[i + 1]) > landIndent)) {
            partial.landscapes.push(namedRef(oneLine, pluginId, 'landscape'));
            i++; continue;
          }
          i++;
          while (i < lines.length) {
            const ll = lines[i];
            if (!ll.trim()) { i++; continue; }
            if (indentOf(ll) <= landIndent) break;
            const lm = ll.trim().match(/^"([^"]+)"(?:\s+(\d+))?$/) || ll.trim().match(/^`([^`]+)`(?:\s+(\d+))?$/);
            if (lm) partial.landscapes.push(namedRef(lm[1], pluginId, 'landscape', { count: lm[2] ? Number(lm[2]) : 1 }));
            i++;
          }
          continue;
        }

        const musicM = matchNamedLine(stripped, 'music');
        if (musicM !== null) { partial.music = musicM; i++; continue; }

        if (stripped === 'description' || stripped.startsWith('description ')) {
          const [desc, ni] = parseTextBlock(lines, i, indent, 'description');
          partial.description = desc; i = ni; continue;
        }
        if (stripped === 'spaceport' || stripped.startsWith('spaceport ')) {
          const [sp, ni] = parseTextBlock(lines, i, indent, 'spaceport');
          partial.spaceport = sp; i = ni; continue;
        }

        const toM = stripped.match(/^to\s+(know|land)\s*$/);
        if (toM) {
          const [cond, ni] = this._captureRawBlock(lines, i + 1, indent);
          if (toM[1] === 'know') partial.toKnow = cond; else partial.toLand = cond;
          i = ni; continue;
        }
        const toAccessM = stripped.match(/^to\s+access\s+(outfitter|shipyard)\s*$/);
        if (toAccessM) {
          const [cond, ni] = this._captureRawBlock(lines, i + 1, indent);
          if (toAccessM[1] === 'outfitter') partial.toAccessOutfitter = cond;
          else partial.toAccessShipyard = cond;
          i = ni; continue;
        }

        if (stripped === 'port' || stripped.startsWith('port ')) {
          const portNameM = matchNamedLine(stripped, 'port');
          const [portData, ni] = parseGenericBlock(lines, i + 1, indent);
          partial.port = { name: portNameM, ...portData };
          i = ni; continue;
        }

        const govM = matchNamedLine(stripped, 'government');
        if (govM !== null) { partial.government = govM; i++; continue; }

        const syM = matchNamedLine(stripped, 'shipyard');
        if (syM !== null) { partial.shipyards.push(namedRef(syM, pluginId, 'shipyard')); i++; continue; }
        const ofM = matchNamedLine(stripped, 'outfitter');
        if (ofM !== null) { partial.outfitters.push(namedRef(ofM, pluginId, 'outfitter')); i++; continue; }

        const rrM = stripped.match(/^"required reputation"\s+(-?[\d.]+)/);
        if (rrM) { partial.requiredReputation = Number(rrM[1]); i++; continue; }
        const bribeM = stripped.match(/^bribe\s+(-?[\d.]+)/);
        if (bribeM) { partial.bribe = Number(bribeM[1]); i++; continue; }
        const btM = stripped.match(/^"bribe threshold"\s+(-?[\d.]+)/);
        if (btM) { partial.bribeThreshold = Number(btM[1]); i++; continue; }
        const bfM = stripped.match(/^"bribe fraction"\s+(-?[\d.]+)/);
        if (bfM) { partial.bribeFraction = Number(bfM[1]); i++; continue; }
        const secM = stripped.match(/^security\s+(-?[\d.]+)/);
        if (secM) { partial.security = Number(secM[1]); i++; continue; }

        const whM = matchNamedLine(stripped, 'wormhole');
        if (whM !== null) { partial.wormhole = whM; i++; continue; }

        if (stripped === 'tribute' || stripped.startsWith('tribute ')) {
          const trM = stripped.match(/^tribute\s+(-?[\d.]+)/);
          const tribute = { credits: trM ? Number(trM[1]) : null, threshold: null, fleets: [], dailyReputationPenalty: null };
          const tribIndent = indent;
          i++;
          while (i < lines.length) {
            const tl = lines[i];
            if (!tl.trim()) { i++; continue; }
            if (indentOf(tl) <= tribIndent) break;
            const ts = tl.trim();
            const thM = ts.match(/^threshold\s+(-?[\d.]+)/);
            if (thM) { tribute.threshold = Number(thM[1]); i++; continue; }
            const tfM = ts.match(/^fleet\s+(?:"([^"]+)"|`([^`]+)`|(\S+))\s+(-?\d+)/);
            if (tfM) { tribute.fleets.push(namedRef(tfM[1] ?? tfM[2] ?? tfM[3], pluginId, 'tributeFleet', { count: Number(tfM[4]) })); i++; continue; }
            const drpM = ts.match(/^"daily reputation penalty"\s+(-?[\d.]+)/);
            if (drpM) { tribute.dailyReputationPenalty = Number(drpM[1]); i++; continue; }
            i++;
          }
          partial.tribute = tribute;
          continue;
        }

        if (stripped === '"tribute hails"') {
          const [hails, ni] = parseGenericBlock(lines, i + 1, indent);
          partial.tributeHails = hails; i = ni; continue;
        }
      }
      i++;
    }

    const [rawEntries] = parseIndentTree(lines, planetBodyStart, baseIndent + 1);
    this._mergePlanet(name, partial, pluginId, rawEntries);
    return i;
  }

  _mergePlanet(name, partial, pluginId, rawEntries = null) {
    let node = this.planets.get(name);
    if (!node) {
      node = this._stampNew({
        displayName: null, attributes: [], requires: [], landscapes: [],
        music: null, description: null, spaceport: null,
        toKnow: null, toLand: null, toAccessOutfitter: null, toAccessShipyard: null,
        port: null, government: null, governmentInherited: false,
        shipyards: [], outfitters: [], requiredReputation: null,
        bribe: null, bribeThreshold: null, bribeFraction: null, security: null,
        wormhole: null, tribute: null, tributeHails: {}, systemName: null,
        rawByPlugin: [],
      }, name, pluginId);
      this.planets.set(name, node);
    } else {
      this._stampTouched(node, pluginId);
    }
    if (rawEntries) node.rawByPlugin.push({ pluginId, entries: rawEntries });

    if (partial.displayName != null) node.displayName = partial.displayName;
    if (partial.music != null) node.music = partial.music;
    if (partial.description != null) node.description = partial.description;
    if (partial.spaceport != null) node.spaceport = partial.spaceport;
    if (partial.toKnow != null) node.toKnow = partial.toKnow;
    if (partial.toLand != null) node.toLand = partial.toLand;
    if (partial.toAccessOutfitter != null) node.toAccessOutfitter = partial.toAccessOutfitter;
    if (partial.toAccessShipyard != null) node.toAccessShipyard = partial.toAccessShipyard;
    if (partial.port != null) node.port = partial.port;
    if (partial.government != null) { node.government = partial.government; node.governmentInherited = false; }
    if (partial.requiredReputation != null) node.requiredReputation = partial.requiredReputation;
    if (partial.bribe != null) node.bribe = partial.bribe;
    if (partial.bribeThreshold != null) node.bribeThreshold = partial.bribeThreshold;
    if (partial.bribeFraction != null) node.bribeFraction = partial.bribeFraction;
    if (partial.security != null) node.security = partial.security;
    if (partial.wormhole != null) node.wormhole = partial.wormhole;
    if (partial.tribute != null) node.tribute = partial.tribute;
    if (Object.keys(partial.tributeHails).length) Object.assign(node.tributeHails, partial.tributeHails);

    node.attributes.push(...partial.attributes);
    node.requires.push(...partial.requires);
    node.landscapes.push(...partial.landscapes);
    mergeNamedRefList(node.shipyards, partial.shipyards);
    mergeNamedRefList(node.outfitters, partial.outfitters);

    return node;
  }

  // wormhole block
  parseWormholeBlock(lines, i, pluginId) {
    const name = matchNamedLine(lines[i].trim(), 'wormhole');
    const baseIndent = indentOf(lines[i]);
    if (!name) return skipIndentedBlock(lines, i, baseIndent);

    const partial = { displayName: null, mappable: false, links: [], color: null };
    i++;
    while (i < lines.length) {
      const line = lines[i];
      const indent = indentOf(line);
      if (indent <= baseIndent && line.trim()) break;
      const stripped = line.trim();
      if (indent === baseIndent + 1) {
        const dispM = stripped.match(/^"display name"\s+"([^"]+)"/) || stripped.match(/^"display name"\s+`([^`]+)`/);
        if (dispM) { partial.displayName = dispM[1]; i++; continue; }
        if (stripped === 'mappable') { partial.mappable = true; i++; continue; }
        const linkM = stripped.match(/^link\s+(?:"([^"]+)"|`([^`]+)`|(\S+))\s+(?:"([^"]+)"|`([^`]+)`|(\S+))\s*$/);
        if (linkM) {
          const from = linkM[1] ?? linkM[2] ?? linkM[3];
          const to   = linkM[4] ?? linkM[5] ?? linkM[6];
          partial.links.push({
            from, to, count: 1, pluginId,
            internalId: `${pluginId}::wormholeLink:${from}->${to}`,
          });
          i++; continue;
        }
        if (stripped.startsWith('color ')) { partial.color = stripped.slice(6).trim(); i++; continue; }
      }
      i++;
    }
    this._mergeWormhole(name, partial, pluginId);
    return i;
  }

  _mergeWormhole(name, partial, pluginId) {
    let node = this.wormholes.get(name);
    if (!node) {
      node = this._stampNew({ displayName: null, mappable: false, links: [], color: null }, name, pluginId);
      this.wormholes.set(name, node);
    } else {
      this._stampTouched(node, pluginId);
    }
    if (partial.displayName != null) node.displayName = partial.displayName;
    if (partial.mappable) node.mappable = true;
    if (partial.color != null) node.color = partial.color;
    for (const l of partial.links) {
      if (!node.links.some(e => e.from === l.from && e.to === l.to)) node.links.push(l);
    }
    return node;
  }

  // star block
  parseStarBlock(lines, i, pluginId) {
    const sprite = matchNamedLine(lines[i].trim(), 'star');
    const baseIndent = indentOf(lines[i]);
    const [data, ni] = parseGenericBlock(lines, i + 1, baseIndent);
    this.stars.push({ sprite, ...data, pluginId, internalId: sprite ? `${pluginId}::star:${sprite}` : null });
    return ni;
  }

  // government block
  parseGovernmentBlock(lines, i, pluginId) {
    const name = matchNamedLine(lines[i].trim(), 'government');
    const baseIndent = indentOf(lines[i]);
    const [data, ni] = parseGenericBlock(lines, i + 1, baseIndent);

    let color = null, colorRef = null;
    if (Array.isArray(data.color) && data.color.length === 3 && data.color.every(v => typeof v === 'number')) {
      color = data.color;
    } else if (typeof data.color === 'string') {
      colorRef = data.color; // resolved later against namedColors
    }

    this.governments.push({
      name, color, colorRef, swizzle: data.swizzle ?? null,
      pluginId, internalId: name ? `${pluginId}::government:${name}` : null,
    });
    return ni;
  }

  // top-level `color "Name" r g b`
  parseNamedColorLine(lines, i, pluginId) {
    const stripped = lines[i].trim();
    const parsed = matchNamedLinePrefix(stripped, 'color');
    if (parsed?.name && parsed.rest) {
      const nums = parsed.rest.split(/\s+/).filter(Boolean).map(Number);
      if (nums.length === 3 && nums.every(n => !Number.isNaN(n))) {
        this.namedColors.set(parsed.name, nums);
      }
    }
    return i + 1;
  }

  parseLandingMessageBlock(lines, i, pluginId) {
    const [msg, ni] = parseTextBlock(lines, i, indentOf(lines[i]), '"landing message"');
    const baseIndent = indentOf(lines[i]);
    const sprites = [];
    let j = ni;
    while (j < lines.length) {
      const l = lines[j];
      if (!l.trim()) { j++; continue; }
      if (indentOf(l) <= baseIndent) break;
      sprites.push(l.trim().replace(/["`]/g, ''));
      j++;
    }
    this.landingMessages.push({ text: msg.text, sprites, pluginId });
    return j;
  }

  // ── after every plugin: tie things together ──

  // links both ways
  resolveLinks() {
    let inferred = 0;
    for (const [name, sys] of this.systems) {
      for (const link of sys.links) {
        const target = this.systems.get(link.name);
        if (!target) continue;
        const already = target.links.some(l => l.name === name);
        if (!already) {
          target.links.push(namedRef(name, link.pluginId, 'link', { explicit: false }));
          inferred++;
        }
      }
    }
    return inferred;
  }

  // put planet data on every landable object
  resolveObjectPlanets() {
    let attached = 0, missing = 0;
    for (const [sysName, sys] of this.systems) {
      const walk = (objs) => {
        for (const o of objs) {
          if (o.isLandable) {
            const planet = this.planets.get(o.name);
            if (planet) {
              o._planetData = planet;
              planet.systemName = sysName;
              attached++;
            } else {
              missing++;
            }
          }
          if (o.children.length) walk(o.children);
        }
      };
      walk(sys.objectTree);
    }
    return { attached, missing };
  }

  // planets inherit their system's government
  resolveGovernmentInheritance() {
    let inherited = 0;
    for (const planet of this.planets.values()) {
      if (planet.government == null && planet.systemName) {
        const sys = this.systems.get(planet.systemName);
        if (sys && sys.government != null) {
          planet.government = sys.government;
          planet.governmentInherited = true;
          inherited++;
        }
      }
    }
    return inherited;
  }

  // wormhole links → system-to-system links
  resolveWormholes() {
    const graph = []; // [{ wormhole, fromSystem, toSystem, fromPlanet, toPlanet, pluginId, internalId }]
    for (const wh of this.wormholes.values()) {
      for (const l of wh.links) {
        const fromPlanet = this.planets.get(l.from);
        const toPlanet = this.planets.get(l.to);
        graph.push({
          wormhole: wh.name,
          fromPlanet: l.from, toPlanet: l.to,
          fromSystem: fromPlanet ? fromPlanet.systemName : null,
          toSystem:   toPlanet   ? toPlanet.systemName   : null,
          pluginId: l.pluginId, internalId: l.internalId,
        });
      }
    }
    this.wormholeGraph = graph;
    return graph;
  }

  // government colour names → colours
  resolveGovernmentColors() {
    let resolved = 0, unresolved = 0;
    for (const gov of this.governments) {
      if (gov.color != null || !gov.colorRef) continue;
      const rgb = this.namedColors.get(gov.colorRef);
      if (rgb) { gov.color = rgb; resolved++; }
      else unresolved++;
    }
    return { resolved, unresolved };
  }

  runAllResolvers() {
    const linkResult = this.resolveLinks();
    const objResult = this.resolveObjectPlanets();
    const govResult = this.resolveGovernmentInheritance();
    const wormholeGraph = this.resolveWormholes();
    const govColorResult = this.resolveGovernmentColors();
    return {
      inferredLinks: linkResult, ...objResult, governmentsInherited: govResult,
      wormholeLinks: wormholeGraph.length, governmentColorsResolved: govColorResult.resolved,
      governmentColorsUnresolved: govColorResult.unresolved,
    };
  }

  // ── output ──

  // everything merged
  toJSON() {
    return {
      galaxies:  [...this.galaxies.values()],
      systems:   [...this.systems.values()],
      planets:   [...this.planets.values()],
      wormholes: [...this.wormholes.values()],
      wormholeGraph: this.wormholeGraph || [],
      stars: this.stars,
      governments: this.governments,
      landingMessages: this.landingMessages,
    };
  }

  // only what one plugin's own files define
  toPluginSlice(pluginId) {
    // this plugin's references
    const filterRefs = (refs) => refs.filter(r => r.pluginId === pluginId);
    // one system's slice
    const sliceSystem = (sys) => ({
      ...sys,
      links: filterRefs(sys.links),
      asteroids: filterRefs(sys.asteroids),
      minables: filterRefs(sys.minables),
      trade: filterRefs(sys.trade),
      fleets: sys.fleets.filter(f => f.pluginId === pluginId),
      raids: sys.raids.filter(f => f.pluginId === pluginId),
      hazards: sys.hazards.filter(f => f.pluginId === pluginId),
      planets: filterRefs(sys.planets),
    });
    // one planet's slice
    const slicePlanet = (p) => ({
      ...p,
      shipyards: filterRefs(p.shipyards),
      outfitters: filterRefs(p.outfitters),
      landscapes: p.landscapes.filter(l => l.pluginId === pluginId),
    });
    return {
      galaxies:  [...this.galaxies.values()].filter(g => g._definedBy.includes(pluginId)),
      systems:   [...this.systems.values()].filter(s => s._definedBy.includes(pluginId)).map(sliceSystem),
      planets:   [...this.planets.values()].filter(p => p._definedBy.includes(pluginId)).map(slicePlanet),
      wormholes: [...this.wormholes.values()].filter(w => w._definedBy.includes(pluginId)),
      stars: this.stars.filter(s => s.pluginId === pluginId),
      governments: this.governments.filter(g => g.pluginId === pluginId),
      landingMessages: this.landingMessages.filter(m => m.pluginId === pluginId),
    };
  }
}

module.exports = EndlessSkyMapParser;
