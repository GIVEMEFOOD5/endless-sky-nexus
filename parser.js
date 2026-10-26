// The data parser (GitHub Action): reads the game and every plugin, then writes ships, outfits, map and missions to Supabase.

const https           = require('https');
const http            = require('http');
const SpeciesResolver = require('./speciesResolver');
const LocationResolver = require('./locationResolver');
const EndlessSkyMapParser     = require('./mapParser');
const EndlessSkyMissionParser = require('./missionParser');
const { parseAttributes } = require('./attributeParser');
const { syncAttributeTables } = require('./attributeSync');
const { PushCache, codeHash } = require('./pushCache');
const PluginRefs = require('./Display/JavaScript/pluginRefs.js');
const crypto          = require('crypto');
const fs              = require('fs').promises;
const path            = require('path');
const { exec: execCallback } = require('child_process');
const { promisify }   = require('util');
const exec            = promisify(execCallback);
const AdmZip          = require('adm-zip');
const tar             = require('tar');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are GitHub secrets) ──
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// internal_id → database id, for building junction rows
const shipIdByInternalId    = new Map();
const outfitIdByInternalId  = new Map();
const variantIdByInternalId = new Map();

// ── archive plugins (zip / tar) ──

// Recognised archive extensions, in the order they should be tested
// (longest/most-specific suffix first, e.g. ".tar.gz" before ".gz").
const ARCHIVE_EXTENSIONS = ['.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar', '.zip'];

// archive extension of a file name
function detectArchiveExtension(urlOrName) {
  const lower = urlOrName.toLowerCase().split('?')[0];
  for (const ext of ARCHIVE_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext;
  }
  return null;
}

// download a URL to a file (follows redirects)
function downloadToFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https://') ? https : http;
    const options = { headers: { 'User-Agent': 'endless-sky-parser' } };
    client.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        downloadToFile(res.headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
        return;
      }
      const fsSync = require('fs');
      const fileStream = fsSync.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(() => resolve()));
      fileStream.on('error', reject);
    }).on('error', reject);
  });
}

// unpack an archive by its extension
async function extractArchive(archivePath, destDir, ext) {
  await fs.mkdir(destDir, { recursive: true });

  if (ext === '.zip') {
    const zip = new AdmZip(archivePath);
    zip.extractAllTo(destDir, true);
    return;
  }

  if (ext === '.tar' || ext === '.tar.gz' || ext === '.tgz') {
    await tar.extract({ file: archivePath, cwd: destDir });
    return;
  }

  if (ext === '.tar.bz2' || ext === '.tbz2') {
    // The `tar` package doesn't decompress bzip2 itself; shell out to bzip2 + tar.
    try {
      await exec(`bzip2 -dc "${archivePath}" | tar -x -C "${destDir}"`);
    } catch (err) {
      throw new Error(
        `Failed to extract .tar.bz2 archive (is bzip2 installed on the runner?): ${err.message}`
      );
    }
    return;
  }

  throw new Error(`Unsupported archive extension: ${ext}`);
}

// stable hash for a ship (detects changes)
function hashShip(ship) {
  const relevant = {
    sprite:          ship.sprite          ?? null,
    thumbnail:       ship.thumbnail       ?? null,
    description:     ship.description     ?? null,
    attributes:      ship.attributes      ?? {},
    outfitMap:       ship.outfitMap       ?? {},
    engines:         ship.engines         ?? [],
    reverseEngines:  ship.reverseEngines  ?? [],
    steeringEngines: ship.steeringEngines ?? [],
    guns:            ship.guns            ?? [],
    turrets:         ship.turrets         ?? [],
    bays:            ship.bays            ?? [],
    leaks:           ship.leaks           ?? [],  // included so leak-only differences are detected
  };
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(relevant))
    .digest('hex')
    .slice(0, 12);
}

// outfit map → the stored format
function outfitMapToOutputFormat(outfitMap) {
  if (!outfitMap || typeof outfitMap !== 'object') return {};
  const result = {};
  for (const [name, val] of Object.entries(outfitMap)) {
    if (typeof val === 'object' && val !== null) {
      const pluginId = val.pluginId ?? null;
      result[name] = { count: val.count ?? 1, pluginId, internalId: pluginId != null ? `${pluginId}::${name}` : null };
    } else {
      result[name] = { count: Number(val) || 1, pluginId: null, internalId: null };
    }
  }
  return result;
}

// ── weapon blocks: one normalised shape ──

