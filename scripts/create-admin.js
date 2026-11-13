require('dotenv').config();
const bcrypt=require('bcryptjs');
const {pool}=require('../storage');
(async()=>{
 const name=process.env.INITIAL_ADMIN_NAME;
 const barcode=process.env.INITIAL_ADMIN_BARCODE;
 const password=process.env.INITIAL_ADMIN_PASSWORD;
 if(!name || !barcode || !password || password.length<10 || password==='COLOCAR_CONTRASENA_DE_PRUEBA_TEMPORAL') throw Error('Define INITIAL_ADMIN_NAME, INITIAL_ADMIN_BARCODE e INITIAL_ADMIN_PASSWORD (minimo 10 caracteres) en .env');
 const hash=await bcrypt.hash(password,12);
 const [rows]=await pool.query('SELECT id FROM users WHERE employee_barcode=?',[barcode]);
 if(rows.length) {console.log('El codigo de empleado ya existe. No se modifico su contrasena.');process.exit(0)}
 await pool.query('INSERT INTO users(full_name,employee_barcode,password_hash,role,active) VALUES(?,?,?,?,1)',[name,barcode,hash,'administrador']);
 console.log('Administrador de pruebas creado: '+name+' / '+barcode+' (con permisos de colaborador incluidos).');
})().catch(e=>{console.error('Error:',e.message);process.exitCode=1}).finally(()=>pool.end());
