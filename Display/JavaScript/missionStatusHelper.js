'use strict';

// ═══════════════════════════════════════════════════════════
//  missionStatusHelper.js
//
//  The "helper" in loader → display → helper: takes data the loader
//  already fetched/formatted and data the save-file tooling already
//  parsed, and manipulates/combines them — it doesn't fetch or render
//  anything itself.
//
//  Reads a parsed Endless Sky save (as produced by esSaveParser.js and
//  stored by saveManager.js) directly from localStorage — no dependency
//  on saveManager.js or esSaveParser.js actually being loaded on the
//  page, since the save is already plain JSON by the time it's in
//  localStorage. Cross-references it against a mission's internal name
//  to answer: is this mission currently active, available-but-not-
//  accepted, completed, failed, declined, or never encountered — and,
//  for repeatable missions with a mixed history, says so honestly
//  instead of picking one outcome to report.
//
//  ── Why this isn't a naive done/failed binary ──────────────────────
//  Confirmed against a real save file (not assumed):
//    - `mission "X"` blocks and `"available job" "X"` blocks are TWO
//      SEPARATE keywords. A mission sitting in `mission` is genuinely
//      held (it carries a uuid, and if it had NPCs/on-enter triggers
//      set up when accepted, those are serialised too). A mission
//      sitting in `"available job"` merely passed its `to offer` roll
//      and is waiting on the job board — never accepted. There's no
//      ambiguity between these two once you use the right keyword.
//    - `"<name>: active"` is a COUNTER, not a boolean — incremented on
//      accept, decremented on complete/fail — and a real save was found
//      where a repeatable mission had BOTH `done: 14` and `failed: 2`
//      with no current `active`/held/available state at all. Reporting
//      that as just "failed" (or just "done") would be actively wrong.
//      So every status result carries the full counts, and `mixed` is
//      its own explicit status rather than a coin-flip between two.
//    - "Failed" doesn't always mean the player did something wrong —
//      some missions can structurally only ever resolve via `to fail`
//      (a literal always-false `to complete`). `unreachableCompletePath`
//      flags that narrow, confirmed-real pattern — see
//      hasUnreachableCompletePath() below for exactly what it does and
//      doesn't catch.
//
//  Public API on window.MissionStatusHelper:
//    .STATUS                        → the status string constants
//    .getCurrentSave()              → parsed save object, or null
//    .listSaves()                   → [{ id, label, pilotName, importedAt }]
//    .getSaveById(id)               → parsed save object, or null
//    .getMissionStatus(name, save?) → status object for ONE mission name
//    .getAllStatuses(save?)         → Map<name, statusObject> for every
//                                      name the save has ANY record of
//                                      (held, available, or in conditions)
//    .decorateMissions(missions, save?)
//                                    → given MissionLoader.getAllMissions()
//                                      output (or any array of objects with
//                                      a `.name`), returns the same array
//                                      with `.status` attached to each
//    .hasUnreachableCompletePath(rawEntries)
//                                    → pure utility, see the note above
// ═══════════════════════════════════════════════════════════

