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

// Salas en memoria
const rooms = {}; // roomId -> { videoFile, viewers, hostToken, mutedUsers:Set, userNames:Map(socketId->name) }

function makeRoomId() { return crypto.randomBytes(3).toString('hex'); }

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString('hex') + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 * 1024 } });

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