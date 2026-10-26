'use strict';

// The Missions page: cards, filters, status badges, the mission window, Complete/Remove and the save cleanup panel.

(function () {

const listEl        = document.getElementById('missionList');
const statusEl       = document.getElementById('status');
const searchInput    = document.getElementById('searchInput');
const countLabel     = document.getElementById('countLabel');
// Both optional — only used if present in the page's HTML. See the
// bottom of this file for the exact markup to add for each.
const statusFilterEl = document.getElementById('statusFilterSelect');
const jobBoardFilterEl = document.getElementById('jobBoardFilterCheckbox');
const offerFilterEl = document.getElementById('offerFilterSelect');
const noSaveNoticeEl = document.getElementById('noSaveNotice');
const cleanupPanelEl = document.getElementById('saveCleanupPanel');

const HAS_STATUS_HELPER  = typeof window.MissionStatusHelper !== 'undefined';
const HAS_CLEANUP_HELPER = typeof window.SaveCleanupHelper   !== 'undefined';

// ── loader events ──
document.addEventListener('missionsLoadStart', () => {
    if (statusEl) statusEl.textContent = 'Loading missions…';
});
document.addEventListener('missionsLoaded', () => {
    if (statusEl) statusEl.remove();
    searchInput.disabled = false;
});
// While the first missions are showing and the rest are still downloading
document.addEventListener('missionsProgress', (e) => {
    const { loaded, total, done } = e.detail || {};
    let note = document.getElementById('missionProgressNote');
    if (done) { if (note) note.remove(); return; }
    if (!note) {
        note = document.createElement('p');
        note.id = 'missionProgressNote';
        note.style.cssText = 'font-size:0.85rem;color:var(--c-text-dim);margin:0 0 10px;';
        (listEl && listEl.parentNode) ? listEl.parentNode.insertBefore(note, listEl) : document.body.appendChild(note);
    }
    note.textContent = `Showing the first ${loaded.toLocaleString()} of ${total.toLocaleString()} missions — the rest are loading…`;
});
document.addEventListener('missionsLoadError', (e) => {
    if (statusEl) statusEl.textContent = 'Could not load mission data: ' + e.detail.message;
});

searchInput.addEventListener('input', applyFiltersAndRender);
if (statusFilterEl) statusFilterEl.addEventListener('change', applyFiltersAndRender);
if (jobBoardFilterEl) jobBoardFilterEl.addEventListener('change', applyFiltersAndRender);
if (offerFilterEl) offerFilterEl.addEventListener('change', applyFiltersAndRender);
// a big save arrives a moment later (rebuilt from its file)
if (window.GameKeys) window.GameKeys.loadGameRules().then(r => {
    if (r && window.MissionLoader && MissionLoader.isReady && MissionLoader.isReady()) refreshMissions();
});
document.addEventListener('esSaveCacheReady', () => {
    if (window.MissionLoader && MissionLoader.isReady && MissionLoader.isReady()) refreshMissions();
});

// clicking a card opens the mission window
listEl.addEventListener('click', (e) => {
    const head = e.target.closest('.mission-head');
    if (head) MissionModal.open(head.closest('.mission-card').dataset.id);
});

// redraw after the selected plugins change. Called by: generalPluginStuff
window._renderCardsFromManager = async function (/* resetTab */) {
    refreshMissions();
};

// the save can change in another tab
if (HAS_STATUS_HELPER) {
    window.addEventListener('storage', (e) => {
        if (e.key === 'ES_SM_CURRENT' || (e.key && e.key.startsWith('ES_SM_SAVE_'))) {
            refreshMissions();
        }
    });
}

// ── start: show the list as soon as the first missions are in ──
let _missionsBooted = false;
// show the list once. Called by: missionsLoaded
function _bootMissionList() {
    if (_missionsBooted) return;
    _missionsBooted = true;
    window.PluginManager.ensurePickerOverlay();
    return window.PluginManager.initDefaultPlugin();
}
document.addEventListener('missionsLoaded', _bootMissionList);
MissionLoader.load()
    .then(_bootMissionList)
    .catch(() => { /* missionsLoadError already fired and shown */ });

// Looked up by id when a card's raw-tree toggle is clicked, so we don't
// have to stuff raw mission data into the HTML string itself.
let currentMissions = new Map();

// the decorated list, rebuilt only when the data changes
let allDecoratedMissions = [];

// ── status badges ──
const STATUS_BADGE = HAS_STATUS_HELPER ? {
    [MissionStatusHelper.STATUS.IN_PROGRESS]:     { cls: 'active',    text: 'In progress' },
    [MissionStatusHelper.STATUS.AVAILABLE]:       { cls: 'available', text: 'Available' },
    [MissionStatusHelper.STATUS.DONE]:            { cls: 'done',      text: 'Completed' },
    [MissionStatusHelper.STATUS.FAILED]:          { cls: 'failed',    text: 'Failed' },
    [MissionStatusHelper.STATUS.DECLINED]:        { cls: 'declined',  text: 'Declined' },
    [MissionStatusHelper.STATUS.MIXED]:           { cls: 'mixed',     text: 'Mixed history' },
    [MissionStatusHelper.STATUS.OFFERED_ONLY]:    { cls: 'offered',   text: 'Offered' },
    // "not encountered" gets no badge (most missions)
} : {};

// flagged + failed/declined → shown as completed
function effectiveStatus(m) {
    if (!m.status) return null;
    return MissionStatusHelper.effectiveStatus(m.status);
}
// why a status was corrected
function overrideReason(m) {
    return m.status.completedByCondition ? m.status.completedByConditionReason : m.status.unreachableCompletePathReason;
}

const OFFER_BADGE = {
    now:    { cls: 'available', text: 'Can be offered' },
    almost: { cls: 'offered',   text: 'One step away' },
};
// "can get it now" badge
function offerBadgeHtml(m) {
    const b = m.offer && OFFER_BADGE[m.offer.state];
    if (!b) return '';
    const tip = m.offer.missing && m.offer.missing.length ? `${m.offer.label}: ${m.offer.missing.join('; ')}` : m.offer.label;
    return `<span class="mission-status-badge mission-status-badge--${b.cls}" title="${esc(tip)}">${esc(b.text)}</span>`;
}

// status badge
function statusBadgeHtml(m) {
    if (!m.status) return '';
    const overridden = effectiveStatus(m) !== m.status.status;
    const badge = STATUS_BADGE[effectiveStatus(m)];
    const badgeTitle = overridden
        ? `Recorded as "${m.status.label}" in the save, but ${overrideReason(m)} Shown as Completed based on that.`
        : m.status.label;
    // background helpers that have run: a plain "Ran" badge and no warning sign —
    // nothing is wrong with them
    if (m.status.backgroundHelper && overridden) {
        return `<span class="mission-status-badge mission-status-badge--done" title="${esc(m.status.unreachableCompletePathReason || '')}">Ran</span>`;
    }
    const badgeHtml = badge
        ? `<span class="mission-status-badge mission-status-badge--${badge.cls}" title="${esc(badgeTitle)}">${esc(badge.text)}</span>`
        : '';
    const warningHtml = m.status.unreachableCompletePath
        ? `<span class="mission-status-warning" title="${esc(m.status.unreachableCompletePathReason || '')}${overridden ? ' Shown as Completed above based on this.' : ' Open the mission and check its raw structure to judge for yourself.'}">⚠</span>`
        : '';
    return badgeHtml + warningHtml;
}

function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// reload missions and statuses. Called by: plugin/save changes
function refreshMissions() {
    let missions = MissionLoader.getAllMissions();

    if (HAS_STATUS_HELPER) {
        // prefer the cleaned-up save if there is one
        const save = HAS_CLEANUP_HELPER
            ? (SaveCleanupHelper.getUpdatedSave() || MissionStatusHelper.getCurrentSave())
            : MissionStatusHelper.getCurrentSave();
        missions = MissionStatusHelper.decorateMissions(missions, save);
        // Fold the status label into search text too, so typing "failed"
        // or "in progress" filters the list without a dedicated control.
        missions.forEach(m => { m.searchText = `${m.searchText} ${m.status.label}`.toLowerCase(); });
        // "Can I get it?" — only meaningful with a save loaded
        if (save && MissionStatusHelper.offerability) {
            missions.forEach(m => { m.offer = MissionStatusHelper.offerability(m.name, m.raw, save, m.status); });
        }
        if (offerFilterEl) offerFilterEl.disabled = !save;
        // Status filters need a save — grey them out (and reset) without one
        if (statusFilterEl) {
            statusFilterEl.disabled = !save;
            statusFilterEl.title = save ? '' : 'Open a save on the Saves & Account page to filter by status';
            if (!save && statusFilterEl.value) statusFilterEl.value = '';
            const first = statusFilterEl.options[0];
            if (first) { first.dataset.label = first.dataset.label || first.textContent; first.textContent = save ? first.dataset.label : 'Status: open a save first'; }
        }
        if (offerFilterEl && !save) offerFilterEl.title = 'Open a save on the Saves & Account page to use this';
        if (noSaveNoticeEl) noSaveNoticeEl.classList.toggle('hidden', !!save);
    } else if (noSaveNoticeEl) {
        noSaveNoticeEl.classList.add('hidden');
    }

    allDecoratedMissions = missions;
    applyFiltersAndRender();
    renderCleanupPanel();
}

// search + filters over the list (cheap)
function applyFiltersAndRender() {
    const q = searchInput.value.trim().toLowerCase();
    let filtered = q ? allDecoratedMissions.filter(m => m.searchText.includes(q)) : allDecoratedMissions;

    const statusPick = statusFilterEl ? statusFilterEl.value : '';
    if (statusPick && HAS_STATUS_HELPER) {
        // filters use the status as shown
        filtered = statusPick === 'has_status'
            ? filtered.filter(m => effectiveStatus(m) !== MissionStatusHelper.STATUS.NOT_ENCOUNTERED)
            : filtered.filter(m => effectiveStatus(m) === statusPick);
    }

    const offerPick = offerFilterEl && !offerFilterEl.disabled ? offerFilterEl.value : '';
    if (offerPick) {
        filtered = filtered.filter(m => m.offer && (offerPick === 'now_or_almost'
            ? (m.offer.state === 'now' || m.offer.state === 'almost')
            : m.offer.state === offerPick));
    }

    if (jobBoardFilterEl && jobBoardFilterEl.checked) {
        filtered = filtered.filter(m => !(m.locations || []).includes('job'));
    }

    currentMissions = new Map(filtered.map(m => [m.id, m]));

    countLabel.textContent = `${filtered.length} mission${filtered.length === 1 ? '' : 's'}`;
    // draw cards in batches so phones don't stall
    lastFiltered = filtered;
    shownCount = Math.min(filtered.length, MISSION_BATCH);
    listEl.innerHTML = filtered.length
        ? filtered.slice(0, shownCount).map(cardHtml).join('') + moreButtonHtml()
        : '<p class="mission-empty">No missions match.</p>';
    watchMore();
}

const MISSION_BATCH = 60;
let lastFiltered = [], shownCount = 0, moreObserver = null;
// "Show more" button
function moreButtonHtml() {
    const left = lastFiltered.length - shownCount;
    return left > 0 ? `<button class="btn btn-secondary" id="missionShowMore" style="width:100%;margin-top:10px;">Show ${Math.min(left, MISSION_BATCH)} more (${left} left)</button>` : '';
}
// next batch of cards
function showMoreMissions() {
    const btn = document.getElementById('missionShowMore');
    if (!btn) return;
    const next = lastFiltered.slice(shownCount, shownCount + MISSION_BATCH);
    shownCount += next.length;
    btn.insertAdjacentHTML('beforebegin', next.map(cardHtml).join(''));
    btn.outerHTML = moreButtonHtml();
    watchMore();
}
// auto-load more near the bottom
function watchMore() {
    const btn = document.getElementById('missionShowMore');
    if (!btn) return;
    btn.onclick = showMoreMissions;
    if (!('IntersectionObserver' in window)) return;
    if (moreObserver) moreObserver.disconnect();
    moreObserver = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) showMoreMissions(); }, { rootMargin: '600px' });
    moreObserver.observe(btn);
}

