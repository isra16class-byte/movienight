// --- Logger estructurado (Fase 4 del plan de producción, "logs estructurados") -------------------
// Hasta ahora todo el server logueaba con `console.log`/`console.error` y texto libre, armado a mano
// con template strings (ej. `Error creando sala desde biblioteca (R2): ${err.message}`) — funciona
// para leer en una terminal, pero es difícil de indexar/filtrar en cualquier servicio de logs real
// (Datadog, Better Stack, CloudWatch, etc., según el hosting que se elija — ver Fase 0 del plan) sin
// parsear texto con regex. Este módulo centraliza un logger sobre **pino** (JSON por línea, rápido,
// sin bindings nativos) que el resto del código usa en vez de `console.*` directo.
//
// Por qué pino y no reimplementarlo a mano (a diferencia de `loadDotEnv()` en server.js, que sí evita
// una librería a propósito): acá la funcionalidad real que hace falta — niveles, timestamps
// consistentes, serialización de errores con stack trace, y sobre todo REDACCIÓN de campos sensibles
// (ver `redact` abajo) — no es trivial de mantener bien a mano, y es exactamente el tipo de cosa que
// una librería chica y madura resuelve mejor que un wrapper casero.
const pino = require('pino');

// LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'. Default 'info' —
// suficiente para operar en producción sin el ruido de 'debug' (que sí puede ser útil prendido a mano
// un rato si hace falta investigar algo puntual).
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// LOG_PRETTY=1: formato legible en una sola línea coloreada, pensado para desarrollo local en una
// terminal — requiere tener instalado `pino-pretty` (no se agrega como dependencia obligatoria del
// proyecto a propósito: en producción real siempre conviene JSON crudo, que es lo que espera
// cualquier recolector de logs; pedirle a alguien que solo corre esto en un VPS que instale un
// paquete extra que nunca va a usar no tendría sentido). Si no está instalado, cae a JSON normal con
// un aviso — nunca rompe el arranque del server por esto.
const PRETTY = process.env.LOG_PRETTY === '1';

function buildTransport() {
  if (!PRETTY) return undefined;
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' } };
  } catch {
    // No usamos el logger todavía acá (se está construyendo) — un console.error puntual en el
    // arranque es aceptable para este único caso, no forma parte de los logs de operación normal.
    console.error('⚠️  LOG_PRETTY=1 pero "pino-pretty" no está instalado (npm install pino-pretty) — logueando en JSON normal.');
    return undefined;
  }
}

// --- Redacción de campos sensibles ----------------------------------------------------------------
// pino soporta paths estilo lodash/jmespath simplificado, con comodines `*` para "cualquier campo en
// cualquier nivel de anidamiento con ese nombre". Esto es la razón principal (además del formato) por
// la que vale la pena una librería acá: reemplaza el valor por '[Redacted]' en vez de mostrarlo, sin
// que cada `logger.info({...})` en el código tenga que acordarse de nunca pasar uno de estos campos
// — más fácil de auditar en un solo lugar que confiar en que cada callsite lo haga bien a mano.
// Cubre: contraseñas en texto plano o hasheadas, tokens de host/sesión/reset, y headers/cookies donde
// pueda venir una credencial cruda.
const REDACT_PATHS = [
  'password', '*.password',
  'passwordHash', '*.passwordHash',
  'libraryPasswordHash', '*.libraryPasswordHash',
  'hostToken', '*.hostToken',
  'sessionId', '*.sessionId',
  'token', '*.token',
  'req.headers.cookie',
  'req.headers["x-library-password"]',
  '*.headers.cookie',
  '*.headers["x-library-password"]'
];

const logger = pino({
  level: LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
  // Serializador estándar de pino para errores: incluye message/stack/type de forma consistente, en
  // vez de lo que salga de pasar un objeto Error crudo (que a veces serializa como `{}` según el
  // motor de JSON.stringify) — se activa automáticamente para cualquier campo llamado `err` o `error`.
  serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
  transport: buildTransport()
});

module.exports = logger;
