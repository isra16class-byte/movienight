# 📎 Memoria del proyecto (activa) — MovieNight

**Leé esto primero** al retomar el proyecto (vos o una IA). Es un resumen corto a
propósito, y es el que se sigue actualizando de ahora en adelante — el detalle
histórico completo, versión por versión, quedó archivado en
`docs/historico/MEMORIA.md` (largo, ~1850 líneas) y `docs/historico/CHANGELOG.md`,
pero para arrancar a trabajar no hace falta leer eso de entrada.

Cada cambio importante que se haga de ahora en adelante debería:
1. Actualizar este archivo si cambia algo de lo esencial (arquitectura, roles, riesgos).
2. Agregar una entrada en `docs/CHANGELOG.md` (el nuevo, no el archivado).


---

## Qué es

Watch party privado: el host sube un video, se crea una sala con código, los
amigos entran por link/código y ven el video sincronizado, con chat y
reacciones. Repo: `https://github.com/isra16class-byte/movienight`.

## Stack

- **Backend**: Node + Express + Socket.io (sync de video, chat, presencia, todo en tiempo real).
- **Subida de video**: Multer → disco local (`public/uploads/`) **o** Cloudflare R2 si está configurado (modo dual, ver `lib/r2.js` y README).
- **Frontend**: HTML/CSS/JS vanilla, sin framework.
- **Estado de las salas**: `rooms` sigue siendo un objeto en memoria dentro de `server.js` (las lecturas son síncronas, sensibles a latencia por el sync de video/chat en tiempo real), pero desde la Fase 1.1 cada mutación relevante se respalda en **Redis** (`lib/roomStore.js`), y al arrancar el server se repuebla desde ahí — sobrevive a un reinicio del proceso. Si Redis no responde, el server no arranca (mismo criterio "fallar rápido" que ya usaba R2); `DISABLE_REDIS=1` es un escape hatch solo para desarrollo local, nunca para producción.
- **Cuentas de usuario**: desde la Fase 2bis, **PostgreSQL** (`lib/db.js`, vía `pg`) guarda el modelo de usuario (tabla `users`: email, password hasheado con bcrypt). Motor separado de Redis a propósito — Redis sigue siendo solo para el estado efímero de las salas. Sin `DATABASE_URL` configurada, el registro/login queda deshabilitado pero el resto de la app sigue funcionando igual (no es un escape hatch de producción, es un feature opcional todavía no activado); si SÍ está configurada y Postgres no responde al arrancar, mismo criterio de "fallar rápido" que Redis/R2. Con `DATABASE_URL` configurada, un login exitoso también deja una **sesión de servidor real** (`lib/sessionStore.js`, sobre la misma conexión de Redis que ya usa `roomStore.js`): cookie `movienight.sid` httpOnly/sameSite=lax, contenido (`userId`/`email`) guardado server-side, revocable con `POST /auth/logout` — ver más abajo el detalle y lo que todavía falta de esta fase.
- **Exposición a internet**: Cloudflare Tunnel (no hay hosting propio todavía).

## Estructura de archivos

```
movienight/
  server.js              # Todo el backend: rutas HTTP + lógica de sockets
  lib/r2.js                # Cloudflare R2 (opcional): subir/listar/borrar videos
  lib/roomStore.js          # Persistencia de salas en Redis (Fase 1.1 del plan de producción)
  lib/db.js                # Postgres: modelo de usuario, registro/login (Fase 2bis del plan de producción)
  lib/sessionStore.js      # Sesiones de usuario sobre Redis (Fase 2bis del plan de producción)
  scripts/r2-cleanup-multipart.js
  public/
    index.html            # Crear sala / unirse por código
    library.html            # Biblioteca de videos ya subidos (con contraseña propia)
    room.html              # La sala: reproductor, chat, controles (la mayoría de la lógica de cliente vive acá)
    style.css, sw.js, manifest.webmanifest
  docs/
    MEMORIA.md              # Este archivo (resumen activo — se actualiza)
    CHANGELOG.md             # Historial de cambios activo (nuevas entradas van acá)
    PLAN-PRODUCCION.md      # Roadmap de robustez/seguridad/infra para producción
    historico/               # Registro archivado (MEMORIA.md, CHANGELOG.md viejos) — consultar solo si hace falta el porqué histórico de algo
```

