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
const rooms = {}; // roomId -> { videoFile, viewers, hostToken, mutedUsers:Set, userNames:Map(socketId->name) }

function makeRoomId() { return crypto.randomBytes(3).toString('hex'); }

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

app.post('/create-room', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No llegó ningún video' });
  const roomId = makeRoomId();
  const hostToken = crypto.randomBytes(16).toString('hex');
  rooms[roomId] = {
    videoFile: '/uploads/' + req.file.filename,
    viewers: 0,
    hostToken,
    mutedUsers: new Set(),
    userNames: new Map()
  };
  res.json({ roomId, hostToken });
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

app.get('/room/:id', (req, res) => {
  if (!rooms[req.params.id]) return res.status(404).send('Esa sala no existe (o ya se cerró).');
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/api/room/:id', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'not found' });
  res.json({ videoFile: room.videoFile });
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

app.post('/create-room-from-upload', (req, res) => {
  const { filename } = req.body || {};
  if (!isValidUploadFilename(filename)) return res.status(400).json({ error: 'Ese archivo no existe' });
  const roomId = makeRoomId();
  const hostToken = crypto.randomBytes(16).toString('hex');
  rooms[roomId] = {
    videoFile: '/uploads/' + filename,
    viewers: 0,
    hostToken,
    mutedUsers: new Set(),
    userNames: new Map()
  };
  res.json({ roomId, hostToken });
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
    return { id, username: room.userNames.get(id) || 'Anónimo', isHost: !!s.isHost, muted: room.mutedUsers.has(id) };
  });
  io.to(roomId).emit('viewer-list', list);
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomId, username, hostToken }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('room-error', 'La sala no existe.'); return; }

    currentRoom = roomId;
    socket.username = username || 'Anónimo';
    socket.isHost = hostToken && hostToken === room.hostToken;
    socket.join(roomId);

    room.userNames.set(socket.id, socket.username);
    room.viewers++;

    socket.emit('host-status', socket.isHost);
    io.to(roomId).emit('viewer-count', room.viewers);
    socket.to(roomId).emit('chat-message', { system: true, text: `${socket.username} se unió a la sala 🎬` });
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
    if (room.mutedUsers.has(socket.id)) { socket.emit('mute-status', { muted: true }); return; }
    io.to(currentRoom).emit('chat-message', { system: false, user: socket.username, text });
  });

  socket.on('reaction', (emoji) => {
    if (currentRoom) io.to(currentRoom).emit('reaction', emoji);
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
    if (room.mutedUsers.has(targetId)) room.mutedUsers.delete(targetId);
    else room.mutedUsers.add(targetId);
    const target = io.sockets.sockets.get(targetId);
    if (target) target.emit('mute-status', { muted: room.mutedUsers.has(targetId) });
    broadcastViewerList(currentRoom);
  });

  socket.on('disconnect', () => {
    const room = rooms[currentRoom];
    if (room) {
      room.viewers = Math.max(0, room.viewers - 1);
      room.userNames.delete(socket.id);
      room.mutedUsers.delete(socket.id);
      io.to(currentRoom).emit('viewer-count', room.viewers);
      socket.to(currentRoom).emit('chat-message', { system: true, text: `${socket.username || 'Alguien'} salió de la sala` });
      broadcastViewerList(currentRoom);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MovieNight corriendo en http://localhost:${PORT}`));