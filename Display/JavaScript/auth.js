'use strict';

// Login, sign-up and account settings (Supabase auth), plus syncing your selected plugins to your account.

(function () {

let _currentUser = null;
let _currentProfile = null; // { username } — fetched once per session, cached
let _authReadyResolve;
const _authReady = new Promise(resolve => { _authReadyResolve = resolve; });
const _listeners = [];
let _isAdmin = null, _adminCheckedFor = null;   // see isAdmin()

// load the profile row
async function _loadProfile(userId) {
    if (!userId) { _currentProfile = null; return; }
    try {
        const { data } = await window.supabaseClient
            .from('profiles').select('username').eq('id', userId).maybeSingle();
        _currentProfile = data || null;
    } catch (_) {
        _currentProfile = null;
    }
}

// tell listeners the user changed
function _fireAuthChange() {
    for (const fn of _listeners) {
        try { fn(_currentUser, _currentProfile); } catch (e) { console.error('[Auth] listener error:', e); }
    }
}

// getSession() reads the persisted session token — cheap, no network
// round trip in the common case — so this resolves fast on every page.
window.supabaseClient.auth.getSession().then(async ({ data }) => {
    _currentUser = data?.session?.user ?? null;
    await _loadProfile(_currentUser?.id);
    _authReadyResolve();
    _fireAuthChange();
});

let _inPasswordRecovery = false;
window.supabaseClient.auth.onAuthStateChange(async (event, session) => {
    _currentUser = session?.user ?? null;
    if (_currentUser?.id !== _adminCheckedFor) { _isAdmin = null; _adminCheckedFor = null; }
    await _loadProfile(_currentUser?.id);
    _fireAuthChange();
    // Arrived from a "reset your password" email link — the user is signed
    // in with a one-time session and needs to choose a new password now.
    if (event === 'PASSWORD_RECOVERY') {
        _inPasswordRecovery = true;
        window.dispatchEvent(new CustomEvent('es:passwordRecovery'));
    }
});

// is a username free? (for checking as you type)
async function isUsernameAvailable(username) {
    // Case-insensitive check on the server (user_management.sql); falls back
    // to an exact match if that function hasn't been installed yet.
    const { data, error } = await window.supabaseClient.rpc('username_available', { p_username: username });
    if (!error && typeof data === 'boolean') return data;
    const { data: row } = await window.supabaseClient
        .from('profiles').select('id').eq('username', username).maybeSingle();
    return !row || row.id === _currentUser?.id;
}

// message if a username isn't allowed, '' if fine
function usernameProblem(username) {
    const v = String(username || '').trim();
    if (v.length < 3) return 'Usernames need at least 3 characters.';
    if (v.length > 24) return 'Usernames can be at most 24 characters.';
    if (!/^[A-Za-z0-9_.-]+$/.test(v)) return 'Use only letters, numbers, dots, dashes and underscores.';
    return '';
}

// sign up
async function signUp(email, password, username) {
    if (username) {
        const problem = usernameProblem(username);
        if (problem) throw new Error(problem);
    }
    const { data, error } = await window.supabaseClient.auth.signUp({ email, password });
    if (error) throw error;
    if (data.user && username) {
        const { error: profileErr } = await window.supabaseClient
            .from('profiles').insert({ id: data.user.id, username });
        if (profileErr) {
            // someone may have taken the name a moment ago
            const err = new Error(
                profileErr.message.includes('duplicate') || profileErr.code === '23505'
                    ? 'That username was just taken — your account was created, but pick a different username to finish setting up your profile.'
                    : profileErr.message
            );
            err.isProfileError = true;
            throw err;
        }
        _currentProfile = { username };
    }
    return data.user;
}

// log in
async function signIn(email, password) {
    const { data, error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
}

// log out
async function signOut() {
    await window.supabaseClient.auth.signOut();
    // selected plugins are per browser — sync them on login
    try { localStorage.removeItem('es_sb_active_plugins'); } catch (_) { /* ignore */ }
}

// resolves once the session has been checked
async function ready() {
    await _authReady;
    return _currentUser;
}

// current user
function getCurrentUser() {
    return _currentUser;
}

// current profile
function getCurrentProfile() {
    return _currentProfile;
}

// username if set, else email
function getDisplayName() {
    return _currentProfile?.username || _currentUser?.email || null;
}

// listen for login/logout (fires once straight away)
function onAuthChange(fn) {
    _listeners.push(fn);
    if (_currentUser !== null || _listeners.length) fn(_currentUser);
}

// your saved plugin selection (null if signed out)
async function getActivePluginsPreference() {
    const user = await ready();
    if (!user) return null;
    const { data, error } = await window.supabaseClient
        .from('user_preferences').select('active_plugins').eq('user_id', user.id).maybeSingle();
    if (error || !data) return null;
    return data.active_plugins;
}

// save it (does nothing if signed out)
async function saveActivePluginsPreference(activePlugins) {
    const user = getCurrentUser();
    if (!user) return;
    try {
        await window.supabaseClient.from('user_preferences').upsert({
            user_id: user.id,
            active_plugins: activePlugins,
            updated_at: new Date().toISOString(),
        });
    } catch (err) {
        console.warn('[Auth] Could not sync active plugins to account:', err);
    }
}

// change username
async function updateUsername(newUsername) {
    const user = getCurrentUser();
    if (!user) throw new Error('You need to be logged in to do that.');
    const problem = usernameProblem(newUsername);
    if (problem) throw new Error(problem);
    newUsername = newUsername.trim();

    // upsert so a missing profile row is created
    const { error } = await window.supabaseClient
        .from('profiles').upsert({ id: user.id, username: newUsername });
    if (error) {
        throw new Error(
            error.code === '23505' || /duplicate/i.test(error.message)
                ? 'That username is already taken.'
                : error.message
        );
    }
    _currentProfile = { ..._currentProfile, username: newUsername };
    _fireAuthChange();
}

// change password
async function updatePassword(newPassword) {
    const user = getCurrentUser();
    if (!user) throw new Error('You need to be logged in to do that.');
    const { error } = await window.supabaseClient.auth.updateUser({ password: newPassword });
    if (error) throw error;
}

// change email (confirmation goes to the new address)
async function updateEmail(newEmail) {
    const user = getCurrentUser();
    if (!user) throw new Error('You need to be logged in to do that.');
    const { error } = await window.supabaseClient.auth.updateUser({ email: newEmail });
    if (error) throw error;
}

// "reset your password" email
async function requestPasswordReset(email) {
    const redirectTo = new URL('UserManager.html', window.location.href).href;
    const { error } = await window.supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
}
// in the middle of a password reset?
function isInPasswordRecovery() { return _inPasswordRecovery; }
// set the new password
function finishPasswordRecovery() { _inPasswordRecovery = false; }

// is this user an admin?
async function isAdmin() {
    const user = getCurrentUser();
    if (!user) return false;
    if (_adminCheckedFor === user.id && _isAdmin !== null) return _isAdmin;
    const { data, error } = await window.supabaseClient.rpc('is_admin');
    _isAdmin = !error && data === true;
    _adminCheckedFor = user.id;
    return _isAdmin;
}

// everything this account stores, for download
async function exportMyData() {
    const user = getCurrentUser();
    if (!user) throw new Error('You need to be logged in to do that.');
    const sb = window.supabaseClient;
    const pick = async (table, cols = '*', col = 'user_id') => {
        const { data, error } = await sb.from(table).select(cols).eq(col, user.id);
        return error ? { error: error.message } : data;
    };
    const saves = await pick('player_saves');
    const saveFiles = [];
    if (Array.isArray(saves)) {
        for (const s of saves) {
            const entry = { ...s };
            for (const kind of ['original', 'edited']) {
                if (kind === 'edited' && !s.has_edits) continue;
                const { data } = await sb.storage.from('saves').download(`${user.id}/${s.id}/${kind}.txt`);
                if (data) entry[`${kind}_text`] = await data.text();
            }
            saveFiles.push(entry);
        }
    }
    return {
        exportedAt: new Date().toISOString(),
        account: { id: user.id, email: user.email, created_at: user.created_at },
        profile: await pick('profiles', '*', 'id'),
        preferences: await pick('user_preferences'),
        fleets: await pick('fleets'),
        shared_ships: await pick('saved_ships'),
        saves: saveFiles,
        reports_filed: await pick('reports', '*', 'reporter_id'),
    };
}

// delete the account and everything in it
async function deleteMyAccount() {
    const user = getCurrentUser();
    if (!user) throw new Error('You need to be logged in to do that.');
    if (window.SaveVault) await window.SaveVault.deleteAllAccountFiles();
    const { error } = await window.supabaseClient.rpc('delete_my_account');
    if (error) throw error;
    await signOut();
}

window.EsAuth = {
    usernameProblem, requestPasswordReset, isInPasswordRecovery, finishPasswordRecovery,
    isAdmin, exportMyData, deleteMyAccount,
    signUp, signIn, signOut, ready, getCurrentUser, getCurrentProfile, getDisplayName,
    isUsernameAvailable, onAuthChange,
    updateUsername, updatePassword, updateEmail,
    getActivePluginsPreference, saveActivePluginsPreference,
};

})();
