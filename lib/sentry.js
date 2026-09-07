// --- Reporte de errores (Fase 4 del plan de producción) -----------------------------------------
// Sentry es deliberadamente opcional: el proyecto puede seguir corriendo sin una cuenta/configuración
// de monitoreo, igual que ya hace con Postgres o Resend. `server.js` carga primero el .env con
// loadDotEnv(), y recién después llama a init(), por eso SENTRY_DSN nunca queda hardcodeado.
const Sentry = require('@sentry/node');
const logger = require('./logger');

let enabled = false;

// Debe mantenerse en sincronía conceptual con REDACT_PATHS de lib/logger.js. Sentry puede adjuntar
// objetos de request/extra por sus integraciones, así que la redacción se hace sobre el evento final,
// no solo sobre los contextos que construye este módulo.
const SENSITIVE_FIELD = /^(password|passwordhash|librarypassword|librarypasswordhash|hosttoken|sessionid|token|cookie|set-cookie|authorization|x-library-password)$/i;
const REDACTED = '[Redacted]';

function redactSensitiveData(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);

  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key)) value[key] = REDACTED;
    else if (child && typeof child === 'object') redactSensitiveData(child, seen);
  }
  return value;
}

function redactSensitiveQuery(url) {
  if (typeof url !== 'string') return url;
  try {
    const parsed = new URL(url, 'http://movienight.local');
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_FIELD.test(key)) parsed.searchParams.set(key, REDACTED);
    }
    return /^[a-z][a-z\d+.-]*:/i.test(url)
      ? parsed.toString()
      : `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function beforeSend(event) {
  redactSensitiveData(event);
  if (event.request) {
    // Nunca hacen falta para diagnosticar este proyecto y pueden contener credenciales aunque una
    // integración futura cambie sus defaults.
    delete event.request.cookies;
    if (event.request.headers) {
      delete event.request.headers.cookie;
      delete event.request.headers.authorization;
      delete event.request.headers['x-library-password'];
      delete event.request.headers['set-cookie'];
    }
    event.request.url = redactSensitiveQuery(event.request.url);
  }
  return event;
}

function init() {
  if (!process.env.SENTRY_DSN) return false;
  try {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      // Error Monitoring solamente: sin PII, Logs, Tracing ni Profiling.
      sendDefaultPii: false,
      enableLogs: false,
      // Los handlers globales ya existen en server.js. Se excluyen los equivalentes del SDK para
      // que uncaughtException/unhandledRejection se reporten exactamente una vez.
      integrations: (integrations) => integrations.filter((integration) => (
        integration.name !== 'OnUncaughtException' && integration.name !== 'OnUnhandledRejection'
      )),
      beforeSend
    });
    enabled = true;
    logger.info('Sentry configurado: reporte de errores habilitado.');
  } catch (err) {
    // Una configuración inválida nunca debe impedir que MovieNight arranque.
    logger.warn({ err }, 'No se pudo inicializar Sentry; se continúa sin reporte externo de errores');
  }
  return enabled;
}

function captureException(err, context = {}) {
  if (!enabled) return false;
  try {
    Sentry.captureException(err, context);
    return true;
  } catch (captureErr) {
    logger.warn({ err: captureErr }, 'No se pudo enviar un error a Sentry');
    return false;
  }
}

async function flush(timeoutMs = 2000) {
  if (!enabled) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch (err) {
    logger.warn({ err }, 'No se pudo vaciar la cola de Sentry antes de cerrar');
  }
}

function health() {
  // Sentry no ofrece un ping barato que no genere un evento. Como Resend, el healthcheck expone la
  // configuración sin inventar un chequeo de red ni convertir una dependencia opcional en crítica.
  return { enabled, ok: true };
}

module.exports = { init, isEnabled: () => enabled, captureException, flush, health };
