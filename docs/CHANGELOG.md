# 📝 Changelog (activo) — MovieNight

## 2026-09-08 — Panel de administración: EN CURSO (pasos 1-6 de 9, `docs/PLAN-PANEL-ADMIN.md`)

- **Motivo**: feature nueva (no es parte de `docs/PLAN-PRODUCCION.md`, que es sobre
  robustez/seguridad/infra) — un panel para administradores donde cambiar en caliente
  8 parámetros de comportamiento (TTLs, límites, umbrales) sin editar `.env` ni
  reiniciar el proceso, más algunas acciones operativas sobre las salas activas.
  Diseño completo, revisado y confirmado en `docs/PLAN-PANEL-ADMIN.md` (las 6
  preguntas abiertas de la sección 9 están resueltas). Se trabaja en la rama
  `plan-produccion`, siguiendo el orden de implementación de la sección 8 de ese
  documento.
- **Paso 1 — migración**: columna `role` en `users` (`'user'|'admin'`, default
  `'user'`), tabla `app_settings` (clave/valor con precedencia sobre `.env`) y tabla
  `admin_actions_audit` (historial de acciones, con `ip`/`user_agent` — se sumó esto
  sobre la propuesta original del plan, no estaba en el diseño inicial). Funciones de
  acceso nuevas en `lib/db.js`.
- **Paso 2 — `scripts/make-admin.js`**: promueve una cuenta ya existente a admin por
  email. No crea cuentas nuevas — a propósito, para que "convertirse en admin" nunca
  sea alcanzable desde el navegador.
- **Paso 3 — `lib/settings.js`**: catálogo de los 8 parámetros administrables con sus
  rangos, precedencia DB→env→default, cache en memoria. 10 tests (luego 11, ver el
  bugfix de abajo).
- **Paso 4 — refactor "constante → función"**: los 8 puntos que hasta ahora leían
  `process.env` una sola vez al arrancar (`lib/roomStore.js`, `server.js`,
  `lib/alerts.js`, `scripts/library-orphan-report.js`) ahora llaman a
  `settings.getSetting()` en cada uso — sin esto, el panel (cuando exista) cambiaría
  un valor que ningún código volvería a leer hasta el próximo reinicio.
- **Bug real encontrado y corregido durante el paso 4**: el catálogo de
  `lib/settings.js` tenía `default: null` para `ROOM_TTL_HOURS`, tomado literal de la
  propuesta original del plan ("null = nunca expira, ya es un valor válido hoy") —
  pero el comportamiento REAL del código, sin nada configurado, siempre fue 24hs
  (fallback hardcodeado en `lib/roomStore.js` antes de este refactor), nunca "para
  siempre". Con `default: null` tal cual proponía el plan, una instalación nueva
  habría pasado a tener salas que **nunca expiran** por default — un cambio de
  comportamiento real, no el refactor puramente mecánico que promete la sección 4.
  Corregido a `default: 24` (el de siempre), con `nullable: true` para que "nunca
  expira" siga siendo una elección explícita desde el panel (campo vacío), no lo que
  pasa sin querer si nadie toca nada. Test nuevo que lo fija
  (`test/settings.test.js`).
- **Verificado en sandbox (pasos 1-4)**: sintaxis OK en los 5 archivos tocados, 48/48
  tests (11 en `settings.test.js`), lint limpio, arranque real del server sin
  Redis/Postgres confirmando el log nuevo de `settings.init()`. Sin cambio de
  comportamiento observable con nada configurado desde el panel — ese llega recién en
  los pasos 6-7.
- **Paso 5 — extraer `closeRoom()` de `sweepExpiredRooms()`**: nuevo
  `lib/roomLifecycle.js::closeRoom(io, rooms, roomStore, roomId, reason)`, con el
  mismo bloque que antes vivía inline dentro del loop de `sweepExpiredRooms()` en
  `server.js` (avisar por el evento `room-error`, desconectar cada socket que
  seguía en la sala, borrarla de `rooms` en memoria y de `roomStore`/Redis).
  `io`/`rooms`/`roomStore` se reciben como parámetros — mismo criterio que ya usa
  `lib/hostAuth.js::setHost` con `io` — para poder testear la función aislada de
  Socket.io. `reason` es nuevo como parámetro explícito (antes estaba hardcodeado
  al mensaje de "expiró por TTL"): lo necesitan los botones del panel (paso 7) para
  que el mensaje en pantalla diga la causa real ("cerrada por un administrador",
  "cerrada por inactividad", etc.), no un genérico. `sweepExpiredRooms()` ahora
  llama a `closeRoom()` por cada sala expirada en vez de tener su propia copia de
  la lógica — cambio mecánico, sin diferencia de comportamiento observable (mismo
  criterio de la sección 4 del plan). 6 tests nuevos en `test/roomLifecycle.test.js`
  (mismo patrón de `io`/`rooms`/`roomStore` de mentira que ya usa
  `test/hostAuth.test.js`): el broadcast de `room-error` con el motivo recibido,
  que desconecta y saca de la sala a cada socket que seguía adentro, que no rompe
  si un socket del set ya se desconectó solo o si nadie estaba conectado, que
  borra la sala de `rooms` (sin tocar otras) y que la borra de `roomStore`.
- **Verificado en sandbox (paso 5)**: sintaxis OK en los 3 archivos tocados
  (`server.js`, `lib/roomLifecycle.js`, `test/roomLifecycle.test.js`), 54/54 tests
  (los 48 anteriores + los 6 nuevos de `roomLifecycle.test.js`), lint limpio,
  arranque real del server sin Redis/Postgres. Sin cambio de comportamiento
  observable: `sweepExpiredRooms()` sigue emitiendo el mismo mensaje de TTL de
  siempre, solo que ahora vía `closeRoom()`.
- **Paso 6 — rutas `/admin/settings` + `requireAdmin`**: nuevo `lib/adminAuth.js`
  con dos piezas, separadas de `server.js` desde el arranque (a diferencia de
  otras rutas del proyecto, extraídas recién en la Fase 5) para poder testearlas
  aisladas desde el primer momento:
  - `makeRequireAdmin(db, log)`: fábrica que arma el middleware `requireAdmin` con
    `db`/`log` inyectables (mismo criterio que `lib/settings.js::init(db)`). El rol
    se consulta a Postgres **en cada request** a `/admin/*` (no viaja en la cookie
    de sesión) — así, revocar el rol de alguien tiene efecto inmediato en el
    próximo request, sin esperar a que esa sesión expire. 404 sin `DATABASE_URL`
    (mismo criterio que `requireDbEnabled`, no confirmar que la feature existe a
    quien no tiene ni Postgres configurado), 401 sin sesión, 403 si la cuenta no es
    admin o ya no existe.
  - `isSameOrigin(req)`/`requireSameOrigin`: chequeo de `Origin`/`Referer` contra el
    host propio (sección 2.4 del plan) para el POST — barato, no requiere tokens
    CSRF nuevos. Deja pasar si no hay ninguno de los dos headers (no romper
    clientes legítimos que no los mandan; `sameSite=lax` en la cookie de sesión ya
    cubre el escenario típico).
  - `server.js`: `GET /admin/settings` (`requireAdmin`) devuelve
    `settings.listAll()` tal cual. `POST /admin/settings`
    (`requireSameOrigin` + `requireAdmin`) valida y guarda con
    `settings.setSetting()` — 400 con el mensaje que ya arma `lib/settings.js` si
    la validación falla — e inserta una fila en `admin_actions_audit`
    (`setting_changed`, `{ key, from, to }`) antes de responder 200. Si esa
    inserción de auditoría falla, el cambio (que ya se guardó bien) sigue
    devolviendo 200 — el fallo de auditoría se loguea aparte, no tira abajo un
    cambio que sí se aplicó.
  - 13 tests nuevos en `test/adminAuth.test.js`: los 4 códigos de respuesta de
    `requireAdmin` (404/401/403/200-next, más 500 si Postgres tira) con un
    `db`/`log` de mentira, y `isSameOrigin`/`requireSameOrigin` con Origin
    coincidente/no coincidente, sin ninguno de los dos headers, usando Referer
    como respaldo, y con un Origin de formato inválido.
- **Verificado en sandbox (paso 6)**: sintaxis OK en los 3 archivos tocados
  (`server.js`, `lib/adminAuth.js`, `test/adminAuth.test.js`), 67/67 tests (los 54
  anteriores + los 13 nuevos de `adminAuth.test.js`), lint limpio. Arranque real
  del server sin Redis/Postgres confirmando que `GET`/`POST /admin/settings` dan
  404 (mismo comportamiento que el resto de `/auth/*` sin `DATABASE_URL`) y que el
  resto de la app sigue funcionando (`GET /` sigue en 200). **No verificado
  todavía end-to-end con un admin real** (200 en ambas rutas, 400 fuera de rango,
  403 con sesión no-admin) — este sandbox no tiene Postgres disponible; queda
  pendiente de confirmar en un entorno con `docker compose up` (o Postgres real),
  mismo criterio que las fases anteriores que dependen de Postgres.
