# 📜 CHANGELOG — MovieNight

Registro cronológico de cambios del proyecto. Formato: más nuevo arriba, nunca se borran entradas viejas.

Ver `MEMORIA.md` para el estado actual y contexto técnico completo — este archivo es solo la bitácora de "qué cambió cuándo".

---

## [2026-08-20] Fix — Modal de contraseña de biblioteca quedaba invisible al fallar, solo en `localhost`

**Motivo:** reporte del usuario: al poner mal la contraseña de biblioteca, la pantalla se quedaba
trabada en "Cargando cintas..." — pero solo en `localhost`, nunca a través de Cloudflare Tunnel.

**Causa raíz** (`public/library.html`, `public/room.html`): el modal genérico (`mnDialog`) oculta el
overlay recién 150ms después de cerrarse (para que se vea el fade-out), con un `setTimeout` que nunca
se cancelaba. Si se abría un modal nuevo antes de esos 150ms — justo lo que hace `mnLibraryFetch` al
volver a pedir la contraseña apenas el `fetch` anterior vuelve con `401` —, el timeout viejo disparaba
igual más tarde y ocultaba el modal recién abierto, dejándolo invisible con su `Promise` sin resolver.
En `localhost` el `fetch` a sí mismo tarda bien menos de 150ms (la carrera se ganaba siempre); a través
de Cloudflare Tunnel el viaje de ida y vuelta ya tarda más que eso, por lo que nunca se notaba ahí.

**Fix:** se guarda el id del `setTimeout` en una variable de módulo y se cancela con `clearTimeout` al
abrir cualquier modal nuevo, en los dos archivos donde vive el componente.

Ver `MEMORIA.md`, sección 8novodecies, para el detalle completo.

## [2026-08-20] Feature — Soporte de archivo `.env` para no pasar `LIBRARY_PASSWORD` a mano en cada arranque

**Motivo:** el usuario preguntó si era normal ver el mensaje de "contraseña generada al azar" en consola en cada `npm start` sin `LIBRARY_PASSWORD` fija — sí lo es, pero abrió la puerta a resolver la fricción real: recordar pasar la variable a mano, con sintaxis distinta según el sistema operativo (en Windows/PowerShell es `$env:LIBRARY_PASSWORD="x"; npm start`, no `LIBRARY_PASSWORD=x npm start` como en Mac/Linux).

**Cambio:** lector de `.env` propio (`loadDotEnv()` en `server.js`), sin agregar la librería `dotenv` como dependencia — el proyecto se mantiene con solo 3 (`express`, `multer`, `socket.io`) y el formato necesario es mínimo. Si existe un `.env` en la raíz, carga sus variables a `process.env` sin pisar las que ya vinieran del entorno real (una variable de entorno pasada a mano sigue ganándole al `.env`). Se agregó `.env.example` (versionado en git, plantilla) documentando `LIBRARY_PASSWORD` y `PORT`; `.env` ya estaba en `.gitignore` desde el fix anterior.

Probado: con `.env` presente y sin variable de entorno real, arranca sin el warning de contraseña generada, y la contraseña del `.env` funciona contra `/api/uploads`. Con variable de entorno real *y* `.env` presentes a la vez, gana la real (confirmado con curl).

Ver `MEMORIA.md`, sección 8octodecies, para el detalle completo.

## [2026-08-20] Security fix — Biblioteca (`/api/uploads`) accesible sin autenticación a cualquiera con el link de una sala

**Motivo:** el usuario preguntó específicamente por seguridad pensando en el escenario "un amigo reenvía el link a alguien que no debería tenerlo". Al revisar el server bajo ese ángulo apareció el problema más serio detectado hasta ahora: `GET /api/uploads` (listar) y `DELETE /api/uploads/:filename` (borrar) no pedían absolutamente nada — ni `hostToken` de ninguna sala, ni ninguna contraseña. Bastaba con conocer el dominio del server (que se conoce apenas se tiene el link de una sala) y escribir `/library.html` para ver **todos** los videos subidos alguna vez, de cualquier sala, y borrar cualquiera de ellos — incluso mientras estaban en uso en otra sala activa, rompiéndola sin avisar.

