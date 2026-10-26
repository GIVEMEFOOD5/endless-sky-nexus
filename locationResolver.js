'use strict';

// Works out where every ship and outfit can be found (shipyards, outfitters, fleets, missions, events) per plugin. Used by parser.js.

class LocationResolver {
  constructor() { this.reset(); }

  reset() {
    // ── what the parser collects ──

    // Named fleets: { name, shipNames[], pluginId }
    this.fleets = [];

    // { fleetName, systemName, pluginId }
    this.fleetSystems = [];

    // { planetName, systemName, pluginId }
    this.planetSystems = [];

    // Shipyard listings: { yardName, shipNames[], pluginId }
    this.shipyardEntries = [];

    // Planet → shipyard(s): { planetName, yardNames[], pluginId }
    this.planetShipyards = [];

    // Planet → outfitter(s): { planetName, outfitterNames[], pluginId }
    this.planetOutfitters = [];

    // Outfitter listings: { outfitterName, outfitNames[], pluginId }
    this.outfitterEntries = [];

    // Mission NPC ship refs: { missionName, shipName, pluginId }
    this.missionNpcShips = [];

    // Mission "give outfit" refs: { missionName, outfitName, count, pluginId }
    this.missionGiveOutfits = [];

    // Mission "give ship" refs: { missionName, shipName, pluginId }
    this.missionGiveShips = [];

    // planets given shipyards by missions
    this.eventPlanetShipyardAdds = [];

    // shipyards added/removed on planets by events
    this.eventPlanetShipyardChanges = [];

    // outfitters added/removed on planets by events
    this.eventPlanetOutfitterChanges = [];

    // fleets added/removed in systems by events
    this.eventSystemFleetChanges = [];

    // mission X can trigger event Y
    this.missionEventTriggers = [];

    // person X flies ship Y
    this.personShips = [];

    // person X only appears in system Z
    this.personSystems = [];

    // ships and the outfits they carry
    this.shipOutfitRefs = [];
  }

  // ── collectors (called by parser.js) ──

  collectFleet(fleetName, shipNames, pluginId) {
    if (!fleetName) return;
    this.fleets.push({ name: fleetName, shipNames: [...shipNames], pluginId: pluginId ?? null });
  }

  collectFleetInSystem(fleetName, systemName, pluginId) {
    if (!fleetName || !systemName) return;
    this.fleetSystems.push({ fleetName, systemName, pluginId: pluginId ?? null });
  }

  collectPlanetInSystem(planetName, systemName, pluginId) {
    if (!planetName || !systemName) return;
    this.planetSystems.push({ planetName, systemName, pluginId: pluginId ?? null });
  }

  collectShipyard(yardName, shipNames, pluginId) {
    if (!yardName) return;
    this.shipyardEntries.push({ yardName, shipNames: [...shipNames], pluginId: pluginId ?? null });
  }

  collectPlanet(planetName, yardNames, outfitterNames, pluginId) {
    if (!planetName) return;
    this.planetShipyards.push({ planetName, yardNames: [...yardNames], pluginId: pluginId ?? null });
    this.planetOutfitters.push({ planetName, outfitterNames: [...outfitterNames], pluginId: pluginId ?? null });
  }

  collectOutfitter(outfitterName, outfitNames, pluginId) {
    if (!outfitterName) return;
    this.outfitterEntries.push({ outfitterName, outfitNames: [...outfitNames], pluginId: pluginId ?? null });
  }

  collectMissionNpcShip(missionName, shipName, pluginId) {
    if (!missionName || !shipName) return;
    this.missionNpcShips.push({ missionName, shipName, pluginId: pluginId ?? null });
  }

  collectMissionGiveOutfit(missionName, outfitName, count, pluginId) {
    if (!missionName || !outfitName) return;
    this.missionGiveOutfits.push({ missionName, outfitName, count: count ?? 1, pluginId: pluginId ?? null });
  }

  collectMissionGiveShip(missionName, shipName, pluginId) {
    if (!missionName || !shipName) return;
    this.missionGiveShips.push({ missionName, shipName, pluginId: pluginId ?? null });
  }

  collectEventPlanetShipyardAdd(planetName, yardName, pluginId) {
    if (!planetName || !yardName) return;
    this.eventPlanetShipyardAdds.push({ planetName, yardName, pluginId: pluginId ?? null });
  }

  // event changes a planet's shipyard
  collectEventPlanetShipyardChange(planetName, yardName, action, eventName, pluginId) {
    if (!planetName || !yardName || !action) return;
    this.eventPlanetShipyardChanges.push({
      planetName, yardName, action, eventName: eventName ?? null, pluginId: pluginId ?? null,
    });
  }

