const { areaCondition } = require('./inventory-area');

async function listToolAssets(pool, area) {
  const scope = areaCondition(area);
  const [rows] = await pool.query(
    `SELECT ta.id,ta.asset_barcode,ta.asset_status,ta.description,ta.product_id,
            p.name,p.sap_code,p.barcode product_barcode,p.kind,p.active,p.module_id,
            m.name module,i.stock_units,i.last_counted_at,
            ${area === 'taller' ? "COALESCE(NULLIF(TRIM(s.location_validated),''),NULLIF(TRIM(s.section_name),''),m.name)" : 'm.name'} location,
            l.loaned_at,u.full_name borrower
     FROM tool_assets ta
     LEFT JOIN products p ON p.id=ta.product_id
     LEFT JOIN modules m ON m.id=p.module_id
     LEFT JOIN inventory i ON i.product_id=p.id
     ${area === 'taller' ? 'LEFT JOIN taller_carga_20261123 s ON BINARY s.barcode=BINARY p.barcode' : ''}
     LEFT JOIN loans l ON l.open_asset_id=ta.id LEFT JOIN users u ON u.id=l.borrower_id
     WHERE ${scope}
     ORDER BY m.id,p.source_row,ta.id`
  );
  return rows;
}

module.exports = { listToolAssets };
