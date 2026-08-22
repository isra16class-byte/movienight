# 📜 CHANGELOG — MovieNight

Registro cronológico de cambios del proyecto. Formato: más nuevo arriba, nunca se borran entradas viejas.

Ver `MEMORIA.md` para el estado actual y contexto técnico completo — este archivo es solo la bitácora de "qué cambió cuándo".

---

## [2026-08-22] Fix: el video se reiniciaba al minuto 0 al salir/reentrar de la sala

**Motivo:** reportado por el dueño del proyecto tras la primera sesión larga real (2h, con R2 ya
andando): salir y volver a entrar a la sala reiniciaba el video al minuto 0 — grave sobre todo cuando
quien reingresaba recuperaba el host (automático por el `hostToken` guardado en `localStorage`),
porque a él nadie lo corregía y el reinicio se propagaba a toda la sala al tocar play.

**La causa:** `room-data` (lo que el servidor manda a quien se conecta) nunca incluía el minuto actual
del video, solo el archivo. El `<video>` del navegador arranca en 0 por defecto en toda carga fresca.
A un espectador normal lo corregía el próximo heartbeat del host (parpadeo de ~4s), pero al host mismo
nadie lo corrige.

**El fix:** la sala guarda ahora la última posición conocida (`room.videoPosition`), actualizada en
cada `sync` del host, y la manda en `room-data` a quien se conecta. El cliente la aplica solo en
cargas frescas del `<video>` (nunca en una reconexión de socket con la pestaña ya abierta, para no
meter saltos innecesarios). Se resetea a 0 al cambiar de cinta. Verificado con una prueba de extremo a
extremo con `socket.io-client` real: host avanza a 45:00, se desconecta, reconecta recuperando el
host, `room-data` le manda `time: 2700` (antes del fix, siempre daba `0`).

**También documentado (sin cambio de código):** el corte intermitente cada ~15 min con Error 1033 de
Cloudflare, reportado en la misma sesión — es una limitación conocida de los túneles rápidos
(`*.trycloudflare.com`, sin garantía de actividad), no un bug de MovieNight. El proyecto ya tiene la
solución (túnel con nombre, sección 8quinquicies de `MEMORIA.md`) para sesiones largas.

**Documentación:** `MEMORIA.md` secciones 8septicies y 8octicies.

## [2026-08-21] Fix: R2 nunca se activaba usando `.env` (bug de orden de `require`)

**Motivo:** un usuario real completó las 5 variables de R2 en su `.env` siguiendo la guía paso a paso
y el server seguía mostrando `💾 Cloudflare R2 no está configurado`. No era un error del usuario: era
un bug de código presente desde la Fase 1 de R2, que nunca se había notado porque hasta ahora R2 solo
se había probado pasando las variables directo por consola, nunca a través de un archivo `.env` real.

**La causa:** `server.js` cargaba `lib/r2.js` con `require('./lib/r2')` **antes** de llamar a
`loadDotEnv()`. Como `lib/r2.js` lee `process.env.R2_*` en constantes de nivel de módulo una sola vez,
en el momento del `require`, esas constantes quedaban fijadas en `''` para siempre si el `.env`
todavía no se había leído en ese momento — sin importar que `loadDotEnv()` llenara `process.env`
correctamente dos líneas más abajo.

**El fix:** se movió el `require('./lib/r2')` a después de `loadDotEnv()` en `server.js`. No se tocó
nada de `lib/r2.js`. Confirmado con una prueba mínima que reproduce el bug y el fix, y con el server
real levantando con un `.env` de R2 de prueba.

**Confirmado en producción:** el dueño del proyecto aplicó el patch, hizo `git pull` y `npm start` con
su `.env` de R2 ya completado (sin tocarlo) — el server pasó a mostrar "☁️ Cloudflare R2: conectado".
Descarta la hipótesis alternativa (variables fusionadas en una sola línea del `.env`); era un
artefacto de copiar/pegar desde PowerShell al pasar `Get-Content .env` por chat, no el archivo real.

**Documentación:** `MEMORIA.md` sección 8sexicies.

## [2026-08-21] Dominio fijo — túnel con nombre de Cloudflare (opcional)

**Motivo:** el Quick Tunnel (`cloudflared tunnel --url ...`, ya documentado desde antes) da un link
random distinto cada vez que se reinicia `cloudflared` — el host tiene que reenviarlo a sus amigos en
cada sesión. Un túnel con nombre de Cloudflare da el mismo link siempre (dominio propio), a costa de
una configuración única.

