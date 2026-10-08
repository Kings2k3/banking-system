const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const config = require('./config');

function databaseSchema() {
  const schema = process.env.DATABASE_SCHEMA || 'payvexis_app';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error('Invalid PostgreSQL schema name.');
  }
  return schema;
}

class PostgresDatabase {
  constructor() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL.');
    this.engine = 'postgres';
    this.inTransaction = false;
    this.migrationsReady = false;
    this.worker = new Worker(require.resolve('./postgres-worker.js'), {
      workerData: {
        connectionString: process.env.DATABASE_URL,
        schema: databaseSchema()
      }
    });
    this.worker.unref();
  }

  call(op, sql, values = []) {
    const { port1, port2 } = new MessageChannel();
    const signal = new Int32Array(new SharedArrayBuffer(4));
    this.worker.postMessage({ op, sql, values, signal, port: port2 }, [port2]);
    const status = Atomics.wait(signal, 0, 0, 45000);
    const response = receiveMessageOnPort(port1)?.message;
    port1.close();
    if (status === 'timed-out' || !response) {
      throw new Error('PostgreSQL request timed out or the database worker stopped.');
    }
    if (response.error) {
      const error = new Error(response.error.message);
      error.code = response.error.code;
      throw error;
    }
    return response.value;
  }

  prepare(sql) {
    return {
      get: (...values) => this.call('get', sql, values),
      all: (...values) => this.call('all', sql, values),
      run: (...values) => this.call('run', sql, values)
    };
  }

  transaction(fn) {
    const invoke = (...args) => {
      if (this.inTransaction) throw new Error('Nested PostgreSQL transactions are not supported.');
      this.call('begin');
      this.inTransaction = true;
      try {
        const result = fn(...args);
        if (result && typeof result.then === 'function') {
          throw new Error('A PostgreSQL transaction callback must be synchronous.');
        }
        this.call('commit');
        return result;
      } catch (error) {
        try { this.call('rollback'); } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
        throw error;
      } finally {
        this.inTransaction = false;
      }
    };
    invoke.immediate = invoke;
    invoke.deferred = invoke;
    invoke.exclusive = invoke;
    return invoke;
  }

  close() {
    this.worker.terminate();
  }
}

const db = new PostgresDatabase();
const initDB = () => {
  const expected = ['001_ledger', '002_admin_controls', '003_identity_ownership',
    '004_customer_identity', '005_shared_accounts', '006_admin_workspace'];
  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all().map(row => row.version);
  if (JSON.stringify(versions) !== JSON.stringify(expected)) {
    throw new Error('PostgreSQL schema migrations 001-006 are required.');
  }
  db.migrationsReady = true;
  if (config.ADMIN_PASSWORD) {
    const bcrypt = require('bcrypt');
    const passwordHash = bcrypt.hashSync(config.ADMIN_PASSWORD, 12);
    db.transaction(() => {
      if (db.prepare("SELECT id FROM users WHERE role = 'admin'").get()) return;
      const result = db.prepare(`INSERT INTO users
        (email, password_hash, first_name, last_name, account_number, role)
        VALUES (?, ?, 'System', 'Admin', '0000000000', 'admin')`)
        .run(config.ADMIN_EMAIL, passwordHash);
      db.prepare("INSERT INTO staff_memberships (user_id, staff_role) VALUES (?, 'owner')")
        .run(result.lastInsertRowid);
    })();
  }
};

module.exports = { db, initDB };
