/* ═══════════════════════════════════════════════════════════════
   pluginManager.js  —  Endless Sky Plugin Manager
   Fetches plugins.json on page load, lets the user add / edit /
   remove entries, then saves back via the Vercel backend.

   Two lists:
     _plugins  — already committed to plugins.json (Active Plugins)
     _pending  — added this session, not yet saved (Awaiting Save)

   Also polls parse-status.json to show when the GitHub Action is
   running, and blocks saves during that window.

   Entries can be one of two types:
     "git"     — a GitHub repository, cloned by the parser via git
     "archive" — a .zip/.tar/.tar.gz/.tgz/.tar.bz2 uploaded through
                 this page straight to Vercel Blob storage, then
                 committed into rawData/ in the repo. May contain
                 multiple plugins; the parser detects all of them.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// This project has no build step (plain <script> tags, no bundler), so we
// can't use a bare "@vercel/blob/client" specifier — browsers can't resolve
// that without a bundler. esm.sh re-serves npm packages as browser-ready
// ESM, so this works with zero build tooling. Pin the version so a future
// @vercel/blob release can't silently change behaviour under you — and
// keep this in sync with the @vercel/blob version in the Vercel project's
// package.json. A mismatch between client and server versions here caused
// a 400 Bad Request on the direct-to-storage upload in earlier testing.
import { upload } from 'https://esm.sh/@vercel/blob@2.6.1/client';

/* ── Paths ───────────────────────────────────────────────────── */
const PLUGINS_JSON_PATH = 'https://raw.githubusercontent.com/givemefood5/endless-sky-nexus/main/plugins.json';
const PARSE_STATUS_PATH = 'https://api.github.com/repos/givemefood5/endless-sky-nexus/contents/parse-status.json';

/* ── Vercel backend endpoints ────────────────────────────────── */
const BACKEND_URL        = 'https://vercel-for-endless-sky-ship-builder.vercel.app/api/update-json';
const BLOB_UPLOAD_URL    = 'https://vercel-for-endless-sky-ship-builder.vercel.app/api/blob-upload';
const COMMIT_ARCHIVE_URL = 'https://vercel-for-endless-sky-ship-builder.vercel.app/api/commit-archive';
const DELETE_ARCHIVE_URL = 'https://vercel-for-endless-sky-ship-builder.vercel.app/api/delete-archive';

/* ── Optional shared secret (must match SECRET_KEY in Vercel env) */
const UPDATE_SECRET = null;

/* ── Archive upload constraints (mirrors the server-side check —
   the server is authoritative, this is just instant client feedback) */
const MAX_ARCHIVE_BYTES = 90 * 1024 * 1024; // 90 MB
const ALLOWED_ARCHIVE_EXTENSIONS = ['.zip', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar'];

/* ── Poll intervals ──────────────────────────────────────────── */
const POLL_INTERVAL_RUNNING    = 30_000;  // 30 s  — while parse is active
const POLL_INTERVAL_IDLE       = 120_000; // 2 min — background keep-alive
const POLL_INTERVAL_AFTER_SAVE = 8_000;  // 8 s   — rapid checks just after a save
const POLL_AFTER_SAVE_DURATION = 180_000; // 3 min — how long to keep rapid-polling

/* ══════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════ */

function normaliseRepository(raw) {
    const s = (raw || '').trim();
    if (!s) return null;

    if (/^https?:\/\/github\.com\//i.test(s)) {
        const m = s.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)/i);
        return m ? `https://github.com/${m[1]}` : null;
    }

    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) {
        return `https://github.com/${s}`;
    }

    return null;
}

function detectArchiveExtension(filename) {
    const lower = (filename || '').toLowerCase();
    for (const ext of ALLOWED_ARCHIVE_EXTENSIONS) {
        if (lower.endsWith(ext)) return ext;
    }
    return null;
}

function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function highlight(str, query) {
    const escaped = esc(str);
    if (!query) return escaped;
    const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escaped.replace(
        new RegExp(`(${safeQuery})`, 'gi'),
        '<mark class="search-hl">$1</mark>'
    );
}

function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ══════════════════════════════════════════════════════════════
   PluginStore
   ══════════════════════════════════════════════════════════════ */
class PluginStore {
    constructor() {
        this._plugins   = [];
        this._pending   = [];
        this._listeners = [];
    }

    onChange(fn) { this._listeners.push(fn); }
    _notify()    { this._listeners.forEach(fn => fn()); }

    get plugins()      { return JSON.parse(JSON.stringify(this._plugins)); }
    get pending()      { return JSON.parse(JSON.stringify(this._pending)); }
    get count()        { return this._plugins.length; }
    get pendingCount() { return this._pending.length; }

    loadFromObject(obj) {
        if (!obj || !Array.isArray(obj.plugins)) {
            throw new Error('JSON must have a "plugins" array at the root.');
        }
        this._plugins = obj.plugins.map(p => ({
            name:       String(p.name       || '').trim(),
            repository: String(p.repository || '').trim(),
            // Existing entries without a "type" field are git repos —
            // that was the only kind before archive support existed.
            type:       p.type === 'archive' ? 'archive' : 'git',
        }));
        this._notify();
    }