// one mission card
function cardHtml(m) {
    return `
      <div class="mission-card" data-id="${m.id}">
        <div class="mission-head">
          <span class="mission-title">${m.titleHtml}</span>
          <span class="mission-head-right">
            ${offerBadgeHtml(m)}
            ${statusBadgeHtml(m)}
            <span class="mission-plugin">${m.pluginHtml}</span>
          </span>
        </div>
      </div>`;
}

// ── the mission window (extend with registerAction / registerNote) ──
const MissionModal = (function () {
    let overlayEl, titleEl, pluginEl, bodyEl, actionsEl;
    let openMissionId = null;
    const actionBuilders = [];
    const noteBuilders = [];

    // add the window to the page
    function inject() {
        if (document.getElementById('missionModalOverlay')) return;

        overlayEl = document.createElement('div');
        overlayEl.id = 'missionModalOverlay';
        overlayEl.className = 'modal-overlay';
        overlayEl.innerHTML = `
            <div class="modal-box modal-box--detail">
                <div class="modal-header">
                    <div>
                        <div class="modal-title" id="missionModalTitle"></div>
                        <div class="mission-plugin" id="missionModalPlugin"></div>
                    </div>
                    <button class="modal-close" id="missionModalCloseBtn">✕</button>
                </div>
                <div id="missionModalBody"></div>
                <div id="missionModalActions" class="mission-modal-actions"></div>
            </div>`;
        document.body.appendChild(overlayEl);

        titleEl   = document.getElementById('missionModalTitle');
        pluginEl  = document.getElementById('missionModalPlugin');
        bodyEl    = document.getElementById('missionModalBody');
        actionsEl = document.getElementById('missionModalActions');

        overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) close(); });
        document.getElementById('missionModalCloseBtn').addEventListener('click', close);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

        // Raw-tree lazy-render/toggle now lives inside the modal body,
        // same lazy-build-on-first-click behaviour as before.
        bodyEl.addEventListener('click', (e) => {
            const toggle = e.target.closest('.mission-raw-toggle');
            if (!toggle) return;
            const box = toggle.nextElementSibling;
            if (box.dataset.lazy === '1') {
                const m = currentMissions.get(openMissionId);
                box.innerHTML = (m && m.raw)
                    ? MissionLoader.renderRawTree(m.raw)
                    : '<div class="mission-empty">(no raw data)</div>';
                delete box.dataset.lazy;
            }
            box.classList.toggle('open');
            toggle.textContent = (box.classList.contains('open') ? '▾' : '▸') + ' View full raw structure';
        });

        // one listener for every action button
        actionsEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-mission-action]');
            if (!btn) return;
            const m = currentMissions.get(openMissionId);
            if (m) _fireEvent('missionModalAction', { action: btn.dataset.missionAction, mission: m, button: btn });
        });
    }

    // page event
    function _fireEvent(name, detail) {
        document.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
    }

    // open the mission window
    function open(missionId) {
        const m = currentMissions.get(missionId);
        if (!m) return;
        openMissionId = missionId;

        titleEl.innerHTML  = m.titleHtml;
        pluginEl.innerHTML = m.pluginHtml;
        const notes = noteBuilders
            .map(fn => { try { return fn(m) || ''; } catch (err) { console.error('[MissionModal] note builder failed:', err); return ''; } })
            .join('');
        bodyEl.innerHTML   = notes + m.bodyHtml;
        actionsEl.innerHTML = actionBuilders
            .map(fn => { try { return fn(m) || ''; } catch (err) { console.error('[MissionModal] action builder failed:', err); return ''; } })
            .join('');

        overlayEl.classList.add('active');
    }

    // close it
    function close() {
        overlayEl.classList.remove('active');
        openMissionId = null;
    }

    // add an action button to the window
    function registerAction(buildFn) {
        actionBuilders.push(buildFn);
    }

    // add a note to the mission window
    function registerNote(buildFn) {
        noteBuilders.push(buildFn);
    }

    document.addEventListener('DOMContentLoaded', inject);
    // In case this script runs after DOMContentLoaded already fired
    // (it's loaded at the end of body, so this is the common case).
    if (document.readyState !== 'loading') inject();

    return { open, close, registerAction, registerNote, getOpenMissionId: () => openMissionId };
})();

