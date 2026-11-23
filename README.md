# Sistema de Inventario - Cuarto de Valvulas | v1 (pruebas)

## Inventario existente en Aiven

- Esquema `inventario_valvulas`, MySQL 8.4. El 23 de noviembre de 2026 se verificaron 550 referencias con una fila de inventario cada una, 171 del Cuarto de Válvulas y 379 del Taller.
- El módulo `11` (`TALLER`) contiene `CTH000001` a `CTH000379`. Los códigos y nombres coinciden con `taller_carga_20261123`. Esta tabla se consulta para mostrar la ubicación validada o, cuando falta, la sección registrada en la carga.
- Las 379 referencias del Taller estaban pendientes de clasificación y conteo. Se conservan sus cantidades `NULL` y se validan individualmente.

## Requisitos
- Node.js LTS 20 o superior (preferible 22).
- MySQL Aiven ya creado y certificado CA descargado.
- Acceso de red al host/puerto de Aiven.

## Instalacion
1. Descomprimir esta carpeta y abrir terminal **dentro** de ella.
2. Ejecutar `npm install`.
3. Copiar `.env.example` a `.env`.
4. En `.env` completar `DB_PASSWORD` real (solo localmente), `JWT_SECRET` de al menos 32 caracteres aleatorios y `INITIAL_ADMIN_PASSWORD` temporal de **10 caracteres o mas**. Nunca subir `.env` a GitHub.
5. Descargar certificado CA desde Aiven > Informacion de conexion > Certificado CA, guardarlo en `certs/ca.pem`.
6. Solo para una base local vacia, `npm run seed:admin` crea al administrador inicial si su codigo no existe. **No ejecutes este comando contra Aiven**: esa base ya tiene usuarios y no es necesario volver a crearlos.
7. Ejecutar `npm start`.
8. Abrir `http://localhost:3000`. El login permite seleccionar un usuario activo, escribir el codigo personal o identificarlo con lector USB/camara; en todos los casos se requiere la contraseña personal.

La aplicación inicia con el esquema existente. El despliegue usa las mismas variables de entorno de Render y requiere que Aiven conserve el módulo y la tabla de carga del Taller.

## Para probar un retiro
1. Seleccionar el área en el encabezado. En el Taller, identificar la cuenta mediante la credencial y la contraseña, o confirmar la credencial después de entrar con el selector de usuarios.
2. En Administración, registrar la cantidad y el motivo en **Ajuste autorizado de existencias** y confirmar la verificación física. Cero es un conteo válido. Después, clasificar el artículo como `consumible` y activarlo.
3. En **Escanear / mover**, buscar el nombre, el SAP o el código de barras. El código puede escribirse, leerse con lector USB o capturarse con la cámara.
4. Seleccionar la operación, la cantidad y las observaciones. Los retiros requieren un producto activo y existencias suficientes. Los movimientos administrativos requieren un motivo auditado.
5. Consultar el movimiento en el Dashboard o descargar el Excel con el rol de administrador.

## Para probar un prestamo
1. Registrar el conteo físico, clasificar la referencia como `herramienta` y activarla.
2. En **Identificar herramienta individual**, registrar el código único de la unidad física. En el Taller se confirma cada activo individual y se aplica como máximo el total contado de la referencia.
3. En **Préstamos**, escanear el código individual y confirmar el préstamo. Consultar allí al prestatario y la fecha de salida.
4. Elegir **Devolver** y registrar la condición. En el Taller, el prestatario, un encargado o un administrador puede registrar la devolución y dejar la unidad en mantenimiento cuando corresponda.

## Notas importantes
- Solo el administrador puede ajustar stock, editar productos o registrar activos. Los ajustes exigen un motivo. Los movimientos administrativos registran el autorizador y los saldos anterior y posterior.
- Para acceso desde celular no se debe exponer el puerto 3000 directamente a Internet: desplegar en un servicio web con HTTPS y guardar las credenciales en variables de entorno privadas.
- La lectura por camara usa la API `BarcodeDetector` si esta disponible y carga `@zxing/browser` localmente como alternativa. La camara necesita HTTPS o localhost y permiso del navegador; tambien se admite lector USB/Bluetooth o entrada manual.
- El login lista solo `id` y nombre de usuarios activos. Escanear una credencial Code 128 identifica al usuario, pero no autentica; el backend compara la contraseña con `password_hash` mediante bcrypt antes de emitir la sesion y las rutas administrativas verifican el rol.
- La busqueda de productos en Escanear / mover consulta MySQL por CVP, SAP o nombre y muestra los articulos pendientes sin permitir moverlos. El lector ZXing se carga solo cuando hace falta y Render lo sirve desde la dependencia instalada, sin CDN.
- Herramientas y prestamos lista todos los registros `tool_assets` con producto, ubicacion (modulo), SAP, codigo CVP, estado guardado y disponibilidad. La falta de validacion se calcula a partir de `products.active=0`; no se agrega un valor al ENUM ni se cambian activos automaticamente. El backend tambien bloquea prestamos de productos inactivos o activos que no tengan `asset_status='disponible'`.
- La validacion individual de una herramienta requiere sesion de administrador, confirmacion de verificacion fisica y motivo; la operacion actualiza solo el producto/activo seleccionado y escribe auditoria dentro de una transaccion. No se validan herramientas por lote.
- Herramientas individuales se siguen por `tool_assets`; los prestamos NO descuentan existencias. El stock de herramientas y las piezas individuales necesitan conciliacion antes de operar a escala.
- El valor `original_pack_count` es historico y no se recalcula tras un retiro. El stock operativo es `stock_units`.
- Se debe separar `kind`/`active` despues de revisar cada referencia, en especial el O-ring 9x2 con SAP discrepante.
- Aiven ya contiene al administrador y a los colaboradores registrados. El login no crea, modifica ni sobrescribe cuentas o contraseñas.
- No se ofrece recuperacion de contrasena ni registro automatico; son funcionalidades para la siguiente fase.
- Excel incluye Dashboard, Inventario, Movimientos y Préstamos del área seleccionada. Para exportar los movimientos de una persona, seleccionarla en el filtro del Dashboard antes de descargar.
- NO corresponde todavia a un sistema validado para produccion ni a una PWA offline. No se deben registrar datos operativos hasta probar respaldos, roles, concurrencia y correcciones.

