const test = require('node:test');
const assert = require('node:assert/strict');
const { listToolAssets } = require('../tool-inventory');

test('tool listing includes inactive assets and returns location and both barcode fields', async () => {
  const row = { id: 5, active: 0, asset_status: 'mantenimiento', module: 'CAJÓN 1', product_barcode: 'CVP123' };
  let sql;
  const pool = {
    async query(statement) {
      sql = statement;
      return [[row]];
    }
  };

  assert.deepEqual(await listToolAssets(pool), [row]);
  assert.match(sql, /LEFT JOIN products/);
  assert.match(sql, /LEFT JOIN modules/);
  assert.match(sql, /p\.active/);
  assert.match(sql, /p\.sap_code/);
  assert.match(sql, /p\.barcode product_barcode/);
  assert.doesNotMatch(sql, /WHERE\s+p\.active\s*=\s*1/i);
});