    _allPlugins() {
        return [...this._plugins, ...this._pending];
    }

    _checkNameAndRepoUnique(trimName, repoValue, { skipListIndex = null } = {}) {
        const lower = trimName.toLowerCase();
        const lists = [
            { items: this._plugins, label: null },
            { items: this._pending, label: 'awaiting save' },
        ];
        for (const { items, label } of lists) {
            for (let i = 0; i < items.length; i++) {
                if (skipListIndex && skipListIndex.items === items && skipListIndex.index === i) continue;
                const p = items[i];
                if (p.name.toLowerCase() === lower) {
                    return `A plugin named "${p.name}" already exists${label ? ` (${label})` : ''}.`;
                }
                if (repoValue && p.repository === repoValue) {
                    return `That repository/archive is already listed as "${p.name}"${label ? ` (${label})` : ''}.`;
                }
            }
        }
        return null;
    }

    /* ── Add a git-repository plugin (unchanged behaviour) ───────── */
    addPlugin(name, repo) {
        const trimName = (name || '').trim();
        if (!trimName) return { ok: false, error: 'Plugin name cannot be empty.' };

        const normRepo = normaliseRepository(repo);
        if (!normRepo) return { ok: false, error: 'Invalid repository — use  username/repo  or a full GitHub URL.' };

        const err = this._checkNameAndRepoUnique(trimName, normRepo);
        if (err) return { ok: false, error: err };

        this._pending.push({ name: trimName, repository: normRepo, type: 'git' });
        this._notify();
        return { ok: true };
    }

    /* ── Add an archive plugin. `archiveUrl` is already a resolved
       raw.githubusercontent.com URL — the caller (UI) is responsible
       for actually performing the upload+commit before calling this;
       this method just registers the resulting entry, same as addPlugin
       registers a git repo URL. ─────────────────────────────────── */
    addArchivePlugin(name, archiveUrl) {
        const trimName = (name || '').trim();
        if (!trimName) return { ok: false, error: 'Plugin name cannot be empty.' };
        if (!archiveUrl) return { ok: false, error: 'Missing archive URL.' };

        const err = this._checkNameAndRepoUnique(trimName, archiveUrl);
        if (err) return { ok: false, error: err };

        this._pending.push({ name: trimName, repository: archiveUrl, type: 'archive' });
        this._notify();
        return { ok: true };
    }

    editPlugin(index, name, repo) {
        if (index < 0 || index >= this._plugins.length)
            return { ok: false, error: `No plugin at index ${index}.` };

        const trimName = (name || '').trim();
        if (!trimName) return { ok: false, error: 'Plugin name cannot be empty.' };

        const existing = this._plugins[index];

        // Archive entries keep their uploaded file — only the display
        // name can be changed here. Re-uploading a replacement archive
        // is done via "remove, then add" rather than in-place editing,
        // to keep this edit path simple and unambiguous.
        if (existing.type === 'archive') {
            const err = this._checkNameAndRepoUnique(trimName, null, { skipListIndex: { items: this._plugins, index } });
            if (err) return { ok: false, error: err };
            this._plugins[index] = { ...existing, name: trimName };
            this._notify();
            return { ok: true };
        }

        const normRepo = normaliseRepository(repo);
        if (!normRepo) return { ok: false, error: 'Invalid repository — use  username/repo  or a full GitHub URL.' };

        const err = this._checkNameAndRepoUnique(trimName, normRepo, { skipListIndex: { items: this._plugins, index } });
        if (err) return { ok: false, error: err };

        this._plugins[index] = { name: trimName, repository: normRepo, type: 'git' };
        this._notify();
        return { ok: true };
    }

    editPending(index, name, repo) {
        if (index < 0 || index >= this._pending.length)
            return { ok: false, error: `No pending plugin at index ${index}.` };

        const trimName = (name || '').trim();
        if (!trimName) return { ok: false, error: 'Plugin name cannot be empty.' };

        const existing = this._pending[index];

        if (existing.type === 'archive') {
            const err = this._checkNameAndRepoUnique(trimName, null, { skipListIndex: { items: this._pending, index } });
            if (err) return { ok: false, error: err };
            this._pending[index] = { ...existing, name: trimName };
            this._notify();
            return { ok: true };
        }

        const normRepo = normaliseRepository(repo);
        if (!normRepo) return { ok: false, error: 'Invalid repository — use  username/repo  or a full GitHub URL.' };

        const err = this._checkNameAndRepoUnique(trimName, normRepo, { skipListIndex: { items: this._pending, index } });
        if (err) return { ok: false, error: err };

        this._pending[index] = { name: trimName, repository: normRepo, type: 'git' };
        this._notify();
        return { ok: true };
    }

    removePlugin(index) {
        if (index < 0 || index >= this._plugins.length)
            return { ok: false, error: `No plugin at index ${index}.` };
        this._plugins.splice(index, 1);
        this._notify();
        return { ok: true };
    }

