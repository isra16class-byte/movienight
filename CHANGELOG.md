# 📜 CHANGELOG — MovieNight

Registro cronológico de cambios del proyecto. Formato: más nuevo arriba, nunca se borran entradas viejas.

Ver `MEMORIA.md` para el estado actual y contexto técnico completo — este archivo es solo la bitácora de "qué cambió cuándo".

---

## [2026-08-18] Fix — Faltaba `<meta name="viewport">` en las 3 páginas (causa real de "se ve raro en el celular")

**Motivo:** el usuario mandó una captura de su celular real mostrando la sala rota en vertical — a pesar de que la sesión anterior ("revisión completa de diseño adaptivo") había dado por buena la sala en celular. Al reproducir el caso exacto con emulación de un dispositivo móvil real (Pixel 7, vía Playwright), en vez de solo achicar la ventana de un Chrome de escritorio, se encontró la causa real.

**Causa encontrada:** ninguna de las 3 páginas (`index.html`, `library.html`, `room.html`) tenía la etiqueta `<meta name="viewport" content="width=device-width, initial-scale=1">`. Sin esa etiqueta, los navegadores móviles (Chrome/Safari) ignoran el ancho real de la pantalla y renderizan la página como si fuera de escritorio, a un ancho virtual de **980px** (el valor clásico de compatibilidad), y recién después la achican para que entre en la pantalla. Se confirmó midiendo `window.innerWidth` dentro de la página: en un Pixel 7 (ancho real 412px) daba **981px** — el navegador nunca se enteraba de que la pantalla era angosta, así que ninguna media query de `max-width` se disparaba nunca, ni las de este fix ni las de sesiones anteriores.

**Por qué no se detectó en la revisión anterior:** esa sesión probó los tamaños con Playwright fijando manualmente el ancho de un contexto de Chrome de escritorio (`newContext({ viewport: { width, height } })`), lo cual sí respeta ese ancho tal cual — sin darse cuenta de que eso **no reproduce** el comportamiento real de un navegador móvil sin meta viewport (que es un mecanismo aparte, específico de `isMobile: true`). Fue un punto ciego real del testing anterior, no algo que se pudiera ver leyendo el CSS.

**Fix:** una sola línea agregada al `<head>` de `index.html`, `library.html` y `room.html`:
```html
<meta name="viewport" content="width=device-width, initial-scale=1">
```

**Efecto colateral positivo:** además de arreglar el layout de la sala, esto corrige `index.html` y `library.html` — antes el texto se veía más chico de lo esperado en celular (todo el contenido estaba renderizado a "tamaño de escritorio" y después escalado hacia abajo); ahora usan el tamaño de fuente real definido en el CSS.

**Verificado con Playwright usando emulación real de dispositivo** (no solo resize de ventana): `devices['Pixel 7']`, `devices['iPhone 13']`, `devices['iPhone SE']`, `devices['Pixel 7 landscape']` y `devices['iPhone SE landscape']` — confirmando en cada caso que `window.innerWidth` dentro de la página coincide con el ancho real reportado por el propio dispositivo emulado (ej. 412px, 390px, 320px), y con capturas de pantalla de las 3 páginas mostrando el layout correcto en cada uno.

## [2026-08-18] Fix — Revisión completa de diseño adaptivo (todas las pantallas)

**Motivo:** pregunta directa del usuario ("¿mi app tiene diseño adaptivo para teléfono y todo tipo de pantalla?") tras el fix del layout de la sala en vertical — en vez de asumir que ya estaba todo resuelto, se armó una matriz de pruebas real con Playwright: 3 pantallas (`index.html`, `library.html`, `room.html`) × 7 tamaños (celular chico 360×640, celular normal 390×844, celular landscape 844×390, tablet portrait 768×1024, tablet landscape 1024×768, laptop 1366×800, desktop 1920×1080), más dos casos límite adicionales (landscape angosto tipo iPhone SE, 667×375, en las 3 pantallas).

