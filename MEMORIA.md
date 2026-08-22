# 🧠 MEMORIA DEL PROYECTO — MovieNight

Este archivo es un resumen de contexto para retomar el desarrollo en cualquier momento (por ti mismo o pegándoselo a una IA). Explica qué es el proyecto, cómo está armado, qué decisiones se tomaron y por qué, y qué falta.

Última actualización: 22 de agosto de 2026 (V19: contraseña + límite de 3 intentos para subir cintas
nuevas, reusando la contraseña de biblioteca — protege contra que cualquiera con el link llene el
storage de Cloudflare R2 y genere costo; ver sección 8novicies. Antes de eso: fix del video que se
reiniciaba al minuto 0 al salir/reentrar de la sala — sección 8septicies — y documentación, sin cambio
de código, del corte intermitente del túnel rápido de Cloudflare — sección 8octicies).

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
  .env.example             # Plantilla de variables de entorno (LIBRARY_PASSWORD, PORT, R2_*) — sí se sube a git
  .env                    # Copia de lo anterior con valores reales (NO se sube a git, ver .gitignore)
  cloudflared-config.example.yml  # Plantilla para túnel con nombre / dominio fijo (opcional, ver README)
  cloudflared-config.yml   # Copia con valores reales (NO se sube a git, ver .gitignore)
  lib/
    r2.js                  # Cloudflare R2 (opcional): subir/listar/borrar videos en R2 en vez de disco
  public/
    index.html            # Pantalla para crear sala (subir video) o unirse por código
    library.html            # Biblioteca de cintas: lista videos ya subidos, permite usarlos o borrarlos (V6)
    room.html              # Pantalla de la sala: reproductor, chat, controles
    style.css                # Estilos compartidos por las 3 pantallas
    uploads/                # Videos subidos (NO se sube a git, se genera solo; sin uso si R2 está activo)
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
- `LIBRARY_PASSWORD` (V9, ampliado en V19): **no** es un campo de `rooms` — es una única contraseña a nivel de todo el servidor (no por sala), guardada en una variable de módulo (`libraryPasswordHash`), que protege `GET /api/uploads` y `DELETE /api/uploads/:filename` (ver sección 8septendecies) y, desde V19, también `POST /create-room` y `POST /room/:id/change-video` — las dos rutas que suben un archivo NUEVO (ver sección 8novicies; `requireUploadAuth`, distinto de `requireLibraryAuth`, agrega ahí un límite de 3 intentos por IP). Se lee de la variable de entorno del mismo nombre; si no está definida, se genera una al azar en cada arranque y se imprime por consola.

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

> **Nota (Fase 3 de R2, ver sección 8quatricies):** lo que sigue describe la implementación original
> V6, que asumía disco local siempre. Desde la Fase 3, si R2 está activo, estas mismas rutas leen y
> escriben contra el bucket en vez de disco — `isValidUploadFilename()` ya no existe (se reemplazó por
> `isValidUploadReference()`, async y consciente de R2). El comportamiento en modo disco (sin R2) no
> cambió en nada.

- **Backend (`server.js`), 3 rutas nuevas**:
  - `GET /api/uploads` — lee `public/uploads/` con `fs.readdir` y devuelve un JSON con cada video (`filename`, `displayName`, `size`, `mtime`), filtrado por extensión (`.mp4 .mkv .mov .webm .avi .m4v`) y ordenado por fecha descendente. No depende de las salas en memoria — lee directo del disco, así que sobrevive a reinicios del servidor.
  - `POST /create-room-from-upload` (body JSON `{ filename }`) — crea una sala igual que `POST /create-room`, pero reutilizando un archivo que ya existe en vez de recibir uno por `multer`. Devuelve `{ roomId, hostToken }` igual que siempre.
  - `DELETE /api/uploads/:filename` — borra el archivo del disco con `fs.unlink`.
  - Las tres rutas comparten `isValidUploadFilename()` (en modo disco; ver nota arriba para R2), que valida que el nombre no tenga separadores de ruta ni `..` y que el archivo exista dentro de `UPLOAD_DIR` — evita path traversal (ej. `../../server.js`). Probado explícitamente con Playwright antes de entregar.
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

## 8vicies. Ajuste de espaciado del home para que entre sin scroll

El usuario pidió dos cosas puntuales sobre `index.html` (la pantalla de crear sala, `.deck` sin
`.deck-wide`): que entrara completa sin necesidad de scroll en ventanas de altura normal, y que se
achicara el hueco vacío entre el botón "GRABAR SALA" y el separador "O TAMBIÉN".

**La causa del hueco grande:** `#status` (el `<div>` de estado que aparece mientras se sube el video)
reservaba `min-height: 18px` + `margin-top: 16px` incluso vacío (para no saltar el layout cuando
aparece texto), y el separador `.divider-row` tenía `margin: 26px 0 20px` — entre los dos, ~60px de
espacio siempre reservado ahí sin nada visible la mayoría del tiempo.

**Fix:** se achicó el ritmo vertical del home en varios puntos (padding de `.deck`, margen de
`.tagline`, padding de `.tape-slot`, margen de `.password-input`, margen/padding de `.rec-btn`, margen
de `.divider-row`, y el margen del link a la biblioteca al final) y se agregó una regla específica para
`#status`/`#joinStatus` (ids únicos, solo existen en `index.html`) que reduce su hueco reservado cuando
están vacíos. En total suma a bastante menos de altura, sin necesidad de scroll en ventanas típicas de
escritorio.

**Por qué se scopeó con `.deck:not(.deck-wide)` en vez de tocar las clases compartidas directamente:**
varias clases usadas en el home (`.tagline`, `.tape-slot`, `.status-line`) también las usa
`library.html` (`.deck.deck-wide`) — que ya maneja su propio scroll interno en `.tape-list` y no
necesitaba este ajuste. Se prefirió no tocar su espaciado para no arriesgar regresiones ahí. `.rec-btn`,
`.divider-row` y `.password-input` sí se editaron directamente porque son exclusivas de `index.html`.

## 8unvicies. Rediseño adaptativo: elimina el scroll de página en home y biblioteca

La sesión anterior (8vicies) achicó valores fijos en `px` para que el home entrara sin scroll "en
ventanas de altura normal" — un parche parcial. El usuario pidió el enfoque completo: unidades
relativas al viewport (`dvh`, `vh`, `clamp()`, `min()`) en vez de seguir achicando `px`, y en
biblioteca, que la página no scrollee nunca y **solo** `.tape-list` lo haga.

**Causa raíz del bug reportado (captura en mobile, Chrome Android vía Cloudflare Tunnel):**
`.vhs-scene` usaba `min-height: 100vh`. En mobile, `100vh` vale el alto "grande" de la pantalla (como
si la barra de Chrome estuviera oculta) — más alto que el área que en verdad se ve al cargar la
página (con la barra visible). Con `min-height`, la escena terminaba siendo más alta que lo
realmente visible en pantalla, y el navegador agregaba scroll de PÁGINA para poder llegar a ese
sobrante — eso es lo que arrastraba el título y la tagline junto con el resto en la captura del
usuario. Encima, `.deck.deck-wide` limitaba su alto con `max-height: 82vh`, un porcentaje del mismo
`100vh` ya inflado, que tampoco compensaba la barra.

**Fix — `.vhs-scene`:** pasa de `min-height: 100vh` a `height: 100vh; height: 100dvh` (capa `100vh`
de respaldo para navegadores sin soporte + capa `dvh` real que sí descuenta la barra del navegador —
mismo patrón en capas que ya usa `.room-scene` para el problema del teclado, ver sección 7septies).
`overflow` pasa de `hidden` a `overflow-y: auto` — no como scroll esperado, sino como red de
seguridad: si algún caso extremo de verdad no entra ni encogiéndose al mínimo (ver clamp() abajo),
preferimos un scroll ocasional y contenido a recortar y esconder un botón con `overflow: hidden`.

**Fix — biblioteca (`.deck.deck-wide`):** `max-height` pasa de `82vh` a `100%` — como `.vhs-scene`
ahora mide `dvh` de verdad y es quien limita el espacio disponible (con su propio padding alrededor),
a la tarjeta le alcanza con no pasarse del 100% de ese espacio; el límite siempre coincide con lo
visible en pantalla. `.tape-list` sigue siendo la única parte con `flex:1` + `overflow-y:auto` (eso
no cambió), así que sigue siendo la única que scrollea — el resto de la tarjeta (volver, eyebrow,
título, tagline) queda fijo, que era el pedido explícito. Se compactó también esa cabecera
(`.deck.deck-wide .back-link/.eyebrow-osd/.marquee-title/.tagline`, y el margen de `.tape-list`) con
`clamp(..., dvh, ...)`, porque en mobile es proporcionalmente más alta que en desktop y le restaba
espacio real a la lista — antes, en una pantalla baja, la cabecera sola casi no dejaba lugar para ver
ni un ítem.

**Fix — home (`.deck:not(.deck-wide)`):** sin lista scrolleable, así que la meta es que todo el
contenido encoja lo necesario para entrar sin scroll de ningún tipo. Todos los paddings/márgenes que
la sesión anterior había fijado en `px` (padding de la tarjeta, tagline, tape-slot, `#status`/
`#joinStatus`, `.rec-btn`, `.divider-row`) pasan a `clamp(mínimo, valor-en-dvh, techo)` — en ventanas
altas se quedan en el mismo techo de antes (se ve idéntico), y en ventanas bajas siguen encogiendo en
vez de tocar un piso fijo y volver a desbordar. `.marquee-title` (el `h1` "MOVIE NIGHT") ahora limita
su tamaño también por alto (`font-size: clamp(22px, min(7vw, 8dvh), 42px)`), no solo por ancho como
antes — una ventana ancha pero baja (celular en landscape) antes no lo achicaba y era de las primeras
cosas en empujar contenido fuera de pantalla. (`library.html` pisa este valor con su propio
`style="font-size:..."` inline en el `h1`, así que el cambio en la práctica solo afecta al home.)

