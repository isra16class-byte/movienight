const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { PassThrough } = require('stream');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const session = require('express-session');

// --- Carga variables desde un .env en la raíz del proyecto, si existe (V10) --------------------
// No se agregó la librería `dotenv` a propósito: el proyecto ya se mantiene con solo 3 dependencias
// (express, multer, socket.io), y para el formato simple que necesitamos (KEY=valor, una por línea)
// no vale la pena sumar una dependencia nueva. No pisa variables que ya vengan del entorno real
// (ej. `LIBRARY_PASSWORD=x npm start` sigue ganándole a lo que diga el .env).
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1); // comillas opcionales alrededor del valor
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

// `require('./lib/r2')` va DESPUÉS de loadDotEnv() a propósito (V17 — fix): lib/r2.js lee
// process.env.R2_* en constantes de nivel de módulo, una sola vez, en el momento en que se hace
// `require`. Si el require pasa antes de loadDotEnv() (como estaba desde la Fase 1), esas constantes
// quedan fijadas en '' para siempre, sin importar qué haya en el .env — porque Node cachea el módulo
// y no lo vuelve a ejecutar. El bug no se notaba probando con variables de entorno reales (ej.
// `R2_ACCOUNT_ID=x npm start`), porque esas ya existen en process.env antes de que arranque node —
// recién se manifestó con un usuario real usando un archivo .env.
const r2 = require('./lib/r2');

// Persistencia externa del estado de las salas (Fase 1.1 del plan de producción) — ver
// lib/roomStore.js para el detalle de qué se persiste, por qué, y el criterio de "fallar rápido" si
// Redis está configurado pero no responde.
const roomStore = require('./lib/roomStore');

// Modelo de usuario (registro/login) — Fase 2bis del plan de producción. Ver lib/db.js para el
// detalle de qué se persiste y el criterio de "fallar rápido" si Postgres está configurado y no
// responde. A diferencia de Redis, acá NO configurar DATABASE_URL es un modo válido: el resto de la
// app (salas anónimas por hostToken) sigue funcionando igual, solo /auth/* queda deshabilitado.
const db = require('./lib/db');

// Sesiones de usuario reales (Fase 2bis del plan de producción, "Sesiones") — ver lib/sessionStore.js
// para el detalle de por qué un store propio sobre Redis en vez de una librería como connect-redis.
const { RedisSessionStore } = require('./lib/sessionStore');

// Envío de emails para "olvidé mi contraseña" (Fase 2bis del plan de producción) — ver lib/mailer.js
// para el detalle de por qué Resend y el criterio de "feature opcional" sin RESEND_API_KEY configurada.
const mailer = require('./lib/mailer');

// --- Manejo de errores no capturados (Fase 1.2 del plan de producción) ---------------------------
// Sin esto, un error que se escapa de cualquier lugar del código (una excepción sincrónica que nadie
// atrapó, o una Promise rechazada sin `.catch`) tira abajo el proceso Node entero sin dejar rastro
// útil más que lo que imprima Node por defecto — y con él, todas las salas activas y sus conexiones.
//
// 'uncaughtException': después de una excepción no capturada, el estado interno del proceso queda en
// una condición desconocida (puede haber quedado a mitad de escribir un archivo, un handler a medio
// ejecutar, etc.) — seguir corriendo como si nada puede esconder problemas peores. Por eso la práctica
// recomendada de Node es loguear y salir con código de error (1), no intentar "seguir vivo".
// Esto SÍ significa que, sin la Fase 1.3 (proceso supervisado, ej. PM2) todavía implementada, el
// servidor se queda caído hasta que alguien lo reinicie a mano — es la razón por la que el plan de
// producción ordena 1.2 y 1.3 juntas dentro de la misma fase.
process.on('uncaughtException', (err) => {
  console.error('');
  console.error('💥 Excepción no capturada — el proceso va a cerrarse (revisar logs arriba):');
  console.error(err);
  console.error('');
  process.exit(1);
});

// 'unhandledRejection': una Promise que rechazó sin que nadie le haya puesto `.catch` (ej. un
// `await` faltante en alguna ruta async, o un error de red de R2 no atrapado). A diferencia de una
// excepción sincrónica, el estado del proceso en general sigue siendo válido — por eso acá solo se
// loguea, sin salir, para no reiniciar el servidor (y cortar todas las salas activas) por errores que
// pueden ser puntuales de una sola operación (ej. una subida a R2 que falló para un solo usuario).
process.on('unhandledRejection', (reason) => {
  console.error('');
  console.error('⚠️  Promesa rechazada sin manejar (revisar si falta un try/catch o un .catch):');
  console.error(reason);
  console.error('');
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// El server escucha en localhost y se expone con Cloudflare Tunnel (ver README) — todas las
// requests le llegan físicamente desde `cloudflared` en la propia máquina, no desde el navegador de
// cada persona. Sin `trust proxy`, `req.ip` sería siempre la misma IP local para todo el mundo, lo
// cual inutilizaría cualquier rate-limiting por IP (ver requireUploadAuth, V19: un solo intento
// fallido de cualquiera bloquearía a todo el grupo por igual). Con esto, Express lee la IP real del
// visitante del header `X-Forwarded-For` que agrega Cloudflare en el camino.
app.set('trust proxy', true);

// IP real del visitante: preferimos el header propio de Cloudflare (`Cf-Connecting-Ip`, más confiable
// cuando se pasa por su red, sea con Tunnel o no) y caemos a `req.ip` (ya resuelto por Express vía
// X-Forwarded-For gracias al 'trust proxy' de arriba) si no está presente — ej. corriendo en
// localhost sin túnel, donde Cloudflare no interviene.
function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Mismo criterio que clientIp(req) de arriba, pero para conexiones de Socket.io — usado por el
// rate-limiting de intentos de contraseña de sala en 'join-room' (Fase 2.2 del plan de producción).
// El handshake de Socket.io no pasa por el middleware `trust proxy` de Express, así que acá se lee
// directo el header que agrega Cloudflare.
function socketClientIp(socket) {
  return socket.handshake.headers['cf-connecting-ip'] || socket.handshake.address || 'unknown';
}

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// `setHeaders` para .html/.css/.js: por defecto Cloudflare cachea estáticos por extensión (CSS/JS
// sobre todo) en su borde, INDEPENDIENTEMENTE de que reiniciemos el server o el túnel — confirmado
// en producción: un cambio de `style.css` no se veía reflejado hasta purgar el caché a mano en el
// dashboard de Cloudflare, aunque el archivo en disco ya estuviera actualizado. Como este proyecto
// se actualiza seguido a mano (git am + reiniciar), preferimos que SIEMPRE se sirva la versión más
// nueva del código de la app antes que ganar unos ms de velocidad — `no-store` en el código (no en
// los uploads/thumbnails de `public/uploads`, que si se pueden cachear normalmente) evita que
// Cloudflare vuelva a guardar una copia vieja.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|css|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  }
}));
app.use(express.json());

// --- Sesiones de usuario (Fase 2bis del plan de producción, "Sesiones") --------------------------
// Reemplaza, para quien tiene cuenta, la idea de "confiar en lo que mande el cliente" (el esquema de
// `hostToken` en localStorage) por una sesión real de servidor: el navegador solo recibe un `sid`
// random en una cookie `httpOnly` (JS del navegador no puede leerla ni exfiltrarla por XSS, a
// diferencia de `localStorage`) — el contenido real (`userId`, `email`) vive en Redis, ver
// lib/sessionStore.js. Importante: esto todavía NO reemplaza `hostToken` como forma de probar "soy el
// dueño de esta sala" (eso es el punto siguiente de la Fase 2bis, "migración del rol de host", ver
// docs/PLAN-PRODUCCION.md) — hoy conviven los dos esquemas: `hostToken` sigue siendo la única fuente
// de verdad para el control de sala, y la sesión solo identifica "hay una cuenta logueada" para
// /auth/*. Se monta SIEMPRE (no solo si DATABASE_URL está configurada): así el middleware existe de
// entrada y las rutas de /auth/* (deshabilitadas sin Postgres, ver requireDbEnabled) simplemente no
// llegan a tocar req.session; no hay necesidad de una rama condicional acá.
//
// SESSION_SECRET: usada por express-session para firmar la cookie (detecta si alguien la modificó a
// mano, no es para cifrar el contenido — el contenido en sí vive server-side en Redis, no en la
// cookie). Mismo patrón que LIBRARY_PASSWORD (server.js, Fase 2 vieja): si no está seteada por
// variable de entorno, se genera una al azar y se avisa por consola — PERO a diferencia de
// LIBRARY_PASSWORD, acá el efecto de que cambie en cada reinicio es distinto: no rompe nada del lado
// del servidor, pero SÍ invalida de golpe todas las sesiones activas (todo el mundo queda
// desloggeado) cada vez que el proceso reinicia. Para producción real conviene fijar SESSION_SECRET
// en el .env, igual que se recomienda con LIBRARY_PASSWORD.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sessionSecretWasGenerated = !process.env.SESSION_SECRET;

// Duración de la sesión: 30 días por default, configurable. `rolling: true` (más abajo) hace que cada
// request autenticada empuje el vencimiento hacia adelante — una cuenta que se usa seguido no se
// desloggea sola a mitad de camino, solo si pasan SESSION_MAX_AGE_MS sin ninguna actividad.
const SESSION_MAX_AGE_MS = parseInt(process.env.SESSION_MAX_AGE_MS, 10) || 30 * 24 * 60 * 60 * 1000;

// `secure: true` en la cookie (el navegador solo la manda sobre HTTPS) es el default correcto para
// producción (Cloudflare Tunnel siempre expone HTTPS hacia afuera, ver README) — pero cortaría las
// sesiones en desarrollo local sobre http://localhost sin túnel. Escape hatch explícito
// (SESSION_COOKIE_INSECURE=1), mismo criterio que DISABLE_REDIS: nombrado para que quede clarísimo en
// los logs que es un modo degradado, nunca para producción.
const SESSION_COOKIE_INSECURE = process.env.SESSION_COOKIE_INSECURE === '1';

// Se guarda en una variable (en vez de pasarlo anónimo a app.use()) porque, desde la Fase 2bis
// ("migración del rol de host"), Socket.io también necesita poder leer/escribir esta misma sesión —
// ver `io.engine.use(sessionMiddleware)` un poco más abajo, después de que `io` ya existe.
const sessionMiddleware = session({
  // Si Redis está deshabilitado (DISABLE_REDIS=1, solo desarrollo local sin Redis a mano — ver
  // lib/roomStore.js) no tiene sentido instanciar el store propio (que asume Redis disponible): se
  // cae al MemoryStore que trae express-session por default, con el mismo tipo de aviso por consola
  // que ya usan roomStore.js/lib/db.js para sus propios escape hatches (ver el aviso en startServer()).
  // MemoryStore pierde todas las sesiones activas en cada reinicio y no sirve con más de un proceso —
  // aceptable solo porque es exactamente el mismo modo "sin persistencia real" que ya implica
  // DISABLE_REDIS=1 para las salas.
  store: roomStore.isEnabled() ? new RedisSessionStore() : undefined,
  secret: SESSION_SECRET,
  name: 'movienight.sid', // nombre propio de cookie, no el 'connect.sid' default (no anunciar la librería usada)
  resave: false, // el store propio no necesita "refrescar" en cada request sin cambios (evita writes de más a Redis)
  saveUninitialized: false, // no crear ni persistir una sesión para visitas anónimas que nunca hacen login
  rolling: true, // cada request de alguien logueado empuja el vencimiento — ver SESSION_MAX_AGE_MS arriba
  cookie: {
    httpOnly: true, // JS del navegador no puede leer esta cookie (mitiga robo de sesión vía XSS)
    secure: !SESSION_COOKIE_INSECURE,
    sameSite: 'lax', // alcanza para este caso de uso (no hay necesidad de cross-site real) y mitiga CSRF básico
    maxAge: SESSION_MAX_AGE_MS
  }
});
app.use(sessionMiddleware);

// --- Compartir la sesión con Socket.io (Fase 2bis del plan de producción, "migración del rol de
// host") ------------------------------------------------------------------------------------------
// Hasta acá, la sesión de express-session solo existía del lado de las rutas HTTP normales (/auth/*,
// etc.) — el handshake de Socket.io (io.on('connection', ...)) no pasaba por el middleware de Express
// (ver el comentario grande sobre el rate limiter general, más arriba: Socket.io intercepta su propio
// path ANTES de llegar a Express), así que `socket.request.session` no existía todavía. `io.engine.use`
// (soportado desde Socket.io 4.6+, acá estamos en 4.7.x) monta un middleware de Express directo sobre
// el motor de Engine.io que usa Socket.io por debajo — mismo objeto `req`/`res` que ve el
// handshake, así que reusa la MISMA cookie `movienight.sid` que ya manda el navegador con cualquier
// otro request del mismo origen (no hace falta nada especial del lado del cliente). Con esto,
// `socket.request.session` queda disponible en cualquier handler de socket para leer `userId`/`email`
// si hay una sesión válida — es lo que usa `isRoomOwner()` (ver más abajo) para decidir "soy el dueño
// de esta sala" sin depender de `hostToken` cuando la sala fue creada por una cuenta logueada.
io.engine.use(sessionMiddleware);