**Cambio:** se agregó `LIBRARY_PASSWORD`, una contraseña única a nivel de todo el servidor (no por sala, ya que la biblioteca es compartida entre todas). Se lee de la variable de entorno del mismo nombre; si no está definida, se genera una al azar en cada arranque y se imprime por consola con instrucciones. Un middleware nuevo, `requireLibraryAuth`, protege ambas rutas (`GET`/`DELETE` de `/api/uploads`) y responde `401` si falta o es incorrecta. En el cliente (`library.html`), se agregó `mnLibraryFetch()`, que adjunta la contraseña guardada en `localStorage` a cada request y, si el servidor responde `401`, la pide con el modal propio (`mnPrompt`, que se sumó a este archivo — antes solo estaba en `room.html`) y reintenta.

No se protegió `POST /create-room-from-upload`: explotarlo requeriría adivinar el nombre exacto del archivo en disco, que lleva un prefijo aleatorio de 8 caracteres hex — sin poder listar primero, es tan poco viable como adivinar un `hostToken`.

Ver `MEMORIA.md`, secciones 4 y 8septendecies, para el detalle completo.

## [2026-08-20] Fix — Host duplicado: el traspaso de host (automático o manual) no degradaba al anterior

**Motivo:** reporte del usuario: al irse el host, el control se transfería al siguiente conectado (correcto), pero si el host original regresaba, el servidor lo volvía a marcar como host **sin quitárselo** a quien ya lo tenía — quedaban 2 hosts a la vez, y repitiendo el ciclo se podían acumular más.

**Causa raíz** (`server.js`): `room.hostToken` es un secreto estático que nunca se invalida, y cada socket decidía "soy host" comparándolo sin chequear si ya había *otro* host activo en la sala. Lo mismo pasaba con el traspaso manual (botón "Hacer host"): se promovía al nuevo pero nunca se degradaba a quien lo transfería.

**Fix**: se agregó `room.hostSocketId`, el `socket.id` del host actual (única fuente de verdad), y una función `setHost(room, roomId, socket)` por la que ahora pasan los 3 casos que pueden cambiar el host de una sala — join con `hostToken` válido, traspaso automático al desconectarse, traspaso manual (`make-host`). Siempre degrada primero al host anterior (si hay uno distinto y sigue conectado, se le manda `host-status: { isHost: false }` para que su UI de host desaparezca al instante) antes de promover al nuevo. El traspaso automático además dejó de confiar en la bandera local `socket.isHost` (podía quedar desincronizada) y ahora compara contra `room.hostSocketId`.

**Verificación**: probado con clientes `socket.io-client` reales simulando el escenario completo (host entra → invitado entra → host se desconecta → se transfiere al invitado → host original vuelve a entrar) — antes quedaban 2 hosts marcados en la lista de espectadores, ahora siempre queda exactamente 1.

Ver `MEMORIA.md`, sección 5bis, para el detalle completo.

## [2026-08-20] Fix — Diálogos nativos del navegador (prompt/confirm/alert) sin estilo propio

**Motivo:** reporte del usuario con captura: al entrar a una sala desde el celular, el `prompt()` nativo que pide el nombre (`¿Cómo te llamas?`) aparecía sin ningún estilo, con la URL completa del túnel de Cloudflare pegada arriba. No tiene relación con que el link cambie de sesión a sesión (eso sigue igual) — es que `prompt()`/`confirm()`/`alert()` son diálogos del navegador, no HTML de la página, y Chrome les antepone el origen que los pidió.

**Cambio**: se agregó un modal genérico (`.mn-modal-overlay` en `style.css`) con el mismo sistema de diseño "videoclub" del resto de la app, reutilizado para los 3 casos (prompt con input, confirm sí/no, alert de un botón) vía funciones async `mnPrompt()`/`mnConfirm()`/`mnAlert()` (devuelven `Promise`, ya que los diálogos nativos bloqueaban de forma síncrona y un modal HTML no puede). El flujo de entrada a la sala (`room.html`) que dependía del `prompt()` bloqueante se reescribió como `async/await` (`enterRoom()`).

**Aplicado en `room.html`**: nombre al entrar, contraseña de sala, contraseña incorrecta (reintento), confirmar "Salir de la sala", confirmar "Expulsar", confirmar "Hacer host", aviso de "Te expulsaron". **Aplicado en `library.html`**: aviso de permisos de host, errores al usar/borrar una cinta, confirmar borrado.