- **Pendiente** (ver `docs/PLAN-PANEL-ADMIN.md` sección 8 para el detalle de cada
  uno): paso 7 (rutas de dashboard/acciones sobre salas + auditoría — reusan
  `closeRoom()` para "cerrar una sala puntual", "cerrar inactivas" y "cerrar
  TODAS"), paso 8 (`public/admin.html`), paso 9 (prueba end-to-end completa).
  **Todavía no existe `public/admin.html` ni las rutas de dashboard/acciones sobre
  salas** — el panel no es usable todavía.
- **Bug real encontrado y corregido probando el paso 6 en Docker Compose real
  (2026-09-08)**: `sweepExpiredRooms()` (el barrido inicial de salas expiradas al
  arrancar) se disparaba dentro del bloque de Redis, **antes** de `await
  settings.init()` — que corre más abajo, después de Postgres/migraciones. Efecto
  colateral del refactor "constante → función" del paso 4: `roomStore.getRoomTtlSeconds()`
  pasó a depender de `settings.getSetting()`, que tira si se llama antes de
  `init()`. Con Redis real, cada arranque logueaba
  `"lib/settings.js: init() no se llamó todavía"` en el barrido inicial — atrapado
  por un `.catch()` (no bajaba el server), pero el barrido de verdad no corría. No
  se detectó en el sandbox porque las pruebas ahí corren con `DISABLE_REDIS=1`
  (ese bloque queda sin ejecutar en ese modo); recién se vio con
  `docker compose up` real. **Corregido**: el llamado a `sweepExpiredRooms()` (y
  su `setInterval`) se movió de dentro del bloque de Redis a después de
  `settings.init()`, con el mismo `roomStore.isEnabled()` de siempre como
  condición. Sin cambio de comportamiento observable más allá de arreglar el
  error espurio en el log. Verificado en sandbox: sintaxis OK, 67/67 tests, lint
  limpio (no se pudo re-probar con Redis real en este sandbox — queda pendiente de
  confirmar que el log ya no aparece la próxima vez que se levante con
  `docker compose up`).

## 2026-09-08 — Fase 5: `docker compose up` (Opción B) verificado en entorno real ✅ COMPLETA la Fase 5

- **Motivo**: único ítem que quedaba pendiente de toda la Fase 5 — la entrada anterior
  solo había verificado `docker build` directo (Opción A) en un entorno real; faltaba
  probar `docker-compose.yml` (Opción B: app + Redis + Postgres bundleados) de punta a
  punta.
- **Primero, una falsa alarma descartada**: antes de esta prueba se sospechó que
  `eslint`/`@eslint-community` seguían coloándose en la imagen (`ls node_modules | grep
  -i eslint` los seguía listando incluso después del fix de la entrada anterior).
  Investigado en sandbox y confirmado en el entorno real del usuario con
  `find node_modules -mindepth 1 -maxdepth 1 -type d -empty`: son directorios de
  "scope" (`@eslint`, `@eslint-community`, y de paso `@keyv`/`@cacheable`/`@humanfs`/
  `@humanwhocodes`) que **quedan vacíos** como residuo cosmético de `npm ci --omit=dev`
  al podar el paquete real que iba adentro — `node_modules/eslint` no existe
  (`ls: node_modules/eslint: No such file or directory`). El fix de la entrada anterior
  (orden de los `COPY`) sí funciona correctamente; no hacía falta ningún cambio
  adicional al `Dockerfile`.
- **`docker compose up -d --build` probado de punta a punta** (Windows, Docker Desktop):
  los tres contenedores (`app`, `redis`, `postgres`) levantan y quedan `healthy`,
  incluido el `HEALTHCHECK` del propio `Dockerfile` contra `GET /health` funcionando
  dentro del contenedor `app`. Registro de cuenta (escribe en el Postgres del
  contenedor), creación de sala (escribe en el Redis del contenedor), y
  `docker compose restart app` con la sesión y la sala sobreviviendo — confirma que el
  estado persiste en los volúmenes de Redis/Postgres aunque se recree el contenedor de
  la app.
- **Bug real encontrado, pero en la configuración del usuario, no en el proyecto**:
  el video se subía bien a R2 pero no reproducía en la sala. Causa: en el `.env` del
  usuario, `R2_PUBLIC_URL` no tenía salto de línea antes del comentario siguiente
  (`R2_PUBLIC_URL=https://pub-xxx.r2.dev# R2_PRESIGN_EXPIRES_SECONDS=...`), así que el
  comentario quedaba pegado al valor real de la variable. `lib/r2.js::getPublicUrl()`
  arma el `<video src>` directo como `` `${R2_PUBLIC_URL}/${key}` ``, así que la URL que
  llegaba al navegador quedaba rota. Confirmado revisando el código (no hacía falta
  cambiar nada ahí, `getPublicUrl()` ya hace exactamente lo que debería con un valor
  bien formado) — el fix fue solo corregir el `.env` del usuario (cada variable en su
  propia línea). De paso se encontró y corrigió, en el mismo `.env`, un
  `METRICS_TOKEN=METRICS_TOKEN=...` duplicado (el nombre de la variable colado dentro de
  su propio valor). Ninguno de los dos es un bug del código del proyecto, pero vale la
  pena dejarlo anotado como error común al editar `.env` a mano.
- Con esto, las **dos** opciones de deploy con Docker (A: `docker build` directo, B:
  `docker compose up`) quedan verificadas en un entorno real, cerrando el único ítem
  pendiente de la Fase 5.

## 2026-09-08 — Fase 5: fix real en el Dockerfile, encontrado en verificación en entorno real

- **Motivo**: verificando el `Dockerfile` de la entrada anterior contra un Docker real
  (Windows, Docker Desktop) apareció un bug real, no cosmético: la imagen final tenía las
  `devDependencies` adentro (`eslint`, `@eslint-community`, 163 paquetes en vez de los ~16
  directos de producción + transitivas) — el multi-stage build no estaba cumpliendo su
  propósito. Señales que lo delataron: `transferring build context` de 315MB en el primer
  build (el repo sin `node_modules` pesa unos pocos MB) y un `chown -R /app` de 114s
  (típico de recorrer `node_modules`, no solo el código del proyecto).
- **Causa raíz**: orden de los `COPY` en la etapa `runtime`. El `Dockerfile` original hacía
  `COPY --from=deps node_modules` **antes** de `COPY . .` — si el `node_modules` local del
  checkout (con `devDependencies`, porque ya se había corrido `npm ci` completo unos pasos
  antes para el lint/tests) llegaba a colarse en el contexto de build por el motivo que
  fuera, el `COPY . .` posterior lo pisaba encima del limpio. **Fix**: invertir el orden
  (`COPY . .` primero, `COPY --from=deps node_modules` después) — así el `node_modules` que
  termina en la imagen es siempre el de producción, sin devDependencies, sin importar qué
  traiga el contexto.
- **Segundo hallazgo, al reconstruir ya con el fix**: `transferring build context` bajó a
  7.67kB (confirma que el `.dockerignore` en sí SÍ estaba excluyendo `node_modules`
  correctamente — la causa era 100% el orden de los `COPY`, no el `.dockerignore`), pero el
  `chown -R /app` seguía tardando ~110s incluso con `node_modules` ya limpio — esperable:
  paquetes como `@aws-sdk/client-s3` traen miles de archivos chiquitos (una clase por
  comando de la API), y un `chown -R` recorriendo todo eso como paso aparte es lento,
  especialmente en Docker Desktop/Windows. **Fix**: `--chown=node:node` en cada `COPY` (lo
  resuelve el propio motor de copia, sin una pasada recursiva extra) en vez de un
  `RUN chown -R /app` separado; el `chown` a mano que queda es puntual, solo sobre
  `public/uploads/` recién creada (vacía, no hay nada que recorrer).
- **Verificado en entorno real** (Windows, Docker Desktop, mismo checkout donde se
  encontraron los dos problemas): con ambos fixes aplicados, `docker run --rm movienight sh
  -c "du -sh /app/node_modules; ls /app/node_modules | grep -i eslint; ls /app/node_modules
  | wc -l"` ya no debería listar `eslint`/`@eslint-community` ni dar ~163 paquetes — pendiente
  de la confirmación final después de este segundo fix (chown puntual), pero el fix de
  fondo (orden de los `COPY`) ya se confirmó resuelto en esta misma sesión. Con esto,
  las dos verificaciones reales pendientes de la entrada anterior (`docker build` y el
  contenido de la imagen) quedan cubiertas — mismo criterio de "verificación independiente
  en entorno real" que ya se usó para cerrar la Fase 2bis y la Fase 4.

## 2026-09-08 — Fase 5: documentar y automatizar el despliegue ✅ COMPLETA la Fase 5

- **Motivo**: último punto pendiente de la Fase 5 (y, con esto, de todo el plan de
  producción salvo términos de uso/privacidad en Fase 6). Hasta ahora el flujo era 100%
  manual — traer un patch con `git am`, `npm install` si hacía falta, reiniciar a mano — y
  el plan pedía un pipeline (push a `main` → deploy automático, o al menos un solo
  comando). El hosting sigue sin decidirse (Fase 0), así que se documentan y automatizan
  **tres** caminos en paralelo, sin imponer ninguno.
- **`Dockerfile` nuevo** (imagen de producción, `node:22-alpine`): multi-stage para no
  cargar `devDependencies` en la imagen final; sin dependencias nativas que compilar
  (`bcryptjs` es JS puro, no `bcrypt`; `pg` usa su driver JS por default sin `pg-native`)
  así que alcanza Alpine liviano. Corre como el usuario `node` sin privilegios (no root).
  `HEALTHCHECK` contra `GET /health` con el módulo `http` nativo (sin sumar `curl` a la
  imagen solo para esto). `public/uploads/` declarado como `VOLUME` para que, en modo
  disco local (sin R2), los videos sobrevivan a que se recree el contenedor.
- **`.dockerignore` nuevo**: excluye `.env`/`cloudflared-config.yml` (secretos reales,
  nunca deben terminar en una imagen), `public/uploads/*` (contenido de sala real, no
  código — y en Docker esa carpeta se monta como volumen, no se hornea en el build), y lo
  que no hace falta en runtime (`.git`, `docs/`, `test/`, `.md`).
- **`docker-compose.yml` nuevo**: para VPS con Docker (Opción B del README) — bundlea la
  app + Redis 7 + Postgres 16, con `healthcheck` propios y `depends_on: condition:
  service_healthy` para que la app no arranque antes de que Redis/Postgres respondan de
  verdad (no solo que el contenedor exista). Contraseña de Postgres con default
  `movienight/movienight` solo para que `docker compose up` funcione sin tocar nada — con
  un comentario explícito de cambiarla (`POSTGRES_PASSWORD` en `.env`) para un despliegue
  real. Pensado también para quien prefiera Redis/Postgres administrados aparte: alcanza
  con no usar los servicios `redis`/`postgres` de este archivo y apuntar `REDIS_URL`/
  `DATABASE_URL` del `.env` a los externos.
- **`scripts/deploy.sh` nuevo** (`npm run deploy`, script nuevo en `package.json`): para
  VPS sin Docker (Opción C, el camino de siempre del proyecto — Node + PM2). Junta en un
  comando lo que antes eran pasos sueltos a mano: falla temprano si falta `pm2`/`npm` o si
  no se corre parado en la raíz del checkout; frena si hay cambios sin commitear en el
  servidor (para no pisar algo tocado ahí por error); `git fetch` + `git reset --hard
  origin/<rama activa>` (no asume que la rama sea `main`); `npm ci` (completo, con
  `devDependencies`, para poder correr lint/tests a continuación); **corre lint y tests
  contra el código recién traído** — mismo criterio de "fallar rápido" que ya usa el
  proyecto para Redis/Postgres/R2 al arrancar, acá aplicado al propio despliegue: si algo
  no pasa, no se reinicia el proceso en vivo; recién si todo pasó, `pm2 reload
  ecosystem.config.js --update-env` (sin downtime si hay más de una instancia) con
  fallback a `pm2 restart` si `reload` no aplica.
- **`.github/workflows/ci.yml`**: nuevo job `deploy-vps`, `needs: test`, que corre
  `scripts/deploy.sh` por SSH en el servidor (`webfactory/ssh-agent` + `ssh` directo) — pero
  **solo** en push a `main` y **solo si** el secret `DEPLOY_HOST` está configurado en el
  repo (`if: ... && secrets.DEPLOY_HOST != ''`); sin ese secret, el job se salta solo y el
  resto de CI (el job `test` ya existente) sigue exactamente igual que antes. Requiere
  además `DEPLOY_USER`, `DEPLOY_SSH_KEY` (clave privada sin passphrase) y `DEPLOY_PATH`
  como secrets. Como el asistente de IA con el que se trabaja este repo no hace push
  directo (ver `docs/MEMORIA.md`, "Cómo se trabaja en este repo"), este job solo puede
  dispararse cuando la persona hace el push real a `main`.
- **README**: la sección "Proceso supervisado" se reemplaza por "Despliegue a
  producción", con las tres opciones documentadas paso a paso (A: Railway/Render/Fly.io
  vía `Dockerfile`, B: VPS con Docker vía `docker-compose.yml`, C: VPS sin Docker vía PM2 +
  `scripts/deploy.sh`, con el workflow de GitHub Actions opcional como sub-sección de C).
  También se actualiza "Estructura del proyecto" con los archivos nuevos.
