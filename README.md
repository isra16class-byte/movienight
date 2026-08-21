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

### Contraseña de la biblioteca

`/library.html` (donde se ven y se pueden borrar todos los videos ya subidos, de cualquier sala) pide
una contraseña propia, separada de la contraseña de cada sala — porque a diferencia de una sala, la
biblioteca es compartida por todo el servidor. Si no configurás nada, el servidor genera una al azar
en cada arranque y la imprime en la consola al iniciar.

Para que sea siempre la misma, la forma más simple es crear un archivo `.env` (se carga solo, no hace
falta repetir nada cada vez que arrancás el servidor):

```bash
cp .env.example .env
```

Y editá `.env` con la contraseña que quieras:

```
LIBRARY_PASSWORD=lo-que-quieras
```

`.env` nunca se sube a git (ya está en `.gitignore`) — es solo para tu compu. Compartí la contraseña
con tu grupo por otro canal (no por el mismo link de la sala).

Alternativa sin `.env`, pasando la variable directo al arrancar:

```bash
# Mac/Linux
LIBRARY_PASSWORD=lo-que-quieras npm start

# Windows (PowerShell)
$env:LIBRARY_PASSWORD="lo-que-quieras"; npm start
```

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

## Cloudflare R2 (opcional — para cuando el link de Cloudflare Tunnel se traba)

Si compartís la sala por internet con **Cloudflare Tunnel** (ver sección anterior) y varios amigos
remotos ven el video trabado o con buffering constante, aunque tu conexión de subida sea buena, el
problema casi siempre es el "Quick Tunnel" gratis: todo el tráfico de video sale de tu compu por una
sola conexión, compartida entre todos los espectadores remotos a la vez. Con un video de varios GB y
más de un espectador remoto, esa conexión se satura.

**Cloudflare R2** es el storage tipo S3 de Cloudflare. Si el video vive ahí en vez de en tu disco, ya
no sale de tu compu en absoluto: lo sirve directo la red de Cloudflare a cada espectador, y el egress
(ancho de banda de salida) es **gratis siempre**, sin límite — a diferencia de la mayoría de storages
S3-compatibles. El tier gratis de R2 incluye 10 GB de storage y 1 millón de operaciones al mes,
suficiente para tener guardada una película pesada sin pagar nada.

Esto es **totalmente opcional**: si no configurás nada de esto, el server sigue funcionando en modo
local (disco), exactamente igual que siempre.

### Cómo activarlo

1. Creá una cuenta gratis en [Cloudflare](https://dash.cloudflare.com/sign-up) si no tenés una.
2. En el dashboard, andá a **R2 Object Storage** y creá un bucket (ej. `movienight`). La primera vez
   te va a pedir agregar un método de pago (tarjeta o PayPal) para habilitar R2 — no te cobra nada
   mientras te mantengas dentro del tier gratis, pero Cloudflare igual lo exige como requisito para
   activar el servicio.
3. Dentro del bucket, en su configuración, activá **acceso público** (public access) usando el
   subdominio gratis que te ofrece Cloudflare (`https://pub-xxxxxxxx.r2.dev`) — no hace falta un
   dominio propio para esto.
4. Generá credenciales de API: en R2 → **Manage R2 API Tokens** → creá un token con permisos de
   lectura y escritura sobre tu bucket. Te va a dar un `Access Key ID` y un `Secret Access Key`.
5. Tu `Account ID` de Cloudflare aparece en la URL del dashboard o en la barra lateral de la cuenta.
6. Completá estas variables en tu `.env` (ver `.env.example`):
   ```
   R2_ACCOUNT_ID=tu-account-id
   R2_ACCESS_KEY_ID=tu-access-key-id
   R2_SECRET_ACCESS_KEY=tu-secret-access-key
   R2_BUCKET_NAME=movienight
   R2_PUBLIC_URL=https://pub-xxxxxxxx.r2.dev
   ```

**Estado actual:** por ahora esto solo monta la infraestructura (`lib/r2.js`) — subir/listar/borrar
videos todavía se sigue haciendo en disco local (`public/uploads`) mientras se termina de conectar R2
al flujo de crear sala, cambiar cinta y la biblioteca. Esta sección se va a ir actualizando a medida
que eso avance.

## Estructura del proyecto

```
movienight/
  server.js              # Servidor Express + Socket.io
  package.json
  lib/
    r2.js                 # Cloudflare R2 (opcional, ver sección arriba) — subir/listar/borrar videos en R2
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
