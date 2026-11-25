const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const accessPolicy = require('../lib/accessPolicy');
const { makeAttemptLimiter } = require('../lib/rateLimiter');
const { rateLimitKeyFromIp } = require('../lib/ipKey');
const { hashPassword, verifyPassword } = require('../lib/passwordAuth');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf("  socket.on('join-room', safeSocketHandler(");
const end = source.indexOf('\n  }));', start);
assert.ok(start >= 0 && end > start);
const handlerSource = source.slice(start, end + '\n  }));'.length);
assert.match(handlerSource, /broadcastViewerList\(roomId\)/);
const goodPassword = crypto.randomBytes(24).toString('hex');
const badPassword = crypto.randomBytes(24).toString('hex');
const passwordHash = hashPassword(goodPassword);

// Handler completo real, bcrypt/limitador/política reales. Socket, BD/avatar y persistencia son dobles.
async function fixture({ requireAccount = false } = {}) {
  const hash = await passwordHash;
  const state = { now: 1_000_000, ip: '2001:db8:1:2::1', failures: 0, verified: 0, saved: 0, assigned: 0 };
  const limiter = makeAttemptLimiter({ now: () => state.now });
  const rooms = {};
  for (const id of ['abc123', 'abc124']) rooms[id] = {
    passwordHash: hash, viewers: 0, userNames: new Map(), mutedUserIds: new Set(),
    chatHistory: [], initialVideoAnnounced: true, recentDisconnects: new Map(),
    videoFile: '/uploads/fixture.mp4', videoPosition: { time: 0, paused: true },
  };
  const events = [];
  let handler;
  let connection = 0;
  const socket = {
    id: 'qa-socket', connected: true, disconnected: false, request: { session: {} },
    on: (_event, fn) => { handler = fn; }, emit: (...args) => events.push(args),
    join() {}, to: () => ({ emit() {} }),
  };
  // Cada petición representa una conexión nueva; el contador por IP+sala y la sesión se comparten.
  // Una conexión ya admitida no se reutiliza artificialmente para entrar después en otra sala/IP.
  function connectAttempt() {
    vm.runInNewContext('let currentRoom = null;\n' + handlerSource, {
      socket: { ...socket, id: 'qa-socket-' + ++connection }, rooms, accessPolicy, rateLimitKeyFromIp, roomJoinAuthLimiter: limiter,
      safeSocketHandler: (_name, fn) => fn,
      settings: { getSetting: (key) => key === 'REQUIRE_ACCOUNT_TO_JOIN' && requireAccount },
      socketClientIp: () => state.ip,
      verifyPassword: async (...args) => { state.verified++; return verifyPassword(...args); }, hashPassword,
      logger: { warn: () => { state.failures++; } },
      roomStore: { saveRoom: () => { state.saved++; } },
      getSocketAvatarId: async () => null,
      pushChatHistory: (room, message) => room.chatHistory.push(message),
      videoDisplayName: (file) => file,
      io: { to: () => ({ emit() {} }) },
      assignHostOnJoin: () => { state.assigned++; }, broadcastViewerList() {}, roomHasConnectedUser: () => false, clearTimeout,
    });
  }
  return {
    state, rooms, socket, limiter,
    async join(fields = {}) {
      events.length = 0;
      connectAttempt();
      await handler({ roomId: 'abc123', username: 'QA', userId: 'qa-user', ...fields });
      const result = events.find(([name]) => ['room-error', 'room-data'].includes(name));
      assert.ok(result, 'el handler debe responder');
      return JSON.parse(JSON.stringify(result));
    },
  };
}

test('sala: contraseña omitida, null o vacía no consume intentos ni permite entrar', async () => {
  const f = await fixture();
  for (const fields of [{}, { password: null }, { password: '' }, {}, { password: '' }]) {
    const reply = await f.join(fields);
    assert.equal(reply[0], 'room-error');
    assert.equal(f.limiter.attemptsLeft('2001:db8:1:2::/64:abc123'), 3);
    assert.equal(reply[2]?.code, 'ROOM_PASSWORD_REQUIRED');
    assert.equal(reply[2].attemptsLeft, 3);
    assert.match(reply[1], /Te quedan 3 intento/);
    assert.equal(f.rooms.abc123.viewers, 0);
    assert.equal(f.rooms.abc123.userNames.size, 0);
    assert.equal(f.state.assigned, 0);
    assert.equal(f.state.saved, 0);
  }
  assert.equal(f.state.failures, 0);
  assert.equal((await f.join({ password: goodPassword }))[0], 'room-data');
});

