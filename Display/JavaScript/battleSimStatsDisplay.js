;(function () {
'use strict';

// The battle simulator's results: HP chart, side-by-side stats, weapons, fight log, rankings, progress window.

const FPS           = 60;
const MAX_SIM_SECS  = 6000;

// ── formatting ──

function fmt(n) {
    if (n === null || n === undefined) return '—';
    if (!isFinite(n)) return '∞';
    if (Math.abs(n) >= 100000) return (n / 1000).toFixed(1) + 'k';
    if (Math.abs(n) >= 10000)  return Math.round(n).toLocaleString();
    if (Math.abs(n) < 0.01 && n !== 0) return n.toExponential(2);
    if (Number.isInteger(n)) return n.toString();
    return parseFloat(n.toPrecision(4)).toString();
}
function fmtT(t)   { return isFinite(t) ? t.toFixed(1) + 's' : '∞'; }
// time-to-kill text
function fmtTTK(t) { return isFinite(t) ? fmtT(t) : '∞ (never)'; }
// "12.3%"
function fmtPct(v) {
    if (!v) return '0%';
    return (v * 100).toFixed(2).replace(/\.?0+$/, '') + '%';
}
// "+12/s"
function fmtNet(v) {
    if (!isFinite(v) || v === 0) return '0';
    return (v > 0 ? '+' : '') + fmt(v);
}
function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// "#rrggbb" → rgba()
function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}
// "disabled in 12.3s" text
function buildTtkString(name, ttk, projectedTtk) {
    const n = escHtml(name);
    if (isFinite(ttk)) return `${n} disabled in ${fmtT(ttk)}`;
    if (projectedTtk == null) return `${n} survived`;
    if (!isFinite(projectedTtk)) return `${n} survived (regen &gt; damage)`;
    return `${n} survived · ~${fmtT(projectedTtk)} projected`;
}

// ── other modules ──

let _damageTypes  = [];
let _outfitIndex  = {};
let _attrDefs     = null;

// ammo that's really a capacity (negative)

function _isNegativeCapacityAmmo(outfit) {
    const check = obj => {
        for (const [k, v] of Object.entries(obj || {}))
            if (k.endsWith(' capacity') && typeof v === 'number' && v < 0) return true;
        return false;
    };
    return check(outfit) || check(outfit.attributes);
}

// which ammo a weapon uses
function resolveAmmoRef(w) {
    const raw = w['ammo'];
    if (typeof raw === 'string' && raw.length > 0) return { ammoName: raw, ammoCount: 1 };
    for (const key of Object.keys(w)) {
        if (key === 'ammo') continue;
        const val = w[key];
        if (!val && val !== 0) continue;
        if (typeof val !== 'number' && val !== true) continue;
        const outfit = _outfitIndex[key];
        if (outfit) {
            const isAmmo =
                outfit.category === 'Ammunition' ||
                (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0) ||
                (typeof outfit.attributes?.[key] === 'number' && outfit.attributes[key] > 0) ||
                _isNegativeCapacityAmmo(outfit);
            if (!isAmmo) continue;
            return { ammoName: key, ammoCount: val === true ? 1 : Math.max(1, Math.round(val)) };
        }
    }
    return null;
}

// HP over time chart. Called by: buildMatchupBlock, renderResults2Team

function buildHpChart(sA, sB, result) {
    const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const tlA    = (result.timelineA || []).map(p => ({ ...p }));
    const tlB    = (result.timelineB || []).map(p => ({ ...p }));
    if (!tlA.length && !tlB.length) return '';

    const W = 560, H = 200, PL = 48, PR = 12, PT = 14, PB = 28;
    const cW = W - PL - PR, cH = H - PT - PB;

    const deathA     = isFinite(result.ttkA) ? result.ttkA : Infinity;
    const deathB     = isFinite(result.ttkB) ? result.ttkB : Infinity;
    const firstDeath = Math.min(deathA, deathB);
    const lastPoint  = tl => tl.length ? tl[tl.length - 1].t : 0;
    const maxTime    = Math.max(
        isFinite(firstDeath) ? firstDeath : Math.max(lastPoint(tlA), lastPoint(tlB)),
        0.1
    );
    const maxHP = Math.max(sA.maxShields + sA.maxHull, sB.maxShields + sB.maxHull, 1);
    const px    = t  => PL + clamp(t,  0, maxTime) / maxTime * cW;
    const py    = hp => PT + cH - clamp(hp, 0, maxHP) / maxHP * cH;

    function clip(tl, iS, iH) {
        if (!tl.length) return [];
        const out = [];
        if (tl[0].t > 0) out.push({ t: 0, shields: iS, hull: iH });
        for (let i = 0; i < tl.length; i++) {
            const p = tl[i];
            if (p.t <= maxTime) {
                out.push(p);
            } else {
                const prev = tl[i - 1] || out[out.length - 1];
                if (prev && prev.t < maxTime) {
                    const dt = p.t - prev.t, r = dt > 0 ? (maxTime - prev.t) / dt : 0;
                    out.push({ t: maxTime, shields: prev.shields + (p.shields - prev.shields) * r, hull: prev.hull + (p.hull - prev.hull) * r });
                }
                break;
            }
        }
        if (out.length === 1) out.push({ ...out[0], t: out[0].t + 0.001 });
        return out;
    }

    const cA = clip(tlA, sA.maxShields, sA.maxHull);
    const cB = clip(tlB, sB.maxShields, sB.maxHull);
    if (!cA.length && !cB.length) return '';

    // chart lines
    function makePaths(tl) {
        if (!tl.length) return { hull: '', shieldArea: '' };
        const hull = tl.map((p, i) =>
            `${i ? 'L' : 'M'}${px(p.t).toFixed(1)},${py(Math.max(0, p.hull)).toFixed(1)}`
        ).join(' ');
        const hasShields = tl.some(p => p.shields > 0);
        let shieldArea = '';
        if (hasShields) {
            const fwd = tl.map((p, i) =>
                `${i === 0 ? 'M' : 'L'}${px(p.t).toFixed(1)},${py(Math.max(0, p.hull) + Math.max(0, p.shields)).toFixed(1)}`
            ).join(' ');
            const rev = [...tl].reverse().map(p =>
                `L${px(p.t).toFixed(1)},${py(Math.max(0, p.hull)).toFixed(1)}`
            ).join(' ');
            shieldArea = `${fwd} ${rev} Z`;
        }
        return { hull, shieldArea };
    }

    const pA     = makePaths(cA), pB = makePaths(cB);
    const colorA = sA.color || '#3b82f6';
    const colorB = sB.color || '#ef4444';

    const yTicks = [0, 0.5, 1].map(f => {
        const v = maxHP * f, y = py(v).toFixed(1);
        const lb = v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v).toString();
        return `<line x1="${PL}" y1="${y}" x2="${PL + cW}" y2="${y}" stroke="rgba(148,163,184,0.12)" stroke-width="1"/>` +
               `<text x="${PL - 4}" y="${+y + 4}" fill="#64748b" font-size="10" text-anchor="end">${lb}</text>`;
    }).join('');

    const xTicks = [0, 0.5, 1].map(f => {
        const t = maxTime * f, x = px(t).toFixed(1);
        return `<text x="${x}" y="${PT + cH + 14}" fill="#64748b" font-size="10" text-anchor="middle">${t.toFixed(1)}s</text>`;
    }).join('');

    // chart threshold line
    const threshLine = (minHull, color) => minHull > 0
        ? `<line x1="${PL}" y1="${py(minHull).toFixed(1)}" x2="${PL + cW}" y2="${py(minHull).toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>`
        : '';

    const trunc  = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
    const lx     = PL + cW - 4;
    const legend =
        `<rect x="${lx - 82}" y="${PT + 2}"  width="8" height="3" fill="${colorA}" rx="1"/>` +
        `<text x="${lx - 70}" y="${PT + 8}"  fill="${colorA}" font-size="10">${escHtml(trunc(sA.name, 18))}</text>` +
        `<rect x="${lx - 82}" y="${PT + 16}" width="8" height="3" fill="${colorB}" rx="1"/>` +
        `<text x="${lx - 70}" y="${PT + 22}" fill="${colorB}" font-size="10">${escHtml(trunc(sB.name, 18))}</text>`;

    return `<div class="hp-chart-wrap">
        <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style="width:100%;display:block;height:auto;">
            <rect x="${PL}" y="${PT}" width="${cW}" height="${cH}" fill="rgba(15,23,42,0.5)" rx="4"/>
            ${yTicks}${xTicks}
            ${threshLine(sA.minHull, hexToRgba(colorA, 0.5))}
            ${threshLine(sB.minHull, hexToRgba(colorB, 0.5))}
            ${pA.shieldArea ? `<path d="${pA.shieldArea}" fill="${hexToRgba(colorA, 0.12)}" stroke="none"/>` : ''}
            ${pA.hull       ? `<path d="${pA.hull}"       fill="none" stroke="${colorA}" stroke-width="2.5"/>` : ''}
            ${pB.shieldArea ? `<path d="${pB.shieldArea}" fill="${hexToRgba(colorB, 0.12)}" stroke="none"/>` : ''}
            ${pB.hull       ? `<path d="${pB.hull}"       fill="none" stroke="${colorB}" stroke-width="2.5"/>` : ''}
            ${legend}
        </svg>
    </div>`;
}

