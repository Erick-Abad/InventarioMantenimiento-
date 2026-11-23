const { Code128Reader } = require('@zxing/library');
const { TALLER_ID,invalid,requireArea } = require('./inventory-area');
const { audit,transaction } = require('./workshop-control');
const { optionalText,locationId } = require('./catalog-admin');

function changeAssets(pool,userId,input) {
  const state=input.status, apply=input.apply===true;
  const ids=Array.isArray(input.ids)?[...new Set(input.ids.map(Number))].sort((a,b)=>a-b):[];
  const reason=optionalText(input.reason,255,'Motivo');
  if(!ids.length||ids.length>100||ids.some(id=>!Number.isSafeInteger(id)||id<1)||!['disponible','mantenimiento','baja'].includes(state)){
    throw invalid('Selecciona de 1 a 100 unidades y su nuevo estado.');
  }
  if(apply&&((reason?.length||0)<5||state==='disponible'&&input.physical_verification!==true)){
    throw invalid('Indica un motivo y verifica físicamente la disponibilidad.');
  }
  return transaction(pool,async db=>{
    const [assets]=await db.query(`SELECT t.id,t.asset_barcode,t.asset_status,p.id product_id,p.module_id,p.name,p.kind,p.active,
      i.last_counted_at,i.stock_units,(wps.product_id IS NOT NULL) provisional_stock,l.id open_loan_id FROM tool_assets t
      JOIN products p ON p.id=t.product_id LEFT JOIN inventory i ON i.product_id=p.id
      LEFT JOIN workshop_provisional_stock wps ON wps.product_id=p.id
      LEFT JOIN loans l ON l.open_asset_id=t.id WHERE t.id IN (?) ORDER BY t.id FOR UPDATE`,[ids]);
    if(assets.length!==ids.length)throw invalid('Una o más unidades no existen.',404);
    const rows=assets.map(asset=>{
      requireArea(asset.module_id,input.area);
      const reason=asset.open_loan_id||asset.asset_status==='prestada'?'Tiene un préstamo abierto'
        :state==='disponible'&&asset.kind!=='herramienta'?'La referencia no está clasificada como herramienta'
        :state==='disponible'&&asset.module_id===TALLER_ID&&(!asset.stock_units||!asset.last_counted_at&&!asset.provisional_stock)?'Falta un conteo físico con existencias'
        :state==='disponible'&&asset.asset_status==='baja'?'La unidad está dada de baja'
        :null;
      return {id:asset.id,barcode:asset.asset_barcode,name:asset.name,current:asset.asset_status,reason};
    });
    if(!apply)return rows;
    if(rows.some(row=>row.reason))throw invalid('Una o más unidades cambiaron de estado. Revisa la vista previa.',409);
    for(const asset of assets){
      if(state==='disponible'&&!asset.active)await db.query('UPDATE products SET active=1 WHERE id=?',[asset.product_id]);
      if(asset.asset_status===state&&asset.active)continue;
      await db.query('UPDATE tool_assets SET asset_status=? WHERE id=?',[state,asset.id]);
      await audit(db,userId,'estado_herramienta','tool_assets',asset.id,{before:asset.asset_status,after:state,reason,physical_verification:input.physical_verification===true});
    }
    return rows;
  });
}

function editAsset(pool,userId,id,input) {
  const description=optionalText(input.description,250,'Descripción');
  return transaction(pool,async db=>{
    const [[asset]]=await db.query(`SELECT t.description,p.module_id,tl.location_id FROM tool_assets t
      JOIN products p ON p.id=t.product_id LEFT JOIN tool_locations tl ON tl.asset_id=t.id WHERE t.id=? FOR UPDATE`,[id]);
    if(!asset)throw invalid('Herramienta inexistente.',404);
    requireArea(asset.module_id,input.area);
    const location=await locationId(db,asset.module_id,input.location_id);
    await db.query('UPDATE tool_assets SET description=? WHERE id=?',[description,id]);
    if(location)await db.query('INSERT INTO tool_locations(asset_id,location_id) VALUES (?,?) AS updated ON DUPLICATE KEY UPDATE location_id=updated.location_id',[id,location]);
    else if(asset.location_id)await db.query('DELETE FROM tool_locations WHERE asset_id=?',[id]);
    await audit(db,userId,'editar_herramienta','tool_assets',id,{before:asset,after:{description,location_id:location}});
    return {ok:true};
  });
}

function barcodeSvg(code) {
  if(typeof code!=='string'||!/^[\x20-\x7e]{1,70}$/.test(code))throw invalid('La etiqueta requiere un código Code 128 de caracteres imprimibles.');
  const values=[104,...Array.from(code,character=>character.charCodeAt(0)-32)];
  const checksum=values.reduce((sum,value,i)=>sum+value*(i||1),0)%103;
  let position=10;
  const bars=[];
  for(const symbol of [...values,checksum,106]){
    Code128Reader.CODE_PATTERNS[symbol].forEach((width,index)=>{
      if(index%2===0)bars.push(`<rect x="${position}" y="6" width="${width}" height="52"/>`);
      position+=width;
    });
  }
  const text=code.replace(/[&<>]/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[character]));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${position+10} 78" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/>${bars.join('')}<text x="50%" y="73" font-family="monospace" font-size="11" text-anchor="middle">${text}</text></svg>`;
}

module.exports={changeAssets,editAsset,barcodeSvg};
