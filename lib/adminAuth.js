// --- Seguridad de las rutas /admin/* (paso 6 de docs/PLAN-PANEL-ADMIN.md, sección 2) --------------
// Dos piezas, separadas de server.js desde el arranque (a diferencia de otras rutas del proyecto, que
// se extrajeron recién en la Fase 5) para poder testearlas aisladas desde el primer momento, mismo
// criterio que ya usa lib/hostAuth.js/lib/rateLimiter.js.

// makeRequireAdmin(db, log): fábrica que arma el middleware `requireAdmin`, con `db` y `log`
// inyectables (default: los módulos reales) para poder testear con un `db`/`log` de mentira, sin
// tocar Postgres ni el logger real — mismo criterio que lib/settings.js::init(db) recibiendo el
// módulo de db como parámetro en vez de leerlo de un require top-level fijo.
//
// El rol NO viaja en la cookie de sesión (ver docs/PLAN-PANEL-ADMIN.md, sección 2.2): se consulta a
// Postgres en cada request a /admin/*, así que revocar el rol de alguien tiene efecto inmediato en el
// próximo request, sin esperar a que esa sesión expire o esa persona vuelva a loguearse. No es un
// endpoint de alto tráfico (a diferencia de join-room), así que el costo de esta consulta extra por
// request no importa acá.
//
// 404 (no 401/403) si Postgres no está habilitado — mismo criterio que requireDbEnabled en server.js:
// no confirmarle a quien pregunta que la feature existe si ni siquiera hay cuentas de usuario
// configuradas en este server.
function makeRequireAdmin(db, log) {
  return async function requireAdmin(req, res, next) {
    if (!db.isEnabled()) return res.status(404).json({ error: 'No disponible.' });
    if (!(req.session && req.session.userId)) return res.status(401).json({ error: 'Requiere sesión.' });
    try {
      const user = await db.findUserById(req.session.userId);
      if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Requiere rol de administrador.' });
      req.adminUser = user; // lo usan las rutas de abajo (auditoría: quién hizo la acción)
      next();
    } catch (err) {
      log.error({ err }, 'Error verificando rol de administrador');
      res.status(500).json({ error: 'Error interno verificando permisos.' });
    }
  };
}

// isSameOrigin(req): true si no hay Origin/Referer para comparar (ej. un curl a mano, o un cliente
// que no manda esos headers — no bloqueamos ese caso, rompería clientes legítimos sin ganar mucho:
// sameSite=lax en la cookie de sesión ya cubre el escenario típico de CSRF) o si el que sí vino
// coincide con el host del propio server. Lógica pura (recibe `req` pero solo llama a `req.get`, sin
// tocar `res`) para poder testearla sin armar un `res` de mentira.
function isSameOrigin(req) {
  const origin = req.get('origin');
  const referer = req.get('referer');
  if (!origin && !referer) return true;
  const host = req.get('host'); // incluye el puerto si no es el estándar, ej. "localhost:3000"
  try {
    return new URL(origin || referer).host === host;
  } catch {
    return false; // Origin/Referer con formato inválido: se trata igual que "no coincide"
  }
}

// Chequeo barato de Origin/Referer contra el propio host (docs/PLAN-PANEL-ADMIN.md, sección 2.4) para
// POST /admin/settings y las rutas de acciones del paso 7 — las consecuencias de un CSRF exitoso acá
// son más serias que en el resto de la app. No reemplaza tokens CSRF por completo, pero es barato y no
// requiere tocar el esquema de sesión existente.
function requireSameOrigin(req, res, next) {
  if (isSameOrigin(req)) return next();
  res.status(403).json({ error: 'Origen no permitido.' });
}

module.exports = { makeRequireAdmin, isSameOrigin, requireSameOrigin };
