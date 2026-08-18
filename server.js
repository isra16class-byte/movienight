const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Salas en memoria
// roomId -> { videoFile, subtitleFile, viewers, hostToken, passwordHash,
//             mutedUserIds:Set<userId>, userNames:Map(socketId->name),
//             bufferingSockets:Set<socketId>, recentDisconnects:Map(userId->{timer,username}) }
const rooms = {};

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
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 * 1024 } });

// Subtítulos: se leen en memoria para poder convertir .srt -> .vtt antes de guardar
const subtitleUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v'];

// Convierte "abc123__Mi Pelicula.mp4" -> "Mi Pelicula.mp4" para mostrar en la biblioteca.
// Los archivos subidos antes de este cambio no tienen el separador "__", se muestran con su nombre tal cual (el hash).
function displayNameFor(filename) {
  const idx = filename.indexOf('__');
  return idx >= 0 ? filename.slice(idx + 2) : filename;
}

// Evita path traversal: el nombre no puede contener separadores de ruta y debe existir tal cual dentro de UPLOAD_DIR.
function isValidUploadFilename(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename !== path.basename(filename)) return false;
  if (filename.includes('..')) return false;
  return fs.existsSync(path.join(UPLOAD_DIR, filename));
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
    passwordHash: password ? hashPassword(password) : null,
    mutedUserIds: new Set(),
    userNames: new Map(),
    bufferingSockets: new Set(),
    recentDisconnects: new Map()
  };
}

app.post('/create-room', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No llegó ningún video' });
  const roomId = makeRoomId();
  const room = makeRoom('/uploads/' + req.file.filename, (req.body.password || '').trim());
  rooms[roomId] = room;
  res.json({ roomId, hostToken: room.hostToken });
});

app.post('/create-room-from-upload', (req, res) => {
  const { filename, password } = req.body || {};
  if (!isValidUploadFilename(filename)) return res.status(400).json({ error: 'Ese archivo no existe' });
  const roomId = makeRoomId();
  const room = makeRoom('/uploads/' + filename, (password || '').trim());
  rooms[roomId] = room;
  res.json({ roomId, hostToken: room.hostToken });
});

app.post('/room/:id/change-video', upload.single('video'), (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Sala no existe' });
  if (req.body.hostToken !== room.hostToken) return res.status(403).json({ error: 'No autorizado' });
  if (!req.file) return res.status(400).json({ error: 'No llegó ningún video' });
  room.videoFile = '/uploads/' + req.file.filename;
  io.to(req.params.id).emit('video-changed', { videoFile: room.videoFile });
  res.json({ ok: true });
});

// Cambiar la cinta de una sala ya existente reutilizando un video de la biblioteca (sin resubir nada)
app.post('/room/:id/change-video-from-upload', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Sala no existe' });
  const { filename, hostToken } = req.body || {};
  if (hostToken !== room.hostToken) return res.status(403).json({ error: 'No autorizado' });
  if (!isValidUploadFilename(filename)) return res.status(400).json({ error: 'Ese archivo no existe' });
  room.videoFile = '/uploads/' + filename;
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

app.get('/api/uploads', (req, res) => {
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

app.delete('/api/uploads/:filename', (req, res) => {
  const { filename } = req.params;
  if (!isValidUploadFilename(filename)) return res.status(400).json({ error: 'Ese archivo no existe' });
  fs.unlink(path.join(UPLOAD_DIR, filename), (err) => {
    if (err) return res.status(500).json({ error: 'No se pudo borrar el archivo' });
    res.json({ ok: true });
  });
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
    socket.isHost = !!(hostToken && hostToken === room.hostToken);
    socket.join(roomId);

    room.userNames.set(socket.id, socket.username);
    room.viewers++;

    const wasMuted = room.mutedUserIds.has(socket.userId);

    // Reconexión rápida (ej. wifi que se cae un segundo): no repetir "se unió a la sala"
    const recent = room.recentDisconnects.get(socket.userId);
    if (recent) {
      clearTimeout(recent.timer);
      room.recentDisconnects.delete(socket.userId);
    } else {
      socket.to(roomId).emit('chat-message', { system: true, text: `${socket.username} se unió a la sala 🎬` });
    }

    socket.emit('host-status', { isHost: socket.isHost, hostToken: socket.isHost ? room.hostToken : null });
    socket.emit('room-data', { videoFile: room.videoFile, subtitleFile: room.subtitleFile });
    if (wasMuted) socket.emit('mute-status', { muted: true });

    io.to(roomId).emit('viewer-count', room.viewers);
    broadcastViewerList(roomId);
  });

  // Solo el host puede mover el video
  socket.on('sync', (data) => {
    if (!socket.isHost || !currentRoom) return;
    socket.to(currentRoom).emit('sync', data);
  });

  socket.on('chat-message', (text) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (room.mutedUserIds.has(socket.userId)) { socket.emit('mute-status', { muted: true }); return; }
    if (typeof text !== 'string' || !text.trim()) return;
    io.to(currentRoom).emit('chat-message', { system: false, user: socket.username, text: text.slice(0, 500) });
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
    if (!target) return;
    target.isHost = true;
    target.emit('host-status', { isHost: true, hostToken: room.hostToken });
    io.to(currentRoom).emit('chat-message', { system: true, text: `🎛 ${socket.username} le pasó el control remoto a ${target.username}` });
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
      io.to(currentRoom).emit('chat-message', { system: true, text: `${username} salió de la sala` });
    }, RECONNECT_GRACE_MS);
    room.recentDisconnects.set(userId, { timer, username });

    // Traspaso automático: si el que se fue era el único host conectado, el siguiente en la sala toma el control
    if (socket.isHost) {
      const stillConnected = io.sockets.adapter.rooms.get(currentRoom);
      const stillHasHost = stillConnected && [...stillConnected].some(id => io.sockets.sockets.get(id)?.isHost);
      if (stillConnected && stillConnected.size > 0 && !stillHasHost) {
        const next = io.sockets.sockets.get([...stillConnected][0]);
        if (next) {
          next.isHost = true;
          next.emit('host-status', { isHost: true, hostToken: room.hostToken });
          io.to(currentRoom).emit('chat-message', { system: true, text: `🎛 ${next.username || 'Alguien'} ahora tiene el control remoto (el host anterior se desconectó)` });
          broadcastViewerList(currentRoom);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MovieNight corriendo en http://localhost:${PORT}`));