**Bugs encontrados y arreglados, ambos en `public/style.css`:**
- **Sala en landscape angosto de celular** (ej. 667×375): la media query nueva del fix anterior forzaba el video a relación de aspecto 16:9 a ancho completo sin importar el alto disponible — en una pantalla de solo 375px de alto, eso hacía que el video ocupara el 100% y el panel de chat/sala **desapareciera por completo**, sin scroll ni forma de acceder a él (ni siquiera al botón "Salir"). Se separó en dos reglas: con alto suficiente (`min-height: 500px`) se apila video arriba / chat abajo como antes; con poco alto se mantiene el layout de fila (video + panel al costado, como en desktop) pero con el panel angostado a 220px y controles más compactos.
- **`index.html`/`library.html` en pantallas bajitas** (celular landscape, ventanas de escritorio chicas): la tarjeta central podía quedar más alta que la pantalla, cortando visualmente el botón "GRABAR SALA" y todo lo de abajo en el primer vistazo. No era un bug bloqueante (la página sí permite scroll, se verificó con una captura de página completa), pero se le bajó el padding vertical de la tarjeta en pantallas de menos de 500px de alto para que entre más contenido sin depender tanto de scrollear.
- Limpieza: se sacó código CSS muerto (`.change-video`) que había quedado huérfano desde el cambio de V7 que reemplazó ese input de archivo por el link a la biblioteca.

**Verificado con Playwright** (21 capturas de pantalla + 5 adicionales de casos límite, no solo lectura de código): las 3 pantallas se revisaron una por una contra los 7 tamaños + los 2 casos límite de landscape angosto, confirmando visualmente que no queda contenido cortado ni inaccesible en ningún tamaño probado.

**Conclusión para el roadmap:** con este fix, las 3 pantallas de la app (`index.html`, `library.html`, `room.html`) tienen diseño adaptivo cubierto para celular (portrait y landscape, incluyendo casos angostos), tablet (portrait y landscape) y desktop de cualquier tamaño.

## [2026-08-18] Fix — Sala rota en vertical/celular (le faltaba la media query)

**Motivo:** reporte del usuario ("se ve raro en el teléfono, como si no estuviera pensado para vertical").

**Causa encontrada:** `index.html` y `library.html` sí tenían media queries para mobile (agregadas en V5.1/V5.2/V6, verificadas con Playwright en su momento), pero **`room.html` nunca las tuvo**. El layout de la sala usa `.side { width: 300px; flex-shrink: 0 }` fijo al costado del video sin importar el ancho de pantalla — en un celular en vertical (~390px de ancho) eso deja el video comprimido en una franja de apenas ~90px y el panel de chat ocupando casi toda la pantalla.

**Fix en `public/style.css`:** nueva media query (`max-width: 820px`) que cambia `.screen-row` de fila a columna: video arriba con relación de aspecto 16:9, panel de chat/sala abajo ocupando el ancho completo y el resto del alto disponible. También se limpió CSS muerto (`.change-video`, clase que había quedado sin usar desde el cambio de V7 que reemplazó el input de archivo por el link a la biblioteca).
- Verificado con Playwright en viewport de 390×844 (tamaño típico de celular en vertical): captura de pantalla confirmando el layout apilado correctamente.

## [2026-08-18] Fix — Heartbeat de sync causaba "se queda cargando" aleatorio a todos

**Motivo:** reporte del usuario ("el video se queda cargando entre ratos"), pasándole a todos por igual y en momentos aleatorios — se descartó ancho de banda (test de velocidad del host: 428 Mbps de subida, 3ms de ping), lo que apuntaba a algo del propio código en vez de la conexión.

**Causa encontrada:** el heartbeat que el host manda cada 4s para mantener sincronizados a los invitados (existente desde V3) forzaba un salto duro de `currentTime` ante *cualquier* desvío mayor a 1.5 segundos — algo que pasa todo el tiempo por jitter normal de red/decodificación. Cada salto duro le hacía tirar al navegador el buffer pre-cargado y pedir de nuevo un pedazo del archivo al servidor, lo cual se percibía como "se queda cargando", cada 4 segundos, en cualquier invitado, en cualquier momento.

**Fix en `public/room.html`:** para desvíos chicos (0.5s–4s) ya no se salta — se ajusta `playbackRate` levemente (1.06x o 0.94x) hasta que se empareja solo, sin cortar el stream ni volver a pedir nada al servidor. Solo se sigue saltando de golpe (`currentTime = ...`) para desvíos grandes de verdad (más de 4 segundos), donde no queda otra opción.
- Verificado: sintaxis del script revisada con `node -c` tras el cambio.

## [2026-08-18] V7 — Traspaso de host, contraseña de sala, subtítulos, biblioteca desde la sala y varios pendientes del roadmap

**Motivo:** pedido directo del usuario ("¿el botón de cambiar cinta debería llevar a la biblioteca? ¿y un botón de salir?") + petición explícita de revisar qué funciones le faltaban a la app comparándola con apps de watch party existentes (Teleparty, Scener, Watch2Gether, un proyecto open-source similar) e implementar todo lo de prioridad alta/media que salió de esa revisión.