window.MissionModal = MissionModal;

// example note — safe to remove
MissionModal.registerAction(m => `
    <button class="btn-cleanup-reset" data-mission-action="copy-name">Copy internal name</button>
`);
document.addEventListener('missionModalAction', (e) => {
    if (e.detail.action !== 'copy-name') return;
    navigator.clipboard?.writeText(e.detail.mission.name).catch(() => {});
});

// warning for statuses that may mislead
if (HAS_STATUS_HELPER) {
    MissionModal.registerNote(m => {
        if (!m.offer || m.offer.state === 'active') return '';
        // a background helper that has already run: say so plainly
        const helperRan = m.status && m.status.backgroundHelper && m.offer.state === 'used_up';
        const label = helperRan ? 'Already ran — background missions only run once' : m.offer.label;
        const list = m.offer.missing && m.offer.missing.length
            ? `<ul style="margin:6px 0 0;padding-left:18px;">${m.offer.missing.map(x => `<li><code>${esc(x)}</code></li>`).join('')}</ul>` : '';
        const lead = m.offer.state === 'almost' ? 'Still needed:' : m.offer.state === 'not_yet' ? 'Not met yet:' : m.offer.state === 'unknown' ? 'Can’t check from the save:' : '';
        // "be where it's offered" only matters if it can still be offered
        const stillOfferable = !['used_up', 'done', 'never'].includes(m.offer.state);
        return `<div class="mission-warning-banner" style="border-color:var(--c-border);">🧭 <strong>${esc(label)}</strong>${lead ? ` — ${lead}` : ''}${list}
          ${stillOfferable ? '<div style="font-size:0.8rem;color:var(--c-text-dim);margin-top:4px;">You also need to be where the mission is offered.</div>' : ''}</div>`;
    });
}

