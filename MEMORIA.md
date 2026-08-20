# 🧠 MEMORIA DEL PROYECTO — MovieNight

Este archivo es un resumen de contexto para retomar el desarrollo en cualquier momento (por ti mismo o pegándoselo a una IA). Explica qué es el proyecto, cómo está armado, qué decisiones se tomaron y por qué, y qué falta.

Última actualización: 20 de agosto de 2026 (fix: el modal de contraseña de biblioteca quedaba invisible en `localhost` al fallar la contraseña — carrera entre el `setTimeout` de ocultado del modal viejo y la apertura del modal nuevo; ver sección 8novodecies).

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
  .env.example             # Plantilla de variables de entorno (LIBRARY_PASSWORD, PORT) — sí se sube a git
  .env                    # Copia de lo anterior con valores reales (NO se sube a git, ver .gitignore)
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
    hostSocketId: socketId | null,                 // socket.id del host actual, única fuente de verdad (V8)
    passwordHash: 'sha256 hex' | null,           // null = sala sin contraseña
    mutedUserIds: Set<userId>,                     // por userId persistente, no por socket.id (V7)
    userNames: Map<socketId, username>,
    bufferingSockets: Set<socketId>,               // quién está buffereando ahora mismo (V7)
    recentDisconnects: Map<userId, { timer, username }>  // margen de 15s para reconexiones (V7)
  }
}
```

- `roomId`: 6 caracteres hex, generado con `crypto.randomBytes(3)`.
- `hostToken`: 32 caracteres hex, generado al crear la sala. Se manda al cliente creador y se guarda en `localStorage` (`mn_host_<roomId>`). Sigue siendo la credencial que prueba "puedo ser host" — no hay login ni cuentas de usuario. Desde V7 también se puede recibir en caliente vía socket (`host-status`) si alguien recibe el control remoto sin haber creado la sala (traspaso automático o manual, ver sección 5bis).
- `hostSocketId` (V8): a diferencia de `hostToken` (que es una credencial, no cambia), este campo dice quién es el host **ahora mismo** — el `socket.id` del único socket con `isHost = true` en la sala en un momento dado. Es la pieza que faltaba antes de V8: sin ella, presentar un `hostToken` válido alcanzaba para volverse host sin importar si ya había otro. Ver sección 5bis para el fix completo.
- `passwordHash` (V7): opcional. Si está seteado, `join-room` exige que el cliente mande la contraseña en texto plano por socket; el servidor la hashea (`sha256`) y compara. No hay salt por usuario — es una protección básica pensada para un grupo de amigos, no para resistir ataques serios (ver sección 9).
- `userId` (V7): identificador persistente generado en el cliente (`crypto.randomUUID()`, guardado en `localStorage` como `mn_uid`, uno solo por navegador — no por sala). Se manda en cada `join-room` y es lo que permite que el estado de "silenciado" y la supresión de mensajes de reconexión sobrevivan a un refresh o a una caída de wifi. Es distinto de `socket.id`, que cambia en cada conexión.
- `LIBRARY_PASSWORD` (V9): **no** es un campo de `rooms` — es una única contraseña a nivel de todo el servidor (no por sala), guardada en una variable de módulo (`libraryPasswordHash`), que protege `GET /api/uploads` y `DELETE /api/uploads/:filename` (ver sección 8septendecies). Se lee de la variable de entorno del mismo nombre; si no está definida, se genera una al azar en cada arranque y se imprime por consola.

## 5. Sistema de roles (host vs invitado) — IMPORTANTE

Esto se agregó después de la primera versión, a pedido explícito: solo el host puede controlar el video, y necesita poder expulsar/silenciar gente.

- Al hacer `join-room`, el cliente manda `{ roomId, username, hostToken }`. El servidor compara `hostToken` contra el guardado en la sala; si coincide, pasa por `setHost()` (V8, ver sección 5bis) y ese socket se vuelve host.
- **Solo puede haber un host a la vez por sala** (V8). Antes de V8, cualquier socket que presentara el `hostToken` correcto se volvía host sin más chequeo — lo cual causaba hosts duplicados en varios escenarios (ver 5bis). Ahora `room.hostSocketId` guarda quién es el host actual, y `setHost()` es el único lugar que puede cambiarlo: siempre degrada primero al host anterior (si hay uno distinto y sigue conectado) antes de promover al nuevo. Efecto secundario esperado: si el creador abre la sala en dos pestañas/dispositivos, solo la última en unirse queda como host activo (la otra pierde el control, avisada por `host-status`) — antes ambas quedaban como host a la vez, que era justamente la causa del bug. Si el `hostToken` se filtra, quien lo tenga puede seguir volviéndose host en cualquier momento — eso no cambió — pero ya no puede haber dos al mismo tiempo (ver sección de riesgos).
- Eventos `sync` (play/pause/seek) del backend **solo se retransmiten si vienen de un socket con `isHost = true`**.
- En el frontend (`room.html`), a los no-host se les quita el atributo `controls` del `<video>`, y se bloquea cualquier intento de mover el `currentTime` manualmente (evento `seeking` lo revierte a `lastKnownTime`). Esto se agregó porque un invitado logró adelantar el video sin querer desde el celular.
- Se agregó un **heartbeat**: el host manda su posición cada 4 segundos (`type: 'heartbeat'`) para resincronizar a todos aunque no haya pausado/adelantado nada — corrige drift por buffering o lag.
- El host puede **expulsar** (`kick-user`) y **silenciar el chat** (`toggle-mute`) a otros usuarios desde la pestaña "Espectadores" en `room.html`. El silencio es solo de chat, no de audio/video (cada quien controla su propio volumen localmente, no hay forma de silenciar el audio de otro ya que no comparten audio entre sí).
- El host puede **cambiar la película** en cualquier momento sin cerrar la sala (`POST /room/:id/change-video`, protegido por `hostToken` en el body), o reutilizar un video ya subido desde la biblioteca (`POST /room/:id/change-video-from-upload`, ver sección 8quater).

## 5bis. Traspaso de host (V7, corregido en V8)

Antes, si el host cerraba la pestaña o se le caía la conexión, nadie más podía controlar el video — la sala quedaba "congelada" salvo que el host volviera a entrar desde el mismo navegador (el único que tiene el `hostToken` en `localStorage`).

- **Automático**: en el handler de `disconnect` del servidor, si el socket que se fue era el host actual (`room.hostSocketId === socket.id`), se asciende automáticamente al espectador que lleva más tiempo conectado (primero en el `Set` de sockets de la sala, que en Socket.io conserva el orden de inserción), vía `setHost()`.
- **Manual**: el host puede darle el control a cualquier espectador desde el panel "Sala" → botón "Hacer host" (evento `make-host`), también vía `setHost()`.
- En ambos casos se manda un mensaje de sistema al chat avisando quién es el nuevo host.

**Bug de V7, corregido en V8 — "host duplicado":** en V7, ni el traspaso automático ni el manual le quitaban el rol de host a quien lo tenía antes — solo prendían `isHost = true` en el nuevo, sin apagarlo en el viejo. Combinado con que "cualquier socket con el `hostToken` correcto es host" (sección 5), esto generaba hosts duplicados en la práctica:
- El host se iba → se transfería al siguiente → el host original volvía a entrar (su `hostToken` en `localStorage` seguía siendo válido) → quedaba marcado `isHost = true` **sin quitárselo** a quien ya lo tenía. Dos hosts a la vez, cada uno pudiendo mover el video del otro.
- Traspaso manual: quien daba el control con "Hacer host" no se degradaba a sí mismo. Mismo resultado.
- Repitiendo el primer caso varias veces se podían acumular 3 o más "hosts" simultáneos.

**Fix (V8):** se agregó `room.hostSocketId` (ver sección 4) y una función única `setHost(room, roomId, socket)` por la que pasan los tres casos de arriba (join con token válido, traspaso automático, traspaso manual). Antes de promover a alguien, `setHost()` siempre revisa si `room.hostSocketId` ya apunta a otro socket conectado y, si es así, lo degrada primero (`isHost = false` + `host-status` avisándole, para que su UI de host desaparezca al instante). Así nunca puede haber más de un socket con `isHost = true` a la vez en una sala. El traspaso automático además dejó de confiar en la bandera local `socket.isHost` (que podía quedar desincronizada) y ahora compara directamente contra `room.hostSocketId`, que es la fuente de verdad.

Esto resuelve el primer ítem del roadmap ("traspasar el rol de host a otro espectador si el host se desconecta") de forma completa — en V7 quedaba resuelto a medias por este bug.

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
| `make-host` | solo host (V7) | Asciende a otro socket a host vía `setHost()` (V8), que además degrada al host anterior |
| `buffering-status` | cualquier cliente (V7) | Marca/desmarca a ese socket como "buffereando" para la sala |
| `typing` | cualquier cliente (V7) | Se retransmite a los demás para el indicador "X está escribiendo..." |
| `room-data` | servidor, tras un `join-room` válido (V7) | Manda `videoFile` y `subtitleFile` — reemplaza al fetch a `/api/room/:id` que existía antes de V7 |
| `subtitle-changed` | servidor (V7) | Avisa a todos que hay un `.vtt` nuevo para el `<track>` del video |
| `viewer-list` | servidor (broadcast) | Se manda cada vez que cambia la sala (join/leave/mute/buffering) |

En el cliente, hay una variable `ignoreSync` que evita loops infinitos: cuando el reproductor recibe un evento de sync remoto y cambia `currentTime`/play/pause, se pone `ignoreSync = true` por 200-300ms para no re-emitir ese mismo cambio como si fuera una acción del usuario.

**Botones de salto ±10s (V7)**: visibles solo para el host, en `room.html`. Simplemente mueven `player.currentTime`, lo que dispara el evento nativo `seeked` — no necesitan lógica de sync propia, reutilizan el mismo camino que mover la barra de progreso nativa.

## 7. Decisiones de diseño relevantes (por qué se hizo así)

- **Sin base de datos ni persistencia**: el proyecto es para uso personal/casual, no vale la pena la complejidad de Postgres/SQLite para algo que se usa unas horas y se apaga.
- **Sin sistema de cuentas**: entrar a la sala solo pide un nombre (modal propio, ver sección 8sedecies), no hay registro. El "host" se identifica solo por posesión del token, no por login.
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
- **Frontend (`public/library.html`)**: pantalla nueva con el mismo sistema de diseño VHS (`.deck.deck-wide`, esquinas, contador REC, horizonte). Lista cada video con ícono, nombre, tamaño formateado (KB/MB/GB) y fecha, más dos botones: "▶ USAR" (llama a `create-room-from-upload`, guarda el `hostToken` en `localStorage` igual que el flujo normal, y redirige a `/room/<id>`) y "🗑" (con confirmación antes de borrar — desde V8 es el modal propio `mnConfirm()`, ver sección 8sedecies; antes era `confirm()` nativo). Estados de carga/vacío incluidos. Responsive: en pantallas angostas (`≤480px`) los botones bajan a una segunda fila para no apretar el nombre del archivo.
- **Nueva clase compartida en `style.css`**: `.deck.deck-wide` (620px en vez de 380px) para que la lista tenga espacio; `.tape-list`, `.tape-item` y variantes para los botones de acción.
- **Riesgo conocido, ya anotado en la sección 9**: borrar un video que está siendo usado por una sala activa rompe el reproductor de esa sala (el archivo deja de existir en `/uploads/`). No hay ninguna advertencia de "este video está en uso" — queda pendiente si se vuelve un problema real.
- Verificado end-to-end con Playwright: subida con nombre real → aparece en la biblioteca con ese nombre → botón "USAR" crea la sala y redirige → botón "🗑" borra el archivo del disco (confirmado con `ls`) → intento de path traversal rechazado con 400.

## 8quinquies. Contraseña de sala (V7)

Al crear una sala (desde `index.html`) hay un campo opcional "Contraseña de la sala". Si se llena:

- El servidor guarda `sha256(password)` en `room.passwordHash` — nunca la contraseña en texto plano, y sin salt por sala (protección básica, ver riesgos).
- `GET /api/room/:id` ahora solo devuelve `{ passwordProtected: true|false }`. Antes de V7 devolvía también `videoFile`, lo cual exponía la ruta real del video sin verificar nada — se movió esa información a después de un `join-room` válido (evento `room-data`).
- En `room.html`, si `passwordProtected` es `true`, se pide la contraseña con un modal propio (desde V8, `mnPrompt()`; antes `prompt()` nativo — ver sección 8sedecies) antes de conectar el socket. Si es incorrecta, el servidor manda `room-error: 'Contraseña incorrecta.'` y el cliente vuelve a preguntar (no expulsa a la primera).
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

## 8nonies. Barra de autofill de Chrome (llave/tarjeta/ubicación) sobre el teclado

El usuario reportó que, al escribir en el chat desde el celular, Chrome muestra una barra con iconos
de llave/tarjeta/ubicación arriba del teclado (el "keyboard accessory bar" de Autofill de Chrome
para Android, que ofrece rellenar con contraseñas, tarjetas o direcciones guardadas).

**Primer intento (insuficiente):** agregar `autocomplete="off"` al `<input>` del chat. No funcionó —
Chrome sigue mostrando la barra en `<input>`/`<textarea>` de la página sin importar `autocomplete`,
según confirmó el usuario con una captura.

**Pista clave que dio el usuario:** el diálogo nativo `prompt()` que pide el nombre al entrar a la
sala (`¿Cómo te llamas?`) **nunca** muestra esa barra. La diferencia: `prompt()` es un diálogo del
propio navegador, no un `<input>` del HTML de la página — y ahí está la solución real, porque la
barra de autofill de Chrome solo se activa sobre elementos de formulario reales
(`<input>`/`<textarea>`); no se activa sobre elementos `contenteditable`, porque no forman parte del
sistema de formularios que esa barra asiste.

**Fix aplicado:** el campo de chat (`chatInput`, en `room.html`) pasó de `<input>` a
`<div contenteditable="true">`. Es el mismo truco que usan WhatsApp Web, Messenger o Slack para su
caja de mensaje, en parte por esto mismo. Cambios necesarios en cascada:
- **HTML**: `<div id="chatInput" class="chat-input-field" contenteditable="true"
  data-placeholder="Escribe algo..." role="textbox" aria-multiline="false" enterkeyhint="send">`.
- **CSS** (`.chat-input-field` en `style.css`): reemplaza a `.chat-input input`. Como
  `contenteditable` no tiene atributo `placeholder` nativo, se simula con
  `.chat-input-field:empty:before { content: attr(data-placeholder); ... }`. El estado
  "silenciado" ya no puede usar `:disabled` (no existe en un div), se maneja con una clase
  `.is-disabled` (opacidad + `pointer-events: none`).
- **JS** (`room.html`): todo lo que leía/escribía `chatInput.value` pasó a `chatInput.textContent`.
  `Enter` en un contenteditable inserta un salto de línea por default (no "envía" como en un
  `<input>`), así que el handler de `keydown` hace `e.preventDefault()` y arma el envío a mano. Se
  agregó un handler de `paste` que fuerza texto plano (`document.execCommand('insertText', ...)`
  con `clipboardData.getData('text/plain')`), para que pegar contenido no traiga HTML/formato
  pegado de otro lado. El mute (`toggleMute`) ahora setea `contentEditable = 'false'` en vez de
  `.disabled`.

**`roomPassword` en `index.html`** sigue siendo un `<input type="password">` normal con
`autocomplete="new-password"` — no se convirtió a contenteditable porque perdería el enmascarado
nativo de contraseña, y no se pidió. **`joinCode`** sí terminó convertido más adelante (ver
8duodecies) porque el usuario confirmó que la barra también aparecía ahí.

## 8decies. En celular, código de sala + botón Salir viven en la pestaña "Sala" (no en PC)

Pedido explícito: en celular, el código de sala y el botón "Salir" ocupaban espacio fijo arriba de
las pestañas Chat/Sala, restándole lugar visible al chat (justo lo que la gente quiere ver más
mientras mira la peli). En PC no molesta porque el panel lateral es más alto. Se pidió que en
celular esas dos cosas se muden dentro de la pestaña "Sala", y que en PC se queden tal cual estaban.

**Cómo se hizo:** en vez de duplicar el HTML (lo cual duplicaría los ids `roomCodeText`, `copyBtn`,
`leaveBtn` y rompería `getElementById`), se envolvió el bloque en un único grupo
`<div id="codeSalirGroup">` y se mueve ese mismo nodo del DOM entre dos posibles contenedores con
JS, según el ancho de pantalla:
- `sideHeaderDesktop` (`<div class="side-header">`, arriba de las pestañas) — posición para PC.
- `codeSalirSlotMobile` (otro `<div class="side-header">`, vacío, como primer hijo de
  `#panel-people`, la pestaña "Sala") — posición para celular.