// side-by-side numbers for two teams

function buildCompareGrid(sA, sB, result) {
    const ttkStrA = isFinite(result.ttkA) ? fmtTTK(result.ttkA)
        : result.projectedTtkA != null
            ? (isFinite(result.projectedTtkA) ? `~${fmtT(result.projectedTtkA)} (proj.)` : '∞ (regen wins)')
            : '∞ (survived)';
    const ttkStrB = isFinite(result.ttkB) ? fmtTTK(result.ttkB)
        : result.projectedTtkB != null
            ? (isFinite(result.projectedTtkB) ? `~${fmtT(result.projectedTtkB)} (proj.)` : '∞ (regen wins)')
            : '∞ (survived)';

    const allProtKeys = new Set([
        ...Object.keys(sA.protections || {}),
        ...Object.keys(sB.protections || {}),
        'piercing resistance',
    ]);
    const protRows = [];
    for (const key of [...allProtKeys].sort()) {
        const va = key === 'piercing resistance' ? sA.piercingRes : (sA.protections?.[key] || 0);
        const vb = key === 'piercing resistance' ? sB.piercingRes : (sB.protections?.[key] || 0);
        if (va === 0 && vb === 0) continue;
        protRows.push([key.replace(/\b\w/g, l => l.toUpperCase()), fmtPct(va), fmtPct(vb)]);
    }

    const energyGenA    = (sA.energyGenPerFrame || 0) * FPS;
    const energyGenB    = (sB.energyGenPerFrame || 0) * FPS;
    const idleConsumeA  = ((sA.energyConsumeIdlePerFrame || 0) + (sA.coolingEnergyPerFrame || 0)) * FPS;
    const idleConsumeB  = ((sB.energyConsumeIdlePerFrame || 0) + (sB.coolingEnergyPerFrame || 0)) * FPS;
    const moveEnergyA   = (sA.movingEnergyPerFrame || 0) * FPS;
    const moveEnergyB   = (sB.movingEnergyPerFrame || 0) * FPS;
    const fireEnergyA   = sA.firingEnergyPerSec || 0;
    const fireEnergyB   = sB.firingEnergyPerSec || 0;
    const netA          = energyGenA - idleConsumeA - moveEnergyA - fireEnergyA;
    const netB          = energyGenB - idleConsumeB - moveEnergyB - fireEnergyB;
    const fuelGenA      = (sA.fuelRegenPerFrame || 0) * FPS;
    const fuelGenB      = (sB.fuelRegenPerFrame || 0) * FPS;
    const fireFuelA     = sA.firingFuelPerSec || 0;
    const fireFuelB     = sB.firingFuelPerSec || 0;
    const moveFuelA     = (sA.movementProfile?.sustainedCombat?.fuelPerSec) ?? 0;
    const moveFuelB     = (sB.movementProfile?.sustainedCombat?.fuelPerSec) ?? 0;
    const netFuelA      = fuelGenA - fireFuelA - moveFuelA;
    const netFuelB      = fuelGenB - fireFuelB - moveFuelB;
    const showFuel      =
        (sA.fuelCap || 0) > 0 || (sB.fuelCap || 0) > 0 ||
        fireFuelA > 0 || fireFuelB > 0 || moveFuelA > 0 || moveFuelB > 0;

    const energySection = [
        ['Energy Cap.',     fmt(sA.energyCap),        fmt(sB.energyCap)],
        ['Energy Gen/s',    fmt(energyGenA),           fmt(energyGenB)],
        ['Idle Consume/s',  fmt(-idleConsumeA),        fmt(-idleConsumeB)],
        ['Move Energy/s',   fmt(-moveEnergyA),         fmt(-moveEnergyB)],
        ['Firing Energy/s', fmt(-fireEnergyA),         fmt(-fireEnergyB)],
        ['Net (combat) /s', fmtNet(netA),              fmtNet(netB)],
        ['Heat Capacity',   fmt(sA.maxHeat),           fmt(sB.maxHeat)],
        ['Cooling/s',       fmt(sA.coolingPerSec),     fmt(sB.coolingPerSec)],
        ['Firing Heat/s',   fmt(sA.firingHeatPerSec),  fmt(sB.firingHeatPerSec)],
        ['Cool Efficiency', (sA.coolEff || 0).toFixed(3), (sB.coolEff || 0).toFixed(3)],
    ];
    if ((sA.firingHullCostPerSec || 0) > 0 || (sB.firingHullCostPerSec || 0) > 0)
        energySection.push(['Firing Hull Cost/s', fmt(sA.firingHullCostPerSec), fmt(sB.firingHullCostPerSec)]);
    if ((sA.firingShieldCostPerSec || 0) > 0 || (sB.firingShieldCostPerSec || 0) > 0)
        energySection.push(['Firing Shield Cost/s', fmt(sA.firingShieldCostPerSec), fmt(sB.firingShieldCostPerSec)]);

    const sections = [
        ['Combat', [
            ['Time to Disable', ttkStrA,            ttkStrB],
            ['Max Shields',     fmt(sA.maxShields), fmt(sB.maxShields)],
            ['Max Hull',        fmt(sA.maxHull),    fmt(sB.maxHull)],
            ['Disable Thresh',  fmt(sA.minHull),    fmt(sB.minHull)],
            ['Shield DPS',      fmt(sA.shieldDPS),  fmt(sB.shieldDPS)],
            ['Hull DPS',        fmt(sA.hullDPS),    fmt(sB.hullDPS)],
            ['Shield Regen/s',  fmt(sA.shieldRegenPerSec), fmt(sB.shieldRegenPerSec)],
            ['Hull Repair/s',   fmt(sA.hullRepairPerSec),  fmt(sB.hullRepairPerSec)],
            ...protRows,
        ]],
        ['Energy & Heat', energySection],
    ];

    if (showFuel) {
        const fuelRows = [
            ['Fuel Capacity', fmt(sA.fuelCap), fmt(sB.fuelCap)],
            ['Fuel Regen/s',  fmt(fuelGenA),   fmt(fuelGenB)],
        ];
        if (moveFuelA > 0 || moveFuelB > 0) fuelRows.push(['Move Fuel/s',   fmt(-moveFuelA), fmt(-moveFuelB)]);
        if (fireFuelA > 0 || fireFuelB > 0) fuelRows.push(['Firing Fuel/s', fmt(-fireFuelA), fmt(-fireFuelB)]);
        fuelRows.push(['Net Fuel/s', fmtNet(netFuelA), fmtNet(netFuelB)]);
        sections.push(['Fuel', fuelRows]);
    }

    const colorA = sA.color || '#3b82f6';
    const colorB = sB.color || '#ef4444';

    return sections.map(([section, items]) => {
        if (!items?.length) return '';
        const colA      = items.map(([, va]) => `<div class="res-row"><div class="res-row-value">${va}</div></div>`).join('');
        const colDiv    = items.map(([label]) => `<div class="res-divider-item">${label}</div>`).join('');
        const colB      = items.map(([,, vb]) => `<div class="res-row"><div class="res-row-value">${vb}</div></div>`).join('');
        const mobileRows = items.map(([label, va, vb]) =>
            `<div class="res-row-mobile">
                <span class="res-row-mobile__label">${label}</span>
                <span class="res-row-mobile__val-a" style="color:${colorA}">${va}</span>
                <span class="res-row-mobile__val-b" style="color:${colorB}">${vb}</span>
            </div>`
        ).join('');
        return `<div class="res-section-title">${section}</div>
        <div class="results-compare">
            <div class="res-col res-col-a" style="--col-a:${colorA}">${colA}</div>
            <div class="res-divider">${colDiv}</div>
            <div class="res-col res-col-b" style="--col-b:${colorB}">${colB}</div>
            ${mobileRows}
        </div>`;
    }).join('');
}