test('sala: vacíos entre fallos no gastan ni reinician intentos; el tercero bloquea', async () => {
  const f = await fixture();
  assert.equal((await f.join({ password: badPassword }))[2]?.attemptsLeft, 2);
  for (const password of ['', null, undefined]) {
    assert.equal((await f.join({ password }))[2].attemptsLeft, 2);
  }
  assert.equal((await f.join({ password: badPassword }))[2].attemptsLeft, 1);
  const third = await f.join({ password: badPassword });
  assert.deepEqual(third[2], { code: 'ROOM_PASSWORD_LOCKED', attemptsLeft: 0, lockedMinutes: 15 });
  assert.match(third[1], /15 minutos/);
  assert.equal(f.state.failures, 3);
  assert.equal(f.rooms.abc123.viewers, 0);
});

test('sala: el bloqueo rechaza también correcta/vacía, sin verificar ni sumar fallos; vence en 15 min', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.join({ password: badPassword });
  const verified = f.state.verified;
  f.state.now += 14 * 60 * 1000;
  for (const password of [goodPassword, '', null]) {
    const reply = await f.join({ password });
    assert.deepEqual(reply[2], { code: 'ROOM_PASSWORD_LOCKED', attemptsLeft: 0, lockedMinutes: 1 });
    assert.match(reply[1], /Esperá 1 min/);
  }
  assert.equal(f.state.verified, verified);
  assert.equal(f.state.failures, 3);
  f.state.now += 60 * 1000;
  assert.equal((await f.join({ password: goodPassword }))[0], 'room-data');
});

test('sala: éxito reinicia el contador y los espacios siguen siendo intentos', async () => {
  const f = await fixture();
  for (const password of [' ', badPassword]) await f.join({ password });
  assert.equal((await f.join({ password: goodPassword }))[0], 'room-data');
  assert.equal((await f.join({ password: badPassword }))[2]?.attemptsLeft, 2);
});

test('sala: conserva aislamiento por sala y prefijo IPv6 /64', async () => {
  const f = await fixture();
  await f.join({ password: badPassword });
  f.state.ip = '2001:db8:1:2::99';
  assert.equal((await f.join({ password: badPassword }))[2]?.attemptsLeft, 1);
  await f.join({ password: badPassword });
  assert.equal((await f.join({ roomId: 'abc124', password: goodPassword }))[0], 'room-data');
  f.state.ip = '2001:db8:1:3::1';
  assert.equal((await f.join({ password: goodPassword }))[0], 'room-data');
});

test('sala: exigir cuenta corta antes del limitador y una sala abierta no pide contraseña', async () => {
  const f = await fixture({ requireAccount: true });
  const rejected = await f.join({ password: badPassword });
  assert.equal(rejected[2].code, 'ACCOUNT_REQUIRED');
  assert.equal(f.state.verified, 0);
  assert.equal(f.state.failures, 0);
  f.socket.request.session.userId = 'qa-account';
  f.rooms.abc123.passwordHash = null;
  assert.equal((await f.join())[0], 'room-data');
  assert.equal(f.state.verified, 0);
});

test('sala: una contraseña correcta de una sala antigua se migra y persiste con bcrypt', async () => {
  const f = await fixture();
  f.rooms.abc123.passwordHash = crypto.createHash('sha256').update(goodPassword).digest('hex');
  assert.equal((await f.join({ password: goodPassword }))[0], 'room-data');
  assert.match(f.rooms.abc123.passwordHash, /^\$2/);
  assert.equal((await verifyPassword(goodPassword, f.rooms.abc123.passwordHash)).valid, true);
  assert.equal(f.state.saved, 1);
  assert.equal(f.state.failures, 0);
});