// --- Rate limiting general de rutas HTTP (Fase 2.2 del plan de producción) -----------------------
// Capa base sobre TODAS las rutas de la API (creación de sala, biblioteca, subtítulos, etc.), además
// de los límites específicos que ya existían (requireUploadAuth, y ahora join-room). Se define ACÁ,
// después de express.static y express.json(), a propósito:
//   - Después de express.static: los archivos estáticos (HTML/CSS/JS y los videos servidos desde
//     public/uploads) ya quedaron resueltos por ese middleware antes de llegar acá, así que nunca
//     pasan por este limitador — clave para no cortar la reproducción de video, que hace muchos
//     requests de tipo Range por segundo (eso NO es tráfico de "API").
//   - El handshake de Socket.io tampoco pasa por acá: socket.io intercepta las requests a su propio
//     path (/socket.io/) ANTES de que lleguen a Express (ver `new Server(server)` más abajo), así
//     que este limitador nunca ve tráfico de sync/chat/reacciones en tiempo real.
// Ventana y tope generosos a propósito (300 requests/5min por IP): esto es una red de contención
// contra abuso/bugs de cliente, no el límite fino de cada acción puntual (eso lo sigue haciendo
// requireUploadAuth para subir cintas, y el limitador nuevo de join-room para contraseñas de sala).
// `keyGenerator` reusa clientIp() (arriba) en vez del default de la librería, para ser consistentes
// con el resto del proyecto: preferir el header propio de Cloudflare por sobre `req.ip`.
const generalApiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // v8 de express-rate-limit exige pasar cualquier IP por este helper (trunca IPv6 a su /64, así un
  // mismo cliente no puede esquivar el límite rotando de dirección dentro del mismo bloque) — no
  // hacerlo con un keyGenerator custom es un error de validación al arrancar, no solo un warning.
  keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
  // El healthcheck (Fase 1.5) puede consultarse seguido por un orquestador/hosting — no tiene
  // sentido que compita por el mismo cupo que el resto de la API ni que un chequeo automatizado
  // termine bloqueado.
  skip: (req) => req.path === '/health' || req.path === '/healthz',
  message: { error: 'Demasiadas solicitudes desde esta IP. Esperá un momento y volvé a intentar.' }
});
app.use(generalApiLimiter);

// --- Contraseña de biblioteca (V9) --------------------------------------------------------------
// Antes, /api/uploads (listar) y DELETE /api/uploads/:filename (borrar) no pedían nada: cualquiera
// que tuviera la URL base del server —por ejemplo, alguien a quien le reenviaron el link de UNA sala—
// podía navegar a /library.html y ver o borrar TODOS los videos subidos alguna vez, de cualquier sala,
// sin necesitar el hostToken de ninguna. Esto es independiente de la contraseña de sala (que protege
// una sala puntual) y de hostToken (que protege el control de una sala puntual): la biblioteca es
// compartida entre todas las salas del servidor, así que necesita su propio secreto, uno solo para
// todo el server (no por sala), ya que no hay sistema de cuentas.
//
// Se define con la variable de entorno LIBRARY_PASSWORD (ej. en un archivo .env o al arrancar:
// `LIBRARY_PASSWORD=lo-que-sea npm start`). Si no se define, se genera una al azar y se imprime en
// consola al arrancar — quien corre el server la comparte una sola vez con su grupo de amigos (por
// el chat que usen, no por el mismo link de la sala).
const LIBRARY_PASSWORD = process.env.LIBRARY_PASSWORD || crypto.randomBytes(4).toString('hex');
const libraryPasswordWasGenerated = !process.env.LIBRARY_PASSWORD;
// Se hashea con bcrypt de forma asíncrona dentro de startServer() (más abajo), ANTES de aceptar
// conexiones (server.listen) — no se persiste en ningún lado (LIBRARY_PASSWORD siempre sale de la
// variable de entorno o se genera de nuevo al arrancar), así que a diferencia de room.passwordHash
// no hace falta lógica de migración acá: siempre se calcula fresco con el esquema nuevo.
let libraryPasswordHash = null;

// --- Fase 2bis, "la biblioteca deja de depender de una única LIBRARY_PASSWORD" (2026-09-06) ------
// Con cuentas reales ya en pie, tener una sesión iniciada alcanza por sí solo para listar/borrar la
// biblioteca — no hace falta ADEMÁS la contraseña compartida. La LIBRARY_PASSWORD no se quita: sigue
// siendo el único camino para quien no tiene cuenta (todavía no es obligatorio registrarse, ver
// "quién puede crear salas" en docs/PLAN-PRODUCCION.md — este cambio agrega una alternativa, no
// reemplaza la existente, así el grupo actual sin cuentas no pierde acceso a nada). Sigue siendo una
// sola biblioteca compartida entre todos (decidido en Fase 0): el control de acceso ahora acepta dos
// caminos válidos, no dos bibliotecas separadas.
async function requireLibraryAuth(req, res, next) {
  try {
    if (req.session && req.session.userId) return next(); // sesión de cuenta real: alcanza sola
    const provided = req.get('x-library-password') || req.query.libraryPassword || (req.body && req.body.libraryPassword) || '';
    const { valid } = await verifyPassword(provided, libraryPasswordHash);
    if (!valid) return res.status(401).json({ error: 'Contraseña de biblioteca requerida o incorrecta.' });
    next();
  } catch (err) {
    console.error('⚠️  Error verificando la contraseña de biblioteca:', err.message);
    res.status(500).json({ error: 'Error interno verificando la contraseña.' });
  }
}

// --- Contraseña + límite de intentos para SUBIR una cinta nueva (V19) ----------------------------
// Motivo: con R2 conectado, cualquiera con el link llegaba a /create-room y podía subir archivos
// gigantes sin ninguna traba — cada uno se factura (almacenamiento + operaciones de R2). A diferencia
// de requireLibraryAuth (que protege leer/borrar la biblioteca y ya alcanzaba con "correcta o no"),
// acá el costo de un intento de más es mucho más alto: dejar pasar la SUBIDA REAL de un archivo
// pesado es peor que dejar pasar un GET. Por eso, además de reusar la misma LIBRARY_PASSWORD (un solo
// secreto para todo el server, no hace falta uno nuevo — ver sección de riesgos en docs/historico/MEMORIA.md), esto
// suma un límite de intentos por IP: 3 contraseñas incorrectas seguidas bloquean esa IP por 15 minutos
// antes de poder volver a intentar, para que probar contraseñas al azar no sea gratis.
//
// Se aplica ANTES de `upload.single('video')` en las rutas que suben un archivo nuevo (/create-room,
// /room/:id/change-video) — a propósito, para que una contraseña incorrecta corte la request antes de
// que Multer empiece a leer/subir el archivo. El cliente manda la contraseña por el header
// `x-library-password` (no por un campo del FormData): así queda disponible para este middleware
// antes de que arranque el parseo del multipart/form-data que trae el video.
const AUTH_MAX_ATTEMPTS = 3;
const AUTH_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutos bloqueado tras agotar los 3 intentos

// --- Limitador genérico de intentos fallidos (Fase 2.2 del plan de producción) -------------------
// Antes esto vivía hardcodeado dentro de requireUploadAuth (V19). Se extrae acá como fábrica
// reutilizable porque la Fase 2.2 agrega un segundo lugar que necesita exactamente el mismo criterio
// (3 intentos fallidos → bloqueo de 15 min): la contraseña de sala en 'join-room' (ver más abajo),
// que hasta ahora no tenía ningún límite. Cada instancia lleva su propio Map de intentos — una para
// subir cintas (por IP) y otra para join-room (por IP+sala, ver más abajo el porqué de esa clave).
function makeAttemptLimiter() {
  const attempts = new Map(); // key -> { count, lockedUntil }
  return {
    // Minutos restantes de bloqueo para `key`, o null si puede intentar.
    lockedMinutes(key) {
      const entry = attempts.get(key);
      const now = Date.now();
      return (entry && entry.lockedUntil > now) ? Math.ceil((entry.lockedUntil - now) / 60000) : null;
    },
    recordSuccess(key) { attempts.delete(key); }, // se olvida cualquier intento fallido previo
    // Registra un intento fallido; devuelve si quedó bloqueada y cuántos intentos quedan.
    recordFailure(key) {
      const now = Date.now();
      let entry = attempts.get(key);
      // Arranca un contador nuevo si no había uno, o si el bloqueo anterior ya venció (lockedUntil
      // solo es > 0 tras el 3er intento fallido; mientras se cuenta 1° y 2°, se mantiene en 0 y no
      // hay que resetear el contador en cada request).
      if (!entry || (entry.lockedUntil > 0 && entry.lockedUntil <= now)) entry = { count: 0, lockedUntil: 0 };
      entry.count += 1;
      if (entry.count >= AUTH_MAX_ATTEMPTS) {
        entry.lockedUntil = now + AUTH_LOCKOUT_MS;
        entry.count = 0; // al vencer el bloqueo, vuelve a tener 3 intentos frescos
        attempts.set(key, entry);
        return { locked: true, attemptsLeft: 0 };
      }
      attempts.set(key, entry);
      return { locked: false, attemptsLeft: AUTH_MAX_ATTEMPTS - entry.count };
    }
  };
}

const uploadAuthLimiter = makeAttemptLimiter(); // clave: ip
const roomJoinAuthLimiter = makeAttemptLimiter(); // clave: ip + roomId (ver 'join-room' más abajo)

async function requireUploadAuth(req, res, next) {
  try {
    // Mismo criterio que requireLibraryAuth (Fase 2bis, "la biblioteca deja de depender de una única
    // LIBRARY_PASSWORD"): una sesión de cuenta real alcanza sola, sin pedir además la contraseña
    // compartida. No reemplaza el camino existente — sigue siendo válido subir/crear sala solo con la
    // LIBRARY_PASSWORD, sin cuenta (ver "quién puede crear salas" más abajo, decisión ya cerrada).
    if (req.session && req.session.userId) return next();

    const ip = clientIp(req);
    const lockedMinutes = uploadAuthLimiter.lockedMinutes(ip);
    if (lockedMinutes !== null) {
      return res.status(429).json({
        error: `Demasiados intentos fallidos. Esperá ${lockedMinutes} min y volvé a intentar.`,
        lockedMinutes
      });
    }

    const provided = req.get('x-library-password') || '';
    const { valid } = await verifyPassword(provided, libraryPasswordHash);
    if (valid) {
      uploadAuthLimiter.recordSuccess(ip);
      return next();
    }

    const { locked, attemptsLeft } = uploadAuthLimiter.recordFailure(ip);
    if (locked) {
      return res.status(401).json({
        error: 'Contraseña incorrecta. Se bloquearon los intentos de subida por 15 minutos.',
        attemptsLeft: 0
      });
    }
    return res.status(401).json({ error: 'Contraseña incorrecta.', attemptsLeft });
  } catch (err) {
    console.error('⚠️  Error verificando la contraseña de subida:', err.message);
    res.status(500).json({ error: 'Error interno verificando la contraseña.' });
  }
}

// --- Cuentas de usuario: registro y login (Fase 2bis del plan de producción) ---------------------
// Primer paso de la Fase 2bis: modelo de usuario + registro/login. Todavía NO reemplaza el hostToken
// ni el acceso a la biblioteca (eso es el paso siguiente, sesiones — ver docs/PLAN-PRODUCCION.md) —
// por ahora /auth/login solo confirma que el email/contraseña son válidos, no deja una sesión
// iniciada en el navegador. Las dos rutas quedan deshabilitadas (404 explícito, no un 500 confuso) si
// no hay DATABASE_URL configurada, para que quede claro que es un feature opcional todavía no
// activado, no un error del server.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

// --- Recuperación de contraseña (Fase 2bis del plan de producción) ------------------------------
// APP_BASE_URL: dominio público del servidor (ej. https://sala.tu-dominio.uk), necesario para armar
// el link completo que va DENTRO del email ("hacé click acá para elegir una contraseña nueva") — a
// diferencia del resto de las rutas HTTP, que nunca necesitaron saber su propio dominio público
// (Cloudflare Tunnel lo resuelve del lado de afuera, el proceso Node nunca lo ve). Sin definirla, se
// cae a construir el link con el host que llega en la request (req.get('host')) — funciona en el caso
// común (un solo dominio), pero conviene fijarla explícita en producción si hay más de un dominio
// apuntando al mismo server, o para no depender de que el header Host no esté falseado.
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');