  // event changes a planet's outfitter
  collectEventPlanetOutfitterChange(planetName, outfitterName, action, eventName, pluginId) {
    if (!planetName || !outfitterName || !action) return;
    this.eventPlanetOutfitterChanges.push({
      planetName, outfitterName, action, eventName: eventName ?? null, pluginId: pluginId ?? null,
    });
  }

  // event changes a system's fleets
  collectEventSystemFleetChange(eventName, systemName, fleetName, action, rate, pluginId) {
    if (!eventName || !systemName || !fleetName || !action) return;
    this.eventSystemFleetChanges.push({
      eventName, systemName, fleetName, action, rate: rate ?? null, pluginId: pluginId ?? null,
    });
  }

  // mission triggers event
  collectMissionEventTrigger(missionName, eventName, pluginId) {
    if (!missionName || !eventName) return;
    this.missionEventTriggers.push({ missionName, eventName, pluginId: pluginId ?? null });
  }

  // person flies a ship
  collectPerson(personName, shipName, pluginId) {
    if (!personName || !shipName) return;
    this.personShips.push({ personName, shipName, pluginId: pluginId ?? null });
  }

  // person tied to a system
  collectPersonSystem(personName, systemName, pluginId) {
    if (!personName || !systemName) return;
    this.personSystems.push({ personName, systemName, pluginId: pluginId ?? null });
  }

  // ship carries an outfit (plugin = the outfit's)
  collectShipOutfit(shipName, outfitName, pluginId, shipPluginId) {
    if (!shipName || !outfitName) return;
    this.shipOutfitRefs.push({
      shipName,
      outfitName,
      pluginId: pluginId ?? null,
      shipPluginId: shipPluginId ?? null,
    });
  }

  // ── helpers ──

  _buildPlanetToSystems() {
    const map = new Map();
    for (const { planetName, systemName, pluginId } of this.planetSystems) {
      if (!map.has(planetName)) map.set(planetName, new Map());
      const byPlugin = map.get(planetName);
      const key = pluginId ?? '__unknown__';
      if (!byPlugin.has(key)) byPlugin.set(key, new Set());
      byPlugin.get(key).add(systemName);
    }
    return map;
  }

  _buildFleetToSystems() {
    const map = new Map();
    for (const { fleetName, systemName, pluginId } of this.fleetSystems) {
      if (!map.has(fleetName)) map.set(fleetName, new Map());
      const byPlugin = map.get(fleetName);
      const key = pluginId ?? '__unknown__';
      if (!byPlugin.has(key)) byPlugin.set(key, new Set());
      byPlugin.get(key).add(systemName);
    }
    return map;
  }

  _buildYardToPlanets() {
    const map = new Map();

    const add = (yardName, planetName, pluginId) => {
      if (!map.has(yardName)) map.set(yardName, new Map());
      const byPlugin = map.get(yardName);
      const key = pluginId ?? '__unknown__';
      if (!byPlugin.has(key)) byPlugin.set(key, new Set());
      byPlugin.get(key).add(planetName);
    };

    for (const { planetName, yardNames, pluginId } of this.planetShipyards)
      for (const y of yardNames) add(y, planetName, pluginId);

    // Unconditional base behavior — unchanged from before this pass.
    for (const { planetName, yardName, pluginId } of this.eventPlanetShipyardAdds)
      add(yardName, planetName, pluginId);

    return map;
  }

  _buildOutfitterToPlanets() {
    const map = new Map();

    const add = (outfitterName, planetName, pluginId) => {
      if (!map.has(outfitterName)) map.set(outfitterName, new Map());
      const byPlugin = map.get(outfitterName);
      const key = pluginId ?? '__unknown__';
      if (!byPlugin.has(key)) byPlugin.set(key, new Set());
      byPlugin.get(key).add(planetName);
    };

    for (const { planetName, outfitterNames, pluginId } of this.planetOutfitters)
      for (const o of outfitterNames) add(o, planetName, pluginId);

    // event 'add' actions count like other shipyards
    for (const { planetName, outfitterName, action, pluginId } of this.eventPlanetOutfitterChanges)
      if (action === 'add') add(outfitterName, planetName, pluginId);

    return map;
  }