**No toca código de la app:** `server.js` sigue escuchando en `localhost:PORT` exactamente igual,
sea que se exponga con Quick Tunnel, túnel con nombre, o nada (uso solo en LAN). Es 100%
configuración/documentación nueva:

- `cloudflared-config.example.yml` — plantilla nueva (se sube a git), mismo patrón que `.env.example`:
  se copia a `cloudflared-config.yml` (que sí se agregó a `.gitignore`, no se sube) y se completan 3
  valores (nombre/UUID del túnel, ruta a las credenciales, subdominio).
- `package.json` — script nuevo `npm run tunnel` (`cloudflared tunnel --config cloudflared-config.yml run`).
- `README.md` — sección nueva "Dominio fijo (túnel con nombre)" con la guía paso a paso completa:
  `cloudflared tunnel login` → `tunnel create` → `tunnel route dns` → completar la plantilla →
  `npm run tunnel`. Los primeros 4 pasos son de una sola vez; después alcanza con `npm run tunnel` en
  cada sesión futura.

**Documentación:** `MEMORIA.md` con la sección 8quinquicies nueva y el roadmap (sección 10)
actualizado — este era el único ítem de infraestructura que quedaba pendiente en el roadmap además de
las 3 fases de R2 (ya cerradas).

## [2026-08-21] Cloudflare R2 — Fase 3: la biblioteca (`library.html`) lista, reutiliza y borra directo del bucket

**Motivo:** cerraba la última pieza pendiente de R2. Desde la Fase 2, un video subido con R2 activo
quedaba en el bucket pero invisible para `library.html` (que solo leía `public/uploads/` en disco) —
solo se podía reutilizar volviendo a subirlo entero. Esta sesión conecta las 4 rutas que faltaban:
`GET /api/uploads`, `DELETE /api/uploads/:filename`, `POST /create-room-from-upload` y
`POST /room/:id/change-video-from-upload`.

**Qué se agregó en `lib/r2.js`:** `objectExists(key)`, un HEAD puntual contra un objeto del bucket
(en vez de listar todo con `listObjects()` y buscar adentro) — cumple el mismo rol que
`fs.existsSync` en modo disco, para validar un `filename` que llega del cliente antes de reutilizarlo
o borrarlo.

**Qué cambió en `server.js`:** `isValidUploadFilename` (síncrona, solo disco) se reemplazó por
`isValidUploadReference` (async, revisa disco o R2 según `r2.isR2Enabled()`), usada por las 4 rutas
de arriba, todas convertidas a `async`/`await`. `GET /api/uploads` en modo R2 llama a
`r2.listObjects()` y devuelve el mismo shape (`filename`, `displayName`, `size`, `mtime`) que en modo
disco — por eso no hizo falta tocar nada de `public/library.html`, que trata `filename` como un
identificador opaco. `videoUrlForExistingFile()` nueva arma la URL final (ruta local o link público de
R2) para `room.videoFile` al reutilizar una cinta, igual que ya hacía `videoUrlForUploadedFile()` para
una subida nueva (Fase 2).

**Manejo de errores:** si R2 falla a mitad de un listado/borrado/HEAD (credenciales mal puestas,
bucket borrado, conexión caída), las 4 rutas devuelven `502` con JSON y loguean el error por consola
— mismo criterio que ya usaba la Fase 2 para las subidas: fallo explícito, nunca una mezcla silenciosa
de "biblioteca a medio listar" o un archivo que se cree borrado sin estarlo.

**Cómo se probó (sin credenciales reales de R2):** en modo disco local (R2 desactivado) se repitió el
flujo completo — crear sala subiendo un archivo, listar biblioteca, reutilizar el video con
`create-room-from-upload`, borrar con `DELETE /api/uploads/:filename` (incluyendo el caso de borrar un
filename inexistente, que debe devolver 400) — para confirmar que el paso a rutas `async` no cambió en
nada el comportamiento de siempre. Aparte, se arrancó el server con las 4 variables de R2 seteadas
pero con credenciales inventadas (no apuntan a un bucket real) para confirmar que `GET /api/uploads`
responde `502` con JSON en vez de colgarse o tirar un error sin manejar — igual al aviso por consola
que ya existía desde la Fase 2 al arrancar (`testConnection()`).

**Con esto se cierran las 3 fases de Cloudflare R2** planeadas en el roadmap: con las 4 variables de
entorno configuradas, todo el ciclo de vida de un video (subir, listar, reutilizar, cambiar de cinta,
borrar) pasa por el bucket sin tocar el disco del host, y `library.html` funciona exactamente igual
para quien la usa, sea que R2 esté activo o no.

