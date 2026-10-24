// --- Limitador genérico de intentos fallidos (Fase 2.2 del plan de producción) -------------------
// Extraído de server.js en la Fase 5 ("tests") para poder testearlo aislado. Comportamiento sin
// cambios respecto al original: 3 intentos fallidos → bloqueo de 15 minutos, por clave (IP, o
// IP+roomId según el caller). Cada instancia lleva su propio Map de intentos.
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutos

// Separa una clave de limitador en { ip, rest } cortando en el ÚLTIMO ":" (para claves `ip:email` o
// `ip:roomId`). No sirve cortar en el primero: una IPv6 lleva ":" por dentro (p. ej. "2800:bf0::4d53" o
// "::ffff:1.2.3.4"), y ni un email ni un roomId llevan ":". Si no hay ":" devuelve { ip: key, rest: null }.
// Solo debe usarse con las claves que SÍ llevan sufijo (login, sala); la de biblioteca es la IP sola y no se corta.
function splitLastColon(key) {
  const s = String(key);
  const i = s.lastIndexOf(':');
  if (i === -1) return { ip: s, rest: null };
  return { ip: s.slice(0, i), rest: s.slice(i + 1) };
}

// Enmascara un email para mostrarlo al admin: 2 primeras letras + "***@" + dominio ("is***@gmail.com").
// Con menos de 2 caracteres antes de la "@", "***@dominio". Sin "@" devuelve "***" (no devuelve el texto original).
function maskEmail(email) {
  const s = String(email);
  const at = s.lastIndexOf('@');
  if (at === -1) return '***';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  return local.length < 2 ? `***@${domain}` : `${local.slice(0, 2)}***@${domain}`;
}

function makeAttemptLimiter({
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  lockoutMs = DEFAULT_LOCKOUT_MS,
  now = Date.now
} = {}) {
  const attempts = new Map(); // key -> { count, lockedUntil }
  return {
    // Minutos restantes de bloqueo para `key`, o null si puede intentar.
    lockedMinutes(key) {
      const entry = attempts.get(key);
      const t = now();
      return (entry && entry.lockedUntil > t) ? Math.ceil((entry.lockedUntil - t) / 60000) : null;
    },
    recordSuccess(key) { attempts.delete(key); }, // se olvida cualquier intento fallido previo
    // Claves bloqueadas AHORA (lockedUntil todavía en el futuro), para el panel de admin. Solo lee el Map
    // `attempts`; no lo modifica ni borra entradas vencidas. Nota: al bloquear, recordFailure deja
    // entry.count en 0, así que no sirve como "intentos que causaron el bloqueo"; como el bloqueo se
    // dispara exactamente al llegar a maxAttempts (y mientras dura nadie llama a recordFailure), el
    // valor real es siempre maxAttempts.
    listLocked() {
      const t = now();
      const locked = [];
      for (const [key, entry] of attempts) {
        if (entry.lockedUntil > t) locked.push({ key, lockedUntil: entry.lockedUntil, attemptCount: maxAttempts });
      }
      return locked;
    },
    // Registra un intento fallido; devuelve si quedó bloqueada y cuántos intentos quedan.
    recordFailure(key) {
      const t = now();
      let entry = attempts.get(key);
      // Arranca un contador nuevo si no había uno, o si el bloqueo anterior ya venció (lockedUntil
      // solo es > 0 tras el último intento fallido permitido; mientras se cuenta, se mantiene en 0 y
      // no hay que resetear el contador en cada request).
      if (!entry || (entry.lockedUntil > 0 && entry.lockedUntil <= t)) entry = { count: 0, lockedUntil: 0 };
      entry.count += 1;
      if (entry.count >= maxAttempts) {
        entry.lockedUntil = t + lockoutMs;
        entry.count = 0; // al vencer el bloqueo, vuelve a tener intentos frescos
        attempts.set(key, entry);
        return { locked: true, attemptsLeft: 0 };
      }
      attempts.set(key, entry);
      return { locked: false, attemptsLeft: maxAttempts - entry.count };
    }
  };
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_LOCKOUT_MS,
  makeAttemptLimiter,
  splitLastColon,
  maskEmail
};
