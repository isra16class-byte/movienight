# 🧠 MEMORIA DEL PROYECTO — MovieNight

Este archivo es un resumen de contexto para retomar el desarrollo en cualquier momento (por ti mismo o pegándoselo a una IA). Explica qué es el proyecto, cómo está armado, qué decisiones se tomaron y por qué, y qué falta.

Última actualización: 15 de agosto de 2026.

---

## 1. Qué es

Watch party privado para ver películas con amigos. Es una app web (no nativa) hecha con **Node.js + Express + Socket.io**. El dueño de la sala ("host") sube un archivo de video desde su compu, se genera un link de sala, y sus amigos entran desde el navegador (compu o celular) a ver el video sincronizado, con chat y reacciones.

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

## 8. Riesgos / cosas pendientes de endurecer (seguridad)

- El `hostToken` viaja en texto plano por HTTP (a menos que Cloudflare Tunnel lo cifre en tránsito, que sí lo hace vía HTTPS). Si alguien lo obtiene (inspeccionando `localStorage` de la persona equivocada, por ejemplo), puede hacerse pasar por host.
- No hay rate-limiting en el chat ni en la subida de archivos — un usuario malicioso podría floodear el chat o intentar subir archivos gigantes repetidamente.
- No hay validación de tipo de archivo más allá de lo que el navegador manda como `video/*` en el `<input accept>` — no es una validación real de seguridad, solo de UX.
- Las salas nunca se borran ni expiran — si el server corre mucho tiempo, `rooms` y los archivos en `uploads/` se van acumulando.

## 9. Ideas pendientes / roadmap

- [ ] Traspasar el rol de host a otro espectador (si el host se desconecta, nadie puede controlar el video).
- [ ] Subtítulos (.srt) sincronizados.
- [ ] Borrado automático de salas/archivos viejos (ej. después de X horas sin actividad).
- [ ] Dominio fijo con Cloudflare Tunnel nombrado (requiere cuenta de Cloudflare + dominio propio) para no tener que compartir un link nuevo cada sesión.
- [ ] Posible: contraseña de sala además del link, para evitar que alguien con el link viejo entre sin querer.
- [ ] Posible: mostrar advertencia/loading mientras el video sube (actualmente el usuario no tiene feedback de progreso de subida, solo un texto genérico "Subiendo...").

## 10. Historial de cambios

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
