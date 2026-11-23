require('dotenv').config();
const express=require('express');const helmet=require('helmet');const rateLimit=require('express-rate-limit');const jwt=require('jsonwebtoken');const bcrypt=require('bcryptjs');const crypto=require('crypto');const ExcelJS=require('exceljs');const path=require('path');const {pool}=require('./storage');const {searchProducts}=require('./product-search');const {loanBlockReason}=require('./public/tool-availability');const {listToolAssets}=require('./tool-inventory');const {registerAdminMovement}=require('./admin-movement');const {listActiveLoginUsers,identifyLoginUser,authenticateLogin}=require('./login-auth');
const {TALLER_ID,invalid,areaCondition,requireArea,requireTallerWorker,listHistory,listAreaProducts}=require('./inventory-area');
const app=express();app.disable('x-powered-by');app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:'32kb'}));app.use(express.static(path.join(__dirname,'public')));
app.use('/vendor/zxing',express.static(path.join(__dirname,'node_modules','@zxing','browser','umd'),{index:false,maxAge:'1d'}));
const safe=(f)=>(req,res,next)=>Promise.resolve(f(req,res,next)).catch(next);
const bad=(res,msg,code=400)=>res.status(code).json({error:msg});
const auth=(req,res,next)=>{try{const t=(req.headers.authorization||'').replace(/^Bearer /,'');req.user=jwt.verify(t,process.env.JWT_SECRET,{algorithms:['HS256']});next()}catch{return bad(res,'Sesion no valida. Ingresa nuevamente.',401)}};
const admin=(req,res,next)=>req.user.role==='administrador'?next():bad(res,'Solo administrador.',403);
const integer=(v)=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const uid=()=>crypto.randomUUID();
const audit=async(c,actor,action,entity,id,details)=>c.query('INSERT INTO audit_logs(actor_id,action_name,entity_name,entity_id,details_json) VALUES(?,?,?,?,?)',[actor,action,entity,id,JSON.stringify(details||{})]);
app.get('/api/health',safe(async(req,res)=>{await pool.query('SELECT 1');res.json({ok:true,database:'connected'})}));
app.get('/api/login/users',rateLimit({windowMs:15*60*1000,limit:60,standardHeaders:'draft-7',legacyHeaders:false}),safe(async(req,res)=>{
 res.json(await listActiveLoginUsers(pool));
}));
app.get('/api/login/identify',rateLimit({windowMs:15*60*1000,limit:60,standardHeaders:'draft-7',legacyHeaders:false}),safe(async(req,res)=>{
 try{res.json(await identifyLoginUser(pool,req.query.barcode))}
 catch(e){if(e.status)return bad(res,e.message,e.status);throw e}
}));
app.post('/api/login',rateLimit({windowMs:15*60*1000,limit:12,standardHeaders:'draft-7',legacyHeaders:false}),safe(async(req,res)=>{
 try{
  const u=await authenticateLogin(pool,req.body);
  const credentialVerified=typeof req.body.barcode==='string'&&req.body.barcode.trim()!=='';
  const token=jwt.sign({id:u.id,name:u.name,role:u.role,credentialVerified},process.env.JWT_SECRET,{expiresIn:'8h',algorithm:'HS256'});
  res.json({token,user:{...u,credentialVerified}});
 }catch(e){if(e.status)return bad(res,e.message,e.status);throw e}
}));
app.post('/api/session/credential',auth,rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-7',legacyHeaders:false}),safe(async(req,res)=>{
 const barcode=typeof req.body.barcode==='string'?req.body.barcode.trim():'';
 if(!barcode||barcode.length>70)return bad(res,'Ingresa el código de tu credencial.');
 const [[account]]=await pool.query('SELECT role FROM users WHERE id=? AND employee_barcode=? AND active=1',[req.user.id,barcode]);
 if(!account||account.role!==req.user.role)return bad(res,'La credencial no corresponde a tu sesión activa.',403);
 const {id,name,role,exp}=req.user;
 res.json({token:jwt.sign({id,name,role,exp,credentialVerified:true},process.env.JWT_SECRET,{algorithm:'HS256'})});
}));
app.get('/api/history',auth,safe(async(req,res)=>{
 const userId=req.query.user_id===undefined?null:integer(req.query.user_id);
 const page=req.query.page===undefined?1:integer(req.query.page);
 if(!page||page>100000||(req.query.user_id!==undefined&&!userId))return bad(res,'Página o trabajador inválido.');
 const rows=await listHistory(pool,req.query.area,{userId,limit:26,offset:(page-1)*25});
 res.json({rows:rows.slice(0,25),hasMore:rows.length>25});
}));
app.get('/api/dashboard',auth,safe(async(req,res)=>{
 const area=req.query.area;
 if(area){
  const [products,recent]=await Promise.all([listAreaProducts(pool,area),listHistory(pool,area)]);
  const modulesById=new Map(products.map(p=>[p.module_id,{name:p.module,inventory_status:p.inventory_status,products:0,units:null}]));
  for(const p of products){
   const module=modulesById.get(p.module_id);
   module.products++;
   if(p.stock_units!==null)module.units=(module.units??0)+Number(p.stock_units);
  }
  const [[toolCounts]]=await pool.query(`SELECT
   COUNT(CASE WHEN t.asset_status='disponible' AND p.active=1 AND p.kind='herramienta'
        AND (${area==='taller'?'i.last_counted_at IS NOT NULL AND i.stock_units>0':'1=1'})
        AND l.id IS NULL THEN 1 END) available,
   COUNT(l.id) loaned FROM tool_assets t JOIN products p ON p.id=t.product_id
   LEFT JOIN inventory i ON i.product_id=p.id LEFT JOIN loans l ON l.open_asset_id=t.id WHERE ${areaCondition(area)}`);
  const counted=products.filter(p=>p.stock_units!==null);
  const summary={products:products.length,units:counted.length?counted.reduce((sum,p)=>sum+Number(p.stock_units),0):null,
   uncounted:products.length-counted.length,
   pending:products.filter(p=>!p.active||p.kind==='pendiente'||(area==='taller'&&!p.last_counted_at)).length};
  const low=products.filter(p=>p.active&&p.kind==='consumible'&&p.stock_units!==null&&p.min_stock_units!==null&&p.stock_units<=p.min_stock_units);
  return res.json({summary,modules:[...modulesById.values()],loans:toolCounts.loaned,available:toolCounts.available,recent,low});
 }
 const [[summary]]=await pool.query(`SELECT COUNT(*) AS products,SUM(p.barcode IS NOT NULL) AS barcodes,SUM(i.stock_units IS NULL) AS uncounted,COALESCE(SUM(i.stock_units),0) AS units FROM products p JOIN inventory i ON i.product_id=p.id`);
 const [mods]=await pool.query(`SELECT m.name,m.inventory_status,COUNT(p.id) AS products,COALESCE(SUM(i.stock_units),0) AS units FROM modules m LEFT JOIN products p ON p.module_id=m.id LEFT JOIN inventory i ON i.product_id=p.id GROUP BY m.id,m.name,m.inventory_status ORDER BY m.id`);
 const [[loans]]=await pool.query('SELECT COUNT(*) AS pending FROM loans WHERE returned_at IS NULL');
 const [recent]=await pool.query(`SELECT mv.id,mv.movement_type,mv.quantity_units,mv.created_at,p.name product,u.full_name collaborator FROM movements mv JOIN products p ON p.id=mv.product_id JOIN users u ON u.id=mv.user_id ORDER BY mv.id DESC LIMIT 15`);
 res.json({summary,modules:mods,loans:loans.pending,recent});
}));
app.get('/api/products/search',auth,safe(async(req,res)=>{
 const query=req.query.q;
 if(typeof query!=='string')return bad(res,'Indica un código, SAP o nombre para buscar.');
 try{res.json(await searchProducts(pool,query,req.query.area))}
 catch(e){if(e instanceof RangeError)return bad(res,e.message);throw e}
}));
app.get('/api/products',auth,safe(async(req,res)=>{
 if(req.query.area)return res.json(await listAreaProducts(pool,req.query.area));
 const [rows]=await pool.query(`SELECT p.id,p.name,p.sap_code,p.barcode,p.kind,p.active,p.units_per_pack,p.notes,p.module_id,m.name module,m.inventory_status,i.stock_units,i.original_pack_count,i.min_stock_units FROM products p JOIN modules m ON m.id=p.module_id JOIN inventory i ON i.product_id=p.id ORDER BY p.module_id,p.source_row`);res.json(rows);
}));
app.get('/api/tools',auth,safe(async(req,res)=>{res.json(await listToolAssets(pool,req.query.area))}));
app.get('/api/loans',auth,safe(async(req,res)=>{
 const scope=areaCondition(req.query.area);
 const [rows]=await pool.query(`SELECT l.id,l.asset_id,l.loaned_at,l.due_at,l.returned_at,l.borrower_id,
  u.full_name collaborator,t.asset_barcode,p.name product,t.asset_status,l.return_condition,p.module_id
  FROM loans l JOIN users u ON u.id=l.borrower_id JOIN tool_assets t ON t.id=l.asset_id JOIN products p ON p.id=t.product_id
  WHERE ${scope} ${req.query.area?'ORDER BY l.returned_at IS NULL DESC,l.id DESC':'ORDER BY l.id DESC LIMIT 150'}`);
 res.json(rows);
}));
app.get('/api/workers',auth,safe(async(req,res)=>{
 const [workers]=await pool.query('SELECT id,full_name FROM users ORDER BY full_name,id');
 res.json(workers);
}));
app.get('/api/users',auth,admin,safe(async(req,res)=>{const [rows]=await pool.query('SELECT id,full_name,employee_barcode,role,active FROM users ORDER BY full_name');res.json(rows)}));
app.post('/api/admin/users',auth,admin,safe(async(req,res)=>{
 let {full_name,employee_barcode,password,role}=req.body;role=role||'colaborador';if(!full_name||!employee_barcode||typeof password!=='string'||password.length<10||!['colaborador','encargado','administrador'].includes(role))return bad(res,'Nombre, codigo y contrasena de 10 caracteres son obligatorios');
 const hash=await bcrypt.hash(password,12);const [r]=await pool.query('INSERT INTO users(full_name,employee_barcode,password_hash,role,active) VALUES(?,?,?,?,1)',[full_name.trim(),employee_barcode.trim(),hash,role]);await audit(pool,req.user.id,'crear_usuario','users',r.insertId,{full_name,role});res.status(201).json({id:r.insertId});
}));
app.patch('/api/admin/products/:id',auth,admin,safe(async(req,res)=>{
 const id=integer(req.params.id);const {name,sap_code,barcode,kind,active,units_per_pack,min_stock_units,notes}=req.body;
 if(!id||!['consumible','herramienta','pendiente'].includes(kind)||typeof name!=='string'||!name.trim()||typeof active!=='boolean'||(active&&kind==='pendiente'))return bad(res,'Producto y clasificacion invalidos');
 const pp=units_per_pack===''||units_per_pack==null?null:Number(units_per_pack);if(pp!==null&&(!Number.isInteger(pp)||pp<=0))return bad(res,'Unidades por paquete debe ser entero positivo');
 const min=min_stock_units===''||min_stock_units==null?null:Number(min_stock_units);if(min!==null&&(!Number.isInteger(min)||min<0))return bad(res,'Minimo invalido');
 const c=await pool.getConnection();
 try{
  await c.beginTransaction();
  const [[product]]=await c.query(`SELECT p.module_id,p.barcode,p.active,p.kind,i.stock_units,i.last_counted_at
   FROM products p LEFT JOIN inventory i ON i.product_id=p.id WHERE p.id=? FOR UPDATE`,[id]);
  if(!product)throw invalid('Producto inexistente.',404);
  requireArea(product.module_id,req.body.area);
  const code=String(barcode||'').trim()||null;
  let retiredAssets=[];
  if(active&&!product.active&&(product.stock_units==null||!product.last_counted_at))throw invalid('Registra y confirma el conteo físico antes de activar el producto.');
  if(product.module_id===TALLER_ID){
   if(code!==product.barcode)throw invalid('El código CTH está vinculado a la carga del Taller y debe conservarse.');
   if(active&&(product.stock_units==null||!product.last_counted_at))throw invalid('Registra y confirma el conteo físico antes de activar el producto.');
   if(product.kind==='herramienta'&&kind!==product.kind){
    const [assets]=await c.query(`SELECT t.id,t.asset_status,l.id open_loan_id FROM tool_assets t
     LEFT JOIN loans l ON l.open_asset_id=t.id WHERE t.product_id=? AND (t.asset_status<>'baja' OR l.id IS NOT NULL) FOR UPDATE`,[id]);
    if(assets.some(asset=>asset.open_loan_id||asset.asset_status==='prestada'))throw invalid('Devuelve las unidades prestadas antes de cambiar el tipo.',409);
    if(assets.length){
     if(req.body.retire_assets!==true)throw invalid('Confirma la baja de las unidades individuales para guardar el nuevo tipo.',409);
     retiredAssets=assets.map(asset=>asset.id);
     await c.query("UPDATE tool_assets SET asset_status='baja' WHERE product_id=? AND asset_status<>'baja'",[id]);
    }
   }
  }else if(code&&code!==product.barcode){
   if(/^CTH/i.test(code))throw invalid('Los códigos CTH están reservados para productos del Taller.');
   const [[asset]]=await c.query('SELECT id FROM tool_assets WHERE asset_barcode=?',[code]);
   if(asset)throw invalid('El código ya está asignado a una herramienta individual.',409);
  }
  await c.query('UPDATE products SET name=?,sap_code=?,barcode=?,kind=?,active=?,units_per_pack=?,notes=? WHERE id=?',[name.trim(),sap_code||null,code,kind,active?1:0,pp,notes||null,id]);
  await c.query('UPDATE inventory SET min_stock_units=? WHERE product_id=?',[min,id]);
  await audit(c,req.user.id,'editar_producto','products',id,{name,sap_code,barcode:code,kind,active,units_per_pack:pp,min_stock_units:min,retired_asset_ids:retiredAssets});
  await c.commit();
  res.json({ok:true});
 }catch(e){await c.rollback();throw e}finally{c.release()}
}));
function movementRequest(req, adminMovement){
 return {productId:req.body.product_id,userId:req.user.id,quantity:req.body.quantity_units,type:req.body.movement_type,
  reason:req.body.reason,requestId:req.body.request_id,area:req.body.area,user:req.user,adminMovement};
}
app.post('/api/movements',auth,safe(async(req,res)=>{
 try{res.json({ok:true,...await registerAdminMovement(pool,movementRequest(req,false))})}
 catch(e){if(e.code==='ER_DUP_ENTRY')return bad(res,'Movimiento ya registrado. Actualiza los datos.',409);throw e}
}));
app.post('/api/admin/movements',auth,admin,safe(async(req,res)=>{
 try{const result=await registerAdminMovement(pool,movementRequest(req,true));res.json({ok:true,...result})}
 catch(e){if(e.code==='ER_DUP_ENTRY')return bad(res,'Movimiento ya registrado; actualiza los datos.',409);if(e.status)return bad(res,e.message,e.status);throw e}
}));
app.post('/api/admin/adjust',auth,admin,safe(async(req,res)=>{
 const id=integer(req.body.product_id),stock=req.body.new_stock_units,reason=String(req.body.reason||'').trim();
 const n=typeof stock==='string'&&stock.trim()?Number(stock):stock;
 const verified=req.body.physical_verification===true;
 if(!id||!Number.isSafeInteger(n)||n<0||reason.length<5||reason.length>255)return bad(res,'Indica un stock válido y un motivo de 5 a 255 caracteres.');
 const c=await pool.getConnection();
 try{
  await c.beginTransaction();
  const [[p]]=await c.query('SELECT p.module_id,p.kind,i.stock_units,i.last_counted_at FROM products p JOIN inventory i ON i.product_id=p.id WHERE p.id=? FOR UPDATE',[id]);
  if(!p)throw invalid('Producto inexistente o sin inventario.',404);
  requireArea(p.module_id,req.body.area);
  await requireTallerWorker(c,p.module_id,req.user);
  if((!p.last_counted_at||p.stock_units===null)&&!verified)throw invalid('Confirma que verificaste físicamente el conteo inicial.');
  if(p.module_id===TALLER_ID){
   if(p.kind==='herramienta'){
    const [[assets]]=await c.query("SELECT COUNT(*) total FROM tool_assets WHERE product_id=? AND asset_status<>'baja'",[id]);
    if(n<assets.total)throw invalid('El conteo es inferior al número de herramientas individuales registradas.');
   }
  }
  const before=p.stock_units;
  const change=before===null?n:Math.abs(n-before);
  if(before===n&&!verified)throw invalid('Sin cambios de stock.');
  await c.query('UPDATE inventory SET stock_units=?,last_counted_at=IF(?,NOW(),last_counted_at) WHERE product_id=?',[n,verified,id]);
  if(change){
   const type=before===null||n>before?'ajuste_positivo':'ajuste_negativo';
   await c.query('INSERT INTO movements(product_id,user_id,authorized_by,movement_type,quantity_units,stock_before,stock_after,reason,request_id) VALUES(?,?,?,?,?,?,?,?,?)',[id,req.user.id,req.user.id,type,change,before,n,reason,uid()]);
  }
  await audit(c,req.user.id,change?'ajuste_stock':'verificar_conteo','inventory',id,{before,after:n,reason,physical_verification:verified});
  await c.commit();
  res.json({ok:true,before,after:n});
 }catch(e){await c.rollback();throw e}finally{c.release()}
}));
app.post('/api/admin/tools',auth,admin,safe(async(req,res)=>{
 const id=integer(req.body.product_id),barcode=String(req.body.asset_barcode||'').trim();
 if(!id||!barcode||barcode.length>70||/^CTH[0-9]{6}$/i.test(barcode))return bad(res,'Indica un código individual distinto de los códigos CTH de producto.');
 const c=await pool.getConnection();
 try{
  await c.beginTransaction();
  const [[p]]=await c.query('SELECT p.module_id,p.kind,p.active,i.stock_units,i.last_counted_at FROM products p LEFT JOIN inventory i ON i.product_id=p.id WHERE p.id=? FOR UPDATE',[id]);
  if(p?.kind!=='herramienta'||!p.active)throw invalid('Clasifica y activa primero el producto como herramienta.');
  requireArea(p.module_id,req.body.area);
  if(p.module_id===TALLER_ID){
   if(req.body.physical_verification!==true||!p.last_counted_at||p.stock_units==null)throw invalid('Confirma la existencia física de la herramienta y el conteo de la referencia.');
   const [[existing]]=await c.query("SELECT COUNT(*) total FROM tool_assets WHERE product_id=? AND asset_status<>'baja'",[id]);
   if(existing.total>=p.stock_units)throw invalid('Todas las unidades verificadas ya están identificadas.');
  }
  const [[duplicate]]=await c.query('SELECT id FROM products WHERE barcode=?',[barcode]);
  if(duplicate)throw invalid('El código ya está asignado a un producto.',409);
  const [r]=await c.query('INSERT INTO tool_assets(product_id,asset_barcode,description,asset_status) VALUES(?,?,?,?)',[id,barcode,String(req.body.description||'').slice(0,250),'disponible']);
  await audit(c,req.user.id,'crear_herramienta','tool_assets',r.insertId,{id,barcode,physical_verification:req.body.physical_verification===true});
  await c.commit();
  res.json({id:r.insertId});
 }catch(e){await c.rollback();throw e}finally{c.release()}
}));
app.post('/api/admin/tools/:id/validate',auth,admin,safe(async(req,res)=>{
 const id=integer(req.params.id),reason=typeof req.body.reason==='string'?req.body.reason.trim():'';
 if(!id||req.body.physical_verification!==true||reason.length<5||reason.length>255)return bad(res,'Confirma la verificación física e indica un motivo de 5 a 255 caracteres.');
 const c=await pool.getConnection();
 try{
  await c.beginTransaction();
  const [[asset]]=await c.query(`SELECT ta.product_id,ta.asset_status,p.module_id,p.kind,p.active,i.stock_units,i.last_counted_at
   FROM tool_assets ta JOIN products p ON p.id=ta.product_id LEFT JOIN inventory i ON i.product_id=p.id WHERE ta.id=? FOR UPDATE`,[id]);
  if(!asset)throw invalid('Herramienta no encontrada.',404);
  requireArea(asset.module_id,req.body.area);
  if(asset.kind!=='herramienta')throw invalid('La referencia no est? clasificada como herramienta.',409);
  if(['baja','prestada'].includes(asset.asset_status))throw invalid('La herramienta est? dada de baja o prestada.',409);
  if(asset.module_id===TALLER_ID&&(!asset.last_counted_at||!asset.stock_units))throw invalid('Primero registra el conteo físico de la referencia.',409);
  if(asset.active&&asset.asset_status==='disponible')throw invalid('La herramienta ya est? validada y disponible.',409);
  await c.query('UPDATE products SET active=1 WHERE id=?',[asset.product_id]);
  await c.query("UPDATE tool_assets SET asset_status='disponible' WHERE id=?",[id]);
  await audit(c,req.user.id,'validar_herramienta','tool_assets',id,{product_id:asset.product_id,physical_verification:true,reason,before:{active:Number(asset.active),asset_status:asset.asset_status},after:{active:1,asset_status:'disponible'}});
  await c.commit();
  res.json({ok:true,id,asset_status:'disponible'});
 }catch(e){await c.rollback();throw e}finally{c.release()}
}));
app.post('/api/loans',auth,safe(async(req,res)=>{
 const asset=integer(req.body.asset_id),requestId=String(req.body.request_id||'');
 if(!asset||!/^[0-9a-f-]{36}$/i.test(requestId))return bad(res,'Datos inválidos.');
 const c=await pool.getConnection();
 try{
  await c.beginTransaction();
  const [[tool]]=await c.query(`SELECT ta.asset_status,p.module_id,p.active,p.kind,i.stock_units,i.last_counted_at
   FROM tool_assets ta JOIN products p ON p.id=ta.product_id LEFT JOIN inventory i ON i.product_id=p.id WHERE ta.id=? FOR UPDATE`,[asset]);
  if(!tool)throw invalid('Herramienta no encontrada.',404);
  requireArea(tool.module_id,req.body.area);
  await requireTallerWorker(c,tool.module_id,req.user);
  const blockReason=loanBlockReason(tool);
  if(blockReason)throw invalid(blockReason,409);
  if(tool.module_id===TALLER_ID&&(!tool.last_counted_at||!tool.stock_units))throw invalid('La herramienta requiere conteo físico.',409);
  const [[prior]]=await c.query('SELECT id FROM loans WHERE asset_id=? AND (notes=? OR notes LIKE ?)',[asset,'Solicitud '+requestId,'Solicitud '+requestId+' · %']);
  if(prior)throw invalid('Este préstamo ya fue registrado.',409);
  await c.query("UPDATE tool_assets SET asset_status='prestada' WHERE id=?",[asset]);
  const notes=String(req.body.notes||'').trim().slice(0,255);
  const [insert]=await c.query('INSERT INTO loans(asset_id,borrower_id,loaned_by,notes) VALUES(?,?,?,?)',[asset,req.user.id,req.user.id,'Solicitud '+requestId+(notes?' · '+notes:'')]);
  await audit(c,req.user.id,'prestamo','loans',insert.insertId,{asset,notes});
  await c.commit();
  res.json({ok:true,id:insert.insertId});
 }catch(e){await c.rollback();throw e}finally{c.release()}
}));
app.post('/api/loans/:id/return',auth,safe(async(req,res)=>{
 const id=integer(req.params.id);
 if(!id)return bad(res,'Préstamo inválido.');
 const c=await pool.getConnection();
 try{
  await c.beginTransaction();
  const [[loan]]=await c.query(`SELECT l.asset_id,l.returned_at,l.borrower_id,p.module_id
   FROM loans l JOIN tool_assets t ON t.id=l.asset_id JOIN products p ON p.id=t.product_id
   WHERE l.id=? FOR UPDATE`,[id]);
  if(!loan||loan.returned_at)throw invalid('Préstamo inexistente o ya devuelto.',409);
  requireArea(loan.module_id,req.body.area);
  await requireTallerWorker(c,loan.module_id,req.user);
  if(loan.module_id===TALLER_ID&&req.user.role==='colaborador'&&Number(loan.borrower_id)!==Number(req.user.id))throw invalid('Solo el prestatario, un encargado o un administrador puede devolver esta herramienta.',403);
  const condition=String(req.body.condition||'Correcta').trim().slice(0,255)||'Correcta';
  const status=loan.module_id===TALLER_ID&&req.body.maintenance===true?'mantenimiento':'disponible';
  await c.query('UPDATE loans SET returned_at=NOW(),received_by=?,return_condition=? WHERE id=?',[req.user.id,condition,id]);
  await c.query('UPDATE tool_assets SET asset_status=? WHERE id=?',[status,loan.asset_id]);
  await audit(c,req.user.id,'devolucion','loans',id,{condition,asset_status:status});
  await c.commit();
  res.json({ok:true});
 }catch(e){await c.rollback();throw e}finally{c.release()}
}));
app.get('/api/export',auth,admin,safe(async(req,res)=>{const wb=new ExcelJS.Workbook();wb.creator='Inventario Cuarto de Valvulas';const sheet=(name,headers,rows)=>{const s=wb.addWorksheet(name);s.columns=headers.map(([header,key,width])=>({header,key,width}));s.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};s.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF183A53'}};for(const row of rows)s.addRow(row);s.autoFilter={from:'A1',to:s.getRow(1).getCell(headers.length).address};s.views=[{state:'frozen',ySplit:1}];return s};
 const area=req.query.area;
 if(area){
  const userId=req.query.user_id===undefined?null:integer(req.query.user_id);
  if(req.query.user_id!==undefined&&!userId)return bad(res,'Trabajador inválido.');
  const [products,moves]=await Promise.all([listAreaProducts(pool,area),listHistory(pool,area,{userId,limit:2147483647})]);
  const [loans]=await pool.query(`SELECT l.id,p.name product,t.asset_barcode,u.full_name collaborator,l.loaned_at,
   l.returned_at,l.return_condition,t.asset_status FROM loans l JOIN tool_assets t ON t.id=l.asset_id JOIN products p ON p.id=t.product_id
   JOIN users u ON u.id=l.borrower_id WHERE ${areaCondition(area)} ORDER BY l.id DESC`);
  sheet('Inventario',[['Ubicación','location',32],['Artículo','name',48],['SAP','sap_code',16],['Código de barras','barcode',19],
   ['Tipo','kind',16],['Activo','active',12],['Cantidad','stock_units',14],['Disponible','availability',32],
   ['Último responsable','last_worker',28],['Actualización','updated_at',24],['Mínimo','min_stock_units',13]],products);
  sheet('Movimientos',[['Fecha','created_at',24],['Tipo','movement_type',20],['Artículo','product',48],['Código de barras','barcode',19],
   ['Activo individual','asset_barcode',20],['Trabajador','collaborator',28],['Cantidad','quantity_units',14],
   ['Antes','stock_before',14],['Después','stock_after',14],['Observaciones','reason',40]],moves);
  sheet('Préstamos',[['Artículo','product',45],['Código individual','asset_barcode',20],['Prestatario','collaborator',28],
   ['Salida','loaned_at',24],['Devolución','returned_at',24],['Condición','return_condition',30],['Estado actual','asset_status',22]],loans);
  const overview=wb.addWorksheet('Dashboard');
  overview.addRows([['Área',area==='taller'?'Taller - Bodega de Herramientas':'Cuarto de Válvulas'],
   ['Referencias',products.length],['Cantidades desconocidas',products.filter(p=>p.stock_units===null).length],
   ['Movimientos exportados',moves.length],['Préstamos abiertos',loans.filter(l=>!l.returned_at).length]]);
  overview.getColumn(1).width=32;overview.getColumn(2).width=38;
  res.attachment(area==='taller'?'Inventario_Taller.xlsx':'Inventario_Cuarto_Valvulas.xlsx');
  await wb.xlsx.write(res);return res.end();
 }
 const [p]=await pool.query('SELECT m.name module,p.name,p.sap_code,p.barcode,p.kind,p.active,i.stock_units,i.original_pack_count,i.min_stock_units FROM products p JOIN modules m ON m.id=p.module_id JOIN inventory i ON i.product_id=p.id ORDER BY m.id,p.source_row');const [moves]=await pool.query('SELECT mv.id,mv.created_at,mv.movement_type,p.name product,u.full_name collaborator,mv.quantity_units,mv.stock_before,mv.stock_after,mv.reason FROM movements mv JOIN products p ON p.id=mv.product_id JOIN users u ON u.id=mv.user_id ORDER BY mv.created_at DESC LIMIT 10000');const [loans]=await pool.query('SELECT l.id,p.name product,t.asset_barcode,u.full_name collaborator,l.loaned_at,l.returned_at FROM loans l JOIN tool_assets t ON t.id=l.asset_id JOIN products p ON p.id=t.product_id JOIN users u ON u.id=l.borrower_id ORDER BY l.id DESC LIMIT 10000');
 sheet('Inventario',[['Modulo','module',18],['Producto','name',42],['SAP','sap_code',16],['Codigo barra','barcode',19],['Tipo','kind',15],['Activo','active',12],['Unidades','stock_units',15],['Paquetes origen','original_pack_count',17],['Minimo','min_stock_units',13]],p);
 sheet('Movimientos',[['ID','id',10],['Fecha','created_at',25],['Tipo','movement_type',20],['Producto','product',42],['Colaborador','collaborator',28],['Cantidad','quantity_units',14],['Antes','stock_before',14],['Despues','stock_after',14],['Motivo','reason',32]],moves);
 sheet('Prestamos',[['ID','id',10],['Producto','product',37],['Herramienta','asset_barcode',20],['Colaborador','collaborator',32],['Fecha salida','loaned_at',25],['Devuelto','returned_at',25]],loans);
 const dash=wb.addWorksheet('Dashboard');dash.getCell('A1').value='INVENTARIO - RESUMEN';dash.getCell('A1').font={bold:true,size:16};dash.addRow([]);dash.addRow(['Referencias','=COUNTA(Inventario!B2:B10000)']);dash.addRow(['Unidades registradas','=SUM(Inventario!G2:G10000)']);dash.addRow(['Sin conteo','=COUNTBLANK(Inventario!G2:G'+(p.length+1)+')']);dash.addRow(['Movimientos exportados',moves.length]);dash.addRow(['Prestamos abiertos',loans.filter(v=>!v.returned_at).length]);dash.getColumn(1).width=30;dash.getColumn(2).width=22;wb.worksheets.splice(0,0);res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="Inventario_Cuarto_Valvulas.xlsx"');await wb.xlsx.write(res);res.end();
}));
app.use((err,req,res,next)=>{if(err.status)return bad(res,err.message,err.status);if(err.code==='ER_DUP_ENTRY')return bad(res,'Código duplicado.',409);console.error(err.code||err.name);res.status(500).json({error:'Error del servidor. Revisa los registros.'})});
if(require.main===module){
 const port=Number(process.env.PORT||3000);
 app.listen(port,()=>console.log('Inventario disponible en http://localhost:'+port));
}
module.exports=app;
