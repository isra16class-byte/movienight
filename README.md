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

**Importante:** necesitas 2 procesos corriendo al mismo tiempo — el servidor (`npm start`) y el túnel (`cloudflared`). Si cierras cualquiera de las dos terminales, o tu compu se suspende, el link deja de funcionar para todos. El link también cambia cada vez que reinicias `cloudflared`, a menos que configures un túnel con nombre y dominio propio (ver siguiente sección).

## Dominio fijo (túnel con nombre)

Lo de arriba es un **Quick Tunnel**: gratis, sin configuración previa, pero te da un link random
distinto (`https://palabras-random.trycloudflare.com`) cada vez que reiniciás `cloudflared` — hay que
volver a compartirlo con tus amigos cada sesión.

Un **túnel con nombre** resuelve eso: mismo link siempre (ej. `https://movienight.tudominio.com`), a
costa de un poco de configuración única. Sigue siendo gratis, pero necesitás tener un dominio propio
ya agregado a tu cuenta de Cloudflare (podés comprar uno barato en cualquier registrador y cambiarle
los nameservers a Cloudflare — Cloudflare no vende dominios `.com`/`.net` directo, pero agregar uno
existente a tu cuenta sí es gratis).

### Cómo activarlo

1. Instalá `cloudflared` si todavía no lo hiciste (ver sección anterior).
2. Autenticá `cloudflared` con tu cuenta (una sola vez por compu, abre el navegador):
   ```bash
   cloudflared tunnel login
   ```
3. Creá el túnel con nombre (podés usar `movienight` o el nombre que quieras):
   ```bash
   cloudflared tunnel create movienight
   ```
   Esto imprime un `UUID` y guarda un archivo de credenciales en `~/.cloudflared/<UUID>.json` — es lo
   único que necesitás de este paso, no hace falta anotar nada más.
4. Conectá un subdominio de tu dominio (ya agregado a Cloudflare) a ese túnel:
   ```bash
   cloudflared tunnel route dns movienight movienight.tudominio.com
   ```
   Esto crea el registro DNS automáticamente — no hace falta tocar nada a mano en el dashboard.
5. Copiá `cloudflared-config.example.yml` a `cloudflared-config.yml` (en la raíz del proyecto) y
   completá los 3 valores marcados adentro: el nombre/UUID del túnel, la ruta completa al archivo de
   credenciales del paso 3, y el subdominio que elegiste en el paso 4.
6. Con el servidor corriendo (`npm start`), en otra terminal:
   ```bash
   npm run tunnel
   ```
   (equivale a `cloudflared tunnel --config cloudflared-config.yml run`)
7. Entrá a `https://movienight.tudominio.com` (el mismo link, siempre, en cada sesión futura) y creá
   tu sala desde ahí.

**Notas:**
- `cloudflared-config.yml` (el archivo real, con tus valores) no se sube a git — está en `.gitignore`,
  igual que `.env`. Solo se versiona la plantilla `cloudflared-config.example.yml`.
- Seguís necesitando 2 procesos corriendo (`npm start` + `npm run tunnel`), igual que con el Quick
  Tunnel — lo único que cambia es que el link ya no varía entre sesiones.
- Los pasos 2 a 5 son **de una sola vez**: una vez armado el túnel con nombre, en cada sesión futura
  alcanza con repetir el paso 6 (`npm run tunnel`).

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

**Estado actual: completo.** Si completás las 4 variables obligatorias del `.env`, todo el ciclo de
vida de un video pasa por el bucket en vez de disco local:

- Subir un video (al crear una sala o al cambiar de cinta) se transmite directo a R2.
- La biblioteca (`library.html`) lista, reutiliza y borra videos directo del bucket — funciona
  exactamente igual que en modo disco, sin ningún cambio visible para quien la usa.

El servidor verifica la conexión a R2 al arrancar y te avisa por consola en qué modo quedó. Si **no**
completás esas variables, todo sigue funcionando en modo local (disco), exactamente igual que
siempre — es un modo dual, no hace falta elegir de antemano.

Si algo de la configuración de R2 está mal (credenciales, nombre de bucket, etc.), el servidor te
avisa claro por consola al arrancar, y cualquier operación contra R2 (subir, listar la biblioteca,
reutilizar un video, borrar) va a fallar con un mensaje de error legible en vez de romperse en
silencio — a propósito no hay "modo de emergencia" que caiga solo a disco si R2 falla, para no
terminar con videos mezclados entre disco y bucket sin darte cuenta.

## Proceso supervisado (para no depender de una terminal abierta)

Correr `npm start` en una terminal funciona para probar, pero si esa terminal se cierra
(o el proceso crashea por cualquier motivo) el servidor se queda caído hasta que alguien
lo note y lo reinicie a mano. Qué conviene depende de dónde lo hospedes:

- **VPS propio** (una máquina tuya, sin plataforma de hosting de por medio): usar
  [PM2](https://pm2.keymetrics.io/). Ya viene configurado en `ecosystem.config.js`:
  ```bash
  npm install -g pm2      # una sola vez en el servidor
  npm run pm2:start       # arranca movienight supervisado por PM2
  npm run pm2:logs        # ver logs en vivo
  npm run pm2:status      # ver si está corriendo
  npm run pm2:restart     # reiniciar manualmente (ej. después de un deploy)
  pm2 save && pm2 startup # (opcional, una sola vez) para que PM2 levante movienight solo
                           # si se reinicia la máquina — `pm2 startup` imprime un comando
                           # a copiar y correr, distinto según el sistema
  ```
  Si el proceso se cae, PM2 lo reinicia solo, con backoff exponencial (para no reintentar en
  loop si el problema es persistente, ej. Redis caído) y un tope de reinicios seguidos antes
  de rendirse y avisar — el detalle de esos números está comentado en `ecosystem.config.js`.
- **Railway / Render / Fly.io o similar**: no hace falta nada de lo de arriba. Estas
  plataformas ya reinician el proceso solas si crashea, usando `npm start` como comando de
  arranque — `ecosystem.config.js` no se usa en este caso.

## Estructura del proyecto

```
movienight/
  server.js              # Servidor Express + Socket.io
  package.json
  ecosystem.config.js    # Configuración de PM2 para proceso supervisado (solo VPS propio, ver sección arriba)
  cloudflared-config.example.yml  # Plantilla para túnel con nombre / dominio fijo (opcional, ver README)
  lib/
    r2.js                 # Cloudflare R2 (opcional, ver sección arriba) — subir/listar/borrar videos en R2
  public/
    index.html            # Página para crear sala
    room.html              # Página de la sala (reproductor, chat, controles)
    uploads/                # Videos subidos (se genera solo, no se sube a git)
  docs/
    MEMORIA.md              # Resumen activo para retomar el proyecto rápido (arquitectura, roles, riesgos) — leer primero
    CHANGELOG.md             # Historial de cambios activo (nuevas entradas van acá)
    PLAN-PRODUCCION.md      # Plan por fases de todo lo pendiente para llevar esto a producción real
    historico/
      MEMORIA.md            # Registro histórico detallado, versión por versión (largo, archivado)
      CHANGELOG.md           # Historial cronológico completo hasta la reorganización de docs (archivado)
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

- Historial de salas / salas persistentes en disco o base de datos.
