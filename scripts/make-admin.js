// --- Promover una cuenta existente a administradora (docs/PLAN-PANEL-ADMIN.md) --------------------
//
// Por qué existe: no hay ninguna ruta HTTP para asignar el rol 'admin' — a propósito, para que
// "convertirse en admin" nunca sea alcanzable desde el navegador ni por un bug de una ruta mal
// protegida. La única forma de crear el primer admin (y cualquier admin siguiente) es este script,
// corrido a mano en el servidor con acceso directo a Postgres. Mismo criterio de "modo seguro por
// default" que ya usan scripts/r2-cleanup-multipart.js y scripts/library-orphan-report.js.
//
// Uso (desde la raíz del proyecto, con el .env ya configurado):
//
//   node scripts/make-admin.js persona@ejemplo.com
//
// Requiere que la cuenta ya exista (se registró antes por el flujo normal de /auth/register) — este
// script no crea cuentas nuevas, solo cambia el rol de una que ya está en `users`.

const path = require('path');
const fs = require('fs');

// Mismo loader minimalista de .env que ya usan server.js y los otros scripts de scripts/.
function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const db = require('../lib/db');

async function main() {
  const email = process.argv[2];

  if (!email) {
    console.error('Uso: node scripts/make-admin.js persona@ejemplo.com');
    process.exit(1);
  }

  if (!db.isEnabled()) {
    console.error('❌ DATABASE_URL no está configurada en este .env — sin Postgres no hay cuentas de');
    console.error('   usuario, y por lo tanto nada que promover a admin.');
    process.exit(1);
  }

  try {
    await db.testConnection();
  } catch (err) {
    console.error('❌ No se pudo conectar a Postgres:', err.message);
    process.exit(1);
  }

  // runMigrations() es idempotente (CREATE ... IF NOT EXISTS, ver lib/db.js) — se corre acá también,
  // no solo al arrancar server.js, para que este script funcione incluso si todavía no se arrancó el
  // server ni una sola vez con el código nuevo (ej. justo después de un deploy).
  await db.runMigrations();

  const user = await db.findUserByEmail(email);
  if (!user) {
    console.error(`❌ No existe ninguna cuenta con el email "${email}". Tiene que registrarse primero`);
    console.error('   por el flujo normal (/auth/register) antes de poder promoverla a admin.');
    process.exit(1);
  }

  await db.setUserRole(user.id, 'admin');
  console.log(`✅ "${user.email}" ahora es administradora. Ya puede entrar a /admin.html con su sesión normal.`);

  await db.closeConnection();
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
