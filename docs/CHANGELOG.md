# 📝 Changelog (activo) — MovieNight

Registro cronológico de cambios importantes, de más reciente a más antiguo. Este
archivo arranca vacío a partir de la reorganización de la documentación — el
historial completo de versiones anteriores (V1 a V24+) quedó archivado en
`docs/historico/CHANGELOG.md`.

Formato de cada entrada: fecha, qué cambió, por qué (breve — el detalle largo,
si hace falta, puede ir en el mensaje de commit).

---

## 2026-09-06 — Fase 2bis: verificación independiente en entorno real

- Se corrió el plan de pruebas completo (`PRUEBAS-FASE-2BIS.md`) en un
  entorno separado del usado para cerrar la fase (Windows, PowerShell,
  Docker para Redis/Postgres) — las 8 secciones dieron el resultado
  esperado: registro/login/sesiones, migración del rol de host, biblioteca
  por sesión, recuperación de contraseña con rate limiting, healthcheck,
  UI de login/biblioteca en el navegador, y la regresión sin
  `DATABASE_URL`.
- No se necesitó tocar código — los únicos tropiezos fueron de escaping de
  JSON en PowerShell al armar los `curl` a mano, no del servidor.
- Con dos verificaciones independientes (sandbox + entorno real del
  usuario), la Fase 2bis queda confirmada.

---

## 2026-09-06 — Fase 2bis (cierre): biblioteca por sesión + recuperación de contraseña

- **Biblioteca por sesión de usuario**: `requireLibraryAuth` (listar/borrar
  en `/api/uploads`) y `requireUploadAuth` (subir cinta nueva, crear sala,
  subtítulos) ahora aceptan una sesión de cuenta real como alternativa a
  `LIBRARY_PASSWORD` — no la reemplazan, los dos caminos conviven: el grupo
  sin cuenta no pierde acceso a nada, quien sí tiene cuenta deja de
  necesitar además la contraseña compartida.
- **UI mínima de login/registro/logout**: nueva en `index.html` y
  `library.html`, encadenando el componente `mnPrompt` ya existente (sin
  sumar un formulario nuevo). Antes de este cambio no había ninguna forma
  de loguearse desde el navegador, aunque `/auth/*` ya estaba listo desde
  un paso anterior de la Fase 2bis.
- **Recuperación de contraseña**: nuevas rutas `POST /auth/forgot-password`
  y `POST /auth/reset-password`, más `public/reset-password.html`. Email
  vía **Resend** (`lib/mailer.js`, HTTP directo con `fetch`, sin SDK ni
  SMTP). Tokens de un solo uso (`sha256` guardado, nunca en texto plano),
  vencimiento de 1 hora, tabla nueva `password_resets` en Postgres.
  Respuesta siempre genérica (exista o no el email) para no permitir
  enumerar cuentas, con un limitador propio (3 pedidos/hora por ip+email)
  que tampoco delata si se alcanzó el límite. Sin `RESEND_API_KEY`
  configurada, el link se loguea por consola (solo desarrollo local);
  reportado en el healthcheck (`checks.email`) sin contar como falla si no
  está habilitado.
- **Probado end-to-end** con Redis y Postgres reales: los tres caminos de
  acceso a biblioteca/subida (sin credencial → 401, con sesión → 200, con
  `LIBRARY_PASSWORD` → 200) dan el resultado esperado; el flujo completo de
  reseteo (token inválido → 400, contraseña corta → 400 sin gastar el
  token, token real + contraseña válida → 200, reintentar el mismo token →
  400, login viejo falla / login nuevo funciona, rate limiting confirmado
  contando links logueados).
- Con esto, la **Fase 2bis queda completa** — sin ítems pendientes en
  `docs/PLAN-PRODUCCION.md` bajo esa fase.

---

## 2026-09-06 — Fase 2bis: prueba end-to-end del camino "con dueño" + "quién puede crear salas"

- **Camino "con dueño" probado end-to-end** (pendiente desde el cambio
  anterior, ver entrada de abajo): con Redis y Postgres reales levantados,
  se confirmó por HTTP (`upload-subtitle`) y por Socket.io (`join-room`,
  con un cliente `socket.io-client` real mandando la cookie
  `movienight.sid` en el handshake) que `isRoomOwner()` se comporta como
  se esperaba en los 4 casos que importan: hostToken solo sin sesión → no
  autoriza; cookie del dueño sin hostToken → autoriza; hostToken correcto
  + cookie de otra cuenta → no autoriza; sala anónima + hostToken → sigue
  autorizando igual que siempre. Confirma que
  `io.engine.use(sessionMiddleware)` efectivamente deja
  `socket.request.session` disponible en el handshake tal como se esperaba
  por lectura de código. Este punto de la Fase 2bis queda cerrado del todo.
