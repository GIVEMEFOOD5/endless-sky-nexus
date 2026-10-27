(function () {
'use strict';

// Finds and loads sprites (ships, outfits, planets, effects) from each plugin's images on GitHub, with animation frames.

// ── config ──

const GITHUB_REPO   = 'GIVEMEFOOD5/endless-sky-nexus';
const GITHUB_BRANCH = 'main';

// Base URL for raw image serving — works from any host, no GitHub Pages dependency
const GITHUB_PAGES_BASE = `https://raw.githubusercontent.com/GIVEMEFOOD5/endless-sky-nexus/main/data/`;
    
// Raw GitHub URL base for API
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;

// Image extensions
const IMG_EXT_RE = /\.(png|jpg|jpeg)$/i;

// Animation separator chars used in ES filenames


// ── state ──

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


// the repo's file list (fetched once)

async function _fetchRepoTree() {
  if (_repoTree)        return _repoTree;
  if (_repoTreeFetching) return _repoTreeFetching;

  _repoTreeFetching = (async () => {
    // GitHub allows ~60 of these an hour per visitor, so keep the list in the
    // browser until the parser publishes new data (one fetch per data version)
    const fetchTree = async () => {
      const res = await fetch(GITHUB_API_BASE, { headers: { Accept: 'application/vnd.github.v3+json' } });
      if (!res.ok) throw new Error(`GitHub API returned ${res.status}${res.status === 403 ? ' (hourly limit reached — try again later)' : ''}`);
      const data = await res.json();
      return data.tree || [];
    };
    try {
      _repoTree = window.EsCache ? await window.EsCache.loadWithCache('imageRepoTree', fetchTree) : await fetchTree();
      console.log(`ImageGrabber: repo tree ready — ${_repoTree.length} entries`);
    } catch (err) {
      // a failed fetch isn't cached, so the next page load tries again
      console.warn('ImageGrabber: could not get the image list:', err.message);
      _repoTree = [];
    }
    _repoTreeFetching = null;
    return _repoTree;
  })();

  return _repoTreeFetching;
}


// ── per-plugin image index ──

// index of one plugin's images/ folder
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


// ── public ──

// build the indexes up front (startup / plugin change)
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


// which plugin to look in first

function setCurrentPlugin(outputName) {
  _currentPlugin = outputName;
  // Eagerly build index for this plugin if not already done
  if (outputName) _buildPluginIndex(outputName);
}


// ─── Public: findImageVariations ─────────────────────────────────────────────

// every frame of a sprite in one plugin
function findImageVariations(basePath, outputName) {
  const target = outputName || _currentPlugin;
  if (!target) return [];

  const pluginIdx = _pluginIndexes[target];
  if (!pluginIdx?.ready) return [];

  return _searchIndex(pluginIdx.index, basePath);
}


// search one index
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


// search every plugin (current first)
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


// forget loaded sprites

function clearSpriteCache() {
  if (_active) {
    _active.dispose();
    _active = null;
  }
  _fetchGen++;
}


// frames → animated canvas or image

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


// load a sprite exactly as named

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


// load a sprite (image index, then fallbacks). Called by: the Data Viewer, map, builder

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

  // 1. the image index
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


// effect sprite (old name)

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


// an outfit's effect sprites

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


// ── globals ──

window.initImageIndex      = initImageIndex;
window.setCurrentPlugin    = setCurrentPlugin;
window.findImageVariations = findImageVariations;
window.fetchSprite         = fetchSprite;
window.fetchSpriteExact    = _fetchSpriteExact;  // used by EffectGrabber to avoid circular calls
window.fetchEffectSprite   = fetchEffectSprite;
window.fetchOutfitEffects  = fetchOutfitEffects;
window.clearSpriteCache    = clearSpriteCache;

})();