  _mergeInto(result, byPlugin, category, fallbackPlugin) {
    for (const [rawKey, values] of byPlugin) {
      const key = rawKey === '__unknown__' ? (fallbackPlugin ?? '__unknown__') : rawKey;
      if (!result[key]) result[key] = {};
      if (!result[key][category]) result[key][category] = new Set();
      for (const v of values) result[key][category].add(v);
    }
  }

  // merge only this plugin's slice
  _mergeOwnPluginOnly(result, byPluginMap, category, pluginId) {
    if (!byPluginMap) return;
    const key = pluginId ?? '__unknown__';
    const values = byPluginMap.get(key);
    if (!values || !values.size) return;
    if (!result[key]) result[key] = {};
    if (!result[key][category]) result[key][category] = new Set();
    for (const v of values) result[key][category].add(v);
  }

  // event fleet changes, formatted
  _mergeEventFleetChanges(result, fleetName, fleetPluginId, category) {
    const matches = this.eventSystemFleetChanges.filter(c => c.fleetName === fleetName);
    if (!matches.length) return;
    const key = fleetPluginId ?? '__unknown__';
    for (const c of matches) {
      if (!result[key]) result[key] = {};
      if (!result[key][category]) result[key][category] = new Set();
      const rateStr = c.action === 'add' && c.rate != null ? ` (rate ${c.rate})` : '';
      result[key][category].add(
        `${c.action === 'add' ? 'Adds' : 'Removes'} fleet in "${c.systemName}" via event "${c.eventName}"${rateStr}`
      );
    }
  }

  // events a mission can trigger
  _mergeMissionEventTriggers(result, missionNamesByPlugin, category) {
    for (const [pluginId, missionNames] of missionNamesByPlugin) {
      for (const missionName of missionNames) {
        const triggers = this.missionEventTriggers.filter(
          t => t.missionName === missionName && t.pluginId === pluginId
        );
        if (!triggers.length) continue;
        const key = pluginId ?? '__unknown__';
        if (!result[key]) result[key] = {};
        if (!result[key][category]) result[key][category] = new Set();
        for (const t of triggers) {
          result[key][category].add(`"${missionName}" → event "${t.eventName}"`);
        }
      }
    }
  }

  // persons flying this ship
  _mergePersons(result, shipName, ownerPluginId) {
    for (const ref of this.personShips) {
      if (ref.shipName !== shipName) continue;
      if (!this._refersTo('ship', shipName, ref.pluginId, ownerPluginId)) continue;
      const key = ref.pluginId ?? '__unknown__';
      if (!result[key]) result[key] = {};
      if (!result[key]['Persons']) result[key]['Persons'] = new Set();
      result[key]['Persons'].add(ref.personName);

      const systems = this.personSystems.filter(
        s => s.personName === ref.personName && s.pluginId === ref.pluginId
      );
      if (systems.length) {
        if (!result[key]['Systems']) result[key]['Systems'] = new Set();
        for (const s of systems) result[key]['Systems'].add(s.systemName);
      }
    }
  }

  // ── references between plugins ──
  setOwnerResolver(fn) { this._ownerOf = typeof fn === 'function' ? fn : null; }

  _refersTo(kind, name, refPluginId, ownerPluginId) {
    if (refPluginId === ownerPluginId) return true;
    if (!this._ownerOf) return false;
    return this._ownerOf(kind, name, refPluginId) === ownerPluginId;
  }

  // ── ships ──

