# 🚀 Plan hacia producción — MovieNight

Este documento junta, en un solo lugar, todo lo que habría que resolver para pasar
MovieNight de "proyecto casero para un grupo de amigos" (estado actual, ver
`docs/MEMORIA.md` y, para el detalle completo, `docs/historico/MEMORIA.md`) a
una app en **producción real**: con usuarios que no controlás vos,
sin depender de que tu compu esté prendida, y sin sorpresas de costo o de caída de
servicio.

No es un roadmap de features — es específicamente el trabajo de **robustez,
seguridad, infraestructura y operación** que separa "funciona para mi grupo de
WhatsApp" de "puedo confiarle esto a gente que no conozco / cobrar por esto / que
no se caiga sin que nadie se entere".

Está ordenado por **fases**, y dentro de cada fase por prioridad. No hace falta (ni
conviene) hacerlo todo de una — la idea es que cada fase deje el proyecto en un
estado mejor y usable, sin necesitar la fase siguiente para funcionar.

---

## Fase 0 — Decisiones de arquitectura ✅ (resuelta el 2026-09-05)

Estas preguntas cambiaban *cómo* se resuelve todo lo de abajo. Ya están
respondidas — quedan documentadas acá para no perder el porqué de las fases
siguientes:

- [x] **¿Una sola instancia alcanza, o hace falta escalar horizontalmente?**
      → **Una sola instancia alcanza por ahora.** Consecuencia: la **Fase 3
      completa (Redis adapter de Socket.io, sticky sessions) queda pospuesta**
      — no hace falta planificarla ni implementarla todavía. Si el uso crece y
      hace falta escalar más adelante, se retoma esa fase, pero no bloquea nada
      de lo que sigue.
- [x] **¿Cuentas reales (login) o se mantiene el modelo actual (nombre + token)?**
      → **Se agregan cuentas reales.** Esto es el cambio de mayor impacto de
      esta ronda de decisiones: bastante de lo que estaba anotado como
      "opcional a futuro" (Fase 6) pasa a ser parte del trabajo real, y
      **cambia el enfoque de la Fase 2.3** (que hablaba de "endurecer" el
      `hostToken` actual) — con cuentas reales, tiene más sentido resolver la
      identidad del host a través de la sesión autenticada del usuario, en vez
      de parchear el esquema de token anónimo actual. Ver el detalle agregado
      en Fase 2.3 y la nueva Fase 2bis más abajo.
- [x] **¿Multi-tenant o un solo servidor con una biblioteca compartida?**
      → **Sigue siendo un solo servidor, biblioteca compartida entre todos los
      usuarios.** Aunque haya cuentas reales, no hace falta modelar
      organizaciones/espacios separados — todo el mundo con cuenta ve la misma
      biblioteca de videos. Esto simplifica bastante el modelo de datos
      respecto a lo que se había anotado como posible en Fase 6 (que ese ítem
      de multi-tenancy queda descartado, no solo pospuesto).
- [ ] **¿Dónde se hostea?** → **Todavía no decidido.** Mientras tanto, conviene
      mantener el trabajo de infraestructura (Fase 1) **agnóstico de
      proveedor**: un `Dockerfile` simple corre igual en un VPS propio que en
      Railway/Render/Fly.io, y evita atarse a configuración específica de un
      proveedor antes de tiempo. Retomar este punto antes de la Fase 1.3
      (proceso supervisado) y 1.5 (healthcheck), que sí tienen detalles que
      cambian según el hosting elegido.

---

## Fase 1 — Estabilidad básica ✅ (completa el 2026-09-05)

El objetivo de esta fase es que el servidor **no pierda todo si se cae**, y que si
se cae, **se entere alguien y se reinicie solo**. Sin esto, todo lo demás es
secundario.

### 1.1 Persistencia externa del estado de las salas ✅ (resuelta el 2026-09-05)
- [x] Reemplazar el objeto `rooms` en memoria (`server.js`) por una store externa:
  se agregó `lib/roomStore.js` sobre **Redis** (vía `ioredis`). `rooms` en
  memoria se mantiene como fuente de verdad para LECTURAS (síncronas, por la
  sensibilidad a latencia del sync de video/chat en tiempo real), pero cada
  mutación relevante escribe también a Redis, y al arrancar el server se
  repuebla `rooms` leyendo de ahí — así sobrevive a un reinicio del proceso.
