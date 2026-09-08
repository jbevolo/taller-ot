# Taller OT — Sistema de Gestion de Ordenes de Trabajo

PWA para la gestion de ordenes de trabajo en talleres mecanicos. Incluye panel administrativo con login, CRUD de ordenes, fotos con compresion y camara, impresion, enlace publico para clientes, backup/restore, y soporte offline del shell via Service Worker. Backend gestionado en Supabase (Auth, Postgres, Storage).

---

## Caracteristicas principales

- **Autenticacion** con email y contraseña via Supabase Auth (registro con confirmacion por correo) (`index.html:601-616`)
- **Alta, edicion y finalizacion** de ordenes de trabajo con campos: cliente, vehiculo, dominio, telefono, novedades, checks (garantia, oblea, PH, NV, retencion, mangueras), monto cobrado, forma de pago y notas (`index.html:1120-1137`)
- **Fotos** con compresion automatica (max 1920px, calidad progresiva 0.85-0.4, objetivo < 1 MB), seleccion desde camara trasera, frontal o galeria; subida a Supabase Storage; maximo 5 fotos por orden nueva (`index.html:1014-1063`, `index.html:937`)
- **Vista publica para clientes** via parametro `?id=<uuid>` en la URL, sin autenticacion, de solo lectura (`index.html:1963-1966`, `index.html:1608-1691`)
- **Impresion** de orden (formato documento oficial con firmas) y borrador desde el formulario (`index.html:1758-1794`, `index.html:1802-1820`)
- **Compartir por WhatsApp** con resumen y enlace al portal del cliente (`index.html:1567-1594`)
- **Backup y restauracion** de todas las ordenes como archivo JSON (`index.html:1832-1920`)
- **PWA offline** del shell (Service Worker con cache-first de assets estaticos) (`sw.js:1-39`)
- **Busqueda** en tiempo real con debounce de 300 ms sobre numero, cliente, vehiculo, dominio y telefono (`index.html:844-888`)
- **Paginacion** de 50 ordenes por pagina (`index.html:507`, `index.html:767-819`)

---

## Stack y arquitectura

| Capa | Tecnologia |
|------|-----------|
| Frontend | HTML + Tailwind CSS (CDN), Font Awesome (CDN), Inter (Google Fonts) |
| Backend | Supabase: Auth, Postgres, Storage |
| Cliente Supabase | `@supabase/supabase-js@2` via CDN (`index.html:13`) |
| PWA | Service Worker nativo (`sw.js`), Web App Manifest (`manifest.json`) |

No hay paso de compilacion, bundler ni framework JavaScript. Toda la aplicacion vive en un unico archivo `index.html` (~1985 lineas) con modulo ES6 inline.

---

## Estructura del proyecto

| Archivo | Responsabilidad |
|---------|----------------|
| `index.html` | Aplicacion completa: HTML, estilos, logica JS modulo (auth, CRUD, fotos, backup, impresion, vista publica, notificaciones) |
| `sw.js` | Service Worker: precache de shell y CDN, estrategia cache-first |
| `manifest.json` | Web App Manifest para PWA (nombre, iconos, theme, display standalone) |
| `sample_backup.json` | Ejemplo de archivo de backup con formato de referencia |
| `icon.png` | Icono de la PWA (512x512) |
| `docs/SETUP.md` | Guia de configuracion del backend Supabase y checklist de despliegue |
| `README.md` | Este documento |

---

## Como ejecutar localmente

1. Clonar el repositorio.
2. Iniciar un servidor HTTP local. La PWA requiere un servidor web; abrir `index.html` directamente desde el filesystem no registra el Service Worker.
   ```bash
   # Con Python 3
   python3 -m http.server 8080

   # Con Node.js (si esta disponible)
   npx serve .
   ```
3. Abrir `http://localhost:8080` en el navegador.
4. Los valores de Supabase (URL del proyecto y clave anon) ya estan configurados en `index.html` (lineas 464-471). No se requiere edicion para uso basico.
5. Para despliegue en produccion, publicar la carpeta raiz en cualquier hosting estatico con HTTPS (requerido para Service Worker y camara).

---

## Guia de uso

### Inicio de sesion

- **Login**: ingrese email y contraseña, presione "Entrar" (`index.html:583-595`).
- **Registro**: ingrese email y contraseña, presione "Crear Cuenta"; recibira un correo de confirmacion de Supabase antes de poder iniciar sesion (`index.html:601-616`).
- **Cerrar sesion**: boton "Salir" en el header (`index.html:648-651`).

### Crear una orden de trabajo

