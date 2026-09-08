// --- Conexión a PostgreSQL y modelo de usuarios (Fase 2bis del plan de producción) ----------------
//
// Por qué existe este archivo: hasta ahora el proyecto no tenía ninguna base de datos relacional —
// Redis (lib/roomStore.js) guarda el estado efímero de las salas, y R2/disco local guardan los
// videos. Con la decisión de Fase 0 de agregar cuentas reales (login), hace falta un lugar donde
// vivan de forma durable el email y la contraseña de cada usuario — algo que no tiene sentido meter
// en Redis (pensado para datos efímeros de sala, no para el registro permanente de usuarios).
//
// Mismo criterio de "fallar rápido y claro" que ya usan lib/r2.js y lib/roomStore.js: si Postgres
// está configurado (DATABASE_URL definida) y no responde al arrancar, el server NO arranca en un modo
// silencioso — un login/registro que "no funciona nunca" en silencio sería peor que un error de
// arranque bien visible. A diferencia de Redis, acá no hay escape hatch tipo DISABLE_REDIS: sin
// DATABASE_URL configurada, el registro/login simplemente no está disponible (ver isEnabled() más
// abajo) — no es un modo degradado del resto de la app, que sigue funcionando 100% igual que antes
// (salas anónimas por hostToken) mientras no se configure Postgres.

const { Pool } = require('pg');
const logger = require('./logger');

const DATABASE_URL = process.env.DATABASE_URL || '';

let _pool = null;

function isEnabled() {
  return !!DATABASE_URL;
}

function getPool() {
  if (!_pool) {
    _pool = new Pool({ connectionString: DATABASE_URL });
    // Igual que ioredis en lib/roomStore.js: esto captura errores de conexiones YA EN EL POOL que
    // quedan inactivas (ej. el server de Postgres las cierra por timeout) — sin este listener, ese
    // tipo de error se escapa como 'error' de EventEmitter sin nadie escuchando, lo cual Node trata
    // como una excepción no capturada y tira abajo el proceso entero (ver el handler global de
    // uncaughtException en server.js). No hace falta reintentar acá: pg pide una conexión nueva del
    // pool en el próximo query que la necesite.
    _pool.on('error', (err) => {
      logger.error({ err }, 'Postgres (lib/db) reportó un error en una conexión inactiva del pool');
    });
  }
  return _pool;
}

// Se llama una sola vez al arrancar el server (igual que roomStore.testConnection() y
// r2.testConnection()) para chequear que Postgres responda ANTES de aceptar tráfico.
async function testConnection() {
  await getPool().query('SELECT 1');
}

// Chequeo liviano de vida para el healthcheck (mismo patrón que roomStore.ping()) — nunca tira,
// siempre devuelve un resultado estructurado para que /health arme la respuesta.
async function ping() {
  if (!isEnabled()) return { enabled: false, ok: true }; // Postgres no configurado: no es una falla, ver nota de arriba
  try {
    await getPool().query('SELECT 1');
    return { enabled: true, ok: true };
  } catch (err) {
    return { enabled: true, ok: false, error: err.message };
  }
}

// Cierra el pool prolijamente durante el graceful shutdown (Fase 1.4) — no tira si falla, mismo
// criterio que roomStore.closeConnection(): en un shutdown ya se está cerrando el proceso de todos
// modos, no tiene sentido bloquear ni tratarlo como error fatal.
async function closeConnection() {
  if (!_pool) return;
  try {
    await _pool.end();
  } catch (err) {
    logger.error({ err }, 'Error cerrando el pool de Postgres durante el shutdown');
  }
}