function baseUrlFor(req) {
  return APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// Token de reseteo: random, viaja UNA sola vez por email, en texto plano, como parte del link. Nunca
// se guarda así en la base — se guarda sha256(token) (ver createPasswordReset en lib/db.js), mismo
// principio que una contraseña (si se filtrara la tabla, el hash solo no alcanza para generar un link
// válido). No hace falta bcrypt acá: a diferencia de una contraseña elegida por una persona (espacio
// de valores chico, hay que hacerlo lento a propósito), este token sale de crypto.randomBytes (alta
// entropía) — un hash rápido ya es inviable de fuerza-brutear.
function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora — corto a propósito, es un link que viaja por email
const MAX_RESET_REQUESTS = 3;
const RESET_REQUEST_WINDOW_MS = 60 * 60 * 1000; // 1 hora

// Limitador propio y simple para /auth/forgot-password: no es un limitador de "intentos fallidos" como
// makeAttemptLimiter() (ahí "fallar" tiene sentido — contraseña incorrecta; acá CUALQUIER pedido, sea
// el email real de alguien o no, cuenta igual, porque la respuesta es siempre el mismo mensaje
// genérico y no hay forma de distinguir "correcto"/"incorrecto" del lado del cliente). Ventana
// deslizante simple, clave ip+email — igual que loginAuthLimiter: errar/probar con un email no gasta
// el cupo de otro email desde la misma IP, y no alcanza con cambiar de IP para reintentar con el mismo
// email sin límite.
const resetRequestTimestamps = new Map(); // key -> array de timestamps
function isResetRequestRateLimited(key) {
  const now = Date.now();
  const recent = (resetRequestTimestamps.get(key) || []).filter((t) => now - t < RESET_REQUEST_WINDOW_MS);
  if (recent.length >= MAX_RESET_REQUESTS) {
    resetRequestTimestamps.set(key, recent);
    return true;
  }
  recent.push(now);
  resetRequestTimestamps.set(key, recent);
  return false;
}

function requireDbEnabled(req, res, next) {
  if (!db.isEnabled()) {
    return res.status(404).json({ error: 'Las cuentas de usuario no están habilitadas en este servidor (falta configurar DATABASE_URL).' });
  }
  next();
}

// Mismo criterio de rate limiting que ya usa el proyecto (Fase 2.2: makeAttemptLimiter, 3 intentos →
// bloqueo 15 min) — clave = ip+email (no solo ip, como requireUploadAuth): así errar la contraseña de
// una cuenta no bloquea el intento de otra persona (u otra cuenta) desde la misma IP compartida, y
// tampoco alcanza con probar el mismo email desde IPs distintas para saltarse el límite.
const loginAuthLimiter = makeAttemptLimiter();

app.post('/auth/register', requireDbEnabled, async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    return res.status(400).json({ error: 'Faltan email y/o contraseña.' });
  }
  const trimmedEmail = email.trim();
  if (!EMAIL_REGEX.test(trimmedEmail)) {
    return res.status(400).json({ error: 'El email no tiene un formato válido.' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `La contraseña necesita al menos ${MIN_PASSWORD_LENGTH} caracteres.` });
  }
  try {
    const passwordHash = await hashPassword(password); // misma hashPassword() que ya usa el proyecto (bcrypt, Fase 2.1) para passwordHash de sala y LIBRARY_PASSWORD
    const user = await db.createUser(trimmedEmail, passwordHash);
    res.status(201).json({ id: user.id, email: user.email });
  } catch (err) {
    // '23505' = unique_violation de Postgres — el índice users_email_lower_idx (lib/db.js) es quien
    // realmente garantiza que no haya dos cuentas con el mismo email (no solo este chequeo aplicativo,
    // que además tiene una condición de carrera si dos registros llegan al mismo tiempo con el mismo
    // email — el índice de la base es la fuente de verdad última).
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email.' });
    }
    console.error('⚠️  Error registrando usuario:', err.message);
    res.status(500).json({ error: 'No se pudo completar el registro. Intentá de nuevo en un momento.' });
  }
});

app.post('/auth/login', requireDbEnabled, async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    return res.status(400).json({ error: 'Faltan email y/o contraseña.' });
  }
  const trimmedEmail = email.trim();
  const limiterKey = `${clientIp(req)}:${trimmedEmail.toLowerCase()}`;
  const lockedMinutes = loginAuthLimiter.lockedMinutes(limiterKey);
  if (lockedMinutes !== null) {
    return res.status(429).json({
      error: `Demasiados intentos fallidos. Esperá ${lockedMinutes} min y volvé a intentar.`,
      lockedMinutes
    });
  }

  try {
    const user = await db.findUserByEmail(trimmedEmail);
    // Mismo mensaje genérico tanto si el email no existe como si la contraseña es incorrecta —
    // distinguir "ese email no existe" de "esa contraseña está mal" le regala a un atacante una forma
    // barata de enumerar qué emails tienen cuenta registrada, probando uno por uno.
    if (!user) {
      loginAuthLimiter.recordFailure(limiterKey);
      return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    }

    const { valid } = await verifyPassword(password, user.password_hash);
    if (!valid) {
      const { locked } = loginAuthLimiter.recordFailure(limiterKey);
      if (locked) {
        return res.status(429).json({ error: 'Demasiados intentos fallidos. Esperá 15 min y volvé a intentar.' });
      }
      return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    }

    loginAuthLimiter.recordSuccess(limiterKey);

    // `regenerate()` en vez de escribir directo sobre req.session: crea un `sid` nuevo y descarta
    // cualquier sesión anónima previa asociada a la cookie que ya traía este navegador (si la había,
    // aunque hoy no se usa sesión para nada estando deslogueado) — mitiga session fixation (un
    // atacante que le hizo plantar a la víctima una cookie de sesión conocida de antemano no gana nada
    // con eso, porque el login siempre arranca un `sid` nuevo). Después de regenerate(), `req.session`
    // apunta a la sesión nueva (vacía) — recién ahí se le escribe el usuario logueado.
    req.session.regenerate((err) => {
      if (err) {
        console.error('⚠️  Error creando la sesión tras login:', err.message);
        return res.status(500).json({ error: 'No se pudo iniciar sesión. Intentá de nuevo en un momento.' });
      }
      req.session.userId = user.id;
      req.session.email = user.email;
      // save() explícito (en vez de confiar en que express-session guarde solo al final de la
      // response): así, si guardar en Redis falla, se entera este handler y responde 500 en vez de
      // devolver 200 con una cookie que en la práctica no quedó respaldada en el store.
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('⚠️  Error guardando la sesión tras login:', saveErr.message);
          return res.status(500).json({ error: 'No se pudo iniciar sesión. Intentá de nuevo en un momento.' });
        }
        res.json({ id: user.id, email: user.email });
      });
    });
  } catch (err) {
    console.error('⚠️  Error en login:', err.message);
    res.status(500).json({ error: 'No se pudo iniciar sesión. Intentá de nuevo en un momento.' });
  }
});

// Cierra la sesión actual (si había una) — borra la entrada en Redis (lib/sessionStore.js) y expira la
// cookie del lado del cliente. No exige estar logueado para llamarla (si no había sesión, `destroy()`
// simplemente no tiene nada que borrar); no depende de `requireDbEnabled` a propósito, para que
// siempre se pueda limpiar una cookie de sesión vieja aunque Postgres esté momentáneamente abajo.
app.post('/auth/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy((err) => {
    if (err) {
      console.error('⚠️  Error cerrando la sesión:', err.message);
      return res.status(500).json({ error: 'No se pudo cerrar la sesión. Intentá de nuevo en un momento.' });
    }
    res.clearCookie('movienight.sid');
    res.json({ ok: true });
  });
});

// Le permite al cliente (room.html, library.html, etc.) preguntar "¿hay alguien logueado ahora?" sin
// tener que guardar ese dato por su cuenta — la cookie httpOnly no se puede leer desde JS, así que
// esta es la única forma de que el frontend sepa el estado de la sesión.
app.get('/auth/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, id: req.session.userId, email: req.session.email });
});

// --- Recuperación de contraseña (Fase 2bis del plan de producción) ------------------------------
// Pide el reseteo: SIEMPRE responde el mismo mensaje genérico, exista o no una cuenta con ese email —
// mismo principio de no-enumeración que ya usa /auth/login (Fase 2bis, primer paso): decirle a quien
// pregunta "ese email no tiene cuenta" es regalarle una forma barata de averiguar qué emails están
// registrados, probando uno por uno.
app.post('/auth/forgot-password', requireDbEnabled, async (req, res) => {
  const { email } = req.body || {};
  if (typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'Falta el email.' });
  }
  const trimmedEmail = email.trim();
  const genericResponse = { ok: true, message: 'Si ese email tiene una cuenta registrada, te mandamos un link para elegir una contraseña nueva.' };

  const limiterKey = `${clientIp(req)}:${trimmedEmail.toLowerCase()}`;
  if (isResetRequestRateLimited(limiterKey)) {
    // Ojo: acá SÍ conviene devolver el mismo mensaje genérico (no un 429 explícito) — un 429 en este
    // endpoint puntual delataría "este email/IP ya pidió el máximo de veces", que ya es información de
    // más comparado con /auth/login (ahí el 429 no filtra si el email existe, porque el rate limit
    // corre por IP+email de la MISMA cuenta que ya se sabe que existe en ese punto del código).
    return res.json(genericResponse);
  }

  try {
    const user = await db.findUserByEmail(trimmedEmail);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(token);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await db.createPasswordReset(user.id, tokenHash, expiresAt);
      const resetUrl = `${baseUrlFor(req)}/reset-password.html?token=${token}`;
      try {
        await mailer.sendPasswordResetEmail(user.email, resetUrl);
      } catch (err) {
        // No se le devuelve el error a quien pidió el reseteo (seguiría siendo el mismo mensaje
        // genérico) — pero sí queda bien visible en los logs del server, porque acá el fallo es real
        // (Resend caído, API key mal puesta, etc.) y nadie más se va a enterar si no se loguea.
        console.error('⚠️  Error mandando el email de reseteo de contraseña:', err.message);
      }
    }
    res.json(genericResponse);
  } catch (err) {
    console.error('⚠️  Error en forgot-password:', err.message);
    // Mismo mensaje genérico incluso ante un error interno: no hay forma de distinguirlo desde afuera
    // de "no encontré ese email", y no tiene sentido filtrar detalle de un error de base de datos acá.
    res.json(genericResponse);
  }
});

// Confirma el reseteo: valida el token (existe, no venció) y cambia la contraseña. Invalida TODOS los
// pedidos de reseteo pendientes de esa cuenta al terminar (ver deletePasswordResetsForUser) — un link
// viejo no debe seguir sirviendo una vez que la contraseña ya cambió.
app.post('/auth/reset-password', requireDbEnabled, async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof token !== 'string' || !token.trim() || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Falta el token y/o la contraseña nueva.' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `La contraseña necesita al menos ${MIN_PASSWORD_LENGTH} caracteres.` });
  }
  try {
    const reset = await db.findValidPasswordReset(hashResetToken(token.trim()));
    if (!reset) {
      return res.status(400).json({ error: 'Ese link ya no es válido — puede haber vencido (dura 1 hora) o ya haberse usado. Pedí uno nuevo.' });
    }
    const passwordHash = await hashPassword(password);
    await db.updateUserPassword(reset.user_id, passwordHash);
    await db.deletePasswordResetsForUser(reset.user_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('⚠️  Error en reset-password:', err.message);
    res.status(500).json({ error: 'No se pudo cambiar la contraseña. Intentá de nuevo en un momento.' });
  }
});

// Salas — objeto en memoria del proceso, igual que antes de la Fase 1.1, PERO ahora respaldado en
// Redis (lib/roomStore.js): cada mutación relevante llama a roomStore.saveRoom(roomId, room) para
// que sobreviva a un reinicio del proceso, y al arrancar el server se repuebla desde ahí (ver
// startServer() al final del archivo). Seguir usando un objeto plano en memoria como fuente de
// verdad para LEER (en vez de ir a Redis en cada acceso) es a propósito: la lógica de sync de video/
// chat es sensible a latencia y corre por Socket.io en el mismo proceso, así que cada lectura sigue
// siendo síncrona; Redis solo entra de "escritura" para que el estado no se pierda si el proceso cae.
// roomId -> { videoFile, subtitleFile, viewers, hostToken, passwordHash,
//             mutedUserIds:Set<userId>, userNames:Map(socketId->name),
//             bufferingSockets:Set<socketId>, recentDisconnects:Map(userId->{timer,username}),
//             chatHistory:Array<msg> }
const rooms = {};

const CHAT_HISTORY_LIMIT = 50;

// Guarda un mensaje de chat (system o de usuario) en el historial de la sala, con tope de
// CHAT_HISTORY_LIMIT mensajes (se descarta el más viejo). Se llama junto a cada emit('chat-message',
// ...) para que el historial refleje exactamente lo que la gente ya vio en su pantalla. No reemplaza
// los emits en vivo — solo permite reconstruir el chat para quien se (re)conecta, ver 'chat-history'
// en join-room.
function pushChatHistory(room, msg) {
  room.chatHistory.push(msg);
  if (room.chatHistory.length > CHAT_HISTORY_LIMIT) room.chatHistory.shift();
}

// Rate limiting de flood en el chat (Fase 2.2 del plan de producción) — ventana deslizante simple:
// como mucho CHAT_RATE_LIMIT_MAX mensajes por cada CHAT_RATE_LIMIT_WINDOW_MS, por socket. Los valores
// dejan pasar cómodo un ida-y-vuelta normal de chat entre amigos (varios mensajes cortos seguidos)
// pero cortan un flood sostenido. Se guarda en el propio objeto `socket` (no en `room`) porque es un
// límite por conexión, no por sala — no tiene sentido persistirlo en Redis (se reinicia solo en cada
// reconexión, que es exactamente el comportamiento que queremos).
const CHAT_RATE_LIMIT_MAX = 8;
const CHAT_RATE_LIMIT_WINDOW_MS = 10 * 1000;

function isChatRateLimited(socket) {
  const now = Date.now();
  const recent = (socket._chatTimestamps || []).filter((t) => now - t < CHAT_RATE_LIMIT_WINDOW_MS);
  if (recent.length >= CHAT_RATE_LIMIT_MAX) {
    socket._chatTimestamps = recent; // no cuenta este intento bloqueado como uno más
    return true;
  }
  recent.push(now);
  socket._chatTimestamps = recent;
  return false;
}

function makeRoomId() { return crypto.randomBytes(3).toString('hex'); }

// --- Hashing de contraseñas (Fase 2.1 del plan de producción) -----------------------------------
// Antes (hasta la Fase 1) las contraseñas de sala y de biblioteca se guardaban con sha256 sin salt:
// rápido de calcular a propósito (es un hash de uso general, no pensado para contraseñas), lo que lo
// hace barato de atacar por fuerza bruta/diccionario si alguna vez se filtrara el hash. bcrypt es
// deliberadamente lento (controlable con BCRYPT_ROUNDS) y con salt integrado en el propio hash de
// salida, que es el estándar razonable hoy para esto.
//
// Se usa `bcryptjs` (implementación en JS puro) en vez del paquete `bcrypt` (con bindings nativos) a
// propósito: este proyecto se instala en VPS propios, Windows (ver Fase 1.3, probado ahí) y
// PaaS (Railway/Render/Fly.io) sin un paso de build propio — bindings nativos suman una dependencia
// de toolchain (Python/gcc) que puede fallar según la plataforma, mientras que bcryptjs es <10% más
// lento y no tiene ese riesgo. La interfaz (`hash`/`compareSync`) es la misma.
const BCRYPT_ROUNDS = 10;

