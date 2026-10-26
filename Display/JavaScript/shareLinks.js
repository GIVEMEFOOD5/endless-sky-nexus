'use strict';

// "Look at this build" links: the ship or battle is packed into the link itself (nothing saved online).

(function () {
  const DISCORD_LIMIT = 2000;   // characters in a normal Discord message

  const toB64u = bytes => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64u = str => {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };
  const canCompress = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  // run bytes through a (de)compression stream
  async function pipe(bytes, stream) {
    const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await res.arrayBuffer());
  }

  // data → "z…" (compressed) or "j…" (plain, old browsers). Called by: make
  async function pack(data) {
    const json = new TextEncoder().encode(JSON.stringify(data));
    if (canCompress) {
      try { return 'z' + toB64u(await pipe(json, new CompressionStream('deflate-raw'))); } catch (_) { /* fall back */ }
    }
    return 'j' + toB64u(json);
  }
  // link text → data. Called by: read
  async function unpack(str) {
    const kind = str[0], body = fromB64u(str.slice(1));
    const bytes = kind === 'z' ? await pipe(body, new DecompressionStream('deflate-raw')) : body;
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // absolute URL for a page
  function pageUrl(page) {
    const here = new URL(window.location.href);
    return new URL(page, here).href.split('#')[0];
  }

  // full share link. Called by: shipBuilder.sbShareShip, battleSim.shareBattle
  async function make(page, key, data) {
    return `${pageUrl(page)}#${key}=${await pack({ v: 1, ...data })}`;
  }

  // data from this page's link (null if none). Called by: shipBuilder, battleSim on load
  async function read(key) {
    const m = window.location.hash.match(new RegExp(`[#&]${key}=([^&]+)`));
    if (!m) return null;
    try { return await unpack(decodeURIComponent(m[1])); }
    catch (err) { console.warn('[ShareLinks] Could not read the shared link:', err); return { _broken: true }; }
  }

  // remove the #… from the address bar
  function clear() {
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (_) {}
  }

  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // copy the link and show it in a window. Called by: the 🔗 share buttons
  async function show(url, what) {
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch (_) { /* show it to copy by hand */ }
    let m = document.getElementById('share-link-modal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'share-link-modal'; m.className = 'modal-overlay';
      m.addEventListener('click', e => { if (e.target === m) m.classList.remove('active'); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') m.classList.remove('active'); });
      document.body.appendChild(m);
    }
    const long = url.length > DISCORD_LIMIT;
    m.innerHTML = `<div class="modal-box" style="width:min(560px,96vw);">
      <div class="modal-header"><div class="modal-title">🔗 Share ${esc(what)}</div>
        <button class="modal-close" aria-label="Close" onclick="document.getElementById('share-link-modal').classList.remove('active')">×</button></div>
      <p style="margin:0 0 8px;">${copied ? '✅ Link copied — paste it anywhere (Discord, Reddit …).' : 'Copy this link and paste it anywhere:'}</p>
      <textarea class="text-input" readonly rows="3" style="width:100%;font-size:0.8rem;word-break:break-all;" onclick="this.select()">${esc(url)}</textarea>
      <p style="font-size:0.8rem;color:var(--c-text-dim);margin:8px 0 0;">
        Anyone who opens it sees exactly this — no account needed, and nothing is saved online.
        ${long ? `<br>⚠ It's ${url.length.toLocaleString()} characters — longer than a normal Discord message (2,000). Send it as a file, use Nitro, or share a simpler version.` : ''}</p>
      <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="navigator.clipboard && navigator.clipboard.writeText(${esc(JSON.stringify(url))}).then(()=>this.textContent='✅ Copied')">Copy again</button>
        <button class="btn btn-primary" onclick="document.getElementById('share-link-modal').classList.remove('active')">Done</button></div>
    </div>`;
    m.classList.add('active');
  }

  window.ShareLinks = { make, read, clear, show, pack, unpack };
})();