Ver `MEMORIA.md`, sección 8sedecies, para el detalle completo.

## [2026-08-19] Feature — Duración y progreso también para invitados (solo lectura)

**Motivo:** pedido del usuario: los invitados no tenían forma de saber cuánto duraba la película ni por dónde iba, ya que la barra de progreso solo existía en `#hostControlsWrap` (exclusivo del host).

**Cambio** (`public/room.html`, `public/style.css`): se agregó una barra de progreso + tiempo dentro de `#localControls` (el panel que ya tenían los invitados con volumen y pantalla completa), reutilizando las mismas clases visuales del host (`seek-bar`, `seek-track`, `seek-buffered`, `seek-fill`, `time-label`) pero **sin thumb arrastrable y sin listeners de mouse/touch** (`seek-bar--readonly`) — es puramente informativa, no se puede tocar para adelantar/atrasar. El `timeupdate`/`progress` del `<video>` ahora actualiza en paralelo la barra del host y la del invitado (`guestSeekFill`, `guestSeekBuffered`, `guestTimeLabel`), sin importar el rol actual — así sigue funcionando igual si hay un traspaso de host en el medio. `.local-controls` pasó de ser una caja angosta en la esquina inferior derecha a una barra completa de borde a borde (`left/right: 14px`), igual que `.host-controls`, para que entre la barra de progreso.

## [2026-08-19] Mejora + Rediseño — Overlay de host oculto hasta tocar el video en celular, y botones ±10s rediseñados

**Motivo:** feedback del usuario con captura: en celular, el badge "CONTROL REMOTO" y los botones de retroceder/adelantar 10s (ambos solo visibles para el host) tapaban el video todo el tiempo. Pidió que aparecieran solo al tocar la pantalla, y de paso que se mejorara la estética de los botones ±10s.

**Mejora — overlay tap-to-toggle** (`public/room.html`, `public/style.css`): en celular (`max-width: 820px`), `.host-badge` y `.host-controls` arrancan ocultos (`opacity: 0`) y solo se muestran con la clase `controls-visible` en `.screen-wrap`, que se agrega al tocar el video y se quita sola tras 3s de inactividad (temporizador que se reinicia si se toca el badge o los botones). En escritorio no cambia nada, siguen siempre visibles.

**Rediseño — botones ±10s** (`public/style.css`, `public/room.html`): de rectángulos planos con emoji a color (⏪/⏩) a chips circulares con ícono de flecha circular en texto plano (↺/↻, nunca sale a color) + "10" en la fuente OSD, con glow rosa/cian igual al resto de los controles interactivos de la sala.

## [2026-08-19] Fix + Mejora — Layout deformado al salir de pantalla completa, y botón de enviar en el chat

**Motivo:** reporte del usuario con capturas: en celular, al tocar pantalla completa y luego salir, la sala quedaba deformada (video ocupando el layout equivocado, chat aplastado) y ya no volvía a su estado normal. Se aprovechó para agregar el botón de enviar mensaje que faltaba junto al campo de texto.

**Fix — layout roto al salir de pantalla completa** (`public/room.html`): la pantalla completa se pide sobre el `<video>` solo (`player.requestFullscreen()`), y algunos navegadores (sobre todo Chrome/Android) fuerzan una rotación a landscape mientras dura, revirtiéndola al salir — pero esa rotación no siempre dispara `orientationchange`, y el `resize` que sí llega puede traer un valor intermedio de la animación de transición (mismo tipo de problema ya documentado para el cierre del teclado). Resultado: `--app-height` y la clase `device-landscape` se quedaban pegados en el valor de cuando estaba en pantalla completa. Se agregaron listeners de `fullscreenchange`/`webkitfullscreenchange` (y `webkitbeginfullscreen`/`webkitendfullscreen` para el reproductor nativo de iOS Safari, que no usa la Fullscreen API estándar en `<video>`) que reintentan `setAppHeight()` + `updateOrientationClass()` varias veces (0/50/150/300/500ms) para cubrir toda la animación, igual que ya se hacía con el teclado.

