const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminMovement } = require('../admin-movement');

const requestId = 'c0a80123-4567-489a-8abc-0123456789ab';

function createPool({ kind = 'consumible', stock = 150, duplicateRequest = false, active = 1, moduleId = 1, counted = true, alertFails = false } = {}) {
  const state = { stock, events: [], inserts: [], committed: false, released: false };
  let stockAtTransactionStart = stock;
  const connection = {
    async beginTransaction() { stockAtTransactionStart = state.stock; state.events.push('begin'); },
    async query(sql, params) {
      state.events.push(sql.trim().split(/\s+/)[0].toLowerCase());
      if (sql.includes('SELECT p.kind,i.stock_units')) return [[{ kind, stock_units: state.stock, active, module_id: moduleId, last_counted_at: counted ? new Date() : null }]];
      if (sql.includes('SELECT role,active FROM users')) return [[{ active: 1, role: 'administrador' }]];
      if (sql.startsWith('UPDATE inventory')) state.stock = params[0];
      if (sql.startsWith('INSERT INTO movements')) {
        if (duplicateRequest) throw Object.assign(new Error('Duplicate request'), { code: 'ER_DUP_ENTRY' });
        state.inserts.push({ table: 'movements', params });
        return [{ insertId:25 }];
      }
      if (sql.startsWith('INSERT INTO audit_logs')) {
        if (alertFails && params[1]==='entrada_colaborador') throw Error('No se pudo guardar la alerta');
        state.inserts.push({ table: 'audit_logs', params });
      }
      return [{ affectedRows: 1 }];
    },
    async commit() { state.committed = true; state.events.push('commit'); },
    async rollback() { state.stock = stockAtTransactionStart; state.events.push('rollback'); },
    release() { state.released = true; }
  };
  return { state, pool: { async getConnection() { return connection; } } };
}

const movement = overrides => ({
  productId: 12,
  userId: 4,
  quantity: 85,
  type: 'entrada',
  reason: 'Conteo y reposición confirmados',
  requestId,
  ...overrides
});

test('a collaborator entry stores one linked alert in the stock transaction', async () => {
  const {pool,state}=createPool({stock:3});
  const user={id:4,role:'colaborador'};
  const data=movement({user,adminMovement:false,quantity:2,reason:''});
  assert.deepEqual(await registerAdminMovement(pool,data),{before:3,after:5});
  const [saved,alert]=state.inserts;
  assert.equal(saved.params[2],null);
  assert.deepEqual(alert.params.slice(0,4),[4,'entrada_colaborador','movements',25]);
  assert.deepEqual(JSON.parse(alert.params[4]),{product_id:12,quantity:2,after:5});

  const consume=createPool({stock:5});
  await registerAdminMovement(consume.pool,{...data,type:'consumo'});
  assert.equal(consume.state.inserts.length,1);

  const failed=createPool({stock:3,alertFails:true});
  await assert.rejects(()=>registerAdminMovement(failed.pool,data),/guardar la alerta/);
  assert.equal(failed.state.stock,3);
  assert.equal(failed.state.committed,false);
});

test('admin can record a justified entry for an inactive product without activating it', async () => {
  const { pool, state } = createPool({ stock: 150, active: 0 });
  const result = await registerAdminMovement(pool, movement({}));

  assert.deepEqual(result, { before: 150, after: 235 });
  assert.equal(state.stock, 235);
  assert.equal(state.committed, true);
  assert.equal(state.released, true);
  assert.deepEqual(state.inserts.map(row => row.table), ['movements', 'audit_logs']);
  assert.equal(state.events.includes('update products'), false);
  assert.deepEqual(state.inserts[0].params.slice(0, 8), [
    12, 4, 4, 'entrada', 85, 150, 235, 'Conteo y reposición confirmados'
  ]);
});

test('a follow-up admin consumption updates the balance and is separately audited', async () => {
  let stock = 235;
  const entries = [];
  const pool = {
    async getConnection() {
      const { connection } = createPersistentConnection(entries, () => stock, value => { stock = value; });
      return connection;
    }
  };

  const result = await registerAdminMovement(pool, movement({
    quantity: 10,
    type: 'consumo',
    reason: 'Retiro físico confirmado'
  }));

  assert.deepEqual(result, { before: 235, after: 225 });
  assert.equal(stock, 225);
  assert.equal(entries.filter(entry => entry.table === 'movements').length, 1);
  assert.equal(entries[0].params[3], 'consumo');
});