**Documentación:** README (sección Cloudflare R2 actualizada — ya no dice "pendiente", roadmap sin ese
ítem), `MEMORIA.md` con la sección de R2 actualizada de punta a punta y el roadmap (sección 10) al día.

## [2026-08-21] Cloudflare R2 — Fase 2: la subida de video (crear sala / cambiar cinta) ya va directo al bucket

**Motivo:** seguía de la Fase 1 (ver entrada de abajo) — ahí solo se había montado `lib/r2.js` sin que
nada lo usara. Esta sesión conecta esa infraestructura a `POST /create-room` y
`POST /room/:id/change-video`, que son las dos rutas que reciben un archivo de video.

**Decisión de arquitectura:** el navegador sigue subiendo al servidor exactamente igual que antes
(mismo `FormData`/XHR, misma barra de progreso) — es el servidor quien, en vez de escribir a disco,
reenvía ese stream directo a R2 sin tocarlo en ningún momento (ni disco, ni memoria completa). Se
eligió esto en vez de que el navegador suba directo a R2 con una URL prefirmada porque el problema
real (ver Fase 1 más abajo) era de reproducción para espectadores remotos, no de subida — y esta forma
no requiere tocar ningún HTML/JS del cliente ni configurar CORS en el bucket.

**Qué se agregó/cambió en `server.js`:** un motor de storage de Multer nuevo (`r2VideoStorage`) que
usa `r2.uploadStream()` (ya existía desde la Fase 1) en vez de `multer.diskStorage`; se elige uno u
otro una sola vez al arrancar según `r2.isR2Enabled()`; `videoUrlForUploadedFile()` arma la URL final
(local o de R2) para `room.videoFile`; middleware de errores que devuelve JSON (no HTML) si Multer
corta por tamaño o si falla la subida a R2; chequeo de `r2.testConnection()` al arrancar el server,
con aviso claro por consola si R2 está mal configurado.

**Qué NO se tocó (a propósito, queda para la Fase 3):** `/create-room-from-upload`,
`/room/:id/change-video-from-upload` y `/api/uploads` (la biblioteca) siguen funcionando solo contra
disco local. Efecto esperado: con R2 activo, un video subido ahora no aparece todavía en
`library.html` para reutilizarlo después — hay que volver a subirlo. Ver `MEMORIA.md` sección
8tricies para el detalle completo y cómo se probó (sin credenciales reales de R2, con un stub).

**Documentación:** README actualizado (sección Cloudflare R2 ahora dice que la subida ya está
conectada, y qué falta); `MEMORIA.md` con la sección 8tricies nueva y el roadmap (sección 10)
actualizado.

## [2026-08-21] Cloudflare R2 — Fase 1: infraestructura aislada, sin conectar todavía

**Motivo:** sesión real con 3 personas (host en localhost + 2 amigas remotas por Cloudflare Tunnel)
con un video de 3GB: se trababa solo del lado del túnel, por igual en ambos celulares, con buena banda
ancha de por medio — señal clara de que el "Quick Tunnel" gratis de `cloudflared` (una sola conexión
saliente compartida entre todos los espectadores remotos) es el cuello de botella, no el internet de
nadie. De las alternativas evaluadas (bajar bitrate, túnel nombrado, ngrok, R2), R2 es la única que
saca el video de la conexión del host por completo: lo sirve directo la red de Cloudflare, con egress
(ancho de banda de salida) gratis siempre, sin tier.

**Qué se agregó:** módulo nuevo `lib/r2.js` con las funciones para hablar con un bucket de R2 vía el
SDK S3-compatible (`@aws-sdk/client-s3` + `@aws-sdk/lib-storage`, nuevas dependencias): `isR2Enabled`,
`testConnection`, `makeObjectKey`, `uploadStream` (multipart, para videos de varios GB),
`listObjects`, `deleteObject`, `getPublicUrl`. `.env.example` con las 5 variables nuevas de R2
(comentadas por default). Nueva sección en README con la guía paso a paso para crear el bucket,
activar acceso público y generar credenciales.

**Importante — todavía no cambia nada del comportamiento de la app:** `server.js` no se tocó, y nada
llama todavía a `lib/r2.js`. Es solo la infraestructura aislada sobre la que se va a construir la
Fase 2 (subida de video directo a R2 desde `/create-room` y compañía) y la Fase 3 (biblioteca leyendo
del bucket). Cualquier instalación existente sigue funcionando en modo local exactamente igual que
antes de este cambio.

Ver `MEMORIA.md` sección 8novovicies para el detalle completo.

---

