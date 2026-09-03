const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { PassThrough } = require('stream');
const { Server } = require('socket.io');

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
const libraryPasswordHash = hashPassword(LIBRARY_PASSWORD);

function requireLibraryAuth(req, res, next) {
  const provided = req.get('x-library-password') || req.query.libraryPassword || (req.body && req.body.libraryPassword) || '';
  if (hashPassword(provided) !== libraryPasswordHash) {
    return res.status(401).json({ error: 'Contraseña de biblioteca requerida o incorrecta.' });
  }
  next();
}

// --- Contraseña + límite de intentos para SUBIR una cinta nueva (V19) ----------------------------
// Motivo: con R2 conectado, cualquiera con el link llegaba a /create-room y podía subir archivos
// gigantes sin ninguna traba — cada uno se factura (almacenamiento + operaciones de R2). A diferencia
// de requireLibraryAuth (que protege leer/borrar la biblioteca y ya alcanzaba con "correcta o no"),
// acá el costo de un intento de más es mucho más alto: dejar pasar la SUBIDA REAL de un archivo
// pesado es peor que dejar pasar un GET. Por eso, además de reusar la misma LIBRARY_PASSWORD (un solo
// secreto para todo el server, no hace falta uno nuevo — ver sección de riesgos en MEMORIA.md), esto
// suma un límite de intentos por IP: 3 contraseñas incorrectas seguidas bloquean esa IP por 15 minutos
// antes de poder volver a intentar, para que probar contraseñas al azar no sea gratis.
//
// Se aplica ANTES de `upload.single('video')` en las rutas que suben un archivo nuevo (/create-room,
// /room/:id/change-video) — a propósito, para que una contraseña incorrecta corte la request antes de
// que Multer empiece a leer/subir el archivo. El cliente manda la contraseña por el header
// `x-library-password` (no por un campo del FormData): así queda disponible para este middleware
// antes de que arranque el parseo del multipart/form-data que trae el video.
const UPLOAD_AUTH_MAX_ATTEMPTS = 3;
const UPLOAD_AUTH_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutos bloqueado tras agotar los 3 intentos
const uploadAuthAttempts = new Map(); // ip -> { count, lockedUntil }

function requireUploadAuth(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  let entry = uploadAuthAttempts.get(ip);

  if (entry && entry.lockedUntil > now) {
    const minutesLeft = Math.ceil((entry.lockedUntil - now) / 60000);
    return res.status(429).json({
      error: `Demasiados intentos fallidos. Esperá ${minutesLeft} min y volvé a intentar.`,
      lockedMinutes: minutesLeft
    });
  }

  const provided = req.get('x-library-password') || '';
  if (hashPassword(provided) === libraryPasswordHash) {
    uploadAuthAttempts.delete(ip); // contraseña correcta: se olvida cualquier intento fallido previo
    return next();
  }

  // Arranca un contador nuevo si no había uno todavía, o si el bloqueo anterior ya venció (lockedUntil
  // solo es > 0 una vez que se llegó al 3er intento fallido; mientras se está contando 1° y 2°
  // intento, lockedUntil se mantiene en 0 y NO hay que resetear el contador en cada request).
  if (!entry || (entry.lockedUntil > 0 && entry.lockedUntil <= now)) entry = { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= UPLOAD_AUTH_MAX_ATTEMPTS) {
    entry.lockedUntil = now + UPLOAD_AUTH_LOCKOUT_MS;
    entry.count = 0; // al vencer el bloqueo, vuelve a tener 3 intentos frescos
    uploadAuthAttempts.set(ip, entry);
    return res.status(401).json({
      error: 'Contraseña incorrecta. Se bloquearon los intentos de subida por 15 minutos.',
      attemptsLeft: 0
    });
  }
  uploadAuthAttempts.set(ip, entry);
  return res.status(401).json({
    error: 'Contraseña incorrecta.',
    attemptsLeft: UPLOAD_AUTH_MAX_ATTEMPTS - entry.count
  });
}

// Salas en memoria
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

function makeRoomId() { return crypto.randomBytes(3).toString('hex'); }
function hashPassword(pw) { return crypto.createHash('sha256').update(String(pw)).digest('hex'); }

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
// request. Ver sección "Cloudflare R2 — Fase 2" en MEMORIA.md para el porqué de este modo dual.
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