(function () {

// Same keys saveManager.js writes to — see that file's own header comment.
// Read directly rather than depending on saveManager.js being loaded,
// since by the time a save is in localStorage it's already plain JSON.
const SM_REGISTRY_KEY = 'ES_SM_REGISTRY';
const SM_SAVE_PREFIX  = 'ES_SM_SAVE_';
const SM_CURRENT_KEY  = 'ES_SM_CURRENT';

const STATUS = {
  IN_PROGRESS:     'in_progress',
  AVAILABLE:       'available_not_accepted',
  DONE:            'completed_successfully',
  FAILED:          'completed_unsuccessfully',
  DECLINED:        'declined',
  MIXED:           'mixed',
  OFFERED_ONLY:    'offered_only',
  NOT_ENCOUNTERED: 'not_encountered',
};

// ── "This status may not mean what it looks like" detector ──────
//
// Two separate, narrow, confirmed-real patterns where a mission's
// "Failed" or "Declined" status doesn't necessarily mean genuine
// failure or a player choosing to decline:
//
// PATTERN A — unreachable `to complete`: a mission whose `to complete`
// trigger is a literal always-false condition (a single child that's
// just the bare number 0) while a real `to fail` trigger exists.
// Structurally, such a mission can only ever resolve through `to fail`.
//
// PATTERN B — reward-then-self-resolve: an `on X` action block (on
// accept, on offer, on visit, ...) contains a bare `fail` or `decline`
// ACTION alongside real reward-granting actions (payment/outfit/ship/
// log) in that same block. Confirmed against a real mission
// ("Unfettered: Jump Drive Source"): its `on accept` grants a log
// entry, swaps an outfit, pays 1,000,000 credits, raises reputation —
// then calls `fail` as the very next action, purely to remove the
// mission from the active list once its one-time payout already
// happened. That's a deliberate "grant reward, then dismiss" pattern,
// not a failure — but it does leave a real "<name>: failed" condition
// behind, same as a genuine failure would.
//
// IMPORTANT — raw-tree shape: both patterns key off the exact { key,
// values, children } convention missionParser.js's catalog data uses:
// `to offer` / `on accept` are NOT merged into one string key — they're
// `{ key: "to"/"on", values: ["offer"/"accept", ...] }`. esSaveParser.js
// builds save-file mission trees the same way (confirmed, and fixed
// here after finding a mismatch), so this works identically whichever
// source the raw tree came from.
//
// This is deliberately narrow — it catches exactly these two confirmed
// patterns, nothing broader. A mission could resolve unusually in some
// OTHER way this doesn't recognise (there's no way to enumerate every
// possible mission script). So: the ABSENCE of a flag does NOT mean a
// failure/decline was genuine — it only means neither known pattern was
// the cause. Always treat a flag as "worth a second look", never a
// verdict, and treat its absence as "nothing detected", not "confirmed
// genuine."
function _triggerBlock(rawEntries, lead, subtype) {
  return (rawEntries || []).find(e => e.key === lead && e.values && e.values[0] === subtype);
}

function _unreachableCompletePath(rawEntries) {
  const toComplete = _triggerBlock(rawEntries, 'to', 'complete');
  const toFail      = _triggerBlock(rawEntries, 'to', 'fail');
  if (!toComplete || !toFail) return false;

  const kids = toComplete.children;
  const looksAlwaysFalse = Array.isArray(kids) && kids.length === 1 &&
      (kids[0].key === '0' || kids[0].key === 'never') && (!kids[0].values || kids[0].values.length === 0);
  if (!looksAlwaysFalse) return false;

  // `to fail` needs to actually say something — not itself be an
  // equally-trivial placeholder.
  return !!((toFail.children && toFail.children.length) || (toFail.values && toFail.values.length > 1));
}

const REWARD_ACTION_KEYS = new Set(['payment', 'outfit', 'give', 'log', 'ship']);
const SELF_RESOLVE_KEYS  = new Set(['fail', 'decline']);

function _rewardThenSelfResolve(rawEntries) {
  for (const entry of (rawEntries || [])) {
    if (entry.key !== 'on') continue; // action blocks only, not "to" declarative triggers
    const kids = entry.children || [];
    const resolveAction = kids.find(c => SELF_RESOLVE_KEYS.has(c.key) && (!c.values || c.values.length === 0));
    if (!resolveAction) continue;
    // Background helper: ends itself the moment it's offered, after doing its
    // work (starting an event, setting conditions …). Common for plugin
    // "compatibility" missions — "failed" there just means it has run.
    const trigger = entry.values && entry.values[0];
    if (trigger === 'offer') return { trigger, resolveAction: resolveAction.key, helper: true,
      actions: kids.filter(c => !SELF_RESOLVE_KEYS.has(c.key)).map(c => c.key) };
    const hasReward = kids.some(c => REWARD_ACTION_KEYS.has(c.key));
    if (hasReward) {
      return { trigger: entry.values && entry.values[0], resolveAction: resolveAction.key };
    }
  }
  return null;
}

// Combines both patterns into one flag + a human-readable reason, since
// a consumer just needs "should I double-check this one" plus enough
// context to know where to look — not two separate booleans to juggle.
function detectQuestionableResolution(rawEntries) {
  if (!Array.isArray(rawEntries)) return { flagged: false, reason: null };

  if (_unreachableCompletePath(rawEntries)) {
    return { flagged: true, reason: 'Its "to complete" condition looks unreachable — it may only ever resolve via "to fail".' };
  }

  const b = _rewardThenSelfResolve(rawEntries);
  if (b && b.helper) {
    const did = b.actions.includes('event') ? 'starts its story event' : b.actions.length ? 'makes its changes' : 'is checked';
    return { flagged: true, helper: true, reason: `A background mission: as soon as it's offered it ${did} and then ends itself with "${b.resolveAction}". So "${b.resolveAction === 'fail' ? 'failed' : 'declined'}" just means it has run — nothing went wrong.` };
  }
  if (b) {
    return { flagged: true, reason: `Its "on ${b.trigger}" block grants a reward and then calls "${b.resolveAction}" right after — that looks like a deliberate way to end the mission after a one-time payout, not a real ${b.resolveAction === 'fail' ? 'failure' : 'decline'}.` };
  }

  return { flagged: false, reason: null };
}

// Kept as a thin alias — some callers may already reference this name.
function hasUnreachableCompletePath(rawEntries) {
  return detectQuestionableResolution(rawEntries).flagged;
}

// ── "Is its completion condition met?" ───────────────────────
//
// Evaluates a mission's `to complete` condition set against the save's
// conditions, following Endless Sky's ConditionSet rules: top-level lines
// are ANDed; `has X` / `not X` / `never`; `and` / `or` blocks; comparisons
// like `"x" >= 3` with + and - arithmetic. Anything it can't evaluate
// (other operators, built-in conditions it can't know) makes the whole
// result `null` — never a guess.
//
// Returns { value: true|false|null, positives } where `positives` counts
// checks that were satisfied by a condition the save actually HAS. A
// mission is only treated as complete when value is true AND positives > 0,
// so a block made only of `not "..."` checks can't mark it complete just
// because the save lacks those conditions.
const _CMP = ['==', '!=', '<=', '>=', '<', '>'];
// `conds` is either a plain { name: value } map or a function name → number|null
// (null = "can't know", which makes the whole check unknown).
function _condValue(conds, name) {
  if (typeof conds === 'function') return conds(name);
  const v = conds ? conds[name] : undefined;
  return typeof v === 'number' ? v : (v ? 1 : 0);
}
function _evalExpr(tokens, conds) {
  // term ((+|-) term)*   — terms are numbers or condition names
  if (!tokens.length) return null;
  let total = 0, sign = 1, expectTerm = true, usedPresent = false;
  for (const t of tokens) {
    if (expectTerm) {
      if (t === '(' || t === ')' || t === '*' || t === '/' || t === '%') return null;
      const n = Number(t);
      if (Number.isFinite(n) && String(t).trim() !== '') total += sign * n;
      else { const v = _condValue(conds, t); if (v === null) return null; if (v !== 0) usedPresent = true; total += sign * v; }
      expectTerm = false;
    } else {
      if (t === '+') sign = 1; else if (t === '-') sign = -1; else return null;
      expectTerm = true;
    }
  }
  return expectTerm ? null : { value: total, usedPresent };
}
function _evalLine(entry, conds) {
  const tokens = [entry.key, ...(entry.values || [])].map(String);
  const head = tokens[0];
  if (head === 'never') return { value: false, positives: 0 };
  if (head === 'and' || head === 'or') {
    const kids = (entry.children || []).map(c => _evalLine(c, conds));
    if (head === 'and') return _combineAnd(kids);
    if (kids.some(k => k.value === true)) return { value: true, positives: kids.filter(k => k.value === true).reduce((n, k) => n + k.positives, 0) };
    return kids.some(k => k.value === null) ? { value: null, positives: 0 } : { value: false, positives: 0 };
  }
  if (head === 'has' && tokens.length === 2) {
    const c = _condValue(conds, tokens[1]); if (c === null) return { value: null, positives: 0 };
    return { value: c !== 0, positives: c !== 0 ? 1 : 0 };
  }
  if (head === 'not' && tokens.length === 2) {
    const c = _condValue(conds, tokens[1]); if (c === null) return { value: null, positives: 0 };
    return { value: c === 0, positives: 0 };
  }
  const opAt = tokens.findIndex((t, i) => i > 0 && _CMP.includes(t));
  if (opAt === -1) {
    const e = _evalExpr(tokens, conds);
    return e ? { value: e.value !== 0, positives: e.value !== 0 && e.usedPresent ? 1 : 0 } : { value: null, positives: 0 };
  }
  const l = _evalExpr(tokens.slice(0, opAt), conds), r = _evalExpr(tokens.slice(opAt + 1), conds);
  if (!l || !r) return { value: null, positives: 0 };
  const a = l.value, b = r.value;
  const v = { '==': a === b, '!=': a !== b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b }[tokens[opAt]];
  return { value: v, positives: v && (l.usedPresent || r.usedPresent) && a !== 0 ? 1 : 0 };
}
function _combineAnd(results) {
  if (results.some(r => r.value === false)) return { value: false, positives: 0 };
  if (results.some(r => r.value === null)) return { value: null, positives: 0 };
  return { value: true, positives: results.reduce((n, r) => n + r.positives, 0) };
}
function evaluateConditionSet(children, conds) {
  if (!Array.isArray(children) || !children.length) return { value: null, positives: 0 };
  return _combineAnd(children.map(c => _evalLine(c, conds)));
}
/** true when the mission's own `to complete` is satisfied by this save. */
function completeConditionMet(rawEntries, conds) {
  const block = _triggerBlock(rawEntries, 'to', 'complete');
  if (!block) return false;
  const r = evaluateConditionSet(block.children, conds);
  return r.value === true && r.positives > 0;
}

// ── "Can this pilot be offered it?" ──────────────────────────
//
// Mirrors Mission::CanOffer's condition checks (not the location ones —
// the game also needs you to be at the right planet, which the card
// already shows): `to offer` must pass, `to fail` must not, and the
// mission must not have been offered as many times as `repeat` allows.
//
// Conditions come from the save, plus the ones the game derives from save
// data instead of storing (credits, date, licenses, visited systems and
// planets, reputation). Other derived conditions (flagship stats, cargo,
// random rolls, …) can't be known here, so a check that uses them is
// reported as "unknown" rather than guessed.
// Fallback list — see conditionGetter(); the real list is parsed from the game.
const DERIVED_UNKNOWN = ['flagship ', 'ships: ', 'ship model: ', 'outfit: ', 'outfit (', 'installed ', 'random', 'roll:',
  'net worth', 'salary', 'tribute', 'cargo ', 'passenger', 'bunks', 'crew', 'person destroyed', 'days since',
  'hyperjumps', 'distance', 'role: ', 'weekday', 'total ', 'global ', 'unpaid', 'previous system', 'previous planet',
  'combat rating', 'armament deterrence', 'cargo attractiveness', 'raid chance', 'gross ', 'drag', 'mass',
  'month count', 'days until', 'day of', 'credit score'];
function conditionGetter(save) {
  const conds = (save && save.pilot && save.pilot.conditions) || {};
  const date = String((save && save.pilot && save.pilot.date) || '').trim().split(/\s+/).map(Number);
  const lic = new Set((save && save.licenses) || []);
  const vs = new Set((save && save.visitedSystems) || []);
  const vp = new Set((save && save.visitedPlanets) || []);
  const rep = (save && save.pilot && save.pilot.reputations) || {};
  const plugins = new Set((save && save.plugins) || []);
  const fullName = String(save?.pilot?.name || '').trim();
  const [first, ...rest] = fullName.split(/\s+/);
  const last = rest.join(' ');
  const fi = save?.pilot?.flagshipIndex;
  const flagshipModel = Array.isArray(save?.ships) && fi != null && save.ships[fi] ? (save.ships[fi]._modelName || save.ships[fi].model || null) : null;
  const derived = window.GameKeys ? window.GameKeys.derivedConditions() : null;
  return name => {
    if (Object.prototype.hasOwnProperty.call(conds, name)) { const v = conds[name]; return typeof v === 'number' ? v : (v ? 1 : 0); }
    if (name === 'credits') return Number(save?.account?.credits) || 0;
    if (name === 'day' && date.length === 3) return date[0];
    if (name === 'month' && date.length === 3) return date[1];
    if (name === 'year' && date.length === 3) return date[2];
    if (name.startsWith('license: ')) return lic.has(name.slice(9)) ? 1 : 0;
    if (name.startsWith('visited system: ')) return vs.has(name.slice(16)) ? 1 : 0;
    if (name.startsWith('visited planet: ')) return vp.has(name.slice(16)) ? 1 : 0;
    if (name.startsWith('reputation: ')) return Number(rep[name.slice(12)]) || 0;
    if (name.startsWith('installed plugin: ')) return plugins.has(name.slice(18)) ? 1 : 0;
    if (name.startsWith('flagship model: ') && flagshipModel) return flagshipModel === name.slice(16) ? 1 : 0;
    if (name.startsWith('first name: ') && first) return first === name.slice(12) ? 1 : 0;
    if (name.startsWith('last name: ') && last) return last === name.slice(11) ? 1 : 0;
    if (name.startsWith('name: ') && fullName) return fullName === name.slice(6) ? 1 : 0;
    // Anything else the game computes rather than stores can't be known
    // here. The list comes from the parser (PlayerInfo.cpp / AI.cpp
    // conditions[...].ProvideNamed / ProvidePrefixed); DERIVED_UNKNOWN is
    // only the fallback until it has loaded.
    if (derived) {
      if (derived.named.has(name) || derived.prefixed.some(p => name.startsWith(p))) return null;
    } else if (DERIVED_UNKNOWN.some(p => name.startsWith(p))) return null;
    return 0;
  };
}
function _repeatLimit(raw) {
  const r = (raw || []).find(e => e.key === 'repeat');
  if (!r) return 1;
  const n = Number(r.values && r.values[0]);
  return Number.isFinite(n) ? n : 0;            // bare `repeat` = unlimited
}
const _lineText = e => [e.key, ...(e.values || [])].map(v => /\s/.test(String(v)) ? `"${v}"` : String(v)).join(' ');

/**
 * → { state, label, missing: string[] }
 *   state: 'active' | 'used_up' | 'now' | 'almost' | 'not_yet' | 'unknown'
 */
function offerabilityFor(name, raw, save, status) {
  if (!Array.isArray(raw)) return { state: 'unknown', label: 'No mission data', missing: [] };
  if (status && status.isHeld) return { state: 'active', label: 'Already accepted', missing: [] };
  const get = conditionGetter(save);
  const lim = _repeatLimit(raw);
  const offered = get(`${name}: offered`) || 0;
  if (lim > 0 && offered >= lim) return { state: 'used_up', label: lim === 1 ? 'Already offered — it won’t come back' : `Offered ${offered}/${lim} times — no more offers`, missing: [] };

  const toFail = _triggerBlock(raw, 'to', 'fail');
  if (toFail && toFail.children && toFail.children.length) {
    const f = evaluateConditionSet(toFail.children, get);
    if (f.value === true) return { state: 'not_yet', label: 'Its “to fail” condition is already met', missing: [] };
  }
  const toOffer = _triggerBlock(raw, 'to', 'offer');
  if (!toOffer || !toOffer.children || !toOffer.children.length) return { state: 'now', label: 'No requirements', missing: [] };

  const results = toOffer.children.map(c => ({ entry: c, r: _evalLine(c, get) }));
  const failed = results.filter(x => x.r.value === false);
  const unknown = results.filter(x => x.r.value === null);
  if (!failed.length && !unknown.length) return { state: 'now', label: 'Requirements met', missing: [] };
  if (!failed.length) return { state: 'unknown', label: 'Depends on things this page can’t check', missing: unknown.map(x => _lineText(x.entry)) };
  if (failed.length === 1 && !unknown.length) return { state: 'almost', label: 'One requirement left', missing: [_lineText(failed[0].entry)] };
  return { state: 'not_yet', label: `${failed.length} requirements not met`, missing: failed.map(x => _lineText(x.entry)) };
}

// ── Save-file access ─────────────────────────────────────────
function _readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[missionStatusHelper] Could not read', key, e);
    return null;
  }
}

