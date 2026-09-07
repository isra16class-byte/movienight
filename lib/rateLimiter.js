// --- Limitador genérico de intentos fallidos (Fase 2.2 del plan de producción) -------------------
// Extraído de server.js en la Fase 5 ("tests") para poder testearlo aislado. Comportamiento sin
// cambios respecto al original: 3 intentos fallidos → bloqueo de 15 minutos, por clave (IP, o
// IP+roomId según el caller). Cada instancia lleva su propio Map de intentos.
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutos

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
  makeAttemptLimiter
};