function isBcryptHash(hash) {
  return typeof hash === 'string' && /^\$2[aby]\$\d{2}\$/.test(hash);
}
// Detecta un hash del esquema viejo (sha256 hex, 64 caracteres) para la migración transparente de
// abajo — ver hashPassword/verifyPassword.
function isLegacySha256Hash(hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash);
}
function legacySha256(pw) { return crypto.createHash('sha256').update(String(pw)).digest('hex'); }

// Hashea una contraseña nueva (sala al crearse, o LIBRARY_PASSWORD al arrancar) siempre con bcrypt —
// solo se llama con contraseñas nuevas, nunca para migrar una vieja (eso lo hace verifyPassword).
async function hashPassword(pw) {
  return bcrypt.hash(String(pw), BCRYPT_ROUNDS);
}

// Verifica una contraseña contra un hash guardado, que puede ser bcrypt (esquema nuevo) o sha256sin
// salt (esquema viejo, de la Fase 1 y anteriores — las salas creadas antes de este cambio quedaron
// con ese hash guardado en Redis). Plan de migración elegido (ver docs/PLAN-PRODUCCION.md, Fase 2.1):
// NO resetear contraseñas existentes al desplegar — en vez de eso, se detecta el algoritmo viejo, se
// valida con él, y si es válida se re-hashea con bcrypt para la próxima vez (needsRehash: true, el
// caller se encarga de persistir el hash nuevo). Así la migración es transparente para quien ya tenía
// una sala con contraseña: no nota nada, y con el uso normal (cada login exitoso) los hashes viejos
// van desapareciendo solos.
async function verifyPassword(pw, hash) {
  if (!hash) return { valid: !pw, needsRehash: false }; // sala/biblioteca sin contraseña configurada
  if (isBcryptHash(hash)) {
    return { valid: await bcrypt.compare(String(pw), hash), needsRehash: false };
  }
  if (isLegacySha256Hash(hash)) {
    const valid = legacySha256(pw) === hash;
    return { valid, needsRehash: valid }; // solo migrar si la contraseña vieja era correcta
  }
  // Hash con una forma que no reconocemos (dato corrupto/inesperado): tratarlo como no válido en vez
  // de tirar una excepción — más seguro que asumir cualquier otra cosa.
  return { valid: false, needsRehash: false };
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    const safeBase = base.replace(/[^a-zA-Z0-9 _\-]/g, '').trim().slice(0, 80) || 'video';
    cb(null, crypto.randomBytes(4).toString('hex') + '__' + safeBase + ext);
  }
});
// --- Cloudflare R2 — Fase 2: subida de video en streaming (sin tocar disco) --------------------
// Motor de storage de Multer alternativo al de disco local de arriba. Multer llama a _handleFile
// con `file.stream`, el stream crudo de esa parte del multipart mientras todavía está llegando por
// HTTP — en vez de escribirlo a disco (como hace el motor `storage` de arriba), lo empalmamos
// directo a `r2.uploadStream`, que lo sube a R2 en partes (multipart) a medida que llega. El archivo
// nunca toca el disco del host ni se carga entero en memoria en ningún punto del camino.
// El `PassThrough` intermedio solo cuenta bytes (para poder devolver `size`, igual que hace el motor
// de disco); no altera ni retiene los datos que pasan por él.
const r2VideoStorage = {
  _handleFile(req, file, cb) {
    const key = r2.makeObjectKey(file.originalname);
    let bytes = 0;
    const counter = new PassThrough();
    counter.on('data', (chunk) => { bytes += chunk.length; });
    file.stream.pipe(counter);
    r2.uploadStream(key, counter, file.mimetype)
      .then(() => cb(null, { key, size: bytes }))
      .catch((err) => cb(err));
  },
  // Multer llama esto para limpiar un archivo ya subido si algo más falla durante la misma request
  // (ej. otro archivo del mismo form, o un límite excedido detectado después). `file.key` es el campo
  // propio que devolvimos arriba en _handleFile (no es un campo estándar de Multer).
  _removeFile(req, file, cb) {
    if (!file.key) return cb(null);
    r2.deleteObject(file.key).then(() => cb(null)).catch(cb);
  }
};

// Se decide una sola vez al arrancar el server (según las variables de entorno ya cargadas por
// loadDotEnv arriba): si R2 está configurado, TODAS las subidas de video van a R2, no hay mezcla por
// request. Ver sección "Cloudflare R2 — Fase 2" en docs/historico/MEMORIA.md para el porqué de este modo dual.
const videoStorage = r2.isR2Enabled() ? r2VideoStorage : storage;
const upload = multer({ storage: videoStorage, limits: { fileSize: 8 * 1024 * 1024 * 1024 } });

// A partir del `req.file` que deja Multer (con cualquiera de los dos motores de arriba), arma la URL
// que se guarda en `room.videoFile` y se manda tal cual al cliente (`room.html` hace
// `player.src = videoFile` directo, ver 'room-data'/'video-changed') — por eso puede ser tanto una
// ruta local ('/uploads/archivo.mp4') como una URL absoluta de R2, sin que el cliente necesite saber
// cuál de las dos es.
function videoUrlForUploadedFile(file) {
  return r2.isR2Enabled() ? r2.getPublicUrl(file.key) : '/uploads/' + file.filename;
}

// Subtítulos: se leen en memoria para poder convertir .srt -> .vtt antes de guardar
const subtitleUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v'];

// Convierte "abc123__Mi Pelicula.mp4" -> "Mi Pelicula.mp4" para mostrar en la biblioteca.
// Los archivos subidos antes de este cambio no tienen el separador "__", se muestran con su nombre tal cual (el hash).
function displayNameFor(filename) {
  const idx = filename.indexOf('__');
  return idx >= 0 ? filename.slice(idx + 2) : filename;
}

// Igual que displayNameFor pero a partir de room.videoFile ('/uploads/archivo.mp4' -> 'archivo.mp4' ->
// nombre legible). Se usa para los mensajes de chat de "cinta cargada"/"cambiaron la cinta".
function videoDisplayName(videoFile) {
  return displayNameFor(path.basename(videoFile));
}

// --- Cloudflare R2 — Fase 3: validar un filename/key que llega del cliente ----------------------
// Antes (`isValidUploadFilename`, hasta V16) esto era síncrono y solo miraba disco local
// (`fs.existsSync`). Ahora, en modo R2, el "filename" que manda `library.html` es en realidad la key
// del objeto en el bucket (ver `r2.makeObjectKey`), así que hace falta una versión async que
// pregunte a R2 en vez de al filesystem — de ahí el `await` en las 4 rutas que la usan.
// El chequeo de path traversal (basename + sin "..") se mantiene en los dos modos: en disco evita
// escapar de UPLOAD_DIR; en R2 el bucket no tiene "carpetas" reales, pero una key con "../" en el
// medio seguiría siendo una key válida y confusa (ej. en un listado), así que se rechaza igual.
async function isValidUploadReference(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename !== path.basename(filename)) return false;
  if (filename.includes('..')) return false;
  if (r2.isR2Enabled()) return r2.objectExists(filename);
  return fs.existsSync(path.join(UPLOAD_DIR, filename));
}

// Arma la URL que se guarda en room.videoFile a partir de un filename/key ya validado por
// isValidUploadReference — mismo criterio que videoUrlForUploadedFile (arriba) pero para el caso de
// "reutilizar una cinta ya subida" en vez de "subida nueva".
function videoUrlForExistingFile(filename) {
  return r2.isR2Enabled() ? r2.getPublicUrl(filename) : '/uploads/' + filename;
}

// Conversión mínima SRT -> WebVTT: agrega cabecera y cambia el separador decimal de coma a punto en los timestamps.
function srtToVtt(content) {
  const body = content.replace(/\r+/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + body.trim() + '\n';
}

// `ownerUserId`: id de la cuenta (tabla `users`, lib/db.js) que creó la sala, o `null` si se creó sin
// sesión iniciada (sigue siendo el caso más común hoy, ya que todavía no hay UI de login — ver
// docs/PLAN-PRODUCCION.md). Es el campo nuevo de la "migración del rol de host": cuando está seteado,
// `isRoomOwner()` (más abajo) deja de confiar en `hostToken` para esta sala y exige que la sesión
// autenticada coincida — `hostToken` se sigue generando y devolviendo igual para toda sala (no rompe
// al cliente actual, que siempre lo guarda en localStorage), pero para una sala con dueño ya no
// alcanza por sí solo para probar "soy el host".
async function makeRoom(videoFile, password, ownerUserId = null) {
  return {
    videoFile,
    subtitleFile: null,
    viewers: 0,
    hostToken: crypto.randomBytes(16).toString('hex'),
    hostSocketId: null, // socket.id del host actual (única fuente de verdad; ver setHost más abajo)
    ownerUserId: ownerUserId || null,
    passwordHash: password ? await hashPassword(password) : null,
    mutedUserIds: new Set(),
    userNames: new Map(),
    bufferingSockets: new Set(),
    recentDisconnects: new Map(),
    initialVideoAnnounced: false, // ver join-room: anuncia la cinta con la que se creó la sala una sola vez
    chatHistory: [], // últimos CHAT_HISTORY_LIMIT mensajes de chat (system y de usuario), ver pushChatHistory
    // lastActivity (Fase 2.6 del plan de producción): timestamp de la última vez que hubo actividad
    // real en la sala — lo mantiene al día roomStore.saveRoom() en cada guardado (ver ese archivo). Se
    // inicializa acá por prolijidad (el primer saveRoom(), inmediato después de crear la sala en los
    // dos call sites de más abajo, lo va a pisar de todos modos con el mismo valor).
    lastActivity: Date.now(),
    // Última posición conocida del video (V18 — fix: sin esto, cualquiera que se conectaba o
    // reconectaba arrancaba SIEMPRE en el segundo 0, porque 'room-data' solo mandaba el archivo,
    // nunca el minuto. A un espectador normal lo corregía el próximo heartbeat del host (parpadeo de
    // ~4s), pero si quien se reconectaba recuperaba el host (por el hostToken guardado en su
    // localStorage), nadie lo corregía a él — se quedaba en 0 en serio, y al tocar play eso se
    // propagaba a toda la sala vía 'sync'. Se actualiza en cada 'sync' que manda el host (play/
    // pause/seek/heartbeat) y se manda de vuelta en 'room-data' a quien se conecta.
    videoPosition: { time: 0, paused: true }
  };
}

// --- Cloudflare R2 — Fase 2.7: subida directa desde el navegador (URL prefirmada) ---------------
// Motivo: subir un video real vía /create-room (multipart, pasa por el server) falla en producción
// real con `413 Payload Too Large` de Cloudflare — el proxy corta el request antes de que llegue a
// Node, independiente de cualquier límite de Multer/Express (hallazgo bloqueante documentado en
// docs/PLAN-PRODUCCION.md, Fase 2.7). Esta ruta resuelve el paso 1 del camino elegido: el cliente pide
// acá una URL prefirmada, sube el archivo DIRECTO a R2 con esa URL (sin pasar por este server en
// absoluto, así que el límite de Cloudflare deja de aplicar), y recién después confirma la sala con
// `POST /create-room-from-upload` o `POST /room/:id/change-video-from-upload` (ninguna de las dos
// rutas es nueva — ya sabían recibir la key de un archivo ya presente en el bucket, solo que hasta
// ahora esa key siempre venía de una subida hecha por ESTE server).
// Solo tiene sentido en modo R2 — en modo disco local (sin R2 configurado) no hay a dónde apuntar una
// URL prefirmada de S3, así que esta ruta devuelve 404 explícito y el cliente sigue con el flujo viejo
// (multipart directo a /create-room), que en modo disco sigue funcionando igual que siempre (con el
// mismo límite de Cloudflare si se comparte por Tunnel — ver Fase 2.7 en el plan, "modo disco local
// queda limitado a videos chicos" es una limitación conocida, no algo que esta ruta resuelva).
// Reusa exactamente el mismo gate que ya protegía la subida (`requireUploadAuth`): sesión de cuenta
// real, o la LIBRARY_PASSWORD compartida con el mismo límite de intentos — pedir una URL prefirmada
// tiene el mismo costo potencial (alguien podría generar URLs y llenar el bucket) que subir un archivo
// directo, así que amerita el mismo control.
const R2_PRESIGN_EXPIRES_SECONDS = parseInt(process.env.R2_PRESIGN_EXPIRES_SECONDS, 10) || 6 * 60 * 60; // 6h default: la subida real puede tardar bastante más que el default típico de una URL prefirmada si la conexión de quien sube es lenta (es un video de varios GB)

// --- Límite de storage de la biblioteca (Fase 2.6 del plan de producción) ------------------------
// Sin esto, con cuentas reales ya en pie (Fase 2bis) cualquiera con cuenta puede seguir subiendo
// videos sin límite y el costo de R2 (o el disco del VPS) crece sin control. Los dos límites son
// opcionales e independientes (0 = sin límite, el default): cantidad de videos y tamaño total en GB.
// Se chequean ANTES de aceptar una subida nueva (no en /create-room-from-upload ni
// /room/:id/change-video-from-upload, que reusan un archivo YA en la biblioteca — no suman nada
// nuevo, así que no tiene sentido bloquearlos acá).
const MAX_LIBRARY_VIDEOS = parseInt(process.env.MAX_LIBRARY_VIDEOS, 10) || 0;
const MAX_LIBRARY_SIZE_GB = parseFloat(process.env.MAX_LIBRARY_SIZE_GB) || 0;

async function checkStorageLimits(req, res, next) {
  if (!MAX_LIBRARY_VIDEOS && !MAX_LIBRARY_SIZE_GB) return next(); // sin límites configurados: no hace falta listar nada
  try {
    let videos;
    if (r2.isR2Enabled()) {
      videos = (await r2.listObjects()).filter(o => VIDEO_EXTENSIONS.includes(path.extname(o.filename).toLowerCase()));
    } else {
      const files = fs.readdirSync(UPLOAD_DIR).filter(f => VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()));
      videos = files.map(f => ({ size: fs.statSync(path.join(UPLOAD_DIR, f)).size }));
    }
    if (MAX_LIBRARY_VIDEOS && videos.length >= MAX_LIBRARY_VIDEOS) {
      return res.status(413).json({ error: `La biblioteca llegó al límite de ${MAX_LIBRARY_VIDEOS} video(s). Borrá alguno desde /library.html antes de subir uno nuevo.` });
    }
    if (MAX_LIBRARY_SIZE_GB) {
      const totalGB = videos.reduce((sum, o) => sum + o.size, 0) / (1024 ** 3);
      if (totalGB >= MAX_LIBRARY_SIZE_GB) {
        return res.status(413).json({ error: `La biblioteca llegó al límite de almacenamiento (${MAX_LIBRARY_SIZE_GB}GB). Borrá algún video desde /library.html antes de subir uno nuevo.` });
      }
    }
    next();
  } catch (err) {
    // Falla "abierta" a propósito: esto es un límite de costo, no de seguridad — un error listando la
    // biblioteca (ej. R2 momentáneamente lento) no debería bloquear una subida legítima.
    console.error('⚠️  Error chequeando límites de storage de la biblioteca (se deja pasar la subida):', err.message);
    next();
  }
}
app.post('/api/uploads/presign', requireUploadAuth, checkStorageLimits, async (req, res) => {
  if (!r2.isR2Enabled()) {
    return res.status(404).json({ error: 'La subida directa no está disponible: este servidor no tiene Cloudflare R2 configurado. Subí el video de la forma habitual.' });
  }
  const { filename, contentType } = req.body || {};
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'Falta el nombre del archivo.' });
  }
  try {
    const key = r2.makeObjectKey(filename);
    const uploadUrl = await r2.getPresignedUploadUrl(key, contentType, R2_PRESIGN_EXPIRES_SECONDS);
    res.json({ key, uploadUrl, expiresIn: R2_PRESIGN_EXPIRES_SECONDS });
  } catch (err) {
    console.error('Error generando URL prefirmada de R2:', err.message);
    res.status(502).json({ error: 'No se pudo preparar la subida directa a Cloudflare R2 (revisá credenciales/conexión).' });
  }
});