function listSaves() {
  return _readJSON(SM_REGISTRY_KEY) || [];
}

function getSaveById(id) {
  if (!id) return null;
  // Big saves don't fit in localStorage; saveCache.js rebuilds them from the stored file.
  return _readJSON(SM_SAVE_PREFIX + id) || (window.EsSaveCache ? window.EsSaveCache.get(id) : null);
}

function getCurrentSave() {
  const id = _readJSON(SM_CURRENT_KEY);
  return id ? getSaveById(id) : null;
}

// ── Core status logic ────────────────────────────────────────
//
// Priority when a mission has BOTH a live state (held/available) AND
// leftover history from earlier cycles (a repeatable mission done or
// failed before): the live state wins for `status`, but the historical
// counts are never dropped — they're always in `counts`, and folded
// into `label` as a parenthetical so a repeatable mission's full story
// doesn't disappear just because it's active again.
function getMissionStatus(name, save) {
  save = save === undefined ? getCurrentSave() : save;

  const counts = { offered: 0, active: 0, done: 0, failed: 0, declined: 0 };
  if (save && save.pilot && save.pilot.conditions) {
    const c = save.pilot.conditions;
    for (const key of Object.keys(counts)) {
      const v = c[`${name}: ${key}`];
      // Conditions are stored as `true` when the save just has the bare
      // condition name with no trailing number (count of 1, effectively),
      // or a number when it does.
      counts[key] = typeof v === 'number' ? v : (v ? 1 : 0);
    }
  }

  const isHeld      = !!(save && Array.isArray(save.missions)     && save.missions.some(m => m.name === name));
  const isAvailable = !!(save && Array.isArray(save.availableJobs) && save.availableJobs.some(m => m.name === name));

  // Checked here ONLY against the save's own copy of a currently-held
  // mission (the live, most-trustworthy source). For missions that have
  // already resolved (not held), decorateMissions() layers an
  // additional check against the plugin catalog's static definition,
  // since the save no longer carries that mission's structure once it's
  // no longer active (in particular, pattern B below needs the on-accept/
  // on-offer blocks, which a held save copy typically no longer has —
  // those already fired once, back when the mission was accepted).
  let unreachableCompletePath = false;
  let unreachableCompletePathReason = null;
  if (isHeld) {
    const heldEntry = save.missions.find(m => m.name === name);
    if (heldEntry) {
      const detected = detectQuestionableResolution(heldEntry.raw);
      unreachableCompletePath = detected.flagged;
      unreachableCompletePathReason = detected.reason;
    }
  }

  const resolutionTypes = ['done', 'failed', 'declined'].filter(k => counts[k] > 0);
  const history = resolutionTypes.length > 1
    ? STATUS.MIXED
    : resolutionTypes.length === 1
      ? ({ done: STATUS.DONE, failed: STATUS.FAILED, declined: STATUS.DECLINED }[resolutionTypes[0]])
      : (counts.offered > 0 ? STATUS.OFFERED_ONLY : STATUS.NOT_ENCOUNTERED);

  let status;
  if (isHeld)           status = STATUS.IN_PROGRESS;
  else if (isAvailable) status = STATUS.AVAILABLE;
  else                  status = history;

  return {
    status,
    label:  _label(status, counts, isHeld !== true && isAvailable !== true ? null : history),
    counts,
    isHeld,
    isAvailable,
    unreachableCompletePath,
    unreachableCompletePathReason,
  };
}