**Cambios en `server.js`:**
- **Traspaso de host**: si el host se desconecta y no queda ningún otro socket host conectado en la sala, el servidor asciende automáticamente al siguiente espectador conectado (orden de llegada) y le manda el `hostToken` para que persista en `localStorage`. También se agregó traspaso manual: el host puede darle el control remoto a cualquier espectador desde el panel "Sala" (evento `make-host`), sin quitarse su propio rol.
- **Contraseña de sala (opcional)**: `POST /create-room` y `/create-room-from-upload` aceptan un campo `password` opcional; se guarda hasheada (`sha256`) en `room.passwordHash`, nunca en texto plano. `GET /api/room/:id` ya no devuelve `videoFile` (para no exponer la ruta del archivo antes de validar contraseña) — solo indica `passwordProtected`. El `videoFile`/`subtitleFile` reales ahora viajan por socket (`room-data`) recién después de un `join-room` válido.
- **Subtítulos (.srt/.vtt)**: nueva ruta `POST /room/:id/upload-subtitle` (protegida por `hostToken`), convierte `.srt` a `.vtt` (cambia el separador decimal de coma a punto y agrega la cabecera `WEBVTT`) y notifica a toda la sala vía `subtitle-changed`.
- **Cambiar cinta reutilizando la biblioteca**: nueva ruta `POST /room/:id/change-video-from-upload` (protegida por `hostToken`, valida el nombre de archivo igual que el resto de rutas de biblioteca) — permite cambiarle la cinta a una sala activa sin volver a subir el video.
- **Buffering compartido**: nuevo evento de socket `buffering-status`; el servidor lo guarda por sala (`bufferingSockets`) y lo incluye en cada `viewer-list`, así todos ven quién está cargando (⏳).
- **Reconexión sin perder estado**: cada cliente ahora manda un `userId` persistente (guardado en `localStorage`, no cambia entre pestañas/recargas). El estado de "silenciado" ahora se guarda por `userId` en vez de por `socket.id`, así sobrevive una reconexión. Además, si alguien se reconecta dentro de los 15 segundos de haberse ido, no se repiten los mensajes de "se unió"/"salió" en el chat (evita floodear el chat por wifi inestable).
- **Chat**: el indicador de "escribiendo..." se retransmite vía nuevo evento `typing`. Los mensajes de chat ahora se recortan a 500 caracteres y los nombres de usuario a 40, como saneamiento básico.
- `public/room.html` y `public/library.html` cambiaron bastante; ver abajo.

**Cambios en `public/room.html`:**
- **Botón "Cambiar cinta"** ahora es un link a `/library.html?fromRoom=<roomId>` en vez de un `<input type="file">` que resubía el video directo — reutiliza toda la pantalla de biblioteca en vez de duplicar UI. `library.html` detecta el parámetro y adapta sus botones y su comportamiento (ver abajo).
- **Botón "🚪 Salir"** nuevo en la cabecera del panel lateral (visible para todos, no solo el host): desconecta el socket explícitamente y redirige a `/`.
- **Botones de salto ±10s** (`⏪ 10` / `10 ⏩`), visibles solo para el host, en la esquina inferior izquierda del reproductor.
- **Botón "Hacer host"** en la lista de espectadores (solo visible para el host, junto a Silenciar/Expulsar) para traspasar el control manualmente.
- **Subida de subtítulos** (`.srt`/`.vtt`) desde el panel "Sala", solo visible para el host. Se agrega un `<track>` al `<video>` cuando hay subtítulos activos, actualizado en vivo para todos vía socket.
- **Indicador de "escribiendo..."** debajo del historial de chat.
- **Ícono ⏳** junto al nombre de quien esté buffereando, en la lista de espectadores.
- **Prompt de contraseña** si la sala la tiene, antes de conectar el socket; reintenta si es incorrecta en vez de expulsar directo a la persona.
- Fix de seguridad menor de paso: los mensajes de chat y nombres de usuario ahora se escapan (`escapeHtml`) antes de insertarse como HTML — el código anterior insertaba texto de usuario sin escapar.
- El `hostToken` ahora puede llegar por socket (`host-status`) además de `localStorage`, para que el traspaso automático/manual de host funcione sin que la persona tenga que refrescar.

**Cambios en `public/library.html`:**
- Detecta `?fromRoom=<roomId>` en la URL. Si está presente: el título y el botón "◂ Volver" cambian de contexto ("ELEGIR CINTA PARA LA SALA" / "◂ Volver a la sala"), el botón "USAR" pasa a llamar `POST /room/:id/change-video-from-upload` (cambia la cinta de esa sala) en vez de crear una sala nueva, y aparece un bloque nuevo para **subir una cinta completamente nueva directo a esa sala** (usa la ruta original `POST /room/:id/change-video` con progreso real de subida, igual que en `index.html`) — esto evita que el rediseño le quite al host la posibilidad de poner un video que todavía no está en la biblioteca.
- Si no hay `fromRoom` en la URL, se comporta exactamente igual que en V6 (crea una sala nueva).

