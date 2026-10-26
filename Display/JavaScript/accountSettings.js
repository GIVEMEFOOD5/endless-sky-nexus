'use strict';

// Account settings form (username, email, password).

(function () {

// message under the form
function showMessage(elId, message, isError) {
    const box = document.getElementById(elId);
    if (!box) return;
    box.innerHTML = message
        ? `<div class="${isError ? 'auth-form-error' : 'auth-form-success'}">${message}</div>`
        : '';
}

// button busy state
function setButtonLoading(btn, loading, defaultLabel) {
    if (!btn) return;
    btn.disabled = loading;
    btn.textContent = loading ? 'Saving…' : defaultLabel;
}

// fill the form
function render(user, profile) {
    const loggedOut = document.getElementById('account-logged-out');
    const loggedIn = document.getElementById('account-logged-in');
    if (!loggedOut || !loggedIn) return;

    if (!user) {
        loggedOut.style.display = 'block';
        loggedIn.style.display = 'none';
        return;
    }
    loggedOut.style.display = 'none';
    loggedIn.style.display = 'block';

    const usernameField = document.getElementById('account-username');
    const emailField = document.getElementById('account-email');
    // don't overwrite what you're typing
    if (!usernameField.dataset.touched) usernameField.value = profile?.username || '';
    if (!emailField.dataset.touched) emailField.value = user.email || '';
}

document.getElementById('account-username').addEventListener('input', e => { e.target.dataset.touched = '1'; });
document.getElementById('account-email').addEventListener('input', e => { e.target.dataset.touched = '1'; });

window.EsAuth.onAuthChange(render);

// ── Live username availability check, same pattern as the signup form ──
const usernameInput = document.getElementById('account-username');
const usernameHint = document.getElementById('account-username-hint');
let usernameCheckTimer = null;
usernameInput.addEventListener('input', () => {
    const value = usernameInput.value.trim();
    clearTimeout(usernameCheckTimer);
    const currentUsername = window.EsAuth.getCurrentProfile()?.username;
    if (value.length < 3 || value === currentUsername) { usernameHint.textContent = ''; usernameHint.className = 'auth-field-hint'; return; }
    usernameHint.textContent = 'Checking…';
    usernameHint.className = 'auth-field-hint auth-field-hint--checking';
    usernameCheckTimer = setTimeout(() => {
        window.EsAuth.isUsernameAvailable(value).then(available => {
            if (usernameInput.value.trim() !== value) return; // stale
            usernameHint.textContent = available ? '✓ Available' : '✗ Already taken';
            usernameHint.className = 'auth-field-hint ' + (available ? 'auth-field-hint--ok' : 'auth-field-hint--bad');
        }).catch(() => { usernameHint.textContent = ''; usernameHint.className = 'auth-field-hint'; });
    }, 350);
});

// ── Save username ──
document.getElementById('account-username-save').addEventListener('click', async () => {
    const btn = document.getElementById('account-username-save');
    const value = usernameInput.value.trim();
    showMessage('account-username-error', '');
    if (value.length < 3) { showMessage('account-username-error', 'Username needs to be at least 3 characters.', true); return; }

    setButtonLoading(btn, true, 'Save Username');
    try {
        await window.EsAuth.updateUsername(value);
        showMessage('account-username-error', 'Username updated!', false);
        usernameInput.dataset.touched = '';
    } catch (err) {
        showMessage('account-username-error', err.message || 'Could not update username.', true);
    } finally {
        setButtonLoading(btn, false, 'Save Username');
    }
});

// ── Update email ──
document.getElementById('account-email-save').addEventListener('click', async () => {
    const btn = document.getElementById('account-email-save');
    const value = document.getElementById('account-email').value.trim();
    showMessage('account-email-error', '');
    if (!value) { showMessage('account-email-error', 'Enter an email address.', true); return; }

    setButtonLoading(btn, true, 'Update Email');
    try {
        await window.EsAuth.updateEmail(value);
        showMessage('account-email-error', 'Check your new email to confirm the change.', false);
    } catch (err) {
        showMessage('account-email-error', err.message || 'Could not update email.', true);
    } finally {
        setButtonLoading(btn, false, 'Update Email');
    }
});

// ── Save password ──
document.getElementById('account-password-save').addEventListener('click', async () => {
    const btn = document.getElementById('account-password-save');
    const newPassword = document.getElementById('account-new-password').value;
    const confirmPassword = document.getElementById('account-confirm-password').value;
    showMessage('account-password-error', '');

    if (newPassword.length < 6) { showMessage('account-password-error', 'Password needs to be at least 6 characters.', true); return; }
    if (newPassword !== confirmPassword) { showMessage('account-password-error', "Passwords don't match.", true); return; }

    setButtonLoading(btn, true, 'Save Password');
    try {
        await window.EsAuth.updatePassword(newPassword);
        showMessage('account-password-error', 'Password updated!', false);
        document.getElementById('account-new-password').value = '';
        document.getElementById('account-confirm-password').value = '';
    } catch (err) {
        showMessage('account-password-error', err.message || 'Could not update password.', true);
    } finally {
        setButtonLoading(btn, false, 'Save Password');
    }
});

})();