```js
const mobileLayoutQuery = window.matchMedia('(max-width: 820px)');
function placeCodeSalirGroup() {
  const target = mobileLayoutQuery.matches ? codeSalirSlotMobile : sideHeaderDesktop;
  if (codeSalirGroup.parentElement !== target) target.appendChild(codeSalirGroup);
}
```

Como es el mismo nodo (no una copia), sus listeners (`copyBtn`, `leaveBtn`) nunca se pierden al
moverlo. Se decide por **ancho** (`max-width: 820px`, el mismo breakpoint que ya usa el resto del
layout mobile) y se reacciona con `mobileLayoutQuery.addEventListener('change', ...)` — no con
`resize` plano — para que abrir el teclado (que solo achica el *alto* visible, no el ancho) nunca
dispare un movimiento de por medio. Mismo criterio de fondo que `updateOrientationClass()` (8octies)
y el fix del layout de landscape angosto (8octies también): separar "cambió el layout real" de
"cambió cuánto espacio visible queda".

`.side-header:empty { display: none; }` en `style.css` intentaba esconder el contenedor que quedara
vacío para no dejar un padding/borde hueco ahí arriba — pero tenía un bug, ver 8duodecies.

## 8undecies. Rediseño del botón "Salir"

Pedido: el botón "Salir" se veía "muy simple y genérico" (outline rosa plano tipo botón de
formulario estándar), sin relación con la estética "videoclub VHS" del resto de la sala.

