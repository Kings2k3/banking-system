# PostgreSQL runtime and Vercel deployment

The Express API now selects PostgreSQL when `DB_ENGINE=postgres` or when it runs on Vercel. Local development and the existing test suite continue to use SQLite unless PostgreSQL is selected. PostgreSQL contains six migrations in a named schema; the runtime checks their exact versions before serving requests.

## Current environment

- The Vercel project has a Neon PostgreSQL connection in its Production environment. The application schema is `payvexis_app` in the London database region.
- `payvexis_test` is an isolated smoke-test schema. Its sample accounts and staff records are disposable. Do not point the live application at it.
- The project uses the Express framework preset, so the Vercel build produces an API function as well as the allowlisted files in `public/`.
- The production schema is separate from the developer's SQLite database. No local customer history was imported.

## Local PostgreSQL run

Create an ignored `.env` file with `DATABASE_URL`, `JWT_SECRET`, and a separate 64-character hex `STAFF_MFA_KEY`. Set `DB_ENGINE=postgres` and `DATABASE_SCHEMA=payvexis_app`. Use a known HTTPS `APP_BASE_URL` and configured email transport for production. Start with `npm start`; the normal SQLite start remains available by leaving `DB_ENGINE` unset.

`npm run bootstrap:postgres -- path/to/ignored-env-file` creates a **fresh** schema named by `PG_STAGE_SCHEMA` (default `payvexis_app`). It refuses to replace an existing schema. `npm run check:postgres -- path/to/ignored-env-file payvexis_app` reports table, user, and migration counts. `npm run migrate:postgres` is the separate legacy-data import path; use it only when an import is intended.

The PostgreSQL adapter runs the current synchronous repository calls through one database worker per Node process. Explicit transactions use a PostgreSQL advisory lock so the existing ledger code keeps serialized writes across function instances. This is a compatibility step for the current application, not the final high-throughput repository architecture described in [system-design.md](system-design.md).

## Verification and launch needs

- `npm test` checks the SQLite behavior.
- `node scripts/smoke-postgres-runtime.js path/to/ignored-env-file payvexis_test` checks PostgreSQL query translation, rollback, customer registration and email verification, staff MFA, admin workspaces, and joint invitations. It creates test data only in the named test schema.
- `npm run vercel-build` creates the allowlisted public assets. `vercel build --prod` should produce `.vercel/output/functions/index.func` containing `server/postgres-worker.js`.
- Production still needs an HTTPS `APP_BASE_URL`, a verified sending domain and SMTP/Resend settings (`MAIL_FROM` plus credentials), and a reviewed owner staff account. The current production config intentionally refuses to start without working email settings. Do not publish a live customer signup that cannot deliver verification and recovery links.
- Demo internal transfers and admin balance adjustments remain disabled when `NODE_ENV=production`.

Keep database URLs and authentication keys in Vercel environment variables or ignored local files. Never commit them or include local `.env` files in a deployment artifact.
