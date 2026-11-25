// Reproducción de docs/AUDITORIA-LIMITADORES.md. Ejecutar con node scripts/audit-limiters.js.
// Salida 0 = observaciones reproducidas, NO significa ausencia de hallazgos de seguridad.
// Diagnóstico local: no modifica server.js, no carga .env y no envía emails.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { Module, createRequire } = require('node:module');
const os = require('node:os');
const repo = path.resolve(__dirname, '..');
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'movienight-limiter-audit-'));
const fromRepo = createRequire(path.join(repo, 'server.js'));
for (const key of Object.keys(process.env)) {
  if (!/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT)$/i.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  DISABLE_REDIS: '1', DATABASE_URL: '', SESSION_COOKIE_INSECURE: '1', LOG_LEVEL: 'silent',
  LIBRARY_PASSWORD: crypto.randomBytes(24).toString('hex'),
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'), PORT: '3113'
});
const data = { lookups: 0, resets: 0, emails: 0 };
const goodPassword = crypto.randomBytes(24).toString('hex');
const badPassword = crypto.randomBytes(24).toString('hex');
const roomPassword = crypto.randomBytes(24).toString('hex');
const bcrypt = fromRepo('bcryptjs');
const userHash = bcrypt.hashSync(goodPassword, 10);
const fakeDb = {
  isEnabled: () => true,
  testConnection: async () => {}, runMigrations: async () => {},
  findUserByEmail: async (email) => {
    data.lookups++;
    return email.toLowerCase().startsWith('audit-known-')
      ? { id: 'audit-user', email: email.toLowerCase(), password_hash: userHash } : null;
  },
  getUserAvatarId: async () => null,
  createPasswordReset: async () => { data.resets++; },
  findValidPasswordReset: async () => null
};
const fakeMailer = { isEnabled: () => true, sendPasswordResetEmail: async () => { data.emails++; } };
let httpServer;
const testHttp = { ...http, createServer: (...args) => {
  httpServer = http.createServer(...args);
  const listen = httpServer.listen.bind(httpServer);
  httpServer.listen = (_port, callback) => listen(0, '127.0.0.1', callback);
  return httpServer;
} };
const loaded = new Module(path.join(runtimeDir, 'server-under-audit.cjs'), module);
loaded.filename = path.join(runtimeDir, 'server-under-audit.cjs');
loaded.paths = Module._nodeModulePaths(repo);
loaded.require = (id) => {
  if (id === './lib/logger') return { ...fromRepo('./lib/logger'), fatal: (entry, message) => {
    process.stderr.write(JSON.stringify({ fatal: message || entry, error: entry?.err?.message }) + '\n');
  } };
  if (id === './lib/db') return fakeDb;
  if (id === './lib/mailer') return fakeMailer;
  if (id === 'http') return testHttp;
  return fromRepo(id);
};
// Solo se añade acceso a las funciones/estado para observarlos en esta corrida.
// La lógica de las rutas y de los limitadores se compila tal como está en el checkout.
loaded._compile(fs.readFileSync(path.join(repo, 'server.js'), 'utf8') +
  '\nmodule.exports = { io, rooms, makeRoom, isResetRequestRateLimited, resetRequestTimestamps };', loaded.filename);
