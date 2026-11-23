const test = require('node:test');
const assert = require('node:assert/strict');
const { searchProducts } = require('../product-search');

test('search returns database matches and prioritizes exact barcode matches', async () => {
  const match = { id: 8, barcode: 'CVP000010', stock_units: null };
  let call;
  const pool = {
    async query(sql, params) {
      call = { sql, params };
      return [[match]];
    }
  };

  const result = await searchProducts(pool, ' CVP000010 ');

  assert.deepEqual(result, [match]);
  assert.match(call.sql, /ORDER BY CASE WHEN p\.barcode=\? THEN 0/);
  assert.match(call.sql, /LIMIT 20/);
  assert.deepEqual(call.params, [
    'CVP000010', 'CVP000010', '%CVP000010%', '%CVP000010%', '%CVP000010%',
    'CVP000010', 'CVP000010'
  ]);
});

test('search escapes SQL LIKE wildcards and parameterizes the term', async () => {
  let call;
  const pool = {
    async query(sql, params) {
      call = { sql, params };
      return [[]];
    }
  };

  await searchProducts(pool, 'O-ring 10%_!');

  assert.equal(call.params[2], '%O-ring 10!%!_!!%');
  assert.doesNotMatch(call.sql, /O-ring 10%_/);
});

test('empty search does not query the database and oversized input is rejected', async () => {
  let queried = false;
  const pool = { async query() { queried = true; return [[]]; } };

  assert.deepEqual(await searchProducts(pool, '  '), []);
  await assert.rejects(() => searchProducts(pool, 'x'.repeat(101)), RangeError);
  assert.equal(queried, false);
});

test('a scanned Taller code uses exact barcode lookup within the selected area', async () => {
  const pool = { async query(sql, args) {
    assert.match(sql, /WHERE p\.module_id=11 AND \(p\.barcode=\?\)/);
    assert.deepEqual(args, ['CTH000379']);
    return [[]];
  } };
  assert.deepEqual(await searchProducts(pool, ' cth000379 ', 'taller'), []);
  await assert.rejects(() => searchProducts(pool, 'CTH000379', 'invalid'), /Área de inventario inválida/);
});
