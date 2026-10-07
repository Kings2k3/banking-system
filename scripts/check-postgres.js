const dotenv = require('dotenv');
const { Client } = require('pg');

dotenv.config({ path: process.argv[2] || '.env', quiet: true });

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
      FROM information_schema.tables WHERE table_schema = 'public'`);
    console.log(`PostgreSQL connection OK; public tables: ${result.rows[0].count}`);
  } finally {
    if (connected) await client.end();
  }
}

main().catch(error => {
  console.error(`PostgreSQL connection failed: ${error.code || error.name}`);
  process.exitCode = 1;
});