- [x] Definir qué pasa si Redis no responde: **falla rápido y claro** — si
      Redis está configurado (o el default `redis://127.0.0.1:6379`) y no
      responde al arrancar, el server no llega a abrir el puerto HTTP
      (`process.exit(1)`), mismo criterio que ya usa `lib/r2.js`. Escape hatch
      explícito `DISABLE_REDIS=1` solo para desarrollo local (documentado como
      "nunca en producción").
- [x] Serializar `mutedUserIds` (Set) a JSON (array) para guardarlo en Redis.
      `userNames`/`bufferingSockets`/`recentDisconnects`/`hostSocketId` (todo lo
      indexado por `socket.id` o con un `setTimeout` en curso) se dejó
      deliberadamente fuera de lo que se persiste: no sobrevive a un reinicio
      de Socket.io de todos modos (todas las conexiones se cortan igual), así
      que se reconstruye solo a medida que la gente se reconecta — no hacía
      falta ni tenía sentido serializarlo. El host se reasigna solo al
      reconectar con el mismo `hostToken` (lógica ya existente en `join-room`).
- [x] Throttle de escritura para el evento `sync` (heartbeat cada 4s del host):
      se persiste al toque en `play`/`pause`/`seek`, pero como mucho una vez
      cada 5s para los heartbeats — evita un round-trip a Redis constante sin
      necesidad real.
- [x] Probado manualmente end-to-end: crear sala → confirmar el JSON en Redis →
      matar el proceso (`kill -9`) → proceso nuevo apuntando al mismo Redis →
      `GET /api/room/:id` responde con el estado correcto sin recrear la sala.
      También el camino de fallo (Redis inalcanzable → el server no arranca,
      código de salida 1).

### 1.2 Manejo de errores no capturados ✅ (resuelto el 2026-09-05)
- [x] Agregar handlers globales:
  ```js
  process.on('uncaughtException', (err) => { /* log + salir controlado */ });
  process.on('unhandledRejection', (reason) => { /* log */ });
  ```
  `uncaughtException` loguea y hace `process.exit(1)` (el estado del proceso queda
  en condición desconocida tras una excepción sincrónica no capturada — sin la
  Fase 1.3 todavía implementada, esto deja el server caído hasta un reinicio
  manual, es la razón por la que 1.2 y 1.3 van juntas en el orden del plan).
  `unhandledRejection` solo loguea, sin salir (el proceso en general sigue en un
  estado válido tras una Promise rechazada suelta).
- [x] Envolver cada handler de socket (`io.on('connection', ...)`) en try/catch, o
      un wrapper genérico — hoy un error en cualquier evento puede tirar abajo el
      proceso entero y con él **todas** las salas activas, no solo la que falló.
      Implementado con un wrapper genérico `safeSocketHandler(eventName, handler)`
      que envuelve los 10 `socket.on(...)` de la conexión; loguea el evento y el
      `socket.id` sin tirar el proceso. El callback de `setTimeout` dentro de
      `disconnect` (fuera del try/catch del wrapper, por correr en otro tick) tiene
      su propio try/catch aparte.

### 1.3 Proceso supervisado ✅ (resuelta el 2026-09-05)
- [x] Reemplazar "correr `npm start` en una terminal" por un supervisor real:
  se agregó `ecosystem.config.js` para **PM2**, pensado para el caso de VPS
  propio (`npm run pm2:start`, ver README sección "Proceso supervisado"). Para
  el caso de Railway/Render/Fly.io no hace falta nada de esto — esas
  plataformas ya reinician el proceso solas si crashea usando `npm start`
  como comando de arranque, y `ecosystem.config.js` no se usa en ese camino.
  Como el hosting todavía no está decidido (Fase 0), quedan documentados y
  soportados ambos caminos en vez de asumir uno.
- [x] Configurar reinicio automático con backoff (no reintentar en loop infinito
      si el problema es persistente, ej. Redis caído): `exp_backoff_restart_delay`
      en `ecosystem.config.js` (arranca en 100ms, duplica en cada caída seguida
      hasta el tope de 15s de PM2), combinado con `min_uptime: '30s'` +
      `max_restarts: 10` — si el proceso no logra 10 reinicios seguidos que se
      sostengan al menos 30s, PM2 deja de reintentar y lo marca `errored` en vez
      de loopear para siempre.