- **Verificado en sandbox**: lint (`npm run lint`) y los 37 tests existentes
  (`npm test`) en verde contra el código real (sin cambios de comportamiento en
  `server.js`/`lib/*`, todo lo nuevo es infraestructura de deploy); `docker-compose.yml`
  validado como YAML válido; `scripts/deploy.sh` validado con `bash -n` (sintaxis, sin
  ejecutarlo de verdad — necesita un servidor real con PM2 y un checkout de git).
  **No verificado**: el sandbox no tiene acceso de red a Docker Hub (fuera de la lista de
  dominios permitidos), así que no se pudo correr `docker build` ni `docker compose up`
  contra un daemon de Docker real — queda pendiente esa verificación en un entorno real
  antes de confiar el Dockerfile/docker-compose a un despliegue de producción real (mismo
  criterio de "verificación independiente en entorno real" que ya se usó para cerrar la
  Fase 2bis y la Fase 4).

## 2026-09-07 — Fase 5: validar variables de entorno al arrancar

- **Motivo**: último punto pendiente de la Fase 5 — el plan pedía fallar rápido con un mensaje claro
  si falta algo obligatorio, en vez de que el problema aparezca "a mitad de una subida de video como
  puede pasar hoy con R2 mal configurado" (cita textual del plan). Ese caso concreto es real:
  `isR2Enabled()` (`lib/r2.js`) solo exige 4 de las 5 variables de R2 — si falta `R2_PUBLIC_URL`, el
  server arranca normal y la subida de un video de varios GB funciona entera, y recién al final,
  armando el link público para guardar la referencia, `getPublicUrl()` tira su error. Todo ese tiempo
  de subida quedaba desperdiciado por un problema que ya estaba ahí desde el arranque.
- **`lib/envValidation.js` nuevo**, con `collectIssues(env)` (pura, testeable, no toca
  `process.env` directo) y `validateOrExit(logger)` (la que se llama de verdad). Detecta:
  - **Configuración parcial de un grupo de variables relacionadas**: por ahora, R2 (las 5 variables,
    no solo las 4 que exige `isR2Enabled()` — acá el objetivo es otro, avisar de una configuración a
    medias, no decidir si R2 "está activo"). Si ninguna está seteada, no es un error (modo disco
    local); si están las 5, tampoco: el problema es el punto medio.
  - **Variables numéricas con un valor inválido**: las 12 variables que hoy se leen con
    `parseInt`/`parseFloat` en `server.js` y `lib/*.js` (`SESSION_MAX_AGE_MS`,
    `R2_PRESIGN_EXPIRES_SECONDS`, `MAX_LIBRARY_VIDEOS`, `MAX_LIBRARY_SIZE_GB`,
    `ROOM_SWEEP_INTERVAL_MS`, `MULTIPART_SWEEP_INTERVAL_MS`, `MULTIPART_ABANDON_DAYS`,
    `ALERT_CHECK_INTERVAL_MS`, `SHUTDOWN_GRACE_MS`, `ALERT_HEALTH_FAILURE_THRESHOLD`,
    `ALERT_COOLDOWN_MS`, `ROOM_TTL_HOURS`). El patrón que ya usaba el proyecto
    (`parseInt(x, 10) || default`) cae callado al default si `x` no parsea — nadie se entera de que
    su valor no se aplicó. Se usa un match de regex de punta a punta (no `Number.isFinite(parseInt(x))`
    solo) porque `parseInt`/`parseFloat` son parsers laxos que ignoran basura al final
    (`parseInt("24h", 10)` da `24` sin avisar que la "h" se descartó) — un caso que se encontró
    escribiendo el primer test de este módulo y que el chequeo original no detectaba.
  - **Flags booleanos con un valor raro** (`DISABLE_REDIS`, `SESSION_COOKIE_INSECURE`,
    `LOG_PRETTY`): estos se leen con `=== '1'`, así que `SESSION_COOKIE_INSECURE=true` por ejemplo
    queda sin efecto — esto solo genera un **warning** (no frena el arranque), porque no es
    necesariamente un error real.
- **`server.js`**: `require('./lib/envValidation').validateOrExit(...)` se agrega justo después de
  `loadDotEnv()`, ANTES de requerir `lib/r2.js` y el resto de los módulos que leen `process.env.*` en
  constantes de nivel de módulo — mismo motivo por el que `lib/r2.js` ya tenía que requerirse después
  de `loadDotEnv()` (Node cachea el módulo, así que una constante leída antes de tiempo queda fijada
  para siempre).
- **10 tests nuevos** (`test/envValidation.test.js`): entorno vacío sin problemas, R2 completo sin
  problemas, R2 con 4/5 y con solo 1/5 (el mensaje lista las que faltan en los dos casos), una
  variable numérica entera inválida con el valor original en el mensaje, `ROOM_TTL_HOURS="0"` NO es
  un error (0 es un valor real y válido, no ausencia de valor — mismo cuidado que ya tenía
  `MULTIPART_ABANDON_DAYS` desde antes, ver la entrada de esa fase), un decimal válido con punto no
  reporta nada, un flag booleano con valor raro da warning y no error, un flag en `"1"` no reporta
  nada, y que varios problemas a la vez se acumulan todos juntos (no solo el primero).
- **No agrega nada obligatorio**: sin ninguna variable configurada, el server sigue arrancando igual
  que siempre — este módulo solo detecta configuraciones a medias o con una forma inválida en
  variables que ya existían.
- **Probado manualmente end-to-end**: `DISABLE_REDIS=1 node server.js` arranca normal (mismo log de
  siempre); `R2_ACCOUNT_ID=x SHUTDOWN_GRACE_MS=abc node server.js` termina con código de salida `1`
  ANTES de abrir el puerto, listando los dos problemas juntos; `SESSION_COOKIE_INSECURE=true node
  server.js` arranca igual (con el warning logueado) en vez de frenar. Los 37 tests del proyecto
  (27 de antes + 10 nuevos) en verde, y `npm run lint` limpio sobre el archivo nuevo.

## 2026-09-07 — Fase 5: CI con lint (ESLint)

- **Motivo**: segundo punto de la Fase 5 ("Calidad de código y proceso") — el CI del punto anterior
  corría los tests pero no lint, porque no había una config de ESLint en el proyecto.
- **`eslint.config.js`** (flat config, formato que exige ESLint 10): cubre el código de servidor
  (`server.js`, `lib/**/*.js`, `scripts/**/*.js`, `test/**/*.js`, más el propio `eslint.config.js` y
  `ecosystem.config.js`), con `sourceType: 'commonjs'` y los globals de Node
  (paquete `globals`). A propósito **no cubre `public/`**: el JS de cliente vive inline dentro de los
  `.html`, sin build step ni bundler — meterlo bajo lint implicaría separarlo a archivos `.js` propios
  primero, un cambio de otro alcance. Reglas: `@eslint/js` `recommended` (los errores reales —
  variables no declaradas, `case` que cae mal, etc.) más `no-unused-vars` con excepción para nombres
  que empiezan con `_` (`argsIgnorePattern`/`varsIgnorePattern`/`caughtErrorsIgnorePattern`, mismo
  patrón que el proyecto ya usaba en callbacks). Nada de reglas de estilo (comillas, punto y coma):
  el proyecto no tenía una convención de estilo enforced hasta ahora, y sumarla acá hubiera sido un
  diff enorme ajeno al objetivo de este cambio.
- **Nuevas dependencias de desarrollo**: `eslint`, `@eslint/js`, `globals`.
- **`package.json`**: nuevo script `"lint": "eslint ."`.
- **`.github/workflows/ci.yml`**: nuevo step `npm run lint`, antes de `npm test`.
- **8 errores reales encontrados y corregidos** al correr el lint por primera vez sobre el código
  existente (ninguno era solo "ruido" del linter, los ocho eran casos genuinos):
  - `server.js` destructuraba `BCRYPT_ROUNDS`, `isBcryptHash`, `isLegacySha256Hash` y `legacySha256`
    de `lib/passwordAuth.js` sin usar ninguno de los cuatro — quedaron colgados ahí desde la
    extracción a `lib/` de la entrada anterior (Fase 5, tests). Se sacaron del destructure; el
    comportamiento no cambia (`hashPassword`/`verifyPassword`, que sí se usan, siguen igual).
  - Una clase de caracteres con un guion escapado innecesariamente (`\-` al final de
    `[^a-zA-Z0-9 _\-]`, donde no hace falta escapar) aparecía **dos veces** con el mismo patrón
    exacto: en `server.js` (nombre de archivo en disco) y en `lib/r2.js` (`makeObjectKey`, nombre de
    objeto en el bucket) — se corrigió en los dos lugares (`[^a-zA-Z0-9 _-]`), sin cambio de
    comportamiento (la clase de caracteres significa lo mismo con o sin el escape de más).
  - `lib/r2.js` (`getCspOrigins`) tenía un `catch (err)` que nunca usa `err` a propósito (ya
    documentado en el comentario: una `R2_PUBLIC_URL` mal formada no debería reventar el arranque
    del server) — se renombró a `catch (_err)`, mismo patrón `_` que ya usa el resto del proyecto.
  - `test/uploadReference.test.js` tenía un mock (`objectExists: async (key) => exists`) que ignora
    a propósito el argumento — se renombró a `_key`.
- **Probado**: `npm run lint` sin errores sobre el estado final del código; `npm test` sigue en
  verde (27/27) tras los cuatro cambios de código (los otros cuatro son solo config/docs).

## 2026-09-07 — Fase 5: tests unitarios (setHost, auth, modo dual disco/R2) + CI en GitHub Actions