**Regresión propia detectada al probar, y corregida en la misma sesión:** al achicar el padding-top
del home, el contador REC decorativo (`.rec-timer`, `position:absolute; top:14px`, puramente
cosmético — no tiene efecto funcional, ver JS) empezó a superponerse con el texto "REWIND · PLAY ·
REC" en viewports bajos (se notaba, por ejemplo, a 390×500 y a 1280×500). Se agregó `.rec-timer` a la
lista de elementos ocultos en `@media (max-height: 500px)`, igual que ya pasaba con `.deck-corner`.

**Bug preexistente encontrado de paso (no introducido en esta sesión, pero sí corregido):** ese mismo
`@media (max-height: 500px)` estaba ubicado, en el archivo, ANTES de las reglas base de
`.deck-corner` y de `.rec-timer`. En CSS, con la misma especificidad, gana la regla que aparece
**último en el archivo** — no importa si está dentro de un `@media` o no. Es decir: la regla que
"ocultaba" las esquinas decorativas en pantallas bajas en realidad nunca se aplicaba de verdad, desde
antes de esta sesión (se puede confirmar comparando capturas de antes/después de mover el bloque). Se
reubicó el `@media` a después de esas dos reglas base para que el override funcione en la práctica.

**Cómo se verificó (no fue solo lectura de código):** se levantó un servidor estático local del
directorio `public/` y se usó Chromium headless vía Playwright (ya disponible en el entorno, usado
también por otros paquetes) para tomar capturas y medir programáticamente `document.documentElement.
scrollHeight` vs `clientHeight` en 7 tamaños de viewport por página (desktop y mobile, alturas
normal/baja/extrema, y landscape), antes y después del cambio — y en biblioteca, además, con una
lista sintética de 15 cintas inyectada vía JS para reproducir el caso con contenido real (la lista
vacía/con 1 ítem de carga no alcanza a desbordar y no reproduce el bug). Antes del fix, el home
scrolleaba a nivel página en 1280×500, 1280×350 y 844×390 (landscape); después de todos los cambios
(incluida la corrección del `rec-timer` y del bug de orden en el `@media`), cero scroll de página en
los 14 casos probados (7 alturas × 2 páginas).

**Límite honesto — esto no es magia sin límite:** no existe una forma puramente CSS de garantizar que
absolutamente cualquier contenido entre en absolutamente cualquier alto de ventana sin nunca ni
esconder texto ni scrollear en algún punto; se priorizó no esconder nunca contenido interactivo antes
que forzar un ajuste perfecto. Midiendo en este entorno para el home: cero scroll (ni de página ni
interno) desde ~560px de alto de viewport hacia arriba — cubre prácticamente cualquier laptop,
monitor o celular en portrait real. Entre ~520px y ~560px puede faltar apenas 1–3px y activarse la red
de seguridad (`overflow-y:auto` en `.vhs-scene`) de forma casi imperceptible. Por debajo de ~520px
(ventanas de verdad extremas, tipo 350–450px de alto — un celular tendría que estar en landscape *y*
la ventana del navegador de escritorio tendría que ser inusualmente chica) ese scroll interno se
vuelve más notorio, cumpliendo su rol de red de seguridad en vez de romper el layout o esconder el
botón "ENTRAR". La biblioteca no tiene esta limitación: como su propio contenido scrolleable
(`.tape-list`) absorbe cualquier exceso, no depende de que todo entre encogiéndose.

**Por qué se scopearon los cambios como se scopearon:** las reglas nuevas para biblioteca usan
`.deck.deck-wide .selector` (no la clase compartida sola) por la misma razón que ya explica la sección
8vicies — no arriesgar la spacing del home. Los cambios en `.rec-btn`, `.divider-row`,
`#status`/`#joinStatus`, `.password-input` se hicieron directo sobre la clase compartida sin scopear
porque, tras revisar los dos HTML, esas clases/ids son exclusivos de `index.html` (no los usa
`library.html` ni `room.html`).

## 8duovicies. Biblioteca: scrollbar temático, botones alado en mobile, y fix del hueco antes de la lista

Tres pedidos del usuario sobre `/library.html`, con capturas en cada paso.

**Scrollbar (`.tape-list`):** el scroll interno de la lista usaba el scrollbar nativo del navegador
(riel blanco sólido con flechas en Chrome/Edge), que rompía la estética VHS/neón del resto de la
interfaz. Se reemplaza por un pulgar delgado `var(--line)` que se enciende en `var(--cyan)` al hacer
hover, vía `scrollbar-color`/`scrollbar-width` (Firefox) y `::-webkit-scrollbar*` (Chrome/Edge/Safari).
Scopeado solo a `.tape-list` — no toca `.chat-messages` de `room.html`, que tiene su propio scroll.

**Tarjetas compactas + botones alado (mobile, dentro de `@media (max-width: 480px)`):** las tarjetas de
`.tape-item` (ícono + nombre/tamaño/fecha + botones USAR/eliminar) tenían mucho padding e ícono grande,
y las acciones se envolvían a su propia fila DEBAJO de toda la tarjeta (`flex-wrap` + `order` +
`flex-basis: 100%`) — el usuario pidió explícitamente que fueran "alado", no "abajado". Se compacta
padding/ícono/tipografía y se saca ese wrap: ícono + info + botones quedan en una sola fila, igual que
en desktop. El nombre vuelve a truncar con `…` (antes se dejaba envolver a varias líneas porque tenía
toda la tarjeta para sí solo, algo que solo tenía sentido con las acciones debajo).

**El hueco entre "insertar cinta" y la lista — causa real, encontrada en el tercer intento:**
`#newTapeStatus` es el `<div class="status-line">` dentro de `.new-upload`, donde se muestra "Subiendo
cinta... X%" **solo** durante una subida activa — el resto del tiempo está vacío. La regla base
`.status-line` (compartida con otros usos del proyecto) reserva `margin-top: 16px` + `min-height: 18px`
= 34px **siempre**, esté vacío o no. Ese espacio invisible, justo antes del borde punteado de
`.new-upload`, era la causa real del hueco "brusco" que reportó el usuario — no `.new-upload` ni
`.tape-list` en sí (dos intentos previos les bajaron `margin`/`padding` sin resolver el problema de
fondo, porque no era ahí). Es exactamente el mismo patrón que `index.html` ya resolvía para `#status`/
`#joinStatus` (ver sección 8vicies) pero que nunca se había aplicado a `#newTapeStatus` de
`library.html`. Fix: mismo override, `min-height: 0` + `margin-top: 6px` (no 0, para que cuando sí haya
texto de progreso no quede pegado al selector de archivo justo arriba).

**Cómo se detectó de verdad (no fue solo releer el CSS):** ante dos intentos fallidos ya confirmados
por el usuario con capturas + hard refresh (descartando caché), se midieron coordenadas de color píxel
por píxel sobre las capturas que mandó (`PIL`/Python: se ubicó dónde terminaba el fondo `bg-elevated`
de la caja de subida y dónde empezaba el de la primera tarjeta) para calcular el hueco real en CSS px y
compararlo contra lo que las reglas nuevas deberían producir. La diferencia (~34px de más, no explicada
por `.new-upload`/`.tape-list`) apuntó directo a un elemento intermedio con altura reservada — de ahí
se encontró `#newTapeStatus`.

**Verificado:** el usuario confirmó que tras este fix el hueco se ve correcto, en desktop
(`localhost:3000` con hard refresh) y en mobile (vía Cloudflare Tunnel).

## 8tervicies. Fix: "cambiar cinta" no llegaba a los invitados + host duplicado en la lista de espectadores (V11)

Bug reportado por el usuario: al usar "📼 Cambiar cinta", la película nueva solo se veía en la pantalla
del host — los invitados se quedaban con la vieja — y además aparecía en la pestaña "Espectadores" otro
usuario con el mismo nombre del host, "como si se duplicara".

**Causa raíz de ambos síntomas: cambiar de cinta implica que el host navega fuera de `room.html`.**
"Cambiar cinta" no es una acción in-page — el link `#changeVideoLink` manda al host a
`/library.html?fromRoom=<roomId>` a elegir el video, y al confirmar ("usar"), `library.html` hace
`window.location = /room/<roomId>` para volver. Eso son dos navegaciones de página completa, con todo
lo que implican para el socket del host: se cierra al salir de `room.html` y se abre de nuevo (con un
`socket.id` nuevo) al volver.

**Síntoma 1 — el cambio de video no llegaba a los invitados:** el servidor (`server.js`, rutas
`change-video` y `change-video-from-upload`) sí emitía `io.to(roomId).emit('video-changed', ...)`
correctamente a toda la sala — eso nunca estuvo roto. El bug estaba en `room.html`: **no existía
ningún `socket.on('video-changed', ...)` del lado del cliente.** El host "veía" el cambio solo porque,
al volver de `library.html`, la página se recarga entera y pide `room-data` de nuevo en el `join-room`
— trae el video nuevo por ese camino, no por el evento. Los invitados, que nunca navegan a ningún
lado, se quedan escuchando un evento que nadie procesa: su `<video>` sigue apuntando al archivo viejo
indefinidamente. Fix: se agregó el listener que faltaba (junto al de `subtitle-changed`, mismo patrón),
que pausa, limpia `src`, carga el archivo nuevo y resetea `lastKnownTime` a 0 para que el bloqueo de
seek de los invitados (sección 5) no los deje "atados" a un tiempo del video anterior.

