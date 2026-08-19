# 🧠 MEMORIA DEL PROYECTO — MovieNight

Este archivo es un resumen de contexto para retomar el desarrollo en cualquier momento (por ti mismo o pegándoselo a una IA). Explica qué es el proyecto, cómo está armado, qué decisiones se tomaron y por qué, y qué falta.

Última actualización: 18 de agosto de 2026 (fix: el teclado activaba por error el layout de landscape angosto en vertical).

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
    index.html            # Pantalla para crear sala (subir video) o unirse por código
    library.html            # Biblioteca de cintas: lista videos ya subidos, permite usarlos o borrarlos (V6)
    room.html              # Pantalla de la sala: reproductor, chat, controles
    style.css                # Estilos compartidos por las 3 pantallas
    uploads/                # Videos subidos (NO se sube a git, se genera solo)
  README.md               # Documentación de uso/instalación
  MEMORIA.md              # Este archivo
```

## 4. Modelo de datos (en memoria, server.js)

```js
rooms = {
  [roomId]: {
    videoFile: '/uploads/xxxx.mp4',
    subtitleFile: '/uploads/xxxx.vtt' | null,
    viewers: number,
    hostToken: 'string secreta',
    passwordHash: 'sha256 hex' | null,           // null = sala sin contraseña
    mutedUserIds: Set<userId>,                     // por userId persistente, no por socket.id (V7)
    userNames: Map<socketId, username>,
    bufferingSockets: Set<socketId>,               // quién está buffereando ahora mismo (V7)
    recentDisconnects: Map<userId, { timer, username }>  // margen de 15s para reconexiones (V7)
  }
}
```

- `roomId`: 6 caracteres hex, generado con `crypto.randomBytes(3)`.
- `hostToken`: 32 caracteres hex, generado al crear la sala. Se manda al cliente creador y se guarda en `localStorage` (`mn_host_<roomId>`). Es la única forma de identificar quién es host — no hay login ni cuentas de usuario. Desde V7 también se puede recibir en caliente vía socket (`host-status`) si alguien recibe el control remoto sin haber creado la sala (traspaso automático o manual, ver sección 5bis).
- `passwordHash` (V7): opcional. Si está seteado, `join-room` exige que el cliente mande la contraseña en texto plano por socket; el servidor la hashea (`sha256`) y compara. No hay salt por usuario — es una protección básica pensada para un grupo de amigos, no para resistir ataques serios (ver sección 9).
- `userId` (V7): identificador persistente generado en el cliente (`crypto.randomUUID()`, guardado en `localStorage` como `mn_uid`, uno solo por navegador — no por sala). Se manda en cada `join-room` y es lo que permite que el estado de "silenciado" y la supresión de mensajes de reconexión sobrevivan a un refresh o a una caída de wifi. Es distinto de `socket.id`, que cambia en cada conexión.

## 5. Sistema de roles (host vs invitado) — IMPORTANTE

Esto se agregó después de la primera versión, a pedido explícito: solo el host puede controlar el video, y necesita poder expulsar/silenciar gente.

- Al hacer `join-room`, el cliente manda `{ roomId, username, hostToken }`. El servidor compara `hostToken` contra el guardado en la sala; si coincide, `socket.isHost = true`.
- **Cualquier socket que presente el hostToken correcto se vuelve host** (no hay un solo "host socket" fijo) — esto es intencional para que el creador pueda abrir varias pestañas/dispositivos y seguir teniendo control, pero significa que si el hostToken se filtra, cualquiera puede volverse host. No hay protección adicional contra esto (ver sección de riesgos).
- Eventos `sync` (play/pause/seek) del backend **solo se retransmiten si vienen de un socket con `isHost = true`**.
- En el frontend (`room.html`), a los no-host se les quita el atributo `controls` del `<video>`, y se bloquea cualquier intento de mover el `currentTime` manualmente (evento `seeking` lo revierte a `lastKnownTime`). Esto se agregó porque un invitado logró adelantar el video sin querer desde el celular.
- Se agregó un **heartbeat**: el host manda su posición cada 4 segundos (`type: 'heartbeat'`) para resincronizar a todos aunque no haya pausado/adelantado nada — corrige drift por buffering o lag.
- El host puede **expulsar** (`kick-user`) y **silenciar el chat** (`toggle-mute`) a otros usuarios desde la pestaña "Espectadores" en `room.html`. El silencio es solo de chat, no de audio/video (cada quien controla su propio volumen localmente, no hay forma de silenciar el audio de otro ya que no comparten audio entre sí).
- El host puede **cambiar la película** en cualquier momento sin cerrar la sala (`POST /room/:id/change-video`, protegido por `hostToken` en el body), o reutilizar un video ya subido desde la biblioteca (`POST /room/:id/change-video-from-upload`, ver sección 8quater).

## 5bis. Traspaso de host (V7)

Antes, si el host cerraba la pestaña o se le caía la conexión, nadie más podía controlar el video — la sala quedaba "congelada" salvo que el host volviera a entrar desde el mismo navegador (el único que tiene el `hostToken` en `localStorage`).

- **Automático**: en el handler de `disconnect` del servidor, si el socket que se fue era host y no queda ningún otro socket host conectado en esa sala, se asciende automáticamente al espectador que lleva más tiempo conectado (primero en el `Set` de sockets de la sala, que en Socket.io conserva el orden de inserción). Al nuevo host se le manda el `hostToken` real por el evento `host-status`, así queda guardado en su `localStorage` y sigue siendo host aunque recargue la página.
- **Manual**: el host puede darle el control a cualquier espectador desde el panel "Sala" → botón "Hacer host" (evento `make-host`). Esto **no le quita** el rol de host a quien lo dio — sigue existiendo la misma regla de V2: cualquier socket con el `hostToken` correcto es host, así que ahora simplemente hay dos.
- En ambos casos se manda un mensaje de sistema al chat avisando quién es el nuevo host.
- Esto resuelve el primer ítem del roadmap ("traspasar el rol de host a otro espectador si el host se desconecta").

## 6. Sincronización de video — cómo funciona

Eventos de socket relevantes (todos dentro del namespace default, agrupados por `roomId` con `socket.join(roomId)`):

| Evento | Quién lo emite | Qué hace |
|---|---|---|
| `join-room` | cliente al entrar | Une el socket a la sala, determina si es host, actualiza contadores |
| `sync` | host (play/pause/seek/heartbeat) | Se retransmite a todos los demás en la sala |
| `chat-message` | cualquier cliente no silenciado | Se retransmite a toda la sala |
| `reaction` | cualquier cliente | Se retransmite a toda la sala (emoji flotante) |
| `kick-user` | solo host | Servidor fuerza `disconnect()` del socket objetivo |
| `toggle-mute` | solo host | Agrega/quita del `Set` de silenciados (por `userId`), notifica al afectado |
| `make-host` | solo host (V7) | Asciende a otro socket a host y le manda el `hostToken` |
| `buffering-status` | cualquier cliente (V7) | Marca/desmarca a ese socket como "buffereando" para la sala |
| `typing` | cualquier cliente (V7) | Se retransmite a los demás para el indicador "X está escribiendo..." |
| `room-data` | servidor, tras un `join-room` válido (V7) | Manda `videoFile` y `subtitleFile` — reemplaza al fetch a `/api/room/:id` que existía antes de V7 |
| `subtitle-changed` | servidor (V7) | Avisa a todos que hay un `.vtt` nuevo para el `<track>` del video |
| `viewer-list` | servidor (broadcast) | Se manda cada vez que cambia la sala (join/leave/mute/buffering) |

En el cliente, hay una variable `ignoreSync` que evita loops infinitos: cuando el reproductor recibe un evento de sync remoto y cambia `currentTime`/play/pause, se pone `ignoreSync = true` por 200-300ms para no re-emitir ese mismo cambio como si fuera una acción del usuario.

**Botones de salto ±10s (V7)**: visibles solo para el host, en `room.html`. Simplemente mueven `player.currentTime`, lo que dispara el evento nativo `seeked` — no necesitan lógica de sync propia, reutilizan el mismo camino que mover la barra de progreso nativa.

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

### 8.2 Pulido visual V5.2 (mismo día, feedback sobre V5.1)

Ajustes puntuales pedidos tras ver V5.1 en vivo: los objetos cayendo seguían chicos, y el título pedía verse "más vivo, como letras reales, con los bordes marcados" (efecto 3D/extrusión) y más iluminado.

- **Floaters más grandes**: tamaños en `public/index.html` subidos de rango `16px–34px` a rango `26px–54px` (solo en la pantalla de inicio; los del panel lateral de `room.html` no se tocaron).
- **Título "MOVIE NIGHT" con efecto de extrusión/relieve 3D**: se le agregaron capas de `text-shadow` escalonadas en diagonal (blanco tenue arriba-izquierda simulando luz, violeta y morado oscuro hacia abajo-derecha) detrás del degradado rosa-cian existente, para dar sensación de letras con grosor real en vez de texto plano. Se afinó dos veces: la primera versión (offsets más grandes, 6 capas) tapaba el degradado y se veía como un bloque morado sólido — se redujo a offsets más chicos (máx. ~4.5px) y menos capas para que el relieve se note sin perder el color ni el brillo.
- **Más brillo + parpadeo de neón**: se subió la intensidad del `drop-shadow` (glow) del título y se agregó `@keyframes neonFlicker`, una animación de 5s que simula el parpadeo sutil de un letrero de neón real (un flicker tenue y después un destello más fuerte, muy espaciado, no es molesto).
- Archivo afectado: solo `public/style.css` (clase `.marquee-title` + `@keyframes neonFlicker`) y `public/index.html` (tamaños inline de `.floater`).
- Verificado con capturas reales (Playwright, desktop y mobile) antes de entregar, incluyendo una iteración intermedia descartada por verse mal.

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

## 8quater. Biblioteca de cintas (V6) — reusar videos ya subidos

Antes, cada video subido quedaba "atrapado" dentro de la sala que lo creó: no había forma de reutilizarlo para una sala nueva sin volver a subir el archivo entero (lento con archivos de varios GB). Se agregó una pantalla nueva, `public/library.html`, accesible desde un link en `index.html` ("📼 Ver biblioteca de cintas subidas").

- **Backend (`server.js`), 3 rutas nuevas**:
  - `GET /api/uploads` — lee `public/uploads/` con `fs.readdir` y devuelve un JSON con cada video (`filename`, `displayName`, `size`, `mtime`), filtrado por extensión (`.mp4 .mkv .mov .webm .avi .m4v`) y ordenado por fecha descendente. No depende de las salas en memoria — lee directo del disco, así que sobrevive a reinicios del servidor.
  - `POST /create-room-from-upload` (body JSON `{ filename }`) — crea una sala igual que `POST /create-room`, pero reutilizando un archivo que ya existe en vez de recibir uno por `multer`. Devuelve `{ roomId, hostToken }` igual que siempre.
  - `DELETE /api/uploads/:filename` — borra el archivo del disco con `fs.unlink`.
  - Las tres rutas comparten `isValidUploadFilename()`, que valida que el nombre no tenga separadores de ruta ni `..` y que el archivo exista dentro de `UPLOAD_DIR` — evita path traversal (ej. `../../server.js`). Probado explícitamente con Playwright antes de entregar.
- **Nombres de archivo más amigables**: el `filename` que genera Multer cambió de `<hash>.mp4` a `<hash-corto>__<nombre original sanitizado>.mp4` (ej. `b0db5e9e__Mi Pelicula Favorita.mp4`). La biblioteca separa el hash del nombre original (`displayNameFor()`) para mostrar solo el nombre reconocible. **Los videos subidos antes de este cambio no tienen el separador `__`**, así que en la biblioteca se muestran con su nombre-hash tal cual (ej. `ce1e9f8848137671.mp4`) — es cosmético, siguen funcionando igual.
- **Frontend (`public/library.html`)**: pantalla nueva con el mismo sistema de diseño VHS (`.deck.deck-wide`, esquinas, contador REC, horizonte). Lista cada video con ícono, nombre, tamaño formateado (KB/MB/GB) y fecha, más dos botones: "▶ USAR" (llama a `create-room-from-upload`, guarda el `hostToken` en `localStorage` igual que el flujo normal, y redirige a `/room/<id>`) y "🗑" (con `confirm()` antes de borrar). Estados de carga/vacío incluidos. Responsive: en pantallas angostas (`≤480px`) los botones bajan a una segunda fila para no apretar el nombre del archivo.
- **Nueva clase compartida en `style.css`**: `.deck.deck-wide` (620px en vez de 380px) para que la lista tenga espacio; `.tape-list`, `.tape-item` y variantes para los botones de acción.
- **Riesgo conocido, ya anotado en la sección 9**: borrar un video que está siendo usado por una sala activa rompe el reproductor de esa sala (el archivo deja de existir en `/uploads/`). No hay ninguna advertencia de "este video está en uso" — queda pendiente si se vuelve un problema real.
- Verificado end-to-end con Playwright: subida con nombre real → aparece en la biblioteca con ese nombre → botón "USAR" crea la sala y redirige → botón "🗑" borra el archivo del disco (confirmado con `ls`) → intento de path traversal rechazado con 400.

## 8quinquies. Contraseña de sala (V7)

Al crear una sala (desde `index.html`) hay un campo opcional "Contraseña de la sala". Si se llena:

- El servidor guarda `sha256(password)` en `room.passwordHash` — nunca la contraseña en texto plano, y sin salt por sala (protección básica, ver riesgos).
- `GET /api/room/:id` ahora solo devuelve `{ passwordProtected: true|false }`. Antes de V7 devolvía también `videoFile`, lo cual exponía la ruta real del video sin verificar nada — se movió esa información a después de un `join-room` válido (evento `room-data`).
- En `room.html`, si `passwordProtected` es `true`, se pide la contraseña con un `prompt()` antes de conectar el socket. Si es incorrecta, el servidor manda `room-error: 'Contraseña incorrecta.'` y el cliente vuelve a preguntar (no expulsa a la primera).
- La biblioteca (`create-room-from-upload`) no tiene campo de contraseña en esta versión — quedó fuera de alcance por simplicidad; si se necesita, es un cambio chico (agregar el mismo input en `library.html`).

## 8sexies. Subtítulos .srt/.vtt (V7)

- El host sube un archivo `.srt` o `.vtt` desde el panel "Sala" en `room.html` → `POST /room/:id/upload-subtitle` (protegido por `hostToken`, multer en memoria, máx. 5MB).
- Si es `.srt`, el servidor lo convierte a WebVTT con una transformación mínima: agrega la cabecera `WEBVTT` y cambia el separador decimal de los timestamps de coma a punto (`00:00:01,000` → `00:00:01.000`). No es un parser completo de SRT, pero cubre el formato estándar.
- Se guarda como `<hash>.vtt` en `public/uploads/` (no aparece en la biblioteca porque el filtro de `GET /api/uploads` solo lista extensiones de video).
- El servidor guarda la ruta en `room.subtitleFile` y avisa a todos los clientes conectados (`subtitle-changed`) para que agreguen/reemplacen el `<track>` del `<video>` en vivo, sin recargar.
- Si se sube un subtítulo nuevo, el anterior de esa sala se borra del disco (best-effort, no rompe nada si falla).

## 8septies. Fix: el teclado móvil empujaba el video fuera de pantalla

**El problema:** en `room.html`, `.room-scene` usaba `height: 100vh`. En Chrome/Android, `100vh` se calcula sobre el alto de pantalla completa **sin descontar el teclado**, y no se achica cuando el teclado aparece. Al tocar el campo de chat, el navegador intenta llevar el input enfocado a la vista y, como `.room-scene` seguía "creyendo" que medía la pantalla completa, terminaba scrolleando toda la sala hacia arriba — el video (arriba de todo en el layout apilado de celular) se iba literalmente fuera de la pantalla.

**Fix, en 3 capas (de más a menos compatible, cada una pisa a la anterior si el navegador la soporta):**
1. **`interactive-widget=resizes-content`** agregado al `<meta name="viewport">` de las 3 páginas. Le pide explícitamente al navegador (Chrome 108+) que redimensione el viewport de layout cuando aparece el teclado, en vez de solo "taparlo" — es la solución de raíz cuando el navegador la soporta.
2. **`height: 100dvh`** como capa intermedia en `.room-scene` (con `100vh` de respaldo antes, para navegadores que no reconocen `dvh` — la declaración inválida se ignora entera y queda el `vh`).
3. **`--app-height`, manejado por JS en `room.html`**, como capa final y más confiable: escucha `window.visualViewport.resize` (y `resize`/`orientationchange` de respaldo) y guarda el alto real visible en una custom property. `.room-scene` usa `height: calc(var(--app-height, 100vh))` como última declaración, que gana si JS ya corrió, y cae a `100vh` si todavía no.
- Además, en la media query de celular en vertical, `.screen-wrap` (el video) pasó de `flex: none; aspect-ratio: 16/9` (rígido, no cede espacio) a `flex: 1 1 auto` con `min-height: 100px` y `max-height: 45dvh`(/`45vh` de respaldo) — así, si el espacio se aprieta mucho, el video se achica con gracia en vez de forzar que el chat desaparezca.
- Se sacó una regla vieja (`@media (max-width:480px) { .room-scene { height:auto } }`, agregada en un fix anterior como parche) que hubiera pisado este arreglo en la mayoría de los celulares — quedó obsoleta con la solución real.
- **Verificado con Playwright simulando la apertura del teclado** (achicando el viewport a mano, ya que un navegador headless no despliega teclado real): con una proporción de teclado realista (~34% del alto de pantalla, similar a Gboard en un Pixel 7), `.room-scene` se ajusta al alto visible real y tanto el video como el campo de chat enfocado quedan dentro de la zona visible, sin salirse de pantalla. También se confirmó que no hay regresión en desktop ni en landscape angosto de celular.
- **Limitación conocida del testing**: Playwright/Chromium headless no renderiza un teclado virtual real, así que esto se probó simulando el achique de viewport que el teclado causaría — no hay forma de probar 100% automatizado el comportamiento exacto de un teclado nativo de Android. Si en un celular real se ve algún caso raro, lo más probable es un navegador/versión que no soporte `interactive-widget` ni `visualViewport` (muy poco común hoy).

## 8octies. Fix: el teclado activaba por error el layout de "landscape angosto" en vertical

**El problema:** era una regresión indirecta del fix anterior (8septies). El layout apilado (video
arriba, chat abajo) vs. el layout de fila (video + chat al costado, pensado para cuando el celular
está físicamente acostado y con poco alto) se elegía en CSS puro con `min-height: 500px` /
`max-height: 499px` sobre el viewport. El problema: `interactive-widget=resizes-content` (agregado
en 8septies) hace que abrir el teclado *también* achique esa altura visible — así que al escribir en
el chat con el celular parado, el viewport visible caía debajo de 500px y la media query pensaba
que estaba en landscape angosto, activando el layout de fila (video comprimido a un lado, chat
ocupando casi la mitad de la pantalla) en medio de una sesión normal en vertical. Reproducible en
cualquier celular por igual, porque no depende del hardware sino de que el teclado angosta el
viewport de la misma forma en todos.

**Fix:** dejar de elegir el layout según cuánto espacio visible queda (afectado por el teclado) y
elegirlo según la **orientación real del dispositivo** (no afectada por el teclado):

- En `room.html`, `updateOrientationClass()` lee `window.matchMedia('(orientation: landscape)')` y
  agrega/saca la clase `device-landscape` en `<html>`. Se llama una vez al cargar la página y **solo
  se vuelve a calcular en el evento `orientationchange`** — que dispara una rotación física real del
  celular. Abrir/cerrar el teclado dispara `resize` y `visualViewport.resize`, pero nunca
  `orientationchange`, así que ya no puede confundir esto (a diferencia de `setAppHeight()`, que sí
  debe reaccionar a esos eventos porque su trabajo es justamente reflejar el alto visible real).
- En `style.css`, las dos media queries que antes usaban `min-height`/`max-height` ahora usan
  `html:not(.device-landscape)` (layout apilado, el caso normal) y `html.device-landscape` (layout
  de fila, solo para landscape angosto real), ambas todavía dentro de `max-width: 820px` para no
  afectar escritorio.
- `--app-height` (8septies) sigue haciendo su trabajo sin cambios: decide cuánto espacio visible hay
  disponible. Esta sección solo decide fila vs. columna. Las dos cosas ahora están desacopladas.
- **Limitación conocida:** si el navegador no soporta `matchMedia('(orientation: ...)')` (rarísimo
  hoy), la clase nunca se agrega y el layout apilado queda como default — que es el comportamiento
  correcto para el caso mucho más común (celular en vertical), así que el fallback es seguro.
- **No se pudo probar con un navegador real en este entorno** (sin Chromium disponible para
  Playwright ni acceso de red para descargarlo) — se validó revisando a mano la lógica de CSS/JS.
  Recomendado confirmar en un celular real, sobre todo el caso de landscape angosto real (celular
  acostado) para asegurarse de que `device-landscape` se siga agregando correctamente ahí.

## 9. Riesgos / cosas pendientes de endurecer (seguridad)

- El `hostToken` viaja en texto plano por HTTP (a menos que Cloudflare Tunnel lo cifre en tránsito, que sí lo hace vía HTTPS). Si alguien lo obtiene (inspeccionando `localStorage` de la persona equivocada, por ejemplo), puede hacerse pasar por host.
- La contraseña de sala (V7) usa `sha256` sin salt — suficiente para que alguien con el link no entre "sin querer", pero no es resistente a un atacante que se lo proponga en serio (sin rate-limiting en `join-room`, se podría probar contraseñas por fuerza bruta contra el socket). Dado el caso de uso (grupo de amigos), se consideró un trade-off aceptable.
- No hay rate-limiting en el chat, en `join-room`, ni en la subida de archivos — un usuario malicioso podría floodear el chat, probar contraseñas repetidamente, o intentar subir archivos gigantes repetidamente.
- No hay validación de tipo de archivo más allá de lo que el navegador manda como `video/*` en el `<input accept>` (o la extensión `.srt`/`.vtt` para subtítulos) — no es una validación real de seguridad, solo de UX.
- Las salas nunca se borran ni expiran — si el server corre mucho tiempo, `rooms` y los archivos en `uploads/` se van acumulando. (Ahora al menos se pueden borrar a mano fácil desde `library.html`, ver sección 8quater.)
- Borrar un video desde `library.html` mientras una sala activa lo está usando rompe esa sala sin avisar (ver 8quater) — sigue sin resolverse en V7.
- El traspaso automático de host (sección 5bis) elige al espectador que lleva más tiempo conectado sin ningún otro criterio (no hay forma de "vetar" a alguien de ser host automático). Improbable que sea un problema real dado que es para grupos de amigos, pero queda anotado.

## 10. Ideas pendientes / roadmap

- [ ] Borrado automático de salas/archivos viejos (ej. después de X horas sin actividad).
- [ ] Dominio fijo con Cloudflare Tunnel nombrado (requiere cuenta de Cloudflare + dominio propio) para no tener que compartir un link nuevo cada sesión.
- [ ] Posible: avisar si se intenta borrar un video que está en uso por una sala activa.
- [ ] Posible: contraseña también al reutilizar un video desde la biblioteca (`create-room-from-upload`), hoy solo existe al crear desde `index.html`.
- [ ] Posible: rate-limiting real en `join-room` (intentos de contraseña) y en la subida de archivos.
- [ ] Evaluado y descartado por ahora (no encaja con el caso de uso de grupo privado chico): video/voz en vivo integrado tipo Scener/Kast, soporte para reproducir desde plataformas externas (Netflix/YouTube/etc.).
- [x] ~~Mostrar advertencia/loading mientras el video sube~~ — resuelto en V5 con barra de progreso real (ver sección 8ter).
- [x] ~~Reutilizar videos ya subidos sin tener que resubirlos~~ — resuelto en V6 con la biblioteca de cintas (ver sección 8quater).
- [x] ~~Traspasar el rol de host a otro espectador~~ — resuelto en V7, automático y manual (ver sección 5bis).
- [x] ~~Subtítulos (.srt) sincronizados~~ — resuelto en V7 (ver sección 8sexies).
- [x] ~~Contraseña de sala además del link~~ — resuelto en V7 (ver sección 8quinquies).
- [x] ~~El botón de "Cambiar cinta" debería llevar a la biblioteca~~ — resuelto en V7: ahora enlaza a `/library.html?fromRoom=<roomId>`, que además permite subir una cinta completamente nueva sin perder esa opción.
- [x] ~~Botón de "Salir" para volver al inicio y unirse a otra sala~~ — resuelto en V7.
- [x] ~~El teclado móvil empuja el video fuera de pantalla al escribir en el chat~~ — resuelto (ver sección 8septies).

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