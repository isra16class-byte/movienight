const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'room.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf("socket.on('room-error',");
const end = source.indexOf('\n});', start);
assert.ok(start >= 0 && end > start);
const handlerSource = source.slice(start, end + '\n});'.length);
const promptStart = source.indexOf('function mnPrompt(');
const promptEnd = source.indexOf('\n}\n', promptStart);
assert.ok(promptStart >= 0 && promptEnd > promptStart);
const promptSource = source.slice(promptStart, promptEnd + 3);

// Listener y helper mnPrompt reales; diálogo, Socket.IO y navegación simulados, sin navegador.
function fixture(answer = crypto.randomBytes(24).toString('hex')) {
  const state = { prompts: [], alerts: [], emitted: [], logins: 0 };
  const location = { href: '/room/abc123' };
  let handler;
  vm.runInNewContext('let roomPassword = null;\n' + promptSource + handlerSource, {
    roomId: 'abc123', username: 'QA', hostToken: null, myUserId: 'qa-user', location,
    socket: { on: (_event, fn) => { handler = fn; }, emit: (...args) => state.emitted.push(args) },
    mnDialog: async (options) => { state.prompts.push(options); return answer; },
    mnAlert: async (...args) => { state.alerts.push(args); },
    goToLoginForRoom: async () => { state.logins++; },
  });
  return { state, location, answer, error: handler };
}

test('sala UI: muestra los intentos del servidor en el prompt y reenvía la nueva contraseña', async () => {
  for (const attemptsLeft of [2, 1]) {
    const f = fixture();
    const message = `Contraseña incorrecta. Te quedan ${attemptsLeft} intento(s).`;
    await f.error(message, { code: 'ROOM_PASSWORD_INCORRECT', attemptsLeft });
    assert.equal(f.state.prompts[0].message, message);
    assert.equal(f.state.prompts[0].inputType, 'password');
    assert.equal(f.state.emitted.length, 1);
    assert.equal(f.state.emitted[0][0], 'join-room');
    assert.equal(f.state.emitted[0][1].password, f.answer);
  }
});

test('sala UI: contraseña requerida muestra el contador sin perder el mensaje', async () => {
  const f = fixture(null);
  const message = 'Contraseña de sala requerida. Te quedan 3 intento(s).';
  await f.error(message, { code: 'ROOM_PASSWORD_REQUIRED', attemptsLeft: 3 });
  assert.equal(f.state.prompts[0].message, message);
  assert.equal(f.state.emitted.length, 0);
  assert.equal(f.location.href, '/');
});

test('sala UI: al tercer fallo muestra el bloqueo sin pedir ni reenviar otra contraseña', async () => {
  const f = fixture();
  const message = 'Contraseña incorrecta. Se bloquearon los intentos por 15 minutos.';
  await f.error(message, { code: 'ROOM_PASSWORD_LOCKED', attemptsLeft: 0, lockedMinutes: 15 });
  assert.equal(f.state.prompts.length, 0);
  assert.equal(f.state.emitted.length, 0);
  assert.equal(f.state.alerts[0][0], message);
  assert.equal(f.location.href, '/');
});

test('sala UI: bloqueo vigente muestra el tiempo restante y vuelve al inicio', async () => {
  const f = fixture();
  const message = 'Demasiados intentos fallidos. Esperá 4 min y volvé a intentar.';
  await f.error(message, { code: 'ROOM_PASSWORD_LOCKED', attemptsLeft: 0, lockedMinutes: 4 });
  assert.equal(f.state.prompts.length, 0);
  assert.equal(f.state.alerts[0][0], message);
  assert.equal(f.location.href, '/');
});

test('sala UI: mantiene la prioridad del login requerido y los errores antiguos sin metadatos', async () => {
  const login = fixture();
  await login.error('Iniciá sesión.', { code: 'ACCOUNT_REQUIRED' });
  assert.equal(login.state.logins, 1);
  assert.equal(login.state.prompts.length, 0);
  assert.equal(login.state.alerts.length, 0);
  const legacy = fixture(null);
  const message = 'Contraseña incorrecta. Te quedan 2 intento(s).';
  await legacy.error(message);
  assert.equal(legacy.state.prompts[0].message, message);
  assert.equal(legacy.state.emitted.length, 0);
});
