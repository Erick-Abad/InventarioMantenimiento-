const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { pool } = require('../storage');

async function migrate() {
  const directory=path.join(__dirname,'../migrations');
  for(const file of readdirSync(directory).filter(name=>name.endsWith('.sql')).sort()){
    const script=readFileSync(path.join(directory,file),'utf8');
    for (const statement of script.split(';').map(sql => sql.trim()).filter(Boolean)) {
      await pool.query(statement);
    }
  }
  console.log('Migración del Taller aplicada.');
}

migrate().catch(error => {
  console.error('Migración interrumpida:', error.code || error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