- **Motivo**: primer punto de la Fase 5 ("Calidad de código y proceso") — el plan pedía tests para lo
  más crítico y menos obvio a simple vista (`setHost`, autenticación de sala/biblioteca, el modo dual
  disco/R2), más CI básico que corra esos tests en cada cambio.
- **Extracción sin cambio de comportamiento**: `server.js` (2394 líneas, todo en un solo archivo)
  no se puede testear directo — `startServer()` se ejecuta al cargar el módulo y se conecta a
  Redis/Postgres reales (con `process.exit(1)` si no responden). En vez de reescribir esa estructura,
  se extrajo la lógica puntual a testear a cuatro módulos nuevos bajo `lib/`, dejando en `server.js`
  wrappers que llaman a esos módulos con la MISMA firma de siempre (por clausura, sin tocar ningún
  call site existente):
  - `lib/passwordAuth.js`: hashing bcrypt + la migración transparente desde el esquema legacy sha256
    (Fase 2.1) — `isBcryptHash`, `isLegacySha256Hash`, `legacySha256`, `hashPassword`, `verifyPassword`.
  - `lib/rateLimiter.js`: `makeAttemptLimiter` (Fase 2.2, 3 intentos fallidos → bloqueo de 15 min),
    ahora con un reloj (`now`) inyectable para poder testear el paso del tiempo sin `setTimeout`s
    reales de 15 minutos.
  - `lib/hostAuth.js`: `isRoomOwner` (quién puede reclamar el host de una sala — Fase 2bis, "migración
    del rol de host") y `setHost` (el traspaso de host, que ya tuvo un bug real de "hosts duplicados",
    ver `docs/historico/MEMORIA.md` 5bis), con `io` recibido por parámetro en vez de leído de la
    variable global del módulo, para poder testearlo con un `io` de mentira.
  - `lib/uploadReference.js`: `isValidUploadReference`, `displayNameFor`, `videoDisplayName`,
    `videoUrlForExistingFile` — el modo dual disco local/R2, con `r2` y `fs` inyectables por parámetro.
- **27 tests nuevos** (`test/*.test.js`) con el test runner nativo de Node (`node:test` + `node:assert`,
  disponible desde Node 18+ sin sumar Jest/Mocha ni ninguna dependencia nueva de testing):
  - `test/passwordAuth.test.js` (8 tests): reconocimiento de hash bcrypt vs. legacy, hasheo, y
    verificación en los cuatro casos (sin contraseña configurada, bcrypt correcta/incorrecta, legacy
    correcta con `needsRehash: true`, legacy incorrecta, hash con forma irreconocible).
  - `test/rateLimiter.test.js` (5 tests): intentos por debajo del límite, bloqueo al 3er intento,
    `recordSuccess` olvidando intentos previos, recuperación de intentos frescos tras vencer el
    bloqueo (con un reloj controlado, sin esperar de verdad), y que dos claves distintas no se pisen.
  - `test/hostAuth.test.js` (7 tests): `isRoomOwner` en sala anónima (el hostToken alcanza solo) y en
    sala con dueño (solo la sesión de esa cuenta autoriza, el hostToken solo ya no); `setHost`
    asignando por primera vez, degradando al host anterior antes de promover al nuevo (el caso que
    causó el bug de hosts duplicados), sin romper si el host anterior ya no está conectado, y
    reasignando al mismo socket que ya es host sin un degrade espurio.
  - `test/uploadReference.test.js` (7 tests): `displayNameFor`/`videoDisplayName` con y sin el
    separador `__`; `isValidUploadReference` rechazando filenames vacíos/no-string/con path traversal/
    con subcarpetas en los dos modos, consultando `fs.existsSync` en modo disco e ignorando el
    filesystem por completo en modo R2 (consulta `r2.objectExists`); `videoUrlForExistingFile` en
    ambos modos.
- **CI**: nuevo `.github/workflows/ci.yml` — corre `npm ci` + `npm test` en cada push a
  `main`/`plan-produccion` y en cada Pull Request contra `main`. A propósito simple por ahora: sin
  lint (no hay una config de ESLint en el proyecto todavía), sin matriz de versiones de Node, y sin
  levantar Redis/Postgres como servicios — los tests actuales son unitarios sobre `lib/*.js`, no
  necesitan infraestructura real.
- **`package.json`**: nuevo script `"test": "node --test"`.
- **Probado**: los 27 tests pasan (`npm test`); `node -c server.js` sin errores de sintaxis tras el
  refactor; y un smoke test end-to-end real — servidor levantado con `DISABLE_REDIS=1`, `GET /health`
  en `200`, y `GET /api/uploads` devolviendo `401`/`401`/`200` según falte la contraseña de biblioteca,
  sea incorrecta, o sea la correcta — confirmando que el refactor no cambió ningún comportamiento
  observable de la app real.

## 2026-09-07 — Fase 4: verificación independiente de alertas mínimas en entorno real

- **Motivo**: la entrada anterior ("Fase 4: alertas mínimas") ya había probado el ciclo completo en
  sandbox y contra un servidor real controlado desde acá — esto suma una segunda verificación,
  independiente, corrida por el usuario en su propio entorno (mismo criterio de doble verificación
  que ya se usó para cerrar la Fase 2bis).
- **Healthcheck + R2, probado con Redis y R2 reales**:
  - Redis apagado → `/health` pasó a `503` en ~11s.
  - A los 2 chequeos seguidos en falla (`ALERT_HEALTH_FAILURE_THRESHOLD=2` para la prueba) →
    se disparó el email de "Healthcheck en falla".
  - Silencio durante toda la ventana de `ALERT_COOLDOWN_MS` → confirmado que no reenvía de más
    mientras el problema sigue.
  - Redis levantado de nuevo (sin reiniciar el proceso de Node) → `/health` volvió a `200` → llegó
    el email de "Recuperado".
  - Credencial de R2 inválida a propósito → R2 respondió `403`, `/health` pasó a `503`, y se
    dispararon **ambas** alertas ("Healthcheck en falla" + "R2 está devolviendo errores").
- **Limpieza post-prueba confirmada**: `.env` restaurado a su estado original (sin las variables
  `ALERT_*` usadas solo para la prueba), sin backups temporales sueltos, servidor final corriendo
  limpio con `/health` en `200`.
- **Resultado**: con esta segunda verificación (sandbox + entorno real del usuario), la Fase 4
  (observabilidad) queda confirmada del todo — no quedan dudas pendientes sobre el comportamiento
  de las alertas en un entorno real. Sin cambios de código en esta entrada.

## 2026-09-07 — Fase 4: alertas mínimas ✅ (último punto pendiente de la fase, ahora completa)

- **Motivo**: `/health` y `/metrics` ya exponían si el proceso está sano y si R2 viene fallando,
  pero ambos son "pull" — alguien tiene que estar mirando la consola o consultando el endpoint a
  mano para enterarse. Esto agrega la mitad que faltaba ("push").
- **`server.js`**: se extrajo la lógica de `/health` a una función reusable
  `computeHealthStatus()`, para que el job nuevo de alertas revise exactamente lo mismo que ya
  reporta la ruta HTTP, sin una segunda definición de "sano" que se pueda desincronizar con el
  tiempo. Nuevo job `runAlertChecks()`, corrido cada `ALERT_CHECK_INTERVAL_MS` (default 1 min) vía
  `setInterval` (mismo patrón que `sweepExpiredRooms`/`sweepAbandonedMultipartUploads`, limpiado en
  el graceful shutdown), que llama a `computeHealthStatus()` y a `metrics.snapshot()` y delega la
  decisión de alertar a `lib/alerts.js`.
- **Nuevo `lib/alerts.js`**: mantiene el estado (en memoria, una sola instancia, mismo criterio que
  `lib/metrics.js`) de cuántos chequeos seguidos lleva fallando el healthcheck y cuál era el último
  `r2ErrorCount` visto. Manda un email si:
  - El healthcheck lleva `ALERT_HEALTH_FAILURE_THRESHOLD` chequeos SEGUIDOS en falla (default 3 —
    con el intervalo por default, 3 minutos de caída sostenida antes de la primera alerta, para no
    disparar por un timeout aislado de un segundo).
  - `r2ErrorCount` (de `metrics.snapshot()`) subió desde el último chequeo — se ignora el valor
    absoluto (que solo crece con el tiempo) y se compara contra la última lectura.
  - Una vez mandada la primera alerta de cualquiera de los dos tipos, un `ALERT_COOLDOWN_MS`
    (default 30 min) evita reenviar en cada chequeo mientras el problema siga sin resolverse — sin
    esto, un R2 caído durante horas mandaría un email por minuto.
  - Cuando el healthcheck vuelve a estar OK después de haber alertado, manda un único email de
    "recuperado", para no obligar a consultar `/health` a mano para saber si ya se solucionó solo.
- **`lib/mailer.js`**: se extrajo el POST a la API de Resend a un helper interno
  (`sendViaResend()`), compartido ahora por `sendPasswordResetEmail()` y la nueva
  `sendAlertEmail()`. Sin `RESEND_API_KEY` configurada, `sendAlertEmail()` loguea el contenido
  completo de la alerta como warning en vez de intentar mandarla — a diferencia de
  `sendPasswordResetEmail` (que loguea un link para que alguien lo abra), acá no hay un link que
  loguear, así que se loguea directamente el mensaje entero.
- **Feature opcional, mismo criterio que Sentry/Postgres/R2**: sin `ALERT_EMAIL_TO` configurada, el
  job ni siquiera arranca — no tiene sentido correr chequeos periódicos de más si no hay a quién
  avisarle. Nuevas variables documentadas en `.env.example`: `ALERT_EMAIL_TO`,
  `ALERT_CHECK_INTERVAL_MS`, `ALERT_HEALTH_FAILURE_THRESHOLD`, `ALERT_COOLDOWN_MS`.
- **Probado en sandbox**: con un harness aislado que llama directo a
  `alerts.checkHealthAndAlert()` con distintas secuencias de resultados, se confirmó el ciclo
  completo — chequeo bajo el umbral (sin alerta) → cruza el umbral (alerta de "Healthcheck en
  falla") → sigue fallando dentro del cooldown (sin alerta nueva) → se recupera (email de
  "Recuperado") → sigue sano (sin alerta) → vuelve a fallar dos veces (nuevo ciclo de alerta,
  confirma que el estado se reinicia bien tras una recuperación). Probado además contra un servidor
  real (modo disco local, `DISABLE_REDIS=1`, credenciales de R2 inválidas a propósito): con
  `ALERT_HEALTH_FAILURE_THRESHOLD=2` y `ALERT_CHECK_INTERVAL_MS=2000`, el healthcheck empezó a
  fallar por R2 (`checks.r2.ok: false`) y a los 2 chequeos se dispararon correctamente tanto la
  alerta de "Healthcheck en falla" como la de "R2 está devolviendo errores" (`r2ErrorCount` subiendo
  en cada intento fallido); confirmado también que `ALERT_COOLDOWN_MS` evita reenviar en cada
  chequeo mientras el problema sigue, y que sí vuelve a alertar una vez cumplido el cooldown si la
  falla persiste.

