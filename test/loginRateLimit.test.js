const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeAttemptLimiter } = require('../lib/rateLimiter');
const { rateLimitKeyFromIp } = require('../lib/ipKey');
const { hashPassword, verifyPassword } = require('../lib/passwordAuth');

// Ejecuta el handler de login REAL sin arrancar el servidor ni cargar .env.
// La BD y las callbacks de sesión son dobles; el limitador y bcrypt son reales.
// Normalizar las lecturas permite el mismo test en checkouts LF y CRLF.
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf("app.post('/auth/login',");
assert.notEqual(start, -1);
const end = source.indexOf('\n});', start);
assert.notEqual(end, -1);
const handlerSource = source.slice(start, end + '\n});'.length);
const goodPassword = crypto.randomBytes(24).toString('hex');
const wrongPassword = crypto.randomBytes(24).toString('hex');
const passwordHash = hashPassword(goodPassword);
const knownEmail = 'known@example.invalid';
const absentEmail = 'absent@example.invalid';

async function fixture() {
  const hash = await passwordHash;
  const state = { now: 1_000_000, lookups: 0, failures: 0 };
  let handler;
  vm.runInNewContext(handlerSource, {
    app: { post: (_route, _middleware, fn) => { handler = fn; } },
    requireDbEnabled: () => {},
    db: {
      findUserByEmail: async (email) => {
        state.lookups++;
        const normalized = email.toLowerCase();
        return [knownEmail, 'other@example.invalid'].includes(normalized)
          ? { id: normalized, email: normalized, password_hash: hash } : null;
      },
      getUserAvatarId: async () => null,
    },
    logger: { warn: () => { state.failures++; }, error: () => {} },
    clientIp: (req) => req.ip,
    rateLimitKeyFromIp,
    loginAuthLimiter: makeAttemptLimiter({ now: () => state.now }),
    verifyPassword,
    reportHttpError: () => {},
  });
  async function request(body, ip = '192.0.2.10') {
    const result = { status: 200 };
    const req = { body, ip, session: {
      regenerate: (callback) => callback(null), save: (callback) => callback(null),
    } };
    const res = {
      status: (status) => { result.status = status; return res; },
      json: (value) => { result.body = JSON.parse(JSON.stringify(value)); return res; },
    };
    await handler(req, res);
    return result;
  }
  return { state, request };
}

test('login: respuestas idénticas para email existente e inexistente, incluidos tercer fallo y bloqueo', async () => {
  const { state, request } = await fixture();
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const existing = await request({ email: knownEmail, password: wrongPassword });
    const absent = await request({ email: absentEmail, password: wrongPassword });
    assert.deepEqual(existing, absent, `las respuestas del intento ${i + 1} deben coincidir`);
    statuses.push(existing.status);
    if (i < 2) assert.deepEqual(existing.body, { error: 'Email o contraseña incorrectos.' });
    if (i === 2) assert.deepEqual(existing.body, {
      error: 'Demasiados intentos fallidos. Esperá 15 min y volvé a intentar.',
    });
    if (i === 3) assert.equal(existing.body.lockedMinutes, 15);
  }
  assert.deepEqual(statuses, [401, 401, 429, 429]);
  assert.equal(state.lookups, 6, 'una clave bloqueada no consulta la BD');
  assert.equal(state.failures, 6, 'el cuarto pedido bloqueado no registra otro fallo');
  const correctWhileLocked = await request({ email: knownEmail, password: goodPassword });
  assert.equal(correctWhileLocked.status, 429);
});

test('login: peticiones incompletas no gastan ni reinician el contador', async () => {
  const { state, request } = await fixture();
  await request({ email: knownEmail, password: wrongPassword });
  const lookups = state.lookups;
  for (const body of [undefined, {}, { email: knownEmail }, { email: knownEmail, password: '' },
    { email: knownEmail, password: null }, { email: knownEmail, password: 42 },
    { email: '   ', password: wrongPassword }]) {
    assert.equal((await request(body)).status, 400);
  }
  assert.equal(state.lookups, lookups);
  assert.equal((await request({ email: knownEmail, password: wrongPassword })).status, 401);
  assert.equal((await request({ email: knownEmail, password: wrongPassword })).status, 429);
});

test('login: un éxito limpia fallos y el bloqueo vence a los 15 minutos', async () => {
  const { state, request } = await fixture();
  for (let i = 0; i < 2; i++) assert.equal((await request({ email: knownEmail, password: wrongPassword })).status, 401);
  assert.equal((await request({ email: knownEmail, password: goodPassword })).status, 200);
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await request({ email: knownEmail, password: wrongPassword })).status);
  assert.deepEqual(statuses, [401, 401, 429]);
  state.now += 15 * 60 * 1000 - 1;
  assert.equal((await request({ email: knownEmail, password: goodPassword })).status, 429);
  state.now++;
  assert.equal((await request({ email: knownEmail, password: goodPassword })).status, 200);
});

test('login: conserva normalización de email, aislamiento entre cuentas y prefijo IPv6 /64', async () => {
  const { request } = await fixture();
  const ipA = '2001:db8:1:2::1';
  const ipSamePrefix = '2001:db8:1:2::99';
  assert.equal((await request({ email: knownEmail, password: wrongPassword }, ipA)).status, 401);
  assert.equal((await request({ email: ' KNOWN@example.invalid ', password: wrongPassword }, ipSamePrefix)).status, 401);
  assert.equal((await request({ email: knownEmail, password: wrongPassword }, ipA)).status, 429);
  assert.equal((await request({ email: knownEmail, password: goodPassword }, ipSamePrefix)).status, 429);
  assert.equal((await request({ email: 'other@example.invalid', password: goodPassword }, ipA)).status, 200);
  assert.equal((await request({ email: knownEmail, password: goodPassword }, '2001:db8:1:3::1')).status, 200);
});
