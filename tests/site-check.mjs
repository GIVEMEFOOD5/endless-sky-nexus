// ═══════════════════════════════════════════════════════════════════════════
//  tests/site-check.mjs — automatic checks for Endless Sky Nexus
//
//  Opens the site in a real browser (Chromium, via Playwright) and runs the
//  main things a visitor does. Fails if any page throws an error or a flow
//  doesn't work. Uses the live Supabase data (read-only — it never logs in
//  and never writes anything).
//
//  Run locally:   python3 -m http.server 8080 &   then   node tests/site-check.mjs
//  In GitHub:     .github/workflows/site-checks.yml runs it on every change.
//  SITE_URL=https://… node tests/site-check.mjs  checks a deployed copy instead.
// ═══════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.SITE_URL || 'http://localhost:8080').replace(/\/$/, '');
const H = p => `${BASE}/Display/HTML/${p}`;
const OUT = 'site-check-results';
fs.mkdirSync(OUT, { recursive: true });

// Console noise that isn't a site bug (missing ship pictures, the browser's own network log …)
const IGNORE = [/Failed to load resource/i, /ERR_|net::/i, /favicon/i, /ImageGrabber/i, /QuotaExceededError/i, /Could not write save/i];

const results = [];
let browser, context;

function watch(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(`page error: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (!IGNORE.some(re => re.test(t))) errors.push(`console: ${t.slice(0, 300)}`);
  });
  page.on('dialog', d => d.accept());
  return errors;
}

async function check(name, fn) {
  const page = await context.newPage();
  const errors = watch(page);
  const started = Date.now();
  try {
    const note = await fn(page);
    if (errors.length) throw new Error(errors.slice(0, 5).join('\n'));
    results.push({ name, ok: true, note: note || '', secs: (Date.now() - started) / 1000 });
    console.log(`✅ ${name}${note ? ` — ${note}` : ''}`);
  } catch (err) {
    const file = path.join(OUT, name.replace(/[^\w]+/g, '_').slice(0, 80) + '.png');
    try { await page.screenshot({ path: file, fullPage: true }); } catch (_) {}
    results.push({ name, ok: false, note: String(err.message || err).slice(0, 1500), secs: (Date.now() - started) / 1000 });
    console.log(`❌ ${name}\n   ${String(err.message || err).split('\n').join('\n   ')}`);
  } finally {
    await page.close();
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const dataReady = page => page.waitForFunction(() => window.DataLoader && window.DataLoader.isReady && window.DataLoader.isReady(), null, { timeout: 90000 });

browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
// For offline testing only: FAKE_SUPABASE=path/to/fake.js swaps the live database for a fake one.
async function newContext(opts) {
  const ctx = await browser.newContext(opts);
  if (process.env.FAKE_SUPABASE) {
    const fake = fs.readFileSync(process.env.FAKE_SUPABASE, 'utf8');
    await ctx.route('**/*', rt => {
      const u = rt.request().url();
      if (u.includes('@supabase/supabase-js')) return rt.fulfill({ status: 200, contentType: 'application/javascript', body: fake });
      return u.startsWith(BASE) ? rt.continue() : rt.abort();
    });
  }
  return ctx;
}
context = await newContext({ viewport: { width: 1280, height: 900 } });

// ── 1. Every page opens without errors ─────────────────────────────────────
const PAGES = ['Home.html', 'DataViewer.html', 'shipBuilder.html', 'BattleSim.html', 'Systems.html',
               'UserMissionHelper.html', 'UserManager.html', 'PluginAdder.html', 'Profile.html', 'About.html'];
for (const p of PAGES) {
  await check(`page opens: ${p}`, async page => {
    await page.goto(H(p), { waitUntil: 'load' });
    await page.waitForTimeout(6000);
    const title = await page.title();
    expect(/Endless Sky Nexus/.test(title), `unexpected title "${title}"`);
    return title;
  });
}
await check('root address goes to Home', async page => {
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  expect(/Home\.html/.test(page.url()), `ended on ${page.url()}`);
});

// ── 2. Phones: no page scrolls sideways ────────────────────────────────────
{
  const phone = await newContext({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
  const saved = context; context = phone;
  for (const p of PAGES) {
    await check(`fits a phone: ${p}`, async page => {
      await page.goto(H(p), { waitUntil: 'load' });
      await page.waitForTimeout(5000);
      const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(sw <= cw + 1, `page is ${sw}px wide on a ${cw}px screen`);
    });
  }
  context = saved; await phone.close();
}

// ── 3. Data Viewer ──────────────────────────────────────────────────────────
await check('Data Viewer: cards, search, details', async page => {
  await page.goto(H('DataViewer.html'));
  await page.waitForFunction(() => document.querySelectorAll('#cardsContainer .card').length > 0, null, { timeout: 90000 });
  const n = await page.locator('#cardsContainer .card').count();
  await page.fill('#searchInput', 'zzzz-no-such-thing'); await page.dispatchEvent('#searchInput', 'input'); await page.waitForTimeout(800);
  expect(await page.locator('#cardsContainer .card').count() === 0, 'search for nonsense still shows cards');
  await page.fill('#searchInput', ''); await page.dispatchEvent('#searchInput', 'input'); await page.waitForTimeout(800);
  await page.locator('#cardsContainer .card').first().click();
  await page.waitForTimeout(800);
  expect(await page.locator('.modal-tab').count() > 0, 'item details did not open');
  return `${n} ships shown`;
});

// ── 4. Ship builder: outfit a game ship, save, auto-fit, share link ──────────
await check('Ship Builder: outfit a ship, save, auto-fit, share link', async page => {
  await page.goto(H('shipBuilder.html'));
  await dataReady(page);
  await page.waitForTimeout(1500);
  await page.evaluate(() => openOutfitExisting());
  await page.waitForSelector('#sb-ship-picker-list .sb-picker-row', { timeout: 30000 });
  await page.locator('#sb-ship-picker-list .sb-picker-row').first().click();
  await page.waitForTimeout(800);
  const name = await page.inputValue('#ship-name');
  expect(name, 'no ship opened');
  await page.click('text=💾 Save Ship'); await page.waitForTimeout(800);
  expect(await page.evaluate(() => sbFleet.length) >= 1, 'ship was not saved to the fleet');
  // auto-fit (all-round) must produce a result that passes its own checks
  await page.click('text=⚡ Auto-fit'); await page.waitForTimeout(3000);
  await page.click('[data-af="goal"][data-goal="general"]');
  await page.click('[data-af="run"]');
  await page.waitForSelector('#af-result h3', { timeout: 120000 });
  await page.click('[data-af="close"]');
  // share link round trip
  const url = await page.evaluate(async () => ShareLinks.make('shipBuilder.html', 'ship', { ship: sbCompactDesign(sbCurrentShip) }));
  const other = await context.newPage(); const errs = watch(other);
  await other.goto(url); await dataReady(other); await other.waitForTimeout(2500);
  const opened = await other.inputValue('#ship-name').catch(() => '');
  await other.close();
  expect(opened === name, `share link opened "${opened}" instead of "${name}"`);
  expect(!errs.length, errs.join(' | '));
  return `${name}; link ${url.length} chars`;
});

// ── 5. Battle simulator: two teams fight; share link ─────────────────────────
await check('Battle Simulator: a battle runs, share link', async page => {
  await page.goto(H('BattleSim.html'));
  await page.waitForFunction(() => window.BattleSimTeams && BattleSimTeams.ships().length > 1, null, { timeout: 90000 });
  await page.evaluate(() => {
    const T = BattleSimTeams; T.clear();
    const has = s => Array.isArray(s.outfits) ? s.outfits.length : Object.keys(s.outfits || {}).length;
    const armed = T.ships().filter(has).slice(0, 2);
    if (armed.length < 2) armed.push(...T.ships().slice(0, 2 - armed.length));
    T.add(T.teams()[0].id, armed[0], 1); T.add(T.teams()[1].id, armed[1] || armed[0], 1); T.refresh();
  });
  await page.evaluate(() => runSimulation());
  await page.waitForFunction(() => getComputedStyle(document.getElementById('simResults')).display !== 'none', null, { timeout: 120000 });
  const winner = await page.textContent('#resultWinnerName');
  const url = await page.evaluate(async () => {
    const T = BattleSimTeams.teams();
    return ShareLinks.make('BattleSim.html', 'battle', { teams: T.map(t => ({ n: t.name, s: t.ships.map(e => [e.shipData.name, e.count, e.skilled ?? e.count]) })) });
  });
  const other = await context.newPage(); const errs = watch(other);
  await other.goto(url);
  await other.waitForFunction(() => getComputedStyle(document.getElementById('simResults')).display !== 'none', null, { timeout: 120000 });
  await other.close();
  expect(!errs.length, errs.join(' | '));
  return `winner: ${winner}`;
});

// ── 6. Systems map: systems AND hyperspace lanes load; share link ────────────
await check('Systems Map: systems and jump lanes load, share link', async page => {
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  await page.goto(H('Systems.html'));
  await page.waitForFunction(() => window.MapView, null, { timeout: 60000 });
  await page.waitForTimeout(12000);
  const line = logs.reverse().find(t => /^\[Map\] \d+ systems, \d+ lanes drawn/.test(t)) || '';
  const m = line.match(/\[Map\] (\d+) systems, (\d+) lanes drawn/);
  expect(m, 'map never reported loading');
  expect(+m[1] > 100, `only ${m[1]} systems loaded`);
  expect(+m[2] > 100, `only ${m[2]} hyperspace lanes drawn (jump links missing?)`);
  const other = await context.newPage(); const errs = watch(other);
  await other.goto(H('Systems.html') + '#system=Sol');
  await other.waitForTimeout(12000);
  const panel = await other.textContent('#mapDetailsPanel').catch(() => '');
  await other.close();
  expect(/Sol/.test(panel || ''), 'map link to Sol did not open Sol');
  expect(!errs.length, errs.join(' | '));
  return `${m[1]} systems, ${m[2]} lanes`;
});

// ── 7. Missions ──────────────────────────────────────────────────────────────
await check('Missions: list loads and a mission opens', async page => {
  await page.goto(H('UserMissionHelper.html'));
  await page.waitForFunction(() => document.querySelectorAll('.mission-card').length > 0, null, { timeout: 90000 });
  const n = await page.locator('.mission-card').count();
  await page.locator('.mission-card').first().click();
  await page.waitForTimeout(800);
  expect(await page.locator('.modal-overlay.active').count() > 0, 'mission details did not open');
  return `${n} missions shown`;
});

// ── 8. Saves: open a save, see the fleet, open the editor ────────────────────
await check('Saves: open a save file and the editor', async page => {
  await page.goto(H('UserManager.html'));
  await page.waitForTimeout(3000);
  await page.setInputFiles('#fileInput', path.resolve('tests/fixtures/sample-save.txt'));
  await page.waitForSelector('#results:not(.hidden)', { timeout: 30000 });
  const fleet = await page.textContent('#results');
  expect(/Test Shuttle|Shuttle/.test(fleet || ''), 'the save\'s ship is not shown');
  await page.click('#resultTabs .tab[data-tab="edit"]');
  await page.waitForTimeout(1500);
  expect(await page.locator('[data-f="credits"]').count() > 0, 'save editor did not open');
  return 'Test Pilot opened';
});

await browser.close();

// ── Summary ──────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
const md = [`## Site checks: ${failed.length ? `❌ ${failed.length} failed` : '✅ all passed'} (${results.length} checks)`, '',
  '| | Check | Notes | Time |', '|---|---|---|---|',
  ...results.map(r => `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.note.replace(/\n/g, '<br>').replace(/\|/g, '\\|').slice(0, 400)} | ${r.secs.toFixed(1)}s |`)].join('\n');
fs.writeFileSync(path.join(OUT, 'summary.md'), md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
console.log(`\n${failed.length ? `❌ ${failed.length} of ${results.length} checks failed` : `✅ All ${results.length} checks passed`}`);
process.exit(failed.length ? 1 : 0);
