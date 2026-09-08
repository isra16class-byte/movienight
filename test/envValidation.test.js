const test = require('node:test');
const assert = require('node:assert/strict');
const { collectIssues } = require('../lib/envValidation');

test('collectIssues: entorno vacío no reporta nada', () => {
  const { errors, warnings } = collectIssues({});
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('collectIssues: R2 con las 5 variables completas no reporta nada', () => {
  const { errors } = collectIssues({
    R2_ACCOUNT_ID: 'a',
    R2_ACCESS_KEY_ID: 'b',
    R2_SECRET_ACCESS_KEY: 'c',
    R2_BUCKET_NAME: 'd',
    R2_PUBLIC_URL: 'https://pub-x.r2.dev',
  });
  assert.deepEqual(errors, []);
});

test('collectIssues: R2 a medio configurar (falta R2_PUBLIC_URL) reporta un error con el nombre de la que falta', () => {
  const { errors } = collectIssues({
    R2_ACCOUNT_ID: 'a',
    R2_ACCESS_KEY_ID: 'b',
    R2_SECRET_ACCESS_KEY: 'c',
    R2_BUCKET_NAME: 'd',
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /R2_PUBLIC_URL/);
});

test('collectIssues: una sola variable de R2 seteada también cuenta como configuración parcial', () => {
  const { errors } = collectIssues({ R2_ACCOUNT_ID: 'a' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /R2_ACCESS_KEY_ID/);
  assert.match(errors[0], /R2_SECRET_ACCESS_KEY/);
  assert.match(errors[0], /R2_BUCKET_NAME/);
  assert.match(errors[0], /R2_PUBLIC_URL/);
});

test('collectIssues: variable numérica entera inválida ("24h") reporta un error con el valor original', () => {
  const { errors } = collectIssues({ SHUTDOWN_GRACE_MS: '24h' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /SHUTDOWN_GRACE_MS/);
  assert.match(errors[0], /24h/);
});

test('collectIssues: ROOM_TTL_HOURS="0" es un decimal válido, no reporta error (0 es un valor real, no un typo)', () => {
  const { errors } = collectIssues({ ROOM_TTL_HOURS: '0' });
  assert.deepEqual(errors, []);
});

test('collectIssues: variable numérica válida (con decimales) no reporta error', () => {
  const { errors } = collectIssues({ MULTIPART_ABANDON_DAYS: '1.5' });
  assert.deepEqual(errors, []);
});

test('collectIssues: flag booleano con valor distinto de "1" reporta un warning, no un error', () => {
  const { errors, warnings } = collectIssues({ SESSION_COOKIE_INSECURE: 'true' });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SESSION_COOKIE_INSECURE/);
});

test('collectIssues: flag booleano en "1" no reporta nada', () => {
  const { errors, warnings } = collectIssues({ DISABLE_REDIS: '1' });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('collectIssues: acumula varios problemas distintos a la vez, no solo el primero', () => {
  const { errors, warnings } = collectIssues({
    R2_ACCOUNT_ID: 'a',
    SHUTDOWN_GRACE_MS: 'no-numero',
    LOG_PRETTY: 'yes',
  });
  assert.equal(errors.length, 2);
  assert.equal(warnings.length, 1);
});
