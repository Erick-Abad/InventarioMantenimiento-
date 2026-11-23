const { TALLER_ID } = require('../inventory-area');
const { transaction } = require('../workshop-control');

async function enableProvisionalWorkshop(pool) {
  return transaction(pool, async db => {
    const [[module]]=await db.query('SELECT code FROM modules WHERE id=? FOR UPDATE',[TALLER_ID]);
    if(module?.code!=='TALLER')throw Error('No se encontró el módulo TALLER.');
    const [products]=await db.query(`SELECT p.id,p.barcode,p.kind,p.active FROM products p
      JOIN inventory i ON i.product_id=p.id
      WHERE p.module_id=? AND p.kind IN ('pendiente','herramienta') AND i.stock_units IS NULL
      AND i.last_counted_at IS NULL AND p.barcode REGEXP '^CTH[0-9]{6}$'
      AND NOT EXISTS(SELECT 1 FROM tool_assets t WHERE t.product_id=p.id AND t.asset_status<>'baja')
      ORDER BY p.id FOR UPDATE`,[TALLER_ID]);
    if(!products.length)return 0;
    const ids=products.map(product=>product.id);
    const barcodes=products.map(product=>`UN-${product.barcode}-01`);
    const [[collision]]=await db.query('SELECT barcode FROM products WHERE barcode IN (?) UNION ALL SELECT asset_barcode FROM tool_assets WHERE asset_barcode IN (?) LIMIT 1',[barcodes,barcodes]);
    if(collision)throw Error(`Código individual ocupado: ${collision.barcode}`);
    await db.query("UPDATE products SET kind='herramienta',active=1 WHERE id IN (?)",[ids]);
    await db.query('UPDATE inventory SET stock_units=1 WHERE product_id IN (?)',[ids]);
    await db.query('INSERT INTO workshop_provisional_stock(product_id) VALUES ?',[ids.map(id=>[id])]);
    await db.query('INSERT INTO tool_assets(product_id,asset_barcode,asset_status,description) VALUES ?',
      [ids.map((id,index)=>[id,barcodes[index],'disponible','Unidad inicial asignada con stock provisional'])]);
    const [assets]=await db.query('SELECT id,product_id,asset_barcode FROM tool_assets WHERE asset_barcode IN (?)',[barcodes]);
    const assetsByProduct=new Map(assets.map(asset=>[asset.product_id,asset]));
    await db.query('INSERT INTO audit_logs(actor_id,action_name,entity_name,entity_id,details_json) VALUES ?',
      [products.map(product=>{
        const asset=assetsByProduct.get(product.id);
        return [null,'stock_provisional','inventory',product.id,JSON.stringify({before:null,after:1,
          before_kind:product.kind,before_active:product.active,asset_id:asset.id,asset_barcode:asset.asset_barcode,
          reason:'Habilitación solicitada con una unidad provisional, pendiente de conteo físico'})];
      })]);
    return products.length;
  });
}

if(require.main===module){
  const {pool}=require('../storage');
  (async()=>{
    const [[target]]=await pool.query('SELECT DATABASE() db');
    if(process.argv[2]!==target.db)throw Error('Indica exactamente el nombre de la base de destino.');
    console.log(`Referencias habilitadas con una unidad provisional: ${await enableProvisionalWorkshop(pool)}`);
  })().catch(error=>{console.error(error.code||error.message);process.exitCode=1;}).finally(()=>pool.end());
}

module.exports={enableProvisionalWorkshop};
