// --- Alertas mínimas (Fase 4 del plan de producción, último punto pendiente de la fase) -----------
//
// Por qué existe este archivo: `/health` (Fase 1.5) y `/metrics` (Fase 4) ya exponen si el proceso
// está sano y si R2 viene fallando, pero ambos son "pull" — alguien tiene que estar mirando la
// consola o pegándole al endpoint a mano para enterarse. Esto agrega la mitad que faltaba ("push"):
// un job periódico, corrido desde `server.js`, que llama a `computeHealthStatus()` (la misma función
// que usa la ruta `/health`, para no duplicar la lógica de qué cuenta como sano) y a
// `metrics.snapshot()`, y manda un email vía `lib/mailer.js` si:
//   1. El healthcheck lleva varias fallas SEGUIDAS (no una sola: un timeout aislado de 3s contra
//      Redis/R2/Postgres no necesariamente amerita despertar a alguien — pero varias seguidas sí).
//   2. R2 empezó a devolver errores nuevos desde la última vez que se revisó (`r2ErrorCount` subió).
//
// Deliberadamente NO usa Sentry para esto (aunque ya está integrado, ver lib/sentry.js): Sentry
// captura excepciones puntuales a medida que ocurren, pero no tiene noción de "la dependencia X
// lleva N chequeos fallando" — esa lógica de umbral/cooldown es justo lo que este módulo agrega.
//
// Todo en memoria, a propósito, mismo criterio que lib/metrics.js: la Fase 0 ya decidió que una sola
// instancia alcanza por ahora, así que no hace falta coordinar este estado entre procesos.
//
// Feature opcional: sin `ALERT_EMAIL_TO` configurada, el job ni siquiera se arranca (ver
// `isEnabled()`/server.js) — no tiene sentido correr chequeos extra cada un rato si no hay a quién
// avisarle. No es un escape hatch de producción (como DISABLE_REDIS): es simplemente un feature que
// requiere decidir a qué email mandar las alertas, igual criterio que RESEND_API_KEY/SENTRY_DSN.

const logger = require('./logger');
const mailer = require('./mailer');
const settings = require('./settings');

const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || '';

// Cuántos chequeos seguidos en falla hacen falta antes de mandar la primera alerta, y cuánto esperar
// antes de reenviar la misma alerta mientras el problema persista — ambos configurables vía
// lib/settings.js (defaults 3 y 30 minutos, ver el catálogo). Se leen en cada llamada a
// checkHealthAndAlert(), no una sola vez al arrancar (paso 4 del plan de panel de administración),
// para que cambiarlos desde el panel aplique sin reiniciar el proceso.

function isEnabled() {
  return !!ALERT_EMAIL_TO;
}

// --- Estado del healthcheck repetido -------------------------------------------------------------
let consecutiveHealthFailures = 0;
let healthAlertActive = false; // true desde que se manda la primera alerta hasta que se recupera
let lastHealthAlertAt = 0;

async function sendAlert(subject, message) {
  try {
    await mailer.sendAlertEmail(ALERT_EMAIL_TO, subject, message);
    logger.warn({ subject }, 'Alerta enviada (Fase 4, alertas mínimas)');
  } catch (err) {
    // Si Resend mismo falla al mandar la alerta, no hay nada más que hacer del lado de este módulo
    // que dejarlo bien visible en los logs — no tiene sentido reintentar en loop ni hacer caer el
    // proceso por esto.
    logger.error({ err, subject }, 'No se pudo enviar el email de alerta (Fase 4, alertas mínimas)');
  }
}