Se rediseñó pensándolo como un botón de "eyectar cinta" de videocasetera: fondo oscuro con
gradiente sutil (panel físico, no un rectángulo plano), el ícono 🚪 en su propio círculo separado
del texto, glow rosa (`box-shadow`) que se intensifica en hover en vez de invertir colores, y un
efecto de "click" físico al presionar (`transform: translateY(1px) scale(0.99)` + sombra hacia
adentro). Clases: `.leave-btn` (contenedor) y `.leave-btn-icon` (círculo del ícono), ambas en
`style.css`. El HTML pasó de `<button class="leave-btn">🚪 Salir</button>` a
`<button class="leave-btn"><span class="leave-btn-icon">🚪</span> Salir</button>`.

## 8duodecies. Más espacio de chat con el teclado abierto + fix del hueco vacío + `joinCode` contenteditable

Tres pedidos del usuario a partir de una captura en celular (con el teclado abierto, solo se veía
un mensaje del chat, un hueco vacío entre el video y las pestañas, y la barra de autofill de Chrome
seguía apareciendo en el campo de código de sala de `index.html`).

**1) Hueco vacío entre el video y las pestañas — bug de 8decies.** La franja vacía no era decorativa:
era el propio `sideHeaderDesktop` (el `.side-header` de PC) que, en celular, se supone debía
colapsar por `.side-header:empty { display: none; }` al quedarse sin el grupo código+Salir (mudado
a `codeSalirSlotMobile`, dentro de la pestaña "Sala"). Pero `:empty` nunca se disparaba: al mover
`codeSalirGroup` con `appendChild`, el contenedor de origen conserva los nodos de texto del HTML
original (saltos de línea/indentación entre las etiquetas), y esos nodos de texto cuentan como
contenido para `:empty` — el navegador nunca lo consideraba realmente vacío.
**Fix**: `placeCodeSalirGroup()` (`room.html`) ahora esconde el contenedor perdedor a mano
(`sideHeaderDesktop.style.display = isMobile ? 'none' : ''`, y viceversa para
`codeSalirSlotMobile`), sin depender de `:empty`. La regla CSS se deja como respaldo inofensivo.

