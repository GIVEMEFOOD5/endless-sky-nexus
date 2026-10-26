'use strict';

// Your named fleets (kept in this browser, synced to your account when logged in). Used by the builder and other pages.

(function () {
  const KEY        = 'es_ship_builder_fleets_v1';
  const LEGACY_KEY = 'es_ship_builder_v4';
  const TABLE      = 'fleets';
  const SYNC_DELAY = 1500;

  const listeners = [];
  let state = null;
  let status = 'local';
  let statusDetail = '';
  let syncTimer = null;
  let syncing = false;
  let cloudUnavailable = false;

  // ── helpers ──
  const now = () => Date.now();
  const clone = v => JSON.parse(JSON.stringify(v));
  // random id
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  // id for a ship
  const newShipId = () => Date.now() + Math.random();
  // read JSON from this browser (null if missing)
  function readJSON(k) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (_) { return null; } }
  // logged-in user (or null)
  function currentUser() { return (window.EsAuth && window.EsAuth.getCurrentUser && window.EsAuth.getCurrentUser()) || null; }
  // Supabase client (or null)
  const cloud = () => window.supabaseClient || null;

  // tell listeners something changed
  function emit(reason, fleetId) {
    for (const fn of listeners) { try { fn({ reason, fleetId, status }); } catch (e) { console.warn('[FleetStore] listener failed', e); } }
  }
  // sync status message
  function setStatus(s, detail = '') { status = s; statusDetail = detail; emit('status'); }

  // a new fleet object
  function makeFleet(name, ships) {
    const t = now();
    return { id: uuid(), name: name || 'New fleet', ships: ships || [], createdAt: t, updatedAt: t, syncedAt: null, ownerId: null, dirty: true };
  }

  // ── load / save ──
  function load() {
    state = readJSON(KEY);
    const legacy = readJSON(LEGACY_KEY);
    const legacyShips = Array.isArray(legacy) ? legacy : [];

    if (!state || !Array.isArray(state.fleets)) {
      // First run: the existing single fleet becomes "My Fleet".
      const first = makeFleet('My Fleet', legacyShips);
      // An empty starter fleet on a fresh browser shouldn't be pushed into an
      // account that already has fleets — see the placeholder check in sync.
      if (!legacyShips.length) first.placeholder = true;
      state = { version: 1, activeId: first.id, fleets: [first], pendingDeletes: [] };
      persist('migrated', { skipSync: true });
      return;
    }
    state.pendingDeletes = state.pendingDeletes || [];

    // Adopt ships another page wrote straight into the legacy key (older
    // code paths) so nothing written there is ever silently lost.
    const known = new Set(state.fleets.flatMap(f => f.ships.map(s => String(s.id))));
    const stray = legacyShips.filter(s => !known.has(String(s.id)));
    if (stray.length) {
      let inbox = state.fleets.find(f => f.name === 'Imported ships');
      if (!inbox) { inbox = makeFleet('Imported ships'); state.fleets.push(inbox); }
      inbox.ships.push(...stray);
      touch(inbox);
      persist('adopted', { skipSync: true });
    }
    if (!state.fleets.length) { const f = makeFleet('My Fleet'); state.fleets.push(f); state.activeId = f.id; }
    if (!state.fleets.some(f => f.id === state.activeId)) state.activeId = state.fleets[0].id;
  }

  // save to this browser and queue a sync. Called by: every change
  function persist(reason, { fleetId, skipSync } = {}) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      localStorage.setItem(LEGACY_KEY, JSON.stringify(state.fleets.flatMap(f => f.ships)));
    } catch (e) {
      console.warn('[FleetStore] Could not write to localStorage (storage full?)', e);
      setStatus('error', 'Browser storage is full — changes may not be kept.');
    }
    emit(reason, fleetId);
    if (!skipSync) scheduleSync();
  }

  // mark a fleet as updated
  function touch(fleet) { delete fleet.placeholder; fleet.updatedAt = Math.max(now(), (fleet.updatedAt || 0) + 1); fleet.dirty = true; }
  // fleet by id (throws if missing)
  function need(id) { const f = state.fleets.find(x => x.id === id); if (!f) throw new Error(`Fleet not found: ${id}`); return f; }

  // ── reading ──
  const list   = () => state.fleets.map(f => ({ id: f.id, name: f.name, shipCount: f.ships.length, updatedAt: f.updatedAt, synced: !f.dirty && !!f.syncedAt }));
  const get    = id => state.fleets.find(f => f.id === id) || null;
  // the fleet in use. Called by: the builder, accountCenter, nameSearch
  const active = () => get(state.activeId);

  // ── changing ──
  function setActive(id) { need(id); state.activeId = id; persist('active', { fleetId: id, skipSync: true }); }

  // new fleet. Called by: shipBuilderFleets, saveManager
  function create(name, ships) {
    const f = makeFleet(uniqueName(name || 'New fleet'), (ships || []).map(s => ({ ...clone(s), id: newShipId() })));
    state.fleets.push(f);
    persist('created', { fleetId: f.id });
    return f;
  }
  // rename a fleet
  function rename(id, name) {
    const f = need(id);
    const clean = String(name || '').trim();
    if (!clean) throw new Error('A fleet needs a name.');
    f.name = clean; touch(f);
    persist('renamed', { fleetId: id });
  }
  // copy a fleet
  function duplicate(id) {
    const src = need(id);
    return create(`${src.name} (copy)`, src.ships);
  }
  // delete a fleet
  function remove(id) {
    const f = need(id);
    state.fleets = state.fleets.filter(x => x !== f);
    if (f.syncedAt) state.pendingDeletes.push(f.id);
    if (!state.fleets.length) { const p = makeFleet('My Fleet'); p.placeholder = true; state.fleets.push(p); }
    if (state.activeId === id) state.activeId = state.fleets[0].id;
    persist('removed', { fleetId: id });
  }
  // replace a fleet's ships. Called by: shipBuilderFleets.sbSave, saveManager
  function setShips(id, ships) {
    const f = need(id);
    f.ships = clone(ships || []);
    touch(f);
    persist('ships', { fleetId: id });
  }
  // add ships to a fleet. Called by: saveManager, accountCenter, shipBuilderShared
  function addShips(id, ships) {
    const f = need(id);
    f.ships.push(...(ships || []).map(s => ({ ...clone(s), id: newShipId() })));
    touch(f);
    persist('ships', { fleetId: id });
  }
  // move or copy a ship to another fleet
  function moveShip(fromId, index, toId, { copy = false } = {}) {
    const from = need(fromId), to = need(toId);
    const ship = from.ships[index];
    if (!ship) throw new Error('Ship not found');
    to.ships.push({ ...clone(ship), id: copy ? newShipId() : ship.id });
    touch(to);
    if (!copy) { from.ships.splice(index, 1); touch(from); }
    persist(copy ? 'copied' : 'moved', { fleetId: toId });
  }
  // "Fleet 2", "Fleet 3" …
  function uniqueName(base) {
    const names = new Set(state.fleets.map(f => f.name));
    if (!names.has(base)) return base;
    let n = 2;
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }
  // listen for changes. Called by: shipBuilderFleets
  function onChange(fn) { listeners.push(fn); }

  // ── account sync ──
  function scheduleSync() {
    if (!currentUser() || cloudUnavailable) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, SYNC_DELAY);
  }

  // is the cloud table missing?
  function isMissingTable(err) {
    return err && (err.code === '42P01' || err.code === 'PGRST205' || /relation .* does not exist|could not find the table/i.test(err.message || ''));
  }

  // sync with your account now
  async function syncNow() {
    const user = currentUser();
    const sb = cloud();
    if (!user || !sb) { setStatus('local'); return; }
    if (cloudUnavailable) return;
    if (syncing) { scheduleSync(); return; }
    syncing = true;
    setStatus('syncing');
    try {
      // 1. deletions made while offline / since last sync
      if (state.pendingDeletes.length) {
        const ids = [...state.pendingDeletes];
        const { error } = await sb.from(TABLE).delete().in('id', ids).eq('user_id', user.id);
        if (error) throw error;
        state.pendingDeletes = state.pendingDeletes.filter(id => !ids.includes(id));
      }

      // 2. pull
      const { data: rows, error: selErr } = await sb.from(TABLE)
        .select('id, name, ships, position, created_at, updated_at').eq('user_id', user.id);
      if (selErr) throw selErr;
      const remote = new Map((rows || []).map(r => [r.id, r]));
      let pulledActive = false;

      for (const r of rows || []) {
        const remoteTime = Date.parse(r.updated_at) || 0;
        const local = get(r.id);
        if (!local) {
          state.fleets.push({ id: r.id, name: r.name, ships: r.ships || [], createdAt: Date.parse(r.created_at) || remoteTime,
            updatedAt: remoteTime, syncedAt: remoteTime, ownerId: user.id, dirty: false });
          continue;
        }
        if (local.ownerId && local.ownerId !== user.id) continue;   // another account's fleet on this browser
        if (local.dirty && local.updatedAt > remoteTime) continue;  // local edit is newer → pushed below
        if (!local.dirty && local.syncedAt === remoteTime) continue; // unchanged
        Object.assign(local, { name: r.name, ships: r.ships || [], updatedAt: remoteTime, syncedAt: remoteTime, ownerId: user.id, dirty: false });
        if (local.id === state.activeId) pulledActive = true;
      }

      // 3. fleets that vanished from the cloud were deleted on another device
      state.fleets = state.fleets.filter(f => {
        if (remote.has(f.id) || !f.syncedAt || f.ownerId !== user.id) return true;
        return f.dirty && f.updatedAt > f.syncedAt;                  // edited here since → keep and re-push
      });
      // drop an untouched empty starter fleet once the account's own fleets arrive
      if ((rows || []).length) {
        const before = state.fleets.length;
        state.fleets = state.fleets.filter(f => !(f.placeholder && !f.ships.length));
        if (state.fleets.length !== before) pulledActive = true;
      }
      if (!state.fleets.length) state.fleets.push(makeFleet('My Fleet'));
      if (!get(state.activeId)) { state.activeId = state.fleets[0].id; pulledActive = true; }

      // 4. push this account's dirty fleets (and adopt unowned local ones)
      const toPush = state.fleets.filter(f => f.dirty && (!f.ownerId || f.ownerId === user.id));
      if (toPush.length) {
        const payload = toPush.map(f => ({
          id: f.id, user_id: user.id, name: f.name, ships: f.ships,
          position: state.fleets.indexOf(f),
          created_at: new Date(f.createdAt).toISOString(),
          updated_at: new Date(f.updatedAt).toISOString(),
        }));
        const { error: upErr } = await sb.from(TABLE).upsert(payload, { onConflict: 'id' });
        if (upErr) throw upErr;
        for (const f of toPush) { f.dirty = false; f.syncedAt = f.updatedAt; f.ownerId = user.id; }
      }

      persist(pulledActive ? 'pulled' : 'synced', { skipSync: true });
      setStatus('synced');
    } catch (err) {
      if (isMissingTable(err)) {
        cloudUnavailable = true;
        console.warn('[FleetStore] Supabase table "fleets" not found — run supabase/fleets.sql. Fleets stay local.');
        setStatus('unavailable', 'Cloud sync is not set up yet.');
      } else {
        console.warn('[FleetStore] Sync failed:', err);
        setStatus('error', err.message || 'Sync failed');
      }
    } finally {
      syncing = false;
    }
  }

  // ── start ──
  load();
  if (window.EsAuth && window.EsAuth.onAuthChange) {
    window.EsAuth.onAuthChange(user => { if (user) syncNow(); else setStatus('local'); });
  }
  window.addEventListener('storage', e => {             // another tab changed fleets
    if (e.key === KEY) { load(); emit('external'); }
  });

  window.FleetStore = {
    list, get, active, setActive,
    get activeId() { return state.activeId; },
    get status() { return status; },
    get statusDetail() { return statusDetail; },
    create, rename, duplicate, remove, setShips, addShips, moveShip,
    onChange, syncNow,
  };
})();
