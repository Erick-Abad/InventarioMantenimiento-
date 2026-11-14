async function listToolAssets(pool) {
  const [rows] = await pool.query(
    `SELECT ta.id,ta.asset_barcode,ta.asset_status,ta.description,ta.product_id,
            p.name,p.sap_code,p.barcode product_barcode,p.kind,p.active,p.module_id,
            m.name module,i.stock_units
     FROM tool_assets ta
     LEFT JOIN products p ON p.id=ta.product_id
     LEFT JOIN modules m ON m.id=p.module_id
     LEFT JOIN inventory i ON i.product_id=p.id
     ORDER BY m.id,p.source_row,ta.id`
  );
  return rows;
}

module.exports = { listToolAssets };
