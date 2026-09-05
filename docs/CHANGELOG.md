# 📝 Changelog (activo) — MovieNight

Registro cronológico de cambios importantes, de más reciente a más antiguo. Este
archivo arranca vacío a partir de la reorganización de la documentación — el
historial completo de versiones anteriores (V1 a V24+) quedó archivado en
`docs/historico/CHANGELOG.md`.

Formato de cada entrada: fecha, qué cambió, por qué (breve — el detalle largo,
si hace falta, puede ir en el mensaje de commit).

---

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
