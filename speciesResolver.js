'use strict';

// Works out which governments fly or sell each ship and outfit (fleets, persons, shipyards, outfitters). Used by parser.js.

class SpeciesResolver {
  constructor() { this.reset(); }
  reset() {
    // fleets: { government, shipNames, pluginId, name }
    this.fleets           = [];
    this.npcRefs          = [];   // { government, shipName,  pluginId }
    this.shipyards        = {};   // name → [{ shipName, pluginId }]
    this.outfitters       = {};   // name → [{ outfitName, pluginId }]
    this.planets           = [];   // { name, government, shipyards, outfitters, pluginId }
    this.shipOutfits      = {};   // shipName → [{ outfitName, pluginId }]  (pluginId = owner of the SHIP)
    this.knownGovernments = new Set();

    // NEW — { eventName, government, towardGovernment, value, pluginId }
    this.eventGovernmentAttitudeChanges = [];

    // persons: one entry per (person, ship)
    this.persons = [];
  }

  // ── collectors ──

  // a fleet (its name is optional)
  collectFleet(government, shipNames, pluginId, fleetName = null) {
    if (!shipNames.length) return;
    if (government) this.knownGovernments.add(government);
    this.fleets.push({
      government: government ?? null,
      shipNames: [...shipNames],
      pluginId: pluginId ?? null,
      name: fleetName ?? null,
    });
  }

  collectNpcRef(government, shipName, pluginId) {
    if (!shipName) return;
    if (government) this.knownGovernments.add(government);
    this.npcRefs.push({ government: government ?? null, shipName, pluginId: pluginId ?? null });
  }

  collectShipyard(name, shipNames, pluginId) {
    if (!this.shipyards[name]) this.shipyards[name] = [];
    for (const shipName of shipNames)
      this.shipyards[name].push({ shipName, pluginId: pluginId ?? null });
  }

  collectOutfitter(name, outfitNames, pluginId) {
    if (!this.outfitters[name]) this.outfitters[name] = [];
    for (const outfitName of outfitNames)
      this.outfitters[name].push({ outfitName, pluginId: pluginId ?? null });
  }

  collectPlanet(name, government, shipyards, outfitters, pluginId) {
    if (government) this.knownGovernments.add(government);
    this.planets.push({ name, government, shipyards, outfitters, pluginId: pluginId ?? null });
  }

  // an event changes one government's attitude to another
  collectEventGovernmentAttitudeChange(eventName, government, towardGovernment, value, pluginId) {
    if (!eventName || !government || !towardGovernment) return;
    this.eventGovernmentAttitudeChanges.push({
      eventName,
      government,
      towardGovernment,
      value: value ?? null,
      pluginId: pluginId ?? null,
    });
  }

  // a person sets its government directly
  collectPerson(personName, government, shipName, pluginId) {
    if (!personName || !shipName) return;
    if (government) this.knownGovernments.add(government);
    this.persons.push({
      personName,
      government: government ?? null,
      shipName,
      pluginId: pluginId ?? null,
    });
  }

  // outfits on a ship or variant
  collectShipOutfits(speciesShipName, outfitNames, pluginId, variantShipName = null) {
    if (!outfitNames.length) return;
    const storeName = variantShipName ?? speciesShipName;
    if (!this.shipOutfits[storeName]) this.shipOutfits[storeName] = [];
    for (const outfitName of outfitNames)
      this.shipOutfits[storeName].push({ outfitName, pluginId: pluginId ?? null });
  }

  // fill in fleets that had no government
  resolveFleetGovernmentGaps() {
    let resolved = 0, stillUnresolved = 0;
    let seenFleetWarn = null;   // each fleet name warned about once
    for (const entry of this.fleets) {
      if (entry.government) continue;
      if (!entry.name) { stillUnresolved++; continue; }
      let source = this.fleets.find(f => f.name === entry.name && f.pluginId === entry.pluginId && f.government);
      if (!source) source = this.fleets.find(f => f.name === entry.name && f.government);
      if (source) {
        entry.government = source.government;
        this.knownGovernments.add(source.government);
        resolved++;
      } else {
        stillUnresolved++;
        seenFleetWarn = seenFleetWarn || new Set();
        if (!seenFleetWarn.has(entry.name)) {
          seenFleetWarn.add(entry.name);
          console.warn(`    ⚠ Fleet "${entry.name}" (plugin ${entry.pluginId}) has ships but no government could be found in any of its definitions.`);
        }
      }
    }
    console.log(`  Fleet government-gap resolution: ${resolved} resolved, ${stillUnresolved} unresolved`);
  }

