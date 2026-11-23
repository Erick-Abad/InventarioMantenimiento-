const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pool } = require('../storage');

async function migrate() {
  const script = readFileSync(path.join(__dirname, '../migrations/001_workshop.sql'), 'utf8');
  for (const statement of script.split(';').map(sql => sql.trim()).filter(Boolean)) {
    await pool.query(statement);
  }
  console.log('Migración del Taller aplicada.');
}

migrate().catch(error => {
  console.error('Migración interrumpida:', error.code || error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