**Síntoma 2 — entrada duplicada del host en la lista de espectadores:** al salir de `room.html` hacia
`library.html`, el socket del host se cerraba dejando que el navegador lo hiciera solo al descargar la
página (comportamiento por defecto de un `<a href>` normal), en vez de llamar a `socket.disconnect()`
explícitamente como sí hace, desde siempre, el botón "Salir" (`leaveBtn`, ver su handler unas líneas
arriba en `room.html`). La diferencia importa: un cierre "pasivo" del lado del navegador no le llega
al servidor con la misma inmediatez que un `disconnect()` explícito — el margen exacto depende del
transporte de Socket.io y de la red (p. ej. sobre Cloudflare Tunnel, ver README), pero mientras el
servidor no haya procesado el `disconnect` del socket viejo, ese socket sigue contando como conectado:
sigue en `io.sockets.adapter.rooms`, sigue con su entrada en `room.userNames` bajo el nombre del host.
Si la nueva conexión (al volver de la biblioteca, con un `socket.id` distinto) hace `join-room` **antes**
de que el servidor haya limpiado la vieja, `broadcastViewerList` arma la lista con ambos socket.id
todavía presentes — dos entradas, mismo nombre de host, una "viva" y una "fantasma" que recién
desaparece cuando el servidor por fin detecta el corte. Fix: se agregó un listener de `click` en
`changeVideoLink` que llama a `socket.disconnect()` antes de dejar que la navegación siga su curso —
mismo patrón que `leaveBtn` — para que el servidor se entere al instante y no quede ventana de
superposición.

**Nota:** el traspaso automático de host (sección 5bis) se sigue disparando igual que antes cuando el
host sale a cambiar de cinta (si hay algún invitado, se lo asciende brevemente hasta que el host
vuelve y `setHost()` lo recupera) — eso no es nuevo ni es lo que reportó el usuario, y de momento se
deja así; ver sección 10 si en algún momento se quiere evitar ese parpadeo rediseñando "cambiar cinta"
para que no implique salir de `room.html` en absoluto (ver también el ítem nuevo del roadmap).

## 8quatervicies. Mensajes de chat al crear la sala y al cambiar de cinta

Pedido del usuario: que aparezca un mensaje en el chat con el nombre del video cada vez que se cambia
de cinta, y también cuando se crea la sala (mostrando con qué video se creó).

**Cambio de cinta (`change-video` y `change-video-from-upload`, `server.js`):** justo antes de emitir
`video-changed` (ver sección 8tervicies), ahora también se emite `io.to(roomId).emit('chat-message',
{ system: true, text: '📼 Cambiaron la cinta: <nombre>' })`. El nombre sale de la nueva función
`videoDisplayName(videoFile)`, que hace `path.basename` sobre `room.videoFile` (`/uploads/archivo.mp4`
→ `archivo.mp4`) y le aplica `displayNameFor` (la misma función que ya limpiaba el prefijo hash `__`
para mostrar los nombres en la biblioteca, sección 8quater) — así el mensaje muestra el nombre legible
del archivo original, no el hash aleatorio con el que se guarda en disco.

**Cinta con la que se crea la sala (`create-room` y `create-room-from-upload`):** a diferencia de un
cambio de cinta, la creación de sala ocurre por HTTP, sin ningún socket todavía conectado a esa sala
— no hay a quién emitirle un `chat-message` en ese momento (el chat vive enteramente en sockets, nunca
se persiste ni hay historial). Se resolvió agregando un flag `initialVideoAnnounced` a `makeRoom()`
(arranca en `false`) y anunciando la cinta la primera vez que alguien hace `join-room` en esa sala —
en la práctica, el host, que entra a `/room/:id` justo después de crearla. El mensaje (`🎬 Cinta
cargada: <nombre>`) se emite una sola vez por sala (se apaga el flag al primer uso) para no repetirse
en cada join de invitados posteriores.

**Sin cambios en el cliente** — el chat ya sabía renderizar mensajes de sistema (`{ system: true,
text }`) desde antes; estos son mensajes más de ese mismo tipo, no un formato nuevo.

## 8quinvicies. Historial de chat server-side: sobrevive a la recarga de "cambiar cinta"

Pregunta del usuario, a raíz de la sección anterior: al host se le vaciaba el chat entero cada vez que
usaba "Cambiar cinta". Causa: el chat nunca se guardó en ningún lado del lado del servidor — es 100%
en vivo, cada mensaje se emite por socket y cada cliente lo va agregando a su propio DOM (`#messages`)
sin persistencia. "Cambiar cinta" implica que el host navega fuera de `room.html` (sección 8tervicies)
— recarga completa de página — así que su `#messages` se reconstruye vacío y nunca vuelve a llenarse,
porque no había ningún historial para pedirle al servidor. A los invitados no les pasaba porque su
socket nunca se desconecta durante ese flujo.

**Fix — historial en memoria por sala (`server.js`):** se agrega `chatHistory: []` a `makeRoom()` y
una constante `CHAT_HISTORY_LIMIT = 50` (últimos 50 mensajes, se descarta el más viejo al llegar al
tope — evita que una sala con mucha charla acumule memoria indefinidamente). La función
`pushChatHistory(room, msg)` centraliza el guardado; se llama junto a **cada** emisión de
`chat-message` que ya existía en el proyecto: mensajes de usuario (`chat-message` del cliente), "se
unió a la sala", "salió de la sala", traspaso manual de host (`make-host`), traspaso automático de host
al desconectarse, y los dos mensajes nuevos de la sección anterior ("cinta cargada" / "cambiaron la
cinta"). No se creó ningún helper que reemplace los `io.to()/socket.to().emit(...)` existentes —
se dejaron intactos y solo se les agregó el `pushChatHistory(...)` justo al lado, para no tocar de más
la lógica de quién recibe qué en vivo (algunos usan `socket.to()` para excluir al que dispara el
mensaje, por ejemplo "fulano se unió" no le llega a fulano mismo — eso sigue igual).

**Envío al cliente (`join-room`):** apenas el socket hace `join`, se le manda
`socket.emit('chat-history', room.chatHistory)` con el historial **tal como estaba antes de este
join** — antes de que se generen los mensajes propios de este join (cinta cargada / se unió), que le
van a llegar en vivo igual que a todos, ya que en ese punto el socket ya está en la sala (`socket.join`
ocurre más arriba). Este orden evita que esos mensajes se dupliquen (uno por el historial, otro en
vivo).

**Cliente (`public/room.html`):** nuevo listener `socket.on('chat-history', ...)` que limpia
`#messages` (`messages.innerHTML = ''`) y repinta cada mensaje del array recibido, reusando la misma
función de renderizado que ya usaba `chat-message` (se extrajo a `renderChatMessage(data)` para no
duplicar el HTML de renderizado entre ambos casos). **Por qué limpiar primero:** Socket.io puede
reconectarse solo (ej. un corte de wifi de un segundo) sin que la página se recargue — en ese caso
`chat-history` llega de nuevo con todo el historial, y sin este limpiado previo, los mensajes que ya
estaban en pantalla quedarían duplicados debajo de sí mismos.

**Nota:** el historial NO dispara los comentarios flotantes tipo "danmaku" (sección de pantalla
completa) al repintarse — `renderChatMessage` solo pinta en el panel de chat; `spawnDanmaku` se sigue
llamando aparte, solo para mensajes que llegan en vivo por `chat-message` (no tendría sentido que al
reconectar te lluevan de golpe 50 comentarios flotantes viejos sobre el video).

**Se mantiene 100% en memoria, no en disco:** si el servidor se reinicia, el historial de todas las
salas se pierde igual que el resto del estado (`rooms` entero vive en memoria, ver limitación ya
anotada en la sección 9 de este documento).

## 8sexvicies. Más emojis con scroll horizontal + responder a un mensaje (swipe o ícono) (V14)

Dos pedidos del usuario sobre el chat, a partir de una captura de pantalla en celular:

**Más emojis, con scroll en vez de que se apilen en varias filas.** La barra de reacciones rápidas
(`.reactions`) tenía 5 botones fijos (😂🔥😱❤️👏) con `flex-wrap: wrap` — con pocos entraban en una
fila, pero agregar más los mandaba a una segunda fila, comiéndose espacio vertical del chat. Se
sumaron los "más usados" que faltaban (😭😍👍🙌💀🎉😅, 12 en total) y se cambió el contenedor a
`flex-wrap: nowrap; overflow-x: auto;` — ahora es una sola fila que se desliza horizontalmente con el
dedo (o con el mouse en desktop), con una scrollbar fina temática en vez de la del navegador por
defecto (`scrollbar-width: thin` + `::-webkit-scrollbar` para Chrome/Android, que es lo que se ve en
la screenshot).

**Responder a un mensaje.** Pedido explícito: poder "agarrar" un mensaje y deslizarlo hacia la derecha
para dejarlo marcado como el que se está respondiendo — el gesto estándar de WhatsApp/Telegram/etc.
Se implementó con dos caminos, para cubrir touch y mouse:

1. **Swipe hacia la derecha (`public/room.html`, listeners de touch delegados en `#messages`):**
   `touchstart` guarda el punto de partida sobre el mensaje (`.msg`) tocado. En el primer `touchmove`
   que supera una "zona muerta" de 8px se decide la dirección: si el movimiento es más horizontal que
   vertical Y hacia la derecha, se "bloquea" como swipe-de-responder (se crea un ícono ↩ que va
   apareciendo a la izquierda del mensaje a medida que se arrastra, y el mensaje se corre con
   `transform: translateX(...)`, con un tope de 70px); si no, se suelta el gesto entero y el navegador
   sigue haciendo scroll vertical normal — no hace falta pelear con `preventDefault` en el listener
   (que además obligaría a declararlo no-pasivo) porque el CSS ya declara `touch-action: pan-y` en
   `.msg`: eso le dice al navegador "el pan vertical lo manejás vos nativo, lo horizontal es mío", así
   que los listeners quedan `{ passive: true }` sin perder nada. Al soltar (`touchend`), si se arrastró
   más de 46px se dispara `startReply(...)` (con una vibración cortita si el dispositivo lo soporta) y
   el mensaje vuelve a su lugar con una transición suave.
2. **Ícono ↩ por mensaje (funciona con mouse y como respaldo táctil):** cada mensaje renderizado
   (`renderChatMessage`) incluye un botoncito ↩ en la esquina superior derecha, casi invisible por
   defecto y visible al pasar el mouse (`:hover`) en desktop, o siempre semitransparente en pantallas
   táctiles (`@media (hover: none)`, ya que ahí el hover no existe). Un click/tap sobre él llama a la
   misma `startReply(...)`.

`startReply(user, text)` guarda `replyingTo = { user, text }` y muestra un banner arriba de la caja de
texto (`#replyPreview`, oculto por defecto) con la cita y un botón "✕" para cancelar
(`cancelReply()`). Al enviar (`sendChatMessage`), el payload que viaja por socket pasó de ser un string
plano a un objeto `{ text, replyTo }`; si había una respuesta armada, se manda junto y se limpia el
banner después de enviar.

**`server.js` (`socket.on('chat-message', ...)`):** ahora recibe ese objeto en vez de un string —
se acepta también un string plano por compatibilidad hacia atrás (por si queda algún cliente viejo en
caché sin recargar la página), y se sanitiza `replyTo` (debe ser un objeto con `user`/`text` string no
vacíos, se recortan a 40/200 caracteres) antes de armar el mensaje final `{ system: false, user, text,
replyTo }`, que se guarda en el historial (`pushChatHistory`, sección 8quinvicies) y se reenvía a toda
la sala como siempre. **No hay IDs de mensaje ni tabla de referencias** — la "respuesta" es una cita de
texto plano (usuario + contenido) embebida en el mensaje nuevo, no un link clickeable al mensaje
original; es la forma más simple que cubre el pedido sin sumar un sistema de identificadores por
mensaje que nada más en el proyecto necesita todavía.

**Cliente, renderizado (`renderChatMessage`):** si el mensaje trae `replyTo`, se pinta un bloque
citado arriba del texto (`.reply-quote`, con barra de color a la izquierda y recortado a 2 líneas con
`-webkit-line-clamp` para que una cita larga no infle la altura del mensaje). El historial
(`chat-history`, sección 8quinvicies) reutiliza el mismo `renderChatMessage`, así que las respuestas
también sobreviven a una recarga de página igual que el resto del chat.

## 8septvicies. Colores por nombre de usuario + confirmación al salir con el botón "atrás" (V15)

Dos pedidos del usuario tras la sesión de emojis/respuestas.

**Colores de nombre.** Antes todos los nombres de usuario (en el chat, la lista de espectadores y los
comentarios flotantes de pantalla completa) se veían del mismo color (`--pink` fijo por CSS, o cyan
fijo para los danmaku). Se armó una paleta de 7 colores neón pensada para la estética VHS/vaporwave ya
existente —`#ff2e9a` (rosa, el mismo `--pink`), `#b18aff` (violeta claro), `#ff7a45` (el mismo `--sun`),
`#4dff9e` (verde "tracking" de cinta), `#ffe066` (amarillo REC), `#5ec8ff` (azul eléctrico, distinto
del cyan) y `#ff5c72` (coral, distinto del rosa)— y una función `usernameColor(name, isHost)` en
`room.html` que hashea el nombre (`hashUsername`, hash simple tipo djb2/Java `String.hashCode`) a un
índice fijo de esa paleta: **el mismo nombre siempre saca el mismo color**, sin importar reconexiones
ni recargas de página, porque no depende de ningún estado — es puro cálculo sobre el string. El host
tiene un color reservado aparte, el `--cyan` de la app (el mismo que ya usa el ícono 🎛 en la lista de
espectadores), para que siempre se distinga quién tiene el control en ese momento; ese color no entra
en el hash de los demás para que ningún invitado se lo gane por casualidad.

Se aplica en tres lugares: el nombre en cada mensaje de chat y en la cita cuando el mensaje es una
respuesta (`renderChatMessage`), el nombre en los comentarios flotantes de pantalla completa
(`spawnDanmaku`, ahora recibe un tercer parámetro `isHost`), y el nombre en la lista de espectadores
(`viewer-list`). Para que el color de un mensaje de chat refleje "¿esta persona era el host cuando
escribió esto?" y no "¿es el host ahora?" (el control remoto puede pasar de mano en mano durante la
sala, sección 5bis), el servidor (`server.js`, handler `chat-message`) agrega `isHost: !!socket.isHost`
al mensaje que arma y guarda en el historial — así un mensaje viejo no cambia de color retroactivamente
solo porque el host actual es otro.