// "Name" / "Name" 3 / Name 3 → { name, count }
function matchGovernmentLine(stripped) {
  const m = stripped.match(/^government\s+(?:"([^"]+)"|`([^`]+)`|(\S+))\s*$/);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

// "Name" N → { name, count }
function parseNameCount(raw) {
    if (typeof raw !== 'string') return null;
    raw = raw.trim();
    // Quoted name with optional trailing integer: "OutfitName" 3
    const quotedMatch = raw.match(/^["'`]([^"'`]+)["'`](?:\s+(\d+))?$/);
    if (quotedMatch) {
        return { name: quotedMatch[1], count: quotedMatch[2] ? parseInt(quotedMatch[2], 10) : 1 };
    }
    // Unquoted name with trailing integer: OutfitName 2
    const unquotedCountMatch = raw.match(/^(.+?)\s+(\d+)$/);
    if (unquotedCountMatch) {
        return { name: unquotedCountMatch[1].trim(), count: parseInt(unquotedCountMatch[2], 10) };
    }
    // Plain name, no count
    return { name: raw, count: 1 };
}

// tidy a weapon block
function normaliseWeaponBlock(weapon, outfitsByName) {
    if (!weapon || typeof weapon !== 'object') return weapon;

    const submunitions = [];  // { type, count }
    const ammunition   = [];  // { type, count }
    const keysToDelete = [];

    // ── 1. weapon.ammo = "OutfitName" | "OutfitName 3" | "\"OutfitName\" 3" ──
    if (weapon.ammo != null) {
        if (typeof weapon.ammo === 'string' && weapon.ammo.length > 0) {
            const parsed = parseNameCount(weapon.ammo);
            if (parsed) ammunition.push({ type: parsed.name, count: parsed.count });
        }
        keysToDelete.push('ammo');
    }

    // 2. weapon.submunition (string, object or list)
    if (weapon.submunition != null) {
        const raw     = weapon.submunition;
        const entries = Array.isArray(raw) ? raw : [raw];
        for (const entry of entries) {
            if (typeof entry === 'string' && entry.length > 0) {
                // May be "OutfitName", "OutfitName 2", or '"OutfitName" 2'
                const parsed = parseNameCount(entry);
                if (parsed) submunitions.push({ type: parsed.name, count: parsed.count });
            } else if (typeof entry === 'object' && entry !== null) {
                // Already a sub-block: { name: "X", count: N }
                const subName  = entry.name ?? entry.type ?? null;
                const subCount = typeof entry.count === 'number' ? entry.count : 1;
                if (subName) submunitions.push({ type: subName, count: subCount });
            }
        }
        keysToDelete.push('submunition');
    }

    // 3. "submunition Name" keys
    for (const key of Object.keys(weapon)) {
        if (!key.startsWith('submunition ')) continue;
        const subName = key.slice('submunition '.length).trim();
        if (!subName) continue;
        const val = weapon[key];
        let count = 1;
        if (Array.isArray(val))                           count = val.length;
        else if (typeof val === 'number' && val > 0)      count = Math.round(val);
        else if (typeof val === 'object' && val !== null) count = 1;
        submunitions.push({ type: subName, count });
        keysToDelete.push(key);
    }

    // 4. loose keys — best-effort ammo / submunition detection
    for (const key of Object.keys(weapon)) {
        if (keysToDelete.includes(key)) continue;
        if (key === 'ammo' || key === 'submunition') continue;

        const val = weapon[key];
        if (val === false || val === 0 || val === null || val === undefined) continue;
        if (typeof val !== 'number' && val !== true) continue;

        const entries = outfitsByName ? outfitsByName.get(key) : null;
        if (!entries || entries.length === 0) continue;

        const outfit = entries[0]?.outfit;
        if (!outfit) continue;

        const isAmmo =
            outfit.category === 'Ammunition' ||
            (typeof outfit.ammoStored === 'number' && outfit.ammoStored > 0) ||
            (typeof outfit.attributes?.[key] === 'number' && outfit.attributes[key] > 0) ||
            Object.entries(outfit.attributes || {}).some(
                ([k, v]) => k.endsWith(' capacity') && typeof v === 'number' && v < 0
            );

        const isSubmunition = !isAmmo && !!outfit.weapon;

        if (isAmmo) {
            const count = val === true ? 1 : Math.max(1, Math.round(val));
            ammunition.push({ type: key, count });
            keysToDelete.push(key);
        } else if (isSubmunition) {
            const count = val === true ? 1 : Math.max(1, Math.round(val));
            submunitions.push({ type: key, count });
            keysToDelete.push(key);
        }
    }

    // write the normalised lists
    for (const k of keysToDelete) delete weapon[k];

    if (submunitions.length > 0) weapon.submunitions = submunitions;
    if (ammunition.length   > 0) weapon.ammunition   = ammunition;

    return weapon;
}

// ---------------------------------------------------------------------------
class EndlessSkyParser {
  constructor() {
    this.ships           = [];
    this.variants        = [];
    this.outfits         = [];
    this.effects         = [];
    this.pendingVariants = [];

    this.shipById    = new Map();
    this.shipsByName = new Map();

    this.outfitsByName = new Map();

    this._sourcePriority = new Map();
    this._overrides      = new Map();
    this._currentPluginId = null;

    this._currentRepoShipsBefore = 0;
    this._currentRepoShipsAfter  = 0;

    // fleets named inside npc blocks (missions and events)
    this._pendingNpcFleetRefs = [];

    // Populated by resolveEventGovernmentImpact() — the joined
    // event → fleet → government answer. See that method for shape.
    this.eventGovernmentImpacts = [];

    this.speciesResolver  = new SpeciesResolver();
    this.locationResolver = new LocationResolver();
    this.mapParser     = new EndlessSkyMapParser();
    this.missionParser2 = new EndlessSkyMissionParser();
  }

  setSourcePriority(sources) {
    this._sourcePriority.clear();
    sources.forEach((source, index) => {
      this._sourcePriority.set(source.name, index);
        this.mapParser.setSourcePriority(sources);
        this.missionParser2.setSourcePriority(sources);
    });
  }

  setOverrides(sources) {
    this._overrides.clear();
    for (const source of sources) {
      if (source.overrides?.length) {
        this._overrides.set(source.name, new Set(source.overrides));
      }
    }
  }

  _registerShip(ship, pluginId) {
    const internalId = `${pluginId}::${ship.name}`;
    ship._internalId = internalId;
    ship._pluginId   = pluginId;
    ship._hash       = hashShip(ship);

    this.shipById.set(internalId, ship);
    if (!this.shipsByName.has(ship.name)) this.shipsByName.set(ship.name, []);
    this.shipsByName.get(ship.name).push(ship);
    return internalId;
  }

  // give every outfit its internal id and plugin
  _registerOutfit(outfit, pluginId) {
    outfit._internalId = `${pluginId}::${outfit.name}`;
    outfit._pluginId = pluginId;
    const name = outfit.name;
    if (!this.outfitsByName.has(name)) this.outfitsByName.set(name, []);
    this.outfitsByName.get(name).push({ pluginId, outfit });
  }

  _resolveOutfitPluginId(outfitName, preferPluginId) {
    const entries = this.outfitsByName.get(outfitName);
    if (!entries || entries.length === 0) return null;
    if (preferPluginId) {
      const local = entries.find(e => e.pluginId === preferPluginId);
      if (local) return local.pluginId;
    }
    const sorted = [...entries].sort((a, b) => {
      const pa = this._sourcePriority.get(a.pluginId) ?? Infinity;
      const pb = this._sourcePriority.get(b.pluginId) ?? Infinity;
      return pa - pb;
    });
    return sorted[0].pluginId;
  }

  _resolveBaseShip(baseName, variantPluginId) {
    const localId   = `${variantPluginId}::${baseName}`;
    const localShip = this.shipById.get(localId);
    if (localShip) return { baseShip: localShip, error: null };

    const candidates = this.shipsByName.get(baseName) ?? [];
    if (candidates.length === 0) return { baseShip: null, error: `no base ship found for "${baseName}"` };
    if (candidates.length === 1) return { baseShip: candidates[0], error: null };

    const hashes = new Set(candidates.map(s => s._hash));
    if (hashes.size === 1) return { baseShip: candidates[0], error: null };

    // overrides are keyed by the source name
    const variantSourceName = variantPluginId ? variantPluginId.split('/')[0] : null;
    const variantOverrides = this._overrides.get(variantSourceName);
    if (variantOverrides?.size) {
      const overriddenCandidates = candidates.filter(s => variantOverrides.has(s._pluginId));
      if (overriddenCandidates.length === 1) {
        console.log(`    ↳ Collision on "${baseName}" resolved via override: using ${overriddenCandidates[0]._pluginId}`);
        return { baseShip: overriddenCandidates[0], error: null };
      }
    }

    const ranked = [...candidates].sort((a, b) => {
      const pa = this._sourcePriority.get(a._pluginId) ?? Infinity;
      const pb = this._sourcePriority.get(b._pluginId) ?? Infinity;
      return pa - pb;
    });
    const winner = ranked[0];
    const losers = ranked.slice(1).map(s => s._pluginId).join(', ');
    // same ship + same plugins → mention once
    this._collisionSeen = this._collisionSeen || new Map();
    const ckey = `${baseName}|${losers}`;
    this._collisionSeen.set(ckey, (this._collisionSeen.get(ckey) || 0) + 1);
    if (this._collisionSeen.get(ckey) > 1) return { baseShip: winner, error: null };
    console.warn(
      `    ⚠ Collision on base ship "${baseName}" for variant in "${variantPluginId}". ` +
      `Plugins with this ship: ${candidates.map(s => s._pluginId).join(', ')}. ` +
      `Resolved by source order — using "${winner._pluginId}" (overridden: ${losers}). ` +
      `Add an "overrides" declaration to plugins.json to silence this warning.`
    );
    return { baseShip: winner, error: null };
  }

  fetchUrl(url) {
    return new Promise((resolve, reject) => {
      const options = { headers: {} };
      if (process.env.GITHUB_TOKEN && url.includes('api.github.com')) {
        options.headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
        options.headers['User-Agent']    = 'endless-sky-parser';
      }
      https.get(url, options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end',  ()    => { resolve(data); });
      }).on('error', reject);
    });
  }

  async detectDefaultBranch(owner, repo) {
    try {
      const raw  = await this.fetchUrl(`https://api.github.com/repos/${owner}/${repo}`);
      const data = JSON.parse(raw);
      if (data.default_branch) return data.default_branch;
    } catch (e) {
      console.warn(`Could not detect default branch: ${e.message}`);
    }
    return 'master';
  }

  async findTxtFiles(dir) {
    const results = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) results.push(...await this.findTxtFiles(full));
      else if (e.name.endsWith('.txt')) results.push(full);
    }
    return results;
  }

  async detectPluginsViaLsTree(repoGitUrl, branch, repoName, keepDir = null) {
    // With keepDir, the blob-less clone made for the probe is kept there and
    // reused for the real (sparse) checkout instead of cloning again.
    const tmpDir = keepDir || path.join(process.cwd(), `.tmp-lstree-${repoName}-${Date.now()}`);
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      // In detectPluginsViaLsTree, replace the clone line:
      let authenticatedUrl = repoGitUrl;
      if (process.env.GITHUB_TOKEN) {
        authenticatedUrl = repoGitUrl.replace(
          'https://github.com/',
          `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/`
        );
      }
      await exec(`git clone --filter=blob:none --no-checkout --depth 1 --single-branch --branch ${branch} ${authenticatedUrl} "${tmpDir}"`);
      const { stdout } = await exec(`git -C "${tmpDir}" ls-tree -r --name-only -t HEAD`);
      const allPaths = stdout.trim().split('\n').filter(Boolean);
      const plugins = [];
      for (const p of allPaths) {
        const basename = path.basename(p);
        if (basename !== 'data') continue;
        const hasTxt = allPaths.some(f => f.startsWith(p + '/') && f.endsWith('.txt'));
        if (!hasTxt) continue;
        const parentDir = path.dirname(p);
        const pluginRootInRepo = (parentDir === '.' || parentDir === '') ? '.' : parentDir;
        const pluginName = pluginRootInRepo === '.' ? repoName : path.basename(pluginRootInRepo);
        const imagesPath = pluginRootInRepo === '.' ? 'images' : `${pluginRootInRepo}/images`;
        const hasImages = allPaths.includes(imagesPath);
        plugins.push({ name: pluginName, pluginRootInRepo, hasImages });
      }
      // some plugins bundle a copy of another plugin's data — skip the copy
      plugins.sort((a, b) => a.pluginRootInRepo.split('/').length - b.pluginRootInRepo.split('/').length);
      const kept = [];
      for (const p of plugins) {
        const isNestedInsideKept = kept.some(k =>
          k.pluginRootInRepo !== '.' && p.pluginRootInRepo.startsWith(k.pluginRootInRepo + '/')
        );
        if (isNestedInsideKept) {
          console.log(`  Skipping "${p.name}" — nested inside an already-detected plugin, would duplicate its content.`);
        } else {
          kept.push(p);
        }
      }
      return kept;
    } finally {
      if (!keepDir) await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async detectPlugins(cloneDir, repoName) {
    const plugins = [];
    const walk = async (dir) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const fullPath = path.join(dir, e.name);
        if (e.name === 'data') {
          // .txt anywhere under data/ counts
          const hasTxtDeep = async d => {
            let es; try { es = await fs.readdir(d, { withFileTypes: true }); } catch { return false; }
            for (const x of es) {
              if (x.isFile() && x.name.endsWith('.txt')) return true;
              if (x.isDirectory() && await hasTxtDeep(path.join(d, x.name))) return true;
            }
            return false;
          };
          if (!(await hasTxtDeep(fullPath))) continue;
          const pluginRoot = dir;
          const pluginName = pluginRoot === cloneDir ? repoName : path.basename(pluginRoot);
          const pluginRootInRepo = path.relative(cloneDir, pluginRoot) || '.';
          const imagesDir = path.join(pluginRoot, 'images');
          let hasImages = false;
          try { await fs.access(imagesDir); hasImages = true; } catch {}
          plugins.push({ name: pluginName, dataDir: fullPath, imagesDir: hasImages ? imagesDir : null, pluginRootInRepo });
          continue;
        }
        await walk(fullPath);
      }
    };
    await walk(cloneDir);
    return plugins;
  }

  // copy every image into the output
  async copyAllImages(sourceDir, destDir) {
    const validExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.avif', '.webp']);
    let fileCount = 0;

    const walk = async (srcDir, outDir) => {
      let entries;
      try { entries = await fs.readdir(srcDir, { withFileTypes: true }); }
      catch { return; } // folder vanished or was never there — nothing to copy
      let madeDir = false;
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const srcPath = path.join(srcDir, e.name);
        if (e.isDirectory()) {
          await walk(srcPath, path.join(outDir, e.name));
          continue;
        }
        if (!validExts.has(path.extname(e.name).toLowerCase())) continue;
        if (!madeDir) { await fs.mkdir(outDir, { recursive: true }); madeDir = true; }
        await fs.copyFile(srcPath, path.join(outDir, e.name));
        fileCount++;
      }
    };

    await walk(sourceDir, destDir);
    return fileCount;
  }

  async copyImagesForPlugin(sourceImagesDir, destImagesDir) {
    if (!sourceImagesDir) { console.log('  No images folder, skipping.'); return; }
    console.log('  Copying entire images/ folder...');
    const fileCount = await this.copyAllImages(sourceImagesDir, destImagesDir);
    console.log(`  ✓ Copied ${fileCount} image files`);
  }

  // parse one plugin folder (git or archive)
  async _parsePluginFolder(clonedPlugin, pluginId, pluginRoot) {
    const pluginData = await this.readPluginTxt(pluginRoot);
    if (pluginData?.name) {
      console.log(`  plugin.txt name: "${pluginData.name}"`);
    }

    this._currentPluginId = pluginId;

    const shipsBefore   = this.ships.length;
    const outfitsBefore = this.outfits.length;
    const effectsBefore = this.effects.length;

    const txtFiles = await this.findTxtFiles(clonedPlugin.dataDir);
    console.log(`  Parsing ${txtFiles.length} data files...`);
    for (const f of txtFiles) {
      this.parseFileContent(await fs.readFile(f, 'utf8'), f, clonedPlugin.dataDir);
    }

    console.log(`  → +${this.ships.length - shipsBefore} ships, +${this.outfits.length - outfitsBefore} outfits, +${this.effects.length - effectsBefore} effects`);

    return {
      name:         clonedPlugin.name,
      pluginData,
      pluginId,
      imagesDir:    clonedPlugin.imagesDir,
      shipsBefore,
      shipsAfter:   this.ships.length,
      outfitsBefore,
      outfitsAfter: this.outfits.length,
      effectsBefore,
      effectsAfter: this.effects.length
    };
  }

  // finish a batch of plugin folders
  async _finalisePluginBatch(pluginMeta, repoPendingBefore, sourceIdentifier) {
    this._currentPluginId = null;

    for (const pv of this.pendingVariants.slice(repoPendingBefore)) {
      pv.repoShipsAfter = this.ships.length;
    }

    const repoPending = this.pendingVariants.slice(repoPendingBefore);
    console.log(`\n  Processing ${repoPending.length} variants from this source against ${this.ships.length} total ships (across all sources)...`);
    this.processVariants(repoPending);
    console.log(`  → ${this.variants.length} total variants kept so far`);

    const results = [];

    for (const meta of pluginMeta) {
      const pluginShips   = this.ships.slice(meta.shipsBefore,   meta.shipsAfter);
      const pluginOutfits = this.outfits.slice(meta.outfitsBefore, meta.outfitsAfter);
      const pluginEffects = this.effects.slice(meta.effectsBefore, meta.effectsAfter);

      const pluginShipNames = new Set(pluginShips.map(s => s.name));
      const pluginVariants  = this.variants.filter(v =>
        pluginShipNames.has(v.baseShip) || (v._variantPluginId === meta.pluginId)
      );

      // map- or mission-only plugins still count
      const metaMapSlice = this.mapParser.toPluginSlice(meta.pluginId);
      const metaMissionSlice = this.missionParser2.toPluginSlice(meta.pluginId);
      const hasMapOrMissionContent =
        metaMapSlice.systems.length > 0 || metaMapSlice.galaxies.length > 0 ||
        metaMapSlice.planets.length > 0 || metaMapSlice.wormholes.length > 0 ||
        metaMapSlice.stars.length > 0 || metaMapSlice.governments.length > 0 ||
        metaMissionSlice.length > 0;

      const isEmpty = pluginShips.length === 0 && pluginVariants.length === 0 &&
                      pluginOutfits.length === 0 && pluginEffects.length === 0 &&
                      !hasMapOrMissionContent;

      if (isEmpty) {
        console.log(`  Skipping "${meta.name}" - no parseable content found.`);
        continue;
      }

      console.log(`  Plugin "${meta.name}": ${pluginShips.length} ships, ${pluginVariants.length} variants, ${pluginOutfits.length} outfits, ${pluginEffects.length} effects, ${metaMapSlice.systems.length} systems, ${metaMissionSlice.length} missions`);

      const destImagesDir = path.join(process.cwd(), 'data', meta.name, 'images');
      await this.copyImagesForPlugin(meta.imagesDir, destImagesDir);

      results.push({
        name:       meta.name,
        pluginData: meta.pluginData,
        outputName: meta.name,
        pluginId:   meta.pluginId,
        repository: sourceIdentifier,
        ships:      pluginShips,
        variants:   pluginVariants,
        outfits:    pluginOutfits,
        effects:    pluginEffects,
      });
    }

    return results;
  }

  async parseRepository(repoUrl, sourceName = null) {
    const urlMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!urlMatch) throw new Error('Invalid GitHub URL: ' + repoUrl);

    const owner = urlMatch[1];
    const repo  = urlMatch[2].replace('.git', '');

    let branch;
    const branchMatch = repoUrl.match(/\/tree\/([^\/]+)/);
    if (branchMatch) {
      branch = branchMatch[1];
    } else {
      branch = await this.detectDefaultBranch(owner, repo);
      console.log(`  Detected default branch: ${branch}`);
    }

    const repoGitUrl = `https://github.com/${owner}/${repo}.git`;
    console.log(`\nScanning: ${owner}/${repo} @ ${branch}`);

    // one shallow clone per repository, then a sparse checkout per plugin
    const repoCloneDir = path.join(process.cwd(), `.tmp-repo-${repo}-${Date.now()}`);
    let probePlugins;
    try {
      probePlugins = await this.detectPluginsViaLsTree(repoGitUrl, branch, repo, repoCloneDir);
    } catch (err) {
      await fs.rm(repoCloneDir, { recursive: true, force: true });
      throw new Error(`Failed to probe repository structure: ${err.message}`);
    }

    if (probePlugins.length === 0) {
      await fs.rm(repoCloneDir, { recursive: true, force: true });
      console.log('No valid plugin data folders detected.');
      return [];
    }

    let clonedAll;
    try {
      const folders = [];
      for (const p of probePlugins) {
        const root = p.pluginRootInRepo;
        folders.push(root === '.' ? 'data' : `${root}/data`);
        if (p.hasImages) folders.push(root === '.' ? 'images' : `${root}/images`);
      }
      console.log(`  Checking out data/ and images/ for ${probePlugins.length} plugin(s)...`);
      await exec(`git -C "${repoCloneDir}" sparse-checkout init --cone`);
      await exec(`git -C "${repoCloneDir}" sparse-checkout set ${folders.map(f => `"${f}"`).join(' ')}`);
      await exec(`git -C "${repoCloneDir}" checkout ${branch}`);
      clonedAll = await this.detectPlugins(repoCloneDir, repo);
    } catch (err) {
      await fs.rm(repoCloneDir, { recursive: true, force: true });
      throw new Error(`Sparse checkout failed for ${repoGitUrl}: ${err.stderr || err.message}`);
    }

    console.log(`Found ${probePlugins.length} plugin(s): ${probePlugins.map(p => p.name).join(', ')}`);

    const repoPendingBefore = this.pendingVariants.length;
    this._currentRepoShipsBefore = this.ships.length;

    const pluginMeta = [];
    const cloneDirs  = [repoCloneDir];

    for (const probe of probePlugins) {
      console.log(`\n  ── Plugin: ${probe.name} ──`);
      const pluginId = `${sourceName}/${probe.name}`;
      const root     = probe.pluginRootInRepo;

      try {
        // Match by location in the repository (names can repeat across folders).
        const clonedPlugin = clonedAll.find(p => p.pluginRootInRepo === root)
          || clonedAll.find(p => p.name === probe.name);

        if (!clonedPlugin) {
          console.warn(`  Could not locate plugin "${probe.name}" in clone, skipping.`);
          continue;
        }

        const pluginRoot = root === '.' ? repoCloneDir : path.join(repoCloneDir, root);
        const meta = await this._parsePluginFolder(clonedPlugin, pluginId, pluginRoot);
        pluginMeta.push(meta);

      } catch (err) {
        for (const d of cloneDirs) await fs.rm(d, { recursive: true, force: true });
        throw err;
      }
    }

    this._currentRepoShipsAfter = this.ships.length;

    try {
      return await this._finalisePluginBatch(pluginMeta, repoPendingBefore, repoUrl);
    } finally {
      for (const d of cloneDirs) await fs.rm(d, { recursive: true, force: true });
    }
  }

  // parse an archive source (the archive version of parseRepository)
  async parseArchiveSource(archiveUrl, sourceName = null) {
    const ext = detectArchiveExtension(archiveUrl);
    if (!ext) {
      throw new Error(
        `Could not determine archive type for "${archiveUrl}". ` +
        `Supported extensions: ${ARCHIVE_EXTENSIONS.join(', ')}`
      );
    }

    console.log(`\nScanning archive: ${archiveUrl}`);

    const workDir      = path.join(process.cwd(), `.tmp-archive-${sourceName}-${Date.now()}`);
    const downloadPath = path.join(workDir, `download${ext}`);
    const extractDir   = path.join(workDir, 'extracted');

    await fs.mkdir(workDir, { recursive: true });

    try {
      console.log(`  Downloading archive...`);
      await downloadToFile(archiveUrl, downloadPath);

      console.log(`  Extracting (${ext})...`);
      await extractArchive(downloadPath, extractDir, ext);

      const detectedPlugins = await this.detectPlugins(extractDir, sourceName);

      if (detectedPlugins.length === 0) {
        console.log('  No valid plugin data folders detected inside archive.');
        return [];
      }

      console.log(`  Found ${detectedPlugins.length} plugin(s) in archive: ${detectedPlugins.map(p => p.name).join(', ')}`);

      const repoPendingBefore = this.pendingVariants.length;
      this._currentRepoShipsBefore = this.ships.length;

      const pluginMeta = [];
      for (const clonedPlugin of detectedPlugins) {
        console.log(`\n  ── Plugin: ${clonedPlugin.name} ──`);
        const pluginId    = `${sourceName}/${clonedPlugin.name}`;
        const pluginRoot  = clonedPlugin.pluginRootInRepo === '.'
          ? extractDir
          : path.join(extractDir, clonedPlugin.pluginRootInRepo);
        const meta = await this._parsePluginFolder(clonedPlugin, pluginId, pluginRoot);
        pluginMeta.push(meta);
      }

      this._currentRepoShipsAfter = this.ships.length;

      return await this._finalisePluginBatch(pluginMeta, repoPendingBefore, archiveUrl);

    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  parseFileContent(content, filePath, dataDir) {
    const lines = content.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line    = lines[i];
      const trimmed = line.trim();
      const indent  = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0) {
        if (trimmed.startsWith('ship ')) {
          const [d, ni] = this.parseShip(lines, i);
          if (d) {
            this._registerShip(d, this._currentPluginId);
            if (d.description != null) this.ships.push(d);
          }
          i = ni; continue;
        } else if (trimmed.startsWith('outfit ')) {
          const [d, ni] = this.parseOutfit(lines, i);
          if (d) {
            this._registerOutfit(d, this._currentPluginId);
            this.outfits.push(d);
          }
          i = ni; continue;
        } else if (trimmed.startsWith('effect ')) {
          const [d, ni] = this.parseExtraEffect(lines, i);
          if (d) {
            d._pluginId = this._currentPluginId;
            this.effects.push(d);
          }
          i = ni; continue;
        } else if (trimmed.startsWith('fleet ')) {
          i = this.parseFleetBlock(lines, i); continue;
        } else if (trimmed.startsWith('mission ')) {
          const [m, ni] = this.missionParser2.parseMissionBlock(lines, i, this._currentPluginId);
          if (m) this.missionParser2.register(m, this._currentPluginId);
          i = this.parseMissionBlock(lines, i); continue;
        } else if (trimmed.startsWith('shipyard ')) {
          i = this.parseShipyardBlock(lines, i); continue;
        } else if (trimmed.startsWith('outfitter ')) {
          i = this.parseOutfitterBlock(lines, i); continue;
        } else if (trimmed.startsWith('planet ') || trimmed.startsWith('"planet"')) {
          this.mapParser.parsePlanetBlock(lines, i, this._currentPluginId);
          i = this.parsePlanetBlock(lines, i); continue;
        } else if (trimmed.startsWith('event ') || trimmed === 'event') {
          this._captureRawEvent(lines, i);
          i = this.parseEventBlock(lines, i); continue;
        } else if (trimmed.startsWith('system ')) {
          this.mapParser.parseSystemBlock(lines, i, this._currentPluginId);
          i = this.parseSystemBlock(lines, i); continue;
        } else if (trimmed.startsWith('person ')) {
          i = this.parsePersonBlock(lines, i); continue;
        } else if (trimmed.startsWith('galaxy ')) {
          i = this.mapParser.parseGalaxyBlock(lines, i, this._currentPluginId); continue;
        } else if (trimmed.startsWith('wormhole ')) {
          i = this.mapParser.parseWormholeBlock(lines, i, this._currentPluginId); continue;
        } else if (trimmed.startsWith('star ')) {
          i = this.mapParser.parseStarBlock(lines, i, this._currentPluginId); continue;
        } else if (trimmed.startsWith('government ')) {
          i = this.mapParser.parseGovernmentBlock(lines, i, this._currentPluginId); continue;
        } else if (trimmed.startsWith('color ')) {
          i = this.mapParser.parseNamedColorLine(lines, i, this._currentPluginId); continue;
        } else if (trimmed.startsWith('"landing message"')) {
          i = this.mapParser.parseLandingMessageBlock(lines, i, this._currentPluginId); continue;
        }
      }
      i++;
    }
  }

  // person "X" blocks (named ships that fly around)
  parsePersonBlock(lines, i) {
    const headerLine = lines[i].trim();
    const nameMatch = headerLine.match(/^person\s+"([^"]+)"/) ||
                      headerLine.match(/^person\s+`([^`]+)`/);
    const personName = nameMatch ? nameMatch[1] : null;
    const personIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    let government = null;
    const shipNames = [];
    const systemNames = [];
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= personIndent && line.trim()) break;
      const stripped = line.trim();

      if (indent === personIndent + 1) {
        const govName = matchGovernmentLine(stripped);
        if (govName !== null) { government = govName; i++; continue; }

        const sysMatch = stripped.match(/^system\s+"([^"]+)"/) ||
                          stripped.match(/^system\s+`([^`]+)`/) ||
                          stripped.match(/^system\s+(\S+)\s*$/);
        if (sysMatch) { systemNames.push(sysMatch[1]); i++; continue; }

        // `ship "Model" ["Custom Name"]`
        const shipMatch = stripped.match(
          /^ship\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(?:"([^"]*)"|`([^`]*)`|(\S+)))?\s*$/
        );
        if (shipMatch) {
          const model = shipMatch[1] ?? shipMatch[2] ?? shipMatch[3] ?? null;
          if (model) shipNames.push(model);
          // a ship line may have its own sub-block
          if (i + 1 < lines.length) {
            const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
            if (nextIndent > indent) {
              i = this.skipIndentedBlock(lines, i, indent);
              continue;
            }
          }
          i++; continue;
        }
      }
      i++;
    }

    for (const shipName of shipNames) {
      // Feeds the same resolution path as npc-block ships.
      this.speciesResolver.collectNpcRef(government, shipName, this._currentPluginId);
      // Dedicated traceability + location output.
      this.speciesResolver.collectPerson(personName, government, shipName, this._currentPluginId);
      this.locationResolver.collectPerson(personName, shipName, this._currentPluginId);
      for (const systemName of systemNames) {
        this.locationResolver.collectPersonSystem(personName, systemName, this._currentPluginId);
      }
    }
    return i;
  }

  // fleet blocks (relative indents, variants, governments)
  parseFleetBlock(lines, i) {
    const headerLine = lines[i].trim();
    const nameMatch = headerLine.match(/^fleet\s+"([^"]+)"/) ||
                      headerLine.match(/^fleet\s+`([^`]+)`/);
    const fleetName = nameMatch ? nameMatch[1] : null;
    const fleetIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    let government = null;
    const shipNames = [];
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= fleetIndent && line.trim()) break;
      const stripped = line.trim();

      if (indent === fleetIndent + 1) {
        const govName = matchGovernmentLine(stripped);
        if (govName !== null) { government = govName; i++; continue; }

        // `variant [weight]` / `add variant [weight]`
        const variantMatch = stripped.match(/^(?:add\s+)?variant(?:\s+(\d+))?\s*$/);
        if (variantMatch) {
          const variantIndent = indent;
          i++;
          while (i < lines.length) {
            const vl = lines[i];
            const vi = vl.length - vl.replace(/^\t+/, '').length;
            if (vi <= variantIndent && vl.trim()) break;
            const vs = vl.trim();
            const vm = vs.match(/^"([^"]+)"(?:\s+\d+)?$/) || vs.match(/^`([^`]+)`(?:\s+\d+)?$/);
            if (vm) shipNames.push(vm[1]);
            i++;
          }
          continue;
        }
      }

      // flat form: "Ship" [weight] under the fleet
      if (indent === fleetIndent + 1 || indent === fleetIndent + 2) {
        const shipMatch = stripped.match(/^"([^"]+)"(?:\s+\d+)?$/) ||
                          stripped.match(/^`([^`]+)`(?:\s+\d+)?$/);
        if (shipMatch) shipNames.push(shipMatch[1]);
      }
      i++;
    }
    this.speciesResolver.collectFleet(government, shipNames, this._currentPluginId, fleetName);
    this.locationResolver.collectFleet(fleetName, shipNames, this._currentPluginId);
    return i;
  }

  parseMissionBlock(lines, i) {
    const headerLine = lines[i].trim();
    const nameMatch = headerLine.match(/^mission\s+"([^"]+)"/) ||
                      headerLine.match(/^mission\s+`([^`]+)`/);
    const missionName = nameMatch ? nameMatch[1] : null;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const stripped = line.trim();
      if (stripped === 'npc' || stripped.startsWith('npc ')) {
        i = this._parseMissionNpcBlock(lines, i, missionName); continue;
      }

      // give outfit (quotes optional)
      if (missionName) {
        const om =
          stripped.match(/^give\s+outfit\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(-?\d+))?\s*$/) ||
          stripped.match(/^outfit\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(-?\d+))?\s*$/);
        if (om) {
          const outfitName = om[1] ?? om[2] ?? om[3] ?? null;
          const count = om[4] ? parseInt(om[4], 10) : 1;
          if (outfitName && count > 0) {
            this.locationResolver.collectMissionGiveOutfit(missionName, outfitName, count, this._currentPluginId);
          }
          // NOTE: count <= 0 ("take away") lines are matched but still not
          // recorded anywhere — unchanged limitation, flagged not silent.
          i++; continue;
        }
      }

      // give ship (quotes optional)
      if (missionName) {
        const sm =
          stripped.match(/^give\s+ship\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(?:"([^"]*)"|`([^`]*)`|(\S+)))?\s*$/) ||
          stripped.match(/^ship\s+(?:"([^"]+)"|`([^`]+)`|(\S+))(?:\s+(?:"([^"]*)"|`([^`]*)`|(\S+)))?\s*$/);
        if (sm) {
          const shipModel = sm[1] ?? sm[2] ?? sm[3] ?? null;
          // custom name (kept even though unused)
          if (shipModel) {
            this.locationResolver.collectMissionGiveShip(missionName, shipModel, this._currentPluginId);
          }
          i++; continue;
        }
      }

      // `event "X"` — this mission can trigger an event
      if (missionName) {
        const evM = stripped.match(/^event\s+"([^"]+)"(?:\s+-?\d+(?:\s+-?\d+)?)?\s*$/) ||
                    stripped.match(/^event\s+`([^`]+)`(?:\s+-?\d+(?:\s+-?\d+)?)?\s*$/);
        if (evM) {
          this.locationResolver.collectMissionEventTrigger(missionName, evM[1], this._currentPluginId);
          i++; continue;
        }
      }

      i++;
    }
    return i;
  }

  // npc block inside a mission
  _parseMissionNpcBlock(lines, i, missionName) {
    let government = null;
    const shipNames = [];
    const npcIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= npcIndent && line.trim()) break;
      const stripped = line.trim();
      if (indent === npcIndent + 1) {
        const npcGovName = matchGovernmentLine(stripped);
        if (npcGovName !== null) {
          government = npcGovName;
          this.speciesResolver.knownGovernments.add(government);
          i++; continue;
        }
        const shipTwoArg = stripped.match(/^ship\s+"([^"]+)"\s+"[^"]*"/) ||
                           stripped.match(/^ship\s+`([^`]+)`\s+`[^`]*`/);
        const shipOneArg = stripped.match(/^ship\s+"([^"]+)"$/) ||
                           stripped.match(/^ship\s+`([^`]+)`$/);
        if (shipTwoArg) { shipNames.push(shipTwoArg[1]); i++; continue; }
        if (shipOneArg) { shipNames.push(shipOneArg[1]); i++; continue; }
        if (stripped === 'fleet' || stripped.startsWith('fleet ')) {
          // named fleet, e.g. `fleet "Marauder Raid"`
          const namedMatch = stripped.match(/^fleet\s+"([^"]+)"\s*$/) || stripped.match(/^fleet\s+`([^`]+)`\s*$/);
          if (namedMatch) {
            this._pendingNpcFleetRefs.push({
              fleetName: namedMatch[1],
              government,             // the npc's own government line, if any — used as a fallback only; the fleet's OWN government (resolved later) takes precedence
              missionName,
              eventName: null,
              pluginId: this._currentPluginId,
            });
            i++; continue;
          }
          // inline fleet: the ship names under it
          const fleetIndent = indent;
          let inlineGovernment = null;
          const inlineShipNames = [];
          i++;
          while (i < lines.length) {
            const fl = lines[i];
            const fi = fl.length - fl.replace(/^\t+/, '').length;
            if (fi <= fleetIndent && fl.trim()) break;
            const fs2 = fl.trim();
            if (fi === fleetIndent + 1) {
              const fgn = matchGovernmentLine(fs2);
              if (fgn !== null) {
                inlineGovernment = fgn;
                this.speciesResolver.knownGovernments.add(inlineGovernment);
                i++; continue;
              }
            }
            if (fi > fleetIndent + 1) {
              const fm = fs2.match(/^"([^"]+)"(?:\s+\d+)?$/) || fs2.match(/^`([^`]+)`(?:\s+\d+)?$/);
              if (fm) inlineShipNames.push(fm[1]);
            }
            i++;
          }
          // inline fleet ships use its own government
          const effectiveGovernment = inlineGovernment ?? government;
          for (const shipName of inlineShipNames) {
            this.speciesResolver.collectNpcRef(effectiveGovernment, shipName, this._currentPluginId);
            if (missionName) this.locationResolver.collectMissionNpcShip(missionName, shipName, this._currentPluginId);
          }
          continue;
        }
      }
      i++;
    }
    for (const shipName of shipNames) {
      this.speciesResolver.collectNpcRef(government, shipName, this._currentPluginId);
      if (missionName) this.locationResolver.collectMissionNpcShip(missionName, shipName, this._currentPluginId);
    }
    return i;
  }

  // npc block inside an event
  parseNpcBlock(lines, i, eventName = null) {
    let government = null;
    const shipNames = [];
    const npcIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= npcIndent && line.trim()) break;
      const stripped = line.trim();
      if (indent === npcIndent + 1) {
        const npcGovName = matchGovernmentLine(stripped);
        if (npcGovName !== null) {
          government = npcGovName;
          this.speciesResolver.knownGovernments.add(government);
          i++; continue;
        }
        const shipTwoArg = stripped.match(/^ship\s+"([^"]+)"\s+"[^"]*"/) ||
                           stripped.match(/^ship\s+`([^`]+)`\s+`[^`]*`/);
        const shipOneArg = stripped.match(/^ship\s+"([^"]+)"$/) ||
                           stripped.match(/^ship\s+`([^`]+)`$/);
        if (shipTwoArg) { shipNames.push(shipTwoArg[1]); i++; continue; }
        if (shipOneArg) { shipNames.push(shipOneArg[1]); i++; continue; }
        if (stripped === 'fleet' || stripped.startsWith('fleet ')) {
          const namedMatch = stripped.match(/^fleet\s+"([^"]+)"\s*$/) || stripped.match(/^fleet\s+`([^`]+)`\s*$/);
          if (namedMatch) {
            this._pendingNpcFleetRefs.push({
              fleetName: namedMatch[1],
              government,
              missionName: null,
              eventName,
              pluginId: this._currentPluginId,
            });
            i++; continue;
          }
          // inline fleet (same as missions)
          const fleetIndent = indent;
          let inlineGovernment = null;
          const inlineShipNames = [];
          i++;
          while (i < lines.length) {
            const fl = lines[i];
            const fi = fl.length - fl.replace(/^\t+/, '').length;
            if (fi <= fleetIndent && fl.trim()) break;
            const fs2 = fl.trim();
            if (fi === fleetIndent + 1) {
              const fgn = matchGovernmentLine(fs2);
              if (fgn !== null) {
                inlineGovernment = fgn;
                this.speciesResolver.knownGovernments.add(inlineGovernment);
                i++; continue;
              }
            }
            if (fi > fleetIndent + 1) {
              const fm = fs2.match(/^"([^"]+)"(?:\s+\d+)?$/) || fs2.match(/^`([^`]+)`(?:\s+\d+)?$/);
              if (fm) inlineShipNames.push(fm[1]);
            }
            i++;
          }
          const effectiveGovernment = inlineGovernment ?? government;
          for (const shipName of inlineShipNames) {
            this.speciesResolver.collectNpcRef(effectiveGovernment, shipName, this._currentPluginId);
          }
          continue;
        }
      }
      i++;
    }
    for (const shipName of shipNames) {
      this.speciesResolver.collectNpcRef(government, shipName, this._currentPluginId);
    }
    return i;
  }

  parseOutfitsBlock(lines, i, speciesShipName = null, variantShipName = null, shipPluginId = null) {
    const outfitMap = {};
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= 1 && line.trim()) break;
      if (indent >= 2) {
      const m = line.trim().match(/^"([^"]+)"(?:\s+(\d+))?/) ||
                line.trim().match(/^`([^`]+)`(?:\s+(\d+))?/);
        if (m) {
          const name     = m[1];
          const count    = m[2] ? Math.max(1, parseInt(m[2], 10)) : 1;
          const pluginId = this._resolveOutfitPluginId(name, shipPluginId ?? this._currentPluginId);
          outfitMap[name] = { count, pluginId };
        }
      }
      i++;
    }
    if (speciesShipName && Object.keys(outfitMap).length) {
      this.speciesResolver.collectShipOutfits(
        speciesShipName, Object.keys(outfitMap), this._currentPluginId, variantShipName
      );
      const locName = variantShipName ?? speciesShipName;
      for (const outfitName of Object.keys(outfitMap)) {
        const effectiveShipPluginId = shipPluginId ?? this._currentPluginId;
        this.locationResolver.collectShipOutfit(locName, outfitName, outfitMap[outfitName].pluginId, effectiveShipPluginId);
      }
    }
    return [outfitMap, i];
  }

  // shipyard block
  parseShipyardBlock(lines, i) {
    const headerMatch =
      lines[i].trim().match(/^shipyard\s+"([^"]+)"/) ||
      lines[i].trim().match(/^shipyard\s+`([^`]+)`/) ||
      lines[i].trim().match(/^shipyard\s+(\S+)/);
    if (!headerMatch) return i + 1;
    const name = headerMatch[1];
    const ships = [];
    const baseIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= baseIndent && line.trim()) break;
      const m = line.trim().match(/^"([^"]+)"/) || line.trim().match(/^`([^`]+)`/);
      if (m) ships.push(m[1]);
      i++;
    }
    this.speciesResolver.collectShipyard(name, ships, this._currentPluginId);
    this.locationResolver.collectShipyard(name, ships, this._currentPluginId);
    return i;
  }

  // outfitter block
  parseOutfitterBlock(lines, i) {
    const headerMatch =
      lines[i].trim().match(/^outfitter\s+"([^"]+)"/) ||
      lines[i].trim().match(/^outfitter\s+`([^`]+)`/) ||
      lines[i].trim().match(/^outfitter\s+(\S+)/);
    if (!headerMatch) return i + 1;
    const name = headerMatch[1];
    const outfits = [];
    const baseIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= baseIndent && line.trim()) break;
      const m = line.trim().match(/^"([^"]+)"/) || line.trim().match(/^`([^`]+)`/);
      if (m) outfits.push(m[1]);
      i++;
    }
    this.speciesResolver.collectOutfitter(name, outfits, this._currentPluginId);
    this.locationResolver.collectOutfitter(name, outfits, this._currentPluginId);
    return i;
  }

  // planet block (eventName = changed by that event)
  parsePlanetBlock(lines, i, eventName = null) {
    const headerMatch =
      lines[i].trim().match(/^(?:"planet"|planet)\s+"([^"]+)"/) ||
      lines[i].trim().match(/^(?:"planet"|planet)\s+`([^`]+)`/) ||
      lines[i].trim().match(/^(?:"planet"|planet)\s+(\S+)/);
    if (!headerMatch) { return this.skipIndentedBlock(lines, i, 0); }
    const planetName = headerMatch[1];
    let government = null;
    const shipyards  = [];
    const outfitters = [];
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const stripped = line.trim();
      const planetGovName = matchGovernmentLine(stripped);
      const syMatch =
        stripped.match(/^shipyard\s+"([^"]+)"/) ||
        stripped.match(/^shipyard\s+`([^`]+)`/) ||
        stripped.match(/^shipyard\s+(\S+)/);
      const addSyMatch =
        stripped.match(/^add\s+shipyard\s+"([^"]+)"/) ||
        stripped.match(/^add\s+shipyard\s+`([^`]+)`/) ||
        stripped.match(/^add\s+shipyard\s+(\S+)/);
      // NEW: remove shipyard / add outfitter / remove outfitter — none of
      // these were previously recognized at all.
      const removeSyMatch =
        stripped.match(/^remove\s+shipyard\s+"([^"]+)"/) ||
        stripped.match(/^remove\s+shipyard\s+`([^`]+)`/) ||
        stripped.match(/^remove\s+shipyard\s+(\S+)/);
      const addOfMatch =
        stripped.match(/^add\s+outfitter\s+"([^"]+)"/) ||
        stripped.match(/^add\s+outfitter\s+`([^`]+)`/) ||
        stripped.match(/^add\s+outfitter\s+(\S+)/);
      const removeOfMatch =
        stripped.match(/^remove\s+outfitter\s+"([^"]+)"/) ||
        stripped.match(/^remove\s+outfitter\s+`([^`]+)`/) ||
        stripped.match(/^remove\s+outfitter\s+(\S+)/);
      const ofMatch =
        stripped.match(/^outfitter\s+"([^"]+)"/) ||
        stripped.match(/^outfitter\s+`([^`]+)`/) ||
        stripped.match(/^outfitter\s+(\S+)/);

      if (planetGovName !== null) government = planetGovName;
      if (syMatch)    shipyards.push(syMatch[1]);
      if (ofMatch)    outfitters.push(ofMatch[1]);
      if (addSyMatch) {
        shipyards.push(addSyMatch[1]);
        // Unconditional base behavior — unchanged from before.
        this.locationResolver.collectEventPlanetShipyardAdd(planetName, addSyMatch[1], this._currentPluginId);
        // NEW: also record the traceable, event-tagged version.
        this.locationResolver.collectEventPlanetShipyardChange(planetName, addSyMatch[1], 'add', eventName, this._currentPluginId);
      }
      if (removeSyMatch) {
        this.locationResolver.collectEventPlanetShipyardChange(planetName, removeSyMatch[1], 'remove', eventName, this._currentPluginId);
      }
      if (addOfMatch) {
        outfitters.push(addOfMatch[1]);
        this.locationResolver.collectEventPlanetOutfitterChange(planetName, addOfMatch[1], 'add', eventName, this._currentPluginId);
      }
      if (removeOfMatch) {
        this.locationResolver.collectEventPlanetOutfitterChange(planetName, removeOfMatch[1], 'remove', eventName, this._currentPluginId);
      }
      i++;
    }
    this.speciesResolver.collectPlanet(planetName, government, shipyards, outfitters, this._currentPluginId);
    this.locationResolver.collectPlanet(planetName, shipyards, outfitters, this._currentPluginId);
    return i;
  }

  parseSystemBlock(lines, i) {
    const headerLine = lines[i].trim();
    const nameMatch = headerLine.match(/^system\s+"([^"]+)"/) ||
                      headerLine.match(/^system\s+`([^`]+)`/)  ||
                      headerLine.match(/^system\s+(\S+)/);
    const systemName = nameMatch ? nameMatch[1] : null;
    if (!systemName) return i + 1;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const stripped = line.trim();
      if (indent === 1) {
        const fleetMatch = stripped.match(/^fleet\s+"([^"]+)"/) || stripped.match(/^fleet\s+`([^`]+)`/);
        if (fleetMatch) {
          this.locationResolver.collectFleetInSystem(fleetMatch[1], systemName, this._currentPluginId);
          i++; continue;
        }
      }
      if (stripped.startsWith('planet ') || stripped === 'planet') {
        const pm = stripped.match(/^planet\s+"([^"]+)"/) ||
                   stripped.match(/^planet\s+`([^`]+)`/)  ||
                   stripped.match(/^planet\s+(\S+)/);
        if (pm) this.locationResolver.collectPlanetInSystem(pm[1], systemName, this._currentPluginId);
      }
      i++;
    }
    return i;
  }

  // capture an event's raw changes (for the map timeline)
  _captureRawEvent(lines, i) {
    const header = lines[i].trim();
    const m = header.match(/^event\s+"([^"]+)"/) || header.match(/^event\s+`([^`]+)`/) || header.match(/^event\s+(\S+)/);
    if (!m || !this._currentPluginId) return;
    const out = [lines[i].replace(/\r$/, '')];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].replace(/\r$/, '');
      if (line.trim() && !/^\s/.test(line)) break;            // next top-level node
      out.push(line);
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    if (!this.rawEvents) this.rawEvents = [];
    this.rawEvents.push({ plugin_id: this._currentPluginId, name: m[1], raw: out.join('\n') });
  }

  parseEventBlock(lines, i) {
    const headerMatch = lines[i].trim().match(/^event\s+"([^"]+)"/) || lines[i].trim().match(/^event\s+`([^`]+)`/);
    const eventName = headerMatch ? headerMatch[1] : null;
    i++;
    while (i < lines.length) {
      const line   = lines[i];
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent === 0 && line.trim()) break;
      const stripped = line.trim();
      if (indent >= 1) {
        if (stripped.startsWith('fleet ') || stripped === 'fleet') { i = this.parseFleetBlock(lines, i); continue; }
        if (stripped.startsWith('planet ') || stripped.startsWith('"planet"')) { i = this.parsePlanetBlock(lines, i, eventName); continue; }
        if (stripped.startsWith('shipyard ')) { i = this.parseShipyardBlock(lines, i); continue; }
        if (stripped.startsWith('outfitter ')) { i = this.parseOutfitterBlock(lines, i); continue; }
        if (stripped === 'npc' || stripped.startsWith('npc ')) { i = this.parseNpcBlock(lines, i, eventName); continue; }

        // ── NEW: system "X" sub-block — add/remove fleet spawns.
        const sysMatch = stripped.match(/^system\s+"([^"]+)"/) || stripped.match(/^system\s+`([^`]+)`/) || stripped.match(/^system\s+(\S+)/);
        if (sysMatch) {
          const systemName = sysMatch[1];
          const sysIndent  = indent;
          i++;
          while (i < lines.length) {
            const sl = lines[i];
            const si = sl.length - sl.replace(/^\t+/, '').length;
            if (si <= sysIndent && sl.trim()) break;
            const ss = sl.trim();
            const addFleetM    = ss.match(/^add\s+fleet\s+"([^"]+)"(?:\s+(\d+))?/) || ss.match(/^add\s+fleet\s+`([^`]+)`(?:\s+(\d+))?/);
            const removeFleetM = ss.match(/^remove\s+fleet\s+"([^"]+)"/)           || ss.match(/^remove\s+fleet\s+`([^`]+)`/);
            if (addFleetM) {
              this.locationResolver.collectEventSystemFleetChange(
                eventName, systemName, addFleetM[1], 'add',
                addFleetM[2] ? parseInt(addFleetM[2], 10) : null,
                this._currentPluginId
              );
            } else if (removeFleetM) {
              this.locationResolver.collectEventSystemFleetChange(
                eventName, systemName, removeFleetM[1], 'remove', null, this._currentPluginId
              );
            }
            i++;
          }
          continue;
        }

        // ── NEW: government "X" sub-block — "attitude toward" changes.
        const eventGovName = matchGovernmentLine(stripped);
        if (eventGovName !== null) {
          const govName   = eventGovName;
          const govIndent = indent;
          this.speciesResolver.knownGovernments.add(govName);
          i++;
          let inAttitude = false;
          while (i < lines.length) {
            const gl = lines[i];
            const gi = gl.length - gl.replace(/^\t+/, '').length;
            if (gi <= govIndent && gl.trim()) break;
            const gs = gl.trim();
            if (gs === '"attitude toward"' || gs === 'attitude toward') {
              inAttitude = true; i++; continue;
            }
            if (inAttitude && gi > govIndent + 1) {
              // target government without quotes too
              const atM = gs.match(/^(?:"([^"]+)"|`([^`]+)`|(\S+))\s+(-?[\d.]+)/);
              if (atM) {
                const targetGov = atM[1] ?? atM[2] ?? atM[3];
                this.speciesResolver.knownGovernments.add(targetGov);
                this.speciesResolver.collectEventGovernmentAttitudeChange(
                  eventName, govName, targetGov, parseFloat(atM[4]), this._currentPluginId
                );
              }
            }
            i++;
          }
          continue;
        }
      }
      i++;
    }
    return i;
  }

  parseBlock(lines, startIdx, options = {}) {
    const data = {};
    let i = startIdx;
    const baseIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    let descriptionLines = [];

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (line.trim().startsWith('#')) { i++; continue; }
      const currentIndent = line.length - line.replace(/^\t+/, '').length;
      if (currentIndent < baseIndent) break;
      if (currentIndent === baseIndent) {
        const stripped = line.trim();
        if (options.parseHardpoints) {
          const hr = this.parseHardpoint(stripped, lines, i, currentIndent);
          if (hr) {
            const [type, hdata, ni] = hr;
            if (!data[type]) data[type] = [];
            data[type].push(hdata);
            i = ni; continue;
          }
        }
        if (options.skipBlocks && options.skipBlocks.includes(stripped)) {
          i = this.skipIndentedBlock(lines, i, currentIndent); continue;
        }
        if (stripped === 'description' || stripped.startsWith('description ')) {
          const [desc, ni] = this.parseDescription(lines, i, currentIndent);
          if (desc) descriptionLines.push(...desc);
          i = ni; continue;
        }
        if (stripped.startsWith('sprite ') || stripped.startsWith('"flare sprite"') ||
            stripped.startsWith('"steering flare sprite"') || stripped.startsWith('"reverse flare sprite"') ||
            stripped.startsWith('"afterburner effect"')) {
          const [sd, ni] = this.parseSpriteWithData(lines, i, currentIndent);
          Object.assign(data, sd);
          i = ni; continue;
        }
        if (i + 1 < lines.length) {
          const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
          if (nextIndent > currentIndent) {
            const key = stripped.replace(/["`]/g, '');
            // weapon blocks (outfits and ships)
            const nestedOptions = (key === 'weapon') ? { ...options, numericAware: true } : options;
            const [nd, ni] = this.parseBlock(lines, i + 1, nestedOptions);
            if (key in data) {
              if (!Array.isArray(data[key])) data[key] = [data[key]];
              data[key].push(nd);
            } else { data[key] = nd; }
            i = ni; continue;
          }
        }
        const subAmmoMatch =
            stripped.match(/^(?:"submunition"|submunition)\s+"([^"]+)"\s+(\d+)$/) ||
            stripped.match(/^(?:"submunition"|submunition)\s+`([^`]+)`\s+(\d+)$/) ||
            stripped.match(/^(?:"ammo"|ammo)\s+"([^"]+)"\s+(\d+)$/)               ||
            stripped.match(/^(?:"ammo"|ammo)\s+`([^`]+)`\s+(\d+)$/);
        if (subAmmoMatch) {
            const isAmmo  = stripped.trimStart().replace(/^"/, '').startsWith('ammo');
            const key     = isAmmo ? 'ammo' : 'submunition';
            const val     = `"${subAmmoMatch[1]}" ${subAmmoMatch[2]}`;  // preserve for parseNameCount
            if (key in data) {
                if (!Array.isArray(data[key])) data[key] = [data[key]];
                data[key].push(val);
            } else { data[key] = val; }
            i++; continue;
        }

        if (options.numericAware) {
          const kv = this.parseNumericAwareLine(stripped);
          if (kv) {
            const [k, v] = kv;
            this.mergeAttributeValue(data, k, v);
            i++; continue;
          }
        } else {
          const kv = this.parseKeyValue(stripped);
          if (kv) {
            const [k, v] = kv;
            if (k in data) {
              if (!Array.isArray(data[k])) data[k] = [data[k]];
              data[k].push(v);
            } else { data[k] = v; }
            i++; continue;
          }
        }
        descriptionLines.push(stripped);
      }
      i++;
    }
    if (descriptionLines.length > 0) data.description = descriptionLines.join(' ');
    return [data, i];
  }

  parseKeyValue(stripped) {
    const patterns = [
      { regex: /"([^"]+)"\s+"([^"]+)"/,        ki: 1, vi: 2, str: true  },
      { regex: /"([^"]+)"\s+`([^`]+)`/,        ki: 1, vi: 2, str: true  },
      { regex: /`([^`]+)`\s+"([^"]+)"/,        ki: 1, vi: 2, str: true  },
      { regex: /`([^`]+)`\s+`([^`]+)`/,        ki: 1, vi: 2, str: true  },
      { regex: /"([^"]+)"\s+([^"`\s][^"`]*)/, ki: 1, vi: 2, str: false },
      { regex: /`([^`]+)`\s+([^"`\s][^"`]*)/, ki: 1, vi: 2, str: false },
      { regex: /^(\S+)\s+"([^"]+)"$/,          ki: 1, vi: 2, str: true  },
      { regex: /^(\S+)\s+`([^`]+)`$/,          ki: 1, vi: 2, str: true  },
      { regex: /^(\S+)\s+(.+)$/,               ki: 1, vi: 2, str: false, noQ: true }
    ];
    for (const p of patterns) {
      if (p.noQ && (stripped.includes('"') || stripped.includes('`'))) continue;
      const m = stripped.match(p.regex);
      if (m) {
        const k  = m[p.ki];
        const vs = m[p.vi].trim();
        const v  = p.str ? vs : (isNaN(parseFloat(vs)) ? vs : parseFloat(vs));
        return [k, v];
      }
    }
    const qk = stripped.match(/^["'`]([^"'`]+)["'`]$/);
    if (qk) return [qk[1], true];
    if (!stripped.includes(' ') && !stripped.includes('"') && !stripped.includes('`')) return [stripped, true];
    return null;
  }

  parseDescription(lines, i, baseIndent) {
    const stripped = lines[i].trim();
    const descLines = [];
    const single = stripped.match(/^description\s+"([^"]*)"$/) ||
                   stripped.match(/^description\s+`([^`]*)`$/);
    if (single) return [[single[1]], i + 1];
    const start = stripped.match(/^description\s+"(.*)$/) ||
                  stripped.match(/^description\s+`(.*)$/);
    if (start) {
      const st = start[1];
      if (st.endsWith('`') || st.endsWith('"')) return [[st.slice(0, -1)], i + 1];
      if (st) descLines.push(st);
      i++;
      while (i < lines.length) {
        const dl = lines[i], ds = dl.trim();
        if (ds.endsWith('`') || ds.endsWith('"')) {
          if (ds.slice(0, -1)) descLines.push(ds.slice(0, -1));
          return [descLines, i + 1];
        }
        const di = dl.length - dl.replace(/^\t+/, '').length;
        if (di <= baseIndent && dl.trim()) break;
        if (ds) descLines.push(ds);
        i++;
      }
      return [descLines, i];
    }
    i++;
    while (i < lines.length) {
      const dl = lines[i];
      const di = dl.length - dl.replace(/^\t+/, '').length;
      if (di <= baseIndent) break;
      if (dl.trim()) descLines.push(dl.trim());
      i++;
    }
    return [descLines, i];
  }

  parseSpriteWithData(lines, i, baseIndent) {
    const stripped = lines[i].trim();
    const FIELDS = [
      { key: 'sprite'               },
      { key: 'thumbnail'            },
      { key: 'flare sprite'         },
      { key: 'flare sound',           noSubBlock: true },
      { key: 'steering flare sprite' },
      { key: 'steering flare sound',  noSubBlock: true },
      { key: 'reverse flare sprite'  },
      { key: 'reverse flare sound',   noSubBlock: true },
      { key: 'afterburner effect'    },
      { key: 'afterburner sound',     noSubBlock: true },
    ];
    const esc     = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const kwPat   = (key) => `(?:"${esc(key)}"|` + '`' + `${esc(key)}` + '`' + `|'${esc(key)}'|${esc(key)})`;
    const pathPat = `(?:"([^"]+)"|` + '`([^`]+)`' + `|'([^']+)'|(\\S+))`;
    const extractPath = (m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? null;
    for (const f of FIELDS) {
      if (!f.re) f.re = new RegExp(`^${kwPat(f.key)}\\s+${pathPat}`);
    }
    for (const cfg of FIELDS) {
      const m = stripped.match(cfg.re);
      if (!m) continue;
      const pathValue = extractPath(m);
      if (!pathValue) continue;
      const result = { [cfg.key]: pathValue };
      if (!cfg.noSubBlock && i + 1 < lines.length) {
        const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
        if (nextIndent > baseIndent) {
          const [sd, nextIdx] = this.parseBlock(lines, i + 1);
          result[cfg.key + ' data'] = sd;
          return [result, nextIdx];
        }
      }
      return [result, i + 1];
    }
    return [{}, i + 1];
  }

  // hardpoint sub-block (angle, arc, zoom …)
  parseNumericAwareLine(stripped) {
    let key, rest;
    const qk = stripped.match(/^"([^"]+)"\s*(.*)$/) ||
               stripped.match(/^`([^`]+)`\s*(.*)$/) ||
               stripped.match(/^'([^']+)'\s*(.*)$/);
    if (qk) {
      key = qk[1]; rest = qk[2].trim();
    } else {
      const sp = stripped.indexOf(' ');
      if (sp === -1) { key = stripped; rest = ''; }
      else { key = stripped.slice(0, sp); rest = stripped.slice(sp + 1).trim(); }
    }
    if (!key) return null;
    if (rest === '') return [key, [true]];

    const qv = rest.match(/^"([^"]+)"$/) || rest.match(/^`([^`]+)`$/) || rest.match(/^'([^']+)'$/);
    if (qv) return [key, [qv[1]]];

    // Quoted value with a trailing extra token (e.g. a repeat count) —
    // keep just the quoted value, matching prior lossy-but-safe behavior.
    const qvPlus = rest.match(/^"([^"]+)"\s+(.+)$/) ||
                   rest.match(/^`([^`]+)`\s+(.+)$/) ||
                   rest.match(/^'([^']+)'\s+(.+)$/);
    if (qvPlus) return [key, [qvPlus[1]]];

    const tokens = rest.split(/\s+/);
    const isNumericToken = t => /^-?[\d.]+$/.test(t);
    if (tokens.every(isNumericToken)) {
      return [key, tokens.map(t => parseFloat(t))];
    }

    return [key, [rest]];
  }

  // merge a repeated attribute (add up or keep a list)
  mergeAttributeValue(data, key, values) {
    let outerKey = key;
    if (outerKey in data) {
      let n = 2;
      while ((`${key}_${n}`) in data) n++;
      outerKey = `${key}_${n}`;
    }
    if (values.length === 1) {
      data[outerKey] = values[0];
    } else {
      const nested = {};
      values.forEach((v, idx) => { nested[`${outerKey}_${idx + 1}`] = v; });
      data[outerKey] = nested;
    }
  }

  parseHardpointAttributes(lines, i, baseIndent, data) {
    if (i + 1 >= lines.length) return i + 1;
    const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
    if (nextIndent <= baseIndent) return i + 1;
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const indent = line.length - line.replace(/^\t+/, '').length;
      if (indent <= baseIndent) break;
      const kv = this.parseNumericAwareLine(line.trim());
      if (kv) {
        const [k, v] = kv;
        this.mergeAttributeValue(data, k, v);
      }
      i++;
    }
    return i;
  }

  parseHardpoint(stripped, lines, i, baseIndent) {
    if (stripped.match(/^["'`]?engine["'`]?\s+(-?[\d.]+)/)) {
      const p = stripped.replace(/["'`]/g, '').split(/\s+/).slice(1);
      const d = { x: +p[0], y: +p[1] };
      if (p[2] !== undefined && p[2] !== '') d.zoom = +p[2];
      const ni = this.parseHardpointAttributes(lines, i, baseIndent, d);
      return ['engines', d, ni];
    }
    if (stripped.match(/^["'`]?reverse engine["'`]?\s+(-?[\d.]+)/)) {
      const p = stripped.replace(/["'`]/g, '').split(/\s+/).slice(2);
      const d = { x: +p[0], y: +p[1] };
      if (p[2] !== undefined && p[2] !== '') d.zoom = +p[2];
      const ni = this.parseHardpointAttributes(lines, i, baseIndent, d);
      return ['reverseEngines', d, ni];
    }
    if (stripped.match(/^["'`]?steering engine["'`]?\s+(-?[\d.]+)/)) {
      const p = stripped.replace(/["'`]/g, '').split(/\s+/).slice(2);
      const d = { x: +p[0], y: +p[1] };
      if (p[2] !== undefined && p[2] !== '') d.zoom = +p[2];
      const ni = this.parseHardpointAttributes(lines, i, baseIndent, d);
      return ['steeringEngines', d, ni];
    }
    // gun <x> <y> ["Outfit Name"]  — the outfit name is optional and may be
    // quoted (names with spaces) or bare (single-word names).
    const gunMatch = stripped.match(
      /^["'`]?gun["'`]?\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(?:"([^"]+)"|`([^`]+)`|'([^']+)'|([^\s"'`]+)))?\s*$/
    );
    if (gunMatch) {
      const [, xs, ys, q1, q2, q3, bare] = gunMatch;
      const outfitName = q1 ?? q2 ?? q3 ?? bare ?? '';
      const d = { x: +xs, y: +ys, gun: outfitName };
      const ni = this.parseHardpointAttributes(lines, i, baseIndent, d);
      return ['guns', d, ni];
    }
    // turret <x> <y> ["Outfit Name"]  — same shape as gun.
    const turretMatch = stripped.match(
      /^["'`]?turret["'`]?\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(?:"([^"]+)"|`([^`]+)`|'([^']+)'|([^\s"'`]+)))?\s*$/
    );
    if (turretMatch) {
      const [, xs, ys, q1, q2, q3, bare] = turretMatch;
      const outfitName = q1 ?? q2 ?? q3 ?? bare ?? '';
      const d = { x: +xs, y: +ys, turret: outfitName };
      const ni = this.parseHardpointAttributes(lines, i, baseIndent, d);
      return ['turrets', d, ni];
    }
    const bm = stripped.match(/^["'`]?bay["'`]?\s+["'`]?([^"'`\s]+)["'`]?\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)(?:\s+(.+))?/);
    if (bm) {
      const d = { type: bm[1], x: +bm[2], y: +bm[3] };
      if (bm[4]) d.position = bm[4];
      const ni = this.parseHardpointAttributes(lines, i, baseIndent, d);
      return ['bays', d, ni];
    }
    return null;
  }

  // one leak line: leak "effect" open spread
  parseLeak(stripped) {
    const m =
      stripped.match(/^leak\s+"([^"]+)"\s+(\d+)\s+(\d+)$/) ||
      stripped.match(/^leak\s+`([^`]+)`\s+(\d+)\s+(\d+)$/);
    if (!m) return null;
    return {
      effect:       m[1],
      openChance:   parseInt(m[2], 10),
      spreadChance: parseInt(m[3], 10),
    };
  }

  skipIndentedBlock(lines, i, baseIndent) {
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      if (l.length - l.replace(/^\t+/, '').length <= baseIndent) break;
      i++;
    }
    return i;
  }

  _outfitMapsEqual(a, b) {
    const aKeys = Object.keys(a || {});
    const bKeys = Object.keys(b || {});
    if (aKeys.length !== bKeys.length) return false;
    const getCount = v => typeof v === 'object' ? (v.count ?? 1) : (v === true ? 1 : (v ?? 1));
    for (const k of aKeys) {
      if (getCount(a[k]) !== getCount(b[k])) return false;
    }
    return true;
  }

  parseShip(lines, startIdx) {
    const line = lines[startIdx].trim();
    const match = line.match(/^ship\s+"([^"]+)"(?:\s+"([^"]+)")?/) ||
                  line.match(/^ship\s+`([^`]+)`(?:\s+`([^`]+)`)?/) ||
                  line.match(/^ship\s+'([^']+)'(?:\s+'([^']+)')?/);
    if (!match) return [null, startIdx + 1];
    const [, baseName, variantName] = match;
    if (startIdx + 1 >= lines.length) return [null, startIdx + 1];
    const nextLine = lines[startIdx + 1];
    if (nextLine.trim() && (nextLine.length - nextLine.replace(/^\t+/, '').length) === 0) {
      return [null, startIdx + 1];
    }
    if (variantName) {
      this.pendingVariants.push({
        baseName, variantName, startIdx, lines,
        variantPluginId: this._currentPluginId,
        repoShipsBefore: this._currentRepoShipsBefore,
        repoShipsAfter:  null
      });
      return [null, this.skipIndentedBlock(lines, startIdx, 0)];
    }

    const shipData = {
      name: baseName,
      engines: [], reverseEngines: [], steeringEngines: [],
      guns: [], turrets: [], bays: [], leaks: [],
      outfitMap: {}
    };
    let i = startIdx + 1;
    while (i < lines.length) {
      const line2 = lines[i];
      if (!line2.trim() || line2.trim().startsWith('#')) { i++; continue; }
      const indent = line2.length - line2.replace(/^\t+/, '').length;
      if (indent < 1) break;
      const stripped = line2.trim();

      if (stripped === 'outfits') {
        const [outfitMap, ni] = this.parseOutfitsBlock(lines, i, baseName, null, this._currentPluginId);
        shipData.outfitMap = outfitMap;
        i = ni; continue;
      }
      if (stripped === 'add attributes') {
        i = this.skipIndentedBlock(lines, i, indent); continue;
      }

      // hardpoints
      const hr = this.parseHardpoint(stripped, lines, i, indent);
      if (hr) {
        const [type, hdata, ni] = hr;
        if (!shipData[type]) shipData[type] = [];
        shipData[type].push(hdata);
        i = ni; continue;
      }

      // leak lines
      const leak = this.parseLeak(stripped);
      if (leak) { shipData.leaks.push(leak); i++; continue; }

      if (stripped === 'description' || stripped.startsWith('description ')) {
        const [desc, ni] = this.parseDescription(lines, i, indent);
        if (desc) {
          shipData.description = shipData.description
            ? shipData.description + ' ' + desc.join(' ')
            : desc.join(' ');
        }
        i = ni; continue;
      }
      if (stripped.startsWith('sprite ') ||
          stripped.startsWith('"thumbnail"') || stripped.startsWith('thumbnail ') ||
          stripped.startsWith('"flare sprite"') || stripped.startsWith('"flare sound"') ||
          stripped.startsWith('"steering flare sprite"') || stripped.startsWith('"steering flare sound"') ||
          stripped.startsWith('"reverse flare sprite"') || stripped.startsWith('"reverse flare sound"') ||
          stripped.startsWith('"afterburner effect"') || stripped.startsWith('"afterburner sound"')) {
        const [sd, ni] = this.parseSpriteWithData(lines, i, indent);
        Object.assign(shipData, sd);
        i = ni; continue;
      }
      if (i + 1 < lines.length) {
        const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
        if (nextIndent > indent) {
          const key = stripped.replace(/^["'`]([^"'`]+)["'`]$/, '$1');
          const [nd, ni] = this.parseBlock(lines, i + 1, { parseHardpoints: false });
          shipData[key] = nd;
          i = ni; continue;
        }
      }
      const kv = this.parseKeyValue(stripped);
      if (kv) shipData[kv[0]] = kv[1];
      i++;
    }
    return [shipData, i];
  }

  parseShipVariant(variantInfo) {
    const { baseShip, error } = this._resolveBaseShip(
      variantInfo.baseName, variantInfo.variantPluginId
    );
    if (error) {
      console.warn(`  Skipping variant "${variantInfo.baseName} (${variantInfo.variantName})": ${error}`);
      return null;
    }
    const { startIdx, lines } = variantInfo;
    if (startIdx + 1 >= lines.length) return null;
    const nl = lines[startIdx + 1];
    if (nl.trim() && (nl.length - nl.replace(/^\t+/, '').length) === 0) return null;

    const v = JSON.parse(JSON.stringify(baseShip));
    v.name             = variantInfo.variantName.startsWith(variantInfo.baseName)
      ? variantInfo.variantName
      : `${variantInfo.baseName} (${variantInfo.variantName})`;
    v.variant          = variantInfo.variantName;
    v.baseShip         = variantInfo.baseName;
    v._variantPluginId = variantInfo.variantPluginId;

    let changed = false;
    let inlineOutfitsStarted = false;
    let variantLeaksStarted  = false;   // true once the variant defines its first leak line

    let i = startIdx + 1;
    while (i < lines.length) {
      const line2 = lines[i];
      if (!line2.trim() || line2.trim().startsWith('#')) { i++; continue; }
      const indent = line2.length - line2.replace(/^\t+/, '').length;
      if (indent < 1) break;
      const stripped = line2.trim();

      const inlineOutfitMatch =
        stripped.match(/^"([^"]+)"(?:\s+(\d+))?$/) ||
        stripped.match(/^`([^`]+)`(?:\s+(\d+))?$/);
      if (inlineOutfitMatch && indent === 1) {
        const outfitName = inlineOutfitMatch[1];
        const count  = inlineOutfitMatch[2] ? Math.max(1, parseInt(inlineOutfitMatch[2], 10)) : 1;
        const pluginId = this._resolveOutfitPluginId(outfitName, variantInfo.variantPluginId);
        if (!inlineOutfitsStarted) { v.outfitMap = {}; inlineOutfitsStarted = true; }
        v.outfitMap[outfitName] = { count, pluginId };
        this.speciesResolver.collectShipOutfits(variantInfo.baseName, [outfitName], this._currentPluginId, v.name);
        this.locationResolver.collectShipOutfit(v.name, outfitName, pluginId, variantInfo.variantPluginId);
        changed = true;
        i++; continue;
      }

      if (stripped === 'outfits') {
        const [outfitMap, ni] = this.parseOutfitsBlock(lines, i, variantInfo.baseName, v.name, variantInfo.variantPluginId);
        if (!this._outfitMapsEqual(outfitMap, baseShip.outfitMap || {})) {
          v.outfitMap = outfitMap; changed = true;
        }
        i = ni; continue;
      }

      if (stripped === 'add attributes') {
        const [parsed, ni] = this.parseBlock(lines, i + 1, {});
        if (!v.attributes) v.attributes = {};
        for (const [k, val] of Object.entries(parsed)) {
          if (k in v.attributes && typeof v.attributes[k] === 'number' && typeof val === 'number')
            v.attributes[k] += val;
          else v.attributes[k] = val;
        }
        changed = true; i = ni; continue;
      }

      if (stripped.startsWith('sprite ') ||
          stripped.startsWith('"thumbnail"') || stripped.startsWith('thumbnail ') ||
          stripped.startsWith('"flare sprite"') || stripped.startsWith('"flare sound"') ||
          stripped.startsWith('"steering flare sprite"') || stripped.startsWith('"steering flare sound"') ||
          stripped.startsWith('"reverse flare sprite"') || stripped.startsWith('"reverse flare sound"') ||
          stripped.startsWith('"afterburner effect"') || stripped.startsWith('"afterburner sound"')) {
        const [sd, ni] = this.parseSpriteWithData(lines, i, indent);
        for (const [k, val] of Object.entries(sd)) {
          if (val !== baseShip[k]) { v[k] = val; changed = true; }
        }
        i = ni; continue;
      }

      // leak lines in variants
      const leak = this.parseLeak(stripped);
      if (leak) {
        if (!variantLeaksStarted) { v.leaks = []; variantLeaksStarted = true; }
        v.leaks.push(leak);
        changed = true;
        i++; continue;
      }

      // `"display name" "Modified Carrier"` — what the game shows instead of the internal name
      const dn = stripped.match(/^["`]display name["`]\s+(?:"([^"]+)"|`([^`]+)`|(\S.*))$/);
      if (dn) { v.displayName = dn[1] ?? dn[2] ?? dn[3]; changed = true; i++; continue; }

      const [parsed, ni] = this.parseBlock(lines, i, { parseHardpoints: true });
      if (parsed.displayName) { v.displayName = parsed.displayName; changed = true; }
      if (parsed.sprite && parsed.sprite !== baseShip.sprite) {
        v.sprite = parsed.sprite;
        if (parsed.spriteData) v.spriteData = parsed.spriteData;
        changed = true;
      }
      if (parsed.thumbnail && parsed.thumbnail !== baseShip.thumbnail) {
        v.thumbnail = parsed.thumbnail; changed = true;
      }
      for (const t of ['engines','reverseEngines','steeringEngines','guns','turrets','bays']) {
        if (parsed[t]?.length > 0) { v[t] = parsed[t]; changed = true; }
      }
      i = ni;
    }

    return (changed || v.description) ? v : null;
  }

  shipsAreIdentical(a, b) {
    if (a.baseShip !== b.baseShip) return false;
    if (a.sprite    !== b.sprite)    return false;
    if (a.thumbnail !== b.thumbnail) return false;
    for (const t of ['engines','reverseEngines','steeringEngines','guns','turrets','bays']) {
      const aList = a[t] || [], bList = b[t] || [];
      if (aList.length !== bList.length) return false;
      for (let i = 0; i < aList.length; i++) {
        if (aList[i].x !== bList[i].x || aList[i].y !== bList[i].y) return false;
      }
    }
    const aAttr = a.attributes || {}, bAttr = b.attributes || {};
    const allKeys = new Set([...Object.keys(aAttr), ...Object.keys(bAttr)]);
    for (const k of allKeys) { if (aAttr[k] !== bAttr[k]) return false; }
    if (!this._outfitMapsEqual(a.outfitMap || {}, b.outfitMap || {})) return false;
    return true;
  }

  processVariants(pendingSlice) {
    const toProcess = pendingSlice ?? this.pendingVariants;
    console.log(`  Processing ${toProcess.length} variants...`);
    let kept = 0, skippedNoChange = 0, skippedDuplicate = 0;
    for (const vi of toProcess) {
      const v = this.parseShipVariant(vi);
      if (!v) { skippedNoChange++; continue; }
      const isDuplicate = this.variants.some(existing => this.shipsAreIdentical(existing, v));
      if (isDuplicate) {
        skippedDuplicate++; continue;
      }
      this.variants.push(v);
      kept++;
    }
    console.log(`  Variants: ${kept} kept, ${skippedNoChange} skipped, ${skippedDuplicate} duplicates removed`);
  }

  // submunitions and ammo from the raw lines
  _parseWeaponLines(lines, outfitStartIdx, outfitEndIdx) {
      const submunitions = [];
      const ammunition   = [];

      // Find the weapon block start
      let weaponIndent = -1;
      let i = outfitStartIdx;
      while (i < outfitEndIdx) {
          const line    = lines[i];
          const stripped = line.trim();
          const indent   = line.length - line.replace(/^\t+/, '').length;
          if (stripped === 'weapon' || stripped === '"weapon"') {
              weaponIndent = indent;
              i++;
              break;
          }
          i++;
      }
      if (weaponIndent < 0) return { submunitions, ammunition };

      // Scan weapon block lines
      while (i < outfitEndIdx) {
          const line     = lines[i];
          if (!line.trim()) { i++; continue; }
          const indent   = line.length - line.replace(/^\t+/, '').length;
          // Left weapon block
          if (indent <= weaponIndent) break;

          const stripped = line.trim();

          // submunition "Name" [N]
          const subMatch =
              stripped.match(/^(?:"submunition"|submunition)\s+"([^"]+)"(?:\s+(\d+))?$/) ||
              stripped.match(/^(?:"submunition"|submunition)\s+`([^`]+)`(?:\s+(\d+))?$/);
          if (subMatch) {
              const type  = subMatch[1];
              const count = subMatch[2] ? parseInt(subMatch[2], 10) : 1;
              submunitions.push({ type, count });
              // Skip any indented sub-block (offset data etc) — we don't need it
              i++;
              while (i < outfitEndIdx) {
                  const nl      = lines[i];
                  if (!nl.trim()) { i++; continue; }
                  const nIndent = nl.length - nl.replace(/^\t+/, '').length;
                  if (nIndent <= indent) break;
                  i++;
              }
              continue;
          }

          // ammo "Name" [N]
          const ammoMatch =
              stripped.match(/^(?:"ammo"|ammo)\s+"([^"]+)"(?:\s+(\d+))?$/) ||
              stripped.match(/^(?:"ammo"|ammo)\s+`([^`]+)`(?:\s+(\d+))?$/);
          if (ammoMatch) {
              const type  = ammoMatch[1];
              const count = ammoMatch[2] ? parseInt(ammoMatch[2], 10) : 1;
              // Only add if not already found (weapons have one ammo type)
              if (!ammunition.some(a => a.type === type)) {
                  ammunition.push({ type, count });
              }
              i++;
              continue;
          }

          i++;
      }

      return { submunitions, ammunition };
  }

  parseOutfit(lines, startIdx) {
      const line = lines[startIdx].trim();
      const match = line.match(/^outfit\s+"([^"]+)"\s*$/) ||
                    line.match(/^outfit\s+`([^`]+)`\s*$/) ||
                    line.match(/^outfit\s+'([^']+)'\s*$/);
      if (!match) return [null, startIdx + 1];
      const name = match[1];
      if (startIdx + 1 >= lines.length) return [null, startIdx + 1];
      const nl = lines[startIdx + 1];
      if (nl.trim() && (nl.length - nl.replace(/^\t+/, '').length) === 0) return [null, startIdx + 1];
      const data = { name };
      const [parsed, ni] = this.parseBlock(lines, startIdx + 1, { parseHardpoints: false });
      Object.assign(data, parsed);

      if (data.weapon && typeof data.weapon === 'object') {
          // First: extract submunitions and ammo directly from raw lines
          // (parseBlock mangles repeated submunition keys and drops "Name" N forms)
          const { submunitions, ammunition } = this._parseWeaponLines(lines, startIdx + 1, ni);

          // Second: normalise everything else (handles legacy formats, loose keys)
          data.weapon = normaliseWeaponBlock(data.weapon, this.outfitsByName);

          // Third: override with the accurately raw-parsed values
          // Raw parse is authoritative for submunitions and ammo
          if (submunitions.length > 0) data.weapon.submunitions = submunitions;
          if (ammunition.length   > 0) data.weapon.ammunition   = ammunition;
      }

    return [(data.description || data.weapon) ? data : null, ni];
  }

  parseExtraEffect(lines, startIdx) {
    const line = lines[startIdx].trim();
    const match = line.match(/^effect\s+"([^"]+)"\s*$/) ||
                  line.match(/^effect\s+`([^`]+)`\s*$/) ||
                  line.match(/^effect\s+'([^']+)'\s*$/);
    if (!match) return [null, startIdx + 1];
    const name = match[1];
    if (startIdx + 1 >= lines.length) return [null, startIdx + 1];
    const nl = lines[startIdx + 1];
    if (nl.trim() && (nl.length - nl.replace(/^\t+/, '').length) === 0) return [null, startIdx + 1];
    const data = { name };
    const [parsed, ni] = this.parseBlock(lines, startIdx + 1, { parseHardpoints: false });
    Object.assign(data, parsed);
    return [data, ni];
  }

  resolveAllOutfitPluginIds() {
    let resolved = 0, stillMissing = 0;
    const missingNames = new Map();   // name → times referenced (printed once each, below)
    const resolveMap = (outfitMap, ownerPluginId) => {
      if (!outfitMap || typeof outfitMap !== 'object') return;
      for (const [name, val] of Object.entries(outfitMap)) {
        if (typeof val === 'object' && val.pluginId === null) {
          const found = this._resolveOutfitPluginId(name, ownerPluginId);
          if (found) { val.pluginId = found; resolved++; }
          else {
            stillMissing++;
            missingNames.set(name, (missingNames.get(name) || 0) + 1);
          }
        }
      }
    };
    for (const ship of this.ships)       resolveMap(ship.outfitMap, ship._pluginId);
    for (const variant of this.variants) resolveMap(variant.outfitMap, variant._variantPluginId);
    let refsResolved = 0, refsStillMissing = 0;
    for (const ref of this.locationResolver.shipOutfitRefs) {
        if (ref.pluginId === null) {
            const found = this._resolveOutfitPluginId(ref.outfitName, ref.shipPluginId);
            if (found) { ref.pluginId = found; refsResolved++; }
            else { refsStillMissing++; }
        }
    }
    if (missingNames.size) {
      const list = [...missingNames.entries()].sort((a, b) => b[1] - a[1]);
      console.warn(`    ⚠ ${missingNames.size} outfit name(s) used by ships/variants aren't defined by any plugin (usually an outfit from a plugin not in plugins.json):`);
      for (const [n, c] of list.slice(0, 40)) console.warn(`       ${n}${c > 1 ? `  ×${c}` : ''}`);
      if (list.length > 40) console.warn(`       … and ${list.length - 40} more`);
    }
    console.log(`  Outfit pluginId resolution: ${resolved} resolved, ${stillMissing} still missing`);
    if (this._collisionSeen && this._collisionSeen.size) {
      const total = [...this._collisionSeen.values()].reduce((a, b) => a + b, 0);
      console.log(`  Base-ship collisions: ${this._collisionSeen.size} distinct (${total} variant lookups) — each printed once above`);
    }
  }

  // resolve every named fleet in npc blocks
  resolveAllNpcFleetRefs() {
    let resolved = 0, missing = 0;
    for (const ref of this._pendingNpcFleetRefs) {
      // prefer a fleet from the same plugin
      let match = this.speciesResolver.fleets.find(
        f => f.name === ref.fleetName && f.pluginId === ref.pluginId
      );
      if (!match) {
        match = this.speciesResolver.fleets.find(f => f.name === ref.fleetName);
      }
      if (!match) {
        missing++;
        console.warn(
          `    ⚠ NPC fleet reference not found: "${ref.fleetName}" ` +
          `(referenced by ${ref.missionName ? `mission "${ref.missionName}"` : `event "${ref.eventName}"`} ` +
          `in plugin "${ref.pluginId}")`
        );
        continue;
      }
      const government = match.government || ref.government || null;
      const contextLabel = ref.missionName
        ? ref.missionName
        : `[event "${ref.eventName}" npc]`;
      for (const shipName of match.shipNames) {
        this.speciesResolver.collectNpcRef(government, shipName, match.pluginId);
        this.locationResolver.collectMissionNpcShip(contextLabel, shipName, match.pluginId);
      }
      resolved++;
    }
    console.log(`  NPC fleet-reference resolution: ${resolved} resolved, ${missing} missing`);
  }

  // event → fleet → government (who an event affects)
  resolveEventGovernmentImpact() {
    this.eventGovernmentImpacts = [];
    let resolvedGov = 0, unresolvedGov = 0;

    for (const change of this.locationResolver.eventSystemFleetChanges) {
      const { eventName, systemName, fleetName, action, rate, pluginId } = change;

      // same plugin rule
      let fleetMatch = this.speciesResolver.fleets.find(
        f => f.name === fleetName && f.pluginId === pluginId
      );
      if (!fleetMatch) {
        fleetMatch = this.speciesResolver.fleets.find(f => f.name === fleetName);
      }

      const government = fleetMatch?.government ?? null;
      if (government) resolvedGov++; else unresolvedGov++;

      // missions known to trigger this event
      const triggeringMissions = this.locationResolver.missionEventTriggers
        .filter(t => t.eventName === eventName && t.pluginId === pluginId)
        .map(t => t.missionName);

      this.eventGovernmentImpacts.push({
        eventName,
        systemName,
        fleetName,
        government,
        action,
        rate: rate ?? null,
        pluginId,
        fleetPluginId: fleetMatch?.pluginId ?? null,
        triggeringMissions,
      });
    }

    if (unresolvedGov > 0) {
      console.warn(
        `    ⚠ ${unresolvedGov} event fleet-spawn change(s) could not be traced to a government ` +
        `(the referenced fleet's own "fleet ... government ..." definition wasn't found — ` +
        `check for a typo'd fleet name, or a fleet defined without a government line).`
      );
    }
    console.log(`  Event → fleet → government join: ${resolvedGov} resolved to a government, ${unresolvedGov} unresolved`);
  }

async readPluginTxt(pluginRootDir) {
  const pluginTxtPath = path.join(pluginRootDir, 'plugin.txt');
  try {
    const content = await fs.readFile(pluginTxtPath, 'utf8');
    const result = {};
    for (const line of content.split('\n')) {
      if (line.startsWith('\t') || line.startsWith(' ')) continue;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const m =
        trimmed.match(/^(\w+)\s+"([^"]+)"$/) ||
        trimmed.match(/^(\w+)\s+`([^`]+)`$/) ||
        trimmed.match(/^(\w+)\s+(\S+)$/);
      if (m) {
        const key = m[1];
        const val = m[2];
        if (key === 'about') {
          if (!result.about) result.about = [];
          result.about.push(val);
        } else {
          result[key] = val;
        }
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}
  
}

// keep the display name
function withDisplayName(attributes, ship) {
  const dn = ship && (ship.displayName || ship['display name']);
  if (!dn || dn === ship.name) return attributes;
  return { ...(attributes || {}), 'display name': String(dn) };
}

// keep which governments fly/sell an item
function withGovernments(locations, governments) {
  if (!governments || typeof governments !== 'object') return locations;
  const out = { ...(locations || {}) };
  for (const [pid, list] of Object.entries(governments)) {
    const names = (Array.isArray(list) ? list : list && typeof list === 'object' ? Object.keys(list) : [])
      .filter(n => n !== pid);   // "unknown" fallback is { plugin: { plugin: true } } — not a government
    if (!names.length) continue;
    out[pid] = { ...(out[pid] || {}), Governments: [...new Set(names.map(String))].sort() };
  }
  return out;
}

// the whole run. Called by: the Parse workflow
async function main() {
  try {
    const config = JSON.parse(await fs.readFile(path.join(process.cwd(), 'plugins.json'), 'utf8'));
    console.log(`Found ${config.plugins.length} repository source(s)\n`);

    const sharedParser = new EndlessSkyParser();
    sharedParser.setSourcePriority(config.plugins);
    sharedParser.setOverrides(config.plugins);

    for (const source of config.plugins) {
      if (source.overrides?.length) {
        console.log(`  Override declared: "${source.name}" overrides [${source.overrides.join(', ')}]`);
      }
    }

    const runStart = Date.now();
    const secs = t => ((Date.now() - t) / 1000).toFixed(1) + 's';
    const timings = [];   // [label, seconds] — summary printed at the end

    const allResults = [];
    const parsedSources = new Set();   // sources that were read successfully this run (cleanup only trusts these)
    const sourcesStart = Date.now();
    for (const source of config.plugins) {
      const sourceStart = Date.now();
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Source: ${source.name}  |  ${source.repository}`);
      console.log('='.repeat(60));

      // archive sources (or URLs ending in an archive extension)
      const isArchive =
        source.type === 'archive' ||
        detectArchiveExtension(source.repository || '') !== null;

      let results;
      try {
        results = isArchive
          ? await sharedParser.parseArchiveSource(source.repository, source.name)
          : await sharedParser.parseRepository(source.repository, source.name);
      } catch (err) {
        console.error(`  Error processing "${source.name}": ${err.message}`);
        console.error(err.stack);
        console.error(`  Skipping and continuing with next source...`);
        continue;
      }
      parsedSources.add(source.name);
      timings.push([`source: ${source.name}`, (Date.now() - sourceStart) / 1000]);
      console.log(`  ⏱ ${source.name}: ${secs(sourceStart)}`);
      if (results.length === 0) { console.log('No plugins found, skipping.'); continue; }
      for (const plugin of results) allResults.push({ source, plugin });
    }
    timings.push(['all sources (clone + parse)', (Date.now() - sourcesStart) / 1000]);
    const resolveStart = Date.now();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Resolving deferred outfit pluginIds across all plugins...`);
    console.log('='.repeat(60));
    sharedParser.resolveAllOutfitPluginIds();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Resolving fleet government gaps (government-less fleet reopenings)...`);
    console.log('='.repeat(60));
    sharedParser.speciesResolver.resolveFleetGovernmentGaps();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Resolving planet government gaps (government-less planet reopenings, e.g. event "add shipyard")...`);
    console.log('='.repeat(60));
    sharedParser.speciesResolver.resolvePlanetGovernmentGaps();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Resolving NPC fleet references across all plugins...`);
    console.log('='.repeat(60));
    sharedParser.resolveAllNpcFleetRefs();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Joining event → fleet → government data...`);
    console.log('='.repeat(60));
    sharedParser.resolveEventGovernmentImpact();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Resolving governments across all ${allResults.length} plugin(s)...`);
    console.log(`  Known governments: ${sharedParser.speciesResolver.knownGovernments.size}`);
    console.log(`  Fleets: ${sharedParser.speciesResolver.fleets.length}`);
    console.log(`  Planets: ${sharedParser.speciesResolver.planets.length}`);
    console.log('='.repeat(60));

    console.log(`\nResolving map data (links, object↔planet join, government inheritance, wormholes)...`);
    const mapResolveStats = sharedParser.mapParser.runAllResolvers();
    console.log(`  ${JSON.stringify(mapResolveStats)}`);

    console.log(`\nResolving mission collisions across all plugins...`);
    sharedParser.missionParser2.resolveCollisions();
    console.log(`  ${sharedParser.missionParser2.collisions.length} colliding mission name(s) found`);

    console.log(`\nResolving mission reward/planet cross-references...`);
    const rewardStats = sharedParser.missionParser2.resolveRewardPluginIds(sharedParser);
    const planetRefStats = sharedParser.missionParser2.resolvePlanetRefs(sharedParser.mapParser);
    console.log(`  rewards: ${JSON.stringify(rewardStats)}, planet refs: ${JSON.stringify(planetRefStats)}`);
    
    // which plugin's version a cross-plugin reference uses
    sharedParser.locationResolver.setOwnerResolver((kind, name, fromPluginId) => {
      if (kind === 'outfit') return sharedParser._resolveOutfitPluginId(name, fromPluginId);
      const candidates = sharedParser.shipsByName.get(name);
      if (!candidates || !candidates.length) return null;
      const local = candidates.find(c => c._pluginId === fromPluginId);
      if (local) return local._pluginId;
      // priority per source name
      const prio = id => sharedParser._sourcePriority.get(id)
        ?? sharedParser._sourcePriority.get(String(id).slice(0, String(id).lastIndexOf('/'))) ?? Infinity;
      return [...candidates].sort((a, b) => prio(a._pluginId) - prio(b._pluginId))[0]._pluginId;
    });

    for (const { plugin } of allResults) {
      sharedParser.speciesResolver.attachSpecies(
        plugin.ships, plugin.variants, plugin.outfits, plugin.outputName
      );
      sharedParser.locationResolver.attachLocations(
        plugin.ships, plugin.variants, plugin.outfits, plugin.pluginId
      );
    }

    timings.push(['cross-plugin resolution', (Date.now() - resolveStart) / 1000]);

    // What the last successful run pushed (see pushCache.js). Tied to the
    // parser's own code, so changing the parser forces a full push.
    const parserFiles = ['parser.js', 'pushCache.js', 'speciesResolver.js', 'locationResolver.js', 'mapParser.js',
      'missionParser.js', 'attributeParser.js', 'attributeSync.js', 'dataFolderScanner.js']
      .map(f => path.join(__dirname, f));
    const cache = new PushCache({ dir: path.join(process.cwd(), '.parse-cache'), code: codeHash(parserFiles),
                                  full: process.env.PARSE_FULL === '1' || process.env.PARSE_FULL === 'true' });
    console.log(cache.usable ? `\nUsing the cache from the last run — only changed rows will be pushed.`
                             : `\nFull push (${cache.reason}).`);

    // ── chunked Supabase writes ──
    const CHUNK_SIZE = 500;
    // split into chunks
    function chunk(arr, size) {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    }
    // same internal_id twice → keep the last
    function dedupeByKey(rows, key) {
      const map = new Map();
      for (const row of rows) map.set(row[key], row);
      return [...map.values()];
    }
    // same for two-column keys
    function dedupeByComposite(rows, keys) {
      const map = new Map();
      for (const row of rows) map.set(keys.map(k => row[k]).join('|'), row);
      return [...map.values()];
    }
    // cost/mass sometimes come as a list — use the first
    function toNumeric(val) {
      if (Array.isArray(val)) return typeof val[0] === 'number' ? val[0] : null;
      return typeof val === 'number' ? val : null;
    }
    // dropped connection or 502/503/504 = busy, not wrong
    const isTransient = err => /fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|network|Bad Gateway|Service Unavailable|Gateway Time-?out|upstream|\b50[234]\b/i
      .test((err && err.message) || '');
    let busyUntil = 0;   // after a gateway error everyone slows down for a while
    // retry busy errors
    async function withRetry(fn, { retries = 6, label = 'request' } = {}) {
      let lastErr;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          return await fn();
        } catch (err) {
          lastErr = err;
          if (!isTransient(err) || attempt === retries) throw err;
          // back off more each time: 2s, 4s, 8s, 16s, 30s
          const delayMs = Math.min(30000, 2000 * 2 ** (attempt - 1));
          busyUntil = Date.now() + 60000;
          console.log(`  ↻ ${label}: Supabase busy (${(err.message || '').slice(0, 60)}), retrying in ${delayMs / 1000}s (attempt ${attempt}/${retries})`);
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
      throw lastErr;
    }
    // Up to this many requests in flight at once — Supabase handles a few
    // concurrent requests fine, and this is most of the push's wall time.
    const CONCURRENCY = 4;
    // run a few at a time
    async function inPool(items, worker, limit = CONCURRENCY) {
      let next = 0;
      // while Supabase is busy only one worker keeps going
      const run = async slot => {
        while (next < items.length) {
          if (slot > 0 && Date.now() < busyUntil) { await new Promise(r => setTimeout(r, 1000)); continue; }
          const i = next++; await worker(items[i], i);
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, (_, slot) => run(slot)));
    }
    // too slow or too big → split and retry
    const isTimeout = err => /statement timeout|canceling statement|57014|timed out|payload too large|413/i.test(err && err.message || '') || isTransient(err);
    // send, splitting batches that time out
    async function sendSplitting(part, send, label) {
      try {
        return await withRetry(() => send(part), { label });
      } catch (err) {
        if (!isTimeout(err) || part.length <= 1) throw err;
        const mid = Math.ceil(part.length / 2);
        console.log(`  ↘ ${label}: too slow for ${part.length} rows at once — sending ${mid} + ${part.length - mid}`);
        const a = await sendSplitting(part.slice(0, mid), send, label);
        const b = await sendSplitting(part.slice(mid), send, label);
        return [...(a || []), ...(b || [])];
      }
    }
    // upsert in chunks
    async function upsertChunked(table, rows, { onConflict, select, size = CHUNK_SIZE, concurrency = CONCURRENCY } = {}) {
      const results = [];
      await inPool(chunk(rows, size), async part => {
        if (!part.length) return;
        const data = await sendSplitting(part, async p => {
          let query = supabase.from(table).upsert(p, onConflict ? { onConflict } : undefined);
          if (select) query = query.select(select);
          const { data, error } = await query;
          if (error) throw new Error(`Supabase upsert failed for ${table}: ${error.message}`);
          return data || [];
        }, `upsert ${table}`);
        if (data) results.push(...data);
      }, concurrency);
      return results;
    }
    // insert in chunks
    async function insertChunked(table, rows) {
      await inPool(chunk(rows, CHUNK_SIZE), async part => {
        if (!part.length) return;
        await sendSplitting(part, async p => {
          const { error } = await supabase.from(table).insert(p);
          if (error) throw new Error(`Supabase insert failed for ${table}: ${error.message}`);
          return [];
        }, `insert ${table}`);
      });
    }
    // delete in chunks
    async function deleteInChunked(table, column, ids) {
      // ids can be long uuids — keep each request's URL short
      await inPool(chunk(ids, 200), async part => {
        if (!part.length) return;
        await sendSplitting(part, async p => {
          const { error } = await supabase.from(table).delete().in(column, p);
          if (error) throw new Error(`Supabase delete failed for ${table}: ${error.message}`);
          return [];
        }, `delete ${table}`);
      }, 2);
    }
    // id ↔ internal_id for a whole table
    async function fetchAll(table, cols, orderCol = 'id') {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await withRetry(() => supabase.from(table).select(cols).order(orderCol).range(from, from + 999),
          { label: `read ${table}` });
        if (error) throw new Error(`Supabase select failed for ${table}: ${error.message}`);
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      return rows;
    }
    const dbRows = {};   // table → [{ id, internal_id, plugin_id }] as they are in Supabase now (used by cleanup)
    // id map for a table
    async function fetchIdMap(table) {
      const rows = await fetchAll(table, 'id, internal_id, plugin_id');
      dbRows[table] = rows;
      return new Map(rows.map(r => [r.internal_id, r.id]));
    }

    // ══ PHASE 1: gather every row in memory ══
    console.log(`\nPhase 1: gathering rows in memory (no network yet)...`);
    const allPluginRows = [], allOutfitRows = [], allShipRows = [], allVariantRows = [],
          allEffectRows = [], allStarRows = [], allGalaxyRows = [], allGovernmentRows = [],
          allWormholeRows = [], allPlanetRows = [], allSystemRows = [], allMissionRows = [];
    const rawWormholesByPlugin = [], rawPlanetsByPlugin = [], rawSystemsByPlugin = [];
    let skippedGovernmentsWithoutName = 0;
    let pluginOrderCounter = 0;

    for (const { source, plugin } of allResults) {
      const pluginDataToWrite = plugin.pluginData ?? { name: plugin.outputName };
      allPluginRows.push({
        plugin_id:    plugin.pluginId,
        source_name:  plugin.name,
        output_name:  plugin.outputName,
        display_name: pluginDataToWrite.name ?? plugin.outputName,
        repository:   source.repository,
        plugin_data:  pluginDataToWrite,
        source_priority: pluginOrderCounter++,
      });

      const shipsOut = plugin.ships.map(s => ({
        ...s, outfits: outfitMapToOutputFormat(s.outfitMap), outfitMap: undefined,
      }));
      const variantsOut = plugin.variants.map(v => ({
        ...v, outfits: outfitMapToOutputFormat(v.outfitMap), outfitMap: undefined,
      }));
      const outfitsOut = plugin.outfits.map(o => ({
        ...o, pluginId: o._pluginId ?? null, internalId: o._internalId ?? null, _pluginId: undefined, _internalId: undefined,
      }));
      const effectsOut = plugin.effects.map(e => ({
        ...e, pluginId: e._pluginId ?? null, _pluginId: undefined,
      }));
      const mapSlice = sharedParser.mapParser.toPluginSlice(plugin.pluginId);
      const missionSlice = sharedParser.missionParser2.toPluginSlice(plugin.pluginId);

      for (const o of outfitsOut) allOutfitRows.push({
        plugin_id: o.pluginId ?? plugin.pluginId, internal_id: o.internalId, name: o.name,
        category: o.category ?? null, cost: toNumeric(o.cost), mass: toNumeric(o.mass),
        thumbnail: o.thumbnail, description: o.description,
        attributes: { ...o, name: undefined, description: undefined, thumbnail: undefined,
                      pluginId: undefined, internalId: undefined,
                      locations: withGovernments(o.locations, o.governments),
                      governments: undefined, governmentEvents: undefined },
      });

      for (const s of shipsOut) allShipRows.push({
        plugin_id: s._pluginId ?? plugin.pluginId, internal_id: s._internalId, name: s.name,
        category: s.attributes?.category ?? null, cost: toNumeric(s.attributes?.cost), mass: toNumeric(s.attributes?.mass),
        sprite: s.sprite, thumbnail: s.thumbnail, description: s.description, attributes: withDisplayName(s.attributes, s),
        hardpoints: { guns: s.guns, turrets: s.turrets, bays: s.bays, engines: s.engines,
                      leaks: s.leaks, reverseEngines: s.reverseEngines, steeringEngines: s.steeringEngines },
        explosions: { tiny: s['tiny explosion'], small: s['small explosion'], medium: s['medium explosion'],
                      large: s['large explosion'], huge: s['huge explosion'], final: s['final explode'] },
        locations: withGovernments(s.locations, s.governments),
      });

      for (const v of variantsOut) allVariantRows.push({
        plugin_id: v._pluginId ?? plugin.pluginId, variant_plugin_id: v._variantPluginId ?? null,
        internal_id: v._internalId, name: v.name, base_ship_name: v.baseShip,
        category: v.attributes?.category ?? null, cost: toNumeric(v.attributes?.cost), mass: toNumeric(v.attributes?.mass),
        sprite: v.sprite, thumbnail: v.thumbnail, description: v.description, attributes: withDisplayName(v.attributes, v),
        hardpoints: { guns: v.guns, turrets: v.turrets, bays: v.bays, engines: v.engines,
                      leaks: v.leaks, reverseEngines: v.reverseEngines, steeringEngines: v.steeringEngines },
        explosions: { tiny: v['tiny explosion'], small: v['small explosion'], medium: v['medium explosion'],
                      large: v['large explosion'], huge: v['huge explosion'], final: v['final explode'] },
        locations: withGovernments(v.locations, v.governments),
      });

      for (const e of effectsOut) allEffectRows.push({
        plugin_id: e.pluginId ?? plugin.pluginId, name: e.name, sprite: e.sprite, sound: e.sound,
        lifetime: toNumeric(e.lifetime), random_angle: toNumeric(e['random angle']),
        random_frame_rate: toNumeric(e['random frame rate']), random_spin: toNumeric(e['random spin']),
        random_velocity: toNumeric(e['random velocity']), velocity_scale: toNumeric(e['velocity scale']),
        sprite_data: e['sprite data'] ?? null,
      });

      for (const s of mapSlice.stars ?? []) allStarRows.push({
        plugin_id: s.pluginId ?? plugin.pluginId, internal_id: s.internalId, sprite: s.sprite,
        icon: s.icon, power: toNumeric(s.power), wind: toNumeric(s.wind), habitable: toNumeric(s.habitable), mass: toNumeric(s.mass),
      });
      for (const g of mapSlice.galaxies ?? []) allGalaxyRows.push({
        plugin_id: g._pluginId ?? plugin.pluginId, internal_id: g._internalId, name: g.name,
        sprite: g.sprite, pos_x: toNumeric(g.pos?.x), pos_y: toNumeric(g.pos?.y),
      });
      for (const gv of mapSlice.governments ?? []) {
        if (gv.name) allGovernmentRows.push({
          plugin_id: gv.pluginId ?? plugin.pluginId, name: gv.name,
          color: gv.color ?? null, color_ref: gv.colorRef ?? null, swizzle: toNumeric(gv.swizzle),
        });
        else skippedGovernmentsWithoutName++;
      }

      for (const w of mapSlice.wormholes ?? []) allWormholeRows.push({
        plugin_id: w._pluginId ?? plugin.pluginId, internal_id: w._internalId, name: w.name,
        display_name: w.displayName, mappable: w.mappable ?? null, color: w.color ?? null,
      });
      rawWormholesByPlugin.push(mapSlice.wormholes ?? []);

      for (const p of mapSlice.planets ?? []) allPlanetRows.push({
        plugin_id: p._pluginId ?? plugin.pluginId, internal_id: p._internalId, name: p.name,
        display_name: p.displayName, system_name: p.systemName, government: p.government,
        government_inherited: p.governmentInherited ?? null, security: toNumeric(p.security),
        bribe: toNumeric(p.bribe), bribe_threshold: toNumeric(p.bribeThreshold), bribe_fraction: toNumeric(p.bribeFraction),
        required_reputation: toNumeric(p.requiredReputation), wormhole: p.wormhole ?? null,
        attributes: p.attributes ?? null, requires: p.requires ?? null, description: p.description ?? null,
        spaceport: p.spaceport ?? null, port: p.port ?? null, landscapes: p.landscapes ?? null,
        tribute: toNumeric(p.tribute), tribute_hails: p.tributeHails ?? null,
        music: p.music ?? null, to_know: p.toKnow ?? null, to_land: p.toLand ?? null,
        to_access_outfitter: p.toAccessOutfitter ?? null, to_access_shipyard: p.toAccessShipyard ?? null,
      });
      rawPlanetsByPlugin.push(mapSlice.planets ?? []);

      for (const sy of mapSlice.systems ?? []) allSystemRows.push({
        plugin_id: sy._pluginId ?? plugin.pluginId, internal_id: sy._internalId, name: sy.name,
        display_name: sy.displayName, government: sy.government, pos_x: toNumeric(sy.pos?.x), pos_y: toNumeric(sy.pos?.y),
        habitable: toNumeric(sy.habitable), jump_range: toNumeric(sy.jumpRange), haze: sy.haze ?? null, music: sy.music ?? null,
        starfield_density: toNumeric(sy.starfieldDensity), ramscoop: toNumeric(sy.ramscoop),
        invisible_fence: toNumeric(sy.invisibleFence), no_raids: sy.noRaids ?? null,
        attributes: { attributes: sy.attributes, belts: sy.belts, arrival: sy.arrival, departure: sy.departure },
        flags: sy.flags ?? null, raids: sy.raids ?? null, object_tree: sy.objectTree ?? null,
      });
      rawSystemsByPlugin.push(mapSlice.systems ?? []);

      for (const m of missionSlice ?? []) allMissionRows.push({
        plugin_id: m._pluginId ?? plugin.pluginId, internal_id: m._internalId, name: m.name,
        display_name: m.displayName, source_plugin: m.sourcePlugin, source: m.source ?? null,
        destination: m.destination ?? null, stopovers: m.stopovers ?? null, waypoints: m.waypoints ?? null,
        cargo: m.cargo ?? null, passengers: m.passengers ?? null, payment: m.payment ?? null,
        rewards: m.rewards ?? null, deadline: m.deadline ?? null, illegal: m.illegal ?? null,
        repeatable: m.repeatable ?? null, repeat_limit: toNumeric(m.repeatLimit), npc_count: toNumeric(m.npcCount),
        has_npc_objective: m.hasNpcObjective ?? null, flags: m.flags ?? null, conditions: m.conditions ?? null,
        condition_side_effects: m.conditionSideEffects ?? null, event_triggers: m.eventTriggers ?? null,
        locations: m.locations ?? null, raw: m.raw ?? null,
      });

      // (plugin ordering/display-name lookups now live in the plugins table
      // itself via source_priority, rather than a separate index structure)
    }
    console.log(`  ✓ gathered ${allShipRows.length} ships | ${allVariantRows.length} variants | ${allOutfitRows.length} outfits | ${allEffectRows.length} effects`);
    console.log(`  ✓ gathered ${allSystemRows.length} systems | ${allPlanetRows.length} planets | ${allWormholeRows.length} wormholes | ${allMissionRows.length} missions`);

    // ══ PHASE 2: push rows to Supabase ══
    console.log(`\nPhase 2: bulk-pushing to Supabase...`);
    const dedupedOutfitRows   = dedupeByKey(allOutfitRows, 'internal_id');
    const dedupedShipRows     = dedupeByKey(allShipRows, 'internal_id');
    const dedupedVariantRows  = dedupeByKey(allVariantRows, 'internal_id');
    const dedupedStarRows     = dedupeByKey(allStarRows, 'internal_id');
    const dedupedGalaxyRows   = dedupeByKey(allGalaxyRows, 'internal_id');
    const dedupedWormholeRows = dedupeByKey(allWormholeRows, 'internal_id');
    const dedupedPlanetRows   = dedupeByKey(allPlanetRows, 'internal_id');
    const dedupedSystemRows   = dedupeByKey(allSystemRows, 'internal_id');
    const dedupedMissionRows  = dedupeByKey(allMissionRows, 'internal_id');
    const droppedDuplicates = allOutfitRows.length - dedupedOutfitRows.length
      + allShipRows.length - dedupedShipRows.length
      + allVariantRows.length - dedupedVariantRows.length
      + allSystemRows.length - dedupedSystemRows.length
      + allPlanetRows.length - dedupedPlanetRows.length;
    if (droppedDuplicates > 0) console.log(`  ⚠ dropped ${droppedDuplicates} duplicate internal_id row(s) before pushing`);
    if (skippedGovernmentsWithoutName > 0) console.log(`  ⚠ skipped ${skippedGovernmentsWithoutName} government entrie(s) with no name`);

    const pushStart = Date.now();
    const PARENTS = ['outfits', 'ships', 'variants', 'effects', 'stars', 'galaxies', 'governments',
                     'wormholes', 'planets', 'systems', 'missions', 'game_events'];
    await cache.verify(supabase, PARENTS);

    // Each table: push only rows whose content changed since the last run.
    const pushed = {};
    // push one table
    async function pushTable(table, rows, keyOf, opts = {}) {
      const { changed, skipped } = cache.diff(table, rows, keyOf);
      pushed[table] = { changed: changed.length, skipped };
      const res = await upsertChunked(table, changed, opts);
      cache.accept(table);
      return res;
    }
    const ik = r => r.internal_id;
    const pn = r => `${r.plugin_id}\u0000${r.name}`;

    await upsertChunked('plugins', allPluginRows);   // small; also carries source order
    await pushTable('outfits', dedupedOutfitRows, ik, { onConflict: 'internal_id', size: 100 });
    await pushTable('ships', dedupedShipRows, ik, { onConflict: 'internal_id' });
    await pushTable('variants', dedupedVariantRows, ik, { onConflict: 'internal_id' });
    // effects/governments have no internal_id, so (plugin_id, name) is their
    // natural key — needs the unique constraints from supabase/schema_fixes.sql.
    await pushTable('effects', dedupeByComposite(allEffectRows, ['plugin_id', 'name']), pn, { onConflict: 'plugin_id,name' });
    await pushTable('stars', dedupedStarRows, ik, { onConflict: 'internal_id' });
    await pushTable('galaxies', dedupedGalaxyRows, ik, { onConflict: 'internal_id' });
    await pushTable('governments', dedupeByComposite(allGovernmentRows, ['plugin_id', 'name']), pn, { onConflict: 'plugin_id,name' });
    await pushTable('wormholes', dedupedWormholeRows, ik, { onConflict: 'internal_id' });
    // planets/systems/missions carry big JSON — smaller batches, two at a time
    await pushTable('planets', dedupedPlanetRows, ik, { onConflict: 'internal_id', size: 100, concurrency: 2 });
    await pushTable('systems', dedupedSystemRows, ik, { onConflict: 'internal_id', size: 100, concurrency: 2 });
    await pushTable('missions', dedupedMissionRows, ik, { onConflict: 'internal_id', size: 50, concurrency: 2 });

    // raw event definitions (for the map's save replay)
    try {
      const knownPlugins = new Set(allPluginRows.map(p => p.plugin_id));
      const merged = new Map();
      for (const ev of sharedParser.rawEvents || []) {
        if (!knownPlugins.has(ev.plugin_id)) continue;
        const k = `${ev.plugin_id}\u0000${ev.name}`;
        const prev = merged.get(k);
        merged.set(k, prev ? { ...prev, raw: prev.raw + '\n' + ev.raw } : { ...ev });
      }
      await pushTable('game_events', [...merged.values()], pn, { onConflict: 'plugin_id,name', size: 200 });
      console.log(`  ✓ ${merged.size} event definitions`);
    } catch (err) {
      console.warn(`  Could not store event definitions (run supabase/game_events.sql?): ${err.message}`);
    }
    for (const [t, { changed, skipped }] of Object.entries(pushed))
      if (changed || skipped) console.log(`  ${t.padEnd(12)} ${String(changed).padStart(6)} pushed${skipped ? `, ${skipped} unchanged` : ''}`);

    // Database ids for every row (skipped rows didn't come back from the upsert).
    const [oMap, sMap, vMap, wMap, plMap, syMap] = await Promise.all(
      ['outfits', 'ships', 'variants', 'wormholes', 'planets', 'systems'].map(fetchIdMap));
    for (const [k, v] of oMap) outfitIdByInternalId.set(k, v);
    for (const [k, v] of sMap) shipIdByInternalId.set(k, v);
    for (const [k, v] of vMap) variantIdByInternalId.set(k, v);
    const wormholeIdByInternalId = wMap, planetIdByInternalId = plMap, systemIdByInternalId = syMap;
    console.log(`  ✓ parent tables pushed (${secs(pushStart)})`);
    timings.push(['push parent tables', (Date.now() - pushStart) / 1000]);

    // ══ PHASE 3: junction tables (outfits on ships, links, shipyards …) ══
    console.log(`\nPhase 3: building junction tables...`);
    const junctionStart = Date.now();

    // self-check: rebuild anything whose rows have gone missing
    function addChildren(map, key, part) {
      const cur = map.get(key);
      if (!cur) { map.set(key, part); return; }
      if (Array.isArray(part)) { map.set(key, cur.concat(part)); return; }
      for (const [k, v] of Object.entries(part)) cur[k] = (cur[k] || []).concat(v || []);
    }

    const JUNCTION_FAMILIES = {
      ship_outfits: ['ship_outfits'], variant_outfits: ['variant_outfits'], wormhole_links: ['wormhole_links'],
      planet_children: ['planet_shipyards', 'planet_outfitters'],
      system_children: ['system_fleets', 'system_hazards', 'system_asteroids', 'system_minables', 'system_links', 'system_planets', 'system_trade'],
    };
    // ids that have rows in a child table
    async function idsWithRows(table, col) {
      const have = new Set();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await withRetry(() => supabase.from(table).select(col).order(col).range(from, from + 999), { label: `check ${table}` });
        if (error) return null;
        for (const r of data || []) have.add(r[col]);
        if (!data || data.length < 1000) break;
      }
      return have;
    }
    const forceRebuild = { ships: new Set(), variants: new Set(), planets: new Set(), systems: new Set(), wormholes: new Set() };
    // rebuild parents with missing child rows
    async function checkCoverage(kind, childTable, col, childrenMap, idByKey, hasRows, label) {
      if (!cache.usable) return;          // no cache = everything is rebuilt anyway
      const have = await idsWithRows(childTable, col);
      if (!have) return;
      const missing = new Map();   // plugin → count
      for (const [k, v] of childrenMap) {
        if (!hasRows(v)) continue;
        const id = idByKey.get(k);
        if (id && !have.has(id)) {
          forceRebuild[kind].add(k);
          const pid = String(k).split('::')[0];
          missing.set(pid, (missing.get(pid) || 0) + 1);
        }
      }
      if (missing.size) console.log(`  ⚠ ${forceRebuild[kind].size} ${label} had no ${childTable} rows — rebuilding them (${[...missing].map(([p, n]) => `${p}: ${n}`).join(', ')})`);
    }
    const expectedRows = cache.meta('junctionRows') || null;
    if (expectedRows) {
      for (const [family, tables] of Object.entries(JUNCTION_FAMILIES)) {
        for (const t of tables) {
          const want = expectedRows[t];
          if (!want) continue;
          const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
          if (error || count == null) continue;
          if (count < want * 0.98) {
            console.log(`  ⚠ ${t} has ${count} rows but should have about ${want} — rebuilding all ${family.replace('_', ' ')}`);
            cache.distrust(family);
            break;
          }
        }
      }
    }

    // ── ship/variant outfits ──
    const shipChildren = new Map(), variantChildren = new Map();
    for (const { plugin } of allResults) {
      for (const s of plugin.ships)
        shipChildren.set(s._internalId, Object.values(outfitMapToOutputFormat(s.outfitMap)).map(i => [i.internalId, i.count]));
      for (const v of plugin.variants)
        variantChildren.set(v._internalId, Object.values(outfitMapToOutputFormat(v.outfitMap)).map(i => [i.internalId, i.count]));
    }
    await checkCoverage('ships', 'ship_outfits', 'ship_id', shipChildren, shipIdByInternalId, v => v.some(([oi]) => outfitIdByInternalId.has(oi)), 'ships');
    await checkCoverage('variants', 'variant_outfits', 'variant_id', variantChildren, variantIdByInternalId, v => v.some(([oi]) => outfitIdByInternalId.has(oi)), 'variants');
    const changedShips = cache.changedParents('ship_outfits', 'ships', [...shipChildren.keys()], k => shipChildren.get(k));
    const changedVariants = cache.changedParents('variant_outfits', 'variants', [...variantChildren.keys()], k => variantChildren.get(k));
    for (const k of forceRebuild.ships) changedShips.add(k);
    for (const k of forceRebuild.variants) changedVariants.add(k);
    const shipOutfitRows = [], variantOutfitRows = [];
    for (const k of changedShips) {
      const shipId = shipIdByInternalId.get(k);
      if (!shipId) continue;
      for (const [oi, count] of shipChildren.get(k)) {
        const outfitId = outfitIdByInternalId.get(oi);
        if (outfitId) shipOutfitRows.push({ ship_id: shipId, outfit_id: outfitId, count });
      }
    }
    for (const k of changedVariants) {
      const variantId = variantIdByInternalId.get(k);
      if (!variantId) continue;
      for (const [oi, count] of variantChildren.get(k)) {
        const outfitId = outfitIdByInternalId.get(oi);
        if (outfitId) variantOutfitRows.push({ variant_id: variantId, outfit_id: outfitId, count });
      }
    }
    // Clear the changed parents' old rows first, so an outfit removed from a
    // ship doesn't linger (the old upsert-only approach kept it forever).
    await deleteInChunked('ship_outfits', 'ship_id', [...changedShips].map(k => shipIdByInternalId.get(k)).filter(Boolean));
    await deleteInChunked('variant_outfits', 'variant_id', [...changedVariants].map(k => variantIdByInternalId.get(k)).filter(Boolean));
    await upsertChunked('ship_outfits', dedupeByComposite(shipOutfitRows, ['ship_id', 'outfit_id']), { onConflict: 'ship_id,outfit_id' });
    await upsertChunked('variant_outfits', dedupeByComposite(variantOutfitRows, ['variant_id', 'outfit_id']), { onConflict: 'variant_id,outfit_id' });
    cache.accept('ship_outfits', 'variant_outfits');

    // variant → base ship
    const shipIdBySuffix = new Map();
    for (const row of dedupedShipRows) {
      const internalId = row.internal_id, id = shipIdByInternalId.get(internalId);
      const at = internalId ? internalId.lastIndexOf('::') : -1;
      const suffix = at === -1 ? null : internalId.slice(at + 2);
      if (id && suffix && !shipIdBySuffix.has(suffix)) shipIdBySuffix.set(suffix, id);
    }
    const variantBaseUpdates = [];
    const baseOf = new Map();
    for (const { plugin } of allResults) {
      for (const v of plugin.variants) {
        const variantId = variantIdByInternalId.get(v._internalId);
        const baseId = shipIdBySuffix.get(v.baseShip);
        if (variantId && baseId) { variantBaseUpdates.push({ id: variantId, base_ship_id: baseId }); baseOf.set(v._internalId, baseId); }
      }
    }
    const changedBases = cache.changedParents('variant_base', 'variants', [...baseOf.keys()], k => baseOf.get(k));
    const changedBaseIds = new Set([...changedBases].map(k => variantIdByInternalId.get(k)));
    const dedupedBaseUpdates = dedupeByKey(variantBaseUpdates.filter(u => changedBaseIds.has(u.id)), 'id');
    for (const part of chunk(dedupedBaseUpdates, CHUNK_SIZE)) {
      if (!part.length) continue;
      const { error } = await supabase.rpc('bulk_update_variant_base_ship', { updates: part });
      if (error) throw new Error(`Supabase RPC failed for bulk_update_variant_base_ship: ${error.message}`);
    }
    cache.accept('variant_base');

    // ── wormhole links ──
    const wormholeChildren = new Map();
    for (const wormholes of rawWormholesByPlugin)
      for (const w of wormholes) addChildren(wormholeChildren, w._internalId, (w.links ?? []).map(l => [l.from, l.to, l.count ?? 1]));
    await checkCoverage('wormholes', 'wormhole_links', 'wormhole_id', wormholeChildren, wormholeIdByInternalId, v => v.length > 0, 'wormholes');
    const changedWormholes = cache.changedParents('wormhole_links', 'wormholes', [...wormholeChildren.keys()], k => wormholeChildren.get(k));
    for (const k of forceRebuild.wormholes) changedWormholes.add(k);
    const linkRows = [];
    for (const k of changedWormholes) {
      const wormholeId = wormholeIdByInternalId.get(k);
      if (wormholeId) for (const [from, to, count] of wormholeChildren.get(k)) linkRows.push({ wormhole_id: wormholeId, from_system: from, to_system: to, count });
    }
    await deleteInChunked('wormhole_links', 'wormhole_id', [...changedWormholes].map(k => wormholeIdByInternalId.get(k)).filter(Boolean));
    await insertChunked('wormhole_links', linkRows);
    cache.accept('wormhole_links');

    // ── planet shipyards / outfitters ──
    const planetChildren = new Map();
    for (const planets of rawPlanetsByPlugin)
      for (const p of planets) addChildren(planetChildren, p._internalId, {
        sy: (p.shipyards ?? []).map(x => x.name), of: (p.outfitters ?? []).map(x => x.name) });
    await checkCoverage('planets', 'planet_outfitters', 'planet_id', planetChildren, planetIdByInternalId, v => v.of.length > 0, 'planets');
    await checkCoverage('planets', 'planet_shipyards', 'planet_id', planetChildren, planetIdByInternalId, v => v.sy.length > 0, 'planets');
    const changedPlanets = cache.changedParents('planet_children', 'planets', [...planetChildren.keys()], k => planetChildren.get(k));
    for (const k of forceRebuild.planets) changedPlanets.add(k);
    const shipyardRows = [], outfitterRows = [];
    for (const k of changedPlanets) {
      const planetId = planetIdByInternalId.get(k);
      if (!planetId) continue;
      const c = planetChildren.get(k);
      for (const name of c.sy) shipyardRows.push({ planet_id: planetId, ship_name: name });
      for (const name of c.of) outfitterRows.push({ planet_id: planetId, outfit_name: name });
    }
    const changedPlanetIds = [...changedPlanets].map(k => planetIdByInternalId.get(k)).filter(Boolean);
    await deleteInChunked('planet_shipyards', 'planet_id', changedPlanetIds);
    await deleteInChunked('planet_outfitters', 'planet_id', changedPlanetIds);
    await insertChunked('planet_shipyards', shipyardRows);
    await insertChunked('planet_outfitters', outfitterRows);
    cache.accept('planet_children');

    // ── system fleets / hazards / asteroids / minables / links / planets / trade ──
    const systemChildren = new Map();
    for (const systems of rawSystemsByPlugin)
      for (const sy of systems) addChildren(systemChildren, sy._internalId, {
        fleets: (sy.fleets ?? []).map(f => ({ fleet_name: f.name, period: toNumeric(f.period), to_spawn: f.toSpawn ?? null })),
        hazards: (sy.hazards ?? []).map(h => ({ hazard_name: h.name, period: toNumeric(h.period), to_spawn: h.toSpawn ?? null })),
        asteroids: (sy.asteroids ?? []).map(a => ({ asteroid_name: a.name, asteroid_count: toNumeric(a.count), energy: toNumeric(a.energy) })),
        minables: (sy.minables ?? []).map(m => ({ minable_name: m.name, asteroid_count: toNumeric(m.count), energy: toNumeric(m.energy) })),
        links: (sy.links ?? []).map(l => ({ linked_system_name: l.name ?? l, explicit: l.explicit ?? null })),
        planets: (sy.planets ?? []).map(p => ({ planet_name: p.name })),
        trade: (sy.trade ?? []).map(t => ({ commodity_name: t.name, cost: toNumeric(t.cost) })),
      });
    await checkCoverage('systems', 'system_links', 'system_id', systemChildren, systemIdByInternalId, v => v.links.length > 0, 'systems');
    await checkCoverage('systems', 'system_planets', 'system_id', systemChildren, systemIdByInternalId, v => v.planets.length > 0, 'systems');
    await checkCoverage('systems', 'system_fleets', 'system_id', systemChildren, systemIdByInternalId, v => v.fleets.length > 0, 'systems');
    const changedSystems = cache.changedParents('system_children', 'systems', [...systemChildren.keys()], k => systemChildren.get(k));
    for (const k of forceRebuild.systems) changedSystems.add(k);
    const sysRows = { fleets: [], hazards: [], asteroids: [], minables: [], links: [], planets: [], trade: [] };
    for (const k of changedSystems) {
      const systemId = systemIdByInternalId.get(k);
      if (!systemId) continue;
      const c = systemChildren.get(k);
      for (const part of Object.keys(sysRows)) for (const r of c[part]) sysRows[part].push({ system_id: systemId, ...r });
    }
    const changedSystemIds = [...changedSystems].map(k => systemIdByInternalId.get(k)).filter(Boolean);
    const SYS_TABLES = { fleets: 'system_fleets', hazards: 'system_hazards', asteroids: 'system_asteroids', minables: 'system_minables',
                         links: 'system_links', planets: 'system_planets', trade: 'system_trade' };
    // one table at a time — seven big deletes/inserts at once can trip Supabase's statement timeout
    for (const t of Object.values(SYS_TABLES)) await deleteInChunked(t, 'system_id', changedSystemIds);
    for (const [part, t] of Object.entries(SYS_TABLES)) await insertChunked(t, sysRows[part]);
    cache.accept('system_children');

    // remember how many rows each junction table holds now, for next run's self-check
    {
      const rows = {};
      for (const tables of Object.values(JUNCTION_FAMILIES)) for (const t of tables) {
        const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
        if (!error && count != null) rows[t] = count;
      }
      cache.setMeta('junctionRows', rows);
    }

    console.log(`  rebuilt children of ${changedShips.size} ships, ${changedVariants.size} variants, ${changedPlanets.size} planets, ` +
      `${changedSystems.size} systems, ${changedWormholes.size} wormholes (${secs(junctionStart)})`);
    timings.push(['junction tables', (Date.now() - junctionStart) / 1000]);

    // ══ PHASE 4: remove what no longer exists ══
    console.log(`\nPhase 4: removing data that no longer exists...`);
    const cleanupStart = Date.now();
    const cleanup = { pluginsRemoved: [], staleRows: 0, flaggedShips: 0, flaggedFleets: 0, reAdded: 0 };
    const allowMass = process.env.PARSE_ALLOW_MASS_DELETE === '1';
    const sourceOf = id => { const s = String(id); return s.slice(0, s.lastIndexOf('/')); };
    const CHILDREN = {
      ships:     [['ship_outfits', 'ship_id']],
      variants:  [['variant_outfits', 'variant_id']],
      outfits:   [['ship_outfits', 'outfit_id'], ['variant_outfits', 'outfit_id']],
      planets:   [['planet_shipyards', 'planet_id'], ['planet_outfitters', 'planet_id']],
      systems:   Object.values(SYS_TABLES).map(t => [t, 'system_id']),
      wormholes: [['wormhole_links', 'wormhole_id']],
    };
    // delete rows and their children
    async function deleteByIds(table, ids) {
      if (!ids.length) return;
      for (const [child, col] of CHILDREN[table] || []) await deleteInChunked(child, col, ids);
      await deleteInChunked(table, 'id', ids);
    }
    const PLUGIN_TABLES_BY_ID   = ['outfits', 'ships', 'variants', 'stars', 'galaxies', 'wormholes', 'planets', 'systems', 'missions'];
    const PLUGIN_TABLES_BY_NAME = ['effects', 'governments', 'game_events'];
    const currentKeys = {
      outfits: dedupedOutfitRows, ships: dedupedShipRows, variants: dedupedVariantRows, stars: dedupedStarRows,
      galaxies: dedupedGalaxyRows, wormholes: dedupedWormholeRows, planets: dedupedPlanetRows, systems: dedupedSystemRows,
      missions: dedupedMissionRows,
    };

    try {
      const currentPluginIds = new Set(allPluginRows.map(p => p.plugin_id));
      const listedSources = new Set(config.plugins.map(p => p.name));
      const dbPlugins = await fetchAll('plugins', 'plugin_id, output_name, display_name, repository', 'plugin_id');

      // ── 4a. whole plugins ──
      const removed = dbPlugins.filter(p => !currentPluginIds.has(p.plugin_id) &&
        (!listedSources.has(sourceOf(p.plugin_id)) || parsedSources.has(sourceOf(p.plugin_id))));
      if (removed.length && removed.length > Math.max(5, dbPlugins.length / 2) && !allowMass) {
        console.warn(`  ⚠ ${removed.length} of ${dbPlugins.length} plugins would be removed — that looks like a mistake, so nothing was removed. ` +
          `(Set PARSE_ALLOW_MASS_DELETE=1 if it's intended.)`);
      } else if (removed.length) {
        const ids = removed.map(p => p.plugin_id);
        const idSet = new Set(ids);
        console.log(`  Removing ${removed.length} plugin(s) no longer on the site: ${removed.map(p => p.display_name || p.plugin_id).join(', ')}`);
        for (const t of PLUGIN_TABLES_BY_ID) {
          const rows = dbRows[t] || (dbRows[t] = await fetchAll(t, 'id, internal_id, plugin_id'));
          await deleteByIds(t, rows.filter(r => idSet.has(r.plugin_id)).map(r => r.id));
        }
        for (const t of PLUGIN_TABLES_BY_NAME) {
          try { await inPool(chunk(ids, 50), async part => { await supabase.from(t).delete().in('plugin_id', part); }); }
          catch (err) { console.warn(`  could not clear ${t}: ${err.message}`); }
        }
        try {
          await upsertChunked('removed_plugins', removed.map(p => ({
            plugin_id: p.plugin_id, output_name: p.output_name, display_name: p.display_name,
            source_name: sourceOf(p.plugin_id), repository: p.repository, removed_at: new Date().toISOString(),
          })), { onConflict: 'plugin_id' });
        } catch (err) { console.warn(`  Could not record removed plugins (run supabase/removed_plugins.sql?): ${err.message}`); }
        await inPool(chunk(ids, 50), async part => {
          const { error } = await supabase.from('plugins').delete().in('plugin_id', part);
          if (error) throw new Error(`could not delete plugins rows: ${error.message}`);
        });
        cleanup.pluginsRemoved = removed.map(p => p.display_name || p.plugin_id);
      }

      // A removed plugin that's back again is no longer "removed".
      try {
        const { data: wasRemoved } = await supabase.from('removed_plugins').select('plugin_id');
        const back = (wasRemoved || []).map(r => r.plugin_id).filter(id => currentPluginIds.has(id));
        if (back.length) {
          await supabase.from('removed_plugins').delete().in('plugin_id', back);
          cleanup.reAdded = back.length;
          console.log(`  ${back.length} previously removed plugin(s) are back: ${back.join(', ')}`);
        }
      } catch (_) { /* table not created yet */ }

      // ── 4b. items removed from plugins that are still here ──
      for (const t of PLUGIN_TABLES_BY_ID) {
        const rows = dbRows[t] || await fetchAll(t, 'id, internal_id, plugin_id');
        const keep = new Set(currentKeys[t].map(r => r.internal_id));
        const byPlugin = new Map();
        for (const r of rows) {
          if (!currentPluginIds.has(r.plugin_id)) continue;           // removed plugins handled above
          const g = byPlugin.get(r.plugin_id) || byPlugin.set(r.plugin_id, { total: 0, stale: [] }).get(r.plugin_id);
          g.total++;
          if (!keep.has(r.internal_id)) g.stale.push(r.id);
        }
        const toDelete = [];
        for (const [pid, g] of byPlugin) {
          if (!g.stale.length) continue;
          if (g.stale.length > 20 && g.stale.length > g.total / 2 && !allowMass) {
            console.warn(`  ⚠ ${pid}: ${g.stale.length} of ${g.total} ${t} would be removed — skipped (looks like a parse problem).`);
            continue;
          }
          toDelete.push(...g.stale);
        }
        if (toDelete.length) { await deleteByIds(t, toDelete); cleanup.staleRows += toDelete.length; console.log(`  removed ${toDelete.length} ${t} no longer in their plugins`); }
      }
      for (const t of PLUGIN_TABLES_BY_NAME) {
        try {
          const current = new Set((t === 'effects' ? allEffectRows : t === 'governments' ? allGovernmentRows : [])
            .map(r => `${r.plugin_id}\u0000${r.name}`));
          if (t === 'game_events') for (const ev of sharedParser.rawEvents || []) current.add(`${ev.plugin_id}\u0000${ev.name}`);
          const rows = await fetchAll(t, 'plugin_id, name', 'name');
          const stale = new Map();
          for (const r of rows) {
            if (!currentPluginIds.has(r.plugin_id) || current.has(`${r.plugin_id}\u0000${r.name}`)) continue;
            (stale.get(r.plugin_id) || stale.set(r.plugin_id, []).get(r.plugin_id)).push(r.name);
          }
          for (const [pid, names] of stale) {
            await inPool(chunk(names, 100), async part => { await supabase.from(t).delete().eq('plugin_id', pid).in('name', part); });
            cleanup.staleRows += names.length;
          }
        } catch (err) { console.warn(`  could not tidy ${t}: ${err.message}`); }
      }

      // ── 4c. flag people's ships that use a removed plugin ──
      try {
        const removedRows = await fetchAll('removed_plugins', 'plugin_id, output_name, display_name, source_name, repository, removed_at', 'plugin_id');
        const index = PluginRefs.indexRemoved(removedRows);
        const ships = await fetchAll('saved_ships', 'id, user_id, build_data');
        const shipFlags = [];
        for (const s of ships) {
          const missing = PluginRefs.missingFor(s.build_data, index);
          if (missing.length) shipFlags.push({ saved_ship_id: String(s.id), user_id: s.user_id, missing, flagged_at: new Date().toISOString() });
        }
        const fleets = await fetchAll('fleets', 'id, user_id, ships');
        const fleetFlags = [];
        for (const f of fleets) {
          const merged = new Map();
          for (const design of Array.isArray(f.ships) ? f.ships : []) {
            for (const m of PluginRefs.missingFor(design, index)) {
              const e = merged.get(m.plugin_id) || merged.set(m.plugin_id, { ...m, uses: [], ships: [] }).get(m.plugin_id);
              const shipName = design.name || design._sourceShip || 'Unnamed ship';
              if (!e.ships.includes(shipName)) e.ships.push(shipName);
              for (const u of m.uses) if (!e.uses.includes(u)) e.uses.push(u);
            }
          }
          if (merged.size) fleetFlags.push({ fleet_id: String(f.id), user_id: f.user_id, missing: [...merged.values()], flagged_at: new Date().toISOString() });
        }
        // replace the flag tables' contents (flags clear themselves once a plugin is back)
        const prevShip = await fetchAll('saved_ship_plugin_flags', 'saved_ship_id', 'saved_ship_id');
        const prevFleet = await fetchAll('fleet_plugin_flags', 'fleet_id', 'fleet_id');
        const keepShip = new Set(shipFlags.map(f => f.saved_ship_id)), keepFleet = new Set(fleetFlags.map(f => f.fleet_id));
        await deleteInChunked('saved_ship_plugin_flags', 'saved_ship_id', prevShip.map(r => r.saved_ship_id).filter(id => !keepShip.has(id)));
        await deleteInChunked('fleet_plugin_flags', 'fleet_id', prevFleet.map(r => r.fleet_id).filter(id => !keepFleet.has(id)));
        await upsertChunked('saved_ship_plugin_flags', shipFlags, { onConflict: 'saved_ship_id' });
        await upsertChunked('fleet_plugin_flags', fleetFlags, { onConflict: 'fleet_id' });
        cleanup.flaggedShips = shipFlags.length; cleanup.flaggedFleets = fleetFlags.length;
      } catch (err) {
        console.warn(`  Could not flag ships that use removed plugins (run supabase/removed_plugins.sql?): ${err.message}`);
      }
    } catch (err) {
      console.warn(`  Cleanup skipped: ${err.message}`);
    }
    console.log(`  ${cleanup.pluginsRemoved.length} plugin(s) removed, ${cleanup.staleRows} leftover row(s) removed, ` +
      `${cleanup.flaggedShips} shared ship(s) and ${cleanup.flaggedFleets} fleet(s) flagged as needing a removed plugin (${secs(cleanupStart)})`);
    timings.push(['cleanup', (Date.now() - cleanupStart) / 1000]);

    // a fingerprint per plugin (lets the deploy reuse unchanged ready-made files)
    {
      const crypto = require('crypto');
      const pidOf = key => String(key).split('::')[0];
      const outfitHash = new Map(dedupedOutfitRows.map(o => [o.internal_id, crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex')]));
      const parts = new Map();   // plugin_id → hash
      const feed = (pid, label, value) => {
        if (!pid) return;
        let h = parts.get(pid);
        if (!h) { h = crypto.createHash('sha1'); parts.set(pid, h); }
        h.update(label); h.update(JSON.stringify(value));
      };
      const tables = { ships: dedupedShipRows, variants: dedupedVariantRows, outfits: dedupedOutfitRows, effects: allEffectRows,
        systems: dedupedSystemRows, planets: dedupedPlanetRows, galaxies: dedupedGalaxyRows, wormholes: dedupedWormholeRows,
        stars: dedupedStarRows, governments: allGovernmentRows, missions: dedupedMissionRows };
      for (const [t, rows] of Object.entries(tables)) for (const r of rows) feed(r.plugin_id, t, r);
      // children (outfit lists, jump links, shipyards …) — and the outfits a plugin's ships
      // use from OTHER plugins, since those are copied into its catalog file too
      const kids = { ship: shipChildren, variant: variantChildren, planet: planetChildren, system: systemChildren, wormhole: wormholeChildren };
      for (const [label, map] of Object.entries(kids)) for (const [k, v] of map) {
        feed(pidOf(k), label, v);
        if (label === 'ship' || label === 'variant') for (const [oi] of v) feed(pidOf(k), 'uses', outfitHash.get(oi) || oi);
      }
      const fingerprints = Object.fromEntries([...parts].map(([pid, h]) => [pid, h.digest('hex')]));
      await withRetry(async () => {
        const { error } = await supabase.from('app_config').upsert({ key: 'pluginFingerprints', value: fingerprints }, { onConflict: 'key' });
        if (error) throw new Error(`Supabase upsert failed for app_config: ${error.message}`);
      }, { label: 'upsert pluginFingerprints' });
    }

    // Display names for pages that don't load full ship/outfit data (e.g. Missions):
    // { pluginId: { ships: { internal: display }, outfits: { internal: display } } }
    {
      const names = {};
      const put = (rows, kind) => {
        for (const r of rows) {
          const dn = r.attributes && r.attributes['display name'];
          if (!dn || dn === r.name) continue;
          const p = (names[r.plugin_id] = names[r.plugin_id] || { ships: {}, outfits: {} });
          p[kind][r.name] = String(dn);
        }
      };
      put(dedupedShipRows, 'ships'); put(dedupedVariantRows, 'ships'); put(dedupedOutfitRows, 'outfits');
      await withRetry(async () => {
        const { error } = await supabase.from('app_config').upsert({ key: 'displayNames', value: names }, { onConflict: 'key' });
        if (error) throw new Error(`Supabase upsert failed for app_config: ${error.message}`);
      }, { label: 'upsert displayNames' });
    }

    // Tell the site there's new data (its cache checks this) — only when
    // something actually changed, so visitors' caches stay valid otherwise.
    const anythingChanged = cleanup.pluginsRemoved.length || cleanup.staleRows || Object.values(pushed).some(p => p.changed > 0)
      || changedShips.size || changedVariants.size || changedPlanets.size || changedSystems.size || changedWormholes.size;
    if (anythingChanged)
      await supabase.from('app_config').upsert({ key: 'dataVersion', value: { updatedAt: new Date().toISOString() } });
    else console.log(`  Nothing changed since the last run.`);
    console.log(`\nAll Supabase writes complete.`);

    // json outputs the site still reads

    const dataDir = path.join(process.cwd(), 'data');
    await fs.mkdir(dataDir, { recursive: true });
    // attribute definitions go straight to Supabase
    const attrStart = Date.now();
    let gameSha = null;
    try {
      const { stdout } = await promisify(execCallback)('git ls-remote https://github.com/endless-sky/endless-sky.git HEAD', { timeout: 30000 });
      gameSha = (stdout.split(/\s+/)[0] || '').trim() || null;
    } catch (_) { /* unknown → don't skip */ }
    const prevAttr = cache.meta('attributes');
    const attrUnchanged = gameSha && prevAttr && prevAttr.gameSha === gameSha && (pushed.ships?.changed ?? 1) === 0;
    if (attrUnchanged) {
      console.log(`\nAttribute definitions: game unchanged since the last run (${gameSha.slice(0, 7)}) — skipped.`);
      cache.setMeta('attributes', prevAttr);
    } else try {
      const attrDefsJson = await parseAttributes(dataDir);

      // Relational copy (attribute_definitions, attribute_flags, …) — what
      // the front end reads first. See attributeSync.js.
      try {
        await withRetry(() => syncAttributeTables(supabase, attrDefsJson, { shipRows: dedupedShipRows }),
          { label: 'sync attribute tables' });
      } catch (err) {
        console.warn(`Could not sync attribute tables: ${err.message}`);
      }

      // Blob copy kept as a fallback while every page moves over to the
      // tables. Safe to remove once nothing reads app_config.attributeDefinitions.
      await supabase.from('app_config').upsert({ key: 'attributeDefinitions', value: attrDefsJson });

      // the data version the site checks
      await supabase.from('app_config').upsert({ key: 'dataVersion', value: { updatedAt: new Date().toISOString() } });
      console.log(`\nPushed attribute definitions to Supabase.`);
      if (gameSha) cache.setMeta('attributes', { gameSha, at: new Date().toISOString() });
    } catch (err) {
      console.warn(`Could not build or push attribute definitions: ${err.message}`);
    }
    timings.push(['attribute definitions', (Date.now() - attrStart) / 1000]);

    // Everything succeeded — remember what was pushed for next time.
    try { cache.commit(); console.log(`\nSaved the push cache (.parse-cache/pushed.json).`); }
    catch (err) { console.warn(`Could not save the push cache: ${err.message}`); }

    // Where the time went, slowest first (sources over 5 s only).
    timings.push(['TOTAL', (Date.now() - runStart) / 1000]);
    console.log(`\n${'='.repeat(60)}\nTimings\n${'='.repeat(60)}`);
    for (const [label, sec] of timings.filter(([l, t]) => !l.startsWith('source: ') || t >= 5).sort((a, b) => b[1] - a[1]))
      console.log(`  ${sec.toFixed(1).padStart(7)}s  ${label}`);

    console.log(`\n${'='.repeat(60)}\n✓ All done!\n${'='.repeat(60)}\n`);
  } catch (err) {
    console.error('Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = EndlessSkyParser;