function _label(status, counts, overriddenHistory) {
  const base = {
    [STATUS.IN_PROGRESS]:     'Currently active',
    [STATUS.AVAILABLE]:       'Available, not yet accepted',
    [STATUS.DONE]:            counts.done > 1 ? `Completed (×${counts.done})` : 'Completed',
    [STATUS.FAILED]:          counts.failed > 1 ? `Failed (×${counts.failed})` : 'Failed',
    [STATUS.DECLINED]:        'Declined',
    [STATUS.MIXED]:           `Mixed history — done ×${counts.done}, failed ×${counts.failed}${counts.declined ? `, declined ×${counts.declined}` : ''}`,
    [STATUS.OFFERED_ONLY]:    'Offered — outcome unclear',
    [STATUS.NOT_ENCOUNTERED]: 'Not encountered',
  }[status] || status;

  // If currently held/available but there's also resolved history from
  // earlier cycles (a repeatable mission), say so rather than hiding it.
  if (overriddenHistory && overriddenHistory !== STATUS.NOT_ENCOUNTERED && overriddenHistory !== STATUS.OFFERED_ONLY) {
    const historyBits = [];
    if (counts.done)     historyBits.push(`done ×${counts.done}`);
    if (counts.failed)   historyBits.push(`failed ×${counts.failed}`);
    if (counts.declined) historyBits.push(`declined ×${counts.declined}`);
    if (historyBits.length) return `${base} (previously: ${historyBits.join(', ')})`;
  }
  return base;
}