**Mejora — botón de enviar** (`public/room.html`, `public/style.css`): se agrega `#chatSendBtn` (➤) al lado del campo de chat. La lógica de armar y mandar el mensaje se sacó a una función (`sendChatMessage()`) para no duplicarla entre el `Enter` y el click del botón. El botón usa `mousedown` con `preventDefault()` en vez de dejar que el `click` normal le quite el foco al campo — si no, en celular cada tap en "Enviar" cerraría el teclado de golpe antes de mandar el mensaje.

## [2026-08-19] Ajuste — Video más grande con el teclado abierto, fix del tamaño que no se restauraba, y barra de volumen colapsable

**Motivo:** feedback tras el cambio anterior — el video quedaba demasiado chico con el teclado abierto ("la cuestión es poder hablar y ver el video al mismo tiempo"), un bug donde no volvía a su tamaño original al cerrar el teclado, y pedido de simplificar la barra de volumen/pantalla completa.

**Ajuste 1 — video más grande** (`public/style.css`): `.screen-wrap` en `html.keyboard-open` pasa de `max-height: 20dvh; min-height: 64px` a `max-height: 38dvh; min-height: 90px`, mucho más cerca del tamaño normal. El espacio para el chat ahora sale de esconder emojis + barra de volumen + el fix del hueco vacío, no de aplastar el video.

**Fix 2 — el video no volvía a su tamaño original** (`public/room.html`): `visualViewport` ahora también escucha `scroll` (no solo `resize` — algunos Android disparan eso al cerrar el teclado), y el `blur` del chat refuerza `setAppHeight()` con varios `setTimeout` (50/150/300/500ms) para cubrir toda la animación de cierre.

**Ajuste 3 — barra de volumen colapsable** (`public/room.html`, `public/style.css`): se oculta mientras el teclado está abierto (mismo criterio que los emojis, vía `updateLocalControlsVisibility()`). El ícono 🔊 pasó de `<span>` a `<button>` que alterna un deslizador colapsable (`.vol-control.open .vol-slider`, animado con `transition`) — solo aparece al tocarlo, y se cierra tocando afuera o al abrirse el teclado. El botón de pantalla completa sigue siempre visible, aparte.

## [2026-08-19] Mejora + Fix — Más chat visible con el teclado abierto, hueco vacío arreglado, y `joinCode` sin barra de autofill

**Motivo:** captura del usuario en celular con el teclado abierto: solo se veía un mensaje del chat, un hueco vacío entre el video y las pestañas, y la barra de autofill de Chrome seguía apareciendo al escribir el código de sala en la pantalla de inicio (pendiente desde el fix del chat, ver `[2026-08-18] Fix — Barra de autofill...`).

**Fix 1 — hueco vacío** (`public/room.html`): era un bug de la mudanza código+Salir a la pestaña "Sala" (`[2026-08-18]` anterior): `.side-header:empty` nunca se disparaba porque el contenedor que se quedaba sin el grupo conservaba nodos de texto (indentación del HTML), así que el navegador no lo consideraba realmente vacío. Ahora `placeCodeSalirGroup()` esconde el contenedor perdedor a mano con `style.display`.

**Mejora 2 — más mensajes visibles con el teclado abierto** (`public/room.html`, `public/style.css`): se agrega la clase `keyboard-open` a `<html>` mientras el campo de chat tiene el foco. En celular vertical, eso oculta la fila de emojis y baja el tope de altura del video (de 45dvh/100px mín. a 20dvh/64px mín.), dejándole mucho más lugar a los mensajes anteriores del chat.

**Fix 3 — autofill en `joinCode`** (`public/index.html`, `public/style.css`): mismo patrón que el chat de la sala — pasó de `<input maxlength="6">` a `<div contenteditable="true">`, con manejo a mano de Enter (envía en vez de saltar de línea), paste a texto plano, y recorte a 6 caracteres (ya que contenteditable no tiene `maxlength`).

## [2026-08-18] Mejora — En celular, código de sala + Salir se mudan a la pestaña "Sala" + rediseño del botón Salir

**Motivo:** pedido del usuario — en celular, el código de sala y el botón Salir ocupaban espacio fijo arriba de las pestañas, restándole lugar visible al chat. Se pidió moverlos dentro de la pestaña "Sala" solo en celular (PC igual que antes), y de paso rediseñar el botón Salir porque se veía "muy simple y genérico".