    removePending(index) {
        if (index < 0 || index >= this._pending.length)
            return { ok: false, error: `No pending plugin at index ${index}.` };
        this._pending.splice(index, 1);
        this._notify();
        return { ok: true };
    }

    async save() {
        const payload = { plugins: this._allPlugins() };
        const headers = { 'Content-Type': 'application/json' };

        if (UPDATE_SECRET) {
            headers['X-Update-Secret'] = UPDATE_SECRET;
        }

        try {
            const res = await fetch(BACKEND_URL, {
                method:  'POST',
                headers,
                body:    JSON.stringify(payload),
            });

            let data;
            try { data = await res.json(); } catch { data = {}; }

            if (!res.ok) {
                return { ok: false, error: data.error || `Server error ${res.status}` };
            }

            this._plugins = this._allPlugins();
            this._pending = [];
            this._notify();
            return { ok: true };

        } catch (networkErr) {
            return { ok: false, error: `Network error: ${networkErr.message}` };
        }
    }
}

/* ══════════════════════════════════════════════════════════════
   ArchiveUploader
   Handles the two-step upload: browser → Vercel Blob directly,
   then a small POST to /api/commit-archive to land it in GitHub.
   ══════════════════════════════════════════════════════════════ */
class ArchiveUploader {
    static async upload(file, pluginName, onProgress) {
        const ext = detectArchiveExtension(file.name);
        if (!ext) {
            return { ok: false, error: `Unsupported file type. Allowed: ${ALLOWED_ARCHIVE_EXTENSIONS.join(', ')}` };
        }
        if (file.size > MAX_ARCHIVE_BYTES) {
            return { ok: false, error: `File is ${formatBytes(file.size)}, which exceeds the 90MB limit.` };
        }

        let blobResult;
        try {
            const clientPayload = UPDATE_SECRET ? JSON.stringify({ secret: UPDATE_SECRET }) : undefined;
            blobResult = await upload(file.name, file, {
                access:            'public',
                handleUploadUrl:   BLOB_UPLOAD_URL,
                clientPayload,
                onUploadProgress:  (event) => {
                    if (onProgress && typeof event.percentage === 'number') {
                        onProgress(event.percentage / 100);
                    }
                },
            });
        } catch (err) {
            return { ok: false, error: `Upload failed: ${err.message}` };
        }

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (UPDATE_SECRET) headers['X-Update-Secret'] = UPDATE_SECRET;

            const res = await fetch(COMMIT_ARCHIVE_URL, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    blobUrl:    blobResult.url,
                    pluginName: pluginName,
                    fileName:   file.name,
                }),
            });

            let data;
            try { data = await res.json(); } catch { data = {}; }

            if (!res.ok) {
                return { ok: false, error: data.error || `Server error ${res.status} committing archive.` };
            }

            return { ok: true, rawUrl: data.rawUrl };

        } catch (networkErr) {
            return { ok: false, error: `Network error committing archive: ${networkErr.message}` };
        }
    }

    /**
     * Delete the underlying file from rawData/ in GitHub. Used when the
     * user removes an "archive"-type plugin entry, so the upload doesn't
     * sit around unreferenced forever. Failures here are logged but don't
     * block the plugin removal itself — a leftover file in rawData/ is
     * harmless clutter, not a correctness problem, so we don't want a
     * network hiccup here to prevent someone from removing a plugin.
     */
    static async deleteArchive(rawUrl) {
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (UPDATE_SECRET) headers['X-Update-Secret'] = UPDATE_SECRET;

            const res = await fetch(DELETE_ARCHIVE_URL, {
                method: 'POST',
                headers,
                body: JSON.stringify({ rawUrl }),
            });

            let data;
            try { data = await res.json(); } catch { data = {}; }

            if (!res.ok) {
                return { ok: false, error: data.error || `Server error ${res.status} deleting archive.` };
            }

            return { ok: true };

        } catch (networkErr) {
            return { ok: false, error: `Network error deleting archive: ${networkErr.message}` };
        }
    }
}

/* ══════════════════════════════════════════════════════════════
   ParseStatusMonitor
   ══════════════════════════════════════════════════════════════ */

const PARSE_STATUS_API_PATH =
    'https://api.github.com/repos/givemefood5/endless-sky-nexus/contents/parse-status.json';

const PARSE_STATUS_PAGES_PATH =
    'https://raw.githubusercontent.com/givemefood5/endless-sky-nexus/main/parse-status.json';
    
const PAGES_POLL_INTERVAL = 15_000; // 15 s — while job is running

class ParseStatusMonitor {
    constructor() {
        this._status           = null;   // 'running' | 'idle' | null
        this._startedAt        = null;
        this._completedAt      = null;
        this._listeners        = [];
        this._pagesPollTimer   = null;   // only active while running
        this._optimisticTimer  = null;
        this._confirmedRunning = false;
    }

    get isRunning()   { return this._status === 'running'; }
    get status()      { return this._status; }
    get startedAt()   { return this._startedAt; }
    get completedAt() { return this._completedAt; }