## [2026-08-21] Fix: el nombre citado en una respuesta no usaba el color de host (V16)

**Motivo:** el usuario notó (con captura) que un mensaje citado dentro de una respuesta aparecía en
rosa aunque esa misma persona era host y su nombre se veía cyan como autor de sus propios mensajes —
dos colores para el mismo nombre en la misma sala.

**Causa:** `renderChatMessage` (`public/room.html`) pintaba el nombre citado en `.reply-quote` llamando
a `usernameColor(data.replyTo.user, false)` — el `isHost` estaba **hardcodeado a `false`** en vez de
usar el dato real de la persona citada, un descuido de cuando se armó el sistema de respuestas (V14) y
todavía no existían los colores por nombre (esos llegaron recién en V15).

**Fix:** se hizo viajar `isHost` de punta a punta para la persona citada, no solo para el autor del
mensaje: `renderChatMessage` ahora guarda `isHost` en el `dataset` de cada mensaje del DOM;
`startReply(user, text, isHost)` suma ese tercer parámetro; los dos disparadores de responder (click en
el ícono ↩ y el gesto de swipe) se lo pasan leyendo `dataset.ishost`; y `server.js` (handler
`chat-message`) ahora también sanitiza y reenvía `isHost` dentro del objeto `replyTo`, cosa que antes
no hacía aunque el cliente ya lo mandara. Con el dato llegando bien, el cambio real es reemplazar el
`false` fijo por `data.replyTo.isHost` en la línea que arma el HTML de la cita.

Ver `MEMORIA.md` sección 8octovicies para el detalle completo.

---

## [2026-08-20] Colores por nombre de usuario + confirmación al salir con "atrás" (V15)

**Motivo:** dos pedidos separados. (1) Colores para los nombres de invitados en el chat, sin romper la
estética de la app. (2) Un caso real: a la amiga del usuario se le fue el pulgar dos veces sobre el
botón de atrás del teléfono mientras miraba una peli y salió de la sala sin querer — como había
entrado por el link directo (sin historial previo), tuvo que reingresar con el link de nuevo. El botón
"Salir" ya confirmaba antes de salir, pero el botón/gesto de atrás del navegador no pasaba por esa
confirmación.

**Colores de nombre (`public/room.html`):** paleta de 7 colores neón acorde a la estética VHS ya
existente (`#ff2e9a #b18aff #ff7a45 #4dff9e #ffe066 #5ec8ff #ff5c72`) + una función
`usernameColor(name, isHost)` que hashea el nombre a un color fijo de esa paleta (mismo nombre, mismo
color siempre). El host tiene un color reservado aparte (el `--cyan` de la app, el mismo del ícono 🎛),
que no entra en el hash de los demás. Se aplica en el chat (`renderChatMessage`), en la cita cuando un
mensaje es una respuesta, en los comentarios flotantes de pantalla completa (`spawnDanmaku`, nuevo
parámetro `isHost`) y en la lista de espectadores. `server.js` agrega `isHost: !!socket.isHost` a cada
mensaje de chat que arma, para que el color refleje si esa persona era host en el momento de escribir
(no si lo es ahora — el control puede pasar de mano en mano).

**Confirmación al salir con "atrás" (`public/room.html`):** se empuja un estado extra al historial al
cargar la sala (`history.pushState`) y se intercepta `popstate` (el evento que dispara el botón/gesto
de atrás) re-empujando el mismo estado guardia de inmediato — así funciona incluso con dos "atrás"
seguidos — y mostrando la misma confirmación que ya usaba "Salir". Si confirma, sale de verdad; si
cancela, se queda donde estaba. No se tocó `beforeunload` (poco confiable en celular, y dispararía
falsos avisos durante la navegación interna de "cambiar cinta"); el guardia de `popstate` solo
reacciona a "atrás", nunca a una navegación hacia adelante.

Ver `MEMORIA.md` sección 8septvicies para el detalle completo.

---

## [2026-08-20] Más emojis con scroll horizontal + responder a un mensaje (swipe o ícono) (V14)

**Motivo:** pedido del usuario a partir de una captura del chat en celular — que aparezca la carita
llorando (😭) y más emojis "de los más usados" en la barra de reacciones, que esa barra se pueda
desplazar horizontalmente en vez de apilarse en varias filas, y poder "agarrar" un mensaje y deslizarlo
hacia la derecha para marcarlo como el que se está respondiendo (gesto típico de WhatsApp/Telegram).

