const test = require('node:test');
const assert = require('node:assert/strict');
const { filterToolAssets, loanBlockReason, workshopToolReferences } = require('../public/tool-availability');

test('only active tools in available state can be loaned', () => {
  assert.equal(loanBlockReason({ kind: 'herramienta', active: 1, asset_status: 'disponible' }), null);
});

test('the workshop loan catalog can show and filter imported references without treating them as individual assets', () => {
  const products = [
    { id: 1, barcode: 'CTH000001', kind: 'pendiente', active: 0, location: 'Casillero con llave' },
    { id: 2, barcode: 'CTH000002', kind: 'herramienta', active: 1, location: 'Casillero con llave' },
    { id: 3, barcode: 'CTH000003', kind: 'consumible', active: 1, location: 'Casillero con llave' },
    { id: 4, barcode: 'CTH000004', kind: 'herramienta', active: 1, location: 'Herramientas generales' }
  ];
  const assets = [{ product_id: 2, asset_barcode: 'TALLER-002', kind: 'herramienta', active: 1, asset_status: 'disponible' }];
  const references = workshopToolReferences(products, assets);
  assert.deepEqual(references.map(row => row.id), [1, 4]);
  assert.deepEqual(filterToolAssets(references, { query: 'cth000001', location: 'Casillero con llave', status: 'validacion' }), [references[0]]);
  assert.deepEqual(filterToolAssets(references, { location: 'Herramientas generales' }), [references[1]]);
  assert.deepEqual(filterToolAssets([...assets, ...references], { status: 'disponible' }), assets);
  assert.ok(references.every(reference => !reference.asset_barcode && loanBlockReason(reference)));
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