**2) Con el teclado abierto solo se veía el último mensaje del chat.** Aunque el video ya tenía un
`min-height: 100px` (8octies), entre eso, el hueco vacío del punto 1, la fila de emojis y el campo
de escribir, no quedaba casi nada de alto para `#messages`.
**Fix (primera versión, ver 8terdecies para el ajuste posterior)**: `room.html` agrega la clase
`keyboard-open` a `<html>` mientras el campo de chat (`chatInput`) tiene el foco (`focus`/`blur`) —
no se usó la altura del `visualViewport` para detectarlo porque esa señal ya se usa para otra cosa
(`--app-height`) y mezclarlas daría falsos positivos (p. ej. el navegador ocultando su barra de
direcciones también achica la altura visible sin que haya teclado). Con esa clase, en celular
vertical (`style.css`, `@media (max-width: 820px)`, mismo criterio de excluir `device-landscape`
que el resto del layout mobile):
- Se oculta `.reactions` (la fila de emojis) — no hace falta mientras se está escribiendo.
- `.screen-wrap` baja su tope de `max-height: 45dvh` (8octies) a `max-height: 20dvh` y su
  `min-height` de `100px` a `64px`, achicando bastante más el video para dejarle el resto del alto
  visible a los mensajes anteriores.

**3) `joinCode` (`index.html`) seguía mostrando la barra de autofill de Chrome.** En 8nonies se
había resuelto solo para el chat de la sala; el campo de código para unirse (pantalla de inicio)
seguía siendo un `<input>` normal y le pasaba lo mismo.
**Fix**: mismo patrón que 8nonies — `joinCode` pasó de `<input type="text" maxlength="6">` a
`<div id="joinCode" class="join-code-field" contenteditable="true" data-placeholder="a1b2c3" ...>`.
Cambios en cascada: `joinCode.value` → `joinCode.textContent` en `tryJoin()`; el `keydown` de Enter
ahora hace `e.preventDefault()` antes de llamar a `tryJoin()` (si no, insertaría un salto de línea);
se agregó un handler de `paste` que fuerza texto plano; y como un contenteditable no tiene
`maxlength`, se agregó un handler de `input` que recorta el texto a 6 caracteres a mano (y limpia
saltos de línea, por si algo los coló vía paste), moviendo el cursor al final tras recortar. La
placa de contraseña (`roomPassword`) no se tocó — sigue siendo un `<input type="password">` normal,
ver nota actualizada en 8nonies.

## 8terdecies. Ajuste: video más grande con el teclado abierto, bug del tamaño que no se restauraba, y barra de volumen colapsable

Feedback del usuario tras probar 8duodecies: el 20dvh/64px dejaba el video demasiado chico —
"la cuestión es poder hablar y ver el video al mismo tiempo", prioridad al video. Además reportó un
bug (video no volvía a su tamaño original al cerrar el teclado) y pidió sacarle protagonismo a la
barra de volumen. Antes de tocar nada se le preguntó qué tanto debía achicarse el video y qué hacer
con la barra de volumen — eligió "poco, prioridad al video" y "ocultarla mientras el teclado está
abierto + rediseñarla para que el deslizador solo aparezca al tocar el ícono".