// one weapon line

function buildWeaponItem(w) {
    const extra = [];
    for (const typeName of _damageTypes) {
        if (typeName === 'Shield' || typeName === 'Hull') continue;
        const dps = w[typeName.toLowerCase() + 'DPS'] || 0;
        if (dps > 0.001) {
            const typeEntry = window.DamageTypes?.getDamageType(typeName);
            const isStatusOnly = typeEntry?.category === 'status' && typeEntry?.shieldInteraction !== 'direct';
            extra.push(`${typeName}: ${fmt(dps)}/s${isStatusOnly ? ' ⚡' : ''}`);
        }
    }
    if (w.relShield > 0) extra.push(`%Shld: ${w.relShield}%/hit`);
    if (w.relHull   > 0) extra.push(`%Hull: ${w.relHull}%/hit`);

    return `<div class="weapon-item">
        <div class="weapon-item-name">${window.OutfitNames ? OutfitNames.html(w.name) : escHtml(w.name)}${
            w.hasSubmunitions
                ? `<span style="color:var(--c-accent-text);font-size:0.7em;margin-left:4px;">⚡sub</span>`
                : ''
        }</div>
        <div class="weapon-item-stats">
            <span class="weapon-stat">Rate:<span>${w.sps}/s</span></span>
            <span class="weapon-stat">Shld:<span>${fmt(w.shieldDPS)}/s</span></span>
            <span class="weapon-stat">Hull:<span>${fmt(w.hullDPS)}/s</span></span>
            ${w.piercing  ? `<span class="weapon-stat">Pierce:<span>${w.piercing}%</span></span>` : ''}
            ${w.range     ? `<span class="weapon-stat">Range:<span>${w.range}px</span></span>`   : ''}
            ${w.burstCount > 1 ? `<span class="weapon-stat">Burst:<span>${w.burstCount}×</span></span>` : ''}
            ${w.homing    ? `<span class="weapon-stat">🎯 Homing</span>` : ''}
            ${w.antiMissile ? `<span class="weapon-stat">🛡 A-M</span>` : ''}
            ${extra.map(s => `<span class="weapon-stat">${escHtml(s)}</span>`).join('')}
        </div>
    </div>`;
}

// ammo used vs carried

function buildAmmoSummary(stats) {
    const outfitMap = stats.rawShip?.outfitMap || {};
    const seen = new Set(), rows = [];

    for (const w of stats.weapons) {
        const ammoRef = resolveAmmoRef(w);
        if (!ammoRef?.ammoName) continue;
        const ammoName = ammoRef.ammoName;
        if (seen.has(ammoName)) continue;
        seen.add(ammoName);

        const ammoOutfit = _outfitIndex[ammoName];
        let capacityKey = null, ammoPerUnit = 1;
        if (ammoOutfit) {
            const checkObj = obj => {
                for (const [k, v] of Object.entries(obj || {}))
                    if (k.endsWith(' capacity') && typeof v === 'number' && v < 0)
                        return { k, v };
                return null;
            };
            const hit = checkObj(ammoOutfit) || checkObj(ammoOutfit.attributes);
            if (hit) { capacityKey = hit.k; ammoPerUnit = Math.abs(hit.v); }
        }

        let totalCapacity = 0;
        for (const [outfitName, qty] of Object.entries(outfitMap)) {
            const outfit = _outfitIndex[outfitName];
            if (!outfit || !capacityKey) continue;
            const tl = typeof outfit[capacityKey] === 'number' ? outfit[capacityKey] : 0;
            const al = typeof outfit.attributes?.[capacityKey] === 'number' ? outfit.attributes[capacityKey] : 0;
            const perUnit = tl + al;
            if (perUnit > 0) totalCapacity += perUnit * qty;
        }

        let stock = 0;
        if (capacityKey && totalCapacity > 0) stock = Math.round(totalCapacity / ammoPerUnit);
        else if ((stats.ammoInventory?.[ammoName] ?? 0) > 0) stock = stats.ammoInventory[ammoName];

        let totalSps = 0;
        for (const w2 of stats.weapons) {
            if (resolveAmmoRef(w2)?.ammoName !== ammoName) continue;
            const reload      = Math.max(1, w2.reload || 1);
            const burstCount  = w2['burst count']  || 1;
            const burstReload = w2['burst reload'] || reload;
            totalSps += (burstCount / ((burstCount - 1) * burstReload + reload)) * FPS;
        }

        const sustainSecs = totalSps > 0 ? stock / totalSps : null;
        rows.push({ ammoName, stock, sustainSecs });
    }

    if (!rows.length) return '';

    return `<div class="ship-accordion-subsection-title">Ammo</div>` +
        rows.map(r => `
        <div class="weapon-item">
            <div class="weapon-item-name">${escHtml(r.ammoName)}</div>
            <div class="weapon-item-stats">
                <span class="weapon-stat">Stock:<span>${r.stock}</span></span>
                ${r.sustainSecs != null
                    ? `<span class="weapon-stat">Until Empty:<span>${r.sustainSecs.toFixed(1)}s</span></span>`
                    : ''}
            </div>
        </div>`).join('');
}

