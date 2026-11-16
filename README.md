# Sistema de Inventario - Cuarto de Valvulas | v1 (pruebas)

## Ya existente en Aiven (no volver a importar)
- Servicio `inventario-valvulas`, esquema `inventario_valvulas`, MySQL 8.4.
- Ocho tablas creadas y 50 productos importados (30 de modulo 1, 20 de modulo 2), 29 codigos CVP originales.
- Hay DOS referencias sin conteo; todos los productos se importaron `kind='pendiente'`, `active=0` para evitar retiros no autorizados.

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
6. Ejecutar `npm run seed:admin`. Solo crea a Erick Abad Monserrate, codigo `0987654321`, rol **administrador** (tambien realiza tareas de colaborador). La contrasena se guarda como hash bcrypt; el codigo de barras NO es la contrasena.
7. Ejecutar `npm start`.
8. Abrir `http://localhost:3000` en la computadora. Ingresar codigo `0987654321` y la contrasena temporal creada.

**No ejecuta automaticamente migraciones, ni vuelve a insertar los 50 productos.**

## Para probar un retiro
1. Administracion > seleccionar un repuesto, clasificar como `consumible`, marcar activo, guardar.
2. Confirmar su stock, dejando sin activar las referencias con conteo desconocido.
3. Escanear / mover > leer codigo CVP del repuesto o seleccionarlo > elegir retiro o entrada > indicar unidades > confirmar. Para colaboradores y encargados el repuesto debe estar activo; el administrador tambien puede registrar entradas y consumos de repuestos inactivos con un motivo auditado. Ningun movimiento admite stock desconocido (NULL).
4. Dashboard e Inventario reflejan el movimiento.

## Para probar un prestamo
1. Clasificar y activar el producto correspondiente como `herramienta`.
2. Administracion > Identificar herramienta individual: crear su codigo unico (distinto al CVP de producto).
3. Prestamos > escanear la etiqueta de la herramienta y prestar.
4. Prestamos > usar `Devolver` para marcarla disponible.

## Notas importantes
- Solo el administrador puede ajustar stock y modificar productos. Los ajustes exigen motivo y dejan rastro. Las entradas y consumos administrativos tambien registran motivo, autorizador, saldos anterior/posterior y auditoria, sin activar el producto.
- Para acceso desde celular no se debe exponer el puerto 3000 directamente a Internet: desplegar en un servicio web con HTTPS y guardar las credenciales en variables de entorno privadas.
- La lectura por camara usa la API `BarcodeDetector` si esta disponible y carga `@zxing/browser` localmente como alternativa. La camara necesita HTTPS o localhost y permiso del navegador; tambien se admite lector USB/Bluetooth o entrada manual.
- La busqueda de productos en Escanear / mover consulta MySQL por CVP, SAP o nombre y muestra los articulos pendientes sin permitir moverlos. El lector ZXing se carga solo cuando hace falta y Render lo sirve desde la dependencia instalada, sin CDN.
- Herramientas y prestamos lista todos los registros `tool_assets` con producto, ubicacion (modulo), SAP, codigo CVP, estado guardado y disponibilidad. La falta de validacion se calcula a partir de `products.active=0`; no se agrega un valor al ENUM ni se cambian activos automaticamente. El backend tambien bloquea prestamos de productos inactivos o activos que no tengan `asset_status='disponible'`.
- La validacion individual de una herramienta requiere sesion de administrador, confirmacion de verificacion fisica y motivo; la operacion actualiza solo el producto/activo seleccionado y escribe auditoria dentro de una transaccion. No se validan herramientas por lote.
- Herramientas individuales se siguen por `tool_assets`; los prestamos NO descuentan existencias. El stock de herramientas y las piezas individuales necesitan conciliacion antes de operar a escala.
- El valor `original_pack_count` es historico y no se recalcula tras un retiro. El stock operativo es `stock_units`.
- Se debe separar `kind`/`active` despues de revisar cada referencia, en especial el O-ring 9x2 con SAP discrepante.
- Hay una sola cuenta inicial: Erick. Su rol admin incluye operaciones normales.
- No se ofrece recuperacion de contrasena ni registro automatico; son funcionalidades para la siguiente fase.
- Exportar Excel incluye Dashboard, Inventario, Movimientos y Prestamos. Los graficos se incorporaran en la siguiente version.
- NO corresponde todavia a un sistema validado para produccion ni a una PWA offline. No se deben registrar datos operativos hasta probar respaldos, roles, concurrencia y correcciones.

## Endpoints
`GET /api/health`, `POST /api/login`, `GET /api/dashboard`, `GET /api/products`, `GET /api/products/search?q=...`, `POST /api/movements`, `GET /api/tools`, `GET /api/loans`, `POST /api/loans`, `POST /api/loans/:id/return`, `GET /api/export`, `GET /api/users`, `POST /api/admin/users`, `PATCH /api/admin/products/:id`, `POST /api/admin/adjust`, `POST /api/admin/tools`, `POST /api/admin/tools/:id/validate`.

## Seguridad
- Conexion DB bajo TLS con CA (rechazo de certificados no validos).
- Contrasenas con bcrypt; token firmado 8h; restricciones de rol en el backend.
- Consulta y actualizacion de inventario en transaccion con bloqueo de registro y UUID unico por movimiento.
- Almacenar `JWT_SECRET`, contrasenas y CA fuera del codigo fuente.
- Para produccion: proxy HTTPS, logs de auditoria completos, limitacion de solicitudes en operaciones sensibles, pruebas de doble solicitud en prestamos, sistema de respaldo, rotacion de claves y sesiones persistentes seguras.
