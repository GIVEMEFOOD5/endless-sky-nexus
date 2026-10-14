'use strict';

// ═══════════════════════════════════════════════════════════
//  mapDisplay.js  —  Endless Sky Ship Builder / Systems Map
//
//  STAGE 4 of the map pipeline: DISPLAY IT INTELLIGENTLY.
//  Owns the canvas, draws systems/links/labels at a level of detail
//  chosen by mapCalculations.js, wires up mouse AND touch input
//  (pan, pinch-zoom, tap, hover), renders the legend/search/tooltip
//  UI, and shows loading progress while mapDataLoader.js fetches
//  (potentially large) per-plugin map files.
//
//  Dependencies (must be loaded before this file):
//    mapDataLoader.js      — window.MapDataLoader
//    mapDataFormatter.js   — window.MapDataFormatter
//    mapCalculations.js    — window.MapCalculations
//    generalPluginStuff.js — window.PluginManager  (which plugins are active)
//    dataLoader.js         — window.DataLoader     (populates window.allData
//                             so the shared plugin picker has something to list)
//    Animator.js, ImageGrabber.js — window.fetchSprite / initImageIndex /
//                             setCurrentPlugin, for planet & star art. Optional
//                             in the sense that this file checks `typeof` before
//                             calling them, so the map still works without images
//                             if they're ever left out — it just won't have art.
//
//  INTEGRATION WITH GeneralPluginStuff
//  ------------------------------------
//  generalPluginStuff.js owns "which plugins are active" sitewide and
//  calls `window._renderCardsFromManager(resetTab)` every time that
//  selection changes (plugin added/removed/reordered, or on first
//  load). This file defines that hook: on every call, it asks
//  PluginManager for the current active list, downloads/merges just
//  those plugins' map data, and redraws. No other page logic needs
//  to know the map exists.
//
//  JOB BOARD TOGGLE
//  -----------------
//  A checkbox (#mapJobBoardToggle, in Systems.html) controls whether
//  job-related mission markers/badges show at all. Story (non-job)
//  missions with a concrete source always show — they aren't part of
//  what's being toggled. See mapCalculations.js's buildMissionIndex()
//  for how "where could a job start" is computed, including its
//  documented approximation for generic (filter-based) job-board
//  templates.
// ═══════════════════════════════════════════════════════════