## 2026-09-07 — Fase 4: fix de `uploads.inProgress` pegado tras una desconexión abrupta

- **Bug encontrado probando en un entorno real**: cortar a la fuerza (`kill -9`) el proceso cliente
  a mitad de una subida real (300MB, limitada a 1MB/s para poder observarla) dejaba
  `uploads.inProgress` pegado en `1` para siempre — 30+ segundos de polling después de matar el
  cliente, sin volver nunca a `0`, aunque no había ninguna otra subida en curso.
- **Causa**: `trackVideoUpload()` (agregado en la entrada de más abajo, "Fase 4: métricas básicas")
  solo llamaba a `metrics.uploadFinished()` dentro del callback de
  `multerMiddleware(req, res, callback)`. Cuando el cliente corta la conexión a mitad de la subida,
  Busboy/Multer no llegan a terminar de parsear el `multipart/form-data` — ni error ni éxito, el
  callback simplemente nunca se invoca — así que `uploadFinished()` no se ejecutaba jamás para ese
  caso.
- **Fix**: `trackVideoUpload()` ahora también escucha `req.on('aborted', ...)` y `res.on('close',
  ...)` (los dos, por si en alguna versión/plataforma de Node uno no dispara) y llama a
  `metrics.uploadFinished()` desde ahí si el callback normal de Multer todavía no lo hizo. Una
  bandera (`finished`) evita descontar dos veces si terminan disparando ambos caminos.
- **Probado end-to-end en sandbox** (modo disco local, `DISABLE_REDIS=1`, sin R2): reproducido el
  bug exacto de la prueba original (subida de 300MB a 1MB/s, `kill -9` al proceso `curl` a mitad de
  camino, `uploads.inProgress` confirmado en `1` durante la subida) — con el fix aplicado, la
  primera consulta a `/metrics` después del corte ya muestra `0` (antes se quedaba en `1` durante
  los 30s completos de polling). Probada también la regresión del camino normal: una subida chica
  sin cortar sigue subiendo el contador a `1` y bajándolo a `0` al terminar con éxito, sin doble
  descuento.

## 2026-09-07 — Fase 4: métricas básicas

- Nuevo `lib/metrics.js`: contadores en memoria (`uploadsInProgress`, `r2ErrorCount`, `r2LastError`),
  con `uploadStarted()`/`uploadFinished()`/`recordR2Error()`/`snapshot()`. En memoria a propósito —
  la Fase 0 ya decidió que una sola instancia alcanza por ahora, no hace falta un backend compartido
  tipo Redis para esto.
- Nueva ruta `GET /metrics`: salas activas (`Object.keys(rooms).length`), usuarios conectados
  (`io.engine.clientsCount`), subidas de video en curso y errores de R2 vistos desde que arrancó el
  proceso (cantidad + último mensaje y fecha). Excluida del rate limiter general, mismo criterio que
  `/health`.
- Protección opcional con `METRICS_TOKEN` (header `x-metrics-token`): sin la variable, el endpoint
  queda público; con ella, responde 401 sin el header o con uno incorrecto. Mismo criterio que otras
  variables opcionales del proyecto (`LIBRARY_PASSWORD`, `SENTRY_DSN`).
- `lib/r2.js`: nuevo wrapper `withR2ErrorTracking()` envolviendo cada función que habla de verdad con
  el bucket (`uploadStream`, `getPresignedUploadUrl`, `listObjects`, `deleteObject`, `getObjectHead`,
  `testConnection`, `listMultipartUploads`, `abortMultipartUpload`). `objectExists()` solo cuenta el
  error cuando es una falla real de R2, no cuando el objeto simplemente no existe (404 válido).
- `server.js`: nuevo `trackVideoUpload()` envolviendo `upload.single('video')` en `/create-room` y
  `/room/:id/change-video`, para que `uploads.inProgress` refleje los dos modos que pasan por el
  proceso (disco local y streaming a R2 vía `r2VideoStorage`). La subida directa a R2 por URL
  prefirmada (Fase 2.7) queda deliberadamente afuera de este contador: el server nunca ve esos bytes
  en ese camino.
- **Probado end-to-end en sandbox**: `/metrics` sin `METRICS_TOKEN` configurada (público); con la
  variable configurada, 401 sin header y con header incorrecto, 200 con el correcto.
  `uploads.inProgress` confirmado en 1 durante una subida real (video real generado con `ffmpeg`,
  agrandado con datos aleatorios para que la transferencia tardara lo suficiente para observarlo por
  polling) y de vuelta en 0 al terminar (incluso en el camino de error, sala inexistente). El conteo
  de errores de R2 confirmado configurando credenciales inválidas: `errorCount` subió a 1 con el
  mensaje y la fecha correctos, mismo error que además hizo fallar `/health` al mismo tiempo.

## 2026-09-07 — Fase 4: reporte de errores con Sentry

- Nuevo `lib/sentry.js` sobre `@sentry/node`. `SENTRY_DSN` se toma desde el `.env` ya cargado por
  `loadDotEnv()` y nunca se hardcodea. Sin DSN, Sentry no se inicializa y MovieNight sigue corriendo
  sin ninguna dependencia externa adicional.
- Captura centralizada de excepciones no manejadas, rutas HTTP y `safeSocketHandler`. Las integraciones
  globales automáticas del SDK se desactivan para no duplicar los eventos que ya manejan los handlers de
  `process`; en `uncaughtException` se espera brevemente el vaciado de la cola antes de salir.
- Antes de enviar eventos se eliminan cookies y headers de autenticación, y se redactan contraseñas,
  `hostToken`, tokens y datos de sesión en cualquier nivel. Sentry queda solo para Error Monitoring:
  sin Logs, Tracing ni Profiling.
- `/health` ahora expone `checks.sentry` como dependencia opcional. La ausencia del DSN se ve como
  `{ enabled: false, ok: true }`, sin degradar el estado general.
- **Bug encontrado en la verificación end-to-end (2026-09-07):** con `@sentry/node` 10.73.0,
  `defaultIntegrations` no acepta la función usada originalmente: el SDK intentaba ejecutar
  `.forEach` sobre ella, inicializaba Sentry en falso y emitía `defaultIntegrations.forEach is not a
  function`. La causa raíz fue usar el callback de `integrations` en la opción equivocada; el fix fue
  mover allí el filtro de `OnUncaughtException`/`OnUnhandledRejection`. Además, la auditoría de
  `beforeSend()` encontró que `libraryPassword` (query/body) no coincidía con la regex; se agregó
  explícitamente para evitar enviar esa contraseña a Sentry.
- **Verificación end-to-end en entorno real (2026-09-07):** un error real disparado con
  `x-library-password` en el header llegó a Sentry (evento visible en el dashboard, `checks.sentry`
  en `{ enabled: true, ok: true }`), y el header no apareció en ningún lado del evento —ni en Tags,
  Contexts, ni en el JSON crudo— porque el SDK ni siquiera llegó a capturarlo (`sendDefaultPii:
  false`). Esto confirma que no hay fuga en ese caso, pero no ejercitaba la rama de `beforeSend()`
  que redacta activamente un campo sensible ya presente en el evento. **Verificado aparte (mismo
  día)**: con una ruta de prueba temporal (no commiteada) que llama a `captureException()` con
  `extra: { password, hostToken, normalField }`, el evento real en Sentry muestra `password` y
  `hostToken` como `[Filtered]` (el label propio de Sentry para datos scrubbeados) y `normalField`
  sin tocar — confirma que `redactSensitiveData()` sí actúa cuando el dato sensible llega a estar
  presente, y que no redacta de más. Con las dos pruebas (dato no capturado / dato capturado y
  redactado), la verificación de `beforeSend()` queda completa.

## 2026-09-06 — Fase 4: logs estructurados (JSON) en vez de `console.log`/`console.error`

- **Motivo**: hasta ahora todo el server logueaba con `console.log`/`console.error`
  y texto libre armado a mano con template strings — funciona para leer en una
  terminal, pero es difícil de indexar/filtrar en cualquier servicio de logs real
  (Datadog, Better Stack, CloudWatch, etc., según el hosting que se termine
  eligiendo — ver Fase 0) sin parsear texto con regex.
- **Nuevo `lib/logger.js`**, sobre **pino** (JSON por línea, rápido, sin bindings
  nativos — se agrega como dependencia real, mismo criterio que ya se usó con
  `helmet`/`express-rate-limit`/`file-type`: la funcionalidad que hace falta acá
  no vale la pena reimplementarla a mano, a diferencia de `loadDotEnv()`):
  - `LOG_LEVEL` (default `info`) controla el nivel; `LOG_PRETTY=1` da un formato
    legible en una sola línea para desarrollo local (requiere `pino-pretty`
    instalado aparte — no es una dependencia obligatoria del proyecto; si no
    está instalado, cae a JSON normal con un aviso, nunca rompe el arranque).
  - **Redacción automática de campos sensibles**: contraseñas (`password`,
    `passwordHash`, `libraryPasswordHash`), `hostToken`, `sessionId`, `token`,
    y headers/cookies (`req.headers.cookie`, `x-library-password`) — en
    cualquier nivel de anidamiento (paths con comodín `*.campo`) — se
    reemplazan por `[Redacted]` antes de escribirse, para que ningún error a
    futuro termine filtrando una credencial cruda a los logs. Probado con un
    objeto de prueba anidado (`nested.passwordHash`, `req.headers.cookie`):
    los tres campos salen redactados, el resto del objeto intacto.
  - Serialización estándar de errores (`pino.stdSerializers.err`) para los
    campos `err`/`error` — stack trace y mensaje consistentes, en vez de lo
    que salga de pasar un `Error` crudo a JSON.stringify.
- **Reemplazados los ~96 `console.log`/`console.error` de `server.js`** por
  `logger.info/warn/error/fatal(...)` con campos estructurados (`err`, `roomId`,
  `socketId`, `event`, `filename`, `key`, etc.) en vez de texto concatenado —
  cubre el manejo de errores no capturados (Fase 1.2), todas las rutas de
  `/auth/*`, validación de video/subtítulos, subida a R2, creación/cambio de
  sala, el wrapper `safeSocketHandler`, los barridos de salas expiradas y de
  multipart abandonado (Fase 2.6), y el arranque/apagado del server (Fases 1.1,
  1.4). Mismo reemplazo en `lib/db.js`, `lib/roomStore.js` y `lib/mailer.js`
  (12 usos entre los tres).