**`public/style.css`:** `.reactions` pasa de `flex-wrap: wrap` a `flex-wrap: nowrap; overflow-x:
auto;` con scrollbar fina temática. Se agregan 7 emojis nuevos (😭😍👍🙌💀🎉😅) a los 5 que ya había,
12 en total. Nuevos estilos para el sistema de respuestas: `.msg { touch-action: pan-y }` (deja que el
navegador maneje el scroll vertical nativo y le da el gesto horizontal al JS, sin pelear con
`preventDefault`), `.reply-quote` (cita recortada a 2 líneas arriba del texto cuando el mensaje es una
respuesta), `.reply-icon` (botón ↩ por mensaje, visible en hover en desktop / semi-visible siempre en
táctil), `.swipe-reply-icon` (ícono que aparece mientras se arrastra) y `#replyPreview` (banner de
"respondiendo a…" arriba de la caja de texto).

**`public/room.html`:** listeners de `touchstart/touchmove/touchend/touchcancel` delegados en
`#messages`, con zona muerta de 8px para no interferir con un tap ni con el scroll vertical normal, y
umbral de 46px para disparar la respuesta al soltar (con `navigator.vibrate` si el dispositivo lo
soporta). El ícono ↩ de cada mensaje hace lo mismo con un click, para desktop o como respaldo táctil.
`sendChatMessage()` ahora manda `{ text, replyTo }` en vez de un string plano; `renderChatMessage`
pinta la cita cuando corresponde.

**`server.js`:** `socket.on('chat-message', ...)` acepta el nuevo payload `{ text, replyTo }` (con
compatibilidad hacia atrás si llega un string plano), sanitiza `replyTo` (user/text string no vacíos,
recortados a 40/200 caracteres) y lo adjunta al mensaje que guarda en el historial y reenvía a la sala.
No se agregaron IDs de mensaje — la respuesta es una cita de texto plano embebida, no un link al
mensaje original.

Ver `MEMORIA.md` sección 8sexvicies para el detalle completo.

---

## [2026-08-20] Historial de chat server-side: sobrevive a la recarga de "cambiar cinta" (V13)

**Motivo:** pregunta del usuario tras el fix de V11 — notó que al host se le vaciaba el chat entero
cada vez que usaba "Cambiar cinta". Causa: el chat nunca se guardó en el servidor (100% en vivo, sin
persistencia), y "cambiar cinta" implica que el host navega fuera de `room.html` y recarga la página
(ver V11) — reconstruye su `#messages` vacío para siempre. Los invitados, cuyo socket nunca se
desconecta en ese flujo, no tenían este problema.

**`server.js`:** se agrega `chatHistory: []` a `makeRoom()`, tope de `CHAT_HISTORY_LIMIT = 50`
mensajes, y `pushChatHistory(room, msg)` — se llama junto a cada emisión de `chat-message` que ya
existía (mensajes de usuario, entradas/salidas, traspasos de host manual y automático, y los mensajes
de video de V12), sin tocar la lógica existente de a quién le llega cada uno en vivo. En `join-room`,
apenas el socket hace `join`, se le manda `socket.emit('chat-history', room.chatHistory)` con el
historial previo a este join (para no duplicar con los mensajes en vivo que le van a llegar del propio
join, como "cinta cargada"/"se unió").

**`public/room.html`:** nuevo `socket.on('chat-history', ...)` que limpia `#messages` y repinta el
historial completo, reusando el renderizado ya extraído a `renderChatMessage(data)`. Se limpia primero
porque Socket.io puede reconectarse solo (ej. wifi inestable) sin recargar la página, y en ese caso el
evento llega de nuevo — sin el limpiado quedarían mensajes duplicados. El historial no dispara los
comentarios flotantes ("danmaku"), solo los mensajes que llegan en vivo.

**Nota:** el historial vive en memoria junto con el resto del estado de la sala — se pierde si el
servidor se reinicia, igual que siempre (ver sección 9 de `MEMORIA.md`).

Ver `MEMORIA.md` sección 8quinvicies para el detalle completo.

---

## [2026-08-20] Mensajes de chat al crear la sala y al cambiar de cinta (V12)

**Motivo:** pedido del usuario — que el chat avise el nombre del video cada vez que se cambia de
cinta, y también al crear la sala, mostrando con qué video se creó.

**Cambio 1 (`server.js`, rutas `change-video`/`change-video-from-upload`):** se agrega un
`chat-message` de sistema (`📼 Cambiaron la cinta: <nombre>`) justo antes del `video-changed` que ya
se emitía. Se agrega `videoDisplayName(videoFile)`, que resuelve el nombre legible del archivo
(reutiliza `displayNameFor`, la misma función de la biblioteca que limpia el prefijo hash).