**1) Video más grande con teclado abierto.** `.screen-wrap` en `html.keyboard-open` pasó de
`max-height: 20dvh; min-height: 64px` a `max-height: 38dvh; min-height: 90px` — mucho más cerca del
tamaño normal (`45dvh`/`100px`, 8octies). El espacio extra para el chat ya no sale de aplastar el
video, sino de esconder los emojis, el hueco vacío arreglado en 8duodecies, y ahora también la
barra de volumen (punto 3).

**2) Bug: el video no volvía a su tamaño original al cerrar el teclado.** Causa: en algunos
Android + Chrome, tras cerrar el teclado, el evento final de `visualViewport.resize` no llega a
tiempo (o llega con un valor intermedio de la animación de cierre), y `--app-height` se queda
pegado en ese valor chico — el CSS ya no tiene la clase `keyboard-open` pero el `--app-height` que
usa `.room-scene` para calcular su alto real sigue siendo el reducido.
**Fix**: dos cambios en `room.html`. (a) `visualViewport` ahora también escucha `scroll` además de
`resize` (algunos Android disparan `scroll` en vez de/antes que el `resize` final al cerrar el
teclado). (b) el handler de `blur` del chat, además de sacar la clase `keyboard-open`, refuerza el
recálculo de `setAppHeight()` varias veces con `setTimeout` (`50, 150, 300, 500` ms) para cubrir
toda la duración de la animación de cierre del teclado, en vez de confiar en un solo evento.

**3) Barra de volumen colapsable.** Antes `.local-controls` mostraba el ícono 🔊, el deslizador de
volumen y el botón de pantalla completa (⛶) todos fijos y siempre visibles sobre el video. Dos
cambios:
- **Se oculta mientras el teclado está abierto** (celular vertical, mismo criterio que los emojis):
  se agregó `updateLocalControlsVisibility()` en `room.html`, que decide el `display` de
  `#localControls` combinando dos cosas — si es host (nunca se muestra, ya existía) y si el teclado
  está abierto en celular vertical (nuevo). Se maneja por JS y no por una regla CSS con
  `html.keyboard-open` porque el `display` de `#localControls` ya se fija por JS en otro lado
  (`socket.on('host-status', ...)`) vía `style.display`, y una regla de CSS normal no le gana a un
  inline style — hacía falta que ambas decisiones vivan en el mismo lugar.
- **El deslizador ahora es colapsable**, como en varios reproductores: se envolvió el ícono y el
  `<input type="range">` en un `<div class="vol-control" id="volControl">`, y el ícono pasó de
  `<span>` a `<button id="volToggleBtn">`. Al tocarlo, alterna la clase `.open` en `volControl`; el
  CSS (`.vol-slider`) anima su ancho de `0` a `90px` con `transition`. Se cierra solo si se toca
  afuera (listener de `click` en `document` mientras está abierto, que se remueve al cerrarlo para
  no dejar listeners colgando) o si se abre el teclado (`setKeyboardOpen` llama a `closeVolPopup()`
  para que no quede el popup abierto detrás de la barra ya escondida). El botón de pantalla
  completa (`fsBtn`) no forma parte de este colapso — sigue siempre visible aparte.

## 8quaterdecies. Fix: layout deformado al salir de pantalla completa + botón de enviar en el chat

Reporte del usuario con dos capturas de celular: al tocar el botón de pantalla completa (⛶) y
luego salir, la sala quedaba deformada — el video pasaba a ocupar el layout de escritorio (fila,
video angosto a un costado en vez de columna con video arriba) y el chat quedaba aplastado abajo,
sin volver nunca a su estado normal aunque el celular siguiera en vertical.

**Causa.** La pantalla completa se pide sobre el `<video>` solo (`player.requestFullscreen()`), no
sobre toda la página. En Chrome/Android (y el reproductor nativo de iOS Safari) es común que, al
entrar en pantalla completa sobre un video, el navegador fuerce una rotación a landscape mientras
dura — aunque el celular esté físicamente en vertical — y la revierta al salir. El problema es que
esa rotación "de mentiras" no siempre dispara `orientationchange` (el evento del que depende
`updateOrientationClass()`, ver 8octies), y el `resize`/`visualViewport.resize` que sí llega puede
traer un valor intermedio de la animación de transición — el mismo tipo de carrera ya documentado
para el cierre del teclado (8terdecies, punto 2). Resultado: `--app-height` y la clase
`device-landscape` en `<html>` se quedaban pegados en el valor de cuando estaba en pantalla
completa, y ya nada volvía a recalcularlos porque ni `resize` ni `orientationchange` volvían a
disparar con el valor correcto.

**Fix** (`public/room.html`): se agregó `resyncLayoutAfterFullscreen()`, que reintenta
`setAppHeight()` + `updateOrientationClass()` varias veces (`0, 50, 150, 300, 500` ms) para cubrir
toda la duración de la animación de transición, igual que ya se hace en el `blur` del chat para el
teclado. Se cuelga de tres pares de eventos para cubrir navegadores distintos:
- `fullscreenchange` / `webkitfullscreenchange` en `document` (Chrome/Firefox/Safari desktop y
  Android modernos, Fullscreen API estándar).
- `webkitbeginfullscreen` / `webkitendfullscreen` en el propio `<video>` (iOS Safari, que no
  implementa la Fullscreen API estándar sobre `<video>` — usa su reproductor nativo con estos
  eventos propios en su lugar).

**Botón de enviar mensaje.** Se aprovechó para agregar `#chatSendBtn` (➤) al lado del campo de
chat, a pedido del usuario — antes solo se podía mandar el mensaje con Enter. La lógica de armar y
emitir el mensaje se sacó del listener de `keydown` a una función aparte (`sendChatMessage()`) para
no duplicarla entre el Enter y el click del botón nuevo. El botón intercepta su propio `mousedown`
con `preventDefault()` (en vez de dejar que el `click` normal le robe el foco al `chatInput`) — si
no, en celular cada tap en "Enviar" dispararía el `blur` del chat (que cierra el teclado, ver
8terdecies) justo antes de mandar el mensaje, en vez de dejar el teclado abierto para seguir
escribiendo.

