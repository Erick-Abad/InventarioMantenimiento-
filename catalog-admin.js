const ExcelJS = require('exceljs');
const { invalid } = require('./inventory-area');
const { audit, transaction } = require('./workshop-control');

const detailFields = { brand:160, model:255, measure:120, capacity:255, category:140, specifications:4000 };
const statuses = ['cerrado','en_proceso','pendiente'];
const kinds = ['pendiente','herramienta','consumible'];
const integerId = value => Number.isSafeInteger(Number(value)) && Number(value)>0 ? Number(value) : null;

function optionalText(value, max, label) {
  if (value==null||value==='') return null;
  if (typeof value!=='string'||value.trim().length>max) throw invalid(`${label} excede el formato o longitud permitida.`);
  return value.trim()||null;
}

async function locationId(db, moduleId, input) {
  if (input==null||input==='') return null;
  const id=integerId(input);
  const [[row]]=await db.query('SELECT id FROM inventory_locations WHERE id=? AND module_id=?', [id,moduleId]);
  if (!row) throw invalid('Selecciona una ubicación del módulo del artículo.');
  return row.id;
}

async function saveDetails(db, productId, moduleId, input) {
  if (!input||typeof input!=='object'||Array.isArray(input)) throw invalid('Características inválidas.');
  const fields=Object.keys(detailFields);
  const values=fields.map(field=>optionalText(input[field],detailFields[field],field));
  const location=await locationId(db,moduleId,input.location_id);
  await db.query(`INSERT INTO product_details(product_id,location_id,${fields.join(',')}) VALUES (?,?,?,?,?,?,?,?) AS updated
    ON DUPLICATE KEY UPDATE location_id=updated.location_id,${fields.map(field=>`${field}=updated.${field}`).join(',')}`,
    [productId,location,...values]);
}

async function createProduct(db, userId, input) {
  const name=optionalText(input.name,255,'Nombre'), barcode=optionalText(input.barcode,70,'Código de barras');
  const sap=optionalText(input.sap_code,80,'SAP'), notes=optionalText(input.notes,4000,'Observaciones');
  const moduleId=integerId(input.module_id), kind=input.kind||'pendiente';
  if (!name||!moduleId||!kinds.includes(kind)||barcode&&/^CTH[0-9]{6}$/i.test(barcode)) throw invalid('Indica nombre, módulo y un código distinto a los CTH de la carga.');
  const [[module]]=await db.query('SELECT id FROM modules WHERE id=? FOR UPDATE', [moduleId]);
  if (!module) throw invalid('Módulo inexistente.');
  if (barcode) {
    const [[asset]]=await db.query('SELECT id FROM tool_assets WHERE asset_barcode=?', [barcode]);
    if (asset) throw invalid('El código ya está asignado a una unidad física.',409);
  }
  const [[sequence]]=await db.query('SELECT COALESCE(MAX(source_row),0)+1 source_row FROM products WHERE module_id=?', [moduleId]);
  const [result]=await db.query('INSERT INTO products(module_id,source_row,name,sap_code,barcode,kind,notes,active) VALUES(?,?,?,?,?,?,?,0)',
    [moduleId,sequence.source_row,name,sap,barcode,kind,notes]);
  await db.query('INSERT INTO inventory(product_id,stock_units) VALUES(?,NULL)', [result.insertId]);
  if (input.details) await saveDetails(db,result.insertId,moduleId,input.details);
  await audit(db,userId,'crear_producto','products',result.insertId,{module_id:moduleId,name,barcode,kind});
  return result.insertId;
}

async function catalogStructure(db) {
  const [[modules],[locations]]=await Promise.all([
    db.query('SELECT id,code,name,inventory_status FROM modules ORDER BY id'),
    db.query('SELECT id,module_id,name FROM inventory_locations ORDER BY name,id')
  ]);
  return {modules,locations};
}

function saveModule(pool,userId,input) {
  const id=integerId(input.id), code=optionalText(input.code,20,'Código del módulo'), name=optionalText(input.name,120,'Nombre');
  if (!code||!name||!statuses.includes(input.inventory_status)) throw invalid('Indica código, nombre y estado del módulo.');
  return transaction(pool,async db=>{
    if (id) {
      const [[module]]=await db.query('SELECT code FROM modules WHERE id=? FOR UPDATE',[id]);
      if (!module) throw invalid('Módulo inexistente.',404);
      if (module.code!==code) throw invalid('Conserva el código del módulo para mantener la vinculación del historial.');
      await db.query('UPDATE modules SET name=?,inventory_status=? WHERE id=?',[name,input.inventory_status,id]);
    } else {
      const [result]=await db.query('INSERT INTO modules(code,name,inventory_status) VALUES(?,?,?)',[code,name,input.inventory_status]);
      await audit(db,userId,'crear_modulo','modules',result.insertId,{code,name,status:input.inventory_status});
      return result.insertId;
    }
    await audit(db,userId,'editar_modulo','modules',id,{name,status:input.inventory_status});
    return id;
  });
}

