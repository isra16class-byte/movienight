# 🧠 MEMORIA DEL PROYECTO — MovieNight

Este archivo es un resumen de contexto para retomar el desarrollo en cualquier momento (por ti mismo o pegándoselo a una IA). Explica qué es el proyecto, cómo está armado, qué decisiones se tomaron y por qué, y qué falta.

Última actualización: 16 de agosto de 2026 (pulido visual V5.1).

---

## 1. Qué es

Watch party privado para ver películas con amigos. Es una app web (no nativa) hecha con **Node.js + Express + Socket.io**. El dueño de la sala ("host") sube un archivo de video desde su compu, se genera un link/código de sala, y sus amigos entran desde el navegador (compu o celular) — con el link completo o pegando el código de 6 caracteres — a ver el video sincronizado, con chat y reacciones.

Repo: `https://github.com/isra16class-byte/movienight`

## 2. Stack y por qué

- **Backend**: Node + Express (servidor HTTP simple) + Socket.io (tiempo real: sync de video, chat, presencia).
- **Subida de archivos**: Multer, guardando en disco local (`public/uploads/`), servido como estático.
- **Frontend**: HTML/CSS/JS vanilla, sin framework — el proyecto es chico y no lo justifica.
- **Sin base de datos**: las salas viven en un objeto en memoria (`rooms` dentro de `server.js`). Se pierden si el servidor se reinicia. Fue una decisión consciente por simplicidad, dado el uso personal/casual.
- **Exposición a internet**: no hay hosting propio. Se usa **Cloudflare Tunnel** (`cloudflared tunnel --url http://localhost:3000`) para exponer el servidor local cuando los amigos están fuera de la red. Se eligió sobre ngrok porque el plan gratis de ngrok corta la sesión a las ~2 horas (justo la duración de una peli), y Cloudflare Tunnel no tiene ese límite.

## 3. Estructura de archivos

```
movienight/
  server.js              # Todo el backend: rutas HTTP + lógica de sockets
  package.json
  public/
    index.html            # Pantalla para crear sala (subir video)
    room.html              # Pantalla de la sala: reproductor, chat, controles
    uploads/                # Videos subidos (NO se sube a git, se genera solo)
  README.md               # Documentación de uso/instalación
  MEMORIA.md              # Este archivo
```

## 4. Modelo de datos (en memoria, server.js)

```js
rooms = {
  [roomId]: {
    videoFile: '/uploads/xxxx.mp4',
    viewers: number,
    hostToken: 'string secreta',
    mutedUsers: Set<socketId>,
    userNames: Map<socketId, username>
  }
}
```

- `roomId`: 6 caracteres hex, generado con `crypto.randomBytes(3)`.
- `hostToken`: 32 caracteres hex, generado al crear la sala. Se manda al cliente creador y se guarda en `localStorage` (`mn_host_<roomId>`). Es la única forma de identificar quién es host — no hay login ni cuentas de usuario.

## 5. Sistema de roles (host vs invitado) — IMPORTANTE

Esto se agregó después de la primera versión, a pedido explícito: solo el host puede controlar el video, y necesita poder expulsar/silenciar gente.

- Al hacer `join-room`, el cliente manda `{ roomId, username, hostToken }`. El servidor compara `hostToken` contra el guardado en la sala; si coincide, `socket.isHost = true`.
- **Cualquier socket que presente el hostToken correcto se vuelve host** (no hay un solo "host socket" fijo) — esto es intencional para que el creador pueda abrir varias pestañas/dispositivos y seguir teniendo control, pero significa que si el hostToken se filtra, cualquiera puede volverse host. No hay protección adicional contra esto (ver sección de riesgos).
- Eventos `sync` (play/pause/seek) del backend **solo se retransmiten si vienen de un socket con `isHost = true`**.
- En el frontend (`room.html`), a los no-host se les quita el atributo `controls` del `<video>`, y se bloquea cualquier intento de mover el `currentTime` manualmente (evento `seeking` lo revierte a `lastKnownTime`). Esto se agregó porque un invitado logró adelantar el video sin querer desde el celular.
- Se agregó un **heartbeat**: el host manda su posición cada 4 segundos (`type: 'heartbeat'`) para resincronizar a todos aunque no haya pausado/adelantado nada — corrige drift por buffering o lag.
- El host puede **expulsar** (`kick-user`) y **silenciar el chat** (`toggle-mute`) a otros usuarios desde la pestaña "Espectadores" en `room.html`. El silencio es solo de chat, no de audio/video (cada quien controla su propio volumen localmente, no hay forma de silenciar el audio de otro ya que no comparten audio entre sí).
- El host puede **cambiar la película** en cualquier momento sin cerrar la sala (`POST /room/:id/change-video`, protegido por `hostToken` en el body).

