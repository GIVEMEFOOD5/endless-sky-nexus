'use strict';

// The Account tab: shared ships, your data (export / delete), and admin tools.

(function () {
  // Supabase client
  const sb = () => window.supabaseClient;
  const A = window.EsAuth;
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // message
  const say = (m, t) => (typeof toast === 'function' ? toast(m, t) : alert(m));
  // link to a page
  const pageUrl = (page, params) => { const u = new URL(page, location.href); for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v); return u.href; };
  window.EsLinks = {
    ship: id => pageUrl('shipBuilder.html', { shared: id }),
    profile: username => pageUrl('Profile.html', { u: username }),
  };

  const host = document.getElementById('account-logged-in');
  if (!host || !A) return;
  const root = document.createElement('div');
  root.id = 'ac-root';
  host.appendChild(root);

  // draw the tab
  async function render() {
    const user = A.getCurrentUser();
    if (!user) { root.innerHTML = ''; return; }
    const profile = A.getCurrentProfile();
    root.innerHTML = `
      <hr style="border-color:var(--c-border);margin:24px 0;">
      <h3 style="margin:0 0 6px;">Shared ships</h3>
      <p style="font-size:0.85rem;color:var(--c-text-dim);margin:0 0 12px;">
        Ships you save with “Share” in the ship builder. Only ships marked <strong>Public</strong> can be seen by other people.
        ${profile?.username ? `Your public ships are listed on <a href="${h(window.EsLinks.profile(profile.username))}">your profile</a>.` : ''}
      </p>
      <div id="ac-ships"><p style="color:var(--c-text-dim);">Loading…</p></div>

      <hr style="border-color:var(--c-border);margin:24px 0;">
      <h3 style="margin:0 0 6px;">Your data</h3>
      <div class="btn-group" style="margin:0 0 8px;">
        <button class="btn btn-secondary" id="ac-export">Download my data</button>
        <button class="btn btn-danger" id="ac-delete">Delete my account</button>
      </div>
      <p style="font-size:0.8rem;color:var(--c-text-dim);margin:0;">The download is one JSON file with your profile, fleets, shared ships, saves and reports you filed.</p>
      <div id="ac-admin"></div>`;
    document.getElementById('ac-export').onclick = exportData;
    document.getElementById('ac-delete').onclick = openDelete;
    renderShips();
    if (await A.isAdmin()) { renderAdmin(); renderSiteErrors(); }
  }

  // ── shared ships ──
  async function renderShips() {
    if (window.PluginAvailability) await window.PluginAvailability.ready;
    const box = document.getElementById('ac-ships');
    const user = A.getCurrentUser();
    if (!box || !user) return;
    const { data, error } = await sb().from('saved_ships')
      .select('id, name, is_public, hidden_at, hidden_reason, build_data, updated_at').eq('user_id', user.id).order('updated_at', { ascending: false });
    if (error) { box.innerHTML = `<p style="color:var(--c-danger-text);">Could not load your shared ships: ${h(error.message)}</p>`; return; }
    if (!data.length) { box.innerHTML = '<p style="color:var(--c-text-dim);">You haven’t shared any ships yet. Use “Share” on a ship in the ship builder.</p>'; return; }
    box.innerHTML = data.map(s => `
      <div class="list-row" data-id="${h(s.id)}" style="margin-bottom:8px;flex-wrap:wrap;gap:8px;">
        <span class="list-row__label">${h(s.name)}
          <span style="font-size:0.75rem;color:var(--c-text-dim);">${h(s.build_data?.attributes?.category || '')}</span>
          ${window.PluginAvailability ? window.PluginAvailability.badgeHtml(s.build_data) : ''}
          ${s.hidden_at ? `<span style="font-size:0.75rem;color:var(--c-danger-text);"> · hidden by a moderator${s.hidden_reason ? ': ' + h(s.hidden_reason) : ''}</span>` : ''}</span>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;">
          <input type="checkbox" data-act="public"${s.is_public ? ' checked' : ''}> Public</label>
        ${s.is_public && !s.hidden_at ? '<button class="btn btn-secondary btn-sm" data-act="link">Copy link</button>' : ''}
        ${window.FleetStore ? '<button class="btn btn-secondary btn-sm" data-act="fleet">Add to fleet</button>' : ''}
        <button class="btn btn-danger btn-sm" data-act="delete">Delete</button>
      </div>`).join('');
    box.onclick = async e => {
      const b = e.target.closest('[data-act]'); if (!b || b.dataset.act === 'public') return;
      const s = data.find(x => x.id === b.closest('[data-id]').dataset.id);
      if (b.dataset.act === 'link') {
        try { await navigator.clipboard.writeText(window.EsLinks.ship(s.id)); say('Link copied.', 'success'); }
        catch (_) { prompt('Copy this link:', window.EsLinks.ship(s.id)); }
      }
      if (b.dataset.act === 'fleet') {
        const f = window.FleetStore.active();
        window.FleetStore.addShips(f.id, [{ ...(s.build_data || {}), name: s.build_data?.name || s.name }]);
        say(`Added "${s.name}" to your fleet "${f.name}".`, 'success');
      }
      if (b.dataset.act === 'delete') {
        if (!confirm(`Delete the shared ship "${s.name}"? Its link will stop working. Your fleets are not affected.`)) return;
        const { error } = await sb().from('saved_ships').delete().eq('id', s.id);
        if (error) return say(error.message, 'danger');
        say('Shared ship deleted.', 'success'); renderShips();
      }
    };
    box.onchange = async e => {
      if (e.target.dataset.act !== 'public') return;
      const id = e.target.closest('[data-id]').dataset.id;
      const { error } = await sb().from('saved_ships').update({ is_public: e.target.checked, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) { say(error.message, 'danger'); e.target.checked = !e.target.checked; return; }
      say(e.target.checked ? 'Ship is now public.' : 'Ship is now private — only you can see it.', 'success');
      renderShips();
    };
  }

  // ── your data ──
  async function exportData() {
    const b = document.getElementById('ac-export');
    b.disabled = true; b.textContent = 'Preparing…';
    try {
      const data = await A.exportMyData();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: `my-endless-sky-nexus-data-${new Date().toISOString().slice(0, 10)}.json` }).click();
      URL.revokeObjectURL(url);
      say('Downloaded your data.', 'success');
    } catch (err) { say(err.message, 'danger'); }
    finally { b.disabled = false; b.textContent = 'Download my data'; }
  }

  // delete account (asks first)
  function openDelete() {
    let m = document.getElementById('ac-delete-modal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'ac-delete-modal'; m.className = 'modal-overlay';
      m.innerHTML = `
        <div class="modal-box" style="width:min(440px,96vw);">
          <div class="modal-header"><div class="modal-title">Delete your account</div>
            <button class="modal-close" data-close>×</button></div>
          <p style="color:var(--c-text-mid);">This permanently deletes your account, fleets, shared ships and the saves stored in your account. It cannot be undone.</p>
          <label style="display:flex;gap:8px;align-items:center;margin-bottom:12px;font-size:0.9rem;">
            <input type="checkbox" id="ac-del-local" checked> Also remove fleets and saves stored in this browser</label>
          <label for="ac-del-confirm" style="display:block;font-size:0.85rem;margin-bottom:6px;">Type <strong>DELETE</strong> to confirm</label>
          <input id="ac-del-confirm" class="text-input" autocomplete="off">
          <div id="ac-del-error" style="margin-top:8px;"></div>
          <div class="btn-group btn-group-right">
            <button class="btn btn-secondary" data-close>Cancel</button>
            <button class="btn btn-danger" id="ac-del-go" disabled>Delete my account</button>
          </div>
        </div>`;
      document.body.appendChild(m);
      m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) m.classList.remove('active'); });
      const input = m.querySelector('#ac-del-confirm'), go = m.querySelector('#ac-del-go');
      input.oninput = () => { go.disabled = input.value.trim() !== 'DELETE'; };
      go.onclick = async () => {
        go.disabled = true; go.textContent = 'Deleting…';
        try {
          const clearLocal = m.querySelector('#ac-del-local').checked;
          await A.deleteMyAccount();
          if (clearLocal) {
            for (const k of Object.keys(localStorage)) if (/^(ES_SM_|es_ship_builder_)/.test(k)) localStorage.removeItem(k);
            if (window.SaveVault) await window.SaveVault.clearLocal();
          }
          m.classList.remove('active');
          say('Your account has been deleted.', 'success');
          setTimeout(() => location.reload(), 1200);
        } catch (err) {
          m.querySelector('#ac-del-error').innerHTML = `<div class="auth-form-error">${h(err.message)}</div>`;
          go.disabled = false; go.textContent = 'Delete my account';
        }
      };
    }
    m.querySelector('#ac-del-confirm').value = '';
    m.querySelector('#ac-del-go').disabled = true;
    m.querySelector('#ac-del-error').innerHTML = '';
    m.classList.add('active');
  }

  // ── admin: site errors and moderation ──
  let _siteErrorsMissing = false, _siteErrorsBusy = false;   // ask once per page if it isn't set up yet
  async function renderSiteErrors() {
    if (_siteErrorsMissing || _siteErrorsBusy) return;
    _siteErrorsBusy = true;
    try { await _renderSiteErrors(); } finally { _siteErrorsBusy = false; }
  }
  async function _renderSiteErrors() {
    const box = document.getElementById('ac-admin');
    if (!box) return;
    let el = document.getElementById('ac-site-errors');
    if (!el) { el = document.createElement('div'); el.id = 'ac-site-errors'; box.after(el); }
    const { data, error } = await sb().from('client_errors_summary').select('*').limit(25);
    if (error) {
      // missing, or not allowed to read it yet (403 — see supabase/grants.sql)
      if (/does not exist|relation|schema cache|PGRST205|permission denied|42501/i.test(error.message + ' ' + (error.code || ''))) _siteErrorsMissing = true;
      el.innerHTML = _siteErrorsMissing
        ? '<p style="font-size:0.84rem;color:var(--c-text-dim);">Site error reports: run <code>supabase/client_errors.sql</code> and <code>supabase/grants.sql</code> once to switch them on.</p>'
        : `<p style="color:var(--c-danger-text);">Could not load site errors: ${h(error.message)}</p>`;
      return;
    }
    el.innerHTML = `
      <hr style="border-color:var(--c-border);margin:24px 0;">
      <h3 style="margin:0 0 6px;">Site errors (last 7 days)</h3>
      <p style="font-size:0.82rem;color:var(--c-text-dim);margin:0 0 8px;">Errors that happened in visitors' browsers, most frequent first. Full details (stack traces, browsers) are in the <code>client_errors</code> table in Supabase.</p>
      ${(data || []).length ? (data || []).map(r => `<div class="list-row" style="margin-bottom:6px;flex-wrap:wrap;align-items:flex-start;">
          <span class="list-row__label" style="flex:1 1 300px;"><code style="font-size:0.8rem;white-space:pre-wrap;word-break:break-word;">${h(r.message)}</code>
            <span style="display:block;font-size:0.78rem;color:var(--c-text-dim);margin-top:2px;">${h(r.page || '')} · ${r.times}× · last ${h(new Date(r.last_seen).toLocaleString())}</span></span></div>`).join('')
        : '<p style="font-size:0.84rem;">✅ No errors reported this week.</p>'}`;
  }

  // admin section
  async function renderAdmin() {
    const box = document.getElementById('ac-admin');
    if (!box) return;
    const { data: reports, error } = await sb().from('reports').select('*').eq('status', 'open').order('created_at');
    if (error) { box.innerHTML = `<p style="color:var(--c-danger-text);">Could not load reports: ${h(error.message)}</p>`; return; }
    const shipIds = reports.filter(r => r.target_type === 'ship').map(r => r.target_id);
    const userIds = [...new Set([...reports.filter(r => r.target_type === 'user').map(r => r.target_id), ...reports.map(r => r.reporter_id).filter(Boolean)])];
    const ships = {};
    for (const id of new Set(shipIds)) {
      const { data } = await sb().rpc('admin_get_ship', { p_ship: id });
      if (data && data[0]) { ships[id] = data[0]; userIds.push(data[0].user_id); }
    }
    const { data: profs } = userIds.length ? await sb().from('profiles').select('id, username').in('id', [...new Set(userIds)]) : { data: [] };
    const nameOf = id => (profs || []).find(p => p.id === id)?.username || 'unknown user';

    box.innerHTML = `
      <hr style="border-color:var(--c-border);margin:24px 0;">
      <h3 style="margin:0 0 6px;">Moderation</h3>
      ${reports.length ? reports.map(r => {
        const ship = ships[r.target_id];
        const target = r.target_type === 'ship'
          ? (ship ? `Ship “${h(ship.name)}” by ${h(nameOf(ship.user_id))}${ship.hidden_at ? ' <em>(hidden)</em>' : ''}` : 'A ship that no longer exists')
          : `User “${h(nameOf(r.target_id))}”`;
        return `<div class="list-row" data-id="${h(r.id)}" style="margin-bottom:8px;flex-wrap:wrap;gap:8px;align-items:flex-start;">
          <span class="list-row__label" style="flex-basis:100%;">${target}
            <span style="display:block;font-size:0.82rem;color:var(--c-text-mid);margin-top:4px;">“${h(r.reason)}” — reported by ${h(nameOf(r.reporter_id))}, ${h(new Date(r.created_at).toLocaleString())}</span></span>
          ${r.target_type === 'ship' && ship ? `
            <a class="btn btn-secondary btn-sm" href="${h(window.EsLinks.ship(ship.id))}" target="_blank" rel="noopener">View</a>
            <button class="btn btn-danger btn-sm" data-act="${ship.hidden_at ? 'unhide' : 'hide'}" data-ship="${h(ship.id)}">${ship.hidden_at ? 'Unhide ship' : 'Hide ship'}</button>` : ''}
          ${r.target_type === 'user' ? `<button class="btn btn-danger btn-sm" data-act="reset" data-user="${h(r.target_id)}">Reset username</button>` : ''}
          <button class="btn btn-secondary btn-sm" data-act="resolved">Mark resolved</button>
          <button class="btn btn-secondary btn-sm" data-act="dismissed">Dismiss</button>
        </div>`;
      }).join('') : '<p style="color:var(--c-text-dim);">No open reports.</p>'}`;

    box.onclick = async e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const reportId = b.closest('[data-id]').dataset.id;
      let res;
      if (b.dataset.act === 'hide') {
        const reason = prompt('Reason shown to the owner (optional):', '') ?? null;
        if (reason === null) return;
        res = await sb().rpc('admin_set_ship_hidden', { p_ship: b.dataset.ship, p_hidden: true, p_reason: reason || null });
      } else if (b.dataset.act === 'unhide') {
        res = await sb().rpc('admin_set_ship_hidden', { p_ship: b.dataset.ship, p_hidden: false, p_reason: null });
      } else if (b.dataset.act === 'reset') {
        if (!confirm('Replace this user’s username with a generic one?')) return;
        res = await sb().rpc('admin_reset_username', { p_user: b.dataset.user });
        if (!res.error) say(`Username changed to ${res.data}.`, 'success');
      } else {
        res = await sb().rpc('admin_resolve_report', { p_report: reportId, p_status: b.dataset.act });
      }
      if (res.error) return say(res.error.message, 'danger');
      renderAdmin();
    };
  }

  A.onAuthChange(() => render());
})();
