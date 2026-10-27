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
  lib/rateLimiter.js       # Limitador de intentos fallidos (extraído en Fase 5); listLocked() lista los bloqueados ahora; splitLastColon() y maskEmail() para el panel
  lib/ipKey.js             # rateLimitKeyFromIp(): clave de los limitadores (IPv6 -> prefijo /64)
  lib/hostAuth.js          # isRoomOwner + setHost, el sistema de roles (extraído en Fase 5)
  lib/uploadReference.js   # Modo dual disco/R2 para referencias a videos ya subidos (extraído en Fase 5)
  lib/logger.js            # Logger estructurado (JSON) sobre pino, con redacción de campos sensibles — Fase 4
  lib/sentry.js            # Reporte opcional de excepciones a Sentry, con redacción de secretos — Fase 4
  lib/metrics.js           # Contadores en memoria para GET /metrics (uploads en curso, errores de R2) — Fase 4
  lib/alerts.js            # Alertas mínimas por email si el healthcheck o R2 vienen fallando — Fase 4
  lib/settings.js          # Catálogo de parámetros administrables (panel de admin, ✅ completo — ver "Por dónde seguir")
  lib/avatars.js           # Avatares de cuenta: lee public/avatars/avatars.json, valida, resuelve id -> { id, name, url } y limita los cambios (20 cada 10 min por cuenta)
  scripts/make-admin.js    # Promueve una cuenta existente a admin (panel de admin, ✅ completo)
  scripts/check-avatars.js # `npm run check:avatars`: revisa los iconos del manifiesto (formato, peso, dimensiones, SVG inseguros, CREDITS.md)
  scripts/prepare-avatar.py # Recorta, escala y guarda una imagen como public/avatars/<id>.png (Python 3 + Pillow; no usa npm)
  public/admin.html        # Panel de administración: settings + dashboard + acciones sobre salas (✅ completo, paso 9 cerrado)
  public/avatars/          # Iconos de avatar: avatars.json (manifiesto), 6 PNG de 256x256, README.md (cómo agregarlos) y CREDITS.md (origen y licencia)
  scripts/r2-cleanup-multipart.js
  test/                    # Tests unitarios (node:test) de la lógica extraída a lib/*.js — Fase 5
  .github/workflows/ci.yml # CI: corre npm test en cada push/PR — Fase 5
  public/
    index.html            # Crear sala / unirse por código; también login/registro/logout (Fase 2bis)
    library.html            # Biblioteca de videos ya subidos (con contraseña propia o sesión de cuenta)
    room.html              # La sala: reproductor, chat, controles (la mayoría de la lógica de cliente vive acá)
    reset-password.html    # Pantalla para elegir contraseña nueva tras el link de "olvidé mi contraseña"
    terms.html, privacy.html # Términos de uso / privacidad (BORRADOR, sin linkear todavía — Fase 6)
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
- ~~Contraseña de biblioteca sin bloqueo por IP~~ → **resuelto 2026-10-21**: `requireLibraryAuth` comparte el limitador de
  `requireUploadAuth` (3 intentos, 15 min). Ver «Por dónde seguir».
- ~~Sin forma de ver qué IPs están bloqueadas ni log de los intentos fallidos~~ → **resuelto 2026-10-23**: `GET /admin/security` (solo admin)
  y `logger.warn` con la IP en cada intento fallido. Es el estado actual en memoria, no un historial. Ver «Por dónde seguir».
- ~~Los limitadores de intentos usaban la IPv6 completa como clave: cambiar de dirección dentro del mismo bloque esquivaba el bloqueo~~ →
  **resuelto 2026-10-24** para login, biblioteca/subida y salas con contraseña: la clave es el prefijo /64. Ver «Por dónde seguir». El limitador de
  recuperar contraseña (`isResetRequestRateLimited`) se resolvió después, el mismo día: ver «Por dónde seguir».
- ~~Contraseña de biblioteca guardada en `localStorage` en texto plano~~ → **mitigado 2026-10-21**: ahora en `sessionStorage` (por pestaña) y se
  migra/borra la vieja. Sigue legible por un script inyectado en esa pestaña. `mn_host_<sala>` sigue en `localStorage`. Ver «Por dónde seguir».
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

**Interruptores de acceso, fase 4 de 5: `ALLOW_REGISTRATION` y `ALLOW_LIBRARY_PASSWORD` (2026-10-27)**: código hecho y verificado por el asistente, **pendiente de que la persona aplique el parche y pruebe en el navegador**. Las fases 1 y 2 ya estaban aplicadas; la fase 3 (commit `0abe64d`) sigue con su prueba en navegador pendiente. Plan en `docs/PLAN-INTERRUPTORES.md` (4.0d).

- **Qué cambió:** `lib/accessPolicy.js` suma `libraryPasswordBlock` y `registrationBlock` y mete `ALLOW_LIBRARY_PASSWORD` en `ACCOUNT_REQUIRING_SWITCHES`; `server.js` los usa en `requireLibraryAuth`, `requireUploadAuth` y `/auth/register`, y `GET /api/access-policy` suma `allowRegistration` y `allowLibraryPassword`; claves en `lib/settings.js`, `lib/envValidation.js`, el panel y `.env.example`; `index.js` avisa antes de pedir la contraseña si ya no vale. Ambos cortes responden 403 (`ACCOUNT_REQUIRED` o `REGISTRATION_CLOSED`), nunca 401, para que el cliente no reabra el prompt de contraseña.
- **Con `ALLOW_LIBRARY_PASSWORD` apagado** el corte va antes de comparar la contraseña: no gasta intentos del limitador ni confirma si era correcta. Cierra el hueco de `presign` de la fase 2.
- **Ojo (revisar):** apagarlo implica que un anónimo tampoco puede crear sala aunque `ALLOW_ANONYMOUS_ROOMS` esté en «Sí», porque la contraseña era su única puerta. No lo decidí yo: sale de que `requireUploadAuth` protege `/create-room`. Si se quiere otra cosa hay que separar ambas reglas.
- **Verificado:** `npm test` 155/155, lint limpio, prueba de mutación (2 tests fallan sin la regla) y prueba con el servidor real y Postgres local (registro cerrado, contraseña apagada en las 5 rutas, con y sin sesión, arranque fallido sin `DATABASE_URL`). **No verificado:** navegador (aviso de `index.js`, selectores del panel, `library.html` con el interruptor apagado), guardar desde el panel, R2 real y la app móvil.
- **Siguiente:** fase 5, `REQUIRE_ACCOUNT_TO_JOIN` (rechazo en `join-room` y pantalla de «necesitas cuenta» en `room.js`). Es la pesada: antes de empezar hay que decidir qué ve quien abre un link de sala sin cuenta (4.1 del plan). Suma su interruptor a `ACCOUNT_REQUIRING_SWITCHES` y actualiza también `PLAN-PRODUCCION.md`.

**Interruptores de acceso, fase 3 de 5: control temporal de una sala sin host (2026-10-27)**: código hecho y verificado por el asistente, **pendiente de que la persona aplique el parche y pruebe en el navegador**. Las fases 1 y 2 ya están aplicadas. Plan en `docs/PLAN-INTERRUPTORES.md` (3.2 y 4.0c).

- **Qué cambió:** `lib/hostAuth.js` suma `roomHasLiveHost`, `canTakeTemporaryHost` y `assignHostOnJoin`; el bloque `join-room` de `server.js` los usa en vez del `if/else` de `isRoomOwner`; `lib/roomStore.js` exporta `hydrateRoom` (solo para tests); 14 tests nuevos. Quien entra a una sala sin host vivo recibe el control temporal si `HOST_AUTO_TRANSFER` está encendido y (`ALLOW_ANONYMOUS_ROOMS` encendido o tiene sesión). Si vuelve el dueño, lo recupera y degrada al temporal.
- **Decisión que tomé yo (revisar):** con `HOST_AUTO_TRANSFER` apagado tampoco hay control temporal, porque el plan (3.1) dice que entonces nadie controla hasta que vuelva el host. El plan no lo decía explícitamente para 3.2; si se prefiere lo contrario es quitar una línea de `canTakeTemporaryHost()` y su test.
- **Ojo:** el host temporal de una sala anónima recibe el `hostToken` de la sala (igual que con el traspaso automático y `make-host` hoy). En salas con dueño ese token no autoriza nada.
- **Verificado:** `npm test` 145/145, lint limpio, prueba de mutación (7 tests fallan sin la regla) y prueba con el servidor real y sockets (dueño se va, visitante recibe control, dueño vuelve y lo recupera, tercero queda de invitado; con `HOST_AUTO_TRANSFER=0` nadie lo recibe). **No verificado:** reinicio real con Redis (sin Redis en el entorno; lo cubre el test con `hydrateRoom`), `ALLOW_ANONYMOUS_ROOMS` apagado con sesión real (sin Postgres) y la UI en un navegador.
- **Siguiente:** fase 4, `ALLOW_REGISTRATION` y `ALLOW_LIBRARY_PASSWORD` (condiciones en `/auth/register`, `requireLibraryAuth` y `requireUploadAuth`; suma `ALLOW_LIBRARY_PASSWORD` a `ACCOUNT_REQUIRING_SWITCHES`). Cierra además el hueco de `presign` anotado en la fase 2.

**Interruptores de acceso, fase 2 de 5: `ALLOW_ANONYMOUS_ROOMS` (2026-10-27)**: código hecho y verificado por el asistente, **pendiente de que la persona aplique el parche y pruebe en el navegador**. La fase 1 (`bool` y `HOST_AUTO_TRANSFER`) ya fue probada y aplicada. Plan en `docs/PLAN-INTERRUPTORES.md`.

- **Qué cambió:** `lib/accessPolicy.js` nuevo; `requireAccountToCreateRoom` antes de `requireUploadAuth` en `/create-room` y `/create-room-from-upload` (403 `ACCOUNT_REQUIRED`); `GET /api/access-policy`; aviso en `index.js`; validación de arranque (sin `DATABASE_URL` y con el interruptor apagado el server no arranca); clave en el catálogo y el panel. Solo bloquea crear: las salas anónimas existentes siguen.
- **Ojo:** `presign` y `change-video` no se tocaron a propósito; sin cuenta pero con la contraseña de biblioteca aún se puede subir un archivo suelto a R2 hasta la fase 4.
- **Verificado:** `npm test` 131/131, lint limpio y prueba por HTTP con el servidor real y un Postgres local (rechazo anónimo, cuenta sin contraseña, panel, arranque fallido). **No verificado:** el aviso y el selector en un navegador, R2 real y la app móvil.
- **Siguiente:** fase 3, control temporal en `join-room` (leer antes `lib/hostAuth.js` y los bloques `join-room`/`disconnect`).

**Interruptores de acceso, fase 1 de 5: tipo `bool` y `HOST_AUTO_TRANSFER` (2026-10-27)**: código hecho y verificado por el asistente, **pendiente de que la persona aplique el parche y pruebe el panel**. Plan completo en `docs/PLAN-INTERRUPTORES.md`.

- **Qué cambió:** `lib/settings.js` (tipo `bool`, clave `HOST_AUTO_TRANSFER`, default `true`), `lib/envValidation.js` (warning si no es 1/true/0/false), `server.js` en `disconnect` (apagado: no hay traspaso, `hostSocketId` queda en `null`, aviso en el chat), selector Sí/No en el panel (`admin.js`, `style.css`), `.env.example` y 10 tests nuevos.
- **Verificado:** `npm test` 121/121, lint limpio, y una prueba con el servidor local y dos sockets en los tres casos (default, `=0`, typo). **No verificado:** el selector en un navegador ni guardar desde el panel (no hay Postgres en el entorno del asistente).
- **Siguiente:** fase 2, `ALLOW_ANONYMOUS_ROOMS` (exigir sesión al crear sala aunque la contraseña de biblioteca sea correcta; ver 4.2 del plan).

**CSP sin `'unsafe-inline'` en `styleSrc`, paso final: `styleSrc` queda en `['self', 'https://fonts.googleapis.com']` (2026-10-25)**: hecho y probado por la persona. Un parche sobre `origin/plan-produccion`
(`CSP: styleSrc sin 'unsafe-inline' (ultimo paso de la conversion de CSP)`, commit `7d6008a`, solo `server.js`). **Con esto queda cerrada la serie de conversión de la CSP: ni `scriptSrc` ni `styleSrc` llevan `'unsafe-inline'`.**

- **Qué cambió:** en `server.js`, `styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']` pasó a `["'self'", 'https://fonts.googleapis.com']`; se reemplazó la primera línea del comentario (ya falsa) por una que explica que
  no queda ningún `style="..."` ni `<style>` en `public/`, que uno nuevo se bloquea a propósito y que lo correcto es una clase en `public/style.css` o `setProperty` desde JS. La explicación de por qué sigue `fonts.googleapis.com` quedó igual.