if (HAS_STATUS_HELPER) {
    MissionModal.registerNote(m => {
        if (!m.status || !m.status.unreachableCompletePath) return '';
        if (m.status.backgroundHelper) return `<div class="mission-warning-banner" style="border-color:var(--c-border);">ℹ️ ${esc(m.status.unreachableCompletePathReason || '')}</div>`;
        const overridden = effectiveStatus(m) !== m.status.status;
        const followUp = overridden
            ? `Already shown as Completed above based on this — no action needed unless you disagree.`
            : `Check the raw structure below to judge for yourself — and consider using "Complete mission" instead if this looks like your case.`;
        return `<div class="mission-warning-banner">⚠ ${esc(m.status.unreachableCompletePathReason || '')} ${followUp}</div>`;
    });
}

// ── Complete / Remove (with a save open) ──
if (HAS_CLEANUP_HELPER && HAS_STATUS_HELPER) {

    MissionModal.registerAction(m => {
        // These change a save, so they need one open
        let hasSave = false;
        try { hasSave = !!JSON.parse(localStorage.getItem('ES_SM_CURRENT') || 'null'); } catch (_) {}
        if (!hasSave) return '<p class="mission-modal-note" style="font-size:0.82rem;color:var(--c-text-dim);margin:0;">Open a save on the <a href="UserManager.html">Saves &amp; Account</a> page to complete or remove this mission in it.</p>';
        const buttons = [];
        const alreadyCleanlyDone = m.status && effectiveStatus(m) === MissionStatusHelper.STATUS.DONE;
        if (!alreadyCleanlyDone) {
            buttons.push('<button class="btn-cleanup-remove-all" data-mission-action="complete-mission">Complete mission (apply rewards)</button>');
        }
        buttons.push('<button class="btn-cleanup-remove" data-mission-action="remove-mission">Remove mission entirely</button>');
        return buttons.join('\n');
    });

    // what completing gives (payment, outfits, ships)
    function computeOnCompleteRewards(m) {
        const onCompleteTriggers = (m.payment && m.payment.triggers && m.payment.triggers.onComplete) || [];
        let credits = onCompleteTriggers.reduce((sum, t) => sum + (t.base || 0), 0);
        // no on-complete payment — use the game's estimate
        if (credits === 0 && onCompleteTriggers.length === 0 && m.payment && m.payment.apparentPayment) {
            credits = m.payment.apparentPayment;
        }
        const outfits = (m.rewards.outfits || [])
            .filter(o => o.grantedIn === 'onComplete')
            .map(o => ({ name: o.name, count: o.count || 1 }));
        const ships = (m.rewards.ships || [])
            .filter(s => s.grantedIn === 'onComplete')
            .map(s => ({ name: s.name, count: s.count || 1 }));
        return { credits, outfits, ships };
    }

    // confirm message for removing a mission
    function describeRemoval(m) {
        if (m.status.isHeld)      return 'This deletes its held mission data and clears its tracking conditions.';
        if (m.status.isAvailable) return 'This removes it from the available-jobs list and clears its tracking conditions.';
        if (m.status.status === MissionStatusHelper.STATUS.NOT_ENCOUNTERED) return 'This save has no record of it, so there\u2019s nothing to remove.';
        return 'This clears its recorded history (offered/done/failed/declined counts) from the save.';
    }

    document.addEventListener('missionModalAction', (e) => {
        const { action, mission } = e.detail;

        if (action === 'remove-mission') {
            if (!window.confirm(`Remove "${mission.name}"? ${describeRemoval(mission)} The original save is untouched — this only edits the Updated Save.`)) return;
            SaveCleanupHelper.removeMission(mission.name);
            MissionModal.close();
            refreshMissions();
            return;
        }

        if (action === 'complete-mission') {
            const rewards = computeOnCompleteRewards(mission);
            const context = mission.status.isHeld
                ? 'currently active'
                : mission.status.isAvailable
                    ? 'available but not yet accepted'
                    : `not currently tracked in the save (status: ${mission.status.label})`;
            const repeatNote = mission.repeatable
                ? ''
                : (mission.status.counts.failed || mission.status.counts.declined)
                    ? '\n\nThis mission isn\u2019t repeatable, so its existing failed/declined history will be cleared — a non-repeatable mission can\u2019t have both in a real save.'
                    : '';
            if (!window.confirm(`Mark "${mission.name}" (${context}) as completed and apply its rewards to the Updated Save?${repeatNote}`)) return;
            const result = SaveCleanupHelper.completeMission(mission.name, rewards, { repeatable: mission.repeatable });
            MissionModal.close();
            refreshMissions();

            const parts = [];
            if (rewards.credits) parts.push(`${rewards.credits.toLocaleString()} credits`);
            const shown = n => (window.MissionNames ? MissionNames.text('outfits', n) : n);
            rewards.outfits.forEach(o => parts.push(`${shown(o.name)}${o.count > 1 ? ` ×${o.count}` : ''} (added to cargo)`));
            if (result.unappliedShips.length) {
                result.unappliedShips.forEach(s => parts.push(`${s.name} (SHIP — not added automatically, see note below)`));
            }
            let msg = parts.length ? `Applied:\n${parts.join('\n')}` : 'This mission had no onComplete rewards to apply.';
            if (result.clearedFailed || result.clearedDeclined) {
                msg += `\n\nCleared prior ${[result.clearedFailed && 'failed', result.clearedDeclined && 'declined'].filter(Boolean).join(' and ')} record (non-repeatable mission).`;
            }
            if (result.unappliedShips.length) {
                msg += `\n\nShip rewards aren't added to the save automatically — this page doesn't have full ship stat data loaded (that lives on the Ship Builder page), so adding one here would mean an incomplete/broken entry. Add it manually if needed.`;
            }
            window.alert(msg);
        }
    });
}