## Modelo de datos (en memoria, `server.js`, respaldado en Redis desde Fase 1.1)

```js
rooms = {
  [roomId]: {
    videoFile, subtitleFile,       // rutas locales o keys de R2
    viewers, hostToken, hostSocketId,
    passwordHash,                   // bcrypt (Fase 2.1) — hashes viejos en sha256 se migran solos
                                     // al próximo login exitoso, ver verifyPassword() en server.js
    mutedUserIds: Set,
    userNames: Map,
    bufferingSockets: Set,
    recentDisconnects: Map          // margen de 15s para reconexiones
  }
}
```

## Sistema de roles — lo esencial

- **Un solo host por sala**, controlado por `room.hostSocketId` (fuente de verdad única, ver `setHost()`). Solo el host puede play/pause/seek, y sus eventos son los únicos que el server retransmite como `sync`.
- **Traspaso de host**: automático si el host se desconecta (pasa al más antiguo conectado), o manual (`make-host`). Ambos pasan por `setHost()`, que siempre degrada al host anterior antes de promover — esto corrigió un bug real de "hosts duplicados" (detalle en `docs/historico/MEMORIA.md`, sección 5bis, por si algo similar vuelve a aparecer).
- **`hostToken`**: credencial random guardada en `localStorage` del creador, sin expiración ni forma de revocarla hoy — riesgo conocido, ver plan de producción.
- **`userId`**: UUID persistente en `localStorage` (no por sala), usado para mute/reconexión — distinto de `socket.id`, que cambia en cada conexión.

## Sincronización de video

Socket.io retransmite `sync` (play/pause/seek + heartbeat cada 4s del host) a
todos en la sala. El cliente usa una bandera `ignoreSync` (~200-300ms) para no
reenviar como propio un cambio que vino del server. Los invitados no pueden
mover la barra de progreso — cualquier intento se revierte.

## Decisiones de diseño que conviene recordar

- **Video servido por HTTP directo, no P2P/WebRTC** — elegido por simplicidad. El trade-off (ancho de banda del host limitaba cuántos espectadores remotos aguantaban fluido) es justo lo que R2 resuelve al sacar el video de la ecuación del propio servidor.
- **Sin cuentas de usuario** — solo nombre + tokens en `localStorage`, sin login real.
- **Cloudflare Tunnel en vez de hosting pago** — para no tener que subir videos de varios GB a un servicio pago cada vez que cambia la película.

## Riesgos de seguridad conocidos (resumen — detalle y plan de acción en `docs/PLAN-PRODUCCION.md`)

- ~~Contraseñas (sala y biblioteca) con `sha256` sin salt~~ → resuelto en
  Fase 2.1 (bcrypt, con migración transparente desde hashes viejos).
- ~~Sin rate-limiting en `join-room` ni en el chat~~ → resuelto en Fase 2.2.
- `hostToken` sin expiración, viaja en texto plano — con el modelo de usuario
  y registro/login ya en pie (Fase 2bis) y ahora también **sesiones reales**
  (cookie httpOnly, ver arriba), sigue siendo el mismo riesgo hasta que se
  implemente la **migración del rol de host** de esa misma fase (validar
  "soy el dueño de la sala" contra la sesión en vez del `hostToken`) — ver
  `docs/PLAN-PRODUCCION.md`.
- Sin validación real de tipo de archivo (solo `Content-Type` del navegador).
- Las salas nunca expiran — se acumulan en memoria y en R2 indefinidamente.
- **Nuevo (2026-09-05, encontrado probando en producción real)**: subir un
  video real vía `create-room` devuelve `413 Payload Too Large` de
  **Cloudflare** (no del server) — el proxy corta el request antes de que
  llegue a Node. Bloqueante para el caso de uso central del proyecto (subir
  películas de varios GB). Detalle y camino a evaluar (subida directa a R2
  con URL prefirmada, sin pasar por el Tunnel) en la Fase 2.7 de
  `docs/PLAN-PRODUCCION.md`.

