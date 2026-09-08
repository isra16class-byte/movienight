// --- Validación de variables de entorno al arrancar (Fase 5 del plan de producción, último punto
// pendiente de la fase) --------------------------------------------------------------------------
//
// Por qué existe este archivo: Redis/Postgres/R2 ya fallan rápido si están CONFIGURADOS y no
// responden (ver lib/roomStore.js, lib/db.js, lib/r2.js) — ese caso ya está cubierto. Lo que no
// estaba cubierto es la otra clase de error, más silenciosa: variables mal escritas o a medio
// configurar, que hoy no rompen nada al arrancar y recién se notan mucho más tarde, en producción
// real, en el peor momento posible. Dos ejemplos reales que motivaron este módulo:
//
//   1. R2 a medio configurar. `isR2Enabled()` (lib/r2.js) solo mira 4 de las 5 variables de R2 —
//      si alguien configura esas 4 pero se olvida (o tipea mal) `R2_PUBLIC_URL`, el server arranca
//      normal, la subida completa funciona normal (sube el video entero, varios GB), y recién al
//      final, cuando hay que armar el link público para guardar la sala/referencia, `getPublicUrl()`
//      tira su error — después de ya haber subido todo. Este módulo mueve ese chequeo al arranque:
//      si se detecta una configuración PARCIAL de R2 (algunas de las 5 variables sí, otras no), el
//      server no llega a abrir el puerto, con un mensaje que dice exactamente cuáles faltan.
//   2. Variables numéricas con un valor que no parsea. Casi todas siguen el patrón
//      `parseInt(process.env.X, 10) || default` — si `X` viene mal escrita (ej. "24h" en vez de
//      "24"), `parseInt` da `NaN`, y `NaN || default` cae calladita al default sin avisarle a nadie.
//      Quien configuró la variable queda pensando que su valor está aplicado cuando en realidad el
//      server está usando el default de siempre.
//
// Lo que este módulo NO hace a propósito: no exige que ninguna variable esté seteada (todo sigue
// siendo opcional, mismo criterio que el resto del proyecto — ver docs/MEMORIA.md, "Stack"). Solo
// detecta configuraciones a medias o valores con una forma inválida, en las variables que ya existen
// hoy. No reemplaza el fail-fast de conectividad de Redis/Postgres/R2 (eso sigue pasando después,
// al intentar conectar de verdad).

// Las 5 variables de R2. Ver lib/r2.js: REQUIRED_VARS ahí adentro solo pide las primeras 4 para que
// isR2Enabled() dé true — R2_PUBLIC_URL queda deliberadamente afuera de esa lista porque sin ella
// igual se puede subir/listar/borrar contra el bucket. Acá sí se incluyen las 5: el objetivo de este
// módulo es otro (avisar de una configuración parcial), no decidir si R2 "está activo".
const R2_VARS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_URL',
];

// name -> 'int' | 'float'. Todas las variables numéricas que hoy se leen con parseInt/parseFloat en
// server.js y lib/*.js (ver el comentario de cada una en su archivo de origen para el porqué de su
// default). Si se agrega una variable numérica nueva al proyecto, sumarla acá para que quede
// cubierta.
const NUMERIC_VARS = {
  SESSION_MAX_AGE_MS: 'int',
  R2_PRESIGN_EXPIRES_SECONDS: 'int',
  MAX_LIBRARY_VIDEOS: 'int',
  MAX_LIBRARY_SIZE_GB: 'float',
  ROOM_SWEEP_INTERVAL_MS: 'int',
  MULTIPART_SWEEP_INTERVAL_MS: 'int',
  MULTIPART_ABANDON_DAYS: 'float',
  ALERT_CHECK_INTERVAL_MS: 'int',
  SHUTDOWN_GRACE_MS: 'int',
  ALERT_HEALTH_FAILURE_THRESHOLD: 'int',
  ALERT_COOLDOWN_MS: 'int',
  ROOM_TTL_HOURS: 'float',
};

// Flags booleanos que el proyecto lee con `=== '1'` (ver lib/roomStore.js, lib/logger.js, server.js).
// Cualquier otro valor ("true", "yes", "on") se interpreta hoy como "no" sin ningún aviso — no es un
// error fatal (podría ser a propósito, ej. DISABLE_REDIS=0 de forma redundante), pero es un typo
// común que vale la pena avisar.
const BOOLEAN_FLAG_VARS = ['DISABLE_REDIS', 'SESSION_COOKIE_INSECURE', 'LOG_PRETTY'];