    onChange(fn) { this._listeners.push(fn); }
    _notify()    { this._listeners.forEach(fn => fn()); }

async poll() {
    try {
        const res = await fetch(PARSE_STATUS_PAGES_PATH + '?t=' + Date.now());
        if (res.ok) {
            const data = await res.json();
            if (data.status === 'running') {
                this._applyStatus(data);
                this._startPagesPoll();
                return this._status;
            }
        }
    } catch {
        // Pages unreachable — fall through to API
    }

    try {
        const res = await fetch(PARSE_STATUS_API_PATH + '?t=' + Date.now(), {
            headers: {
                'Accept':               'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const envelope = await res.json();
        const raw      = atob(envelope.content.replace(/\n/g, ''));
        const data     = JSON.parse(raw);

        this._applyStatus(data);

    } catch {
        // Leave status as-is on total failure
    }

    if (this.isRunning) this._startPagesPoll();
    return this._status;
}

_applyStatus(data) {
    const newStatus = data.status || null;

    if (newStatus === 'running') {
        this._confirmedRunning = true;
        clearTimeout(this._optimisticTimer);
        this._optimisticTimer = null;
    }

    if (newStatus === 'idle' && this._status === 'running' && !this._confirmedRunning) {
        return;
    }

    const changed =
        this._status      !== newStatus                   ||
        this._startedAt   !== (data.startedAt   || null)  ||
        this._completedAt !== (data.completedAt || null);

    this._status      = newStatus;
    this._startedAt   = data.startedAt   || null;
    this._completedAt = data.completedAt || null;

    if (changed) this._notify();

    if (newStatus === 'idle' && this._confirmedRunning) {
        this._confirmedRunning = false;
    }
}

    forceOptimisticRunning() {
        const previousStatus   = this._status;
        this._status           = 'running';
        this._confirmedRunning = false;
        this._notify();

        clearTimeout(this._optimisticTimer);
        this._optimisticTimer = setTimeout(() => {
            if (!this._confirmedRunning) {
                this._status = previousStatus;
                this._notify();
            }
            this._optimisticTimer = null;
        }, 180_000);

        this._startPagesPoll();
    }

    _startPagesPoll() {
        this._stopPagesPoll();
        this._pagesPollTimer = setTimeout(() => this._pollPages(), PAGES_POLL_INTERVAL);
    }

    _stopPagesPoll() {
        clearTimeout(this._pagesPollTimer);
        this._pagesPollTimer = null;
    }

async _pollPages() {
    this._pagesPollTimer = null;
    try {
        const res = await fetch(PARSE_STATUS_PAGES_PATH + '?t=' + Date.now());
        if (res.ok) {
            const data = await res.json();

            if (data.status === 'running') {
                this._confirmedRunning = true;
                clearTimeout(this._optimisticTimer);
                this._optimisticTimer = null;
                this._notify();
                this._pagesPollTimer = setTimeout(() => this._pollPages(), PAGES_POLL_INTERVAL);
                return;
            }

            const apiRes = await fetch(PARSE_STATUS_API_PATH + '?t=' + Date.now(), {
                headers: {
                    'Accept':               'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                }
            });
            if (!apiRes.ok) throw new Error(`API HTTP ${apiRes.status}`);
            const envelope = await apiRes.json();
            const apiData  = JSON.parse(atob(envelope.content.replace(/\n/g, '')));

            if (apiData.status === 'idle') {
                this._applyStatus(apiData);
                return;
            }

            this._confirmedRunning = true;
            this._pagesPollTimer = setTimeout(() => this._pollPages(), PAGES_POLL_INTERVAL);
            return;
        }
    } catch {
        // Network hiccup — keep polling
    }

    if (this.isRunning) {
        this._pagesPollTimer = setTimeout(() => this._pollPages(), PAGES_POLL_INTERVAL);
    }
}

    stop() {
        this._stopPagesPoll();
        clearTimeout(this._optimisticTimer);
    }
}

/* ══════════════════════════════════════════════════════════════
   PluginManagerUI
   ══════════════════════════════════════════════════════════════ */
class PluginManagerUI {
    constructor(store, monitor) {
        this.store   = store;
        this.monitor = monitor;

        this.nameInput        = document.getElementById('pluginName');
        this.repoInput        = document.getElementById('repoUrl');
        this.addBtn           = document.getElementById('addPluginBtn');
        this.clearBtn         = document.getElementById('clearBtn');
        this.saveBtn          = document.getElementById('saveBtn');
        this.listEl           = document.getElementById('pluginActiveList');
        this.pendingListEl    = document.getElementById('pluginPendingList');
        this.pendingPanel     = document.getElementById('pendingPanel');
        this.counterEl        = document.getElementById('pluginCounter');
        this.pendingCounterEl = document.getElementById('pendingCounter');
        this.statusEl         = document.getElementById('statusMsg');
        this.searchEl         = document.getElementById('pluginSearch');
        this.parseBarEl       = document.getElementById('parseStatusBar');

        this.sourceTypeGitBtn     = document.getElementById('sourceTypeGitBtn');
        this.sourceTypeArchiveBtn = document.getElementById('sourceTypeArchiveBtn');
        this.repoGroup            = document.getElementById('repoGroup');
        this.archiveGroup         = document.getElementById('archiveGroup');
        this.archiveFileInput     = document.getElementById('archiveFile');
        this.archiveDropZone      = document.getElementById('archiveDropZone');
        this.archiveFileLabel     = document.getElementById('archiveFileLabel');
        this.archiveProgressWrap  = document.getElementById('archiveProgressWrap');
        this.archiveProgressBar   = document.getElementById('archiveProgressBar');

        this._editIndex   = null;
        this._editPending = null;
        this._statusTimer = null;
        this._searchQuery = '';
        this._sourceType  = 'git';
        this._selectedFile = null;
        this._uploading    = false;

        this._bindEvents();
        this.store.onChange(()   => this._render());
        this.monitor.onChange(() => this._updateParseBar());
    }

_bindEvents() {
    this.addBtn.addEventListener('click',   () => this._handleAddOrEdit());
    this.clearBtn.addEventListener('click', () => this._handleClear());
    this.saveBtn.addEventListener('click',  () => this._handleSave());

    this.searchEl.addEventListener('input', () => {
        this._searchQuery = this.searchEl.value.trim();
        this._render();
    });

    this.searchEl.addEventListener('search', () => {
        this._searchQuery = '';
        this._render();
    });

    if (this.sourceTypeGitBtn && this.sourceTypeArchiveBtn) {
        this.sourceTypeGitBtn.addEventListener('click', () => this._setSourceType('git'));
        this.sourceTypeArchiveBtn.addEventListener('click', () => this._setSourceType('archive'));
    }

    if (this.archiveFileInput) {
        this.archiveFileInput.addEventListener('change', () => {
            const file = this.archiveFileInput.files?.[0] || null;
            this._handleFileSelected(file);
        });
    }

    if (this.archiveDropZone) {
        this.archiveDropZone.addEventListener('click', () => {
            if (this.archiveFileInput) this.archiveFileInput.click();
        });

        this.archiveDropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.archiveDropZone.classList.add('dragover');
        });
        this.archiveDropZone.addEventListener('dragleave', () => {
            this.archiveDropZone.classList.remove('dragover');
        });
        this.archiveDropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            this.archiveDropZone.classList.remove('dragover');
            const file = e.dataTransfer?.files?.[0] || null;
            this._handleFileSelected(file);
        });
    }
}

