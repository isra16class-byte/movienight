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
- **Sin base de datos**: todo el estado (`rooms`) vive en un objeto en memoria dentro de `server.js` — se pierde si el proceso se reinicia. Es una decisión consciente para el uso actual (casero), pero es el punto #1 a resolver para producción (ver `docs/PLAN-PRODUCCION.md`, Fase 1).
- **Exposición a internet**: Cloudflare Tunnel (no hay hosting propio todavía).

## Estructura de archivos

```
movienight/
  server.js              # Todo el backend: rutas HTTP + lógica de sockets
  lib/r2.js                # Cloudflare R2 (opcional): subir/listar/borrar videos
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

## Modelo de datos (en memoria, `server.js`)

```js
rooms = {
  [roomId]: {
    videoFile, subtitleFile,       // rutas locales o keys de R2
    viewers, hostToken, hostSocketId,
    passwordHash,                   // sha256 sin salt — pendiente migrar a bcrypt (ver plan de producción)
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

- Contraseñas (sala y biblioteca) con `sha256` sin salt.
- Sin rate-limiting en `join-room` ni en el chat.
- `hostToken` sin expiración, viaja en texto plano.
- Sin validación real de tipo de archivo (solo `Content-Type` del navegador).
- Las salas nunca expiran — se acumulan en memoria y en R2 indefinidamente.

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
