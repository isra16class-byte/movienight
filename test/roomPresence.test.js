const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const accessPolicy = require('../lib/accessPolicy');
const hostAuth = require('../lib/hostAuth');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
function handler(name) {
  const start = source.indexOf(`  socket.on('${name}', safeSocketHandler(`);
  const end = source.indexOf('\n  }));', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end + '\n  }));'.length);
}
function optionalFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start);
  return source.slice(start, end + 3);
}
const handlers = handler('join-room') + '\n' + handler('disconnect');
const helpers = optionalFunction('roomHasConnectedUser') + optionalFunction('broadcastViewerList');

// Handlers y reglas de host/acceso reales; transporte, avatar, reloj y persistencia simulados.
function fixture() {
  const rooms = {}, events = [], saved = [], timers = new Map();
  let now = 100000, nextTimer = 0, nextSocket = 0;
  let lookup = async () => null;
  const io = {
    sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
    to: (roomId) => ({ emit: (...args) => events.push({ roomId, args }) }),
  };
  function makeRoom(roomId = 'abc001') {
    const room = {
      viewers: 0, emptySince: now, hostToken: crypto.randomBytes(24).toString('hex'),
      hostSocketId: null, ownerUserId: null, passwordHash: null,
      userNames: new Map(), mutedUserIds: new Set(), bufferingSockets: new Set(),
      recentDisconnects: new Map(), chatHistory: [], initialVideoAnnounced: true,
      videoFile: '/uploads/fixture.mp4', videoPosition: { time: 0, paused: true },
    };
    rooms[roomId] = room;
    return room;
  }
  makeRoom(); makeRoom('abc002');
  function connect(userId = 'qa-user') {
    const callbacks = {}, emitted = [];
    const socket = {
      id: 'qa-socket-' + ++nextSocket, connected: true, disconnected: false,
      request: { session: {} }, on: (event, fn) => { callbacks[event] = fn; },
      emit: (...args) => emitted.push(args), to: (roomId) => io.to(roomId),
      join: (roomId) => {
        if (socket.disconnected) return;
        let members = io.sockets.adapter.rooms.get(roomId);
        if (!members) { members = new Set(); io.sockets.adapter.rooms.set(roomId, members); }
        members.add(socket.id);
      },
    };
    io.sockets.sockets.set(socket.id, socket);
    vm.runInNewContext(helpers + '\nlet currentRoom = null;\n' + handlers, {
      socket, rooms, io, accessPolicy, RECONNECT_GRACE_MS: 15000,
      safeSocketHandler: (_event, fn) => fn,
      settings: { getSetting: (key) => key !== 'REQUIRE_ACCOUNT_TO_JOIN' },
      rateLimitKeyFromIp: (ip) => ip, socketClientIp: () => '192.0.2.10',
      roomJoinAuthLimiter: { lockedMinutes: () => null, recordSuccess() {} },
      getSocketAvatarId: (s) => lookup(s),
      pushChatHistory: (room, message) => room.chatHistory.push(message),
      videoDisplayName: (file) => file, logger: { error() {}, warn() {} },
      roomStore: { saveRoom: (id) => saved.push(id) },
      isRoomOwner: hostAuth.isRoomOwner, assignHostOnJoin: hostAuth.assignHostOnJoin,
      setHost: (room, id, s) => hostAuth.setHost(io, room, id, s),
      Date: { now: () => now },
      setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
      clearTimeout: (id) => timers.delete(id),
    });
    return {
      socket, emitted,
      join: (roomId = 'abc001') => callbacks['join-room']({ roomId, userId, username: 'QA', hostToken: rooms[roomId]?.hostToken }),
      disconnect: () => {
        socket.connected = false; socket.disconnected = true;
        for (const [id, members] of io.sockets.adapter.rooms) {
          members.delete(socket.id); if (!members.size) io.sockets.adapter.rooms.delete(id);
        }
        io.sockets.sockets.delete(socket.id);
        return callbacks.disconnect();
      },
    };
  }
  function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.fn(); }
    }
  }
  const count = (room, text) => room.chatHistory.filter(m => m.text.includes(text)).length;
  return { rooms, io, events, saved, timers, makeRoom, connect, advance, count,
    setLookup: (fn) => { lookup = fn; } };
}

test('presencia: join repetido es idempotente y desconectar deja cero espectadores', async () => {
  const f = fixture(), c = f.connect(), room = f.rooms.abc001;
  await c.join(); await c.join();
  assert.equal(room.viewers, 1);
  assert.equal(room.userNames.size, 1);
  assert.equal(f.count(room, 'se unió'), 1);
  c.disconnect();
  assert.equal(room.viewers, 0);
  assert.equal(room.userNames.size, 0);
  assert.equal(f.io.sockets.adapter.rooms.has('abc001'), false);
});