**Confirmación al salir con el botón "atrás".** El botón "Salir" (`leaveBtn`) ya pedía confirmación
desde siempre, pero el botón/gesto de "atrás" del navegador (o el físico de Android) nunca pasaba por
ahí — simplemente sacaba a la persona de `room.html` directo, sin preguntar nada. El usuario contó el
caso de una amiga que le erró dos veces seguidas al botón de atrás mientras miraba una peli y salió sin
querer, y como había entrado por el link directo de la sala (sin nada antes en su historial de
navegación), no había "a dónde volver" — tuvo que reingresar con el link de nuevo.

Se resolvió con el truco estándar para interceptar "atrás" en una página sin sistema de rutas propio:
al cargar `room.html` se empuja un estado extra al historial (`history.pushState({ mnRoomGuard: true },
'', location.href)`) con la misma URL actual. Cuando la persona aprieta atrás, el navegador hace "pop"
de ese estado extra en vez de salir de la página de una — eso dispara el evento `popstate`, que se
intercepta re-empujando el mismo estado guardia de inmediato (por eso funciona incluso con dos
"atrás" seguidos como en el caso de la amiga: el segundo también cae en el mismo guardia, no hay
ventana en la que se escape) y recién ahí se muestra la misma confirmación que ya usaba "Salir". Si
confirma, se sale de verdad (`socket.disconnect()` + `location.href = '/'`); si cancela, se queda
exactamente donde estaba, sin haber navegado a ningún lado. Un flag `leaveConfirmOpen` evita abrir dos
diálogos superpuestos si el "atrás" se aprieta varias veces mientras el primero todavía espera
respuesta.

Esto es específico a la navegación por historial (atrás/adelante) — no se tocó nada relacionado a
`beforeunload` (cerrar pestaña, escribir otra URL, etc.): esos disparadores son mucho menos confiables
en celular (Chrome Android restringe cada vez más los diálogos de `beforeunload` y a veces ni siquiera
los muestra) y además dispararían un aviso confuso durante la navegación interna de "cambiar cinta"
(que también navega fuera de `room.html` a propósito, sección 8tervicies) si no se excluía
cuidadosamente — el guardia de `popstate` no tiene ese problema porque solo reacciona a "atrás", nunca
a una navegación hacia adelante como la de `changeVideoLink` o `leaveBtn`.

## 8octovicies. Fix: el nombre citado en una respuesta no usaba el color de host (V16)

El usuario reportó (con captura) un mensaje donde el nombre citado dentro de una respuesta aparecía en
un color (rosa) distinto al que ese mismo nombre tenía como autor de su propio mensaje (cyan, el color
de host) — dos colores para la misma persona en la misma conversación.

Causa: `usernameColor(name, isHost)` (sección 8septvicies) sí recibía el `isHost` correcto para pintar
al autor de cada mensaje, pero la línea que pinta el nombre **citado** dentro de `reply-quote` llamaba
a esa misma función pasándole `false` a mano, en vez del `isHost` real de la persona citada — un
descuido del momento en que se armó el sistema de "responder" (V14, sección 8sexvicies), que nunca
había necesitado saber si el citado era host porque los colores de nombre no existían todavía.

El dato de `isHost` de la persona citada nunca llegaba tan lejos como para poder usarse ahí, así que
hubo que hacerlo viajar por las tres vías que pueden iniciar una respuesta:

- **`renderChatMessage`** ahora guarda `isHost` también en el `dataset` de cada mensaje (`data-ishost`,
  como string `'true'`/`'false'` porque el `dataset` del DOM solo admite strings), no solo `user` y
  `text` como antes.
- **`startReply(user, text, isHost)`** suma un tercer parámetro y lo guarda en `replyingTo.isHost`,
  que ya viajaba como parte de `{ text, replyTo }` al emitir `chat-message` (sección 8sexvicies) — no
  hizo falta tocar ese envío, solo lo que se le carga adentro.
- Los dos lugares que llaman a `startReply` — el click en el ícono ↩ y el gesto de swipe (ambos en
  `public/room.html`) — ahora leen `row.dataset.ishost === 'true'` y se lo pasan.
- **`server.js`**, handler `chat-message`: al sanitizar `rawReply` (el objeto `replyTo` que llega del
  cliente) ahora también copia `isHost: !!rawReply.isHost` al objeto `replyTo` final que se guarda en
  el historial y se reenvía a todos — antes solo copiaba `user` y `text`, así que aunque el cliente
  hubiera mandado el dato bien, el servidor lo tiraba.
- Con todo eso ya viajando de punta a punta, el bug de fondo se arregla con un solo cambio real en
  `renderChatMessage`: `usernameColor(data.replyTo.user, data.replyTo.isHost)` en vez del `false` fijo.

Igual que con el `isHost` del mensaje raíz (sección 8septvicies), el de la cita queda "congelado" en el
momento de responder — si el control de host cambia de mano después, las citas viejas no cambian de
color retroactivamente.

## 8novovicies. Cloudflare R2 — Fase 1: infraestructura aislada (sin conectar todavía)

**Motivo:** el usuario probó una sesión real con 3 personas (él en localhost + dos amigas por celular
conectadas vía el link de Cloudflare Tunnel), con un video de 3GB / 1:50:00. El video andaba perfecto
del lado de quien está en localhost, pero se trababa constantemente para las dos conectadas por el
link del túnel — por igual en ambos celulares, con buena banda ancha residencial de por medio (500/460
Mbps). Se descartó que fuera el internet de las invitadas o del usuario: el patrón (localhost bien,
túnel mal, igual en dos redes distintas) apunta a un cuello de botella del lado del "Quick Tunnel"
gratis de `cloudflared` — abre una única conexión saliente desde la compu del host, y todo el tráfico
de video hacia todos los espectadores remotos se multiplexa por ese mismo canal. Con un archivo pesado
y más de un espectador remoto pidiendo distintas partes del archivo (buffering, seeks), ese canal
único se satura.

