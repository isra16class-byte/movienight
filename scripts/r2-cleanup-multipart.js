// --- Limpieza de subidas multipart abandonadas en Cloudflare R2 ---------------------------------
//
// Por qué existe: cuando una subida de video a R2 se corta a medias (pestaña cerrada, túnel caído,
// server local reiniciado mientras subía algo), las partes que ya llegaron al bucket quedan ahí
// ocupando espacio y facturando, pero como el objeto nunca se "completó" no aparecen en el listado
// normal del bucket — se ve el dashboard de Cloudflare con "0 objetos" pero el tamaño ocupado no
// baja. R2 tiene por defecto una regla de lifecycle que las aborta solas a los 7 días de iniciadas,
// pero este script permite verlas y liberarlas ya mismo en vez de esperar.
//
// Uso (desde la raíz del proyecto, con el .env ya configurado con las variables R2_*):
//
//   node scripts/r2-cleanup-multipart.js            # solo lista, no borra nada (modo seguro)
//   node scripts/r2-cleanup-multipart.js --abort     # además cancela TODAS las que encuentre
//
// Por defecto corre en modo "solo listar" a propósito: abortar una subida multipart es
// irreversible (las partes ya subidas se borran para siempre). Hay que pasar --abort explícitamente
// para que borre algo.

const path = require('path');
const fs = require('fs');

// Mismo loader minimalista de .env que usa server.js (sin agregar la dependencia `dotenv`), para
// que este script funcione standalone sin tener que levantar el servidor.
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

const r2 = require('../lib/r2');

function formatBytesEstimate(days) {
  // No tenemos el tamaño de las partes ya subidas (la API de S3 no lo expone en ListMultipartUploads),
  // así que no se puede mostrar un tamaño exacto por subida — solo la fecha de inicio, para que se
  // pueda juzgar si es "basura vieja" o una subida en curso ahora mismo.
  if (days === 0) return 'hoy';
  if (days === 1) return 'hace 1 día';
  return `hace ${days} días`;
}

async function main() {
  const shouldAbort = process.argv.includes('--abort');

  if (!r2.isR2Enabled()) {
    console.error('❌ R2 no está configurado en este .env (faltan variables R2_*). Nada que limpiar.');
    process.exit(1);
  }

  console.log('🔎 Buscando subidas multipart sin completar en el bucket...\n');
  const uploads = await r2.listMultipartUploads();

  if (uploads.length === 0) {
    console.log('✅ No hay subidas multipart abandonadas. El espacio ocupado en el bucket corresponde a objetos reales.');
    return;
  }

  console.log(`Encontradas ${uploads.length} subida(s) sin completar:\n`);
  const now = Date.now();
  for (const u of uploads) {
    const days = Math.floor((now - u.initiated) / (1000 * 60 * 60 * 24));
    console.log(`  - ${u.key}  (iniciada ${formatBytesEstimate(days)})`);
  }

  if (!shouldAbort) {
    console.log('\nEsto fue solo un listado — no se borró nada. Si son basura de subidas que se cortaron,');
    console.log('corré de nuevo con --abort para liberar el espacio:\n');
    console.log('  node scripts/r2-cleanup-multipart.js --abort\n');
    return;
  }

  console.log('\n🗑️  Cancelando todas las de arriba (--abort activado)...\n');
  let ok = 0, fail = 0;
  for (const u of uploads) {
    try {
      await r2.abortMultipartUpload(u.key, u.uploadId);
      console.log(`  ✔ cancelada: ${u.key}`);
      ok++;
    } catch (err) {
      console.log(`  ✘ falló: ${u.key} — ${err.message}`);
      fail++;
    }
  }
  console.log(`\nListo: ${ok} cancelada(s), ${fail} con error. El espacio debería reflejarse en el dashboard de R2 en unos minutos.`);
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err.message);
  process.exit(1);
});