### 1.4 Graceful shutdown ✅ (resuelta el 2026-09-05)
- [x] Capturar `SIGTERM`/`SIGINT`: `server.js` avisa a todos los clientes
      conectados con `io.emit('server-restarting')` antes de cerrar nada, y
      deja de aceptar conexiones HTTP nuevas de inmediato (`server.close()`)
      — pero sin cortar los sockets ya abiertos todavía. El cliente
      (`room.html`) escucha ese evento y muestra un banner ("🔄 El servidor
      se está reiniciando...") en vez de que el video se trabe sin
      explicación.
- [x] Dar un pequeño margen (`SHUTDOWN_GRACE_MS`, default 5000ms, configurable
      por variable de entorno) para que Socket.io termine de mandar mensajes
      en vuelo antes de cerrar el proceso: recién pasado ese margen se llama
      `io.close()` (corta los sockets activos), `roomStore.closeConnection()`
      (cierra Redis con `QUIT`, no de un hachazo) y `process.exit(0)`. Un
      segundo `SIGTERM`/`SIGINT` mientras ya se está cerrando no reinicia el
      timer (flag `shuttingDown`).
      Probado end-to-end con un cliente Socket.io real: conecta, recibe
      `server-restarting`, y se desconecta (`transport close`) exactamente al
      cumplirse el margen configurado — sin margen extra ni corte prematuro.
      Al reconectar (el cliente de Socket.io reintenta solo por default), el
      `join-room` de siempre recupera el estado de la sala; no hizo falta
      lógica nueva de reconexión.

### 1.5 Healthcheck ✅ (resuelta el 2026-09-05)
- [x] Se agregó `GET /health` (alias `GET /healthz`) en `server.js`: devuelve
      200 solo si el server puede responder Y cada dependencia externa
      *habilitada* respondió al chequeo — no solo "el proceso Node
      responde". Redis se chequea con `roomStore.ping()` (reusa el cliente
      ya conectado, distinto de `testConnection()` que además conecta y solo
      tiene sentido al arrancar); R2 con `r2.testConnection()` (mismo
      `HeadBucketCommand` que ya se usaba al arrancar). Cada chequeo tiene un
      timeout corto (3s) para que un Redis/R2 colgado no deje la respuesta
      del healthcheck colgada también. Si una dependencia está deshabilitada
      (`DISABLE_REDIS=1`, o R2 no configurado — ambos modos válidos, ver
      `docs/MEMORIA.md`) no cuenta como falla, pero se reporta igual en la
      respuesta para que quede visible en qué modo está corriendo el
      proceso. Durante un graceful shutdown en curso (Fase 1.4) responde
      503 `shutting_down` de una — aunque en la práctica casi no se llega a
      ejecutar, porque `server.close()` ya dejó de aceptar conexiones nuevas
      para ese momento.
- [x] Necesario para que el hosting/orquestador sepa cuándo reiniciar el
      proceso: probado con un Redis real levantado aparte del arranque del
      server — `/health` responde 200 con Redis arriba, y al apagar Redis
      **sin reiniciar el proceso Node**, la siguiente consulta a `/health`
      responde 503 con el detalle del error (confirma que detecta una falla
      en caliente, no solo el estado en el momento del arranque).

---

## Fase 2 — Seguridad (la mayoría ya está documentada como riesgo conocido en
`docs/historico/MEMORIA.md`, sección 9 — acá se detalla cómo resolver cada una)

### 2.1 Hashing de contraseñas ✅ (resuelta el 2026-09-05)
- [x] Migrar `passwordHash` (sala) y `libraryPasswordHash` de `sha256` sin salt a
      **bcrypt** (vía `bcryptjs`, implementación en JS puro — sin bindings nativos,
      para no sumar un paso de build/toolchain al instalar en VPS, Windows o
      PaaS; la interfaz `hash`/`compare` es la misma que el paquete `bcrypt`),
      10 rounds.