function isSet(env, key) {
  return typeof env[key] === 'string' && env[key].length > 0;
}

// Devuelve { errors, warnings } — nunca tira, para que el caller decida qué hacer con cada lista
// (ver validateOrExit más abajo). Recibe `env` por parámetro (default process.env) para poder
// testear con un objeto de mentira, sin tocar el entorno real del proceso que corre los tests.
function collectIssues(env = process.env) {
  const errors = [];
  const warnings = [];

  // 1. Grupo de R2: todo o nada. Si NINGUNA de las 5 está seteada, R2 simplemente no se usa (modo
  // disco local) — no es un error. Si están las 5, R2 queda bien configurado. El problema es el
  // punto medio: algunas sí, otras no.
  const r2Present = R2_VARS.filter((key) => isSet(env, key));
  if (r2Present.length > 0 && r2Present.length < R2_VARS.length) {
    const missing = R2_VARS.filter((key) => !isSet(env, key));
    errors.push(
      `Configuración de R2 incompleta: falta ${missing.join(', ')} (ya están seteadas ${r2Present.join(', ')}). ` +
      `O se configuran las 5 (R2 activo) o ninguna (modo disco local) — a medias, según qué falte, ` +
      `puede caer en modo disco local en silencio, o fallar recién al terminar de subir un video entero.`
    );
  }

  // 2. Variables numéricas: si está seteada pero no es un número válido de punta a punta, es casi
  // seguro un typo — y hoy cae callada al default sin que nadie se entere. A propósito NO se usa
  // `Number.isFinite(parseInt(x))` acá: parseInt/parseFloat son parsers "laxos" que ignoran
  // cualquier basura al final (`parseInt("24h", 10)` da `24`, sin avisar que la "h" sobrante se
  // descartó) — un match de regex de punta a punta sí detecta ese caso.
  const INT_RE = /^-?\d+$/;
  const FLOAT_RE = /^-?\d+(\.\d+)?$/;
  for (const [key, kind] of Object.entries(NUMERIC_VARS)) {
    if (!isSet(env, key)) continue;
    const raw = env[key].trim();
    const valid = kind === 'int' ? INT_RE.test(raw) : FLOAT_RE.test(raw);
    if (!valid) {
      errors.push(`${key}="${env[key]}" no es un número válido (se esperaba un ${kind === 'int' ? 'entero' : 'decimal'}).`);
    }
  }

  // 3. Flags booleanos: solo warning, no error — no cambia comportamiento fatal, pero es un typo
  // fácil de cometer y silencioso (queda funcionando "como si no estuviera seteada").
  for (const key of BOOLEAN_FLAG_VARS) {
    if (isSet(env, key) && env[key] !== '1') {
      warnings.push(`${key}="${env[key]}" no es "1" — se va a tratar como si NO estuviera activado (¿quisiste poner "1"?).`);
    }
  }

  return { errors, warnings };
}

// Corre collectIssues() contra el entorno real y decide qué hacer: los warnings se loguean y se
// sigue (no cambian el comportamiento del server, solo avisan de un typo probable); los errors se
// loguean TODOS juntos (no solo el primero, para no hacer resolver esto de a uno) y el proceso
// termina con código de salida 1 — mismo criterio de "fallar rápido y claro" que ya usan
// lib/roomStore.js, lib/db.js y lib/r2.js para sus propios chequeos de conectividad. Pensado para
// llamarse una sola vez, al principio de server.js, antes de que cualquier otro módulo lea
// process.env.* en sus propias constantes de nivel de módulo.
function validateOrExit(logger = console) {
  const { errors, warnings } = collectIssues();

  for (const warning of warnings) {
    (logger.warn || logger.log).call(logger, `⚠️  ${warning}`);
  }

  if (errors.length > 0) {
    const log = logger.error || logger.log;
    log.call(logger, `❌ Variables de entorno inválidas (${errors.length}):`);
    for (const error of errors) {
      log.call(logger, `   - ${error}`);
    }
    process.exit(1);
  }
}

module.exports = { collectIssues, validateOrExit, R2_VARS, NUMERIC_VARS, BOOLEAN_FLAG_VARS };
