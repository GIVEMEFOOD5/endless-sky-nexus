'use strict';

// Edits a save file exactly like the game would write it — untouched lines come back byte for byte. Used by the save editor.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EsSaveFile = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // ── the tree: { key, values, children } (+ how the line was written) ──

  const isData = n => Array.isArray(n.tokens);
  const key    = n => (isData(n) ? n.tokens[0] : undefined);

  // a new node
  function makeNode(tokens, children) {
    return { tokens: tokens.map(String), children: children || [] };
  }

  // text → tree (same rules as the game's DataFile)
  function parse(text) {
    const root = { tokens: [], children: [], line: 0 };
    const warnings = [];
    if (typeof text !== 'string') throw new TypeError('parse() expects a string');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // Saves copied around on Windows often have CRLF line endings. The game
    // reads either; remember which so an unedited save is written back as-is.
    const crlf = (text.match(/\r\n/g) || []).length;
    if (crlf && crlf * 2 >= (text.match(/\n/g) || []).length) root.eol = '\r\n';

    const stack = [root];
    const seps  = [-1];
    let indentChar = null;
    let pendingBlanks = 0;
    const lines = text.split('\n');
    const isWs = c => c !== undefined && c <= ' ';   // same test as the game (c <= ' ')

    for (let ln = 0; ln < lines.length; ln++) {
      const line = lines[ln];
      let i = 0, sepCount = 0, mixed = false;
      while (i < line.length && isWs(line[i])) {
        const c = line[i];
        if (c === '\t' || c === ' ') {
          if (indentChar === null) indentChar = c;
          else if (c !== indentChar) mixed = true;
        }
        sepCount++; i++;
      }
      if (mixed) warnings.push(`line ${ln + 1}: mixed tabs and spaces in indentation`);

      if (i >= line.length) {                    // empty / whitespace-only line
        // Remembered and placed just before the next real line (below).
        if (ln < lines.length - 1) pendingBlanks++;
        continue;
      }
      // blank lines belong just before the next real line
      if (pendingBlanks) {
        let s = stack.length - 1;
        while (seps[s] >= sepCount) s--;
        for (; pendingBlanks > 0; pendingBlanks--) stack[s].children.push({ blank: true, children: [] });
      }

      if (line[i] === '#') {                     // full-line comment
        const commentNode = { comment: line.slice(i + 1).replace(/\r$/, ''), children: [], line: ln + 1 };
        // attach at the depth its indentation implies, without opening a scope
        let s = stack.length - 1;
        while (seps[s] >= sepCount) s--;
        stack[s].children.push(commentNode);
        continue;
      }

      while (seps[seps.length - 1] >= sepCount) { seps.pop(); stack.pop(); }
      const node = { tokens: [], children: [], line: ln + 1 };
      stack[stack.length - 1].children.push(node);
      stack.push(node); seps.push(sepCount);
      const lineStart = i, depth = stack.length - 2;

      // tokenize the rest of the line
      while (i < line.length) {
        const c = line[i];
        if (c === '"' || c === '`') {
          const end = line.indexOf(c, i + 1);
          if (end === -1) {
            warnings.push(`line ${ln + 1}: closing ${c} is missing`);
            node.tokens.push(line.slice(i + 1).replace(/\r$/, ''));
            i = line.length;
            break;
          }
          node.tokens.push(line.slice(i + 1, end));
          i = end + 1;
        } else {
          let j = i;
          while (j < line.length && !isWs(line[j])) j++;
          node.tokens.push(line.slice(i, j));
          i = j;
        }
        while (i < line.length && isWs(line[i])) i++;
        if (line[i] === '#') break;              // trailing comment
      }
      // remember how a line was written, so unchanged lines stay identical
      Object.defineProperty(node, 'src', { value: { lead: line.slice(0, lineStart), text: line.slice(lineStart).replace(/\r$/, ''),
        tokens: node.tokens.join('\u0000'), depth }, writable: true, enumerable: false, configurable: true });
    }
    return { root, warnings };
  }

  // ── writing (same rules as the game's DataWriter) ──
  function quote(tok) {
    tok = String(tok);
    const hasQuote = tok.includes('"');
    const hasTick  = tok.includes('`');
    if (hasQuote && hasTick) throw new Error(`Token cannot be written (contains both " and \`): ${tok}`);
    if (hasQuote) return '`' + tok + '`';
    // A bare token starting with '#' would read back as a comment; the game's
    // own writer doesn't guard this, but a quoted one loads correctly.
    if (tok === '' || hasTick || /\s/.test(tok) || tok[0] === '#') return '"' + tok + '"';
    return tok;
  }

  // tree → text
  function stringify(root) {
    const out = [];
    // visit every node
    const walk = (nodes, depth) => {
      const indent = '\t'.repeat(depth);
      for (const n of nodes) {
        if (n.blank)                 { out.push(''); continue; }
        if (n.comment !== undefined) { out.push(indent + '#' + n.comment); continue; }
        const src = n.src;
        if (src && src.depth === depth && src.tokens === n.tokens.join('\u0000')) out.push(src.lead + src.text);
        else out.push(indent + n.tokens.map(quote).join(' '));
        if (n.children.length) walk(n.children, depth + 1);
      }
    };
    walk(root.children, 0);
    const eol = root.eol || '\n';
    return out.join(eol) + eol;
  }

  // number → token (whole numbers stay whole)
  function num(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Not a finite number: ${v}`);
    return String(Object.is(n, -0) ? 0 : n);
  }
  // token → number
  const toNum = (tok, fallback = 0) => {
    if (tok === undefined || tok === null || tok === '') return fallback;
    const n = Number(tok);
    return Number.isFinite(n) ? n : fallback;
  };

  // ── tree helpers ──
  const kids    = (n, k) => n.children.filter(c => isData(c) && c.tokens[0] === k);
  // first child with this key
  const kid     = (n, k) => n.children.find(c => isData(c) && c.tokens[0] === k) || null;
  // its first value
  const val     = (n, k, i = 1) => { const c = kid(n, k); return c ? c.tokens[i] : undefined; };
  // set it (create if missing)
  function setVal(n, k, ...values) {
    let c = kid(n, k);
    if (!c) { c = makeNode([k]); n.children.push(c); }
    c.tokens = [k, ...values.map(String)];
    return c;
  }
  // remove children with this key
  function removeKid(n, k) {
    const before = n.children.length;
    n.children = n.children.filter(c => !(isData(c) && c.tokens[0] === k));
    return before !== n.children.length;
  }
  const clone = n => JSON.parse(JSON.stringify(n));

  // new uuid
  function uuidV4() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const b = [];
    for (let i = 0; i < 16; i++) b.push(Math.floor(Math.random() * 256));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // Canonical top-level order (PlayerInfo::Save). Used only when a block
  // has to be CREATED, so it lands where the game would have written it.
  const TOP_ORDER = [
    'pilot', 'original name', 'date', 'marked event changes today', 'system entry method',
    'previous system', 'previous planet', 'system', 'planet', 'clearance', 'playtime', 'launching',
    'cloaked', 'travel', 'travel destination', 'flagship index', 'map coloring', 'map zoom',
    'collapsed', 'reputation with', 'tribute received', 'max escort count', 'max escort crew',
    'admin cap', 'ship', 'groups', 'storage', 'licenses', 'account', 'cargo', 'basis', 'stock',
    'fleet depreciation', 'stock depreciation', 'mission', 'mission cargo', 'mission passengers',
    'available job', 'available mission', 'sort type', 'sort descending', 'separate deadline',
    'separate possible', 'conditions', 'gifted ships', 'event', 'changes', 'economy', 'destroyed',
    'visited', 'visited planet', 'harvested', 'logbook', 'start', 'plugins', 'message log',
  ];
  const MISSION_KEYS = ['mission', 'available job', 'available mission'];
  // Ship::Save order: identity lines first, per-instance state after the hardpoints.
  const SHIP_HEAD_KEYS = ['name', 'display name', 'plural', 'noun', 'never disabled', 'uncapturable',
    'swizzle', 'administrative cost', 'uuid'];
  const SHIP_TAIL_KEYS = ['crew', 'fuel', 'shields', 'hull', 'position', 'formation', 'system', 'planet',
    'destination system', 'parked'];
  const SHIP_STATE_KEYS = [...SHIP_HEAD_KEYS, ...SHIP_TAIL_KEYS];
  // these belong to the ship's design and get replaced on refit
  const SHIP_DESIGN_KEYS = ['display name', 'plural', 'noun'];

  // ── SaveFile: typed access to a save ──
  class SaveFile {
    constructor(text) {
      const { root, warnings } = parse(text);
      this.root = root;
      this.warnings = warnings;
    }
    static fromText(text) { return new SaveFile(text); }
    toString() { return stringify(this.root); }

    // ── generic ──
    top(k)     { return kid(this.root, k); }
    topAll(k)  { return kids(this.root, k); }
    topKeys()  { return [...new Set(this.root.children.filter(isData).map(key))]; }

    // find or create a top-level node in its usual place
    ensureTop(k, tokens) {
      let n = this.top(k);
      if (n) return n;
      n = makeNode(tokens || [k]);
      const rank = TOP_ORDER.indexOf(k);
      const idx = rank === -1 ? -1 : this.root.children.findIndex(c => {
        const r = TOP_ORDER.indexOf(key(c));
        return r > rank;
      });
      if (idx === -1) this.root.children.push(n); else this.root.children.splice(idx, 0, n);
      return n;
    }
    _setTopValue(k, ...values) {
      const n = this.ensureTop(k);
      n.tokens = [k, ...values.map(String)];
      return n;
    }

    // ── pilot, location, time ──
    get pilot() {
      const n = this.top('pilot');
      return { first: n ? n.tokens[1] || '' : '', last: n ? n.tokens[2] || '' : '' };
    }
    setPilot(first, last) { this._setTopValue('pilot', first, last); }

    get date() {
      const n = this.top('date');
      return n ? { day: toNum(n.tokens[1]), month: toNum(n.tokens[2]), year: toNum(n.tokens[3]) } : null;
    }
    setDate(day, month, year) { this._setTopValue('date', num(day), num(month), num(year)); }

    get system()   { return val(this.root, 'system'); }
    get planet()   { return val(this.root, 'planet'); }
    setLocation(system, planet) {
      this._setTopValue('system', system);
      if (planet) this._setTopValue('planet', planet); else removeKid(this.root, 'planet');
    }
    get playtime() { return toNum(val(this.root, 'playtime')); }
    get flagshipIndex() { const v = val(this.root, 'flagship index'); return v === undefined ? null : toNum(v, -1); }
    setFlagshipIndex(i) { this._setTopValue('flagship index', num(i)); }

    // ── account (credits) ──
    get credits() { const a = this.top('account'); return a ? BigInt(val(a, 'credits') || '0') : 0n; }
    setCredits(amount) {
      const a = this.ensureTop('account');
      const v = BigInt(typeof amount === 'number' ? Math.trunc(amount) : amount);
      const c = kid(a, 'credits');
      if (c) c.tokens = ['credits', v.toString()];
      else a.children.unshift(makeNode(['credits', v.toString()]));
    }
    addCredits(delta) { this.setCredits(this.credits + BigInt(delta)); }
    get account() {
      const a = this.top('account');
      if (!a) return null;
      const income = kid(a, 'salaries income');
      return {
        credits: this.credits,
        score: toNum(val(a, 'score')),
        salariesOwed: toNum(val(a, 'salaries')),
        maintenanceDue: toNum(val(a, 'maintenance')),
        salariesIncome: income ? Object.fromEntries(income.children.filter(isData).map(c => [c.tokens[0], toNum(c.tokens[1])])) : {},
        history: (kid(a, 'history')?.children || []).filter(isData).map(c => toNum(c.tokens[0])),
        mortgages: kids(a, 'mortgage').map(m => ({
          type: m.tokens[1] || 'Mortgage',
          principal: toNum(val(m, 'principal')),
          interest: toNum(val(m, 'interest')),
          term: toNum(val(m, 'term')),
          node: m,
        })),
      };
    }

    // ── conditions ──
    get conditions() {
      const out = {};
      for (const c of this.topAll('conditions'))
        for (const n of c.children.filter(isData)) out[n.tokens[0]] = n.tokens.length > 1 ? toNum(n.tokens[1]) : 1;
      return out;
    }
    getCondition(name) { return this.conditions[name] || 0; }
    setCondition(name, value) {
      const blocks = this.topAll('conditions');
      if (!blocks.length) blocks.push(this.ensureTop('conditions'));
      const v = Math.trunc(Number(value) || 0);
      const tokens = v === 1 ? [name] : [name, String(v)];
      blocks.forEach((c, b) => {
        const i = c.children.findIndex(n => isData(n) && n.tokens[0] === name);
        if (v === 0 || (b > 0 && i === -1)) { if (i !== -1) c.children.splice(i, 1); return; }
        if (i === -1) c.children.push(makeNode(tokens)); else c.children[i].tokens = tokens;
      });
    }
    deleteCondition(name) { this.setCondition(name, 0); }

    // ── reputation ──
    get reputations() {
      const r = this.top('reputation with');
      return r ? Object.fromEntries(r.children.filter(isData).map(n => [n.tokens[0], toNum(n.tokens[1])])) : {};
    }
    setReputation(government, value) {
      const r = this.ensureTop('reputation with');
      const n = kid(r, government);
      if (n) n.tokens = [government, num(value)]; else r.children.push(makeNode([government, num(value)]));
    }

    // ── licences ──
    get licenses() { return (this.top('licenses')?.children || []).filter(isData).map(n => n.tokens[0]); }
    addLicense(name) {
      const l = this.ensureTop('licenses');
      if (!kid(l, name)) l.children.push(makeNode([name]));
    }
    removeLicense(name) {
      const l = this.top('licenses');
      if (!l) return;
      removeKid(l, name);
      if (!l.children.some(isData)) this.root.children = this.root.children.filter(c => c !== l);
    }

    // ── cargo ──
    get cargo() { return readCargoHold(this.top('cargo')); }
    setCargoCommodity(name, tons)  { writeCargoItem(this.ensureTop('cargo'), 'commodities', name, tons); }
    setCargoOutfit(name, count)    { writeCargoItem(this.ensureTop('cargo'), 'outfits', name, count); }

    // ── planet storage ──
    get storage() {
      const s = this.top('storage');
      return (s?.children || []).filter(n => isData(n) && n.tokens[0] === 'planet').map(p => ({
        planet: p.tokens[1], ...readCargoHold(kid(p, 'cargo')),
      }));
    }
    setStoredOutfit(planet, outfit, count) {
      const s = this.ensureTop('storage');
      let p = s.children.find(n => isData(n) && n.tokens[0] === 'planet' && n.tokens[1] === planet);
      if (!p) { p = makeNode(['planet', planet]); s.children.push(p); }
      let c = kid(p, 'cargo');
      if (!c) { c = makeNode(['cargo']); p.children.push(c); }
      writeCargoItem(c, 'outfits', outfit, count);
      if (!c.children.some(isData)) p.children = p.children.filter(x => x !== c);
      if (!p.children.some(isData)) s.children = s.children.filter(x => x !== p);
    }

    // ── ships ──
    get ships() {
      const nodes = this.root.children;
      const out = [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!isData(n) || n.tokens[0] !== 'ship') continue;
        // groups line applies to the ship BEFORE it
        let groups = null;
        for (let j = i + 1; j < nodes.length; j++) {
          if (!isData(nodes[j])) continue;
          if (nodes[j].tokens[0] === 'groups') groups = toNum(nodes[j].tokens[1]);
          break;
        }
        out.push(new ShipView(this, n, out.length, groups));
      }
      return out;
    }
    ship(indexOrUuid) {
      const all = this.ships;
      return typeof indexOrUuid === 'number' ? all[indexOrUuid] || null : all.find(s => s.uuid === indexOrUuid) || null;
    }
    get flagship() { const i = this.flagshipIndex; return i === null || i < 0 ? null : this.ship(i); }

    // remove a ship (and its groups line, mission cargo, flags)
    removeShip(indexOrUuid) {
      const s = this.ship(indexOrUuid);
      if (!s) return false;
      const nodes = this.root.children;
      const at = nodes.indexOf(s.node);
      let end = at + 1;
      while (end < nodes.length && !isData(nodes[end])) end++;
      const removeCount = (end < nodes.length && key(nodes[end]) === 'groups') ? end - at + 1 : 1;
      nodes.splice(at, removeCount);

      const fi = this.flagshipIndex;
      if (fi !== null && fi >= 0) {
        if (fi === s.index) this.setFlagshipIndex(this.ships.length ? 0 : -1);
        else if (fi > s.index) this.setFlagshipIndex(fi - 1);
      }
      if (s.uuid) this._dropCargoAllocations(n => n.tokens[1] === s.uuid);
      return true;
    }

    // copy a ship with a new uuid
    duplicateShip(indexOrUuid, newName) {
      const s = this.ship(indexOrUuid);
      if (!s) return null;
      const copy = clone(s.node);
      setVal(copy, 'uuid', uuidV4());
      if (newName !== undefined) setVal(copy, 'name', newName);
      // insert after the last ship (and its groups line) so indices of existing ships don't shift
      const nodes = this.root.children;
      let insertAt = -1;
      nodes.forEach((n, i) => { if (key(n) === 'ship' || key(n) === 'groups') insertAt = i; });
      nodes.splice(insertAt + 1, 0, copy);
      return this.ships[this.ships.length - 1];
    }

    // replace a ship's design (e.g. with a builder design)
    replaceShipDefinition(indexOrUuid, definition, { levels } = {}) {
      const s = this.ship(indexOrUuid);
      if (!s) throw new Error('Ship not found');
      const def = typeof definition === 'string'
        ? parse(definition).root.children.find(n => isData(n) && n.tokens[0] === 'ship')
        : clone(definition);
      if (!def) throw new Error('No ship block found in the definition text');
      const old = s.node;
      const kept = new Map();
      for (const k of SHIP_STATE_KEYS) { if (SHIP_DESIGN_KEYS.includes(k)) continue; const n = kid(old, k); if (n) kept.set(k, clone(n)); }
      const design = def.children.filter(n => isData(n) && SHIP_DESIGN_KEYS.includes(n.tokens[0]));
      const body = def.children.filter(n => !(isData(n) && SHIP_STATE_KEYS.includes(n.tokens[0])));
      const head = [...SHIP_HEAD_KEYS.filter(k => kept.has(k)).map(k => kept.get(k)), ...design];
      const tail = SHIP_TAIL_KEYS.filter(k => kept.has(k)).map(k => kept.get(k));
      // ship "Model" "Variant" stays as it is
      old.tokens = def.tokens.length >= 3 ? ['ship', def.tokens[1], def.tokens[2]] : ['ship', def.tokens[1] || s.model];
      old.children = [...head, ...body, ...tail];
      if (levels) this._setLevels(old, levels);
      return this.ship(s.index);
    }

    // add a new ship (gets a fresh uuid and sits at the flagship's planet)
    addShip(definition, { name, system, planet, levels, parked = false } = {}) {
      const def = typeof definition === 'string'
        ? parse(definition).root.children.find(n => isData(n) && n.tokens[0] === 'ship')
        : clone(definition);
      if (!def) throw new Error('No ship block found');
      const design = def.children.filter(n => isData(n) && SHIP_DESIGN_KEYS.includes(n.tokens[0]));
      const body = def.children.filter(n => !(isData(n) && SHIP_STATE_KEYS.includes(n.tokens[0])));
      def.children = [makeNode(['name', name || def.tokens[2] || def.tokens[1]]), ...design, ...body, makeNode(['uuid', uuidV4()])];
      this._setLevels(def, levels || {});
      const sys = system || this.system, pl = planet === undefined ? this.planet : planet;
      if (sys) def.children.push(makeNode(['system', sys]));
      if (pl) def.children.push(makeNode(['planet', pl]));
      if (parked) def.children.push(makeNode(['parked']));
      const nodes = this.root.children;
      let insertAt = -1;
      nodes.forEach((n, i) => { if (key(n) === 'ship' || key(n) === 'groups') insertAt = i; });
      if (insertAt === -1) {
        // no ships yet: put it where the game would (before storage/licenses/account…)
        const rank = TOP_ORDER.indexOf('ship');
        insertAt = nodes.findIndex(c => TOP_ORDER.indexOf(key(c)) > rank) - 1;
        if (insertAt < -1) insertAt = nodes.length - 1;
      }
      nodes.splice(insertAt + 1, 0, def);
      // only pick a flagship if this is the pilot's first ship; -1 with other
      // ships means "no flagship chosen" and the game picks one itself
      if (this.ships.length === 1) this.setFlagshipIndex(0);
      return this.ships.find(x => x.node === def);
    }

    _setLevels(shipNode, levels) {
      for (const k of ['crew', 'fuel', 'shields', 'hull']) {
        if (levels[k] === undefined || levels[k] === null) continue;
        const v = k === 'crew' ? Math.trunc(levels[k]) : levels[k];
        const at = shipNode.children.findIndex(n => isData(n) && n.tokens[0] === k);
        const n = makeNode([k, num(v)]);
        if (at !== -1) shipNode.children[at] = n;
        else {
          // keep Ship::Save's order: after hardpoints, before position/system
          const before = shipNode.children.findIndex(c => isData(c) && ['position', 'formation', 'system', 'planet', 'destination system', 'parked'].includes(c.tokens[0]));
          if (before === -1) shipNode.children.push(n); else shipNode.children.splice(before, 0, n);
        }
      }
    }

    // ── missions ──
    get missions() {
      return this.root.children.filter(n => isData(n) && MISSION_KEYS.includes(n.tokens[0])).map(n => ({
        kind: n.tokens[0],
        id: n.tokens[1],                                  // internal name — condition prefix
        displayName: val(n, 'name') || n.tokens[1],
        uuid: val(n, 'uuid') || null,
        deadline: (() => { const d = kid(n, 'deadline'); return d && d.tokens.length >= 4
          ? { day: toNum(d.tokens[1]), month: toNum(d.tokens[2]), year: toNum(d.tokens[3]) } : null; })(),
        destination: val(n, 'destination') || null,
        node: n,
      }));
    }

    // remove a mission by name
    removeMission(id, { kinds = MISSION_KEYS, conditions = false } = {}) {
      const gone = this.missions.filter(m => m.id === id && kinds.includes(m.kind));
      if (!gone.length && !conditions) return 0;
      const drop = new Set(gone.map(m => m.node));
      this.root.children = this.root.children.filter(n => !drop.has(n));
      const uuids = new Set(gone.map(m => m.uuid).filter(Boolean));
      if (uuids.size) this._dropCargoAllocations(n => uuids.has(n.tokens[0]));
      if (conditions) for (const s of ['offered', 'active', 'done', 'failed', 'declined']) this.deleteCondition(`${id}: ${s}`);
      return gone.length;
    }

    // drop its mission cargo / passengers
    _dropCargoAllocations(match) {
      for (const k of ['mission cargo', 'mission passengers']) {
        const block = this.top(k);
        if (!block) continue;
        for (const ps of kids(block, 'player ships')) ps.children = ps.children.filter(n => !(isData(n) && match(n)));
        if (!kids(block, 'player ships').some(ps => ps.children.some(isData)))
          this.root.children = this.root.children.filter(n => n !== block);
      }
    }

    // ── scheduled events ──
    get events() {
      return this.topAll('event').map(n => {
        const d = kid(n, 'date');
        return {
          name: n.tokens[1] || null,
          date: d ? { day: toNum(d.tokens[1]), month: toNum(d.tokens[2]), year: toNum(d.tokens[3]) } : null,
          inline: n.tokens.length < 2,
          node: n,
        };
      });
    }
    // schedule an event like the game does
    scheduleEvent(name, date) {
      const n = makeNode(['event', name], [makeNode(['date', num(date.day), num(date.month), num(date.year)])]);
      const nodes = this.root.children;
      let at = -1;
      nodes.forEach((c, i) => { if (key(c) === 'event') at = i; });
      if (at === -1) at = nodes.findIndex(c => key(c) === 'changes') - 1;
      if (at < -1) at = nodes.length - 1;
      nodes.splice(at + 1, 0, n);
      return n;
    }

    removeEvent(node) { const before = this.root.children.length; this.root.children = this.root.children.filter(n => n !== node); return before !== this.root.children.length; }

    // ── map knowledge ──
    get visitedSystems() { return this.topAll('visited').map(n => n.tokens[1]).filter(Boolean); }
    get visitedPlanets() { return this.topAll('visited planet').map(n => n.tokens[1]).filter(Boolean); }
    setVisitedSystem(name, visited = true) { this._setFlagLine('visited', name, visited); }
    setVisitedPlanet(name, visited = true) { this._setFlagLine('visited planet', name, visited); }
    _setFlagLine(k, name, on) {
      const has = this.root.children.some(n => isData(n) && n.tokens[0] === k && n.tokens[1] === name);
      if (on && !has) {
        // keep the game's sorted order within the run of lines
        const nodes = this.root.children;
        const run = nodes.map((n, i) => [n, i]).filter(([n]) => key(n) === k);
        const node = makeNode([k, name]);
        if (!run.length) {
          const anchor = this.ensureTop(k, [k, name]);     // creates at canonical position
          anchor.tokens = [k, name];
          return;
        }
        const after = run.find(([n]) => n.tokens[1] > name);
        nodes.splice(after ? after[1] : run[run.length - 1][1] + 1, 0, node);
      } else if (!on && has) {
        this.root.children = this.root.children.filter(n => !(isData(n) && n.tokens[0] === k && n.tokens[1] === name));
      }
    }
    // harvested: [{ system, outfit }]
    get harvested() {
      return (this.top('harvested')?.children || []).filter(isData).map(n => ({ system: n.tokens[0], outfit: n.tokens[1] }));
    }

    get plugins() { return (this.top('plugins')?.children || []).filter(isData).map(n => n.tokens[0]); }

    // ── checks before download ──
    get changes() { return this.topAll('changes').flatMap(c => c.children.filter(isData)); }

    // anything after the end of the save (the game always ends with plugins)
    trailingJunk() {
      const nodes = this.root.children;
      const at = nodes.findIndex(n => key(n) === 'plugins');
      if (at === -1) return [];
      const out = [];
      for (let i = at + 1; i < nodes.length; i++) {
        const n = nodes[i];
        if (!isData(n)) continue;
        if (key(n) === 'message log' && !out.length) continue;
        out.push(n);
      }
      return out;
    }
    removeTrailingJunk() {
      const junk = new Set(this.trailingJunk());
      if (!junk.size) return 0;
      const nodes = this.root.children;
      const at = nodes.findIndex(n => key(n) === 'plugins');
      let keepUntil = at;
      for (let i = at + 1; i < nodes.length; i++) if (isData(nodes[i]) && !junk.has(nodes[i])) keepUntil = i;
      const removed = nodes.length - keepUntil - 1;
      this.root.children = nodes.slice(0, keepUntil + 1);
      return removed;
    }

    validate() {
      const problems = [];
      const ships = this.ships;
      const fi = this.flagshipIndex;
      if (fi !== null && fi >= ships.length) problems.push(`flagship index ${fi} is out of range (${ships.length} ships)`);
      const seen = new Map();
      for (const s of ships) {
        if (!s.uuid) continue;
        if (seen.has(s.uuid)) problems.push(`ships ${seen.get(s.uuid)} and ${s.index} share uuid ${s.uuid}`);
        else seen.set(s.uuid, s.index);
      }
      const junk = this.trailingJunk();
      if (junk.length) problems.push(`${junk.length} leftover block${junk.length === 1 ? '' : 's'} after the end of the save (old data the game would load on top of this save)`);
      for (const k of ['conditions', 'changes', 'economy', 'account']) {
        const n = this.topAll(k).length;
        if (n > 1) problems.push(`the save has ${n} "${k}" sections — usually a sign of a damaged file`);
      }
      if (!this.top('pilot')) problems.push('missing "pilot" line');
      if (!this.top('date'))  problems.push('missing "date" line');
      try { stringify(this.root); } catch (e) { problems.push(e.message); }
      return problems;
    }
  }

  // ── cargo hold helpers ──
  function readCargoHold(cargoNode) {
    const out = { commodities: {}, outfits: {} };
    if (!cargoNode) return out;
    for (const section of ['commodities', 'outfits']) {
      const s = kid(cargoNode, section);
      if (s) for (const n of s.children.filter(isData)) out[section][n.tokens[0]] = (out[section][n.tokens[0]] || 0) + toNum(n.tokens[1], 1);
    }
    return out;
  }
  // set one cargo line
  function writeCargoItem(cargoNode, section, name, count) {
    let s = kid(cargoNode, section);
    const c = Math.trunc(Number(count) || 0);
    if (!s) { if (c <= 0) return; s = makeNode([section]); cargoNode.children.push(s); }
    const i = s.children.findIndex(n => isData(n) && n.tokens[0] === name);
    if (c <= 0) { if (i !== -1) s.children.splice(i, 1); }
    else if (i === -1) s.children.push(makeNode([name, String(c)]));
    else s.children[i].tokens = [name, String(c)];
    if (!s.children.some(isData)) cargoNode.children = cargoNode.children.filter(x => x !== s);
  }

  // ── ShipView: live access to one ship ──
  class ShipView {
    constructor(save, node, index, groups) { this.save = save; this.node = node; this.index = index; this.groups = groups; }
    get model()  { return this.node.tokens[1]; }
    get name()   { return val(this.node, 'name') || ''; }
    set name(v)  { setVal(this.node, 'name', v); }
    get uuid()   { return val(this.node, 'uuid') || null; }
    get isFlagship() { return this.save.flagshipIndex === this.index; }
    get crew()   { return toNum(val(this.node, 'crew')); }
    set crew(v)  { setVal(this.node, 'crew', num(Math.trunc(v))); }
    get fuel()   { return toNum(val(this.node, 'fuel')); }
    set fuel(v)  { setVal(this.node, 'fuel', num(v)); }
    get shields(){ return toNum(val(this.node, 'shields')); }
    set shields(v){ setVal(this.node, 'shields', num(v)); }
    get hull()   { return toNum(val(this.node, 'hull')); }
    set hull(v)  { setVal(this.node, 'hull', num(v)); }
    get system() { return val(this.node, 'system') || null; }
    get planet() { return val(this.node, 'planet') || null; }
    setLocation(system, planet) {
      setVal(this.node, 'system', system);
      if (planet) setVal(this.node, 'planet', planet); else removeKid(this.node, 'planet');
    }
    get parked() { return !!kid(this.node, 'parked'); }
    set parked(on) {
      if (on && !this.parked) this.node.children.push(makeNode(['parked']));
      if (!on) removeKid(this.node, 'parked');
    }
    // base attributes
    get attributes() {
      const a = kid(this.node, 'attributes');
      const out = {};
      if (a) for (const n of a.children.filter(isData)) if (!n.children.length) out[n.tokens[0]] = n.tokens.length > 1 ? (Number.isFinite(Number(n.tokens[1])) ? Number(n.tokens[1]) : n.tokens[1]) : true;
      return out;
    }
    setAttribute(k, v) {
      const a = kid(this.node, 'attributes') || (() => { const n = makeNode(['attributes']); this.node.children.push(n); return n; })();
      if (v === null || v === undefined || v === 0) { removeKid(a, k); return; }
      const n = kid(a, k);
      const tok = typeof v === 'number' ? num(v) : String(v);
      if (n) n.tokens = [k, tok]; else a.children.push(makeNode([k, tok]));
    }
    // installed outfits { name: count }
    get outfits() {
      const o = kid(this.node, 'outfits');
      const out = {};
      if (o) for (const n of o.children.filter(isData)) out[n.tokens[0]] = (out[n.tokens[0]] || 0) + toNum(n.tokens[1], 1);
      return out;
    }
    setOutfit(name, count) {
      let o = kid(this.node, 'outfits');
      const c = Math.trunc(Number(count) || 0);
      if (!o) {
        if (c <= 0) return;
        o = makeNode(['outfits']);
        const attrAt = this.node.children.findIndex(n => key(n) === 'attributes');
        this.node.children.splice(attrAt === -1 ? this.node.children.length : attrAt + 1, 0, o);
      }
      const first = o.children.findIndex(n => isData(n) && n.tokens[0] === name);
      o.children = o.children.filter(n => !(isData(n) && n.tokens[0] === name));
      if (c > 0) o.children.splice(first === -1 ? o.children.length : first, 0, makeNode(c === 1 ? [name] : [name, String(c)]));
    }
    // guns and turrets in save order
    get hardpoints() {
      return this.node.children.filter(n => isData(n) && (n.tokens[0] === 'gun' || n.tokens[0] === 'turret'))
        .map(n => ({ type: n.tokens[0], x: toNum(n.tokens[1]), y: toNum(n.tokens[2]), outfit: n.tokens[3] || null, node: n }));
    }
    mountOutfit(hardpointIndex, outfitName) {
      const hp = this.hardpoints[hardpointIndex];
      if (!hp) return false;
      hp.node.tokens = outfitName ? [hp.type, hp.node.tokens[1], hp.node.tokens[2], outfitName] : hp.node.tokens.slice(0, 3);
      return true;
    }
    // bays
    get bays() {
      return kids(this.node, 'bay').map(n => ({ category: n.tokens[1], x: toNum(n.tokens[2]), y: toNum(n.tokens[3]), node: n }));
    }
    toText() { return stringify({ children: [this.node] }); }
  }

  return { parse, stringify, quote, num, SaveFile, ShipView, uuidV4, TOP_ORDER };
});