// ── save cleanup panel: failed missions you can remove ──
if (cleanupPanelEl && HAS_CLEANUP_HELPER) {
    cleanupPanelEl.addEventListener('click', (e) => {
        const removeFailedBtn = e.target.closest('[data-remove-failed]');
        if (removeFailedBtn) {
            SaveCleanupHelper.removeFailedCondition(removeFailedBtn.dataset.removeFailed);
            refreshMissions();
            return;
        }
        const removeEventBtn = e.target.closest('[data-remove-event]');
        if (removeEventBtn) {
            SaveCleanupHelper.removeTriggeredEvent(Number(removeEventBtn.dataset.removeEvent));
            refreshMissions();
            return;
        }
        if (e.target.closest('#cleanupRemoveAllFailed')) {
            SaveCleanupHelper.removeAllFailedConditions();
            refreshMissions();
            return;
        }
        if (e.target.closest('#cleanupRemoveAllEvents')) {
            SaveCleanupHelper.removeAllTriggeredEvents();
            refreshMissions();
            return;
        }
        if (e.target.closest('#cleanupResetBtn')) {
            if (window.confirm('Discard all cleanup edits and start again from the original save?')) {
                SaveCleanupHelper.resetUpdatedSave();
                refreshMissions();
            }
        }
    });
}

