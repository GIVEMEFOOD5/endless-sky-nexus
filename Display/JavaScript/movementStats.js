;(function () {
'use strict';

// A ship's movement figures (speed, acceleration, turning, jumps, cloaking) from the game's formulas.

const FPS = 60;

let SOLAR_POWER = 1.0;

let _attrDefs = null;
let _ready    = false;
let _keys     = null;

function _a(combined, key) {
    if (!key) return 0;
    const v = combined[key];
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

// ramscoop formula from the game code
function _parseRamscoopFormula(formulaStr) {
    if (!formulaStr) return null;

    const coeffMatch = formulaStr.match(/^([\d.]+(?:e[+-]?\d+)?)/i);
    const coefficient = coeffMatch ? parseFloat(coeffMatch[1]) : 1.0;

    const solarExp = /sqrt\s*\(\s*solar_power\s*\)/i.test(formulaStr) ? 0.5 : 1.0;

    const attrMatch = formulaStr.match(/\[([^\]]+)\]/);
    const attrKey   = attrMatch ? attrMatch[1] : null;

    return { coefficient, solarExp, attrKey };
}

// which attribute is which
function _buildKeyRegistry(attrDefs) {
    const attrs    = attrDefs?.attributes            || {};
    const shipFns  = attrDefs?.shipFunctions         || {};
    const navFns   = attrDefs?.navigation            || {};
    const sysAware = attrDefs?.systemAwareFormulas   || {};
    const capDisp  = attrDefs?.shipDisplay?.capacityDisplay || [];
    const intVars  = attrDefs?.shipDisplay?.intermediateVars || {};

    // find an attribute key
    const findKey = (...patterns) => {
        for (const pat of patterns) {
            if (attrs[pat]) return pat;
            const found = Object.keys(attrs).find(k => k === pat);
            if (found) return found;
        }
        for (const pat of patterns) {
            const lp = pat.toLowerCase();
            const found = Object.keys(attrs).find(k => k.toLowerCase() === lp);
            if (found) return found;
        }
        return null;
    };

    const movementFnAttrs = new Set();
    for (const [fnName, fnData] of Object.entries(shipFns)) {
        const reads = fnData.attributesRead || [];
        const isDragFn = reads.some(k => k.toLowerCase().includes('drag'));
        const isTurnFn = reads.some(k => k.toLowerCase().includes('turn'));
        if (isDragFn || isTurnFn) {
            for (const k of reads) movementFnAttrs.add(k);
        }
    }

    const navFnAttrs  = new Set();
    const navBooleans = new Set();
    for (const [fnName, fnData] of Object.entries(navFns)) {
        const reads = fnData.attributesRead || [];
        for (const k of reads) {
            navFnAttrs.add(k);
            if (attrs[k]?.isBoolean) navBooleans.add(k);
        }
    }

    const cloakFnAttrs = new Set();
    for (const [fnName, fnData] of Object.entries(shipFns)) {
        if (fnName.toLowerCase().includes('cloak')) {
            for (const k of (fnData.attributesRead || [])) cloakFnAttrs.add(k);
        }
    }
    const cloakRate = [...cloakFnAttrs].find(k =>
        k.toLowerCase() === 'cloak' || k.toLowerCase() === 'cloaking'
    ) || findKey('cloak');

    const cloakingCostKeys = Object.keys(attrs).filter(k =>
        k.toLowerCase().startsWith('cloaking ')
    );

    const fuelCapEntry = capDisp.find(e =>
        e.displayLabel?.toLowerCase().includes('fuel')
    );
    const fuelCapacity = fuelCapEntry?.attributeKey
        ?? findKey('fuel capacity');

    const ramscoopFormula = sysAware['ramscoop']?.formula || null;
    const ramscoopParsed  = _parseRamscoopFormula(ramscoopFormula);

    const find = (...pats) => findKey(...pats);

    return {
        mass:              find('mass'),
        inertiaReduction:  find('inertia reduction'),
        accelMultiplier:   find('acceleration multiplier'),

        drag:              find('drag'),
        dragReduction:     find('drag reduction'),

        thrust:            find('thrust'),
        thrustEnergy:      find('thrusting energy'),
        thrustHeat:        find('thrusting heat'),
        thrustFuel:        find('thrusting fuel'),

        reverseThrust:     find('reverse thrust'),
        reverseEnergy:     find('reverse thrusting energy'),
        reverseHeat:       find('reverse thrusting heat'),

        afterburnerThrust:   find('afterburner thrust'),
        afterburnerEnergy:   find('afterburner energy'),
        afterburnerHeat:     find('afterburner heat'),
        afterburnerFuel:     find('afterburner fuel'),
        afterburnerShields:  find('afterburner shields'),

        turning:           find('turn'),
        turningEnergy:     find('turning energy'),
        turningHeat:       find('turning heat'),
        turningFuel:       find('turning fuel'),

        jumpFuel:          find('jump fuel'),
        jumpFuelMult:      find('jump fuel multiplier'),
        jumpRange:         find('jump range'),
        fuelCapacity,
        driveTypes:        [...navBooleans],

        ramscoop:          ramscoopParsed,
        fuelGeneration:    find('fuel generation'),

        cloakRate,
        cloakingCostKeys,

        intermediateVars:  intVars,
    };
}

// read the formulas from the definitions. Called on load

function init(attrDefs) {
    _attrDefs = attrDefs || null;
    SOLAR_POWER = _attrDefs?.systemContext?.referenceSolarPower ?? 1.0;
    _keys     = _attrDefs ? _buildKeyRegistry(_attrDefs) : null;
    _ready    = !!_keys;
    if (_ready)
        console.log(`[MovementStats] Ready — solar power: ${SOLAR_POWER}, key registry built from attrDefs.`);
    else
        console.warn('[MovementStats] init called without attrDefs — will use fallback keys.');
}

// are the definitions loaded?
function isReady()     { return _ready; }
// the key list
function getRegistry() { return _keys; }

// keys to use before the definitions load
function _fallbackKeys() {
    return {
        mass: 'mass', inertiaReduction: 'inertia reduction',
        accelMultiplier: 'acceleration multiplier',
        drag: 'drag', dragReduction: 'drag reduction',
        thrust: 'thrust', thrustEnergy: 'thrusting energy',
        thrustHeat: 'thrusting heat', thrustFuel: 'thrusting fuel',
        reverseThrust: 'reverse thrust',
        reverseEnergy: 'reverse thrusting energy',
        reverseHeat: 'reverse thrusting heat',
        afterburnerThrust: 'afterburner thrust',
        afterburnerEnergy: 'afterburner energy',
        afterburnerHeat: 'afterburner heat',
        afterburnerFuel: 'afterburner fuel',
        afterburnerShields: 'afterburner shields',
        turning: 'turn', turningEnergy: 'turning energy',
        turningHeat: 'turning heat', turningFuel: 'turning fuel',
        jumpFuel: 'jump fuel', jumpFuelMult: 'jump fuel multiplier',
        jumpRange: 'jump range', fuelCapacity: 'fuel capacity',
        driveTypes: ['hyperdrive', 'jump drive', 'scram drive'],
        ramscoop: { attrKey: 'ramscoop', coefficient: 0.03, solarExp: 0.5 },
        fuelGeneration: 'fuel generation',
        cloakRate: 'cloak',
        cloakingCostKeys: [
            'cloaking energy', 'cloaking fuel', 'cloaking heat',
            'cloaking shields', 'cloaking hull',
        ],
        intermediateVars: {},
    };
}

// movement figures for a ship's attributes. Called by: computedMovementStats

function compute(combinedAttrs, attrDefsOverride) {
    if (attrDefsOverride && !_ready) init(attrDefsOverride);
    const k   = _keys || _fallbackKeys();
    const c   = combinedAttrs || {};
    const a   = key => _a(c, key);

    const mass         = a(k.mass);
    const inertiaRed   = a(k.inertiaReduction);
    const inertialMass = mass > 0 ? mass / (1 + inertiaRed) : 0;

    const dragAttr     = a(k.drag);
    const dragRed      = a(k.dragReduction);
    const effectiveDrag = inertialMass > 0
        ? Math.min(dragAttr / (1 + dragRed), inertialMass)
        : Math.max(0, dragAttr / (1 + dragRed));

    const thrust       = a(k.thrust);
    const accelMult    = a(k.accelMultiplier);
    const maxVelFwd    = effectiveDrag > 0 ? (thrust / effectiveDrag) * FPS : 0;
    const accelFwd     = inertialMass  > 0
        ? (thrust / inertialMass) * (1 + accelMult) * FPS * FPS : 0;
    const timeToMaxVelSecs = effectiveDrag > 0
        ? (inertialMass / effectiveDrag) / FPS : null;

    const reverseThrust = a(k.reverseThrust);
    const maxVelRev     = (effectiveDrag > 0 && reverseThrust > 0)
        ? (reverseThrust / effectiveDrag) * FPS : 0;
    const accelRev      = (inertialMass > 0 && reverseThrust > 0)
        ? (reverseThrust / inertialMass) * (1 + accelMult) * FPS * FPS : 0;

    const abThrust      = a(k.afterburnerThrust);
    const hasAB         = abThrust > 0;
    const abTotalThrust = thrust + abThrust;
    const maxVelAB      = (effectiveDrag > 0 && hasAB)
        ? (abTotalThrust / effectiveDrag) * FPS : 0;
    const accelAB       = (inertialMass > 0 && hasAB)
        ? (abTotalThrust / inertialMass) * (1 + accelMult) * FPS * FPS : 0;

    const turning        = a(k.turning);
    // turn rate includes the game's turn multiplier
    const turnMultiplier = a('turn multiplier') || 0;
    const turnRatePerSec = inertialMass > 0
        ? (turning / inertialMass) * (1 + turnMultiplier) * FPS
        : 0;
    // Time to turn 180°: only null if we literally cannot turn at all
    const timeFor180Secs = turnRatePerSec > 0 ? 180 / turnRatePerSec : null;

    const driveResults = {};
    for (const driveKey of (k.driveTypes || [])) {
        if (a(driveKey) > 0) driveResults[driveKey] = true;
    }
    const canJump = Object.keys(driveResults).length > 0;

    const jumpFuelBase = canJump
        ? (a(k.jumpFuel) > 0 ? a(k.jumpFuel) : 100)
        : 0;
    const jumpFuelCost = jumpFuelBase * (1 + a(k.jumpFuelMult));

    const hasJumpDrivetype = (k.driveTypes || []).some(dk =>
        dk.toLowerCase().includes('jump drive') && a(dk) > 0
    );
    const jumpRange = hasJumpDrivetype ? a(k.jumpRange) : 0;

    const fuelCap      = a(k.fuelCapacity);
    const jumpsOnFull  = (canJump && jumpFuelCost > 0)
        ? Math.floor(fuelCap / jumpFuelCost) : 0;

    let ramscoopPerSec = 0;
    if (k.ramscoop) {
        const { attrKey, coefficient, solarExp } = k.ramscoop;
        ramscoopPerSec = coefficient
            * Math.pow(SOLAR_POWER, solarExp)
            * a(attrKey);
    }
    const fuelGenPerSec   = a(k.fuelGeneration);
    const fuelRegenPerSec = ramscoopPerSec + fuelGenPerSec;

    const refuelFullSecs = (fuelRegenPerSec > 0 && fuelCap > 0)
        ? fuelCap / fuelRegenPerSec : null;
    const refuelJumpSecs = (fuelRegenPerSec > 0 && jumpFuelCost > 0)
        ? jumpFuelCost / fuelRegenPerSec : null;

    const cloakRate  = a(k.cloakRate);
    const canCloak   = cloakRate > 0;
    const cloakTimeFrames = canCloak ? Math.ceil(1 / cloakRate) : null;
    const cloakTimeSecs   = cloakTimeFrames != null ? cloakTimeFrames / FPS : null;

    const cloakCosts = {};
    for (const costKey of (k.cloakingCostKeys || [])) {
        const val = a(costKey);
        if (val !== 0) {
            const label = costKey.replace(/^cloaking\s+/i, '');
            cloakCosts[label] = +(val * FPS).toFixed(4);
        }
    }

    const fwdEPerSec  = a(k.thrustEnergy)  * FPS;
    const revEPerSec  = a(k.reverseEnergy) * FPS;
    const turnEPerSec = a(k.turningEnergy) * FPS;
    const fwdHPerSec  = a(k.thrustHeat)    * FPS;
    const revHPerSec  = a(k.reverseHeat)   * FPS;
    const turnHPerSec = a(k.turningHeat)   * FPS;
    const fwdFPerSec  = a(k.thrustFuel)    * FPS;
    const turnFPerSec = a(k.turningFuel)   * FPS;
    const abEPerSec   = hasAB ? a(k.afterburnerEnergy)  * FPS : 0;
    const abHPerSec   = hasAB ? a(k.afterburnerHeat)    * FPS : 0;
    const abFPerSec   = hasAB ? a(k.afterburnerFuel)    * FPS : 0;

    const combatEPerSec = Math.max(fwdEPerSec, revEPerSec) + turnEPerSec;
    const combatHPerSec = Math.max(fwdHPerSec, revHPerSec) + turnHPerSec;
    const combatFPerSec = fwdFPerSec + turnFPerSec;

    const maxVelPerFrame    = maxVelFwd / FPS;
    const stoppingDistPx    = effectiveDrag > 0
        ? maxVelPerFrame * (inertialMass / effectiveDrag) * FPS
        : 0;

    const tags = [];
    if (thrust > 0)          tags.push('can-thrust');
    if (reverseThrust > 0)   tags.push('reverse-thrust');
    if (hasAB)               tags.push('afterburner');
    if (turning > 0)         tags.push('can-turn');
    if (canJump)             tags.push('can-jump');
    for (const dk of Object.keys(driveResults)) tags.push(dk);
    if (canCloak)            tags.push('cloaking');
    if (combatFPerSec > 0 || abFPerSec > 0) tags.push('fuel-consuming');

    return {
        mass:            +mass.toFixed(2),
        inertiaReduction:+inertiaRed.toFixed(4),
        inertialMass:    +inertialMass.toFixed(2),
        dragAttribute:   +dragAttr.toFixed(4),
        dragReduction:   +dragRed.toFixed(4),
        effectiveDrag:   +effectiveDrag.toFixed(4),

        thrust,
        maxVelocity:         +maxVelFwd.toFixed(2),
        acceleration:        +accelFwd.toFixed(3),
        timeToMaxVelocitySecs: timeToMaxVelSecs != null ? +timeToMaxVelSecs.toFixed(2) : null,
        thrustCostsPerSec: {
            energy: +fwdEPerSec.toFixed(3),
            heat:   +fwdHPerSec.toFixed(3),
            fuel:   +fwdFPerSec.toFixed(4),
        },

        reverseThrust,
        hasReverseThrust:   reverseThrust > 0,
        maxVelocityReverse: +maxVelRev.toFixed(2),
        accelerationReverse:+accelRev.toFixed(3),
        reverseCostsPerSec: {
            energy: +revEPerSec.toFixed(3),
            heat:   +revHPerSec.toFixed(3),
        },

        hasAfterburner:          hasAB,
        afterburnerThrust:       abThrust,
        maxVelocityAfterburner:  +maxVelAB.toFixed(2),
        accelerationAfterburner: +accelAB.toFixed(3),
        afterburnerCostsPerSec:  hasAB ? {
            energy:  +abEPerSec.toFixed(3),
            heat:    +abHPerSec.toFixed(3),
            fuel:    +abFPerSec.toFixed(4),
            shields: +(a(k.afterburnerShields) * FPS).toFixed(3),
        } : null,

        turning,
        turnRateDegPerSec:  +turnRatePerSec.toFixed(2),
        timeFor180Secs:     timeFor180Secs != null ? +timeFor180Secs.toFixed(2) : null,
        turningCostsPerSec: {
            energy: +turnEPerSec.toFixed(3),
            heat:   +turnHPerSec.toFixed(3),
            fuel:   +turnFPerSec.toFixed(4),
        },

        sustainedCombat: {
            energyPerSec: +combatEPerSec.toFixed(3),
            heatPerSec:   +combatHPerSec.toFixed(3),
            fuelPerSec:   +combatFPerSec.toFixed(4),
            withAfterburner: hasAB ? {
                energyPerSec: +(combatEPerSec + abEPerSec).toFixed(3),
                heatPerSec:   +(combatHPerSec + abHPerSec).toFixed(3),
                fuelPerSec:   +(combatFPerSec + abFPerSec).toFixed(4),
            } : null,
        },

        stoppingDistancePx: +stoppingDistPx.toFixed(1),

        canJump,
        drives:            driveResults,
        jumpFuelPerJump:   +jumpFuelCost.toFixed(2),
        jumpRange,
        fuelCapacity:      fuelCap,
        jumpsOnFullTank:   jumpsOnFull,
        fuelRegenPerSec:   +fuelRegenPerSec.toFixed(4),
        ramscoopPerSec:    +ramscoopPerSec.toFixed(4),
        fuelGenPerSec:     +fuelGenPerSec.toFixed(4),
        refuelFullSecs:    refuelFullSecs  != null ? +refuelFullSecs.toFixed(1)  : null,
        refuelForJumpSecs: refuelJumpSecs  != null ? +refuelJumpSecs.toFixed(1)  : null,

        canCloak,
        cloakRate:         canCloak ? +cloakRate.toFixed(4) : 0,
        timeToFullCloakSecs: cloakTimeSecs != null ? +cloakTimeSecs.toFixed(2) : null,
        cloakCostsPerSec:  cloakCosts,

        tags,
    };
}

// figures as text

function format(profile) {
    if (!profile) return '(null profile)';
    const p   = profile;
    const row = (label, value, unit = '') =>
        `  ${String(label).padEnd(30)} ${value}${unit}`;
    const pct = v => `${(v * 100).toFixed(1)}%`;
    const f   = v => v == null ? '—' : String(v);

    const lines = [
        `╔══ MOVEMENT PROFILE ${'═'.repeat(33)}`,
        `║  Tags: ${p.tags.join(', ') || 'none'}`,
        `║`,
        `║  MASS & DRAG`,
        row('║    Mass',              f(p.mass),            ' t'),
        row('║    Inertia Reduction', pct(p.inertiaReduction)),
        row('║    Inertial Mass',     f(p.inertialMass),    ' t'),
        row('║    Drag Attribute',    f(p.dragAttribute)),
        row('║    Drag Reduction',    pct(p.dragReduction)),
        row('║    Effective Drag',    f(p.effectiveDrag)),
        `║`,
        `║  FORWARD THRUST`,
        row('║    Thrust',            f(p.thrust)),
        row('║    Max Velocity',      f(p.maxVelocity),         ' px/s'),
        row('║    Acceleration',      f(p.acceleration),        ' px/s²'),
        row('║    Time to ~63% vel',  f(p.timeToMaxVelocitySecs), ' s'),
        row('║    Energy cost',       f(p.thrustCostsPerSec.energy), '/s'),
        row('║    Heat cost',         f(p.thrustCostsPerSec.heat),   '/s'),
        p.thrustCostsPerSec.fuel > 0
            ? row('║    Fuel cost',    f(p.thrustCostsPerSec.fuel),   '/s') : null,
        `║`,
        `║  TURNING`,
        row('║    Turning',           f(p.turning)),
        row('║    Turn Rate',         f(p.turnRateDegPerSec),   ' deg/s'),
        row('║    Time for 180°',     p.timeFor180Secs != null ? f(p.timeFor180Secs) : '∞', ' s'),
        row('║    Energy cost',       f(p.turningCostsPerSec.energy), '/s'),
        row('║    Heat cost',         f(p.turningCostsPerSec.heat),   '/s'),
        p.turningCostsPerSec.fuel > 0
            ? row('║    Fuel cost',    f(p.turningCostsPerSec.fuel),   '/s') : null,
    ].filter(Boolean);

    if (p.hasReverseThrust) {
        lines.push(
            `║`,
            `║  REVERSE THRUST`,
            row('║    Reverse Thrust',     f(p.reverseThrust)),
            row('║    Max Reverse Vel',    f(p.maxVelocityReverse),  ' px/s'),
            row('║    Reverse Accel',      f(p.accelerationReverse), ' px/s²'),
            row('║    Energy cost',        f(p.reverseCostsPerSec.energy), '/s'),
            row('║    Heat cost',          f(p.reverseCostsPerSec.heat),   '/s'),
        );
    }

    if (p.hasAfterburner) {
        const ab = p.afterburnerCostsPerSec;
        const abRows = [
            `║`,
            `║  AFTERBURNER (additive to thrust)`,
            row('║    AB Thrust bonus',    f(p.afterburnerThrust)),
            row('║    Max Vel (w/ AB)',    f(p.maxVelocityAfterburner),  ' px/s'),
            row('║    Accel (w/ AB)',      f(p.accelerationAfterburner), ' px/s²'),
            row('║    Energy cost',        f(ab.energy),  '/s'),
            row('║    Heat cost',          f(ab.heat),    '/s'),
            ab.fuel    > 0 ? row('║    Fuel cost',    f(ab.fuel),    '/s') : null,
            ab.shields > 0 ? row('║    Shield cost',  f(ab.shields), '/s') : null,
        ].filter(Boolean);
        lines.push(...abRows);
    }

    {
        const sc = p.sustainedCombat;
        const coreRows = [
            `║`,
            `║  MANEUVERABILITY`,
            row('║    Stopping Distance',  f(p.stoppingDistancePx), ' px'),
            `║`,
            `║  SUSTAINED COMBAT COSTS`,
            row('║    Energy/s',           f(sc.energyPerSec), '/s'),
            row('║    Heat/s',             f(sc.heatPerSec),   '/s'),
            sc.fuelPerSec > 0
                ? row('║    Fuel/s',       f(sc.fuelPerSec),   '/s') : null,
            sc.withAfterburner
                ? row('║    Energy/s (AB on)', f(sc.withAfterburner.energyPerSec), '/s') : null,
        ].filter(Boolean);
        lines.push(...coreRows);
    }

    if (p.canJump) {
        const driveNames = Object.keys(p.drives).join(', ');
        const jumpRows = [
            `║`,
            `║  JUMP CAPABILITY`,
            row('║    Drives',             driveNames),
            row('║    Fuel per Jump',      f(p.jumpFuelPerJump)),
            row('║    Fuel Capacity',      f(p.fuelCapacity)),
            row('║    Jumps (full tank)',   f(p.jumpsOnFullTank)),
            p.jumpRange > 0
                ? row('║    Jump Range',   f(p.jumpRange)) : null,
            p.fuelRegenPerSec > 0
                ? row('║    Fuel Regen/s', f(p.fuelRegenPerSec)) : null,
            p.refuelForJumpSecs != null
                ? row('║    Refuel/jump',  f(p.refuelForJumpSecs), ' s') : null,
        ].filter(Boolean);
        lines.push(...jumpRows);
    }

    if (p.canCloak) {
        lines.push(
            `║`,
            `║  CLOAKING`,
            row('║    Cloak Rate',           f(p.cloakRate)),
            row('║    Time to Full Cloak',   f(p.timeToFullCloakSecs), ' s'),
            ...Object.entries(p.cloakCostsPerSec).map(([k, v]) =>
                row(`║    ${k}/s`, f(v))
            ),
        );
    }

    lines.push(`╚${'═'.repeat(52)}`);
    return lines.join('\n');
}

// two ships' figures side by side
function compareProfiles(profileA, nameA, profileB, nameB) {
    // number with unit, or '—'
    const fmtVal = (v, unit = '') => {
        if (v == null) return '—';
        return `${v}${unit}`;
    };

    const row = (label, vA, vB, unit = '', higherIsBetter = true) => {
        const nA = typeof vA === 'number' ? vA : null;
        const nB = typeof vB === 'number' ? vB : null;
        let winner = null;
        if (nA !== null && nB !== null) {
            if (Math.abs(nA - nB) < 1e-6)                        winner = 'equal';
            else if (higherIsBetter ? nA > nB : nA < nB)         winner = 'A';
            else                                                   winner = 'B';
        }
        return {
            label,
            valueA: fmtVal(vA, unit),
            valueB: fmtVal(vB, unit),
            winner,
        };
    };

    const A = profileA, B = profileB;
    const scA = A.sustainedCombat, scB = B.sustainedCombat;

    return {
        nameA, nameB,
        rows: [
            { section: 'Mass & Drag' },
            row('Mass',                  A.mass,             B.mass,             ' t',      false),
            row('Inertial Mass',         A.inertialMass,     B.inertialMass,     ' t',      false),
            row('Effective Drag',        A.effectiveDrag,    B.effectiveDrag,    '',        false),

            { section: 'Speed' },
            row('Max Velocity',          A.maxVelocity,      B.maxVelocity,      ' px/s'),
            // Always show AB velocity row; null values will show as '—'
            row('Afterburner Velocity',  A.hasAfterburner ? A.maxVelocityAfterburner : null,
                                         B.hasAfterburner ? B.maxVelocityAfterburner : null, ' px/s'),
            // Always show reverse velocity row; null values show as '—'
            row('Reverse Velocity',      A.hasReverseThrust ? A.maxVelocityReverse : null,
                                         B.hasReverseThrust ? B.maxVelocityReverse : null,   ' px/s'),

            { section: 'Agility' },
            row('Acceleration',          A.acceleration,        B.acceleration,        ' px/s²'),
            // FIX: These rows always emit — null displays as '—' which is correct
            row('Turn Rate',             A.turnRateDegPerSec,   B.turnRateDegPerSec,   ' °/s'),
            row('Time for 180°',         A.timeFor180Secs,      B.timeFor180Secs,      ' s',   false),
            row('Stopping Distance',     A.stoppingDistancePx,  B.stoppingDistancePx,  ' px',  false),

            { section: 'Combat Running Costs (lower = better)' },
            row('Energy/s',              scA.energyPerSec,   scB.energyPerSec,   '',        false),
            row('Heat/s',                scA.heatPerSec,     scB.heatPerSec,     '',        false),
            row('Fuel/s',                scA.fuelPerSec,     scB.fuelPerSec,     '',        false),
        ],
    };
}

// ── window.MovementStats ──

window.MovementStats = {
    init,
    isReady,
    compute,
    format,
    compareProfiles,
    getRegistry,
};

})();