  // same for planets
  resolvePlanetGovernmentGaps() {
    let resolved = 0, stillUnresolved = 0;
    for (const entry of this.planets) {
      if (entry.government) continue;
      let source = this.planets.find(p => p.name === entry.name && p.pluginId === entry.pluginId && p.government);
      if (!source) source = this.planets.find(p => p.name === entry.name && p.government);
      if (source) {
        entry.government = source.government;
        this.knownGovernments.add(source.government);
        resolved++;
      } else {
        stillUnresolved++;
        // Most planets have no government line of their own — they use their
        // system's — so this is normal; only a few examples are printed.
        if (stillUnresolved <= 5) console.warn(`    ⚠ Planet "${entry.name}" (plugin ${entry.pluginId}) has shipyards/outfitters listed but no government of its own.`);
      }
    }
    console.log(`  Planet government-gap resolution: ${resolved} resolved, ${stillUnresolved} unresolved` +
      (stillUnresolved > 5 ? ` (first 5 shown; planets normally take their system's government)` : ''));
  }

  // ── lookups ──

  // governments for a ship or variant
  _governmentsForShip(shipName, ownerPluginId = null) {
    const result = new Map();

    const add = (pluginId, government) => {
      const key = pluginId ?? '__unknown__';
      if (!result.has(key)) result.set(key, new Set());
      result.get(key).add(government);
    };

    // Strip variant suffix: "Carrier (Alpha)" → "Carrier"
    const baseName = shipName.replace(/\s*\([^)]+\)\s*$/, '').trim();

    // Fleet listings: exact name only, scoped to ownerPluginId when known.
    for (const fleet of this.fleets) {
      if (!fleet.shipNames.includes(shipName)) continue;
      if (ownerPluginId != null && fleet.pluginId !== ownerPluginId) continue;
      add(fleet.pluginId, fleet.government);
    }

    // NPC refs: exact or base name
    for (const ref of this.npcRefs) {
      if (!ref.government) continue;
      if (ref.shipName !== shipName && ref.shipName !== baseName) continue;
      if (ownerPluginId != null && ref.pluginId !== ownerPluginId) continue;
      add(ref.pluginId, ref.government);
    }

    // shipyard → planet → government (exact name)
    for (const [yard, entries] of Object.entries(this.shipyards)) {
      const matchingEntries = entries.filter(e => e.shipName === shipName);
      if (!matchingEntries.length) continue;
      for (const planet of this.planets) {
        if (!planet.shipyards.includes(yard) || !planet.government) continue;
        for (const e of matchingEntries) {
          if ((e.pluginId ?? null) !== (planet.pluginId ?? null)) continue;
          if (ownerPluginId != null && e.pluginId !== ownerPluginId) continue;
          add(planet.pluginId, planet.government);
        }
      }
    }

