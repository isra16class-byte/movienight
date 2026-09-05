# 🚀 Plan hacia producción — MovieNight

Este documento junta, en un solo lugar, todo lo que habría que resolver para pasar
MovieNight de "proyecto casero para un grupo de amigos" (estado actual, ver
`MEMORIA.md`) a una app en **producción real**: con usuarios que no controlás vos,
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

## Fase 0 — Antes de tocar código: decisiones de arquitectura

Estas preguntas cambian *cómo* se resuelve todo lo de abajo, conviene responderlas
primero:

- [ ] **¿Una sola instancia de servidor alcanza, o necesitás escalar horizontalmente
      (varias instancias detrás de un load balancer)?** Si la respuesta es "una
      instancia potente alcanza por ahora", te ahorrás toda la sección de Socket.io
      + Redis adapter de la Fase 3 y podés posponerla.
- [ ] **¿Va a haber cuentas de usuario reales (login) o se mantiene el modelo actual
      (nombre + token, sin registro)?** Define si hace falta un sistema de auth
      completo o alcanza con endurecer el esquema actual (tokens firmados,
      expiración, etc.).
- [ ] **¿Multi-tenant (varios "servidores" o "espacios" independientes) o sigue
      siendo un único servidor con una sola `LIBRARY_PASSWORD` para todos?** Esto
      determina si hace falta modelar "cuentas"/"organizaciones" en la base de
      datos o no.
- [ ] **¿Dónde se hostea?** (VPS propio, Railway, Render, Fly.io, etc.) — condiciona
      cómo se hace el proceso supervisado, los health checks, y el CI/CD.

---

## Fase 1 — Estabilidad básica (lo más urgente, hacer primero)

El objetivo de esta fase es que el servidor **no pierda todo si se cae**, y que si
se cae, **se entere alguien y se reinicie solo**. Sin esto, todo lo demás es
secundario.

### 1.1 Persistencia externa del estado de las salas
- [ ] Reemplazar el objeto `rooms` en memoria (`server.js`) por una store externa:
  **Redis** es la opción natural (rápido, soporta TTL nativo para expirar salas
  solo, y es lo que después hace falta igual para el Socket.io adapter en Fase 3).
- [ ] Definir qué pasa si Redis no responde: ¿el server cae, o degrada a memoria
      con un aviso? (Recomendado: fallar rápido y claro, igual que hace hoy R2 —
      "a propósito no hay modo de emergencia silencioso", mismo criterio que ya
      usaron para R2 en `lib/r2.js`).
- [ ] Serializar `mutedUserIds` (Set) y `userNames`/`recentDisconnects` (Map) a un
      formato compatible con Redis (JSON, ya que Redis no tiene Sets/Maps nativos
      de JS — sí tiene sus propios tipos `SET`/`HASH` si se quiere aprovechar eso).

### 1.2 Manejo de errores no capturados
- [ ] Agregar handlers globales:
  ```js
  process.on('uncaughtException', (err) => { /* log + salir controlado */ });
  process.on('unhandledRejection', (reason) => { /* log */ });
  ```
- [ ] Envolver cada handler de socket (`io.on('connection', ...)`) en try/catch, o
      un wrapper genérico — hoy un error en cualquier evento puede tirar abajo el
      proceso entero y con él **todas** las salas activas, no solo la que falló.

### 1.3 Proceso supervisado (no depender de una terminal abierta)
- [ ] Reemplazar "correr `npm start` en una terminal" por un supervisor real:
  **PM2** (`pm2 start server.js --name movienight`) si es un VPS propio, o el
  mecanismo nativo del hosting (Railway/Render/Fly reinician el proceso solos si
  crashea, sin necesitar PM2).
- [ ] Configurar reinicio automático con backoff (no reintentar en loop infinito
      si el problema es persistente, ej. Redis caído).

### 1.4 Graceful shutdown
- [ ] Capturar `SIGTERM`/`SIGINT`: avisar a los clientes conectados (evento de
      socket tipo `server-restarting`) antes de cerrar, en vez de cortar las
      conexiones de golpe.
- [ ] Dar un pequeño margen (unos segundos) para que Socket.io termine de mandar
      mensajes en vuelo antes de cerrar el proceso.

### 1.5 Healthcheck
- [ ] Agregar `GET /health` (o `/healthz`) que devuelva 200 si el server puede
      responder Y la conexión a Redis/R2 está viva — no solo "el proceso Node
      responde".
- [ ] Necesario para que el hosting/orquestador sepa cuándo reiniciar el proceso.

---

## Fase 2 — Seguridad (la mayoría ya está documentada como riesgo conocido en
`MEMORIA.md`, sección 9 — acá se detalla cómo resolver cada una)

