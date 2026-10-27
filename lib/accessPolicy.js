// --- Política de acceso: qué interruptores exigen cuenta (docs/PLAN-INTERRUPTORES.md, 3.3 y 3.4) ---
//
// Las cuentas viven en PostgreSQL. Sin DATABASE_URL no existen cuentas, así que un interruptor que
// EXIJA una cuenta sería imposible de cumplir: nadie podría crear sala (o entrar, o subir). Por eso,
// si algún interruptor de esta lista queda en su valor "exigente" y no hay Postgres, el servidor no
// arranca y dice cuál es (mismo criterio de "fallar rápido" que ya usan Redis, R2 y Postgres).
//
// Cada fase suma su interruptor a ACCOUNT_REQUIRING_SWITCHES cuando lo agrega al catálogo de
// lib/settings.js (fase 4: ALLOW_LIBRARY_PASSWORD en false; fase 5: REQUIRE_ACCOUNT_TO_JOIN en true).
//
// Todo acá es puro (recibe getSetting y los datos por parámetro), para poder testearlo sin levantar
// el server ni tocar process.env — mismo criterio que lib/envValidation.js.

// key -> el valor que hace que ese interruptor exija cuenta, y cómo se lo explicamos a quien opera.
const ACCOUNT_REQUIRING_SWITCHES = [
  {
    key: 'ALLOW_ANONYMOUS_ROOMS',
    demandingValue: false,
    why: 'con las salas anónimas apagadas, crear una sala exige una cuenta',
  },
];

// Devuelve los interruptores que hoy exigen cuenta: [{ key, why }].
function accountRequiringSwitches(getSetting) {
  return ACCOUNT_REQUIRING_SWITCHES
    .filter(({ key, demandingValue }) => getSetting(key) === demandingValue)
    .map(({ key, why }) => ({ key, why }));
}

// Arranque: sin Postgres no puede haber cuentas, así que ningún interruptor puede exigirlas.
// Devuelve { ok: true } o { ok: false, errors: [string] } (nunca tira ni sale: el caller decide).
function validateAccessPolicy({ getSetting, dbEnabled }) {
  if (dbEnabled) return { ok: true };
  const demanding = accountRequiringSwitches(getSetting);
  if (demanding.length === 0) return { ok: true };
  return {
    ok: false,
    errors: demanding.map(({ key, why }) =>
      `${key}: ${why}, pero DATABASE_URL no está configurada (sin Postgres no hay cuentas). ` +
      `Configurá DATABASE_URL, o devolvé ${key} a su valor por defecto en el .env.`
    ),
  };
}

// Crear una sala nueva (/create-room y /create-room-from-upload). Devuelve null si se puede, o
// { status, code, error } con la respuesta que el caller debe mandar. Una sesión de cuenta siempre
// alcanza; sin sesión, solo si ALLOW_ANONYMOUS_ROOMS está encendido. Tener la contraseña de biblioteca
// NO sustituye a la sesión acá: requireUploadAuth la deja pasar sin cuenta, y sin este chequeo
// previo el interruptor se esquivaría.
//
// 403 y no 401: el cliente (public/js/index.js) interpreta 401 en estas rutas como "contraseña de
// biblioteca incorrecta" y reabre el prompt de contraseña, que acá no resuelve nada.
function roomCreationBlock(session, getSetting) {
  if (session && session.userId) return null;
  if (getSetting('ALLOW_ANONYMOUS_ROOMS')) return null;
  return {
    status: 403,
    code: 'ACCOUNT_REQUIRED',
    error: 'Crear una sala necesita una cuenta. Iniciá sesión o creá una cuenta e intentá de nuevo.',
  };
}

module.exports = { ACCOUNT_REQUIRING_SWITCHES, accountRequiringSwitches, validateAccessPolicy, roomCreationBlock };
