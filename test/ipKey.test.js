const test = require('node:test');
const assert = require('node:assert/strict');
const { rateLimitKeyFromIp } = require('../lib/ipKey');
const { makeAttemptLimiter, splitLastColon } = require('../lib/rateLimiter');

test('IPv4, unknown, vacío y no-strings no cambian', () => {
  assert.equal(rateLimitKeyFromIp('1.2.3.4'), '1.2.3.4');
  assert.equal(rateLimitKeyFromIp('unknown'), 'unknown');
  assert.equal(rateLimitKeyFromIp(''), '');
  assert.equal(rateLimitKeyFromIp(undefined), undefined);
  assert.equal(rateLimitKeyFromIp(null), null);
});

test('IPv4-mapeada (::ffff:a.b.c.d) se conserva tal cual, en forma decimal y hexadecimal', () => {
  assert.equal(rateLimitKeyFromIp('::ffff:172.18.0.1'), '::ffff:172.18.0.1');
  assert.equal(rateLimitKeyFromIp('::ffff:ac12:1'), '::ffff:ac12:1');
});

test('IPv6 expandida real: se queda con el /64', () => {
  assert.equal(rateLimitKeyFromIp('2800:bf0:8163:1234:f487:b058:2780:4d53'), '2800:bf0:8163:1234::/64');
  assert.equal(rateLimitKeyFromIp('2800:bf0:8163:1234:a5ef:b591:3c8f:f41'), '2800:bf0:8163:1234::/64');
});

test('IPv6 con :: al principio, en el medio y al final', () => {
  assert.equal(rateLimitKeyFromIp('::1'), '::/64');
  assert.equal(rateLimitKeyFromIp('2001:db8::1'), '2001:db8::/64');
  assert.equal(rateLimitKeyFromIp('2001:db8::5:6'), '2001:db8::/64');
  assert.equal(rateLimitKeyFromIp('2001:db8:1:2::'), '2001:db8:1:2::/64');
});

test('mayúsculas, ceros explícitos y zona dan la misma clave que la forma corta', () => {
  assert.equal(rateLimitKeyFromIp('2001:DB8:0:0:0:0:0:1'), rateLimitKeyFromIp('2001:db8::1'));
  assert.equal(rateLimitKeyFromIp('fe80::1%eth0'), rateLimitKeyFromIp('fe80::1'));
});

test('dos IPs del mismo /64 dan la MISMA clave; de /64 distintos, claves distintas', () => {
  const a = '2800:bf0:8163:1234:f487:b058:2780:4d53';
  const b = '2800:bf0:8163:1234:a5ef:b591:3c8f:f41';
  const otro = '2800:bf0:8163:1235:f487:b058:2780:4d53';
  assert.equal(rateLimitKeyFromIp(a), rateLimitKeyFromIp(b));
  assert.notEqual(rateLimitKeyFromIp(a), rateLimitKeyFromIp(otro));
});

test('la clave de un /64 nunca coincide con una IP completa (lleva /64)', () => {
  assert.ok(rateLimitKeyFromIp('2800:bf0:8163:1234:f487:b058:2780:4d53').endsWith('/64'));
});

test('dos direcciones del mismo /64 comparten el contador del limitador: el 3er fallo combinado bloquea a ambas', () => {
  const limiter = makeAttemptLimiter({ now: () => 0 });
  const a = rateLimitKeyFromIp('2800:bf0:8163:1234:f487:b058:2780:4d53');
  const b = rateLimitKeyFromIp('2800:bf0:8163:1234:a5ef:b591:3c8f:f41');
  limiter.recordFailure(a);
  limiter.recordFailure(b);
  assert.equal(limiter.lockedMinutes(a), null); // 2 fallos, todavía no
  limiter.recordFailure(a); // 3er fallo combinado
  assert.equal(limiter.lockedMinutes(a), 15);
  assert.equal(limiter.lockedMinutes(b), 15);
});

test('claves de login/sala con prefijo /64 siguen separándose bien en /admin/security (último ":")', () => {
  const key = `${rateLimitKeyFromIp('2800:bf0:8163:1234:f487:b058:2780:4d53')}:ana@x.com`;
  assert.deepEqual(splitLastColon(key), { ip: '2800:bf0:8163:1234::/64', rest: 'ana@x.com' });
});
