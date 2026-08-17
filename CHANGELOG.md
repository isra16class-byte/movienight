# 📜 CHANGELOG — MovieNight

Registro cronológico de cambios del proyecto. Formato: más nuevo arriba, nunca se borran entradas viejas.

Ver `MEMORIA.md` para el estado actual y contexto técnico completo — este archivo es solo la bitácora de "qué cambió cuándo".

---

## [2026-08-16] V5.1 — Pulido visual del rediseño VHS/vaporwave

**Motivo:** feedback directo sobre una captura de la V5: la interfaz se veía "correcta pero básica/genérica" — los elementos temáticos (lluvia de cintas, horizonte synthwave) casi no se notaban, y había un bug de legibilidad (el separador "O" se confundía con "0" en la fuente VT323).

**Cambios (todos en `public/style.css`, más ajustes chicos en `public/index.html`):**
- Arreglado el bug "O"/"0": el separador ahora dice "o también" en la fuente de texto normal, no en la monoespaciada ambigua.
- Lluvia de fondo (`.floaters`) mucho más visible: opacidad máxima `0.24` → `0.65`, doble glow rosa+cian.
- Sol del horizonte con franjas horizontales (efecto "sol rayado" vaporwave clásico) y más grande/brillante.
- Corregido el grid del piso synthwave, que por un problema de `perspective`/`rotateX` quedaba comprimido y prácticamente invisible fuera del viewport — ahora se ve como un piso de grilla real en la parte baja de la pantalla.
- Agregadas 4 esquinas tipo visor de cámara (`.deck-corner`) alrededor de la tarjeta principal.
- Agregado un contador `REC 00:00` decorativo que corre en vivo en la esquina de la tarjeta (puramente ambiental, sin efecto funcional).
- Agregada textura de estática/grano muy sutil (`feTurbulence` vía SVG inline) en el fondo de la tarjeta.
- Nuevo efecto de hover "mal tracking de VHS" (clase `.tracking-glitch`, solo CSS) en el selector de archivo, el botón de crear sala y el input+botón de unirse por código.
- Mejorado el contraste de los textos cian (`text-shadow` sutil) contra el fondo oscuro.
- Verificado con Playwright (screenshots reales, no solo lectura de código) en desktop y mobile antes de entregar, incluyendo un fix de un bug de posicionamiento del grid que solo se detectó al renderizar.
- `server.js` no cambió. `public/room.html` no se tocó directamente pero hereda las mejoras de `.floaters` y `.osd-counter` por compartir `style.css`.

## [2026-08-16] V5 — Rediseño VHS/vaporwave, unirse por código y progreso real de carga

**Motivo:** exploración estética (reemplazo del look "cine análogo" de la V4) + dos mejoras de usabilidad pendientes en el roadmap: poder entrar a una sala sin el link completo, y ver el progreso real de la subida del video.

**Cambios:**
- Nuevo sistema de diseño "Videoclub": estética VHS/vaporwave — lluvia de fondo con emojis de cintas/CDs (`.floaters` + animación `rainFall`), horizonte con sol y grilla estilo synthwave (`.horizon`) en la pantalla de inicio, overlay de líneas de escaneo tipo CRT sobre toda la página.
- Paleta nueva: fondo morado casi negro (`#170b27`), rosa neón (`#ff2e9a`) como acento principal, cian (`#00e5ff`) para labels tipo "on-screen display", violeta (`#7b2ff7`) de apoyo, naranja (`#ff7a45`) solo en el sol decorativo.
- Tipografía nueva: Monoton (títulos), Space Grotesk (texto), VT323 (labels/código de sala, simula texto de videocasetera).
- Renombrados visuales: selector de archivo ahora es "Insertar cinta" (`.tape-slot`), botón de crear sala es "GRABAR SALA" (`.rec-btn`, con punto rojo de grabación), el host se muestra como "🎛 Control remoto" (antes "🎬 Operador"), cambiar película es "Cambiar cinta" (antes "Cambiar rollo"), código de sala se muestra en un contador tipo OSD (`.osd-counter`, antes `.ticket-stub`).
- **Nuevo: unirse a una sala por código.** `index.html` ahora tiene un input + botón "▶ ENTRAR" debajo del flujo de crear sala; verifica el código contra `GET /api/room/:id` (endpoint que ya existía en `server.js` desde la V1 pero no se usaba desde el frontend) y redirige a `/room/<código>` si existe. Sin cambios en `server.js` ni en la lógica de roles.
- **Nuevo: progreso real de subida.** Se cambió `fetch` por `XMLHttpRequest` en la subida del video (único cambio necesario para acceder a `xhr.upload.onprogress`), mostrando porcentaje en vivo y una barra de progreso (`.tape-progress`) en vez del texto genérico "Subiendo...". Resuelve un pendiente del roadmap.
- Archivos afectados: `public/index.html`, `public/room.html`, `public/style.css`. `server.js` no cambió.
- **Pendiente de esta sesión** (quedó sin hacer por falta de créditos, se completó después): actualizar `MEMORIA.md` y `CHANGELOG.md` para reflejar este rediseño — el código ya estaba commiteado y pusheado (`952125e`) pero la documentación seguía describiendo la V4.

## [2026-08-16] V4 — Rediseño visual: "Función privada"

**Motivo:** la interfaz original (fondo negro + acento rosa/magenta) era genérica, no tenía relación con el mundo del cine. Se pidió un estilo único.

**Cambios:**
- Nuevo sistema de diseño inspirado en cine análogo: boletos de entrada, rollos de película, tira de perforaciones (sprockets), letrero de marquesina.
- Paleta nueva: negro azulado de sala (`#0B0E14`), rojo marquesina (`#FF3B3F`), ámbar de bombilla (`#FFC857`), violeta nocturno como acento en detalles puntuales (`#8B5CF6`).
- Tipografía: Bebas Neue (títulos tipo marquesina), Work Sans (texto), JetBrains Mono (código de sala, etiquetas, timestamps).
- Nuevo archivo `public/style.css` — se extrajeron los estilos que antes vivían inline en cada HTML a una hoja compartida.
- El código de sala ahora se muestra como un "boleto" (`ticket-stub`) con botón de copiar link.
- El botón de crear sala ahora es un boleto con borde perforado ("Empezar función").
- Renombrado en la interfaz (solo texto visible, no en el código): "host" → "🎬 Operador", "Cambiar película" → "Cambiar rollo", "Crear sala" → "Empezar función".
- Loader de subida cambiado de texto plano a un pequeño spinner circular tipo rollo girando.
- Archivos afectados: `public/style.css` (nuevo), `public/index.html`, `public/room.html`. `server.js` no cambió — sigue sirviendo `public/` como estático, así que `style.css` se sirve solo.

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