// shields/hull summary

function buildHealthSummary(resolved) {
    const rows = [];

    // Shields
    if (resolved.maxShields > 0) {
        rows.push(['Max Shields', fmt(resolved.maxShields)]);
        if ((resolved.shieldRegenPerSec || 0) > 0)
            rows.push(['Shield Regen/s', fmt(resolved.shieldRegenPerSec)]);
        if ((resolved.shieldProt || 0) > 0)
            rows.push(['Shield Protection', fmtPct(resolved.shieldProt)]);
    }

    // Hull
    rows.push(['Max Hull', fmt(resolved.maxHull)]);
    if ((resolved.minHull || 0) > 0)
        rows.push(['Disable Thresh', fmt(resolved.minHull)]);
    if ((resolved.hullRepairPerSec || 0) > 0)
        rows.push(['Hull Repair/s', fmt(resolved.hullRepairPerSec)]);
    if ((resolved.hullProt || 0) > 0)
        rows.push(['Hull Protection', fmtPct(resolved.hullProt)]);

    // Piercing resistance
    if ((resolved.piercingRes || 0) > 0)
        rows.push(['Piercing Resist', fmtPct(resolved.piercingRes)]);

    // Other protections (damage-type specific, e.g. ion protection, burn protection)
    for (const [key, val] of Object.entries(resolved.protections || {})) {
        if (key === 'shield protection' || key === 'hull protection') continue;
        if (!val || val <= 0) continue;
        const label = key.replace(/\b\w/g, l => l.toUpperCase()).replace(' Protection', ' Prot.');
        rows.push([label, fmtPct(val)]);
    }

    // Status resistances
    for (const [statName, val] of Object.entries(resolved.statusResist || {})) {
        if (!val || val <= 0) continue;
        const label = statName.charAt(0).toUpperCase() + statName.slice(1) + ' Resist';
        rows.push([label, fmt(val) + '/s']);
    }

    if (!rows.length) return '';

    return `<div class="ship-accordion-subsection-title">Health</div>` +
        rows.map(([label, value]) =>
            `<div class="ship-accordion-stat-row">
                <span class="ship-accordion-stat-label">${label}</span>
                <span class="ship-accordion-stat-value">${value}</span>
            </div>`
        ).join('');
}

// energy/heat summary

function buildEnergyHeatSummary(resolved) {
    const rows = [];

    const energyGen   = (resolved.energyGenPerFrame   || 0) * FPS;
    const idleConsume = ((resolved.energyConsumeIdlePerFrame || 0) + (resolved.coolingEnergyPerFrame || 0)) * FPS;
    const moveEnergy  = (resolved.movingEnergyPerFrame || 0) * FPS;
    const fireEnergy  = resolved.firingEnergyPerSec   || 0;
    const net         = energyGen - idleConsume - moveEnergy - fireEnergy;

    if ((resolved.energyCap || 0) > 0)
        rows.push(['Energy Cap.', fmt(resolved.energyCap)]);
    if (energyGen > 0)
        rows.push(['Energy Gen/s', fmt(energyGen)]);
    if (idleConsume > 0)
        rows.push(['Idle Consume/s', fmt(-idleConsume)]);
    if (moveEnergy > 0)
        rows.push(['Move Energy/s', fmt(-moveEnergy)]);
    if (fireEnergy > 0)
        rows.push(['Firing Energy/s', fmt(-fireEnergy)]);
    if (energyGen > 0 || fireEnergy > 0)
        rows.push(['Net (combat) /s', fmtNet(net)]);

    if ((resolved.maxHeat || 0) > 0)
        rows.push(['Heat Capacity', fmt(resolved.maxHeat)]);
    if ((resolved.coolingPerSec || 0) > 0)
        rows.push(['Cooling/s', fmt(resolved.coolingPerSec)]);
    if ((resolved.firingHeatPerSec || 0) > 0)
        rows.push(['Firing Heat/s', fmt(resolved.firingHeatPerSec)]);
    if ((resolved.coolEff || 0) !== 0)
        rows.push(['Cool Efficiency', (resolved.coolEff || 0).toFixed(3)]);

    if ((resolved.firingHullCostPerSec || 0) > 0)
        rows.push(['Firing Hull Cost/s', fmt(resolved.firingHullCostPerSec)]);
    if ((resolved.firingShieldCostPerSec || 0) > 0)
        rows.push(['Firing Shield Cost/s', fmt(resolved.firingShieldCostPerSec)]);

    // Fuel
    const fuelGen  = (resolved.fuelRegenPerFrame || 0) * FPS;
    const fireFuel = resolved.firingFuelPerSec || 0;
    const moveFuel = (resolved.movementProfile?.sustainedCombat?.fuelPerSec) ?? 0;
    const showFuel = (resolved.fuelCap || 0) > 0 || fuelGen > 0 || fireFuel > 0 || moveFuel > 0;

    if (showFuel) {
        if ((resolved.fuelCap || 0) > 0)
            rows.push(['Fuel Capacity', fmt(resolved.fuelCap)]);
        if (fuelGen > 0)
            rows.push(['Fuel Regen/s', fmt(fuelGen)]);
        if (moveFuel > 0)
            rows.push(['Move Fuel/s', fmt(-moveFuel)]);
        if (fireFuel > 0)
            rows.push(['Firing Fuel/s', fmt(-fireFuel)]);
        if (fuelGen > 0 || fireFuel > 0 || moveFuel > 0)
            rows.push(['Net Fuel/s', fmtNet(fuelGen - fireFuel - moveFuel)]);
    }

    if (!rows.length) return '';

    return `<div class="ship-accordion-subsection-title">Energy &amp; Heat</div>` +
        rows.map(([label, value]) =>
            `<div class="ship-accordion-stat-row">
                <span class="ship-accordion-stat-label">${label}</span>
                <span class="ship-accordion-stat-value">${value}</span>
            </div>`
        ).join('');
}

// speed and turning summary