(function () {

const { MapDataLoader, MapDataFormatter, MapCalculations } = window;

// ── DOM refs (grabbed lazily — Systems.html defines these ids) ──
let canvas, ctx, wrap;
let searchInput, resultsEl, legendListEl, tooltipEl, subtitleEl, loadingEl, loadingBarEl, jobBoardToggleEl, detailsPanelEl;

let dpr = Math.min(window.devicePixelRatio || 1, 2);

/**
 * Escapes text before it goes into an innerHTML template. Everything
 * rendered by this file — system/planet/mission names, governments,
 * plugin ids — ultimately comes from plugin data, which can contain
 * anything, including Endless Sky's own templating placeholders like
 * "<planet>" in an unresolved mission name. Without escaping, the
 * browser reads that as an actual (unknown) HTML tag and silently
 * drops it, which is exactly the kind of "why did half this mission
 * name disappear" bug that's easy to miss without real data — this
 * showed up in testing with the real missions.json and is why every
 * interpolation site in this file uses this.
 */
function _esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// ── Map state (rebuilt every time the active plugin set changes) ──
let systemsByName = new Map();  // FormattedSystem, keyed by name
let systemsArr = [];            // same data, as an array (perf: avoid Map iteration in hot paths)
let galaxies = [];
let linkSegments = [];
let govPalette = { names: [], counts: {}, colors: {} };
const activeGovFilters = new Set(); // governments currently hidden by the legend

let missionIndex = { concreteBySystem: new Map(), genericJobMatchCount: new Map(), stats: {} };
let jobBoardOn = true; // controlled by the Job Board toggle in the UI
let starTable = MapCalculations.buildStarTable(new Map()); // baseline until plugin stars.json data arrives

let cam = MapCalculations.createCamera();
let hovered = null;
let selected = null;
let selectedPlanet = null; // planet name, scoped to `selected` — cleared whenever the system selection changes
let hasFitCamera = false;

// ═══════════════════════════════════════════════════════════
//  Bootstrapping
// ═══════════════════════════════════════════════════════════

function _grabDom() {
    canvas = document.getElementById('mapCanvas');
    ctx = canvas.getContext('2d');
    wrap = document.getElementById('mapWrap');
    searchInput = document.getElementById('mapSearchInput');
    resultsEl = document.getElementById('mapSearchResults');
    legendListEl = document.getElementById('mapLegendList');
    tooltipEl = document.getElementById('mapTooltip');
    subtitleEl = document.getElementById('mapSubtitle');
    loadingEl = document.getElementById('mapLoading');
    loadingBarEl = document.getElementById('mapLoadingBar');
    jobBoardToggleEl = document.getElementById('mapJobBoardToggle');
    detailsPanelEl = document.getElementById('mapDetailsPanel');
}

function _wireJobBoardToggle() {
    if (!jobBoardToggleEl) return;
    jobBoardToggleEl.checked = jobBoardOn;
    jobBoardToggleEl.addEventListener('change', () => {
        jobBoardOn = jobBoardToggleEl.checked;
        _renderDetailsPanel();
        _draw();
    });
}

function init() {
    _grabDom();
    _wireCanvasInput();
    _wireSearch();
    _wireControls();
    _wireLoadProgress();
    _wireJobBoardToggle();
    _wireDetailsPanel();
    window.addEventListener('resize', _resizeCanvas);
    _resizeCanvas();

    if (!window.DataLoader) {
        _showError('dataLoader.js must be loaded before mapDisplay.js');
        return;
    }
    // Ships/outfits are irrelevant to the map, but DataLoader populates
    // window.allData with plugin metadata, which is what the shared
    // plugin picker (PluginManager) reads to build its list.
    window.DataLoader.onReady(() => {
        window.PluginManager.initDefaultPlugin();
        if (typeof initImageIndex === 'function') initImageIndex(); // for planet/star art
    });
    window.DataLoader.load().catch(err => _showError(err.message));

    document.addEventListener('dataLoadError', e => {
        _showError(`Could not load plugin list: ${e.detail?.message || 'unknown error'}`);
    });
}

// This is the hook generalPluginStuff.js calls on every plugin-selection change.
window._renderCardsFromManager = async function (resetView) {
    const active = window.PluginManager.getActivePlugins()
        .filter(id => id !== window.PluginManager.LOCAL_PLUGIN_ID); // no ship builds on a starmap
    if (active.length === 0) {
        _showError('No plugins selected — pick at least one from "Select Plugins".');
        return;
    }
    await _loadAndRender(active, resetView);
};

async function _loadAndRender(activeOutputNames, resetView) {
    _setLoading(true, activeOutputNames.length);
    try {
        if (typeof setCurrentPlugin === 'function') setCurrentPlugin(activeOutputNames[0]);

        const pluginDataMap = await MapDataLoader.loadPlugins(activeOutputNames);
        // The selected save's story changes (mapSaveState.js) — loaded before
        // formatting so the synchronous apply() below has what it needs.
        const saveState = window.MapSaveState || null;
        if (saveState) await saveState.prepare(activeOutputNames);

        systemsByName = MapDataFormatter.formatSystems(pluginDataMap, activeOutputNames);
        const wormholeLinks = MapDataFormatter.formatWormholes(pluginDataMap);
        MapDataFormatter.applyWormholeFlags(systemsByName, wormholeLinks);
        const planetsBySystem = MapDataFormatter.formatPlanets(pluginDataMap, activeOutputNames);
        MapDataFormatter.attachPlanets(systemsByName, planetsBySystem);
        galaxies = MapDataFormatter.formatGalaxies(pluginDataMap).filter(g => !g.isLabel);

        const fetchedStars = MapDataFormatter.formatStars(pluginDataMap, activeOutputNames);
        starTable = MapCalculations.buildStarTable(fetchedStars);

        const governmentColors = MapDataFormatter.formatGovernments(pluginDataMap, activeOutputNames);
        if (saveState) saveState.apply({ systemsByName, planetsBySystem, governmentColors, pluginDataMap, activeOutputNames });

        systemsArr = [...systemsByName.values()];
        linkSegments = MapCalculations.buildLinkSegments(systemsByName);
        {   // a short health report, to spot missing lanes
            let linkNames = 0, dangling = 0;
            for (const s of systemsByName.values()) for (const l of s.links) { linkNames++; if (!systemsByName.has(l)) dangling++; }
            console.info(`[Map] ${systemsByName.size} systems, ${linkSegments.length} lanes drawn (${linkNames} link entries, ${dangling} pointing at systems not loaded)`);
        }
        govPalette = MapCalculations.buildGovernmentPalette(systemsArr, governmentColors);

        let missions = MapDataFormatter.formatMissions(pluginDataMap, activeOutputNames, planetsBySystem);
        if (saveState) missions = saveState.filterMissions(missions, pluginDataMap, activeOutputNames);
        missionIndex = MapCalculations.buildMissionIndex(missions, systemsArr);

        activeGovFilters.clear();
        govPalette.names.forEach(g => activeGovFilters.add(g));

        _renderLegend();
        _updateSubtitle(activeOutputNames);

        if (resetView || !hasFitCamera) {
            cam = MapCalculations.fitToSystems(systemsArr, canvas.clientWidth, canvas.clientHeight);
            hasFitCamera = true;
            selected = null;
            selectedPlanet = null;
        } else if (selected) {
            // A plugin toggle may have re-shaped or removed the previously
            // selected system — re-point at the fresh object, or clear the
            // selection (and the details panel with it) if it's gone.
            const fresh = systemsByName.get(selected.name) || null;
            selected = fresh;
            if (!fresh || !fresh.planets.some(p => p.name === selectedPlanet)) selectedPlanet = null;
        }
        _renderDetailsPanel();
        _draw();
    } catch (err) {
        console.error('[mapDisplay] render failed:', err);
        _showError(err.message);
    } finally {
        _setLoading(false);
    }
}

// ═══════════════════════════════════════════════════════════
//  Loading UI (these files can be large — show real progress)
// ═══════════════════════════════════════════════════════════

function _wireLoadProgress() {
    document.addEventListener('mapPluginLoaded', e => {
        const { index, total } = e.detail;
        if (loadingBarEl) loadingBarEl.style.width = `${Math.round(((index + 1) / total) * 100)}%`;
    });
}

function _setLoading(isLoading, total) {
    if (!loadingEl) return;
    loadingEl.style.display = isLoading ? 'flex' : 'none';
    if (isLoading && loadingBarEl) loadingBarEl.style.width = '4%';
}

function _showError(message) {
    if (subtitleEl) subtitleEl.textContent = `⚠ ${message}`;
}

function _updateSubtitle(activeOutputNames) {
    if (!subtitleEl) return;
    subtitleEl.textContent =
        `${systemsArr.length} systems · ${govPalette.names.length} governments · ` +
        `${missionIndex.stats.total || 0} missions (${missionIndex.stats.concreteJobs || 0} fixed jobs, ` +
        `${missionIndex.stats.genericJobTemplates || 0} generic job templates) · ` +
        `${activeOutputNames.length} plugin${activeOutputNames.length === 1 ? '' : 's'} active` +
        (window.MapSaveState ? window.MapSaveState.subtitleSuffix() : '');
}

// ═══════════════════════════════════════════════════════════
//  Legend
// ═══════════════════════════════════════════════════════════

function _renderLegend() {
    if (!legendListEl) return;
    legendListEl.innerHTML = '';
    govPalette.names.forEach(g => {
        const row = document.createElement('div');
        row.className = 'map-legend-row';
        row.innerHTML = `
            <span class="map-legend-dot" style="background:${govPalette.colors[g]}"></span>
            <span class="map-legend-name">${_esc(g)}</span>
            <span class="map-legend-count">${govPalette.counts[g]}</span>
        `;
        row.addEventListener('click', () => {
            if (activeGovFilters.has(g)) { activeGovFilters.delete(g); row.classList.add('off'); }
            else { activeGovFilters.add(g); row.classList.remove('off'); }
            _draw();
        });
        legendListEl.appendChild(row);
    });
}

// ═══════════════════════════════════════════════════════════
//  Canvas sizing
// ═══════════════════════════════════════════════════════════

function _resizeCanvas() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    _draw();
}

// ═══════════════════════════════════════════════════════════
//  Drawing
// ═══════════════════════════════════════════════════════════

function _visibleSet() {
    return systemsArr.filter(s => activeGovFilters.has(s.government));
}

function _draw() {
    if (!ctx) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Cheap deterministic starfield — no allocations, no Math.random per frame.
    ctx.fillStyle = '#0d1220';
    for (let i = 0; i < 140; i++) {
        const sx = (i * 197) % w, sy = (i * 271) % h;
        ctx.globalAlpha = 0.22 + (i % 5) * 0.07;
        ctx.fillRect(sx, sy, 1, 1);
    }
    ctx.globalAlpha = 1;

    const visible = _visibleSet();
    const visibleNames = new Set(visible.map(s => s.name));
    const { nodeRadius, linkWidth, showAllLabels } = MapCalculations.lod(cam);

    // Links
    ctx.lineWidth = linkWidth;
    ctx.strokeStyle = 'rgba(60,78,110,0.45)';
    ctx.beginPath();
    for (const seg of linkSegments) {
        if (!visibleNames.has(seg.a.name) || !visibleNames.has(seg.b.name)) continue;
        const p1 = MapCalculations.worldToScreen(cam, seg.a.x, seg.a.y, w, h);
        const p2 = MapCalculations.worldToScreen(cam, seg.b.x, seg.b.y, w, h);
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();

    // Nodes
    for (const s of visible) {
        const p = MapCalculations.worldToScreen(cam, s.x, s.y, w, h);
        if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) continue;
        ctx.beginPath();
        ctx.fillStyle = govPalette.colors[s.government] || '#888';
        ctx.arc(p.x, p.y, s.wormhole ? nodeRadius * 1.3 : nodeRadius, 0, Math.PI * 2);
        ctx.fill();
        if (s.wormhole) {
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(180,140,255,0.85)';
            ctx.lineWidth = 1;
            ctx.arc(p.x, p.y, nodeRadius * 1.3 + 2, 0, Math.PI * 2);
            ctx.stroke();
        }
        _drawMissionMarkers(p, s, nodeRadius);
    }

    // Hovered / selected highlight rings + always-on labels
    [selected, hovered].forEach((s, idx) => {
        if (!s || !visibleNames.has(s.name)) return;
        const p = MapCalculations.worldToScreen(cam, s.x, s.y, w, h);
        ctx.beginPath();
        ctx.strokeStyle = idx === 0 ? '#ffffff' : '#5ee1c9';
        ctx.lineWidth = 1.5;
        ctx.arc(p.x, p.y, nodeRadius + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = '#e8edf7';
        ctx.fillText(s.name, p.x + nodeRadius + 7, p.y + 4);
    });

    // At high zoom, label everything visible (intelligent LOD — avoids
    // an unreadable wall of text when zoomed out to the whole galaxy).
    if (showAllLabels) {
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(200,210,230,0.75)';
        for (const s of visible) {
            if (s === selected || s === hovered) continue;
            const p = MapCalculations.worldToScreen(cam, s.x, s.y, w, h);
            if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) continue;
            ctx.fillText(s.name, p.x + nodeRadius + 5, p.y + 3);
        }
    }
}

/**
 * Draws small overlay glyphs on top of a system's government dot for
 * mission activity there:
 *   - a small white flag  — one or more STORY missions start here
 *     (always shown; not gated by the Job Board toggle)
 *   - a small gold diamond — job-board work is available here, either
 *     a fixed job or a matching generic job template (only shown when
 *     jobBoardOn — this is exactly the thing the toggle controls)
 * Both are tiny and offset from the dot so they read as a badge, not
 * a second system.
 */
function _drawMissionMarkers(p, s, nodeRadius) {
    const bucket = missionIndex.concreteBySystem.get(s.name);
    const storyCount = bucket ? bucket.story.length : 0;
    const jobCount = jobBoardOn
        ? (bucket ? bucket.jobs.length : 0) + (missionIndex.genericJobMatchCount.get(s.name) || 0)
        : 0;

    if (storyCount > 0) {
        const fx = p.x - nodeRadius - 3, fy = p.y - nodeRadius - 3;
        ctx.beginPath();
        ctx.moveTo(fx, fy - 5);
        ctx.lineTo(fx, fy + 4);
        ctx.moveTo(fx, fy - 5);
        ctx.lineTo(fx + 5, fy - 3);
        ctx.lineTo(fx, fy - 1);
        ctx.strokeStyle = '#e8edf7';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    if (jobCount > 0) {
        const dx = p.x + nodeRadius + 4, dy = p.y - nodeRadius - 4;
        const r = 3.2;
        ctx.beginPath();
        ctx.moveTo(dx, dy - r);
        ctx.lineTo(dx + r, dy);
        ctx.lineTo(dx, dy + r);
        ctx.lineTo(dx - r, dy);
        ctx.closePath();
        ctx.fillStyle = '#ffd166';
        ctx.fill();
    }
}

// ═══════════════════════════════════════════════════════════
//  Input — mouse (desktop) + touch (mobile), same camera ops
// ═══════════════════════════════════════════════════════════

function _wireCanvasInput() {
    let dragging = false, moved = false, lastX = 0, lastY = 0;

    canvas.addEventListener('mousedown', e => {
        dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY;
        canvas.classList.add('grabbing');
    });
    window.addEventListener('mouseup', () => { dragging = false; canvas.classList.remove('grabbing'); });
    window.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        if (dragging) {
            const dx = e.clientX - lastX, dy = e.clientY - lastY;
            if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
            cam.x -= dx / cam.scale;
            cam.y -= dy / cam.scale;
            lastX = e.clientX; lastY = e.clientY;
            _draw();
            _hideTooltip();
            return;
        }
        _updateHover(sx, sy, e.clientX, e.clientY);
    });
    canvas.addEventListener('click', () => {
        if (moved) return;
        if (hovered) _selectSystem(hovered);
    });
    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        cam = MapCalculations.zoomAt(cam, factor, sx, sy, canvas.clientWidth, canvas.clientHeight);
        _draw();
    }, { passive: false });

    // ── Touch: one finger pans, two fingers pinch-zoom, a tap selects ──
    let touchMode = null; // 'pan' | 'pinch'
    let touchLastX = 0, touchLastY = 0, touchMoved = false;
    let pinchStartDist = 0, pinchStartScale = 1, pinchMidX = 0, pinchMidY = 0;

    function _dist(t0, t1) {
        return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    }
    function _mid(t0, t1, rect) {
        return { x: (t0.clientX + t1.clientX) / 2 - rect.left, y: (t0.clientY + t1.clientY) / 2 - rect.top };
    }

    canvas.addEventListener('touchstart', e => {
        const rect = canvas.getBoundingClientRect();
        if (e.touches.length === 1) {
            touchMode = 'pan'; touchMoved = false;
            touchLastX = e.touches[0].clientX; touchLastY = e.touches[0].clientY;
        } else if (e.touches.length === 2) {
            touchMode = 'pinch';
            pinchStartDist = _dist(e.touches[0], e.touches[1]);
            pinchStartScale = cam.scale;
            const mid = _mid(e.touches[0], e.touches[1], rect);
            pinchMidX = mid.x; pinchMidY = mid.y;
        }
    }, { passive: true });

    canvas.addEventListener('touchmove', e => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        if (touchMode === 'pan' && e.touches.length === 1) {
            const dx = e.touches[0].clientX - touchLastX, dy = e.touches[0].clientY - touchLastY;
            if (Math.abs(dx) + Math.abs(dy) > 3) touchMoved = true;
            cam.x -= dx / cam.scale;
            cam.y -= dy / cam.scale;
            touchLastX = e.touches[0].clientX; touchLastY = e.touches[0].clientY;
            _draw();
        } else if (touchMode === 'pinch' && e.touches.length === 2) {
            const dist = _dist(e.touches[0], e.touches[1]);
            const factor = (dist / (pinchStartDist || dist)) * pinchStartScale / cam.scale;
            cam = MapCalculations.zoomAt(cam, factor, pinchMidX, pinchMidY, canvas.clientWidth, canvas.clientHeight);
            _draw();
        }
    }, { passive: false });

    canvas.addEventListener('touchend', e => {
        if (touchMode === 'pan' && !touchMoved && e.changedTouches.length === 1) {
            const rect = canvas.getBoundingClientRect();
            const sx = e.changedTouches[0].clientX - rect.left, sy = e.changedTouches[0].clientY - rect.top;
            const world = MapCalculations.screenToWorld(cam, sx, sy, canvas.clientWidth, canvas.clientHeight);
            const thresh = (MapCalculations.lod(cam).nodeRadius + 10) / cam.scale;
            const nearest = MapCalculations.findNearest(_visibleSet(), world.x, world.y, thresh);
            if (nearest) {
                _selectSystem(nearest);
                _showTooltip(nearest, e.changedTouches[0].clientX, e.changedTouches[0].clientY);
            }
        }
        touchMode = null;
    });
}