**Cambio 1 — reubicación responsive** (`public/room.html`, `public/style.css`): el bloque código+Salir se envolvió en `<div id="codeSalirGroup">` y se mueve con JS entre dos contenedores (`sideHeaderDesktop` arriba de las pestañas, o `codeSalirSlotMobile` dentro de la pestaña "Sala") según `matchMedia('(max-width: 820px)')`, reaccionando a `change` — no a `resize` — para que el teclado (que solo cambia el alto visible) nunca dispare un movimiento de más. Es el mismo nodo del DOM en ambos casos, así que `copyBtn`/`leaveBtn` no pierden sus listeners al moverse.

**Cambio 2 — rediseño del botón Salir** (`public/style.css`): pasó de outline rosa plano a un estilo "eyectar cinta" acorde a la estética VHS: fondo con gradiente oscuro, ícono en su propio círculo, glow rosa en hover, y efecto de click físico al presionar.

## [2026-08-18] Fix — Barra de autofill de Chrome sobre el teclado del chat (solución definitiva)

**Motivo:** el intento anterior (`autocomplete="off"`) no funcionó — el usuario mandó una captura confirmando que la barra de llave/tarjeta/ubicación seguía apareciendo sobre el teclado al escribir en el chat. También notó, con otra captura, que el diálogo nativo `prompt()` que pide el nombre al entrar a la sala *nunca* muestra esa barra — esa pista fue la clave para encontrar la causa real.

**Causa:** la barra de autofill de Chrome para Android se activa sobre cualquier `<input>`/`<textarea>` de la página sin importar `autocomplete`, pero no sobre elementos `contenteditable` (no forman parte del sistema de formularios que esa barra asiste) — de ahí que `prompt()`, que ni siquiera es un elemento de la página, nunca la dispare.

**Fix** (`public/room.html`, `public/style.css`): el campo de chat (`chatInput`) pasó de `<input>` a `<div contenteditable="true">` — el mismo truco que usan WhatsApp Web, Messenger y Slack en su caja de mensaje. Requirió: placeholder simulado con `:empty:before` + `data-placeholder` (contenteditable no tiene `placeholder` nativo), manejo de `Enter` con `preventDefault()` para enviar en vez de insertar un salto de línea, `chatInput.value` → `chatInput.textContent` en toda la lógica de envío, un handler de `paste` que fuerza texto plano, y el estado "silenciado" pasó de `.disabled` a `contentEditable = 'false'` + una clase `.is-disabled`.

**Alcance:** solo se aplicó al chat, que es el campo que se usa repetidamente durante toda la sesión. `joinCode` y `roomPassword` (`index.html`) siguen siendo `<input>` normales con `autocomplete="off"`/`"new-password"` del intento anterior, porque se usan una sola vez al entrar — si en el futuro molesta ahí también, se puede aplicar el mismo patrón.

## [2026-08-18] Ajuste — Reducir la barra de autofill de Chrome (llave/tarjeta/ubicación) sobre el teclado

**Motivo:** captura del usuario mostrando la barra de autofill de Chrome para Android (iconos de contraseñas/tarjetas/direcciones) apareciendo sobre el teclado al escribir en el chat.

**Aclaración:** no es un bug de MovieNight — es una función nativa de Chrome que aparece en cualquier campo de texto de cualquier sitio, y no hay forma de apagarla del todo desde el código de una página (solo desde la configuración de Chrome del usuario).

**Cambio** (`public/room.html`, `public/index.html`): se agregó `autocomplete="off"` al campo de chat (`chatInput`) y al código de sala para unirse (`joinCode`), y `autocomplete="new-password"` al campo de contraseña de sala (`roomPassword`) — esto le indica a Chrome que esos campos no son credenciales/direcciones/tarjetas guardables, lo que reduce bastante la probabilidad de que la barra aparezca (sin garantía del 100%, ya que la decisión final es de Chrome). El campo de contraseña también deja de disparar el popup de "¿guardar esta contraseña?" al enviarla.

## [2026-08-18] Fix — El teclado activaba por error el layout de "landscape angosto" en vertical