function buildMovementSummary(stats) {
    const mp = stats.movementProfile;
    if (!mp) return '';

    const rows = [];

    if (mp.maxVelocity > 0)
        rows.push(['Max Velocity', fmt(mp.maxVelocity) + ' px/s']);
    if (mp.acceleration > 0)
        rows.push(['Acceleration', fmt(mp.acceleration) + ' px/s²']);

    // turn rate: from the movement profile, else worked out here
    let turnRate = mp.turnRateDegPerSec || 0;
    let time180  = mp.timeFor180Secs   ?? null;
    if (turnRate <= 0 && stats.combined) {
        const c     = stats.combined;
        const mass  = c['mass'] || 0;
        const inRed = c['inertia reduction'] || 0;
        const iMass = mass > 0 ? mass / (1 + inRed) : 0;
        const turn  = c['turn'] || c['turning'] || 0;  // attribute is 'turn' in ES data
        const tMult = c['turn multiplier'] || 0;
        if (iMass > 0 && turn > 0) {
            turnRate = (turn / iMass) * (1 + tMult) * FPS;
            time180  = turnRate > 0 ? 180 / turnRate : null;
        }
    }
    if (turnRate > 0)
        rows.push(['Turn Rate', fmt(+turnRate.toFixed(2)) + ' °/s']);
    if (time180 != null && isFinite(time180))
        rows.push(['Time for 180°', fmtT(time180)]);
    if (mp.hasReverseThrust && mp.maxVelocityReverse > 0)
        rows.push(['Reverse Velocity', fmt(mp.maxVelocityReverse) + ' px/s']);
    if (mp.hasAfterburner && mp.maxVelocityAfterburner > 0)
        rows.push(['Afterburner Velocity', fmt(mp.maxVelocityAfterburner) + ' px/s']);
    if (mp.stoppingDistancePx > 0)
        rows.push(['Stopping Distance', fmt(mp.stoppingDistancePx) + ' px']);

    const sc = mp.sustainedCombat;
    if (sc) {
        if (sc.energyPerSec > 0) rows.push(['Move Energy/s', fmt(sc.energyPerSec)]);
        if (sc.heatPerSec > 0)   rows.push(['Move Heat/s',   fmt(sc.heatPerSec)]);
        if (sc.fuelPerSec > 0)   rows.push(['Move Fuel/s',   fmt(sc.fuelPerSec)]);
    }

    if (mp.canJump) {
        rows.push(['Fuel per Jump', fmt(mp.jumpFuelPerJump)]);
        rows.push(['Jumps (full tank)', String(mp.jumpsOnFullTank)]);
        if (mp.fuelRegenPerSec > 0)
            rows.push(['Fuel Regen/s', fmt(mp.fuelRegenPerSec)]);
    }

    if (mp.canCloak && mp.timeToFullCloakSecs != null)
        rows.push(['Cloak Time', fmtT(mp.timeToFullCloakSecs)]);

    if (!rows.length) return '';

    return `<div class="ship-accordion-subsection-title">Movement</div>` +
        rows.map(([label, value]) =>
            `<div class="ship-accordion-stat-row">
                <span class="ship-accordion-stat-label">${label}</span>
                <span class="ship-accordion-stat-value">${value}</span>
            </div>`
        ).join('');
}

// per-ship panels (click to open)

function buildShipAccordion(teamStats, teamColor) {
    const entries = teamStats._teamShips;
    if (!entries || !entries.length) {
        // Fallback: treat merged stats as a single virtual ship
        return buildSingleShipPanel(teamStats, teamStats.name, teamColor, 1);
    }

    return entries.map((entry, idx) => {
        const resolved = entry.resolved;
        const count    = entry.count;
        const shipName = resolved.rawShip?.name || resolved.name || `Ship ${idx + 1}`;
        return buildSingleShipPanel(resolved, shipName, teamColor, count);
    }).join('');
}

// one ship's panel
function buildSingleShipPanel(resolved, shipName, teamColor, count) {
    const panelId = `ship_panel_${Math.random().toString(36).slice(2)}`;

    const weaponDetails = resolved.weaponDetails || [];
    const hasWeapons    = weaponDetails.length > 0;

    const weaponsHtml = hasWeapons
        ? `<div class="ship-accordion-subsection-title">Weapons</div>` +
          weaponDetails.map(w => buildWeaponItem(w)).join('')
        : `<div class="ship-accordion-no-weapons">No weapons</div>`;

    const ammoHtml       = buildAmmoSummary(resolved);
    const healthHtml     = buildHealthSummary(resolved);
    const energyHeatHtml = buildEnergyHeatSummary(resolved);
    const movementHtml   = buildMovementSummary(resolved);

    const countBadge = count > 1
        ? `<span class="ship-accordion-count-badge">×${count}</span>`
        : '';

    // Quick stat summary for the header
    const headerStats = [
        resolved.shieldDPS  > 0 ? `sDPS ${fmt(resolved.shieldDPS)}`  : '',
        resolved.hullDPS    > 0 ? `hDPS ${fmt(resolved.hullDPS)}`    : '',
        resolved.maxShields > 0 ? `Shld ${fmt(resolved.maxShields)}` : '',
        `Hull ${fmt(resolved.maxHull)}`,
    ].filter(Boolean).join(' · ');

    return `
    <div class="ship-accordion" id="${panelId}">
        <div class="ship-accordion-header" onclick="BattleSimDisplay._toggleShipPanel('${panelId}')">
            <span class="ship-accordion-dot" style="background:${escHtml(teamColor)}"></span>
            <div class="ship-accordion-header-text">
                <span class="ship-accordion-name">${escHtml(shipName)}${countBadge}</span>
                <span class="ship-accordion-quick-stats">${escHtml(headerStats)}</span>
            </div>
            <span class="ship-accordion-chevron">▶</span>
        </div>
        <div class="ship-accordion-body" style="display:none;">
            ${weaponsHtml}
            ${ammoHtml}
            ${healthHtml}
            ${energyHeatHtml}
            ${movementHtml}
        </div>
    </div>`;
}

// a team's weapons

function buildTeamWeaponsSection(sA, sB) {
    const colorA = sA.color || '#3b82f6';
    const colorB = sB.color || '#ef4444';

    return `<div class="weapons-grid">
        <div>
            <div class="weapons-col-title" style="color:${colorA}">${escHtml(sA.name)}</div>
            ${buildShipAccordion(sA, colorA)}
        </div>
        <div>
            <div class="weapons-col-title" style="color:${colorB}">${escHtml(sB.name)}</div>
            ${buildShipAccordion(sB, colorB)}
        </div>
    </div>`;
}

// the fight log

function buildPhaseList(result, sA, sB) {
    const phases = [...(result.phases || [])];

    if (result.winner === 'A' && result.projectedTtkA != null) {
        const pttk = result.projectedTtkA;
        phases.push({ time: (result.ttkB || 0) + (isFinite(pttk) ? pttk : 0), type: 'A', icon: '📊',
            text: isFinite(pttk)
                ? `<strong>${escHtml(sA.name)}</strong> projected to survive ~${fmtT(pttk)} more under continued fire`
                : `<strong>${escHtml(sA.name)}</strong> projected to outlast continued fire — regen outpaces damage` });
    }
    if (result.winner === 'B' && result.projectedTtkB != null) {
        const pttk = result.projectedTtkB;
        phases.push({ time: (result.ttkA || 0) + (isFinite(pttk) ? pttk : 0), type: 'B', icon: '📊',
            text: isFinite(pttk)
                ? `<strong>${escHtml(sB.name)}</strong> projected to survive ~${fmtT(pttk)} more under continued fire`
                : `<strong>${escHtml(sB.name)}</strong> projected to outlast continued fire — regen outpaces damage` });
    }

    if (!phases.length) return '<div class="phase-item phase-neutral">No notable events recorded.</div>';

    const colorA = sA.color || '#3b82f6';
    const colorB = sB.color || '#ef4444';

    return phases.map(ph => {
        const color = ph.type === 'A' ? colorA : ph.type === 'B' ? colorB : '#94a3b8';
        return `<div class="phase-item" style="border-left-color:${color}">
            <span class="phase-icon">${ph.icon}</span>
            <span class="phase-time">${fmtT(ph.time)}</span>
            <span class="phase-text">${ph.text}</span>
        </div>`;
    }).join('');
}

// timeline bar