- [x] Plan de migración elegido: **sin resetear contraseñas existentes**. Se
      soporta un período de transición: `verifyPassword()` detecta si el hash
      guardado es del esquema viejo (sha256, 64 hex) o el nuevo (bcrypt,
      `$2a/b/y$...`), valida con el que corresponda, y si matchea con el
      esquema viejo devuelve `needsRehash: true` — el caller re-hashea con
      bcrypt y persiste el hash nuevo en Redis. Transparente para quien ya
      tenía una sala con contraseña creada antes de este cambio: no nota nada,
      y los hashes viejos van desapareciendo solos con el uso normal (cada
      login exitoso). `LIBRARY_PASSWORD` no necesita esta migración (no se
      persiste entre reinicios; se re-hashea fresco con bcrypt en cada
      arranque, dentro de `startServer()`, antes de aceptar conexiones).
- [x] Probado: hash viejo (sha256) con contraseña correcta → `valid: true,
      needsRehash: true`; con contraseña incorrecta → `valid: false,
      needsRehash: false`; hash nuevo (bcrypt) con contraseña correcta →
      `valid: true, needsRehash: false`. Probado también end-to-end vía
      `join-room`: crear sala → contraseña correcta al primer intento entra
      directo (sin rate limiting de por medio).

### 2.2 Rate limiting ✅ (resuelta el 2026-09-05)
- [x] `join-room` (intentos de contraseña de sala): mismo criterio que ya
      usaba `requireUploadAuth` (3 intentos, bloqueo de 15 min), extraído a un
      helper genérico reusable (`makeAttemptLimiter()`) para no duplicar la
      lógica entre los dos. Clave = `ip:roomId` (no solo `ip`, a diferencia de
      `requireUploadAuth`): cada sala tiene su propia contraseña, así que
      errar la de una sala no debería bloquear el intento de entrar a
      cualquier otra con la misma IP (ej. varios amigos en la misma red).
      Probado end-to-end con un cliente de Socket.io real: 3 intentos
      fallidos seguidos bloquean, y el 4° intento (incluso con la contraseña
      correcta) también queda bloqueado durante la ventana de 15 min, igual
      que el comportamiento ya esperado de `requireUploadAuth`.
- [x] Chat (`chat-message`): límite de flood por socket con ventana
      deslizante — máximo 8 mensajes cada 10 segundos. Se avisa solo a quien
      manda de más (evento `chat-rate-limited`, no se ve en el chat de los
      demás ni se guarda en el historial) — no corta la conexión, solo
      descarta el mensaje de más. Probado: 12 mensajes seguidos → 8 llegan,
      4 quedan bloqueados con el aviso correspondiente.
- [x] Rutas HTTP en general: agregado `express-rate-limit` (300 req/5min por
      IP) como capa base sobre las rutas de la API, además de los límites
      específicos que ya existían. Se monta después de `express.static` y
      `express.json()` a propósito, para no afectar el streaming de video
      (requests `Range` sobre `public/uploads`, servidos por `express.static`
      antes de llegar a este middleware) ni el healthcheck (excluido
      explícitamente); el handshake de Socket.io tampoco pasa por acá, porque
      intercepta su propio path antes de que la request llegue a Express.

### 2.3 Identidad del host — reemplazada por Fase 2bis (cuentas reales)
- ~~Endurecer el `hostToken` actual (expiración, JWT, cookie httpOnly)~~ — con
  la decisión de Fase 0 de agregar **cuentas reales**, no tiene sentido
  invertir en parchear el esquema de token anónimo actual: la identidad del
  host pasa a resolverse a través de la sesión autenticada del usuario. Ver
  **Fase 2bis** más abajo, que reemplaza este ítem.

### 2.4 Headers de seguridad
- [ ] Agregar `helmet` (`app.use(helmet())`) para headers estándar (X-Frame-Options,
      X-Content-Type-Options, etc.).
- [ ] Definir una Content-Security-Policy explícita — hoy no hay ninguna.
- [ ] Configurar CORS explícito si el dominio de producción es fijo, en vez de
      dejar la configuración por defecto de Express/Socket.io.

### 2.5 Validación real de archivos subidos
- [ ] Hoy solo se confía en el `Content-Type` que manda el navegador (`video/*`),
      que es trivial de falsificar. Validar por **magic bytes** del archivo real
      (ej. con la librería `file-type`), no por el header ni la extensión.