function saveLocation(pool,userId,input) {
  const id=integerId(input.id), moduleId=integerId(input.module_id), name=optionalText(input.name,255,'Ubicación');
  if (!moduleId||!name) throw invalid('Indica módulo y nombre de la ubicación.');
  return transaction(pool,async db=>{
    if (id) {
      await locationId(db,moduleId,id);
      await db.query('UPDATE inventory_locations SET name=? WHERE id=?',[name,id]);
    } else {
      const [[module]]=await db.query('SELECT id FROM modules WHERE id=?',[moduleId]);
      if (!module) throw invalid('Módulo inexistente.');
      const [result]=await db.query('INSERT INTO inventory_locations(module_id,name) VALUES(?,?)',[moduleId,name]);
      await audit(db,userId,'crear_ubicacion','inventory_locations',result.insertId,{module_id:moduleId,name});
      return result.insertId;
    }
    await audit(db,userId,'editar_ubicacion','inventory_locations',id,{module_id:moduleId,name});
    return id;
  });
}

const excelHeaders=['Modulo','Codigo de barras','Nombre','SAP','Tipo','Marca','Modelo','Medida','Capacidad','Categoria','Especificaciones'];

async function readImport(encoded) {
  if (typeof encoded!=='string'||encoded.length>2_000_000) throw invalid('Selecciona un Excel de hasta 1,5 MB.');
  const file=Buffer.from(encoded,'base64'), book=new ExcelJS.Workbook();
  // Avoid expanding arbitrary ZIP archives. Inspect central directory size declarations before parsing.
  const signature=Buffer.from([0x50,0x4b,0x05,0x06]);
  const end=file.lastIndexOf(signature);
  if(end<0||end+22>file.length||file.readUInt16LE(end+10)>100)throw invalid('Archivo XLSX inválido.');
  let index=file.readUInt32LE(end+16), total=0;
  for(let i=0;i<file.readUInt16LE(end+10);i++){
    if(index+46>end||file.readUInt32LE(index)!==0x02014b50)throw invalid('Archivo XLSX inválido.');
    total+=file.readUInt32LE(index+24);
    if(total>10_000_000)throw invalid('El Excel supera el límite de datos.');
    index+=46+file.readUInt16LE(index+28)+file.readUInt16LE(index+30)+file.readUInt16LE(index+32);
  }
  try { await book.xlsx.load(file); } catch { throw invalid('No se pudo leer el archivo XLSX.'); }
  const sheet=book.worksheets[0];
  if (!sheet||sheet.rowCount<2||sheet.rowCount>1001||excelHeaders.some((h,i)=>sheet.getRow(1).getCell(i+1).text.trim()!==h)) {
    throw invalid('Usa la plantilla de catálogo con entre 1 y 1000 referencias.');
  }
  const rows=[], seen=new Set();
  for(let n=2;n<=sheet.rowCount;n++){
    const cells=excelHeaders.map((_,i)=>sheet.getRow(n).getCell(i+1));
    if(cells.some(cell=>cell.type===ExcelJS.ValueType.Formula))throw invalid(`Fila ${n}: sustituye las fórmulas por valores.`);
    const [module,barcode,name,sap_code,kind,...fields]=cells.map(cell=>cell.text.trim());
    if(cells.every(cell=>!cell.text.trim()))continue;
    if (!module||module.length>20||!barcode||barcode.length>70||!name||name.length>255||sap_code.length>80||!kinds.includes(kind))throw invalid(`Fila ${n}: revisa módulo, código, nombre, SAP y tipo.`);
    const key=barcode.toUpperCase();
    if (seen.has(key)) throw invalid(`Fila ${n}: código duplicado en el archivo.`);
    seen.add(key);
    const details=Object.fromEntries(Object.keys(detailFields).map((field,i)=>[field,optionalText(fields[i],detailFields[field],`Fila ${n}, ${field}`)]));
    rows.push({module,barcode,name,sap_code,kind,details,row:n});
  }
  if (!rows.length) throw invalid('La hoja no contiene referencias.');
  return rows;
}

async function importCatalog(pool,userId,encoded,apply=false) {
  const rows=await readImport(encoded);
  return transaction(pool,async db=>{
    const [modules]=await db.query('SELECT id,code FROM modules');
    const moduleIds=new Map(modules.map(module=>[module.code.toUpperCase(),module.id]));
    const result=[];
    for(const row of rows){
      const moduleId=moduleIds.get(row.module.toUpperCase());
      if (!moduleId) throw invalid(`Fila ${row.row}: módulo inexistente.`);
      const [[product]]=await db.query(`SELECT p.id,p.module_id,p.kind,d.location_id FROM products p
        LEFT JOIN product_details d ON d.product_id=p.id WHERE p.barcode=? ${apply?'FOR UPDATE':''}`,[row.barcode]);
      if (product&&(product.module_id!==moduleId||product.kind!==row.kind)) throw invalid(`Fila ${row.row}: cambia módulo o tipo desde Administración.`);
      if (!product&&/^CTH[0-9]{6}$/i.test(row.barcode)) throw invalid(`Fila ${row.row}: código CTH reservado para la carga original.`);
      if(apply&&product){
        await db.query('UPDATE products SET name=?,sap_code=? WHERE id=?',[row.name,row.sap_code||null,product.id]);
        await saveDetails(db,product.id,product.module_id,{...row.details,location_id:product.location_id});
        await audit(db,userId,'importar_producto','products',product.id,{name:row.name,barcode:row.barcode});
      } else if(apply){
        await createProduct(db,userId,{...row,module_id:moduleId});
      }
      result.push({barcode:row.barcode,name:row.name,action:product?'Actualizar':'Crear inactivo'});
    }
    return result;
  });
}

module.exports={optionalText,integerId,locationId,saveDetails,createProduct,catalogStructure,saveModule,saveLocation,importCatalog,excelHeaders};
