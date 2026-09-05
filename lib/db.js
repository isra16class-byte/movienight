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
      console.error('⚠️  Postgres (lib/db) reportó un error en una conexión inactiva del pool:', err.message);
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
    console.error('⚠️  Error cerrando el pool de Postgres durante el shutdown:', err.message);
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
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email))`
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

module.exports = {
  isEnabled,
  testConnection,
  ping,
  closeConnection,
  runMigrations,
  createUser,
  findUserByEmail
};
