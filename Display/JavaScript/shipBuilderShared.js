'use strict';

// Opens a ship someone shared from their account (from a link) in the builder.

(function () {
  const id = new URLSearchParams(location.search).get('shared');
  if (!id) return;
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // the window
  function modal(html) {
    let m = document.getElementById('modal-sb-shared');
    if (!m) {
      m = document.createElement('div');
      m.id = 'modal-sb-shared'; m.className = 'modal-overlay';
      m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) m.classList.remove('active'); });
      document.body.appendChild(m);
    }
    m.innerHTML = `<div class="modal-box" style="width:min(460px,96vw);">${html}</div>`;
    m.classList.add('active');
    return m;
  }

  // show a shared ship
  async function show() {
    if (window.EsAuth) await window.EsAuth.ready();
    const { data: ship, error } = await window.supabaseClient.from('saved_ships')
      .select('id, name, user_id, is_public, build_data, updated_at').eq('id', id).maybeSingle();
    if (error || !ship) {
      modal(`<div class="modal-header"><div class="modal-title">Ship not available</div><button class="modal-close" data-close>×</button></div>
        <p style="color:var(--c-text-mid);">This ship doesn't exist, or its owner has made it private.</p>
        <div class="btn-group btn-group-right"><button class="btn btn-secondary" data-close>Close</button></div>`);
      return;
    }
    const { data: owner } = await window.supabaseClient.from('profiles').select('username').eq('id', ship.user_id).maybeSingle();
    const me = window.EsAuth && window.EsAuth.getCurrentUser();
    const mine = me && me.id === ship.user_id;
    if (window.PluginAvailability) await window.PluginAvailability.ready;
    const b = ship.build_data || {};
    const a = b.attributes || {};
    const outfits = b.outfits && typeof b.outfits === 'object' ? Object.values(b.outfits).reduce((n, o) => n + (o.count || 1), 0) : 0;
    const profileUrl = owner?.username ? (() => { const u = new URL('Profile.html', location.href); u.searchParams.set('u', owner.username); return u.href; })() : null;
    const fleets = window.FleetStore ? window.FleetStore.list() : [];

    const m = modal(`
      <div class="modal-header"><div class="modal-title">${h(ship.name)}</div><button class="modal-close" data-close>×</button></div>
      <p style="color:var(--c-text-mid);margin-top:0;">Shared by ${profileUrl ? `<a href="${h(profileUrl)}">${h(owner.username)}</a>` : 'a pilot'}
        ${mine && !ship.is_public ? ' · <strong>private</strong> (only you can see this)' : ''}</p>
      <div class="fleet-card__stats" style="margin-bottom:14px;">
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Model</div><div class="fleet-card__stat-value" style="font-size:0.85rem;">${h(b._sourceShip || b.name || '—')}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Category</div><div class="fleet-card__stat-value" style="font-size:0.85rem;">${h(a.category || '—')}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Hull</div><div class="fleet-card__stat-value">${h(a.hull || '—')}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Outfits</div><div class="fleet-card__stat-value">${outfits}</div></div>
      </div>
      ${window.PluginAvailability ? window.PluginAvailability.noticeHtml(b) : ''}
      ${fleets.length ? `<label for="sb-shared-fleet" style="display:block;font-size:0.85rem;margin-bottom:6px;">Add a copy to</label>
        <select id="sb-shared-fleet" class="text-input">${fleets.map(f => `<option value="${h(f.id)}"${f.id === window.FleetStore.activeId ? ' selected' : ''}>${h(f.name)} (${f.shipCount})</option>`).join('')}</select>` : ''}
      <div class="btn-group btn-group-right">
        ${mine ? '' : '<button class="btn btn-secondary" id="sb-shared-report">Report</button>'}
        <button class="btn btn-secondary" data-close>Close</button>
        ${fleets.length ? '<button class="btn btn-primary" id="sb-shared-add">Add to fleet</button>' : ''}
      </div>`);

    const add = m.querySelector('#sb-shared-add');
    if (add) add.onclick = () => {
      const fleetId = m.querySelector('#sb-shared-fleet').value;
      const copy = { ...b, name: b.name || ship.name, _sharedFrom: ship.id, _sharedBy: owner?.username || null };
      window.FleetStore.addShips(fleetId, [copy]);
      window.FleetStore.setActive(fleetId);
      m.classList.remove('active');
      if (typeof sbToast === 'function') sbToast(`Added "${ship.name}" to ${window.FleetStore.get(fleetId).name}.`, 'success');
      const url = new URL(location.href); url.searchParams.delete('shared'); history.replaceState(null, '', url.href);
    };
    const rep = m.querySelector('#sb-shared-report');
    if (rep) rep.onclick = () => { m.classList.remove('active'); window.EsReport && window.EsReport.open({ type: 'ship', id: ship.id, label: ship.name }); };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();