function buildTimelineBarHTML(sA, sB, result) {
    const effA = isFinite(result.ttkA) ? result.ttkA
        : (result.projectedTtkA != null && isFinite(result.projectedTtkA)) ? result.projectedTtkA : MAX_SIM_SECS;
    const effB = isFinite(result.ttkB) ? result.ttkB
        : (result.projectedTtkB != null && isFinite(result.projectedTtkB)) ? result.projectedTtkB : MAX_SIM_SECS;
    const maxT = Math.max(effA, effB, 1);

    const pctA = Math.round(Math.min((effA / maxT) * 50, 50));
    const pctB = Math.round(Math.min((effB / maxT) * 50, 50));

    const lblA = isFinite(result.ttkA) ? fmtT(result.ttkA)
        : (result.projectedTtkA != null && isFinite(result.projectedTtkA)) ? '~' + fmtT(result.projectedTtkA) : '∞';
    const lblB = isFinite(result.ttkB) ? fmtT(result.ttkB)
        : (result.projectedTtkB != null && isFinite(result.projectedTtkB)) ? '~' + fmtT(result.projectedTtkB) : '∞';

    const colorA = sA.color || '#3b82f6';
    const colorB = sB.color || '#ef4444';

    return `<div class="timeline-track">
        <div class="timeline-bar-a" style="width:${pctA}%;background:${colorA}">
            <span class="timeline-bar-label">${lblA}</span>
        </div>
        <div class="timeline-bar-b" style="width:${pctB}%;background:${colorB}">
            <span class="timeline-bar-label">${lblB}</span>
        </div>
        <div class="timeline-midline"></div>
    </div>`;
}

// one full matchup

function buildMatchupBlock(sA, sB, result, { collapsed = false } = {}) {
    const colorA   = sA.color || '#3b82f6';
    const colorB   = sB.color || '#ef4444';
    const winnerName = result.winner === 'A' ? sA.name
                     : result.winner === 'B' ? sB.name
                     : 'Draw';
    const winnerColor = result.winner === 'A' ? colorA
                      : result.winner === 'B' ? colorB
                      : '#94a3b8';

    const subtitle = `${buildTtkString(sA.name, result.ttkA, result.projectedTtkA)}&nbsp;&nbsp;·&nbsp;&nbsp;${buildTtkString(sB.name, result.ttkB, result.projectedTtkB)}`;

    const id = `matchup_${Math.random().toString(36).slice(2)}`;

    return `
    <div class="matchup-block" id="${id}">
        <div class="matchup-header ${collapsed ? 'matchup-header--collapsed' : ''}" onclick="BattleSimDisplay._toggleMatchup('${id}')">
            <div class="matchup-header-teams">
                <span class="matchup-team-dot" style="background:${colorA}"></span>
                <span class="matchup-team-name" style="color:${colorA}">${escHtml(sA.name)}</span>
                <span class="matchup-vs">vs</span>
                <span class="matchup-team-dot" style="background:${colorB}"></span>
                <span class="matchup-team-name" style="color:${colorB}">${escHtml(sB.name)}</span>
            </div>
            <div class="matchup-header-winner">
                🏆 <span style="color:${winnerColor};font-weight:700">${escHtml(winnerName)}</span>
            </div>
            <div class="matchup-header-chevron">${collapsed ? '▶' : '▼'}</div>
        </div>

        <div class="matchup-body" style="display:${collapsed ? 'none' : 'block'}">
            <div class="result-subtitle" style="margin:8px 0 12px;">${subtitle}</div>

            <div class="timeline-label">Survival Timeline</div>
            ${buildTimelineBarHTML(sA, sB, result)}

            <div style="margin:14px 0 10px;">
                ${buildHpChart(sA, sB, result)}
            </div>

            <div style="margin-bottom:10px;">
                ${buildCompareGrid(sA, sB, result)}
            </div>

            <div class="timeline-label">Ship Analysis</div>
            ${buildTeamWeaponsSection(sA, sB)}

            <div style="margin-top:14px;">
                <div class="timeline-label">Combat Phases</div>
                <div class="phase-list">${buildPhaseList(result, sA, sB)}</div>
            </div>
        </div>
    </div>`;
}

// rankings for 3+ teams

function buildRankingPanel(teamStats, matrix, ranked, getResult) {
    const n = teamStats.length;
    let html = `<div class="timeline-label" style="margin-top:16px">1v1 Match Matrix</div>
    <div class="matrix-scroll"><table class="battle-matrix">
    <thead><tr><th></th>`;
    for (const ts of teamStats) html += `<th style="color:${ts.color}">${escHtml(ts.name)}</th>`;
    html += `</tr></thead><tbody>`;

    for (let i = 0; i < n; i++) {
        html += `<tr><td class="matrix-row-label" style="color:${teamStats[i].color}">${escHtml(teamStats[i].name)}</td>`;
        for (let j = 0; j < n; j++) {
            if (i === j) { html += `<td class="matrix-self">—</td>`; continue; }
            const r    = getResult(i, j);
            const won  = r?.winner === 'A';
            const draw = r?.winner === 'draw';
            // ttkA is always "how long team-i survived", ttkB is "how long team-j survived"
            const ttk  = won
                ? (isFinite(r.ttkB) ? fmtT(r.ttkB) : '∞')   // team-j was disabled
                : draw
                    ? '~'
                    : (isFinite(r.ttkA) ? fmtT(r.ttkA) : '∞');  // team-i was disabled
            const pairI = Math.min(i, j), pairJ = Math.max(i, j);
            html += `<td class="matrix-cell ${won ? 'matrix-win' : draw ? 'matrix-draw' : 'matrix-loss'}"
                        title="${escHtml(teamStats[i].name)} vs ${escHtml(teamStats[j].name)}"
                        onclick="document.querySelector('[data-matchup-pair=\\'${pairI}-${pairJ}\\']')?.scrollIntoView({behavior:'smooth',block:'start'});"
                        style="cursor:pointer">
                <span class="matrix-result">${won ? '✓' : draw ? '~' : '✗'}</span>
                <span class="matrix-ttk">${ttk}</span>
            </td>`;
        }
        html += `</tr>`;
    }
    html += `</tbody></table></div>`;

    html += `<div class="timeline-label" style="margin-top:18px">Rankings</div><div class="ranking-list">`;
    for (const r of ranked) {
        const pos = ranked.indexOf(r);
        html += `<div class="ranking-item">
            <span class="ranking-pos">#${pos + 1}</span>
            <span class="ranking-color-dot" style="background:${r.ts.color}"></span>
            <span class="ranking-name" style="color:${r.ts.color}">${escHtml(r.ts.name)}</span>
            <span class="ranking-wins">${r.wins}/${n - 1} wins</span>
            <span class="ranking-dps">sDPS ${fmt(r.ts.shieldDPS)} · hDPS ${fmt(r.ts.hullDPS)}</span>
            <span class="ranking-ehp">Shld ${fmt(r.ts.maxShields)} · Hull ${fmt(r.ts.maxHull)}</span>
        </div>`;
    }
    html += `</div>`;
    return html;
}

// ── entry points ──

// "How it was flown" box
function engagementHtml(result) {
    const e = result && result.engagement;
    if (!e || !e.notes || !e.notes.length) return '';
    return `<div class="phase-item" style="display:block;padding:10px 12px;margin-bottom:8px;border:1px solid var(--c-border);border-radius:8px;">
        <div style="font-weight:600;margin-bottom:4px;">✈ How it was flown</div>
        <ul style="margin:0;padding-left:18px;font-size:0.86rem;">${e.notes.map(n => `<li>${escHtml(n)}</li>`).join('')}</ul></div>`;
}