1. Completar los campos obligatorios: fecha (se carga automatica al dia actual), nombre del cliente, vehiculo, dominio y trabajos a realizar (`index.html:183-215`).
2. Marcar checks de garantia, oblea, PH, NV, retencion o mangueras si aplica (`index.html:216-241`).
3. Adjuntar fotos (maximo 5): hacer clic en "Subir Fotos", seleccionar fuente (camara trasera, frontal o galeria), las imagenes se comprimen automaticamente (`index.html:934-942`, `index.html:1014-1063`).
4. Presionar "Guardar en la Nube": las fotos se suben primero a Supabase Storage, luego se inserta la orden en la tabla `work_orders` (`index.html:1093-1154`).
5. El numero de orden se genera automaticamente como maximo existente + 1 (`index.html:896-899`).

### Ver y gestionar ordenes

- **Tabla principal**: lista todas las ordenes del usuario con paginacion de 50 por pagina, ordenadas por numero descendente (`index.html:663-684`, `index.html:694-757`).
- **Busqueda**: campo con debounce de 300 ms, filtra por numero, cliente, vehiculo, dominio y telefono (`index.html:844-888`).
- **Ver detalle**: boton ojo, abre modal con todos los datos, galeria de fotos con lightbox, y botones de accion (`index.html:1185-1259`).
- **Anadir fotos a orden existente**: desde el modal de detalle, si la orden no esta finalizada, se puede anadir fotos adicionales (`index.html:1262-1352`).
- **Eliminar foto**: desde el modal de detalle, boton de basura en cada foto (actualiza BD y elimina de Storage) (`index.html:1432-1468`).
- **Finalizar orden**: boton check-circle, registra monto cobrado, forma de pago (Efectivo, Transferencia, Debito, Credito) y notas; cambia estado a "Finalizada" (`index.html:1500-1544`).
- **Eliminar orden**: boton basura con confirmacion; borra registro de la tabla `work_orders` (`index.html:1165-1171`).
- **Imprimir**: genera ventana de impresion con formato de documento oficial, incluye espacios de firma del cliente y del taller (`index.html:1758-1794`).
- **Imprimir borrador**: imprime los datos cargados en el formulario sin guardar (`index.html:1802-1820`).
- **Compartir por WhatsApp**: genera mensaje con resumen y enlace al portal del cliente (`index.html:1567-1594`).

### Enlace publico para clientes

- Al finalizar una orden y compartirla por WhatsApp, se incluye un enlace con formato `index.html?id=<uuid>` (`index.html:1573`).
- El cliente puede ver: numero de orden, estado, vehiculo, dominio, cliente, fecha, trabajos, checks, galeria de fotos y, si esta finalizada, monto, forma de pago y notas (`index.html:1608-1691`).
- **Limitacion conocida**: la consulta anonima a `work_orders` esta bloqueada por las politicas RLS actuales (requieren `auth.uid() = user_id`). El enlace publico no funcionara hasta agregar una politica publica o RPC especifica (ver seccion de Limitaciones).

### Backup y restauracion

**Exportar (Backup):**
- Boton "Backup" en el header: descarga un archivo JSON con todas las ordenes del usuario autenticado (`index.html:1832-1845`).
- Nombre del archivo: `backup_online_workshop_YYYY-MM-DD.json`.

**Importar (Restaurar):**
- Boton "Restaurar": selecciona un archivo JSON. Se muestra confirmacion antes de proceder (`index.html:1850-1876`).
- La restauracion **borra todas las ordenes actuales del usuario** y luego inserta las ordenes del archivo. Los IDs originales se descartan; Supabase genera nuevos UUIDs (`index.html:1890-1920`).
- **ADVERTENCIA OPERATIVA**: la restauracion reemplaza/elimina las ordenes actuales del usuario autenticado antes de completar la importacion. Hacer una copia de seguridad previa antes de restaurar. No restaurar archivos de fuentes no confiables.

**Formato de referencia** (`sample_backup.json`):
```json
[
  {
    "orderNumber": 100,
    "fecha": "2026-05-13",
    "nombre": "Prueba de Restauracion",
    "telefono": "12345678",
    "vehiculo": "Camioneta Test",
    "dominio": "RES-555",
    "novedades": "Descripcion de trabajos...",
    "garantia": true,
    "createdAt": "2026-05-13T14:50:00.000Z",
    "status": "Abierta",
    "id": "test-restore-id"
  }
]
```
> Nota: este es el formato del archivo de ejemplo. El formato de las ordenes en la base de datos usa campos ligeramente diferentes (`order_number` en lugar de `orderNumber`, `created_at` en lugar de `createdAt`). El proceso de restauracion maneja ambos formatos al descartar los campos `id` y asignar el `user_id` del usuario actual.

