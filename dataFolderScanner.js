'use strict';

// Scans the game's data/*.txt files to see which attributes ships and outfits actually use. Used by attributeParser.

const fs   = require('fs').promises;
const path = require('path');

const ES_REPO_RAW = 'https://raw.githubusercontent.com/endless-sky/endless-sky/master';
const ES_API_TREE  = 'https://api.github.com/repos/endless-sky/endless-sky/git/trees/master?recursive=1';

// ── reading data files ──

// split a line the way DataFile.cpp does
function tokenizeLine(rawLine) {
    if (!rawLine) return null;
    let i = 0;
    while (rawLine[i] === '\t') i++;
    const depth = i;
    const rest = rawLine.slice(i);
    if (!rest.trim()) return null;

    const tokens = [];
    let j = 0;
    while (j < rest.length) {
        const ch = rest[j];
        if (ch === ' ' || ch === '\t') { j++; continue; }
        if (ch === '"' || ch === '`') {
            const quote = ch;
            let k = j + 1;
            while (k < rest.length && rest[k] !== quote) k++;
            tokens.push(rest.slice(j + 1, k));
            j = k + 1;
        } else {
            let k = j;
            while (k < rest.length && rest[k] !== ' ' && rest[k] !== '\t') k++;
            tokens.push(rest.slice(j, k));
            j = k;
        }
    }
    return tokens.length ? { depth, tokens } : null;
}

// text → { tokens, children } tree
function buildTree(src) {
    const roots = [];
    const stack = []; // [{ depth, node }], innermost last
    for (const rawLine of src.split('\n')) {
        const parsed = tokenizeLine(rawLine);
        if (!parsed) continue;
        const { depth, tokens } = parsed;
        const node = { tokens, children: [] };
        while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
        if (stack.length) stack[stack.length - 1].node.children.push(node);
        else roots.push(node);
        stack.push({ depth, node });
    }
    return roots;
}

// ── attribute usage ──

// keys that aren't attributes (directives, names, sprites …)
const NON_ATTRIBUTE_KEYS = new Set([
    'overwrite', 'add', 'remove', 'clear',
    'sprite', 'thumbnail', 'description', 'plural', 'noun', 'swizzle',
    'licenses', 'flotsam sprite', 'unplunderable', 'category',
    'outfits', 'engine', 'reverse engine', 'steering engine',
    'gun', 'turret', 'fighter', 'drone', 'bay',
    'leak', 'explode', 'final explode', 'effect', 'sound',
]);

// attributes in one block
function scanAttributeBlock(node, category, onType, perKey) {
    for (const child of node.children) {
        const key = child.tokens[0];
        if (!key) continue;
        if (key === 'weapon') { scanAttributeBlock(child, category, onType, perKey); continue; }
        if (NON_ATTRIBUTE_KEYS.has(key)) continue;

        if (!perKey[key]) perKey[key] = {
            count: 0, categories: new Set(), min: null, max: null, samples: [],
            onShip: false, onOutfit: false,
        };
        const rec = perKey[key];
        rec.count++;
        if (category) rec.categories.add(category);
        if (onType === 'ship')   rec.onShip = true;
        if (onType === 'outfit') rec.onOutfit = true;

        if (child.tokens.length > 1) {
            const value = parseFloat(child.tokens[1]);
            // Preserve sign (§5.7 — negative capacity-consumption values are
            // normal and expected, not something to normalise away).
            if (!isNaN(value)) {
                if (rec.min === null || value < rec.min) rec.min = value;
                if (rec.max === null || value > rec.max) rec.max = value;
                if (rec.samples.length < 5) rec.samples.push(value);
            }
        }
    }
}

// first child with this key
function findChild(node, key) {
    return node.children.find(c => c.tokens[0] === key) || null;
}

// usage across every file
function aggregateDataUsage(fileEntries) {
    const perKey = {};
    for (const { content } of fileEntries) {
        let roots;
        try { roots = buildTree(content); } catch (_) { continue; }

        for (const root of roots) {
            const type = root.tokens[0];
            if (type !== 'outfit' && type !== 'ship') continue;

            if (type === 'outfit') {
                const catNode  = findChild(root, 'category');
                const category = catNode ? catNode.tokens[1] : null;
                scanAttributeBlock(root, category, 'outfit', perKey);
            } else {
                // ship attributes sit one level deeper, under `attributes`
                const attrNode = findChild(root, 'attributes');
                if (!attrNode) continue;
                const catNode = findChild(attrNode, 'category') || findChild(root, 'category');
                const category = catNode ? catNode.tokens[1] : null;
                scanAttributeBlock(attrNode, category, 'ship', perKey);
            }
        }
    }
    return perKey;
}

// how many ships have each attribute