- **Decisión: "quién puede crear salas"** — se mantiene el mismo criterio
  de siempre (conocer la `LIBRARY_PASSWORD` compartida vía
  `requireUploadAuth`), sin exigir cuenta registrada ni verificación de
  email. Motivo: todavía no hay UI de login, así que exigir cuenta dejaría
  al grupo de amigos actual sin poder crear salas; verificar email sería
  sobre-ingeniería para un grupo que ya comparte una contraseña.
- **Gap corregido**: `/create-room-from-upload` (crear sala reusando una
  cinta ya subida a la biblioteca) no exigía ninguna contraseña, a
  diferencia de `/create-room` — cualquiera que supiera o adivinara un
  filename podía crear salas sin ningún control. Se agregó
  `requireUploadAuth` a esa ruta, y `library.html` ahora usa
  `mnLibraryFetch` (ya maneja el prompt/reintento ante un 401) en vez de
  `fetch` directo para esa llamada.
- **Probado**: `create-room-from-upload` sin contraseña → 401 con
  `attemptsLeft`; con la contraseña correcta → 200 y crea la sala; 3
  contraseñas incorrectas seguidas → bloqueo 429 por 15 min (mismo
  comportamiento que el resto de las rutas con `requireUploadAuth`).
- De paso, se corrigió un `package-lock.json` desactualizado
  (`express-session` y sus dependencias transitivas faltaban del lockfile
  aunque ya estaban en `package.json`) — sin esto, `npm ci` en un entorno
  limpio hubiera fallado.

---

## 2026-09-05 — Fase 2bis (tercer paso): migración del rol de host a la sesión

- **Nuevo campo `room.ownerUserId`**: se setea desde `req.session.userId`
  al crear una sala (`/create-room`, `/create-room-from-upload`) si quien
  la crea tiene una sesión iniciada; si no, queda `null` y la sala sigue
  el esquema anónimo de siempre (sin ningún cambio de comportamiento para
  quien no usa cuentas — no hay UI de login todavía). Persistido en Redis
  igual que `hostToken`/`passwordHash` (`lib/roomStore.js`), para que
  sobreviva a un reinicio del proceso.
- **`isRoomOwner(room, { hostToken, sessionUserId })`** (nuevo helper en
  `server.js`): punto único que reemplaza las comparaciones sueltas de
  `hostToken` que había en cada ruta/handler. Sala con dueño → el único
  criterio válido es que la sesión actual tenga ese mismo `userId` (un
  `hostToken` de `localStorage`, aunque coincida, ya no alcanza). Sala sin
  dueño → se mantiene `hostToken` contra `room.hostToken`, sin cambios.
  Nunca se combinan los dos criterios para la misma sala.
- **Socket.io ahora comparte la sesión de Express**: `io.engine.use(sessionMiddleware)`
  (soportado desde Socket.io 4.6+) deja `socket.request.session` disponible
  en cualquier handler — no hacía falta nada del lado del cliente, la
  misma cookie `movienight.sid` que ya se manda en cualquier request del
  mismo origen alcanza también para el handshake de Socket.io.
- **Puntos actualizados para usar `isRoomOwner()`**: `join-room` (Socket.io,
  decide si se llama a `setHost()`), `POST /room/:id/change-video`,
  `POST /room/:id/change-video-from-upload`, `POST /room/:id/upload-subtitle`.
  `room.hostSocketId` sigue siendo, sin cambios, la única fuente de verdad
  de "quién controla la sala ahora mismo" — lo que cambia es solo cómo se
  prueba "soy el dueño de esta sala" para poder reclamarlo.