function _updateHover(sx, sy, clientX, clientY) {
    const world = MapCalculations.screenToWorld(cam, sx, sy, canvas.clientWidth, canvas.clientHeight);
    const thresh = (MapCalculations.lod(cam).nodeRadius + 6) / cam.scale;
    const nearest = MapCalculations.findNearest(_visibleSet(), world.x, world.y, thresh);
    if (nearest !== hovered) { hovered = nearest; _draw(); }
    if (nearest) _showTooltip(nearest, clientX, clientY);
    else _hideTooltip();
}

// ═══════════════════════════════════════════════════════════
//  Tooltip
// ═══════════════════════════════════════════════════════════

function _showTooltip(s, clientX, clientY) {
    if (!tooltipEl) return;
    const links = s.links.length ? s.links.map(_esc).slice(0, 6).join(', ') + (s.links.length > 6 ? '…' : '') : '—';
    tooltipEl.innerHTML = `
        <b>${_esc(s.name)}</b><br>
        <span class="map-tooltip-gov">${_esc(s.government)}</span>
        ${s.wormhole ? '<span class="map-tooltip-badge">wormhole</span>' : ''}
        <div class="map-tooltip-links">links: ${links}</div>
        ${_planetsHtml(s.planets)}
        ${_missionsHtml(s)}
        <div class="map-tooltip-source">from: ${s.definedBy.map(_esc).join(', ')}</div>
    `;
    tooltipEl.style.display = 'block';
    const wrapRect = wrap.getBoundingClientRect();
    tooltipEl.style.left = Math.min(clientX - wrapRect.left + 14, wrapRect.width - 250) + 'px';
    tooltipEl.style.top = (clientY - wrapRect.top + 14) + 'px';
}