## 6. Sincronización de video — cómo funciona

Eventos de socket relevantes (todos dentro del namespace default, agrupados por `roomId` con `socket.join(roomId)`):

| Evento | Quién lo emite | Qué hace |
|---|---|---|
| `join-room` | cliente al entrar | Une el socket a la sala, determina si es host, actualiza contadores |
| `sync` | host (play/pause/seek/heartbeat) | Se retransmite a todos los demás en la sala |
| `chat-message` | cualquier cliente no silenciado | Se retransmite a toda la sala |
| `reaction` | cualquier cliente | Se retransmite a toda la sala (emoji flotante) |
| `kick-user` | solo host | Servidor fuerza `disconnect()` del socket objetivo |
| `toggle-mute` | solo host | Agrega/quita del `Set` de silenciados, notifica al afectado |
| `viewer-list` | servidor (broadcast) | Se manda cada vez que cambia la sala (join/leave/mute) |

En el cliente, hay una variable `ignoreSync` que evita loops infinitos: cuando el reproductor recibe un evento de sync remoto y cambia `currentTime`/play/pause, se pone `ignoreSync = true` por 200-300ms para no re-emitir ese mismo cambio como si fuera una acción del usuario.

## 7. Decisiones de diseño relevantes (por qué se hizo así)

- **Sin base de datos ni persistencia**: el proyecto es para uso personal/casual, no vale la pena la complejidad de Postgres/SQLite para algo que se usa unas horas y se apaga.
- **Sin sistema de cuentas**: entrar a la sala solo pide un nombre (prompt de JS), no hay registro. El "host" se identifica solo por posesión del token, no por login.
- **Video servido desde el propio servidor** (no WebRTC / P2P): se consideró pero se descartó por complejidad — sincronizar streams P2P de video pesado entre navegadores es mucho más difícil que simplemente servir el archivo por HTTP y sincronizar solo los eventos de control (play/pause/seek) por WebSocket. La contra es que el ancho de banda de subida del host limita cuántos amigos pueden ver fluido a la vez.
- **Cloudflare Tunnel en vez de deploy real (Railway/Render/VPS)**: los videos pueden pesar varios GB; subirlos a un servicio de hosting pago sale caro y lento cada vez que cambias de película. Tunear el localhost es gratis y usa el disco/ancho de banda del propio usuario.

## 8. Sistema de diseño (V5 — "Videoclub" VHS/vaporwave)

Dirección visual actual: estética VHS/videoclub y vaporwave de los 80/90 (cintas, casetes, CDs, horizonte con sol y grilla estilo synthwave, líneas de escaneo tipo CRT). Reemplazó al diseño anterior V4 ("función privada de cine análogo": boletos, rollos, marquesina), que a su vez había reemplazado el diseño original sin tema. Cada rediseño se hizo por gusto/exploración estética, no por un problema funcional.

- **Archivo**: `public/style.css` — sigue siendo el único archivo de estilos, compartido entre `index.html` y `room.html`, con tokens en `:root`.
- **Paleta** (variables en `:root` de `style.css`): `--bg` (`#170b27`, morado casi negro), `--pink` (`#ff2e9a`, acento principal — botones, badge de host, elementos "grabando"), `--cyan` (`#00e5ff`, labels tipo OSD/pantalla de videocasetera, hovers), `--violet` (`#7b2ff7`, apoyo), `--sun` (`#ff7a45`, usado solo en el degradado del sol del horizonte decorativo).
- **Tipografía**: `--font-display` (Monoton — títulos grandes, look de letrero de neón), `--font-body` (Space Grotesk — texto normal), `--font-osd` (VT323 — simula la tipografía de "on-screen display" de una videocasetera/TV vieja; se usa en labels, código de sala, contador).
- **Elementos firma**:
  - `.floaters` + `@keyframes rainFall`: una "lluvia" de emojis (📼💿🎞️📀) cayendo de fondo, distintos en `index.html` (pantalla completa) y en el panel lateral de `room.html` (más sutil).
  - `.horizon` / `.sun` / `.grid`: horizonte decorativo con sol y grilla en perspectiva (estética synthwave/outrun), solo en la pantalla de inicio.
  - `body::after` con `repeating-linear-gradient`: overlay de líneas de escaneo (CRT) sobre toda la página.
  - `.tape-slot` (antes `.film-drop`): selector de archivo con forma de ranura de videocasetera. `.rec-btn` (antes `.ticket-btn`): botón de crear sala con punto rojo de "grabando". `.osd-counter` (antes `.ticket-stub`): código de sala mostrado como contador de videocasetera, con botón de copiar.
