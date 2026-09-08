# 🛠️ Plan — Panel de administración de parámetros

Este documento es **planificación**, no implementación todavía — pero el
diseño ya quedó **confirmado** (ver sección 9, todas las preguntas abiertas
resueltas). Listo para pasar a la fase de implementación siguiendo el orden
de la sección 8. No es parte de
`docs/PLAN-PRODUCCION.md` a propósito — ese documento es explícitamente sobre
robustez/seguridad/infra, no features nuevas, y esto **es** una feature nueva.
Si se aprueba el diseño, viviría como `docs/CHANGELOG.md`/`docs/MEMORIA.md`
entradas normales, igual que cualquier otro cambio.

**Alcance ya decidido con vos**: solo parámetros de comportamiento de la app
(TTL, límites, umbrales). Nada de credenciales de infraestructura — esas
siguen 100% en `.env`, sin excepción. Pantalla nueva, separada de
`library.html`, solo para administradores.

---

## 1. Inventario: qué entra y qué no

Repasé cada variable que hoy se lee de `process.env` en `server.js` y
`lib/*.js` (usando `lib/envValidation.js` como mapa, porque ya centraliza
"todas las numéricas del proyecto"). Las clasifiqué en tres grupos:

### 1.1 Candidatas claras para el panel (parámetros de comportamiento puro)

| Variable | Dónde vive hoy | Qué controla |
|---|---|---|
| `ROOM_TTL_HOURS` | `lib/roomStore.js` | Horas sin actividad antes de que una sala expire |
| `MAX_LIBRARY_VIDEOS` | `server.js` | Tope de videos en la biblioteca |
| `MAX_LIBRARY_SIZE_GB` | `server.js` | Tope de almacenamiento de la biblioteca |
| `R2_PRESIGN_EXPIRES_SECONDS` | `server.js` | Vencimiento de la URL prefirmada de subida |
| `ALERT_HEALTH_FAILURE_THRESHOLD` | `lib/alerts.js` | Cuántos healthchecks seguidos en falla antes de alertar |
| `ALERT_COOLDOWN_MS` | `lib/alerts.js` | Cuánto esperar antes de reenviar la misma alerta |
| `MULTIPART_ABANDON_DAYS` | `server.js` | Antigüedad para considerar abandonada una subida multipart |
| `LIBRARY_ORPHAN_DAYS` | `scripts/library-orphan-report.js` | Antigüedad para el reporte de videos huérfanos |

### 1.2 Candidatas dudosas — son "de comportamiento" pero fijan la duración de un `setInterval` al arrancar

| Variable | Qué controla |
|---|---|
| `ROOM_SWEEP_INTERVAL_MS` | Cada cuánto se barren salas expiradas en memoria |
| `MULTIPART_SWEEP_INTERVAL_MS` | Cada cuánto se limpian subidas multipart abandonadas en R2 |
| `ALERT_CHECK_INTERVAL_MS` | Cada cuánto corre el chequeo de salud para alertas |
| `SHUTDOWN_GRACE_MS` | Margen de gracia al recibir SIGTERM |

Ver sección 4 — el problema no es si "deberían" ser administrables (sí, son
comportamiento), sino que hoy arman un `setInterval(fn, X)` **una sola vez al
arrancar**; cambiarlas en caliente sin reiniciar el proceso es más trabajo del
que parece. Propongo dejarlas afuera de la v1 del panel (siguen por `.env`) y
sumarlas después si hace falta — no bloquea nada del resto.

### 1.3 Acciones operativas (nuevo, a pedido — no son "settings", son botones)

Distinto de los parámetros de la sección 1.1: esto no es "cambiar un número
guardado", es **ejecutar algo ahora mismo** sobre las salas activas. Ya
confirmamos el alcance de cada botón con vos:

