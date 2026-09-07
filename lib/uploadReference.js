// --- Modo dual disco local / Cloudflare R2 — referencias a videos ya subidos ---------------------
// Extraído de server.js en la Fase 5 ("tests") para poder testear esta lógica aislada, sin depender
// del filesystem real ni de un bucket de R2 real (se le inyecta un `r2` y un `fs` de mentira).
// Comportamiento sin cambios respecto al original.
const path = require('path');
const realFs = require('fs');

function displayNameFor(filename) {
  const idx = filename.indexOf('__');
  return idx >= 0 ? filename.slice(idx + 2) : filename;
}

// Igual que displayNameFor pero a partir de room.videoFile ('/uploads/archivo.mp4' -> 'archivo.mp4' ->
// nombre legible). Se usa para los mensajes de chat de "cinta cargada"/"cambiaron la cinta".
function videoDisplayName(videoFile) {
  return displayNameFor(path.basename(videoFile));
}

// Valida un filename/key que llega del cliente. En modo R2, el "filename" que manda `library.html` es
// en realidad la key del objeto en el bucket (ver `r2.makeObjectKey`), así que hace falta preguntarle
// a R2 en vez de al filesystem. El chequeo de path traversal (basename + sin "..") se mantiene en los
// dos modos: en disco evita escapar de UPLOAD_DIR; en R2 el bucket no tiene "carpetas" reales, pero
// una key con "../" en el medio seguiría siendo una key válida y confusa (ej. en un listado), así que
// se rechaza igual.
async function isValidUploadReference(filename, { r2, uploadDir, fs = realFs }) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename !== path.basename(filename)) return false;
  if (filename.includes('..')) return false;
  if (r2.isR2Enabled()) return r2.objectExists(filename);
  return fs.existsSync(path.join(uploadDir, filename));
}

// Arma la URL que se guarda en room.videoFile a partir de un filename/key ya validado por
// isValidUploadReference.
function videoUrlForExistingFile(filename, { r2 }) {
  return r2.isR2Enabled() ? r2.getPublicUrl(filename) : '/uploads/' + filename;
}

module.exports = {
  displayNameFor,
  videoDisplayName,
  isValidUploadReference,
  videoUrlForExistingFile
};