    _setSourceType(type) {
        if (this._editIndex !== null || this._editPending !== null) {
            this._clearInputs();
        }
        this._sourceType = type;
        this._selectedFile = null;
        if (this.archiveFileInput) this.archiveFileInput.value = '';
        this._updateSourceTypeUI();
    }

    _updateSourceTypeUI() {
        const isArchive = this._sourceType === 'archive';
        if (this.repoGroup)    this.repoGroup.style.display    = isArchive ? 'none' : '';
        if (this.archiveGroup) this.archiveGroup.style.display = isArchive ? '' : 'none';
        if (this.sourceTypeGitBtn && this.sourceTypeArchiveBtn) {
            this.sourceTypeGitBtn.classList.toggle('active', !isArchive);
            this.sourceTypeArchiveBtn.classList.toggle('active', isArchive);
        }
        this._renderFileLabel();
    }

    _handleFileSelected(file) {
        if (!file) { this._selectedFile = null; this._renderFileLabel(); return; }

        const lower = file.name.toLowerCase();
        const validExt = ALLOWED_ARCHIVE_EXTENSIONS.some(ext => lower.endsWith(ext));
        if (!validExt) {
            this._showStatus(`Unsupported file type. Allowed: ${ALLOWED_ARCHIVE_EXTENSIONS.join(', ')}`, 'error');
            this._selectedFile = null;
            if (this.archiveFileInput) this.archiveFileInput.value = '';
            this._renderFileLabel();
            return;
        }

        if (file.size > MAX_ARCHIVE_BYTES) {
            this._showStatus(
                `"${file.name}" is ${formatBytes(file.size)} — the limit is 90MB. Please upload a smaller archive.`,
                'error'
            );
            this._selectedFile = null;
            if (this.archiveFileInput) this.archiveFileInput.value = '';
            this._renderFileLabel();
            return;
        }

        this._selectedFile = file;
        this._showStatus('', '');
        this._renderFileLabel();
    }

    _renderFileLabel() {
        if (!this.archiveFileLabel) return;
        if (this._selectedFile) {
            this.archiveFileLabel.textContent = `${this._selectedFile.name} (${formatBytes(this._selectedFile.size)})`;
        } else {
            this.archiveFileLabel.textContent = 'No file selected — drag & drop or click to choose (.zip, .tar, .tar.gz, .tgz, .tar.bz2 — max 90MB)';
        }
    }

    _setUploadProgress(fraction) {
        if (!this.archiveProgressWrap || !this.archiveProgressBar) return;
        this.archiveProgressWrap.style.display = 'block';
        this.archiveProgressBar.style.width = `${Math.round(fraction * 100)}%`;
    }