// draw the cleanup panel. Called by: refreshMissions
function renderCleanupPanel() {
    if (!cleanupPanelEl || !HAS_CLEANUP_HELPER) return;

    const save = SaveCleanupHelper.getUpdatedSave();
    if (!save) { cleanupPanelEl.innerHTML = ''; return; }

    const failed   = SaveCleanupHelper.listFailedConditions(save);
    const events   = SaveCleanupHelper.listTriggeredEvents(save);

    const failedRows = failed.length
        ? failed.map(f => `
            <li class="cleanup-row">
              <span>${esc(f.name)}${f.count > 1 ? ` <span class="mission-field-label">(×${f.count})</span>` : ''}</span>
              <button class="btn-cleanup-remove" data-remove-failed="${esc(f.name)}">Remove</button>
            </li>`).join('')
        : '<li class="cleanup-empty">None found.</li>';

    const eventRows = events.length
        ? events.map(ev => `
            <li class="cleanup-row">
              <span>Event dated ${esc(ev.dateText)}</span>
              <button class="btn-cleanup-remove" data-remove-event="${ev.index}">Remove</button>
            </li>`).join('')
        : '<li class="cleanup-empty">None found.</li>';

    cleanupPanelEl.innerHTML = `
      <div class="cleanup-section">
        <div class="cleanup-section-head">
          <span>Failed mission history (${failed.length})</span>
          ${failed.length ? '<button class="btn-cleanup-remove-all" id="cleanupRemoveAllFailed">Remove all</button>' : ''}
        </div>
        <ul class="cleanup-list">${failedRows}</ul>
      </div>
      <div class="cleanup-section">
        <div class="cleanup-section-head">
          <span>Already-triggered events (${events.length})</span>
          ${events.length ? '<button class="btn-cleanup-remove-all" id="cleanupRemoveAllEvents">Remove all</button>' : ''}
        </div>
        <ul class="cleanup-list">${eventRows}</ul>
      </div>
      <button class="btn-cleanup-reset" id="cleanupResetBtn">Discard all cleanup edits</button>
    `;
}

// ── optional HTML this page looks for ──

})();
