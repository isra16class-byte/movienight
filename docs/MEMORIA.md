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
- **Subida de video**: Multer → disco local (`public/uploads/`) **o** Cloudflare R2 si está configurado (modo dual, ver `lib/r2.js` y README). Con R2 configurado, desde la Fase 2.7 el video sube **directo del navegador al bucket** vía URL prefirmada (`POST /api/uploads/presign`), sin pasar por este server — evita el `413 Payload Too Large` que corta Cloudflare al subir un video real por Cloudflare Tunnel. Sin R2 configurado, sigue subiendo por el server (multipart de siempre), con el mismo límite de Cloudflare que antes si se comparte por Tunnel.
- **Frontend**: HTML/CSS/JS vanilla, sin framework.
- **Estado de las salas**: `rooms` sigue siendo un objeto en memoria dentro de `server.js` (las lecturas son síncronas, sensibles a latencia por el sync de video/chat en tiempo real), pero desde la Fase 1.1 cada mutación relevante se respalda en **Redis** (`lib/roomStore.js`), y al arrancar el server se repuebla desde ahí — sobrevive a un reinicio del proceso. Si Redis no responde, el server no arranca (mismo criterio "fallar rápido" que ya usaba R2); `DISABLE_REDIS=1` es un escape hatch solo para desarrollo local, nunca para producción. Desde la Fase 2.6, las salas **expiran a las 24hs sin actividad** (`ROOM_TTL_HOURS`): `roomStore.saveRoom()` estampa `lastActivity` en cada mutación real y aplica un TTL nativo de Redis, y un barrido propio en `server.js` (`sweepExpiredRooms`, cada 30min) limpia `rooms` en memoria cuando el proceso sigue corriendo. El video asociado **nunca se borra** al expirar — queda en la biblioteca para reusarse.
- **Cuentas de usuario**: desde la Fase 2bis, **PostgreSQL** (`lib/db.js`, vía `pg`) guarda el modelo de usuario (tabla `users`: email, password hasheado con bcrypt). Motor separado de Redis a propósito — Redis sigue siendo solo para el estado efímero de las salas. Sin `DATABASE_URL` configurada, el registro/login queda deshabilitado pero el resto de la app sigue funcionando igual (no es un escape hatch de producción, es un feature opcional todavía no activado); si SÍ está configurada y Postgres no responde al arrancar, mismo criterio de "fallar rápido" que Redis/R2. Con `DATABASE_URL` configurada, un login exitoso también deja una **sesión de servidor real** (`lib/sessionStore.js`, sobre la misma conexión de Redis que ya usa `roomStore.js`): cookie `movienight.sid` httpOnly/sameSite=lax, contenido (`userId`/`email`) guardado server-side, revocable con `POST /auth/logout` — ver más abajo el detalle y lo que todavía falta de esta fase. Desde la fase "biblioteca por sesión" (2026-09-06), la sesión también alcanza sola (sin `LIBRARY_PASSWORD`) para listar/borrar/subir en `/library.html` — los dos caminos conviven, ninguno reemplaza al otro. La recuperación de contraseña (`POST /auth/forgot-password` / `POST /auth/reset-password`) manda el email vía **Resend** (`lib/mailer.js`, HTTP directo, sin SDK); sin `RESEND_API_KEY` configurada, el link de reseteo se loguea por consola en vez de mandarse — solo válido para desarrollo local.
- **Exposición a internet**: Cloudflare Tunnel (no hay hosting propio todavía).
- **Headers de seguridad y CORS**: desde la Fase 2.4, `helmet` agrega el set estándar de headers HTTP (Content-Security-Policy, HSTS, X-Frame-Options, etc.) — antes no había ninguno. La CSP es `default-src 'self'` con las excepciones puntuales que la app necesita (`'unsafe-inline'` en scripts/estilos, porque el JS/CSS de las 4 páginas vive inline sin nonces; `data:` en `img-src` para el fondo con ruido de `style.css`; `fonts.googleapis.com`/`fonts.gstatic.com` en `style-src`/`font-src`, para las tipografías de Google Fonts que cargan las 4 páginas — este último se sumó recién al probar en un navegador real, la primera versión lo dejaba afuera) y suma automáticamente los hosts de R2 a `connect-src`/`media-src` cuando R2 está configurado (`lib/r2.js::getCspOrigins()`, verificado subiendo un video real y reproduciéndolo desde el bucket, sin ningún error de CSP/CORS). HSTS solo se desactiva en desarrollo local sin HTTPS (reusa `SESSION_COOKIE_INSECURE=1`). CORS es explícito y cerrado por default (ningún origen cruzado permitido, ni en Express ni en Socket.io) — `ALLOWED_ORIGINS` en `.env` para permitir alguno a propósito.

## Estructura de archivos