- **No cambió:** `fontSrc` (sigue con `fonts.gstatic.com`), `scriptSrc`, `scriptSrcAttr`, `imgSrc`, `connectSrc`, `mediaSrc` ni ningún archivo de `public/`.
- **Verificado por el asistente:** `grep 'style="'` en `public/*.html` y `public/js/*.js` da 0 antes y después; sin `<style>`, `setAttribute('style', ...)`, `cssText` ni `insertAdjacentHTML`, ni `style=` en `server.js`, `sw.js` ni `lib/`;
  `node --check`; `npm test` 111/111 y lint limpio; con el servidor en local (`DISABLE_REDIS=1`), la cabecera real manda `style-src 'self' https://fonts.googleapis.com` (sin `'unsafe-inline'`, con Google Fonts), `font-src 'self' https://fonts.gstatic.com`,
  `script-src 'self'` y `script-src-attr 'none'`; las 7 páginas y `/style.css` responden 200.
- **Probado por la persona en el navegador (las 7 páginas, una por una, con la consola abierta):** informó que todas las pruebas salieron bien, sin ningún error de `style-src` en la consola y sin deformaciones visuales (sin más detalle por página).
- **Estado de la CSP al cerrar la serie:** `scriptSrc: ['self']`, `scriptSrcAttr: 'none'`, `styleSrc: ['self', 'https://fonts.googleapis.com']`. Cualquier `<script>` o `style` inline nuevo se bloquea a propósito.
- **Pendientes aparte (sin cambios, no son de esta serie):** el beacon de Cloudflare bloqueado por `script-src`; `favicon.ico` 404; `<meta apple-mobile-web-app-capable>` obsoleta; `escapeHtml` no escapa `"` y sus 4 copias sin unificar; prueba en móvil de `room.html`
  (rotación y teclado de Android); limpieza de salas de prueba.

**CSP sin `'unsafe-inline'` en `styleSrc`, paso 2 de 2: los 4 colores dinámicos de `room.js` pasan a `--user-color` (2026-10-25)**: hecho y probado por la persona. Un parche sobre `origin/plan-produccion`
(`style: los 4 color:usernameColor() de room.js pasan a --user-color via setProperty`, commit `8c73b7f`; solo `room.js` y `style.css`). **La CSP NO cambió todavía**: `styleSrc` sigue con `'unsafe-inline'`.
**Con esto ya no queda ningún `style="..."` en `public/`** (`grep` da 0).

- **Qué cambió:** los 4 `style="color:${usernameColor(...)}"` de `room.js` (lista de espectadores, cita de respuesta, autor del mensaje y danmaku) pasan a clases (`viewer-name`, `reply-quote-user`, `msg-user`, `danmaku-user`)
  y a `elemento.style.setProperty('--user-color', ...)` justo después del `innerHTML`. `addMessage()` ahora termina con `return div;` (único cambio de lógica) y `renderChatMessage` lo captura para colorear el autor y,
  solo si existe `data.replyTo`, la cita.
- **Desvío respecto del prompt (necesario para que los colores sean los mismos):** agregar una regla `color: var(--user-color)` a una clase sola habría perdido contra reglas ya existentes que antes perdían contra el `style` inline:
  `#messages .msg b { color: var(--pink) }` (todos los autores habrían salido rosa), `.danmaku-item b { color: var(--cyan) }` (todos los danmaku cian) y `#messages .msg .reply-quote .reply-quote-user { color: var(--cyan) }` (la cita).
  Por eso los selectores son más específicos (`#messages .msg .msg-user`, `.danmaku-item .danmaku-user`) y la regla existente de la cita ahora usa `color: var(--user-color, var(--cyan))`. `.viewer-name` queda como clase sola (ninguna regla le compite).
- **No cambió:** `usernameColor()`, `USERNAME_COLORS` (7 colores), `HOST_NAME_COLOR` (`#00e5ff`) ni `hashUsername()` (comparados por contenido contra `fa2760a`: idénticos); `server.js` y la CSP.
- **Verificado por el asistente:** 0 `style="` en `public/`; `node --check`; `npm test` 111/111 y lint limpio; lectura del flujo de `renderChatMessage` (un mensaje de sistema sale antes del código nuevo; sin cita no se busca `.reply-quote-user`;
  con cita, el elemento siempre existe y el texto de otra persona va escapado).
- **Probado:** Copilot en local (sala de prueba con dos pestañas): colores distintos por usuario en lista, chat, cita y danmaku en pantalla completa, mensaje de sistema sin color de usuario, sin errores de CSP ni JavaScript. Reporte de Copilot
  con un dato incoherente: decía que el host tenía el cian especial pero sus datos mostraban a «HostColor» en naranja y a «ViewerColor» en cian (probablemente las dos pestañas compartían `localStorage` y la segunda heredó el token de host).
  **La persona lo repitió en el dominio público y informó que todos los resultados fueron positivos** (sala `e6e87b`, captura de DevTools con chat de autores en colores distintos, sin errores de CSP; solo los avisos conocidos).
- **No verificado:** la salida de pantalla completa con el panel de emojis abierto en el navegador integrado de Copilot (limitación del entorno; ese comportamiento no lo toca este parche y ya se había probado antes).
- **Siguiente (último paso de la serie `styleSrc`):** quitar `'unsafe-inline'` de `styleSrc` en `server.js` (hoy: `["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']`) y actualizar su comentario. Antes de hacerlo conviene un `grep` final de
  `style=`, `<style`, `setAttribute('style'` y `cssText` en `public/` (los dos últimos ya daban 0 en la auditoría), y probar las 7 páginas en el dominio, porque afecta a todas a la vez.
- **Pendientes aparte (sin cambios):** beacon de Cloudflare, `favicon.ico` 404, `<meta apple-mobile-web-app-capable>` obsoleta, unificar `escapeHtml` y escapar `"`, prueba en móvil de `room.html`, limpieza de salas de prueba.

**CSP sin `'unsafe-inline'` en `styleSrc`, paso 1 de 2: los 58 `style="..."` estáticos pasan a clases (2026-10-25)**: hecho y probado por la persona. Un parche sobre `origin/plan-produccion`
(`style: los 58 style="..." estaticos pasan a clases en public/style.css`, commit `4534f15`). **La CSP NO cambió**: `styleSrc` sigue con `'unsafe-inline'`. Quedan 4 `style="..."` dinámicos, todos en `room.js`.

- **Qué cambió:** 11 archivos: `admin.html`, `index.html`, `library.html`, `privacy.html`, `reset-password.html`, `room.html`, `terms.html`, `admin.js`, `index.js`, `library.js` y `style.css`. No se tocó `room.js`, `server.js` ni la CSP.
  Desglose real de los 58: 8 `display:none`, 3 `max-height:none; overflow:visible`, 5 `font-size:clamp(...)`, 3 de margen (`index.html:74` y `:81`, `reset-password.html:38`), 1 `overflow-wrap`, 2 `color:var(--cyan)` del SVG `cassetteIcon` y 36 flotadores.
  (La auditoría previa, hecha en el chat y no guardada en docs, tenía mal sumado ese desglose: decía 11 `display:none` y 4 `clamp`.)
- **Clases nuevas (todas al final de `style.css`):** `hidden-by-default` (8 elementos que JS muestra con `style.display`), `marquee-title-admin/-library/-legal/-reset`, `tape-list-expanded`, `back-link-below-12/-16`,
  `eyebrow-code`, `tape-item-meta-wrap`, `cassette-spin-cyan`, y las reglas `:nth-child` de los flotadores: `floaters-vhs` (compartida por `admin.html` y `library.html`, un solo bloque de 6), `floaters-index` (18) y `floaters-room` (6).
- **Por qué importa el orden y la especificidad:** `.hidden-by-default` va AL FINAL de `style.css` y sin `!important`, porque `.host-controls` y `.local-controls` declaran `display:flex` (gana la regla que viene después a igual especificidad) y un `!important` taparía las
  asignaciones `elemento.style.display = '...'` del JS. `eyebrow-code` usa también el selector `.deck .eyebrow-osd.eyebrow-code` porque `.deck:not(.deck-wide) .eyebrow-osd` (`margin-bottom`) le ganaría por especificidad a una clase sola.
- **Verificado por el asistente:** `grep 'style="'` da exactamente 4 (`room.js:408,890,892,1062`); comparación con un script de los 4 valores de cada flotador contra la regla CSS: 30 reglas únicas (cubren los 36 flotadores), 0 diferencias;
  los contenedores `.floaters` tienen solo hijos `.floater` en las 4 páginas (`:nth-child` seguro); nadie usa `style.display = ''`; sin otras reglas CSS con `display` sobre esos elementos; `node --check` de los 3 JS; `npm test` 111/111 y lint limpio.
- **Probado por la persona en el navegador:** la persona informó que todas las pruebas dieron resultados positivos (flotadores de las páginas, elementos que empiezan ocultos en la sala y el panel de admin, títulos y enlaces, ícono de subida, consola),
  sin más detalle por prueba.
- **Siguiente:** paso 2 de 2: los 4 `style="color:${usernameColor(...)}"` de `room.js` (líneas 408, 890, 892, 1062) con `elemento.style.setProperty('--user-color', ...)` y reglas en `style.css`
  (propuestas: `.viewer-name`, `.reply-quote-user`, `.msg-user`, `.danmaku-user`); recién después, quitar `'unsafe-inline'` de `styleSrc`. `usernameColor()` devuelve 1 de 8 valores fijos (paleta de 7 más el color del host).
- **Pendientes aparte (sin cambios):** beacon de Cloudflare, `favicon.ico` 404, `<meta apple-mobile-web-app-capable>` obsoleta, unificar `escapeHtml` y escapar `"`, prueba en móvil de `room.html`, limpieza de salas de prueba.

**Auditoría de `innerHTML` en `public/js/*.js` (2026-10-25)**: hecha, **sin hallazgos que corregir; no hubo cambios de código**. Trabajada sobre `c348fa0`. Solo documentación.

- **Alcance:** los 47 usos de `innerHTML` en `admin.js` (14), `index.js` (11), `library.js` (14) y `room.js` (8); `sw-register.js` y `reset-password.js` tienen 0. El asistente leyó cada sitio con su contexto y rastreó el origen del dato
  (criterio: ¿puede el valor contener algo escrito por otra persona, o venir de un `fetch`, un evento de socket o la URL, sin pasar por `escapeHtml`?). Con el repo sin cambios, `npm test` 111/111 y lint limpio.
- **Qué confirmó la persona:** NO revisó los 47 sitios. Hizo dos verificaciones puntuales propias: (a) que `escapeHtml` no escapa las comillas dobles y (b) el alfabeto de `socket.id`. El resto de la tabla es lectura del asistente, no confirmada sitio por sitio por la persona.
  El único dato del servidor que no se leyó en su definición: las claves de parámetros (`ROOM_TTL_HOURS`, `MAX_LIBRARY_VIDEOS`) se dedujeron de `SETTINGS_META` y de lo que muestra el panel.
- **Tabla (archivo:línea, qué inserta, origen, escapado):**

| Archivo:línea | Qué inserta | Origen del dato | ¿Escapado? / ¿arreglar? |
|---|---|---|---|
| `admin.js:4`, `index.js:354`, `library.js:40`, `room.js:110` | `div.innerHTML` dentro de la propia función de escapado | Es el mecanismo de escapado | n/a / No |
| `admin.js:74,159,276,307`, `library.js:271,289`, `room.js:396,918,1048` | `''` para vaciar | Literal | n/a / No |
| `admin.js:154,246,266,272,304`, `library.js:280,286` | Mensajes fijos de error o vacío | Literales | n/a / No |
| `admin.js:75`, `index.js:332`, `library.js:170` | Email de la cuenta | `currentUser.email`, de `/auth/me` | Sí (`escapeHtml`; `escapeHtmlLocal` en `index.js`) / No |
| `index.js:339`, `library.js:177` | Botones de login y registro | Literales | n/a / No |
| `admin.js:166` | Fila de parámetros: etiqueta, descripción, origen, valor, clave | Etiqueta y descripción: `SETTINGS_META` (constantes). Origen y valor: `/api/admin/settings` | Sí, todo con `escapeHtml`; `sourceClass` y `placeholder` son constantes / No |
| `admin.js:284` | Fila de bloqueados: fuente, email enmascarado, sala, IP, minutos | Lista de bloqueados del servidor; minutos de `Math.ceil` sobre `Number` | Sí / No |
| `admin.js:314` | Fila de sala: id, video, host, dueño, viewers, actividad, botón | `/api/admin/rooms`; `viewerCount` número; `formatLastActivity` texto de fecha local | Sí (el host, al armar `hostLabel`) / No |
| `index.js:172,199,225,247,263,278,307,443`, `library.js:313,433,472,494,511,526` | `cassetteIcon` más texto fijo o `pct` | Constante SVG, literales y `Math.round` | n/a (constantes y números) / No |
| `library.js:293` | Fila de cinta: nombre, tamaño, fecha, etiqueta del botón | `tape.displayName` de `/api/uploads` (nombre que puso quien subió el video); tamaño y fecha: texto calculado de números; `useLabel`: constante | Sí, el nombre con `escapeHtml` / No |
| `room.js:408` | Fila de espectador: nombre, color, `id` en botones | Nombre del evento `viewer-list`; color de una paleta fija de 7; `id` = `socket.id` (Socket.IO, servidor) | Sí, el nombre / No |
| `room.js:881` | `div.innerHTML = html` en `addMessage` (sumidero) | Llamadores: `room.js:887` (sistema) y `room.js:903` (chat) | Ambos llamadores escapan todo texto de otra persona; colores de paleta fija / No |
| `room.js:935` | Vista previa de respuesta: usuario y texto | Del mensaje respondido | Sí, ambos / No |
| `room.js:1062` | Danmaku: usuario, texto, color | Evento de chat | Sí, ambos / No |