app.post('/create-room', requireUploadAuth, checkStorageLimits, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No llegó ningún video' });
  const roomId = makeRoomId();
  // Si quien crea la sala tiene una sesión iniciada (Fase 2bis), la sala queda "con dueño" desde el
  // arranque — ver isRoomOwner() más arriba. Si no hay sesión (todavía no hay UI de login, o la
  // persona no inició sesión), ownerUserId queda null y la sala sigue el esquema anónimo de siempre.
  const ownerUserId = (req.session && req.session.userId) || null;
  const room = await makeRoom(videoUrlForUploadedFile(req.file), (req.body.password || '').trim(), ownerUserId);
  rooms[roomId] = room;
  // Se espera a que la sala quede guardada en Redis antes de responder con el roomId/hostToken: si
  // el proceso se cayera justo entre responder y persistir, la sala existiría para el creador (que
  // ya tiene el link) pero no sobreviviría a un reinicio — mejor la request tarda un poco más.
  await roomStore.saveRoom(roomId, room);
  res.json({ roomId, hostToken: room.hostToken });
});

// --- Fase 2bis, "quién puede crear salas" (2026-09-06) -------------------------------------------
// Decisión: por ahora sigue siendo la MISMA regla que ya usaba /create-room — conocer la
// LIBRARY_PASSWORD compartida, no hace falta cuenta registrada ni verificación de email. Con
// cuentas reales ya en pie (Fase 2bis) se evaluó exigir sesión iniciada para crear salas, pero
// todavía no hay UI de login (ver docs/PLAN-PRODUCCION.md, Fase 0) — exigir cuenta hoy dejaría a
// todo el grupo de amigos actual sin poder crear salas. La contraseña compartida sigue alcanzando
// para el caso de uso actual (grupo controlado); revisar esta decisión si/cuando haya UI de login y
// se quiera cerrar del todo el modo anónimo. Verificación de email adicional se descarta por ahora:
// sería sobre-ingeniería para un grupo que ya comparte una contraseña de por sí.
// Se encontró de paso (2026-09-06) que ESTA ruta específica no tenía ningún gate — a diferencia de
// /create-room, que sí exige requireUploadAuth. Reusar una cinta ya subida no evita el mismo costo
// de que cualquiera con el link cree salas sin límite (aunque no suba nada nuevo, cada sala ocupa
// memoria/Redis) — se corrige acá para que las dos formas de crear una sala pidan la misma
// contraseña. El cliente (library.html) ya la maneja vía mnLibraryFetch, que reintenta con el
// prompt correspondiente ante un 401.
app.post('/create-room-from-upload', requireUploadAuth, async (req, res) => {
  try {
    const { filename, password } = req.body || {};
    if (!(await isValidUploadReference(filename))) return res.status(400).json({ error: 'Ese archivo no existe' });
    const roomId = makeRoomId();
    // Mismo criterio que /create-room: si hay sesión iniciada, la sala queda "con dueño" (ver
    // isRoomOwner()); si no, sigue el esquema anónimo de hostToken de siempre.
    const ownerUserId = (req.session && req.session.userId) || null;
    const room = await makeRoom(videoUrlForExistingFile(filename), (password || '').trim(), ownerUserId);
    rooms[roomId] = room;
    await roomStore.saveRoom(roomId, room);
    res.json({ roomId, hostToken: room.hostToken });
  } catch (err) {
    console.error('Error creando sala desde biblioteca (R2):', err.message);
    res.status(502).json({ error: 'No se pudo consultar Cloudflare R2 (revisa credenciales/conexión).' });
  }
});

app.post('/room/:id/change-video', requireUploadAuth, checkStorageLimits, upload.single('video'), async (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Sala no existe' });
  // Fase 2bis, "migración del rol de host": si la sala tiene dueño (room.ownerUserId), solo la sesión
  // de esa cuenta autoriza esto — un hostToken de localStorage ya no alcanza (ver isRoomOwner()).
  if (!isRoomOwner(room, { hostToken: req.body.hostToken, sessionUserId: req.session && req.session.userId })) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  if (!req.file) return res.status(400).json({ error: 'No llegó ningún video' });
  room.videoFile = videoUrlForUploadedFile(req.file);
  room.videoPosition = { time: 0, paused: true }; // cinta nueva: arranca de 0, no de donde iba la anterior
  const changedMsg = { system: true, text: `📼 Cambiaron la cinta: ${videoDisplayName(room.videoFile)}` };
  pushChatHistory(room, changedMsg);
  io.to(req.params.id).emit('chat-message', changedMsg);
  io.to(req.params.id).emit('video-changed', { videoFile: room.videoFile });
  await roomStore.saveRoom(req.params.id, room);
  res.json({ ok: true });
});

// Cambiar la cinta de una sala ya existente reutilizando un video de la biblioteca (sin resubir nada)
app.post('/room/:id/change-video-from-upload', async (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Sala no existe' });
  const { filename, hostToken } = req.body || {};
  // Fase 2bis, "migración del rol de host": mismo criterio que change-video (ver isRoomOwner()).
  if (!isRoomOwner(room, { hostToken, sessionUserId: req.session && req.session.userId })) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  try {
    if (!(await isValidUploadReference(filename))) return res.status(400).json({ error: 'Ese archivo no existe' });
  } catch (err) {
    console.error('Error validando cinta de biblioteca (R2):', err.message);
    return res.status(502).json({ error: 'No se pudo consultar Cloudflare R2 (revisa credenciales/conexión).' });
  }
  room.videoFile = videoUrlForExistingFile(filename);
  room.videoPosition = { time: 0, paused: true }; // cinta nueva: arranca de 0, no de donde iba la anterior
  const changedMsg = { system: true, text: `📼 Cambiaron la cinta: ${videoDisplayName(room.videoFile)}` };
  pushChatHistory(room, changedMsg);
  io.to(req.params.id).emit('chat-message', changedMsg);
  io.to(req.params.id).emit('video-changed', { videoFile: room.videoFile });
  await roomStore.saveRoom(req.params.id, room);
  res.json({ ok: true });
});

// Subir subtítulos (.srt o .vtt) para la sala activa
app.post('/room/:id/upload-subtitle', subtitleUpload.single('subtitle'), (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Sala no existe' });
  // Fase 2bis, "migración del rol de host": mismo criterio que change-video (ver isRoomOwner()).
  if (!isRoomOwner(room, { hostToken: req.body.hostToken, sessionUserId: req.session && req.session.userId })) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  if (!req.file) return res.status(400).json({ error: 'No llegó ningún archivo' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!['.srt', '.vtt'].includes(ext)) return res.status(400).json({ error: 'Solo se aceptan archivos .srt o .vtt' });

  let text = req.file.buffer.toString('utf8');
  text = ext === '.srt' ? srtToVtt(text) : (text.trim().startsWith('WEBVTT') ? text : 'WEBVTT\n\n' + text);

  const filename = crypto.randomBytes(4).toString('hex') + '.vtt';
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), text, 'utf8');

  if (room.subtitleFile) {
    const oldPath = path.join(UPLOAD_DIR, path.basename(room.subtitleFile));
    fs.unlink(oldPath, () => {}); // borra el subtítulo anterior de esta sala (best-effort)
  }

  room.subtitleFile = '/uploads/' + filename;
  io.to(req.params.id).emit('subtitle-changed', { subtitleFile: room.subtitleFile });
  roomStore.saveRoom(req.params.id, room); // fire-and-forget: no bloquea la respuesta por un round-trip a Redis
  res.json({ ok: true, subtitleFile: room.subtitleFile });
});

