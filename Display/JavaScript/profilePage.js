'use strict';

// A pilot's public profile page and their shared ships.

(async function () {
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const $ = id => document.getElementById(id);
  const wanted = (new URLSearchParams(location.search).get('u') || '').trim();
  const grid = $('pf-ships');

  if (!wanted) {
    $('pf-title').textContent = '👤 Pilot Profile';
    grid.innerHTML = '<p style="color:var(--c-text-dim);">No pilot chosen. Open a profile from a shared ship.</p>';
    return;
  }
  // usernames are unique ignoring case, so match that way
  const { data: profiles, error } = await window.supabaseClient.from('profiles').select('id, username').ilike('username', wanted.replace(/[\\%_]/g, c => '\\' + c));
  const profile = (profiles || []).find(p => p.username.toLowerCase() === wanted.toLowerCase());
  if (error || !profile) {
    $('pf-title').textContent = '👤 Pilot not found';
    $('pf-sub').textContent = `There is no pilot called “${wanted}”.`;
    grid.innerHTML = '';
    return;
  }
  document.title = `${profile.username} — Pilot Profile — Endless Sky Nexus`;
  $('pf-title').textContent = `👤 ${profile.username}`;

  await window.EsAuth.ready();
  const me = window.EsAuth.getCurrentUser();
  $('pf-actions').innerHTML = me && me.id === profile.id
    ? '<a class="btn btn-secondary btn-sm" href="UserManager.html">Manage which ships are public</a>'
    : '<button class="btn btn-secondary btn-sm" id="pf-report">Report this pilot</button>';
  const rep = $('pf-report');
  if (rep) rep.onclick = () => window.EsReport.open({ type: 'user', id: profile.id, label: profile.username });

  const { data: ships, error: shipErr } = await window.supabaseClient.from('saved_ships')
    .select('id, name, build_data, updated_at').eq('user_id', profile.id).eq('is_public', true).order('updated_at', { ascending: false });
  if (shipErr) { grid.innerHTML = `<p style="color:var(--c-danger-text);">Could not load ships: ${h(shipErr.message)}</p>`; return; }
  if (!ships.length) { grid.innerHTML = '<p style="color:var(--c-text-dim);">This pilot hasn’t shared any ships yet.</p>'; return; }

  if (window.PluginAvailability) await window.PluginAvailability.ready;
  grid.innerHTML = ships.map(s => {
    const b = s.build_data || {}, a = b.attributes || {};
    const link = new URL('shipBuilder.html', location.href); link.searchParams.set('shared', s.id);
    return `<div class="fleet-card">
      <div class="fleet-card__name">${h(s.name)}${window.PluginAvailability ? window.PluginAvailability.badgeHtml(b) : ''}</div>
      <div class="fleet-card__variant">${h(b._sourceShip || '')}</div>
      <div class="fleet-card__stats">
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Category</div><div class="fleet-card__stat-value" style="font-size:0.8rem;">${h(a.category || '—')}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Shields</div><div class="fleet-card__stat-value">${h(a.shields || '—')}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Hull</div><div class="fleet-card__stat-value">${h(a.hull || '—')}</div></div>
        <div class="fleet-card__stat"><div class="fleet-card__stat-label">Updated</div><div class="fleet-card__stat-value" style="font-size:0.8rem;">${h(new Date(s.updated_at).toLocaleDateString())}</div></div>
      </div>
      <div class="fleet-card__actions"><a class="btn btn-primary btn-sm" href="${h(link.href)}">Open in ship builder</a>
        ${me && me.id === profile.id ? '' : `<button class="btn btn-secondary btn-sm" data-report="${h(s.id)}" data-name="${h(s.name)}">Report</button>`}</div>
    </div>`;
  }).join('');
  grid.onclick = e => {
    const b = e.target.closest('[data-report]');
    if (b) window.EsReport.open({ type: 'ship', id: b.dataset.report, label: b.dataset.name });
  };
})();
