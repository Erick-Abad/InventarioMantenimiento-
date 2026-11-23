const TALLER_ID = 11;

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function areaCondition(area) {
  if (area === 'taller') return `p.module_id=${TALLER_ID}`;
  if (area === 'valvulas') return `p.module_id<>${TALLER_ID}`;
  if (area === undefined || area === '') return '1=1';
  throw invalid('Área de inventario inválida.');
}

function requireArea(moduleId, area) {
  areaCondition(area);
  if (area && (Number(moduleId) === TALLER_ID) !== (area === 'taller')) {
    throw invalid('El artículo pertenece a otra área de inventario.', 409);
  }
}

async function requireTallerWorker(connection, moduleId, user) {
  if (Number(moduleId) !== TALLER_ID) return;
  if (!user?.credentialVerified) throw invalid('Escanea o ingresa tu credencial para confirmar tu sesión del Taller.', 403);
  const [[account]] = await connection.query('SELECT role,active FROM users WHERE id=? FOR SHARE', [user.id]);
  if (!account?.active || account.role !== user.role) throw invalid('Tu cuenta cambió. Ingresa nuevamente.', 401);
}

function historyQuery(area) {
  const scope = areaCondition(area);
  return `SELECT mv.id,mv.product_id,mv.user_id,mv.created_at,mv.movement_type,mv.quantity_units,
                 mv.stock_before,mv.stock_after,mv.reason,NULL asset_barcode
          FROM movements mv JOIN products p ON p.id=mv.product_id WHERE ${scope}
          UNION ALL
          SELECT l.id,p.id,l.loaned_by,l.loaned_at,'prestamo',1,NULL,NULL,l.notes,t.asset_barcode
          FROM loans l JOIN tool_assets t ON t.id=l.asset_id JOIN products p ON p.id=t.product_id WHERE ${scope}
          UNION ALL
          SELECT l.id,p.id,l.received_by,l.returned_at,'devolucion',1,NULL,NULL,l.return_condition,t.asset_barcode
          FROM loans l JOIN tool_assets t ON t.id=l.asset_id JOIN products p ON p.id=t.product_id
          WHERE ${scope} AND l.returned_at IS NOT NULL
          UNION ALL
          SELECT a.id,p.id,a.actor_id,a.created_at,IF(a.action_name='stock_provisional','stock_provisional','conteo_fisico'),
                 IF(a.action_name='stock_provisional',1,0),
                 CASE WHEN JSON_TYPE(a.details_json->'$.before')='INTEGER' THEN CAST(a.details_json->>'$.before' AS UNSIGNED) END,
                 CAST(a.details_json->>'$.after' AS UNSIGNED),a.details_json->>'$.reason',NULL
          FROM audit_logs a JOIN products p ON p.id=a.entity_id
          WHERE ${scope} AND a.entity_name='inventory' AND a.action_name IN ('verificar_conteo','stock_provisional')`;
}

async function listHistory(pool, area, { userId, moduleId, assetBarcode, location, from, to, limit = 15, offset = 0 } = {}) {
  const workshop=area==='taller';
  const locationSql=`COALESCE(al.name,${productLocation(workshop)})`;
  const filters=[['h.user_id=?',userId],['p.module_id=?',moduleId],['h.asset_barcode=?',assetBarcode],
    [`${locationSql}=?`,location],['h.created_at>=?',from],['h.created_at<DATE_ADD(?,INTERVAL 1 DAY)',to]].filter(([,value])=>value);
  const [rows] = await pool.query(
    `WITH history AS (${historyQuery(area)})
     SELECT h.*,p.name product,p.barcode,m.name module,${locationSql} location,u.full_name collaborator
     FROM history h JOIN products p ON p.id=h.product_id JOIN modules m ON m.id=p.module_id
     ${productDetailJoins(workshop)} LEFT JOIN users u ON u.id=h.user_id
     LEFT JOIN tool_assets ht ON ht.asset_barcode=h.asset_barcode COLLATE utf8mb4_0900_ai_ci
     LEFT JOIN tool_locations tl ON tl.asset_id=ht.id LEFT JOIN inventory_locations al ON al.id=tl.location_id
     ${filters.length?'WHERE '+filters.map(([sql])=>sql).join(' AND '):''}
     ORDER BY h.created_at DESC,h.id DESC,h.movement_type DESC LIMIT ? OFFSET ?`,
    [...filters.map(([,value])=>value),limit,offset]
  );
  return rows;
}