app.get('/room/:id', (req, res) => {
  if (!rooms[req.params.id]) return res.status(404).send('Esa sala no existe (o ya se cerró).');
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// --- Healthcheck (Fase 1.5 del plan de producción) ------------------------------------------------
// Pensado para que el hosting/orquestador (PM2, Railway/Render/Fly.io, un load balancer, lo que sea)
// sepa cuándo reiniciar el proceso — no alcanza con "el proceso Node responde": el server puede estar
// arriba y aceptando conexiones y aun así ser inútil si Redis (persistencia de salas, Fase 1.1) o R2
// (donde viven los videos, si está configurado) dejaron de responder. Se registra ANTES que
// `gracefulShutdown` (ver el final del archivo) porque `shuttingDown` se declara ahí abajo con
// `let` — la referencia de la clausura se resuelve recién cuando llega una request real, momento en
// el que el módulo entero ya terminó de cargar, así que el orden de declaración no importa acá.
//
// Cada dependencia habilitada se chequea con un timeout corto (no queremos que un Redis/R2 colgado
// deje la respuesta del healthcheck colgada también — un healthcheck que nunca responde es en la
// práctica indistinguible de uno que devuelve "no estoy sano", pero peor: bloquea al orquestador).
const HEALTH_CHECK_TIMEOUT_MS = 3000;
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout de ${ms}ms esperando a ${label}`)), ms))
  ]);
}

app.get(['/health', '/healthz'], async (req, res) => {
  // Durante un graceful shutdown en curso (Fase 1.4) ya se dejaron de aceptar conexiones nuevas
  // (`server.close()`), así que en la práctica esta rama casi no se llega a ejecutar — queda como
  // red de seguridad para alguna request que ya estaba en camino cuando arrancó el shutdown.
  if (shuttingDown) {
    return res.status(503).json({ status: 'shutting_down', uptime: process.uptime() });
  }

  const checks = {};
  let healthy = true;

  if (roomStore.isEnabled()) {
    try {
      const result = await withTimeout(roomStore.ping(), HEALTH_CHECK_TIMEOUT_MS, 'Redis');
      checks.redis = result;
      if (!result.ok) healthy = false;
    } catch (err) {
      checks.redis = { enabled: true, ok: false, error: err.message };
      healthy = false;
    }
  } else {
    // DISABLE_REDIS=1: escape hatch solo de desarrollo local (ver lib/roomStore.js) — no cuenta
    // como una falla del healthcheck, pero se reporta igual para que quede visible en qué modo
    // está corriendo el proceso.
    checks.redis = { enabled: false, ok: true };
  }

  if (r2.isR2Enabled()) {
    try {
      await withTimeout(r2.testConnection(), HEALTH_CHECK_TIMEOUT_MS, 'R2');
      checks.r2 = { enabled: true, ok: true };
    } catch (err) {
      checks.r2 = { enabled: true, ok: false, error: err.message };
      healthy = false;
    }
  } else {
    // R2 no configurado es un modo válido (se sube a disco local, ver README) — no es una falla.
    checks.r2 = { enabled: false, ok: true };
  }

  if (db.isEnabled()) {
    try {
      const result = await withTimeout(db.ping(), HEALTH_CHECK_TIMEOUT_MS, 'Postgres');
      checks.postgres = result;
      if (!result.ok) healthy = false;
    } catch (err) {
      checks.postgres = { enabled: true, ok: false, error: err.message };
      healthy = false;
    }
  } else {
    // DATABASE_URL no configurada: modo válido (cuentas de usuario deshabilitadas, ver requireDbEnabled) — no es una falla.
    checks.postgres = { enabled: false, ok: true };
  }

  // Resend no tiene un chequeo de "está vivo" barato sin mandar un email de prueba de verdad (no vale
  // la pena hacerlo en cada consulta al healthcheck) — acá solo se reporta si está configurado o no,
  // igual que se hace con R2/Postgres cuando no aplican; nunca cuenta como una falla del healthcheck.
  checks.email = { enabled: mailer.isEnabled(), ok: true };

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'error',
    uptime: process.uptime(),
    checks
  });
});

// Solo confirma existencia y si pide contraseña. videoFile/subtitleFile viajan por socket tras un join válido,
// para no exponer la ubicación real del archivo antes de validar la contraseña.
app.get('/api/room/:id', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'not found' });
  res.json({ passwordProtected: !!room.passwordHash });
});

// --- Biblioteca de cintas: videos ya subidos en public/uploads ---

// --- Cloudflare R2 — Fase 3: la biblioteca lista/borra del bucket cuando R2 está activo ---------
// Mismo shape de respuesta en los dos modos (filename, displayName, size, mtime) — ver el comentario
// de listObjects() en lib/r2.js — por eso no hace falta tocar nada de public/library.html: para el
// cliente es indistinguible si el `filename` que recibe es un nombre de archivo en disco o una key
// de R2, lo trata como un identificador opaco que después reenvía tal cual a las otras rutas.
app.get('/api/uploads', requireLibraryAuth, async (req, res) => {
  if (r2.isR2Enabled()) {
    try {
      const objects = await r2.listObjects();
      const list = objects
        .filter(o => VIDEO_EXTENSIONS.includes(path.extname(o.filename).toLowerCase()))
        .map(o => ({ filename: o.filename, displayName: displayNameFor(o.filename), size: o.size, mtime: o.mtime }))
        .sort((a, b) => b.mtime - a.mtime);
      return res.json(list);
    } catch (err) {
      console.error('Error listando la biblioteca en Cloudflare R2:', err.message);
      return res.status(502).json({ error: 'No se pudo listar la biblioteca de Cloudflare R2 (revisa credenciales/conexión).' });
    }
  }
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: 'No se pudo leer la carpeta de uploads' });
    const list = files
      .filter(f => VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()))
      .map(f => {
        const stat = fs.statSync(path.join(UPLOAD_DIR, f));
        return { filename: f, displayName: displayNameFor(f), size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json(list);
  });
});

app.delete('/api/uploads/:filename', requireLibraryAuth, async (req, res) => {
  const { filename } = req.params;
  try {
    if (!(await isValidUploadReference(filename))) return res.status(400).json({ error: 'Ese archivo no existe' });
  } catch (err) {
    console.error('Error validando cinta antes de borrar (R2):', err.message);
    return res.status(502).json({ error: 'No se pudo consultar Cloudflare R2 (revisa credenciales/conexión).' });
  }
  if (r2.isR2Enabled()) {
    try {
      await r2.deleteObject(filename);
      return res.json({ ok: true });
    } catch (err) {
      console.error('Error borrando de Cloudflare R2:', err.message);
      return res.status(502).json({ error: 'No se pudo borrar el archivo de Cloudflare R2.' });
    }
  }
  fs.unlink(path.join(UPLOAD_DIR, filename), (err) => {
    if (err) return res.status(500).json({ error: 'No se pudo borrar el archivo' });
    res.json({ ok: true });
  });
});

// --- Cloudflare R2 — Fase 2: errores de subida como JSON, no como página HTML de Express --------
// Sin esto, un archivo que supera el límite de Multer, o un fallo de R2 a mitad de subida (credenciales
// mal puestas, bucket inexistente, conexión caída), tira un error sin manejar que Express devuelve
// como su página de error HTML por defecto — rompe el `xhr.onload`/`JSON.parse` del cliente (ver
// index.html/library.html), que espera siempre JSON de estas rutas. Tiene que ir después de todas las
// rutas que usan `upload.single('video')` para poder atrapar sus errores (así funciona Express).
app.use((err, req, res, next) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el límite permitido (8GB).' : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error('Error subiendo video:', err.message);
  const msg = r2.isR2Enabled()
    ? 'No se pudo subir el video a Cloudflare R2 (revisa credenciales/conexión en el .env).'
    : 'No se pudo guardar el video.';
  res.status(502).json({ error: msg });
});

function broadcastViewerList(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const sockets = io.sockets.adapter.rooms.get(roomId);
  if (!sockets) return;
  const list = [...sockets].map(id => {
    const s = io.sockets.sockets.get(id);
    return {
      id,
      username: room.userNames.get(id) || 'Anónimo',
      isHost: !!s.isHost,
      muted: room.mutedUserIds.has(s.userId),
      buffering: room.bufferingSockets.has(id)
    };
  });
  io.to(roomId).emit('viewer-list', list);
}

// --- "Migración del rol de host" (Fase 2bis del plan de producción) ------------------------------
// Punto único que decide "¿esta persona puede probar que es la dueña de esta sala?", usado tanto
// desde rutas HTTP (change-video, upload-subtitle, etc.) como desde 'join-room' (Socket.io) — antes
// cada lugar comparaba `hostToken` directo contra `room.hostToken` por su cuenta.
//   - Sala con dueño (`room.ownerUserId` seteado, porque se creó con una sesión iniciada): el ÚNICO
//     criterio válido es que la sesión actual tenga ese mismo `userId` — un `hostToken` de
//     `localStorage`, aunque coincida, ya NO alcanza. Esto es justo lo que cierra el riesgo anotado en
//     docs/MEMORIA.md ("`hostToken` sin expiración, viaja en texto plano"): la sesión vive en una
//     cookie `httpOnly` (no accesible desde JS/XSS) y es revocable al toque (`POST /auth/logout`),
//     algo que un `hostToken` en `localStorage` nunca ofreció.
//   - Sala sin dueño (`room.ownerUserId` es `null` — sigue siendo el caso normal hoy, no hay UI de
//     login todavía): se mantiene el esquema de siempre, `hostToken` contra `room.hostToken`, sin
//     ningún cambio de comportamiento para quien no usa cuentas.
// Nunca se combinan los dos criterios para una misma sala: si tiene dueño, un `hostToken` que hubiera
// quedado dando vueltas (ej. compartido sin querer) no sirve para nada.
function isRoomOwner(room, { hostToken, sessionUserId } = {}) {
  if (room.ownerUserId) {
    return !!sessionUserId && sessionUserId === room.ownerUserId;
  }
  return !!hostToken && hostToken === room.hostToken;
}

const RECONNECT_GRACE_MS = 15000;

// Único punto por donde una sala cambia de host. Garantiza que nunca haya más de un socket con
// isHost=true a la vez: si ya había un host distinto (conectado), lo degrada primero (y se lo avisa,
// para que su UI de host desaparezca) antes de promover al nuevo. Sin esto, un socket viejo con un
// hostToken todavía válido en localStorage podía "recuperar" el host sin quitárselo a quien ya lo
// tenía (traspaso automático o manual) — quedaban 2, o más, hosts simultáneos.
function setHost(room, roomId, socket) {
  if (room.hostSocketId && room.hostSocketId !== socket.id) {
    const prevHost = io.sockets.sockets.get(room.hostSocketId);
    if (prevHost) {
      prevHost.isHost = false;
      prevHost.emit('host-status', { isHost: false, hostToken: null });
    }
  }
  room.hostSocketId = socket.id;
  socket.isHost = true;
  socket.emit('host-status', { isHost: true, hostToken: room.hostToken });
}

// Envuelve un handler de evento de socket en try/catch (Fase 1.2 del plan de producción). Antes de
// esto, un error dentro de cualquier handler (ej. un mensaje malformado que rompe alguna asunción del
// código) se propagaba como excepción no capturada y tiraba abajo el proceso entero — con él, TODAS
// las salas activas, no solo la conexión que disparó el error. Con el wrapper, el error queda
// contenido a esa única invocación: se loguea (con el nombre del evento y el roomId, para poder
// rastrearlo) y el resto del servidor sigue funcionando con normalidad.
function safeSocketHandler(eventName, handler) {
  return function (...args) {
    const logError = (err) => {
      // `this` es el socket que disparó el evento (así es como Socket.io invoca los listeners) —
      // socket.id siempre está disponible; username puede no estarlo todavía si el error pasa antes
      // del join-room exitoso.
      console.error(`⚠️  Error en el handler de socket '${eventName}' (socket.id: ${this.id}, username: ${this.username || 'sin asignar'}):`, err);
    };
    try {
      // Fase 2.1 del plan de producción: 'join-room' ahora verifica la contraseña con bcrypt
      // (async), así que el handler puede devolver una Promise — si esa Promise rechaza (ej. un
      // error de bcrypt), sin este .catch se perdía como una unhandledRejection silenciosa en vez
      // de loguearse con el mismo detalle (eventName, socket.id) que un error síncrono.
      const result = handler.apply(this, args);
      if (result && typeof result.catch === 'function') result.catch(logError);
    } catch (err) {
      logError(err);
    }
  };
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', safeSocketHandler('join-room', async ({ roomId, username, hostToken, userId, password }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('room-error', 'La sala no existe.'); return; }

    // Rate limiting de intentos de contraseña (Fase 2.2 del plan de producción) — antes 'join-room'
    // no tenía ningún límite, a diferencia de requireUploadAuth (V19). Clave = ip + roomId (no solo
    // ip, como en requireUploadAuth): ahí tiene sentido una sola clave global porque hay una única
    // LIBRARY_PASSWORD para todo el server, pero acá cada sala tiene su propia contraseña — bloquear
    // por ip sola dejaría que errar la contraseña de UNA sala te saque también de intentar entrar a
    // CUALQUIER otra sala con esa misma IP (ej. varios amigos en la misma red/NAT).
    const attemptKey = `${socketClientIp(socket)}:${roomId}`;
    if (room.passwordHash) {
      const lockedMinutes = roomJoinAuthLimiter.lockedMinutes(attemptKey);
      if (lockedMinutes !== null) {
        socket.emit('room-error', `Demasiados intentos fallidos. Esperá ${lockedMinutes} min y volvé a intentar.`);
        return;
      }

      // verifyPassword (Fase 2.1) reconoce tanto hashes nuevos (bcrypt) como viejos (sha256, de
      // salas creadas antes de esta migración) — needsRehash indica que matcheó con el esquema
      // viejo, así que se re-hashea con bcrypt y se persiste, sin que quien se conecta note nada.
      const { valid, needsRehash } = await verifyPassword(password || '', room.passwordHash);
      if (!valid) {
        const { locked, attemptsLeft } = roomJoinAuthLimiter.recordFailure(attemptKey);
        socket.emit('room-error', locked
          ? 'Contraseña incorrecta. Se bloquearon los intentos por 15 minutos.'
          : `Contraseña incorrecta. Te quedan ${attemptsLeft} intento(s).`);
        return;
      }
      roomJoinAuthLimiter.recordSuccess(attemptKey);
      if (needsRehash) {
        room.passwordHash = await hashPassword(password || '');
        roomStore.saveRoom(roomId, room); // fire-and-forget, igual que el resto de los saves de esta sala
      }
    }

    currentRoom = roomId;
    socket.username = (username || 'Anónimo').slice(0, 40);
    socket.userId = userId || socket.id;
    socket.join(roomId);

    room.userNames.set(socket.id, socket.username);
    room.viewers++;

    const wasMuted = room.mutedUserIds.has(socket.userId);

    // Le manda el historial de chat guardado hasta ahora (antes de agregarle los mensajes propios de
    // este join, que van a llegarle en vivo más abajo igual que a todos, ya que recién se unió a la
    // sala vía socket.join). Así el chat sobrevive a recargas de página (ej. el host al volver de
    // "cambiar cinta", que navega a library.html y de vuelta — antes se le vaciaba el chat entero).
    socket.emit('chat-history', room.chatHistory);

    // Anuncia la cinta con la que se creó la sala, una sola vez (al primer join, normalmente el host
    // recién llegado de crear la sala). Los cambios posteriores de cinta ya avisan por su cuenta desde
    // change-video/change-video-from-upload.
    if (!room.initialVideoAnnounced) {
      room.initialVideoAnnounced = true;
      const loadedMsg = { system: true, text: `🎬 Cinta cargada: ${videoDisplayName(room.videoFile)}` };
      pushChatHistory(room, loadedMsg);
      io.to(roomId).emit('chat-message', loadedMsg);
      roomStore.saveRoom(roomId, room); // fire-and-forget: no vale la pena bloquear el join por esto
    }

    // Reconexión rápida (ej. wifi que se cae un segundo): no repetir "se unió a la sala"
    const recent = room.recentDisconnects.get(socket.userId);
    if (recent) {
      clearTimeout(recent.timer);
      room.recentDisconnects.delete(socket.userId);
    } else {
      const joinedMsg = { system: true, text: `${socket.username} se unió a la sala 🎬` };
      pushChatHistory(room, joinedMsg);
      socket.to(roomId).emit('chat-message', joinedMsg);
    }

    // Fase 2bis, "migración del rol de host": `socket.request.session` viene del middleware de
    // express-session compartido con Socket.io más arriba (`io.engine.use(sessionMiddleware)`) — si
    // la sala tiene dueño, esto reemplaza al hostToken como forma de probar "soy el host" (ver
    // isRoomOwner()); si no tiene dueño, el comportamiento es exactamente el de siempre.
    const sessionUserId = socket.request.session && socket.request.session.userId;
    if (isRoomOwner(room, { hostToken, sessionUserId })) {
      setHost(room, roomId, socket); // emite su propio 'host-status'
    } else {
      socket.isHost = false;
      socket.emit('host-status', { isHost: false, hostToken: null });
    }
    socket.emit('room-data', { videoFile: room.videoFile, subtitleFile: room.subtitleFile, position: room.videoPosition });
    if (wasMuted) socket.emit('mute-status', { muted: true });

    io.to(roomId).emit('viewer-count', room.viewers);
    broadcastViewerList(roomId);
  }));

  // Solo el host puede mover el video
  socket.on('sync', safeSocketHandler('sync', (data) => {
    if (!socket.isHost || !currentRoom) return;
    const room = rooms[currentRoom];
    // Guarda la última posición conocida (V18) para poder mandársela a quien se conecte después —
    // ver nota en makeRoom(). 'seek' no toca `paused` (solo cambia el minuto); 'play'/'pause' sí;
    // 'heartbeat' manda ambos datos juntos cada 4s como respaldo por si se perdió algún evento.
    if (room && typeof data.time === 'number') {
      room.videoPosition.time = data.time;
      if (data.type === 'play') room.videoPosition.paused = false;
      else if (data.type === 'pause') room.videoPosition.paused = true;
      else if (data.type === 'heartbeat' && typeof data.paused === 'boolean') room.videoPosition.paused = data.paused;
      // Throttle de escritura a Redis: 'heartbeat' llega cada 4s por sala mientras dura la sala
      // entera (ver comentario de room.html), escribir la posición en cada uno sería un round-trip
      // a Redis constante sin necesidad real — un reinicio del proceso que pierda unos pocos segundos
      // de posición exacta no es un problema práctico. 'play'/'pause'/'seek' sí son cambios de estado
      // puntuales (no se repiten solos) y se persisten al toque. `_lastPositionSaveAt` es un campo
      // fuera del shape que persiste roomStore.serializeRoom (solo lee los campos que le interesan),
      // así que agregarlo directo sobre el objeto `room` en memoria no ensucia lo que se guarda.
      const now = Date.now();
      const isHeartbeat = data.type === 'heartbeat';
      if (!isHeartbeat || !room._lastPositionSaveAt || now - room._lastPositionSaveAt > 5000) {
        room._lastPositionSaveAt = now;
        roomStore.saveRoom(currentRoom, room); // fire-and-forget
      }
    }
    socket.to(currentRoom).emit('sync', data);
  }));

  socket.on('chat-message', safeSocketHandler('chat-message', (payload) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (room.mutedUserIds.has(socket.userId)) { socket.emit('mute-status', { muted: true }); return; }
    // Rate limiting de flood en el chat (Fase 2.2 del plan de producción) — antes no había ningún
    // límite: un cliente (o un script apuntando directo al socket, sin pasar por room.html) podía
    // mandar mensajes sin parar, y cada uno se persiste en Redis (roomStore.saveRoom) y se retransmite
    // a toda la sala. Se avisa solo a quien está mandando de más (no se ve en el chat de los demás,
    // ni se guarda en el historial) — no es un error de protocolo, así que no corta la conexión.
    if (isChatRateLimited(socket)) {
      socket.emit('chat-rate-limited', { message: 'Estás mandando mensajes muy rápido, esperá un toque.' });
      return;
    }
    // El cliente manda { text, replyTo } desde V14; se acepta también un string plano por si
    // queda algún cliente viejo en caché sin recargar (o algún otro cliente que hable el protocolo
    // anterior).
    const text = payload && typeof payload === 'object' ? payload.text : payload;
    if (typeof text !== 'string' || !text.trim()) return;
    let replyTo = null;
    const rawReply = payload && typeof payload === 'object' ? payload.replyTo : null;
    if (rawReply && typeof rawReply === 'object' && typeof rawReply.user === 'string' && typeof rawReply.text === 'string' && rawReply.user.trim() && rawReply.text.trim()) {
      // isHost viaja también en la cita (no solo en el mensaje raíz) para que el nombre citado se
      // pinte del color correcto del lado del cliente — ver nota en room.html sobre por qué esto
      // se guarda "congelado" en el momento de responder y no se recalcula contra el host actual.
      replyTo = { user: rawReply.user.slice(0, 40), text: rawReply.text.slice(0, 200), isHost: !!rawReply.isHost };
    }
    // isHost va pegado al mensaje (no solo al socket) para que el color del nombre en el chat (V15,
    // ver room.html) refleje si esa persona ERA el host en el momento de escribirlo — el control
    // remoto puede pasar de mano en mano durante la sala, y un mensaje viejo no debería cambiar de
    // color retroactivamente solo porque el host actual es otro ahora.
    // userId (no solo el nombre) viaja en el mensaje para que cada cliente pueda distinguir "mis
    // mensajes" de los de otros sin ambigüedad — dos personas pueden elegir el mismo nombre al unirse
    // (no hay validación de unicidad), así que comparar por `user` en el cliente daría falsos
    // positivos. userId sí es estable por navegador (ver getPersistentUserId() en room.html).
    const msg = { system: false, user: socket.username, text: text.slice(0, 500), replyTo, isHost: !!socket.isHost, userId: socket.userId };
    pushChatHistory(room, msg);
    io.to(currentRoom).emit('chat-message', msg);
    roomStore.saveRoom(currentRoom, room); // fire-and-forget: guarda el chatHistory actualizado
  }));

  socket.on('typing', safeSocketHandler('typing', () => {
    if (currentRoom) socket.to(currentRoom).emit('typing', { username: socket.username });
  }));

  socket.on('reaction', safeSocketHandler('reaction', (emoji) => {
    if (currentRoom) io.to(currentRoom).emit('reaction', emoji);
  }));

  // Buffering compartido: se muestra un indicador junto al nombre de quien está cargando
  socket.on('buffering-status', safeSocketHandler('buffering-status', (isBuffering) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (isBuffering) room.bufferingSockets.add(socket.id);
    else room.bufferingSockets.delete(socket.id);
    broadcastViewerList(currentRoom);
  }));

  // --- Controles exclusivos del host ---
  socket.on('kick-user', safeSocketHandler('kick-user', (targetId) => {
    if (!socket.isHost || !currentRoom) return;
    const target = io.sockets.sockets.get(targetId);
    if (target) {
      target.emit('kicked');
      target.leave(currentRoom);
      target.disconnect(true);
    }
  }));

  socket.on('toggle-mute', safeSocketHandler('toggle-mute', (targetId) => {
    const room = rooms[currentRoom];
    if (!socket.isHost || !room) return;
    const target = io.sockets.sockets.get(targetId);
    if (!target) return;
    if (room.mutedUserIds.has(target.userId)) room.mutedUserIds.delete(target.userId);
    else room.mutedUserIds.add(target.userId);
    target.emit('mute-status', { muted: room.mutedUserIds.has(target.userId) });
    broadcastViewerList(currentRoom);
    roomStore.saveRoom(currentRoom, room); // fire-and-forget: persiste el nuevo mutedUserIds
  }));

  // Traspaso manual del control remoto a otro espectador
  socket.on('make-host', safeSocketHandler('make-host', (targetId) => {
    const room = rooms[currentRoom];
    if (!socket.isHost || !room) return;
    const target = io.sockets.sockets.get(targetId);
    if (!target || target.id === socket.id) return;
    const fromName = socket.username;
    const toName = target.username;
    setHost(room, currentRoom, target); // degrada a `socket` (host actual) y promueve a `target`
    const transferMsg = { system: true, text: `🎛 ${fromName} le pasó el control remoto a ${toName}` };
    pushChatHistory(room, transferMsg);
    io.to(currentRoom).emit('chat-message', transferMsg);
    broadcastViewerList(currentRoom);
    roomStore.saveRoom(currentRoom, room); // fire-and-forget: guarda el mensaje del traspaso en el chatHistory
  }));

  socket.on('disconnect', safeSocketHandler('disconnect', () => {
    const room = rooms[currentRoom];
    if (!room) return;

    room.viewers = Math.max(0, room.viewers - 1);
    room.userNames.delete(socket.id);
    room.bufferingSockets.delete(socket.id);
    io.to(currentRoom).emit('viewer-count', room.viewers);
    broadcastViewerList(currentRoom);

    // Da un margen antes de anunciar la salida, para no floodear el chat con reconexiones cortas (wifi inestable)
    const userId = socket.userId;
    const username = socket.username || 'Alguien';
    const timer = setTimeout(() => {
      // Este callback corre en un tick aparte (setTimeout), fuera del try/catch de safeSocketHandler
      // que envuelve el resto del handler de 'disconnect' — un error acá se escaparía como excepción
      // no capturada igual, así que se le agrega su propio try/catch para no perder solo esta sala.
      try {
        room.recentDisconnects.delete(userId);
        room.mutedUserIds.delete(userId); // ya pasó el margen de gracia, se limpia el estado de silencio
        const leftMsg = { system: true, text: `${username} salió de la sala` };
        pushChatHistory(room, leftMsg);
        io.to(currentRoom).emit('chat-message', leftMsg);
        roomStore.saveRoom(currentRoom, room); // fire-and-forget: refleja el mutedUserIds actualizado
      } catch (err) {
        console.error(`⚠️  Error en el timer de "salió de la sala" (roomId: ${currentRoom}):`, err);
      }
    }, RECONNECT_GRACE_MS);
    room.recentDisconnects.set(userId, { timer, username });

    // Traspaso automático: si el que se fue era el host actual de la sala (por hostSocketId, no por
    // su flag isHost local — que puede haber quedado desactualizado), el siguiente en la sala toma el control
    if (room.hostSocketId === socket.id) {
      room.hostSocketId = null;
      const stillConnected = io.sockets.adapter.rooms.get(currentRoom);
      if (stillConnected && stillConnected.size > 0) {
        const next = io.sockets.sockets.get([...stillConnected][0]);
        if (next) {
          setHost(room, currentRoom, next);
          const autoTransferMsg = { system: true, text: `🎛 ${next.username || 'Alguien'} ahora tiene el control remoto (el host anterior se desconectó)` };
          pushChatHistory(room, autoTransferMsg);
          io.to(currentRoom).emit('chat-message', autoTransferMsg);
          broadcastViewerList(currentRoom);
          roomStore.saveRoom(currentRoom, room); // fire-and-forget: guarda el mensaje del traspaso automático
        }
      }
    }
  }));
});

const PORT = process.env.PORT || 3000;

// --- Expiración de salas por inactividad (Fase 2.6 del plan de producción) -----------------------
// El TTL nativo de Redis (ver lib/roomStore.js, ROOM_TTL_SECONDS) resuelve la mitad del problema: si
// el proceso está caído, la key igual desaparece sola. Pero mientras el proceso SÍ está corriendo,
// `rooms` en memoria (la fuente de verdad para lecturas, ver la nota grande más arriba) no se entera
// solo de que una key de Redis expiró — necesita este barrido activo para: (1) avisarle a cualquiera
// que siguiera conectado en una sala tan vieja (caso raro, pero posible: alguien dejó una pestaña
// abierta sin actividad real durante 24hs+), (2) sacarla de `rooms`, y (3) borrarla de Redis (más por
// prolijidad del índice `movienight:rooms` que por necesidad — la key en sí ya iba a expirar sola).
// No borra el video asociado (R2/disco) — decisión de producto de esta fase, ver docs/PLAN-PRODUCCION.md:
// el video queda en la biblioteca compartida para reutilizarse en otra sala.
const ROOM_SWEEP_INTERVAL_MS = parseInt(process.env.ROOM_SWEEP_INTERVAL_MS, 10) || 30 * 60 * 1000; // cada 30 min

async function sweepExpiredRooms() {
  const ttlMs = roomStore.ROOM_TTL_SECONDS * 1000;
  const now = Date.now();
  const expiredIds = Object.keys(rooms).filter((id) => now - (rooms[id].lastActivity || 0) > ttlMs);
  if (expiredIds.length === 0) return;

  for (const roomId of expiredIds) {
    try {
      // Avisa y desconecta a quien siga adentro (raro tras 24hs+ sin actividad, pero por las dudas —
      // no tendría sentido dejar a alguien "viendo" una sala que ya se borró de `rooms`).
      io.to(roomId).emit('room-error', 'Esta sala expiró por inactividad (sin uso durante 24hs) y se cerró.');
      const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
      if (socketsInRoom) {
        for (const socketId of [...socketsInRoom]) {
          const s = io.sockets.sockets.get(socketId);
          if (s) { s.leave(roomId); s.disconnect(true); }
        }
      }
      delete rooms[roomId];
      await roomStore.deleteRoom(roomId);
    } catch (err) {
      console.error(`⚠️  Error expirando la sala ${roomId} (Fase 2.6):`, err.message);
    }
  }
  console.log(`🧹 Barrido de salas inactivas (Fase 2.6): ${expiredIds.length} sala(s) cerrada(s) por 24hs+ sin actividad. El video de cada una sigue disponible en la biblioteca.`);
}

// --- Limpieza automática de subidas multipart abandonadas en R2 (Fase 2.6 del plan de producción) -
// `scripts/r2-cleanup-multipart.js` ya hacía esto mismo, pero a mano (`npm run r2:cleanup -- --abort`).
// Esto lo automatiza: corre solo, periódicamente, mientras el server esté levantado. Más agresivo que
// la regla de lifecycle por default de R2 (aborta a los 7 días) a propósito — configurable con
// MULTIPART_ABANDON_DAYS por si 2 días resulta muy agresivo para conexiones de subida muy lentas.
const MULTIPART_SWEEP_INTERVAL_MS = parseInt(process.env.MULTIPART_SWEEP_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000; // cada 24hs
const MULTIPART_ABANDON_DAYS = parseFloat(process.env.MULTIPART_ABANDON_DAYS) || 2;

async function sweepAbandonedMultipartUploads() {
  if (!r2.isR2Enabled()) return;
  try {
    const uploads = await r2.listMultipartUploads();
    const cutoff = Date.now() - MULTIPART_ABANDON_DAYS * 24 * 60 * 60 * 1000;
    const stale = uploads.filter((u) => u.initiated < cutoff);
    for (const u of stale) {
      try {
        await r2.abortMultipartUpload(u.key, u.uploadId);
        console.log(`🧹 Subida multipart abandonada cancelada en R2 (Fase 2.6): ${u.key}`);
      } catch (err) {
        console.error(`⚠️  No se pudo cancelar la subida multipart abandonada ${u.key}:`, err.message);
      }
    }
  } catch (err) {
    console.error('⚠️  Error revisando subidas multipart abandonadas en R2 (Fase 2.6):', err.message);
  }
}

let roomSweepIntervalHandle = null;
let multipartSweepIntervalHandle = null;

// --- Arranque del server (Fase 1.1 del plan de producción) ---------------------------------------
// Se envuelve en una función async (en vez de llamar a server.listen directo) porque ahora hay un
// paso previo que sí puede fallar de verdad y debe frenar el arranque: la conexión a Redis. Mismo
// criterio que ya se aplicaba a R2 (ver más abajo), pero más estricto: R2 solo afecta subir/cambiar
// cintas si falla, así que el server igual arranca y avisa por consola. Redis en cambio es la fuente
// de verdad de que las salas sobrevivan a un reinicio — si está configurado y no responde, arrancar
// igual en modo "memoria nomás" sería exactamente el problema que esta fase busca resolver, sin que
// nadie se entere hasta el próximo crash. Por eso acá SÍ se corta el arranque con process.exit(1).
async function startServer() {
  // Fase 2.1 del plan de producción: se hashea acá (async, con bcrypt) y no en el momento de definir
  // la constante LIBRARY_PASSWORD más arriba, porque bcrypt.hash es async y esto tiene que terminar
  // ANTES de aceptar cualquier request — server.listen() todavía no se llamó a esta altura, así que
  // no hay forma de que una request llegue a requireLibraryAuth/requireUploadAuth mientras esto corre.
  libraryPasswordHash = await hashPassword(LIBRARY_PASSWORD);

  if (roomStore.isEnabled()) {
    try {
      await roomStore.testConnection();
      console.log('🗄️  Redis: conectado. El estado de las salas persiste entre reinicios.');
    } catch (err) {
      console.error('');
      console.error('💥 No se pudo conectar a Redis — el server NO va a arrancar:');
      console.error(`   ${err.message}`);
      console.error('   Revisá REDIS_URL (o que haya un Redis corriendo en redis://127.0.0.1:6379, el valor');
      console.error('   por defecto si no se define REDIS_URL).');
      console.error('   Si es desarrollo local y no tenés Redis instalado, corré con DISABLE_REDIS=1 —');
      console.error('   pero OJO: en ese modo las salas vuelven a vivir solo en memoria, sin persistencia');
      console.error('   real, exactamente el problema que esta fase resuelve. No usar en producción.');
      console.error('');
      process.exit(1);
    }

    try {
      const recovered = await roomStore.loadAllRooms();
      Object.assign(rooms, recovered); // repuebla el objeto `rooms` ya declarado (const, no se reasigna)
      const count = Object.keys(recovered).length;
      if (count > 0) console.log(`🔄 ${count} sala(s) recuperada(s) desde Redis (sobrevivieron al reinicio).`);
    } catch (err) {
      // Redis respondió al ping (testConnection ya pasó) pero algo falló leyendo las salas — se
      // arranca igual (en 0 salas) en vez de bloquear el server entero por esto, pero bien visible.
      console.error('⚠️  Redis conectó pero no se pudieron recuperar las salas guardadas (se arranca sin ellas):', err.message);
    }

    // Fase 2.6: un barrido inicial ACÁ (antes de aceptar tráfico), además del setInterval de abajo,
    // por si el proceso estuvo caído más de ROOM_SWEEP_INTERVAL_MS y se recuperaron desde Redis salas
    // que en realidad ya deberían haber expirado (su key en Redis podría no haber llegado a expirar
    // sola si el TTL se refrescó justo antes de la caída — este barrido las limpia igual, en memoria).
    sweepExpiredRooms().catch((err) => console.error('⚠️  Error en el barrido inicial de salas expiradas:', err.message));
    roomSweepIntervalHandle = setInterval(() => {
      sweepExpiredRooms().catch((err) => console.error('⚠️  Error en el barrido periódico de salas expiradas:', err.message));
    }, ROOM_SWEEP_INTERVAL_MS);
  } else {
    console.log('');
    console.log('⚠️  DISABLE_REDIS=1: las salas viven SOLO en memoria, sin persistencia entre reinicios.');
    console.log('   Pensado solo para desarrollo local sin Redis a mano — no usar en producción.');
    console.log('   Las sesiones de usuario (Fase 2bis) también corren en memoria en este modo: nadie');
    console.log('   queda logueado tras un reinicio, y no sirve con más de un proceso.');
    console.log('');
  }

  if (sessionSecretWasGenerated) {
    console.log('');
    console.log('🔑 SESSION_SECRET no está configurada — se generó una al azar para esta corrida.');
    console.log('   Esto NO rompe nada del servidor, pero SÍ desloguea a todo el mundo en cada reinicio');
    console.log('   del proceso (la cookie de sesión de nadie va a validar contra un secreto nuevo).');
    console.log('   Para que las sesiones sobrevivan a un reinicio, definí SESSION_SECRET en el .env');
    console.log('   (cualquier string largo y random sirve, ej. el que devuelve `openssl rand -hex 32`).');
    console.log('');
  }
  if (SESSION_COOKIE_INSECURE) {
    console.log('⚠️  SESSION_COOKIE_INSECURE=1: la cookie de sesión viaja sin el flag `secure`, o sea que');
    console.log('   el navegador la manda también por HTTP plano. Pensado solo para desarrollo local sin');
    console.log('   HTTPS (ej. http://localhost sin túnel) — nunca en producción.');
  }

  // Postgres (cuentas de usuario, Fase 2bis) — a diferencia de Redis, no configurar DATABASE_URL es
  // un modo válido (el resto de la app sigue funcionando igual, solo /auth/* queda deshabilitado, ver
  // requireDbEnabled más arriba). Pero SI está configurada, aplica el mismo criterio de "fallar
  // rápido" que Redis: un login/registro roto en silencio es peor que frenar el arranque.
  if (db.isEnabled()) {
    try {
      await db.testConnection();
      await db.runMigrations();
      console.log('🐘 Postgres: conectado y migraciones al día. Registro/login habilitados.');
    } catch (err) {
      console.error('');
      console.error('💥 No se pudo conectar a Postgres (o correr las migraciones) — el server NO va a arrancar:');
      console.error(`   ${err.message}`);
      console.error('   Revisá DATABASE_URL, o quitala del .env si todavía no querés habilitar cuentas de usuario.');
      console.error('');
      process.exit(1);
    }
  } else {
    console.log('👤 DATABASE_URL no configurada — las cuentas de usuario (registro/login) están deshabilitadas.');
    console.log('   El resto de la app sigue funcionando igual (salas anónimas por hostToken, como hasta ahora).');
  }

  if (db.isEnabled()) {
    if (mailer.isEnabled()) {
      console.log('📧 Resend configurado — /auth/forgot-password manda emails de verdad.');
    } else {
      console.log('📧 RESEND_API_KEY no configurada — /auth/forgot-password loguea el link por consola en vez de mandar un email (solo sirve para desarrollo local).');
    }
  }

  // Fase 2.6: independiente del bloque de Redis de arriba — corre siempre que R2 esté configurado
  // (la función misma no hace nada si no lo está). No hace falta un barrido inicial acá como el de
  // salas: el lifecycle por default de R2 (7 días) ya cubre el caso "el proceso estuvo caído mucho
  // tiempo", así que alcanza con que el intervalo arranque a contar desde este arranque.
  multipartSweepIntervalHandle = setInterval(() => {
    sweepAbandonedMultipartUploads();
  }, MULTIPART_SWEEP_INTERVAL_MS);

  server.listen(PORT, () => {
    console.log(`MovieNight corriendo en http://localhost:${PORT}`);

    // Cloudflare R2 — Fase 2: si está configurado, se valida la conexión ACÁ (una sola vez, al
    // arrancar) en vez de dejar que el primer error confuso aparezca recién cuando alguien intente
    // crear una sala o cambiar de cinta. A propósito NO hay modo de emergencia a disco si esto falla:
    // mezclar "a veces disco, a veces R2" según si R2 respondió en ese momento sería más confuso que un
    // error claro al subir. Ver sección "Cloudflare R2 — Fase 2" en docs/historico/MEMORIA.md.
    if (r2.isR2Enabled()) {
      r2.testConnection()
        .then(() => {
          console.log('☁️  Cloudflare R2: conectado. Las cintas nuevas se suben directo al bucket (no a disco local).');
        })
        .catch((err) => {
          console.log('');
          console.log('⚠️  Cloudflare R2 está configurado en .env pero la conexión de prueba falló:');
          console.log(`   ${err.message}`);
          console.log('   Revisá R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME.');
          console.log('   Mientras esto no se arregle, crear sala o cambiar de cinta va a fallar (no hay respaldo a disco).');
          console.log('');
        });
    } else {
      console.log('💾 Cloudflare R2 no está configurado — los videos se siguen guardando en disco local (public/uploads).');
    }

    if (libraryPasswordWasGenerated) {
      console.log('');
      console.log('🔒 Contraseña de biblioteca (protege /library.html — listar y borrar cintas):');
      console.log(`   ${LIBRARY_PASSWORD}`);
      console.log('   Se generó al azar porque no definiste LIBRARY_PASSWORD como variable de entorno.');
      console.log('   Compártela con tu grupo por otro canal (no por el link de la sala) y va a cambiar');
      console.log('   cada vez que reinicies el servidor. Para que sea fija, copiá ".env.example" a ".env"');
      console.log('   y completá LIBRARY_PASSWORD ahí (se carga solo, no hace falta escribirla cada vez).');
      console.log('');
    }
  });
}