function createPersistentConnection(inserts, getStock, setStock) {
  const connection = {
    async beginTransaction() {},
    async query(sql, params) {
      if (sql.includes('SELECT p.kind,i.stock_units')) return [[{ kind: 'consumible', stock_units: getStock(), active: 1 }]];
      if (sql.startsWith('UPDATE inventory')) setStock(params[0]);
      if (sql.startsWith('INSERT INTO movements')) inserts.push({ table: 'movements', params });
      if (sql.startsWith('INSERT INTO audit_logs')) inserts.push({ table: 'audit_logs', params });
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() {},
    release() {}
  };
  return { connection };
}

test('unknown stock remains NULL and no movement writes occur', async () => {
  const { pool, state } = createPool({ stock: null });
  await assert.rejects(
    () => registerAdminMovement(pool, movement({})),
    /conteo es desconocido/
  );
  assert.equal(state.stock, null);
  assert.deepEqual(state.inserts, []);
  assert.equal(state.events.includes('rollback'), true);
  assert.equal(state.committed, false);
});

test('an administrator cannot withdraw inactive stock', async () => {
  const { pool, state } = createPool({ active: 0 });
  await assert.rejects(() => registerAdminMovement(pool, movement({ type: 'consumo' })), /producto está inactivo/);
  assert.equal(state.stock, 150);
  assert.deepEqual(state.inserts, []);
});

test('Taller verifies the worker and physical count even when area is missing from a request', async () => {
  const user = { id: 4, role: 'administrador', credentialVerified: true };
  const { pool, state } = createPool({ moduleId: 11, counted: false });
  await assert.rejects(() => registerAdminMovement(pool, movement({})), /credencial/);
  await assert.rejects(() => registerAdminMovement(pool, movement({ area: 'valvulas', user })), /otra área/);
  await assert.rejects(() => registerAdminMovement(pool, movement({ user })), /pendiente de verificación/);
  assert.equal(state.stock, 150);
  assert.deepEqual(state.inserts, []);
});

test('a verified Taller worker can record a stock movement with observations', async () => {
  const { pool, state } = createPool({ moduleId: 11 });
  const user = { id: 4, role: 'administrador', credentialVerified: true };
  const result = await registerAdminMovement(pool, movement({ user, area: 'taller', adminMovement: false, type: 'consumo' }));
  assert.deepEqual(result, { before: 150, after: 65 });
  assert.deepEqual(state.inserts[0].params.slice(0, 8), [12, 4, null, 'consumo', 85, 150, 65, 'Conteo y reposición confirmados']);
});

test('consumption cannot create a negative stock balance', async () => {
  const { pool, state } = createPool({ stock: 9 });
  await assert.rejects(
    () => registerAdminMovement(pool, movement({ quantity: 10, type: 'consumo' })),
    /excede el stock disponible/
  );
  assert.equal(state.stock, 9);
  assert.deepEqual(state.inserts, []);
  assert.equal(state.committed, false);
});

test('admin movement rejects tools, missing reasons, invalid types, and malformed request IDs before writing', async () => {
  const { pool, state } = createPool({ kind: 'herramienta', stock: 1 });
  await assert.rejects(() => registerAdminMovement(pool, movement({})), /Solo se permiten/);
  await assert.rejects(() => registerAdminMovement(pool, movement({ reason: 'no' })), /motivo/);
  await assert.rejects(() => registerAdminMovement(pool, movement({ type: 'ajuste_positivo' })), /operación/);
  await assert.rejects(() => registerAdminMovement(pool, movement({ requestId: 'not-a-uuid' })), /solicitud inválidos/);
  assert.deepEqual(state.inserts, []);
});

test('a duplicate request rolls back the stock update', async () => {
  const { pool, state } = createPool({ stock: 150, duplicateRequest: true });

  await assert.rejects(
    () => registerAdminMovement(pool, movement({})),
    error => error.code === 'ER_DUP_ENTRY'
  );

  assert.equal(state.stock, 150);
  assert.equal(state.committed, false);
  assert.equal(state.events.includes('rollback'), true);
  assert.deepEqual(state.inserts, []);
});

test('two withdrawals sharing one locked balance cannot both spend the same units', async () => {
  let stock = 5;
  let lock = Promise.resolve();
  const pool = {
    async getConnection() {
      let unlock;
      return {
        async beginTransaction() {},
        async query(sql, params) {
          if (sql.includes('SELECT p.kind,i.stock_units')) {
            assert.match(sql, /FOR UPDATE/);
            const previous = lock;
            lock = new Promise(resolve => { unlock = resolve; });
            await previous;
            return [[{ kind:'consumible', stock_units:stock, active:1 }]];
          }
          assert.ok(unlock, 'Las escrituras deben ocurrir con el bloqueo activo.');
          if (sql.startsWith('UPDATE inventory')) stock = params[0];
          return [{ affectedRows:1 }];
        },
        async commit() { unlock(); },
        async rollback() { unlock(); },
        release() {}
      };
    }
  };
  const first = movement({ quantity:4, type:'consumo', adminMovement:false });
  const second = { ...first, userId:5, requestId:'c0a80123-4567-489a-8abc-0123456789ac' };
  const results = await Promise.allSettled([registerAdminMovement(pool,first),registerAdminMovement(pool,second)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.match(results.find(result=>result.status==='rejected').reason.message,/excede el stock disponible/);
  assert.equal(stock,1);
});