## Endpoints
`GET /api/health`, `GET /api/login/users`, `GET /api/login/identify?barcode=...`, `POST /api/login`, `GET /api/dashboard`, `GET /api/products`, `GET /api/products/search?q=...`, `POST /api/movements`, `GET /api/tools`, `GET /api/loans`, `POST /api/loans`, `POST /api/loans/:id/return`, `GET /api/export`, `GET /api/users`, `POST /api/admin/users`, `PATCH /api/admin/products/:id`, `POST /api/admin/adjust`, `POST /api/admin/tools`, `POST /api/admin/tools/:id/validate`.

Las consultas de inventario, búsqueda, dashboard, herramientas, préstamos y Excel aceptan `area=taller` o `area=valvulas`. `GET /api/history` acepta `area`, `page` y `user_id`. `GET /api/workers` devuelve los nombres y los identificadores internos para ese filtro. `POST /api/session/credential` coteja la credencial con la sesión autenticada y conserva su vencimiento.

## Comprobación y Render

### Control del Taller

- **Administrador presente** es el modo inicial. El administrador escoge al prestatario, puede indicar vencimiento y registra la entrega o devolución. Cada trabajador consulta sus propios préstamos.
- **Autoservicio** se habilita de forma explícita en el encabezado por un administrador. El trabajador inicia sesión con contraseña, escoge **Retirar herramienta** o **Devolver herramienta**, escanea su credencial y luego la unidad física. Puede usar la cámara o un lector USB que envíe Enter al final. Para devolver una unidad dañada, marca **Reportar daño** antes de escanear. La credencial se limpia tras cada operación. El regreso a modo administrador presente bloquea inmediatamente las solicitudes nuevas de autoservicio.
- El catálogo y el stock son independientes de las unidades físicas. En **Administración** se pueden gestionar módulos, ubicaciones, permisos, características y lotes explícitos de códigos individuales. El cambio masivo de estado exige una vista previa y confirmación. El historial y la etiqueta Code 128 de una unidad están en su ficha de **Préstamos**.
- **Catálogo en Excel** genera una plantilla con referencias que tienen código. Al importar, se previsualizan las altas y actualizaciones. Las referencias nuevas quedan inactivas y con cantidad desconocida. La importación nunca ajusta stock ni mueve un producto entre módulos. Los ajustes auditados se hacen desde **Ajuste autorizado de existencias**.

### Migración y publicación

1. Confirma el respaldo lógico por TLS y conserva el archivo fuera de Git. Comprueba que la base de prueba corresponda a la misma estructura que Aiven antes de usarla para pruebas de escritura.
2. Con las variables de la base de destino configuradas, ejecuta `npm run migrate:workshop` una vez desde un entorno de confianza antes de publicar el código. [La migración](migrations/001_workshop.sql) agrega tablas complementarias y preserva el modo registrado en `workshop_control` si la fila ya existe. Puede volver a ejecutarse.
3. Ejecuta `npm test`. Comprueba en una base de prueba que el modo cerrado y los permisos se aplican dentro de la transacción, y que un préstamo simultáneo se rechaza. Conserva las credenciales de producción en las variables privadas de Render.
4. Conserva `node server.js` y `/api/health` en Render. `SESSION_IDLE_MINUTES` es opcional y admite enteros del 1 al 120, con valor predeterminado de 15. Después del primer despliegue de esta versión se debe iniciar sesión de nuevo para crear una sesión revocable. La cámara móvil requiere HTTPS y permiso del navegador.
5. Comprueba el acceso y la lectura de la API con una cuenta autorizada. Haz verificaciones de escritura en la base de prueba.

## Seguridad
- Conexion DB bajo TLS con CA (rechazo de certificados no validos).
- Contrasenas con bcrypt; token firmado 8h; restricciones de rol en el backend.
- Consulta y actualizacion de inventario en transaccion con bloqueo de registro y UUID unico por movimiento.
- Almacenar `JWT_SECRET`, contrasenas y CA fuera del codigo fuente.
- Para produccion: proxy HTTPS, logs de auditoria completos, limitacion de solicitudes en operaciones sensibles, pruebas de doble solicitud en prestamos, sistema de respaldo, rotacion de claves y sesiones persistentes seguras.
