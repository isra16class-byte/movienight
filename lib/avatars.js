// --- Avatares de cuenta (lista fija de iconos) ----------------------------------------------------
//
// Cada persona con cuenta puede elegir un avatar de una lista fija. La lista vive en
// `public/avatars/avatars.json` (arreglo de { id, name, file, placeholder? }) y los archivos, en la
// misma carpeta, los sirve express.static como cualquier otro archivo de public/.
//
// Este módulo hace tres cosas, todas sin dependencias nuevas:
//   1. Carga y valida el manifiesto al arrancar (loadManifest / init). Si el manifiesto es inválido NO
//      tumba el servidor: se registra el error y la lista queda vacía.
//   2. Resuelve ids -> { id, name, url } (resolveAvatar, nunca lanza).
//   3. Revisa los archivos de iconos (checkIconFile / checkManifestFiles). Lo usan tanto
//      scripts/check-avatars.js como test/avatars.test.js, para que el script y los tests midan
//      exactamente lo mismo.
//
// Los ids son estables: renombrar uno deja a quien lo eligió sin avatar (resolveAvatar da null, no es
// un error). En los eventos de socket y en la base va el id, nunca la URL.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeAttemptLimiter } = require('./rateLimiter');

const DEFAULT_AVATARS_DIR = path.join(__dirname, '..', 'public', 'avatars');
const MANIFEST_FILE = 'avatars.json';
const ID_PATTERN = /^[a-z0-9-]{2,32}$/;
const MAX_AVATARS = 40;

// Límites que revisa checkIconFile (el servidor en runtime NO los aplica: solo los revisa el script y
// los tests, para no tumbar nada en producción por un icono pesado).
const ALLOWED_EXTENSIONS = ['png', 'webp', 'svg'];
const MAX_FILE_BYTES = 200 * 1024;
const MIN_DIMENSION = 128;
const MAX_DIMENSION = 1024;

// Cambiar de avatar: 20 cambios cada 10 minutos por cuenta (mismo patrón que el resto del proyecto,
// lib/rateLimiter.js). Cada pedido cuenta como un intento; al llegar al tope se bloquea 10 minutos.
const AVATAR_CHANGE_MAX = 20;
const AVATAR_CHANGE_LOCKOUT_MS = 10 * 60 * 1000;

function makeAvatarChangeLimiter({ now } = {}) {
  return makeAttemptLimiter({
    maxAttempts: AVATAR_CHANGE_MAX,
    lockoutMs: AVATAR_CHANGE_LOCKOUT_MS,
    ...(now ? { now } : {})
  });
}

// --- Manifiesto ------------------------------------------------------------------------------------

function isSafeFileName(file) {
  return typeof file === 'string' && file.length > 0 && !file.includes('/') && !file.includes('\\') && !file.includes('..');
}

// Hash corto del CONTENIDO del archivo: va en la URL (?v=...) para que reemplazar un archivo sin
// cambiar su nombre rompa las cachés (también la de Cloudflare).
function shortHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 8);
}

// Valida la estructura del manifiesto (ya parseado) contra el contenido de `dir`.
// Devuelve { avatars, errors }: si hay cualquier error, `avatars` queda VACÍO (manifiesto inválido =
// lista vacía, ver comentario de arriba). No lanza.
function validateManifest(entries, dir = DEFAULT_AVATARS_DIR) {
  const errors = [];
  if (!Array.isArray(entries)) return { avatars: [], errors: ['El manifiesto debe ser un arreglo.'] };
  if (entries.length > MAX_AVATARS) errors.push(`Hay ${entries.length} avatares y el máximo es ${MAX_AVATARS}.`);

  const seenIds = new Set();
  const seenFiles = new Set();
  const avatars = [];
  entries.forEach((entry, i) => {
    const where = `Entrada ${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${where}: no es un objeto.`);
      return;
    }
    const { id, name, file } = entry;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      errors.push(`${where}: id inválido (${JSON.stringify(id)}); usa letras minúsculas, números y guiones, de 2 a 32 caracteres.`);
    } else if (seenIds.has(id)) {
      errors.push(`${where}: id repetido (${id}).`);
    } else {
      seenIds.add(id);
    }
    if (typeof name !== 'string' || !name.trim()) errors.push(`${where}: falta el nombre.`);
    if (!isSafeFileName(file)) {
      errors.push(`${where}: archivo inválido (${JSON.stringify(file)}); no puede tener "/" ni "..".`);
      return;
    }
    if (seenFiles.has(file)) errors.push(`${where}: archivo repetido (${file}).`);
    seenFiles.add(file);
    let buffer;
    try {
      buffer = fs.readFileSync(path.join(dir, file));
    } catch {
      errors.push(`${where}: el archivo ${file} no existe o no se puede leer.`);
      return;
    }
    avatars.push({
      id,
      name: typeof name === 'string' ? name : '',
      file,
      placeholder: entry.placeholder === true,
      hash: shortHash(buffer)
    });
  });

  return { avatars: errors.length ? [] : avatars, errors };
}