  // everything about where a ship can be found
_resolveShipLocations(shipName, ownerPluginId) {
    const result = {};
    const fleetToSystems  = this._buildFleetToSystems();
    const yardToPlanets   = this._buildYardToPlanets();
    const planetToSystems = this._buildPlanetToSystems();

    // Track mission names found for this ship, per plugin, so
    // _mergeMissionEventTriggers can cross-reference them afterwards.
    const missionNamesByPlugin = new Map();
    // note a mission
    const trackMission = (pluginId, missionName) => {
      const key = pluginId ?? '__unknown__';
      if (!missionNamesByPlugin.has(key)) missionNamesByPlugin.set(key, new Set());
      missionNamesByPlugin.get(key).add(missionName);
    };

    for (const fleet of this.fleets) {
      if (!fleet.shipNames.includes(shipName)) continue;
      if (!this._refersTo('ship', shipName, fleet.pluginId, ownerPluginId)) continue;
      // Only take the Systems this SAME fleet (fleet.pluginId) spawns in —
      // not every plugin's same-named fleet. See _mergeOwnPluginOnly.
      this._mergeOwnPluginOnly(result, fleetToSystems.get(fleet.name), 'Systems', fleet.pluginId);
      // NEW: event-driven add/remove of this same fleet, anywhere.
      this._mergeEventFleetChanges(result, fleet.name, fleet.pluginId, 'EventFleetChanges');
    }

    for (const yard of this.shipyardEntries) {
      if (!yard.shipNames.includes(shipName)) continue;
      if (!this._refersTo('ship', shipName, yard.pluginId, ownerPluginId)) continue;
      const planetsByPlugin = yardToPlanets.get(yard.yardName);
      if (!planetsByPlugin) continue;
      // Only take planets that reference THIS shipyard entry's own plugin —
      // not every plugin's same-named shipyard. See _mergeOwnPluginOnly.
      const key = yard.pluginId ?? '__unknown__';
      const planets = planetsByPlugin.get(key);
      if (!planets || !planets.size) continue;
      if (!result[key]) result[key] = {};
      if (!result[key]['Planets']) result[key]['Planets'] = new Set();
      for (const planet of planets) {
        result[key]['Planets'].add(planet);
        // which system a planet is in can come from another plugin
        const sysMap = planetToSystems.get(planet);
        if (sysMap) this._mergeInto(result, sysMap, 'Systems', key);
      }
    }

    for (const ref of this.missionNpcShips) {
      if (ref.shipName !== shipName) continue;
      if (!this._refersTo('ship', shipName, ref.pluginId, ownerPluginId)) continue;
      const key = ref.pluginId ?? '__unknown__';
      if (!result[key]) result[key] = {};
      if (!result[key]['Missions']) result[key]['Missions'] = new Set();
      result[key]['Missions'].add(ref.missionName);
      trackMission(ref.pluginId, ref.missionName);
    }

    for (const ref of this.missionGiveShips) {
      if (ref.shipName !== shipName) continue;
      if (!this._refersTo('ship', shipName, ref.pluginId, ownerPluginId)) continue;
      const key = ref.pluginId ?? '__unknown__';
      if (!result[key]) result[key] = {};
      if (!result[key]['Missions']) result[key]['Missions'] = new Set();
      result[key]['Missions'].add(ref.missionName);
      trackMission(ref.pluginId, ref.missionName);
    }

    // NEW: for every mission already found above, note if it's known to
    // trigger an event.
    this._mergeMissionEventTriggers(result, missionNamesByPlugin, 'TriggeredByMissionEvents');

    // NEW: person "X" blocks that include this ship, plus any system(s)
    // that person is restricted to.
    this._mergePersons(result, shipName, ownerPluginId);

    return result;
}

  // ── outfits ──

