'use strict';

// "Updated Save": a cleaned-up copy of your save (remove failed missions, triggered events …) for the Missions page.

(function () {

// Same keys saveManager.js writes to — see that file's own header comment.
const SM_CURRENT_KEY = 'ES_SM_CURRENT';
const SM_SAVE_PREFIX  = 'ES_SM_SAVE_';
// this file's own storage key (one at a time, like the active save ships)
const SM_UPDATED_SAVE_KEY = 'ES_SM_UPDATED_SAVE';

function _readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[saveCleanupHelper] Could not read', key, e);
    return null;
  }
}
function _writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('[saveCleanupHelper] Could not write', key, e);
    return false;
  }
}

// the original save
function _getOriginalSave() {
  const id = _readJSON(SM_CURRENT_KEY);
  return id ? _readJSON(SM_SAVE_PREFIX + id) : null;
}

// the Updated Save (made from the current save the first time). Called by: UserManagerMissionDisplay
function getUpdatedSave() {
  let updated = _readJSON(SM_UPDATED_SAVE_KEY);
  if (updated) return updated;

  const original = _getOriginalSave();
  if (!original) return null;

  updated = JSON.parse(JSON.stringify(original)); // deep copy — never share references with the original
  _writeJSON(SM_UPDATED_SAVE_KEY, updated);
  return updated;
}

// start again from the original
function resetUpdatedSave() {
  const original = _getOriginalSave();
  if (!original) return null;
  const fresh = JSON.parse(JSON.stringify(original));
  _writeJSON(SM_UPDATED_SAVE_KEY, fresh);
  return fresh;
}

// ── failed conditions ──
function listFailedConditions(save) {
  save = save || getUpdatedSave();
  if (!save || !save.pilot || !save.pilot.conditions) return [];
  const out = [];
  for (const [key, value] of Object.entries(save.pilot.conditions)) {
    const m = key.match(/^(.*): failed$/);
    if (!m) continue;
    out.push({ key, name: m[1], count: typeof value === 'number' ? value : 1 });
  }
  return out;
}

// remove one failed condition
function removeFailedCondition(name) {
  const save = getUpdatedSave();
  if (!save) return null;
  delete save.pilot.conditions[`${name}: failed`];
  _writeJSON(SM_UPDATED_SAVE_KEY, save);
  return save;
}

// remove them all
function removeAllFailedConditions() {
  const save = getUpdatedSave();
  if (!save) return null;
  for (const { key } of listFailedConditions(save)) delete save.pilot.conditions[key];
  _writeJSON(SM_UPDATED_SAVE_KEY, save);
  return save;
}

// "DD MM YYYY" → date
function _parseDate(str) {
  if (!str) return null;
  const parts = String(str).trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const [day, month, year] = parts;
  return [year, month, day];
}

// is date a on or before date b?
function _dateLTE(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return true; // exactly equal counts as "has arrived"
}

// an event's own date
function _eventDateTuple(eventEntry) {
  const dateNode = (eventEntry.raw || []).find(n => n.key === 'date');
  if (!dateNode || dateNode.values.length !== 3) return null;
  const [day, month, year] = dateNode.values;
  return [year, month, day];
}

// events that have already happened
function listTriggeredEvents(save) {
  save = save || getUpdatedSave();
  if (!save) return [];
  const pilotDate = _parseDate(save.pilot && save.pilot.date);
  const events = save.events || (save.blocks && save.blocks.event) || [];
  if (!pilotDate) return []; // can't compare against an unknown current date

  const out = [];
  events.forEach((ev, index) => {
    const eventDate = _eventDateTuple(ev);
    // No date at all → can't tell if it's triggered; leave it alone
    // rather than guessing.
    if (eventDate && _dateLTE(eventDate, pilotDate)) {
      out.push({
        index,
        dateText: `${eventDate[2]}/${eventDate[1]}/${eventDate[0]}`,
        raw: ev.raw,
      });
    }
  });
  return out;
}

// remove one
function removeTriggeredEvent(index) {
  const save = getUpdatedSave();
  if (!save || !Array.isArray(save.events)) return null;
  save.events.splice(index, 1);
  // Keep blocks.event (the source of truth `events` was aliased from) in
  // sync too, so nothing reading that field directly sees a stale entry.
  if (save.blocks && Array.isArray(save.blocks.event)) save.blocks.event = save.events;
  _writeJSON(SM_UPDATED_SAVE_KEY, save);
  return save;
}