// --- Migraciones ------------------------------------------------------------------------------
// Nada de librería de migraciones (mismo criterio minimalista que ya usa el proyecto con dotenv en
// server.js: no vale la pena sumar una dependencia nueva para esto). Cada sentencia es idempotente
// (CREATE ... IF NOT EXISTS) y se corre una sola vez al arrancar, antes de aceptar tráfico — si el
// proyecto suma más tablas más adelante (ej. sesiones, cuando se implemente esa parte de la Fase
// 2bis), se agregan acá como sentencias nuevas al final del array, nunca editando las que ya corrieron
// en producción.
//
// gen_random_uuid() viene de la extensión `pgcrypto` (disponible en Postgres desde hace muchas
// versiones, no es exclusivo de una versión reciente) — se usa UUID en vez de un id autoincremental
// para no exponer "cuántos usuarios se registraron" ni el orden de registro a través del propio id.
const MIGRATIONS = [
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Único por email SIN distinguir mayúsculas/minúsculas (alguien@x.com y Alguien@X.com son la misma
  // cuenta) — un índice único sobre LOWER(email) en vez de una constraint UNIQUE simple sobre `email`,
  // porque Postgres no permite hacer UNIQUE directamente sobre una expresión, solo sobre columnas.
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email))`,
  // --- Recuperación de contraseña (Fase 2bis del plan de producción) ---------------------------
  // Se guarda el HASH del token (sha256, ver hashResetToken en server.js), nunca el token en texto
  // plano — mismo criterio que las contraseñas: si algún día se filtra la tabla, no alcanza para
  // suplantar a nadie sin además tener el token original que solo viajó una vez por email. Tabla
  // separada (no columnas nuevas en `users`) porque puede haber más de un pedido de reseteo pendiente
  // a la vez (ej. la persona pide el link, no lo usa, y lo vuelve a pedir) y porque `ON DELETE CASCADE`
  // limpia solos los pedidos de una cuenta si esa cuenta se llegara a borrar en el futuro.
  `CREATE TABLE IF NOT EXISTS password_resets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS password_resets_token_hash_idx ON password_resets (token_hash)`,
  // Acelera el borrado de "todos los pedidos pendientes de este usuario" al usar uno con éxito.
  `CREATE INDEX IF NOT EXISTS password_resets_user_id_idx ON password_resets (user_id)`,
  // --- Panel de administración (docs/PLAN-PANEL-ADMIN.md) ---------------------------------------
  // `role` como TEXT simple ('user' | 'admin') en vez de una tabla de roles aparte: con dos valores
  // posibles no se justifica la complejidad extra, y agregar un tercer rol el día de mañana sigue
  // siendo un ALTER TABLE + migración de datos, nada distinto a lo que haría falta con una tabla
  // separada. NOT NULL DEFAULT 'user' para que las cuentas ya existentes (creadas antes de esta
  // migración) queden como 'user' automáticamente, sin necesidad de un UPDATE manual.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'`,
  // `app_settings`: clave/valor simple, todo en TEXT (se parsea al leer según el tipo declarado en el
  // catálogo de lib/settings.js, no acá) — mismo criterio minimalista que el resto de este archivo.
  // Solo existe una fila por parámetro que alguien haya tocado desde el panel; si una key no está acá,
  // gana el valor de `.env`, y si tampoco está en `.env`, el default del catálogo (ver lib/settings.js
  // para la precedencia completa). `updated_by` referencia a quién hizo el último cambio, para poder
  // mostrarlo en el panel — ON DELETE SET NULL porque el valor sigue siendo válido aunque esa cuenta
  // de admin se borre en el futuro (no tiene sentido perder el setting por eso).
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL
  )`,
  // `admin_actions_audit`: historial de acciones operativas (cerrar salas, etc.), separado de
  // `app_settings` porque esa tabla solo guarda el valor VIGENTE de cada parámetro, no quién lo trajo
  // hasta ahí ni cuándo. `detail` en JSONB para no tener que agregar columnas nuevas cada vez que una
  // acción nueva necesite guardar datos distintos (ej. cuántas salas se cerraron, o el nombre del
  // parámetro que cambió y su valor anterior). `ip`/`user_agent` de dónde vino la acción — vale la
  // pena para algo tan sensible como "cerrar TODAS las salas", igual que cualquier log de auditoría
  // serio. `admin_user_id` sin ON DELETE CASCADE ni SET NULL: se deja como referencia simple (si la
  // cuenta de admin se borra, el registro de auditoría de todos modos no debería desaparecer con ella;
  // en la práctica las cuentas de admin no se borran, solo se les revierte el rol).
  `CREATE TABLE IF NOT EXISTS admin_actions_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    detail JSONB,
    ip TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Para listar el historial ordenado por fecha (uso más común del panel) sin depender de un sort en
  // memoria sobre toda la tabla.
  `CREATE INDEX IF NOT EXISTS admin_actions_audit_created_at_idx ON admin_actions_audit (created_at DESC)`
];

async function runMigrations() {
  const pool = getPool();
  for (const sql of MIGRATIONS) {
    await pool.query(sql);
  }
}

// --- Usuarios ------------------------------------------------------------------------------------

// Crea un usuario nuevo. `passwordHash` ya viene hasheado con bcrypt (ver hashPassword() en
// server.js, la misma función que ya se usa para passwordHash de sala y LIBRARY_PASSWORD) — este
// módulo no sabe nada de contraseñas en texto plano, ni falta que le haga.
// Puede tirar un error de violación de constraint (código '23505') si el email ya existe — el caller
// (POST /auth/register en server.js) es quien decide cómo responder eso (409, mensaje sin filtrar
// detalle interno de Postgres).
async function createUser(email, passwordHash) {
  const result = await getPool().query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
    [email, passwordHash]
  );
  return result.rows[0];
}

