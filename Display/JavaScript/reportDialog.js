'use strict';

// The "Report" window for flagging a shared ship or profile.

(function () {
  const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let current = null;

  // add the window once
  function ensure() {
    let m = document.getElementById('es-report-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'es-report-modal';
    m.className = 'modal-overlay';
    m.innerHTML = `
      <div class="modal-box" style="width:min(440px,96vw);">
        <div class="modal-header"><div class="modal-title" id="es-report-title">Report</div>
          <button class="modal-close" data-close aria-label="Close">×</button></div>
        <div id="es-report-body"></div>
      </div>`;
    m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) m.classList.remove('active'); });
    document.body.appendChild(m);
    return m;
  }

  // open it
  function open(target) {
    current = target;
    const m = ensure();
    const user = window.EsAuth && window.EsAuth.getCurrentUser();
    document.getElementById('es-report-title').textContent = target.type === 'ship' ? `Report “${target.label}”` : `Report ${target.label}`;
    const body = document.getElementById('es-report-body');
    if (!user) {
      body.innerHTML = `<p style="color:var(--c-text-mid);">Log in to report ${target.type === 'ship' ? 'a ship' : 'a user'}.</p>
        <div class="btn-group btn-group-right"><button class="btn btn-secondary" data-close>Cancel</button>
        <button class="btn btn-primary" id="es-report-login">Log in</button></div>`;
      document.getElementById('es-report-login').onclick = () => { m.classList.remove('active'); window.openAuthModal && window.openAuthModal('signin'); };
    } else {
      body.innerHTML = `
        <p style="color:var(--c-text-mid);margin-top:0;">Tell the moderators what's wrong, for example an offensive name or description.</p>
        <textarea id="es-report-reason" class="text-input" rows="4" maxlength="1000" style="width:100%;resize:vertical;"></textarea>
        <div id="es-report-error" style="margin-top:8px;"></div>
        <div class="btn-group btn-group-right"><button class="btn btn-secondary" data-close>Cancel</button>
          <button class="btn btn-danger" id="es-report-send">Send report</button></div>`;
      document.getElementById('es-report-send').onclick = send;
      setTimeout(() => document.getElementById('es-report-reason').focus(), 30);
    }
    m.classList.add('active');
  }

  // send the report
  async function send() {
    const reason = document.getElementById('es-report-reason').value.trim();
    const err = document.getElementById('es-report-error');
    if (reason.length < 3) { err.innerHTML = '<div class="auth-form-error">Add a few words about the problem.</div>'; return; }
    const btn = document.getElementById('es-report-send');
    btn.disabled = true; btn.textContent = 'Sending…';
    const { error } = await window.supabaseClient.from('reports').insert({
      target_type: current.type, target_id: String(current.id), reason,
    });
    if (error) {
      err.innerHTML = `<div class="auth-form-error">${h(error.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Send report';
      return;
    }
    document.getElementById('es-report-body').innerHTML =
      '<p class="auth-form-success">Thanks — a moderator will take a look.</p><div class="btn-group btn-group-right"><button class="btn btn-secondary" data-close>Close</button></div>';
  }

  window.EsReport = { open };
})();