## 8quindecies. Overlay de host oculto hasta tocar el video (celular) + rediseño de los botones ±10s

Pedido del usuario con captura: en celular, el badge "🎛 CONTROL REMOTO" y los botones de
retroceder/adelantar 10s (ambos solo visibles para el host) tapaban el video todo el tiempo — quería
que aparecieran solo al tocar la pantalla, como en cualquier reproductor. De paso pidió mejorar la
estética de los botones ±10s, que no le gustaban.

**1) Overlay oculto hasta tocar el video (solo celular, `max-width: 820px`).** En escritorio
`.host-badge` y `.host-controls` se quedan siempre visibles, sin cambios — ahí no estorban (hay
mouse, más espacio). En celular ahora arrancan con `opacity: 0; pointer-events: none` y solo se
muestran cuando `.screen-wrap` tiene la clase `controls-visible`, que JS (`room.html`) agrega/quita:
- Tocar el video (fuera del badge/botones) alterna la clase — igual que el tap-to-toggle de
  YouTube/Netflix.
- Al mostrarse, arranca un `setTimeout` de 3s que la vuelve a esconder sola; cada nuevo toque
  (incluido tocar el badge o los botones ±10s, que además ejecutan su propia acción con ese mismo
  click) reinicia el temporizador en vez de ocultarla de golpe.
- Al volverse host recién en caliente (traspaso de control remoto, ver 5bis) se muestra el overlay
  un momento automáticamente, para que la persona note que ahí están el badge y los botones — si no,
  como arrancan ocultos, podría no descubrirlos nunca sin tocar el video primero.
- Se aplica en las dos orientaciones de celular (vertical y landscape angosto), a diferencia de
  otras reglas de esta sección que sí distinguen orientación (acá el overlay tapa una porción
  similar del video chico en cualquiera de las dos).

**2) Rediseño de los botones ±10s.** Antes eran rectángulos planos con emoji de flechas dobles
(⏪/⏩), que se veían a color y desentonaban con el resto de la interfaz (monocroma, con glow de
neón). Ahora son círculos tipo "chip" (`.skip-btn`, 50px) con un ícono de flecha circular (↺/↻ —
caracteres de texto plano, no emoji, así que nunca salen a color) y el "10" debajo en la fuente OSD
(`--font-osd`), el mismo lenguaje visual que ya usa el contador de sala (`.osd-counter`). Brillan en
rosa (línea visual de todo lo relacionado a host: `.host-badge` ya usaba ese gradiente) y pasan a
cian al tocarlos, como el resto de los controles interactivos de la sala.

## 8sedecies. Modal propio reemplaza los diálogos nativos del navegador (V8)

El usuario reportó con captura que, al entrar a una sala desde el celular, el `prompt()` nativo que
pide el nombre (`¿Cómo te llamas?`) aparecía sin ningún estilo y con la URL completa del túnel de
Cloudflare pegada arriba (ej. `definition-utc-college-specials.trycloudflare.com dice`) — algo que no
tiene que ver con que el link cambie cada vez que se reinicia el túnel (eso siempre pasó y seguirá
pasando), sino con que `prompt()`/`confirm()`/`alert()` son diálogos del propio navegador, no HTML de
la página, así que Chrome les antepone el origen de la página que los pidió.

**Fix:** se agregó un componente de modal genérico (`.mn-modal-overlay` en `style.css`), con el mismo
sistema de diseño "videoclub" del resto de la app, reutilizado para los 3 casos (mostrando u
ocultando el input y el botón cancelar según corresponda):
- `mnPrompt({ title, placeholder, type, ... })` — reemplaza `prompt()`.
- `mnConfirm(message)` — reemplaza `confirm()`.
- `mnAlert(message)` — reemplaza `alert()`.

Los tres devuelven una `Promise` (los diálogos nativos bloqueaban de forma síncrona; un modal HTML no
puede hacer eso), así que todo el flujo de entrada a la sala (`room.html`) que dependía del `prompt()`
del nombre y la contraseña se convirtió a `async/await` (`enterRoom()`).

Aplicado en **`room.html`**: nombre al entrar, contraseña de sala, contraseña incorrecta (reintento),
confirmar "Salir de la sala", confirmar "Expulsar", confirmar "Hacer host", aviso de "Te expulsaron".
Aplicado en **`library.html`**: aviso de permisos de host, errores al usar/borrar una cinta,
confirmar borrado. El markup del modal y las funciones `mnDialog`/`mnPrompt`/`mnConfirm`/`mnAlert`
están duplicados en ambos archivos (mismo patrón que ya usa `escapeHtml`, cada página HTML es
autocontenida, no hay un JS compartido entre páginas).

Es puramente de UI/estética — no tiene relación con Cloudflare Tunnel ni con que el link cambie de
sesión a sesión; eso sigue siendo así y no tiene solución sin un dominio fijo (ver roadmap, sección 10).

## 8septendecies. Contraseña de biblioteca (V9) — cierra el acceso libre a listar/borrar cintas

El usuario preguntó por seguridad pensando en el escenario "un amigo reenvía el link de una sala a
alguien que no debería tenerlo". Repasando el server bajo ese lente apareció el hallazgo más serio de
toda la sección de riesgos: `GET /api/uploads` (listar) y `DELETE /api/uploads/:filename` (borrar) no
pedían **absolutamente nada** — ni `hostToken`, ni contraseña de sala, ni ningún otro chequeo. No hacía
falta ni ser especialmente hábil: alcanzaba con conocer el dominio del server (que ya lo sabés apenas
tenés el link de una sala) y escribir `/library.html` a mano. Desde ahí se podía ver **todo** lo que se
subió alguna vez a ese server (de cualquier sala, no solo la propia) y borrar cualquier archivo —
incluso mientras otra sala lo estaba usando en ese momento, rompiéndola sin avisar a nadie (riesgo ya
anotado en la sección 9, ahora mitigado).