- **`scripts/library-orphan-report.js` y `scripts/r2-cleanup-multipart.js`
  quedan con `console.log` tal cual, a propósito**: son scripts de CLI para
  correr a mano, pensados para que una persona lea el output en la terminal,
  no para alimentar un sistema de logs — convertirlos a JSON estructurado
  sería peor para ese caso de uso.
- **Caso especial: secretos que SÍ deben verse en consola.** Dos lugares del
  código imprimen un secreto a propósito para que quien opera el server lo
  lea (la `LIBRARY_PASSWORD` generada al azar en `server.js`, y el link de
  reseteo de contraseña en modo desarrollo sin `RESEND_API_KEY`, en
  `lib/mailer.js`). En los dos casos el valor va directo en el string del
  mensaje, no como campo estructurado aparte (ej. `{ password: ... }`) —
  pasarlo por un campo así activaría la redacción automática de arriba y
  ocultaría justo el valor que esa línea existe para mostrar.
- **Probado**: arranque completo del server con `DISABLE_REDIS=1` (sin
  Redis/Postgres/R2 reales) — logs de arranque en JSON válido, línea por
  línea, con los campos esperados (`port`, `signal`, `graceMs`, etc.); un
  `SIGTERM` real dispara el log de graceful shutdown (Fase 1.4) con el mismo
  formato, y el proceso cierra limpio. `LOG_PRETTY=1` sin `pino-pretty`
  instalado cae a JSON con el aviso esperado, sin romper el arranque.

## 2026-09-07 — Fase 2.5: fix — 0 bytes reales subidos a R2 en modo streaming (encontrado probando contra R2 real)

- **Hallazgo**: verificando la Fase 2.5 en un entorno con credenciales reales
  de R2 (no disponibles en el sandbox donde se implementó la fase), subir un
  video real por `/create-room` en modo streaming a R2 respondía `200` con un
  `size` correcto, pero el objeto quedaba en el bucket con **0 bytes reales**.
  Se confirmó tanto con un video más chico que `SNIFF_BYTES` como con uno más
  grande — afectaba a los dos casos, no solo a uno.
- **Causa**: el `counter` que cuenta bytes para el `size` final era un
  `PassThrough` con un `counter.on('data', (chunk) => { bytes += chunk.length; })`
  externo. Adjuntar un listener `'data'` a un stream Readable lo pone en modo
  *flowing* de inmediato — los chunks que se escribían en `counter` (tanto
  los ya juntados para el sniff como los que seguían llegando) se drenaban
  consumidos por ese mismo listener contador, **antes** de que
  `r2.uploadStream` llegara a engancharse como consumidor real (el SDK de AWS
  hace un round-trip de red, `CreateMultipartUpload`, antes de empezar a leer
  el stream — tiempo de sobra para que el listener temprano ya hubiera
  drenado todo). El tamaño se reportaba correctamente (ese mismo listener lo
  contaba bien), pero el consumidor real nunca llegó a ver los datos.
- **Por qué no se detectó en la verificación anterior**: el harness de la
  Parte 1 de esta fase usaba un mock de `r2.uploadStream` que consumía el
  stream en el mismo tick en que se lo pasaban, sin ningún delay — eso
  alcanzaba a "ganarle" al drenaje del listener temprano por pura casualidad
  de timing, ocultando el bug. Un mock más realista (con un `await` antes de
  empezar a leer, simulando el round-trip real de red) sí lo reproduce.
- **Fix**: reemplazar el `PassThrough`+listener externo por un `Transform`
  propio (definido inline en `r2VideoStorage._handleFile`, `server.js`) que
  cuenta los bytes dentro de su propio método de escritura (`_transform`) —
  así el conteo no depende de poner el lado de lectura en modo flowing, y ese
  lado queda en pausa hasta que `r2.uploadStream` lo consume de verdad, sin
  perder nada en el medio.
- **Probado**:
  - Reproducido el bug en aislado, con un script standalone mínimo (un
    `PassThrough` + listener temprano + un consumidor que se engancha
    después): confirma 0 bytes recibidos por el consumidor real, pese al
    conteo correcto del listener.
  - Confirmado el fix con el mismo patrón, usando un `Transform`: el
    consumidor tardío recibe ahora los bytes completos.
  - Harness que reproduce la lógica exacta y completa de
    `r2VideoStorage._handleFile` (ya con el fix) contra un mock de
    `r2.uploadStream` con un delay async antes de empezar a leer: los 4 casos
    (video real chico/grande, falso chico/grande) se comportan bien — los 2
    reales suben exactamente sus bytes completos, los 2 falsos se rechazan
    por magic bytes, el mock se invoca exactamente 2 veces (los 2 casos
    reales).
  - El mismo harness, corrido contra el código viejo (buggy) con ese mismo
    delay realista, confirma que el bug afectaba **tanto al caso chico como
    al grande** (0 bytes reales subidos en los dos).
- **Verificado además en el entorno real donde se encontró el bug** (según el
  reporte de esa sesión, antes del fix): archivo inválido rechazado por
  `/create-room` sin quedar en disco; subtítulos válidos/inválidos en ambos
  formatos comportándose bien; el flujo completo de subida directa por URL
  prefirmada (presign → PUT directo al navegador → confirmación de sala)
  confirmado de punta a punta contra R2 real, incluyendo el rechazo y borrado
  correcto de un archivo inválido subido por ese camino.

## 2026-09-07 — Fase 2.5: validación real de archivos subidos (magic bytes/estructura)

- Hasta ahora la única validación de un video subido era el `Content-Type`
  que manda el navegador en el multipart — trivial de falsificar desde
  cualquier cliente HTTP. Igual para subtítulos, donde solo se chequeaba la
  extensión del nombre de archivo.
- Nuevo `lib/fileValidation.js`:
  - `isValidVideoBuffer(buffer)`: detecta el contenedor real por **magic
    bytes** (librería `file-type` v22, ESM-only, importada con `import()`
    dinámico desde este módulo CommonJS) contra la lista ya aceptada por el
    proyecto (mp4/mkv/mov/webm/avi/m4v). `SNIFF_BYTES = 4100` — la muestra
    mínima que recomienda la librería para detectar con confianza sin
    necesitar el archivo entero.
  - `isValidSubtitleContent(text, ext)`: valida estructura real de
    `.srt`/`.vtt` — un bloque de timestamp con el separador correcto (coma en
    SRT, punto en VTT), la cabecera `WEBVTT` obligatoria en VTT (por spec), y
    un chequeo de proporción de bytes de control para descartar binarios que
    por casualidad contengan la secuencia `-->` en algún punto.
- `lib/r2.js`: nueva `getObjectHead(key, maxBytes)` — `GetObject` con header
  `Range` para leer solo el comienzo de un objeto ya en el bucket, sin bajar
  el archivo entero.
- `server.js`, integrado en los **tres caminos** por los que un video puede
  llegar a la biblioteca:
  - **Modo disco local** (`rejectIfInvalidVideo`, middleware nuevo tras
    `upload.single('video')` en `/create-room` y `/room/:id/change-video`):
    `multer.diskStorage` no da ningún gancho para mirar el contenido antes de
    escribirlo entero, así que se valida leyendo la cabecera del archivo ya
    escrito y se borra si no matchea.
  - **Modo R2 streaming** (`r2VideoStorage._handleFile`): se juntan los
    primeros `SNIFF_BYTES` ANTES de completar la subida a R2 y se valida ahí
    — si no pasa, se corta la conexión (`file.stream.destroy()`) sin
    terminar de subir un archivo que ya se sabe inválido, así nunca llega a
    ocupar espacio en el bucket. **Bug real encontrado y corregido acá**: un
    video más chico que `SNIFF_BYTES` termina (evento `'end'`) antes de que
    `'data'` alcance ese umbral — sin un chequeo síncrono (`validationStarted`)
    la subida quedaba colgada para siempre, porque nunca se llamaba al
    callback de Multer.
  - **Confirmación de subida directa a R2 por URL prefirmada** (Fase 2.7,
    `rejectIfInvalidExistingVideo`, en `/create-room-from-upload` y
    `/room/:id/change-video-from-upload`): el server nunca ve el archivo
    mientras sube por ese camino (el navegador lo manda directo al bucket),
    así que esta es la primera oportunidad real de validarlo — se lee el
    rango inicial del objeto con `r2.getObjectHead()` y se borra de la
    biblioteca si no pasa.
- `server.js`, subtítulos (`/room/:id/upload-subtitle`): valida estructura
  real con `isValidSubtitleContent()` antes de convertir SRT→VTT y guardar.
- El manejador de errores genérico de subida distingue ahora
  `err.isVideoValidationError` (400, "el archivo no es un video válido") de
  un error real de infraestructura (502, R2/disco inalcanzable) — antes de
  este cambio, un video rechazado durante el streaming a R2 se reportaba
  igual que una caída de R2.
- `package.json`/`package-lock.json`: agregada la dependencia
  `file-type@22.0.2`.
- **Probado**:
  - End-to-end en modo disco local, contra un servidor real (`curl`): un
    archivo de texto renombrado a `.mp4` → `400` y se borra del disco; un mp4
    real → `200` y se guarda; un binario renombrado a `.srt` → `400`; un
    `.srt` válido → `200`; un `.srt` sin ningún timestamp → `400`; un `.vtt`
    válido → `200`.
  - El camino de streaming a R2, con un harness aislado que reproduce
    exactamente la lógica de `r2VideoStorage._handleFile` contra un **mock**
    de `r2.uploadStream` (sin necesitar credenciales reales de R2): los 4
    casos (video real más chico que `SNIFF_BYTES`, falso más chico, falso más
    grande, real más grande) se comportan como se espera — en particular
    confirma el fix del bug de "video chico" (sube bien, sin colgarse) y que
    `r2.uploadStream` (mock) se invoca exactamente en los 2 casos que
    corresponden (los reales).
  - **Pendiente, no bloqueante**: no se llegó a confirmar el camino de
    streaming a R2 contra un bucket real (sin credenciales disponibles en
    esta sesión) ni el camino de subida directa por URL prefirmada de punta a
    punta — el harness cubre la lógica de validación en sí, pero no reemplaza
    una prueba contra R2 de verdad. Queda para cuando haya credenciales a
    mano, mismo criterio que otras fases de este plan cuando el sandbox no
    tiene acceso a infraestructura real.

## 2026-09-06 — Fase 2.4: fix de Google Fonts confirmado en un segundo pase por el navegador

- Con el fix de la entrada anterior (sumar `fonts.googleapis.com` a
  `style-src` y `fonts.gstatic.com` a `font-src`) ya aplicado, se repitió la
  verificación en navegador contra `/`, `/library.html` y `/room/:id`:
  `document.fonts.status` da `loaded`, `document.fonts.check(...)` confirma
  `Monoton` y `Space Grotesk` cargadas, y el screenshot de cada página
  muestra las tipografías reales aplicadas (no la fuente por default del
  sistema) — confirmación visual, no solo ausencia de error en consola.
