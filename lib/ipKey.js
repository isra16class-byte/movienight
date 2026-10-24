// Clave de IP para los limitadores de intentos fallidos (login, biblioteca, salas con contraseña).
// En IPv6 un solo cliente suele recibir un bloque entero (normalmente /64) y puede usar cualquier
// dirección de ese bloque, así que la dirección completa como clave deja esquivar el bloqueo con solo
// cambiar de dirección. Acá se trunca al prefijo /64 (usando el helper de express-rate-limit, que ya es
// dependencia del proyecto: no se escribe un parser de IPv6 propio). IPv4, 'unknown' y las IPv4-mapeadas
// (::ffff:a.b.c.d, que son IPv4 con otra forma) no cambian. Solo afecta a la CLAVE del limitador:
// los logs y el resto del código siguen usando la IP completa.
const net = require('node:net');
const { ipKeyGenerator } = require('express-rate-limit');

const IPV6_PREFIX_BITS = 64;

function rateLimitKeyFromIp(ip) {
  if (typeof ip !== 'string' || ip === '' || !net.isIPv6(ip)) return ip;
  const key = ipKeyGenerator(ip, IPV6_PREFIX_BITS); // p. ej. "2800:bf0:8163:1234::/64"
  if (net.isIPv4(key)) return ip; // IPv4-mapeada: el helper devuelve la v4; acá se conserva la IP tal cual
  return key;
}

module.exports = { IPV6_PREFIX_BITS, rateLimitKeyFromIp };