test('presencia: dos entradas concurrentes del mismo socket se admiten una sola vez', async () => {
  const f = fixture(), c = f.connect();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.setLookup(async () => { await gate; return null; });
  const first = c.join(), second = c.join(); release();
  await Promise.all([first, second]);
  assert.equal(f.rooms.abc001.viewers, 1);
  assert.equal(f.count(f.rooms.abc001, 'se unió'), 1);
});

test('presencia: desconexión durante la validación no crea espectador, nombre ni host fantasma', async () => {
  const f = fixture(), c = f.connect();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.setLookup(async () => { await gate; return null; });
  const entering = c.join(); c.disconnect(); release(); await entering;
  const room = f.rooms.abc001;
  assert.equal(room.viewers, 0);
  assert.equal(room.userNames.size, 0);
  assert.equal(room.hostSocketId, null);
  assert.equal(room.chatHistory.length, 0);
});

test('presencia: una sala cerrada o reemplazada mientras valida no admite la entrada pendiente', async () => {
  for (const replace of [false, true]) {
    const f = fixture(), c = f.connect(), oldRoom = f.rooms.abc001;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    f.setLookup(async () => { await gate; return null; });
    const entering = c.join(); delete f.rooms.abc001;
    if (replace) f.makeRoom();
    release(); await entering;
    assert.equal(oldRoom.viewers, 0);
    assert.equal(oldRoom.userNames.size, 0);
    assert.equal(c.emitted.some(([event, message]) => event === 'room-error' && message === 'La sala no existe.'), true);
    if (replace) assert.equal(f.rooms.abc001.viewers, 0);
  }
});

test('presencia: reconexión solapada no duplica avisos ni anuncia salida mientras queda otra pestaña', async () => {
  const f = fixture(), old = f.connect(), current = f.connect(), room = f.rooms.abc001;
  await old.join(); await current.join();
  assert.equal(room.viewers, 2, 'las conexiones siguen contándose por separado');
  assert.equal(room.userNames.size, 2);
  assert.equal(f.count(room, 'se unió'), 1);
  room.mutedUserIds.add('qa-user');
  old.disconnect(); f.advance(15000);
  assert.equal(f.count(room, 'salió de la sala'), 0);
  assert.equal(room.mutedUserIds.has('qa-user'), true);
  assert.equal(room.viewers, 1);
  current.disconnect(); f.advance(15000);
  assert.equal(f.count(room, 'salió de la sala'), 1);
  assert.equal(room.mutedUserIds.has('qa-user'), false);
  assert.equal(room.viewers, 0);
});

test('presencia: conserva la gracia de reconexión ordenada y vuelve a anunciar después de vencer', async () => {
  const f = fixture(), old = f.connect(), room = f.rooms.abc001;
  await old.join(); old.disconnect(); f.advance(10000);
  const current = f.connect(); await current.join(); f.advance(15000);
  assert.equal(f.count(room, 'se unió'), 1);
  assert.equal(f.count(room, 'salió de la sala'), 0);
  current.disconnect(); f.advance(15000);
  assert.equal(f.count(room, 'salió de la sala'), 1);
  const later = f.connect(); await later.join();
  assert.equal(f.count(room, 'se unió'), 2);
});

test('presencia: otra identidad se anuncia y un mismo socket no puede acumular salas', async () => {
  const f = fixture(), first = f.connect(), second = f.connect('qa-other');
  await first.join(); await second.join();
  assert.equal(f.count(f.rooms.abc001, 'se unió'), 2);
  await first.join('abc002');
  assert.equal(f.rooms.abc002.viewers, 0);
  assert.equal(first.emitted.some(([event]) => event === 'room-error'), true);
  first.disconnect(); second.disconnect();
  assert.equal(f.rooms.abc001.viewers, 0);
});

test('presencia: un timer de salida no guarda ni resucita una sala que ya fue cerrada', async () => {
  const f = fixture(), c = f.connect();
  await c.join(); c.disconnect(); delete f.rooms.abc001;
  const saves = f.saved.length; f.advance(15000);
  assert.equal(f.saved.length, saves);
});

test('presencia: un callback viejo ya encolado no consume la gracia de una salida nueva', async () => {
  const f = fixture(), old = f.connect(), room = f.rooms.abc001;
  await old.join(); old.disconnect();
  const obsolete = [...f.timers.values()][0].fn;
  const current = f.connect(); await current.join(); current.disconnect();
  obsolete();
  assert.equal(f.count(room, 'salió de la sala'), 0);
  assert.equal(room.recentDisconnects.size, 1);
  f.advance(15000);
  assert.equal(f.count(room, 'salió de la sala'), 1);
});

test('presencia: repetir una entrada no vuelve a asignar el control que ya tiene otro socket', async () => {
  const f = fixture(), first = f.connect(), current = f.connect('qa-other'), room = f.rooms.abc001;
  await first.join(); await current.join();
  assert.equal(room.hostSocketId, current.socket.id);
  await first.join();
  assert.equal(room.hostSocketId, current.socket.id);
  assert.equal(current.socket.isHost, true);
  assert.equal(first.socket.isHost, false);
});
