const test = require('node:test');
const assert = require('node:assert/strict');
const { makeAttemptLimiter } = require('../lib/rateLimiter');

test('deja pasar sin bloqueo antes de agotar los intentos', () => {
  const limiter = makeAttemptLimiter();
  assert.equal(limiter.lockedMinutes('1.2.3.4'), null);
  const r1 = limiter.recordFailure('1.2.3.4');
  assert.deepEqual(r1, { locked: false, attemptsLeft: 2 });
  const r2 = limiter.recordFailure('1.2.3.4');
  assert.deepEqual(r2, { locked: false, attemptsLeft: 1 });
  assert.equal(limiter.lockedMinutes('1.2.3.4'), null);
});

test('bloquea al 3er intento fallido seguido, con 15 minutos por default', () => {
  let now = 1_000_000;
  const limiter = makeAttemptLimiter({ now: () => now });
  limiter.recordFailure('ip');
  limiter.recordFailure('ip');
  const r3 = limiter.recordFailure('ip');
  assert.deepEqual(r3, { locked: true, attemptsLeft: 0 });
  assert.equal(limiter.lockedMinutes('ip'), 15);
});

test('recordSuccess olvida los intentos fallidos previos', () => {
  const limiter = makeAttemptLimiter();
  limiter.recordFailure('ip');
  limiter.recordFailure('ip');
  limiter.recordSuccess('ip');
  const r = limiter.recordFailure('ip');
  // Vuelve a contar desde 1, no desde 3 — el éxito anterior "limpió" el contador.
  assert.deepEqual(r, { locked: false, attemptsLeft: 2 });
});

test('tras vencer el bloqueo, vuelve a dar intentos frescos', () => {
  let now = 0;
  const limiter = makeAttemptLimiter({ now: () => now, lockoutMs: 1000, maxAttempts: 2 });
  limiter.recordFailure('ip');
  const r = limiter.recordFailure('ip'); // 2do intento -> bloquea
  assert.equal(r.locked, true);
  assert.equal(limiter.lockedMinutes('ip'), 1); // ceil(1000ms / 60000) = 1 minuto

  now = 1001; // ya pasó el lockoutMs
  assert.equal(limiter.lockedMinutes('ip'), null);
  const after = limiter.recordFailure('ip'); // primer intento del ciclo nuevo
  assert.deepEqual(after, { locked: false, attemptsLeft: 1 });
});

test('claves distintas no se pisan entre sí (ej. dos IPs, o IP+roomId)', () => {
  const limiter = makeAttemptLimiter({ maxAttempts: 1 });
  const a = limiter.recordFailure('ip-a');
  assert.equal(a.locked, true);
  assert.equal(limiter.lockedMinutes('ip-b'), null); // otra clave, sin bloqueo
});

test('listLocked: vacío al inicio, lista la clave al bloquear y la quita al vencer el bloqueo', () => {
  let now = 1_000;
  const limiter = makeAttemptLimiter({ now: () => now, lockoutMs: 1000, maxAttempts: 3 });
  assert.deepEqual(limiter.listLocked(), []);
  limiter.recordFailure('ip');
  limiter.recordFailure('ip');
  assert.deepEqual(limiter.listLocked(), []); // todavía contando, no bloqueada
  limiter.recordFailure('ip'); // 3er intento -> bloquea
  limiter.recordFailure('otra'); // 1 intento: no bloqueada
  assert.deepEqual(limiter.listLocked(), [{ key: 'ip', lockedUntil: 2_000, attemptCount: 3 }]);
  now = 1_999;
  assert.equal(limiter.listLocked().length, 1);
  now = 2_000; // lockedUntil ya no es futuro
  assert.deepEqual(limiter.listLocked(), []);
});

test('listLocked: recordSuccess quita la clave y no modifica el resto del estado', () => {
  const limiter = makeAttemptLimiter({ now: () => 0 });
  limiter.recordFailure('a'); limiter.recordFailure('a'); limiter.recordFailure('a');
  limiter.listLocked();
  assert.equal(limiter.lockedMinutes('a'), 15); // listLocked no cambió nada
  limiter.recordSuccess('a');
  assert.deepEqual(limiter.listLocked(), []);
});