## Cómo se trabaja en este repo

- El asistente (IA) no hace push directo. Flujo real: clona el repo → hace el cambio → commit local → genera un patch con `git format-patch -1 HEAD` → lo entrega como archivo descargable → el usuario lo aplica con `git am nombre.patch` y hace `git push` él mismo.
- Cada cambio importante debería reflejarse acá (este archivo, `docs/MEMORIA.md`, si cambia algo esencial) y como entrada nueva en `docs/CHANGELOG.md` — no en los archivos de `docs/historico/`, que quedaron congelados como registro del estado anterior a esta reorganización.

## Por dónde seguir

Ver `docs/PLAN-PRODUCCION.md` para el roadmap completo de qué falta para
producción, con las fases priorizadas. Decisiones de arquitectura ya tomadas
(Fase 0, 2026-09-05): **una sola instancia alcanza** (no hace falta escalar
horizontalmente todavía — Fase 3 pospuesta), **va a haber cuentas reales de
usuario** (login — esto es ahora la Fase 2bis del plan, y reemplaza la idea
original de solo "endurecer" el `hostToken` anónimo), **sigue siendo un solo
servidor con una biblioteca compartida** (no hace falta multi-tenancy), y el
**hosting todavía no está decidido** (mantener el trabajo de infraestructura
agnóstico de proveedor mientras tanto).

Orden recomendado: persistencia externa + manejo de errores + supervisión de
proceso (Fase 1) → hashing de contraseñas + rate limiting (Fase 2.1/2.2) →
sistema de cuentas reales (Fase 2bis) → expiración de salas/storage (Fase 2.6).

**Fase 1 completa (2026-09-05)**: los cinco puntos (persistencia externa 1.1,
manejo de errores no capturados 1.2, proceso supervisado 1.3, graceful
shutdown 1.4, healthcheck 1.5) ya están resueltos — el detalle de cada uno
está más abajo.

**Fase 2.1/2.2 completas (2026-09-05)**: hashing de contraseñas con bcrypt
(con migración transparente desde los hashes `sha256` viejos, sin resetear
contraseñas existentes) y rate limiting en `join-room` (3 intentos/15min,
igual criterio que ya usaba la subida de cintas), en el chat (flood, 8
msj/10s por socket) y una capa general sobre las rutas HTTP de la API. Sigue
el orden recomendado: **Fase 2bis** (cuentas reales) es el próximo paso —
es el cambio de mayor superficie de esta ronda, conviene encararlo antes de
seguir invirtiendo en el esquema actual de `hostToken`/sala anónima.

**Fase 1.5 (healthcheck) ya resuelta (2026-09-05)**: `GET /health` (alias
`/healthz`) en `server.js` — 200 solo si el proceso responde Y cada
dependencia externa *habilitada* (Redis vía `roomStore.ping()`, R2 vía
`r2.testConnection()`) respondió dentro de un timeout corto (3s); 503 con el
detalle si alguna falla, o si el server está en medio de un graceful
shutdown. Una dependencia deshabilitada (`DISABLE_REDIS=1`, o R2 no
configurado) no cuenta como falla, pero se reporta igual en la respuesta.
Probado con Redis real: apagarlo **sin reiniciar el proceso Node** hace que
la siguiente consulta a `/health` pase de 200 a 503 — confirma que detecta
una caída en caliente, no solo el estado del arranque.

**Fase 1.4 (graceful shutdown) ya resuelta (2026-09-05)**: `server.js` captura
`SIGTERM`/`SIGINT`, avisa a todos los conectados (`io.emit('server-restarting')`,
manejado en `room.html` con un banner) y deja de aceptar conexiones HTTP
nuevas, todo antes de tocar los sockets activos. Recién después de un margen
configurable (`SHUTDOWN_GRACE_MS`, default 5s) se cierran los sockets, se
cierra Redis prolijamente (`roomStore.closeConnection()`, `QUIT` en vez de
matar la conexión) y termina el proceso. Al reconectar, el flujo normal de
`join-room` ya recupera el estado — no hizo falta lógica nueva para eso.
Con esto queda cerrada la Fase 1 completa (ver arriba).