| Botón | Qué hace | Riesgo | Lógica que reusa |
|---|---|---|---|
| **Ver salas activas** | Lista cada sala: id, cantidad de viewers conectados ahora, dueña (email o anónima), última actividad, referencia de video, **host actual** (nombre/userId asociado a `room.hostSocketId`) | Ninguno (solo lectura) | Nuevo, lee del objeto `rooms` en memoria |
| **Limpiar salas** | Fuerza YA el barrido de salas vencidas por TTL (24hs sin actividad), sin esperar el próximo ciclo de 30 min | Bajo — por definición son salas sin uso reciente | 100% la `sweepExpiredRooms()` que ya existe, solo se dispara a demanda además de por el interval |
| **Cerrar salas inactivas** | Cierra las que tienen **0 viewers conectados desde hace al menos ~30s** (no en el instante exacto), aunque todavía no lleguen a las 24hs de TTL (ej. todos se desconectaron hace 10 min) | Medio — no molesta a nadie mirando, pero adelanta un cierre que iba a pasar solo más tarde | Función nueva `closeRoom()` (ver más abajo), con un selector distinto al de TTL |
| **Cerrar TODAS las salas** | Botón nuclear: cierra cada sala existente, **incluidas las que tienen gente mirando ahora mismo** — modo mantenimiento/emergencia | Alto — kickea gente activa sin aviso previo | Misma `closeRoom()`, aplicada a todas |

**`closeRoom(roomId, reason)` (nueva, extraída)**: generaliza lo que hoy hace
`sweepExpiredRooms()` en su loop — `io.to(roomId).emit('room-error', reason)`,
desconectar cada socket de esa sala, `delete rooms[roomId]`,
`roomStore.deleteRoom(roomId)`. El mensaje (`reason`) cambia según el
disparador (TTL vencido / cerrada por un administrador), para que si alguien
se queja de que "se le cerró la sala", el mensaje que vio en pantalla ya le
dice la causa real. `sweepExpiredRooms()` pasa a ser un loop que llama a esta
función nueva por cada sala expirada, en vez de tener su propia copia de la
lógica — mismo criterio de no duplicar código que ya usa el proyecto al
extraer `hostAuth.js`/`rateLimiter.js` en la Fase 5.

**Salvaguardas específicas para "Cerrar TODAS las salas"** (por el riesgo
alto):

- El front pide escribir una palabra de confirmación exacta (ej.
  `CERRAR TODO`) antes de habilitar el botón — no alcanza con un `confirm()`
  de un click, dado lo destructivo de la acción.
- El backend **vuelve a validar** esa misma palabra en el body del POST — no
  confiar en que el front la haya pedido; si alguien golpea el endpoint
  directo sin el campo correcto, se rechaza con 400. Defensa en profundidad,
  no específica de este proyecto pero vale la pena acá.
- Devuelve cuántas salas cerró y sus ids, para que quede en la respuesta (y
  en el audit log, ver 2.3) exactamente qué se afectó.

---

### 1.4 Deliberadamente afuera, para siempre

- **Todo lo que es credencial o secreto**: `DATABASE_URL`, `REDIS_URL`,
  `SESSION_SECRET`, `RESEND_API_KEY`, `SENTRY_DSN`, las 5 de R2,
  `METRICS_TOKEN`, `ALLOWED_ORIGINS`. Confirmado con vos, sección de alcance.
- **`LIBRARY_PASSWORD`**: es una contraseña compartida real, no un parámetro
  de comportamiento — cambiarla en caliente implica decidir qué pasa con
  quien ya la tenía guardada, invalidación, etc. Queda afuera de esta v1;
  se puede evaluar aparte si hace falta.
- **`SESSION_MAX_AGE_MS`**: técnicamente numérica y de comportamiento, pero
  tocarla en caliente es delicado (afecta cookies ya emitidas con el `maxAge`
  viejo horneado adentro). La dejaría afuera también, mismo criterio que
  `LIBRARY_PASSWORD`.

---

## 2. Modelo de seguridad

### 2.1 Roles

- Columna nueva `role TEXT NOT NULL DEFAULT 'user'` en la tabla `users`
  (migración idempotente, mismo patrón que las de `lib/db.js`).
