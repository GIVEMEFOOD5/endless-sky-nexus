# Endless Sky Nexus

Free fan-made tools for the space game [Endless Sky](https://endless-sky.github.io/):
ship & outfit database, ship builder with auto-fit, battle simulator, galaxy map,
mission browser and save editor — for the base game and community plugins.

**Website:** https://endless-sky-nexus.ravenslittlesis.workers.dev

## What's in this repository

```
.
├── Display/                      # the website (HTML, CSS, JavaScript, images)
│   ├── HTML/                     # one page per tool
│   ├── JavaScript/               # page logic (autoFitting/ = the ship auto-fitter)
│   ├── CSS/
│   └── Images/                   # site icon and social-sharing image
├── .github/workflows/
│   └── parse-endless-sky.yml     # GitHub Action: parses the game + plugins into Supabase
├── parser.js (+ *Parser.js, *Resolver.js, pushCache.js …)  # the data parser
├── plugins.json                  # which game/plugin repositories are parsed
├── supabase/                     # database set-up scripts
├── robots.txt, sitemap.xml, _redirects   # search engines and the root redirect
└── wrangler.toml                 # Cloudflare deployment
```

## Adding a plugin

Use the Plugin Manager page on the website, or add an entry to `plugins.json`:

```json
{ "name": "my-plugin", "repository": "https://github.com/username/repository" }
```

Pushing a change to `plugins.json` runs the parser automatically.

## Updating the data

The parser runs on the 1st of every month. To run it now: **Actions → Parse Endless Sky Data → Run workflow**
(tick *full refresh* to resend everything).

## Search engines

`sitemap.xml` lists every page and `robots.txt` points to it. If the site moves to a new address,
replace `https://endless-sky-nexus.ravenslittlesis.workers.dev` in `sitemap.xml`, `robots.txt`,
`index.html` and the `<head>` of each page in `Display/HTML/`.
