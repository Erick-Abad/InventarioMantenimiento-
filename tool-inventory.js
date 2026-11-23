const { areaCondition, productDetailJoins, productLocation } = require('./inventory-area');

async function listToolAssets(pool, area) {
  const scope = areaCondition(area);
  const [rows] = await pool.query(
    `SELECT ta.id,ta.asset_barcode,ta.asset_status,ta.description,ta.product_id,
            p.name,p.sap_code,p.barcode product_barcode,p.kind,p.active,p.module_id,
            m.name module,i.stock_units,i.last_counted_at,(wps.product_id IS NOT NULL) provisional_stock,
            COALESCE(al.name,${productLocation(area==='taller')}) location,tl.location_id,
            l.loaned_at,l.borrower_id,u.full_name borrower
     FROM tool_assets ta
     LEFT JOIN products p ON p.id=ta.product_id
     LEFT JOIN modules m ON m.id=p.module_id
     LEFT JOIN inventory i ON i.product_id=p.id LEFT JOIN workshop_provisional_stock wps ON wps.product_id=p.id
     ${productDetailJoins(area==='taller')}
     LEFT JOIN tool_locations tl ON tl.asset_id=ta.id LEFT JOIN inventory_locations al ON al.id=tl.location_id
     LEFT JOIN loans l ON l.open_asset_id=ta.id LEFT JOIN users u ON u.id=l.borrower_id
     WHERE ${scope}
     ORDER BY m.id,p.source_row,ta.id`
  );
  return rows;
}

module.exports = { listToolAssets };