- **Valores dentro de atributos** (`data-key`, `data-room`, `data-id`, `value=`): todos controlados por el servidor, no por otra persona (`roomId` = 6 hex de `makeRoomId`; `socket.id` lo genera Socket.IO; claves de parámetros fijas; valor numérico).
- **Nota aclaratoria (no es pendiente):** los valores de `dataset` en `room.js` (`user`, `text`, `ishost`) se asignan con la API del DOM (`div.dataset[k] = v`), no con `innerHTML`, así que no necesitan escapado.
- **Pendientes a decidir aparte (no tocados):**
  1. **`escapeHtml` no escapa las comillas dobles** (usa `textContent` seguido de `innerHTML`: escapa `&`, `<` y `>`, no `"`). Hoy no es explotable porque ningún valor de otra persona entra en un atributo, pero si en el futuro alguien
     pone texto de usuario dentro de un atributo con `escapeHtml`, podría salirse de las comillas. Posible paso: unificar la función y escapar también `"` y `'`.
  2. **Cuatro copias de la función:** tres `escapeHtml` (la de `room.js` además tolera `null`) y una `escapeHtmlLocal` en `index.js`. Unificarlas en un archivo compartido, si se decide que vale la pena.

**CSP sin `'unsafe-inline'`, paso 6: `scriptSrc` queda en `['self']` (2026-10-25)**: hecho y probado por la persona en el dominio público. Un parche sobre `origin/plan-produccion`
(`CSP: scriptSrc sin 'unsafe-inline' (paso 6 de la conversion)`, solo `server.js`). **Con esto termina la serie de 6 pasos.**

- **Qué cambió:** en `server.js`, `scriptSrc: ["'self'", "'unsafe-inline'"]` pasó a `scriptSrc: ["'self'"]`, y se reemplazó el comentario (ya falso) por uno que dice que ninguna página necesita `'unsafe-inline'`, que
  `scriptSrcAttr` sigue en `'none'` y que un `<script>` inline nuevo se bloquea a propósito: el JS nuevo va como archivo en `public/js/`, referenciado con `<script src="/js/...">`.
- **No cambió:** `scriptSrcAttr`, `styleSrc` (sigue con `'unsafe-inline'`: hay `style="..."` inline en todas las páginas; es un tema aparte), ninguna otra directiva, ningún archivo de `public/`.
- **Verificado por el asistente:** `grep "<script" public/*.html` antes y después: cero `<script>` sin `src` (`privacy.html` y `terms.html` no tienen ninguno); sin `javascript:`, `eval` ni `new Function` en `public/` y `server.js`;
  `node --check`; `npm test` 111/111, lint limpio; con el servidor en local (`DISABLE_REDIS=1`) la cabecera real manda `script-src 'self'` y `script-src-attr 'none'`, sin `'unsafe-inline'`; las 7 páginas y los `.js` responden 200.
- **Probado por la persona en el dominio público (con la CSP nueva, confirmado porque el error del beacon de Cloudflare ahora dice `"script-src 'self'"` y antes decía `'self' 'unsafe-inline'`):** Copilot (sin sesión ni
  contraseña) vio `/`, `/library.html` (diálogo de contraseña), `/reset-password.html?token=algofalso` y una sala, cada una con su `.js` cargado y sin error de CSP propio, 404 ni error JavaScript;
  **`/admin.html` con sesión de admin carga sus datos (3 salas activas, parámetros)**, con `sw-register.js` y `admin.js` en 200; la persona probó crear una sala desde la portada, la biblioteca con la contraseña
  correcta y una sala real con video y chat (sala `cf6d9c`: video reproduciéndose, chat, websocket 101), todo sin errores nuevos en la consola.
- **Consola, solo avisos conocidos y ajenos al cambio:** beacon de Cloudflare bloqueado por la CSP, `apple-mobile-web-app-capable` obsoleta, 404 de `favicon.ico`.
- **No verificado:** `privacy.html` y `terms.html` no se abrieron en el navegador (no tienen scripts, la cabecera es la misma); en móvil, rotación y teclado de Android de `room.html` (la persona lo hará después).
- **Con esto queda resuelto** el pendiente viejo de confirmar `admin.html` en el dominio real.
- **Pendientes aparte:** (1) la CSP bloquea `https://static.cloudflareinsights.com/beacon.min.js`: permitirlo en `server.js` (`scriptSrc`/`connectSrc`) o desactivar la inyección en el panel de Cloudflare;
  (2) `favicon.ico` da 404 (no hay ícono); (3) `<meta name="apple-mobile-web-app-capable">` obsoleta: agregar `mobile-web-app-capable`; (4) `styleSrc` sigue con `'unsafe-inline'`, tema aparte;
  (5) prueba en móvil de `room.html`; (6) limpieza de salas de prueba.

**CSP sin `'unsafe-inline'`, paso 5: `room.html` sin JS inline (2026-10-25)**: hecho y probado por la persona en PC y en el dominio público; **queda pendiente solo la prueba en móvil** (ver abajo). Un parche sobre `origin/plan-produccion`
(`room.html: el script grande pasa a public/js/room.js`). **La CSP NO cambió**: `scriptSrc` sigue con `'unsafe-inline'`. Con este paso ya no queda JS inline en ninguna página de `public/`.

- **Qué cambió:** el tercer `<script>` de `public/room.html` (inline, 66633 bytes, 1194 líneas: desde el comentario «Alto real de la sala» antes de `function setAppHeight()` hasta el último
  `document.addEventListener('fullscreenchange', ...)`) pasó tal cual a `public/js/room.js` (archivo nuevo). `room.html` lo carga con `<script src="/js/room.js" defer></script>` en el mismo lugar (antes de
  `</body>`), después de `/socket.io/socket.io.js` y `/js/sw-register.js`, que siguen en el `<head>` y sin `defer`. Sin `nonce`, `integrity` ni `crossorigin`. (El prompt decía que empezaba en `function setAppHeight() {`;
  empieza en un comentario justo antes. No cambia nada.)
- **No cambió:** CSP, `server.js`, el `<script>` de socket.io, `sw-register.js`, otras páginas, ningún nombre de función ni variable. Claves de storage intactas (`mn_uid` y `mn_host_<sala>` en `localStorage`,
  `mn_username_<sala>` en `sessionStorage`) y rutas relativas intactas (`/api/room/<sala>`, `/room/<sala>/upload-subtitle`, socket). No se anotó ningún bug durante la copia.
- **Por qué `defer` es seguro:** `io` ya existe porque socket.io es bloqueante en el `<head>`; el script era lo último del body (después solo `</body></html>`), así que con `defer` corre con el mismo DOM completo; el
  script no usa `DOMContentLoaded`, `readyState`, `window.onload`, `load`, `currentScript` ni `document.write`. Único efecto posible: la página puede pintarse un instante antes de que corra (parpadeo del layout), sin riesgo funcional.
- **Verificado por el asistente:** comparación byte a byte (con `cmp` y con Python) del `<script>` viejo (de `git show 127de40:public/room.html`, líneas 161 a 1354) contra `room.js`: idéntico, también en un clon fresco
  tras `git am`; `node --check`; `room.html` con tres `<script src>` y ninguno con código; no hay atributos `on*=`; `npm test` 111/111 y lint limpio.
- **Probado por la persona (PC, 2026-10-25):** con el host en una ventana normal y un espectador en una ventana de incógnito (sin `localStorage` compartido): sincronización del video (play, pausa, seek),
  danmaku y reacciones, panel de emojis, subtítulos, pantalla completa con el panel de emojis abierto (se cierra al salir) y modo claro/oscuro. La persona informó que todo dio resultados positivos (sin más detalle por prueba).
  Antes, Copilot ya había visto en local: `room.js` con 200, chat, reacción y lista de espectadores (`👥 2`).
- **Probado por la persona en el dominio público (capturas de DevTools, con recarga forzada `Ctrl+Shift+R`):** `/js/room.js` con 200 (tipo `script`, 25.2 kB, iniciador la línea 160 de `room.html`, directo de la red); en la consola
  solo los avisos conocidos y ajenos a este cambio (beacon de Cloudflare bloqueado por la CSP, `apple-mobile-web-app-capable` obsoleta, 404 de `favicon.ico`); ningún error de CSP ni 404 de `room.js`.
- **PENDIENTE (no verificado):** solo en móvil, rotación (layout fila/columna, `setAppHeight`, `orientationchange`) y el fix del teclado de Android; la persona lo hará después.
- **Limpieza pendiente (no es del código):** salas de prueba y la entrada `metrics-test.mp4` de la biblioteca local.
- **Plan de conversión (decidido por la persona):** 1) `sw-register.js` ✔; 2) `admin.html` ✔; 3) `index.html` ✔; 4) `library.html` ✔; 5) `room.html` ✔ en código (este, con pruebas pendientes); 6) quitar `'unsafe-inline'` de
  `scriptSrc`. **Los pendientes de PC y del dominio público están cerrados, así que el paso 6 queda habilitado**; lo único que falta de `room.html` es la prueba en móvil, que es de layout y no depende de la CSP (decisión de la persona si la hace antes o después).
- **Pendiente aparte (sin cambios):** la CSP bloquea `https://static.cloudflareinsights.com/beacon.min.js`; `admin.html` sigue sin confirmarse en el dominio real.

**CSP sin `'unsafe-inline'`, paso 4: `library.html` sin JS inline (2026-10-24)**: hecho. Un parche sobre `origin/plan-produccion`
(`library.html: el script grande pasa a public/js/library.js`, commit `1fd63a0`). **La CSP NO cambió**: `scriptSrc` sigue con `'unsafe-inline'` (`room.html` conserva su script grande).

- **Qué cambió:** el segundo `<script>` de `public/library.html` (inline, 25854 bytes, 573 líneas: desde `const cassetteIcon` hasta el `setInterval` del contador REC) pasó tal cual a
  `public/js/library.js` (archivo nuevo). `library.html` lo carga con `<script src="/js/library.js" defer></script>` en el mismo lugar (antes de `</body>`). Ya no tiene código inline: solo `sw-register.js` y
  `library.js`. Sin `nonce`, `integrity` ni `crossorigin`. (El prompt del paso decía que empezaba en `const params`; empieza en `const cassetteIcon`, y `const params` está en la línea 6 del script. No cambia nada.)
- **No cambió:** CSP, `server.js`, `sw-register.js`, otras páginas, ningún nombre de función ni variable. Claves de storage intactas (`mn_host_<sala>` en `localStorage`, `mn_library_pw` en `sessionStorage`) y rutas
  `fetch` relativas intactas (`/auth/*`, `/api/uploads/presign`, `/room/<sala>/change-video-from-upload`, `/create-room-from-upload`).
- **Verificado por el asistente:** comparación byte a byte del `<script>` viejo (de `git show 38474cf:public/library.html`, líneas 76 a 648) contra `library.js`: idéntico, también en un clon fresco tras `git am`;
  `node --check`; ningún bloque inline con código; no hay atributos `on*=`; `npm test` 111/111 y lint limpio.
- **Probado, resultado pasado por la persona (y Copilot en el PC de la persona):** en el dominio público, `/library.html` pide la contraseña de biblioteca y `library.js` carga con 200, sin error de CSP ni 404 (solo el
  beacon de Cloudflare conocido); en local, con sesión de admin, la lista de videos carga igual; contraseña incorrecta muestra el mensaje habitual y, tras varios intentos, «Demasiados intentos. Esperá 15 min.» (429);
  `?fromRoom=<sala>` muestra «ELEGIR CINTA PARA LA SALA», el enlace de volver y los botones `USAR`. **El cambio de cinta de punta a punta lo probó la persona en el dominio público con la sala `12a142`
  (host en el mismo navegador): funcionó y la sala mostró la cinta nueva.**
- **Nota de la prueba:** un primer intento con la sala `d6ff8b` no pudo completarse (la sala estaba cerrada y `metrics-test.mp4` figuraba en la lista pero el servidor respondía «Ese archivo no existe»);
  no es de esta extracción (el código es idéntico), sino una entrada de biblioteca sin archivo detrás tras reconstruir el contenedor.
- **No verificado:** la subida de un video nuevo desde la propia biblioteca y el borrado de videos (no se ejercitaron en esta prueba); el modal de contraseña más allá del rechazo y del 429.
- **Limpieza pendiente (no es del código):** la entrada `metrics-test.mp4` sin archivo en la biblioteca local y las salas de prueba (`d6ff8b`, `12a142`).
- **Plan de conversión (decidido por la persona):** 1) `sw-register.js` ✔; 2) `admin.html` ✔; 3) `index.html` ✔; 4) `library.html` ✔ (este); 5) `room.html`; 6) recién entonces quitar `'unsafe-inline'` de
  `scriptSrc`. Siguiente: `room.html`.
