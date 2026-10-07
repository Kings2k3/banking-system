# PostgreSQL staging import

The running application still uses SQLite. `npm run migrate:postgres` copies a consistent
SQLite backup into a **new PostgreSQL schema** and reconciles every imported row. It does
not switch the application to PostgreSQL or enable live payments.

## Prerequisites

1. Apply SQLite migrations 001 through 006 in order. Keep the resulting SQLite backups.
2. Provision a PostgreSQL database and a dedicated user permitted to create a schema,
   tables, indexes, functions, and triggers there. Use an encrypted connection appropriate
   for the deployment.
3. Set `DATABASE_URL` in the local environment or `.env`. Optionally set a unique
   `PG_STAGE_SCHEMA`; otherwise the script creates a timestamped schema.
4. Ensure the target schema name does not already exist. Keep other users and applications
   out of the staging schema.

Run `npm run migrate:postgres`. The script creates another SQLite backup, imports all
application tables in foreign-key order in one PostgreSQL transaction, rebuilds indexes
and financial-history triggers, and compares each row in primary-key order. It checks
foreign keys in the source, balances against postings, balanced journals, and primary
owner memberships. On any failure, the PostgreSQL transaction rolls back. The SQLite
backup is retained under `server/backups/` for review and recovery.

**This is a rehearsal and data reconciliation, not a cutover.** Before a real cutover,
the synchronous SQLite data access in `server/database.js`, routes, and services needs a
PostgreSQL transaction-aware implementation. Run all API and authorization tests against
that implementation, re-import after a write freeze or change-data-capture process,
repeat reconciliation, test restore and rollback, then switch traffic. Do not enable
live payment or card integrations until that cutover and their own reconciliation are
complete.

The import SQL is exercised against an in-memory PostgreSQL engine in
`test/postgres-import.test.js`. A provisioned PostgreSQL server is required to validate
the `pg` client connection and perform an actual staged import.