**Cambio 2 (`server.js`, `join-room`):** como crear una sala es un POST HTTP sin ningún socket
conectado todavía, no hay a quién avisarle en el momento de crearla. Se agrega un flag
`initialVideoAnnounced` a `makeRoom()` y se anuncia la cinta (`🎬 Cinta cargada: <nombre>`) la primera
vez que alguien hace `join-room` en la sala (en la práctica, el host recién llegado de crearla),
apagando el flag para que no se repita en joins posteriores de invitados.

**Sin cambios en el cliente** — el chat ya renderizaba mensajes de sistema desde antes.

Ver `MEMORIA.md` sección 8quatervicies para el detalle completo.

---

## [2026-08-20] Fix: "cambiar cinta" no llegaba a los invitados + host duplicado en espectadores (V11)

**Motivo:** el usuario reportó que al usar "📼 Cambiar cinta", el video nuevo solo se veía en la
pantalla del host (los invitados se quedaban con el viejo), y que además aparecía otro "invitado" con
el mismo nombre del host en la pestaña "Espectadores", como duplicado.

**Causa raíz:** "cambiar cinta" implica que el host navega fuera de `room.html` (a
`/library.html?fromRoom=...` y de vuelta), lo que cierra y reabre su socket.

**Fix 1 (`public/room.html`):** faltaba el listener `socket.on('video-changed', ...)` del lado del
cliente. El servidor (`server.js`) siempre emitió correctamente `video-changed` a toda la sala al
cambiar de cinta — eso nunca estuvo roto — pero nadie lo escuchaba. El host "veía" el cambio solo
porque, al volver de la biblioteca, la página se recarga entera y pide el video actualizado de nuevo
vía `room-data`; los invitados, que nunca navegan a ningún lado, jamás recibían el video nuevo. Se
agregó el listener (mismo patrón que `subtitle-changed`): pausa, limpia y recarga el `<video>`, y
resetea `lastKnownTime` para no dejar a los invitados "atados" a un tiempo del video anterior.

**Fix 2 (`public/room.html`):** el link `#changeVideoLink` no llamaba a `socket.disconnect()` antes de
navegar a la biblioteca (a diferencia del botón "Salir", que sí lo hace desde siempre). Dejar que el
navegador cierre el socket "pasivamente" al descargar la página no es tan inmediato como un
`disconnect()` explícito — durante esa ventana, el servidor sigue considerando conectado al socket
viejo del host, y si la nueva conexión hace `join-room` antes de que esa ventana se cierre, la lista de
espectadores muestra dos entradas con el nombre del host (una viva, una fantasma) hasta que el servidor
por fin detecta el corte. Se agregó un handler de `click` en el link que desconecta el socket a mano
antes de dejar seguir la navegación, igual que "Salir".

**Sin cambios en el servidor** — ambos fixes son puramente de cliente (`public/room.html`).

Ver `MEMORIA.md` sección 8tervicies para el detalle completo.

---

## [2026-08-20] Biblioteca: scrollbar temático, botones alado en mobile, y fix del hueco antes de la lista

**Motivo:** tres pedidos del usuario sobre `/library.html` (con capturas en cada paso), en la misma
sesión de trabajo:
1. En PC, el scroll interno de `.tape-list` mostraba el scrollbar nativo del navegador (riel blanco
   sólido con flechas), que desentona con la estética VHS/neón del resto de la interfaz.
2. En mobile, las tarjetas de `.tape-item` quedaban muy grandes (mucho padding, ícono grande, y los
   botones USAR/eliminar se envolvían a su propia fila DEBAJO de toda la tarjeta), entrando pocas
   cintas a la vista sin scrollear.
3. Un hueco grande y "brusco" entre la caja "O inserta una cinta nueva" y la primera cinta de la
   lista, tanto en mobile como en desktop — este tomó 3 iteraciones hasta dar con la causa real (ver
   detalle abajo).

**Cambio 1 — scrollbar (`public/style.css`, solo `.tape-list`):** se reemplaza el scrollbar nativo por
uno temático (pulgar delgado color `var(--line)` que se enciende en `var(--cyan)` al hover), vía
`scrollbar-color`/`scrollbar-width` (Firefox) y `::-webkit-scrollbar*` (Chrome/Edge/Safari). No afecta
ningún otro elemento con scroll del proyecto (`.chat-messages` en room.html no se tocó).

