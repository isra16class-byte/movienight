const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isBcryptHash,
  isLegacySha256Hash,
  legacySha256,
  hashPassword,
  verifyPassword
} = require('../lib/passwordAuth');

test('isBcryptHash reconoce un hash bcrypt real y rechaza otras formas', () => {
  assert.equal(isBcryptHash('$2b$10$abcdefghijklmnopqrstuv'), true);
  assert.equal(isBcryptHash('$2a$12$abcdefghijklmnopqrstuv'), true);
  assert.equal(isBcryptHash(legacySha256('hola')), false);
  assert.equal(isBcryptHash(null), false);
  assert.equal(isBcryptHash(undefined), false);
  assert.equal(isBcryptHash(''), false);
});

test('isLegacySha256Hash reconoce un hex de 64 caracteres y rechaza el resto', () => {
  assert.equal(isLegacySha256Hash(legacySha256('hola')), true);
  assert.equal(isLegacySha256Hash('$2b$10$abcdefghijklmnopqrstuv'), false);
  assert.equal(isLegacySha256Hash('muy-corto'), false);
  assert.equal(isLegacySha256Hash(null), false);
});

test('hashPassword produce un hash bcrypt válido', async () => {
  const hash = await hashPassword('mi-contraseña');
  assert.equal(isBcryptHash(hash), true);
});

test('verifyPassword: sin hash configurado, solo es válida una contraseña vacía', async () => {
  assert.deepEqual(await verifyPassword('', null), { valid: true, needsRehash: false });
  assert.deepEqual(await verifyPassword('algo', null), { valid: false, needsRehash: false });
});

test('verifyPassword: hash bcrypt, contraseña correcta e incorrecta, sin pedir rehash', async () => {
  const hash = await hashPassword('correcta');
  const ok = await verifyPassword('correcta', hash);
  const bad = await verifyPassword('incorrecta', hash);
  assert.deepEqual(ok, { valid: true, needsRehash: false });
  assert.deepEqual(bad, { valid: false, needsRehash: false });
});

test('verifyPassword: hash legacy sha256 correcto pide needsRehash', async () => {
  const legacyHash = legacySha256('vieja-contraseña');
  const result = await verifyPassword('vieja-contraseña', legacyHash);
  assert.deepEqual(result, { valid: true, needsRehash: true });
});

test('verifyPassword: hash legacy sha256 incorrecto no pide rehash', async () => {
  const legacyHash = legacySha256('vieja-contraseña');
  const result = await verifyPassword('otra-cosa', legacyHash);
  assert.deepEqual(result, { valid: false, needsRehash: false });
});

test('verifyPassword: hash con forma irreconocible se trata como inválido, sin tirar excepción', async () => {
  const result = await verifyPassword('cualquiera', 'esto-no-es-un-hash-valido');
  assert.deepEqual(result, { valid: false, needsRehash: false });
});