- [ ] Igual para subtítulos (`.srt`/`.vtt`): validar que el contenido tenga
      estructura de subtítulo válida antes de aceptarlo, no solo la extensión.

### 2.6 Expiración de salas y limpieza de storage
- [ ] Las salas hoy **nunca expiran** (`docs/historico/MEMORIA.md`, sección 9). Definir una
      política (ej. TTL de 24-48h sin actividad) y aplicarla:
  - Si se migra a Redis (Fase 1.1), usar el TTL nativo de Redis para expirar la
    sala sola.
  - Al expirar una sala, evaluar si also se borra el video asociado en R2, o se
    deja en la biblioteca para reutilizar (esto es una decisión de producto, no
    solo técnica).
- [ ] Job periódico (cron o `setInterval` largo) que:
  - Liste videos en R2 sin ninguna sala activa ni referencia en la biblioteca
    "viva", y los marque para revisión/borrado.
  - Corra `listMultipartUploads`/`abortMultipartUpload` (ya existe el script,
    `scripts/r2-cleanup-multipart.js`) automáticamente en vez de a mano.
- [ ] Límite de storage total o de cantidad de videos por biblioteca, para que el
      costo de R2 no crezca sin control con más usuarios.

### 2.7 Límite de tamaño de subida vía Cloudflare Tunnel/Proxy (hallazgo — bloqueante, 2026-09-05)
- [ ] **Encontrado probando en producción real** (dominio
      `sala.movienight-palomitasjuntos.uk`, detrás de Cloudflare): un archivo
      de prueba de 1KB sube sin problema, pero un video real (mp4 de tamaño
      normal) devuelve `413 Payload Too Large` con página de error de
      **Cloudflare**, no de Express/Multer — el request ni siquiera llega al
      server.
- [ ] **Causa**: Cloudflare (proxied, no solo como túnel "gris") limita el
      tamaño máximo de request que deja pasar según el plan de la cuenta —
      100MB en Free/Pro, 200MB en Business, configurable hasta más en
      Enterprise. Esto es independiente de cualquier límite que se configure
      en Multer o en Express — el corte pasa *antes* de que el tráfico
      llegue al proceso Node.
- [ ] **Por qué es bloqueante**: el caso de uso central del proyecto
      (`docs/MEMORIA.md`, "Qué es") es subir películas completas — un video
      de 2 horas en calidad decente pesa varios GB, muy por encima de
      cualquier límite de Cloudflare en un plan pago razonable. Mientras esto
      no se resuelva, **la subida de video real no funciona en producción**
      aunque el resto del pipeline (R2, rate limiting, persistencia) esté
      correcto.
- [ ] **Camino a evaluar (no implementado todavía)**: subida **directa a R2**
      desde el navegador vía **URL prefirmada** (`PutObjectCommand` +
      `getSignedUrl` de `@aws-sdk/s3-request-presigner`, R2 es compatible con
      S3), en vez de que el archivo pase por `multer` → server → R2. Así el
      binario del video nunca atraviesa el Cloudflare Tunnel/proxy que sirve
      `sala.movienight-palomitasjuntos.uk`, y el límite de payload deja de
      aplicar (solo viajan por ahí las rutas HTTP livianas: pedir la URL
      prefirmada, confirmar el upload, crear la sala). Implica cambiar el
      flujo de `POST /create-room` (hoy recibe el archivo directo) a algo
      tipo: 1) el cliente pide una URL prefirmada, 2) sube directo a R2 con
      esa URL, 3) confirma al server que terminó para crear la sala con la
      key ya subida. Repensar también qué pasa con el modo "disco local"
      (sin R2 configurado, ver `lib/r2.js`) — ese camino seguiría
      necesitando pasar por el server, así que probablemente el límite de
      Cloudflare seguiría aplicando ahí a menos que se resuelva aparte (ej.
      excluyendo esa ruta del proxy, o aceptando que el modo disco local
      queda limitado a videos chicos).
