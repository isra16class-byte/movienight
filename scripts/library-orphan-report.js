// --- Reporte de videos "huérfanos" en la biblioteca (Fase 2.6 del plan de producción) ------------
//
// Por qué existe: la biblioteca (disco local o bucket de R2, según cómo esté configurado el server)
// es compartida entre todas las salas — un video puede haber sido subido para una sala que ya expiró
// hace rato (Fase 2.6, expiración de salas) y quedar ocupando espacio sin que ninguna sala activa lo
// esté usando. Este script NO borra nada solo: lista candidatos para que una persona los revise y
// decida a mano, con el mismo criterio "modo seguro por default" que ya usa
// scripts/r2-cleanup-multipart.js.
//
// "Huérfano" acá significa: el archivo está en la biblioteca (disco o R2) pero ninguna sala activa
// (repoblada desde Redis) tiene `videoFile` apuntando a él, Y además tiene más de
// LIBRARY_ORPHAN_DAYS de antigüedad (por default 30 — más generoso que el TTL de salas de 24hs, a
// propósito: un video recién subido para "la próxima peliculeada" no debería aparecer acá solo porque
// todavía no se creó la sala que lo va a usar).
//
// Uso (desde la raíz del proyecto, con el .env ya configurado):
//
//   node scripts/library-orphan-report.js                # solo reporta, no borra nada
//   node scripts/library-orphan-report.js --delete        # además borra TODOS los que encuentre
//
// Requiere Redis disponible (para saber qué videos SÍ están en uso) — si DISABLE_REDIS=1 o Redis no
// responde, el script no tiene forma confiable de saber qué está en uso y se corta antes de reportar
// nada, para no arriesgar marcar como "huérfano" algo que en realidad sí se está viendo ahora mismo.

const path = require('path');
const fs = require('fs');

// Mismo loader minimalista de .env que ya usan server.js y r2-cleanup-multipart.js.
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
const roomStore = require('../lib/roomStore');

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v'];
const LIBRARY_ORPHAN_DAYS = parseFloat(process.env.LIBRARY_ORPHAN_DAYS) || 30;
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');

// A partir de room.videoFile ('/uploads/archivo.mp4' o una URL completa de R2), extrae solo el
// nombre de archivo / key — mismo criterio que displayNameFor/videoDisplayName en server.js, pero acá
// interesa el identificador completo (no el nombre "lindo"), para comparar contra el listado real.
function keyFromVideoFile(videoFile) {
  if (!videoFile) return null;
  try {
    // Si es una URL completa (modo R2), path.basename ya devuelve solo la key final.
    return path.basename(videoFile);
  } catch {
    return null;
  }
}

function formatDays(days) {
  if (days === 0) return 'hoy';
  if (days === 1) return 'hace 1 día';
  return `hace ${days} días`;
}

function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(2)}GB`;
  return `${(bytes / (1024 ** 2)).toFixed(0)}MB`;
}

async function main() {
  const shouldDelete = process.argv.includes('--delete');

  if (!roomStore.isEnabled()) {
    console.error('❌ DISABLE_REDIS=1 en este .env — sin Redis no hay forma confiable de saber qué videos están');
    console.error('   en uso por una sala activa. No se generó ningún reporte (por seguridad, no se asume nada).');
    process.exit(1);
  }

  console.log('🔎 Conectando a Redis para ver qué videos están en uso por salas activas...\n');
  let activeKeys;
  try {
    await roomStore.testConnection();
    const rooms = await roomStore.loadAllRooms();
    activeKeys = new Set(
      Object.values(rooms)
        .map((room) => keyFromVideoFile(room.videoFile))
        .filter(Boolean)
    );
    console.log(`   ${Object.keys(rooms).length} sala(s) activa(s), ${activeKeys.size} video(s) distinto(s) en uso.\n`);
  } catch (err) {
    console.error('❌ No se pudo conectar a Redis o leer las salas activas:', err.message);
    console.error('   No se generó ningún reporte (por seguridad, no se asume nada sobre qué está en uso).');
    process.exit(1);
  }

  console.log('📚 Listando la biblioteca...\n');
  let library;
  if (r2.isR2Enabled()) {
    const objects = await r2.listObjects();
    library = objects.filter((o) => VIDEO_EXTENSIONS.includes(path.extname(o.filename).toLowerCase()));
  } else {
    const files = fs.readdirSync(UPLOAD_DIR).filter((f) => VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()));
    library = files.map((f) => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, f));
      return { filename: f, size: stat.size, mtime: stat.mtimeMs };
    });
  }

  const now = Date.now();
  const cutoffMs = LIBRARY_ORPHAN_DAYS * 24 * 60 * 60 * 1000;
  const orphans = library.filter((o) => !activeKeys.has(o.filename) && (now - o.mtime) > cutoffMs);

  if (orphans.length === 0) {
    console.log(`✅ No hay candidatos: todo lo que tiene más de ${LIBRARY_ORPHAN_DAYS} días está referenciado por alguna sala activa, o no llega a esa antigüedad todavía.`);
    return;
  }

  console.log(`Encontrados ${orphans.length} video(s) sin ninguna sala activa usándolos, con más de ${LIBRARY_ORPHAN_DAYS} días de antigüedad:\n`);
  for (const o of orphans) {
    const days = Math.floor((now - o.mtime) / (1000 * 60 * 60 * 24));
    console.log(`  - ${o.filename}  (${formatSize(o.size)}, subido ${formatDays(days)})`);
  }

  if (!shouldDelete) {
    console.log('\nEsto fue solo un reporte — no se borró nada. Revisá la lista (puede haber cintas que');
    console.log('querés conservar para la próxima peliculeada aunque hoy no las use ninguna sala). Para');
    console.log('borrar TODAS las de arriba, corré de nuevo con --delete:\n');
    console.log('  node scripts/library-orphan-report.js --delete\n');
    return;
  }

  console.log('\n🗑️  Borrando todas las de arriba (--delete activado)...\n');
  let ok = 0, fail = 0;
  for (const o of orphans) {
    try {
      if (r2.isR2Enabled()) {
        await r2.deleteObject(o.filename);
      } else {
        fs.unlinkSync(path.join(UPLOAD_DIR, o.filename));
      }
      console.log(`  ✔ borrado: ${o.filename}`);
      ok++;
    } catch (err) {
      console.log(`  ✘ falló: ${o.filename} — ${err.message}`);
      fail++;
    }
  }
  console.log(`\nListo: ${ok} borrado(s), ${fail} con error.`);
}

main()
  .catch((err) => {
    console.error('❌ Error inesperado:', err.message);
    process.exit(1);
  })
  .finally(() => {
    roomStore.closeConnection();
  });
