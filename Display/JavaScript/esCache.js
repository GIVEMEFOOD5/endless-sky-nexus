'use strict';

// A small browser cache (IndexedDB) for loaded data, thrown away when the parser publishes new data.

(function () {

const DB_NAME     = 'esShipBuilderCache';
const DB_VERSION  = 1;
const STORE_NAME  = 'kv';

let _dbPromise = null;
let _remoteVersionPromise = null;

// open the database. Called by: _getRaw, _setRaw, clearCache
function _openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
    return _dbPromise;
}

// read one entry. Called by: loadWithCache
async function _getRaw(key) {
    try {
        const db = await _openDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
            req.onerror   = () => reject(req.error);
        });
    } catch (err) {
        console.warn('[esCache] Read failed, treating as cache miss:', err);
        return undefined;
    }
}

// write one entry. Called by: loadWithCache
async function _setRaw(key, value) {
    try {
        const db = await _openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put({ key, value });
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    } catch (err) {
        // Not fatal — worst case, this page just re-fetches next time too.
        console.warn('[esCache] Write failed (cache will be skipped this time):', err);
    }
}

// the live data version, asked once per page. Called by: loadWithCache, Bundles.manifest
async function getRemoteDataVersion() {
    if (_remoteVersionPromise) return _remoteVersionPromise;
    _remoteVersionPromise = (async () => {
        try {
            const { data, error } = await window.supabaseClient
                .from('app_config').select('value').eq('key', 'dataVersion').maybeSingle();
            if (error || !data) return null;
            return data.value?.updatedAt ?? null;
        } catch (_) {
            return null;
        }
    })();
    return _remoteVersionPromise;
}

// cached copy if it's still current, else fetch fresh and save it. Called by: dataLoader, mapDataLoader, missionLoader
async function loadWithCache(bundleKey, fetchFreshFn) {
    const remoteVersion = await getRemoteDataVersion();
    if (remoteVersion) {
        const cached = await _getRaw(bundleKey);
        if (cached && cached.dataVersion === remoteVersion) {
            console.log(`[esCache] "${bundleKey}" — using cached data (version ${remoteVersion}), no fetch needed`);
            return cached.data;
        }
    }
    console.log(`[esCache] "${bundleKey}" — fetching fresh` + (remoteVersion ? ` (version ${remoteVersion})` : ' (version check unavailable)'));
    const fresh = await fetchFreshFn();
    if (remoteVersion) await _setRaw(bundleKey, { data: fresh, dataVersion: remoteVersion });
    return fresh;
}

// wipe the cache. Called by: shipBuilderStats
async function clearCache() {
    try {
        const db = await _openDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).clear();
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    } catch (err) {
        console.warn('[esCache] Could not clear cache:', err);
    }
}

window.EsCache = { loadWithCache, getRemoteDataVersion, clearCache };

})();