/**
 * Mission section of the tooltip: names every concrete (fixed-planet)
 * mission that starts here, split into story vs job-board, plus — only
 * while the Job Board toggle is on — how many generic job templates
 * could also spawn here (an approximation; see mapCalculations.js's
 * evaluateMissionFilter doc comment for exactly what that does and
 * doesn't check).
 */
function _missionsHtml(s) {
    const bucket = missionIndex.concreteBySystem.get(s.name);
    const genericCount = missionIndex.genericJobMatchCount.get(s.name) || 0;
    const hasStory = bucket && bucket.story.length > 0;
    const hasJobs = bucket && bucket.jobs.length > 0;
    if (!hasStory && !hasJobs && !(jobBoardOn && genericCount > 0)) return '';

    const rows = [];
    if (hasStory) {
        const names = bucket.story.slice(0, 4).map(m => _esc(m.displayName)).join(', ');
        const more = bucket.story.length > 4 ? ` +${bucket.story.length - 4} more` : '';
        rows.push(`<div class="map-tooltip-mission">🚩 ${names}${more}</div>`);
    }
    if (jobBoardOn && hasJobs) {
        const names = bucket.jobs.slice(0, 4).map(m => _esc(m.displayName)).join(', ');
        const more = bucket.jobs.length > 4 ? ` +${bucket.jobs.length - 4} more` : '';
        rows.push(`<div class="map-tooltip-mission">🧾 ${names}${more}</div>`);
    }
    if (jobBoardOn && genericCount > 0) {
        rows.push(`<div class="map-tooltip-mission-approx">🧾 ~${genericCount} generic job template${genericCount === 1 ? '' : 's'} could also appear here (approx.)</div>`);
    }
    return `<div class="map-tooltip-missions">${rows.join('')}</div>`;
}