- **Vocabulario de interfaz** (solo texto visible): "Insertar cinta" (elegir archivo), "GRABAR SALA" (crear sala), "🎛 Control remoto" (host, antes "🎬 Operador"), "Cambiar cinta" (cambiar video, antes "Cambiar rollo"). El backend sigue usando `host`, `create-room`, `change-video` sin cambios.
- **Fuentes por CDN** (Google Fonts) — mismo trade-off que antes: requiere internet la primera carga; para 100% offline/LAN habría que autohospedar los `.woff2`.

### 8.1 Pulido visual V5.1 (mismo día, sesión siguiente)

La V5 original quedó "correcta pero genérica" — los elementos temáticos (lluvia de cintas, horizonte, sol) apenas se notaban, y había un bug de legibilidad. Se ajustó sin cambiar la estructura HTML de fondo:

- **Bug arreglado**: el separador entre "crear sala" y "unirse con código" decía literalmente `O` en la fuente `--font-osd` (VT323), que renderiza el `O` casi idéntico a un `0` — confundía. Se cambió el texto a "o también" en `--font-body` (sin ambigüedad) y se sacó de la fuente monoespaciada.
- **Lluvia de fondo más visible**: opacidad máxima de los emojis flotantes subida de `0.24` a `0.65`, con doble `drop-shadow` (rosa + cian) para que se destaquen del fondo morado oscuro en vez de perderse.
- **Sol del horizonte con más presencia**: ahora tiene franjas horizontales (truco: `repeating-linear-gradient` con `var(--bg)` alternado sobre el `radial-gradient` del sol, recortado por el `border-radius:50%` del propio elemento) — el clásico "sol rayado" del vaporwave/synthwave, en vez de un círculo liso. Tamaño y opacidad subidos.
- **Grid del piso corregido**: el `perspective()` + `rotateX()` original comprimía la altura real del grid a casi nada (quedaba oculto debajo del viewport). Se ajustaron los valores (`perspective(650px) rotateX(72deg)`, `height:42%`, `bottom:0`) para que el piso de grilla synthwave sea visible de verdad en la parte baja de la pantalla, con un `mask-image` que lo desvanece hacia arriba.
- **Marco tipo visor de cámara**: 4 corner-brackets (`.deck-corner`, esquinas en L color cian) alrededor de la tarjeta principal — refuerza la idea de "grabando/encuadrando", común en overlays de cámaras/videocaseteras.
- **Contador REC**: un timestamp `REC 00:00` en la esquina superior de la tarjeta que corre en vivo (`setInterval` de 1s en el `<script>` de `index.html`) — puramente decorativo/ambiental, no tiene ningún efecto funcional ni se manda al servidor.
- **Textura de estática sutil**: `.deck::before` con un SVG de `feTurbulence` como `background-image` (ruido tipo "grano de cinta vieja"), opacidad muy baja (`0.05`) con `mix-blend-mode: overlay` — casi subliminal, da textura sin ensuciar la legibilidad.
- **Efecto "mal tracking" al pasar el mouse**: nueva clase reusable `.tracking-glitch` (aplicada a `.tape-slot`, `.rec-btn` y `.join-row`) — al hacer hover (o `:focus-within` en el caso del input), dispara una animación corta (`trackingGlitch`, 0.5s) de líneas horizontales cian + destello blanco con `clip-path` animado, simulando el glitch de una VHS con mal tracking. Es puramente CSS, sin JS.
- **Contraste mejorado**: los textos en `--font-osd` color `--cyan` (`.eyebrow-osd`, `.osd-counter-code`) ahora llevan `text-shadow` sutil en cian para que no se pierdan contra el fondo morado oscuro.
- Archivo afectado: solo `public/style.css` y `public/index.html` (agrega el contador REC, las esquinas y las clases `tracking-glitch`). `public/room.html` no cambió — hereda las mejoras de `.floaters`/`.osd-counter` automáticamente por compartir `style.css`.
- Verificado renderizando la página con Playwright en desktop (1400px) y mobile (390px) antes de entregar — sin overlaps ni cortes de texto.

