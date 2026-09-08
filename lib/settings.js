// --- Parámetros administrables desde el panel (docs/PLAN-PANEL-ADMIN.md) --------------------------
//
// Por qué existe: hoy cada uno de estos 8 parámetros se lee UNA sola vez de `process.env` al
// arrancar el proceso (`parseInt(process.env.X, 10) || default`, ver server.js y lib/*.js) — cambiar
// uno implica editar el `.env` y reiniciar el server. Este módulo agrega una segunda fuente, Postgres
// (tabla `app_settings`), que se puede tocar en caliente desde el panel sin reiniciar nada. La
// precedencia es DB → env → default: si alguien tocó el valor desde el panel, gana ese; si no, se
// respeta lo que ya haya en `.env` (compatibilidad total con instalaciones existentes que nunca usen
// el panel); si tampoco hay nada en `.env`, gana el default del catálogo de acá abajo.
//
// Lo que este módulo NO resuelve (a propósito, ver sección 4 del plan): los 4 parámetros que fijan
// la duración de un `setInterval` al arrancar (ROOM_SWEEP_INTERVAL_MS y compañía) quedan fuera de
// v1 — reprogramar un interval ya corriendo es una categoría de cambio distinta y más riesgosa que
// la que resuelve este archivo (que getSetting() se llame de nuevo en cada uso, en vez de una sola
// vez al arrancar). Ver sección 4.2 del plan para el refactor "constante → función" que hace falta en
// cada uno de los 8 puntos de lectura, aparte de este módulo.
//
// Cache en memoria (no se pega contra Postgres en cada getSetting(), sería un query por cada join de
// sala o subida) que se llena una sola vez con init() al arrancar (después de runMigrations(), mismo
// orden que el resto de lib/db.js) y se actualiza en el momento cuando algo cambia desde el panel —
// nunca queda desactualizada mientras el proceso siga vivo, porque no hay más de una instancia del
// server corriendo a la vez (ver docs/PLAN-PRODUCCION.md, Fase 3 pospuesta a propósito).

const defaultDb = require('./db');

// key -> { type: 'int'|'float', default, min, max, nullable? }. Rangos y defaults confirmados tal
// cual la propuesta original del plan (sección 3.3) — no son un guess mío improvisado, son los
// mismos límites que ya usa lib/envValidation.js como referencia de "qué es un valor razonable" para
// cada una de estas variables.
//
// `nullable: true` en ROOM_TTL_HOURS es la única aclaración técnica que sumé sobre la propuesta
// original: el plan ya declaraba `default: null` ("null = nunca expira", un valor válido hoy), pero
// un catálogo `{ type: 'float', min: 0.5 }` sin esta bandera no tiene forma de distinguir "no seteado
// todavía" de "seteado a null a propósito" — con `nullable: true`, un valor vacío se acepta y se
// interpreta como "nunca expira" en vez de rechazarse por no cumplir el `min`.
const SETTINGS = {
  ROOM_TTL_HOURS: { type: 'float', default: null, min: 0.5, max: 24 * 30, nullable: true },
  MAX_LIBRARY_VIDEOS: { type: 'int', default: 0, min: 0, max: 10000 },
  MAX_LIBRARY_SIZE_GB: { type: 'float', default: 0, min: 0, max: 100000 },
  R2_PRESIGN_EXPIRES_SECONDS: { type: 'int', default: 6 * 60 * 60, min: 60, max: 7 * 24 * 60 * 60 },
  ALERT_HEALTH_FAILURE_THRESHOLD: { type: 'int', default: 3, min: 1, max: 20 },
  ALERT_COOLDOWN_MS: { type: 'int', default: 30 * 60 * 1000, min: 60 * 1000, max: 24 * 60 * 60 * 1000 },
  MULTIPART_ABANDON_DAYS: { type: 'float', default: 2, min: 0, max: 30 },
  LIBRARY_ORPHAN_DAYS: { type: 'float', default: 30, min: 0, max: 365 },
};

let cache = null; // Map key -> fila de app_settings ({ key, value, updated_at, updated_by }), o null si init() no corrió

function parseRaw(raw, type) {
  return type === 'int' ? parseInt(raw, 10) : parseFloat(raw);
}

// '' se interpreta como null SOLO en settings marcados nullable — para el resto, un string vacío
// simplemente no es un número válido (Number.isFinite(NaN) es false, isValid() ya lo rechaza).
function coerce(key, raw) {
  const def = SETTINGS[key];
  if (raw === '' && def.nullable) return null;
  return parseRaw(raw, def.type);
}

function isValid(key, value) {
  const def = SETTINGS[key];
  if (value === null) return !!def.nullable;
  if (!Number.isFinite(value)) return false;
  if (def.min !== undefined && value < def.min) return false;
  if (def.max !== undefined && value > def.max) return false;
  return true;
}

function ensureKnown(key) {
  if (!SETTINGS[key]) throw new Error(`lib/settings.js: "${key}" no está en el catálogo de SETTINGS`);
}

