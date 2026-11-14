const SEARCH_LIMIT = 20;

function escapeLike(value) {
  return value.replace(/[!%_]/g, character => '!'+character);
}

async function searchProducts(pool, query) {
  const term = typeof query === 'string' ? query.trim() : '';
  if (!term) return [];
  if (term.length > 100) throw new RangeError('La búsqueda no puede superar 100 caracteres.');

  const pattern = '%'+escapeLike(term)+'%';
  const [rows] = await pool.query(
    `SELECT p.id,p.name,p.sap_code,p.barcode,p.kind,p.active,p.units_per_pack,p.notes,p.module_id,
            m.name module,m.inventory_status,i.stock_units,i.original_pack_count,i.min_stock_units
     FROM products p
     JOIN modules m ON m.id=p.module_id
     JOIN inventory i ON i.product_id=p.id
     WHERE p.barcode=? OR p.sap_code=? OR p.name LIKE ? ESCAPE '!' OR p.barcode LIKE ? ESCAPE '!' OR p.sap_code LIKE ? ESCAPE '!'
     ORDER BY CASE WHEN p.barcode=? THEN 0 WHEN p.sap_code=? THEN 1 ELSE 2 END,p.module_id,p.source_row
     LIMIT ${SEARCH_LIMIT}`,
    [term,term,pattern,pattern,pattern,term,term]
  );
  return rows;
}

module.exports = { searchProducts };