**Por qué R2 en vez de otras alternativas** (bajar bitrate, túnel nombrado, ngrok): de todas las
opciones evaluadas, R2 es la única que resuelve el problema de raíz — si el video vive en el bucket,
ya no sale de la compu del host en absoluto, lo sirve directo la red de borde de Cloudflare a cada
espectador. Tier gratis real: 10GB de storage + 1M operaciones Clase A (escritura/listado) + 10M
operaciones Clase B (lectura) al mes, **y egress siempre gratis, sin tier** — que es justo el recurso
que se agotaba. Lo único no 100% gratis: Cloudflare pide un método de pago cargado en la cuenta para
habilitar R2 la primera vez (no cobra nada mientras se esté dentro del límite gratis).

**Alcance de esta fase (deliberadamente acotado):** esta sesión solo monta la infraestructura de R2
como una pieza aislada, sin tocar en absoluto el flujo que ya funciona hoy (disco local vía Multer).
Conectar R2 a la creación de salas, cambio de cinta y biblioteca es Fase 2 y 3 (pendientes, ver
sección 10). Se decidió así a propósito para poder revisar/probar la conexión a R2 por separado antes
de tocar código que ya está en uso.

**`lib/r2.js` (nuevo archivo):** módulo con toda la lógica de R2, aislado de `server.js`:
- `isR2Enabled()`: `true` solo si las 4 variables de entorno obligatorias están seteadas
  (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`). Si falta cualquiera,
  el resto de las funciones del módulo tiran un error claro al llamarse — pensado para que sea
  imposible "olvidarse" de chequear el modo antes de usar R2 en el código que lo consuma más adelante.
- `getClient()`: arma (lazy, una sola vez) un `S3Client` del SDK oficial de AWS
  (`@aws-sdk/client-s3`) apuntando al endpoint S3-compatible de Cloudflare
  (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`) con `region: 'auto'` — R2 no tiene regiones tipo
  AWS, ese es el valor que el SDK espera para este caso. No hizo falta ningún SDK propio de
  Cloudflare: R2 es compatible con la API de S3.
- `testConnection()`: hace un `HeadBucketCommand` (no sube ni lista nada pesado) para validar
  credenciales/nombre de bucket. Pensada para usarse al arrancar el server en Fase 3, para avisar por
  consola si algo está mal configurado antes de que alguien intente subir un video.
- `makeObjectKey(originalName)`: arma la key del objeto con el mismo criterio que ya usa Multer en
  disco (`server.js`, `storage.filename`) — prefijo random de 4 bytes + `__` + nombre original
  saneado — para que la biblioteca (Fase 3) pueda seguir mostrando nombres legibles reusando
  `displayNameFor` tal cual está, sin tener que tocarlo.
- `uploadStream(key, bodyStream, contentType)`: sube un stream directo a R2 usando
  `@aws-sdk/lib-storage` (`Upload`, no `PutObject` simple) porque maneja multipart upload — necesario
  para videos de varios GB, que es el caso de uso central de este proyecto. No pasa por disco ni se
  carga entero en memoria.
- `listObjects()` / `deleteObject(key)`: paginan (de a 1000, el máximo de la API S3) y devuelven el
  mismo shape que ya usa `GET /api/uploads` en modo local (`filename`, `size`, `mtime`), para que
  Fase 3 pueda enchufar esto en la biblioteca sin tocar el HTML/JS del cliente.
- `getPublicUrl(key)`: arma el link servible por el navegador a partir de `R2_PUBLIC_URL` (el
  subdominio gratis `*.r2.dev` que da Cloudflare al activar acceso público en el bucket, o un dominio
  propio). Tira error si `R2_PUBLIC_URL` no está seteada.

**Dependencias nuevas:** `@aws-sdk/client-s3` y `@aws-sdk/lib-storage` (ambas open source, del SDK
oficial de AWS — no hay forma de hablar con la API S3-compatible de R2 sin algo así). Se agregaron a
`package.json`/`package-lock.json` con `npm install --save`, sin tocar ninguna dependencia existente.

**`.env.example`:** se agregaron las 5 variables de R2 (las 4 obligatorias + `R2_PUBLIC_URL`),
comentadas por default y documentadas — dejarlas sin completar no cambia nada del comportamiento
actual del server.

**Modo dual, explícito desde el día 1:** todavía no hay ningún lugar del código que llame a
`lib/r2.js` — `server.js` sigue exactamente igual que antes de esta sesión. `isR2Enabled()` da
`false` en cualquier instalación existente (nadie tiene esas variables seteadas todavía), así que esta
sesión no cambia el comportamiento observable de la app en absoluto; es solo la pieza de
infraestructura sobre la que se va a construir Fase 2.

**README:** nueva sección "Cloudflare R2 (opcional...)" con el contexto del problema (mismo que arriba,
resumido) y la guía paso a paso para crear el bucket, activar acceso público, generar credenciales de
API, y completar el `.env` — para que alguien pueda dejar todo listo del lado de Cloudflare *antes* de
que Fase 2 conecte el código.

## 8tricies. Cloudflare R2 — Fase 2: la subida de video ya sube directo al bucket

**Motivo:** seguía de la sección anterior (8novovicies) — ahí solo se había montado `lib/r2.js` como
pieza aislada, sin que ningún endpoint la usara todavía. Esta sesión conecta esa infraestructura a las
dos rutas que reciben un archivo de video: `POST /create-room` y `POST /room/:id/change-video`.

**Decisión de arquitectura (server-proxy-stream, no presigned URL):** se evaluaron dos formas de
conectar R2 acá — (a) que el navegador suba directo a R2 con una URL prefirmada, sin pasar en absoluto
por el servidor/túnel, o (b) que el navegador siga subiendo al servidor exactamente igual que hoy, y
sea el servidor quien reenvíe ese stream a R2 sin tocar disco. Se eligió (b) porque el problema real
que motivó todo esto (ver 8novovicies) fue de **reproducción** para espectadores remotos, no de
subida — la persona que sube el video lo hace una sola vez, no es tráfico simultáneo de varios
espectadores pidiendo partes distintas de un archivo a la vez, que es lo que saturaba el túnel. Con
(b) se resuelve el cuello de botella real con bastante menos superficie de cambio: no hace falta tocar
`index.html`/`room.html`/`library.html` (la barra de progreso de subida sigue midiendo lo mismo que
antes — bytes del navegador al servidor — y sigue funcionando igual), y no hace falta configurar CORS
en el bucket. Queda anotado como posible mejora futura si algún día un invitado remoto (no el host) es
quien sube seguido videos pesados desde su propia conexión (ver sección 10).

**`server.js` — motor de storage de Multer para R2 (`r2VideoStorage`):** Multer ya se usaba para
recibir el archivo (antes solo con `multer.diskStorage`, que lo escribe en disco). Se agregó un
segundo motor que implementa la misma interfaz (`_handleFile`/`_removeFile`) pero, en vez de escribir
a disco, toma `file.stream` — el stream crudo de esa parte del multipart, mientras todavía está
llegando por HTTP — y lo empalma directo a `r2.uploadStream()` (la función que ya existía desde la
Fase 1, sube en partes/multipart). El archivo nunca toca el disco del servidor ni se carga entero en
memoria en ningún punto: entra por un lado (request HTTP) y sale por el otro (subida a R2) al mismo
tiempo. Se intercala un `PassThrough` en el medio solo para contar bytes que pasan (no retiene ni
altera los datos) y así poder devolver `size`, igual que ya hace el motor de disco.

**Selección de motor una sola vez, al arrancar (no por request):** `const videoStorage = r2.isR2Enabled() ? r2VideoStorage : storage`.
Como `isR2Enabled()` depende de variables de entorno que ya están cargadas por `loadDotEnv()` antes de
que se ejecute esta línea, el modo queda fijo para toda la vida del proceso — no hay mezcla de "esta
subida sí, esta otra no" dentro de una misma corrida del servidor.

**`videoUrlForUploadedFile(file)`:** función que arma la URL final a partir del `req.file` que deja
Multer (con cualquiera de los dos motores) — `r2.getPublicUrl(file.key)` si R2 está activo, o
`/uploads/' + file.filename` en modo local, igual que antes. Se usa en `/create-room` y
`/room/:id/change-video`, reemplazando el armado manual de la ruta que había antes en ambos. El
cliente (`room.html`) no necesita saber cuál de las dos es: sigue haciendo `player.src = videoFile`
tal cual, sea una ruta local o una URL absoluta de R2 (confirmado con pruebas, ver más abajo).

**`videoDisplayName()` (ya existía) sigue funcionando sin cambios con URLs de R2:** separa por nombre
de archivo con `path.basename()` y por el separador `__` que ya usa el nombre. Como
`r2.makeObjectKey()` arma la key del objeto con el mismo criterio que Multer usa en disco (prefijo
random + `__` + nombre original saneado, ver Fase 1), `path.basename('https://pub-x.r2.dev/ab12cd34__Mi Pelicula.mp4')`
devuelve `ab12cd34__Mi Pelicula.mp4` igual que con una ruta local, así que los mensajes de chat de
"cinta cargada"/"cambiaron la cinta" muestran el nombre legible sin ningún cambio adicional.