    return result;
  }

  _governmentsForOutfit(outfitName) {
    const result = new Map();

    const add = (pluginId, government) => {
      const key = pluginId ?? '__unknown__';
      if (!result.has(key)) result.set(key, new Set());
      result.get(key).add(government);
    };

    // outfitter → planet → government
    for (const [outfitter, entries] of Object.entries(this.outfitters)) {
      const matchingEntries = entries.filter(e => e.outfitName === outfitName);
      if (!matchingEntries.length) continue;
      for (const planet of this.planets) {
        if (!planet.outfitters.includes(outfitter) || !planet.government) continue;
        for (const e of matchingEntries) {
          if ((e.pluginId ?? null) !== (planet.pluginId ?? null)) continue;
          add(planet.pluginId, planet.government);
        }
      }
    }

    // ship outfits → ship's government
    for (const [shipName, entries] of Object.entries(this.shipOutfits)) {
      const matchingEntries = entries.filter(e => e.outfitName === outfitName);
      if (!matchingEntries.length) continue;

      const shipOwnerPluginIds = new Set(matchingEntries.map(e => e.pluginId ?? null));
      for (const shipOwnerPluginId of shipOwnerPluginIds) {
        for (const [pluginId, govts] of this._governmentsForShip(shipName, shipOwnerPluginId)) {
          for (const g of govts) {
            const effectivePlugin = pluginId !== '__unknown__'
              ? pluginId
              : (shipOwnerPluginId ?? null);
            add(effectivePlugin, g);
          }
        }
      }
    }

    this._filterToKnownGovernments(result);
    return result;
  }

  // drop governments that were never defined
  _filterToKnownGovernments(byPlugin) {
    for (const [pluginId, govts] of byPlugin) {
      for (const g of govts)
        if (!this.knownGovernments.has(g))
          govts.delete(g);
      if (!govts.size) byPlugin.delete(pluginId);
    }
    return byPlugin;
  }

  // events that change these governments
  _eventChangesForGovernments(governmentNames) {
    if (!governmentNames || governmentNames.size === 0) return [];
    const lines = new Set();
    for (const c of this.eventGovernmentAttitudeChanges) {
      if (!governmentNames.has(c.government) && !governmentNames.has(c.towardGovernment)) continue;
      lines.add(
        `Event "${c.eventName}": ${c.government} attitude toward ${c.towardGovernment} → ${c.value}`
      );
    }
    return [...lines].sort();
  }

  // ── public ──

  // add government data to ships, variants and outfits. Called by: parser.js
  attachSpecies(ships, variants, outfits, pluginName) {
    // Map → object
    const toObj = (byPlugin) => {
      if (byPlugin.size === 0) {
        if (!pluginName) return {};
        return { [pluginName]: { [pluginName]: true } };
      }
      const obj = {};
      for (const [pluginId, govts] of byPlugin) {
        const key = pluginId === '__unknown__' ? (pluginName ?? '__unknown__') : pluginId;
        if (!obj[key]) obj[key] = {};
        for (const g of govts) obj[key][g] = true;
      }
      return obj;
    };

    // every government name across plugins
    const flattenGovs = (byPlugin) => {
      const flat = new Set();
      for (const govts of byPlugin.values()) for (const g of govts) flat.add(g);
      return flat;
    };

    for (const ship of ships) {
      const byPlugin = this._governmentsForShip(ship.name, ship._pluginId ?? null);
      this._filterToKnownGovernments(byPlugin);
      if (byPlugin.size === 0 && pluginName)
        byPlugin.set(pluginName, new Set([pluginName]));
      ship.governments = toObj(byPlugin);
      ship.governmentEvents = this._eventChangesForGovernments(flattenGovs(byPlugin));
    }

    for (const variant of variants) {
      // variant name first (its own plugin)
      let byPlugin = this._governmentsForShip(variant.name, variant._variantPluginId ?? null);
      this._filterToKnownGovernments(byPlugin);

      // then the base ship's (any plugin)
      if (byPlugin.size === 0) {
        byPlugin = this._governmentsForShip(variant.baseShip ?? variant.name, null);
        this._filterToKnownGovernments(byPlugin);
      }

      if (byPlugin.size === 0 && pluginName)
        byPlugin.set(pluginName, new Set([pluginName]));
      variant.governments = toObj(byPlugin);
      variant.governmentEvents = this._eventChangesForGovernments(flattenGovs(byPlugin));
    }

    for (const outfit of outfits) {
      const byPlugin = this._governmentsForOutfit(outfit.name);
      if (byPlugin.size === 0 && pluginName)
        byPlugin.set(pluginName, new Set([pluginName]));
      outfit.governments = toObj(byPlugin);
      outfit.governmentEvents = this._eventChangesForGovernments(flattenGovs(byPlugin));
    }
  }
}
module.exports = SpeciesResolver;