  // everything about where an outfit can be found
  _resolveOutfitLocations(outfitName, ownerPluginId) {
    const result = {};
    const outfitterToPlanets = this._buildOutfitterToPlanets();
    const yardToPlanets      = this._buildYardToPlanets();
    const planetToSystems    = this._buildPlanetToSystems();
    const fleetToSystems     = this._buildFleetToSystems();

    const missionNamesByPlugin = new Map();
    // note a mission
    const trackMission = (pluginId, missionName) => {
      const key = pluginId ?? '__unknown__';
      if (!missionNamesByPlugin.has(key)) missionNamesByPlugin.set(key, new Set());
      missionNamesByPlugin.get(key).add(missionName);
    };

    // 1. outfitters → planets
    for (const entry of this.outfitterEntries) {
      if (!entry.outfitNames.includes(outfitName)) continue;

      const planetsByPlugin = outfitterToPlanets.get(entry.outfitterName);
      if (!planetsByPlugin) continue;

      const key = entry.pluginId ?? '__unknown__';
      const planets = planetsByPlugin.get(key);
      if (!planets || !planets.size) continue;

      if (!result[key]) result[key] = {};
      if (!result[key]['Planets']) result[key]['Planets'] = new Set();
      if (!result[key]['Outfitters']) result[key]['Outfitters'] = new Set();
      result[key]['Outfitters'].add(entry.outfitterName);
      for (const planet of planets) result[key]['Planets'].add(planet);
    }

    // ── 1b. NEW — event-driven outfitter add/remove for outfitters that
    //       list this outfit, tagged with the causing event.
    for (const entry of this.outfitterEntries) {
      if (!entry.outfitNames.includes(outfitName)) continue;
      const changes = this.eventPlanetOutfitterChanges.filter(
        c => c.outfitterName === entry.outfitterName && c.pluginId === entry.pluginId
      );
      if (!changes.length) continue;
      const key = entry.pluginId ?? '__unknown__';
      if (!result[key]) result[key] = {};
      if (!result[key]['EventOutfitterChanges']) result[key]['EventOutfitterChanges'] = new Set();
      for (const c of changes) {
        result[key]['EventOutfitterChanges'].add(
          `${c.action === 'add' ? 'Adds to' : 'Removes from'} "${c.planetName}" via event "${c.eventName}"`
        );
      }
    }

    // 2. ships carrying it → shipyards → planets → systems
    const shipsWithOutfit = new Set(
      this.shipOutfitRefs
        .filter(r => r.outfitName === outfitName && this._refersTo('outfit', outfitName, r.pluginId, ownerPluginId))
        .map(r => r.shipName)
    );

    for (const shipName of shipsWithOutfit) {
      // the ships themselves (same plugin)
      for (const ref of this.shipOutfitRefs) {
        if (ref.outfitName !== outfitName) continue;
        if (ref.shipName !== shipName) continue;
        if (!this._refersTo('outfit', outfitName, ref.pluginId, ownerPluginId)) continue;
        const key = ref.shipPluginId ?? '__unknown__';
        if (!result[key]) result[key] = {};
        if (!result[key]['Ships']) result[key]['Ships'] = new Set();
        result[key]['Ships'].add(shipName);
      }

      // their shipyards → planets
      for (const yard of this.shipyardEntries) {
        if (!yard.shipNames.includes(shipName)) continue;
        const planetsByPlugin = yardToPlanets.get(yard.yardName);
        if (!planetsByPlugin) continue;
        const key = yard.pluginId ?? '__unknown__';
        const planets = planetsByPlugin.get(key);
        if (!planets || !planets.size) continue;
        if (!result[key]) result[key] = {};
        if (!result[key]['ShipyardPlanets']) result[key]['ShipyardPlanets'] = new Set();
        for (const planet of planets) result[key]['ShipyardPlanets'].add(planet);
      }

      // Fleet path for that ship → systems. Scoped to each fleet entry's
      // own plugin, for the same reason (fleet names collide too).
      for (const fleet of this.fleets) {
        if (!fleet.shipNames.includes(shipName)) continue;
        this._mergeOwnPluginOnly(result, fleetToSystems.get(fleet.name), 'Systems', fleet.pluginId);
        // NEW: event-driven add/remove of that fleet.
        this._mergeEventFleetChanges(result, fleet.name, fleet.pluginId, 'EventFleetChanges');
      }
    }

    // 3. missions that give it
    for (const ref of this.missionGiveOutfits) {
      if (ref.outfitName !== outfitName) continue;
      if (!this._refersTo('outfit', outfitName, ref.pluginId, ownerPluginId)) continue;
      const key = ref.pluginId ?? '__unknown__';
      if (!result[key]) result[key] = {};
      if (!result[key]['Missions']) result[key]['Missions'] = new Set();
      result[key]['Missions'].add(ref.missionName);
      trackMission(ref.pluginId, ref.missionName);
    }

    // NEW: for every mission already found above, note if it's known to
    // trigger an event.
    this._mergeMissionEventTriggers(result, missionNamesByPlugin, 'TriggeredByMissionEvents');

    return result;
  }

  // ── output ──

  _finalise(result, pluginName) {
    if (Object.keys(result).length === 0) {
      const key = pluginName ?? '__unknown__';
      return { [key]: { '_deprecated/unused': true } };
    }

    const out = {};
    for (const [pluginId, categories] of Object.entries(result)) {
      // Keep the full pluginId (sourceName/folderName) exactly as stored.
      // Only substitute __unknown__ entries with the pluginName fallback.
      const key = pluginId === '__unknown__' ? (pluginName ?? '__unknown__') : pluginId;
      if (!out[key]) out[key] = {};
      for (const [cat, values] of Object.entries(categories)) {
        if (values instanceof Set) {
          out[key][cat] = [...values].sort();
        } else {
          out[key][cat] = values;
        }
      }
    }
    return out;
  }

  // add locations to every ship and outfit. Called by: parser.js

attachLocations(ships, variants, outfits, pluginName) {
    for (const ship of ships) {
      const raw = this._resolveShipLocations(ship.name, ship._pluginId);
      ship.locations = this._finalise(raw, pluginName);
    }
    for (const variant of variants) {
      const raw = this._resolveShipLocations(variant.name, variant._variantPluginId);
      variant.locations = this._finalise(raw, pluginName);
    }
    for (const outfit of outfits) {
      const raw = this._resolveOutfitLocations(outfit.name, outfit._pluginId);
      outfit.locations = this._finalise(raw, pluginName);
    }
}
}

module.exports = LocationResolver;