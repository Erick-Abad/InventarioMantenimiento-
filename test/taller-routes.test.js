const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

test('Taller HTTP workflow requires a physical count and records only verified tools and authorized operations', async () => {
  const product = { module_id:11, barcode:'CTH000001', kind:'herramienta', active:0, stock_units:null, last_counted_at:null };
  const assets = [];
  const loans = [];
  const audit = [];
  const password = 'test-password-42';
  const account = { id:4, full_name:'Prueba', role:'administrador', active:1, password_hash:await bcrypt.hash(password,4) };
  const worker = {...account,id:5,full_name:'Colaborador',role:'colaborador'};
  const users = new Map([[4,account],[5,worker]]), sessions = new Map();
  let mode='ADMIN_PRESENTE';
  let lockedReads = 0;
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, args) {
      if (sql.includes('FOR UPDATE')) lockedReads++;
      if (sql.startsWith('INSERT INTO app_sessions')) {sessions.set(args[0],{id:args[1],ended_at:null});return [{affectedRows:1}];}
      if (sql.includes('FROM app_sessions s JOIN users')) {
        const session=sessions.get(args[1]),user=users.get(args[2]);
        return [session?.id===user?.id?[{...user,...session,name:user.full_name,expired:0}]:[]];
      }
      if (sql.startsWith('UPDATE app_sessions SET last_seen')) return [{affectedRows:1}];
      if (sql.startsWith('UPDATE app_sessions SET ended_at')) {sessions.get(args[0]).ended_at=new Date();return [{affectedRows:1}];}
      if (sql.includes('FROM workshop_control'))return [[{mode}]];
      if (sql.startsWith('UPDATE workshop_control')) {mode=args[0];return [{affectedRows:1}];}
      if (sql.includes('WHERE id=? AND employee_barcode=?')) return [args[0]===4&&args[1]==='EMP-4' ? [account] : []];
      if (sql.includes('SELECT id,full_name,password_hash,role,active')) return [[users.get(Number(args[0]))]];
      if (sql.includes('credential_matches FROM users')) return [[{...users.get(args[1]),credential_matches:args[0]===`EMP-${args[1]}`}]];
      if (sql.includes('SELECT role,active FROM users')) return [[account]];
      if (sql.startsWith('SELECT p.module_id')) return [[product]];
      if (sql.startsWith('SELECT COUNT(*) total FROM tool_assets')) return [[{ total:assets.length }]];
      if (sql.startsWith('SELECT id FROM products WHERE barcode')) return [[]];
      if (sql.startsWith('UPDATE inventory SET stock_units')) {
        product.stock_units=args[0];
        if (args[1]) product.last_counted_at=new Date();
      } else if (sql.startsWith('UPDATE products SET name')) {
        product.active=args[4];
      } else if (sql.startsWith('INSERT INTO tool_assets')) {
        assets.push({ id:1, asset_status:args[3] });
        return [{ insertId:1 }];
      } else if (sql.includes('SELECT ta.id,ta.asset_status')) {
        return [[{ ...product, ...assets[0] }]];
      } else if (sql.startsWith('SELECT id FROM loans WHERE open_asset_id')) {
        return [loans.filter(loan=>!loan.returned_at)];
      } else if (sql.startsWith('SELECT id FROM loans WHERE asset_id')) {
        return [loans.filter(loan=>loan.notes===args[1])];
      } else if (sql.startsWith('INSERT INTO loans')) {
        loans.push({ id:loans.length+1, asset_id:1, borrower_id:args[1], loaned_by:args[2], returned_at:null, notes:args[4], guest_name:args[5], module_id:11 });
        return [{ insertId:loans.length }];
      } else if (sql.includes('SELECT l.id,l.asset_id,l.returned_at')) {
        return [loans.filter(loan=>sql.includes('WHERE l.id=?')?loan.id===args[0]:!loan.returned_at)
          .map(loan=>({...loan,asset_status:assets[0].asset_status}))];
      } else if (sql.startsWith('UPDATE loans SET returned_at')) {
        loans.find(loan=>loan.id===args[2]).returned_at=new Date();
        loans.find(loan=>loan.id===args[2]).condition=args[1];
      } else if (sql.startsWith('UPDATE tool_assets SET asset_status')) {
        assets[0].asset_status=sql.includes("'prestada'")?'prestada':args[0];
      } else if (sql.startsWith('INSERT INTO audit_logs')) {
        audit.push({ action:args[1], details:JSON.parse(args[4]) });
      } else if (sql.startsWith('DELETE FROM workshop_provisional_stock')) {
        product.provisional_stock=0;
      } else if (!sql.startsWith('INSERT INTO movements')&&!sql.startsWith('UPDATE inventory SET min_stock_units')) {
        assert.fail('Consulta inesperada: '+sql);
      }
      return [{ affectedRows:1 }];
    }
  };
  const storagePath=require.resolve('../storage');
  require.cache[storagePath]={ exports:{ pool:{ query:connection.query, getConnection:async()=>connection } } };
  process.env.JWT_SECRET='local-test-secret-taller-not-production';
  const server=require('../server').listen(0,'127.0.0.1');
  await once(server,'listening');
  const root='http://127.0.0.1:'+server.address().port+'/api';
  let token='';
  async function call(path,data,expected,method='POST') {
    const response=await fetch(root+path,{ method, headers:{ Authorization:'Bearer '+token, 'Content-Type':'application/json' }, body:JSON.stringify(data) });
    const result=await response.json();
    assert.equal(response.status,expected,JSON.stringify(result));
    return result;
  }
  try {
    const edit={ area:'taller', name:'Herramienta', kind:'herramienta', active:true, barcode:product.barcode };
    const adjust={ area:'taller', product_id:1, new_stock_units:0, reason:'Conteo de prueba' };
    const login=await call('/login',{ user_id:4, barcode:'', password },200);
    assert.equal(login.user.credentialVerified,false);
    token=login.token;
    await call('/admin/products/1',edit,400,'PATCH');
    await call('/admin/adjust',{ ...adjust, physical_verification:true },403);
    await call('/session/credential',{ barcode:'EMP-5' },403);
    token=(await call('/session/credential',{ barcode:'EMP-4' },200)).token;
    await call('/admin/adjust',adjust,400);
    assert.equal(product.stock_units,null);
    await call('/admin/adjust',{ ...adjust, physical_verification:true },200);
    assert.equal(audit.at(-1).action,'verificar_conteo');
    assert.equal(audit.at(-1).details.before,null);
    await call('/admin/products/1',edit,200,'PATCH');
    const individual={ area:'taller', product_id:1, asset_barcode:'TALLER-IND-001', physical_verification:true };
    await call('/admin/tools',individual,400);
    await call('/admin/adjust',{ ...adjust, new_stock_units:1 },200);
    await call('/admin/tools',{ ...individual, physical_verification:false },400);
    await call('/admin/tools',individual,200);
    await call('/admin/tools',{ ...individual, asset_barcode:'TALLER-IND-002' },400);
    await call('/admin/adjust',adjust,400);
    const loan={ area:'taller', asset_id:1, request_id:randomUUID() };
    await call('/loans',{ ...loan, area:'valvulas' },409);
    await call('/loans',loan,200);
    await call('/loans',loan,409);
    assert.equal(loans[0].borrower_id,4);
    await call('/loans/1/return',{ area:'taller', condition:'Requiere reparación', maintenance:true },200);
    await call('/loans/1/return',{ area:'taller' },409);
    assert.equal(assets[0].asset_status,'mantenimiento');
    assert.equal(product.stock_units,1);
    assert.equal(audit.at(-1).action,'devolucion');
    const provisional={...loan,request_id:randomUUID()};
    product.last_counted_at=null;
    assets[0].asset_status='disponible';
    await call('/loans',provisional,409);
    product.provisional_stock=1;
    const secondLoan=await call('/loans',provisional,200);
    assert.equal(product.last_counted_at,null);
    await call('/loans/'+secondLoan.id+'/return',{area:'taller',maintenance:true},200);
    await call('/admin/adjust',{...adjust,new_stock_units:1},400);
    await call('/admin/adjust',{...adjust,new_stock_units:1,physical_verification:true},200);
    assert.ok(product.last_counted_at);
    assert.equal(product.provisional_stock,0);
    assets[0].asset_status='disponible';
    const guestRequest={...loan,guest_name:'  Persona puntual  ',request_id:randomUUID()};
    await call('/loans',{...guestRequest,guest_name:'   '},400);
    await call('/loans',{...guestRequest,borrower_id:4},400);
    const guestLoan=await call('/loans',guestRequest,200);
    const guest=loans.find(row=>row.id===guestLoan.id);
    assert.equal(guest.guest_name,'Persona puntual');
    assert.equal(guest.borrower_id,null);
    assert.equal(guest.loaned_by,4);
    await call('/loans/'+guest.id+'/return',{area:'taller',maintenance:true},200);
    assert.ok(lockedReads>=12);
    const adminToken=token;
    const workerToken=(await call('/login',{user_id:5,password},200)).token;
    token=workerToken;
    const selfLoan={...loan,employee_barcode:'EMP-5',request_id:randomUUID()};
    await call('/loans',{...selfLoan,guest_name:'Persona puntual'},403);
    await call('/loans',selfLoan,403);
    await call('/admin/workshop/mode',{mode:'AUTOSERVICIO'},403,'PATCH');
    await call('/movements',{},400);
    await call('/admin/movements',{},403);
    await call('/admin/products/1',edit,403,'PATCH');
    await call('/admin/tools/1',{description:'Cambio por colaborador'},403,'PATCH');
    await call('/admin/tools',individual,403);
    await call('/admin/adjust',adjust,403);
    await call('/admin/entry-alerts',undefined,403,'GET');
    token=adminToken;
    await call('/admin/workshop/mode',{mode:'AUTOSERVICIO'},200,'PATCH');
    token=workerToken;
    await call('/loans',selfLoan,409);
    assets[0].asset_status='disponible';
    await call('/loans',{...selfLoan,employee_barcode:'EMP-4'},403);
    const borrowed=await call('/loans',selfLoan,200);
    assert.equal(loans.find(row=>row.id===borrowed.id).loaned_by,5);
    await call('/loans/return-by-code',{area:'taller',asset_barcode:'TALLER-IND-001',employee_barcode:'EMP-5'},200);
    assert.ok(loans.find(row=>row.id===borrowed.id).returned_at);
    token=adminToken;
    await call('/admin/workshop/mode',{mode:'ADMIN_PRESENTE'},200,'PATCH');
    token=workerToken;
    await call('/loans',{...selfLoan,request_id:randomUUID()},403);
    worker.active=0;
    await call('/loans',{...selfLoan,request_id:randomUUID()},401);
    assert.equal(audit.at(-1).action,'cierre_sesion');
  } finally {
    server.close();
    await once(server,'close');
  }
});