- **Bootstrap del primer admin**: nada de UI para esto en la v1 — un
  `UPDATE users SET role = 'admin' WHERE email = '...'` a mano, o un script
  chico `scripts/make-admin.js <email>` (más prolijo, versionable, evita
  errores de tipeo en SQL a mano). Recomiendo el script.
- Nadie puede promoverse a sí mismo ni a otros desde la UI — evita tener que
  pensar en "quién puede dar admins" como problema de producto.

### 2.2 Middleware `requireAdmin`

Mismo patrón que `requireLibraryAuth`/`requireUploadAuth` ya existentes:

```js
async function requireAdmin(req, res, next) {
  if (!db.isEnabled()) return res.status(404).json({ error: 'No disponible.' });
  if (!(req.session && req.session.userId)) return res.status(401).json({ error: 'Requiere sesión.' });
  const user = await db.findUserById(req.session.userId); // nuevo método, ver 2.3
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Requiere rol de administrador.' });
  next();
}
```

Nota: hoy `req.session` solo guarda `userId`/`email` (ver `lib/sessionStore.js`
y el login en `server.js`) — el rol **no** debería viajar en la cookie de
sesión aunque esté firmada, porque si algún día se agrega una forma de
revocar/cambiar roles, una sesión vieja podría seguir "recordando" un rol que
ya no es válido. Mejor resolverlo con una consulta a Postgres en cada request
a `/admin/*` (son pocas, no es un endpoint de alto tráfico como `join-room`).

### 2.3 Auditoría (con las acciones operativas, ya no es opcional)

Con solo los "settings" de la sección 1.1, un historial completo era
recomendable pero no crítico (`app_settings.updated_at`/`updated_by_user_id`
alcanzaba). Con los botones de la sección 1.3, cambia la balanza: **"cerrar
TODAS las salas" es una acción con impacto directo en gente real, en el
momento** — ahí sí conviene un registro de verdad, no solo "el valor actual".

Tabla nueva, genérica para cualquier acción de admin (no solo settings):

```sql
CREATE TABLE IF NOT EXISTS admin_actions_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,        -- 'setting_changed' | 'room_closed' | 'rooms_closed_inactive' | 'rooms_closed_all' | 'sweep_forced'
  detail JSONB,                -- ej. { key: 'MAX_LIBRARY_VIDEOS', from: 0, to: 20 } o { roomIds: [...], count: 5 }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_actions_audit_created_at_idx ON admin_actions_audit (created_at);
```

`app_settings` sigue guardando solo el valor actual (para leer rápido en cada
uso, ver sección 3) — el historial de cambios vive acá, aparte. Cada ruta de
`/admin/*` que escriba algo (`POST /admin/settings`, y las 3 rutas de
acciones de la sección 1.3) inserta una fila acá antes de responder 200. No
hace falta UI para leer esta tabla en la v1 (se consulta con SQL directo si
hace falta investigar algo) — se puede sumar una pantalla de "historial" más
adelante si resulta útil en la práctica.

### 2.4 Otros puntos de seguridad

- **CSRF**: el proyecto ya usa `sameSite: 'lax'` en la cookie de sesión, que
  cubre el caso típico (un GET desde otro sitio no manda la cookie en un
  POST). Para `/admin/settings` (POST), dado que las consecuencias de un CSRF
  exitoso acá son más serias que en el resto de la app, conviene sumar un
  chequeo de `Origin`/`Referer` contra el propio host — barato, no requiere
  tokens CSRF nuevos ni tocar el esquema de sesión existente.
- **Rate limiting**: no hace falta uno nuevo — para llegar a `/admin/*` ya
  hace falta pasar por el rate limiting de login existente. Si en algún
  momento se agregara reseteo de contraseña de otros usuarios desde el panel
  (no está en el alcance de esta v1), ahí sí habría que pensar un límite
  propio.
- **Validación de cada valor**: cada setting necesita un validador propio
  (mínimo, máximo, tipo) del lado del servidor — no alcanza con "es un
  número", por ejemplo `MAX_LIBRARY_VIDEOS` negativo o `ROOM_TTL_HOURS` en
  `0.0001` son técnicamente números válidos pero probablemente errores de
  tipeo con consecuencias reales (borrar todo, o nunca expirar nada). Ver
  sección 3.3.