// ── Bulk lookup ───────────────────────────────────────────────
function getAllStatuses(save) {
  save = save === undefined ? getCurrentSave() : save;
  const names = new Set();

  if (save) {
    (save.missions      || []).forEach(m => names.add(m.name));
    (save.availableJobs || []).forEach(m => names.add(m.name));
    if (save.pilot && save.pilot.conditions) {
      for (const key of Object.keys(save.pilot.conditions)) {
        const m = key.match(/^(.*): (?:offered|active|done|failed|declined)$/);
        if (m) names.add(m[1]);
      }
    }
  }

  const out = new Map();
  for (const name of names) out.set(name, getMissionStatus(name, save));
  return out;
}

// ── Decorate a mission list from MissionLoader ──────────────────
// Takes whatever MissionLoader.getAllMissions() (or getMissionsByPlugin)
// returned and attaches `.status` to each entry by matching `.name`.
// Missions the save has no record of at all still get a NOT_ENCOUNTERED
// status object, not `undefined` — a consumer can always read
// `.status.status` without a null check.
function decorateMissions(missions, save) {
  save = save === undefined ? getCurrentSave() : save;
  const statuses = getAllStatuses(save);
  return missions.map(m => {
    let status = statuses.get(m.name) || getMissionStatus(m.name, save);
    // Already-resolved missions (not currently held) have no live save
    // data to check for these patterns — fall back to the plugin
    // catalog's static definition, which is what `m.raw` is here
    // (missionLoader.js's own raw tree for this catalog entry). This is
    // also the ONLY place pattern B (reward-then-fail/decline) can
    // realistically fire, since a held save copy no longer carries the
    // on-accept/on-offer blocks it needs once they've already run once.
    if (!status.unreachableCompletePath && !status.isHeld && m.raw) {
      const detected = detectQuestionableResolution(m.raw);
      if (detected.flagged) {
        status = { ...status, unreachableCompletePath: true, unreachableCompletePathReason: detected.reason, backgroundHelper: !!detected.helper };
      }
    }
    // Resolved as failed/declined/mixed, but the mission's own "to complete"
    // condition is met in this save → it was completed in practice (some
    // missions end through `fail` once their goal is reached).
    const resolvedOtherwise = [STATUS.FAILED, STATUS.DECLINED, STATUS.MIXED, STATUS.OFFERED_ONLY].includes(status.status);
    if (resolvedOtherwise && !status.isHeld && m.raw && save && save.pilot &&
        completeConditionMet(m.raw, save.pilot.conditions)) {
      status = { ...status, completedByCondition: true,
        completedByConditionReason: 'Its "to complete" condition is met in this save, so it counts as completed.' };
    }
    return { ...m, status };
  });
}

window.MissionStatusHelper = {
  STATUS,
  getCurrentSave,
  listSaves,
  getSaveById,
  getMissionStatus,
  getAllStatuses,
  decorateMissions,
  hasUnreachableCompletePath,
  detectQuestionableResolution,
  evaluateConditionSet,
  completeConditionMet,
  conditionGetter,
  offerability: offerabilityFor,
  /** Shown status after both overrides above — use this for display. */
  effectiveStatus(status) {
    if (!status) return null;
    if (status.completedByCondition) return STATUS.DONE;
    if (status.unreachableCompletePath && (status.status === STATUS.FAILED || status.status === STATUS.DECLINED)) return STATUS.DONE;
    return status.status;
  },
};

})();