**Fase 1.3 (proceso supervisado) ya resuelta (2026-09-05)**: `ecosystem.config.js`
con configuración de **PM2** para el caso de VPS propio (`npm run pm2:start`,
`pm2:stop`, `pm2:restart`, `pm2:logs`, `pm2:status` — ver README, sección
"Proceso supervisado"), con reinicio automático y backoff exponencial
(`exp_backoff_restart_delay`) más un tope de reinicios seguidos
(`min_uptime` + `max_restarts`) para no loopear infinito si el problema es
persistente (ej. Redis caído). Si en cambio se hostea en Railway/Render/Fly.io,
no hace falta nada de esto — ya reinician el proceso solos usando `npm start`.
**Fix agregado (2026-09-05, encontrado verificando la Fase 1 en Windows)**:
faltaba `kill_timeout: 8000` en `ecosystem.config.js` — sin esto, el
`SIGKILL` por default de PM2 (~1.6s) llegaba antes que el margen prolijo de
`SHUTDOWN_GRACE_MS` (5s, ver Fase 1.4 abajo), matando el proceso a mitad del
cierre ordenado de Redis. Si se cambia `SHUTDOWN_GRACE_MS`, hay que subir
`kill_timeout` en consecuencia (son dos configs independientes). **Ese fix
no alcanzaba en Windows**: confirmado (con ayuda de GitHub Copilot
investigando issues del propio repo de PM2) que Windows no entrega señales
POSIX reales — `pm2 stop`/`pm2 restart` ahí terminan forzando el cierre con
`taskkill /T /F` sin disparar nunca `process.on('SIGTERM', ...)`, así que
ningún valor de `kill_timeout` lo iba a arreglar. Se agregó la vía oficial
de PM2 para este caso: `shutdown_with_message: true` en
`ecosystem.config.js` + un listener `process.on('message', ...)` en
`server.js` que reacciona al mensaje IPC `shutdown` llamando a la misma
`gracefulShutdown()` — probado con `child_process.fork` simulando el
mensaje de PM2: cierre prolijo en 5.02s, igual que un `SIGTERM` directo en
Linux. Los listeners de `SIGTERM`/`SIGINT` siguen intactos para cuando se
corre sin PM2.

**Fase 1.2 (manejo de errores no capturados) ya resuelta (2026-09-05)**:
`process.on('uncaughtException'/'unhandledRejection')` a nivel global, y un
wrapper genérico (`safeSocketHandler`) envolviendo los handlers de
`io.on('connection', ...)` en `server.js` — un error en un solo evento de socket
ya no tira abajo el proceso ni afecta a las demás salas activas.

**Hallazgo bloqueante (2026-09-05)**: probando en producción real
(`sala.movienight-palomitasjuntos.uk`, detrás de Cloudflare) se confirmó que
la subida de un video real falla con `413 Payload Too Large` — de Cloudflare,
no del server — mientras que un archivo de 1KB de prueba sube sin problema.
El resto del pipeline probado funciona bien: rate limiting de `join-room`
(3 intentos → bloqueo 15 min, incluso con contraseña correcta después) y de
chat (8 msj/10s), y persistencia en Redis (una sala vieja responde con su
`videoFile`/`position` correctos). Queda anotado como Fase 2.7 en
`docs/PLAN-PRODUCCION.md`, con la subida directa a R2 vía URL prefirmada como
camino a evaluar — no implementado todavía.