/**
 * Renders the planets.json data actually attached to this system:
 * each planet's own government (which can differ from the system's —
 * e.g. a pirate-held world in an otherwise Republic system) plus
 * small badges for shipyard/outfitter/spaceport access.
 */
function _planetsHtml(planets) {
    if (!planets || planets.length === 0) return '';
    const rows = planets.slice(0, 6).map(p => {
        const badges = [
            p.hasSpaceport ? 'port' : null,
            p.hasShipyard ? 'shipyard' : null,
            p.hasOutfitter ? 'outfitter' : null,
        ].filter(Boolean).join(' · ');
        const govNote = p.government ? ` <span class="map-tooltip-planet-gov">(${_esc(p.government)})</span>` : '';
        return `<div class="map-tooltip-planet">• ${_esc(p.name)}${govNote}${badges ? ` — ${badges}` : ''}</div>`;
    }).join('');
    const more = planets.length > 6 ? `<div class="map-tooltip-planet">…and ${planets.length - 6} more</div>` : '';
    return `<div class="map-tooltip-planets">${rows}${more}</div>`;
}

function _hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════
//  Details panel (below the viewport — not a popup)
//
//  Clicking/tapping a system fills this in. It's deliberately a
//  plain section on the page rather than a modal or floating popup:
//  a mis-click just replaces its contents, there's nothing to
//  dismiss and no focus trap, so it can't turn an accidental tap
//  into a frustrating dead end. Clicking a planet row inside it
//  drills into that planet; a "back" link returns to the system view.
// ═══════════════════════════════════════════════════════════

