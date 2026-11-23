const { TALLER_ID, invalid, requireArea, requireTallerWorker } = require('./inventory-area');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function registerAdminMovement(pool, movement) {
  const productId = Number(movement.productId);
  const userId = Number(movement.userId);
  const quantity = Number(movement.quantity);
  const type = movement.type;
  const reason = typeof movement.reason === 'string' ? movement.reason.trim() : '';
  const requestId = movement.requestId;
  const adminMovement = movement.adminMovement !== false;

  if (!Number.isSafeInteger(productId) || productId <= 0
      || !Number.isSafeInteger(userId) || userId <= 0
      || !Number.isSafeInteger(quantity) || quantity <= 0
      || !['entrada', 'consumo'].includes(type)
      || (adminMovement && reason.length < 5) || reason.length > 255
      || typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) {
    throw invalid('Producto, cantidad, operación, motivo (5-255 caracteres) o solicitud inválidos.');
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT p.kind,i.stock_units,p.active,p.module_id,i.last_counted_at
       FROM products p JOIN inventory i ON i.product_id=p.id
       WHERE p.id=? FOR UPDATE`,
      [productId]
    );
    if (!rows.length) throw invalid('Producto inexistente o sin registro de inventario.', 404);
    const product = rows[0];
    requireArea(product.module_id, movement.area);
    await requireTallerWorker(connection, product.module_id, movement.user);
    if (product.kind !== 'consumible') throw invalid('Solo se permiten movimientos de repuestos consumibles.');
    if (!product.active && (!adminMovement || type === 'consumo' || product.module_id === TALLER_ID)) {
      throw invalid('El producto está inactivo.');
    }
    if (product.stock_units === null || (product.module_id === TALLER_ID && !product.last_counted_at)) {
      throw invalid('El conteo es desconocido o está pendiente de verificación. Registra primero un conteo físico en Administración.');
    }

    const before = Number(rows[0].stock_units);
    if (!Number.isSafeInteger(before) || before < 0) throw invalid('El stock actual no es un entero válido.');
    const after = type === 'entrada' ? before + quantity : before - quantity;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw invalid('La operación excede el stock disponible o el límite numérico.');
    }

    await connection.query('UPDATE inventory SET stock_units=? WHERE product_id=?', [after, productId]);
    await connection.query(
      `INSERT INTO movements(product_id,user_id,authorized_by,movement_type,quantity_units,stock_before,stock_after,reason,request_id)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [productId, userId, adminMovement ? userId : null, type, quantity, before, after, reason || null, requestId]
    );
    if (adminMovement) await connection.query(
      'INSERT INTO audit_logs(actor_id,action_name,entity_name,entity_id,details_json) VALUES(?,?,?,?,?)',
      [userId, 'movimiento_admin', 'inventory', productId, JSON.stringify({
        movement_type: type,
        quantity_units: quantity,
        before,
        after,
        reason,
        request_id: requestId
      })]
    );
    await connection.commit();
    return { before, after };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { registerAdminMovement };