- Esto cierra el riesgo anotado en `docs/MEMORIA.md` ("`hostToken` sin
  expiración, viaja en texto plano") para cualquier sala creada con sesión
  iniciada: la sesión vive en una cookie `httpOnly` (no accesible desde
  JS/XSS, a diferencia de `localStorage`) y es revocable al toque
  (`POST /auth/logout`).
- **Probado**: flujo anónimo de punta a punta con un server real
  (`DISABLE_REDIS=1`) — crear sala sin sesión → `join-room` con el
  `hostToken` correcto da host, con uno inválido no; `upload-subtitle` con
  `hostToken` inválido → 403, con el correcto → 200. Confirma que el
  esquema sin cuentas sigue exactamente igual que antes de este cambio.
  **Todavía no probado end-to-end el camino "con dueño"** (sesión real +
  `ownerUserId`): requiere Postgres arriba para poder loguearse de verdad,
  no disponible en el entorno donde se hizo este cambio — revisado por
  lectura de código y con el mismo criterio que ya usa `isRoomOwner()` en
  el resto de los call sites, pero pendiente de una prueba real con
  Postgres+Redis antes de darlo por cerrado del todo.
- **Lo que sigue faltando de la Fase 2bis**: quién puede crear salas,
  biblioteca por sesión de usuario (en vez de `LIBRARY_PASSWORD` única), y
  recuperación de contraseña — ver `docs/PLAN-PRODUCCION.md`.

---

- **Sesiones de servidor**: `POST /auth/login` exitoso ahora deja una
  sesión real en vez de solo confirmar credenciales válidas. Cookie
  `movienight.sid` (`httpOnly`, `sameSite: lax`, `secure` por defecto,
  30 días con `rolling: true`) vía `express-session`, respaldada en Redis
  con un store propio (`lib/sessionStore.js`) que reusa la misma conexión
  que ya expone `lib/roomStore.js` (`roomStore.getClient()`) — se descartó
  `connect-redis` porque su versión moderna depende del cliente `redis`
  oficial, no de `ioredis` (el que ya usa el proyecto), y sumar un segundo
  cliente de Redis solo para esto no valía la pena frente a un store chico
  y propio.
- **Nuevas rutas**: `POST /auth/logout` (`req.session.destroy()`, borra la
  sesión en Redis y expira la cookie) y `GET /auth/me` (para que el
  frontend consulte el estado de sesión, ya que la cookie es `httpOnly` y
  no se puede leer desde JS).
- **Session fixation**: el login llama a `req.session.regenerate()` antes
  de escribir `userId`/`email` — un `sid` que el navegador ya traía de
  antes del login no sobrevive al login.
- **Variables de entorno nuevas** (`.env.example`): `SESSION_SECRET`
  (se genera al azar si falta, mismo patrón que `LIBRARY_PASSWORD`, con la
  salvedad de que acá desloguea a todo el mundo en cada reinicio sin
  fijarla), `SESSION_MAX_AGE_MS` (default 30 días) y
  `SESSION_COOKIE_INSECURE=1` (escape hatch solo para desarrollo local sin
  HTTPS — sin él, confirmado en pruebas que la cookie no se manda sobre
  HTTP plano, comportamiento correcto del flag `secure`).
- Si `DISABLE_REDIS=1` (desarrollo local sin Redis), el middleware cae al
  `MemoryStore` que trae `express-session` por default, con el mismo tipo
  de aviso por consola que ya usan `roomStore.js`/`lib/db.js`.
- Probado end-to-end con Redis y Postgres reales: registro → login → sesión
  visible en Redis (prefijo `movienight:sess:`) → `GET /auth/me` la
  reconoce → `POST /auth/logout` la borra y expira la cookie → `GET
  /auth/me` vuelve a `loggedIn: false`.
- **Todavía no reemplaza `hostToken`** como forma de identificar al host de
  una sala — es el siguiente punto pendiente de la Fase 2bis (ver
  `docs/PLAN-PRODUCCION.md`).

---

## 2026-09-05 — Fase 2bis (primer paso): modelo de usuario + registro/login con PostgreSQL

- **Modelo de usuario**: nuevo `lib/db.js` — pool de conexiones a
  **PostgreSQL** (vía `pg`), separado de Redis a propósito (Redis sigue
  siendo solo para el estado efímero de las salas). Migraciones idempotentes
  (`CREATE TABLE IF NOT EXISTS`) corridas al arrancar, antes de aceptar
  tráfico. Tabla `users`: `id` UUID (vía `pgcrypto`, evita exponer
  cantidad/orden de registro), `email`, `password_hash`, `created_at`.
  Índice único **case-insensitive** sobre `email` (`LOWER(email)`) — dos
  emails que solo difieren en mayúsculas son la misma cuenta.
  Mismo criterio de "fallar rápido" que ya usan Redis/R2: si `DATABASE_URL`
  está configurada y Postgres no responde al arrancar, el server no arranca.
  Sin `DATABASE_URL`, las cuentas de usuario quedan deshabilitadas (404
  explícito en `/auth/*`) pero el resto de la app sigue funcionando
  exactamente igual que antes — no es un escape hatch de producción como
  `DISABLE_REDIS`, es un feature opcional todavía no activado.
  Integrado en el healthcheck (`checks.postgres`, `GET /health`) y en el
  graceful shutdown (`pool.end()` prolijo antes de cerrar el proceso).
- **Registro y login**: `POST /auth/register` y `POST /auth/login` en
  `server.js`. Contraseña hasheada con bcrypt reusando `hashPassword()`/
  `verifyPassword()` (misma función de la Fase 2.1, sin duplicar lógica de
  hashing). Validación de formato de email y mínimo 8 caracteres de
  contraseña en registro. Login devuelve el mismo mensaje genérico ("Email o
  contraseña incorrectos") tanto si el email no existe como si la
  contraseña está mal, para no dejar enumerar qué emails tienen cuenta
  registrada. Rate limiting reusando `makeAttemptLimiter()` (Fase 2.2, 3
  intentos → bloqueo 15 min), con clave `ip:email` (distinto de `join-room`,
  que usa `ip:roomId`): errar la contraseña de una cuenta no bloquea el
  intento de otra cuenta desde la misma IP, y probar el mismo email desde
  IPs distintas no permite saltarse el límite.
  **Todavía no implementado a propósito**: esto NO deja una sesión iniciada
  en el navegador (cookie httpOnly/JWT) — eso, junto con la migración del
  rol de host y el acceso a la biblioteca por sesión, es el paso siguiente
  dentro de la misma Fase 2bis (ver `docs/PLAN-PRODUCCION.md`).
- Probado end-to-end con Postgres y Redis reales: registro con email
  duplicado (incluso con mayúsculas/minúsculas distintas) → 409; email
  inválido → 400; contraseña corta → 400; login case-insensitive; email
  inexistente → mismo mensaje genérico que contraseña incorrecta; 3
  contraseñas incorrectas seguidas → bloqueo, y la contraseña CORRECTA
  inmediatamente después del bloqueo también queda bloqueada durante la
  ventana de 15 min (mismo comportamiento ya esperado de `join-room`);
  healthcheck reportando Postgres arriba; graceful shutdown cerrando el
  pool sin errores.
- `package.json`: agregada dependencia `pg`. `.env.example`: agregada
  `DATABASE_URL` (documentada como opcional).
- `docs/PLAN-PRODUCCION.md`: tachados "Modelo de usuario" y "Registro y
  login" dentro de la Fase 2bis. `docs/MEMORIA.md`: actualizado el stack,
  la estructura de archivos, riesgos conocidos y "por dónde seguir" (qué
  falta de la Fase 2bis: sesiones, migración del rol de host, biblioteca
  por sesión, recuperación de contraseña).

## 2026-09-05 — Hallazgo: Cloudflare bloquea subida de video real (413 Payload Too Large)

- Probando en producción real (`sala.movienight-palomitasjuntos.uk`, detrás
  de Cloudflare): un archivo de prueba de 1KB sube sin problema, pero un
  video real (mp4 de tamaño normal) devuelve `413 Payload Too Large` con
  página de error de **Cloudflare** — el request no llega al server.
  Cloudflare limita el tamaño de request según el plan (100MB en Free/Pro,
  200MB en Business), independiente de cualquier límite configurado en
  Multer/Express.
- Bloqueante para el caso de uso central del proyecto (subir películas de
  varios GB). Documentado como **Fase 2.7** en `docs/PLAN-PRODUCCION.md`, con
  la subida directa a R2 vía URL prefirmada (bypasseando el Tunnel para el
  binario del video) como camino a evaluar — todavía no implementado.
- De paso, se confirmó que sí funcionan bien en producción real: rate
  limiting de `join-room` (3 intentos → bloqueo 15min, incluso con la
  contraseña correcta después de bloqueado) y de chat (8 msj/10s, 4
  bloqueados de 12 enviados), y persistencia en Redis (sala vieja responde
  con `videoFile`/`position` correctos).
- `docs/MEMORIA.md`: agregado a riesgos de seguridad/infra conocidos y a
  "por dónde seguir".

## 2026-09-05 — Fase 2.1/2.2 del plan de producción: hashing con bcrypt + rate limiting

- **Hashing de contraseñas (2.1)**: `passwordHash` (sala) y `libraryPasswordHash`
  migran de `sha256` sin salt a **bcrypt** (10 rounds), vía `bcryptjs` (JS
  puro, sin bindings nativos — evita sumar un paso de build/toolchain al
  instalar en VPS, Windows o PaaS). `server.js`: nueva `verifyPassword(pw,
  hash)` que reconoce tanto el hash nuevo (bcrypt) como el viejo (sha256, de
  salas creadas antes de este cambio) y devuelve `needsRehash: true` si
  matcheó con el esquema viejo — el caller re-hashea con bcrypt y persiste el
  hash nuevo en Redis. Migración transparente, sin resetear ninguna
  contraseña existente: quien ya tenía una sala con contraseña no nota nada,
  y los hashes viejos van desapareciendo solos con el uso normal.
  `LIBRARY_PASSWORD` no necesita esta migración (no se persiste entre
  reinicios) — se hashea fresco con bcrypt dentro de `startServer()`, antes
  de aceptar conexiones.
- **Rate limiting (2.2)**:
  - `join-room`: nuevo límite de intentos de contraseña (3 intentos, bloqueo
    de 15 min), mismo criterio que ya usaba `requireUploadAuth` (V19) —
    extraído a un helper genérico (`makeAttemptLimiter()`) para no duplicar
    la lógica. Clave = `ip:roomId` (no solo `ip`): cada sala tiene su propia
    contraseña, así que errar la de una no debería bloquear el intento de
    entrar a cualquier otra desde la misma IP.
  - `chat-message`: límite de flood por socket (ventana deslizante, máx. 8
    mensajes cada 10s). Avisa solo a quien manda de más (`chat-rate-limited`),
    sin tocar el chat de los demás ni el historial.
  - Nueva capa general con `express-rate-limit` (300 req/5min por IP) sobre
    las rutas HTTP de la API, montada después de `express.static` y
    `express.json()` para no afectar el streaming de video ni el healthcheck
    (excluido explícitamente); el handshake de Socket.io tampoco pasa por
    acá (intercepta su propio path antes de llegar a Express).
  - `safeSocketHandler` ahora soporta handlers async (necesario para
    `join-room`, que pasó a usar bcrypt).
- Probado manualmente end-to-end con un cliente de Socket.io real: 3 intentos
  de contraseña incorrecta en `join-room` bloquean, y el 4° intento (aunque
  sea la contraseña correcta) también queda bloqueado durante la ventana;
  12 mensajes de chat seguidos → 8 llegan, 4 quedan bloqueados con el aviso
  correspondiente. La migración sha256→bcrypt se probó de forma unitaria
  (hash viejo + contraseña correcta → válido y marca `needsRehash`; hash
  viejo + contraseña incorrecta → inválido, sin marcar migración).
- `docs/PLAN-PRODUCCION.md`: tachados los ítems de Fase 2.1 y 2.2.
  `docs/MEMORIA.md`: actualizada la sección de riesgos de seguridad
  conocidos y "por dónde seguir" (próximo paso: Fase 2bis, cuentas reales).

## 2026-09-05 — Fix real: graceful shutdown en Windows vía IPC (shutdown_with_message)

- El fix anterior de `kill_timeout` (ver entrada de más abajo) era correcto
  pero no alcanzaba en Windows: confirmado (investigado con ayuda de GitHub
  Copilot contra issues del repo oficial de PM2 — PM2 #3555, #4469, #5914)
  que Windows no entrega señales POSIX reales. `pm2 stop`/`pm2 restart` ahí
  terminan forzando el cierre del proceso (`taskkill /T /F`) sin que
  `process.on('SIGTERM', ...)` llegue a dispararse nunca — ningún valor de
  `kill_timeout` iba a arreglar eso, porque el handler ni siquiera corre.
- `server.js`: nuevo listener `process.on('message', ...)` que reacciona al
  mensaje IPC `shutdown` (la vía oficial de PM2 para este caso, que sí
  funciona igual en Windows y Linux) llamando a la misma `gracefulShutdown()`
  que ya usaban `SIGTERM`/`SIGINT` — sin duplicar lógica.
- `ecosystem.config.js`: activado `shutdown_with_message: true`. Los
  listeners de señales siguen intactos, para cuando se corre el proceso sin
  PM2 (`node server.js` + Ctrl+C/kill directo).
- Probado con `child_process.fork` simulando el mensaje IPC que manda PM2:
  cierre prolijo confirmado en 5.02s (igual que un `SIGTERM` directo en
  Linux, ya probado antes). Queda pendiente la confirmación end-to-end con
  PM2 real en Windows (`pm2 stop`/`pm2 restart` + mirar los logs con
  `--timestamp`).

## 2026-09-05 — Fix: PM2 mataba el proceso antes de que terminara el graceful shutdown

- `ecosystem.config.js`: agregado `kill_timeout: 8000` (PM2). Sin esto, PM2
  manda `SIGKILL` a los ~1.6s por default tras un `pm2 stop`/`pm2 restart`/
  `pm2 reload`, muy por debajo del margen prolijo de `SHUTDOWN_GRACE_MS`
  (5000ms por default, ver Fase 1.4) que usa `server.js` para avisar a los
  clientes conectados y cerrar Redis con `QUIT` en vez de cortar la conexión
  de golpe. En la práctica: el banner de "servidor reiniciando" llegaba a
  los clientes, pero el cierre prolijo de Redis nunca alcanzaba a ejecutarse
  — PM2 mataba el proceso primero.
- Encontrado probando manualmente en Windows (PM2 + `pm2:stop`/`pm2:restart`)
  durante una verificación de la Fase 1 ya completa. Si se cambia
  `SHUTDOWN_GRACE_MS` por variable de entorno a más de ~6-7s, hay que subir
  `kill_timeout` en `ecosystem.config.js` también — son dos configuraciones
  independientes, en procesos distintos (PM2 vs Node), y no se leen una a la
  otra automáticamente.
- `README.md`: agregada nota en la sección "Proceso supervisado" explicando
  esto mismo, para que no se pierda la próxima vez que se toque
  `SHUTDOWN_GRACE_MS`.
- Pendiente de confirmar en Linux (donde señales POSIX son más confiables
  que en Windows — ver nota de la sesión anterior en el detalle de abajo):
  repetir la prueba de `pm2 stop`/`pm2 restart` verificando que el proceso
  ahora sí espera el margen completo antes de cerrar, en vez de asumir que
  el comportamiento en Windows es representativo del servidor real.

## 2026-09-05 — Fase 1.5 del plan de producción: healthcheck (cierra la Fase 1 completa)

- `server.js`: nuevo endpoint `GET /health` (alias `GET /healthz`) — 200 solo
  si el proceso responde Y cada dependencia externa *habilitada* respondió al
  chequeo dentro de un timeout corto (3s, `withTimeout()`), 503 con el
  detalle si alguna falla. Redis se chequea con `roomStore.ping()` (liviano,
  reusa el cliente ya conectado — distinto de `testConnection()`, que además
  conecta y solo tiene sentido llamarla una vez al arrancar); R2 con
  `r2.testConnection()` (el mismo `HeadBucketCommand` que ya se usaba al
  arrancar el server).
- Una dependencia deshabilitada (`DISABLE_REDIS=1`, o R2 no configurado —
  ambos son modos válidos de correr el proyecto, ver arriba) no cuenta como
  falla del healthcheck, pero se reporta igual en la respuesta
  (`{ enabled: false, ok: true }`) para que quede visible en qué modo está
  corriendo el proceso.
- Si el server está en medio de un graceful shutdown (Fase 1.4, flag
  `shuttingDown`), `/health` responde 503 `shutting_down` de una, sin hacer
  los chequeos — aunque en la práctica casi no llega a ejecutarse, porque
  `server.close()` ya dejó de aceptar conexiones nuevas para ese momento.
- `lib/roomStore.js`: nueva función `ping()` para este uso específico
  (chequeo liviano de vida, sin conectar ni reintentar como sí hace
  `testConnection()`).
- Probado con un Redis real levantado aparte (no con `DISABLE_REDIS=1`):
  `/health` responde 200 con Redis arriba, y **sin reiniciar el proceso
  Node**, apagar Redis hace que la siguiente consulta responda 503 con el
  mensaje de error de `ioredis` — confirma que el chequeo detecta una caída
  en caliente, no solo el estado que había al arrancar.
- Con esto se completan los 5 puntos de la **Fase 1 del plan de producción**
  (persistencia externa, manejo de errores, proceso supervisado, graceful
  shutdown, healthcheck). Próximo paso recomendado: Fase 2.1/2.2 (hashing de
  contraseñas + rate limiting) — ver `docs/PLAN-PRODUCCION.md`.

## 2026-09-05 — Fase 1.4 del plan de producción: graceful shutdown

- `server.js`: se agregaron handlers de `SIGTERM`/`SIGINT` (`gracefulShutdown`)
  que, en orden: (1) avisan a todos los clientes conectados con
  `io.emit('server-restarting')`; (2) dejan de aceptar conexiones HTTP nuevas
  (`server.close()`) sin cortar los sockets ya abiertos; (3) esperan un margen
  configurable (`SHUTDOWN_GRACE_MS`, default 5000ms) para que Socket.io
  termine de mandar cualquier mensaje en vuelo; (4) recién ahí cierran los
  sockets activos (`io.close()`), cierran la conexión a Redis prolijamente
  (`roomStore.closeConnection()`, `QUIT` en vez de matar el socket) y hacen
  `process.exit(0)`. Un flag (`shuttingDown`) evita que un segundo
  `SIGTERM`/`SIGINT` mientras ya se está cerrando reinicie el timer.
- `lib/roomStore.js`: nueva función `closeConnection()` — cierra el cliente
  de `ioredis` con `QUIT` (espera a que terminen los comandos en curso) si
  llegó a crearse; no hace nada si Redis está deshabilitado o nunca se
  conectó, y no tira si falla (en un shutdown ya se está cerrando el proceso
  de todos modos).
- `public/room.html` / `public/style.css`: nuevo banner (`#restartBanner`,
  arriba y centrado sobre el video) que se muestra al recibir
  `server-restarting` y se oculta solo al reconectar (`connect` ya dispara de
  nuevo en cada reconexión de Socket.io). No hizo falta lógica nueva de
  reconexión: Socket.io reintenta solo por default, y el `join-room` de
  siempre recupera el estado de la sala al reconectar.
- Probado end-to-end con un cliente Socket.io real conectado: recibió
  `server-restarting` y se desconectó (`transport close`) exactamente al
  cumplirse el margen configurado (5s), sin corte prematuro ni margen extra.
- Pendiente el healthcheck (1.5) para cerrar la Fase 1 completa — ver
  `docs/PLAN-PRODUCCION.md`.

## 2026-09-05 — Fase 1.3 del plan de producción: proceso supervisado

- Se agregó `ecosystem.config.js` con configuración de **PM2**, pensada para
  el caso de VPS propio (el hosting todavía no está decidido — Fase 0 — así
  que se mantiene agnóstico: si se termina usando Railway/Render/Fly.io, este
  archivo simplemente no se usa, esas plataformas ya reinician el proceso
  solas con `npm start` como comando de arranque).
- `instances: 1` / `exec_mode: 'fork'` a propósito: `rooms` vive en memoria
  por proceso (ver arriba), así que correr más de una instancia con PM2 en
  modo cluster no compartiría las salas activas entre sí — coherente con la
  decisión de Fase 0 de que una sola instancia alcanza por ahora.
- Backoff para no reintentar en loop infinito si el problema es persistente
  (ej. Redis caído, ver Fase 1.1): `exp_backoff_restart_delay: 100` (arranca
  en 100ms, se duplica en cada caída seguida hasta el tope de 15s que pone
  PM2 por default) combinado con `min_uptime: '30s'` + `max_restarts: 10` —
  si el proceso no logra 10 reinicios seguidos que se sostengan al menos 30s,
  PM2 deja de reintentar y lo marca `errored` en vez de loopear para siempre.
- Se agregaron scripts de `npm`: `pm2:start`, `pm2:stop`, `pm2:restart`,
  `pm2:logs`, `pm2:status`.
- Se agregó al README una sección "Proceso supervisado" explicando los dos
  caminos (PM2 en VPS propio vs. mecanismo nativo de una plataforma de
  hosting) y cómo usar cada uno.
- Pendiente el resto de la Fase 1 (graceful shutdown 1.4, healthcheck 1.5) —
  ver `docs/PLAN-PRODUCCION.md`.

## 2026-09-05 — Fase 1.1 del plan de producción: persistencia externa del estado de las salas

- Se creó `lib/roomStore.js`: guarda/recupera el estado de las salas en **Redis**
  (vía `ioredis`), con el mismo criterio de "fallar rápido" que ya usa
  `lib/r2.js` — si Redis está configurado (o el default `redis://127.0.0.1:6379`)
  y no responde al arrancar, el server **no arranca** (`process.exit(1)`), en vez
  de degradar en silencio a memoria pura.
- Escape hatch explícito `DISABLE_REDIS=1`, documentado como **solo para
  desarrollo local** sin Redis instalado — nunca para producción.
- Solo se persiste la parte del estado de `room` que tiene sentido después de
  un reinicio real del proceso: `videoFile`, `subtitleFile`, `videoPosition`,
  `hostToken`, `passwordHash`, `mutedUserIds`, `chatHistory` e
  `initialVideoAnnounced`. Todo lo indexado por `socket.id` (hostSocketId,
  userNames, bufferingSockets) o con temporizadores en curso
  (`recentDisconnects`, que además tiene un `setTimeout` real, no
  serializable) se deja fuera a propósito: no sobrevive a un reinicio de
  Socket.io de todos modos, así que arranca limpio solo con cada reconexión.
- `server.js`: al arrancar, si Redis está habilitado, se prueba la conexión
  (`roomStore.testConnection()`) y se repuebla `rooms` desde Redis
  (`roomStore.loadAllRooms()`) antes de `server.listen`. Cada mutación
  relevante (`create-room`, `create-room-from-upload`, `change-video`,
  `change-video-from-upload`, subir subtítulo, `join-room` en el primer
  anuncio de cinta, `chat-message`, `toggle-mute`, traspaso de host manual y
  automático, limpieza de mute tras el margen de reconexión) llama a
  `roomStore.saveRoom(...)`. El evento `sync` (heartbeat cada 4s del host) se
  persiste con throttle de 5s — solo se escribe al toque en `play`/`pause`/
  `seek`, que son cambios de estado puntuales.
- Los escritos desde eventos de socket y del endpoint de subtítulos son
  fire-and-forget (no bloquean la respuesta ni el evento en tiempo real por un
  round-trip a Redis); `create-room`/`create-room-from-upload`/
  `change-video`/`change-video-from-upload` sí esperan (`await`) a que
  Redis confirme antes de responder, porque son el punto donde se le entrega
  al usuario el `roomId`/`hostToken` que va a depender de que la sala
  realmente exista después.
- Probado manualmente end-to-end: crear una sala (con contraseña), confirmar
  el JSON guardado en Redis, matar el proceso (`kill -9`, no un shutdown
  prolijo), levantar un proceso nuevo apuntando al mismo Redis, y confirmar
  que `GET /api/room/:id` sigue respondiendo con el estado correcto
  (`passwordProtected: true`) sin haber creado la sala de nuevo. También se
  probó el camino de fallo: `REDIS_URL` apuntando a un puerto sin nada
  escuchando → el server loguea el error y termina con código 1, sin llegar
  a abrir el puerto HTTP.
- Pendiente el resto de la Fase 1 (proceso supervisado 1.3, graceful shutdown
  1.4, healthcheck 1.5) — ver `docs/PLAN-PRODUCCION.md`.

## 2026-09-05 — Fase 1.2 del plan de producción: manejo de errores no capturados

- Se agregaron handlers globales `process.on('uncaughtException', ...)` y
  `process.on('unhandledRejection', ...)` en `server.js`. El primero loguea y
  hace `process.exit(1)` (estado del proceso queda indefinido tras una
  excepción sincrónica sin capturar); el segundo solo loguea, sin salir.
- Se agregó un wrapper genérico `safeSocketHandler(eventName, handler)` que
  envuelve los 10 `socket.on(...)` dentro de `io.on('connection', ...)` en
  try/catch — un error en un solo evento (ej. un payload malformado de un
  cliente) ya no tira abajo el proceso completo ni afecta a las demás salas
  activas; se loguea con el nombre del evento y el `socket.id` para poder
  rastrearlo.
- El callback de `setTimeout` dentro de `disconnect` (el margen de 15s antes
  de anunciar "salió de la sala") corre en un tick aparte, fuera del alcance
  del try/catch del wrapper — se le agregó su propio try/catch.
- Probado manualmente: un `join-room` con payload `null` (que antes tiraba
  `TypeError: Cannot destructure property 'roomId' of 'null'` y mataba el
  proceso) ahora queda contenido — el servidor sigue respondiendo a nuevas
  conexiones.
- Pendiente el resto de la Fase 1 (persistencia externa 1.1, proceso
  supervisado 1.3, graceful shutdown 1.4, healthcheck 1.5) — ver
  `docs/PLAN-PRODUCCION.md`.

## 2026-09-05 — Fase 0 del plan de producción resuelta

Decisiones de arquitectura tomadas (ver `docs/PLAN-PRODUCCION.md`, Fase 0):

- Una sola instancia de servidor alcanza por ahora → **Fase 3 (escalado
  horizontal con Redis adapter) queda pospuesta.**
- Va a haber **cuentas de usuario reales (login)** → se agregó la **Fase 2bis**
  al plan (modelo de usuario, registro/login, sesiones, migración de la
  identidad de host, recuperación de contraseña). Esto reemplaza el ítem 2.3
  original ("endurecer el `hostToken`") y el ítem correspondiente que estaba
  anotado como opcional en la Fase 6.
- Sigue siendo **un solo servidor con una biblioteca compartida** entre todos
  los usuarios (no multi-tenant) → se descartó ese ítem de la Fase 6.
- El **hosting todavía no está decidido** → se dejó anotado mantener el
  trabajo de infraestructura de la Fase 1 agnóstico de proveedor mientras
  tanto (ej. Docker en vez de configuración específica de una plataforma).

Se actualizó `docs/MEMORIA.md` con el resumen de estas decisiones y el nuevo
orden recomendado de fases.

## 2026-09-05 — Reorganización de la documentación

- Se archivaron `MEMORIA.md` y `CHANGELOG.md` originales en `docs/historico/`
  (quedan como registro histórico, ya no se actualizan).
- Se creó `docs/MEMORIA.md`: resumen corto y activo, pensado para que una
  sesión nueva tenga el contexto esencial sin leer el archivo histórico
  completo. Es el que se sigue actualizando de ahora en adelante.
- Se creó este archivo (`docs/CHANGELOG.md`), activo, para las próximas
  entradas.
- Se agregó `docs/PLAN-PRODUCCION.md`: plan por fases de todo lo pendiente
  (persistencia, seguridad, infraestructura, observabilidad) para llevar el
  proyecto de "uso casero" a producción real.
- Se actualizaron las referencias cruzadas en `README.md` y `server.js` para
  apuntar a las nuevas rutas dentro de `docs/`.