function productDetailJoins(workshop) {
  return `LEFT JOIN product_details pd ON pd.product_id=p.id LEFT JOIN inventory_locations pl ON pl.id=pd.location_id
    ${workshop?'LEFT JOIN taller_carga_20261123 s ON BINARY s.barcode=BINARY p.barcode':''}`;
}

function productLocation(workshop) {
  return `COALESCE(pl.name,${workshop?"NULLIF(TRIM(s.location_validated),''),NULLIF(TRIM(s.section_name),''),":''}m.name)`;
}

async function listAreaProducts(pool, area) {
  const scope = areaCondition(area);
  const workshop = area === 'taller';
  const [rows] = await pool.query(
    `WITH history AS (${historyQuery(area)}),
     latest AS (SELECT product_id,user_id,created_at,
                ROW_NUMBER() OVER(PARTITION BY product_id ORDER BY created_at DESC,id DESC,movement_type DESC) rn FROM history),
     assets AS (SELECT t.product_id,SUM(t.asset_status='disponible' AND l.id IS NULL) available,SUM(l.id IS NOT NULL) loaned,
                COUNT(*) assets FROM tool_assets t LEFT JOIN loans l ON l.open_asset_id=t.id GROUP BY t.product_id),
     edits AS (SELECT entity_id,MAX(created_at) edited_at FROM audit_logs
               WHERE entity_name='products' AND action_name='editar_producto' GROUP BY entity_id)
     SELECT p.id,p.name,p.sap_code,p.barcode,p.kind,p.active,p.units_per_pack,p.notes,p.module_id,
            m.name module,m.inventory_status,i.stock_units,i.original_pack_count,i.min_stock_units,i.last_counted_at,
            (wps.product_id IS NOT NULL) provisional_stock,
            ${productLocation(workshop)} location,
            ${workshop ? "(pl.id IS NOT NULL OR NULLIF(TRIM(s.location_validated),'') IS NOT NULL)" : '1'} location_validated,
            pd.location_id,pd.measure,pd.specifications,
            ${workshop?"COALESCE(pd.brand,NULLIF(TRIM(s.brand),''))":"pd.brand"} brand,
            ${workshop?"COALESCE(pd.model,NULLIF(TRIM(s.model),''))":"pd.model"} model,
            ${workshop?"COALESCE(pd.capacity,NULLIF(TRIM(s.capacity),''))":"pd.capacity"} capacity,
            ${workshop?"COALESCE(pd.category,NULLIF(TRIM(s.record_type),''))":"pd.category"} category,
            CASE WHEN p.active=0 THEN 'Pendiente de validación'
                 WHEN p.kind='pendiente' OR ${workshop ? '(i.last_counted_at IS NULL AND wps.product_id IS NULL) OR i.stock_units IS NULL' : "(p.kind='consumible' AND i.stock_units IS NULL)"} THEN 'Pendiente de conteo o clasificación'
                 WHEN p.kind='herramienta' AND COALESCE(a.available,0)>0 ${workshop ? 'AND i.stock_units>0' : ''} THEN 'Disponible para préstamo'
                 WHEN p.kind='herramienta' AND COALESCE(a.loaned,0)>0 THEN 'Prestada'
                 WHEN p.kind='herramienta' AND COALESCE(a.assets,0)=0 THEN 'Sin activos registrados'
                 WHEN p.kind='herramienta' THEN 'No disponible'
                 WHEN i.stock_units=0 THEN 'Agotado' ELSE 'Disponible' END availability,
            u.full_name last_worker,
            GREATEST(COALESCE(i.updated_at,p.created_at),COALESCE(l.created_at,p.created_at),COALESCE(e.edited_at,p.created_at)) updated_at
     FROM products p JOIN modules m ON m.id=p.module_id LEFT JOIN inventory i ON i.product_id=p.id
     ${productDetailJoins(workshop)}
     LEFT JOIN workshop_provisional_stock wps ON wps.product_id=p.id
     LEFT JOIN latest l ON l.product_id=p.id AND l.rn=1 LEFT JOIN users u ON u.id=l.user_id
     LEFT JOIN assets a ON a.product_id=p.id LEFT JOIN edits e ON e.entity_id=p.id
     WHERE ${scope} ORDER BY p.module_id,p.source_row,p.id`
  );
  return rows;
}

module.exports = { TALLER_ID, invalid, areaCondition, requireArea, requireTallerWorker, listHistory, listAreaProducts, productDetailJoins, productLocation };
