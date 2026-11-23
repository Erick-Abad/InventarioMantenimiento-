let catalog={modules:[],locations:[]}, catalogUsers=[], importPreviewFile=null, batchPreview=null;

function clearCatalogSession(){
  catalog={modules:[],locations:[]};catalogUsers=[];importPreviewFile=null;auditNext=null;
  clearBatchPreview();
  for(const id of ['edit-user','batch-tools','audit-list','catalog-preview'])$(id).replaceChildren();
  $('audit-panel').open=false;
  $('catalog-apply').hidden=true;
  $('catalog-file').value='';
  $('new-user-form').reset();
}

function renderLocationOptions(id,moduleId,selected,placeholder){
  setFilterOptions(id,catalog.locations.filter(location=>String(location.module_id)===String(moduleId)).map(location=>[location.id,location.name]),placeholder);
  $(id).value=selected==null?'':String(selected);
}

function renderProductLocations(product){
  renderLocationOptions('edit-location',product?.module_id,product?.location_id,'Ubicación de origen');
  const reference=products.find(row=>String(row.id)===$('asset-product').value);
  renderLocationOptions('new-asset-location',reference?.module_id,null,'Ubicación del producto');
}

function editDetails(){
  return {location_id:$('edit-location').value||null,...Object.fromEntries(
    ['brand','model','measure','capacity','category','specifications'].map(key=>[key,$('edit-'+key).value]))};
}

async function loadCatalogAdmin(){
  const revision=areaRevision;
  const [structure,people,units]=await Promise.all([api('/admin/catalog'),api('/users'),api(areaEndpoint('/tools'))]);
  if(revision!==areaRevision)return;
  catalog=structure;catalogUsers=people;
  const modeScope=module=>(Number(module.id)===11)===(area==='taller');
  const modules=structure.modules.filter(modeScope).map(module=>[module.id,module.name]);
  document.querySelectorAll('.catalog-module').forEach(dropdown=>{
    const previous=dropdown.value;
    dropdown.replaceChildren(...modules.map(([id,name])=>new Option(name,id)));
    if(modules.some(([id])=>String(id)===previous))dropdown.value=previous;
  });
  setFilterOptions('catalog-module-editor',structure.modules.map(module=>[module.id,module.name]),'Nuevo módulo o cajón');
  setFilterOptions('edit-user',people.filter(user=>user.id!==me.id).map(user=>[user.id,user.full_name]),'Selecciona un usuario');
  $('batch-tools').replaceChildren(...units.map(unit=>new Option(`${unit.asset_barcode} · ${unit.name} · ${unit.asset_status}`,unit.id)));
  clearBatchPreview();
  renderProductLocations(products.find(row=>String(row.id)===$('edit-product').value));
  $('catalog-location-form').elements.module_id.onchange();
  $('catalog-module-editor').onchange();
  $('edit-user').onchange();
}

$('asset-product').onchange=()=>renderProductLocations(products.find(row=>String(row.id)===$('edit-product').value));

const moduleForm=$('catalog-module-form'), locationForm=$('catalog-location-form'), userForm=$('edit-user-form');
$('catalog-module-editor').onchange=()=>{
  const module=catalog.modules.find(item=>String(item.id)===$('catalog-module-editor').value);
  for(const key of ['code','name','inventory_status'])moduleForm.elements[key].value=module?.[key]??(key==='inventory_status'?'pendiente':'');
  moduleForm.elements.code.readOnly=Boolean(module);
};
locationForm.elements.module_id.onchange=()=>{
  renderLocationOptions('catalog-location-editor',locationForm.elements.module_id.value,null,'Nueva ubicación');
  $('catalog-location-editor').onchange();
};
$('catalog-location-editor').onchange=()=>{
  locationForm.elements.name.value=catalog.locations.find(location=>String(location.id)===$('catalog-location-editor').value)?.name||'';
};
$('edit-user').onchange=()=>{
  const user=catalogUsers.find(row=>String(row.id)===$('edit-user').value);
  userForm.elements.role.value=user?.role||'colaborador';
  userForm.elements.active.checked=Boolean(user?.active);
};

for(const [form,endpoint,message] of [[$('create-product-form'),'/admin/products','Producto creado con conteo pendiente.'],
  [moduleForm,'/admin/modules','Módulo guardado.'],[locationForm,'/admin/locations','Ubicación guardada.']]){
  form.onsubmit=async event=>{
    event.preventDefault();
    try{await post(endpoint,Object.fromEntries(new FormData(form)));notice(message);await loadCatalogAdmin();await load();}
    catch(e){notice(e.message);}
  };
}
userForm.onsubmit=async event=>{
  event.preventDefault();
  try{
    await post('/admin/users/'+$('edit-user').value,{role:userForm.elements.role.value,active:userForm.elements.active.checked},'PATCH');
    notice('Permisos actualizados.');await loadCatalogAdmin();
  }catch(e){notice(e.message);}
};

function clearBatchPreview(){batchPreview=null;$('batch-preview').replaceChildren();$('batch-apply').hidden=true;}
for(const id of ['batch-tools','batch-status','batch-reason','batch-verified'])$(id).onchange=clearBatchPreview;
$('batch-tools-form').onsubmit=async event=>{
  event.preventDefault();clearBatchPreview();
  const selection={ids:[...$('batch-tools').selectedOptions].map(option=>Number(option.value)),status:$('batch-status').value,
    reason:$('batch-reason').value.trim(),physical_verification:$('batch-verified').checked,area};
  try{
    const rows=await post('/admin/tools/status',selection);
    $('batch-preview').innerHTML=table(['Código','Artículo','Estado actual','Resultado'],rows.map(row=>[row.barcode,row.name,row.current,row.reason||selection.status]));
    if(rows.every(row=>!row.reason)){batchPreview=selection;$('batch-apply').hidden=false;}
  }catch(e){notice(e.message);}
};
$('batch-apply').onclick=async()=>{
  if(!batchPreview||batchPreview.area!==area)return;
  if(!confirm('¿Confirmar el estado de las unidades seleccionadas?'))return;
  try{await post('/admin/tools/status',{...batchPreview,apply:true});notice('Estados actualizados.');await loadCatalogAdmin();}
  catch(e){notice(e.message);}
};

