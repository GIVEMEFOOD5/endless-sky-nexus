# Database setup scripts

Numbered `.sql` files, run in order by `build/dbHealth.mjs`. Every script is safe to run again.

The **Database health** GitHub Action (`.github/workflows/database.yml`) runs them automatically:
when these files change, every day, before every parse, and whenever the Site checks fail.
It also gives the website permission to use each table, following the table's own row rules.

To change the database: add a new numbered file here (e.g. `060_something.sql`) and push.

It needs one GitHub secret, `SUPABASE_DB_URL` — your database connection string
(Supabase → Connect → Session pooler). Keep it secret: it is never used on the website.