- Cero mensajes de CSP/CORS en las tres páginas. Apareció un
  `ERR_CONNECTION_REFUSED` transitorio del polling de Socket.IO durante la
  ventana del reinicio del server (nada que ver con CSP/CORS — el cliente
  reintentando mientras el proceso viejo terminaba de cerrar, ya cubierto por
  el graceful shutdown de la Fase 1.4).
- Con esto, el fix de Google Fonts queda **confirmado de punta a punta**, no
  solo por el header de la CSP sino por el resultado real en el navegador.

## 2026-09-06 — Fase 2.4: fix — Google Fonts bloqueado por la CSP (encontrado en navegador real)

- **Hallazgo**: la primera versión de la CSP (ver entrada anterior, mismo día)
  bloqueaba la hoja de estilos de **Google Fonts**
  (`https://fonts.googleapis.com/css2?family=Monoton&family=Space+Grotesk...`)
  que las 4 páginas (`index.html`, `library.html`, `room.html`,
  `reset-password.html`) cargan por `<link rel="stylesheet">` — sin haber
  probado en un navegador real, esto no se veía con los checks de headers por
  `curl`, solo aparecía como violación en la consola del navegador
  (`Refused to load the stylesheet ... violates ... "style-src"`). No rompía
  nada funcional (subida, salas, chat, sync seguían andando), pero las 3
  tipografías reales del proyecto (Monoton/Space Grotesk/VT323) caían
  silenciosamente a la fuente por default del navegador.
- **Fix**: se sumó `https://fonts.googleapis.com` a `style-src` (de ahí sale la
  hoja de estilos en sí) y `https://fonts.gstatic.com` a `font-src` (de ahí
  sale el archivo real de cada fuente, `.woff2`, que esa hoja de estilos
  termina pidiendo) — sin estos dos, la hoja de estilos hubiera cargado pero
  las fuentes en sí hubieran seguido bloqueadas.
- **Verificado además, en el mismo pase por el navegador**: el flujo completo
  de subida directa a R2 (URL prefirmada, PUT desde el navegador) y
  reproducción del video desde el bucket público — **sin ningún error de CSP
  ni de CORS**, confirmado con el estado real del elemento `<video>`
  (`paused: false`, `readyState: 4`, `currentSrc` apuntando a una URL real de
  `*.r2.dev`) en dos salas de prueba distintas.
- Con este fix, la **Fase 2.4 queda confirmada también contra un navegador
  real y R2 real**, no solo contra los checks de headers/CORS por `curl` de
  la entrada anterior.

## 2026-09-06 — Fase 2.4: headers de seguridad (helmet) y CORS explícito

- **`helmet`** agrega ahora el set estándar de headers HTTP de seguridad —
  antes el server no mandaba ninguno más allá de lo que pone Express por
  default. Incluye una **Content-Security-Policy explícita** (`default-src
  'self'`, con `'unsafe-inline'` en `script-src`/`style-src` porque el JS/CSS
  de las 4 páginas vive inline en el HTML sin nonces, y `data:` en `img-src`
  para el fondo con ruido de `style.css`) y **HSTS** — ambos desactivados solo
  en desarrollo local sin HTTPS, reusando `SESSION_COOKIE_INSECURE=1` (ya
  existía desde Fase 2bis, mismo motivo real: "no hay HTTPS todavía").
- Nueva `r2.getCspOrigins()` en `lib/r2.js`: cuando R2 está configurado, suma
  automáticamente a `connect-src`/`media-src` el endpoint de subida
  prefirmada (`https://BUCKET.ACCOUNT_ID.r2.cloudflarestorage.com` — estilo
  "virtual-hosted", confirmado imprimiendo una URL firmada real, no asumido
  de la documentación) y el bucket público (`R2_PUBLIC_URL`). En modo disco
  local, la CSP no necesita nada más que `'self'`.
- **CORS explícito**: nueva variable `ALLOWED_ORIGINS` (lista separada por
  comas), usada tanto por el middleware `cors()` de Express como por la
  config de CORS de `new Server(server, { cors: ... })` de Socket.io — sin
  definirla, ningún origen cruzado queda permitido en ninguno de los dos
  (mismo comportamiento que ya había de forma implícita, ahora explícito).
- Probado localmente: headers presentes en `/` y `/health`; sin
  `ALLOWED_ORIGINS`, un request con header `Origin` cruzado no recibe
  `Access-Control-Allow-Origin`; con `ALLOWED_ORIGINS=https://sala.ejemplo.uk`,
  ese origen sí lo recibe y uno no listado no; con R2 "configurado" (valores
  de prueba, sin llegar a conectar de verdad), la CSP mostró los dos hosts
  esperados en `connect-src`/`media-src`, y sin R2 no aparecieron; con
  `SESSION_COOKIE_INSECURE=1` no aparecieron `Strict-Transport-Security` ni
  `upgrade-insecure-requests` en la respuesta.
- Documentado en el README (nueva sección "Headers de seguridad y CORS") y en
  `.env.example` (`ALLOWED_ORIGINS`). Con esto, la **Fase 2.4 queda
  completa** — la única salvedad anotada (no bloqueante) es que
  `'unsafe-inline'` en scripts/estilos sigue siendo necesario mientras las
  páginas no se sirvan como plantillas renderizadas por request (para poder
  usar nonces); queda como posible mejora futura, no forma parte de esta
  fase.

## 2026-09-06 — Fase 2.6: fix confirmado en entorno real, verificación end-to-end completa

- **Confirmación del fix de `LIBRARY_ORPHAN_DAYS=0`/`MULTIPART_ABANDON_DAYS=0`**
  (ver entrada anterior, mismo día): se corrió de nuevo
  `LIBRARY_ORPHAN_DAYS=0 npm run library:orphans` contra el mismo entorno
  real (Windows, Redis y R2 reales) con el fix ya aplicado. La salida ahora
  dice literalmente **"con más de 0 días"** en vez de "30" — confirma que el
  `0` explícito ya se respeta y no cae al default. Reportó 6 candidatos, y
  los 6 coinciden exactamente con los objetos que había en el bucket sin
  ninguna sala activa usándolos (incluye videos de prueba de la fase
  anterior, ver más abajo).
- Con este último chequeo, el **plan de pruebas completo de la Fase 2.6 quedó
  verificado de punta a punta en un entorno real** (no solo en el sandbox
  donde se escribió el código):
  - Expiración de sala por inactividad: confirmada por HTTP (`404` tras
    vencer el TTL) y por Redis (`TTL`/`EXISTS` reflejando la expiración).
  - El video de una sala expirada sigue disponible en la biblioteca de R2
    (no se borra al expirar la sala, la decisión de producto tomada).
  - Límite de storage (`MAX_LIBRARY_VIDEOS`): una subida nueva por encima
    del límite se rechaza con `413` y el mensaje esperado.
  - Reporte de videos huérfanos (`library:orphans`): lista correctamente
    los candidatos sin ninguna sala activa usándolos, con el fix de `0`
    confirmado; nunca borra nada sin `--delete`.
- **Pendiente de confirmar en positivo, no bloqueante**: la limpieza
  automática de subidas multipart abandonadas en R2
  (`sweepAbandonedMultipartUploads`) arrancó bien en las pruebas, pero no
  hubo ninguna subida multipart real abandonada disponible en ese momento
  para confirmar que el barrido efectivamente la cancela — solo se confirmó
  que no rompe nada cuando no hay candidatos. Queda para la próxima vez que
  se corte una subida real a R2 a mitad de camino.
- **Nota aparte, no relacionada con esta fase** (sin resolver todavía):
  `POST /create-room-from-upload` devolvió `502` en la prueba anterior con
  un archivo de referencia que probablemente no existía de verdad en el
  bucket (comportamiento esperable en ese caso, no necesariamente un bug) —
  a confirmar con un archivo real si se quiere descartar del todo.
- Con esto, la **Fase 2.6 queda completa y verificada en entorno real**
  (mismo criterio de verificación independiente que ya se aplicó en la
  Fase 2bis).

## 2026-09-06 — Fase 2.6: fix encontrado probando en un entorno real (LIBRARY_ORPHAN_DAYS=0)

