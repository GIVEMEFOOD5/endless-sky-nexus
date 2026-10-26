// Parses mission definitions (offers, conditions, triggers, rewards) per plugin. Used by parser.js.

'use strict';

const crypto = require('crypto');

// indent depth

function indentOf(line) {
  return line.length - line.replace(/^\t+/, '').length;
}

// split a line like the game does
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

// { key, values, children } tree
function parseIndentTree(lines, startIdx, baseIndent) {
  const entries = [];
  let i = startIdx;
  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.trim()) { i++; continue; }
    const indent = indentOf(raw);
    if (indent < baseIndent) break;
    const stripped = raw.trim();
    if (stripped.startsWith('#')) { i++; continue; }

    const tokens = tokenizeESLine(stripped);
    const key = tokens.length > 0 ? tokens[0] : stripped;
    const values = tokens.slice(1).map(coerceToken);
    i++;

    // is there a deeper block next?
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

// visit every entry
function walkAll(entries, visit) {
  if (!entries) return;
  for (const entry of entries) {
    visit(entry);
    if (entry.children) walkAll(entry.children, visit);
  }
}

// hash of a tree (detects changes)
function hashTree(entries) {
  return crypto.createHash('sha1').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
}

// { name, count, pluginId, internalId } reference
function namedRef(name, extra = {}) {
  return { name, count: 1, pluginId: null, internalId: null, ...extra };
}

const LOCATION_TAGS = new Set([
  'job', 'landing', 'assisting', 'boarding', 'shipyard',
  'outfitter', 'job board', 'entering', 'transition',
]);

// keys turned into typed fields (the rest stay raw)
const TOP_LEVEL_HANDLED_KEYS = new Set([
  'name', 'description', 'cargo', 'passengers', 'source', 'destination',
  'stopover', 'waypoint', 'npc', 'on', 'to', 'repeat', 'illegal', 'deadline',
  'apparent payment',
]);

// salary/income, and reputation changes ("reputation: Pirate" += 5) — the
// auto-fitter uses those to tell which missions mend a reputation.
const SIDE_EFFECT_KEYWORDS = /salary|income|wage|^reputation: /i;

// ---------------------------------------------------------------------------
class EndlessSkyMissionParser {
  constructor() {
    this.missions = [];
    this.missionById = new Map();
    this.missionsByName = new Map();

    this._sourcePriority = new Map();
    this.collisions = [];
  }

  setSourcePriority(sources) {
    this._sourcePriority.clear();
    sources.forEach((source, index) => this._sourcePriority.set(source.name, index));
  }

  _registerMission(mission, pluginId) {
    const internalId = `${pluginId}::${mission.name}`;
    mission._pluginId = pluginId;
    mission._internalId = internalId;
    mission._hash = hashTree(mission.raw);
    mission.sourcePlugin = pluginId;
    this.missionById.set(internalId, mission);
    if (!this.missionsByName.has(mission.name)) this.missionsByName.set(mission.name, []);
    this.missionsByName.get(mission.name).push(mission);
    return internalId;
  }

  register(mission, pluginId) {
    this._registerMission(mission, pluginId);
    this.missions.push(mission);
    return mission;
  }

  // "3-5" style ranges
  _resolveRangeSpec(commodity, nums) {
    const clean = nums.filter(n => typeof n === 'number' && !Number.isNaN(n));
    const base = commodity !== null ? { commodity } : {};
    if (clean.length === 0) return { ...base, min: 0, max: 0, mode: 'fixed', nbParams: null };
    if (clean.length === 1) return { ...base, min: clean[0], max: clean[0], mode: 'fixed', nbParams: null };
    if (clean.length === 2) return { ...base, min: clean[0], max: clean[1], mode: 'uniform', nbParams: null };
    const [n1, r, p] = clean;
    const mean = n1 + (r * (1 - p)) / p;
    const variance = p > 0 ? (r * (1 - p)) / (p * p) : 0;
    const softMax = Math.round(mean + 3 * Math.sqrt(variance));
    return { ...base, min: n1, max: null, expected: Math.round(mean), softMax, mode: 'negative-binomial', nbParams: { r, p } };
  }

  // one mission block
  parseMissionBlock(lines, i, pluginId) {
    const headerLine = lines[i].trim();
    const nameMatch = headerLine.match(/^mission\s+"([^"]+)"/) || headerLine.match(/^mission\s+`([^`]+)`/);
    const missionName = nameMatch ? nameMatch[1] : null;
    const baseIndent = indentOf(lines[i]);
    if (!missionName) {
      // Not a real mission header - skip whatever block follows so the
      // caller's line index still advances sensibly.
      const [, ni] = parseIndentTree(lines, i + 1, baseIndent + 1);
      return [null, ni];
    }

    const [raw, ni] = parseIndentTree(lines, i + 1, baseIndent + 1);