- [ ] Alternativa más simple pero menos flexible: si el dominio se sirve como
      túnel "gris" (DNS only, sin el proxy naranja de Cloudflare) en vez de
      proxied, el límite de payload no aplica — a evaluar el trade-off
      (se pierden protecciones de Cloudflare como DDoS/WAF delante del
      server).

---

## Fase 2bis — Cuentas de usuario reales (agregada tras la decisión de Fase 0)

Esto reemplaza lo que antes estaba anotado como "posible, a futuro" en la
Fase 6 — al confirmarse en Fase 0 que sí va a haber login, este es trabajo
real, no opcional. Es un cambio de arquitectura más grande que el resto de la
Fase 2, conviene tratarlo como su propio bloque:

- [ ] **Modelo de usuario**: tabla/colección `users` (necesita la base de
      datos real de todos modos por la Fase 1.1 — aprovechar el mismo motor
      si es Postgres, o uno separado si se prefiere Mongo/otro para esto y
      Redis solo para las salas efímeras).
- [ ] **Registro y login**: email + contraseña como mínimo (hasheada con
      bcrypt/argon2, mismo criterio que 2.1). Evaluar si conviene sumar login
      social (Google, etc.) o dejarlo para más adelante — no es necesario para
      el primer corte.
- [ ] **Sesiones**: reemplazar el `hostToken` en `localStorage` por una sesión
      de servidor real (cookie `httpOnly` + `secure`, con una librería como
      `express-session` respaldada en Redis, o JWT de corta duración con
      refresh). Esto también resuelve de raíz el problema de "no hay forma de
      revocar el token" que tenía anotado el esquema anterior.
- [ ] **Quién puede crear salas**: definir si cualquier cuenta registrada
      puede crear una sala (más simple) o si hace falta algún tipo de
      verificación adicional (ej. verificar el email) antes de dejar subir
      videos — relevante porque cada sala nueva implica storage en R2, que
      tiene costo.
- [ ] **Migración del rol de host**: `room.hostSocketId` ya es la fuente de
      verdad de "quién controla la sala ahora" (ver `docs/MEMORIA.md`, sección
      de roles) — eso no cambia. Lo que cambia es cómo se prueba "soy el
      dueño de esta sala": en vez de comparar un `hostToken` de
      `localStorage`, se valida contra el `userId` de la sesión autenticada.
- [ ] **La biblioteca deja de depender de una única `LIBRARY_PASSWORD`
      compartida**: con cuentas reales, tiene más sentido que el acceso a
      subir/borrar videos se valide por sesión de usuario logueado, no por una
      contraseña de servidor única. (Sigue siendo una sola biblioteca
      compartida entre todos — eso ya se decidió en Fase 0 — pero el *control
      de acceso* a esa biblioteca puede ser por cuenta en vez de por
      contraseña única.)
- [ ] **Recuperación de contraseña**: flujo mínimo de "olvidé mi contraseña"
      (requiere poder mandar emails — evaluar un servicio simple tipo
      Resend/Postmark/SES en vez de armar SMTP propio).

---

## Fase 3 — Escalado horizontal (pospuesta — ver decisión de Fase 0: una sola
instancia alcanza por ahora. Queda documentada para cuando haga falta retomarla)

- [ ] Adoptar `@socket.io/redis-adapter` para que los eventos de Socket.io
      (sync, chat, reacciones) se propaguen entre instancias — sin esto, dos
      usuarios de la misma sala conectados a instancias distintas no se ven entre
      sí.
- [ ] Configurar *sticky sessions* en el load balancer (necesario para que un
      mismo cliente de Socket.io siga hablando con la misma instancia durante el
      handshake, salvo que se use transporte solo-websocket).
- [ ] Mover cualquier estado que quede en memoria de proceso (además de `rooms`,
      ya cubierto en 1.1) a Redis, para que no importe a qué instancia responde
      cada request.

---

## Fase 4 — Observabilidad

- [ ] Logs estructurados (JSON) en vez de `console.log` — más fácil de indexar en
      cualquier servicio de logs (Datadog, Better Stack, CloudWatch, etc. según
      el hosting elegido).
- [ ] Reporte de errores (ej. **Sentry**) para enterarse de excepciones en
      producción sin depender de que alguien mire la consola del server a mano.