function makeRoom(videoFile, password) {
  return {
    videoFile,
    subtitleFile: null,
    viewers: 0,
    hostToken: crypto.randomBytes(16).toString('hex'),
    hostSocketId: null, // socket.id del host actual (única fuente de verdad; ver setHost más abajo)
    passwordHash: password ? hashPassword(password) : null,
    mutedUserIds: new Set(),
    userNames: new Map(),
    bufferingSockets: new Set(),
    recentDisconnects: new Map(),
    initialVideoAnnounced: false, // ver join-room: anuncia la cinta con la que se creó la sala una sola vez
    chatHistory: [], // últimos CHAT_HISTORY_LIMIT mensajes de chat (system y de usuario), ver pushChatHistory
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

app.post('/create-room', requireUploadAuth, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No llegó ningún video' });
  const roomId = makeRoomId();
  const room = makeRoom(videoUrlForUploadedFile(req.file), (req.body.password || '').trim());
  rooms[roomId] = room;
  res.json({ roomId, hostToken: room.hostToken });
});

app.post('/create-room-from-upload', async (req, res) => {
  try {
    const { filename, password } = req.body || {};
    if (!(await isValidUploadReference(filename))) return res.status(400).json({ error: 'Ese archivo no existe' });
    const roomId = makeRoomId();
    const room = makeRoom(videoUrlForExistingFile(filename), (password || '').trim());
    rooms[roomId] = room;
    res.json({ roomId, hostToken: room.hostToken });
  } catch (err) {
    console.error('Error creando sala desde biblioteca (R2):', err.message);
    res.status(502).json({ error: 'No se pudo consultar Cloudflare R2 (revisa credenciales/conexión).' });
  }
});

app.post('/room/:id/change-video', requireUploadAuth, upload.single('video'), (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Sala no existe' });
  if (req.body.hostToken !== room.hostToken) return res.status(403).json({ error: 'No autorizado' });
  if (!req.file) return res.status(400).json({ error: 'No llegó ningún video' });
  room.videoFile = videoUrlForUploadedFile(req.file);
  room.videoPosition = { time: 0, paused: true }; // cinta nueva: arranca de 0, no de donde iba la anterior
  const changedMsg = { system: true, text: `📼 Cambiaron la cinta: ${videoDisplayName(room.videoFile)}` };
  pushChatHistory(room, changedMsg);
  io.to(req.params.id).emit('chat-message', changedMsg);
  io.to(req.params.id).emit('video-changed', { videoFile: room.videoFile });
  res.json({ ok: true });
});

// Cambiar la cinta de una sala ya existente reutilizando un video de la biblioteca (sin resubir nada)
app.post('/room/:id/change-video-from-upload', async (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Sala no existe' });
  const { filename, hostToken } = req.body || {};
  if (hostToken !== room.hostToken) return res.status(403).json({ error: 'No autorizado' });
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
  res.json({ ok: true });
});

// Subir subtítulos (.srt o .vtt) para la sala activa
app.post('/room/:id/upload-subtitle', subtitleUpload.single('subtitle'), (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Sala no existe' });
  if (req.body.hostToken !== room.hostToken) return res.status(403).json({ error: 'No autorizado' });
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
  res.json({ ok: true, subtitleFile: room.subtitleFile });
});

app.get('/room/:id', (req, res) => {
  if (!rooms[req.params.id]) return res.status(404).send('Esa sala no existe (o ya se cerró).');
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
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

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomId, username, hostToken, userId, password }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('room-error', 'La sala no existe.'); return; }

    if (room.passwordHash && hashPassword(password || '') !== room.passwordHash) {
      socket.emit('room-error', 'Contraseña incorrecta.');
      return;
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

    if (hostToken && hostToken === room.hostToken) {
      setHost(room, roomId, socket); // emite su propio 'host-status'
    } else {
      socket.isHost = false;
      socket.emit('host-status', { isHost: false, hostToken: null });
    }
    socket.emit('room-data', { videoFile: room.videoFile, subtitleFile: room.subtitleFile, position: room.videoPosition });
    if (wasMuted) socket.emit('mute-status', { muted: true });

    io.to(roomId).emit('viewer-count', room.viewers);
    broadcastViewerList(roomId);
  });

  // Solo el host puede mover el video
  socket.on('sync', (data) => {
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
    }
    socket.to(currentRoom).emit('sync', data);
  });

  socket.on('chat-message', (payload) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (room.mutedUserIds.has(socket.userId)) { socket.emit('mute-status', { muted: true }); return; }
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
  });

  socket.on('typing', () => {
    if (currentRoom) socket.to(currentRoom).emit('typing', { username: socket.username });
  });

  socket.on('reaction', (emoji) => {
    if (currentRoom) io.to(currentRoom).emit('reaction', emoji);
  });

  // Buffering compartido: se muestra un indicador junto al nombre de quien está cargando
  socket.on('buffering-status', (isBuffering) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (isBuffering) room.bufferingSockets.add(socket.id);
    else room.bufferingSockets.delete(socket.id);
    broadcastViewerList(currentRoom);
  });

  // --- Controles exclusivos del host ---
  socket.on('kick-user', (targetId) => {
    if (!socket.isHost || !currentRoom) return;
    const target = io.sockets.sockets.get(targetId);
    if (target) {
      target.emit('kicked');
      target.leave(currentRoom);
      target.disconnect(true);
    }
  });

  socket.on('toggle-mute', (targetId) => {
    const room = rooms[currentRoom];
    if (!socket.isHost || !room) return;
    const target = io.sockets.sockets.get(targetId);
    if (!target) return;
    if (room.mutedUserIds.has(target.userId)) room.mutedUserIds.delete(target.userId);
    else room.mutedUserIds.add(target.userId);
    target.emit('mute-status', { muted: room.mutedUserIds.has(target.userId) });
    broadcastViewerList(currentRoom);
  });

  // Traspaso manual del control remoto a otro espectador
  socket.on('make-host', (targetId) => {
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
  });

  socket.on('disconnect', () => {
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
      room.recentDisconnects.delete(userId);
      room.mutedUserIds.delete(userId); // ya pasó el margen de gracia, se limpia el estado de silencio
      const leftMsg = { system: true, text: `${username} salió de la sala` };
      pushChatHistory(room, leftMsg);
      io.to(currentRoom).emit('chat-message', leftMsg);
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
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`MovieNight corriendo en http://localhost:${PORT}`);

  // Cloudflare R2 — Fase 2: si está configurado, se valida la conexión ACÁ (una sola vez, al
  // arrancar) en vez de dejar que el primer error confuso aparezca recién cuando alguien intente
  // crear una sala o cambiar de cinta. A propósito NO hay modo de emergencia a disco si esto falla:
  // mezclar "a veces disco, a veces R2" según si R2 respondió en ese momento sería más confuso que un
  // error claro al subir. Ver sección "Cloudflare R2 — Fase 2" en MEMORIA.md.
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