**Por qué un secreto aparte, y no reusar `hostToken` o la contraseña de sala:** la biblioteca es
compartida por *todo* el servidor, no por una sala puntual — no tendría sentido atarla al token de una
sala específica. Se optó por un secreto único a nivel de servidor, `LIBRARY_PASSWORD` (ver sección 4),
en la misma línea que ya existían "secretos por alcance" en el proyecto (token por sala, contraseña por
sala): ahora hay también uno por servidor.

**Cómo se configura:** variable de entorno `LIBRARY_PASSWORD`. Si no se define, el servidor genera una
al azar en cada arranque (`crypto.randomBytes(4).toString('hex')`) y la imprime por consola al iniciar,
con instrucciones para fijarla. Se guarda hasheada (reusa `hashPassword`, el mismo `sha256` que ya se
usa para contraseñas de sala) en `libraryPasswordHash`, nunca en texto plano en memoria más tiempo del
necesario para hashearla.

**Backend:** middleware `requireLibraryAuth` (recibe el valor por header `x-library-password`, o por
query/body como alternativa) aplicado a las dos rutas mencionadas. Responde `401` si falta o no
coincide. **No** se agregó a `POST /create-room-from-upload` — para explotarlo haría falta adivinar el
nombre exacto del archivo en el servidor, que lleva un prefijo aleatorio de 8 caracteres hex
(`crypto.randomBytes(4)`, ver sección 8quater), así que sin poder listar antes es, en la práctica, tan
poco adivinable como el `hostToken` mismo — no se consideró necesario duplicar la protección ahí.

**Frontend (`library.html`):** función `mnLibraryFetch(url, options)`, que envuelve `fetch` agregando
el header con la contraseña guardada en `localStorage` (`mn_library_pw`); si el server responde `401`,
pide la contraseña con el modal propio (`mnPrompt`, agregado a este archivo en este mismo cambio — antes
solo estaba en `room.html`) y reintenta, en un loop sin botón de cancelar (para no dejar mostrar una
biblioteca vacía como si no hubiera nada, que sería confuso). Una vez que la contraseña funciona una
vez, queda guardada para las próximas visitas desde el mismo navegador — no se vuelve a pedir salvo que
cambie (ej. el servidor se reinició sin `LIBRARY_PASSWORD` fija y generó una nueva).

## 8octodecies. Soporte de archivo `.env` para fijar `LIBRARY_PASSWORD` sin repetirlo cada arranque (V10)

Tras el fix de la sección anterior, el usuario preguntó si era normal ver el mensaje de "contraseña
generada al azar" en consola cada vez que corre `npm start` — sí, es el comportamiento esperado sin
`LIBRARY_PASSWORD` fija, pero abre la puerta a una mejora obvia: no depender de recordar pasar la
variable de entorno a mano cada vez (más aún en Windows/PowerShell, donde la sintaxis es distinta a
Mac/Linux: `$env:LIBRARY_PASSWORD="x"; npm start` en vez de `LIBRARY_PASSWORD=x npm start`).

**Se agregó un lector de `.env` propio** (función `loadDotEnv()` al inicio de `server.js`), sin sumar
la librería `dotenv` como dependencia — el proyecto se mantiene deliberadamente con solo 3 dependencias
(`express`, `multer`, `socket.io`; ver sección 2), y el formato que hace falta soportar es mínimo
(`CLAVE=valor`, una por línea, comillas opcionales, líneas vacías y que empiezan con `#` se ignoran).
Si existe un archivo `.env` en la raíz del proyecto, sus variables se cargan a `process.env` **sin
pisar** las que ya vinieran del entorno real — así, si en algún momento se quiere sobreescribir
puntualmente sin tocar el `.env` (`LIBRARY_PASSWORD=x npm start`), esa forma sigue funcionando y tiene
prioridad.

Se agregó `.env.example` (sí versionado en git, es solo una plantilla) documentando las variables
disponibles (`LIBRARY_PASSWORD`, `PORT`). El archivo real `.env` ya estaba en `.gitignore` desde antes
de este cambio, así que nunca se sube por accidente. El flujo recomendado quedó: `cp .env.example .env`
y completar ahí — el servidor lo carga solo en cada arranque, sin volver a pedir nada por consola ni
tener que recordar la sintaxis de variables de entorno de cada sistema operativo.

## 8novodecies. Fix: el modal de contraseña de biblioteca quedaba invisible al fallar en localhost

El usuario reportó: al poner la contraseña de biblioteca incorrecta, la pantalla se quedaba trabada
en "Cargando cintas..." — pero **solo en `localhost`**, nunca a través de Cloudflare Tunnel.

**Causa raíz:** el modal genérico (`mnDialog`, duplicado en `library.html` y `room.html`, ver sección
8sedecies) oculta el overlay recién 150ms después de cerrarse (`setTimeout(() => overlay.hidden = true,
150)`), para que se alcance a ver la animación de fade-out. Ese timeout nunca se cancelaba. Si se abría
un `mnDialog` nuevo antes de que pasaran esos 150ms — exactamente lo que hace `mnLibraryFetch` al pedir
la contraseña de nuevo apenas el `fetch` anterior vuelve con `401` —, el timeout viejo igual disparaba
más tarde y ponía `overlay.hidden = true` **sobre el modal recién abierto**, dejándolo invisible con su
`Promise` todavía sin resolver (nadie puede hacer click en algo que no se ve). De fondo quedaba visible
lo que había debajo del overlay: el `<ul>` con el texto original "Cargando cintas...".

Por qué pasaba solo en `localhost`: el `fetch` a sí mismo en la misma máquina tarda bien menos de
150ms, así que la carrera se ganaba siempre. A través de Cloudflare Tunnel el viaje de ida y vuelta ya
tarda más que eso, así que el timeout viejo ya había disparado (sin nada abierto que ocultar) antes de
que se mostrara el modal nuevo — por eso ahí nunca se notaba.

