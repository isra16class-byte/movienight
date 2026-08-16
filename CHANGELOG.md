# 📜 CHANGELOG — MovieNight

Registro cronológico de cambios del proyecto. Formato: más nuevo arriba, nunca se borran entradas viejas.

Ver `MEMORIA.md` para el estado actual y contexto técnico completo — este archivo es solo la bitácora de "qué cambió cuándo".

---

## [2026-08-15] V3 — Bloqueo de controles para invitados + resincronización

**Motivo:** se detectó que un invitado podía adelantar el video sin querer desde el celular (el reproductor nativo de pantalla completa en móviles mostraba su propia barra de progreso).

**Cambios:**
- Agregado `playsinline`, `webkit-playsinline` y `disablepictureinpicture` al `<video>` para evitar el reproductor nativo de iOS/Android.
- Los invitados (no-host) ya no tienen `video.controls` habilitado.
- Se bloquea cualquier intento de mover `currentTime` manualmente en no-host: el evento `seeking` revierte el video a `lastKnownTime`.
- Se agregó un "heartbeat": el host manda su posición cada 4 segundos (evento `sync` tipo `heartbeat`) para corregir cualquier desvío por buffering o lag, sin que el usuario lo note.
- Archivo afectado: `public/room.html`.

## [2026-08-15] Repo subido a GitHub

- Se creó el repositorio `isra16class-byte/movienight`.
- Se agregó `.gitignore` (excluye `node_modules/` y `public/uploads/*`) — hubo que hacerlo a tiempo porque videos de prueba (200+ MB) superaban el límite de 100MB de GitHub y el primer intento de `push` fue rechazado.
- Se reinició el historial local de Git (`.git` borrado y re-inicializado) para limpiar el commit que ya traía los videos pesados adentro.
- Verificado con `git clone` en un entorno aparte: el repo queda limpio (sin `node_modules` ni videos).

## [2026-08-15] V2 — Sistema de roles (host / invitado)

**Motivo:** en la V1 cualquier persona en la sala podía pausar/adelantar el video, lo cual no es viable para ver una película en grupo.

**Cambios:**
- Al crear una sala (`POST /create-room`), el servidor genera un `hostToken` secreto y se lo manda solo al creador, que lo guarda en `localStorage`.
- Al unirse a la sala (`join-room`), el cliente manda el token; si coincide con el de la sala, ese socket se marca `isHost = true`.
- Los eventos `sync` (play/pause/seek) del backend solo se retransmiten si vienen de un socket host.
- Agregado: botón para **cambiar la película** en caliente sin cerrar la sala (`POST /room/:id/change-video`, protegido por `hostToken`).
- Agregado: panel "Espectadores" con lista de quién está en la sala; el host puede **expulsar** (`kick-user`) o **silenciar el chat** (`toggle-mute`) de cualquier invitado.
- Archivos afectados: `server.js`, `public/index.html`, `public/room.html`.

## [2026-08-15] V1 — Primera versión funcional

**Alcance inicial:**
- Subida de video propio (Multer) → se genera una sala con código de 6 caracteres.
- Reproducción sincronizada básica vía Socket.io: cualquier usuario podía emitir `play`/`pause`/`seek` y se reflejaba en todos.
- Chat de texto en vivo + reacciones flotantes con emojis.
- Sin sistema de roles — todos los usuarios tenían el mismo nivel de control.
- Sin persistencia — salas viven en memoria mientras el servidor está corriendo.
- Exposición a internet resuelta con Cloudflare Tunnel (elegido sobre ngrok por no tener límite de sesión de ~2 horas en el plan gratis).