startServer();

// --- Graceful shutdown (Fase 1.4 del plan de producción) -----------------------------------------
// Sin esto, un SIGTERM/SIGINT (ej. `pm2 stop`/`pm2 restart`, un deploy que mata el proceso, Ctrl+C
// en desarrollo) corta todas las conexiones de Socket.io de golpe — a quien esté viendo algo en ese
// momento el video se le traba sin ninguna explicación, y del lado del servidor no queda margen para
// que nada en vuelo (ej. un `chat-message` recién emitido) termine de salir.
//
// Con esto: (1) se avisa a todos los clientes conectados con un evento dedicado, para que la UI
// pueda mostrar algo mejor que un corte mudo; (2) se deja de aceptar conexiones HTTP nuevas de
// inmediato (no tiene sentido sumar gente a mitad de un shutdown); (3) recién después de un margen
// (`SHUTDOWN_GRACE_MS`, default 5s) se cierran los sockets de verdad y termina el proceso — tiempo
// de sobra para que el aviso llegue y para que Socket.io despache cualquier mensaje que ya estaba en
// camino.
const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS, 10) || 5000;
let shuttingDown = false; // evita que un segundo SIGTERM/SIGINT mientras ya estamos cerrando reinicie el timer o duplique el cierre

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('');
  console.log(`🛑 ${signal} recibido — cerrando MovieNight (margen de ${SHUTDOWN_GRACE_MS / 1000}s para avisar a los clientes conectados)...`);

  // Fase 2.6: no tiene efecto funcional dejarlos correr (el proceso está por terminar de todos
  // modos), pero cortarlos prolijamente evita que un barrido dispare a mitad del shutdown.
  if (roomSweepIntervalHandle) clearInterval(roomSweepIntervalHandle);
  if (multipartSweepIntervalHandle) clearInterval(multipartSweepIntervalHandle);

  // Evento dedicado (no reutilizamos 'room-error' ni similares: esto no es un error de la sala, es
  // el servidor entero bajando) — el cliente (room.html) lo escucha para mostrar un banner en vez de
  // dejar que el video se trabe sin explicación cuando el socket se corte en unos segundos.
  io.emit('server-restarting');

  // Deja de aceptar conexiones HTTP nuevas ya mismo. Esto NO corta las conexiones de Socket.io ya
  // abiertas (quedan vivas hasta el io.close() de abajo) — el callback recién dispara cuando ya no
  // quede ninguna conexión abierta, así que no bloquea el timeout de más abajo.
  server.close((err) => {
    if (err) console.error('⚠️  Error cerrando el servidor HTTP:', err.message);
  });

  setTimeout(async () => {
    io.close(); // corta todas las conexiones de Socket.io activas
    await roomStore.closeConnection(); // cierra la conexión a Redis prolijamente (QUIT en vez de matar el socket)
    await db.closeConnection(); // cierra el pool de Postgres prolijamente (Fase 2bis)
    console.log('👋 MovieNight cerrado.');
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // lo que manda `pm2 stop`/`pm2 restart`, y la mayoría de los hostings al redeployar
process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // Ctrl+C en una terminal (desarrollo local)

// Windows no entrega señales POSIX reales: Node y PM2 documentan que ahí SIGTERM/SIGINT pueden
// terminar el proceso incondicionalmente en vez de disparar los handlers de arriba (PM2 termina
// forzando el cierre con `taskkill /T /F`) — confirmado en este proyecto: probando en Windows,
// `pm2 stop`/`pm2 restart` cortaban el proceso sin loguear nada del shutdown, mientras que un
// SIGTERM directo en Linux sí disparaba `gracefulShutdown` normalmente. La solución oficial de PM2
// para este caso es IPC en vez de señales: `shutdown_with_message: true` en ecosystem.config.js hace
// que, en vez de (o adicionalmente a) la señal, PM2 mande un mensaje de proceso con
// `{ data: {}, action: 'shutdown' }`, que si el proceso corre bajo PM2 (`process.send` existe) sí le
// llega de forma confiable en cualquier plataforma. Sin este listener, activar
// `shutdown_with_message` en la config no alcanza por sí solo (PM2 mandaría el mensaje al vacío).
process.on('message', (msg) => {
  if (msg === 'shutdown' || (msg && msg.action === 'shutdown')) gracefulShutdown('mensaje IPC de PM2 (shutdown_with_message)');
});
