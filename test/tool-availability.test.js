const test = require('node:test');
const assert = require('node:assert/strict');
const { filterToolAssets, loanBlockReason } = require('../public/tool-availability');

test('only active tools in available state can be loaned', () => {
  assert.equal(loanBlockReason({ kind: 'herramienta', active: 1, asset_status: 'disponible' }), null);
});

test('inactive assets remain blocked for physical validation even if their stored state is available', () => {
  assert.match(
    loanBlockReason({ kind: 'herramienta', active: 0, asset_status: 'disponible' }),
    /Pendiente de validación/
  );
});

test('maintenance, loaned, retired, and non-tool assets cannot be loaned', () => {
  for (const status of ['mantenimiento', 'prestada', 'baja']) {
    assert.ok(loanBlockReason({ kind: 'herramienta', active: 1, asset_status: status }));
  }
  assert.ok(loanBlockReason({ kind: 'consumible', active: 1, asset_status: 'disponible' }));
});

test('tool filters combine barcode, location, and pending-validation state', () => {
  const assets = [
    { asset_barcode: 'A-1', name: 'Juego de llaves', module: 'Cajón 1', module_id: 9, active: 0, asset_status: 'mantenimiento' },
    { asset_barcode: 'B-1', name: 'Juego de dados', module: 'Cajón 2', module_id: 10, active: 0, asset_status: 'mantenimiento' },
    { asset_barcode: 'A-2', name: 'Pinza', module: 'Cajón 1', module_id: 9, active: 1, asset_status: 'disponible' }
  ];

  assert.deepEqual(
    filterToolAssets(assets, { query: 'A-', moduleId: '9', status: 'validacion' }),
    [assets[0]]
  );
  assert.deepEqual(
    filterToolAssets(assets, { query: 'dados', moduleId: '10' }),
    [assets[1]]
  );
});
