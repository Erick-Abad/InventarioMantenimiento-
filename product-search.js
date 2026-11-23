const { areaCondition } = require('./inventory-area');
const SEARCH_LIMIT = 20;

function escapeLike(value) {
  return value.replace(/[!%_]/g, character => '!'+character);
}

async function searchProducts(pool, query, area) {
  const scope = areaCondition(area);
  const term = typeof query === 'string' ? query.trim() : '';
  if (!term) return [];
  if (term.length > 100) throw new RangeError('La búsqueda no puede superar 100 caracteres.');

  const exact = /^CTH\d{6}$/i.test(term);
  const pattern = '%'+escapeLike(term)+'%';
  const [rows] = await pool.query(
    `SELECT p.id,p.name,p.sap_code,p.barcode,p.kind,p.active,p.units_per_pack,p.notes,p.module_id,
            m.name module,m.inventory_status,i.stock_units,i.original_pack_count,i.min_stock_units,i.last_counted_at,
            (wps.product_id IS NOT NULL) provisional_stock
     FROM products p
     JOIN modules m ON m.id=p.module_id
     LEFT JOIN inventory i ON i.product_id=p.id
     LEFT JOIN workshop_provisional_stock wps ON wps.product_id=p.id
     WHERE ${scope} AND (${exact ? 'p.barcode=?' : "p.barcode=? OR p.sap_code=? OR p.name LIKE ? ESCAPE '!' OR p.barcode LIKE ? ESCAPE '!' OR p.sap_code LIKE ? ESCAPE '!'"})
     ORDER BY ${exact ? '' : 'CASE WHEN p.barcode=? THEN 0 WHEN p.sap_code=? THEN 1 ELSE 2 END,'}p.module_id,p.source_row
     LIMIT ${SEARCH_LIMIT}`,
    exact ? [term.toUpperCase()] : [term,term,pattern,pattern,pattern,term,term]
  );
  return rows;
}

module.exports = { searchProducts };