- **Pendiente aparte (sin cambios):** la CSP bloquea `https://static.cloudflareinsights.com/beacon.min.js`; `admin.html` sigue sin confirmarse en el dominio real.

**CSP sin `'unsafe-inline'`, paso 3: `index.html` sin JS inline (2026-10-24)**: hecho. Un parche sobre `origin/plan-produccion`
(`index.html: el script grande pasa a public/js/index.js`). **La CSP NO cambió**: `scriptSrc` sigue con `'unsafe-inline'` (`library.html` y `room.html` conservan su script grande).

- **Qué cambió:** el segundo `<script>` de `public/index.html` (inline, 22369 bytes, 501 líneas: desde `const btn = document.getElementById...` hasta el `setInterval` del contador REC) pasó tal cual a
  `public/js/index.js` (archivo nuevo). `index.html` lo carga con `<script src="/js/index.js" defer></script>` en el mismo lugar (antes de `</body>`). Ya no tiene código inline: solo `sw-register.js` e
  `index.js`. Sin `nonce`, `integrity` ni `crossorigin`. (El prompt del paso decía que empezaba en `const dropLabel`; empieza en `const btn`, no cambia nada.)
- **No cambió:** CSP, `server.js`, `sw-register.js`, otras páginas, ningún nombre de función ni variable. Rutas `fetch`/XHR intactas, todas relativas al mismo origen: `/api/uploads/presign`,
  `/create-room-from-upload`, `/create-room`, `/auth/me`, `/auth/login`, `/auth/register`, `/auth/logout`, `/auth/forgot-password` y `/api/room/<código>`. La subida directa a R2 hace `PUT` a la URL prefirmada
  que devuelve el servidor en el momento: no hay host fijo dentro del script.
- **Verificado por el asistente:** comparación byte a byte del `<script>` viejo (de `git show ac20290:public/index.html`) contra `index.js`: idéntico (22369 contra 22369 bytes); `node --check`; ningún bloque inline con
  código; no hay atributos `on*=`; los ids que usa el script existen en el HTML salvo `loginBtn`, `logoutBtn` y `registerBtn`, que crea el propio script al pintar la barra de cuenta; `npm test` 111/111 y
  lint limpio, antes y después.
- **Probado por Copilot en el PC de la persona (tras `git am` y `docker compose up -d --build`), resultado pasado por la persona; la persona no lo marcó explícitamente como confirmado.**
  En el dominio público (`sala.movienight-palomitasjuntos.uk`, que apunta al mismo contenedor), con recarga forzada y la consola escuchada (`page.on('console')` y `pageerror` antes de recargar): `index.js` cargó
  desde el propio dominio, sin error de CSP ni 404; el único error de consola fue el beacon de Cloudflare ya conocido; la portada permite elegir un archivo. Al pulsar «GRABAR SALA» sin sesión apareció el aviso esperado
  «Subida protegida — Subir una cinta nueva necesita la contraseña de la biblioteca»; se canceló sin introducir ninguna contraseña. En el contenedor local, con una sesión ya abierta: se eligió `metrics-test.mp4`,
  se vio «Subiendo cinta... 0%», se creó la sala `d6ff8b`, redirigió a ella y la sala abrió con el diálogo para poner el nombre.
- **No verificado:** (1) cuál fue el camino de subida real (directo a R2 o por el servidor): el registro no muestra la petición `presign`/`PUT`, solo que la sala se creó; el camino más sensible a una URL mal copiada
  sigue sin comprobarse con evidencia; (2) el arrastrar y soltar con el ratón (se usó `setInputFiles`, no un arrastre real) y la barra de progreso más allá del 0% inicial; (3) login, registro y recuperar contraseña
  desde la portada; (4) una subida nueva en el dominio con la contraseña de la biblioteca (no se introdujo); (5) que `admin.html` ya esté confirmada en el dominio real (el paso 2 sigue sin confirmarse allí; es
  independiente de este).
- **Limpieza pendiente (no es del código):** la sala de prueba `d6ff8b` y, probablemente, el video `metrics-test.mp4` que quedó en la biblioteca local.
- **Plan de conversión (decidido por la persona):** 1) `sw-register.js` ✔ (confirmado en el dominio real); 2) `admin.html` ✔ (probado por Copilot en local); 3) `index.html` ✔ (este); 4) `library.html`; 5) `room.html`;
  6) recién entonces quitar `'unsafe-inline'` de `scriptSrc`. Siguiente: `library.html`.
- **Pendiente aparte (sin cambios):** la CSP bloquea `https://static.cloudflareinsights.com/beacon.min.js` (ver la entrada anterior).

**CSP sin `'unsafe-inline'`, paso 2: `admin.html` sin JS inline (2026-10-24)**: hecho. Un parche sobre `origin/plan-produccion`
(`admin.html: el script grande pasa a public/js/admin.js`). **La CSP NO cambió**: `scriptSrc` sigue con `'unsafe-inline'` (`index.html`, `library.html` y `room.html` conservan su script grande).

- **Qué cambió:** el segundo `<script>` de `public/admin.html` (inline, 17934 bytes, 423 líneas: desde `function escapeHtml` hasta el `setInterval` del contador REC) pasó tal cual a
  `public/js/admin.js` (archivo nuevo). `admin.html` lo carga con `<script src="/js/admin.js" defer></script>` en el mismo lugar (al final del body). `admin.html` ya no tiene código inline:
  solo `sw-register.js` y `admin.js`. Sin `nonce`, `integrity` ni `crossorigin`.
- **Por qué `defer` es correcto:** el script hace `getElementById` al cargar, la página no tiene atributos `on*=` y nada depende de ejecutarse antes de terminar de parsear.
- **No cambió:** CSP, `server.js`, `sw-register.js`, otras páginas, ningún nombre de función ni variable; las rutas `fetch` (`/auth/*`, `/admin/settings`, `/admin/stats`, `/admin/rooms`,
  `/admin/security` y las acciones de `/admin/rooms/...`) son relativas al mismo origen y siguen igual.
- **Verificado por el asistente:** comparación byte a byte del `<script>` viejo (de `git show 6b1e6f1:public/admin.html`) contra `admin.js`: idéntico (17934 contra 17934 bytes); `node --check`; ningún
  bloque inline con código; los ids que usa el script existen en el HTML (`logoutBtn` lo crea el propio JS); `npm test` 111/111 y lint limpio, antes y después.
- **Probado por Copilot en el PC de la persona (`localhost:3000`, tras `git am` y `docker compose up -d --build`, recarga forzada, con la sesión de admin ya abierta), resultado pasado por la
  persona; la persona no lo marcó explícitamente como confirmado:** `admin.js` cargó con 200; el panel mantiene estadísticas, salas activas, «Bloqueados ahora» y acciones globales; el service
  worker sigue registrado con `/sw.js`. Esta vez la herramienta SÍ escuchó la consola (`page.on('console')` y `pageerror` antes de recargar): sin errores de CSP, 404 ni JavaScript, ni avisos nuevos.
  Acción de punta a punta: cerró la sala de prueba `f38d60` desde el panel (Cerrar → confirmar) y tras el refresco el panel mostró «No hay salas activas ahora mismo.» y «Nadie bloqueado ahora mismo.».
- **No verificado:** el dominio real (solo `localhost`; allí el error del beacon de Cloudflare no aparece, porque lo inyecta el proxy); el refresco automático de 15 s esperando sin tocar nada.
- **Plan de conversión (decidido por la persona):** 1) `sw-register.js` ✔ (confirmado en el dominio real); 2) `admin.html` ✔ (este); 3) `index.html`; 4) `library.html`; 5) `room.html`; 6) recién entonces
  quitar `'unsafe-inline'` de `scriptSrc`. Siguiente: `index.html`.
- **Pendiente aparte, sin relación con la conversión de CSP (no se toca en ningún parche de esta serie):** la CSP bloquea `https://static.cloudflareinsights.com/beacon.min.js`, el script de analíticas
  que Cloudflare inyecta solo en los sitios que pasan por su proxy. Sale como error de consola en las 4 páginas verificadas en el dominio real; no rompe nada. Dos caminos si algún día se quiere resolver:
  permitirlo agregando `https://static.cloudflareinsights.com` a `scriptSrc`/`connectSrc` en `server.js` (si interesan esas analíticas), o desactivar la inyección automática desde el panel de
  Cloudflare (si no interesan). Ya figuraba como observación en una entrada anterior; queda como pendiente sin resolver.

**CSP sin `'unsafe-inline'`, paso 1 (compartido): el registro del service worker sale de las 4 páginas (2026-10-24)**: hecho. Un parche sobre `origin/plan-produccion`
(`Registro del service worker: de 4 bloques inline a public/js/sw-register.js`). **La CSP NO cambió**: `scriptSrc` sigue con `'unsafe-inline'`.

- **Qué cambió:** `index.html`, `library.html`, `room.html` y `admin.html` tenían el MISMO bloque inline de registro del service worker (comprobado byte a byte antes de tocar: las
  4 copias idénticas, 123 bytes). Pasó tal cual a `public/js/sw-register.js` (archivo nuevo) y cada página lo carga con `<script src="/js/sw-register.js"></script>`, en la misma
  posición (el primer `<script>` de cada una; en `room.html`, justo después del de socket.io, que no se tocó). Sin `defer` ni `async`, para conservar el momento de ejecución.
- **No cambió:** CSP, `server.js`, `public/sw.js` (el service worker en sí), `express.static` (sirve `.js` con `Cache-Control: no-store`) ni el segundo `<script>` de cada página.
- **Qué inline queda:** un bloque grande por página (`index.html` ~línea 101, `library.html` ~75, `room.html` ~160, `admin.html` ~96); `reset-password.html` ya no tiene.
- **Verificado por el asistente:** comparación byte a byte del bloque viejo (de cada una de las 4 páginas, en `HEAD`) contra `sw-register.js`: igual en las 4; ninguna página conserva
  `serviceWorker.register` inline; `node --check`; `npm test` 111/111 y lint limpio, antes y después. Cada página cambia solo 6 líneas (ese bloque).
- **Probado por Copilot en el PC de la persona (`localhost:3000`, tras `git am` y `docker compose up -d --build`, recarga forzada), resultado pasado por la persona; la persona no lo marcó
  explícitamente como confirmado:** `sw-register.js` con 200 en `/`, `/library.html`, `/room/<id>` y `/admin.html`; `/sw.js` con 200; el service worker aparece registrado (scope
  `http://localhost:3000/`, script `/sw.js`); cada página carga y funciona a simple vista (la biblioteca muestra las cintas, la sala muestra el diálogo de nombre). El registro de la herramienta
  muestra el detalle de `/` y de la sala; `library.html` y `admin.html` figuran solo en su resumen.
- **Confirmado por la persona en el dominio real (`sala.movienight-palomitasjuntos.uk`), con un navegador real, en las 4 páginas (`/`, `/library.html`, `/room/<id>`, `/admin.html`):**
  `sw-register.js` cargó bien en las 4, el service worker quedó registrado en `/sw.js` con scope `/`, y las 4 páginas funcionaron normal (incluido el 401 esperado de la biblioteca al pedir
  contraseña). Esto reemplaza lo anterior de «solo localhost / sin verificar el dominio». La consola mostró un único error ajeno a este cambio: la CSP bloquea `beacon.min.js` de
  Cloudflare Insights (ver el pendiente aparte, abajo).
- **Plan de conversión (decidido por la persona):** 1) este paso; 2) `admin.html`; 3) `index.html`; 4) `library.html`; 5) `room.html`; 6) recién entonces quitar `'unsafe-inline'` de `scriptSrc`.
  Siguiente: `admin.html`.

**CSP sin `'unsafe-inline'`, paso 1: `reset-password.html` sin JS inline (2026-10-24)**: hecho. Un parche sobre `origin/plan-produccion`
(`reset-password.html: el script inline pasa a public/js/reset-password.js`). Es el primero de varios patches (uno por página); **la CSP NO cambió**:
`scriptSrc` sigue con `'unsafe-inline'` porque las demás páginas siguen con JS inline.

- **Qué cambió:** el único `<script>` inline de `public/reset-password.html` (1749 bytes) pasó tal cual a `public/js/reset-password.js` (archivo nuevo, carpeta nueva
  `public/js/`); el HTML carga `<script src="/js/reset-password.js" defer></script>`. `defer` porque el script usa `getElementById` al cargar. Sin `nonce`,
  `integrity` ni `crossorigin`. Extracción, no reescritura: comparada byte a byte contra el commit anterior, idéntica.
- **No cambió:** CSP, `server.js`, `express.static` (sirve `public/` con `Cache-Control: no-store` para `.js`), `sw.js` (network-first, cachea el `.js` solo), otras páginas.
  No hay atributos `on*=` en esa página.
