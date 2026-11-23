const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

test('Taller HTTP workflow requires a physical count and records only verified tools and authorized operations', async () => {
  const product = { module_id:11, barcode:'CTH000001', kind:'herramienta', active:0, stock_units:null, last_counted_at:null };
  const assets = [];
  const loans = [];
  const audit = [];
  const password = 'test-password-42';
  const account = { id:4, full_name:'Prueba', role:'administrador', active:1, password_hash:await bcrypt.hash(password,4) };
  let lockedReads = 0;
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, args) {
      if (sql.includes('FOR UPDATE')) lockedReads++;
      if (sql.includes('WHERE id=? AND employee_barcode=?')) return [args[0]===4&&args[1]==='EMP-4' ? [account] : []];
      if (sql.includes('SELECT id,full_name,password_hash,role,active')) return [[account]];
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
      } else if (sql.includes('SELECT ta.asset_status')) {
        return [[{ ...product, ...assets[0] }]];
      } else if (sql.startsWith('SELECT id FROM loans WHERE asset_id')) {
        return [loans.filter(loan=>loan.notes===args[1])];
      } else if (sql.startsWith('INSERT INTO loans')) {
        loans.push({ id:1, asset_id:1, borrower_id:args[1], returned_at:null, notes:args[3], module_id:11 });
        return [{ insertId:1 }];
      } else if (sql.includes('SELECT l.asset_id,l.returned_at')) {
        return [loans];
      } else if (sql.startsWith('UPDATE loans SET returned_at')) {
        loans[0].returned_at=new Date();
        loans[0].condition=args[1];
      } else if (sql.startsWith('UPDATE tool_assets SET asset_status')) {
        assets[0].asset_status=sql.includes("'prestada'")?'prestada':args[0];
      } else if (sql.startsWith('INSERT INTO audit_logs')) {
        audit.push({ action:args[1], details:JSON.parse(args[4]) });
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
  let token=jwt.sign({ id:4, role:account.role },process.env.JWT_SECRET,{ expiresIn:'5m', algorithm:'HS256' });
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
    assert.ok(lockedReads>=12);
  } finally {
    server.close();
    await once(server,'close');
  }
});