**Cambio 2 — tarjetas compactas + botones alado (mobile, `@media (max-width: 480px)`):** se compactan
padding/ícono/tipografía de `.tape-item`, y se saca el `flex-wrap`/`order`/`flex-basis` que mandaba
`.tape-item-actions` a su propia fila. Ahora ícono + nombre/meta + botones quedan siempre en una sola
fila (igual que en desktop) — el nombre vuelve a truncar con `…` en una línea para no desbordar la fila
en pantallas angostas.

**Cambio 3 — el hueco antes de la lista, en 3 intentos:**
- *Intento 1* (mobile-only): se bajó `margin-top` de `.deck.deck-wide .tape-list` y `margin-bottom`/
  `padding-bottom` de `.new-upload`, pero solo dentro del `@media (max-width: 480px)` — insuficiente,
  porque el usuario mandó una captura del mismo hueco en desktop (`.deck-wide` de 620px, muy por encima
  del breakpoint), donde el fix no aplicaba.
- *Intento 2*: los mismos valores se movieron a la regla base (afecta desktop y mobile por igual). El
  usuario probó con hard refresh en `localhost:3000` (para descartar caché del navegador/Cloudflare
  Tunnel) y el hueco seguía prácticamente igual de grande — se midió en píxeles sobre la captura y no
  coincidía con los valores nuevos, más cercano a los viejos.
- *Causa raíz real* (encontrada midiendo coordenadas de color en las capturas): `#newTapeStatus` (el
  `<div class="status-line">` dentro de `.new-upload`, donde se muestra "Subiendo cinta... X%" durante
  una subida) heredaba la regla base `.status-line { margin-top: 16px; min-height: 18px; ... }` — 34px
  reservados **siempre**, esté vacío o no (que es la mayoría del tiempo, ya que solo se llena durante
  una subida activa). Ese espacio invisible, sumado a los ajustes de los intentos 1 y 2, era el hueco
  real. Mismo patrón que `index.html` ya había resuelto para `#status`/`#joinStatus` (ver sección
  8vicies de `MEMORIA.md`), nunca aplicado a `#newTapeStatus` de `library.html`. Fix: mismo override
  (`min-height: 0`), con `margin-top: 6px` (no 0, para que cuando sí haya texto de progreso no quede
  pegado al selector de archivo).

**Verificado:** el usuario confirmó tras el fix del `#newTapeStatus` que el hueco se ve correcto, en
desktop (`localhost:3000` con hard refresh) y en mobile (Cloudflare Tunnel).

---



**Motivo:** pedido del usuario, con una captura del bug en biblioteca en mobile (Chrome Android, vía
Cloudflare Tunnel): la tarjeta entera era más alta que la pantalla y la PÁGINA COMPLETA scrolleaba
(arrastrando título y tagline), mientras `.tape-list` tenía además su propio scroll interno — dos
scrolls compitiendo. El ajuste anterior de home (ver entrada de más abajo) fue un parche parcial de
valores en `px`; esta vez se pidió explícitamente el enfoque completo con unidades relativas.

**Causa raíz:** `.vhs-scene` usaba `min-height: 100vh`. En mobile, `100vh` vale el alto "grande" de la
pantalla (como si la barra de Chrome estuviera oculta) — más alto que el área que en verdad se ve al
cargar la página (con la barra visible). Con `min-height`, la escena terminaba siendo más alta que lo
realmente visible, y el navegador agregaba scroll de PÁGINA para llegar a ese sobrante — eso es lo que
movía el título y la tagline en la captura. Además, `.deck.deck-wide` limitaba su alto con
`max-height: 82vh`, un porcentaje fijo del mismo `100vh` inflado, que tampoco compensaba la barra.

**Cambio** (`public/style.css`, sin tocar HTML/JS):
- `.vhs-scene` pasa de `min-height: 100vh` a `height: 100vh; height: 100dvh` (capa de respaldo +
  capa `dvh` real, mismo patrón que ya usa `.room-scene` para el teclado), con `overflow-y: auto`
  como red de seguridad en vez de `overflow: hidden` — así, si algún caso extremo no llega a entrar
  ni encogiéndose al mínimo, el resultado es un scroll ocasional y contenido en vez de recortar y
  esconder un botón.
- `.deck.deck-wide` (biblioteca) pasa de `max-height: 82vh` a `max-height: 100%` del `.vhs-scene`
  ahora `dvh`-based — el límite real siempre coincide con lo visible en pantalla. `.tape-list` sigue
  siendo la única parte con `flex:1` + `overflow-y:auto`, así que sigue siendo la única que scrollea;
  el resto de la tarjeta (título, tagline, volver) queda fijo, que era el pedido explícito del
  usuario. Se compactó además la cabecera de biblioteca (back-link, eyebrow, título, tagline, margen
  de `.tape-list`) con `clamp(..., dvh, ...)`, porque en mobile es proporcionalmente más alta y le
  restaba espacio a la lista.