**Fase 2bis en curso — modelo de usuario + registro/login completos (2026-09-05)**:
primer paso de la fase resuelto — `lib/db.js` (Postgres, motor separado de
Redis) con la tabla `users` y migraciones idempotentes al arrancar, más
`POST /auth/register` y `POST /auth/login` en `server.js` (bcrypt reusando
`hashPassword()`/`verifyPassword()` de la Fase 2.1, rate limiting reusando
`makeAttemptLimiter()` de la Fase 2.2 con clave `ip:email`). Sin
`DATABASE_URL` configurada, estas dos rutas quedan deshabilitadas (404
explícito) pero el resto de la app sigue funcionando exactamente igual que
antes — no es un cambio disruptivo para quien todavía no quiere cuentas de
usuario. Integrado en el healthcheck (`checks.postgres`) y en el graceful
shutdown (cierra el pool de conexiones prolijamente). Probado end-to-end con
Postgres real: alta con email duplicado (case-insensitive) → 409, validación
de formato de email y longitud mínima de contraseña, login case-insensitive,
mensaje de error genérico ante email inexistente (no permite enumerar
cuentas registradas), y el rate limiting bloqueando tras 3 intentos fallidos
(incluso la contraseña correcta queda bloqueada durante la ventana de 15
min, mismo comportamiento que `join-room`).

**Lo que falta de la Fase 2bis** (sin tocar todavía, a propósito — ver
`docs/PLAN-PRODUCCION.md` para el detalle de cada uno): **migración del rol
de host** (validar "soy el dueño de la sala" contra la sesión en vez del
`hostToken`), **biblioteca por sesión de usuario** en vez de
`LIBRARY_PASSWORD` única, **quién puede crear salas** (definir si hace falta
algo más que tener cuenta registrada), y **recuperación de contraseña**.

**Fase 2bis — sesiones reales ✅ (2026-09-05)**: `POST /auth/login` exitoso
ahora deja una sesión de servidor real, en vez de solo confirmar que las
credenciales son válidas. `lib/sessionStore.js` implementa el `Store` que
pide `express-session` sobre la misma conexión de Redis que ya usa
`lib/roomStore.js` (se evaluó `connect-redis`, pero su versión moderna tiene
como peer dependency el cliente `redis` oficial, no `ioredis` — más simple
un store propio, chico, que reusar dos clientes de Redis distintos en el
mismo proceso). Cookie `movienight.sid`: `httpOnly` (no accesible desde JS,
a diferencia de `hostToken` en `localStorage`), `sameSite: lax`, `secure`
por defecto (con escape hatch `SESSION_COOKIE_INSECURE=1` solo para
desarrollo local sin HTTPS — confirmado en pruebas que, sin el escape
hatch, la cookie efectivamente no se manda sobre HTTP plano, comportamiento
esperado y correcto), 30 días con renovación automática en cada request de
alguien logueado (`rolling: true`). `req.session.regenerate()` en el login
(mitiga session fixation) y `POST /auth/logout` para cerrar sesión
(`req.session.destroy()`, borra la entrada en Redis). Nuevo
`GET /auth/me` para que el frontend pueda preguntar el estado de sesión sin
poder leer la cookie directamente (es httpOnly a propósito). Si Redis está
deshabilitado (`DISABLE_REDIS=1`, desarrollo local) el middleware cae al
`MemoryStore` que trae `express-session` por default, con el mismo tipo de
aviso por consola que ya usan `roomStore.js`/`lib/db.js` para sus propios
escape hatches. Probado end-to-end con Redis y Postgres reales: registro →
login (cookie `Set-Cookie` con los flags esperados, sesión visible en Redis
con prefijo `movienight:sess:`) → `GET /auth/me` reconoce la sesión →
`POST /auth/logout` la borra de Redis y expira la cookie → `GET /auth/me`
vuelve a `loggedIn: false`. **Todavía NO reemplaza `hostToken`** como forma
de probar la identidad del host — eso es el siguiente punto pendiente de
esta fase (ver arriba y `docs/PLAN-PRODUCCION.md`).

**Lo que falta de la Fase 2bis** (sin tocar todavía, a propósito — ver

**Fase 1.1 (persistencia externa) ya resuelta (2026-09-05)**: `lib/roomStore.js`
respalda en Redis lo esencial de cada sala (cinta, posición, contraseñas,
muteos, chat) y lo repuebla al arrancar — una sala sobrevive a un reinicio del
proceso. Fail-fast si Redis está configurado y no responde (no arranca el
server); `DISABLE_REDIS=1` para desarrollo local sin Redis, nunca en
producción.