// `healthy`/`checks` vienen de `computeHealthStatus()` en server.js — la misma función que usa
// `/health`, para que "lo que dispara una alerta" sea exactamente "lo que /health reportaría como
// error" y no una segunda definición de "sano" que se pueda desincronizar de la primera con el
// tiempo.
async function checkHealthAndAlert(healthy, checks) {
  if (healthy) {
    if (healthAlertActive) {
      // Se había alertado antes y ahora se recuperó — un solo email de "ya volvió", para que quien
      // recibió la alerta de caída no tenga que ir a consultar /health a mano para saber si ya se
      // resolvió solo.
      await sendAlert(
        'Recuperado',
        'El healthcheck volvió a responder OK después de haber estado fallando. No hace falta ninguna acción.'
      );
      healthAlertActive = false;
      lastHealthAlertAt = 0;
    }
    consecutiveHealthFailures = 0;
    return;
  }

  consecutiveHealthFailures++;
  const failureThreshold = settings.getSetting('ALERT_HEALTH_FAILURE_THRESHOLD');
  if (consecutiveHealthFailures < failureThreshold) return;

  const now = Date.now();
  // Primera vez que se cruza el umbral (`!healthAlertActive`), o ya se había alertado pero pasó el
  // cooldown y el problema sigue sin resolverse — en cualquiera de los dos casos, manda de nuevo.
  const cooldownMs = settings.getSetting('ALERT_COOLDOWN_MS');
  if (healthAlertActive && (now - lastHealthAlertAt) < cooldownMs) return;

  const failingChecks = Object.entries(checks)
    .filter(([, v]) => v && v.enabled !== false && v.ok === false)
    .map(([name, v]) => `${name}: ${v.error || 'sin detalle'}`);

  await sendAlert(
    'Healthcheck en falla',
    `El healthcheck lleva ${consecutiveHealthFailures} chequeo(s) seguido(s) en falla ` +
    `(umbral configurado: ${failureThreshold}).\n` +
    `Dependencias fallando: ${failingChecks.length > 0 ? failingChecks.join(', ') : '(ver /health para el detalle)'}`
  );
  healthAlertActive = true;
  lastHealthAlertAt = now;
}

// --- Estado de errores de R2 ----------------------------------------------------------------------
// A diferencia del healthcheck (donde "en falla" es un estado binario que se puede consultar de
// nuevo), los errores de R2 son eventos que ya pasaron (ver lib/metrics.js, recordR2Error) — lo que
// importa acá es notar cuándo el contador ACUMULATIVO sube desde la última vez que se revisó, no su
// valor absoluto (que solo crece con el tiempo, incluso por errores viejos ya resueltos).
let lastKnownR2ErrorCount = null; // null hasta el primer chequeo, para no alertar por errores previos al arranque de este job
let lastR2AlertAt = 0;

async function checkR2ErrorsAndAlert(r2Snapshot) {
  if (!r2Snapshot || !r2Snapshot.enabled) return;

  if (lastKnownR2ErrorCount === null) {
    // Primer chequeo tras arrancar: solo establece la base, no alerta — evita mandar un email por
    // errores que ya habían ocurrido antes de que este job empezara a correr (ej. si el proceso
    // reinició con `r2ErrorCount` en 0 de nuevo, ver la nota de lib/metrics.js sobre contadores
    // volátiles, no hay problema; pero si en el futuro esto se persistiera, esta guarda seguiría
    // siendo necesaria).
    lastKnownR2ErrorCount = r2Snapshot.errorCount;
    return;
  }

  if (r2Snapshot.errorCount <= lastKnownR2ErrorCount) return;

  const now = Date.now();
  if ((now - lastR2AlertAt) < settings.getSetting('ALERT_COOLDOWN_MS')) {
    // Todavía en cooldown de la alerta anterior — no manda un email nuevo por cada error individual
    // durante una racha, pero SÍ actualiza la base de comparación, para no acumular una alerta
    // gigante con todos los errores de la racha entera una vez que el cooldown termine.
    lastKnownR2ErrorCount = r2Snapshot.errorCount;
    return;
  }

  const newErrors = r2Snapshot.errorCount - lastKnownR2ErrorCount;
  await sendAlert(
    'R2 está devolviendo errores',
    `Se detectaron ${newErrors} error(es) nuevo(s) de Cloudflare R2 desde el último chequeo ` +
    `(total acumulado desde que arrancó el proceso: ${r2Snapshot.errorCount}).\n` +
    `Último error: ${r2Snapshot.lastError ? `${r2Snapshot.lastError.message} (${r2Snapshot.lastError.at})` : 'sin detalle'}`
  );
  lastKnownR2ErrorCount = r2Snapshot.errorCount;
  lastR2AlertAt = now;
}

module.exports = {
  isEnabled,
  checkHealthAndAlert,
  checkR2ErrorsAndAlert
};
