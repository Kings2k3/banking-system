const { parentPort, workerData } = require('node:worker_threads');
const { Client, types } = require('pg');

if (!/^[a-z][a-z0-9_]*$/.test(workerData.schema)) throw new Error('Invalid PostgreSQL schema.');
const quotedSchema = `"${workerData.schema}"`;
for (const oid of [types.builtins.INT8, types.builtins.NUMERIC]) {
  types.setTypeParser(oid, value => {
    const number = Number(value);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) {
      throw new Error('PostgreSQL number exceeds JavaScript precision.');
    }
    return number;
  });
}

let client;
let connected = false;
let inTransaction = false;

async function ensureClient() {
  if (connected) return client;
  client = new Client({ connectionString: workerData.connectionString,
    connectionTimeoutMillis: 25000, query_timeout: 30000 });
  await client.connect();
  connected = true;
  client.on('error', () => { connected = false; });
  return client;
}

function translate(sql) {
  const aliases = new Map();
  const original = sql;
  for (const match of original.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    aliases.set(match[1].toLowerCase(), match[1]);
  }
  let index = 0;
  sql = sql.replace(/\?/g, () => `$${++index}`);
  sql = sql.replace(/datetime\('now',\s*'-1 day'\)/gi,
    "to_char(timezone('UTC', now()) - interval '1 day', 'YYYY-MM-DD HH24:MI:SS')");
  sql = sql.replace(/datetime\('now'\)/gi,
    "to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')");
  sql = sql.replace(/strftime\('%s',\s*'now'\)/gi, 'EXTRACT(EPOCH FROM now())');
  sql = sql.replace(/strftime\('%s',\s*([A-Za-z_][A-Za-z0-9_.]*)\)/gi,
    (_, column) => `EXTRACT(EPOCH FROM ${column}::timestamp)`);
  return { sql, aliases };
}

function mapRows(rows, aliases) {
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [aliases.get(key) || key, value])));
}

async function query(sql, values, op) {
  const database = await ensureClient();
  const translated = translate(sql);
  let statement = translated.sql.trim().replace(/;$/, '');
  if (op === 'run' && /^INSERT\s+INTO\b/i.test(statement) && !/\bRETURNING\b/i.test(statement)) {
    statement += ' RETURNING *';
  }
  const execute = async () => database.query(statement, values);
  let result;
  if (inTransaction) {
    result = await execute();
  } else {
    await database.query('BEGIN');
    try {
      await database.query(`SET LOCAL search_path TO ${quotedSchema}, public`);
      result = await execute();
      await database.query('COMMIT');
    } catch (error) {
      await database.query('ROLLBACK');
      throw error;
    }
  }
  const rows = mapRows(result.rows, translated.aliases);
  if (op === 'get') return rows[0];
  if (op === 'all') return rows;
  return { changes: result.rowCount, lastInsertRowid: rows[0]?.id };
}

async function handle(message) {
  const database = await ensureClient();
  if (message.op === 'begin') {
    if (inTransaction) throw new Error('Transaction already open.');
    await database.query('BEGIN');
    try {
      await database.query(`SET LOCAL search_path TO ${quotedSchema}, public`);
      await database.query('SELECT pg_advisory_xact_lock(742936187::bigint)');
      inTransaction = true;
    } catch (error) {
      await database.query('ROLLBACK');
      throw error;
    }
    return null;
  }
  if (message.op === 'commit' || message.op === 'rollback') {
    if (!inTransaction) throw new Error('No transaction is open.');
    try { await database.query(message.op.toUpperCase()); }
    finally { inTransaction = false; }
    return null;
  }
  return query(message.sql, message.values, message.op);
}

parentPort.on('message', async message => {
  try {
    const value = await handle(message);
    message.port.postMessage({ value });
  } catch (error) {
    message.port.postMessage({ error: { message: error.message, code: error.code } });
  } finally {
    message.port.close();
    Atomics.store(message.signal, 0, 1);
    Atomics.notify(message.signal, 0);
  }
});