function assetEditor(asset){
  const locations=catalog.locations.filter(location=>String(location.module_id)===String(asset.module_id));
  return `<details><summary>Editar unidad</summary><form id="edit-asset-form" data-id="${asset.id}">
    <label>Descripción<input name="description" maxlength="250" value="${escapeHtml(asset.description||'')}"></label>
    <label>Ubicación<select name="location_id"><option value="">Ubicación del producto</option>
    ${locations.map(location=>`<option value="${location.id}" ${location.id===asset.location_id?'selected':''}>${escapeHtml(location.name)}</option>`).join('')}
    </select></label><button type="submit">Guardar unidad</button></form></details>`;
}

$('asset-details').addEventListener('submit',async event=>{
  const form=event.target;
  if(form.id!=='edit-asset-form')return;
  event.preventDefault();
  try{await scopedPost('/admin/tools/'+form.dataset.id,Object.fromEntries(new FormData(form)),'PATCH');notice('Unidad actualizada.');await refreshLoans();}
  catch(e){notice(e.message);}
});

$('asset-details').addEventListener('click',async event=>{
  const label=event.target.closest('[data-asset-label]'), history=event.target.closest('[data-asset-history]');
  if(!label&&!history)return;
  try{
    if(label){
      const printWindow=window.open('','_blank','popup');
      if(!printWindow)throw Error('Permite la ventana emergente para imprimir la etiqueta.');
      try{
        const image=await api('/admin/tools/'+label.dataset.assetLabel+'/label');
        const img=printWindow.document.createElement('img');
        const url=URL.createObjectURL(image);
        img.alt='Etiqueta de código de barras';
        img.style.width='90mm';
        img.onload=()=>{printWindow.focus();printWindow.print();URL.revokeObjectURL(url);};
        printWindow.document.body.append(img);img.src=url;
      }catch(e){printWindow.close();throw e;}
    }else{
      const target=$('asset-history-result');
      const rows=await api('/tools/'+history.dataset.assetHistory+'/history');
      if(target?.isConnected)target.innerHTML=table(['Prestatario','Entregó','Salida','Vence','Devolución','Recibió','Condición'],
        rows.map(loan=>[loan.borrower,loan.loaned_by,dateLabel(loan.loaned_at),dateLabel(loan.due_at),dateLabel(loan.returned_at),loan.received_by||'—',loan.return_condition||'—']));
    }
  }catch(e){notice(e.message);}
});

$('catalog-template').onclick=async()=>{
  try{saveDownload(await api('/admin/catalog/template'),'Catalogo_Editable.xlsx');}
  catch(e){notice(e.message);}
};
function saveDownload(blob,filename){
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('catalog-file').onchange=()=>{importPreviewFile=null;$('catalog-preview').replaceChildren();$('catalog-apply').hidden=true;};
$('catalog-import').onsubmit=async event=>{
  event.preventDefault();
  const file=$('catalog-file').files[0];
  if(!file||file.size>1_500_000)return notice('Selecciona un Excel de hasta 1,5 MB.');
  try{
    const encoded=await new Promise((resolve,reject)=>{
      const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(Error('No se pudo leer el archivo.'));
      reader.readAsDataURL(file);
    });
    const rows=await post('/admin/catalog/import',{file:encoded});
    if($('catalog-file').files[0]!==file)return;
    importPreviewFile=encoded;
    $('catalog-preview').innerHTML=`<p>${rows.length} referencias en el archivo</p>`+table(['Código','Artículo','Acción'],rows.slice(0,50).map(row=>[row.barcode,row.name,row.action]));
    $('catalog-apply').hidden=false;
  }catch(e){notice(e.message);}
};
$('catalog-apply').onclick=async()=>{
  if(!importPreviewFile||!confirm('¿Confirmar la importación del catálogo?'))return;
  try{
    const rows=await post('/admin/catalog/import',{file:importPreviewFile,apply:true});
    $('catalog-file').value='';$('catalog-file').onchange();notice(`${rows.length} referencias procesadas.`);await load();
  }catch(e){notice(e.message);}
};

let auditNext=null;
async function showAudit(before=null){
  const previous=token;
  const data=await api('/admin/audit'+(before?'?before='+before:''));
  if(token!==previous)return;
  auditNext=data.next;
  $('audit-older').disabled=!auditNext;
  $('audit-list').innerHTML=table(['Fecha','Usuario','Operación','Entidad','Detalles'],data.rows.map(row=>[
    dateLabel(row.created_at),row.actor||'—',row.action_name,`${row.entity_name} ${row.entity_id??''}`,
    typeof row.details_json==='string'?row.details_json:JSON.stringify(row.details_json??{})
  ]));
}
$('audit-panel').ontoggle=()=>{if($('audit-panel').open&&isAdmin())showAudit().catch(e=>notice(e.message));};
$('audit-latest').onclick=()=>showAudit().catch(e=>notice(e.message));
$('audit-older').onclick=()=>{if(auditNext)showAudit(auditNext).catch(e=>notice(e.message));};
