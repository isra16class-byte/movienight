# 📝 Changelog (activo) — MovieNight

Registro cronológico de cambios importantes, de más reciente a más antiguo. Este
archivo arranca vacío a partir de la reorganización de la documentación — el
historial completo de versiones anteriores (V1 a V24+) quedó archivado en
`docs/historico/CHANGELOG.md`.

Formato de cada entrada: fecha, qué cambió, por qué (breve — el detalle largo,
si hace falta, puede ir en el mensaje de commit).

---

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
