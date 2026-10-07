const dotenv = require('dotenv');
const { Client } = require('pg');
const { safeName } = require('./postgres-import-lib');

dotenv.config({ path: process.argv[2] || '.env', quiet: true });
const schema = process.argv[3] || 'public';
const quotedSchema = safeName(schema);

async function main() {
  if (!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL || '')) {
    throw new Error('DATABASE_URL is missing or invalid');
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 12000
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const result = await client.query(`SELECT COUNT(*)::int AS count
      FROM information_schema.tables WHERE table_schema = $1`, [schema]);
    console.log(`PostgreSQL connection OK; ${schema} tables: ${result.rows[0].count}`);
    if (result.rows[0].count) {
      const users = await client.query(`SELECT COUNT(*)::int AS count FROM ${quotedSchema}.users`);
      const migrations = await client.query(`SELECT COUNT(*)::int AS count
        FROM ${quotedSchema}.schema_migrations`);
      console.log(`Users: ${users.rows[0].count}; schema migrations: ${migrations.rows[0].count}`);
    }
  } finally {
    if (connected) await client.end();
  }
}

main().catch(error => {
  console.error(`PostgreSQL connection failed: ${error.code || error.name}`);
  process.exitCode = 1;
});