**Cambios en `public/index.html`:**
- Campo opcional "Contraseña de la sala" antes del botón "GRABAR SALA"; si se llena, se manda en el mismo `FormData` de la subida.

**Cambios en `public/style.css`:** estilos nuevos para el input de contraseña, el botón "Salir", los botones de salto ±10s, el panel de host (cambiar cinta + subtítulos), el indicador de "escribiendo...", y el bloque de subida nueva dentro de la biblioteca.

**Verificado en esta sesión** (contra un servidor real levantado localmente, no solo lectura de código): creación de sala con contraseña + `passwordProtected` reflejado en `/api/room/:id`; conexión de socket con contraseña incorrecta (rechazada) y correcta (aceptada); traspaso automático de host al desconectar al único host, confirmado con `viewer-list` y mensaje de sistema; subida de un `.srt` de prueba y verificación byte a byte de la conversión a `.vtt`; cambio de cinta de una sala activa vía `change-video-from-upload` con token inválido (403) y válido (200); intento de path traversal (`../server.js`) rechazado con 400, igual que en V6.

**Pendiente / fuera de alcance de esta sesión** (quedó anotado en `MEMORIA.md`): video/voz en vivo integrado, soporte multiplataforma (Netflix/YouTube/etc.), rate-limiting real de chat/subida — se evaluaron y se decidió no implementarlos por ahora dado que la app es explícitamente para grupos privados chicos, no para escala pública.

## [2026-08-16] V6 — Biblioteca de cintas (reutilizar videos ya subidos)

**Motivo:** pregunta directa del usuario: "¿cómo elimino los videos que ya he subido?" → llevó a la idea de una pantalla dedicada para ver, reutilizar y borrar los videos de `public/uploads/` sin tener que tocar el sistema de archivos a mano ni resubir un video para crear una sala nueva.

**Cambios:**
- **3 rutas nuevas en `server.js`**: `GET /api/uploads` (lista los videos en disco con nombre, tamaño y fecha), `POST /create-room-from-upload` (crea una sala reutilizando un video existente, sin pasar por Multer), `DELETE /api/uploads/:filename` (borra el archivo). Las tres validan el nombre de archivo contra path traversal (`isValidUploadFilename`).
- Los archivos subidos ahora se guardan como `<hash-corto>__<nombre original sanitizado>.ext` en vez de solo `<hash>.ext`, para poder mostrar un nombre reconocible en la biblioteca. Los videos subidos antes de este cambio siguen funcionando, solo que se muestran con su nombre-hash viejo.
- **Pantalla nueva `public/library.html`** ("📼 Biblioteca de cintas"), enlazada desde `index.html`: lista cada video con tamaño/fecha y botones "▶ USAR" (crea sala y redirige, sin resubir nada) y "🗑" (borra con confirmación). Mismo sistema de diseño VHS que el resto del sitio, con una variante más ancha de la tarjeta (`.deck-wide`) y layout responsive para mobile.
- `public/room.html` no cambió.
- Verificado end-to-end con Playwright (no solo visualmente): subida con nombre real, aparición en la biblioteca, creación de sala desde un video existente con redirect real, borrado con verificación en disco, y rechazo de un intento de path traversal (`../server.js` → 400).

## [2026-08-16] V5.2 — Floaters más grandes y título con relieve 3D/neón

**Motivo:** feedback sobre la V5.1 en vivo: los objetos cayendo seguían viéndose chicos, y "MOVIE NIGHT" pedía sentirse más como letras reales (con borde/relieve) y más iluminado.

**Cambios:**
- Tamaños de los emojis flotantes en `public/index.html` subidos de `16px–34px` a `26px–54px`.
- Nuevo efecto de extrusión 3D en `.marquee-title` (`public/style.css`): capas de `text-shadow` en diagonal (highlight blanco arriba-izquierda, violeta y morado oscuro abajo-derecha) para simular letras con grosor, sin tapar el degradado rosa-cian de fondo. Se afinó en dos pasadas — la primera versión con offsets grandes se veía como un bloque sólido, tapando el color; se ajustó a offsets más chicos.
- Glow del título más intenso + nueva animación `neonFlicker` (5s) que simula el parpadeo sutil de un letrero de neón real.
- `server.js` y `public/room.html` no cambiaron.
- Verificado con Playwright (desktop y mobile) antes de entregar.

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