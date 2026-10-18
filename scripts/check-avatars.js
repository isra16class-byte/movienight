// --- Revisión de los iconos de avatar (npm run check:avatars) -------------------------------------
//
// Revisa public/avatars/avatars.json y cada archivo que referencia: archivo existente, formato
// (png, webp, svg), peso (<= 200 KB), dimensiones de PNG/WebP (cuadrado, 128-1024 px) y SVG sin
// scripts ni referencias externas; ids y archivos únicos. Usa lib/avatars.js, el mismo código que
// valida el servidor y los tests. Sale con código 1 si hay errores; los avisos no fallan la revisión.

const { checkManifestFiles, DEFAULT_AVATARS_DIR } = require('../lib/avatars');

function pad(value, width) {
  return String(value).padEnd(width);
}

function main() {
  const { manifestErrors, entries, placeholders } = checkManifestFiles(DEFAULT_AVATARS_DIR);
  let errorCount = manifestErrors.length;
  let warningCount = 0;

  console.log(`${pad('id', 24)}${pad('formato', 9)}${pad('tamaño', 10)}${pad('dimensiones', 13)}estado`);
  for (const entry of entries) {
    const c = entry.check;
    const size = c.bytes === null ? '-' : `${(c.bytes / 1024).toFixed(1)} KB`;
    const dims = c.width === null ? '-' : `${c.width}x${c.height}`;
    const status = c.errors.length ? 'ERROR' : (c.warnings.length ? 'AVISO' : 'ok');
    console.log(`${pad(entry.id, 24)}${pad(c.format || '-', 9)}${pad(size, 10)}${pad(dims, 13)}${status}`);
    for (const e of c.errors) { console.log(`  - ${entry.file}: ${e}`); errorCount++; }
    for (const w of c.warnings) { console.log(`  - ${entry.file}: ${w}`); warningCount++; }
  }

  if (manifestErrors.length) {
    console.log('\nProblemas en el manifiesto:');
    for (const e of manifestErrors) console.log(`  - ${e}`);
  }
  if (placeholders > 0) {
    console.log(`\nAVISO: ${placeholders} marcadores sin reemplazar.`);
  }
  console.log(`\n${entries.length} iconos revisados: ${errorCount} errores, ${warningCount} avisos.`);
  process.exit(errorCount > 0 ? 1 : 0);
}

main();
