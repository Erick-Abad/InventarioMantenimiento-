const $=id=>document.getElementById(id);let token=sessionStorage.getItem('invtoken')||'',me=JSON.parse(sessionStorage.getItem('invme')||'null'),products=[],assets=[],loans=[],selectedAssetId=null,stream=null,cameraControls=null,scanTimer=null,searchTimer=null,searchSequence=0,zxingLoadPromise=null,loginMethod='select',loginCodeTimer=null,loginIdentifySequence=0,identifiedScanCode='';
let area='valvulas',activeTab='dashboard',inventoryPage=1,toolPage=1,toolReferences=[],historyPage=1,historySequence=0,returnLoan=null;
let pickedTool=null;
let areaRevision=0,cameraRevision=0,movementPending=false,loanPending=false;
const areaNames={valvulas:'Cuarto de Válvulas',taller:'Taller - Bodega de Herramientas'};
const areaEndpoint=(endpoint,params={})=>endpoint+'?'+new URLSearchParams({area,...params});
const dateLabel=value=>value?new Date(value).toLocaleString('es-CO'):'—';
const countedUnits=value=>value===null?'Sin conteo':Number(value).toLocaleString('es-CO');
const operationLabels={entrada:'Entrada',consumo:'Retiro',ajuste_positivo:'Ajuste positivo',ajuste_negativo:'Ajuste negativo',conteo_fisico:'Conteo físico',prestamo:'Préstamo',devolucion:'Devolución'};
const scopedPost=(endpoint,data,method)=>post(endpoint,{...data,area},method);
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function notice(s){const t=$('toast');t.textContent=s;t.hidden=false;setTimeout(()=>t.hidden=true,4800)}
async function api(endpoint,options={}){const headers={...(options.headers||{}),Authorization:'Bearer '+token};if(options.body)headers['Content-Type']='application/json';const r=await fetch('/api'+endpoint,{...options,headers});if(r.status===401){logout();throw Error('Tu sesión venció')}if(!r.ok){const data=await r.json().catch(()=>({}));throw Error(data.error||'No se pudo completar la solicitud')}return endpoint.split('?')[0]==='/export'?r.blob():r.json()}
const post=(url,data,method='POST')=>api(url,{method,body:JSON.stringify(data)});
async function loadLoginUsers(){const response=await fetch('/api/login/users');const users=await response.json().catch(()=>[]);if(!response.ok)throw Error(users.error||'No se pudo cargar la lista de usuarios');$('login-user').innerHTML='<option value="">Selecciona tu nombre</option>'+users.map(user=>`<option value="${user.id}">${escapeHtml(user.full_name)}</option>`).join('')}
function setLoginMethod(method){loginMethod=method;const methods=['select','manual','scan'];for(const current of methods){$(`login-${current}-panel`).hidden=current!==method;const button=document.querySelector(`[data-login-method="${current}"]`);button.classList.toggle('selected',current===method);button.setAttribute('aria-selected',String(current===method))}$('login-user').required=method==='select';$('login-manual-code').required=method==='manual';$('login-scan-code').required=method==='scan';if(method!=='scan'){identifiedScanCode='';$('login-identify-message').textContent='El escaneo identifica tu usuario, pero no inicia sesión.';$('login-identify-message').className='login-feedback'}}
async function identifyLoginCode(value){const code=value.trim(),sequence=++loginIdentifySequence,feedback=$('login-identify-message');identifiedScanCode='';if(!code){feedback.textContent='Escanea o escribe el código de tu credencial.';feedback.className='login-feedback';return false}feedback.textContent='Buscando usuario…';feedback.className='login-feedback';try{const response=await fetch('/api/login/identify?barcode='+encodeURIComponent(code));const result=await response.json().catch(()=>({}));if(sequence!==loginIdentifySequence)return false;if(!response.ok)throw Error(result.error||'No se pudo identificar la credencial.');identifiedScanCode=code;feedback.textContent=`Credencial identificada: ${result.name}. Ingresa tu contraseña para continuar.`;feedback.className='login-feedback success';return true}catch(error){if(sequence!==loginIdentifySequence)return false;feedback.textContent=error.message;feedback.className='login-feedback error';return false}}
function logout(){stopCamera();areaRevision++;searchSequence++;historySequence++;sessionStorage.clear();token='';me=null;$('app').hidden=true;$('login').hidden=false;$('login-password').value='';loadLoginUsers().catch(e=>notice(e.message))}
function showApp(){if(!token||!me)return;const isAdmin=me.role==='administrador';$('login').hidden=true;$('app').hidden=false;$('identity').textContent=me.name+' · '+me.role;document.querySelectorAll('.admin-only').forEach(x=>x.hidden=!isAdmin);$('movement-reason').required=isAdmin;$('movement-reason').minLength=isAdmin?5:0;$('movement-reason-label').textContent=isAdmin?'Motivo administrativo':'Observaciones';selectArea('valvulas','dashboard')}
async function load(){
  const revision=areaRevision;
  const rows=await api(areaEndpoint('/products'));
  if(revision!==areaRevision)return;
  products=rows;
  setSelect('movement-product',products,'Selecciona un artículo');
  setSelect('edit-product',products);
  setSelect('adjust-product',products);
  setSelect('asset-product',products.filter(p=>p.kind==='herramienta'&&p.active));
  const options=[...new Set(products.map(p=>p.location))].sort((a,b)=>a.localeCompare(b,'es'));
  const location=$('module-filter'),selected=location.value;
  location.innerHTML='<option value="">Todas las ubicaciones</option>'+options.map(value=>`<option>${escapeHtml(value)}</option>`).join('');
  if(options.includes(selected))location.value=selected;
  filterProducts();
  updateEdit();
  updateAdjust();
  showProduct(products.find(p=>String(p.id)===$('movement-product').value));
}
function setSelect(id,rows,placeholder=''){
  const select=$(id),previous=select.value;
  select.innerHTML=(placeholder?`<option value="">${escapeHtml(placeholder)}</option>`:'')+
    rows.map(p=>`<option value="${p.id}">${escapeHtml(p.name)} ? ${escapeHtml(p.barcode||p.module)}</option>`).join('');
  if(rows.some(p=>String(p.id)===previous))select.value=previous;
}
function selectArea(next,tab=activeTab==='prestamos'?'prestamos':'inventario'){
  areaRevision++;searchSequence++;historySequence++;clearTimeout(searchTimer);stopCamera();
  area=next;products=[];assets=[];toolReferences=[];loans=[];selectedAssetId=null;pickedTool=null;inventoryPage=1;toolPage=1;historyPage=1;
  for(const id of ['filter','module-filter','inventory-kind','inventory-status','scan-product','asset-search','tool-module-filter','tool-status-filter','history-worker','movement-reason'])$(id).value='';
  $('worker-code').value='';$('loan-notes').value='';
  $('product-search-results').hidden=true;
  $('movement-type').value='consumo';
  for(const id of ['movement-product','edit-product','adjust-product','asset-product'])$(id).replaceChildren();
  showProduct(null);showAssetDetails(null);closeReturn();
  filterProducts();
  for(const id of ['tools-list','loans-list','tools-summary','kpis','modules','low-stock','recent'])$(id).replaceChildren();
  document.querySelectorAll('[data-area]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.area===area)));
  $('inventory-heading').textContent=area==='taller'?areaNames.taller:'Inventario del Cuarto de Válvulas';
  $('loans-heading').textContent='Herramientas y préstamos · '+areaNames[area];
  $('dashboard-heading').textContent='Panel de control ? '+areaNames[area];
  $('asset-verified-wrap').hidden=area!=='taller';
  $('asset-verified').required=area==='taller';
  $('asset-verified').checked=false;
  $('adjust-verified').checked=false;
  switchTab(tab);
}
function switchTab(tab){
  activeTab=tab;
  document.querySelectorAll('.tab').forEach(e=>e.hidden=e.id!==tab);
  document.querySelectorAll('nav button').forEach(button=>button.classList.toggle('selected',button.dataset.tab===tab));
  updateWorkerPanel();
  if(tab==='dashboard')dashboard().catch(e=>notice(e.message));
  if(['inventario','movimientos','admin'].includes(tab))load().catch(e=>notice(e.message));
  if(tab==='prestamos')refreshLoans();
  if(tab!=='prestamos')closeReturn();
  if(tab==='movimientos'||tab==='prestamos'){
    const code=area==='taller'&&!me?.credentialVerified?'worker-code':tab==='movimientos'?'scan-product':'asset-search';
    $(code).focus({preventScroll:true});
  }
}
function updateWorkerPanel(){
  const needsWorker=area==='taller'&&['movimientos','prestamos','admin'].includes(activeTab);
  $('worker-panel').hidden=!needsWorker;
  $('worker-form').hidden=Boolean(me?.credentialVerified);
  $('worker-feedback').textContent=me?.credentialVerified?`Credencial verificada · ${me.name}`:'';
}
async function confirmWorker(){
  const code=$('worker-code').value.trim();
  if(!code)return;
  const previousToken=token;
  const result=await post('/session/credential',{barcode:code});
  if(token!==previousToken||!me)return;
  token=result.token;me.credentialVerified=true;
  sessionStorage.setItem('invtoken',token);
  sessionStorage.setItem('invme',JSON.stringify(me));
  $('worker-code').value='';
  updateWorkerPanel();
  if(activeTab==='movimientos')$('scan-product').focus();
  if(activeTab==='prestamos')$('asset-search').focus();
}
function workerReady(){
  if(area!=='taller'||me?.credentialVerified)return true;
  notice('Confirma tu credencial para registrar operaciones en el Taller.');
  $('worker-code').focus();
  return false;
}
async function dashboard(){
  const revision=areaRevision;
  const [d,workers]=await Promise.all([api(areaEndpoint('/dashboard')),api('/workers')]);
  if(revision!==areaRevision)return;
  const stats=[['Referencias',d.summary.products],['Unidades contabilizadas',d.summary.units],
    ['Sin conteo',d.summary.uncounted],['Pendientes de validación',d.summary.pending],
    ['Herramientas prestadas',d.loans],['Herramientas disponibles',d.available]];
  $('kpis').innerHTML=stats.map(([label,value])=>`<div class="kpi"><span>${label}</span><strong>${countedUnits(value)}</strong></div>`).join('');
  $('modules').innerHTML=d.modules.map(x=>`<div class="module"><b>${escapeHtml(x.name)}</b><p class="small">${escapeHtml(x.inventory_status.replaceAll('_',' '))}</p><strong>${x.products}</strong><span> referencias</span><p>${x.units===null?'Sin conteo':countedUnits(x.units)+' unidades registradas'}</p></div>`).join('');
  $('low-stock').innerHTML=table(['Artículo','Código','Ubicación','Cantidad','Mínimo'],d.low.map(p=>[p.name,p.barcode||'—',p.location,p.stock_units,p.min_stock_units]));
  const selector=$('history-worker'),previous=selector.value;
  selector.innerHTML='<option value="">Todos los trabajadores</option>'+workers.map(w=>`<option value="${w.id}">${escapeHtml(w.full_name)}</option>`).join('');
  if(workers.some(w=>String(w.id)===previous))selector.value=previous;
  await renderHistory();
}
async function renderHistory(){
  const sequence=++historySequence,userId=$('history-worker').value,page=historyPage;
  const {rows,hasMore}=await api(areaEndpoint('/history',{page,...(userId?{user_id:userId}:{})}));
  if(sequence!==historySequence)return;
  $('recent').innerHTML=table(['Fecha','Trabajador','Artículo','Operación','Cantidad','Observaciones'],
    rows.map(x=>[dateLabel(x.created_at),x.collaborator||'—',x.asset_barcode?`${x.product} (${x.asset_barcode})`:x.product,
      operationLabels[x.movement_type]||x.movement_type,x.quantity_units,x.reason||'—']));
  $('history-prev').disabled=page===1;
  $('history-next').disabled=!hasMore;
  $('history-page').textContent=`Página ${page}`;
}
function table(headers,rows){return '<div class="table-wrap"><table><thead><tr>'+headers.map(h=>'<th>'+escapeHtml(h)+'</th>').join('')+'</tr></thead><tbody>'+ (rows.length?rows.map(row=>'<tr>'+row.map(c=>'<td>'+escapeHtml(c)+'</td>').join('')+'</tr>').join(''):'<tr><td colspan="'+headers.length+'">No hay datos registrados</td></tr>')+'</tbody></table></div>'}
function filterProducts(reset=false){
  if(reset)inventoryPage=1;
  const q=$('filter').value.trim().toLowerCase(),location=$('module-filter').value;
  const kind=$('inventory-kind').value,status=$('inventory-status').value;
  const statusMatches={
    active:p=>p.active,inactive:p=>!p.active,unknown:p=>p.stock_units===null,
    available:p=>p.availability.startsWith('Disponible'),loaned:p=>p.availability==='Prestada'
  };
  const matches=products.filter(p=>(!location||p.location===location)&&(!kind||p.kind===kind)
    &&(!status||statusMatches[status](p))&&[p.name,p.sap_code,p.barcode,p.location].some(v=>String(v??'').toLowerCase().includes(q)));
  const size=25,pages=Math.max(1,Math.ceil(matches.length/size));
  inventoryPage=Math.min(inventoryPage,pages);
  const start=(inventoryPage-1)*size;
  $('product-list').innerHTML=table(['Código de barras','Artículo','SAP','Cantidad','Ubicación','Tipo','Estado','Disponibilidad','Último responsable','Actualización'],
    matches.slice(start,start+size).map(p=>[p.barcode||'—',p.name,p.sap_code||'—',p.stock_units??'Sin conteo',
      p.location_validated?p.location:p.location+' (según registro)',p.kind,p.active?'Activo':'Por validar',p.availability,p.last_worker||'—',dateLabel(p.updated_at)]));
  $('inventory-page').textContent=`Página ${inventoryPage} de ${pages} · ${matches.length} referencias`;
  $('inventory-prev').disabled=inventoryPage===1;
  $('inventory-next').disabled=inventoryPage===pages;
}
function updateEdit(){
  const p=products.find(x=>String(x.id)===$('edit-product').value);
  for(const [key,val] of [['name',p?.name],['sap',p?.sap_code],['barcode',p?.barcode],['kind',p?.kind],['pack',p?.units_per_pack],['min',p?.min_stock_units],['notes',p?.notes]])$('edit-'+key).value=val??'';
  $('edit-barcode').readOnly=area==='taller';
  $('edit-active').checked=!!p?.active;
  $('edit-retire-assets').checked=false;
  updateRetireAssets(p);
}
function updateRetireAssets(product=products.find(p=>String(p.id)===$('edit-product').value)){
  const visible=area==='taller'&&product?.kind==='herramienta'&&$('edit-kind').value!=='herramienta';
  $('edit-retire-assets-wrap').hidden=!visible;
  if(!visible)$('edit-retire-assets').checked=false;
}
function updateAdjust(){
  const p=products.find(x=>String(x.id)===$('adjust-product').value);
  $('adjust-verified').checked=false;
  $('adjust-verified').required=Boolean(p&&(!p.last_counted_at||p.stock_units===null));
  $('adjust-stock').value=p?.stock_units??'';
}
function movementAllowed(p){
  if(!p||p.kind!=='consumible'||p.stock_units===null)return false;
  if(area==='taller')return Boolean(p.active&&p.last_counted_at);
  return Boolean(p.active||me?.role==='administrador'&&$('movement-type').value==='entrada');
}
function showProduct(p){
  const box=$('selected-product-details');
  $('movement-form').querySelector('button[type=submit]').disabled=movementPending||!movementAllowed(p);
  if(!p){box.hidden=true;box.innerHTML='';return}
  const stock=p.stock_units===null?'Sin conteo':`${Number(p.stock_units).toLocaleString('es-CO')} unidades`;
  const status=p.kind==='pendiente'?'Pendiente de clasificación':p.active?'Activo':'Inactivo';
  const fields=[['Ubicación',p.location||p.module],['Código de barras',p.barcode||'—'],['SAP',p.sap_code||'—'],
    ['Existencias',stock],['Tipo',p.kind],['Estado',status],['Disponibilidad',p.availability||'—'],
    ['Último responsable',p.last_worker||'—'],['Actualización',dateLabel(p.updated_at)]];
  box.hidden=false;
  box.innerHTML=`<strong>${escapeHtml(p.name)}</strong><dl>${fields.map(([key,value])=>`<div><dt>${key}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
  if(p.kind==='herramienta')box.innerHTML+='<button type="button" id="open-product-tools">Ver herramientas individuales</button>';
  else if(!movementAllowed(p))box.innerHTML+='<p class="small">Para esta operación se requiere un consumible habilitado con stock verificado.</p>';
}
function selectMovementProduct(p){
  const current=products.find(row=>row.id===p.id)||p;
  const select=$('movement-product');
  if(![...select.options].some(option=>option.value===String(p.id)))select.add(new Option(p.name,p.id));
  select.value=String(p.id);
  showProduct(current);
}
function renderProductMatches(matches,query){const results=$('product-search-results');const barcode=matches.find(p=>p.barcode?.toUpperCase()===query.toUpperCase());const exact=barcode?[barcode]:matches.filter(p=>p.sap_code===query);if(exact.length===1){selectMovementProduct(exact[0]);results.hidden=true;results.innerHTML='';return}if(!matches.length){showProduct(null);$('movement-product').value='';results.hidden=false;results.innerHTML='<p class="small">No se encontró ningún producto con ese código o búsqueda en esta área.</p>';return}if(matches.length===1){selectMovementProduct(matches[0]);results.hidden=true;results.innerHTML='';return}showProduct(null);$('movement-product').value='';results.hidden=false;results.innerHTML=matches.map(p=>`<button type="button" class="search-result" role="option" data-search-product="${p.id}"><strong>${escapeHtml(p.name)}</strong><span>${escapeHtml(p.module)} · Código ${escapeHtml(p.barcode||'—')} · SAP ${escapeHtml(p.sap_code||'—')}</span><span>${p.stock_units===null?'Stock desconocido':escapeHtml(p.stock_units+' unidades')} · ${escapeHtml(p.kind)} · ${p.active?'Activo':'Inactivo'}</span></button>`).join('')}
async function searchProducts(value=$('scan-product').value){const query=value.trim(),results=$('product-search-results'),sequence=++searchSequence;if(!query){results.hidden=true;results.innerHTML='';$('movement-product').value='';showProduct(null);return}showProduct(null);$('movement-product').value='';results.hidden=false;results.innerHTML='<p class="small">Buscando en el inventario…</p>';try{const matches=await api(areaEndpoint('/products/search',{q:query}));if(sequence!==searchSequence)return;renderProductMatches(matches,query)}catch(e){if(sequence!==searchSequence)return;results.hidden=false;results.innerHTML=`<p class="small">${escapeHtml(e.message)}</p>`}}
function scheduleProductSearch(){clearTimeout(searchTimer);const query=$('scan-product').value.trim();if(!query){searchProducts('');return}searchTimer=setTimeout(()=>searchProducts(query),250)}
function assetAvailability(asset){
  const reason=ToolAvailability.loanBlockReason(asset);
  if(!Number(asset?.active))return{available:false,label:'Pendiente de validación',reason};
  if(asset.loaned_at)return{available:false,label:'Prestada',reason:'La herramienta tiene un préstamo abierto.'};
  if(reason){
    const labels={prestada:'Prestada',mantenimiento:'Mantenimiento',baja:'Dada de baja'};
    return{available:false,label:asset.kind==='herramienta'?labels[asset.asset_status]||'No disponible':'Clasificación incorrecta',reason};
  }
  if(area==='taller'&&(!asset.last_counted_at||!Number(asset.stock_units))){
    return{available:false,label:'Pendiente de conteo',reason:'La referencia requiere un conteo físico con existencias.'};
  }
  return{available:true,label:'Disponible',reason:'Lista para préstamo.'};
}
function referenceStatus(reference){
  if(reference.kind==='pendiente')return 'Pendiente de clasificación';
  if(!reference.active)return 'Pendiente de validación';
  return 'Sin activo individual';
}
function renderTools(resetPage=false){
  if(resetPage){toolPage=1;pickedTool=null}
  const query=$('asset-search').value.trim();
  const rows=ToolAvailability.filterToolAssets([...assets,...toolReferences],{
    query,location:$('tool-module-filter').value,status:$('tool-status-filter').value
  });
  const code=query.toUpperCase();
  const selected=pickedTool
    ?(pickedTool.is_reference?toolReferences:assets).find(row=>row.id===pickedTool.id)
    :assets.find(asset=>asset.asset_barcode.toUpperCase()===code)
      ??toolReferences.find(row=>row.product_barcode?.toUpperCase()===code);
  const available=assets.filter(asset=>assetAvailability(asset).available).length;
  const pending=assets.filter(asset=>!Number(asset.active)).length;
  $('tools-summary').textContent=area==='taller'
    ?`${toolReferences.length} referencias sin activo individual · ${assets.length} activos registrados · ${available} disponibles para préstamo`
    :`${assets.length} herramientas o conjuntos · ${pending} pendientes de validación · ${available} disponibles para préstamo`;
  const pageSize=25,pages=Math.max(1,Math.ceil(rows.length/pageSize));
  toolPage=Math.min(toolPage,pages);
  const start=(toolPage-1)*pageSize;
  const visible=rows.slice(start,start+pageSize);
  const list=$('tools-list');
  list.innerHTML=table(['Acción','Producto','Ubicación','Código individual / conjunto','SAP','Código de barras del producto','Estado registrado','Préstamo'],
    visible.map(row=>{
      const fields=['',row.name,row.location,row.asset_barcode||'—',row.sap_code||'—',row.product_barcode||'—'];
      if(row.is_reference)return [...fields,referenceStatus(row),'No habilitado'];
      const storedStatus=row.asset_status==='mantenimiento'&&!Number(row.active)?'Mantenimiento (estado temporal registrado)':row.asset_status;
      return [...fields,storedStatus,assetAvailability(row).label];
    }));
  visible.forEach((row,index)=>{
    const button=document.createElement('button');
    button.type='button';
    button.textContent='Escoger';
    button.setAttribute('aria-label',`Escoger ${row.name} · ${row.asset_barcode||row.product_barcode||row.location}`);
    button.setAttribute('aria-pressed',String(row===selected));
    button.addEventListener('click',()=>{
      pickedTool=row;
      renderTools();
      $('asset-details').focus();
    });
    list.querySelector('tbody').rows[index].firstElementChild.append(button);
  });
  $('tools-page').textContent=`Página ${toolPage} de ${pages} · ${rows.length} resultados`;
  $('tools-prev').disabled=toolPage===1;
  $('tools-next').disabled=toolPage===pages;
  const asset=selected?.is_reference?null:selected;
  selectedAssetId=asset?.id??null;
  if(selected?.is_reference)showToolReference(selected);
  else showAssetDetails(asset);
  $('loan-asset').disabled=loanPending||!asset||!assetAvailability(asset).available;
  const open=asset&&loans.find(loan=>loan.asset_id===asset.id&&!loan.returned_at);
  $('return-asset').hidden=!open||!canReturn(open);
  $('return-asset').onclick=()=>openReturn(open);
}
function showToolReference(reference){
  const box=$('asset-details');
  box.hidden=false;
  box.innerHTML=`<strong>${escapeHtml(reference.name)}</strong><dl>
    <div><dt>Ubicación</dt><dd>${escapeHtml(reference.location)}</dd></div>
    <div><dt>Código de producto</dt><dd>${escapeHtml(reference.product_barcode)}</dd></div>
    <div><dt>Cantidad</dt><dd>${escapeHtml(reference.stock_units??'Sin conteo')}</dd></div>
    <div><dt>Estado</dt><dd>${referenceStatus(reference)}</dd></div>
    </dl><p class="small">El préstamo requiere una unidad física validada con código individual.</p>`;
}
function showAssetDetails(a){const box=$('asset-details');if(!a){box.hidden=true;box.innerHTML='';return}const availability=assetAvailability(a),storedStatus=a.asset_status==='mantenimiento'&&!Number(a.active)?'Mantenimiento (estado temporal registrado)':a.asset_status;const validationForm=me?.role==='administrador'&&(!Number(a.active)||area==='taller'&&a.asset_status==='mantenimiento')&&!['baja','prestada'].includes(a.asset_status)?`<form id="validate-asset-form" data-asset-id="${a.id}"><label class="check"><input type="checkbox" name="physical_verification" required> Confirmo que verifiqué físicamente el conjunto y su ubicación.</label><label>Motivo / observación de validación<textarea name="reason" rows="2" required minlength="5" placeholder="Indica qué se verificó"></textarea></label><button class="primary" type="submit">Validar y habilitar esta herramienta</button></form>`:'';box.hidden=false;box.innerHTML=`<strong>${escapeHtml(a.name)}</strong><dl><div><dt>Ubicación</dt><dd>${escapeHtml(a.location||a.module)}</dd></div><div><dt>Código de herramienta/conjunto</dt><dd>${escapeHtml(a.asset_barcode)}</dd></div><div><dt>Código de barras del producto</dt><dd>${escapeHtml(a.product_barcode||'—')}</dd></div><div><dt>Código SAP</dt><dd>${escapeHtml(a.sap_code||'—')}</dd></div><div><dt>Estado registrado</dt><dd>${escapeHtml(storedStatus)}</dd></div><div><dt>Disponibilidad</dt><dd>${escapeHtml(availability.label)}</dd></div>${a.borrower?`<div><dt>En poder de</dt><dd>${escapeHtml(a.borrower)}</dd></div><div><dt>Fecha de préstamo</dt><dd>${escapeHtml(dateLabel(a.loaned_at))}</dd></div>`:''}</dl><p class="small">${escapeHtml(availability.reason)}</p>${a.description?`<p class="small">Descripción: ${escapeHtml(a.description)}</p>`:''}${validationForm}`}
function canReturn(loan){
  return !!loan&&!loan.returned_at&&(area!=='taller'||me?.role!=='colaborador'||Number(me.id)===Number(loan.borrower_id));
}
function openReturn(loan){
  if(!canReturn(loan)||!workerReady())return;
  returnLoan=loan;
  $('return-title').textContent='Devolver '+loan.asset_barcode;
  $('return-condition').value='Correcta';
  $('return-maintenance').checked=false;
  $('return-maintenance-wrap').hidden=area!=='taller';
  $('return-form').hidden=false;
  $('return-condition').focus();
}
function closeReturn(){
  returnLoan=null;
  $('return-form').hidden=true;
  $('return-asset').hidden=true;
}
async function refreshLoans(){
  const revision=areaRevision;
  try{
    const result=await Promise.all([api(areaEndpoint('/tools')),api(areaEndpoint('/loans')),
      area==='taller'?api(areaEndpoint('/products')):[]]);
    if(revision!==areaRevision)return;
    [assets,loans]=result;
    toolReferences=ToolAvailability.workshopToolReferences(result[2],assets);
    const moduleFilter=$('tool-module-filter'),selectedModule=moduleFilter.value;
    const locations=[...new Set([...assets,...toolReferences].map(row=>row.location))].sort((a,b)=>a.localeCompare(b,'es'));
    moduleFilter.innerHTML='<option value="">Todas las ubicaciones</option>'+locations.map(location=>`<option>${escapeHtml(location)}</option>`).join('');
    if(locations.includes(selectedModule))moduleFilter.value=selectedModule;
    renderTools();
    $('loans-list').innerHTML='<div class="table-wrap"><table><thead><tr><th>Herramienta</th><th>Prestatario</th><th>Salida</th><th>Devolución</th><th>Condición</th><th>Estado actual</th><th>Acción</th></tr></thead><tbody>'+
      (loans.length?loans.map(l=>`<tr><td>${escapeHtml(l.asset_barcode)}</td><td>${escapeHtml(l.collaborator)}</td><td>${escapeHtml(dateLabel(l.loaned_at))}</td><td>${escapeHtml(dateLabel(l.returned_at))}</td><td>${escapeHtml(l.return_condition||'—')}</td><td>${escapeHtml(l.asset_status)}</td><td>${canReturn(l)?`<button type="button" data-return="${l.id}">Devolver</button>`:'—'}</td></tr>`).join(''):'<tr><td colspan="7">No hay préstamos registrados</td></tr>')+'</tbody></table></div>';
  }catch(e){if(revision===areaRevision)notice(e.message)}
}
function finishScan(dest,code){
  $(dest).value=code;
  stopCamera();
  if(dest==='login-scan-code')identifyLoginCode(code);
  else if(dest==='worker-code')confirmWorker().catch(e=>notice(e.message));
  else if(dest==='scan-product')searchProducts(code);
  else renderTools(true);
}
function loadZXing(){if(window.ZXingBrowser)return Promise.resolve();if(!zxingLoadPromise)zxingLoadPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/vendor/zxing/zxing-browser.min.js';script.onload=resolve;script.onerror=()=>{zxingLoadPromise=null;reject(Error('No se pudo cargar el lector de cámara. Usa un lector USB o escribe el código.'))};document.head.appendChild(script)});return zxingLoadPromise}
async function scanWithZXing(dest,revision){
  await loadZXing();
  if(revision!==cameraRevision)return;
  if(!window.ZXingBrowser?.BrowserMultiFormatReader)throw Error('El lector de cámara no pudo iniciarse.');
  $('camera-help').textContent='Mantén el código dentro del recuadro.';
  const reader=new ZXingBrowser.BrowserMultiFormatReader();
  const controls=await reader.decodeFromConstraints({video:{facingMode:{ideal:'environment'}},audio:false},$('camera-video'),result=>{
    if(result&&revision===cameraRevision)finishScan(dest,result.getText());
  });
  if(revision===cameraRevision)cameraControls=controls;
  else controls.stop();
}
async function scanWithNativeDetector(dest,revision){
  const supported=await BarcodeDetector.getSupportedFormats();
  if(revision!==cameraRevision||!supported.includes('code_128'))return false;
  const formats=['code_128','code_39','ean_13','ean_8','qr_code'].filter(format=>supported.includes(format));
  const current=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
  if(revision!==cameraRevision){current.getTracks().forEach(track=>track.stop());return false}
  stream=current;
  $('camera-video').srcObject=stream;
  await $('camera-video').play();
  if(revision!==cameraRevision)return false;
  const detector=new BarcodeDetector({formats});
  $('camera-help').textContent='Apunta la cámara al código de barras.';
  const tick=async()=>{
    if(revision!==cameraRevision)return;
    try{
      const codes=await detector.detect($('camera-video'));
      if(revision!==cameraRevision)return;
      if(codes.length){finishScan(dest,codes[0].rawValue);return}
      scanTimer=setTimeout(tick,250);
    }catch{
      if(revision!==cameraRevision)return;
      stream?.getTracks().forEach(track=>track.stop());
      stream=null;
      scanWithZXing(dest,revision).catch(e=>{if(revision===cameraRevision){stopCamera();notice(e.message)}});
    }
  };
  scanTimer=setTimeout(tick,300);
  return true;
}
async function camera(dest){
  if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){notice('Usa HTTPS y permite acceso a la cámara, o utiliza un lector USB.');return}
  stopCamera();
  const revision=cameraRevision;
  $('camera-modal').hidden=false;
  $('camera-help').textContent='Iniciando cámara…';
  try{
    if('BarcodeDetector'in window&&BarcodeDetector.getSupportedFormats){
      try{if(await scanWithNativeDetector(dest,revision))return}
      catch{if(revision===cameraRevision){stream?.getTracks().forEach(track=>track.stop());stream=null}}
    }
    if(revision===cameraRevision)await scanWithZXing(dest,revision);
  }catch(e){if(revision===cameraRevision){stopCamera();notice('No se pudo iniciar la cámara: '+e.message)}}
}
function stopCamera(){
  cameraRevision++;
  clearTimeout(scanTimer);scanTimer=null;
  cameraControls?.stop();cameraControls=null;
  stream?.getTracks().forEach(track=>track.stop());stream=null;
  $('camera-video').srcObject=null;
  $('camera-modal').hidden=true;
}
$('camera-close').onclick=stopCamera;$('camera-product').onclick=()=>camera('scan-product');$('camera-asset').onclick=()=>camera('asset-search');$('login-camera').onclick=()=>camera('login-scan-code');$('logout').onclick=logout;
document.querySelectorAll('[data-login-method]').forEach(button=>button.onclick=()=>setLoginMethod(button.dataset.loginMethod));
$('login-scan-code').oninput=()=>{identifiedScanCode='';loginIdentifySequence++;clearTimeout(loginCodeTimer);const code=$('login-scan-code').value.trim();if(!code){$('login-identify-message').textContent='El escaneo identifica tu usuario, pero no inicia sesión.';$('login-identify-message').className='login-feedback';return}$('login-identify-message').textContent='';loginCodeTimer=setTimeout(()=>identifyLoginCode(code),350)};
$('login-scan-code').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();clearTimeout(loginCodeTimer);identifyLoginCode($('login-scan-code').value)}};
$('login-form').onsubmit=async e=>{e.preventDefault();try{let credentials={password:$('login-password').value};if(loginMethod==='select'){if(!$('login-user').value)throw Error('Selecciona tu nombre de la lista.');credentials.user_id=Number($('login-user').value)}else if(loginMethod==='manual'){credentials.barcode=$('login-manual-code').value.trim()}else{const code=$('login-scan-code').value.trim();if(!code)throw Error('Escanea o escribe el código de tu credencial.');if(identifiedScanCode!==code&&!await identifyLoginCode(code))throw Error('No se pudo identificar el código. Revisa la credencial e inténtalo nuevamente.');credentials.barcode=code}const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});const result=await response.json().catch(()=>({}));if(!response.ok)throw Error(result.error||'No se pudo iniciar sesión.');token=result.token;me=result.user;sessionStorage.setItem('invtoken',token);sessionStorage.setItem('invme',JSON.stringify(me));$('login-password').value='';showApp()}catch(ex){$('login-password').value='';notice(ex.message)}};
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
document.querySelectorAll('[data-area]').forEach(button=>button.onclick=()=>{if(button.dataset.area!==area)selectArea(button.dataset.area)});
$('filter').oninput=()=>filterProducts(true);
for(const id of ['module-filter','inventory-kind','inventory-status'])$(id).onchange=()=>filterProducts(true);
$('inventory-prev').onclick=()=>{inventoryPage--;filterProducts()};
$('inventory-next').onclick=()=>{inventoryPage++;filterProducts()};
function changeHistoryPage(page){historyPage=page;renderHistory().catch(e=>notice(e.message))}
$('history-prev').onclick=()=>changeHistoryPage(historyPage-1);
$('history-next').onclick=()=>changeHistoryPage(historyPage+1);
$('history-worker').onchange=()=>changeHistoryPage(1);
$('worker-camera').onclick=()=>camera('worker-code');
$('worker-form').onsubmit=e=>{e.preventDefault();confirmWorker().catch(ex=>notice(ex.message))};
$('adjust-product').onchange=updateAdjust;
$('selected-product-details').onclick=e=>{
  if(e.target.id!=='open-product-tools')return;
  const product=products.find(p=>String(p.id)===$('movement-product').value);
  if(!product)return;
  $('asset-search').value=product.barcode||product.name;
  switchTab('prestamos');
};

