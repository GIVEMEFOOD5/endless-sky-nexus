// The navigation bar on every page: dropdowns, mobile drawer, active link, login and account widget.

(function () {
  'use strict';

  // ── helpers ──
  function isDrawerOpen () {
    return document.querySelector('.es-nav__drawer') &&
           document.querySelector('.es-nav__drawer').classList.contains('nav-drawer-open');
  }

  // ── desktop dropdowns ──
  function closeAllDropdowns () {
    document.querySelectorAll('.es-nav__dropdown.open')
      .forEach(el => el.classList.remove('open'));
  }

  // keep a dropdown on screen
  function positionDropdown (dd) {
    const toggle = dd.querySelector('.es-nav__dropdown-toggle');
    const menu   = dd.querySelector('.es-nav__dropdown-menu');
    if (!toggle || !menu) return;
    const rect   = toggle.getBoundingClientRect();
    menu.style.top  = rect.bottom + 8 + 'px';
    menu.style.left = rect.left   + 'px';
  }

  document.querySelectorAll('.es-nav__dropdown').forEach(function (dd) {
    const btn = dd.querySelector('.es-nav__dropdown-toggle');
    if (!btn) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();

      // In drawer mode, dropdowns are not used — items are already flat
      if (isDrawerOpen()) return;

      const isOpen = dd.classList.contains('open');
      closeAllDropdowns();
      if (!isOpen) {
        dd.classList.add('open');
        positionDropdown(dd);
      }
    });
  });

  // Click outside: close dropdowns AND close drawer
  document.addEventListener('click', function (e) {
    const nav    = document.querySelector('.es-nav');
    const drawer = document.querySelector('.es-nav__drawer');

    if (!e.target.closest('.es-nav') && !e.target.closest('.es-nav__drawer')) {
      closeAllDropdowns();
      // Close drawer
      if (drawer) drawer.classList.remove('nav-drawer-open');
      if (nav)    nav.classList.remove('nav-open');
    }
  });

  // ── mobile menu button ──
  const hamburger = document.querySelector('.es-nav__hamburger');
  if (hamburger) {
    hamburger.addEventListener('click', function (e) {
      e.stopPropagation();
      const nav    = document.querySelector('.es-nav');
      const drawer = document.querySelector('.es-nav__drawer');
      const isOpen = drawer.classList.contains('nav-drawer-open');
      nav.classList.toggle('nav-open', !isOpen);
      drawer.classList.toggle('nav-drawer-open', !isOpen);
    });
  }

  // Clicking a flat link in the drawer closes it
  const drawer = document.querySelector('.es-nav__drawer');
  if (drawer) {
    drawer.addEventListener('click', function (e) {
      if (e.target.closest('.es-nav__link') || e.target.closest('.es-nav__dropdown-item')) {
        document.querySelector('.es-nav').classList.remove('nav-open');
        drawer.classList.remove('nav-drawer-open');
      }
    });
  }

  // ── mobile drawer (flat list) ──
  function buildDrawer () {
    const drawer = document.querySelector('.es-nav__drawer');
    if (!drawer) return;
    const frag = document.createDocumentFragment();

    document.querySelectorAll('#es-nav-links > li').forEach(function (li) {
      if (li.classList.contains('es-nav__dropdown')) {
        // Group label
        const toggle = li.querySelector('.es-nav__dropdown-toggle');
        const label  = document.createElement('div');
        label.className   = 'nav-drawer-group-label';
        label.textContent = toggle ? toggle.textContent.trim() : '';
        frag.appendChild(label);

        // Flatten every sub-item directly into the drawer — no nested menu
        li.querySelectorAll('.es-nav__dropdown-item').forEach(function (item) {
          const a = document.createElement('a');
          a.href         = item.getAttribute('href');
          a.className    = 'es-nav__link';
          a.dataset.page = item.dataset.page || '';
          a.innerHTML    = item.innerHTML;
          frag.appendChild(a);
        });

        const sep = document.createElement('div');
        sep.className = 'nav-drawer-sep';
        frag.appendChild(sep);

      } else {
        const orig = li.querySelector('.es-nav__link');
        if (!orig) return;
        const a = document.createElement('a');
        a.href         = orig.getAttribute('href') || '#';
        a.className    = 'es-nav__link';
        a.dataset.page = orig.dataset.page || '';
        a.innerHTML    = orig.innerHTML;
        frag.appendChild(a);
      }
    });

    drawer.appendChild(frag);
  }

  // ── highlight the current page ──
  function markActive () {
    const page = location.pathname.split('/').pop().replace(/\.html$/i, '').toLowerCase();

    // Clear all active states first
    document.querySelectorAll('.es-nav .active, .es-nav__drawer .active')
      .forEach(function (el) { el.classList.remove('active'); });

    // Mark any link whose data-page matches the current filename
    var matched = false;
    document.querySelectorAll('[data-page]').forEach(function (el) {
      if ((el.dataset.page || '').toLowerCase() === page) {
        el.classList.add('active');
        matched = true;

        // If this item is inside a dropdown menu, also highlight the toggle
        var menu = el.closest('.es-nav__dropdown-menu');
        if (menu) {
          var toggle = el.closest('.es-nav__dropdown')
                         .querySelector('.es-nav__dropdown-toggle');
          if (toggle) toggle.classList.add('active');
        }
      }
    });
  }

  // ── start ──
  buildDrawer();
  markActive();

  // ── account widget ──
  function waitForAuth(retriesLeft) {
    if (window.EsAuth) { initAccountWidget(); return; }
    if (retriesLeft <= 0) return; // no auth.js on this page — nothing to do
    setTimeout(function () { waitForAuth(retriesLeft - 1); }, 100);
  }

  // set up the account widget
  function initAccountWidget() {
    var mount    = document.getElementById('es-nav-account');
    var overlay  = document.getElementById('es-nav-auth-overlay');
    var closeBtn = document.getElementById('es-nav-auth-close');
    var tabs     = overlay ? overlay.querySelectorAll('.modal-tab') : [];
    var signinForm = document.getElementById('es-nav-signin-form');
    var signupForm = document.getElementById('es-nav-signup-form');
    if (!mount || !overlay || !signinForm || !signupForm) return;

    // open the login / sign-up window
    function openModal(mode) {
      setMode(mode || 'signin');
      overlay.classList.add('active');
      var firstInput = (mode === 'signup' ? signupForm : signinForm).querySelector('input');
      if (firstInput) setTimeout(function () { firstInput.focus(); }, 50);
    }
    // Lets other files (e.g. shipBuilder.js's "save to account" flow)
    // trigger the login modal directly rather than duplicating it.
    window.openAuthModal = openModal;
    // close it
    function closeModal() {
      overlay.classList.remove('active');
      signinForm.reset();
      signupForm.reset();
      setFieldError('signin', '');
      setFieldError('signup', '');
      setUsernameHint('', '');
    }
    // login or sign-up mode
    function setMode(mode) {
      tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === mode); });
      signinForm.style.display = mode === 'signin' ? 'block' : 'none';
      signupForm.style.display = mode === 'signup' ? 'block' : 'none';
      overlay.querySelector('[data-mode-for="signin"]').style.display = mode === 'signin' ? 'inline' : 'none';
      overlay.querySelector('[data-mode-for="signup"]').style.display = mode === 'signup' ? 'inline' : 'none';
    }

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { setMode(tab.dataset.tab); });
    });
    overlay.querySelectorAll('[data-switch-to]').forEach(function (btn) {
      btn.addEventListener('click', function () { setMode(btn.dataset.switchTo); });
    });
    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('active')) closeModal();
    });

    // error under a field
    function setFieldError(form, message, isSuccess) {
      var box = document.getElementById('es-nav-' + form + '-error');
      if (!box) return;
      if (!message) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="' + (isSuccess ? 'auth-form-success' : 'auth-form-error') + '">' + message + '</div>';
    }

    // username hint
    function setUsernameHint(text, kind) {
      var hint = document.getElementById('es-nav-signup-username-hint');
      if (!hint) return;
      hint.textContent = text;
      hint.className = 'auth-field-hint' + (kind ? ' auth-field-hint--' + kind : '');
    }

    // button busy state
    function setLoading(form, loading, defaultLabel) {
      var btn = form.querySelector('button[type="submit"]');
      if (!btn) return;
      btn.disabled = loading;
      btn.textContent = loading ? 'Please wait…' : defaultLabel;
    }

    // Live username availability check, debounced so it doesn't fire a
    // Supabase query on every single keystroke.
    var usernameInput = document.getElementById('es-nav-signup-username');
    var usernameCheckTimer = null;
    usernameInput.addEventListener('input', function () {
      var value = usernameInput.value.trim();
      clearTimeout(usernameCheckTimer);
      if (value.length < 3) { setUsernameHint('', ''); return; }
      var problem = window.EsAuth.usernameProblem ? window.EsAuth.usernameProblem(value) : '';
      if (problem) { setUsernameHint(problem, 'bad'); return; }
      setUsernameHint('Checking…', 'checking');
      usernameCheckTimer = setTimeout(function () {
        window.EsAuth.isUsernameAvailable(value).then(function (available) {
          if (usernameInput.value.trim() !== value) return; // stale — value changed since the check started
          setUsernameHint(available ? '✓ Available' : '✗ Already taken', available ? 'ok' : 'bad');
        }).catch(function () { setUsernameHint('', ''); });
      }, 350);
    });

    // on phones the top-bar widget hides; the drawer has its own
    var drawer = document.querySelector('.es-nav__drawer');
    var drawerMount = null;
    if (drawer) {
      drawerMount = document.createElement('div');
      drawerMount.id = 'es-nav-drawer-account';
      drawerMount.className = 'nav-drawer-account';
      drawer.appendChild(drawerMount);
    }

    // logged-out widget
    function renderSignedOut() {
      mount.innerHTML = '<button type="button" class="es-nav__link" id="es-nav-login-btn">👤 Log in</button>';
      document.getElementById('es-nav-login-btn').addEventListener('click', function () { openModal('signin'); });

      if (drawerMount) {
        drawerMount.innerHTML = '<button type="button" class="es-nav__link" id="es-nav-drawer-login-btn">👤 Log in</button>';
        document.getElementById('es-nav-drawer-login-btn').addEventListener('click', function () {
          closeDrawerIfOpen();
          openModal('signin');
        });
      }
      scheduleNavOverflowCheck();
    }

    // logged-in widget
    function renderSignedIn(user, profile) {
      // "Log out" text, no username in the top bar
      mount.innerHTML = '<button type="button" class="es-nav__link" id="es-nav-account-btn">👤 Log out</button>';
      document.getElementById('es-nav-account-btn').addEventListener('click', promptLogoutConfirm);

      if (drawerMount) {
        var name = (profile && profile.username) || user.email || 'Account';
        drawerMount.innerHTML =
          '<span class="nav-drawer-account-email" title="' + name + '">👤 ' + name + '</span>' +
          '<button type="button" class="es-nav__link" id="es-nav-drawer-logout-btn">Log out</button>';
        document.getElementById('es-nav-drawer-logout-btn').addEventListener('click', promptLogoutConfirm);
      }
      scheduleNavOverflowCheck();
    }

    // "really log out?" (top bar and drawer)
    function promptLogoutConfirm() {
      closeDrawerIfOpen();
      var overlay = document.getElementById('es-nav-logout-confirm-overlay');
      if (!overlay) { window.EsAuth.signOut(); return; } // fallback if the markup's missing somehow
      overlay.classList.add('active');
    }

    var logoutOverlay = document.getElementById('es-nav-logout-confirm-overlay');
    if (logoutOverlay) {
      document.getElementById('es-nav-logout-cancel').addEventListener('click', function () {
        logoutOverlay.classList.remove('active');
      });
      document.getElementById('es-nav-logout-confirm').addEventListener('click', function () {
        overlay_signOutAndClose();
      });
      logoutOverlay.addEventListener('click', function (e) {
        if (e.target === logoutOverlay) logoutOverlay.classList.remove('active');
      });
    }
    // log out and close the drawer
    function overlay_signOutAndClose() {
      window.EsAuth.signOut();
      if (logoutOverlay) logoutOverlay.classList.remove('active');
    }

    // close the drawer before opening the login window
    function closeDrawerIfOpen() {
      var d = document.querySelector('.es-nav__drawer');
      var nav = document.querySelector('.es-nav');
      if (d) d.classList.remove('nav-drawer-open');
      if (nav) nav.classList.remove('nav-open');
    }

    window.EsAuth.onAuthChange(function (user, profile) {
      if (user) renderSignedIn(user, profile); else renderSignedOut();
      updateProfileLinks(user, profile || window.EsAuth.getCurrentProfile());
    });

    // "My Profile" links point at your profile
    function updateProfileLinks(user, profile) {
      document.querySelectorAll('[data-page="Profile"]').forEach(function (a) {
        if (!user) { a.style.display = 'none'; return; }
        a.style.display = '';
        a.href = profile && profile.username
          ? 'Profile.html?u=' + encodeURIComponent(profile.username)
          : 'UserManager.html';
      });
    }

    // ── forgot password / new password / choose username ──
    function byId(id) { return document.getElementById(id); }
    // show one of the account boxes
    function showBox(id, message, ok) {
      var box = byId(id); if (!box) return;
      box.innerHTML = message ? '<div class="' + (ok ? 'auth-form-success' : 'auth-form-error') + '">' + message + '</div>' : '';
    }
    ['es-nav-forgot-overlay', 'es-nav-username-overlay'].forEach(function (id) {
      var o = byId(id); if (!o) return;
      o.querySelectorAll('[data-close-overlay]').forEach(function (b) { b.addEventListener('click', function () { o.classList.remove('active'); }); });
      o.addEventListener('click', function (e) { if (e.target === o) o.classList.remove('active'); });
    });

    var forgotBtn = byId('es-nav-forgot-btn');
    var forgotForm = byId('es-nav-forgot-form');
    if (forgotBtn && forgotForm) {
      forgotBtn.addEventListener('click', function () {
        var typed = byId('es-nav-signin-email').value.trim();
        closeModal();
        showBox('es-nav-forgot-error', '');
        byId('es-nav-forgot-email').value = typed;
        byId('es-nav-forgot-overlay').classList.add('active');
        setTimeout(function () { byId('es-nav-forgot-email').focus(); }, 50);
      });
      forgotForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var email = byId('es-nav-forgot-email').value.trim();
        setLoading(forgotForm, true, 'Send reset link');
        window.EsAuth.requestPasswordReset(email)
          .then(function () { showBox('es-nav-forgot-error', 'If that email has an account, a reset link is on its way. Check your inbox.', true); })
          .catch(function (err) { showBox('es-nav-forgot-error', err.message || 'Could not send the reset link — try again.'); })
          .finally(function () { setLoading(forgotForm, false, 'Send reset link'); });
      });
    }

    var newPassOverlay = byId('es-nav-newpass-overlay');
    var newPassForm = byId('es-nav-newpass-form');
    // "set a new password" box
    function openNewPassword() {
      if (!newPassOverlay) return;
      showBox('es-nav-newpass-error', '');
      newPassOverlay.classList.add('active');
      setTimeout(function () { byId('es-nav-newpass-1').focus(); }, 50);
    }
    window.addEventListener('es:passwordRecovery', openNewPassword);
    if (window.EsAuth.isInPasswordRecovery && window.EsAuth.isInPasswordRecovery()) openNewPassword();
    if (newPassForm) newPassForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var a = byId('es-nav-newpass-1').value, b = byId('es-nav-newpass-2').value;
      if (a.length < 6) { showBox('es-nav-newpass-error', 'Passwords need at least 6 characters.'); return; }
      if (a !== b) { showBox('es-nav-newpass-error', "Passwords don't match."); return; }
      setLoading(newPassForm, true, 'Save new password');
      window.EsAuth.updatePassword(a)
        .then(function () {
          window.EsAuth.finishPasswordRecovery();
          showBox('es-nav-newpass-error', 'Password changed. You are logged in.', true);
          newPassForm.reset();
          setTimeout(function () { newPassOverlay.classList.remove('active'); }, 1200);
        })
        .catch(function (err) { showBox('es-nav-newpass-error', err.message || 'Could not change the password — try again.'); })
        .finally(function () { setLoading(newPassForm, false, 'Save new password'); });
    });

    var unameOverlay = byId('es-nav-username-overlay');
    var unameForm = byId('es-nav-username-form');
    var unameInput = byId('es-nav-username-input');
    // ask for a username if missing
    function maybeAskUsername() {
      if (!unameOverlay) return;
      var user = window.EsAuth.getCurrentUser();
      var profile = window.EsAuth.getCurrentProfile();
      if (!user || (profile && profile.username)) { unameOverlay.classList.remove('active'); return; }
      if (sessionStorage.getItem('es_username_prompt_dismissed') === user.id) return;
      if (window.EsAuth.isInPasswordRecovery && window.EsAuth.isInPasswordRecovery()) return;
      unameOverlay.classList.add('active');
    }
    if (unameOverlay) {
      unameOverlay.querySelectorAll('[data-close-overlay]').forEach(function (b) {
        b.addEventListener('click', function () {
          var u = window.EsAuth.getCurrentUser(); if (u) sessionStorage.setItem('es_username_prompt_dismissed', u.id);
        });
      });
      window.EsAuth.ready().then(function () {
        maybeAskUsername();
        window.EsAuth.onAuthChange(function () { maybeAskUsername(); });
      });
      var unameTimer = null;
      unameInput.addEventListener('input', function () {
        var v = unameInput.value.trim(), hint = byId('es-nav-username-hint');
        clearTimeout(unameTimer);
        var problem = window.EsAuth.usernameProblem(v);
        if (problem) { hint.textContent = v.length ? problem : ''; hint.className = 'auth-field-hint' + (v.length ? ' auth-field-hint--bad' : ''); return; }
        hint.textContent = 'Checking…'; hint.className = 'auth-field-hint auth-field-hint--checking';
        unameTimer = setTimeout(function () {
          window.EsAuth.isUsernameAvailable(v).then(function (ok) {
            if (unameInput.value.trim() !== v) return;
            hint.textContent = ok ? '✓ Available' : '✗ Already taken';
            hint.className = 'auth-field-hint ' + (ok ? 'auth-field-hint--ok' : 'auth-field-hint--bad');
          });
        }, 350);
      });
      unameForm.addEventListener('submit', function (e) {
        e.preventDefault();
        setLoading(unameForm, true, 'Save username');
        window.EsAuth.updateUsername(unameInput.value)
          .then(function () { unameOverlay.classList.remove('active'); })
          .catch(function (err) { showBox('es-nav-username-error', err.message || 'Could not save that username.'); })
          .finally(function () { setLoading(unameForm, false, 'Save username'); });
      });
    }

    signinForm.addEventListener('submit', function (e) {
      e.preventDefault();
      setFieldError('signin', '');
      var email = document.getElementById('es-nav-signin-email').value.trim();
      var password = document.getElementById('es-nav-signin-password').value;

      setLoading(signinForm, true, 'Log in');
      window.EsAuth.signIn(email, password)
        .then(function () { closeModal(); })
        .catch(function (err) {
          setFieldError('signin', err.message || 'Could not log in — check your email and password.');
        })
        .finally(function () { setLoading(signinForm, false, 'Log in'); });
    });

    signupForm.addEventListener('submit', function (e) {
      e.preventDefault();
      setFieldError('signup', '');
      var username = usernameInput.value.trim();
      var email = document.getElementById('es-nav-signup-email').value.trim();
      var password = document.getElementById('es-nav-signup-password').value;
      var confirm = document.getElementById('es-nav-signup-password-confirm').value;

      if (password !== confirm) {
        setFieldError('signup', "Passwords don't match.");
        return;
      }

      setLoading(signupForm, true, 'Create account');
      window.EsAuth.signUp(email, password, username)
        .then(function () {
          setFieldError('signup', 'Account created! You\'re logged in.', true);
          setTimeout(closeModal, 900);
        })
        .catch(function (err) {
          // account made, only the username failed
          setFieldError('signup', err.message || 'Could not create an account — try again.');
        })
        .finally(function () { setLoading(signupForm, false, 'Create account'); });
    });
  }

  waitForAuth(30); // ~3 seconds total before giving up

  // ── collapse the bar when it doesn't fit ──
  var navOverflowCheckTimer = null;
  // does the bar fit?
  function checkNavOverflow() {
    var nav = document.querySelector('.es-nav');
    if (!nav) return;
    // measure with everything shown first
    nav.classList.remove('es-nav--collapsed');
    var overflowing = nav.scrollWidth > nav.clientWidth + 1; // +1: rounding tolerance
    if (overflowing) nav.classList.add('es-nav--collapsed');
  }
  // check it soon
  function scheduleNavOverflowCheck() {
    clearTimeout(navOverflowCheckTimer);
    navOverflowCheckTimer = setTimeout(checkNavOverflow, 50);
  }
  window.addEventListener('resize', scheduleNavOverflowCheck);
  window.addEventListener('load', scheduleNavOverflowCheck);
  scheduleNavOverflowCheck(); // initial check — covers the case where auth.js isn't on
                              // this page at all, so renderSignedIn/Out never fire

})();
