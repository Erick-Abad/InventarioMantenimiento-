const { invalid } = require('./inventory-area');
const { transaction } = require('./workshop-control');

async function unreadEntries(pool, adminId) {
  const [rows]=await pool.query(`SELECT a.id,mv.created_at,mv.quantity_units,mv.stock_after,mv.reason,
    p.name product,p.barcode,m.name module,u.full_name collaborator,COUNT(*) OVER() unread_total
    FROM audit_logs a JOIN movements mv ON mv.id=a.entity_id JOIN products p ON p.id=mv.product_id
    JOIN modules m ON m.id=p.module_id JOIN users u ON u.id=mv.user_id
    WHERE a.action_name='entrada_colaborador' AND a.entity_name='movements'
      AND NOT EXISTS(SELECT 1 FROM audit_logs read_alert WHERE read_alert.actor_id=?
        AND read_alert.action_name='entrada_alerta_leida' AND read_alert.entity_name='audit_logs' AND read_alert.entity_id=a.id)
    ORDER BY a.id DESC LIMIT 20`,[adminId]);
  return {unread:Number(rows[0]?.unread_total||0), alerts:rows};
}

function markEntriesRead(pool, adminId, input) {
  if(!Array.isArray(input)||input.length<1||input.length>20||input.some(id=>!Number.isSafeInteger(id)||id<1)){
    throw invalid('Selecciona hasta 20 alertas válidas.');
  }
  return transaction(pool,async db=>{
    // Serialize acknowledgments for this administrator, without touching the movement.
    const [[admin]]=await db.query("SELECT id FROM users WHERE id=? AND role='administrador' AND active=1 FOR UPDATE",[adminId]);
    if(!admin)throw invalid('Solo administrador.',403);
    await db.query(`INSERT INTO audit_logs(actor_id,action_name,entity_name,entity_id,details_json)
      SELECT ?,'entrada_alerta_leida','audit_logs',a.id,JSON_OBJECT() FROM audit_logs a
      LEFT JOIN audit_logs read_alert ON read_alert.actor_id=? AND read_alert.action_name='entrada_alerta_leida'
        AND read_alert.entity_name='audit_logs' AND read_alert.entity_id=a.id
      WHERE a.id IN (?) AND a.action_name='entrada_colaborador' AND a.entity_name='movements' AND read_alert.id IS NULL`,
    [adminId,adminId,input]);
  });
}

module.exports={unreadEntries,markEntriesRead};
