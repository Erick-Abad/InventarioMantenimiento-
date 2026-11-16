const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { listActiveLoginUsers, identifyLoginUser, authenticateLogin } = require('../login-auth');

async function createPool() {
  const hash = await bcrypt.hash('Clave-segura-123', 4);
  const users = [
    { id: 1, full_name: 'Erick Abad Monserrate', employee_barcode: '0987654321', password_hash: hash, role: 'administrador', active: 1 },
    { id: 2, full_name: 'Ana Colaboradora', employee_barcode: 'COL-0001', password_hash: hash, role: 'colaborador', active: 1 },
    { id: 3, full_name: 'Usuario Inactivo', employee_barcode: 'COL-0002', password_hash: hash, role: 'colaborador', active: 0 }
  ];

  return {
    users,
    pool: {
      async query(sql, params = []) {
        if (sql.startsWith('SELECT id,full_name FROM users')) {
          return [users.filter(user => user.active).map(({ id, full_name }) => ({ id, full_name }))
            .sort((a, b) => a.full_name.localeCompare(b.full_name))];
        }
        if (sql.startsWith('SELECT id,full_name,active FROM users')) {
          const user = users.find(row => row.employee_barcode === params[0]);
          return [user ? [{ id: user.id, full_name: user.full_name, active: user.active }] : []];
        }
        if (sql.includes('WHERE id=?')) return [users.filter(user => user.id === params[0])];
        if (sql.includes('WHERE employee_barcode=?')) return [users.filter(user => user.employee_barcode === params[0])];
        throw new Error(`Unexpected query: ${sql}`);
      }
    }
  };
}

test('active login list contains names and IDs only, in alphabetical order', async () => {
  const { pool } = await createPool();
  const users = await listActiveLoginUsers(pool);

  assert.deepEqual(users.map(user => user.full_name), ['Ana Colaboradora', 'Erick Abad Monserrate']);
  assert.equal(users.some(user => 'employee_barcode' in user || 'password_hash' in user), false);
});

test('barcode identification returns the active user name without authenticating', async () => {
  const { pool } = await createPool();
  const user = await identifyLoginUser(pool, 'COL-0001');

  assert.deepEqual(user, { id: 2, name: 'Ana Colaboradora' });
});

test('login authenticates selected users or barcode users with bcrypt', async () => {
  const { pool } = await createPool();

  assert.deepEqual(
    await authenticateLogin(pool, { user_id: 1, password: 'Clave-segura-123' }),
    { id: 1, name: 'Erick Abad Monserrate', role: 'administrador' }
  );
  assert.deepEqual(
    await authenticateLogin(pool, { barcode: 'COL-0001', password: 'Clave-segura-123' }),
    { id: 2, name: 'Ana Colaboradora', role: 'colaborador' }
  );
});

test('unknown, inactive, and wrong-password cases return clear errors without user secrets', async () => {
  const { pool } = await createPool();

  await assert.rejects(() => identifyLoginUser(pool, 'UNKNOWN'), { status: 404 });
  await assert.rejects(() => identifyLoginUser(pool, 'COL-0002'), { status: 403 });
  await assert.rejects(
    () => authenticateLogin(pool, { barcode: 'UNKNOWN', password: 'anything' }),
    { status: 404 }
  );
  await assert.rejects(
    () => authenticateLogin(pool, { barcode: 'COL-0002', password: 'Clave-segura-123' }),
    { status: 403 }
  );
  await assert.rejects(
    () => authenticateLogin(pool, { barcode: 'COL-0001', password: 'incorrecta' }),
    { status: 401 }
  );
});

test('login rejects malformed and ambiguous identifiers', async () => {
  const { pool } = await createPool();

  await assert.rejects(() => authenticateLogin(pool, null), { status: 400 });
  await assert.rejects(
    () => authenticateLogin(pool, { user_id: 1, barcode: '0987654321', password: 'Clave-segura-123' }),
    { status: 400 }
  );
  await assert.rejects(
    () => authenticateLogin(pool, { password: 'Clave-segura-123' }),
    { status: 400 }
  );
});