- [ ] Métricas básicas: salas activas, usuarios conectados, uploads en curso,
      errores de R2 — aunque sea un endpoint simple `/metrics` para empezar,
      antes de pensar en Prometheus/Grafana.
- [ ] Alertas mínimas: si el healthcheck (1.5) falla repetidas veces, o si R2
      empieza a devolver errores, alguien se tiene que enterar (email, Slack,
      lo que sea) sin tener que estar mirando la consola.

---

## Fase 5 — Calidad de código y proceso

- [ ] Tests, al menos para lo más crítico y menos obvio a simple vista:
  - `setHost()` (traspaso de host — ya tuvo un bug serio de hosts duplicados,
    ver `docs/historico/MEMORIA.md` 5bis, justo el tipo de lógica que se rompe fácil sin red
    de seguridad).
  - Autenticación de sala/biblioteca (contraseñas, rate limiting).
  - El modo dual disco/R2 (`isValidUploadReference`, `displayNameFor`).
- [ ] CI básico (GitHub Actions): correr los tests y un lint en cada cambio, antes
      de fusionar.
- [ ] Documentar y automatizar el despliegue — hoy el flujo es manual
      (`git format-patch` → `git am` → `git push`, ver `docs/historico/MEMORIA.md` sección 11).
      Para producción conviene un pipeline: push a `main` → deploy automático
      (o al menos un solo comando), para que desplegar no dependa de recordar
      los pasos.
- [ ] Variables de entorno: validar al arrancar que estén todas las obligatorias
      seteadas (fallar rápido con un mensaje claro, no a mitad de una subida de
      video como puede pasar hoy con R2 mal configurado).

---

## Fase 6 — Producto (actualizada tras la decisión de Fase 0)

- ~~Sistema de cuentas real (login)~~ → **decidido en Fase 0: sí.** Movido a
  la **Fase 2bis**, ya no es un "posible a futuro".
- ~~Multi-tenancy~~ → **decidido en Fase 0: no hace falta.** Sigue siendo un
  solo servidor con una biblioteca compartida entre todos los usuarios,
  incluso con cuentas reales. Descartado de este plan (no solo pospuesto).
- [ ] **Términos de uso / política de privacidad** — sigue pendiente de
      decidir. Se vuelve más relevante ahora que va a haber cuentas reales
      (hay datos personales de por medio: email, contraseña) y sigue siendo
      relevante por el tema de derechos de autor de los videos almacenados.

---

## Resumen — por dónde empezar

Con las decisiones de Fase 0 ya tomadas, el orden recomendado queda así:

1. **Fase 1 completa** (persistencia + manejo de errores + supervisión + healthcheck)
   — sin esto, cualquier otra mejora es sobre una base que se puede caer sin aviso
   y perder todo. La base de datos que se elija acá (Fase 1.1) conviene pensarla
   ya teniendo en cuenta que también va a alojar el modelo de usuarios de la
   Fase 2bis.
2. **Fase 2.1 y 2.2 ✅ (resueltas el 2026-09-05)** — hashing con bcrypt +
   rate limiting, cambios acotados que cierran los riesgos de seguridad más
   baratos de explotar; el hashing con bcrypt se reutiliza directo para las
   contraseñas de cuentas de usuario.
3. **Fase 2bis** (cuentas reales) — es el cambio de mayor superficie de esta
   ronda; conviene encararlo después de tener persistencia sólida (Fase 1) y
   antes de invertir más en el esquema de sala/host actual, ya que cambia
   cómo se identifica al host.
4. **Fase 2.6** (expiración de salas/storage) — antes de que haya usuarios reales
   generando costo de R2 sin control.
5. **Fase 3 queda pospuesta** (una instancia alcanza por ahora, según Fase 0) y
   **Fase 6 de multi-tenancy queda descartada** — no vuelven a este orden salvo
   que cambie la necesidad real de escala.

---

*Este documento es un plan, no un estado — a medida que se vaya resolviendo cada
punto, tacharlo acá y reflejar el cambio en `docs/MEMORIA.md` (que describe el
estado *actual* del proyecto, pensado para lectura rápida) y en
`docs/CHANGELOG.md` (donde van las nuevas entradas de ahora en adelante), siguiendo el
mismo criterio que ya usa el proyecto para el resto de los cambios.*
