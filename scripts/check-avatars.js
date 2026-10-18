// --- Revisión de los iconos de avatar (npm run check:avatars) -------------------------------------
//
// Revisa public/avatars/avatars.json y cada archivo que referencia: archivo existente, formato
// (png, webp, svg), peso (<= 200 KB), dimensiones de PNG/WebP (cuadrado, 128-1024 px) y SVG sin
// scripts ni referencias externas; ids y archivos únicos. Usa lib/avatars.js, el mismo código que
// valida el servidor y los tests. Avisa si public/avatars/CREDITS.md no menciona algún id del
// manifiesto. Sale con código 1 si hay errores; los avisos no fallan la revisión.

const fs = require('fs');
const path = require('path');
const { checkManifestFiles, DEFAULT_AVATARS_DIR } = require('../lib/avatars');

function pad(value, width) {
  return String(value).padEnd(width);
}

// ¿Aparece `id` en `text` como palabra completa (sin letras, números o guiones pegados)?
function mentionsId(text, id) {
  const isIdChar = (ch) => ch !== undefined && /[a-z0-9-]/.test(ch);
  let from = text.indexOf(id);
  while (from !== -1) {
    if (!isIdChar(text[from - 1]) && !isIdChar(text[from + id.length])) return true;
    from = text.indexOf(id, from + 1);
  }
  return false;
}

// Ids del manifiesto que CREDITS.md no menciona (o todos, si el archivo no existe).
function idsWithoutCredits(ids) {
  let text;
  try {
    text = fs.readFileSync(path.join(DEFAULT_AVATARS_DIR, 'CREDITS.md'), 'utf8');
  } catch {
    return { missingFile: true, missing: ids };
  }
  return { missingFile: false, missing: ids.filter((id) => !mentionsId(text, id)) };
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
  const credits = idsWithoutCredits(entries.map((e) => e.id));
  if (credits.missingFile) {
    console.log('\nAVISO: falta public/avatars/CREDITS.md (origen y licencia de cada icono).');
    warningCount++;
  } else if (credits.missing.length) {
    console.log(`\nAVISO: CREDITS.md no menciona estos ids: ${credits.missing.join(', ')}.`);
    warningCount++;
  }
  console.log(`\n${entries.length} iconos revisados: ${errorCount} errores, ${warningCount} avisos.`);
  process.exit(errorCount > 0 ? 1 : 0);
}

main();
