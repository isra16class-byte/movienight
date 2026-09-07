// --- Hashing y verificación de contraseñas (Fase 2.1 del plan de producción) ---------------------
// Extraído de server.js en la Fase 5 ("tests") para poder testear esta lógica de forma aislada, sin
// levantar el server real (Redis/Postgres/Express). Comportamiento sin cambios respecto al original.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 10;

function isBcryptHash(hash) {
  return typeof hash === 'string' && /^\$2[aby]\$\d{2}\$/.test(hash);
}

// Detecta un hash del esquema viejo (sha256 hex, 64 caracteres) para la migración transparente de
// abajo — ver hashPassword/verifyPassword.
function isLegacySha256Hash(hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash);
}

function legacySha256(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

// Hashea una contraseña nueva (sala al crearse, o LIBRARY_PASSWORD al arrancar) siempre con bcrypt —
// solo se llama con contraseñas nuevas, nunca para migrar una vieja (eso lo hace verifyPassword).
async function hashPassword(pw) {
  return bcrypt.hash(String(pw), BCRYPT_ROUNDS);
}

// Verifica una contraseña contra un hash guardado, que puede ser bcrypt (esquema nuevo) o sha256 sin
// salt (esquema viejo, de la Fase 1 y anteriores — las salas creadas antes de este cambio quedaron
// con ese hash guardado en Redis). Plan de migración elegido (ver docs/PLAN-PRODUCCION.md, Fase 2.1):
// NO resetear contraseñas existentes al desplegar — en vez de eso, se detecta el algoritmo viejo, se
// valida con él, y si es válida se re-hashea con bcrypt para la próxima vez (needsRehash: true, el
// caller se encarga de persistir el hash nuevo). Así la migración es transparente para quien ya tenía
// una sala con contraseña: no nota nada, y con el uso normal (cada login exitoso) los hashes viejos
// van desapareciendo solos.
async function verifyPassword(pw, hash) {
  if (!hash) return { valid: !pw, needsRehash: false }; // sala/biblioteca sin contraseña configurada
  if (isBcryptHash(hash)) {
    return { valid: await bcrypt.compare(String(pw), hash), needsRehash: false };
  }
  if (isLegacySha256Hash(hash)) {
    const valid = legacySha256(pw) === hash;
    return { valid, needsRehash: valid }; // solo migrar si la contraseña vieja era correcta
  }
  // Hash con una forma que no reconocemos (dato corrupto/inesperado): tratarlo como no válido en vez
  // de tirar una excepción — más seguro que asumir cualquier otra cosa.
  return { valid: false, needsRehash: false };
}

module.exports = {
  BCRYPT_ROUNDS,
  isBcryptHash,
  isLegacySha256Hash,
  legacySha256,
  hashPassword,
  verifyPassword
};
