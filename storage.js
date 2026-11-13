require('dotenv').config();
const mysql=require('mysql2/promise');const fs=require('fs');const path=require('path');
const required=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME','JWT_SECRET'];
for(const k of required){if(!process.env[k]||process.env[k].includes('REEMPLAZAR')||process.env[k].includes('GENERAR_SECRETO'))throw Error('Configura '+k+' en .env');}
const caEnv=process.env.DB_SSL_CA;
const caPath=process.env.DB_SSL_CA_PATH;
let caContent='';
if(caEnv && caEnv.trim()){
  caContent=caEnv.trim();
} else if(caPath){
  const full=path.resolve(caPath);
  if(!fs.existsSync(full))throw Error('Falta certificado CA en DB_SSL_CA_PATH. Descargalo de Aiven.');
  caContent=fs.readFileSync(full,'utf8');
}
if(!caContent)throw Error('Falta certificado CA. Usa DB_SSL_CA con el contenido PEM o DB_SSL_CA_PATH a un archivo .pem.');
const pool=mysql.createPool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,ssl:{ca:caContent,rejectUnauthorized:true},waitForConnections:true,connectionLimit:8,decimalNumbers:true,timezone:'Z'});
module.exports={pool};