    const mission = {
      name: missionName,
      displayName: null,
      description: null,
      raw,
      locations: [],
      flags: {},
      repeatable: false,
      repeatLimit: null,
      illegal: null,
      deadline: null,
      cargo: null,
      passengers: null,
      conditions: {},        // { offer: [...raw...], complete: [...], fail: [...], accept: [...], display: [...] }
      payment: { apparentPayment: null, triggers: {} },
      source: null,
      destination: null,
      stopovers: [],
      waypoints: [],
      rewards: { outfits: [], ships: [] },
      hasNpcObjective: false,
      npcCount: 0,
      conditionSideEffects: [],
      eventTriggers: [],
    };

    this._deriveFields(mission, raw);
    return [mission, ni];
  }

  _deriveFields(mission, raw) {
    for (const entry of raw) {
      const { key, values, children } = entry;

      if (key === 'name') { mission.displayName = values[0] ?? null; continue; }
      if (key === 'description') { mission.description = values[0] ?? null; continue; }

      if (LOCATION_TAGS.has(key) && values.length === 0 && !children) {
        mission.locations.push(key);
        continue;
      }

      if (key === 'repeat') {
        mission.repeatable = true;
        mission.repeatLimit = typeof values[0] === 'number' ? values[0] : null;
        continue;
      }

      if (key === 'illegal') {
        mission.illegal = { fine: values[0] ?? null, message: values[1] ?? null };
        continue;
      }

      if (key === 'deadline') {
        mission.deadline = mission.deadline || { days: 0, multiplier: 2 };
        if (typeof values[0] === 'number') mission.deadline.days += values[0];
        if (typeof values[1] === 'number') mission.deadline.multiplier = values[1];
        continue;
      }

      if (key === 'apparent payment') {
        mission.payment.apparentPayment = typeof values[0] === 'number' ? values[0] : null;
        continue;
      }

      if (key === 'cargo') {
        const commodity = values[0] ?? null;
        mission.cargo = this._resolveRangeSpec(commodity, values.slice(1));
        continue;
      }

      if (key === 'passengers') {
        mission.passengers = this._resolveRangeSpec(null, values);
        continue;
      }

      if (key === 'source' || key === 'destination') {
        const ref = this._locationRefFromEntry(entry);
        mission[key] = ref;
        continue;
      }
      if (key === 'stopover') {
        const ref = this._locationRefFromEntry(entry);
        if (ref && ref.type === 'planet') mission.stopovers.push(namedRef(ref.value));
        continue;
      }
      if (key === 'waypoint') {
        const ref = this._locationRefFromEntry(entry);
        if (ref && ref.type === 'planet') mission.waypoints.push(namedRef(ref.value));
        continue;
      }

      if (key === 'npc') {
        mission.hasNpcObjective = true;
        mission.npcCount++;
        continue;
      }

      if (key === 'to') {
        // to offer / complete / fail … conditions
        const condName = values[0] ?? 'unknown';
        mission.conditions[condName] = children || [];
        continue;
      }

      if (key === 'on') {
        const triggerRaw = values[0] ?? 'unknown';
        const triggerKey = 'on' + triggerRaw.charAt(0).toUpperCase() + triggerRaw.slice(1);
        this._deriveTrigger(mission, triggerKey, entry);
        continue;
      }

      // anything else is kept raw, not dropped
      if (!TOP_LEVEL_HANDLED_KEYS.has(key)) {
        const value = children ? children : (values.length === 0 ? true : (values.length === 1 ? values[0] : values));
        if (key in mission.flags) {
          if (!Array.isArray(mission.flags[key])) mission.flags[key] = [mission.flags[key]];
          mission.flags[key].push(value);
        } else {
          mission.flags[key] = value;
        }
      }
    }
  }

  _locationRefFromEntry(entry) {
    const { values, children } = entry;
    if (!children && values.length >= 1) return { type: 'planet', value: values[0] };
    if (children) return { type: 'filter', value: children };
    return { type: 'filter', value: [] };
  }

  // one `on <trigger>` block → actions, rewards, events
  _deriveTrigger(mission, triggerKey, onEntry) {
    mission.payment.triggers[triggerKey] = mission.payment.triggers[triggerKey] || [];

    walkAll(onEntry.children, (entry) => {
      const { key, values } = entry;

      if (key === 'payment') {
        const nums = values.filter(v => typeof v === 'number');
        const [base, multiplier] = nums.length === 0 ? [0, 150]
                                  : nums.length === 1 ? [nums[0], 0]
                                  : [nums[0], nums[1]];
        mission.payment.triggers[triggerKey].push({ base, multiplier });
        return;
      }

      if (key === 'event') {
        mission.eventTriggers.push({
          name: values[0] ?? null,
          delayDays: typeof values[1] === 'number' ? values[1] : null,
          delayDaysMax: typeof values[2] === 'number' ? values[2] : null,
          trigger: triggerKey,
        });
        return;
      }

      // Bare `outfit "Name" [count]` (the modern action-effect form - a
      // negative count means "take away") or `give outfit ...`.
      if (key === 'outfit' || (key === 'give' && values[0] === 'outfit')) {
        const isGiveForm = key === 'give';
        const name = isGiveForm ? values[1] : values[0];
        const countRaw = isGiveForm ? values[2] : values[1];
        const count = typeof countRaw === 'number' ? countRaw : 1;
        if (name && count > 0) {
          mission.rewards.outfits.push(namedRef(name, { count, grantedIn: triggerKey }));
        }
        // count <= 0 ("take away") is captured in `raw` in full; not added
        // to rewards since it isn't player-facing value gained.
        return;
      }

      if (key === 'give' && values[0] === 'ship') {
        const model = values[1] ?? null;
        const customName = values[2] ?? null;
        if (model) mission.rewards.ships.push(namedRef(model, { grantedIn: triggerKey, customName }));
        return;
      }

      const condMatch = typeof key === 'string' && values.length >= 1 &&
        (values[0] === '=' || values[0] === '+=' || values[0] === '-=' || values[0] === '>?=' || values[0] === '<?=');
      if (condMatch && SIDE_EFFECT_KEYWORDS.test(key)) {
        mission.conditionSideEffects.push({ condition: key, op: values[0], value: values[1] ?? null, trigger: triggerKey });
      }
    });
  }

  // same mission name in several plugins

  resolveCollisions() {
    this.collisions = [];
    for (const [name, entries] of this.missionsByName) {
      if (entries.length < 2) continue;
      const hashes = new Set(entries.map(m => m._hash));
      const contentIdentical = hashes.size === 1;

      const ranked = [...entries].sort((a, b) => {
        const pa = this._sourcePriority.get(this._sourceNameOf(a._pluginId)) ?? Infinity;
        const pb = this._sourcePriority.get(this._sourceNameOf(b._pluginId)) ?? Infinity;
        return pa - pb;
      });
      const winner = ranked[ranked.length - 1];

      let fieldDiffs = null;
      if (!contentIdentical) {
        fieldDiffs = {};
        const keys = ['payment', 'cargo', 'passengers', 'destination', 'source', 'illegal', 'deadline', 'rewards'];
        for (const k of keys) {
          const vals = entries.map(e => JSON.stringify(e[k]));
          if (new Set(vals).size > 1) fieldDiffs[k] = entries.map(e => ({ pluginId: e._pluginId, value: e[k] }));
        }
      }

      let guessedIntent = 'possible-unrelated-clash';
      if (contentIdentical) guessedIntent = 'identical-redeclaration';
      else {
        const descsMatch = new Set(entries.map(e => e.displayName)).size === 1;
        const destsMatch = new Set(entries.map(e => JSON.stringify(e.destination))).size === 1;
        if (descsMatch && destsMatch) guessedIntent = 'possible-deliberate-patch';
      }

      this.collisions.push({
        name,
        collidesAcross: entries.map(e => e._pluginId),
        contentIdentical,
        fieldDiffs,
        guessedIntent,
        resolvedByPluginPriorityOrder: winner._pluginId,
      });
    }
    return this.collisions;
  }

  _sourceNameOf(pluginId) {
    return pluginId ? pluginId.split('/')[0] : null;
  }

  // rewards → which plugin's outfit/ship

  resolveRewardPluginIds(shipParser) {
    let resolved = 0, missing = 0;
    for (const mission of this.missions) {
      for (const ref of mission.rewards.outfits) {
        const pid = shipParser._resolveOutfitPluginId
          ? shipParser._resolveOutfitPluginId(ref.name, mission._pluginId)
          : null;
        if (pid) { ref.pluginId = pid; ref.internalId = `${pid}::${ref.name}`; resolved++; }
        else missing++;
      }
      for (const ref of mission.rewards.ships) {
        const candidates = shipParser.shipsByName ? shipParser.shipsByName.get(ref.name) : null;
        if (candidates && candidates.length) {
          const local = candidates.find(s => s._pluginId === mission._pluginId);
          const chosen = local || candidates[0];
          ref.pluginId = chosen._pluginId;
          ref.internalId = chosen._internalId;
          resolved++;
        } else missing++;
      }
    }
    return { resolved, missing };
  }

  resolvePlanetRefs(mapParser) {
    let resolved = 0, missing = 0;
    // one reference
    const resolveOne = (ref) => {
      const planet = mapParser.planets.get(ref.name);
      if (planet) { ref.pluginId = planet._pluginId; ref.internalId = planet._internalId; resolved++; }
      else missing++;
    };
    for (const mission of this.missions) {
      if (mission.source && mission.source.type === 'planet') {
        mission.source = { type: 'planet', ref: namedRef(mission.source.value) };
        resolveOne(mission.source.ref);
      }
      if (mission.destination && mission.destination.type === 'planet') {
        mission.destination = { type: 'planet', ref: namedRef(mission.destination.value) };
        resolveOne(mission.destination.ref);
      }
      for (const ref of mission.stopovers) resolveOne(ref);
      for (const ref of mission.waypoints) resolveOne(ref);
    }
    return { resolved, missing };
  }

  // output

  toJSON() {
    return this.missions;
  }

  toPluginSlice(pluginId) {
    return this.missions.filter(m => m._pluginId === pluginId);
  }
}

module.exports = EndlessSkyMissionParser;
module.exports.parseIndentTree = parseIndentTree;
module.exports.tokenizeESLine = tokenizeESLine;
module.exports.walkAll = walkAll;
