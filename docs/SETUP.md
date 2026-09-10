# Guia de configuracion — Taller OT

Referencia tecnica del backend Supabase, esquema de base de datos, politicas de seguridad, Storage y checklist de despliegue.

---

## Requisitos

- Proyecto Supabase activo (<https://supabase.com>).
- Auth habilitado en el proyecto Supabase (Providers > Email).
- Bucket de Storage creado y configurado.
- Tabla `work_orders` creada en el esquema `public`.
- Politicas RLS aplicadas a la tabla `work_orders`.

---

## Valores de configuracion en index.html

Los valores de conexion se encuentran en las lineas 464-471 de `index.html`:

```javascript
const SUPABASE_URL = 'https://TU-PROYECTO.supabase.co';     // Linea 464
const SUPABASE_ANON_KEY = 'TU-CLAVE-ANON-AQUI';              // Linea 471
```

Reemplazar los valores con la URL del proyecto y la clave anon (publica) desde el dashboard de Supabase en **Settings > API**.

> La clave anon es segura para exposicion en frontend. El acceso a datos esta protegido por Row Level Security (RLS).

---

## Esquema de la tabla `work_orders`

La tabla `public.work_orders` es el nucleo de datos de la aplicacion. Esquema esperado/desplegado actualmente (no versionado como migracion en el repositorio):

```sql
CREATE TABLE public.work_orders (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES auth.users(id),
    order_number  integer,
    fecha         date,
    nombre        text,
    telefono      text,
    vehiculo      text,
    dominio       text,
    novedades     text,
    garantia      boolean DEFAULT false,
    oblea         boolean DEFAULT false,
    ph            boolean DEFAULT false,
    nv            boolean DEFAULT false,
    retencion     boolean DEFAULT false,
    mangueras     boolean DEFAULT false,
    fotos         text[],
    verification_checklist jsonb DEFAULT '{}'::jsonb,
    verification_files text[] DEFAULT '{}',
    status        text DEFAULT 'Abierta',
    monto_cobrado numeric,
    forma_pago    text,
    notas_extra   text,
    created_at    timestamptz DEFAULT now()
);
```

**Campos utilizados en index.html:**

| Campo | Uso en la aplicacion | Referencia |
| ------- | --------------------- | ----------- |
| `id` | UUID generado automaticamente, clave primaria | `index.html:1167` (delete por id) |
| `user_id` | Se asigna `currentUser.id` al insertar | `index.html:1121` |
| `order_number` | Auto-calculado (max+1) en el navegador | `index.html:897`, `index.html:1122` |
| `fecha` | Campo type="date" del formulario | `index.html:1123` |
| `nombre` | Nombre del cliente (requerido) | `index.html:1124` |
| `telefono` | Telefono del cliente (opcional) | `index.html:1125` |
| `vehiculo` | Descripcion del vehiculo (requerido) | `index.html:1126` |
| `dominio` | Patente, se guarda en mayusculas | `index.html:1127` |
| `novedades` | Texto libre: trabajos a realizar (requerido) | `index.html:1128` |
| `garantia` | Checkbox booleano | `index.html:1129` |
| `oblea` | Checkbox booleano | `index.html:1130` |
| `ph` | Checkbox booleano | `index.html:1131` |
| `nv` | Checkbox booleano | `index.html:1132` |
| `retencion` | Checkbox booleano | `index.html:1133` |
| `mangueras` | Checkbox booleano | `index.html:1134` |
| `fotos` | Array de URLs publicas (text[]) | `index.html` |
| `verification_checklist` | Planilla digital opcional con items canonicos y estado OK/NO OK/N/A/pendiente | `index.html` |
| `verification_files` | Rutas seguras de adjuntos de planilla (JPG, PNG, PDF, XLS, XLSX) en Storage | `index.html` |
| `status` | `'Abierta'` o `'Finalizada'` | `index.html` |
| `monto_cobrado` | Numeric, se registra al finalizar | `index.html:1529` |
| `forma_pago` | Texto: Efectivo/Transferencia/Debito/Credito | `index.html:1530` |
| `notas_extra` | Texto libre, opcional, al finalizar | `index.html:1531` |
| `created_at` | Generado automaticamente por Supabase | Default de la tabla |

> Nota: este es el esquema observado en el codigo fuente. El repositorio versiona `database/safe-order-operations.sql` exclusivamente para crear el RPC de restauracion; no crea ni modifica esta tabla ni sus politicas RLS.

---

## Politicas RLS (Row Level Security)

La tabla `work_orders` debe tener RLS habilitado. Las politicas actuales segun el codigo son:

1. **Acceso total para usuarios autenticados (propietario)**
   - Nombre: `Enable all access for users based on user_id`
   - Tipo: PUBLIC, PERMISSIVE, ALL
   - Condicion: `auth.uid() = user_id` (en USING y WITH CHECK)
   - Implicacion: cada usuario solo puede ver, crear, modificar y eliminar sus propias ordenes.

2. **admin_select_own** — authenticated, SELECT, `auth.uid() = user_id`
3. **admin_insert_own** — authenticated, INSERT, `auth.uid() = user_id`
4. **admin_update_own** — authenticated, UPDATE, `auth.uid() = user_id`
5. **admin_delete_own** — authenticated, DELETE, `auth.uid() = user_id`

**Implicacion para la vista publica**: las politicas anteriores requieren un usuario autenticado (`auth.uid()` no es null) y coincidencia con `user_id`. Las consultas anonimas (sin sesion) estan bloqueadas. El enlace publico del cliente (`?id=<uuid>`) no podra resolver ordene hasta agregar una politica publica de solo lectura o una funcion RPC que permita consulta anonima por `id`.

---

## Storage — Bucket `photos`

- **Nombre del bucket**: `photos` (`index.html:1105`)
- **Tipo**: publico (las URLs de las fotos se obtienen via `getPublicUrl`, `index.html:1114`)
- **Rutas de subida**: fotos del trabajo bajo el namespace `{user_id}/`; adjuntos de planilla bajo `{user_id}/verification/{uuid}.{ext}` conservando solo extensiones permitidas.
- **Permisos necesarios**:
  - El usuario autenticado debe poder subir archivos a su propia carpeta (`user_id/`).
  - La lectura publica debe estar habilitada para que las URLs de las fotos funcionen en la vista publica del cliente y en WhatsApp.
- **Eliminacion**: al borrar una foto, se extrae la ruta de la URL publica y se elimina del bucket (`index.html:1450-1458`).

---

## Autenticacion

- **Metodo**: email + contraseña via Supabase Auth (`index.html:592`, `index.html:610`).
- **Registro**: `signUp` envia correo de confirmacion antes de permitir login (`index.html:610-616`).
- **Login**: `signInWithPassword` valida credenciales (`index.html:592`).
- **Logout**: `signOut` cierra la sesion (`index.html:649`).
- **Sesion**: se verifica con `getUser()` al cargar la pagina (`index.html:563`). No hay escucha de `onAuthStateChange` en el codigo actual.

---

## Checklist de despliegue

1. **Proyecto Supabase**
   - [ ] Proyecto creado y activo.
   - [ ] Auth habilitado con provider Email.
   - [ ] Tabla `work_orders` creada con el esquema documentado.
   - [ ] RLS habilitado en `work_orders` con las politicas descritas.
   - [ ] Bucket `photos` creado (publico o con politicas de lectura publica + escritura autenticada).
   - [ ] Revisar y aplicar manualmente `database/safe-order-operations.sql` siguiendo `database/README.md`. La migracion debe probarse primero en staging y no se considera desplegada por estar en el repositorio.

2. **Frontend**
   - [ ] Valores de `SUPABASE_URL` y `SUPABASE_ANON_KEY` actualizados en `index.html` (lineas 464-471).
   - [ ] Icono `icon.png` disponible en la raiz del proyecto (512x512 recomendado).

3. **Hosting**
   - [ ] Publicar la carpeta raiz del proyecto en un hosting estatico con HTTPS.
   - [ ] HTTPS es obligatorio para: Service Worker (PWA), acceso a camara en dispositivos moviles, y mixed content policies del navegador.
   - [ ] Verificar que `sw.js` y `manifest.json` sean accesibles desde la raiz del sitio.
   - [ ] Verificar que `index.html` sea el documento de indice (o configurar el enrutamiento correspondiente).

4. **Verificacion**
   - [ ] Abrir la aplicacion, registrar un usuario, confirmar el correo.
   - [ ] Crear una orden con fotos y verificar que se suben al bucket.
   - [ ] Finalizar la orden y verificar el enlace de WhatsApp.
   - [ ] Probar backup y restauracion.
   - [ ] Verificar que el Service Worker se registra (pestana Application > Service Workers en DevTools).

---

## Notas

- La unica migracion versionada, `database/safe-order-operations.sql`, agrega el RPC transaccional de restore y falla si no encuentra el esquema, privilegios y RLS esperados. Los demas cambios de esquema deben gestionarse como migraciones revisadas por separado.
- La clave anon es segura para el frontend; las politicas RLS protegen el acceso a los datos. No exponer la service_role key en el frontend.
- El numero de orden se genera en el navegador con max+1; en uso concurrente pueden producirse colisiones. Para evitarlo, se podria usar un contador secuencial en la base de datos o una funcion RPC.