- **Verificado por el asistente:** `npm test` 111/111 antes y después, lint limpio, `node --check` del `.js`, los 6 ids que usa el script existen en el HTML, y el HTML ya no
  tiene código inline.
- **Probado por Copilot en el PC de la persona, con cuenta de prueba (no la admin), resultado pasado por la persona; la persona no lo marcó explícitamente como
  confirmado:** tras `git am` y `docker compose up -d --build`: `/reset-password.html?token=algofalso` mostró el formulario; `/js/reset-password.js` respondió 200 y el navegador lo cargó
  (`performance.getEntriesByType('resource')`); se registró una cuenta temporal, se pidió el reseteo, el link salió en los logs, se abrió, se cambió la contraseña y el login con la
  nueva dio 200. La cuenta temporal se borró. Que el cambio real funcione prueba, de forma indirecta, que el script se cargó y se ejecutó bajo la CSP actual.
- **No verificado:** (1) la consola del navegador: el chequeo que hizo la herramienta no capturaba mensajes (devolvía una lista vacía fija), así que «sin errores en consola»
  no está comprobado; (2) el mensaje de error al enviar con un token inválido; (3) la pestaña Network en el dominio real, solo se probó en `localhost`.
- **Hallazgo para el plan (no se tocó):** el plan hablaba de un `<script>` inline por página, pero el código real tiene más: `admin.html` también tiene JS inline
  (2 bloques), `index.html` y `library.html` tienen 2 bloques inline cada una, y `room.html` tiene 2 bloques inline más `<script src="/socket.io/socket.io.js">`.
  Quitar `'unsafe-inline'` exige convertir también `admin.html` y esos segundos bloques. `privacy.html` y `terms.html` no tienen scripts. Además `styleSrc` sigue con
  `'unsafe-inline'` (hay `style="..."` en todas las páginas), que es un tema aparte.
- **Siguiente:** `index.html`, `library.html`, `room.html` y `admin.html`, uno por sesión; recién entonces se quita `'unsafe-inline'` de `scriptSrc` en `server.js`.

**`generalApiLimiter`: prefijo /64 explícito en IPv6 (2026-10-24)**: hecho. Un parche sobre `origin/plan-produccion`
(`generalApiLimiter: prefijo /64 explicito en IPv6 (antes /56 por el default de la libreria)`). Una línea de `server.js` más su comentario.

- **Qué cambió:** `keyGenerator` pasa de `ipKeyGenerator(clientIp(req))` a `ipKeyGenerator(clientIp(req), 64)`. Sin el segundo argumento, `express-rate-limit`
  v8.7.0 trunca a /56 (`ipv6Subnet = 56`, verificado en `node_modules/express-rate-limit/dist/index.cjs`), no a /64 como decía el comentario. El comentario ahora
  deja escrito el porqué. Decisión de la persona: igualar a los otros cuatro limitadores (que usan `lib/ipKey.js`), que sí van por /64.
- **No cambió:** `windowMs` (5 min), `max` (300), el `skip` de `/health`, `/healthz` y `/metrics`, el mensaje, `lib/ipKey.js`, los otros limitadores. IPv4 e IPv4-mapeadas
  dan el mismo resultado que antes (`::ffff:172.18.0.1` → `172.18.0.1`).
- **Efecto:** dos direcciones del mismo /56 pero de /64 distintos ahora cuentan por separado (antes compartían cupo). IPv4 no cambia.
- **Verificado por el asistente:** `npm test` 111/111 antes y después, lint limpio, `node --check`; un script en `/tmp` con `ipKeyGenerator(ip, 64)`: dos IPv6 del mismo
  /64 dan la misma clave (`2800:bf0:8163:1234::/64`), una de otro /64 (`...:1235:...`) da otra; con el valor por defecto las dos últimas compartían `...1200::/56`.