**Manejo de errores como JSON (nuevo middleware de errores en `server.js`):** antes, un archivo que
supera el límite de Multer, o ahora un fallo de R2 a mitad de subida (credenciales mal puestas, bucket
inexistente, conexión caída), tiraba un error sin manejar que Express devolvía como su página HTML de
error por defecto — rompía el `xhr.onload`/`JSON.parse()` del cliente en `index.html`/`library.html`,
que siempre espera JSON de estas rutas. Se agregó un middleware de errores de Express (al final de
todas las rutas que usan `upload.single('video')`, como exige Express para que pueda atraparlos) que
devuelve `{ error: '...' }` con status apropiado: 400 si es un `MulterError` (ej. archivo demasiado
grande), 502 si es un fallo de R2.

**Chequeo de conexión a R2 al arrancar el server:** si `isR2Enabled()` es `true`, se llama a
`r2.testConnection()` (ya existía desde la Fase 1, no se usaba en ningún lado todavía) apenas arranca
el servidor, y se imprime por consola si la conexión es válida o si algo está mal configurado — para
detectarlo ahí, no recién cuando alguien intente crear una sala. A propósito **no hay ningún modo de
emergencia que caiga a disco local si esto falla**: si `R2_ACCOUNT_ID` etc. están seteadas pero mal
(typo, bucket borrado, credencial revocada), crear sala o cambiar de cinta va a fallar con el error
JSON de arriba en vez de guardar en disco por sorpresa — se prefirió un fallo explícito y ruidoso a
una mezcla silenciosa de "algunos videos en disco, otros en el bucket" según qué tan bien haya andado
R2 en ese momento puntual.

**Qué NO se tocó en esta sesión (a propósito):**
- `POST /create-room-from-upload` y `POST /room/:id/change-video-from-upload` (reutilizar un video ya
  subido, sin resubir nada) — estas rutas siguen validando y sirviendo **solo** contra disco local
  (`isValidUploadFilename`), sin ningún cambio. La razón: el único lugar de donde sale el `filename`
  que estas rutas reciben es `library.html`, que a su vez lista `GET /api/uploads` — y esa ruta sigue
  leyendo solo disco local hasta la Fase 3 (ver sección 10). Conectar estas dos rutas a R2 sin que la
  biblioteca sepa listar objetos de R2 no serviría de nada todavía (nadie podría llegar a mandar la key
  de un objeto de R2 desde la UI); por eso se dejó explícitamente para la Fase 3, junto con
  `/api/uploads`.
- ~~**Efecto colateral esperado de lo anterior:** con R2 activo, un video subido a partir de ahora (por
  `/create-room` o `/room/:id/change-video`) **no aparece** en `library.html` para reutilizarlo más
  tarde — solo se puede volver a subir.~~ Resuelto en la Fase 3 (ver sección 8quatricies).
- `subtitleUpload` (subtítulos .srt/.vtt) sigue guardándose en disco local sin cambios — son archivos
  de texto chicos, no aportan nada al problema de ancho de banda que motivó todo esto.

**Cómo se probó (sin credenciales reales de R2 en este entorno):** se armó un `lib/r2.js` de prueba
(stub, no forma parte de este commit) que simula `isR2Enabled() = true` y cuenta bytes en vez de
hablar por red de verdad, para validar: (1) un video de 5MB subido a `/create-room` en "modo R2" nunca
toca `public/uploads/` y el stub reporta haber recibido exactamente esos 5MB en streaming; (2) por
socket, `room-data` llega con `videoFile` en formato URL de R2 (`https://pub-.../hash__nombre.mp4`);
(3) si `uploadStream()` o `testConnection()` fallan, el servidor avisa por consola al arrancar y
responde `502` con JSON al intentar crear sala (no HTML); (4) si Multer corta por límite de tamaño,
responde `400` con JSON. En modo local (sin R2 configurado) se repitió la prueba de subida real de un
archivo y se confirmó que el comportamiento no cambió en nada respecto de antes de esta sesión.

## 8quatricies. Cloudflare R2 — Fase 3: la biblioteca lista, reutiliza y borra directo del bucket

Cierra lo que había quedado pendiente en la Fase 2 (sección 8tricies): con R2 activo, la biblioteca
(`library.html`) ahora lee y escribe contra el bucket, no contra disco local.

- **`isValidUploadReference(filename)` (async)** reemplaza a la vieja `isValidUploadFilename`
  (síncrona, solo disco) que existía desde antes de la Fase 1. Mismo chequeo de path traversal en los
  dos modos (`filename !== path.basename(filename)`, sin `..`); la diferencia es cómo confirma que el
  archivo/objeto existe de verdad: `fs.existsSync` en modo disco, `r2.objectExists(filename)` (HEAD
  puntual, no lista todo el bucket) en modo R2. La usan las 4 rutas de abajo — todas pasaron de
  callbacks síncronos a `async`/`await` por este cambio.
- **`GET /api/uploads`**: en modo R2 llama a `r2.listObjects()` (ya existía desde la Fase 1) en vez de
  `fs.readdir`, filtra por `VIDEO_EXTENSIONS` igual que en disco, y arma el mismo shape de respuesta
  (`filename`, `displayName`, `size`, `mtime`) — `displayNameFor()` no cambió, sigue separando por el
  `__` que tanto `multer.diskStorage` como `r2.makeObjectKey()` usan como separador entre el hash
  random y el nombre original.
- **`DELETE /api/uploads/:filename`**: valida con `isValidUploadReference` y, en modo R2, borra con
  `r2.deleteObject()` (ya existía desde la Fase 1) en vez de `fs.unlink`.
- **`POST /create-room-from-upload` y `POST /room/:id/change-video-from-upload`**: mismo cambio —
  validan con `isValidUploadReference` y arman `room.videoFile` con `videoUrlForExistingFile()`
  (nueva; mismo criterio que `videoUrlForUploadedFile()` de la Fase 2, pero para un archivo que ya
  existe en vez de uno que se está subiendo ahora): `r2.getPublicUrl(filename)` en modo R2, o
  `'/uploads/' + filename` en modo disco.
- **Por qué `filename` sigue llamándose así en el body/params** aunque en modo R2 es en realidad una
  key de objeto: no hizo falta cambiar el nombre ni tocar `public/library.html` — el cliente nunca
  interpreta ese valor, solo lo recibe de `GET /api/uploads` y lo reenvía tal cual a las otras 3 rutas
  (ver `useTape`/`deleteTape` en `library.html`). Es un identificador opaco de punta a punta.
- **Manejo de errores**: las 4 rutas devuelven `502` con JSON si R2 falla a mitad de la operación
  (credenciales mal puestas, bucket borrado, conexión caída) — mismo criterio de "fallo explícito, sin
  respaldo silencioso a disco" que ya usaba la Fase 2 para las subidas (ver sección 8tricies). Antes de
  esta sesión, un error de R2 en estas 4 rutas no estaba contemplado en absoluto (las funciones de
  `lib/r2.js` que llamaban simplemente no se llamaban todavía).

**Qué NO cambió:** `subtitleUpload` (.srt/.vtt) sigue en disco local sin cambios, por la misma razón
que en la Fase 2 (archivos de texto chicos, no aportan al problema de ancho de banda). El límite de
tamaño de Multer (8GB) y el middleware de errores JSON de la Fase 2 tampoco se tocaron — esta sesión
no agregó ninguna subida nueva, solo listar/reutilizar/borrar de algo que ya está en el bucket.

**Cómo se probó (sin credenciales reales de R2 en este entorno):** en modo disco local (R2
desactivado) se corrió el flujo completo end-to-end contra el server real (no un stub): subir un video
a `/create-room`, listar con `GET /api/uploads`, reutilizarlo con `/create-room-from-upload`, y
borrarlo con `DELETE /api/uploads/:filename` — incluyendo el caso de pedir borrar un `filename`
inexistente (debe responder `400`, no `500` ni colgarse) — para confirmar que pasar las 4 rutas a
`async`/`await` no cambió nada del comportamiento ya existente. Aparte, se arrancó el server con las 4
variables de entorno de R2 seteadas pero apuntando a credenciales inventadas (no hay bucket real
detrás) para confirmar que `GET /api/uploads` responde `502` con JSON en vez de tirar un error sin
manejar o colgar la request — coherente con el aviso por consola que ya imprime `testConnection()` al
arrancar desde la Fase 2.

**Con esto se cierran las 3 fases de R2 del roadmap.** Con las 4 variables de entorno completas, todo
el ciclo de vida de un video (subir, listar en la biblioteca, reutilizar sin resubir, cambiar de cinta
en una sala activa, borrar) pasa por el bucket sin tocar el disco del servidor — y `library.html`
funciona exactamente igual para quien la usa, sin ningún cambio de UI, sea que R2 esté activo o no.

## 8quinquicies. Dominio fijo — túnel con nombre de Cloudflare (opcional)

Hasta ahora, la sección de README "Cómo usarla con amigos fuera de tu red" solo documentaba el
**Quick Tunnel** (`cloudflared tunnel --url ...`): gratis y sin configuración previa, pero da un link
random nuevo (`https://palabras-random.trycloudflare.com`) cada vez que se reinicia `cloudflared` — el
host tiene que volver a compartirlo con el grupo en cada sesión. Esta sesión agrega la alternativa de
**túnel con nombre**, que da el mismo link siempre, a costa de configuración única.

- **No es código de la app**: `cloudflared` es un binario externo, no una dependencia de `server.js` —
  esto es 100% configuración/documentación, `server.js` sigue sin saber nada de cómo se expone a
  internet (mismo `localhost:3000` de siempre).
- **Requisito**: un dominio propio ya agregado como zona en la cuenta de Cloudflare (no hace falta
  comprarlo ahí — Cloudflare no vende dominios directo — alcanza con comprarlo en cualquier
  registrador y apuntar los nameservers a Cloudflare, que es gratis).
- **`cloudflared-config.example.yml` (nuevo, se sube a git)**: plantilla con los 3 valores que hace
  falta completar (nombre/UUID del túnel, ruta al archivo de credenciales que genera
  `cloudflared tunnel create`, y el subdominio elegido). Mismo patrón que `.env.example`: se copia a
  `cloudflared-config.yml` (sin `.example`) y ese archivo real **no** se sube a git — se agregó a
  `.gitignore` junto a `.env`.