// Busca por email sin distinguir mayúsculas/minúsculas (ver el índice de arriba). Devuelve `null` si
// no existe, en vez de tirar — no encontrar un usuario es un caso normal (login con email
// inexistente), no un error.
async function findUserByEmail(email) {
  const result = await getPool().query(
    'SELECT id, email, password_hash, created_at FROM users WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  return result.rows[0] || null;
}

// Actualiza la contraseña de una cuenta ya existente (usado por POST /auth/reset-password tras
// validar el token). `passwordHash` ya viene hasheado con bcrypt, igual que en createUser.
async function updateUserPassword(userId, passwordHash) {
  await getPool().query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
}

// Busca por id, trayendo también el `role` — usado por requireAdmin (server.js) en cada request a
// una ruta /admin/*, en vez de confiar en un rol viajando en la cookie de sesión: si se revoca el
// rol de alguien, el efecto es inmediato en el próximo request, sin esperar a que esa sesión expire
// o esa persona vuelva a loguearse. `null` si no existe (ej. la cuenta se borró pero la sesión sigue
// viva) — el caller lo trata como "no es admin", no como un error.
async function findUserById(userId) {
  const result = await getPool().query(
    'SELECT id, email, role, created_at FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

// Promueve (o degrada) una cuenta ya existente. Sin validación de que `role` sea uno de los valores
// esperados acá — eso es responsabilidad del caller (scripts/make-admin.js es hoy el único que
// llama esto, y siempre pasa 'admin' literal).
async function setUserRole(userId, role) {
  await getPool().query('UPDATE users SET role = $2 WHERE id = $1', [userId, role]);
}

// --- Configuración administrable (app_settings) ---------------------------------------------------

// Trae TODAS las filas de una vez (nunca son muchas — un puñado de parámetros, ver el catálogo de
// lib/settings.js) en vez de una consulta por key: la cache de lib/settings.js se llena con un solo
// query al arrancar y se invalida entera cada vez que algo cambia, no fila por fila.
async function listSettings() {
  const result = await getPool().query('SELECT key, value, updated_at, updated_by FROM app_settings');
  return result.rows;
}

// `INSERT ... ON CONFLICT DO UPDATE` (upsert) porque la primera vez que se toca un parámetro no
// existe fila todavía, y las siguientes veces sí — un solo query cubre los dos casos sin necesidad de
// primero consultar si existe.
async function setSetting(key, value, updatedByUserId) {
  await getPool().query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3`,
    [key, value, updatedByUserId]
  );
}

// "Restaurar default": borra la fila para que la precedencia (ver lib/settings.js) vuelva a caer en
// env→default, sin necesidad de que el catálogo sepa cuál es "el" default de cada uno acá también.
async function deleteSetting(key) {
  await getPool().query('DELETE FROM app_settings WHERE key = $1', [key]);
}

// --- Auditoría de acciones de administración -------------------------------------------------------

// `detail` se guarda tal cual como JSONB — el caller arma el objeto (ej. { key, oldValue, newValue }
// para un cambio de setting, o { roomsClosed: 3 } para un cierre masivo), este módulo no le impone
// forma.
async function insertAdminAction(adminUserId, action, detail, ip, userAgent) {
  await getPool().query(
    `INSERT INTO admin_actions_audit (admin_user_id, action, detail, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [adminUserId, action, detail ? JSON.stringify(detail) : null, ip || null, userAgent || null]
  );
}

// Historial para mostrar en el panel, más reciente primero. `limit` acotado (ver server.js) para no
// permitir que alguien pida traer la tabla entera de una sola vez.
async function listAdminActions(limit) {
  const result = await getPool().query(
    `SELECT aa.id, aa.action, aa.detail, aa.ip, aa.user_agent, aa.created_at, u.email AS admin_email
     FROM admin_actions_audit aa
     JOIN users u ON u.id = aa.admin_user_id
     ORDER BY aa.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// --- Recuperación de contraseña -------------------------------------------------------------------

// Guarda un pedido de reseteo nuevo. `tokenHash` es sha256 del token real (ver hashResetToken en
// server.js) — el token en texto plano nunca toca la base, solo viaja una vez por el link del email.
async function createPasswordReset(userId, tokenHash, expiresAt) {
  await getPool().query(
    'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt]
  );
}

// Busca un pedido de reseteo válido (existe Y no venció) por el hash del token. Devuelve también el
// email del usuario, para no necesitar una segunda consulta en el caller. `null` si no existe o ya
// venció — un token vencido no es un error, es el caso esperado de "el link ya no sirve".
async function findValidPasswordReset(tokenHash) {
  const result = await getPool().query(
    `SELECT pr.id, pr.user_id, pr.expires_at, u.email
     FROM password_resets pr
     JOIN users u ON u.id = pr.user_id
     WHERE pr.token_hash = $1 AND pr.expires_at > now()`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

// Invalida TODOS los pedidos de reseteo pendientes de un usuario — se llama después de un reseteo
// exitoso, para que un link viejo (ej. reenviado sin querer, o pedido dos veces) no siga sirviendo una
// vez que la contraseña ya cambió.
async function deletePasswordResetsForUser(userId) {
  await getPool().query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
}

module.exports = {
  isEnabled,
  testConnection,
  ping,
  closeConnection,
  runMigrations,
  createUser,
  findUserByEmail,
  findUserById,
  setUserRole,
  updateUserPassword,
  listSettings,
  setSetting,
  deleteSetting,
  insertAdminAction,
  listAdminActions,
  createPasswordReset,
  findValidPasswordReset,
  deletePasswordResetsForUser
};
