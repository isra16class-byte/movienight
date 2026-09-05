// --- Sesiones de usuario sobre Redis (Fase 2bis del plan de producción — "Sesiones") -------------
//
// Por qué existe este archivo: hasta ahora /auth/login (Fase 2bis, primer paso) solo confirmaba que
// el email/contraseña eran válidos, sin dejar nada iniciado en el navegador — cada request seguía
// siendo anónima. Esto agrega una sesión de servidor real: el cliente recibe una cookie `httpOnly`
// (el navegador no puede leerla desde JS, a diferencia de `hostToken` en `localStorage` hoy) que
// referencia un `sid` random; el contenido real de la sesión (`userId`, `email`) vive server-side, en
// Redis — así se puede revocar en cualquier momento (borrando la key), algo que el esquema de
// `hostToken` actual no permite.
//
// Por qué Redis y no una librería como `connect-redis`: la versión moderna de `connect-redis` (7+)
// tiene como peer dependency el cliente oficial `redis`, no `ioredis` (el que ya usa todo el proyecto
// vía lib/roomStore.js) — sumarla implicaría manejar dos clientes de Redis distintos en el mismo
// proceso, o migrar roomStore.js entero de librería sin necesidad real. La interfaz que necesita
// `express-session` (`get`/`set`/`destroy`/`touch`) es chica, así que se implementa acá directo sobre
// el cliente de ioredis que ya expone `roomStore.getClient()` — misma conexión, sin duplicar overhead
// de reconexión/backoff si Redis se cae (ver roomStore.js).
//
// Qué pasa si Redis no responde: mismo criterio que el resto del proyecto (server.js decide, no este
// archivo) — si `DISABLE_REDIS=1` (solo desarrollo local), server.js usa el `MemoryStore` que trae
// `express-session` por default en vez de esta clase, con el mismo tipo de aviso por consola que ya
// usan roomStore.js/lib/db.js para sus propios escape hatches. Este store asume que Redis está
// disponible (falla como cualquier operación de roomStore.js si no lo está).

const session = require('express-session');
const roomStore = require('./roomStore');

const KEY_PREFIX = 'movienight:sess:';
// TTL de respaldo si por algún motivo la sesión no trae `cookie.maxAge` (no debería pasar en el uso
// normal, ver SESSION_MAX_AGE_MS en server.js) — mejor una sesión que expira sola en Redis eventualmente
// que una que queda viva para siempre por un dato faltante.
const FALLBACK_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 días

function ttlSecondsFor(sessionData) {
  const maxAge = sessionData && sessionData.cookie && sessionData.cookie.maxAge;
  // maxAge de express-session viene en milisegundos; Redis EX/EXPIRE esperan segundos. Mínimo de 60s
  // para no terminar seteando un TTL de 0 (o negativo) por algún cálculo raro y borrar la sesión al toque.
  return maxAge ? Math.max(60, Math.floor(maxAge / 1000)) : FALLBACK_TTL_SECONDS;
}

class RedisSessionStore extends session.Store {
  _key(sid) {
    return KEY_PREFIX + sid;
  }

  // express-session llama a get() en cada request que trae la cookie de sesión, para saber si
  // `sid` sigue siendo válido y qué tiene guardado (userId, email).
  get(sid, callback) {
    roomStore.getClient().get(this._key(sid))
      .then((raw) => callback(null, raw ? JSON.parse(raw) : null))
      .catch((err) => callback(err));
  }

  // Se llama al crear una sesión nueva (login) o cada vez que cambia su contenido. `EX` en el mismo
  // comando que el `SET` evita una segunda ida y vuelta a Redis solo para poner el TTL.
  set(sid, sessionData, callback) {
    roomStore.getClient()
      .set(this._key(sid), JSON.stringify(sessionData), 'EX', ttlSecondsFor(sessionData))
      .then(() => callback && callback(null))
      .catch((err) => callback && callback(err));
  }

  // Logout, o cuando express-session decide invalidar una sesión corrupta/vencida.
  destroy(sid, callback) {
    roomStore.getClient().del(this._key(sid))
      .then(() => callback && callback(null))
      .catch((err) => callback && callback(err));
  }

  // "Rolling" del TTL en cada request autenticada (ver `rolling: true` en server.js), sin tener que
  // reescribir el valor entero — solo empuja la expiración en Redis.
  touch(sid, sessionData, callback) {
    roomStore.getClient().expire(this._key(sid), ttlSecondsFor(sessionData))
      .then(() => callback && callback(null))
      .catch((err) => callback && callback(err));
  }
}

module.exports = { RedisSessionStore };