function aggregateShipCoverage(fileEntries) {
    const perKey = {};
    let baseShipCount = 0;
    for (const { content } of fileEntries) {
        let roots;
        try { roots = buildTree(content); } catch (_) { continue; }
        for (const root of roots) {
            if (root.tokens[0] !== 'ship' || root.tokens.length !== 2) continue;
            const attrNode = findChild(root, 'attributes');
            if (!attrNode) continue;
            baseShipCount++;
            const seen = new Set();
            for (const child of attrNode.children) {
                const key = child.tokens[0];
                if (!key || child.children.length) continue;
                seen.add(key);
            }
            for (const key of seen) perKey[key] = (perKey[key] || 0) + 1;
        }
    }
    return { baseShipCount, perKey };
}

// ── category hints ──

// base-game outfit categories only; anything else gives no hint
const CATEGORY_AREA_MAP = {
    'guns':               'Weapons',
    'turrets':             'Weapons',
    'secondary weapons':   'Weapons',
    'ammunition':          'Weapons',
    'anti-missile':        'Weapons',
    'engines':              'Movement & Engines',
    'steering':             'Movement & Engines',
    'power':                'Power, Heat & Life Support',
    'systems':              'Power, Heat & Life Support',
    'shields':              'Power, Heat & Life Support',
    'cooling':              'Power, Heat & Life Support',
    'hand to hand':         'Special / Flags',
};

// a hint only if every category agrees
function deriveCategoryAreaHints(perKey) {
    const hints = {};
    for (const [key, rec] of Object.entries(perKey)) {
        if (!rec.categories || !rec.categories.size) continue;
        const areas = new Set();
        for (const cat of rec.categories) {
            const area = CATEGORY_AREA_MAP[String(cat).toLowerCase()];
            if (area) areas.add(area);
        }
        if (areas.size === 1)
            hints[key] = { area: [...areas][0], categories: [...rec.categories].sort() };
    }
    return hints;
}

// a scanner sharing attributeParser's fetch budget

function createDataFolderScanner({ fetchText, withPool }) {

    // scan the data folder
    async function scanDataFolderUsage(cacheFile, opts = {}) {
        const maxAgeMs    = opts.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
        const forceRescan = !!opts.forceRescan;

        if (!forceRescan) {
            try {
                const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
                // Caches written before shipCoverage existed are treated as
                // stale so the new ship-requirement pass gets real data.
                if ((Date.now() - cached.scannedAt) < maxAgeMs && cached.shipCoverage) {
                    console.log(`  Using cached data/ usage scan from ${new Date(cached.scannedAt).toISOString()} ` +
                        `(${cached.fileCount} files, ${Object.keys(cached.perKey).length} attribute keys). Pass --rescan to force a fresh scan.`);
                    return cached;
                }
            } catch (_) { /* no cache yet, or unreadable — do a fresh scan */ }
        }

        console.log('  Fetching data/ file tree from GitHub API...');
        const authHeaders = process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {};
        let treeJson;
        try {
            treeJson = JSON.parse(await fetchText(ES_API_TREE, authHeaders));
        } catch (err) {
            console.log(`  ✗  Could not fetch repo tree (${err.message}). data/ usage scan skipped this run.`);
            return { scannedAt: Date.now(), fileCount: 0, perKey: {}, failed: true };
        }

        const candidates = (treeJson.tree || [])
            .filter(e => e.type === 'blob' && e.path.startsWith('data/') && /\.txt$/i.test(e.path));
        console.log(`  ${candidates.length} .txt files under data/`);

        const fileEntries = [];
        await withPool(candidates, async (entry) => {
            const content = await fetchText(`${ES_REPO_RAW}/${entry.path}`);
            fileEntries.push({ path: entry.path, content });
        }, 8, (done, total) => {
            if (done % 25 === 0 || done === total) process.stdout.write(`\r  Fetched ${done}/${total}...`);
        });
        console.log(`\r  Fetched ${fileEntries.length}/${candidates.length} data/ files`);

        const perKeyRaw = aggregateDataUsage(fileEntries);
        const perKey = {};
        for (const [key, rec] of Object.entries(perKeyRaw)) {
            perKey[key] = {
                count: rec.count,
                categories: [...rec.categories].sort(),
                min: rec.min, max: rec.max, samples: rec.samples,
                onShip: rec.onShip, onOutfit: rec.onOutfit,
            };
        }

        const shipCoverage = aggregateShipCoverage(fileEntries);
        console.log(`  ${shipCoverage.baseShipCount} base ship definitions measured for attribute coverage`);

        const record = { scannedAt: Date.now(), fileCount: fileEntries.length, perKey, shipCoverage };
        try {
            await fs.mkdir(path.dirname(cacheFile), { recursive: true });
            await fs.writeFile(cacheFile, JSON.stringify(record, null, 2), 'utf8');
        } catch (_) { /* non-fatal — scan still returned in-memory */ }

        return record;
    }

    return { scanDataFolderUsage, deriveCategoryAreaHints, aggregateDataUsage, aggregateShipCoverage, buildTree, tokenizeLine };
}

module.exports = createDataFolderScanner;
