const { randomUUID } = require('node:crypto');
const { invalid } = require('./inventory-area');

const MODES = ['ADMIN_PRESENTE', 'AUTOSERVICIO'];
const idleMinutes = Number(process.env.SESSION_IDLE_MINUTES || 15);
if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 120) {
  throw new Error('SESSION_IDLE_MINUTES debe estar entre 1 y 120.');
}
const idleSeconds = idleMinutes * 60;

function audit(db, actor, action, entity, id, details = {}) {
  return db.query('INSERT INTO audit_logs(actor_id,action_name,entity_name,entity_id,details_json) VALUES(?,?,?,?,?)',
    [actor, action, entity, id, JSON.stringify(details)]);
}

async function transaction(pool, operation) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const result = await operation(db);
    await db.commit();
    return result;
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}

function startSession(pool, user) {
  return transaction(pool, async db => {
    const sid = randomUUID();
    await db.query('INSERT INTO app_sessions(id,user_id,expires_at) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 8 HOUR))', [sid,user.id]);
    await audit(db,user.id,'inicio_sesion','users',user.id,{session_id:sid});
    return sid;
  });
}

async function markEnded(db, sid, userId, reason) {
  const [result] = await db.query('UPDATE app_sessions SET ended_at=NOW(3) WHERE id=? AND user_id=? AND ended_at IS NULL', [sid,userId]);
  if (result.affectedRows) await audit(db,userId,'cierre_sesion','users',userId,{session_id:sid,reason});
}

function endSession(pool, {sid,id}, reason) {
  return transaction(pool, db => markEnded(db,sid,id,reason));
}

async function sessionUser(pool, {sid,id}, touch=true) {
  if (typeof sid !== 'string' || sid.length !== 36) return null;
  return transaction(pool, async db => {
    const [[row]] = await db.query(`SELECT u.id,u.full_name name,u.role,u.active,s.ended_at,
      (s.expires_at<=NOW() OR TIMESTAMPDIFF(SECOND,s.last_seen,NOW(3))>=?) expired
      FROM app_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? FOR UPDATE`, [idleSeconds,sid,id]);
    if (!row || row.ended_at) return null;
    if (!row.active || row.expired) {
      await markEnded(db,sid,id,row.active?'inactividad_o_vencimiento':'cuenta_inactiva');
      return null;
    }
    if(touch)await db.query('UPDATE app_sessions SET last_seen=NOW(3) WHERE id=?', [sid]);
    return {id:row.id,name:row.name,role:row.role};
  });
}

async function getMode(db, lock = '') {
  const [[mode]] = await db.query(`SELECT w.mode,w.changed_at,u.full_name changed_by FROM workshop_control w
    LEFT JOIN users u ON u.id=w.changed_by WHERE w.id=1 ${lock}`);
  if (!mode || !MODES.includes(mode.mode)) throw invalid('El control del Taller requiere configuración.',503);
  return mode;
}

function setMode(pool, user, mode) {
  if (!MODES.includes(mode)) throw invalid('Modo de trabajo inválido.');
  return transaction(pool, async db => {
    // Use the singleton row as a gate for the entire loan/return transaction.
    const [[previous]] = await db.query('SELECT mode FROM workshop_control WHERE id=1 FOR UPDATE');
    if (!previous) throw invalid('El control del Taller requiere configuración.',503);
    const [[account]] = await db.query('SELECT role,active FROM users WHERE id=? FOR SHARE',[user.id]);
    if (!account?.active || account.role!=='administrador') throw invalid('Solo un administrador activo puede cambiar el modo.',403);
    if (previous.mode !== mode) {
      await db.query('UPDATE workshop_control SET mode=?,changed_by=?,changed_at=NOW() WHERE id=1',[mode,user.id]);
      await audit(db,user.id,'modo_taller','workshop_control',1,{before:previous.mode,after:mode});
    }
    return getMode(db);
  });
}

async function requireOperator(db, user, barcode) {
  const [[control]] = await db.query('SELECT mode FROM workshop_control WHERE id=1 FOR SHARE');
  if (!control || !MODES.includes(control.mode)) throw invalid('El control del Taller requiere configuración.',503);
  if (user.role !== 'administrador' && control.mode !== 'AUTOSERVICIO') {
    throw invalid('Autoservicio cerrado. El administrador registra las entregas y devoluciones.',403);
  }
  const code = typeof barcode === 'string' ? barcode.trim() : '';
  if (user.role !== 'administrador' && (!code || code.length > 70)) {
    throw invalid('Escanea tu credencial antes de escanear la herramienta.',403);
  }
  const [[account]] = await db.query('SELECT id,role,active,(employee_barcode=?) credential_matches FROM users WHERE id=? FOR SHARE',[code,user.id]);
  if (!account?.active || account.role !== user.role) throw invalid('La cuenta cambió. Ingresa nuevamente.',401);
  if (user.role !== 'administrador' && !account.credential_matches) {
    throw invalid('La credencial no corresponde a la sesión. Cambia de usuario para continuar.',403);
  }
  return control.mode;
}

module.exports = { audit,transaction,idleSeconds,startSession,endSession,sessionUser,getMode,setMode,requireOperator };