const app = loaded.exports;
const sockets = [];
const observations = {};
async function post(base, route, body, ip = '192.0.2.10') {
  const response = await fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Cf-Connecting-Ip': ip },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
  });
  return { status: response.status, body: await response.json() };
}
async function socketClient(base) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
  sockets.push(ws);
  const queue = [];
  let pending;
  let readyResolve;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    ws.addEventListener('error', () => reject(new Error('Socket local no disponible')), { once: true });
  });
  ws.addEventListener('message', ({ data: payload }) => {
    const message = String(payload);
    if (message.startsWith('0')) ws.send('40');
    else if (message === '2') ws.send('3');
    else if (message.startsWith('40')) readyResolve();
    else if (message.startsWith('42')) {
      const event = JSON.parse(message.slice(2));
      if (!['room-error', 'room-data'].includes(event[0])) return;
      if (pending) { const deliver = pending; pending = null; deliver(event); }
      else queue.push(event);
    }
  });
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout conexión')), 5000))]);
  return { join: async (roomId, fields) => {
    const reply = new Promise((resolve, reject) => {
      if (queue.length) return resolve(queue.shift());
      const timer = setTimeout(() => { pending = null; reject(new Error('Timeout join-room')); }, 5000);
      pending = (event) => { clearTimeout(timer); resolve(event); };
    });
    ws.send('42' + JSON.stringify(['join-room', { roomId, username: 'Auditoría local', userId: crypto.randomUUID(), ...fields }]));
    return reply;
  } };
}
async function main() {
  if (!httpServer.listening) await new Promise((resolve) => httpServer.once('listening', resolve));
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  const email = 'audit-known-empty@example.invalid';
  const emptyLogin = [];
  for (const body of [{}, { email }, { email, password: '' }, { email, password: null },
    { email, password: 2 }, { email: '   ', password: badPassword }]) {
    emptyLogin.push((await post(base, '/auth/login', body)).status);
  }
  assert.deepEqual(emptyLogin, [400, 400, 400, 400, 400, 400]);
  assert.equal(data.lookups, 0);
  const afterEmpty = await post(base, '/auth/login', { email, password: goodPassword });
  assert.equal(afterEmpty.status, 200);
  observations.loginEmpty = { statuses: emptyLogin, validAfterEmpty: afterEmpty.status };
  const existing = [], absent = [];
  for (let i = 0; i < 4; i++) {
    existing.push((await post(base, '/auth/login', { email: 'audit-known-enum@example.invalid', password: badPassword })).status);
    absent.push((await post(base, '/auth/login', { email: 'audit-absent-enum@example.invalid', password: badPassword })).status);
  }
  assert.deepEqual(existing, [401, 401, 429, 429]);
  assert.deepEqual(absent, [401, 401, 401, 429]);
  observations.loginEnumeration = { existing, absent };
  const rotatedLogin = await post(base, '/auth/login', { email: 'audit-known-enum@example.invalid', password: goodPassword }, '192.0.2.11');
  assert.equal(rotatedLogin.status, 200);
  observations.loginOtherIp = { afterLockAtFirstIp: rotatedLogin.status };
  const resetEmpty = [];
  const mapSize = app.resetRequestTimestamps.size;
  for (const body of [{}, { email: '' }, { email: null }, { email: '  ' }, { email: 2 }]) {
    resetEmpty.push((await post(base, '/auth/forgot-password', body)).status);
  }
  assert.deepEqual(resetEmpty, [400, 400, 400, 400, 400]);
  assert.equal(app.resetRequestTimestamps.size, mapSize);
  const beforeReset = { ...data }, resetReplies = [];
  for (let i = 0; i < 4; i++) {
    resetReplies.push(await post(base, '/auth/forgot-password', { email: 'audit-known-reset@example.invalid' }));
  }
  assert.ok(resetReplies.every((r) => r.status === 200));
  assert.ok(resetReplies.every((r) => JSON.stringify(r.body) === JSON.stringify(resetReplies[0].body)));
  assert.equal(data.resets - beforeReset.resets, 3);
  assert.equal(data.emails - beforeReset.emails, 3);
  observations.reset = { emptyStatuses: resetEmpty, statuses: resetReplies.map((r) => r.status),
    generatedResets: data.resets - beforeReset.resets, simulatedEmails: data.emails - beforeReset.emails };
  const beforeRotate = data.emails;
  await post(base, '/auth/forgot-password', { email: 'audit-known-reset@example.invalid' }, '192.0.2.11');
  assert.equal(data.emails - beforeRotate, 1);
  observations.resetOtherIp = { extraSimulatedEmails: data.emails - beforeRotate };
  const absentBefore = { ...data }, absentResets = [];
  for (let i = 0; i < 4; i++) absentResets.push(await post(base, '/auth/forgot-password', { email: 'audit-absent-reset@example.invalid' }));
  assert.ok(absentResets.every((r) => JSON.stringify(r) === JSON.stringify(resetReplies[0])));
  observations.resetAbsent = { statuses: absentResets.map((r) => r.status),
    lookups: data.lookups - absentBefore.lookups, generatedResets: data.resets - absentBefore.resets };
  const originalNow = Date.now;
  let now = originalNow();
  try {
    Date.now = () => now;
    const key = 'audit-window';
    const limited = Array.from({ length: 4 }, () => app.isResetRequestRateLimited(key));
    now += 60 * 60 * 1000;
    limited.push(app.isResetRequestRateLimited(key));
    assert.deepEqual(limited, [false, false, false, true, false]);
    observations.resetWindow = { limited, clock: 'controlado, frontera de 1 hora' };
  } finally { Date.now = originalNow; }
  const roomId = 'abc123';
  app.rooms[roomId] = await app.makeRoom('/uploads/audit-fixture.mp4', roomPassword, null);
  const emptySocket = await socketClient(base);
  const emptyRoom = [];
  for (const fields of [{}, { password: '' }, { password: null }, { password: roomPassword }]) {
    const event = await emptySocket.join(roomId, fields);
    assert.equal(event[0], 'room-error');
    emptyRoom.push(event[1]);
  }
  assert.match(emptyRoom[0], /quedan 2/);
  assert.match(emptyRoom[1], /quedan 1/);
  assert.match(emptyRoom[2], /15 minutos/);
  assert.match(emptyRoom[3], /Esperá 15 min/);
  observations.roomEmpty = emptyRoom;
  const otherId = 'abc124';
  app.rooms[otherId] = await app.makeRoom('/uploads/audit-fixture.mp4', roomPassword, null);
  for (let i = 0; i < 5; i++) {
    const response = await fetch(base + '/api/room/' + otherId);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).passwordProtected, true);
  }
  const otherSocket = await socketClient(base);
  const firstFailure = await otherSocket.join(otherId, { password: badPassword });
  assert.match(firstFailure[1], /quedan 2/);
  const goodJoin = await otherSocket.join(otherId, { password: roomPassword });
  assert.equal(goodJoin[0], 'room-data');
  observations.roomDiscovery = { gets: 5, firstWrong: firstFailure[1], validJoin: goodJoin[0] };
  const invalidReset = await post(base, '/auth/reset-password', { token: crypto.randomBytes(32).toString('hex'), password: goodPassword });
  assert.equal(invalidReset.status, 400);
  observations.resetInvalidToken = { status: invalidReset.status, error: invalidReset.body.error };
  process.stdout.write(JSON.stringify({ isolation: '127.0.0.1; .env no leído; Postgres y email simulados; Redis/R2 deshabilitados; HTTP y Socket.IO reales', observations }, null, 2) + '\n');
}
const watchdog = setTimeout(() => { process.stderr.write('Auditoría agotó 40 segundos\n'); process.exit(1); }, 40000);
main().then(() => { clearTimeout(watchdog); for (const ws of sockets) ws.close(); app.io.close(); process.exit(0); })
  .catch((err) => { process.stderr.write(err.name + ': ' + err.message + '\n'); process.exit(1); });