## 8bis. Unirse por código (sin link completo)

Antes la única forma de entrar a una sala era con el link completo (`/room/<código>`). Ahora `index.html` tiene un segundo flujo, debajo del de crear sala:

- Un input de texto (`#joinCode`, máx. 6 caracteres) + botón "▶ ENTRAR".
- Al enviar, el cliente pega contra `GET /api/room/:id` (endpoint que ya existía en `server.js` desde la V1, pero no se usaba desde el frontend) para verificar que la sala exista antes de redirigir.
- Si la sala existe, redirige a `/room/<código>`; si no, muestra "Esa sala no existe. Revisa el código." sin redirigir.
- No cambia nada del backend ni de la lógica de roles — es puramente una forma alternativa de llegar al mismo link, útil cuando alguien te pasa el código de viva voz o por chat en vez de un link clicable.

## 8ter. Progreso real de subida

Antes, mientras se subía el video, solo se mostraba un texto genérico ("Subiendo tu película...") sin indicar cuánto faltaba. Ahora:

- Se cambió `fetch` por `XMLHttpRequest` en el botón de crear sala (`public/index.html`), porque `fetch` no expone progreso de subida de forma nativa y `xhr.upload.onprogress` sí.
- Se muestra un porcentaje en vivo (`Subiendo cinta... NN%`) y una barra de progreso visual (`.tape-progress` / `.tape-progress-bar`) que se llena en tiempo real según `event.loaded / event.total`.
- Esto resuelve el pendiente que estaba anotado en la sección de roadmap ("mostrar advertencia/loading mientras el video sube").

## 9. Riesgos / cosas pendientes de endurecer (seguridad)

- El `hostToken` viaja en texto plano por HTTP (a menos que Cloudflare Tunnel lo cifre en tránsito, que sí lo hace vía HTTPS). Si alguien lo obtiene (inspeccionando `localStorage` de la persona equivocada, por ejemplo), puede hacerse pasar por host.
- No hay rate-limiting en el chat ni en la subida de archivos — un usuario malicioso podría floodear el chat o intentar subir archivos gigantes repetidamente.
- No hay validación de tipo de archivo más allá de lo que el navegador manda como `video/*` en el `<input accept>` — no es una validación real de seguridad, solo de UX.
- Las salas nunca se borran ni expiran — si el server corre mucho tiempo, `rooms` y los archivos en `uploads/` se van acumulando.

## 10. Ideas pendientes / roadmap

- [ ] Traspasar el rol de host a otro espectador (si el host se desconecta, nadie puede controlar el video).
- [ ] Subtítulos (.srt) sincronizados.
- [ ] Borrado automático de salas/archivos viejos (ej. después de X horas sin actividad).
- [ ] Dominio fijo con Cloudflare Tunnel nombrado (requiere cuenta de Cloudflare + dominio propio) para no tener que compartir un link nuevo cada sesión.
- [ ] Posible: contraseña de sala además del link, para evitar que alguien con el link viejo entre sin querer.
- [x] ~~Mostrar advertencia/loading mientras el video sube~~ — resuelto en V5 con barra de progreso real (ver sección 8ter).

## 11. Historial de cambios

Ver `CHANGELOG.md` — ahí se registra cronológicamente cada cambio importante, versión por versión. Este archivo (`MEMORIA.md`) solo describe el estado **actual** del proyecto; se sobreescribe cada vez que la arquitectura cambia. El changelog, en cambio, se va acumulando (nunca se borra lo viejo).

---

**Para continuar el desarrollo**: lee este archivo primero, después revisa `CHANGELOG.md` para entender qué fue cambiando y por qué, y luego el código: `server.js` (backend/sockets) y `public/room.html` (toda la lógica de cliente vive ahí, incluyendo sync y controles de host). `public/index.html` es solo la pantalla de crear sala, cambia poco.

**Cada vez que hagas un cambio importante:**
1. Actualiza `MEMORIA.md` para que refleje el estado nuevo (no dejes info vieja mezclada con la nueva).
2. Agrega una entrada nueva arriba en `CHANGELOG.md` con la fecha y qué cambió.
3. Haz commit de ambos junto con el código:
   ```
   git add .
   git commit -m "Descripción del cambio"
   git push
   ```