$('scan-product').oninput=scheduleProductSearch;$('scan-product').onchange=()=>searchProducts();$('scan-product').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();clearTimeout(searchTimer);searchProducts()}};$('find-product').onclick=()=>{clearTimeout(searchTimer);searchProducts()};$('product-search-results').onclick=e=>{const btn=e.target.closest('[data-search-product]');if(!btn)return;const p=products.find(x=>String(x.id)===btn.dataset.searchProduct);if(p)selectMovementProduct(p);$('product-search-results').hidden=true};
$('asset-search').oninput=()=>renderTools(true);
$('asset-search').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();renderTools(true)}};
$('tool-module-filter').onchange=$('tool-status-filter').onchange=()=>renderTools(true);
$('tools-prev').onclick=()=>{toolPage--;renderTools()};
$('tools-next').onclick=()=>{toolPage++;renderTools()};
$('asset-details').onsubmit=async e=>{if(e.target.id!=='validate-asset-form')return;e.preventDefault();const form=e.target;if(!form.elements.physical_verification.checked)return notice('Confirma primero la verificación física.');if(!confirm('Se habilitará solo esta herramienta/conjunto verificado. ¿Continuar?'))return;try{await scopedPost('/admin/tools/'+form.dataset.assetId+'/validate',{physical_verification:true,reason:form.elements.reason.value.trim()});notice('Herramienta validada y habilitada');await Promise.all([load(),refreshLoans()])}catch(ex){notice(ex.message)}};
$('movement-type').onchange=$('movement-product').onchange=()=>showProduct(products.find(p=>String(p.id)===$('movement-product').value));
$('movement-form').onsubmit=async e=>{
  e.preventDefault();
  if(movementPending||!workerReady())return;
  const p=products.find(x=>String(x.id)===$('movement-product').value);
  const isAdmin=me.role==='administrador',reason=$('movement-reason').value.trim();
  if(!movementAllowed(p))return notice('Selecciona un consumible habilitado con stock verificado.');
  if(isAdmin&&reason.length<5)return notice('Indica un motivo de al menos 5 caracteres.');
  if(!confirm('¿Confirmar movimiento de inventario?'))return;
  const revision=areaRevision;
  movementPending=true;
  showProduct(p);
  try{
    const data={product_id:p.id,quantity_units:Number($('movement-qty').value),movement_type:$('movement-type').value,request_id:crypto.randomUUID(),reason};
    const result=await scopedPost(isAdmin?'/admin/movements':'/movements',data);
    notice(`Movimiento guardado. Stock de ${p.name}: ${result.after}`);
    if(revision===areaRevision){$('movement-reason').value='';await load()}
  }catch(ex){notice(ex.message)}
  finally{
    movementPending=false;
    showProduct(products.find(row=>String(row.id)===$('movement-product').value));
  }
};
$('edit-kind').onchange=()=>updateRetireAssets();
$('edit-product').onchange=updateEdit;$('edit-product-form').onsubmit=async e=>{e.preventDefault();try{await scopedPost('/admin/products/'+$('edit-product').value,{name:$('edit-name').value,sap_code:$('edit-sap').value,barcode:$('edit-barcode').value,kind:$('edit-kind').value,units_per_pack:$('edit-pack').value,min_stock_units:$('edit-min').value,notes:$('edit-notes').value,active:$('edit-active').checked,retire_assets:$('edit-retire-assets').checked},'PATCH');notice('Producto actualizado');await load()}catch(ex){notice(ex.message)}};
$('adjust-form').onsubmit=async e=>{e.preventDefault();if(!workerReady())return;if(!confirm('Este ajuste queda registrado en auditoría. ¿Continuar?'))return;try{await scopedPost('/admin/adjust',{product_id:Number($('adjust-product').value),new_stock_units:Number($('adjust-stock').value),reason:$('adjust-reason').value,physical_verification:$('adjust-verified').checked});notice('Ajuste registrado');await load()}catch(ex){notice(ex.message)}};
$('new-user-form').onsubmit=async e=>{e.preventDefault();try{await post('/admin/users',Object.fromEntries(new FormData(e.target)));e.target.reset();notice('Colaborador registrado')}catch(ex){notice(ex.message)}};
$('new-asset-form').onsubmit=async e=>{e.preventDefault();try{await scopedPost('/admin/tools',{product_id:Number($('asset-product').value),asset_barcode:$('new-asset-code').value.trim(),description:$('new-asset-description').value,physical_verification:$('asset-verified').checked});notice('Herramienta individual registrada');e.target.reset()}catch(ex){notice(ex.message)}};
$('loan-asset').onclick=async()=>{
  if(loanPending||!workerReady())return;
  const asset=assets.find(a=>a.id===selectedAssetId);
  if(!asset)return notice('Escanea o escribe el código único de una herramienta registrada.');
  const availability=assetAvailability(asset);
  if(!availability.available)return notice(availability.reason);
  if(!confirm(`¿Registrar préstamo de ${asset.name} a tu usuario?`))return;
  const revision=areaRevision;
  loanPending=true;
  $('loan-asset').disabled=true;
  try{
    await scopedPost('/loans',{asset_id:asset.id,request_id:crypto.randomUUID(),notes:$('loan-notes').value});
    notice('Préstamo registrado');
    if(revision===areaRevision){$('loan-notes').value='';await refreshLoans()}
  }catch(ex){notice(ex.message)}
  finally{loanPending=false;renderTools()}
};
$('loans-list').onclick=e=>{
  const button=e.target.closest('[data-return]');
  if(button)openReturn(loans.find(l=>String(l.id)===button.dataset.return));
};
$('cancel-return').onclick=()=>{closeReturn();renderTools()};
$('return-form').onsubmit=async e=>{
  e.preventDefault();
  if(!returnLoan||!workerReady())return;
  const submit=e.submitter;
  submit.disabled=true;
  try{
    await scopedPost('/loans/'+returnLoan.id+'/return',{condition:$('return-condition').value,maintenance:$('return-maintenance').checked});
    closeReturn();notice('Devolución registrada');await refreshLoans();
  }catch(ex){notice(ex.message)}finally{submit.disabled=false}
};
async function downloadExcel(worker=''){
  const currentArea=area;
  const blob=await api(areaEndpoint('/export',worker?{user_id:worker}:{}));
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=currentArea==='taller'?'Inventario_Taller.xlsx':'Inventario_Cuarto_Valvulas.xlsx';
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('export').onclick=()=>downloadExcel().catch(e=>notice(e.message));
$('export-history').onclick=()=>downloadExcel($('history-worker').value).catch(e=>notice(e.message));
setLoginMethod('select');
if(token&&me){showApp()}else loadLoginUsers().catch(e=>notice(e.message))