    _hideUploadProgress() {
        if (!this.archiveProgressWrap) return;
        this.archiveProgressWrap.style.display = 'none';
        this.archiveProgressBar.style.width = '0%';
    }

    _updateParseBar() {
        if (!this.parseBarEl) return;
        const status = this.monitor.status;

        if (status === 'running') {
            this.parseBarEl.className = 'parse-status-bar parse-status--running';
            this.parseBarEl.innerHTML =
                `<span class="parse-spinner"></span>` +
                `<strong>Parse job is currently running.</strong> ` +
                `Saving is disabled until it completes. This page will update automatically.`;
            this.saveBtn.disabled = true;

        } else if (status === 'idle') {
            this.parseBarEl.className = 'parse-status-bar parse-status--idle';
            this.parseBarEl.innerHTML = `✅ <strong>Parser idle.</strong> Ready to accept changes.`;
            this.saveBtn.disabled = false;

        } else {
            this.parseBarEl.className = 'parse-status-bar parse-status--idle';
            this.parseBarEl.innerHTML = `⏳ <strong>Checking parser status…</strong>`;
            this.saveBtn.disabled = false;
        }
    }

async _checkBeforeSave() {
    this.saveBtn.disabled = true;
    this._showStatus('Checking parser status…', 'info');

    const status = await this.monitor.poll();

    if (status === 'running') {
        this._showParserRunningModal();
        this.saveBtn.disabled = false;
        return false;
    }

    return true;
}

    async _handleAddOrEdit() {
        if (this._uploading) return;

        const isNewArchiveAdd =
            this._sourceType === 'archive' &&
            this._editIndex === null &&
            this._editPending === null;

        if (isNewArchiveAdd) {
            await this._handleArchiveAdd();
            return;
        }

        let result;
        if (this._editPending !== null) {
            result = this.store.editPending(this._editPending, this.nameInput.value, this.repoInput.value);
        } else if (this._editIndex !== null) {
            result = this.store.editPlugin(this._editIndex, this.nameInput.value, this.repoInput.value);
        } else {
            result = this.store.addPlugin(this.nameInput.value, this.repoInput.value);
        }

        if (!result.ok) { this._showStatus(result.error, 'error'); return; }

        const wasEditing = this._editIndex !== null || this._editPending !== null;
        this._clearInputs();
        this._showStatus(wasEditing ? 'Plugin updated.' : 'Plugin staged — save when ready.', 'success');
    }

    async _handleArchiveAdd() {
        const trimName = (this.nameInput.value || '').trim();
        if (!trimName) { this._showStatus('Plugin name cannot be empty.', 'error'); return; }
        if (!this._selectedFile) { this._showStatus('Please choose an archive file to upload.', 'error'); return; }

        this._uploading = true;
        this.addBtn.disabled = true;
        this._setUploadProgress(0);
        this._showStatus('Uploading archive…', 'info');

        const result = await ArchiveUploader.upload(
            this._selectedFile,
            trimName,
            (fraction) => {
                this._setUploadProgress(fraction);
                this._showStatus(`Uploading archive… ${Math.round(fraction * 100)}%`, 'info');
            }
        );

        this._uploading = false;
        this.addBtn.disabled = false;
        this._hideUploadProgress();

        if (!result.ok) {
            this._showStatus(result.error, 'error');
            return;
        }

        const addResult = this.store.addArchivePlugin(trimName, result.rawUrl);
        if (!addResult.ok) {
            this._showStatus(
                `Archive uploaded and committed, but could not stage it (${addResult.error}). ` +
                `The file is already in rawData/ at ${result.rawUrl} — you may need to add it manually.`,
                'error'
            );
            return;
        }

        this._clearInputs();
        this._showStatus('Archive uploaded and staged — save when ready.', 'success');
    }

   _showParserRunningModal() {
    document.getElementById('parserRunningModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'parserRunningModal';
    overlay.style.cssText = `
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.45);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999;
    `;

    overlay.innerHTML = `
        <div style="
            background: var(--color-background-primary);
            border: 1px solid var(--color-border-secondary);
            border-radius: 12px;
            padding: 28px 32px;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 8px 32px rgba(0,0,0,0.18);
        ">
            <div style="font-size:32px; margin-bottom:12px;">⏳</div>
            <h2 style="margin:0 0 8px; font-size:18px; font-weight:500; color:var(--color-text-primary)">
                Parser is currently running
            </h2>
            <p style="margin:0 0 20px; font-size:14px; color:var(--color-text-secondary); line-height:1.6">
                A parse job is already in progress. Saving now could cause a conflict.
                Please wait for it to finish — this page will update automatically.
            </p>
            <button id="parserModalClose" style="
                padding: 8px 20px;
                border-radius: 8px;
                border: 1px solid var(--color-border-secondary);
                background: var(--color-background-secondary);
                color: var(--color-text-primary);
                font-size: 14px;
                cursor: pointer;
            ">Got it</button>
        </div>
    `;

    overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.remove();
    });
    overlay.querySelector('#parserModalClose').addEventListener('click', () => overlay.remove());

