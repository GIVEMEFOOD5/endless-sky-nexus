// Database health check: makes sure every table, view and function the website uses exists and
// that the website is allowed to use it. If not, runs supabase/migrations/*.sql, fixes permissions
// from the tables' own row rules, then checks again. Run by .github/workflows/database.yml.
//
//   node build/dbHealth.mjs            check, fix if needed, check again (exit 1 if still broken)
//   node build/dbHealth.mjs --check    only check
//   node build/dbHealth.mjs --apply    run the migrations even if everything looks fine
//
// Needs SUPABASE_DB_URL (the database connection string — a GitHub secret, never on the website).

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const args = new Set(process.argv.slice(2));
const log = (...a) => console.log(...a);
const summary = [];   // lines for the GitHub job summary

// every table/view and function the site's own code asks Supabase for
function whatTheSiteUses() {
  const tables = new Set(), fns = new Set();
  const walk = dir => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) { if (!/vendor|node_modules/.test(p)) walk(p); continue; }
      if (!/\.(m?js)$/.test(f)) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/\.from\(\s*'([a-z_]+)'\s*\)/g)) tables.add(m[1]);
      for (const m of src.matchAll(/(?:fetchAllRows|byIds|allRows)\(\s*'([a-z_]+)'/g)) tables.add(m[1]);
      for (const m of src.matchAll(/\.rpc\(\s*'([a-z_]+)'/g)) fns.add(m[1]);
      for (const m of src.matchAll(/request\(\s*`?'?rpc\/([a-z_]+)/g)) fns.add(m[1]);
    }
  };
  walk(path.join(ROOT, 'Display', 'JavaScript'));
  if (fs.existsSync(path.join(ROOT, 'build'))) walk(path.join(ROOT, 'build'));
  return { tables: [...tables].sort(), fns: [...fns].sort() };
}

// what's wrong right now → [{ kind, name, problem }]
async function check(db, uses) {
  const problems = [];
  for (const t of uses.tables) {
    const { rows } = await db.query(
      `select c.relkind, c.relrowsecurity,
              has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT') as anon_ok,
              has_table_privilege('authenticated', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'INSERT') as auth_ok
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1`, [t]);
    if (!rows.length) { problems.push({ kind: 'table', name: t, problem: 'missing' }); continue; }
    if (!rows[0].anon_ok && !rows[0].auth_ok) problems.push({ kind: 'table', name: t, problem: 'the website isn\'t allowed to use it (403)' });
  }
  for (const f of uses.fns) {
    const { rows } = await db.query(
      `select bool_or(has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')) as ok
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`, [f]);
    if (rows[0].ok === null) problems.push({ kind: 'function', name: f, problem: 'missing' });
    else if (!rows[0].ok) problems.push({ kind: 'function', name: f, problem: 'the website isn\'t allowed to call it' });
  }
  return problems;
}

// run every migration file, in order
async function applyMigrations(db) {
  const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    try { await db.query(sql); log(`  ✓ ran ${f}`); summary.push(`ran \`${f}\``); }
    catch (err) { log(`  ✗ ${f}: ${err.message}`); summary.push(`❌ \`${f}\`: ${err.message}`); }
  }
}

// grants that match each table's own row rules (a SELECT rule for "anon" → anon may SELECT),
// so permissions follow the policies instead of being guessed. Only for tables with RLS on.
async function grantsFromPolicies(db, uses) {
  const { rows } = await db.query(
    `select p.tablename, p.cmd, p.roles
       from pg_policies p join pg_class c on c.relname = p.tablename
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = p.schemaname
      where p.schemaname = 'public' and c.relrowsecurity and p.tablename = any($1)`, [uses.tables]);
  for (const r of rows) {
    const roles = (Array.isArray(r.roles) ? r.roles : String(r.roles).replace(/[{}]/g, '').split(','))
      .flatMap(x => (x === 'public' ? ['anon', 'authenticated'] : [x])).filter(x => x === 'anon' || x === 'authenticated');
    const cmds = r.cmd === 'ALL' ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : [r.cmd];
    for (const role of new Set(roles)) for (const cmd of cmds) {
      await db.query(`grant ${cmd} on public.${pg.escapeIdentifier(r.tablename)} to ${role}`);
    }
  }
  // views the site reads (security_invoker: their tables' rules still apply)
  for (const t of uses.tables) {
    const { rows: v } = await db.query(`select 1 from pg_views where schemaname = 'public' and viewname = $1`, [t]);
    if (v.length) await db.query(`grant select on public.${pg.escapeIdentifier(t)} to authenticated`);
  }
  // functions the site calls (they check who's asking themselves)
  for (const f of uses.fns) {
    const { rows: fr } = await db.query(
      `select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`, [f]);
    for (const x of fr) await db.query(`grant execute on function ${x.sig} to anon, authenticated`);
  }
  // sequences behind tables the website inserts into
  await db.query(`grant usage, select on all sequences in schema public to anon, authenticated`);
  await db.query(`notify pgrst, 'reload schema'`);
}

function report(title, problems) {
  if (!problems.length) { log(`✅ ${title}: everything the website uses is there and allowed`); return; }
  log(`⚠ ${title}: ${problems.length} problem(s)`);
  for (const p of problems) log(`   • ${p.kind} ${p.name}: ${p.problem}`);
}

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    log('SUPABASE_DB_URL isn\'t set — add it as a GitHub secret (see supabase/migrations/README.md). Skipping.');
    return;
  }
  const db = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  await db.connect();
  const uses = whatTheSiteUses();
  log(`The website uses ${uses.tables.length} tables/views and ${uses.fns.length} functions.`);

  const before = await check(db, uses);
  report('Before', before);
  let after = before;
  if (!args.has('--check') && (before.length || args.has('--apply'))) {
    log('\nFixing: running the setup scripts, then permissions from each table\'s row rules …');
    await applyMigrations(db);
    await grantsFromPolicies(db, uses);
    after = await check(db, uses);
    report('After', after);
  }
  await db.end();

  const md = [`## Database health: ${after.length ? `❌ ${after.length} problem(s) left` : '✅ all good'}`, '',
    before.length ? `Found before fixing: ${before.map(p => `\`${p.name}\` (${p.problem})`).join(', ')}` : 'Nothing was wrong.',
    ...(summary.length ? ['', ...summary.map(s => `- ${s}`)] : []),
    ...(after.length ? ['', 'Still wrong (needs a new migration file):', ...after.map(p => `- ${p.kind} \`${p.name}\`: ${p.problem}`)] : [])].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  if (after.length) process.exit(1);
}

main().catch(err => { console.error('Health check failed:', err.message); process.exit(1); });