- **Encontrado probando la Fase 2.6 en un entorno real** (Windows, Redis y R2
  reales, siguiendo el plan de pruebas paso a paso): `LIBRARY_ORPHAN_DAYS=0`
  y `MULTIPART_ABANDON_DAYS=0` (pensados para poder probar "contar/cancelar
  todo sin filtrar por antigüedad", sin esperar 30 días o 2 días reales)
  caían igual al valor por default (30 y 2 respectivamente) en vez de
  respetar el `0` explícito — `parseFloat(process.env.X) || N` trata `0`
  como si no hubiera venido nada, porque `0` es un valor falsy en
  JavaScript. Se reemplazó por un chequeo explícito con `Number.isFinite(...)
  && ... >= 0` en `scripts/library-orphan-report.js` y `server.js`, que sí
  acepta `0` como valor válido.
- El resto de las pruebas de la Fase 2.6 dieron el resultado esperado:
  expiración de sala confirmada por HTTP (`404`) y por Redis (`TTL`/`EXISTS`
  reflejando la expiración), el video de la sala expirada siguió disponible
  en la biblioteca de R2, y el límite de storage (`MAX_LIBRARY_VIDEOS`)
  rechazó una subida nueva con `413` como se esperaba.
- **Nota aparte, no relacionada con esta fase**: durante la prueba,
  `POST /create-room-from-upload` devolvió `502` con un archivo de prueba
  inexistente en el bucket — a revisar por separado si se repite con un
  archivo real, no se tocó nada acá porque esta ruta no forma parte de los
  cambios de la Fase 2.6 (`checkStorageLimits` explícitamente no se le
  aplica, ver comentario en `server.js`).

## 2026-09-06 — Fase 2.6: expiración de salas y límites de storage ✅

- **Decisiones de producto tomadas** (las dos preguntas abiertas que dejaba
  anotadas el plan): las salas expiran a las **24hs sin actividad**, y al
  expirar el video asociado **NO se borra** — queda en la biblioteca
  compartida para reutilizarse en otra sala. Solo se pierde el chat/config/
  participantes de esa sala puntual.
- **Expiración de salas** (`lib/roomStore.js` + `server.js`): se reusa
  literalmente la definición de "actividad" que ya existía — cada
  mutación real de una sala (join, play/pause/seek, chat, mute, traspaso de
  host, cambio de cinta) ya llamaba a `roomStore.saveRoom()` desde fases
  anteriores. Ahora `saveRoom()` estampa `room.lastActivity = Date.now()` en
  cada llamada (mutando el objeto real en memoria, no una copia) y aplica un
  **TTL nativo de Redis** (`SET ... EX <segundos>`, configurable con
  `ROOM_TTL_HOURS`, default 24) sobre la key de la sala — si el proceso
  estuviera caído 24hs+, la key desaparece sola sin depender de que nada la
  barra activamente. Mientras el proceso SÍ está corriendo, un barrido
  periódico propio (`sweepExpiredRooms`, cada `ROOM_SWEEP_INTERVAL_MS`,
  default 30min, más una pasada inicial al arrancar) se encarga de la mitad
  que el TTL de Redis no puede resolver solo: sacar la sala de `rooms` en
  memoria (la fuente de verdad para lecturas) y avisar/desconectar a
  cualquiera que siguiera conectado en una sala tan vieja.
- **Límites de storage de la biblioteca** (`server.js`,
  `checkStorageLimits`): dos límites opcionales e independientes (0 = sin
  límite, el default de ambos), `MAX_LIBRARY_VIDEOS` y `MAX_LIBRARY_SIZE_GB`,
  chequeados antes de aceptar una subida **nueva** — `/create-room`,
  `/room/:id/change-video` y `/api/uploads/presign`. No se chequean en las
  rutas que reusan una cinta ya subida (`/create-room-from-upload`,
  `/room/:id/change-video-from-upload`), porque esas no suman nada nuevo a la
  biblioteca. Falla "abierta" a propósito: un error listando la biblioteca
  para chequear el límite no bloquea una subida legítima (es un límite de
  costo, no de seguridad).
- **Limpieza automática de subidas multipart abandonadas en R2**: lo que
  antes solo se podía correr a mano (`npm run r2:cleanup -- --abort`) ahora
  también corre solo, cada `MULTIPART_SWEEP_INTERVAL_MS` (default 24hs),
  cancelando las que superen `MULTIPART_ABANDON_DAYS` (default 2) sin
  completarse — más agresivo que el lifecycle por default de R2 (7 días) a
  propósito, configurable si resulta muy agresivo para conexiones lentas. El
  script manual (`scripts/r2-cleanup-multipart.js`) se mantiene intacto para
  poder revisar/forzar esto a mano en cualquier momento.
- **Nuevo `scripts/library-orphan-report.js`** (`npm run library:orphans`):
  reporta (nunca borra sin `--delete` explícito) videos de la biblioteca sin
  ninguna sala activa usándolos y con más de `LIBRARY_ORPHAN_DAYS` (default
  30) de antigüedad — cruza la biblioteca (disco o R2, según el modo) contra
  las salas activas recuperadas desde Redis. Se corta sin reportar nada si
  Redis no responde o está deshabilitado (`DISABLE_REDIS=1`): sin saber con
  certeza qué está en uso, no vale la pena arriesgar un falso positivo.
- Con esto, la **Fase 2.6 queda completa** — no quedan ítems pendientes en
  esta fase del plan.

## 2026-09-06 — Fase 2.7: probada end-to-end contra un R2 real, queda completa

- Con el fix del checksum CRC32 ya aplicado (ver entrada de más abajo, mismo
  día) y la regla de CORS del bucket configurada (`PUT` + header
  `Content-Type` permitido, para el origen real de la sala), se probó el
  flujo completo de subida directa contra un bucket de R2 real:
  1. El cliente pide la URL prefirmada (`POST /api/uploads/presign`).
  2. Sube un archivo de video real (no uno de prueba de pocos KB) directo al
     bucket con esa URL, sin pasar por el server.
  3. Confirma la sala (`POST /create-room-from-upload`), reusando la key ya
     subida.
  4. Se verificó en el dashboard de Cloudflare que el objeto quedó en el
     bucket con el nombre esperado (`<hex>__<nombre-original>`), y que la
     sala creada reproduce el video sin problemas, sirviéndolo directo desde
     R2.
- Con esto, la **Fase 2.7 queda completa del todo** — no quedan ítems
  pendientes en esa fase del plan (el límite de 5GB por archivo, al firmar un
  PUT simple en vez de multipart, sigue siendo una limitación conocida y
  documentada, no algo a resolver acá).

## 2026-09-06 — Fase 2.7: bug bloqueante encontrado y resuelto (checksum CRC32 de `aws-sdk` vs R2)

- **Encontrado revisando el código antes de la prueba end-to-end contra un R2
  real** (todavía sin credenciales disponibles en este entorno, pero se pudo
  reproducir y confirmar el problema sin necesitarlas — ver más abajo): desde
  `@aws-sdk/client-s3` **v3.729.0** (diciembre 2024), el SDK calcula por
  default un checksum CRC32 y lo suma a cualquier `PutObject`/`UploadPart`
  — incluida una URL prefirmada, donde ese checksum queda calculado sobre un
  body **vacío** (el archivo real todavía no existe al momento de firmar, solo
  se conoce recién cuando el navegador hace el PUT) y viaja horneado en la
  propia URL (`x-amz-checksum-crc32`, `x-amz-sdk-checksum-algorithm`). R2 no
  implementa esto y devuelve `501 NotImplemented` apenas alguien intenta usar
  esa URL — la subida directa de la Fase 2.7 (`/api/uploads/presign`) habría
  fallado con **cualquier archivo real**, no es un caso límite. Es un problema
  conocido y documentado por Cloudflare (ver su ejemplo oficial en
  `developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/`) y reportado por
  varios proyectos que integran R2 con SDKs de AWS actualizados (flysystem,
  vector, LocalStack, entre otros) — el paquete del proyecto está en
  `^3.1115.0`, bien por encima de la versión donde se introdujo.
- **Confirmado localmente sin necesitar un bucket real**: como el problema
  está en qué queda *horneado en la URL firmada* (la firma se calcula
  enteramente en el proceso Node, sin red), se pudo comparar la URL generada
  por `r2.getPresignedUploadUrl()` antes y después del fix y confirmar que el
  parámetro de checksum desaparece — no hizo falta un PUT real contra R2 para
  detectar ni verificar este bug puntual, aunque la prueba end-to-end contra
  R2 real (subida de un archivo real, con y sin CORS configurado) sigue
  pendiente por falta de credenciales en este entorno.
- **Resuelto**: se agregó `requestChecksumCalculation: 'WHEN_REQUIRED'` y
  `responseChecksumValidation: 'WHEN_REQUIRED'` al `S3Client` en
  `lib/r2.js` (único punto de instanciación del cliente en todo el proyecto,
  confirmado por `grep`) — restaura el comportamiento previo a esa versión
  del SDK: solo calcula/valida checksum cuando la operación realmente lo
  exige (no es el caso de `PutObject`). Como el cliente es un singleton
  compartido, el fix corrige tanto la subida directa por URL prefirmada
  (Fase 2.7) como el camino viejo de multipart server-side (`uploadStream`,
  usado si se sube sin pasar por la URL prefirmada) con un solo cambio.
- **Sigue pendiente** (sin cambios respecto de lo ya documentado en
  `docs/PLAN-PRODUCCION.md`, Fase 2.7): probar el flujo completo contra un
  bucket de R2 real (subida de un archivo real, confirmar la sala, y la regla
  de CORS) — no había credenciales de R2 disponibles en este entorno para
  cerrar esa prueba. Este cambio reduce bastante el riesgo de que esa prueba
  fallara por este motivo puntual, pero no reemplaza la prueba end-to-end en
  sí.


Registro cronológico de cambios importantes, de más reciente a más antiguo. Este
archivo arranca vacío a partir de la reorganización de la documentación — el
historial completo de versiones anteriores (V1 a V24+) quedó archivado en
`docs/historico/CHANGELOG.md`.

Formato de cada entrada: fecha, qué cambió, por qué (breve — el detalle largo,
si hace falta, puede ir en el mensaje de commit).

---

## 2026-09-06 — Fase 2.7: subida directa a R2 vía URL prefirmada (pendiente de probar contra R2 real)

- **Resuelve el hallazgo bloqueante** de `413 Payload Too Large` (Cloudflare,
  no el server) al subir un video real por Cloudflare Tunnel — solo en modo
  R2, ver más abajo qué pasa en modo disco local.
- **Nueva función `r2.getPresignedUploadUrl(key, contentType,
  expiresInSeconds)`** en `lib/r2.js`, sobre `PutObjectCommand` +
  `getSignedUrl` de `@aws-sdk/s3-request-presigner` (dependencia nueva).
- **Nueva ruta `POST /api/uploads/presign`** (mismo gate `requireUploadAuth`
  de siempre): devuelve `{ key, uploadUrl, expiresIn }`. Responde `404`
  explícito si el server no tiene R2 configurado. Nueva variable de entorno
  opcional `R2_PRESIGN_EXPIRES_SECONDS` (default 6h).
- **Cliente**: `public/index.html` (crear sala) y `public/library.html`
  (cambiar cinta desde una sala activa) ahora piden la URL prefirmada, suben
  el archivo DIRECTO a R2 (barra de progreso real sobre ese PUT, no sobre un
  request a este server) y recién después confirman — reusando **sin
  tocarlas** las rutas que ya existían (`POST /create-room-from-upload`,
  `POST /room/:id/change-video-from-upload`), que ya sabían recibir la key
  de un archivo ya presente en el bucket. Si `/api/uploads/presign` responde
  404, el cliente cae solo al flujo clásico de multipart de siempre
  (`/create-room`, `/room/:id/change-video`, sin cambios).
- **Modo disco local sigue exactamente igual que antes** (limitación
  conocida, no resuelta por este cambio): sigue sujeto al mismo límite de
  Cloudflare si se comparte por Tunnel proxied.
- **Limitación documentada, no resuelta**: la URL prefirmada firma un PUT
  simple, no una subida multipart — tope de **5GB por archivo**. Una subida
  multipart prefirmada lo resolvería pero es bastante más trabajo del lado
  del cliente; queda anotada como posible mejora futura si el límite resulta
  un problema real.
- **Paso de infraestructura a cargo de quien despliega**: el bucket de R2
  necesita una regla de **CORS** que permita `PUT` desde el origen de la
  sala — documentado en el README con el JSON de ejemplo para pegar en el
  dashboard de Cloudflare.
- **No probado end-to-end contra un R2 real** (no había credenciales de R2
  disponibles en el entorno donde se implementó este cambio) — revisado por
  lectura de código y verificada la sintaxis de los tres archivos tocados
  (`server.js`, `index.html`, `library.html`). Queda pendiente confirmar en
  la práctica: pedir la URL, subir un archivo real, confirmar la sala, el
  fallback en modo disco, y la regla de CORS.

---



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