/** Single entry point for "the user picked this system" — used by
 *  mouse click, touch tap, and search-result selection alike, so the
 *  details panel and camera-selection state never drift out of sync. */
function _selectSystem(system) {
    selected = system;
    selectedPlanet = null;
    _renderDetailsPanel();
    _draw();
}

function _wireDetailsPanel() {
    if (!detailsPanelEl) return;
    detailsPanelEl.addEventListener('click', e => {
        const planetRow = e.target.closest('[data-planet]');
        if (planetRow) {
            selectedPlanet = planetRow.getAttribute('data-planet');
            _renderDetailsPanel();
            return;
        }
        const backBtn = e.target.closest('[data-back-to-system]');
        if (backBtn) {
            selectedPlanet = null;
            _renderDetailsPanel();
        }
    });
}

function _renderDetailsPanel() {
    if (!detailsPanelEl) return;
    if (!selected) {
        detailsPanelEl.innerHTML = '<div class="map-details-empty">Click or tap a system on the map to see its details here.</div>';
        return;
    }
    detailsPanelEl.innerHTML = selectedPlanet
        ? _renderPlanetDetails(selected, selectedPlanet)
        : _renderSystemDetails(selected);
    _hydrateSpriteThumbs();
}

function _renderSystemDetails(s) {
    const links = s.links.length ? s.links.map(_esc).join(', ') : '—';
    const bucket = missionIndex.concreteBySystem.get(s.name);
    const genericCount = missionIndex.genericJobMatchCount.get(s.name) || 0;

    const starSection = _starSolarHtml(s);

    const planetsSection = s.planets.length
        ? `<div class="map-details-section">
             <h3>Planets (${s.planets.length}) — click one for details</h3>
             <div class="map-planet-list">${s.planets.map(p => _planetRowHtml(p)).join('')}</div>
           </div>`
        : `<div class="map-details-section"><h3>Planets</h3><div class="map-details-links">No planets on record here.</div></div>`;

    const missionsSection = _systemMissionsHtml(s, bucket, genericCount);

    return `
        <div class="map-details-header">
            <h2 class="map-details-title">${_esc(s.name)}<span class="map-details-gov">${_esc(s.government)}${s.wormhole ? ' · wormhole' : ''}</span></h2>
        </div>
        <div class="map-details-section">
            <h3>Jump links</h3>
            <div class="map-details-links">${links}</div>
        </div>
        ${window.MapSaveState ? window.MapSaveState.detailsHtml(s) : ''}
        ${starSection}
        ${planetsSection}
        ${missionsSection}
    `;
}

/**
 * Star image(s) plus Solar Power / Solar Wind for the system, computed
 * via MapCalculations.computeSolarAttributes() from each star object's
 * catalog entry (see mapCalculations.js's BASELINE_STAR_TABLE doc
 * comment for where those numbers come from). There's no separate
 * "heat" number in Endless Sky — Power is what governs both solar
 * collection AND solar-heat outfits, which is stated here rather than
 * inventing a second figure. The system-level `ramscoop` override
 * (universal/addend/multiplier) is shown as its own raw fact, not
 * folded into a single combined "fuel rate" — the exact interaction
 * between it and the wind-based formula below isn't something I could
 * independently verify, so it's shown separately rather than guessed.
 */
function _starSolarHtml(s) {
    const solar = MapCalculations.computeSolarAttributes(s, starTable);
    if (solar.stars.length === 0) {
        return `<div class="map-details-section"><h3>Star</h3><div class="map-details-links">No star on record for this system.</div></div>`;
    }

    const images = solar.stars.map(st => _spriteThumbHtml(st.sprite, st.sprite, 'map-star-thumb')).join('');

    const powerText = solar.power != null ? solar.power.toFixed(2) : 'unknown';
    const windText = solar.wind != null ? solar.wind.toFixed(2) : 'unknown';

    const habitableParts = [];
    if (s.habitableOverride != null) habitableParts.push(`system override: ${s.habitableOverride}`);
    for (const st of solar.stars) {
        if (st.habitable != null) habitableParts.push(`${_esc(st.sprite)}: ${st.habitable}`);
    }
    const habitableText = habitableParts.length ? habitableParts.join(' · ') : 'not on record';

    const ramscoopText = s.ramscoopModifier
        ? `universal ${s.ramscoopModifier.universal} · addend ${s.ramscoopModifier.addend} · multiplier ${s.ramscoopModifier.multiplier} <span class="map-tooltip-planet-gov">(overrides this system's default of 1/0/1)</span>`
        : 'default (no system override — universal 1, addend 0, multiplier 1)';

    return `
        <div class="map-details-section">
            <h3>Star${solar.stars.length > 1 ? 's' : ''} & Solar</h3>
            <div class="map-star-images">${images}</div>
            <div class="map-details-links">
                Solar Power: <b>${powerText}</b> <span class="map-tooltip-planet-gov">(solar collection & solar-heat outfits)</span><br>
                Solar Wind: <b>${windText}</b> <span class="map-tooltip-planet-gov">(ramscoop fuel regen)</span><br>
                Ramscoop modifier: ${ramscoopText}<br>
                Habitable zone: ${habitableText}
            </div>
        </div>
    `;
}