---

## PWA y funcionamiento offline

**Que se cachea** (`sw.js:12-17`):
- `index.html` y `manifest.json` (shell de la aplicacion)
- CDN de Tailwind CSS y Supabase JS

**Estrategia**: cache-first — primero busca en cache, si no existe recien consulta la red (`sw.js:35-38`).

**Que NO funciona offline**:
- Autenticacion (requiere conexion a Supabase)
- Consulta, creacion, edicion y eliminacion de ordenes
- Subida y eliminacion de fotos
- Enlace publico del cliente
- Cualquier operacion de escritura o lectura contra el backend

En resumen: la PWA cachea el shell de la aplicacion para que la interfaz cargue sin conexion, pero todas las operaciones de datos requieren conexion a Internet.

---

## Consideraciones de seguridad y limitaciones conocidas

1. **Inyeccion HTML via innerHTML**: los campos de texto (novedades, notas_extra, mensajes de error) se insertan en el DOM usando `innerHTML` sin sanitizacion (`index.html:1230`, `index.html:1656`, `index.html:1728`, `index.html:1197`). Si se importan backups de fuentes no confiables, existe riesgo de XSS.

2. **Enlace publico de cliente no funcional**: la vista publica consulta `work_orders` como rol anonimo (`index.html:1618-1622`), pero las politicas RLS actuales requieren `auth.uid() = user_id` para todas las operaciones. El enlace `?id=<uuid>` no resolvera ordenes hasta agregar una politica publica o funcion RPC que permita lectura anonima por `id`.

3. **Numero de orden por max+1**: el siguiente numero de orden se calcula sumando 1 al maximo existente en el navegador (`index.html:897`). En uso concurrente (multiples usuarios creando ordene simultaneamente), pueden producirse colisiones de numero de orden.

4. **Sin cola offline de ordene**: no hay mecanismo de persistencia local ni cola de sincronizacion. Si se pierde la conexion durante una operacion de guardado, los datos no se almacenan ni reintentan.

5. **Backups guardan URLs, no bytes**: el archivo de backup contiene las URLs publicas de las fotos, no los archivos binarios. Si el bucket de Storage se elimina o las URLs expiran, las fotos se pierden independientemente del backup. Hacer backup del bucket Storage por separado si se requiere preservacion completa.

---

## Referencias verificadas

| Afirmacion | Ubicacion |
|-----------|----------|
| Configuracion Supabase (URL, anon key, createClient) | `index.html:464-478` |
| Auth: checkUser, signInWithPassword, signUp, signOut | `index.html:562-651` |
| Tabla: `work_orders` | `index.html:665` |
| Columnas insertadas en nueva orden | `index.html:1120-1137` |
| Bucket Storage: `photos` | `index.html:1105` |
| Ruta de subida: `${currentUser.id}/${fileName}` | `index.html:1106` |
| Compresion: 1920px max, calidad 0.85 a 0.4 | `index.html:1027-1050` |
| Limite de fotos: 5 por orden | `index.html:937` |
| Orden: max + 1 | `index.html:897` |
| Paginacion: 50 por pagina | `index.html:507` |
| Busqueda: debounce 300ms, campos searchables | `index.html:844-888` |
| Valores de status: `Abierta` / `Finalizada` | `index.html:1136`, `index.html:1527` |
| Formas de pago: Efectivo, Transferencia, Debito, Credito | `index.html:409-412` |
| Backup: exporta `allOrders` como JSON | `index.html:1832-1845` |
| Restore: borra ordene del usuario, inserta nuevas | `index.html:1890-1920` |
| Vista publica: `?id=` en URL, consulta anonima | `index.html:1963-1966`, `index.html:1618-1622` |
| Impresion: nueva ventana con Tailwind CDN | `index.html:1758-1794` |
| WhatsApp: genera link wa.me | `index.html:1567-1594` |
| SW: cache-first, precache 4 assets | `sw.js:12-17`, `sw.js:35-38` |
| Manifest: standalone, theme #4f46e5, bg #f3f4f6 | `manifest.json:6-8` |
| innerHTML sin sanitizacion (riesgo XSS) | `index.html:1230`, `index.html:1656`, `index.html:1728` |
| sample_backup.json formato legacy | `sample_backup.json:1-15` |

---

## Licencia

Proyecto privado. Todos los derechos reservados.
