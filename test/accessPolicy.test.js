const test = require('node:test');
const assert = require('node:assert/strict');
const {
  accountRequiringSwitches, validateAccessPolicy, roomCreationBlock, libraryPasswordBlock, registrationBlock, joinBlock,
} = require('../lib/accessPolicy');

// getSetting de mentira: valores por clave, con el default "abierto" (todo permitido) para lo no listado.
// REQUIRE_ACCOUNT_TO_JOIN es el único cuyo default es «apagado» (false): los demás vienen en true.
const makeGet = (values = {}) => (key) => (key in values ? values[key] : key !== 'REQUIRE_ACCOUNT_TO_JOIN');

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

test('accountRequiringSwitches: ALLOW_LIBRARY_PASSWORD apagado exige cuenta; ALLOW_REGISTRATION apagado no', () => {
  assert.deepEqual(accountRequiringSwitches(makeGet({ ALLOW_LIBRARY_PASSWORD: false })).map((x) => x.key), ['ALLOW_LIBRARY_PASSWORD']);
  assert.deepEqual(accountRequiringSwitches(makeGet({ ALLOW_REGISTRATION: false })), []);
});

test('validateAccessPolicy: sin Postgres y ALLOW_LIBRARY_PASSWORD apagado, falla nombrando la clave', () => {
  const result = validateAccessPolicy({ getSetting: makeGet({ ALLOW_LIBRARY_PASSWORD: false }), dbEnabled: false });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /ALLOW_LIBRARY_PASSWORD/);
  assert.match(result.errors[0], /DATABASE_URL/);
});

test('validateAccessPolicy: sin Postgres, ALLOW_REGISTRATION apagado solo es válido', () => {
  assert.deepEqual(validateAccessPolicy({ getSetting: makeGet({ ALLOW_REGISTRATION: false }), dbEnabled: false }), { ok: true });
});

test('validateAccessPolicy: con los dos interruptores que exigen cuenta apagados y sin Postgres, lista ambos', () => {
  const result = validateAccessPolicy({
    getSetting: makeGet({ ALLOW_ANONYMOUS_ROOMS: false, ALLOW_LIBRARY_PASSWORD: false }), dbEnabled: false,
  });
  assert.equal(result.errors.length, 2);
});

test('libraryPasswordBlock: encendido (default), no corta a nadie', () => {
  for (const session of [undefined, null, {}, { userId: 5 }]) {
    assert.equal(libraryPasswordBlock(session, makeGet()), null);
  }
});

test('libraryPasswordBlock: apagado, una sesión de cuenta sigue pasando', () => {
  assert.equal(libraryPasswordBlock({ userId: 5 }, makeGet({ ALLOW_LIBRARY_PASSWORD: false })), null);
});

test('libraryPasswordBlock: apagado, sin sesión se corta con 403 ACCOUNT_REQUIRED (no 401)', () => {
  const get = makeGet({ ALLOW_LIBRARY_PASSWORD: false });
  for (const session of [undefined, null, {}, { userId: null }]) {
    const block = libraryPasswordBlock(session, get);
    assert.equal(block.status, 403); // un 401 reabriría el prompt de contraseña en el cliente
    assert.equal(block.code, 'ACCOUNT_REQUIRED');
    assert.ok(block.error.length > 0);
  }
});

test('registrationBlock: abierto (default) no corta; cerrado responde 403 REGISTRATION_CLOSED', () => {
  assert.equal(registrationBlock(makeGet()), null);
  const block = registrationBlock(makeGet({ ALLOW_REGISTRATION: false }));
  assert.equal(block.status, 403);
  assert.equal(block.code, 'REGISTRATION_CLOSED');
  assert.ok(block.error.length > 0);
});

test('accountRequiringSwitches: REQUIRE_ACCOUNT_TO_JOIN exige cuenta ENCENDIDO (al revés que los otros)', () => {
  assert.deepEqual(accountRequiringSwitches(makeGet({ REQUIRE_ACCOUNT_TO_JOIN: true })).map((x) => x.key), ['REQUIRE_ACCOUNT_TO_JOIN']);
  assert.deepEqual(accountRequiringSwitches(makeGet({ REQUIRE_ACCOUNT_TO_JOIN: false })), []);
});

test('validateAccessPolicy: sin Postgres y REQUIRE_ACCOUNT_TO_JOIN encendido, falla nombrando la clave', () => {
  const result = validateAccessPolicy({ getSetting: makeGet({ REQUIRE_ACCOUNT_TO_JOIN: true }), dbEnabled: false });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /REQUIRE_ACCOUNT_TO_JOIN/);
  assert.match(result.errors[0], /DATABASE_URL/);
  assert.deepEqual(validateAccessPolicy({ getSetting: makeGet({ REQUIRE_ACCOUNT_TO_JOIN: true }), dbEnabled: true }), { ok: true });
});

test('joinBlock: apagado (default), no corta a nadie', () => {
  for (const session of [undefined, null, {}, { userId: 5 }]) {
    assert.equal(joinBlock(session, makeGet()), null);
  }
});

test('joinBlock: encendido, una sesión de cuenta sigue entrando', () => {
  assert.equal(joinBlock({ userId: 5 }, makeGet({ REQUIRE_ACCOUNT_TO_JOIN: true })), null);
});

test('joinBlock: encendido, sin sesión se corta con ACCOUNT_REQUIRED', () => {
  const get = makeGet({ REQUIRE_ACCOUNT_TO_JOIN: true });
  for (const session of [undefined, null, {}, { userId: null }]) {
    const block = joinBlock(session, get);
    assert.equal(block.code, 'ACCOUNT_REQUIRED');
    assert.ok(block.error.length > 0);
  }
});

test('joinBlock: el mensaje NO contiene «Contraseña» (room.js abriría el prompt de contraseña de sala)', () => {
  const block = joinBlock({}, makeGet({ REQUIRE_ACCOUNT_TO_JOIN: true }));
  assert.equal(/contraseña/i.test(block.error), false);
});