function ensureInit() {
  if (!cache) {
    throw new Error(
      'lib/settings.js: init() no se llamó todavía — se llama una vez al arrancar el server, ' +
      'después de db.runMigrations() (ver server.js)'
    );
  }
}

// Se llama una sola vez al arrancar (o al principio de cada test). Recibe el módulo de db por
// parámetro (default lib/db.js real) para poder testear con uno de mentira, mismo criterio que ya usa
// lib/envValidation.js (collectIssues(env) recibe el entorno por parámetro en vez de leer
// process.env directo) — acá el "entorno a inyectar" es la conexión a Postgres, no process.env.
async function init(db = defaultDb) {
  cache = new Map();
  if (!db.isEnabled()) return; // sin Postgres, todo cae a env→default (ver getSetting())
  const rows = await db.listSettings();
  for (const row of rows) {
    if (!SETTINGS[row.key]) continue; // ignora keys de una versión anterior del catálogo, no rompe
    cache.set(row.key, row);
  }
}

// Valor YA resuelto (precedencia DB → env → default) y coercido al tipo del catálogo — nunca el
// string crudo. Sync porque lee de la cache en memoria: es la función que reemplaza cada constante
// de nivel de módulo de la sección 4.2 del plan, así que tiene que ser tan barata como leer esa
// constante era.
function getSetting(key) {
  ensureInit();
  ensureKnown(key);

  const dbRow = cache.get(key);
  if (dbRow) return coerce(key, dbRow.value);

  if (process.env[key] !== undefined && process.env[key] !== '') {
    return coerce(key, process.env[key]);
  }

  return SETTINGS[key].default;
}

// Valida un valor ya parseado (número, o null en un setting nullable) contra los límites del
// catálogo. Exportada aparte de setSetting() para que la ruta POST /admin/settings (server.js) pueda
// validar y devolver un 400 con el mensaje de error ANTES de intentar persistir nada.
function validate(key, value) {
  ensureKnown(key);
  if (!isValid(key, value)) {
    const def = SETTINGS[key];
    if (value === null) return { ok: false, error: `"${key}" no acepta un valor vacío` };
    return { ok: false, error: `"${key}" tiene que ser un número entre ${def.min} y ${def.max}` };
  }
  return { ok: true };
}

// Guarda un valor nuevo desde texto crudo (lo que llega del formulario del panel, siempre string):
// valida y persiste en Postgres, y actualiza la cache en memoria en el momento — el próximo
// getSetting() ya ve el valor nuevo, sin reiniciar el proceso. Tira si la validación falla (el
// caller, la ruta POST /admin/settings, decide cómo convertir eso en una respuesta 400) — mismo
// criterio que createUser() en lib/db.js dejando que el caller decida la respuesta HTTP.
async function setSetting(key, rawInput, updatedByUserId, db = defaultDb) {
  ensureInit();
  ensureKnown(key);
  const def = SETTINGS[key];

  const value = (rawInput === '' || rawInput === null) && def.nullable ? null : parseRaw(rawInput, def.type);
  const check = validate(key, value);
  if (!check.ok) throw new Error(check.error);

  const stored = value === null ? '' : String(value);
  await db.setSetting(key, stored, updatedByUserId);
  cache.set(key, { key, value: stored, updated_at: new Date(), updated_by: updatedByUserId });
}

// "Restaurar default": borra la fila en Postgres para que la precedencia vuelva a caer en
// env→default — este módulo no necesita saber "cuál es el default" para esto, alcanza con vaciar la
// cache de esa key.
async function resetSetting(key, db = defaultDb) {
  ensureInit();
  ensureKnown(key);
  await db.deleteSetting(key);
  cache.delete(key);
}

// Para la pantalla de settings del panel: el valor resuelto de CADA parámetro del catálogo (haya
// sido tocado o no desde Postgres) más de dónde sale — para que el panel pueda mostrar "esto viene
// de Postgres" vs "esto es el default de fábrica, nunca se tocó" en vez de una lista de números sin
// contexto.
function listAll() {
  ensureInit();
  return Object.keys(SETTINGS).map((key) => {
    const def = SETTINGS[key];
    const dbRow = cache.get(key);
    const base = { key, type: def.type, min: def.min, max: def.max, nullable: !!def.nullable, default: def.default };

    if (dbRow) {
      return { ...base, value: coerce(key, dbRow.value), source: 'db', updatedAt: dbRow.updated_at, updatedBy: dbRow.updated_by };
    }
    if (process.env[key] !== undefined && process.env[key] !== '') {
      return { ...base, value: coerce(key, process.env[key]), source: 'env', updatedAt: null, updatedBy: null };
    }
    return { ...base, value: def.default, source: 'default', updatedAt: null, updatedBy: null };
  });
}

module.exports = { SETTINGS, init, getSetting, setSetting, resetSetting, validate, listAll };