```
movienight/
  server.js              # Todo el backend: rutas HTTP + lógica de sockets
  Dockerfile                # Imagen de producción (Fase 5 del plan de producción, deploy)
  docker-compose.yml        # App + Redis + Postgres bundleados, para VPS con Docker (Fase 5)
  scripts/deploy.sh          # Deploy en un comando para VPS sin Docker, PM2 (Fase 5)
  lib/r2.js                # Cloudflare R2 (opcional): subir/listar/borrar videos, y URLs prefirmadas
                            # de subida directa desde el navegador (Fase 2.7 del plan de producción)
  lib/roomStore.js          # Persistencia de salas en Redis (Fase 1.1 del plan de producción)
  lib/db.js                # Postgres: modelo de usuario, registro/login (Fase 2bis del plan de producción)
  lib/sessionStore.js      # Sesiones de usuario sobre Redis (Fase 2bis del plan de producción)
  lib/mailer.js            # Envío de emails vía Resend, para recuperación de contraseña (Fase 2bis)
  lib/fileValidation.js    # Validación real de video (magic bytes) y subtítulos (estructura) — Fase 2.5
  lib/passwordAuth.js      # Hashing bcrypt + migración desde sha256 legacy (extraído en Fase 5, ver docs/CHANGELOG.md)
  lib/rateLimiter.js       # Limitador de intentos fallidos (extraído en Fase 5)
  lib/hostAuth.js          # isRoomOwner + setHost, el sistema de roles (extraído en Fase 5)
  lib/uploadReference.js   # Modo dual disco/R2 para referencias a videos ya subidos (extraído en Fase 5)
  lib/logger.js            # Logger estructurado (JSON) sobre pino, con redacción de campos sensibles — Fase 4
  lib/sentry.js            # Reporte opcional de excepciones a Sentry, con redacción de secretos — Fase 4
  lib/metrics.js           # Contadores en memoria para GET /metrics (uploads en curso, errores de R2) — Fase 4
  lib/alerts.js            # Alertas mínimas por email si el healthcheck o R2 vienen fallando — Fase 4
  lib/settings.js          # Catálogo de parámetros administrables (panel de admin, EN CURSO — ver "Por dónde seguir")
  scripts/make-admin.js    # Promueve una cuenta existente a admin (panel de admin, EN CURSO)
  scripts/r2-cleanup-multipart.js
  test/                    # Tests unitarios (node:test) de la lógica extraída a lib/*.js — Fase 5
  .github/workflows/ci.yml # CI: corre npm test en cada push/PR — Fase 5
  public/
    index.html            # Crear sala / unirse por código; también login/registro/logout (Fase 2bis)
    library.html            # Biblioteca de videos ya subidos (con contraseña propia o sesión de cuenta)
    room.html              # La sala: reproductor, chat, controles (la mayoría de la lógica de cliente vive acá)
    reset-password.html    # Pantalla para elegir contraseña nueva tras el link de "olvidé mi contraseña"
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
- **`hostToken`**: credencial random guardada en `localStorage` del creador. Sigue siendo la única
  forma de reclamar el host en salas **anónimas** (sin cuenta, `room.ownerUserId === null`, el caso
  más común hoy ya que todavía no hay UI de login) — sin expiración ni forma de revocarla en ese
  caso. Desde la Fase 2bis ("migración del rol de host", ver más abajo), una sala creada con una
  sesión iniciada queda "con dueño" (`room.ownerUserId`) y ahí `hostToken` deja de alcanzar por sí
  solo: la única forma válida de reclamar el host pasa a ser la sesión autenticada (`isRoomOwner()`
  en `server.js`), que sí es revocable (`POST /auth/logout`) y no viaja accesible por XSS (cookie
  `httpOnly`).
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
- `hostToken` sin expiración, viaja en texto plano — ~~con el modelo de usuario y registro/login ya en
  pie (Fase 2bis) y sesiones reales (cookie httpOnly)~~ → **resuelto para salas creadas con sesión
  iniciada** (Fase 2bis, "migración del rol de host", 2026-09-05): esas salas quedan "con dueño"
  (`room.ownerUserId`) y ahí `hostToken` deja de alcanzar por sí solo, la sesión es lo único que
  cuenta. Sigue siendo el mismo riesgo para salas anónimas (sin cuenta) — inherente al esquema
  "sin login" en sí, no algo que se pueda cerrar del todo mientras eso siga existiendo como opción.
- ~~Sin validación real de tipo de archivo (solo `Content-Type` del
  navegador)~~ → **resuelto en Fase 2.5 (2026-09-07)**: video validado por
  magic bytes (`file-type`), subtítulos por estructura real. Detalle más
  abajo en "Por dónde seguir" y en `docs/PLAN-PRODUCCION.md`.
- Las salas nunca expiran — se acumulan en memoria y en R2 indefinidamente.
- ~~Subir un video real vía `create-room` devuelve `413 Payload Too Large` de
  Cloudflare~~ → **resuelto en modo R2 (Fase 2.7, 2026-09-06)**: subida
  directa del navegador al bucket vía URL prefirmada, sin pasar por el
  Tunnel. **Sigue siendo el mismo problema en modo disco local** (sin R2
  configurado) — limitación conocida de ese modo, no resuelta por este
  cambio. Detalle completo en la Fase 2.7 de `docs/PLAN-PRODUCCION.md`.

## Cómo se trabaja en este repo

- El asistente (IA) no hace push directo. Flujo real: clona el repo → hace el cambio → commit local → genera un patch con `git format-patch -1 HEAD` → lo entrega como archivo descargable → el usuario lo aplica con `git am nombre.patch` y hace `git push` él mismo.
- Cada cambio importante debería reflejarse acá (este archivo, `docs/MEMORIA.md`, si cambia algo esencial) y como entrada nueva en `docs/CHANGELOG.md` — no en los archivos de `docs/historico/`, que quedaron congelados como registro del estado anterior a esta reorganización.

## Por dónde seguir

**Panel de administración — EN CURSO, pasos 1-6 de 9 (2026-09-08, rama
`plan-produccion`)**: feature nueva, no forma parte de `docs/PLAN-PRODUCCION.md`.
Diseño completo y confirmado en `docs/PLAN-PANEL-ADMIN.md` (las 6 preguntas de la
sección 9 están resueltas) — si retomás esto en otra sesión, **leé ese documento
primero**, tiene todo el diseño y el orden de implementación (sección 8).
Completado: migración (`role` en `users`, tablas `app_settings` y
`admin_actions_audit`), `scripts/make-admin.js`, `lib/settings.js` (catálogo de 8
parámetros con precedencia DB→env→default, cache en memoria, 11 tests), el
refactor "constante → función" en los 8 puntos que los usan
(`lib/roomStore.js`, `server.js`, `lib/alerts.js`,
`scripts/library-orphan-report.js`), `lib/roomLifecycle.js::closeRoom(io,
rooms, roomStore, roomId, reason)` — extraída del bloque que antes vivía
inline dentro de `sweepExpiredRooms()` en `server.js` (avisar por `room-error`,
desconectar cada socket de la sala, borrar de `rooms` en memoria y de
`roomStore`/Redis), con `reason` como parámetro para que el mensaje en pantalla
diga la causa real según quién dispare el cierre (TTL vencido hoy;
admin/"cerrar todas" desde el paso 7), y ahora **`lib/adminAuth.js`** +
las dos primeras rutas `/admin/*`: `makeRequireAdmin(db, log)` (fábrica —
`db`/`log` inyectables para poder testear sin Postgres real) arma el
middleware `requireAdmin`, que consulta el rol a Postgres **en cada
request** (no viaja en la cookie de sesión, así revocar un admin tiene
efecto inmediato) y responde 404 sin `DATABASE_URL` (mismo criterio que
`requireDbEnabled`, para no confirmar que la feature existe), 401 sin
sesión, 403 si la cuenta no es admin. `isSameOrigin`/`requireSameOrigin`
chequean `Origin`/`Referer` contra el host propio (sección 2.4 del plan,
defensa barata contra CSRF en el POST) — dejan pasar si no hay ninguno de
los dos headers, para no romper clientes legítimos que no los mandan.
`GET /admin/settings` (`requireAdmin`) devuelve `settings.listAll()` tal
cual. `POST /admin/settings` (`requireSameOrigin` + `requireAdmin`) valida
y guarda con `settings.setSetting()` (400 si la validación falla, con el
mensaje que ya arma `lib/settings.js`), e inserta una fila en
`admin_actions_audit` (`setting_changed`, con `from`/`to`) — si esa
inserción de auditoría falla, el cambio ya guardado sigue devolviendo 200
(el fallo de auditoría se loguea aparte, no tira abajo un cambio que sí se
aplicó). 13 tests nuevos en `test/adminAuth.test.js` (los 4 códigos de
respuesta de `requireAdmin` con un `db`/`log` de mentira, más
`isSameOrigin`/`requireSameOrigin` con distintas combinaciones de
Origin/Referer). Verificado en sandbox sin Postgres: ambas rutas dan 404 y
el resto de la app sigue funcionando (`GET /` sigue en 200) — el flujo
completo con un admin real (200 en ambas, 400 fuera de rango, 403 con
sesión no-admin) queda pendiente de confirmar en un entorno con Postgres de
verdad (`docker compose up`), no lo hay en este sandbox. Detalle completo,
incluida la verificación de cada paso (sintaxis, 67/67 tests, lint, arranque
real), en `docs/CHANGELOG.md`.

**Bug real encontrado en entorno real (Docker Compose, 2026-09-08)**: al
probar el paso 6 con `docker compose up` de verdad (Redis + Postgres reales,
no el sandbox), el arranque tiraba `"lib/settings.js: init() no se llamó
todavía"` en el barrido inicial de salas expiradas. Causa: `sweepExpiredRooms()`
se disparaba dentro del bloque de Redis, **antes** de `await settings.init()`
(que corre más abajo, después de Postgres/migraciones) — arrastrado sin querer
del refactor "constante → función" del paso 4, que hizo que
`roomStore.getRoomTtlSeconds()` pasara a depender de `settings.getSetting()`.
No bajaba el server (el error queda atrapado en un `.catch()`), pero el
barrido inicial no corría de verdad. No se detectó en el sandbox porque ahí
las pruebas corren con `DISABLE_REDIS=1` (ese bloque entero queda sin
ejecutar en ese modo) — recién se vio con Redis real. **Corregido**: el
llamado a `sweepExpiredRooms()` (+ su `setInterval`) se movió de dentro del
bloque de Redis a después de `settings.init()`, con el mismo
`roomStore.isEnabled()` como condición de siempre. Sin cambio de
comportamiento observable más allá de arreglar el error espurio.

**Todavía no existe `public/admin.html` ni
las rutas de dashboard/acciones sobre salas — el panel no es usable
todavía.** Sigue: paso 7 (rutas de dashboard/acciones + auditoría, que
reusan `closeRoom()` para "cerrar una sala puntual", "cerrar inactivas" y
"cerrar TODAS"), paso 8 (`public/admin.html`), paso 9 (prueba end-to-end).

**Fase 5 — `docker compose up` (Opción B) verificado en entorno real ✅ ya no queda
ningún ítem pendiente en toda la Fase 5 (2026-09-08)**: única verificación que faltaba
tras la entrada de abajo, que solo había probado `docker build` directo (Opción A). Con
Windows/Docker Desktop: los tres contenedores (`app`/`redis`/`postgres`) levantan
`healthy`, `docker compose restart app` conserva sesión y sala (confirma persistencia
real en los volúmenes de Redis/Postgres), y el flujo completo de cuenta + sala + video
con R2 funciona de punta a punta. En el camino: se descartó como falsa alarma que
`eslint`/`@eslint-community` "siguieran instalados" (son carpetas de scope vacías,
residuo cosmético de `npm ci --omit=dev`, confirmado con
`find node_modules -mindepth 1 -maxdepth 1 -type d -empty` y que
`node_modules/eslint` no existe); y se encontró un bug real pero en el `.env` del
usuario, no en el proyecto — `R2_PUBLIC_URL` sin salto de línea antes del comentario
siguiente rompía el `<video src>` armado por `lib/r2.js::getPublicUrl()` (el código en
sí ya hacía lo correcto). Detalle completo en `docs/CHANGELOG.md`.

**Fase 5 — fix real en el Dockerfile, encontrado en verificación en entorno real
(2026-09-08)**: probando el `Dockerfile` de la entrada de abajo contra Docker de verdad
(Windows, Docker Desktop) apareció un bug real: la imagen final tenía las
`devDependencies` adentro (`eslint` y compañía, 163 paquetes en vez de los de producción
solamente) — el multi-stage build no cumplía su propósito. Causa: el orden de los `COPY`
en la etapa `runtime` (`node_modules` limpio copiado ANTES que `COPY . .`, así que si el
`node_modules` local con `devDependencies` se colaba en el contexto, el `COPY . .`
posterior lo pisaba). Fix: invertir el orden. Segundo hallazgo al reconstruir: el
`.dockerignore` en sí SÍ excluye `node_modules` correctamente (el contexto bajó de 315MB a
7.67kB una vez resuelto lo anterior — no era la causa), pero el `chown -R /app` seguía
tardando ~110s por los miles de archivos chiquitos que trae `@aws-sdk/client-s3`; se
resolvió con `--chown=node:node` en cada `COPY` en vez de un `chown -R` aparte. Detalle
completo, con los comandos de diagnóstico usados, en `docs/CHANGELOG.md`.

**Fase 5 — documentar y automatizar el despliegue ✅ COMPLETA DEL TODO la Fase 5
(2026-09-08)**: último punto pendiente de la fase (y de todo el plan de producción, salvo
términos de uso/privacidad en Fase 6). Tres caminos de deploy documentados en el README
("Despliegue a producción"), ninguno impuesto porque el hosting sigue sin decidirse
(Fase 0): **(A) Railway/Render/Fly.io** vía el nuevo `Dockerfile` (imagen
`node:22-alpine`, sin dependencias nativas — `bcryptjs` es JS puro, no `bcrypt` — usuario
sin privilegios, `HEALTHCHECK` contra `GET /health`); con eso, push a `main` ya es deploy
automático porque esas plataformas construyen solas desde el `Dockerfile` del repo, sin
necesitar nada más de lo agregado acá. **(B) VPS con Docker** vía el nuevo
`docker-compose.yml`, que bundlea la app + Redis + Postgres para un VPS chico (o solo la
app, si se prefiere Redis/Postgres administrados aparte, apuntando `REDIS_URL`/
`DATABASE_URL` del `.env` a esos servicios en vez de a los contenedores locales) —
`docker compose up -d --build` para levantar, mismo comando para redesplegar. **(C) VPS
sin Docker** (el camino de siempre, Node + PM2) vía el nuevo `scripts/deploy.sh`
(`npm run deploy`), que reemplaza los pasos manuales sueltos por uno solo: frena si hay
cambios sin commitear en el servidor, `git fetch` + `reset --hard` a `origin/<rama>`,
`npm ci`, corre lint+tests contra el código recién traído (mismo criterio de "fallar
rápido" que ya usa el proyecto para Redis/Postgres/R2 al arrancar, acá aplicado al propio
despliegue — si algo no pasa, no reinicia el proceso en vivo) y recién ahí
`pm2 reload`/`restart`. Además, nuevo job opcional `deploy-vps` en
`.github/workflows/ci.yml`: corre `scripts/deploy.sh` por SSH en el servidor después de
que pasen lint+tests, pero solo si están configurados los secrets de GitHub
(`DEPLOY_HOST`/`DEPLOY_USER`/`DEPLOY_SSH_KEY`/`DEPLOY_PATH`) — sin esos secrets el job se
salta solo y CI sigue exactamente igual que antes; como el asistente de IA no hace push
directo (ver más abajo, "Cómo se trabaja en este repo"), este workflow recién dispara
cuando la persona hace el push real a `main`, nunca antes. Con las tres opciones,
"push a `main` = deploy automático" (o, como mínimo en la Opción C sin configurar el
workflow, un solo comando) — el objetivo original del ítem del plan.
**Verificado en sandbox**: lint y los 37 tests en verde contra el código real, sintaxis de
`docker-compose.yml` validada como YAML y de `scripts/deploy.sh` con `bash -n`.
**Verificado en entorno real (Windows, Docker Desktop, 2026-09-08)**: `docker build` de
punta a punta contra un daemon real — encontró y corrigió dos bugs reales del
`Dockerfile` (devDependencies coladas en la imagen por el orden de los `COPY`, y un
`chown -R` innecesariamente lento), ver la entrada de arriba y `docs/CHANGELOG.md` para
el detalle completo. **Pendiente todavía**: `docker compose up` (Opción B) no se probó
en el entorno real, solo `docker build` directo (Opción A) — vale la pena confirmarlo
antes de dar la Opción B por probada de punta a punta, mismo criterio de "verificación
independiente en entorno real" que ya se usó para cerrar otras fases (Fase 2bis y
Fase 4).

**Fase 5 — validar variables de entorno al arrancar ✅ COMPLETA la Fase 5 (2026-09-07)**: último
punto pendiente de la fase. Nuevo `lib/envValidation.js`, que corre al arrancar (antes de conectar a
Redis/Postgres/R2) y falla rápido con un mensaje claro ante dos problemas que hoy pasaban en
silencio: una configuración de R2 a medias (algunas de las 5 variables sí, otras no — el ejemplo real
que motivaba este ítem del plan: sin `R2_PUBLIC_URL`, la subida de un video entero de varios GB
funcionaba completa y recién fallaba al final, armando el link público) y una variable numérica con
un valor que no parsea (el patrón `parseInt(x) || default` que ya usaba el proyecto cae callado al
default sin avisar). También avisa, sin frenar el arranque, si un flag booleano (`DISABLE_REDIS`,
`SESSION_COOKIE_INSECURE`, `LOG_PRETTY`) tiene un valor distinto de `"1"` — esos flags solo se
activan con exactamente ese valor. Nada de esto es obligatorio: sin ninguna variable configurada, el
server arranca exactamente igual que siempre. 10 tests nuevos y probado manualmente contra el server
real: arranque normal con config válida, corte inmediato (exit 1, antes de abrir el puerto) con R2 a
medias + una variable numérica inválida a la vez, y arranque normal con solo un warning cuando el
problema es un flag booleano. **Con esto, la Fase 5 (Calidad de código y proceso) queda completa del
todo** — no quedan ítems pendientes en esa fase. Detalle completo en `docs/CHANGELOG.md`.

**Fase 5 — CI con lint (ESLint) (2026-09-07)**: segundo punto de la Fase 5 resuelto. Nuevo
`eslint.config.js` (flat config) que cubre el código de servidor (`server.js`, `lib/`, `scripts/`,
`test/`) — a propósito no cubre `public/`, donde el JS de cliente vive inline en los `.html` sin
build step. Reglas: `@eslint/js` recommended + `no-unused-vars` con excepción para nombres que
empiezan con `_` (mismo patrón que ya usaba el proyecto en callbacks). Nuevo script
`"lint": "eslint ."` y nuevo step en `.github/workflows/ci.yml` (corre antes de `npm test`). Al
correrlo por primera vez aparecieron 8 errores reales (no ruido del linter): cuatro constantes de
`lib/passwordAuth.js` que quedaron destructuradas sin usar en `server.js` desde la extracción a
`lib/` de la entrada anterior, el mismo escape innecesario de un guion en una regex repetido en dos
archivos (`server.js` y `lib/r2.js`, ambos armando el nombre "seguro" de un archivo), un `catch`
intencionalmente vacío sin el prefijo `_` que ya usa el resto del proyecto, y un argumento de mock
sin usar en un test — los ocho corregidos sin cambiar comportamiento. Verificado con `npm run lint`
limpio y los 27 tests existentes siguiendo en verde.

**Fase 5 — tests unitarios (setHost, auth, modo dual disco/R2) + CI en GitHub
Actions (2026-09-07)**: primer punto de la Fase 5 resuelto. Como `server.js`
(2394 líneas) conecta a Redis/Postgres reales apenas se carga el módulo, no
se puede testear directo — se extrajo la lógica puntual a testear a cuatro
módulos nuevos bajo `lib/` (`passwordAuth.js`, `rateLimiter.js`,
`hostAuth.js`, `uploadReference.js`), dejando en `server.js` wrappers que
llaman a esos módulos con la misma firma de siempre, sin tocar ningún call
site existente ni cambiar comportamiento. 27 tests nuevos en `test/*.test.js`
con el test runner nativo de Node (`node:test`, sin sumar Jest/Mocha),
cubriendo el traspaso de host (el caso que ya tuvo el bug de "hosts
duplicados"), autenticación de sala/biblioteca (contraseñas + rate
limiting), y el modo dual disco/R2. Nuevo `.github/workflows/ci.yml`: corre
`npm ci` + `npm test` en cada push/PR — simple a propósito, sin lint ni
servicios de Redis/Postgres todavía. Verificado con los 27 tests en verde,
`node -c server.js` sin errores, y un smoke test end-to-end real (servidor
levantado con `DISABLE_REDIS=1`, `/health` en `200`, `/api/uploads` con
401/401/200 según la contraseña de biblioteca) confirmando que el refactor
no cambió nada observable. Quedan los demás puntos de la Fase 5: CI con
lint, documentar/automatizar el deploy, y validar variables de entorno al
arrancar.

**Fase 4 — verificación independiente de alertas mínimas en entorno real
(2026-09-07)**: además de la prueba end-to-end contra un servidor real hecha
al cerrar la fase (ver entrada de abajo), se corrió una segunda verificación
independiente en el entorno real del usuario (Redis y R2 reales). Se probó
el ciclo completo: Redis apagado → `/health` en `503` en ~11s → a los 2
chequeos seguidos en falla dispara "Healthcheck en falla" → silencio durante
todo el cooldown → Redis levantado (sin reiniciar Node) → `/health` vuelve a
`200` → llega "Recuperado"; y por separado, credencial de R2 inválida → R2
responde `403`, `/health` en `503`, se disparan ambas alertas ("Healthcheck
en falla" + "R2 está devolviendo errores"). `.env` quedó restaurado a su
estado original (sin las variables `ALERT_*` usadas solo para la prueba) y
sin backups temporales sueltos. Con dos verificaciones independientes
(sandbox + entorno real del usuario, mismo criterio que se usó para cerrar
la Fase 2bis), **la Fase 4 (observabilidad) queda confirmada del todo**.

**Fase 4 (observabilidad) ✅ COMPLETA (2026-09-07) — alertas mínimas**: nuevo
`lib/alerts.js` + un job interno en `server.js` (`runAlertChecks`, cada
`ALERT_CHECK_INTERVAL_MS`, default 1 min) que reusa `computeHealthStatus()`
(la misma función que ya usa `/health`, extraída para no duplicar lógica) y
`metrics.snapshot()`, y manda un email vía `lib/mailer.js` (Resend, ya
integrado desde la Fase 2bis) si el healthcheck lleva varios chequeos
seguidos en falla (`ALERT_HEALTH_FAILURE_THRESHOLD`, default 3) o si
`r2ErrorCount` sube desde el último chequeo. Un `ALERT_COOLDOWN_MS` (default
30min) evita reenviar en cada chequeo mientras el problema siga sin
resolverse, y un único email de "recuperado" avisa cuando vuelve a estar
sano. Todo opcional: sin `ALERT_EMAIL_TO` configurada, no arranca ningún
chequeo de más (mismo criterio que Sentry/R2/Postgres); sin
`RESEND_API_KEY`, la alerta se loguea por consola en vez de mandarse (mismo
fallback que ya usaba `sendPasswordResetEmail`). Probado en sandbox: ciclo
completo (bajo el umbral → sin alerta, cruza el umbral → alerta, sigue
fallando en cooldown → sin alerta nueva, se recupera → email de
"recuperado", vuelve a fallar → nuevo ciclo) con un harness aislado, y
contra un servidor real con credenciales de R2 inválidas (el healthcheck y
el contador de errores de R2 dispararon ambas alertas correctamente). Con
esto, **la Fase 4 (observabilidad) queda completa del todo** — no quedan
ítems pendientes en esa fase.

**Fase 4 — fix de `uploads.inProgress` pegado tras una desconexión abrupta (2026-09-07)**:
probando las métricas contra un servidor real (subida de 300MB limitada a 1MB/s, cortada con
`kill -9` a mitad de camino) se encontró que el contador quedaba pegado en `1` para siempre —
Multer/Busboy no invocan su callback si el cliente corta la conexión antes de terminar de parsear
el `multipart/form-data`, y `metrics.uploadFinished()` solo se llamaba desde ese callback.
`trackVideoUpload()` en `server.js` ahora también escucha `req.on('aborted', ...)` y
`res.on('close', ...)` para descontar el contador en ese caso, con una bandera para no descontar
dos veces si el callback normal de Multer sí llega a dispararse. Reproducido y confirmado en
sandbox (modo disco local): con el fix, `/metrics` vuelve a `0` en la primera consulta después de
matar el proceso cliente, en vez de quedarse en `1`. Detalle completo en `docs/CHANGELOG.md`.

**Fase 4 (observabilidad) en curso — métricas básicas completas (2026-09-07)**: nuevo
`lib/metrics.js` con contadores en memoria (una sola instancia, ver Fase 0 —
no hace falta un backend compartido tipo Redis para esto). Nueva ruta
`GET /metrics` que expone salas activas (`Object.keys(rooms).length`),
usuarios conectados (`io.engine.clientsCount`), subidas de video en curso, y
errores de R2 vistos desde que arrancó el proceso (cuántos y el último). El
conteo de subidas en curso envuelve `upload.single('video')` (`trackVideoUpload`
en `server.js`) — cubre los dos modos que pasan por el proceso (disco local y
streaming a R2 vía `r2VideoStorage`); la subida directa a R2 por URL
prefirmada (Fase 2.7) queda deliberadamente afuera de este contador, porque
el server nunca ve esos bytes en ese camino. El conteo de errores de R2 vive
en `lib/r2.js` (`withR2ErrorTracking`, envuelve cada función que habla de
verdad con el bucket) y distingue el 404 de `objectExists` (resultado
válido, "no existe") de una falla real de R2. Protegido opcionalmente con
`METRICS_TOKEN` (header `x-metrics-token`) — sin la variable, el endpoint
queda público, mismo criterio que otras variables opcionales del proyecto
(`LIBRARY_PASSWORD`, `SENTRY_DSN`). Excluido del rate limiter general, igual
que `/health`. Probado end-to-end en sandbox: `/metrics` sin token (público),
con `METRICS_TOKEN` configurada (401 sin header o con uno incorrecto, 200 con
el correcto), `uploads.inProgress` subiendo a 1 durante una subida real (con
un video real generado con ffmpeg, agrandado con datos random para que la
transferencia tardara lo suficiente para observarlo) y volviendo a 0 al
terminar, y `r2.errorCount`/`r2.lastError` incrementando correctamente al
configurar credenciales de R2 inválidas (mismo error que además hace fallar
`/health`, confirmando que ambos caminos ven la misma falla real).
**Queda pendiente el último punto de la Fase 4**: alertas mínimas
(probablemente vía Resend, ya integrado desde la Fase 2bis) si el
healthcheck falla repetidas veces o si R2 empieza a devolver errores.

**Fase 4 (observabilidad) en curso — logs estructurados + reporte de errores (Sentry) completo (2026-09-07)**:
nuevo `lib/logger.js` sobre **pino** (JSON por línea) que reemplaza los
`console.log`/`console.error` de texto libre que usaba el server hasta acá —
`server.js`, `lib/db.js`, `lib/roomStore.js` y `lib/mailer.js` ahora loguean
con campos estructurados (`err`, `roomId`, `socketId`, `event`, etc.) en vez
de mensajes armados a mano. Incluye **redacción automática** de campos
sensibles (contraseñas, `hostToken`, cookies de sesión, headers de auth) en
cualquier nivel de anidamiento, para que un error a futuro no termine
filtrando una credencial a los logs. `LOG_LEVEL` controla el nivel (default
`info`); `LOG_PRETTY=1` da formato legible para desarrollo local (cae a JSON
con un aviso si no está instalado `pino-pretty`, nunca rompe el arranque).
Los scripts de CLI (`scripts/library-orphan-report.js`,
`scripts/r2-cleanup-multipart.js`) quedan con `console.log` a propósito —
están pensados para leerse en una terminal, no para un sistema de logs.
Probado: arranque completo con `DISABLE_REDIS=1` (JSON válido línea por
línea, campos esperados), graceful shutdown vía `SIGTERM` con el mismo
formato, y la redacción tapando correctamente contraseñas/tokens/cookies de
prueba anidados. Sentry se habilita solo con `SENTRY_DSN`; sin esa variable,
el server no contacta servicios externos y funciona igual. Captura excepciones
HTTP, de handlers de Socket.io y globales una sola vez, y antes de enviarlas
elimina cookies/headers de autenticación y redacta contraseñas, `hostToken`,
tokens y datos de sesión. Su estado opcional figura en `/health` como
`checks.sentry`. Detalle completo en `docs/CHANGELOG.md`. **Quedan pendientes
los dos puntos restantes de la Fase 4**: métricas básicas (`/metrics`) y
alertas mínimas (probablemente vía Resend, ya integrado desde la Fase 2bis).
En la verificación end-to-end se encontró y corrigió un bug de compatibilidad
con `@sentry/node` 10.73.0: se había pasado una función a `defaultIntegrations`,
pero esa opción exige un array y el SDK fallaba con `defaultIntegrations.forEach
is not a function`, dejando Sentry deshabilitado. El filtro se movió a
`integrations`, que sí acepta callback. La misma auditoría agregó
`libraryPassword` a la regex de redacción, porque esa clave puede llegar por
query/body y no coincidía antes. **Verificado en entorno real (2026-09-07)**:
un error disparado con `x-library-password` en el header sí llegó a Sentry
(evento visible, `checks.sentry` en `ok: true`), y el header no aparece en
ningún lugar del evento —ni redactado, porque el SDK ni siquiera lo capturó
(`sendDefaultPii: false`). Confirma que no hay fuga en ese caso, pero no
ejercitaba la rama de `beforeSend()` que redacta activamente un dato ya
presente en el evento. **Cerrado aparte (mismo día)**: con una ruta de
prueba temporal (no commiteada) que pasa `extra: { password, hostToken,
normalField }` a `captureException()`, el evento real muestra `password` y
`hostToken` como `[Filtered]` (label propio de Sentry para scrubbing) y
`normalField` intacto — confirma que la redacción actúa cuando corresponde
y no de más. La verificación de `beforeSend()` queda completa.

**Fase 2.5 (validación real de archivos subidos) completa (2026-09-07)**:
nuevo `lib/fileValidation.js` con `isValidVideoBuffer()` (magic bytes vía
`file-type` v22, detecta mp4/mkv/mov/webm/avi/m4v a partir de los primeros
4100 bytes) e `isValidSubtitleContent()` (estructura real de `.srt`/`.vtt`:
bloque de timestamp con el separador correcto, cabecera `WEBVTT` en VTT, y
un chequeo de proporción de bytes de control para descartar binarios).
Integrado en los tres caminos por los que un video puede entrar a la
biblioteca — modo disco local (valida la cabecera del archivo ya escrito y
lo borra si no matchea), modo streaming a R2 (valida los primeros bytes
ANTES de completar la subida, cortando la conexión si no pasa) y la
confirmación de subida directa a R2 por URL prefirmada (Fase 2.7, donde el
server nunca ve el archivo mientras sube: se lee el rango inicial del
objeto ya en el bucket con la `getObjectHead()` nueva de `lib/r2.js`, y se
borra de la biblioteca si no pasa la validación) — y en la subida de
subtítulos.

**Dos bugs reales encontrados y corregidos durante esta fase, los dos en el
camino de streaming a R2** (`r2VideoStorage._handleFile`): (1) un video más
chico que el umbral de sniff colgaba la subida para siempre, porque el
stream terminaba antes de alcanzar ese umbral y sin un chequeo síncrono
(`validationStarted`) nunca se llamaba al callback de Multer — detectado en
sandbox, antes de probar contra R2 real. (2) Más serio, encontrado recién
probando contra un bucket R2 real: la subida de un video real respondía
`200` con un `size` correcto, pero el objeto quedaba en R2 con **0 bytes
reales** — la causa era que el contador de bytes (`counter`) usaba un
`PassThrough` con un `counter.on('data', ...)` externo, que pone al stream
en modo *flowing* de inmediato; los chunks escritos ahí se drenaban
consumidos por ese mismo listener antes de que `r2.uploadStream` llegara a
engancharse como consumidor real. **Fix**: reemplazar ese `PassThrough` por
un `Transform` propio que cuenta bytes en su método de escritura, sin
ningún listener externo. Confirmado con un harness que reproduce la lógica
exacta de `_handleFile` contra un mock de `r2.uploadStream` con un delay
async realista (a diferencia del harness inicial, que consumía en el mismo
tick y por eso no llegó a detectar este segundo bug) — los 4 casos (video
real/falso × chico/grande) se comportan bien con el fix.

Probado end-to-end en modo disco local contra un servidor real (`curl`):
archivo falso rechazado y borrado, mp4 real aceptado, subtítulos
válidos/inválidos en ambos formatos. **El camino de subida directa por URL
prefirmada se confirmó de punta a punta contra R2 real** (navegador real:
presign → PUT directo al bucket → confirmación de sala, con el video
reproduciéndose después en `room.html`), incluyendo el caso de un archivo
inválido subido por ese camino (se rechaza con 400 y se borra del bucket).

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
sistema de cuentas reales (Fase 2bis) → subida directa a R2 para no cortar
con Cloudflare (Fase 2.7) → expiración de salas/storage (Fase 2.6).

**Fase 2.7 (subida directa a R2 vía URL prefirmada) completa (2026-09-06)**: resuelve el hallazgo bloqueante de
`413 Payload Too Large` de Cloudflare al subir un video real (ver más abajo).
**Segundo hallazgo bloqueante encontrado y resuelto (2026-09-06), este antes de
llegar a probar contra R2 real**: `@aws-sdk/client-s3` (desde v3.729.0) suma
por default un checksum CRC32 a cualquier `PutObject`, incluida una URL
prefirmada — ahí ese checksum queda calculado sobre un body vacío (el archivo
real no existe todavía al firmar) y R2 lo rechaza con `501 NotImplemented`
apenas se usa la URL, con cualquier archivo real. Confirmado sin necesitar un
bucket real (la firma se arma entera en el proceso Node, se pudo comparar la
URL firmada con y sin el fix) y resuelto con
`requestChecksumCalculation: 'WHEN_REQUIRED'` +
`responseChecksumValidation: 'WHEN_REQUIRED'` en el `S3Client` de `lib/r2.js`
(recomendación oficial de Cloudflare para este SDK). Como el cliente es un
singleton compartido, corrige de paso también el camino viejo de multipart
server-side (`uploadStream`). Detalle en `docs/CHANGELOG.md`.
Nueva ruta `POST /api/uploads/presign` (mismo `requireUploadAuth` de siempre)
que devuelve una URL prefirmada de R2 (`r2.getPresignedUploadUrl()`, nueva
función en `lib/r2.js` sobre `@aws-sdk/s3-request-presigner`, dependencia
nueva). El cliente (`index.html` al crear sala, `library.html` al cambiar
cinta desde una sala activa) sube el archivo DIRECTO a R2 con esa URL — el
binario nunca atraviesa el Cloudflare Tunnel — y recién después confirma la
sala reusando **rutas que ya existían sin tocarlas**
(`POST /create-room-from-upload`, `POST /room/:id/change-video-from-upload`):
esas rutas ya sabían recibir la key de un archivo ya en el bucket, solo que
antes esa key siempre venía de una subida hecha por el propio server. Si el
server no tiene R2 configurado, `/api/uploads/presign` responde 404 y el
cliente cae solo al flujo clásico de multipart de siempre (mismo límite de
Cloudflare que antes, en ese modo). Limitación documentada y no resuelta:
firma un PUT simple, no multipart — tope de 5GB por archivo (ver
`docs/PLAN-PRODUCCION.md`, Fase 2.7, para el detalle completo). **Paso de
infraestructura a cargo de quien despliega**: configurar CORS en el bucket
de R2 para permitir el PUT desde el navegador (documentado en el README con
el JSON de ejemplo) — regla de `PUT` + header `Content-Type` permitido, para
el/los orígenes reales de la sala. Antes de la prueba real se encontró y
resolvió un segundo hallazgo bloqueante (checksum CRC32 que agrega por
default `@aws-sdk/client-s3` desde la v3.729.0, ver más abajo la entrada de
Fase 2.7 con la fecha de ese fix) — sin ese fix, R2 rechazaba cualquier
subida real con `501 NotImplemented`. **Probado end-to-end contra un R2 real
(2026-09-06)**: con el fix del checksum aplicado y el CORS del bucket bien
configurado, se confirmó pedir la URL prefirmada, subir un video real,
confirmar la sala, y verificar el objeto en el bucket desde el dashboard de
R2 — la sala reproduce el video sin problemas. Con esto la Fase 2.7 queda
completa del todo.

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

**Fase 2bis — migración del rol de host ✅ para salas con sesión (2026-09-05)**:
`room.ownerUserId` (nuevo campo, persistido igual que `hostToken`/`passwordHash`
en Redis) se setea desde `req.session.userId` al crear una sala, solo si quien
la crea tiene sesión iniciada — si no, queda `null` y la sala sigue el esquema
anónimo de siempre (todavía no hay UI de login, así que sigue siendo el caso
normal hoy). Nuevo helper `isRoomOwner(room, { hostToken, sessionUserId })` en
`server.js`, punto único que reemplaza las comparaciones sueltas de `hostToken`
que había en cada lugar: sala con dueño → solo la sesión autenticada prueba
"soy el host" (`hostToken` deja de alcanzar); sala sin dueño → sigue exactamente
igual que antes. Se actualizaron `join-room` (Socket.io) y las tres rutas HTTP
que dependían de `hostToken` (`change-video`, `change-video-from-upload`,
`upload-subtitle`). Para que Socket.io pueda leer la sesión de Express,
`io.engine.use(sessionMiddleware)` (soportado desde Socket.io 4.6+) — no hace
falta nada nuevo del lado del cliente, la misma cookie `movienight.sid` alcanza.
`room.hostSocketId` sigue siendo, sin cambios, la única fuente de verdad de
"quién controla la sala ahora"; lo que cambió es solo cómo se prueba la
titularidad para poder reclamarlo. Probado de punta a punta el flujo anónimo
con un server real (`DISABLE_REDIS=1`): sigue funcionando exactamente igual que
antes de este cambio. **El camino "con dueño" (sesión real + `ownerUserId`)
está revisado por lectura de código pero todavía no probado end-to-end** —
requiere Postgres arriba para un login real, no disponible en el entorno donde
se hizo este cambio; queda pendiente esa prueba antes de darlo por cerrado del
todo.

**Fase 2bis — camino "con dueño" probado end-to-end (2026-09-06)**: con Redis
y Postgres reales levantados, se confirmó por los 4 caminos que importan
(HTTP y Socket.io) que una sala con `ownerUserId` seteado solo se puede
reclamar con la sesión de esa cuenta — un `hostToken` correcto pero sin esa
sesión (o con la sesión de otra cuenta) ya no alcanza — y que una sala
creada sin sesión sigue funcionando exactamente igual que siempre con
`hostToken`. Este punto de la fase queda cerrado del todo.

**Fase 2bis — "quién puede crear salas" ✅ (decidido el 2026-09-06)**: se
mantiene el mismo criterio de siempre (conocer la `LIBRARY_PASSWORD`
compartida) — no hace falta cuenta registrada ni verificar email, porque
todavía no hay UI de login y exigir cuenta dejaría al grupo actual sin poder
crear salas. De paso se encontró y corrigió un gap real:
`/create-room-from-upload` (crear sala reusando una cinta ya subida) no
pedía ninguna contraseña, a diferencia de `/create-room` — ahora las dos
rutas exigen lo mismo (`requireUploadAuth`).

**Fase 2bis — biblioteca por sesión de usuario ✅ (2026-09-06)**: `requireLibraryAuth`
(listar/borrar en `/api/uploads`) y `requireUploadAuth` (subir cinta nueva,
`/create-room`, `/create-room-from-upload`, `/room/:id/change-video`,
`/room/:id/upload-subtitle`) ahora aceptan una sesión de cuenta real como
alternativa a `LIBRARY_PASSWORD` — no la reemplazan, los dos caminos
conviven a propósito: el grupo sin cuenta no pierde acceso a nada, y quien
sí tiene cuenta deja de necesitar además la contraseña compartida. Se sumó
una UI mínima de login/registro/logout en `index.html` y `library.html`
(encadenando el componente `mnPrompt` que ya existía, sin sumar un
formulario nuevo) — antes de este cambio no había NINGUNA forma de
loguearse desde el navegador, aunque el backend de `/auth/*` ya estaba
listo desde el paso anterior de la fase. Probado end-to-end con Redis y
Postgres reales: sin cookie ni contraseña → 401; con cookie de sesión (sin
mandar contraseña) → 200; con `LIBRARY_PASSWORD` (camino anónimo de
siempre) → 200; mismo resultado en `/create-room-from-upload` (con sesión
pasa el gate y llega al 400 de "archivo no existe", sin sesión sigue
pidiendo la contraseña compartida).

**Fase 2bis — recuperación de contraseña ✅ (2026-09-06)**: nuevas rutas
`POST /auth/forgot-password` y `POST /auth/reset-password`, más
`public/reset-password.html` para completar el link que llega por email.
El email se manda vía **Resend** (`lib/mailer.js`, HTTP directo con
`fetch`, sin SDK ni SMTP — mismo criterio minimalista que el resto del
proyecto). Token de un solo uso, random (`crypto.randomBytes`), guardado
en la tabla nueva `password_resets` como `sha256(token)` (nunca el token en
texto plano, mismo principio que una contraseña) con vencimiento de 1 hora;
al resetear con éxito se invalidan TODOS los pedidos pendientes de esa
cuenta, así un link viejo no sigue sirviendo. `POST /auth/forgot-password`
responde siempre el mismo mensaje genérico (exista o no el email) para no
permitir enumerar cuentas registradas, con un limitador propio (3 pedidos
por hora, clave ip+email) que tampoco delata si el límite se alcanzó (sigue
devolviendo el mismo mensaje). Sin `RESEND_API_KEY` configurada, el link se
loguea por consola en vez de mandarse — solo pensado para desarrollo local,
igual criterio que otros escape hatches del proyecto (`DISABLE_REDIS`,
etc.); se reporta en el healthcheck (`checks.email`) si está habilitado o
no, sin que la ausencia cuente como falla. Probado end-to-end con Postgres
real: token inválido → 400; contraseña corta con token real → 400 sin
gastar el token; token real + contraseña válida → 200 y la contraseña
cambia de verdad (confirmado que el login viejo deja de funcionar y el
nuevo sí); reintentar el mismo token después de usarlo → 400 (ya no sirve);
rate limiting confirmado contando cuántos links se llegaron a loguear tras
varios pedidos seguidos para el mismo email.

**Fase 2bis — verificación independiente en entorno real (2026-09-06)**: además
de las pruebas end-to-end contra Redis/Postgres reales hechas al cerrar la
fase (ver entradas de arriba), se corrió el mismo plan de pruebas
(`PRUEBAS-FASE-2BIS.md`) en un entorno separado (Windows, PowerShell,
Docker para Redis/Postgres). Las 8 secciones dieron el resultado esperado:
registro/login/sesiones, migración del rol de host (sesión de la dueña
autoriza, otra cuenta y hostToken solo no, sala anónima con hostToken
sigue funcionando igual que siempre), biblioteca por sesión, recuperación
de contraseña con rate limiting, healthcheck, UI de login/biblioteca en el
navegador, y la regresión sin `DATABASE_URL`. No se necesitó tocar código —
los únicos tropiezos fueron de escaping de JSON en PowerShell al armar los
`curl` a mano, no del servidor. Con dos verificaciones independientes
(sandbox + entorno real del usuario), la Fase 2bis queda confirmada.

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

**Nota histórica**: esta entrada quedaba desactualizada apenas se escribió —
"biblioteca por sesión de usuario", "quién puede crear salas" y
"recuperación de contraseña" ya se resolvieron todos (ver las entradas más
arriba, con fecha 2026-09-06). La Fase 2bis está completa.

**Fase 1.1 (persistencia externa) ya resuelta (2026-09-05)**: `lib/roomStore.js`
respalda en Redis lo esencial de cada sala (cinta, posición, contraseñas,
muteos, chat) y lo repuebla al arrancar — una sala sobrevive a un reinicio del
proceso. Fail-fast si Redis está configurado y no responde (no arranca el
server); `DISABLE_REDIS=1` para desarrollo local sin Redis, nunca en
producción.