// two-team results
function renderResults2Team(payload) {
    const { teamStats, results: result } = payload;
    const sA  = teamStats[0], sB = teamStats[1];
    const resEl = document.getElementById('simResults');
    if (!resEl) return;

    const colorA     = sA.color || '#3b82f6';
    const colorB     = sB.color || '#ef4444';
    const winnerColor = result.winner === 'A' ? colorA : result.winner === 'B' ? colorB : '#94a3b8';

    document.getElementById('resultWinnerName').style.color = winnerColor;
    document.getElementById('resultWinnerName').textContent =
        result.winner === 'A' ? sA.name : result.winner === 'B' ? sB.name : 'Draw';
    document.getElementById('resultSubtitle').innerHTML =
        `${buildTtkString(sA.name, result.ttkA, result.projectedTtkA)}&nbsp;&nbsp;·&nbsp;&nbsp;${buildTtkString(sB.name, result.ttkB, result.projectedTtkB)}`;

    const effA = isFinite(result.ttkA) ? result.ttkA
        : (result.projectedTtkA != null && isFinite(result.projectedTtkA)) ? result.projectedTtkA : MAX_SIM_SECS;
    const effB = isFinite(result.ttkB) ? result.ttkB
        : (result.projectedTtkB != null && isFinite(result.projectedTtkB)) ? result.projectedTtkB : MAX_SIM_SECS;
    const maxT = Math.max(effA, effB, 1);

    const barA = document.getElementById('timelineBarA');
    const barB = document.getElementById('timelineBarB');
    if (barA) { barA.style.width = Math.round(Math.min((effA / maxT) * 50, 50)) + '%'; barA.style.background = colorA; }
    if (barB) { barB.style.width = Math.round(Math.min((effB / maxT) * 50, 50)) + '%'; barB.style.background = colorB; }

    const lblA = document.getElementById('timelineLabelA');
    const lblB = document.getElementById('timelineLabelB');
    if (lblA) lblA.textContent = isFinite(result.ttkA) ? fmtT(result.ttkA)
        : (result.projectedTtkA != null && isFinite(result.projectedTtkA)) ? '~' + fmtT(result.projectedTtkA) : '∞';
    if (lblB) lblB.textContent = isFinite(result.ttkB) ? fmtT(result.ttkB)
        : (result.projectedTtkB != null && isFinite(result.projectedTtkB)) ? '~' + fmtT(result.projectedTtkB) : '∞';

    const chartEl = document.getElementById('hpChartContainer');
    if (chartEl) chartEl.innerHTML = buildHpChart(sA, sB, result);

    const compareEl = document.getElementById('compareGrid');
    if (compareEl) compareEl.innerHTML = buildCompareGrid(sA, sB, result);

    // weapons, per ship
    const weaponsEl = document.getElementById('weaponsGrid');
    if (weaponsEl) weaponsEl.innerHTML =
        `<div>
            <div class="weapons-col-title" style="color:${colorA}">${escHtml(sA.name)}</div>
            ${buildShipAccordion(sA, colorA)}
        </div>
        <div>
            <div class="weapons-col-title" style="color:${colorB}">${escHtml(sB.name)}</div>
            ${buildShipAccordion(sB, colorB)}
        </div>`;

    const phaseEl = document.getElementById('phaseList');
    if (phaseEl) phaseEl.innerHTML = engagementHtml(result) + buildPhaseList(result, sA, sB);

    const matEl = document.getElementById('matrixSection');
    if (matEl) { matEl.style.display = 'none'; matEl.innerHTML = ''; }
    document.getElementById('timelineSection').style.display = '';
    document.getElementById('weaponsSection').style.display  = '';

    resEl.style.display = 'block';
    resEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
    
// 3+ team results
function renderResultsNTeam(payload) {
    const { teamStats, results: matrix } = payload;
    const n     = teamStats.length;
    const resEl = document.getElementById('simResults');
    if (!resEl) return;

    // teamA vs teamB result ('A' = teamA won)
    function getResult(iA, iB) {
        if (iA < iB) {
            return matrix[iA][iB];  // canonical: A=iA, B=iB
        } else {
            const r = matrix[iB][iA];  // canonical: A=iB, B=iA — flip
            if (!r) return null;
            return {
                ...r,
                winner: r.winner === 'A' ? 'B' : r.winner === 'B' ? 'A' : 'draw',
                // swap ttk values so they correspond to iA and iB respectively
                ttkA: r.ttkB, ttkB: r.ttkA,
                projectedTtkA: r.projectedTtkB, projectedTtkB: r.projectedTtkA,
                timelineA: r.timelineB, timelineB: r.timelineA,
                finalStateA: r.finalStateB, finalStateB: r.finalStateA,
            };
        }
    }

    // Count wins correctly
    const wins = teamStats.map(() => 0);
    for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
            if (i !== j && getResult(i, j)?.winner === 'A') wins[i]++;

    const ranked = teamStats.map((ts, i) => ({ ts, wins: wins[i], idx: i }))
        .sort((a, b) => b.wins - a.wins);

    const top = ranked[0];
    const winnerNameEl = document.getElementById('resultWinnerName');
    const subtitleEl   = document.getElementById('resultSubtitle');
    if (winnerNameEl) {
        winnerNameEl.className   = 'result-winner-name';
        winnerNameEl.style.color = top.ts.color;
        winnerNameEl.textContent = top.ts.name;
    }
    if (subtitleEl)
        subtitleEl.innerHTML = ranked.map((r, pos) =>
            `<span style="color:${r.ts.color};font-weight:${pos === 0 ? 'bold' : 'normal'}">` +
            `${pos + 1}. ${escHtml(r.ts.name)} — ${r.wins}/${n - 1} wins</span>`
        ).join('&nbsp;&nbsp;·&nbsp;&nbsp;');

    const matEl = document.getElementById('matrixSection');
    if (matEl) {
        let html = buildRankingPanel(teamStats, matrix, ranked, getResult);
        html += `<div class="timeline-label" style="margin-top:24px">All Matchups — Full Detail</div>`;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const sA = teamStats[i], sB = teamStats[j];
                const r  = getResult(i, j);
                const blockHtml = buildMatchupBlock(sA, sB, r, { collapsed: true })
                    .replace(`<div class="matchup-block"`, `<div class="matchup-block" data-matchup-pair="${i}-${j}"`);
                html += blockHtml;
            }
        }
        matEl.innerHTML = html;
        matEl.style.display = '';
    }

    document.getElementById('timelineSection').style.display = 'none';
    document.getElementById('hpChartContainer').innerHTML    = '';
    document.getElementById('compareGrid').innerHTML         = '';
    document.getElementById('weaponsGrid').innerHTML         = '';
    document.getElementById('weaponsSection').style.display  = 'none';

    const allPhases = [];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const r = matrix[i][j];
            for (const ph of (r.phases || [])) {
                allPhases.push({
                    ...ph,
                    matchup: `${teamStats[i].name} vs ${teamStats[j].name}`,
                    color: ph.type === 'A' ? teamStats[i].color
                         : ph.type === 'B' ? teamStats[j].color
                         : '#94a3b8',
                });
            }
        }
    }
    allPhases.sort((a, b) => a.time - b.time);

    const phaseEl = document.getElementById('phaseList');
    if (phaseEl) {
        phaseEl.innerHTML = allPhases.length
            ? allPhases.slice(0, 60).map(ph =>
                `<div class="phase-item" style="border-left-color:${ph.color}">
                    <span class="phase-icon">${ph.icon}</span>
                    <span class="phase-time">${fmtT(ph.time)}</span>
                    <span class="phase-text">
                        <em style="font-size:0.8em;color:#64748b">[${escHtml(ph.matchup)}]</em> ${ph.text}
                    </span>
                </div>`
              ).join('')
            : '<div class="phase-item phase-neutral">No notable events.</div>';
    }

    resEl.style.display = 'block';
    resEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// open/close a matchup