// Lee `avatars.json` de `dir` y lo valida. No lanza nunca: cualquier problema (archivo ausente, JSON
// roto, entradas inválidas) vuelve como `errors` y `avatars` queda vacío.
function loadManifest(dir = DEFAULT_AVATARS_DIR) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
  } catch (err) {
    return { avatars: [], errors: [`No se pudo leer ${MANIFEST_FILE}: ${err.message}`] };
  }
  return validateManifest(parsed, dir);
}

function publicAvatar(entry) {
  return { id: entry.id, name: entry.name, url: `/avatars/${encodeURIComponent(entry.file)}?v=${entry.hash}` };
}

// Estado del módulo: se carga con init() al arrancar. Antes de init() la lista está vacía.
let current = { avatars: [], byId: new Map() };

function setCurrent(avatars) {
  current = { avatars, byId: new Map(avatars.map((a) => [a.id, a])) };
}

// Carga el manifiesto real. `log` es opcional (el logger de pino del proyecto); si el manifiesto es
// inválido, registra cada error y deja la lista vacía en vez de tumbar el servidor.
function init({ dir = DEFAULT_AVATARS_DIR, log } = {}) {
  const { avatars, errors } = loadManifest(dir);
  if (errors.length && log) {
    for (const message of errors) log.error({ avatars: true }, `Manifiesto de avatares inválido: ${message}`);
  }
  setCurrent(avatars);
  return { count: avatars.length, errors };
}

function listAvatars() {
  return current.avatars.map(publicAvatar);
}

// { id, name, url } o null si no existe (id desconocido, null, no-string...). Nunca lanza.
function resolveAvatar(id) {
  if (typeof id !== 'string') return null;
  const entry = current.byId.get(id);
  return entry ? publicAvatar(entry) : null;
}

function isValidAvatarId(id) {
  return typeof id === 'string' && current.byId.has(id);
}

// --- Revisión de archivos de iconos (compartida por scripts/check-avatars.js y los tests) ----------

function readPngSize(buf) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature) || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// WebP: soporta los tres formatos de cabecera (VP8 con pérdida, VP8L sin pérdida y VP8X extendido).
// Devuelve null si el archivo no es WebP o la cabecera no se puede interpretar.
function readWebpSize(buf) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8X') {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (kind === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (kind === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