/**
 * Placeholder for a sprite image, hydrated asynchronously after the
 * innerHTML containing it is set — see _hydrateSpriteThumbs(). Doing
 * it this way (render text/structure synchronously, fill in images
 * after) keeps the details panel responsive even though fetchSprite()
 * is async and can be slow on a first-time image-index build.
 */
function _spriteThumbHtml(sprite, altText, sizeClass) {
    if (!sprite) return '';
    return `<div class="map-sprite-thumb ${sizeClass || ''}" data-sprite="${_esc(sprite)}" title="${_esc(altText || sprite)}"></div>`;
}

/** Finds every not-yet-loaded sprite placeholder in the details panel
 *  and fills it in via window.fetchSprite. Fire-and-forget per image —
 *  one missing/slow sprite doesn't block the others. */
function _hydrateSpriteThumbs() {
    if (typeof fetchSprite !== 'function' || !detailsPanelEl) return;
    const placeholders = detailsPanelEl.querySelectorAll('[data-sprite]');
    placeholders.forEach(async el => {
        const sprite = el.getAttribute('data-sprite');
        try {
            const element = await fetchSprite(sprite, null);
            if (!el.isConnected) return; // panel re-rendered before this resolved
            if (element) {
                element.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;image-rendering:pixelated;display:block;margin:auto;';
                el.innerHTML = '';
                el.appendChild(element);
            } else {
                el.classList.add('map-sprite-thumb--missing');
            }
        } catch (err) {
            console.warn('[mapDisplay] sprite fetch failed for', sprite, err);
            el.classList.add('map-sprite-thumb--missing');
        }
    });
}

function _planetRowHtml(p) {
    const badges = [
        p.hasSpaceport ? '<span class="map-badge-chip">port</span>' : null,
        p.hasShipyard ? '<span class="map-badge-chip">shipyard</span>' : null,
        p.hasOutfitter ? '<span class="map-badge-chip">outfitter</span>' : null,
        p.wormhole ? '<span class="map-badge-chip wormhole">wormhole</span>' : null,
    ].filter(Boolean).join('');
    const thumb = _spriteThumbHtml(p.sprite || p.landscapes[0], p.name, 'map-planet-row-thumb');
    return `
        <button class="map-planet-row" data-planet="${_esc(p.name)}">
            ${thumb}
            <span>${_esc(p.name)}</span>
            <span class="map-planet-row-gov">${_esc(p.government)}</span>
            <span class="map-planet-row-badges">${badges}</span>
        </button>
    `;
}

function _renderPlanetDetails(system, planetName) {
    const p = system.planets.find(pl => pl.name === planetName);
    if (!p) {
        // Data changed out from under the selection (e.g. plugin toggled off
        // mid-view) — fall back to the system view rather than show nothing.
        selectedPlanet = null;
        return _renderSystemDetails(system);
    }

    const badges = [
        p.hasSpaceport ? '<span class="map-badge-chip">spaceport</span>' : null,
        p.hasShipyard ? '<span class="map-badge-chip">shipyard</span>' : null,
        p.hasOutfitter ? '<span class="map-badge-chip">outfitter</span>' : null,
        p.wormhole ? `<span class="map-badge-chip wormhole">wormhole: ${_esc(p.wormhole)}</span>` : null,
    ].filter(Boolean).join('');

    const govNote = p.government !== system.government
        ? ` <span class="map-details-links">(differs from ${_esc(system.name)}'s ${_esc(system.government)})</span>`
        : '';

    // Landing-screen art (the actual "picture of the planet"), falling
    // back to the small map-icon sprite if this plugin has no landscape
    // art recorded for it.
    const landscapeImage = p.landscapes.length
        ? _spriteThumbHtml(p.landscapes[0], p.name, 'map-planet-landscape')
        : _spriteThumbHtml(p.sprite, p.name, 'map-planet-landscape');

    // Missions whose source resolved to exactly this planet, not just
    // somewhere else in the same system.
    const bucket = missionIndex.concreteBySystem.get(system.name);
    const storyHere = bucket ? bucket.story.filter(m => m.sourcePlanet === planetName) : [];
    const jobsHere = bucket ? bucket.jobs.filter(m => m.sourcePlanet === planetName) : [];
    const missionsSection = _planetMissionsHtml(storyHere, jobsHere);

    return `
        <button class="map-details-back" data-back-to-system>← Back to ${_esc(system.name)}</button>
        <div class="map-details-header">
            <h2 class="map-details-title">${_esc(p.name)}<span class="map-details-gov">${_esc(p.government)}${govNote}</span></h2>
        </div>
        ${landscapeImage}
        <div class="map-details-section">
            <h3>Facilities</h3>
            <div class="map-details-links">${badges || 'No spaceport facilities on record.'}</div>
        </div>
        ${missionsSection}
        <div class="map-details-section">
            <h3>Source</h3>
            <div class="map-details-links">from: ${p.definedBy.map(_esc).join(', ')}</div>
        </div>
    `;
}

