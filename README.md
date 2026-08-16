# 🎬 MovieNight

Watch party privado para ver películas con amigos, sincronizado en tiempo real, con chat y reacciones. Uso personal — tú subes el video desde tu computadora y tus amigos se conectan con un link.

## ¿Qué hace?

- Subes un archivo de video desde tu compu y se crea una **sala** con un código único.
- Compartes el link de la sala y tus amigos entran desde su navegador (compu o celular), sin instalar nada.
- El video se reproduce **sincronizado** para todos: cuando el host le da play, pausa o adelanta, se refleja en la pantalla de todos.
- Chat de texto en vivo + reacciones flotantes con emojis (😂 🔥 😱 ❤️ 👏).
- Sistema de **host**: solo quien crea la sala controla el video. Los demás solo miran (con su propio volumen y pantalla completa locales).

## Roles

### 👑 Host
Es quien crea la sala (sube el video). Tiene:
- Control exclusivo de play / pausa / adelantar / atrasar.
- Botón para **cambiar la película** en cualquier momento sin cerrar la sala.
- Pestaña "Espectadores" con botones para:
  - **Silenciar**: bloquea el chat de esa persona (ella recibe un aviso, tú no).
  - **Expulsar**: la saca de la sala inmediatamente.

El navegador guarda el `hostToken` (una clave secreta) en `localStorage` al crear la sala — por eso el rol de host persiste si recargas la página, pero no si entras desde otro dispositivo o borras los datos del navegador.

### 👤 Invitado
Entra con el link, pone su nombre, y ve el video sincronizado. Puede:
- Chatear y mandar reacciones (a menos que el host lo silencie).
- Ajustar su propio volumen y poner pantalla completa (esto es local, no afecta a nadie más).
- No puede pausar, adelantar ni atrasar el video — cualquier intento se revierte automáticamente.

## Instalación

Requiere [Node.js](https://nodejs.org) (versión LTS) instalado.

```bash
npm install
npm start
```

El servidor queda escuchando en `http://localhost:3000`.

## Cómo usarla en la misma red (WiFi de casa)

1. Corre `npm start`.
2. Entra a `http://localhost:3000` desde tu navegador, sube el video y crea la sala.
3. Comparte la URL que te queda en la barra de direcciones con tus amigos — si están en la misma WiFi, puedes usar tu IP local en vez de `localhost` (ej: `http://192.168.1.5:3000`) para que ellos también puedan entrar.

## Cómo usarla con amigos fuera de tu red (por internet)

Necesitas exponer tu servidor local a internet. La forma recomendada es **Cloudflare Tunnel** (gratis, sin límite de tiempo de sesión):

1. Instala `cloudflared` ([instrucciones oficiales](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
2. Con el servidor corriendo (`npm start`), abre otra terminal y ejecuta:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Copia el link público que te da (algo como `https://palabras-random.trycloudflare.com`).
4. Entra a ese link (no a `localhost`), crea tu sala, y comparte la URL completa con `/room/codigo` a tus amigos.

**Importante:** necesitas 2 procesos corriendo al mismo tiempo — el servidor (`npm start`) y el túnel (`cloudflared`). Si cierras cualquiera de las dos terminales, o tu compu se suspende, el link deja de funcionar para todos. El link también cambia cada vez que reinicias `cloudflared`, a menos que configures un túnel con nombre y dominio propio.

## Estructura del proyecto

```
movienight/
  server.js              # Servidor Express + Socket.io
  package.json
  public/
    index.html            # Página para crear sala
    room.html              # Página de la sala (reproductor, chat, controles)
    uploads/                # Videos subidos (se genera solo, no se sube a git)
```

## Cómo funciona por dentro

- **Backend (`server.js`)**: usa Express para servir archivos y Multer para recibir el video subido. Cada sala vive en memoria (`rooms`) mientras el servidor esté corriendo — si lo reinicias, se pierden las salas activas.
- **Sincronización**: Socket.io transmite eventos `play`, `pause`, `seek` del host a todos los demás en la sala. Además, el host manda un "heartbeat" cada 4 segundos con su posición exacta, para corregir cualquier desajuste por buffering o lag.
- **Bloqueo de controles**: los invitados no ven la barra de progreso nativa (`video.controls = false`), y si de alguna forma logran mover el tiempo del video (gestos táctiles, teclado), el script lo revierte automáticamente a la posición correcta.
- **Host token**: al crear la sala, el servidor genera una clave aleatoria (`hostToken`) que solo el creador recibe y guarda en su navegador. Se manda en cada conexión para que el servidor sepa quién tiene permiso de controlar la sala.

## Límites conocidos

- Las salas y su estado (chat, viewers, etc.) viven **solo en memoria** — se pierden si reinicias el servidor.
- El tamaño máximo de video está puesto en 8GB (`server.js`, variable `limits.fileSize` en la config de Multer) — se puede ajustar.
- Si el host cierra su pestaña o pierde conexión, nadie puede controlar el video hasta que vuelva a entrar (no hay "traspaso de host" automático todavía).
- Pensado para uso personal con pocos amigos a la vez, no para muchos usuarios simultáneos ni producción.

## Próximas ideas (no implementadas)

- Traspasar el rol de host a otro espectador.
- Subtítulos (.srt) sincronizados.
- Historial de salas / salas persistentes en disco o base de datos.
- Dominio fijo con Cloudflare Tunnel para no compartir un link distinto cada vez.
