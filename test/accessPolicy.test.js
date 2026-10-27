const test = require('node:test');
const assert = require('node:assert/strict');
const { accountRequiringSwitches, validateAccessPolicy, roomCreationBlock } = require('../lib/accessPolicy');

// getSetting de mentira: valores por clave, con el default "abierto" (todo permitido) para lo no listado.
const makeGet = (values = {}) => (key) => (key in values ? values[key] : true);

test('accountRequiringSwitches: con los defaults ningún interruptor exige cuenta', () => {
  assert.deepEqual(accountRequiringSwitches(makeGet()), []);
});

test('accountRequiringSwitches: ALLOW_ANONYMOUS_ROOMS apagado exige cuenta', () => {
  const list = accountRequiringSwitches(makeGet({ ALLOW_ANONYMOUS_ROOMS: false }));
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'ALLOW_ANONYMOUS_ROOMS');
});

test('validateAccessPolicy: con Postgres, cualquier combinación es válida', () => {
  assert.deepEqual(validateAccessPolicy({ getSetting: makeGet({ ALLOW_ANONYMOUS_ROOMS: false }), dbEnabled: true }), { ok: true });
});

test('validateAccessPolicy: sin Postgres y con los defaults, es válido (comportamiento de siempre)', () => {
  assert.deepEqual(validateAccessPolicy({ getSetting: makeGet(), dbEnabled: false }), { ok: true });
});

test('validateAccessPolicy: sin Postgres y ALLOW_ANONYMOUS_ROOMS apagado, falla nombrando la clave y DATABASE_URL', () => {
  const result = validateAccessPolicy({ getSetting: makeGet({ ALLOW_ANONYMOUS_ROOMS: false }), dbEnabled: false });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /ALLOW_ANONYMOUS_ROOMS/);
  assert.match(result.errors[0], /DATABASE_URL/);
});

test('roomCreationBlock: con salas anónimas permitidas, deja crear a cualquiera (con o sin sesión)', () => {
  assert.equal(roomCreationBlock(undefined, makeGet()), null);
  assert.equal(roomCreationBlock({}, makeGet()), null);
  assert.equal(roomCreationBlock({ userId: 5 }, makeGet()), null);
});

test('roomCreationBlock: con salas anónimas apagadas, una sesión de cuenta sigue pudiendo crear', () => {
  assert.equal(roomCreationBlock({ userId: 5 }, makeGet({ ALLOW_ANONYMOUS_ROOMS: false })), null);
});

test('roomCreationBlock: con salas anónimas apagadas, sin sesión se bloquea con 403 y código ACCOUNT_REQUIRED', () => {
  const get = makeGet({ ALLOW_ANONYMOUS_ROOMS: false });
  for (const session of [undefined, null, {}, { userId: null }]) {
    const block = roomCreationBlock(session, get);
    assert.equal(block.status, 403); // no 401: el cliente lo leería como "contraseña de biblioteca incorrecta"
    assert.equal(block.code, 'ACCOUNT_REQUIRED');
    assert.ok(block.error.length > 0);
  }
});