- **Probado por Copilot en el PC de la persona, resultado pasado por la persona; la persona no lo marcó explícitamente como confirmado:** con el cambio en el
  repo local (`git am` no tuvo nada que aplicar porque ya estaba presente), `docker compose up -d --build` arrancó sin errores de `express-rate-limit` ni `ERR_ERL`
  (log «MovieNight corriendo en http://localhost:3000»); `/health` y `/` respondieron 200 y `library.html` cargó con las cintas. Esto cubre que el servidor arranca
  y que el uso normal no se rompe.
- **No probado:** el límite de 300 pedidos en 5 minutos de punta a punta (haría falta superarlo desde dos direcciones del mismo bloque). No era parte del paso.
- **Con esto queda cerrada la observación del comentario de `generalApiLimiter`.** Siguen abiertos: `maskEmail` con 2 letras antes de la `@` las muestra enteras, no hay botón de
  desbloquear, y (de pasos anteriores) configurar `RESEND_API_KEY` antes de producción.

**Recuperar contraseña: clave del límite por /64 en IPv6 (2026-10-24)**: hecho. Un parche sobre `origin/plan-produccion`
(`forgot-password: clave del limite por /64 en IPv6`). Una sola línea de `server.js`. Para verlo en el servidor hace falta `git pull` y
`docker compose up -d --build`.

- **Qué cambió:** en `POST /auth/forgot-password`, `limiterKey` pasa de `` `${clientIp(req)}:${email}` `` a `` `${rateLimitKeyFromIp(clientIp(req))}:${email}` ``,
  igual que login. Ahora `rateLimitKeyFromIp` (de `lib/ipKey.js`, importada una sola vez) se usa en los **cuatro** sitios: biblioteca/subida, login,
  sala con contraseña y recuperar contraseña. Con IPv6, cambiar de dirección dentro del mismo /64 ya no esquiva los 3 pedidos por hora.
- **No cambió:** `isResetRequestRateLimited` (sigue contando cualquier pedido, no solo fallos), `resetRequestTimestamps`, `MAX_RESET_REQUESTS` (3),
  `RESET_REQUEST_WINDOW_MS` (1 h), el mensaje genérico ni la no-enumeración de emails. IPv4 e IPv4-mapeadas tampoco.
- **Revisión de otros sitios que usan la IP:** ninguno de los limitadores de intentos quedó sin pasar por `rateLimitKeyFromIp`. Quedan fuera a propósito:
  `generalApiLimiter` (usa `ipKeyGenerator` con el /56 por defecto de la librería; su comentario en `server.js` dice /64), `avatarChangeLimiter` (clave:
  `userId`) y los dos `clientIp(req)` de `db.insertAdminAction` (registro de auditoría).
- **Verificado por el asistente:** `npm test` 111/111 antes y después, lint limpio, `node --check`. Sin tests nuevos (no hay tests de `forgot-password`; el
  caso general está en `test/ipKey.test.js`). Un script en `/tmp` extrajo `isResetRequestRateLimited` de `server.js` y lo llamó con claves reales: 3 pedidos
  desde la dirección A pasan, el cuarto desde la dirección B del mismo /64 queda limitado; otro /64 y otro email pasan; por IPv4 limita al cuarto.
- **Probado por Copilot en el PC de la persona, contra el dominio real (`curl -6 --interface`), resultado pasado por la persona; la persona no lo marcó
  explícitamente como confirmado:** 3 pedidos desde A con el mismo email (200, mensaje genérico) y un cuarto desde B (mismo /64, 200 con el mismo mensaje
  genérico). Los logs mostraron exactamente 3 líneas «Link de reseteo» para ese email: el cuarto pedido NO generó un cuarto link. (Con `RESEND_API_KEY` sin
  configurar el link se escribe en el log, y de ahí se deduce el efecto del límite, que por diseño no se ve en la respuesta.)
- **No probado / pendiente:** (1) el escenario «otro email desde la misma dirección»: Copilot usó un email que no tiene cuenta, así que aunque el límite no lo
  hubiera afectado tampoco habría salido un link en el log; con esa prueba no se puede distinguir. Lo cubren el script de `/tmp` (clave con el email) y el
  código; (2) tests automáticos del endpoint (requiere Postgres).
- **Observación:** con `RESEND_API_KEY` sin configurar, los links de reseteo (con token válido) quedan escritos en los logs del contenedor; el log de arranque ya
  avisa que eso «solo sirve para desarrollo local». Antes de producción hay que configurarla.
- **Efecto de la prueba:** tras 3 pedidos con un email, ese email queda limitado 1 hora para ese /64 (se vacía al reiniciar la app).
- **Con esto quedan los cuatro limitadores de contraseña/recuperación con clave por /64.** Sigue abierto: el comentario de `generalApiLimiter` (dice /64, es /56),
  `maskEmail` con 2 letras, y no hay botón de desbloquear.

**Limitadores de intentos: clave por /64 en IPv6 (2026-10-24)**: hecho. Un parche sobre `origin/plan-produccion`
(`Limitadores de intentos: clave por /64 en IPv6 (login, biblioteca, sala)`). Para verlo en el servidor hace falta `git pull` y
`docker compose up -d --build`.

- **`lib/ipKey.js` (archivo nuevo):** `rateLimitKeyFromIp(ip)`. Una IPv6 se convierte en su prefijo /64 (`2800:bf0:8163:1234::/64`); IPv4, `'unknown'`,
  vacío, lo que no es string y las IPv4-mapeadas (`::ffff:a.b.c.d`, en forma decimal y hexadecimal) quedan tal cual. Usa `ipKeyGenerator(ip, 64)` de
  `express-rate-limit` (v8.7.0, ya era dependencia), no un parser propio. Vive en `lib/` y no en `server.js` porque `server.js` no se puede importar en los tests.
- **`server.js`:** la parte de IP de la clave pasa por `rateLimitKeyFromIp` en los cuatro sitios de los tres limitadores: `requireLibraryAuth` y
  `requireUploadAuth` (comparten `uploadAuthLimiter`), login (`ip:email`) y `join-room` (`ip:roomId`). La IP completa sigue en los logs
  (`logger.warn({ ip }, ...)`) y en el resto del código. `lib/rateLimiter.js`, las duraciones (3 intentos / 15 min) y `admin.html` no cambiaron.
- **Efecto visible:** en `/admin/security` y en el panel, las IPv6 salen como prefijo `...::/64` (`splitLastColon` sigue separando bien el email o el roomId).
  Varias personas con el mismo /64 comparten bloqueo, igual que ya pasa con una IPv4 compartida por NAT.
- **Tests:** `test/ipKey.test.js`, 9 tests (IPv4, mapeada, IPv6 real, `::` al inicio/medio/final, zona, mismo /64 = misma clave, y dos direcciones del mismo
  /64 comparten el contador del limitador). `npm test` 102 → 111, lint limpio.
- **Verificado por el asistente:** tests y lint; salida real de la función con las IPs de la persona y con casos raros; grep de que ninguna llamada a
  `uploadAuthLimiter`/`loginAuthLimiter`/`roomJoinAuthLimiter` usa ya la IP suelta; en local por IPv4 la biblioteca dio 401/401/401/429 como antes
  (el entorno del asistente no tiene IPv6).
- **Probado por Copilot en el PC de la persona, contra el dominio real (`curl -6`), resultado pasado por la persona; la persona no lo marcó
  explícitamente como confirmado:** (1) biblioteca desde una IPv6: 401, 401, 401 y cuarto intento 429; el panel mostró UNA fila `2800:bf0:8163:1234::/64`,
  «vence en 15 min». (2) Prueba de rotación, tras `docker compose restart app` (el bloqueo vive en memoria): 3 fallos desde la dirección A
  (`...:5f3b:165d:791a:e2fe`) dieron 401, 401, 401; un único intento desde la dirección B (`...:a5ef:b591:3c8f:f41`, del mismo /64 y sin fallos previos)
  dio **429**, y el log solo tiene las 3 líneas de A. Eso es lo que antes habría dado 401 (inferido del código anterior, no medido).
  También: con sesión de admin la biblioteca respondió 200, el login correcto y entrar a una sala con contraseña correcta funcionaron.
- **No probado / pendiente:** login y sala con contraseña bloqueados por rotación de dirección en el dominio real (solo se probó la biblioteca; el
  mecanismo es el mismo y los tests unitarios lo cubren); uso normal de la biblioteca SIN sesión y con la contraseña correcta tras el cambio.
- **Observaciones para la sesión guía (no se tocaron):** (1) `generalApiLimiter` ya usa `ipKeyGenerator(clientIp(req))` con el valor por defecto de la
  librería, que es /56 (`2800:bf0:8163:1234:...` da `2800:bf0:8163:1200::/56`), pero el comentario de `server.js` ~383 dice /64: comentario incorrecto, no un
  fallo; (2) `isResetRequestRateLimited` (recuperar contraseña, `server.js` ~835) sigue con la IPv6 completa como clave; (3) `maskEmail` con 2 letras
  antes de la `@` las muestra enteras; (4) no hay botón de desbloquear.

**Admin: `public/admin.html` muestra las IPs bloqueadas ahora (2026-10-24)**: hecho. Un parche sobre `origin/plan-produccion`
(`admin.html: mostrar las IPs bloqueadas ahora (GET /admin/security)`). Solo toca `public/admin.html`. Para verlo en el servidor hace falta `git pull` y
`docker compose up -d --build`.

- **Qué se agregó:** bloque «🔒 Bloqueados ahora (intentos fallidos)» entre «Salas activas» y «Acciones globales», con las mismas clases que el resto de
  la página (`admin-section-title`, `tape-list`, `tape-item`, `library-empty`/`library-loading`). `loadSecurity()` junta `login`, `library` y `roomJoin`
  con etiqueta de origen (Login / Biblioteca / Sala); `renderSecurity()` muestra origen, IP, `emailMasked` (login) o `roomId` (sala) y «vence en N min»
  (`Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000))`, con el reloj del navegador).
- **Dónde se carga:** dentro de `refreshDashboard()` (`Promise.all([loadStats(), loadRooms(), loadSecurity()])`), así entra en la carga inicial y en el
  refresco de 15 s. Si el fetch falla o responde con error, solo ese bloque muestra «No se pudo cargar la lista de bloqueados.».
- **Seguridad del HTML:** todo dato de `/admin/security` pasa por `escapeHtml` antes de `innerHTML`; no se muestra el email completo en ningún lado.
- **CSS:** no se agregó ninguno; solo un `style="overflow-wrap:anywhere;"` inline en la línea de la IP para que una IPv6 larga no ensanche la página
  (`.tape-item-name` corta con puntos suspensivos y no sirve para eso).
- **No se hizo:** botón de «desbloquear» (el servidor no tiene esa acción). Pendiente solo si se decide agregarla en `server.js` en un paso aparte.
- **Verificado por el asistente:** `npm test` 102/102, `npm run lint` limpio, `node --check` del JS inline, grep de ids/`escapeHtml`/sin `console.log`, y
  `loadSecurity`/`renderSecurity` contra un DOM simulado (tres filas de ejemplo, un `roomId` con HTML sale escapado, lista vacía y respuesta 404).
- **Probado por Copilot en local (`localhost:3000`, Docker), según su resumen:** bloque vacío al inicio; tras 3 fallos de biblioteca, login y sala aparecen
  las tres filas (`Login — ad***@example.com`, `Sala — <roomId>`, Biblioteca con IP y «vence en 15 min»); el refresco de 15 s las muestra; a los 15 min
  desaparecen solas en el siguiente refresco (esto cubre el vencimiento real de `login` y `roomJoin`, que estaba pendiente); sin desborde horizontal a
  360 px en esquema claro y oscuro (medido con `scrollWidth`, con una IP corta `::ffff:172.18.0.1`).
- **Confirmado por la persona (2026-10-24):** dio por positivas las comprobaciones que se le pidieron: el panel con sesión de admin en su servidor, la
  IPv6 larga en pantalla angosta sin ensanchar la página, y la legibilidad en su modo claro/oscuro. No se anotó dispositivo ni navegador concretos.
- **Pendiente:** el límite sigue siendo por IPv6 completa (el mismo equipo mostró dos direcciones del mismo /64 el mismo día; se puede esquivar con otra
  dirección del bloque; lectura del código, no se probó la evasión); `maskEmail` con 2 letras antes de la `@` las muestra enteras; no hay desbloqueo manual.
- **Higiene (no es del código):** las pruebas con Copilot volvieron a dejar la contraseña de la cuenta admin en comandos y archivos temporales (borrados,
  pero queda historial): cambiarla y usar una cuenta admin de prueba. Sala de prueba `f38d60` creada por esa herramienta: cerrarla desde el panel.

**Admin: `/admin/security` separa la IP y enmascara el email de login (2026-10-24)**: hecho. Un parche sobre `origin/plan-produccion`
(`Admin: /admin/security separa la IP y enmascara el email de login`). Para verlo en el servidor hace falta `git pull` y `docker compose up -d --build`.

- **`lib/rateLimiter.js`:** dos funciones puras exportadas. `splitLastColon(key)` corta en el ÚLTIMO `:` y devuelve `{ ip, rest }` (`rest` es `null` si
  no hay `:`). `maskEmail(email)` devuelve las 2 primeras letras + `***@` + dominio (`is***@gmail.com`); con menos de 2 letras `***@dominio`; sin `@`, `***`.
  `listLocked()`, el `Map` y las claves internas (`ip`, `ip:email`, `ip:roomId`) NO cambiaron.
- **Por qué el último `:` y no el primero (el paso decía el primero):** una IPv6 lleva `:` por dentro; cortar en el primero daba `ip: "2800"` y dejaba
  media IP en `rest`. Ni un email ni un `roomId` llevan `:`. La clave de `library` es la IP sola y no se corta.
- **`server.js`, `GET /admin/security`:** `library` = `{ ip, lockedUntil, attemptCount }`; `login` = `{ ip, emailMasked, lockedUntil, attemptCount }` (ya no
  sale el email completo); `roomJoin` = `{ ip, roomId, lockedUntil, attemptCount }` (el `roomId` no se enmascara a propósito).
- **Tests:** 4 nuevos en `test/rateLimiter.test.js` (IPv4, IPv6 real, IPv4 mapeada, sin `:`, email de 1 letra, sin `@`). `npm test` 98 → 102, lint limpio.
- **No se tocó:** `public/admin.html`, duraciones de bloqueo, Postgres, dependencias, ni las claves de los limitadores.
- **Verificado por el asistente:** tests y lint (arriba); en local sin Postgres, la biblioteca dio 401, 401, 401, 429 como antes y `/admin/security` 404.
- **Probado por Copilot en local (`localhost:3000`, Docker/Postgres/Redis), no por la persona:** los tres limitadores con la forma nueva. `login`:
  `emailMasked: "pr***@example.com"` sin el email completo en ningún campo; `roomJoin`: `ip` y `roomId` completos; `library`: solo `ip`, sin `key` ni
  `rest`. IP vista: `::ffff:172.18.0.1` (la del puente de Docker, una IPv4 mapeada con `:` por dentro).
- **Confirmado con el dominio real (2026-10-24):** 3 pedidos con `curl -6` a `https://<dominio>/api/uploads` con contraseña mala (hechos por Copilot, sin sesión)
  dieron 401, 401, 401 y 3 líneas de log con la IPv6 completa `2800:bf0:8163:1234:a5ef:b591:3c8f:f41`. La persona abrió `/admin/security` con su sesión
  de admin y `library` mostró esa misma `ip` completa (8 grupos), con `attemptCount: 3` y `lockedUntil` = último intento + 15 min.
- **No probado / pendiente:** (1) `emailMasked` y `roomId` en el dominio real (solo en local); (2) vencimiento a los 15 min de `login` y `roomJoin` con
  tiempo real; (3) `/admin/security` aún no se ve en `admin.html` (paso aparte); (4) `maskEmail` con exactamente 2 letras antes de la `@` las muestra
  enteras (así lo pedía el paso).
- **Observación para la sesión guía (no se tocó):** la clave del limitador es la IPv6 completa, y el mismo equipo mostró dos direcciones distintas en el
  mismo día (`...f487:b058:2780:4d53` y `...a5ef:b591:3c8f:f41`, mismo prefijo `2800:bf0:8163:1234`). Quien tenga ese bloque (normalmente /64) puede rotar de
  dirección y esquivar el límite. Es lectura del código más esas dos direcciones; no se probó la evasión.
- **Pendientes de higiene (no son del código):** las pruebas automáticas dejaron la contraseña de la cuenta admin en comandos y archivos temporales
  (ya borrados, queda historial): cambiarla. Quedaron salas de prueba creadas por esa herramienta (`9cd6ee`, `f38d60`): cerrarlas desde el panel.

**Admin: ver qué IPs están bloqueadas ahora y log de cada intento fallido (2026-10-23)**: hecho. Un parche sobre `origin/plan-produccion`
(`Admin: GET /admin/security (IPs bloqueadas ahora) y log de cada intento fallido`; al aplicarlo con `git am` el hash cambia). Para verlo en el
servidor hace falta `git pull` y `docker compose up -d --build`.

- **`lib/rateLimiter.js`:** nuevo `listLocked()`: devuelve `{ key, lockedUntil, attemptCount }` solo de las claves con bloqueo vigente. No
  modifica `attempts` ni borra entradas vencidas. `attemptCount` es siempre `maxAttempts`: `recordFailure` deja `entry.count` en 0 al bloquear.
- **`server.js`:** `GET /admin/security` (`requireAdmin`, sin `requireSameOrigin`) devuelve `{ login, library, roomJoin }`. Claves: `library` = IP,
  `login` = `ip:email`, `roomJoin` = `ip:roomId`. Vive en la memoria del proceso: reiniciar el contenedor lo vacía; no es un historial.
- **Logs:** `logger.warn({ ip }, ...)` justo antes de cada `recordFailure` de login (2 sitios), biblioteca (`requireLibraryAuth`), subida/cambio de
  video (`requireUploadAuth`) y `join-room`. No se loguea la contraseña ni el email ni la sala. No se registró `avatarChangeLimiter` (límite de
  frecuencia por usuario, no de contraseñas). Sin tabla ni migración en Postgres.
- **No se tocó:** `public/admin.html`, duración de los bloqueos, Postgres, dependencias.
- **Verificado por el asistente:** `npm test` 96/96 antes y 98/98 después (2 tests nuevos de `listLocked`), `npm run lint` limpio, `node --check`.
  En local sin Postgres/Redis: 4 pedidos con contraseña mala a `/api/uploads` dieron 401, 401, 401 y 429, con 3 líneas de log con la IP;
  `/admin/security` sin sesión y sin Postgres responde 404.
- **Confirmado por la persona (2026-10-23), Chrome, en su dominio:** tras 3 fallos de la biblioteca, `/admin/security` listó su IP real (IPv6, no
  la de Cloudflare ni la de Docker) en `library` con `attemptCount: 3`; los logs tenían las 3 líneas con esa IP; y dijo que a los 15 minutos el
  listado volvió a quedar normal. Con esto queda resuelto el punto «IP tras Cloudflare sin probar» que figuraba para la biblioteca.
- **Probado por Copilot (herramienta de la persona), en local `localhost:3000` con Docker/Postgres/Redis, no por la persona:** 3 fallos de login con
  un email de prueba y 3 fallos de contraseña en una sala protegida: `login` y `roomJoin` listaron su clave con `attemptCount: 3` y los logs
  mostraron 3 líneas de cada tipo (según el resumen de la herramienta). Para eso activó `SESSION_COOKIE_INSECURE=1` temporalmente y lo restauró.
- **No probado / pendiente:** (1) vencimiento a los 15 min de `login` y `roomJoin` con tiempo real (el test unitario usa reloj falso);
  (2) `login` y `roomJoin` en el dominio real; (3) `/admin/security` aún no se ve en `admin.html` (paso aparte).
- **Observaciones para la sesión guía (no se tocaron):** (1) `login` y `roomJoin` devuelven `ip:email` e `ip:roomId`, así que el admin ve emails;
  decidir si se separa la IP o se enmascara; (2) la clave del limitador es la dirección IPv6 completa: quien tenga un bloque (normalmente /64)
  puede cambiar de dirección y esquivar el límite (lectura del código, no probado); (3) abrir la biblioteca sin contraseña guardada gasta un
  intento y ahora además deja una línea en el log; (4) las pruebas con herramientas automáticas dejaron la contraseña de la cuenta admin en
  comandos y archivos temporales (ya borrados, pero queda historial): conviene cambiarla; (5) quedó una sala de prueba creada por esa
  herramienta (`9cd6ee`): cerrarla desde el panel.

**Biblioteca: la contraseña ya no queda en `localStorage`, ahora `sessionStorage` (2026-10-21)**: hecho y **confirmado por la persona**
(2026-10-21) en Chrome (normal e incógnito). Un parche sobre `origin/plan-produccion` (commit local `2587970`; al aplicarlo con `git am` el
hash cambia, en el repo de la persona quedó como `5b97cf9`). Para verlo en el servidor hace falta `git pull` y `docker compose up -d --build`.

- **Web (`public/index.html` y `public/library.html`):** `mn_library_pw` pasa de `localStorage` a `sessionStorage` (por pestaña; se comparte
  entre index y library dentro de la misma pestaña y se borra al cerrarla). Todo acceso va por `getLibraryPw`, `setLibraryPw` y
  `clearLibraryPw` (un juego por página, con try/catch: si el storage falla, no guarda y pide la contraseña cada vez). Migración: al cargar
  ambas páginas se ejecuta `localStorage.removeItem('mn_library_pw')`. `room.html` no usa esta clave.
- **Comportamiento nuevo:** ante un 401 se borra la contraseña guardada (antes nunca se borraba: solo se sobrescribía al acertar). Con 429 no
  se borra, porque el servidor no llegó a compararla.
- **No se tocó:** `mn_host_<sala>`, `mn_uid`, `mn_username_<sala>`, `server.js`, la CSP ni dependencias.
- **Verificado por el asistente:** `npm test` 96/96 y `npm run lint` limpio antes y después, `node --check` del JS inline, `grep` sin ninguna
  escritura de `mn_library_pw` a `localStorage`.
- **Probado con Playwright (herramienta de la persona, instancia local puerto 3100, commit `5b97cf9`):** migración desde localStorage, misma
  pestaña entre index y library, pestaña nueva pide de nuevo, segunda pestaña no comparte, contraseña mala sin guardar nada, clave vieja
  rechazada se borra al primer 401, y `sessionStorage` lanzando `SecurityError` (la web sigue funcionando y pide la contraseña cada vez).
- **Confirmado por la persona a mano, en Chrome incógnito sobre su dominio:** desbloquea, `mn_library_pw` aparece en Session Storage y no en
  Local Storage; crear sala con la biblioteca y volver no la pide otra vez; cerrar la ventana y abrir otra la pide de nuevo; contraseña mala
  no deja nada en Session Storage. Tras 3 intentos fallidos hechos a propósito apareció «Demasiados intentos. Esperá 15 min.». También
  confirmó, sin dar detalle, que la app Android y el vencimiento del bloqueo a los 15 min funcionaron bien.
- **Límite que sigue:** `sessionStorage` sigue siendo texto plano que un script inyectado en esa pestaña podría leer. Se reduce la exposición
  (no sobrevive al cierre de la pestaña ni se comparte entre pestañas), no se elimina.
- **No probado / pendiente:** Firefox y Safari (incluido su modo privado).
- **Observaciones para la sesión guía (fuera de este paso, no se tocaron):** (1) la CSP bloquea el script `beacon.min.js` de
  `static.cloudflareinsights.com` (Cloudflare Web Analytics, lo inyecta Cloudflare; error en la consola, no afecta a la biblioteca); para
  permitirlo hay que tocar `server.js`, o desactivarlo en el panel de Cloudflare; (2) abrir la biblioteca sin contraseña guardada envía un
  `GET /api/uploads` con la contraseña vacía y, según el código de `requireLibraryAuth` (no probado en vivo), cuenta como un intento fallido;
  (3) `mn_host_<sala>` sigue en `localStorage` en texto plano; (4) la contraseña real apareció en capturas y logs de las pruebas: conviene
  cambiar `LIBRARY_PASSWORD`.

**Biblioteca: bloqueo por IP tras intentos fallidos, y la web maneja el 429 (2026-10-21)**: hecho y **confirmado por la persona**
(2026-10-21): dijo «si hice la pruebas y si funcionaron» y antes «todo salio perfecto» (siguió los 5 puntos que se le pasaron; no dio detalle
por punto ni dijo qué navegador usó). Son dos parches sobre `origin/plan-produccion` (commits locales `f2684ea` y `cae7607`; al aplicarlos con
`git am` el hash cambia). Para verlos en el servidor de la persona hace falta `git pull` y `docker compose up -d --build`.

- **Servidor (`server.js`, `requireLibraryAuth`):** `GET` y `DELETE` de `/api/uploads` ahora usan `uploadAuthLimiter` (clave: solo IP), igual
  que `requireUploadAuth`. Sesión de cuenta: pasa sin limitador. IP bloqueada: 429 `{ error, lockedMinutes }` sin comparar la contraseña.
  Contraseña mala: 401 con `attemptsLeft`; la 3.ª mala responde 401 con `attemptsLeft: 0` y desde la 4.ª todo es 429. Contraseña buena:
  `recordSuccess`.
- **Decisión (no efecto colateral):** el limitador es el MISMO para biblioteca y subida (mismo secreto, `LIBRARY_PASSWORD`). Agotar los
  intentos en uno bloquea también el otro (crear sala, cambiar video, `/api/uploads/presign`), y un acierto en cualquiera limpia los fallos
  de ambos. `generalApiLimiter`, la duración del bloqueo (15 min) y `requireUploadAuth` no cambiaron.
- **Web (`public/library.html`):** `mnLibraryFetch` ya no guarda `mn_library_pw` en localStorage si la respuesta es 429 (antes guardaba una
  contraseña mala, y lo mismo pasaba con el 429 de `/create-room-from-upload`). `loadTapes` muestra el mensaje del servidor si la respuesta
  no es una lista (antes decía «Todavía no hay cintas»). No hay clave nueva en localStorage; una contraseña mala guardada antes se corrige
  sola con el siguiente 401.
- **Verificado por el asistente:** `npm test` 96/96, `npm run lint` limpio, `node --check` del JS inline de `library.html`, y contra un
  servidor local (Redis, sin Postgres ni R2) con `curl`: 3 malas → 401 (`attemptsLeft` 2, 1, 0), 4.ª y 5.ª → 429, la contraseña correcta
  sigue en 429 en `GET` y `DELETE` de `/api/uploads` y en `/api/uploads/presign`. No se agregaron tests: no existían de `requireLibraryAuth`.
- **Pendiente / no probado:** (1) que el bloqueo venza a los 15 min con tiempo real (solo lo cubre `test/rateLimiter.test.js`); (2)
  `clientIp` lee primero el header `cf-connecting-ip`: si el servidor se puede alcanzar sin pasar por Cloudflare, ese header es falsificable
  y el bloqueo se podría saltear (lectura del código, no probado; ya era así en `requireUploadAuth`), y si no hay proxy delante, todos
  comparten la IP del proxy; (3) el limitador está en memoria del proceso: reiniciar el contenedor limpia los bloqueos; (4) no hay tests de
  `requireLibraryAuth`.

---

**Sala sin host cuando el dueño se va (observado, decidido dejarlo así por ahora; 2026-10-20).** Regla de este servidor, leída en `lib/hostAuth.js` y en `server.js` (~2165-2175 y ~2347-2360; rama `plan-produccion`, commit `256c280`): si la sala tiene dueño (se creó con una sesión iniciada), solo la cuenta dueña puede ser host (`isRoomOwner`); quien entra y no es el dueño queda sin host aunque esté solo en la sala. El host solo pasa a otra persona por traspaso automático si se desconecta mientras quedan otras personas conectadas. Si el dueño es el último en irse, la sala queda sin host hasta que el dueño vuelva o hasta que venza por inactividad: nadie puede cambiar el video, moverlo ni moderar. Caso visto por la persona (en la app Android): sala 613c27 (cuentas «israel» e «Israel 2»); que el dueño fuera «israel» es una deducción de las capturas, no se comprobó entrando con esa cuenta. La persona decidió dejarlo como está por ahora. Posible mejora sin hacer ni decidir (cambio de servidor): dar el host de forma temporal a la primera persona que entre a una sala sin host (el dueño lo recuperaría al volver, porque `setHost` degrada al anterior); falta decidir el riesgo de seguridad (cualquier invitado podría moderar si el dueño no está) y si lo recibirían solo las cuentas con sesión o también las anónimas.

---

**Avatares de cuenta: servidor listo, con 6 iconos reales (2026-10-18)**: hecho y subido a
`origin/plan-produccion` y **confirmado por la persona** (2026-10-18): dijo «si hice todas las pruebas» (las que se le pasaron: las de los avatares del servidor, la web de siempre y la app Android actual); no dio detalle por punto ni qué navegador, teléfono ni versión de Android usó (no se sabe en qué entorno las hizo: el servidor que usa su teléfono todavía no tenía el código, ver «Despliegue real»). Son 6 commits sobre `a9bca2a`: `7ac4edb`, `85a54be` y `fc1d27c` (infraestructura, con 10 marcadores SVG) y
`ffd2178`, `60b19be` y `62aadf8` (iconos reales y script para prepararlos). Sin dependencias nuevas: en `package.json` solo se agregó el script `check:avatars`.

- **Qué hay (contrato, todo aditivo; lo que usa hoy la web y la app Android no cambió):**
  - `GET /api/avatars` (público): `{ avatars: [{ id, name, url }] }` en el orden del manifiesto; `url` es relativa,
    `/avatars/<archivo>?v=<hash corto del contenido>` (se calcula al arrancar para romper cachés, también la de Cloudflare,
    si se reemplaza un archivo sin cambiar su nombre); `Cache-Control: public, max-age=60`.
  - `PUT /auth/avatar` con `{ avatarId: string | null }` (`null` quita el avatar): 401 sin sesión; 404 si la base de datos
    está desactivada; 403 con `Origin` ajeno y 200 sin `Origin` ni `Referer` (así lo llama OkHttp); 400 `{ error }` si el id no
    está en el manifiesto; 200 `{ ok: true, avatar: { id, name, url } | null }`; 429 al pasar de 20 pedidos cada 10 min por
    cuenta (cuenta todos los pedidos, también los inválidos).
  - `GET /auth/me` agrega `avatar: { id, name, url } | null`.
  - Sockets: `viewer-list` (cada elemento) y `chat-message` (también los del sistema) agregan `avatarId: string | null`.
    Lo pone el servidor desde la sesión; el que mande el cliente en el payload se ignora. Las personas sin cuenta llevan
    `null`. Los mensajes de `chatHistory` anteriores al cambio no lo traen (los clientes deben tratar `undefined` como
    `null`). Se guarda en el mensaje el avatar de cuando se escribió.
  - Cuándo se ve un cambio: al volver a entrar a una sala; un socket ya conectado conserva el anterior. El avatar se cachea en la
    sesión (`req.session.avatarId`); un dispositivo con otra sesión lo ve hasta volver a iniciar sesión, y una sesión anterior al
    cambio lo lee una vez de Postgres.
  - Datos: columna `users.avatar_id TEXT` (nula = sin avatar), con migración idempotente en `lib/db.js`. **No hay migración
    de los marcadores a los iconos reales** (`ffd2178` no la agregó): quien eligió un `avatar-NN` quedó sin avatar si se
    desplegó la parte 1 con personas reales.
  - Reglas del manifiesto: id `^[a-z0-9-]{2,32}$` y único, máximo 40 avatares, PNG, WebP o SVG de hasta 200 KB (PNG y WebP entre
    128 y 1024 px, cuadrados). Los ids no se renombran: renombrar uno deja sin avatar a quien lo eligió. Un manifiesto inválido
    no tumba el servidor: `/api/avatars` devuelve `{ "avatars": [] }` y se registra el error.
- **Iconos actuales (orden del manifiesto):** `koala-ninja`, `caballero`, `viajero`, `pajaro-rojo`, `trex` y `pinguino`; PNG de
  256x256 de 62 a 110 KB. Cajas de recorte usadas sobre los JPG originales (que no están en el repo): koala-ninja `45,15,1015,985`;
  caballero (busto) `255,30,775,550`; viajero `55,110,975,1030`; pajaro-rojo `45,0,1035,990`; trex `3,55,975,1027`; la de pinguino no
  se anotó. Para agregar uno: `python scripts/prepare-avatar.py RUTA ID --box izq,arriba,der,abajo --add --name "Nombre"` y
  `npm run check:avatars` (ver `public/avatars/README.md`). **Para la app Android conviene PNG o WebP**: la app no tiene ninguna
  librería para SVG (solo `BitmapFactory`).
- **Verificado por el asistente (2026-10-18, sobre `62aadf8`):** `npm ci` y `npm test` 96/96 (76 anteriores y 20 de
  `test/avatars.test.js`), `npm run lint` limpio y `npm run check:avatars` con 6 iconos, 0 errores y 0 avisos. Se leyó el diff de
  `server.js` y `lib/db.js`; el parseo de la app Android usa `opt*` y ignora los campos nuevos; el `Dockerfile` copia todo el repo
  y `.dockerignore` solo excluye `public/uploads/*`, así que `public/avatars/` va en la imagen.
- **Informe de Copilot (resumen que pegó la persona; no se vieron las salidas crudas):** en Windows con Docker, Postgres y Redis
  desechables, contra el commit `fc1d27c` (con los 10 marcadores, no con los iconos reales) y con **Node 24, mientras el
  `Dockerfile` fija Node 22**: tests 96/96 y lint limpio; las rutas y los códigos de `PUT /auth/avatar` (200, 400, 401, 403, 429),
  `/auth/me` con avatar que sobrevive a cerrar sesión y volver a entrar; sockets con `avatarId` correcto, `null` para la anónima,
  uno falso ignorado y mensajes del sistema con `null`; una sesión sin `avatarId` en Redis lo recupera de Postgres; cuatro iconos
  malos (SVG con `<script>`, SVG con `onload=`, PNG de 256x128 y archivo de 205 KB) fallan la revisión con código 1; manifiesto roto:
  el servidor arranca con lista vacía y un error en el log; sin `DATABASE_URL`, `/api/avatars` da 200 y el `PUT` da 404.
  El asistente tampoco corrió `scripts/prepare-avatar.py`.
- **Despliegue real de la persona (2026-10-19):** su servidor corre con **Docker Compose** en su PC (imagen `movienight-app` y contenedores
  `movienight-app-1`, `movienight-postgres-1` y `movienight-redis-1`), no con pm2. Al elegir un avatar, la app mostró «El servidor respondió algo
  inesperado…» y `GET /api/avatars` daba `Cannot GET /api/avatars` (Express sin esa ruta): ese servidor corría una imagen anterior a los
  avatares, aunque la rama `plan-produccion` ya los tenía en `origin` y en su carpeta local (`e0c0c6a`). Tras `docker compose up -d --build`
  la app cargó los avatares. Como el `Dockerfile` hace `COPY . .`, **cada cambio de código o de iconos exige reconstruir la imagen**: en la
  carpeta del servidor, `git pull` y `docker compose up -d --build`; un simple reinicio del contenedor no basta. `scripts/deploy.sh` (pm2) no
  aplica con Docker, y el job `deploy-vps` del CI solo corre con push a `main` y con el secret `DEPLOY_HOST`: **subir a `plan-produccion` no
  despliega nada solo**. No hizo falta migración a mano: `avatar_id` se crea al arrancar (según `lib/db.js`; no se verificó en su base). El servidor
  no expone su commit, así que para saber qué versión corre se prueban rutas que aparecieron en commits conocidos (por ejemplo `/terms.html`, de
  `a9bca2a`, y `/api/avatars`, de `7ac4edb`). `pm2 restart movienight` dio «not found» (no es pm2).
- **La app Android ya los usa (confirmado por la persona, 2026-10-19):** elegir avatar en Perfil y verlo en el chat y en la lista de conectados
  (repo `movienight-android`, `5e076af`, `cdf3640` y `28c73d0`; el detalle de sus pruebas está en el `docs/MEMORIA.md` de la app). La persona dijo
  «si funciona y si cargan» y mandó una captura de la sala: el asistente vio avatares con imagen y una inicial en círculo junto a los nombres del
  chat (no es una prueba formal; la inicial es lo esperado para una cuenta sin avatar elegido).
- **Pendiente:**
  - **Origen y licencia de los 6 iconos: NO INFORMADO** (`public/avatars/CREDITS.md`). Los nombres originales de los archivos
    («Gemini_Generated_Image…») sugieren que son imágenes generadas con IA, pero es solo una pista. `pajaro-rojo` se parece a un
    personaje de marca conocido: revisarlo antes de publicar.
  - `CREDITS.md` dice «Los 5 iconos» y hay 6; y el commit `62aadf8` se titula «agrega zorro» pero agrega `pinguino.png` y su
    entrada (no hay zorro).
  - `public/privacy.html` no menciona que se guarda el avatar elegido (`avatar_id`): revisarlo antes de publicar el borrador.
  - La web (`index.html`, `room.html`) no muestra avatares ni deja elegirlos: sin decidir.
  - Se propuso un `npm run avatar:prepare` con `sharp` (dependencia nueva); no se hizo: el script que existe es el de Python.

**Términos de uso / privacidad — BORRADOR, no publicado (2026-09-10)**: único
ítem pendiente de `docs/PLAN-PRODUCCION.md` (Fase 6). `public/terms.html` y
`public/privacy.html` ya están escritos, con el mismo estilo visual del resto
del sitio, pero **sin linkear todavía** desde ninguna página — el usuario
todavía no decidió si/cuándo pasa esto a producción. Enfoque de copyright:
"disclaimer fuerte" (quien sube declara tener derechos, notificación y baja
para reclamos), elegido porque el registro está abierto a cualquiera, no
limitado a un grupo cerrado. Quedan placeholders por completar antes de
publicar: email de contacto y ley aplicable/jurisdicción (todavía no
definidos). Detalle completo en `docs/CHANGELOG.md`.

**Panel de administración — ✅ COMPLETO, paso 9 cerrado (2026-09-10, rama
`plan-produccion`)**: feature nueva, no forma parte de `docs/PLAN-PRODUCCION.md`.
La verificación end-to-end se corrió contra `docker compose` real (app, Redis,
Postgres y R2) y con navegador automatizado: registro/promoción de admin,
permisos `401/403/200`, catálogo exacto de 8 settings, cambio en caliente de
`MAX_LIBRARY_VIDEOS` con subida real a R2 y `413`, restauración, validaciones
`400`, CSRF `403/200`, dashboard con salas/viewers/hosts reales, cierre de
inactivas sin tocar la sala activa, cierre puntual y `404`, sweep TTL, cierre
total con ambas confirmaciones `400` y la frase exacta `200`, auditoría SQL y
refresco automático del panel a los 15s. Las pestañas recibieron los mensajes
de cierre y se desconectaron. No hubo bugs de implementación que corregir.
La suite del checkout dio `76/76` y `npm run lint` limpio; dentro de la imagen
de producción, literalmente los comandos del checklist dieron `0` tests porque
`.dockerignore` excluye `test/`, y `npm run lint` falló porque la imagen instala
solo dependencias de producción y no incluye ESLint: queda anotado como
limitación del packaging, no como fallo funcional del panel.

**Paso 8 — `public/admin.html` ✅ (2026-09-09)**: la pantalla del panel, vanilla
JS sin framework, reusando `mnDialog`/`mnPrompt`/`mnConfirm` y `style.css` tal
cual (bloque nuevo al final de ese archivo, prefijo `.admin-*`). Chequea acceso
al cargar vía `GET /admin/settings` (no por el rol de `GET /auth/me`, que solo
pinta el email en la barra) y redirige a `/` sin mensaje si no da 200 — mismo
criterio de "no confirmarle a cualquiera que la pantalla existe" que ya usa el
resto de `/admin/*`. Dashboard (`GET /admin/stats` + `GET /admin/rooms`, con
refresco cada 15s) arriba de los settings; un input por cada uno de los 8
parámetros con etiqueta/descripción en criollo (`SETTINGS_META`, vive en el
frontend, el backend no la manda) y botón "Restaurar" (deshabilitado si la
fuente no es `db`); tres botones de acción global en una "zona de riesgo"
separada visualmente, el de "Cerrar TODAS" exige escribir `CERRAR TODO` en un
prompt antes de mandar el request. **Ruta nueva no prevista en el plan
original**: `DELETE /admin/settings/:key` (restaurar default por fila) — el
plan pedía el botón pero `resetSetting()` de `lib/settings.js` (paso 3) nunca
había quedado expuesto por HTTP; se agregó con el mismo par de middlewares y
el mismo criterio de auditoría (`setting_reset`) que ya usan las demás rutas de
escritura de `/admin/*`. Verificado en sandbox: sintaxis OK, 76/76 tests (sin
tests nuevos — la ruta nueva reusa `resetSetting()` ya testeado, y este
proyecto no testea las rutas de `server.js` directo), lint limpio, arranque
real sin Redis/Postgres (`GET /admin.html` en 200, `GET/DELETE /admin/settings*`
en 404 igual que el resto de `/admin/*`, resto de la app sin romperse). La
verificación con Postgres/Redis reales y navegador quedó cerrada en el paso 9;
el detalle completo está en `docs/CHANGELOG.md`.

Completado (pasos 1-7): migración (`role` en `users`, tablas `app_settings` y
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
admin/"cerrar todas" desde el paso 7), y **`lib/adminAuth.js`** +
las dos primeras rutas `/admin/*` (paso 6): `makeRequireAdmin(db, log)` (fábrica —
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

**Paso 7 — rutas de dashboard/acciones sobre salas ✅ (2026-09-08)**: cinco
rutas nuevas, todas detrás de `requireAdmin` (las que escriben, además
`requireSameOrigin` + fila en `admin_actions_audit`): `GET /admin/stats` (los
4 contadores del dashboard, reusando `lib/metrics.js` y la misma fuente que ya
usa `GET /metrics`), `GET /admin/rooms` (una fila por sala en memoria, con
owner resuelto a email, `videoRef` vía `videoDisplayName()` ya existente, y el
**host actual** por `room.hostSocketId`), `POST /admin/rooms/sweep-now`
(fuerza el barrido por TTL a demanda — `sweepExpiredRooms()` ahora devuelve
`{ closedCount, roomIds }` en vez de ser fire-and-forget, cambio mecánico sin
diferencia de comportamiento), `POST /admin/rooms/:id/close` (cierra una sala
puntual, 404 si no existe), `POST /admin/rooms/close-inactive` (cierra las que
tienen 0 viewers desde hace al menos `RECONNECT_GRACE_MS` — nuevo campo
`room.emptySince`, nunca persistido en Redis, mismo criterio que
`hostSocketId`/`userNames`; el selector `selectInactiveRoomIds()` es lógica
pura en `lib/roomLifecycle.js`) y `POST /admin/rooms/close-all` (el botón
nuclear, exige `{ confirm: "CERRAR TODO" }` validado también en el backend con
`isValidCloseAllConfirmation()`, 400 si no coincide). 9 tests nuevos en
`test/roomLifecycle.test.js`. Verificado en sandbox: sintaxis OK, 76/76 tests,
lint limpio, arranque real sin Redis/Postgres confirmando que las 5 rutas dan
404 (mismo criterio que el resto de `/admin/*`) y que el resto de la app sigue
funcionando. **No verificado todavía end-to-end con un admin real y salas de
verdad** (cerrar una sala puntual con gente adentro, que "cerrar inactivas" no
toque las que tienen viewers, que "cerrar todas" sí kickee a todos) — queda
para el paso 9, este sandbox no tiene Postgres ni clientes de Socket.io
reales. Detalle completo en `docs/CHANGELOG.md`.

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

**Paso 6 verificado end-to-end con Docker Compose real (2026-09-08)**: lo
que quedaba pendiente arriba (flujo completo con un admin real) se confirmó
con Redis+Postgres reales — los 4 códigos de `requireAdmin`, `POST
/admin/settings` cambiando `MAX_LIBRARY_VIDEOS` en caliente y reflejándose
en el siguiente `GET` sin reiniciar el proceso, 400 con valor fuera de
rango/key inexistente, `requireSameOrigin` rechazando un `Origin` cruzado y
dejando pasar sin headers, y auditoría registrando cada cambio válido (nada
en los inválidos). Detalle completo en `docs/CHANGELOG.md`.

**Decisión tomada durante esa verificación**: se evaluó y se descartó
tratar un error de conectividad a Postgres en pleno request (Postgres
caído con `DATABASE_URL` configurada) como 404 en `requireAdmin` — ese 404
queda reservado para `DATABASE_URL` ausente. `requireAdmin` sigue
devolviendo 500 ante cualquier error al consultar el rol, sin excepción por
tipo de error (motivo completo, con la comparación contra
`lib/db.js::ping()`, en `docs/CHANGELOG.md` y en el comentario del propio
`lib/adminAuth.js`).

**Composer de chat al cambiar el estado del reproductor — descartado, no es
un bug (2026-09-08)**: repetido con más instrumentación (`document.fullscreenElement`
y la clase `is-fullscreen` chequeados antes/después de cada paso, incluido
enviar un mensaje real): nunca se activó pantalla completa, composer
visible todo el tiempo en ambas pestañas. La observación original fue
probablemente una conexión stale de una prueba anterior, no un problema
real.

**Sync automático hacia el invitado — ✅ confirmado con navegador real
(2026-09-10)**: lo que había quedado pendiente el 2026-09-08 (el intento con
Playwright falló por una limitación del harness, no de la app — la segunda
pestaña quedaba en segundo plano y el navegador la throttleaba, así que el
click nunca llegaba a disparar el botón) se probó a mano con **dos ventanas
de navegador reales**, sesión host + invitado, sala real con un video pesado
servido desde R2 (`1280x720-23_000_vidas_reparado.mp4`, ~1h45min). Play,
pausa y seek disparados a mano desde el host se replicaron correctamente en
la ventana del invitado, sin desincronizarse. En el camino apareció
buffering intermitente (⏳ junto al nombre de ambas personas en el panel de
sala — el evento nativo `waiting` del `<video>`, ver
`public/room.html::setBuffering()`) al reproducir por primera vez ese
archivo real; se confirmó que es tráfico real bajando de R2 (la barra de
progreso en DevTools/Network seguía avanzando, no quedó en `pending`/`0
bytes`) y no un bug — con R2 configurado el `<video src>` apunta directo a
la URL pública de R2 (`lib/r2.js::getPublicUrl()`), el archivo nunca pasa
por el proceso Node, así que entrar por Cloudflare Tunnel en vez de
`localhost` no iba a cambiar nada de esto (se descartó esa hipótesis antes
de probar). Sin bugs de implementación que corregir — el `heartbeat` cada
4s sigue siendo la red de seguridad para cualquier evento de sync perdido.

**Paso 7 verificado end-to-end con Docker Compose real y clientes de navegador
(2026-09-09)**: Redis/Postgres reales, cuenta promovida a admin, las seis rutas
de dashboard/acciones probadas con curl y una sala creada desde el navegador.
Se confirmó que `close-inactive` no cierra salas con viewers, sí cierra una sala
vacía después de `RECONNECT_GRACE_MS`, `close-all` valida la confirmación y
expulsa sockets con el mensaje de mantenimiento, y el cierre puntual elimina la
sala. La auditoría registró las acciones válidas con sus detalles y no registró
el 400 de confirmación faltante. Detalle completo en `docs/CHANGELOG.md`.

**Todavía no existe `public/admin.html` — el panel sigue sin ser usable desde
el navegador, aunque ya tiene todas las rutas que necesita (paso 7,
completo y verificado end-to-end).** Sigue: paso 8 (`public/admin.html`:
settings + dashboard + los 3 botones de acción global), y después el paso 9
de prueba end-to-end completa del panel.

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