**Motivo:** captura del usuario (celular vertical, escribiendo en el chat) mostrando el video comprimido a un lado y el chat ocupando casi la mitad de la pantalla — probado en varios celulares con el mismo resultado. Era una regresión del fix anterior de esta misma fecha ("el teclado empujaba el video fuera de pantalla").

**Causa:** el layout apilado (video arriba, chat abajo) vs. el layout de fila (video + chat al costado, pensado para landscape angosto real) se elegía en CSS con `min-height: 500px` / `max-height: 499px` sobre el viewport visible. Pero `interactive-widget=resizes-content` (agregado en el fix anterior) hace que el teclado *también* achique esa altura visible — así que al escribir en el chat en vertical, el viewport caía debajo de 500px y la media query pensaba que era landscape angosto, activando el layout de fila en medio de una sesión normal. Reproducible en cualquier celular por igual, porque no depende del hardware sino de que el teclado angosta el viewport de la misma forma en todos — coincide con lo reportado.

**Fix** (`public/room.html`, `public/style.css`): se dejó de elegir el layout según cuánto espacio visible queda (afectado por el teclado) y se pasó a elegir según la orientación *real* del dispositivo:
1. `updateOrientationClass()` en `room.html` lee `matchMedia('(orientation: landscape)')` y agrega/saca la clase `device-landscape` en `<html>`. Se llama al cargar la página y **solo se recalcula en `orientationchange`** (rotación física real) — el teclado dispara `resize`/`visualViewport.resize`, nunca `orientationchange`, así que ya no puede confundir el layout.
2. En `style.css`, las media queries de layout apilado/fila pasaron de `min-height`/`max-height` a `html:not(.device-landscape)` / `html.device-landscape`, ambas siguen limitadas a `max-width: 820px` para no afectar escritorio.
3. `--app-height` (fix anterior) sigue decidiendo cuánto espacio visible hay; esta sección solo decide fila vs. columna. Quedan desacopladas.

**Limitación del testing:** no se pudo verificar con un navegador real en este entorno (sin Chromium disponible para Playwright ni acceso de red para descargarlo) — se validó revisando a mano la lógica de CSS/JS. Recomendado confirmar en un celular real, en particular el caso de landscape angosto real (celular acostado).

## [2026-08-18] Fix — El teclado del celular empujaba el video fuera de pantalla

**Motivo:** captura del usuario mostrando que, al tocar el campo de chat en el celular, el teclado aparecía y el video se iba fuera de la pantalla hacia arriba. Una sesión anterior había diagnosticado la causa correctamente (compartió el análisis en texto) pero se quedó sin terminar de aplicar el fix — ningún archivo llegó a actualizarse. Se repitió el diagnóstico, se confirmó, y se implementó completo.

**Causa:** `.room-scene` usaba `height: 100vh`, que en Chrome/Android no se achica cuando aparece el teclado (se calcula sobre el alto de pantalla completa). Al enfocar el input, el navegador scrollea la página para "mostrarlo", y como la sala seguía creyendo que medía la pantalla completa, el video (arriba de todo en el layout de celular) terminaba fuera de vista.

**Fix en 3 capas** (`public/room.html`, `public/index.html`, `public/library.html`, `public/style.css`):
1. `interactive-widget=resizes-content` agregado al `<meta viewport>` de las 3 páginas — le pide al navegador que redimensione el layout real cuando aparece el teclado (Chrome 108+).
2. `height: 100dvh` en `.room-scene`, con `100vh` de respaldo para navegadores que no reconocen `dvh`.
3. Variable `--app-height` actualizada por JS en `room.html` vía `window.visualViewport`, como capa final más confiable — `.room-scene` usa `calc(var(--app-height, 100vh))`.
4. El video (`.screen-wrap`) en la media query de celular vertical pasó de `aspect-ratio` rígido a poder achicarse con un piso de 100px y techo de 45dvh, para no forzar que el chat desaparezca si el espacio se aprieta mucho.
5. Se sacó una regla vieja (`.room-scene { height: auto }` en pantallas chicas) que hubiera pisado este fix.

**Verificado con Playwright** simulando la apertura del teclado (achicando el viewport ~34%, proporción realista de un teclado Android típico): el video y el chat quedan dentro del área visible, sin salirse de pantalla. Sin regresión en desktop ni en landscape angosto de celular.

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