**Fix:** se guarda el id del `setTimeout` en una variable de módulo (`mnModalHideTimer`) y se cancela
con `clearTimeout` al abrir cualquier modal nuevo, en los dos archivos donde vive el componente
(`library.html` y `room.html`) — nunca puede quedar un timer viejo compitiendo con un modal recién
abierto.

## 9. Riesgos / cosas pendientes de endurecer (seguridad)

- El `hostToken` viaja en texto plano por HTTP (a menos que Cloudflare Tunnel lo cifre en tránsito, que sí lo hace vía HTTPS). Si alguien lo obtiene (inspeccionando `localStorage` de la persona equivocada, por ejemplo), puede hacerse pasar por host.
- La contraseña de sala (V7) y la de biblioteca (V9) usan `sha256` sin salt — suficiente para que alguien con el link no entre "sin querer", pero no es resistente a un atacante que se lo proponga en serio (sin rate-limiting en `join-room` ni en `requireLibraryAuth`, se podrían probar contraseñas por fuerza bruta). Dado el caso de uso (grupo de amigos), se consideró un trade-off aceptable.
- No hay rate-limiting en el chat, en `join-room`, en `requireLibraryAuth`, ni en la subida de archivos — un usuario malicioso podría floodear el chat, probar contraseñas repetidamente, o intentar subir archivos gigantes repetidamente.
- No hay validación de tipo de archivo más allá de lo que el navegador manda como `video/*` en el `<input accept>` (o la extensión `.srt`/`.vtt` para subtítulos) — no es una validación real de seguridad, solo de UX.
- Las salas nunca se borran ni expiran — si el server corre mucho tiempo, `rooms` y los archivos en `uploads/` se van acumulando. (Ahora al menos se pueden borrar a mano fácil desde `library.html`, ver sección 8quater.)
- Borrar un video desde `library.html` mientras una sala activa lo está usando rompe esa sala sin avisar (ver 8quater) — sigue sin resolverse en V9. Mitigado en parte por V9: ahora hace falta la contraseña de biblioteca para borrar, así que ya no puede pasar por accidente por un desconocido random con el link de una sala — pero un amigo del grupo (que sí tiene la contraseña) todavía podría borrar sin querer un video en uso.
- El traspaso automático de host (sección 5bis) elige al espectador que lleva más tiempo conectado sin ningún otro criterio (no hay forma de "vetar" a alguien de ser host automático). Improbable que sea un problema real dado que es para grupos de amigos, pero queda anotado.
- ~~`GET /api/uploads` y `DELETE /api/uploads/:filename` no pedían ninguna autenticación~~ — resuelto en V9 con `LIBRARY_PASSWORD` (ver sección 8septendecies). Era el riesgo más serio de esta lista: no requería ninguna habilidad especial, solo conocer el dominio del server (que ya se sabe con el link de una sala) y escribir `/library.html`.

## 10. Ideas pendientes / roadmap

- [ ] Borrado automático de salas/archivos viejos (ej. después de X horas sin actividad).
- [ ] Dominio fijo con Cloudflare Tunnel nombrado (requiere cuenta de Cloudflare + dominio propio) para no tener que compartir un link nuevo cada sesión.
- [ ] Posible: avisar si se intenta borrar un video que está en uso por una sala activa.
- [ ] Posible: contraseña también al reutilizar un video desde la biblioteca (`create-room-from-upload`), hoy solo existe al crear desde `index.html`.
- [ ] Posible: rate-limiting real en `join-room` (intentos de contraseña) y en la subida de archivos.
- [ ] Evaluado y descartado por ahora (no encaja con el caso de uso de grupo privado chico): video/voz en vivo integrado tipo Scener/Kast, soporte para reproducir desde plataformas externas (Netflix/YouTube/etc.).
- [x] ~~Mostrar advertencia/loading mientras el video sube~~ — resuelto en V5 con barra de progreso real (ver sección 8ter).
- [x] ~~Reutilizar videos ya subidos sin tener que resubirlos~~ — resuelto en V6 con la biblioteca de cintas (ver sección 8quater).
- [x] ~~Traspasar el rol de host a otro espectador~~ — resuelto en V7 (automático y manual), con un bug de host duplicado corregido en V8 (ver sección 5bis).
- [x] ~~Subtítulos (.srt) sincronizados~~ — resuelto en V7 (ver sección 8sexies).
- [x] ~~Contraseña de sala además del link~~ — resuelto en V7 (ver sección 8quinquies).
- [x] ~~El botón de "Cambiar cinta" debería llevar a la biblioteca~~ — resuelto en V7: ahora enlaza a `/library.html?fromRoom=<roomId>`, que además permite subir una cinta completamente nueva sin perder esa opción.
- [x] ~~Botón de "Salir" para volver al inicio y unirse a otra sala~~ — resuelto en V7.
- [x] ~~El teclado móvil empuja el video fuera de pantalla al escribir en el chat~~ — resuelto (ver sección 8septies).
- [x] ~~Diálogos nativos del navegador (prompt/confirm/alert) sin estilo propio~~ — resuelto en V8 con un modal propio (ver sección 8sedecies).
- [x] ~~Bug: podía haber más de un host a la vez en una sala~~ — resuelto en V8 (ver sección 5bis).
- [x] ~~/api/uploads (listar/borrar cintas) sin ninguna autenticación~~ — resuelto en V9 con contraseña de biblioteca (ver sección 8septendecies).

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

**Nota sobre el flujo de trabajo (desde V8):** el usuario no le da a Claude push directo al repo. El
flujo real es: Claude clona el repo en un entorno propio, hace el cambio, commitea localmente, y
genera un patch con `git format-patch -1 HEAD` que entrega como archivo descargable. El usuario lo
aplica de su lado con `git am nombre-del-patch.patch` (conserva autor y mensaje de commit) y hace el
`git push` él mismo. Esto aplica también a los commits que actualizan `MEMORIA.md`/`CHANGELOG.md`:
van en un patch aparte o en el mismo patch que el código, pero siempre pasan por este mismo mecanismo
— nunca se asuma que Claude tiene (o debe pedir) acceso de escritura directo al repo remoto.