function _systemMissionsHtml(s, bucket, genericCount) {
    const hasStory = bucket && bucket.story.length > 0;
    const hasJobs = bucket && bucket.jobs.length > 0;
    if (!hasStory && !hasJobs && !(jobBoardOn && genericCount > 0)) {
        return `<div class="map-details-section"><h3>Missions</h3><div class="map-details-links">Nothing on record starting here.</div></div>`;
    }
    const rows = [];
    if (hasStory) rows.push(...bucket.story.map(m => `<div class="map-mission-row">🚩 ${_esc(m.displayName)}${m.sourcePlanet ? ` <span class="map-tooltip-planet-gov">(${_esc(m.sourcePlanet)})</span>` : ''}</div>`));
    if (jobBoardOn && hasJobs) rows.push(...bucket.jobs.map(m => `<div class="map-mission-row">🧾 ${_esc(m.displayName)}${m.sourcePlanet ? ` <span class="map-tooltip-planet-gov">(${_esc(m.sourcePlanet)})</span>` : ''}</div>`));
    const approxNote = (jobBoardOn && genericCount > 0)
        ? `<div class="map-mission-approx-note">🧾 ~${genericCount} generic job template${genericCount === 1 ? '' : 's'} could also appear here (approx. — see README for what this does and doesn't check).</div>`
        : '';
    return `<div class="map-details-section"><h3>Missions</h3><div class="map-mission-list">${rows.join('')}</div>${approxNote}</div>`;
}

function _planetMissionsHtml(storyHere, jobsHere) {
    if (storyHere.length === 0 && jobsHere.length === 0) {
        return `<div class="map-details-section"><h3>Missions starting here</h3><div class="map-details-links">None on record for this exact planet.</div></div>`;
    }
    const rows = [
        ...storyHere.map(m => `<div class="map-mission-row">🚩 ${_esc(m.displayName)}</div>`),
        ...(jobBoardOn ? jobsHere.map(m => `<div class="map-mission-row">🧾 ${_esc(m.displayName)}</div>`) : []),
    ];
    return `<div class="map-details-section"><h3>Missions starting here</h3><div class="map-mission-list">${rows.join('')}</div></div>`;
}


// ═══════════════════════════════════════════════════════════
//  Search
// ═══════════════════════════════════════════════════════════

function _wireSearch() {
    if (!searchInput) return;
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim();
        if (!q) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; return; }
        const matches = MapCalculations.search(_visibleSet(), q, 20);
        resultsEl.innerHTML = matches.length
            ? matches.map(s => `<div data-n="${_esc(s.name)}"><b>${_esc(s.name)}</b><span>${_esc(s.government)}</span></div>`).join('')
            : `<p class="map-search-empty" style="margin:0;padding:8px 10px;color:var(--c-text-dim);font-size:0.85rem;">No systems match “${_esc(q)}” in your selected plugins.</p>`;
        resultsEl.style.display = 'block';
    });
    // Enter jumps to the first match
    searchInput.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        const first = resultsEl.querySelector('div[data-n]');
        if (first) { e.preventDefault(); first.click(); }
    });
    resultsEl.addEventListener('click', e => {
        const row = e.target.closest('div[data-n]');
        if (!row) return;
        const s = systemsByName.get(row.getAttribute('data-n'));
        if (!s) return;
        _selectSystem(s);
        cam.x = s.x; cam.y = s.y; cam.scale = Math.max(cam.scale, 3);
        resultsEl.style.display = 'none';
        searchInput.value = s.name;
        searchInput.blur(); // dismiss the mobile keyboard
        _draw();
    });
}

// ═══════════════════════════════════════════════════════════
//  Zoom / reset controls
// ═══════════════════════════════════════════════════════════

function _wireControls() {
    const zoomIn = document.getElementById('mapZoomIn');
    const zoomOut = document.getElementById('mapZoomOut');
    const reset = document.getElementById('mapReset');
    const w = () => canvas.clientWidth, h = () => canvas.clientHeight;
    if (zoomIn) zoomIn.addEventListener('click', () => {
        cam = MapCalculations.zoomAt(cam, 1.3, w() / 2, h() / 2, w(), h());
        _draw();
    });
    if (zoomOut) zoomOut.addEventListener('click', () => {
        cam = MapCalculations.zoomAt(cam, 1 / 1.3, w() / 2, h() / 2, w(), h());
        _draw();
    });
    if (reset) reset.addEventListener('click', () => {
        cam = MapCalculations.fitToSystems(systemsArr, w(), h());
        selected = null;
        _draw();
    });
}

// Lets other map add-ons (mapTradeHelper.js) point the map at a system.
window.MapView = {
    selectSystem(name, { center = true } = {}) {
        const s = systemsByName.get(name);
        if (!s) return false;
        if (center) { cam.x = s.x; cam.y = s.y; }
        _selectSystem(s);
        _draw();
        if (wrap && wrap.scrollIntoView) wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
    },
    hasSystem: name => systemsByName.has(name),
};

document.addEventListener('DOMContentLoaded', init);

})();
