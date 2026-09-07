// --- Validación real de archivos subidos (Fase 2.5 del plan de producción) -----------------------
//
// Por qué existe este archivo: hasta ahora la única validación de "esto es un video" era el
// `Content-Type` que manda el navegador en el multipart (ver `upload.single('video')` en server.js)
// — un header trivial de falsificar desde cualquier cliente HTTP (curl, Postman, un script), no algo
// que dependa del contenido real del archivo. Alguien podía subir cualquier binario (o nada,
// solo bytes al azar) etiquetado como `video/mp4` y el server lo aceptaba igual, ocupando espacio en
// disco/R2 y quedando disponible en la biblioteca compartida como si fuera un video real.
//
// La validación acá es por **magic bytes**: los primeros bytes reales del archivo, que cada
// contenedor de video (MP4, Matroska/WebM, AVI, QuickTime) escribe con una firma propia — es lo
// mismo que usa por ejemplo el comando `file` de Unix, y bastante más difícil de falsificar sin que
// el archivo deje de ser un video real y reproducible en un navegador de verdad.
//
// La librería `file-type` (v22) es ESM-only — este archivo es CommonJS (como el resto del proyecto,
// ver `require` en server.js), así que se importa con `import()` dinámico dentro de la función, no
// con un `require()` de nivel de módulo (fallaría: Node no puede hacer `require()` sincrónico de un
// paquete ESM). No hace falta cachear el resultado del import a mano: Node ya cachea los módulos ESM
// igual que los CommonJS, así que llamadas repetidas no vuelven a re-parsear el paquete.
//
// `SNIFF_BYTES`: cuántos bytes iniciales del archivo hacen falta para que `file-type` detecte el
// formato con confianza. La librería recomienda un mínimo de 4100 bytes (algunos contenedores, sobre
// todo variantes de MP4/QuickTime, guardan su caja de metadata identificatoria un poco después del
// arranque del archivo, no en el primer byte) — pedir menos arriesga falsos negativos (un video real
// rechazado por no alcanzar a leer la firma), pedir de más no suma nada y ralentiza sin necesidad
// tanto la subida en streaming (Fase 2.5, modo R2) como la lectura del archivo ya escrito (modo disco).
const SNIFF_BYTES = 4100;

// Extensiones de video que ya acepta el resto del proyecto (VIDEO_EXTENSIONS en server.js) — se
// repite acá la misma lista (en vez de importarla) para que este módulo no dependa de server.js y se
// pueda testear/reusar suelto; si un día se agrega una extensión nueva hay que sumarla en los dos
// lugares, es la misma situación que ya vive el proyecto con otras constantes chicas duplicadas.
const ALLOWED_VIDEO_EXTS = new Set(['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v']);

// Analiza los primeros bytes de un archivo (buffer, no hace falta el archivo entero) y confirma que
// el contenido real matchea alguno de los contenedores de video que el proyecto acepta. Devuelve
// `{ valid: true, ext, mime }` o `{ valid: false, reason }` — nunca tira excepción por un archivo
// inválido (solo por un error real de la librería, ej. buffer vacío/undefined).
async function isValidVideoBuffer(buffer) {
  if (!buffer || buffer.length === 0) {
    return { valid: false, reason: 'El archivo llegó vacío.' };
  }
  const { fileTypeFromBuffer } = await import('file-type');
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected) {
    return { valid: false, reason: 'No se reconoce el contenido como un formato de video válido.' };
  }
  if (!ALLOWED_VIDEO_EXTS.has(detected.ext)) {
    return { valid: false, reason: `El archivo es un ${detected.mime} (.${detected.ext}), no un formato de video soportado.` };
  }
  return { valid: true, ext: detected.ext, mime: detected.mime };
}

// --- Subtítulos (.srt / .vtt) --------------------------------------------------------------------
// A diferencia del video, no existe una librería de "magic bytes" para subtítulos — son texto plano,
// no tienen una firma binaria propia. La validación acá es de **estructura**: un archivo de
// subtítulos real tiene, como mínimo, un bloque con una marca de tiempo reconocible
// ("00:00:01,000 --> 00:00:04,000" en SRT, con coma; "00:00:01.000 --> 00:00:04.000" en VTT, con
// punto) — algo que un archivo binario cualquiera (o un video renombrado a .srt) prácticamente nunca
// va a producir por casualidad al leerse como texto. Se suma un chequeo de bytes de control: un
// archivo de subtítulos real, al ser texto, no debería tener bytes nulos ni la mayoría de los
// caracteres de control ASCII (0-8, 11, 12, 14-31) salvo salto de línea/retorno de carro/tab —
// aparecer varios de esos es la señal más clara de "esto no es texto", más confiable que confiar en
// que `buffer.toString('utf8')` no tire error (igual "decodifica" bytes arbitrarios sin quejarse).
const TIMESTAMP_VTT = /\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}/;
const TIMESTAMP_SRT = /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
// Umbral de "esto es binario, no texto": una proporción baja a propósito — un subtítulo real
// (incluso con algún caracter raro por un encoding mal detectado) no debería acercarse ni de lejos a
// este ratio, mientras que un binario genuino lo supera enseguida con una muestra chica.
const CONTROL_CHAR_RATIO_LIMIT = 0.01;

function isValidSubtitleContent(text, ext) {
  if (!text || typeof text !== 'string') {
    return { valid: false, reason: 'El archivo llegó vacío.' };
  }
  const normalizedExt = (ext || '').replace(/^\./, '').toLowerCase();
  if (normalizedExt !== 'srt' && normalizedExt !== 'vtt') {
    return { valid: false, reason: 'Extensión de subtítulo no soportada.' };
  }

  // Chequeo de "esto es texto de verdad", antes de mirar la estructura — evita que un binario que
  // por pura casualidad contenga la secuencia de caracteres "-->" en algún punto pase el chequeo de
  // timestamp de abajo.
  const sampleLength = Math.min(text.length, 8192);
  const sample = text.slice(0, sampleLength);
  let controlCount = 0;
  for (let i = 0; i < sample.length; i++) {
    if (CONTROL_CHARS.test(sample[i])) controlCount++;
  }
  if (sampleLength > 0 && controlCount / sampleLength > CONTROL_CHAR_RATIO_LIMIT) {
    return { valid: false, reason: 'El contenido no parece texto plano (demasiados bytes de control) — no parece un archivo de subtítulos real.' };
  }

  // WebVTT exige literalmente empezar con la cabecera "WEBVTT" (spec propia); SRT no tiene cabecera,
  // así que ahí lo único verificable es que exista al menos un bloque de timestamp real.
  if (normalizedExt === 'vtt') {
    const startsRight = text.trimStart().slice(0, 6) === 'WEBVTT';
    if (!startsRight) {
      return { valid: false, reason: 'Un archivo .vtt válido tiene que empezar con la cabecera "WEBVTT".' };
    }
    if (!TIMESTAMP_VTT.test(text)) {
      return { valid: false, reason: 'No se encontró ningún bloque de tiempo con el formato de WebVTT (HH:MM:SS.mmm --> HH:MM:SS.mmm).' };
    }
    return { valid: true };
  }

  // .srt
  if (!TIMESTAMP_SRT.test(text)) {
    return { valid: false, reason: 'No se encontró ningún bloque de tiempo con el formato de SRT (HH:MM:SS,mmm --> HH:MM:SS,mmm).' };
  }
  return { valid: true };
}

module.exports = {
  SNIFF_BYTES,
  isValidVideoBuffer,
  isValidSubtitleContent
};