- `.deck:not(.deck-wide)` (home): todos los paddings/márgenes que en la sesión anterior se habían
  fijado en `px` (padding de la tarjeta, tagline, tape-slot, rec-btn, status-line, divider-row) pasan
  a `clamp()` con `dvh`, para seguir encogiendo proporcionalmente en ventanas bajas en vez de quedarse
  en un piso fijo y volver a desbordar. `.marquee-title` ahora también limita su tamaño por alto
  (`min(7vw, 8dvh)`), no solo por ancho — antes una ventana ancha pero baja (celular en landscape) no
  lo achicaba.
- Fix de regresión propia detectado al probar: al achicar el padding-top del home, el contador REC
  decorativo (`.rec-timer`, position:absolute) empezó a superponerse con el texto "REWIND · PLAY ·
  REC" en viewports bajos. Se agregó a la lista de elementos ocultos en `@media (max-height: 500px)`.
- Bug preexistente encontrado de paso (no introducido en esta sesión): ese mismo
  `@media (max-height: 500px)` estaba ubicado ANTES de las reglas base de `.deck-corner` y
  `.rec-timer` en el archivo — con la misma especificidad, en CSS gana la regla que aparece último en
  el archivo, sin importar si está dentro de un `@media` o no. Es decir, las esquinas decorativas
  nunca se habían ocultado de verdad en pantallas bajas pese a que la regla "existía". Se movió el
  bloque de media query a después de esas dos reglas base para que el override se aplique realmente.

**Verificado con Chromium headless (Playwright) en este entorno**, sirviendo `public/` con un server
estático local — no es una suposición de lectura de código: se midió `scrollHeight` vs `clientHeight`
del documento en 7 tamaños de viewport por página (desktop/mobile, normal/bajo/extremo/landscape), y
la biblioteca además con una lista sintética de 15 cintas para reproducir el caso real con contenido.
Antes del fix, home scrolleaba a nivel página en 500px, 350px y en landscape mobile (844×390); después,
cero scroll de página en todos los tamaños probados, incluyendo esos.

**Límite honesto (no es magia sin límite):** no hay forma puramente CSS de garantizar que absolutamente
cualquier contenido entre en absolutamente cualquier alto de ventana sin ni ocultar texto ni scrollear
en algún punto — se optó por priorizar nunca esconder contenido interactivo. Para el home, midiendo en
este entorno: sin ningún scroll (ni de página ni interno) desde ~560px de alto de viewport hacia arriba
(cubre prácticamente cualquier laptop, monitor, o celular en portrait real); entre ~520px y ~560px puede
faltar 1–3px y activarse un scroll interno mínimo y apenas perceptible dentro de `.vhs-scene`; por
debajo de eso (ventanas realmente extremas, tipo 350–450px de alto) ese scroll interno se vuelve más
notorio, como red de seguridad. La biblioteca no tiene este problema — su propio contenido scrolleable
(`.tape-list`) absorbe cualquier exceso sin necesidad de la red de seguridad.

Ver `MEMORIA.md`, sección 8unvicies, para el detalle completo.


## [2026-08-20] Ajuste visual — Home más compacto: entra sin scroll y sin hueco vacío antes de "O TAMBIÉN"

**Motivo:** pedido del usuario, mostrando una captura del home — quería que la pantalla de crear sala
entrara completa sin scroll, y notó un espacio vacío de más entre el botón "GRABAR SALA" y el
separador "O TAMBIÉN".

**Causa del hueco:** `#status` reservaba `min-height: 18px` + `margin-top: 16px` aunque estuviera
vacío (para no saltar el layout cuando aparece el texto de progreso), sumado al `margin: 26px 0 20px`
de `.divider-row` — entre los dos, ~60px reservados sin nada visible casi todo el tiempo.

**Cambio** (`public/style.css`, `public/index.html`): se achicó el padding/márgenes en varios puntos
del home (tarjeta, tagline, tape-slot, input de contraseña, botón, separador, link a biblioteca) y se
agregó una regla específica para `#status`/`#joinStatus` que reduce su hueco reservado en vacío. Se
scopeó con `.deck:not(.deck-wide)` para no afectar `library.html`, que reutiliza varias de las mismas
clases (`.tagline`, `.tape-slot`, `.status-line`) pero maneja su propio scroll interno y no lo
necesitaba.

Ver `MEMORIA.md`, sección 8vicies, para el detalle completo.

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