- **`package.json`**: nuevo script `"tunnel": "cloudflared tunnel --config cloudflared-config.yml run"`
  — así el comando para levantar el túnel con nombre es `npm run tunnel`, simétrico a `npm start` para
  el servidor. No reemplaza al Quick Tunnel (`cloudflared tunnel --url ...` sigue documentado igual,
  sigue siendo la opción más simple si no importa que el link cambie).
- **README**: sección nueva "Dominio fijo (túnel con nombre)" con la guía paso a paso completa (login,
  `tunnel create`, `tunnel route dns`, completar la plantilla, `npm run tunnel`) — los primeros 4 pasos
  son de una sola vez, después alcanza con repetir `npm run tunnel` en cada sesión.

**Qué NO se tocó:** nada de `server.js`, `lib/r2.js` ni el frontend — el server sigue escuchando en
`localhost:PORT` sin ningún cambio, sea que se exponga con Quick Tunnel, túnel con nombre, o ninguno de
los dos (uso solo en LAN).

## 8sexicies. Fix: R2 nunca se activaba usando `.env` (bug de orden de `require`) (V17) — CONFIRMADO

Un usuario real (no técnico) siguió toda la guía de R2 paso a paso — cuenta, bucket, token, `.env`
completado con las 5 variables — y el server igual imprimía `💾 Cloudflare R2 no está configurado`.
No era un error suyo: era un bug de código presente desde la Fase 1, que nunca se había notado porque
hasta ahora R2 solo se había probado pasando las variables directo por consola
(`R2_ACCOUNT_ID=x npm start`), nunca a través de un archivo `.env` real.

- **La causa:** `server.js` hacía `const r2 = require('./lib/r2')` **antes** de llamar a
  `loadDotEnv()`. `lib/r2.js` lee `process.env.R2_*` en constantes de nivel de módulo
  (`const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || ''`, etc.), una sola vez, en el momento exacto
  del `require` — y Node cachea el módulo, así que esas constantes quedan fijadas para siempre. Si en
  ese momento el `.env` todavía no se leyó, `isR2Enabled()` va a devolver `false` por el resto de la
  vida del proceso, sin importar qué haya en el `.env` ni que `loadDotEnv()` se ejecute dos líneas más
  abajo y sí llene `process.env` correctamente. Con variables de entorno reales (pasadas antes de que
  arranque `node`) esto nunca pasaba, porque ya estaban en `process.env` desde antes del `require` —
  por eso quedó sin detectar durante las 3 fases de R2.
- **El fix:** se movió `const r2 = require('./lib/r2')` a después de `loadDotEnv()` en `server.js`.
  Nada de `lib/r2.js` se tocó — el archivo sigue leyendo `process.env` de la misma forma, solo que
  ahora el `require` (y por lo tanto esa lectura) pasa después de que el `.env` ya se cargó. Se
  confirmó con una prueba mínima (`require` antes vs. después de setear las variables) que reproduce
  el bug y el fix exactos, y con el server real levantando con un `.env` de R2 de prueba: antes del
  fix imprimía "no está configurado" con las variables ya seteadas; después, pasa a intentar
  `testConnection()` como corresponde.
- **Nada más cambió**: el modo dual (disco local si R2 no está configurado) sigue funcionando igual;
  esto solo corrige que un `.env` bien formado ahora sí se detecte.

**Confirmado en producción, con el usuario real (dueño del proyecto):** después de aplicar este patch
y hacer `git pull`, el server pasó de "💾 Cloudflare R2 no está configurado" a "☁️ Cloudflare R2:
conectado. Las cintas nuevas se suben directo al bucket" — con el mismo `.env` que ya tenía, sin
tocarlo. Confirma que la causa era 100% el bug de orden de `require`; la hipótesis alternativa (líneas
de `.env` fusionadas) quedó descartada — era, como se sospechaba, un artefacto de copiar/pegar desde
la consola de PowerShell al mandar `Get-Content .env` por chat, no el contenido real del archivo.
(Nota aparte, sin relación con R2: en el medio apareció un `EADDRINUSE` al correr `npm start` — era
solo un proceso de Node viejo que había quedado corriendo en otra terminal y seguía ocupando el puerto
3000; se resolvió cerrándolo, sin ningún cambio de código.)

## 8septicies. Fix: el video se reiniciaba al minuto 0 al salir/reentrar de la sala (V18)

Reportado por el dueño del proyecto después de la primera sesión larga real (2h, con R2 ya andando):
cada vez que alguien salía de la sala y volvía a entrar, el video se reiniciaba al minuto 0. Era
particularmente grave si quien volvía a entrar era el host (o recuperaba el host al reingresar, algo
automático porque el `hostToken` queda guardado en `localStorage`): en ese caso el reinicio a 0 no se
autocorregía nunca, y al tocar play se propagaba a toda la sala.

- **La causa:** `join-room` mandaba `room-data` con el archivo del video (`videoFile`), pero nunca con
  el minuto en el que iba. El `<video>` del navegador arranca en el segundo 0 por defecto siempre que
  se le asigna un `src` nuevo (que es lo que pasa en toda carga fresca de `room.html`: primer ingreso,
  o volver a entrar después de haber salido). A un espectador común lo terminaba corrigiendo el
  próximo heartbeat del host (se manda cada 4s), lo cual se sentía como un salto/parpadeo molesto pero
  se autocorregía solo. Al host mismo, en cambio, nadie lo corrige — nadie le manda heartbeats a él —
  así que se quedaba en 0 de verdad hasta que tocara play, momento en el que ese 0 se emitía como
  `sync` a todos los demás.
- **El fix:** la sala ahora guarda en el servidor la última posición conocida del video
  (`room.videoPosition = { time, paused }`), actualizada en cada `sync` que manda el host (play,
  pause, seek, y el heartbeat de cada 4s como respaldo). `join-room` la manda de vuelta en `room-data`
  a quien se conecta. Del lado del cliente, `room.html` aplica esa posición (`player.currentTime` +
  seguir reproduciendo si `paused` es `false`) **solo** cuando el `<video>` se está cargando de cero
  (mismo `if` que ya decidía si había que asignar `player.src` de nuevo) — a propósito no se aplica en
  cada reconexión de socket.io mientras la pestaña sigue abierta (ej. un tropiezo de wifi de un
  segundo), porque en ese caso el `<video>` nunca se destruyó y ya sigue solo desde el minuto
  correcto; forzar un seek ahí metería un salto innecesario.
- **Al cambiar de cinta** (`change-video` / `change-video-from-upload`) la posición se resetea a
  `{ time: 0, paused: true }` a propósito — una cinta nueva arranca de cero, no del minuto en el que
  iba la anterior.
- **Verificado con una prueba de extremo a extremo** (cliente `socket.io-client` real, sin mockear
  nada): se crea una sala, el host avanza el video hasta el minuto 45:00 vía `sync`, se desconecta
  (simulando "Salir"), y al reconectar recuperando el host, `room-data` le manda `time: 2700` en vez
  de `0` — confirmado antes y después del fix (antes del fix siempre daba `0`).

## 8octicies. El "se durmió" cada ~15 min con Error 1033 — no es un bug de código, es el túnel rápido