### 2.1 Hashing de contraseñas
- [ ] Migrar `passwordHash` (sala) y `libraryPasswordHash` de `sha256` sin salt a
      **bcrypt** o **argon2** (`bcrypt.hash(pw, 10)` es el estándar razonable hoy).
- [ ] Plan de migración: las contraseñas viejas en `sha256` no se pueden convertir
      directo — hay que decidir si se resetean todas al desplegar el cambio, o si
      se soporta un período de transición (detectar el algoritmo viejo, validar
      con él, y re-hashear con bcrypt en el próximo login exitoso).

### 2.2 Rate limiting
- [ ] `join-room` (intentos de contraseña de sala): limitar intentos por IP y/o
      por `roomId`, similar a lo que ya existe para `requireUploadAuth` (3
      intentos, bloqueo de 15 min) — hoy `join-room` no tiene ningún límite.
- [ ] Chat (`chat-message`): limitar mensajes por segundo por socket, para evitar
      flood.
- [ ] Rutas HTTP en general: agregar `express-rate-limit` como capa base sobre
      todas las rutas públicas, no solo las de upload.

### 2.3 Endurecer el `hostToken`
- [ ] Hoy es una cadena random sin expiración ni forma de revocación — si se
      filtra, sirve para siempre. Opciones (de más simple a más robusta):
  - Agregar expiración (ej. el token vence a las N horas de creada la sala,
    coherente con que las salas tampoco deberían vivir para siempre — ver 2.6).
  - Firmarlo como JWT con expiración incluida, en vez de una cadena random +
    lookup en el store.
- [ ] Evaluar mover el token de `localStorage` (accesible por cualquier script
      que corra en esa página, ej. una extensión de navegador maliciosa) a una
      cookie `httpOnly` — trade-off: más seguro contra XSS, pero requiere manejar
      el envío distinto en los eventos de socket (hoy se manda explícito en el
      payload).

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
- [ ] Las salas hoy **nunca expiran** (`MEMORIA.md`, sección 9). Definir una
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

---

## Fase 3 — Escalado horizontal (solo si Fase 0 determinó que hace falta más de
una instancia)

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
    ver `MEMORIA.md` 5bis, justo el tipo de lógica que se rompe fácil sin red
    de seguridad).
  - Autenticación de sala/biblioteca (contraseñas, rate limiting).
  - El modo dual disco/R2 (`isValidUploadReference`, `displayNameFor`).
- [ ] CI básico (GitHub Actions): correr los tests y un lint en cada cambio, antes
      de fusionar.
- [ ] Documentar y automatizar el despliegue — hoy el flujo es manual
      (`git format-patch` → `git am` → `git push`, ver `MEMORIA.md` sección 11).
      Para producción conviene un pipeline: push a `main` → deploy automático
      (o al menos un solo comando), para que desplegar no dependa de recordar
      los pasos.
- [ ] Variables de entorno: validar al arrancar que estén todas las obligatorias
      seteadas (fallar rápido con un mensaje claro, no a mitad de una subida de
      video como puede pasar hoy con R2 mal configurado).

---

## Fase 6 — Producto (solo si aplica según las respuestas de la Fase 0)

Estas son más grandes y dependen de qué tan lejos se quiera llevar el proyecto —
no son necesarias para "producción estable", pero sí para "producto real" con
usuarios que no se conocen entre sí:

- [ ] Sistema de cuentas real (login), si el modelo "nombre + token en
      localStorage" deja de alcanzar.
- [ ] Multi-tenancy, si va a haber más de un "servidor lógico" con su propia
      biblioteca/contraseña independiente.
- [ ] Términos de uso / política de privacidad, si hay usuarios que no son
      conocidos personales — sobre todo relevante porque se almacenan videos que
      podrían tener derechos de autor de terceros.

---

## Resumen — por dónde empezar

Si hay que elegir un orden mínimo viable:

1. **Fase 1 completa** (persistencia + manejo de errores + supervisión + healthcheck)
   — sin esto, cualquier otra mejora es sobre una base que se puede caer sin aviso
   y perder todo.
2. **Fase 2.1 y 2.2** (hashing con bcrypt + rate limiting) — son cambios acotados
   y cierran los riesgos de seguridad más baratos de explotar.
3. **Fase 2.6** (expiración de salas/storage) — antes de que haya usuarios reales
   generando costo de R2 sin control.
4. El resto (Fase 3 en adelante) según necesidad real de escala y alcance del
   producto, no por adelantado.

---

*Este documento es un plan, no un estado — a medida que se vaya resolviendo cada
punto, tacharlo acá y reflejar el cambio en `MEMORIA.md` (que describe el estado
*actual* del proyecto) y en `CHANGELOG.md` (que acumula el historial), siguiendo
el mismo criterio que ya usa el proyecto para el resto de los cambios.*
