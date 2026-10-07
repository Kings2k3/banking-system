const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { Client } = require('pg');
const config = require('../server/config');
const { db, initDB } = require('../server/database');
const { adminWorkspaceReady } = require('../server/migrations/006_admin_workspace');
const { safeName, tablesInDependencyOrder, postgresTableSql,
  primaryKeyColumns, columns, normalizePgRow, sourceRows } = require('./postgres-import-lib');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL staging.');
  initDB();
  if (!adminWorkspaceReady(db)) throw new Error('Apply SQLite migrations through 006_admin_workspace first.');
  const schema = process.env.PG_STAGE_SCHEMA || `payvexis_stage_${Date.now()}`;
  safeName(schema);
  const folder = path.join(path.dirname(path.resolve(config.DB_PATH)), 'backups');
  fs.mkdirSync(folder, { recursive: true });
  const snapshot = path.join(folder, `postgres-source-${Date.now()}-${randomUUID()}.db`);
  await db.backup(snapshot);
  const source = new Database(snapshot, { readonly: true });
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  let connected = false;
  try {
    const tables = tablesInDependencyOrder(source);
    if (source.pragma('foreign_key_check').length) throw new Error('SQLite snapshot has foreign key violations.');
    await client.connect(); connected = true;
    await client.query('BEGIN');
    try {
      await client.query(`CREATE SCHEMA ${safeName(schema)}`);
      await client.query(`SET LOCAL search_path TO ${safeName(schema)}, public`);
      for (const table of tables) {
        await client.query(postgresTableSql(table.name, table.sql));
      }
      for (const table of tables) {
        const info = columns(source, table.name);
        const names = info.map(column => column.name);
        const sql = `INSERT INTO ${safeName(table.name)} (${names.map(safeName).join(', ')})
          VALUES (${names.map((_, index) => `$${index + 1}`).join(', ')})`;
        for (const row of sourceRows(source, table.name)) {
          await client.query(sql, names.map(name => row[name]));
        }
        const identity = info.find(column => new RegExp(
          `\\b${column.name}\\s+INTEGER\\s+PRIMARY\\s+KEY\\s+AUTOINCREMENT\\b`, 'i')
          .test(table.sql));
        if (identity) {
          const sequence = await client.query('SELECT pg_get_serial_sequence($1, $2) AS name',
            [`${schema}.${table.name}`, identity.name]);
          const max = source.prepare(`SELECT MAX(${safeName(identity.name)}) AS value FROM ${safeName(table.name)}`).get().value;
          if (sequence.rows[0]?.name) {
            await client.query('SELECT setval($1, $2, $3)',
              [sequence.rows[0].name, max || 1, !!max]);
          }
        }
      }
      const indexes = source.prepare(`SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`).all();
      for (const index of indexes) {
        safeName(index.name);
        await client.query(index.sql);
      }
      await client.query(`CREATE FUNCTION prevent_financial_rewrite() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'Posted financial history is immutable'; END;
        $$ LANGUAGE plpgsql`);
      for (const table of ['ledger_postings', 'ledger_journals']) {
        await client.query(`CREATE TRIGGER ${safeName(`${table}_immutable`)}
          BEFORE UPDATE OR DELETE ON ${safeName(table)} FOR EACH ROW
          EXECUTE FUNCTION prevent_financial_rewrite()`);
      }
      await client.query(`CREATE FUNCTION prevent_adjustment_rewrite() RETURNS trigger AS $$
        BEGIN
          IF ROW(NEW.user_id, NEW.direction, NEW.amount_minor, NEW.reason, NEW.sender_name,
             NEW.proposed_by, NEW.idempotency_key, NEW.request_hash)
             IS DISTINCT FROM
             ROW(OLD.user_id, OLD.direction, OLD.amount_minor, OLD.reason, OLD.sender_name,
             OLD.proposed_by, OLD.idempotency_key, OLD.request_hash) THEN
            RAISE EXCEPTION 'Adjustment proposal is immutable';
          END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql`);
      await client.query(`CREATE TRIGGER adjustment_proposal_immutable BEFORE UPDATE ON adjustment_requests
        FOR EACH ROW EXECUTE FUNCTION prevent_adjustment_rewrite()`);

      for (const table of tables) {
        const info = columns(source, table.name);
        const pk = primaryKeyColumns(source, table.name);
        const pgRows = await client.query(`SELECT * FROM ${safeName(table.name)}
          ORDER BY ${pk.map(safeName).join(', ')}`);
        const expected = sourceRows(source, table.name);
        if (pgRows.rows.length !== expected.length) throw new Error(`Row count mismatch: ${table.name}`);
        for (let index = 0; index < expected.length; index++) {
          const normalized = normalizePgRow(pgRows.rows[index], info);
          if (JSON.stringify(normalized) !== JSON.stringify(expected[index])) {
            throw new Error(`Row mismatch: ${table.name} at row ${index + 1}`);
          }
        }
      }
      const projections = await client.query(`SELECT COUNT(*)::int AS n FROM ledger_accounts a
        WHERE a.balance_minor <> COALESCE((SELECT SUM(p.amount_minor)
          FROM ledger_postings p WHERE p.account_id = a.id), 0)`);
      const journals = await client.query(`SELECT COUNT(*)::int AS n FROM (
        SELECT j.id FROM ledger_journals j LEFT JOIN ledger_postings p ON p.journal_id = j.id
        GROUP BY j.id HAVING COUNT(p.id) < 2 OR COALESCE(SUM(p.amount_minor), 0) <> 0) bad`);
      const ownership = await client.query(`SELECT COUNT(*)::int AS n FROM ledger_accounts l
        WHERE l.kind = 'customer' AND NOT EXISTS (
          SELECT 1 FROM customer_accounts a JOIN account_memberships m ON m.account_id = a.id
          WHERE a.ledger_account_id = l.id AND m.user_id = l.user_id
            AND m.member_role = 'owner' AND m.status = 'active')`);
      if (projections.rows[0].n || journals.rows[0].n || ownership.rows[0].n) {
        throw new Error('PostgreSQL financial or ownership reconciliation failed.');
      }
      await client.query('COMMIT');
      console.log(`PostgreSQL staging import verified: ${schema}; ${tables.length} tables.`);
      console.log(`SQLite snapshot retained: ${snapshot}`);
      console.log('The application still uses SQLite; PostgreSQL runtime cutover is not enabled.');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    source.close(); db.close();
    if (connected) await client.end();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