- **Qué hacer si Postgres no responde en medio de una lectura de settings**:
  a diferencia del arranque (donde el criterio del proyecto es fallar rápido),
  acá NO conviene tirar abajo una sala en curso por un timeout de Postgres al
  leer, por ejemplo, `ROOM_TTL_HOURS`. Ver sección 4.2 — el cache resuelve
  esto sirviendo el último valor conocido.

---

## 3. Almacenamiento y arquitectura

### 3.1 Esquema

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id UUID REFERENCES users(id)
);
```

Un registro por parámetro, solo si alguien lo tocó desde el panel — si la
`key` no existe, se usa el fallback (env → default), nunca un `NULL` a medio
camino.

### 3.2 `lib/settings.js` (nuevo)

Responsabilidades:

1. **Definir el catálogo**: nombre, tipo (`int`/`float`), default hardcodeado
   (el mismo que hoy vive disperso en cada archivo), y validador (min/max).
2. **Precedencia**: `app_settings` (Postgres) → `process.env` → default. Así
   ningún `.env` existente se rompe el día que se despliegue esto.
3. **Cache en memoria**: se lee todo de Postgres una vez al arrancar (si
   `DATABASE_URL` está configurada) y se guarda en un `Map`. Se invalida
   (relee esa key nomás) cada vez que `POST /admin/settings` guarda un
   cambio. Si Postgres se cae después de eso, el cache sigue sirviendo el
   último valor bueno — no hay riesgo de que una sala deje de tener TTL
   porque Postgres tuvo un hipo.
4. **API que expone**: `getSetting(key)` (síncrona, lee del cache),
   `refreshSetting(key)` / `refreshAll()` (async, relee de Postgres),
   `setSetting(key, value, userId)` (valida, escribe en Postgres, invalida
   cache), `describeSettings()` (para la UI: valor actual + de dónde sale —
   DB/env/default — útil para que el panel muestre "esto viene de tu
   `.env`" en vez de fingir que todo vive en la DB).
5. **Deshabilitado sin `DATABASE_URL`**: mismo criterio que `lib/db.js` —
   `getSetting(key)` cae directo a env→default sin tocar Postgres para nada,
   y las rutas `/admin/*` devuelven 404 (no 403, para no confirmar que existe
   la feature a quien no tiene ni Postgres configurado).

### 3.3 Catálogo con validadores (ejemplo, para discutir)

```js
const SETTINGS = {
  ROOM_TTL_HOURS: { type: 'float', default: null, min: 0.5, max: 24 * 30 }, // null = "nunca expira", ya es un valor válido hoy
  MAX_LIBRARY_VIDEOS: { type: 'int', default: 0, min: 0, max: 10000 }, // 0 = sin límite
  MAX_LIBRARY_SIZE_GB: { type: 'float', default: 0, min: 0, max: 100000 },
  R2_PRESIGN_EXPIRES_SECONDS: { type: 'int', default: 6 * 60 * 60, min: 60, max: 7 * 24 * 60 * 60 },
  ALERT_HEALTH_FAILURE_THRESHOLD: { type: 'int', default: 3, min: 1, max: 20 },
  ALERT_COOLDOWN_MS: { type: 'int', default: 30 * 60 * 1000, min: 60 * 1000, max: 24 * 60 * 60 * 1000 },
  MULTIPART_ABANDON_DAYS: { type: 'float', default: 2, min: 0, max: 30 },
  LIBRARY_ORPHAN_DAYS: { type: 'float', default: 30, min: 0, max: 365 },
};
```

Los rangos son un punto de partida, no algo que investigué a fondo — vale la
pena que los revises vos, que conocés el uso real mejor que yo.

---

## 4. El problema real: "constantes leídas una sola vez al arrancar"

Esto es lo más importante de este documento, porque cambia cuánto trabajo es
esto en realidad.

### 4.1 Qué pasa hoy

Cada una de estas variables se lee **una sola vez**, al cargar el módulo:

```js
// lib/roomStore.js, nivel de módulo — corre UNA vez, al hacer require()
const ROOM_TTL_HOURS = parseFloat(process.env.ROOM_TTL_HOURS);
```

Si el panel solo escribe en Postgres pero el código sigue leyendo esa
constante capturada al arrancar, **cambiar el valor desde la UI no haría
nada** hasta el próximo restart del proceso — lo cual no es el punto de tener
un panel.

### 4.2 La solución: reemplazar la constante por una función

Para los 8 parámetros de la sección 1.1, hay que cambiar cada lugar que hoy
dice `ROOM_TTL_HOURS` (la constante) por `settings.getSetting('ROOM_TTL_HOURS')`
(la función, que lee del cache en memoria de `lib/settings.js` — rapidísima,
no es un round-trip a Postgres en cada uso). Esto toca:

- `lib/roomStore.js` (`ROOM_TTL_HOURS` → recalcular `ROOM_TTL_SECONDS` en el
  momento de cada `saveRoom()`, no una vez al cargar el módulo)
- `server.js` (`MAX_LIBRARY_VIDEOS`, `MAX_LIBRARY_SIZE_GB`,
  `R2_PRESIGN_EXPIRES_SECONDS`, `MULTIPART_ABANDON_DAYS`)
- `lib/alerts.js` (`ALERT_HEALTH_FAILURE_THRESHOLD`, `ALERT_COOLDOWN_MS`)
- `scripts/library-orphan-report.js` (`LIBRARY_ORPHAN_DAYS`) — este es un
  script de línea de comandos que se corre a mano, no un proceso persistente;
  ahí alcanza con que lea `settings.getSetting()` al arrancar el script (cada
  ejecución ya es "fresca", no hay problema de valor viejo cacheado).

Es un cambio mecánico y de bajo riesgo (cambiar una referencia por una
llamada a función), pero toca varios archivos y necesita que los tests
existentes de Fase 5 (`test/*.test.js`) se revisen para inyectar
`lib/settings.js` de mentira, igual que ya hacen con `roomStore`/`db` mockeados.

### 4.3 Los 4 que quedan afuera de la v1 (sección 1.2)

`ROOM_SWEEP_INTERVAL_MS`, `MULTIPART_SWEEP_INTERVAL_MS`,
`ALERT_CHECK_INTERVAL_MS`, `SHUTDOWN_GRACE_MS` arman un `setInterval` una
sola vez. Hacerlos "vivos" de verdad implicaría un mecanismo de
re-programar el interval cuando cambia el valor (`clearInterval` +
`setInterval` de nuevo), lo cual es más superficie de bug para un beneficio
chico (son parámetros que casi no hace falta tocar seguido, a diferencia de
`MAX_LIBRARY_VIDEOS` que sí tiene sentido ajustar seguido). Propongo:
quedan **fuera del panel en la v1**, se ajustan como siempre por `.env` +
restart. Si más adelante resulta que sí hace falta tocarlos seguido, se
puede sumar un mecanismo de re-schedule como tarea aparte.

---

## 5. API

```
GET  /admin/settings
  → 200 { settings: [ { key, value, source: 'db'|'env'|'default', type, min, max } ] }
  → 401 / 403 / 404 según corresponda (ver requireAdmin)

POST /admin/settings
  body: { key, value }
  → 200 { key, value, source: 'db' }
  → 400 si el valor no valida (fuera de rango, tipo incorrecto)
  → 401 / 403 / 404
```

Un endpoint por cambio (no un PUT masivo de todo el catálogo junto) — más
simple de auditar ("se cambió X a Y"), y evita pisar un cambio concurrente de
otra key por accidente.

### 5.1 Dashboard y acciones operativas (sección 1.3)

```
GET  /admin/stats
  → 200 { activeRooms, connectedUsers, uploadsInProgress, r2ErrorCount }
  Reusa lib/metrics.js (ya existe desde la Fase 4) — no hay que inventar
  contadores nuevos, solo exponerlos también acá para el dashboard del panel.

GET  /admin/rooms
  → 200 { rooms: [ { roomId, viewerCount, owner: 'email'|'anónima',
                      lastActivity, videoRef } ] }
  Lee directo del objeto `rooms` en memoria (una sola instancia, Fase 0) —
  no hace falta ir a Redis para esto, `rooms` ya es la fuente de verdad para
  lecturas síncronas en todo el proyecto.

POST /admin/rooms/sweep-now
  → 200 { closed: number, roomIds: [...] }
  Dispara sweepExpiredRooms() a demanda. Reusa 100% la función existente.

POST /admin/rooms/:id/close
  → 200 { closed: true }
  → 404 si el roomId no existe
  Cierra una sala puntual (botón individual en la lista de "Ver salas
  activas"), vía la `closeRoom()` extraída (ver sección 1.3).

POST /admin/rooms/close-inactive
  → 200 { closed: number, roomIds: [...] }
  Cierra las que tienen 0 viewers conectados desde hace al menos ~30s
  (mismo margen que ya usa `recentDisconnects` para reconexiones — evita
  cerrar una sala en el instante exacto en que alguien se cortó por un
  problema de red breve).

POST /admin/rooms/close-all
  body: { confirm: "CERRAR TODO" }
  → 200 { closed: number, roomIds: [...] }
  → 400 si `confirm` no coincide exactamente (ver salvaguardas, sección 1.3)
  El botón nuclear.
```

Las 4 rutas de acción (`sweep-now`, `:id/close`, `close-inactive`,
`close-all`) insertan una fila en `admin_actions_audit` (sección 2.3) antes
de responder.

---

## 6. Frontend — `public/admin.html`

- Reusa el patrón ya existente de `library.html`/`index.html`: chequeo de
  sesión vía `GET /auth/me` al cargar, `mnPrompt()` para cualquier
  confirmación, mismo `style.css`.
- Si `GET /auth/me` dice `loggedIn: false`, o `GET /admin/settings` devuelve
  401/403/404, redirige a `index.html` (no muestra ni un mensaje de "esto es
  para admins", para no confirmarle a cualquiera que la pantalla existe).
- Un input por parámetro, con: valor actual, de dónde sale (etiqueta chica
  "desde tu .env" / "por defecto" / "editado acá"), y un botón "Restaurar
  default" por fila (borra la key de `app_settings`, vuelve a caer a
  env/default).
- **Sección aparte, arriba de los settings**: dashboard con los 4 contadores
  de `GET /admin/stats`, más la tabla de `GET /admin/rooms` (una fila por
  sala, con su propio botón "Cerrar" — usa `mnPrompt()` para el confirm
  simple, mismo componente que ya usa el resto del proyecto).
- Tres botones de acción global, separados visualmente del resto (más abajo
  en la página, con algo de espacio/color que los distinga de los toggles de
  configuración): "Limpiar salas" (sin confirmación, es de bajo riesgo),
  "Cerrar salas inactivas" (confirmación simple con `mnPrompt()`), y "Cerrar
  TODAS las salas" (input de texto exigiendo escribir `CERRAR TODO`, no un
  botón de un solo click — ver salvaguardas de la sección 1.3).
- Sin JS framework, consistente con el resto del proyecto (vanilla).

---

## 7. Tests (siguiendo el patrón de la Fase 5)

- `lib/settings.js` es la pieza a testear aislada (como `hostAuth.js`,
  `rateLimiter.js`, etc. en `test/`): precedencia DB→env→default, validación
  de rangos, invalidación de cache al hacer `setSetting`, comportamiento sin
  `DATABASE_URL`.
- `requireAdmin` testeable con un `db` de mentira (mismo patrón que
  `passwordAuth.test.js` ya mockea `db`).
- `closeRoom()` extraída (sección 1.3) testeable igual que `setHost()` ya lo
  es: un `io` de mentira, confirmar que emite `room-error`, desconecta los
  sockets de esa sala y llama a `roomStore.deleteRoom`. `sweepExpiredRooms()`
  se re-testea para confirmar que sigue funcionando igual ahora que delega en
  la función extraída (no debería cambiar comportamiento observable, ver
  sección 4.2 del criterio "cambio mecánico, bajo riesgo").
- El selector de "salas inactivas" (0 viewers conectados desde hace al menos
  ~30s, reusando el mismo criterio de `recentDisconnects`) y la validación de
  `confirm === 'CERRAR TODO'` en `close-all` son lógica pura, fácil de
  testear sin levantar Socket.io real.

---

## 8. Orden sugerido de implementación (si se aprueba el diseño)

1. Migración: columna `role` en `users` + tablas `app_settings` y
   `admin_actions_audit`.
2. `scripts/make-admin.js`.
3. `lib/settings.js` con su catálogo y tests.
4. Refactor de los 8 puntos de la sección 4.2 (constante → función) — esto
   se puede hacer y mergear ANTES de tener el panel siquiera, ya que el
   comportamiento no cambia (sigue leyendo env→default si nadie tocó nada
   en Postgres todavía). Es el paso de mayor superficie de cambio, conviene
   aislarlo.
5. Extraer `closeRoom()` de `sweepExpiredRooms()` (sección 1.3) — también
   sin cambio de comportamiento observable, se puede mergear solo, aparte del
   panel, con sus tests.
6. Rutas `/admin/settings` (GET/POST) + `requireAdmin`.
7. Rutas de dashboard/acciones (`/admin/stats`, `/admin/rooms`, y las 4 de
   cierre de salas) + inserts en `admin_actions_audit`.
8. `public/admin.html` (settings + dashboard + botones, todo junto).
9. Prueba end-to-end: crear admin, cambiar `MAX_LIBRARY_VIDEOS` desde el
   panel sin reiniciar el server, abrir un par de salas de prueba y
   confirmar que "cerrar salas inactivas" no toca las que tienen gente
   mirando, y que "cerrar TODAS" sí kickea a todos y pide la palabra de
   confirmación tanto en el front como si se golpea el endpoint directo sin
   ella.

---

## 9. Preguntas — todas resueltas (diseño confirmado)

Alcance de "cerrar todas" vs. "cerrar inactivas" como dos botones separados
(sección 1.3), y que "limpiar salas" es forzar el barrido existente por TTL
— resuelto desde el inicio. Con las acciones operativas, la auditoría deja
de ser opcional (sección 2.3, resuelto hacia la versión con historial
completo). El resto, confirmado en la conversación de revisión del plan:

1. **Los 8 parámetros de la sección 1.1**: confirmados tal cual, sin sacar
   ni agregar ninguno.
2. **Rangos min/max de la sección 3.3**: confirmados tal cual la propuesta
   — se ajustan más adelante si el uso real muestra que algún límite quedó
   corto o generoso (cambio de una línea en `lib/settings.js`).
3. **Los 4 parámetros de intervalos (sección 4.3)**: confirmado que quedan
   fuera de la v1, se siguen ajustando por `.env` + restart.
4. **"Ver salas activas"**: además de id/viewers/dueña/última
   actividad/referencia de video, se suma el **host actual** de cada sala
   (nombre/userId asociado a `room.hostSocketId`) — ver la fila actualizada
   en la tabla de la sección 1.3. Ver el chat de la sala queda descartado
   (abre un problema de privacidad — leer conversaciones de otros — que no
   hace falta resolver para este alcance).
5. **"Cerrar salas inactivas"**: el criterio queda en **0 viewers conectados
   desde hace al menos ~30s** (no en el instante exacto) — reusa el mismo
   margen que ya existe en `room.recentDisconnects` para reconexiones, en
   vez de inventar un concepto de tiempo nuevo. Ver las secciones 1.3, 5.1 y
   7 actualizadas.
6. **Palabra de confirmación para "Cerrar TODAS"**: `CERRAR TODO`, sin
   cambios.

Con esto el diseño queda cerrado — el orden de implementación (sección 8)
puede arrancar tal como está.
