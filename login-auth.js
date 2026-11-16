const bcrypt = require('bcryptjs');

function authError(message, status) {
  return Object.assign(new Error(message), { status });
}

async function listActiveLoginUsers(pool) {
  const [rows] = await pool.query(
    'SELECT id,full_name FROM users WHERE active=1 ORDER BY full_name'
  );
  return rows;
}

async function identifyLoginUser(pool, barcode) {
  if (typeof barcode !== 'string' || !barcode.trim() || barcode.length > 70) {
    throw authError('Ingresa un código de colaborador válido.', 400);
  }

  const [rows] = await pool.query(
    'SELECT id,full_name,active FROM users WHERE employee_barcode=? LIMIT 1',
    [barcode.trim()]
  );
  if (!rows.length) throw authError('No existe un usuario con ese código.', 404);
  if (!Number(rows[0].active)) throw authError('La cuenta está inactiva. Contacta al administrador.', 403);
  return { id: rows[0].id, name: rows[0].full_name };
}

async function authenticateLogin(pool, credentials = {}) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw authError('Datos de inicio de sesión inválidos.', 400);
  }
  const userId = credentials.user_id ?? credentials.userId;
  const { barcode, password } = credentials;
  if (typeof password !== 'string' || !password || password.length > 256) {
    throw authError('Ingresa tu contraseña.', 400);
  }

  const hasUserId = userId !== undefined && userId !== null && userId !== '';
  const hasBarcode = barcode !== undefined && barcode !== null && barcode !== '';
  if (hasUserId === hasBarcode) {
    throw authError('Selecciona un usuario o ingresa un código.', 400);
  }

  let where;
  let value;
  if (hasUserId) {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw authError('El usuario seleccionado no es válido.', 400);
    }
    where = 'id=?';
    value = id;
  } else {
    if (typeof barcode !== 'string' || !barcode.trim() || barcode.length > 70) {
      throw authError('Ingresa un código de colaborador válido.', 400);
    }
    where = 'employee_barcode=?';
    value = barcode.trim();
  }

  const [rows] = await pool.query(
    `SELECT id,full_name,password_hash,role,active FROM users WHERE ${where} LIMIT 1`,
    [value]
  );
  if (!rows.length) {
    throw authError(hasUserId
      ? 'El usuario seleccionado no existe.'
      : 'No existe un usuario con ese código.', 404);
  }

  const user = rows[0];
  if (!Number(user.active)) throw authError('La cuenta está inactiva. Contacta al administrador.', 403);
  if (!await bcrypt.compare(password, user.password_hash)) {
    throw authError('La contraseña es incorrecta.', 401);
  }

  return { id: user.id, name: user.full_name, role: user.role };
}

module.exports = { listActiveLoginUsers, identifyLoginUser, authenticateLogin };