function _toggleMatchup(blockId) {
    const block  = document.getElementById(blockId);
    if (!block) return;
    const header = block.querySelector('.matchup-header');
    const body   = block.querySelector('.matchup-body');
    const chev   = block.querySelector('.matchup-header-chevron');
    if (!body) return;
    const isCollapsed = body.style.display === 'none';
    body.style.display = isCollapsed ? 'block' : 'none';
    if (header) header.classList.toggle('matchup-header--collapsed', !isCollapsed);
    if (chev)   chev.textContent = isCollapsed ? '▼' : '▶';
}

// open/close a ship panel
function _toggleShipPanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const body  = panel.querySelector('.ship-accordion-body');
    const chev  = panel.querySelector('.ship-accordion-chevron');
    if (!body) return;
    const isCollapsed = body.style.display === 'none';
    body.style.display = isCollapsed ? 'block' : 'none';
    if (chev) chev.textContent = isCollapsed ? '▼' : '▶';
    panel.classList.toggle('ship-accordion--open', isCollapsed);
}

// show the results. Called by: battleSim.runSimulation

function renderResults(payload) {
    _damageTypes = payload.damageTypes || _damageTypes;
    _outfitIndex = payload.outfitIndex || _outfitIndex;
    _attrDefs    = payload.attrDefs    || _attrDefs;

    if (payload.mode === '2team') {
        renderResults2Team(payload);
    } else {
        renderResultsNTeam(payload);
    }
}

// the progress window

function _ensureProgressModal() {
    if (document.getElementById('simProgressOverlay')) return;
    const el = document.createElement('div');
    el.id = 'simProgressOverlay';
    el.style.cssText = `
        display:none; position:fixed; inset:0;
        background:rgba(0,0,0,0.75); backdrop-filter:blur(4px);
        z-index:2000; align-items:center; justify-content:center;
    `;
    el.innerHTML = `
        <div style="
            background:var(--c-surface,#1e293b);
            border:1px solid rgba(59,130,246,0.4);
            border-radius:14px;
            padding:28px 32px;
            width:min(440px,90vw);
            box-shadow:0 20px 60px rgba(0,0,0,0.6);
        ">
            <div style="font-size:1rem;font-weight:700;color:#93c5fd;margin-bottom:20px;letter-spacing:0.03em;">
                ⚔ Simulating Battle…
            </div>

            <div style="margin-bottom:16px;">
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
                    <span style="font-size:0.72rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#64748b;">Overall Progress</span>
                    <span id="simProgressOverallPct" style="font-size:0.72rem;font-weight:700;color:#64748b;font-variant-numeric:tabular-nums;">0%</span>
                </div>
                <div style="background:rgba(15,23,42,0.7);border:1px solid rgba(59,130,246,0.2);border-radius:8px;height:12px;overflow:hidden;">
                    <div id="simProgressOverallBar" style="
                        height:100%;width:0%;
                        background:linear-gradient(90deg,#3b82f6,#7c3aed);
                        border-radius:8px;
                        transition:width 0.25s ease;
                    "></div>
                </div>
                <div id="simProgressOverallLabel" style="font-size:0.78rem;color:#94a3b8;margin-top:6px;min-height:1.2em;"></div>
            </div>

            <div style="margin-bottom:20px;">
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
                    <span style="font-size:0.72rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#64748b;">Current Fight</span>
                    <span id="simProgressFightPct" style="font-size:0.72rem;font-weight:700;color:#64748b;font-variant-numeric:tabular-nums;">0%</span>
                </div>
                <div style="background:rgba(15,23,42,0.7);border:1px solid rgba(59,130,246,0.2);border-radius:8px;height:12px;overflow:hidden;">
                    <div id="simProgressFightBar" style="
                        height:100%;width:0%;
                        background:linear-gradient(90deg,#22c55e,#0ea5e9);
                        border-radius:8px;
                        transition:width 0.2s ease;
                    "></div>
                </div>
                <div id="simProgressFightLabel" style="font-size:0.78rem;color:#94a3b8;margin-top:6px;min-height:1.2em;"></div>
            </div>

            <div style="text-align:center;">
                <button id="simCancelBtn" style="
                    background:rgba(239,68,68,0.15);
                    border:1px solid rgba(239,68,68,0.35);
                    border-radius:8px;
                    color:#fca5a5;
                    font-size:0.85rem;
                    font-weight:600;
                    padding:8px 24px;
                    cursor:pointer;
                    transition:background 0.15s, border-color 0.15s;
                " onmouseover="this.style.background='rgba(239,68,68,0.28)';this.style.borderColor='rgba(239,68,68,0.6)'"
                   onmouseout="this.style.background='rgba(239,68,68,0.15)';this.style.borderColor='rgba(239,68,68,0.35)'">
                    ✕ Cancel
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(el);
}

// show the progress window. Called by: battleSim.runSimulation
function showProgressModal(onCancel) {
    _ensureProgressModal();
    const el  = document.getElementById('simProgressOverlay');
    const btn = document.getElementById('simCancelBtn');
    if (el) el.style.display = 'flex';
    if (btn) {
        // re-wire Cancel each time
        btn.onclick = () => {
            if (typeof onCancel === 'function') onCancel();
            // Visual feedback — dim the button so the user knows it registered
            btn.textContent    = '⏳ Cancelling…';
            btn.style.opacity  = '0.5';
            btn.style.cursor   = 'not-allowed';
            btn.onclick        = null;
        };
        btn.textContent   = '✕ Cancel';
        btn.style.opacity = '1';
        btn.style.cursor  = 'pointer';
    }
    updateProgressModal(0, 'Preparing simulation…', 0, '');
}
    
// hide it
function hideProgressModal() {
    const el = document.getElementById('simProgressOverlay');
    if (el) el.style.display = 'none';
}

// move its bar
function updateProgressModal(overallPct, overallLabel, fightPct, fightLabel) {
    const ob = document.getElementById('simProgressOverallBar');
    const op = document.getElementById('simProgressOverallPct');
    const ol = document.getElementById('simProgressOverallLabel');
    const fb = document.getElementById('simProgressFightBar');
    const fp = document.getElementById('simProgressFightPct');
    const fl = document.getElementById('simProgressFightLabel');
    const clamp = v => Math.max(0, Math.min(100, Math.round(v)));
    const oPct = clamp(overallPct);
    const fPct = clamp(fightPct);
    if (ob) ob.style.width = oPct + '%';
    if (op) op.textContent = oPct + '%';
    if (ol) ol.textContent = overallLabel || '';
    if (fb) fb.style.width = fPct + '%';
    if (fp) fp.textContent = fPct + '%';
    if (fl) fl.textContent = fightLabel || '';
}

// ── window.BattleSimStatsDisplay ──

window.BattleSimDisplay = {
    renderResults,
    fmt,
    fmtT,
    fmtTTK,
    fmtPct,
    fmtNet,
    escHtml,
    buildTtkString,
    _toggleMatchup,
    _toggleShipPanel,
    renderResults,
    showProgressModal,
    hideProgressModal,
    updateProgressModal,
};

})();