// Revisa un SVG como texto. Devuelve la lista de problemas encontrados (vacía = limpio).
function inspectSvg(text) {
  const problems = [];
  if (!/<svg[\s>]/i.test(text)) problems.push('no tiene una etiqueta <svg>.');
  const root = (text.match(/<svg\b[^>]*>/i) || [''])[0];
  const hasViewBox = /\sviewBox\s*=/i.test(root);
  const hasSize = /\swidth\s*=/i.test(root) && /\sheight\s*=/i.test(root);
  if (!hasViewBox && !hasSize) problems.push('le falta viewBox (o width y height).');
  // Las declaraciones xmlns son identificadores de espacio de nombres, no referencias que el navegador
  // vaya a cargar: se quitan antes de buscar URLs externas.
  const withoutNamespaces = text.replace(/\sxmlns(:[\w-]+)?\s*=\s*("[^"]*"|'[^']*')/gi, '');
  if (/<script/i.test(text)) problems.push('contiene <script.');
  if (/\son[a-z]+\s*=/i.test(withoutNamespaces)) problems.push('contiene un atributo de evento on*=.');
  if (/javascript:/i.test(text)) problems.push('contiene javascript:.');
  if (/<foreignObject/i.test(text)) problems.push('contiene <foreignObject.');
  if (/<!ENTITY/i.test(text)) problems.push('declara entidades (<!ENTITY).');
  if (/https?:\/\//i.test(withoutNamespaces)) problems.push('tiene referencias http(s) externas.');
  return problems;
}

// Revisa UN archivo de icono. Devuelve { format, bytes, width, height, errors, warnings }.
// `width`/`height` son null si no se pudieron leer (SVG, o WebP con cabecera rara).
function checkIconFile(dir, file) {
  const result = { format: null, bytes: null, width: null, height: null, errors: [], warnings: [] };
  const ext = path.extname(file).slice(1).toLowerCase();
  result.format = ext || null;
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    result.errors.push(`formato no permitido (${ext || 'sin extensión'}); usa png, webp o svg.`);
    return result;
  }
  let buf;
  try {
    buf = fs.readFileSync(path.join(dir, file));
  } catch {
    result.errors.push('el archivo no existe o no se puede leer.');
    return result;
  }
  result.bytes = buf.length;
  if (buf.length > MAX_FILE_BYTES) {
    result.errors.push(`pesa ${Math.round(buf.length / 1024)} KB y el máximo es ${MAX_FILE_BYTES / 1024} KB.`);
  }

  if (ext === 'svg') {
    for (const problem of inspectSvg(buf.toString('utf8'))) result.errors.push(`SVG ${problem}`);
    return result;
  }

  const size = ext === 'png' ? readPngSize(buf) : readWebpSize(buf);
  if (!size) {
    if (ext === 'png') result.errors.push('no es un PNG válido (cabecera ilegible).');
    else result.warnings.push('no se pudieron leer las dimensiones del WebP.');
    return result;
  }
  result.width = size.width;
  result.height = size.height;
  if (size.width !== size.height) result.errors.push(`no es cuadrado (${size.width}x${size.height}).`);
  if (size.width < MIN_DIMENSION || size.height < MIN_DIMENSION || size.width > MAX_DIMENSION || size.height > MAX_DIMENSION) {
    result.errors.push(`las dimensiones (${size.width}x${size.height}) deben estar entre ${MIN_DIMENSION} y ${MAX_DIMENSION} px.`);
  }
  return result;
}

// Revisa el manifiesto Y cada archivo. Devuelve:
//   { manifestErrors, entries: [{ id, name, file, placeholder, check }], placeholders }
// Usa los MISMOS validadores que el servidor (validateManifest) más checkIconFile por archivo.
function checkManifestFiles(dir = DEFAULT_AVATARS_DIR) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
  } catch (err) {
    return { manifestErrors: [`No se pudo leer ${MANIFEST_FILE}: ${err.message}`], entries: [], placeholders: 0 };
  }
  const { errors } = validateManifest(parsed, dir);
  const entries = Array.isArray(parsed)
    ? parsed
        .filter((e) => e && typeof e === 'object' && isSafeFileName(e.file))
        .map((e) => ({
          id: e.id,
          name: e.name,
          file: e.file,
          placeholder: e.placeholder === true,
          check: checkIconFile(dir, e.file)
        }))
    : [];
  return { manifestErrors: errors, entries, placeholders: entries.filter((e) => e.placeholder).length };
}

module.exports = {
  DEFAULT_AVATARS_DIR,
  ID_PATTERN,
  MAX_AVATARS,
  MAX_FILE_BYTES,
  MIN_DIMENSION,
  MAX_DIMENSION,
  AVATAR_CHANGE_MAX,
  AVATAR_CHANGE_LOCKOUT_MS,
  makeAvatarChangeLimiter,
  validateManifest,
  loadManifest,
  init,
  listAvatars,
  resolveAvatar,
  isValidAvatarId,
  readPngSize,
  readWebpSize,
  inspectSvg,
  checkIconFile,
  checkManifestFiles
};
