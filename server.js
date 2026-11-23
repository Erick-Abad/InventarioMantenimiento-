require('dotenv').config();
const express=require('express');const helmet=require('helmet');const rateLimit=require('express-rate-limit');const jwt=require('jsonwebtoken');const bcrypt=require('bcryptjs');const crypto=require('crypto');const ExcelJS=require('exceljs');const path=require('path');const {pool}=require('./storage');const {searchProducts}=require('./product-search');const {loanBlockReason}=require('./public/tool-availability');const {listToolAssets}=require('./tool-inventory');const {registerAdminMovement}=require('./admin-movement');const {listActiveLoginUsers,identifyLoginUser,authenticateLogin}=require('./login-auth');
const {TALLER_ID,invalid,areaCondition,requireArea,requireTallerWorker,listHistory,listAreaProducts}=require('./inventory-area');
const {audit,transaction,idleSeconds,startSession,endSession,sessionUser,getMode,setMode,requireOperator}=require('./workshop-control');
const {optionalText,locationId,saveDetails,createProduct,catalogStructure,saveModule,saveLocation,importCatalog,excelHeaders}=require('./catalog-admin');
const {changeAssets,editAsset,barcodeSvg}=require('./asset-admin');
const app=express();app.disable('x-powered-by');app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:'32kb',type:req=>!req.path.startsWith('/api/admin/catalog/import')&&req.is('application/json')}));app.use(express.static(path.join(__dirname,'public')));
app.use('/vendor/zxing',express.static(path.join(__dirname,'node_modules','@zxing','browser','umd'),{index:false,maxAge:'1d'}));
const safe=(f)=>(req,res,next)=>Promise.resolve(f(req,res,next)).catch(next);
const bad=(res,msg,code=400)=>res.status(code).json({error:msg});
function signedSession(req){
 const header=req.headers.authorization||'';
 if(!header.startsWith('Bearer '))return null;
 try{return jwt.verify(header.slice(7),process.env.JWT_SECRET,{algorithms:['HS256']})}catch{return null}
}
const auth=safe(async(req,res,next)=>{
 const claims=signedSession(req);
 const user=claims&&await sessionUser(pool,claims);
 if(!user)return bad(res,'Sesión cerrada. Ingresa nuevamente.',401);
 req.user={...claims,...user};
 next();
});
const admin=(req,res,next)=>req.user.role==='administrador'?next():bad(res,'Solo administrador.',403);
const integer=(v)=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const uid=()=>crypto.randomUUID();
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.get('/api/health',safe(async(req,res)=>{
 await getMode(pool);
 await pool.query('SELECT 1 FROM app_sessions s,product_details p,inventory_locations l,tool_locations t,workshop_provisional_stock w LIMIT 0');
 res.json({ok:true,database:'connected'});
}));
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
  const sid=await startSession(pool,u);
  const token=jwt.sign({sid,id:u.id,credentialVerified},process.env.JWT_SECRET,{expiresIn:'8h',algorithm:'HS256'});
  res.json({token,user:{...u,credentialVerified},idleSeconds});
 }catch(e){if(e.status)return bad(res,e.message,e.status);throw e}
}));
app.post('/api/session/credential',auth,rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-7',legacyHeaders:false}),safe(async(req,res)=>{
 const barcode=typeof req.body.barcode==='string'?req.body.barcode.trim():'';
 if(!barcode||barcode.length>70)return bad(res,'Ingresa el código de tu credencial.');
 const [[account]]=await pool.query('SELECT role FROM users WHERE id=? AND employee_barcode=? AND active=1',[req.user.id,barcode]);
 if(!account||account.role!==req.user.role)return bad(res,'La credencial no corresponde a tu sesión activa.',403);
 const {sid,id,exp}=req.user;
 res.json({token:jwt.sign({sid,id,exp,credentialVerified:true},process.env.JWT_SECRET,{algorithm:'HS256'})});
}));
app.get('/api/session',auth,(req,res)=>{
 const {id,name,role,credentialVerified}=req.user;
 res.json({user:{id,name,role,credentialVerified},idleSeconds});
});
app.post('/api/logout',safe(async(req,res)=>{
 const claims=signedSession(req);
 if(claims?.sid)await endSession(pool,claims,req.body?.reason==='inactividad'?'inactividad':'salida');
 res.json({ok:true});
}));
app.get('/api/workshop/mode',auth,safe(async(req,res)=>res.json(await getMode(pool))));
app.patch('/api/admin/workshop/mode',auth,admin,safe(async(req,res)=>res.json(await setMode(pool,req.user,req.body.mode))));
function historyDate(value){
 if(value==null||value==='')return undefined;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw invalid('Fecha de historial inválida.');
 return value;
}
app.get('/api/history',auth,safe(async(req,res)=>{
 const userId=req.user.role!=='administrador'?req.user.id:req.query.user_id===undefined?null:integer(req.query.user_id);
 const page=req.query.page===undefined?1:integer(req.query.page);
 if(!page||page>100000||(req.query.user_id!==undefined&&!userId))return bad(res,'Página o trabajador inválido.');
 const {from,to,asset_barcode,location,module_id}=req.query;
 if((from&&to&&from>to)||(module_id&&!integer(module_id)))return bad(res,'Filtros de historial inválidos.');
 const rows=await listHistory(pool,req.query.area,{userId,from:historyDate(from),to:historyDate(to),assetBarcode:optionalText(asset_barcode,70,'Código individual'),
  location:optionalText(location,255,'Ubicación'),moduleId:integer(module_id),limit:26,offset:(page-1)*25});
 res.json({rows:rows.slice(0,25),hasMore:rows.length>25});
}));
app.get('/api/dashboard',auth,safe(async(req,res)=>{
 const area=req.query.area;
 if(area){
  const [products,recent,mode]=await Promise.all([listAreaProducts(pool,area),listHistory(pool,area,{userId:req.user.role==='administrador'?null:req.user.id}),getMode(pool)]);
  const modulesById=new Map(products.map(p=>[p.module_id,{id:p.module_id,name:p.module,inventory_status:p.inventory_status,products:0,units:null}]));
  for(const p of products){
   const module=modulesById.get(p.module_id);
   module.products++;
   if(p.stock_units!==null)module.units=(module.units??0)+Number(p.stock_units);
  }
  const [[toolCounts]]=await pool.query(`SELECT
   COUNT(CASE WHEN t.asset_status='disponible' AND p.active=1 AND p.kind='herramienta'
        AND (${area==='taller'?'(i.last_counted_at IS NOT NULL OR wps.product_id IS NOT NULL) AND i.stock_units>0':'1=1'})
        AND l.id IS NULL THEN 1 END) available,
   COUNT(l.id) loaned,COUNT(*) physical,
   COUNT(CASE WHEN t.asset_status='mantenimiento' THEN 1 END) maintenance,
   COUNT(CASE WHEN t.asset_status='baja' THEN 1 END) retired,
   COUNT(CASE WHEN l.due_at<NOW() THEN 1 END) overdue FROM tool_assets t JOIN products p ON p.id=t.product_id
   LEFT JOIN inventory i ON i.product_id=p.id LEFT JOIN workshop_provisional_stock wps ON wps.product_id=p.id
   LEFT JOIN loans l ON l.open_asset_id=t.id WHERE ${areaCondition(area)}`);
  const counted=products.filter(p=>p.stock_units!==null);
  const summary={products:products.length,units:counted.length?counted.reduce((sum,p)=>sum+Number(p.stock_units),0):null,
   uncounted:products.length-counted.length,
   pending:products.filter(p=>!p.active||p.kind==='pendiente'||(area==='taller'&&!p.last_counted_at)).length};
  const low=products.filter(p=>p.active&&p.kind==='consumible'&&p.stock_units!==null&&p.min_stock_units!==null&&p.stock_units<=p.min_stock_units);
  const [[[users]],[assetLocations]]=await Promise.all([pool.query('SELECT COUNT(*) total FROM users WHERE active=1'),
    pool.query(`SELECT DISTINCT al.name FROM tool_locations tl JOIN inventory_locations al ON al.id=tl.location_id
      JOIN tool_assets t ON t.id=tl.asset_id JOIN products p ON p.id=t.product_id WHERE ${areaCondition(area)}`)]);
  return res.json({summary,modules:[...modulesById.values()],loans:toolCounts.loaned,available:toolCounts.available,
    tools:toolCounts,active_users:users.total,mode,recent,low,
    locations:[...new Set([...products.map(product=>product.location),...assetLocations.map(row=>row.name)])].sort()});
 }
 const [[summary]]=await pool.query(`SELECT COUNT(*) AS products,SUM(p.barcode IS NOT NULL) AS barcodes,SUM(i.stock_units IS NULL) AS uncounted,COALESCE(SUM(i.stock_units),0) AS units FROM products p JOIN inventory i ON i.product_id=p.id`);
 const [mods]=await pool.query(`SELECT m.name,m.inventory_status,COUNT(p.id) AS products,COALESCE(SUM(i.stock_units),0) AS units FROM modules m LEFT JOIN products p ON p.module_id=m.id LEFT JOIN inventory i ON i.product_id=p.id GROUP BY m.id,m.name,m.inventory_status ORDER BY m.id`);
 const [[loans]]=await pool.query('SELECT COUNT(*) AS pending FROM loans WHERE returned_at IS NULL');
 const [recent]=await pool.query(`SELECT mv.id,mv.movement_type,mv.quantity_units,mv.created_at,p.name product,u.full_name collaborator FROM movements mv JOIN products p ON p.id=mv.product_id JOIN users u ON u.id=mv.user_id ${req.user.role==='administrador'?'':'WHERE mv.user_id=?'} ORDER BY mv.id DESC LIMIT 15`,req.user.role==='administrador'?[]:[req.user.id]);
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
app.get('/api/tools',auth,safe(async(req,res)=>{
 const tools=await listToolAssets(pool,req.query.area);
 res.json(req.user.role==='administrador'?tools:tools.map(({borrower,borrower_id,...tool})=>
   ({...tool,borrower:Number(borrower_id)===Number(req.user.id)?borrower:null})));
}));
app.get('/api/loans',auth,safe(async(req,res)=>{
 const scope=areaCondition(req.query.area);
 const [rows]=await pool.query(`SELECT l.id,l.asset_id,l.loaned_at,l.due_at,l.returned_at,l.borrower_id,
  u.full_name collaborator,t.asset_barcode,p.name product,t.asset_status,l.return_condition,p.module_id
  FROM loans l JOIN users u ON u.id=l.borrower_id JOIN tool_assets t ON t.id=l.asset_id JOIN products p ON p.id=t.product_id
  WHERE ${scope} ${req.user.role==='administrador'?'':'AND l.borrower_id=?'}
  ${req.query.area?'ORDER BY l.returned_at IS NULL DESC,l.id DESC':'ORDER BY l.id DESC LIMIT 150'}`,req.user.role==='administrador'?[]:[req.user.id]);
 res.json(rows);
}));
app.get('/api/workers',auth,admin,safe(async(req,res)=>{
 const [workers]=await pool.query('SELECT id,full_name,active FROM users ORDER BY full_name,id');
 res.json(workers);
}));
app.get('/api/users',auth,admin,safe(async(req,res)=>{const [rows]=await pool.query('SELECT id,full_name,employee_barcode,role,active FROM users ORDER BY full_name');res.json(rows)}));
app.get('/api/admin/audit',auth,admin,safe(async(req,res)=>{
 const before=req.query.before===undefined?null:integer(req.query.before);
 if(req.query.before!==undefined&&!before)return bad(res,'Página de auditoría inválida.');
 const [rows]=await pool.query(`SELECT a.id,a.action_name,a.entity_name,a.entity_id,a.details_json,a.created_at,u.full_name actor
  FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ${before?'WHERE a.id<?':''} ORDER BY a.id DESC LIMIT 26`,before?[before]:[]);
 res.json({rows:rows.slice(0,25),next:rows.length===26?rows[24].id:null});
}));
app.post('/api/admin/users',auth,admin,safe(async(req,res)=>{
 let {full_name,employee_barcode,password,role}=req.body;role=role||'colaborador';if(!full_name||!employee_barcode||typeof password!=='string'||password.length<10||!['colaborador','encargado','administrador'].includes(role))return bad(res,'Nombre, codigo y contrasena de 10 caracteres son obligatorios');
 const hash=await bcrypt.hash(password,12);const [r]=await pool.query('INSERT INTO users(full_name,employee_barcode,password_hash,role,active) VALUES(?,?,?,?,1)',[full_name.trim(),employee_barcode.trim(),hash,role]);await audit(pool,req.user.id,'crear_usuario','users',r.insertId,{full_name,role});res.status(201).json({id:r.insertId});
}));
app.patch('/api/admin/users/:id',auth,admin,safe(async(req,res)=>{
 const id=integer(req.params.id),role=req.body.role,active=req.body.active;
 if(!id||!['colaborador','encargado','administrador'].includes(role)||typeof active!=='boolean')return bad(res,'Rol o estado inválido.');
 if(id===req.user.id)return bad(res,'Otro administrador debe modificar tus permisos.');
 await transaction(pool,async db=>{
  const [[user]]=await db.query('SELECT role,active FROM users WHERE id=? FOR UPDATE',[id]);
  if(!user)throw invalid('Usuario inexistente.',404);
  await db.query('UPDATE users SET role=?,active=? WHERE id=?',[role,active?1:0,id]);
  await audit(db,req.user.id,'permisos_usuario','users',id,{before:user,after:{role,active}});
 });
 res.json({ok:true});
}));
app.get('/api/admin/catalog',auth,admin,safe(async(req,res)=>res.json(await catalogStructure(pool))));
app.post('/api/admin/products',auth,admin,safe(async(req,res)=>{
 const id=await transaction(pool,db=>createProduct(db,req.user.id,req.body));
 res.status(201).json({id});
}));
app.post('/api/admin/modules',auth,admin,safe(async(req,res)=>res.json({id:await saveModule(pool,req.user.id,req.body)})));
app.post('/api/admin/locations',auth,admin,safe(async(req,res)=>res.json({id:await saveLocation(pool,req.user.id,req.body)})));
app.post('/api/admin/catalog/import',auth,admin,express.json({limit:'2.1mb'}),safe(async(req,res)=>{
 if(!req.is('application/json'))throw invalid('Se requiere JSON.');
 res.json(await importCatalog(pool,req.user.id,req.body.file,req.body.apply===true));
}));
app.get('/api/admin/catalog/template',auth,admin,safe(async(req,res)=>{
 const [taller,valvulas,{modules}]=await Promise.all([listAreaProducts(pool,'taller'),listAreaProducts(pool,'valvulas'),catalogStructure(pool)]);
 const codes=new Map(modules.map(m=>[m.id,m.code]));
 const book=new ExcelJS.Workbook(), sheet=book.addWorksheet('Catálogo');
 sheet.addRow(excelHeaders).font={bold:true};
 sheet.columns.forEach(column=>{column.width=24});
 sheet.getColumn(3).width=55;
 for(const p of [...taller,...valvulas])if(p.barcode)sheet.addRow([codes.get(p.module_id),p.barcode,p.name,p.sap_code,p.kind,p.brand,p.model,p.measure,p.capacity,p.category,p.specifications]);
 sheet.views=[{state:'frozen',ySplit:1}];
 res.attachment('Catalogo_Editable.xlsx');
 await book.xlsx.write(res);
 res.end();
}));
app.patch('/api/admin/products/:id',auth,admin,safe(async(req,res)=>{
 const id=integer(req.params.id);const {name,sap_code,barcode,kind,active,units_per_pack,min_stock_units,notes}=req.body;
 if(!id||!['consumible','herramienta','pendiente'].includes(kind)||typeof name!=='string'||!name.trim()||typeof active!=='boolean')return bad(res,'Producto y clasificacion invalidos');
 const pp=units_per_pack===''||units_per_pack==null?null:Number(units_per_pack);if(pp!==null&&(!Number.isInteger(pp)||pp<=0))return bad(res,'Unidades por paquete debe ser entero positivo');
 const min=min_stock_units===''||min_stock_units==null?null:Number(min_stock_units);if(min!==null&&(!Number.isInteger(min)||min<0))return bad(res,'Minimo invalido');
 const c=await pool.getConnection();
 try{
  await c.beginTransaction();
  const [[product]]=await c.query(`SELECT p.module_id,p.barcode,p.active,p.kind,i.stock_units,i.last_counted_at,(wps.product_id IS NOT NULL) provisional_stock
   FROM products p LEFT JOIN inventory i ON i.product_id=p.id LEFT JOIN workshop_provisional_stock wps ON wps.product_id=p.id WHERE p.id=? FOR UPDATE`,[id]);
  if(!product)throw invalid('Producto inexistente.',404);
  requireArea(product.module_id,req.body.area);
  const code=String(barcode||'').trim()||null;
  let retiredAssets=[];
  if(active&&kind==='pendiente'&&(!product.active||product.kind!==kind))throw invalid('Clasifica el producto antes de habilitarlo.');
  if(product.barcode&&code!==product.barcode)throw invalid('Conserva los códigos existentes.');
  const provisionalTool=kind==='herramienta'&&product.provisional_stock;
  if(active&&!product.active&&(product.stock_units==null||!product.last_counted_at&&!provisionalTool))throw invalid('Registra y confirma el conteo físico antes de activar el producto.');
  if(product.module_id===TALLER_ID){
   if(code!==product.barcode)throw invalid('El código CTH está vinculado a la carga del Taller y debe conservarse.');
   if(active&&kind!=='pendiente'&&(product.stock_units==null||!product.last_counted_at&&!provisionalTool))throw invalid('Registra y confirma el conteo físico antes de activar el producto.');
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
  if(req.body.details!==undefined)await saveDetails(c,id,product.module_id,req.body.details);
  await audit(c,req.user.id,'editar_producto','products',id,{name,sap_code,barcode:code,kind,active,units_per_pack:pp,min_stock_units:min,retired_asset_ids:retiredAssets,details:req.body.details});
  await c.commit();
  res.json({ok:true});
 }catch(e){await c.rollback();throw e}finally{c.release()}
}));
function movementRequest(req, adminMovement){
 return {productId:req.body.product_id,userId:req.user.id,quantity:req.body.quantity_units,type:req.body.movement_type,
  reason:req.body.reason,requestId:req.body.request_id,area:req.body.area,user:req.user,adminMovement};
}
app.post('/api/movements',auth,admin,safe(async(req,res)=>{
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
  if(verified&&p.module_id===TALLER_ID)await c.query('DELETE FROM workshop_provisional_stock WHERE product_id=?',[id]);
  await audit(c,req.user.id,change?'ajuste_stock':'verificar_conteo','inventory',id,{before,after:n,reason,physical_verification:verified});
  await c.commit();
  res.json({ok:true,before,after:n});
 }catch(e){await c.rollback();throw e}finally{c.release()}
}));
app.post('/api/admin/tools',auth,admin,safe(async(req,res)=>{
 const productId=integer(req.body.product_id);
 const codes=Array.isArray(req.body.asset_barcodes)?req.body.asset_barcodes:[req.body.asset_barcode];
 const barcodes=codes.map(value=>typeof value==='string'?value.trim():'');
 if(!productId||!barcodes.length||barcodes.length>100||barcodes.some(code=>!/^[ -~]{1,70}$/.test(code)||/^CTH[0-9]{6}$/i.test(code))
    ||new Set(barcodes.map(code=>code.toUpperCase())).size!==barcodes.length)return bad(res,'Indica de 1 a 100 códigos individuales únicos, distintos de los CTH de producto.');
 if(req.body.physical_verification!==true)return bad(res,'Confirma las unidades físicas antes de registrarlas.');
 const ids=await transaction(pool,async c=>{
  const [[p]]=await c.query('SELECT p.module_id,p.kind,p.active,i.stock_units,i.last_counted_at FROM products p LEFT JOIN inventory i ON i.product_id=p.id WHERE p.id=? FOR UPDATE',[productId]);
  if(p?.kind!=='herramienta'||!p.active)throw invalid('Clasifica y activa primero el producto como herramienta.');
  requireArea(p.module_id,req.body.area);
  if(p.module_id===TALLER_ID){
   if(req.body.physical_verification!==true||!p.last_counted_at||p.stock_units==null)throw invalid('Confirma la existencia física de las unidades y el conteo de la referencia.');
   const [[existing]]=await c.query("SELECT COUNT(*) total FROM tool_assets WHERE product_id=? AND asset_status<>'baja'",[productId]);
   if(existing.total+barcodes.length>p.stock_units)throw invalid('Los códigos superan el número de unidades verificadas.');
  }
  const [[duplicate]]=await c.query('SELECT id FROM products WHERE barcode IN (?)',[barcodes]);
  if(duplicate)throw invalid('Un código ya está asignado a un producto.',409);
  const location=await locationId(c,p.module_id,req.body.location_id);
  const description=optionalText(req.body.description,250,'Descripción');
  const result=[];
  for(const barcode of barcodes){
   const [r]=await c.query('INSERT INTO tool_assets(product_id,asset_barcode,description,asset_status) VALUES(?,?,?,?)',[productId,barcode,description,'disponible']);
   if(location)await c.query('INSERT INTO tool_locations(asset_id,location_id) VALUES(?,?)',[r.insertId,location]);
   await audit(c,req.user.id,'crear_herramienta','tool_assets',r.insertId,{productId,barcode,location,physical_verification:req.body.physical_verification===true});
   result.push(r.insertId);
  }
  return result;
 });
 res.json({id:ids[0],ids});
}));
app.post('/api/admin/tools/status',auth,admin,safe(async(req,res)=>res.json(await changeAssets(pool,req.user.id,req.body))));
app.patch('/api/admin/tools/:id',auth,admin,safe(async(req,res)=>{
 const id=integer(req.params.id);
 if(!id)return bad(res,'Herramienta inválida.');
 res.json(await editAsset(pool,req.user.id,id,req.body));
}));
app.get('/api/admin/tools/:id/label',auth,admin,safe(async(req,res)=>{
 const [[asset]]=await pool.query('SELECT asset_barcode FROM tool_assets WHERE id=?',[integer(req.params.id)]);
 if(!asset)throw invalid('Herramienta inexistente.',404);
 res.type('image/svg+xml').send(barcodeSvg(asset.asset_barcode));
}));
app.get('/api/tools/:id/history',auth,safe(async(req,res)=>{
 const adminView=req.user.role==='administrador';
 const [rows]=await pool.query(`SELECT l.id,l.loaned_at,l.due_at,l.returned_at,l.return_condition,
   borrower.full_name borrower,issuer.full_name loaned_by,receiver.full_name received_by
  FROM loans l JOIN users borrower ON borrower.id=l.borrower_id
  JOIN users issuer ON issuer.id=l.loaned_by LEFT JOIN users receiver ON receiver.id=l.received_by
  WHERE l.asset_id=? ${adminView?'':'AND l.borrower_id=?'} ORDER BY l.id DESC LIMIT 200`,
  adminView?[integer(req.params.id)]:[integer(req.params.id),req.user.id]);
 res.json(rows);
}));
app.post('/api/admin/tools/:id/validate',auth,admin,safe(async(req,res)=>{
 const id=integer(req.params.id);
 if(!id)return bad(res,'Herramienta inválida.');
 await changeAssets(pool,req.user.id,{...req.body,ids:[id],status:'disponible',apply:true});
 res.json({ok:true,id,asset_status:'disponible'});
}));
app.post('/api/loans',auth,safe(async(req,res)=>{
 const assetId=integer(req.body.asset_id);
 const code=typeof req.body.asset_barcode==='string'?req.body.asset_barcode.trim():'';
 const requestId=String(req.body.request_id||'');
 const due=req.body.due_at==null||req.body.due_at===''?null:new Date(req.body.due_at);
 if((!assetId&&!code)||code.length>70||!UUID_PATTERN.test(requestId)||due&&(!Number.isFinite(+due)||due<=new Date()))return bad(res,'Código, solicitud o vencimiento inválido.');
 const id=await transaction(pool,async c=>{
  await requireOperator(c,req.user,req.body.employee_barcode);
  const [[tool]]=await c.query(`SELECT ta.id,ta.asset_status,p.module_id,p.active,p.kind,i.stock_units,i.last_counted_at,(wps.product_id IS NOT NULL) provisional_stock
   FROM tool_assets ta JOIN products p ON p.id=ta.product_id LEFT JOIN inventory i ON i.product_id=p.id
   LEFT JOIN workshop_provisional_stock wps ON wps.product_id=p.id
   WHERE ${assetId?'ta.id':'ta.asset_barcode'}=? FOR UPDATE`,[assetId||code]);
  if(!tool)throw invalid('Herramienta no encontrada.',404);
  requireArea(tool.module_id,req.body.area);
  const blockReason=loanBlockReason(tool);
  if(blockReason)throw invalid(blockReason,409);
  if(tool.module_id===TALLER_ID&&(!tool.stock_units||!tool.last_counted_at&&!tool.provisional_stock))throw invalid('La herramienta requiere conteo físico.',409);
  const [[open]]=await c.query('SELECT id FROM loans WHERE open_asset_id=? FOR UPDATE',[tool.id]);
  if(open)throw invalid('La herramienta ya tiene un préstamo abierto.',409);
  const [[prior]]=await c.query('SELECT id FROM loans WHERE asset_id=? AND (notes=? OR notes LIKE ?)',[tool.id,'Solicitud '+requestId,'Solicitud '+requestId+' · %']);
  if(prior)throw invalid('Este préstamo ya fue registrado.',409);
  let borrower=req.user.id;
  if(req.user.role==='administrador'&&req.body.borrower_id!=null){
   borrower=integer(req.body.borrower_id);
   const [[recipient]]=await c.query('SELECT id FROM users WHERE id=? AND active=1 FOR SHARE',[borrower]);
   if(!recipient)throw invalid('El prestatario debe ser un usuario activo.');
  }
  await c.query("UPDATE tool_assets SET asset_status='prestada' WHERE id=?",[tool.id]);
  const notes=String(req.body.notes||'').trim().slice(0,255);
  const [insert]=await c.query('INSERT INTO loans(asset_id,borrower_id,loaned_by,due_at,notes) VALUES(?,?,?,?,?)',
   [tool.id,borrower,req.user.id,due,'Solicitud '+requestId+(notes?' · '+notes:'')]);
  await audit(c,req.user.id,'prestamo','loans',insert.insertId,{asset:tool.id,borrower,due,notes});
  return insert.insertId;
 });
 res.json({ok:true,id});
}));
async function returnLoan(req,res){
 const id=integer(req.params.id);
 const code=typeof req.body.asset_barcode==='string'?req.body.asset_barcode.trim():'';
 if((!id&&!code)||code.length>70)return bad(res,'Préstamo o código inválido.');
 const result=await transaction(pool,async c=>{
  await requireOperator(c,req.user,req.body.employee_barcode);
  const [[loan]]=await c.query(`SELECT l.id,l.asset_id,l.returned_at,l.borrower_id,ta.asset_status,p.module_id
   FROM loans l JOIN tool_assets ta ON ta.id=l.asset_id JOIN products p ON p.id=ta.product_id
   WHERE ${id?'l.id=?':'ta.asset_barcode=? AND l.returned_at IS NULL'} FOR UPDATE`,[id||code]);
  if(!loan||loan.returned_at)throw invalid('Préstamo inexistente o ya devuelto.',409);
  requireArea(loan.module_id,req.body.area);
  if(req.user.role!=='administrador'&&Number(loan.borrower_id)!==Number(req.user.id))throw invalid('Solo el prestatario o el administrador puede devolver esta herramienta.',403);
  const condition=String(req.body.condition||'Correcta').trim().slice(0,255)||'Correcta';
  const status=['baja','mantenimiento'].includes(loan.asset_status)?loan.asset_status:req.body.maintenance===true?'mantenimiento':'disponible';
  await c.query('UPDATE loans SET returned_at=NOW(),received_by=?,return_condition=? WHERE id=?',[req.user.id,condition,loan.id]);
  await c.query('UPDATE tool_assets SET asset_status=? WHERE id=?',[status,loan.asset_id]);
  await audit(c,req.user.id,'devolucion','loans',loan.id,{condition,asset_status:status});
  return {ok:true,id:loan.id,asset_status:status};
 });
 res.json(result);
}
app.post('/api/loans/return-by-code',auth,safe(returnLoan));
app.post('/api/loans/:id/return',auth,safe(returnLoan));
app.get('/api/export',auth,admin,safe(async(req,res)=>{const wb=new ExcelJS.Workbook();wb.creator='Inventario Cuarto de Valvulas';const sheet=(name,headers,rows)=>{const s=wb.addWorksheet(name);s.columns=headers.map(([header,key,width])=>({header,key,width}));s.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};s.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF183A53'}};for(const row of rows)s.addRow(row);s.autoFilter={from:'A1',to:s.getRow(1).getCell(headers.length).address};s.views=[{state:'frozen',ySplit:1}];return s};
 const area=req.query.area;
 if(area){
  const userId=req.query.user_id===undefined?null:integer(req.query.user_id);
  if(req.query.user_id!==undefined&&!userId)return bad(res,'Trabajador inválido.');
  const [products,moves]=await Promise.all([listAreaProducts(pool,area),listHistory(pool,area,{userId,from:historyDate(req.query.from),to:historyDate(req.query.to),assetBarcode:optionalText(req.query.asset_barcode,70,'Código individual'),location:optionalText(req.query.location,255,'Ubicación'),moduleId:integer(req.query.module_id),limit:2147483647})]);
  const [loans]=await pool.query(`SELECT l.id,p.name product,t.asset_barcode,u.full_name collaborator,l.loaned_at,
   l.returned_at,l.return_condition,t.asset_status FROM loans l JOIN tool_assets t ON t.id=l.asset_id JOIN products p ON p.id=t.product_id
   JOIN users u ON u.id=l.borrower_id WHERE ${areaCondition(area)} ORDER BY l.id DESC`);
  sheet('Inventario',[['Ubicación','location',32],['Artículo','name',48],['SAP','sap_code',16],['Código de barras','barcode',19],
   ['Tipo','kind',16],['Activo','active',12],['Cantidad','stock_units',14],['Disponible','availability',32],
   ['Último responsable','last_worker',28],['Actualización','updated_at',24],['Mínimo','min_stock_units',13],
   ['Marca','brand',21],['Modelo','model',24],['Medida','measure',17],['Capacidad','capacity',20],['Categoría','category',25],['Especificaciones','specifications',40],['Conteo provisional','provisional_stock',20]],products.map(p=>({...p,provisional_stock:p.provisional_stock?'Sí':''})));
  sheet('Movimientos',[['Fecha','created_at',24],['Tipo','movement_type',20],['Artículo','product',48],['Código de barras','barcode',19],
   ['Activo individual','asset_barcode',20],['Ubicación','location',32],['Trabajador','collaborator',28],['Cantidad','quantity_units',14],
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