// remove them all
function removeAllTriggeredEvents() {
  const save = getUpdatedSave();
  if (!save) return null;
  // Remove by index from the end so earlier indices in the list we're
  // iterating don't shift out from under us.
  const indices = listTriggeredEvents(save).map(e => e.index).sort((a, b) => b - a);
  for (const i of indices) save.events.splice(i, 1);
  if (save.blocks && Array.isArray(save.blocks.event)) save.blocks.event = save.events;
  _writeJSON(SM_UPDATED_SAVE_KEY, save);
  return save;
}

// remove a mission block from the save
function _pullMissionBlock(save, name) {
  const idx = (save.missions || []).findIndex(m => m.name === name);
  if (idx === -1) return null;
  const [removed] = save.missions.splice(idx, 1);
  if (save.blocks && Array.isArray(save.blocks.mission)) save.blocks.mission = save.missions;
  return removed;
}

// remove an available job
function _pullAvailableJob(save, name) {
  const idx = (save.availableJobs || []).findIndex(m => m.name === name);
  if (idx === -1) return null;
  const [removed] = save.availableJobs.splice(idx, 1);
  if (save.blocks && Array.isArray(save.blocks['available job'])) save.blocks['available job'] = save.availableJobs;
  return removed;
}

// remove a mission
function removeMission(name) {
  const save = getUpdatedSave();
  if (!save) return null;
  _pullMissionBlock(save, name);
  _pullAvailableJob(save, name);
  for (const suffix of ['offered', 'active', 'done', 'failed', 'declined']) {
    delete save.pilot.conditions[`${name}: ${suffix}`];
  }
  _writeJSON(SM_UPDATED_SAVE_KEY, save);
  return save;
}

// complete a mission the way the game would (rewards, conditions, events)
function completeMission(name, rewards, opts) {
  const save = getUpdatedSave();
  if (!save) return null;
  rewards = rewards || {};
  const repeatable = !!(opts && opts.repeatable);

  const wasHeld = !!_pullMissionBlock(save, name);
  _pullAvailableJob(save, name); // clear it either way — it's resolved now, not "still available"

  if (wasHeld) {
    const activeKey = `${name}: active`;
    const currentActive = save.pilot.conditions[activeKey];
    const nextActive = (typeof currentActive === 'number' ? currentActive : (currentActive ? 1 : 0)) - 1;
    if (nextActive > 0) save.pilot.conditions[activeKey] = nextActive;
    else delete save.pilot.conditions[activeKey];
  }

  const doneKey   = `${name}: done`;
  const failedKey = `${name}: failed`;
  const declinedKey = `${name}: declined`;
  let clearedFailed = false, clearedDeclined = false;

  if (repeatable) {
    const currentDone = save.pilot.conditions[doneKey];
    save.pilot.conditions[doneKey] = (typeof currentDone === 'number' ? currentDone : (currentDone ? 1 : 0)) + 1;
  } else {
    clearedFailed   = failedKey   in save.pilot.conditions;
    clearedDeclined = declinedKey in save.pilot.conditions;
    delete save.pilot.conditions[failedKey];
    delete save.pilot.conditions[declinedKey];
    save.pilot.conditions[doneKey] = 1;
  }

  if (rewards.credits) {
    save.account = save.account || { credits: 0, score: 0, salaries: {}, history: [] };
    save.account.credits = (save.account.credits || 0) + rewards.credits;
  }

  for (const o of (rewards.outfits || [])) {
    if (!o || !o.name) continue;
    save.cargo = save.cargo || { outfits: {}, commodities: {} };
    save.cargo.outfits = save.cargo.outfits || {};
    save.cargo.outfits[o.name] = (save.cargo.outfits[o.name] || 0) + (o.count || 1);
  }

  _writeJSON(SM_UPDATED_SAVE_KEY, save);
  return {
    save,
    unappliedShips: rewards.ships || [],
    appliedToHeldMission: wasHeld,
    clearedFailed,
    clearedDeclined,
  };
}

window.SaveCleanupHelper = {
  getUpdatedSave,
  resetUpdatedSave,
  listFailedConditions,
  listTriggeredEvents,
  removeFailedCondition,
  removeAllFailedConditions,
  removeTriggeredEvent,
  removeAllTriggeredEvents,
  removeMission,
  completeMission,
};

})();