También reportado en la misma sesión larga: cada tanto (variable, más o menos cada 15 minutos), dejaba
de poder escribir en el chat o pasar el host — aunque el video seguía reproduciéndose sin cortes — y
al recargar la página aparecía **Error 1033 de Cloudflare** ("Cloudflare Tunnel error... Cloudflare is
currently unable to resolve it"). Después de 1-2 intentos de volver a entrar con el mismo link,
volvía a andar solo.

- **Por qué el video seguía andando pero el chat no:** el `<video>` apunta directo a la URL pública
  del bucket de R2 (`https://pub-xxxxx.r2.dev/...`), un dominio de Cloudflare completamente aparte del
  túnel — así que sigue sirviendo bytes sin problema aunque el túnel esté caído. El chat, la lista de
  espectadores y el traspaso de host sí dependen de Socket.io, que viaja **a través** del túnel hacia
  `localhost:3000` — si el túnel tiene un corte breve, esa parte se cae mientras el video no.
- **La causa real, confirmada:** no es un bug de MovieNight ni de la sala en sí — es una limitación
  conocida y documentada de los **túneles rápidos** de Cloudflare (`cloudflared tunnel --url ...`,
  que generan un link `*.trycloudflare.com`), que es justamente el que se estaba usando. Cloudflare
  mismo advierte que estos túneles "sin cuenta" (quick tunnels) **no tienen garantía de actividad**
  ("no uptime guarantee") y pueden tener cortes breves sin aviso — no están pensados para sesiones
  largas o de producción.
- **La solución ya existe en el proyecto y no requiere cambio de código:** el túnel **con nombre**
  (sección 8quinquicies — `cloudflared-config.example.yml` + `npm run tunnel`, guía completa en
  README) usa infraestructura persistente de Cloudflare en vez de un túnel efímero, y no debería
  sufrir estos cortes de la misma forma. Recomendado para sesiones largas o cuando el corte
  intermitente moleste. No se tocó código por este tema — queda documentado acá para no repetir el
  diagnóstico si vuelve a pasar.

## 8novicies. Contraseña + límite de 3 intentos para subir cintas nuevas (V19)

Pedido explícito del dueño del proyecto tras conectar R2 en producción: con el server expuesto al
internet vía Cloudflare Tunnel, cualquiera con el link de la home (`index.html`) podía subir archivos
de video gigantes sin ninguna traba — y cada subida a R2 se factura (almacenamiento + operaciones).
Antes de este cambio no había ninguna protección en `/create-room` ni en `/room/:id/change-video`
(ver el ítem correspondiente en la sección 9, ahora resuelto).

- **La contraseña es la misma que ya existía** (`LIBRARY_PASSWORD`, la que protege listar/borrar en
  la biblioteca desde V9, sección 8septendecies) — no se agregó un secreto nuevo. Sigue siendo una
  sola variable de entorno para todo el server, no por sala.
- **Dónde se aplica:** solo en las dos rutas que reciben un archivo NUEVO y lo suben a R2/disco —
  `POST /create-room` (crear sala subiendo un video) y `POST /room/:id/change-video` (cambiar la
  cinta subiendo una nueva). **No** se tocaron `/create-room-from-upload` ni
  `/room/:id/change-video-from-upload` (reutilizar un video ya subido desde la biblioteca): esas no
  generan storage nuevo, así que no hay costo que proteger ahí. Tampoco se tocó
  `/room/:id/upload-subtitle`: los subtítulos siempre se guardan en disco local (nunca en R2, ver
  `subtitleUpload` en `server.js`) y tienen un límite de 5MB — no es el gasto que preocupaba.
- **El middleware nuevo (`requireUploadAuth` en `server.js`) es distinto de `requireLibraryAuth`**
  (que sigue igual, sin límite de intentos, para listar/borrar) porque acá el costo de un intento de
  más es mucho mayor: dejar pasar la subida real de un archivo pesado a R2 es peor que dejar pasar un
  `GET /api/uploads`. Por eso `requireUploadAuth` suma un límite de **3 intentos incorrectos por IP**
  antes de bloquear esa IP por **15 minutos** (constantes `UPLOAD_AUTH_MAX_ATTEMPTS` /
  `UPLOAD_AUTH_LOCKOUT_MS`), guardado en un `Map` en memoria (`uploadAuthAttempts`, se pierde si el
  server se reinicia — aceptable dado el caso de uso). Una contraseña correcta resetea el contador de
  esa IP a cero.
- **Se aplica ANTES de `upload.single('video')` a propósito**, para que una contraseña incorrecta
  corte la request antes de que Multer empiece siquiera a leer el archivo. Esto importa especialmente
  con R2 activo: el motor de storage de la Fase 2 (`r2VideoStorage._handleFile`, ver sección
  8tricies) sube el archivo a R2 **en streaming, a medida que llega** — si el chequeo de contraseña
  fuera posterior a Multer, la subida a R2 ya se habría completado (y facturado) para cuando el
  servidor recién se entera de que la contraseña era incorrecta. Por eso el cliente manda la
  contraseña por el header `x-library-password` (no como campo del `FormData`): un header HTTP está
  disponible antes de que arranque el parseo del cuerpo multipart, un campo del form no.
- **IP real detrás del túnel:** el server escucha en `localhost` y Cloudflare Tunnel le reenvía todo
  el tráfico desde la propia máquina — sin nada más, `req.ip` sería siempre la misma IP local para
  todo el mundo, lo que habría inutilizado el límite por IP (un intento fallido de cualquiera hubiera
  bloqueado a todo el grupo por igual). Se agregó `app.set('trust proxy', true)` + una función
  `clientIp(req)` que prioriza el header `Cf-Connecting-Ip` (el que agrega Cloudflare con la IP real
  del visitante) y cae a `req.ip`/`req.socket.remoteAddress` si no está presente (ej. corriendo en
  localhost sin túnel).
- **Frontend:** `index.html` (crear sala) y `library.html` (subir cinta nueva desde una sala, flujo
  `fromRoom`) piden la contraseña con el mismo componente de modal (`mnDialog`/`mnPrompt`) que ya
  usaban `room.html` y `library.html` — se copió el componente a `index.html`, que hasta ahora no lo
  tenía (usaba inputs simples en la página). La contraseña se cachea en `localStorage` bajo la MISMA
  clave que ya usa la biblioteca (`mn_library_pw`, ver `mnLibraryFetch` en `library.html`): si ya se
  desbloqueó la biblioteca una vez en ese navegador, crear sala o cambiar cinta no vuelve a pedir
  nada. Si el server responde 401 con intentos restantes, se reintenta la subida (con el mismo
  archivo ya seleccionado, sin que el usuario tenga que volver a elegirlo) pidiendo la contraseña de
  nuevo; si responde 401 sin intentos restantes o 429 (ya bloqueada), se corta y se avisa el motivo
  sin seguir insistiendo.
- **Verificado a mano** contra el server real (`LIBRARY_PASSWORD` de prueba): 3 contraseñas
  incorrectas seguidas devuelven `attemptsLeft` decreciente (2, 1, 0) y la 3ra ya viene con el aviso
  de bloqueo; un 4to intento —incluso con la contraseña correcta— devuelve `429` con los minutos
  restantes; una contraseña correcta en cualquier momento anterior al bloqueo resetea el contador a
  cero; y una subida real (archivo de prueba chico) con la contraseña correcta llega hasta Multer y
  crea la sala con normalidad. De paso se encontró y corrigió un bug en la primera versión del
  contador (reseteaba el conteo en cada intento en vez de acumularlo, porque comparaba
  `lockedUntil <= now` sin chequear primero que `lockedUntil` fuera `> 0`) — quedó corregido antes de
  este commit, no llegó a versionarse roto.

## 9. Riesgos / cosas pendientes de endurecer (seguridad)

- El `hostToken` viaja en texto plano por HTTP (a menos que Cloudflare Tunnel lo cifre en tránsito, que sí lo hace vía HTTPS). Si alguien lo obtiene (inspeccionando `localStorage` de la persona equivocada, por ejemplo), puede hacerse pasar por host.
- La contraseña de sala (V7) y la de biblioteca (V9) usan `sha256` sin salt — suficiente para que alguien con el link no entre "sin querer", pero no es resistente a un atacante que se lo proponga en serio (sin rate-limiting en `join-room` ni en `requireLibraryAuth`, se podrían probar contraseñas por fuerza bruta). Dado el caso de uso (grupo de amigos), se consideró un trade-off aceptable.
- No hay rate-limiting en el chat ni en `join-room` (intentos de contraseña de sala) — un usuario malicioso podría floodear el chat o probar contraseñas de sala repetidamente. `requireLibraryAuth` (listar/borrar biblioteca) tampoco tiene límite de intentos, a propósito: el costo de un intento de más ahí es bajo (una lectura), a diferencia de subir un archivo nuevo.
- ~~No hay rate-limiting en... la subida de archivos~~ — resuelto en V19 para las rutas que suben un archivo NUEVO (`/create-room`, `/room/:id/change-video`, las que consumen storage de R2 y se facturan): ahora exigen la contraseña de biblioteca y bloquean la IP 15 minutos tras 3 intentos incorrectos (ver sección 8novicies). Las rutas que reutilizan un video ya subido (`*-from-upload`) no se tocaron porque no generan storage nuevo.
- No hay validación de tipo de archivo más allá de lo que el navegador manda como `video/*` en el `<input accept>` (o la extensión `.srt`/`.vtt` para subtítulos) — no es una validación real de seguridad, solo de UX.
- Las salas nunca se borran ni expiran — si el server corre mucho tiempo, `rooms` y los archivos en `uploads/` se van acumulando. (Ahora al menos se pueden borrar a mano fácil desde `library.html`, ver sección 8quater.)
- Borrar un video desde `library.html` mientras una sala activa lo está usando rompe esa sala sin avisar (ver 8quater) — sigue sin resolverse en V9. Mitigado en parte por V9: ahora hace falta la contraseña de biblioteca para borrar, así que ya no puede pasar por accidente por un desconocido random con el link de una sala — pero un amigo del grupo (que sí tiene la contraseña) todavía podría borrar sin querer un video en uso.
- El traspaso automático de host (sección 5bis) elige al espectador que lleva más tiempo conectado sin ningún otro criterio (no hay forma de "vetar" a alguien de ser host automático). Improbable que sea un problema real dado que es para grupos de amigos, pero queda anotado.
- ~~`GET /api/uploads` y `DELETE /api/uploads/:filename` no pedían ninguna autenticación~~ — resuelto en V9 con `LIBRARY_PASSWORD` (ver sección 8septendecies). Era el riesgo más serio de esta lista: no requería ninguna habilidad especial, solo conocer el dominio del server (que ya se sabe con el link de una sala) y escribir `/library.html`.

## 10. Ideas pendientes / roadmap

- [ ] Borrado automático de salas/archivos viejos (ej. después de X horas sin actividad).
- [x] ~~Dominio fijo con Cloudflare Tunnel nombrado (requiere cuenta de Cloudflare + dominio propio) para no tener que compartir un link nuevo cada sesión~~ — resuelto (ver sección 8quinquicies): guía completa en README + `cloudflared-config.example.yml` + `npm run tunnel`.
- [ ] Posible: avisar si se intenta borrar un video que está en uso por una sala activa.
- [ ] Posible: contraseña también al reutilizar un video desde la biblioteca (`create-room-from-upload`), hoy solo existe al crear desde `index.html`.
- [ ] Posible: rate-limiting real en `join-room` (intentos de contraseña de sala) y en el chat (flood). El de la subida de archivos ya se resolvió (ver siguiente ítem).
- [ ] Posible: rediseñar "cambiar cinta" para que no implique salir de `room.html` (hoy navega a `library.html` y vuelve, ver sección 8tervicies) — evitaría el parpadeo de traspaso automático de host mientras el host elige la cinta nueva.
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
- [x] ~~Cloudflare R2 — Fase 2: conectar la subida de video (crear sala / cambiar cinta) al bucket~~ — resuelto (ver sección 8tricies).
- [x] ~~Cloudflare R2 — Fase 3: conectar la biblioteca (`library.html`, listar/reutilizar/borrar) al bucket~~ — resuelto (ver sección 8quatricies). Con esto se cierran las 3 fases planeadas de R2.
- [x] ~~Proteger la subida de video nuevo (crear sala / cambiar cinta) para que no cualquiera pueda llenar el storage de R2 y generar costo~~ — resuelto en V19: contraseña de biblioteca + bloqueo de 15 min tras 3 intentos incorrectos por IP (ver sección 8novicies).

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