    document.body.appendChild(overlay);
    this._showStatus('', '');
}

    _handleClear() {
        this._clearInputs();
        this._showStatus('', '');
    }

async _handleSave() {
    const canProceed = await this._checkBeforeSave();
    if (!canProceed) return;

    this._showStatus('Saving…', 'info');

    const result = await this.store.save();

    if (!result.ok) {
        this.saveBtn.disabled = false;
        this._showStatus('Save failed: ' + (result.error || ''), 'error');
        return;
    }

    this._showStatus('plugins.json saved! Parse job starting…', 'success');
    this.monitor.forceOptimisticRunning();
}

async _handleRemoveSave(removedName, removedPlugin) {
    const canProceed = await this._checkBeforeSave();
    if (!canProceed) return;

    this._showStatus(`Removing "${removedName}"…`, 'info');
    const result = await this.store.save();

    if (!result.ok) {
        this.saveBtn.disabled = false;
        this._showStatus('Remove failed: ' + (result.error || ''), 'error');
        return;
    }

    // Only delete the underlying rawData/ file AFTER plugins.json has
    // successfully been saved without this entry — deleting first would
    // risk leaving a dangling reference if the save step then failed.
    if (removedPlugin?.type === 'archive' && removedPlugin.repository) {
        const delResult = await ArchiveUploader.deleteArchive(removedPlugin.repository);
        if (!delResult.ok) {
            console.warn(`Could not delete rawData file for "${removedName}": ${delResult.error}`);
            this._showStatus(
                `"${removedName}" removed and saved, but its uploaded file could not be deleted (${delResult.error}). You may want to remove it manually from rawData/.`,
                'error'
            );
            this.monitor.forceOptimisticRunning();
            return;
        }
    }

    this._showStatus(`"${removedName}" removed and saved.`, 'success');
    this.monitor.forceOptimisticRunning();
}

    _startEdit(index) {
        const p = this.store.plugins[index];
        if (!p) return;
        this._editIndex       = index;
        this._editPending     = null;
        this._sourceType      = p.type === 'archive' ? 'archive' : 'git';
        this.nameInput.value  = p.name;
        this.repoInput.value  = p.type === 'archive' ? '' : p.repository;
        this.addBtn.innerHTML = '<span>✏️</span> Save Changes';
        this._updateSourceTypeUI();
        if (p.type === 'archive') {
            if (this.archiveGroup) this.archiveGroup.style.display = 'none';
            if (this.repoGroup)    this.repoGroup.style.display    = 'none';
        }
        this.nameInput.focus();
        this._showStatus(
            p.type === 'archive'
                ? `Editing archive entry: ${p.name} (rename only — remove & re-upload to replace the file)`
                : `Editing active: ${p.name}`,
            'info'
        );
    }

    _startEditPending(index) {
        const p = this.store.pending[index];
        if (!p) return;
        this._editPending     = index;
        this._editIndex       = null;
        this._sourceType      = p.type === 'archive' ? 'archive' : 'git';
        this.nameInput.value  = p.name;
        this.repoInput.value  = p.type === 'archive' ? '' : p.repository;
        this.addBtn.innerHTML = '<span>✏️</span> Save Changes';
        this._updateSourceTypeUI();
        if (p.type === 'archive') {
            if (this.archiveGroup) this.archiveGroup.style.display = 'none';
            if (this.repoGroup)    this.repoGroup.style.display    = 'none';
        }
        this.nameInput.focus();
        this._showStatus(
            p.type === 'archive'
                ? `Editing staged archive entry: ${p.name} (rename only)`
                : `Editing staged: ${p.name}`,
            'info'
        );
    }

    _clearInputs() {
        this._editIndex       = null;
        this._editPending     = null;
        this.nameInput.value  = '';
        this.repoInput.value  = '';
        this.addBtn.innerHTML = '<span>📥</span> Add Plugin';
        this._selectedFile    = null;
        if (this.archiveFileInput) this.archiveFileInput.value = '';
        this._updateSourceTypeUI();
    }

    _render() {
        this._renderActive();
        this._renderPending();
    }

    _sourceBadge(type) {
        return type === 'archive'
            ? `<span class="source-type-badge source-type--archive" title="Uploaded archive">📦 archive</span>`
            : `<span class="source-type-badge source-type--git" title="Git repository">🔗 git</span>`;
    }

    _renderActive() {
        const plugins = this.store.plugins;
        const query   = this._searchQuery.toLowerCase();

        if (this.counterEl) this.counterEl.textContent = plugins.length;

        const filtered = query
            ? plugins.filter(p =>
                p.name.toLowerCase().includes(query) ||
                p.repository.toLowerCase().includes(query)
              )
            : plugins;

        if (plugins.length === 0) {
            this.listEl.innerHTML = '<div class="sorter-empty">No plugins yet — add one above.</div>';
            return;
        }

        if (filtered.length === 0) {
            this.listEl.innerHTML =
                `<div class="search-no-results">No plugins match "<strong>${esc(this._searchQuery)}</strong>".</div>`;
            return;
        }

        this.listEl.innerHTML = '';
        filtered.forEach(p => {
            const realIndex = plugins.findIndex(
                x => x.name === p.name && x.repository === p.repository
            );

            const row = document.createElement('div');
            row.className = 'sorter-row';
            row.innerHTML = `
                <div class="sorter-label">
                    <span class="plugin-list-name">${highlight(p.name, this._searchQuery)} ${this._sourceBadge(p.type)}</span>
                    <span class="plugin-list-repo">${highlight(p.repository, this._searchQuery)}</span>
                </div>
                <button class="btn-action plugin-edit-btn" data-i="${realIndex}" title="Edit">✏️</button>
                <button class="sorter-remove-btn plugin-rm-btn" data-i="${realIndex}" title="Remove">✕ Remove</button>
            `;

            row.querySelector('.plugin-edit-btn').addEventListener('click', e => {
                e.stopPropagation();
                this._startEdit(+e.currentTarget.dataset.i);
            });

            row.querySelector('.plugin-rm-btn').addEventListener('click', e => {
                e.stopPropagation();
                const idx  = +e.currentTarget.dataset.i;
                const removedPlugin = this.store.plugins[idx];
                const name = removedPlugin?.name ?? 'this plugin';
                if (confirm(`Remove "${name}"?`)) {
                    if (this._editIndex === idx) this._clearInputs();
                    const result = this.store.removePlugin(idx);
                    if (result.ok) this._handleRemoveSave(name, removedPlugin);
                }
            });

            this.listEl.appendChild(row);
        });
    }

    _renderPending() {
        const pending = this.store.pending;

        if (this.pendingCounterEl) this.pendingCounterEl.textContent = pending.length;

        if (pending.length === 0) {
            this.pendingPanel.classList.remove('has-items');
            this.pendingListEl.innerHTML = '';
            return;
        }

        this.pendingPanel.classList.add('has-items');
        this.pendingListEl.innerHTML = '';

        pending.forEach((p, i) => {
            const row = document.createElement('div');
            row.className = 'sorter-row';
            row.innerHTML = `
                <div class="sorter-label">
                    <span class="plugin-list-name">${esc(p.name)} ${this._sourceBadge(p.type)}</span>
                    <span class="plugin-list-repo">${esc(p.repository)}</span>
                </div>
                <button class="btn-action plugin-edit-btn" data-i="${i}" title="Edit">✏️</button>
                <button class="sorter-remove-btn plugin-rm-btn" data-i="${i}" title="Remove">✕ Remove</button>
            `;

            row.querySelector('.plugin-edit-btn').addEventListener('click', e => {
                e.stopPropagation();
                this._startEditPending(+e.currentTarget.dataset.i);
            });

            row.querySelector('.plugin-rm-btn').addEventListener('click', e => {
                e.stopPropagation();
                const idx  = +e.currentTarget.dataset.i;
                const removedPlugin = this.store.pending[idx];
                const name = removedPlugin?.name ?? 'this plugin';
                if (confirm(`Remove "${name}" from the pending list?`)) {
                    if (this._editPending === idx) this._clearInputs();
                    this.store.removePending(idx);
                    // The pending entry was never saved into plugins.json, but if
                    // it's an archive, the file itself was already committed to
                    // rawData/ at upload time — clean that up now so it doesn't
                    // sit around unreferenced forever.
                    if (removedPlugin?.type === 'archive' && removedPlugin.repository) {
                        ArchiveUploader.deleteArchive(removedPlugin.repository).then(result => {
                            if (!result.ok) {
                                console.warn(`Could not delete rawData file for "${name}": ${result.error}`);
                            }
                        });
                    }
                }
            });

            this.pendingListEl.appendChild(row);
        });
    }

    _showStatus(msg, type) {
        if (!this.statusEl) return;
        clearTimeout(this._statusTimer);

        if (!msg) { this.statusEl.className = 'status-msg hidden'; return; }

        this.statusEl.className   = `status-msg status--${type}`;
        this.statusEl.textContent = msg;

        if (type === 'success') {
            this._statusTimer = setTimeout(
                () => { this.statusEl.className = 'status-msg hidden'; }, 3000
            );
        }
    }
}

/* ══════════════════════════════════════════════════════════════
   Bootstrap — runs after DOM ready
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
    const store   = new PluginStore();
    const monitor = new ParseStatusMonitor();
    const ui      = new PluginManagerUI(store, monitor);

    ui._updateParseBar();
    ui._updateSourceTypeUI();

    window.pluginStore  = store;
    window.parseMonitor = monitor;

    const [pluginsResult] = await Promise.allSettled([
        fetch(PLUGINS_JSON_PATH).then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        }),
        monitor.poll(),
    ]);

    if (pluginsResult.status === 'fulfilled') {
        try { store.loadFromObject(pluginsResult.value); }
        catch (err) { ui._showStatus(err.message, 'error'); ui._render(); }
    } else {
        const msg = pluginsResult.reason?.message || 'Unknown error';
        ui._showStatus(`Could not load plugins.json (${msg}). Add plugins manually or check the file path.`, 'error');
        ui._render();
    }
});
