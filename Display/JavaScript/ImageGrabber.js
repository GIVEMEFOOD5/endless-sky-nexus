(function () {
'use strict';

/**
 * ImageGrabber.js — multi-plugin edition
 *
 * Builds a separate image index per plugin folder. When fetchSprite() is called
 * it searches the current plugin's index first, then falls back to all other
 * loaded indexes so variants can find base-game sprites.
 *
 * Requires Animator.js (EndlessSkyAnimator) to be loaded first.
 *
 * Public API
 * ──────────
 *   initImageIndex(outputName?)
 *     Builds (or retrieves cached) index for the given plugin folder.
 *     If no outputName given, initialises all known plugins from allData.
 *     → Promise<void>
 *
 *   setCurrentPlugin(outputName)
 *     Tells the grabber which plugin is active. Called by selectPlugin() in main.js.
 *     → void
 *
 *   fetchSprite(spritePath, spriteParams?)
 *     Searches the current plugin's index first, then all others as fallback.
 *     → Promise<HTMLCanvasElement | HTMLImageElement | null>
 *
 *   clearSpriteCache()
 *     Stops the active animator and revokes object URLs.
 *     → void
 *
 *   findImageVariations(basePath, outputName?)
 *     Low-level: returns all matching frame entries from the specified index
 *     (or current plugin's index if omitted).
 *     → Array<{path, url, variation}>
 */

// ─── Config ───────────────────────────────────────────────────────────────────

const GITHUB_REPO   = 'GIVEMEFOOD5/endless-sky-nexus';
const GITHUB_BRANCH = 'main';

// Base URL for raw image serving — works from any host, no GitHub Pages dependency
const GITHUB_PAGES_BASE = `https://raw.githubusercontent.com/GIVEMEFOOD5/endless-sky-nexus/main/data/`;
    
// Raw GitHub URL base for API
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;

// Image extensions
const IMG_EXT_RE = /\.(png|jpg|jpeg)$/i;

// Animation separator chars used in ES filenames


// ─── Module state ─────────────────────────────────────────────────────────────

// Per-plugin indexes: Map of outputName → { index: Map<baseKey → frames[]>, ready: bool }
const _pluginIndexes  = {};
const _pluginIndexing = {}; // outputName → Promise while building

// Which plugin is currently selected
let _currentPlugin = null;

// Cached full repo tree (fetched once, shared across all index builds)
let _repoTree        = null;
let _repoTreeFetching = null;

// Active animator/image for disposal
let _active   = null;
let _fetchGen = 0;


// ─── Repo tree (fetched once) ─────────────────────────────────────────────────

async function _fetchRepoTree() {
  if (_repoTree)        return _repoTree;
  if (_repoTreeFetching) return _repoTreeFetching;

  _repoTreeFetching = (async () => {
    try {
      const res = await fetch(GITHUB_API_BASE, {
        headers: { Accept: 'application/vnd.github.v3+json' }
      });
      if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
      const data = await res.json();
      _repoTree = data.tree || [];
      console.log(`ImageGrabber: repo tree fetched — ${_repoTree.length} entries`);
    } catch (err) {
      console.error('ImageGrabber: failed to fetch repo tree:', err);
      _repoTree = [];
    }
    _repoTreeFetching = null;
    return _repoTree;
  })();

  return _repoTreeFetching;
}


// ─── Per-plugin index builder ─────────────────────────────────────────────────

/**
 * Builds the image index for one plugin's images/ folder.
 * e.g. outputName = "official-game" → scans data/official-game/images/
 */
async function _buildPluginIndex(outputName) {
  if (_pluginIndexes[outputName]?.ready) return;
  if (_pluginIndexing[outputName])       return _pluginIndexing[outputName];

  _pluginIndexing[outputName] = (async () => {
    const tree    = await _fetchRepoTree();
    const prefix  = `data/${outputName}/images/`;
    const index   = {};

    tree.forEach(node => {
      if (node.type !== 'blob')              return;
      if (!node.path.startsWith(prefix))     return;
      if (!IMG_EXT_RE.test(node.path))       return;

      const rel    = node.path.slice(prefix.length);           // e.g. "ship/penguin.png"
      const noExt  = rel.replace(IMG_EXT_RE, '');              // e.g. "ship/penguin"
      const pageUrl = `${GITHUB_PAGES_BASE}${outputName}/images/${rel}`;

      // Parse animation frame suffix
      const sepNumMatch  = noExt.match(/^(.*?)([+~\-\^=@])(\d+)$/);
      const sepOnlyMatch = noExt.match(/^(.*?)([+~\-\^=@])$/);
      let baseKey, variation;

      if (sepNumMatch) {
        baseKey   = sepNumMatch[1];
        variation = sepNumMatch[2] + sepNumMatch[3];
      } else if (sepOnlyMatch) {
        baseKey   = sepOnlyMatch[1];
        variation = sepOnlyMatch[2];
      } else {
        baseKey   = noExt;
        variation = 'base';
      }

      if (!index[baseKey]) index[baseKey] = [];
      index[baseKey].push({ fullPath: rel, url: pageUrl, variation });
    });

    // Sort frames into playback order
    Object.values(index).forEach(frames => {
      frames.sort((a, b) => {
        if (a.variation === 'base') return -1;
        if (b.variation === 'base') return  1;
        const aNum = /\d/.test(a.variation);
        const bNum = /\d/.test(b.variation);
        if (!aNum &&  bNum) return -1;
        if ( aNum && !bNum) return  1;
        if (!aNum && !bNum) return a.variation.localeCompare(b.variation);
        return parseInt(a.variation.replace(/\D/g, ''), 10) -
               parseInt(b.variation.replace(/\D/g, ''), 10);
      });
    });

    _pluginIndexes[outputName] = { index, ready: true };
    delete _pluginIndexing[outputName];

    console.log(`ImageGrabber: index built for "${outputName}" — ${Object.keys(index).length} sprites`);
  })();

  return _pluginIndexing[outputName];
}


// ─── Public: initImageIndex ───────────────────────────────────────────────────

/**
 * Call at startup (or when plugin list changes) to pre-build indexes.
 * If outputName given, builds just that one. Otherwise builds all plugins
 * known from window.allData (set by main.js).
 */
async function initImageIndex(outputName) {
  if (outputName) {
    await _buildPluginIndex(outputName);
    return;
  }

  // Build index for every known plugin in parallel
  const knownPlugins = window.allData ? Object.keys(window.allData) : [];
  if (knownPlugins.length === 0) {
    // allData not ready yet — just fetch the tree so it's cached
    await _fetchRepoTree();
    return;
  }

  await Promise.all(knownPlugins.map(name => _buildPluginIndex(name)));
}


// ─── Public: setCurrentPlugin ─────────────────────────────────────────────────

function setCurrentPlugin(outputName) {
  _currentPlugin = outputName;
  // Eagerly build index for this plugin if not already done
  if (outputName) _buildPluginIndex(outputName);
}


// ─── Public: findImageVariations ─────────────────────────────────────────────

/**
 * Searches one plugin's index for all frames matching basePath.
 * Returns [] if not found.
 */
function findImageVariations(basePath, outputName) {
  const target = outputName || _currentPlugin;
  if (!target) return [];

  const pluginIdx = _pluginIndexes[target];
  if (!pluginIdx?.ready) return [];

  return _searchIndex(pluginIdx.index, basePath);
}


/**
 * Internal: search a single index object for basePath.
 */
function _searchIndex(index, basePath) {
  // Normalise: strip leading slash, extension, trailing separator+number
  let key = basePath.replace(/^\/+/, '');
  key = key.replace(/\.(png|jpg|jpeg)$/i, '');
  key = key.replace(/[+~\-\^=@]\d+$/, '');
  key = key.replace(/[+~\-\^=@]$/, '');

  // Exact match
  if (index[key]?.length) return index[key];

  // Suffix match (handles paths that omit leading folder names)
  const suffix  = '/' + key;
  const matches = Object.keys(index).filter(k => k === key || k.endsWith(suffix));

  if (matches.length === 1) return index[matches[0]];
  if (matches.length  > 1) {
    // Prefer longest (most specific) match
    matches.sort((a, b) => b.length - a.length);
    return index[matches[0]];
  }

  return [];
}


/**
 * Searches all loaded plugin indexes in priority order:
 * current plugin first, then all others.
 * Returns { frames, sourcePlugin } or null.
 */
function _findAcrossPlugins(basePath) {
  // Build search order: current plugin first
  const order = _currentPlugin ? [_currentPlugin] : [];
  for (const name of Object.keys(_pluginIndexes)) {
    if (name !== _currentPlugin) order.push(name);
  }

  for (const name of order) {
    const pluginIdx = _pluginIndexes[name];
    if (!pluginIdx?.ready) continue;
    const frames = _searchIndex(pluginIdx.index, basePath);
    if (frames.length) return { frames, sourcePlugin: name };
  }

  return null;
}


// ─── Public: clearSpriteCache ─────────────────────────────────────────────────

function clearSpriteCache() {
  if (_active) {
    _active.dispose();
    _active = null;
  }
  _fetchGen++;
}


// ─── Internal: render frames to canvas/img ────────────────────────────────────
// Shared by fetchSprite and fetchSpriteExact. Does NOT call EffectGrabber.

async function _renderFrames(frames, spriteParams, myGen) {
  const blobResults = await Promise.all(frames.map(async frame => {
    try {
      const res = await fetch(frame.url);
      if (!res.ok) return null;
      return { variation: frame.variation, blob: await res.blob(), url: frame.url, path: frame.fullPath };
    } catch { return null; }
  }));

  if (_fetchGen !== myGen) return null;

  const variations = blobResults.filter(Boolean);
  if (!variations.length) return null;

  if (variations.length === 1) {
    const objectUrl = URL.createObjectURL(variations[0].blob);
    _active = { dispose: () => URL.revokeObjectURL(objectUrl) };
    const img = document.createElement('img');
    img.src = objectUrl;
    img.style.cssText =
      'max-width:100%;max-height:500px;object-fit:contain;' +
      'image-rendering:pixelated;display:block;';
    return img;
  }

  if (typeof window.EndlessSkyAnimator !== 'function') {
    console.error('fetchSprite: EndlessSkyAnimator not loaded');
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'max-width:100%;image-rendering:pixelated;display:block;';

  const anim = new window.EndlessSkyAnimator(canvas);
  _active = anim;

  await anim.loadVariations(variations, spriteParams);
  if (_fetchGen !== myGen) return null;

  anim.play();
  return canvas;
}


// ─── Internal: fetchSpriteExact ───────────────────────────────────────────────
// Looks up spritePath in the image indexes ONLY — no EffectGrabber call.
// Used by EffectGrabber to avoid the circular call chain:
//   fetchSprite → fetchEffectByName → fetchSprite (infinite loop)

async function _fetchSpriteExact(spritePath, spriteParams) {
  spriteParams = spriteParams || {};
  const myGen  = _fetchGen;

  if (!spritePath) return null;

  if (_currentPlugin && !_pluginIndexes[_currentPlugin]?.ready) {
    await _buildPluginIndex(_currentPlugin);
  }
  if (_fetchGen !== myGen) return null;

  let found = _findAcrossPlugins(spritePath);

  if (!found) {
    found = _findAcrossPlugins('effect/' + spritePath);
    if (!found) {
      console.warn(`fetchSpriteExact: "${spritePath}" not found in any image index`);
      return null;
    }
    console.log(`fetchSpriteExact: found as "effect/${spritePath}" in "${found.sourcePlugin}"`);
  }

  if (_fetchGen !== myGen) return null;

  const result = await _renderFrames(found.frames, spriteParams, myGen);
  if (result === null && _fetchGen === myGen) {
    console.warn(`fetchSpriteExact: all frame fetches failed for "${spritePath}"`);
  }
  return result;
}


// ─── Public: fetchSprite ──────────────────────────────────────────────────────
// Full pipeline: tries EffectGrabber first (for named effects), then image index.

async function fetchSprite(spritePath, spriteParams) {
  spriteParams = spriteParams || {};
  const myGen  = _fetchGen;

  if (!spritePath) {
    console.warn('fetchSprite: no spritePath provided');
    return null;
  }

  if (_currentPlugin && !_pluginIndexes[_currentPlugin]?.ready) {
    await _buildPluginIndex(_currentPlugin);
  }
  if (_fetchGen !== myGen) return null;

  // ── Step 0: Try EffectGrabber for named effects (e.g. "remnant afterburner") ─
  // EffectGrabber calls _fetchSpriteExact (not fetchSprite) to avoid looping.
  if (typeof window.fetchEffectByName === 'function') {
    const effectResult = await window.fetchEffectByName(spritePath, spriteParams);
    if (effectResult !== null) {
      console.log('fetchSprite: resolved via EffectGrabber');
      return effectResult;
    }
  }
  if (_fetchGen !== myGen) return null;

  // ── Step 1: Image index search ─────────────────────────────────────────────
  let found = _findAcrossPlugins(spritePath);

  if (!found) {
    found = _findAcrossPlugins('effect/' + spritePath);
    if (!found) {
      console.warn(`fetchSprite: "${spritePath}" not found anywhere`);
      return null;
    }
    console.log(`fetchSprite: found as "effect/${spritePath}" in "${found.sourcePlugin}"`);
  } else if (found.sourcePlugin !== _currentPlugin) {
    console.log(`fetchSprite: "${spritePath}" not in current plugin, found in "${found.sourcePlugin}"`);
  }

  if (_fetchGen !== myGen) return null;

  const result = await _renderFrames(found.frames, spriteParams, myGen);
  if (result === null && _fetchGen === myGen) {
    console.warn(`fetchSprite: all frame fetches failed for "${spritePath}"`);
  }
  return result;
}


// ─── fetchEffectSprite (compat wrapper) ───────────────────────────────────────

async function fetchEffectSprite(effectNameOrPath, spriteParams) {
  if (!effectNameOrPath) {
    console.warn('fetchEffectSprite: no path provided');
    return null;
  }
  if (_currentPlugin && !_pluginIndexes[_currentPlugin]?.ready) {
    await _buildPluginIndex(_currentPlugin);
  }
  return fetchSprite(effectNameOrPath, spriteParams);
}


// ─── fetchOutfitEffects ───────────────────────────────────────────────────────

async function fetchOutfitEffects(outfit) {
  if (!outfit) return {};
  const results = {};
  const pairs = [
    ['flare sprite',         'flareSprite'],
    ['steering flare sprite','steeringFlareSprite'],
    ['reverse flare sprite', 'reverseFlareSprite'],
    ['afterburner effect',   'afterburnerEffect'],
  ];
  for (const [key, resultKey] of pairs) {
    if (!outfit[key]) continue;
    try {
      const sprite = await fetchEffectSprite(outfit[key], outfit.spriteData);
      if (sprite) results[resultKey] = sprite;
    } catch (err) {
      console.error(`fetchOutfitEffects: ${key} failed:`, err);
    }
  }
  return results;
}


// ─── Globals ──────────────────────────────────────────────────────────────────

window.initImageIndex      = initImageIndex;
window.setCurrentPlugin    = setCurrentPlugin;
window.findImageVariations = findImageVariations;
window.fetchSprite         = fetchSprite;
window.fetchSpriteExact    = _fetchSpriteExact;  // used by EffectGrabber to avoid circular calls
window.fetchEffectSprite   = fetchEffectSprite;
window.fetchOutfitEffects  = fetchOutfitEffects;
window.clearSpriteCache    = clearSpriteCache;

})();
