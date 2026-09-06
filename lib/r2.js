// --- Cloudflare R2 (Fase 1) --------------------------------------------------------------------
//
// Por qué existe este archivo: el server sirve los videos desde disco local (public/uploads) y los
// transmite él mismo a cada espectador. Cuando la sala se comparte por Cloudflare Tunnel (para
// amigos fuera de la red local), todo ese tráfico pesado va apretado por la única conexión saliente
// del túnel gratis ("Quick Tunnel") — con un video de varios GB y más de un espectador remoto a la
// vez, eso se traba. R2 es el storage tipo S3 de Cloudflare: si el video vive ahí, ya no sale de tu
// compu en absoluto, lo sirve directo la red de Cloudflare a cada espectador, y el egress (ancho de
// banda de salida) es gratis siempre, sin tier — a diferencia de otros storages S3-compatibles.
//
// Esta Fase 1 SOLO monta la infraestructura: funciones para subir/listar/borrar contra un bucket de
// R2. Todavía no se conecta a /create-room, /create-room-from-upload, /room/:id/change-video ni a la
// biblioteca (/api/uploads) — eso es Fase 2 y 3. Nada de lo que ya funciona hoy (disco local) se
// toca ni se rompe con este archivo.
//
// Modo dual: si no están las 4 variables de entorno obligatorias, isR2Enabled() da false y el resto
// de las funciones tiran un error claro si se llaman igual — así ninguna parte del código puede
// "olvidarse" de chequear el modo antes de usar R2. Nadie queda obligado a configurar nada de esto;
// el server sigue andando en modo local (disco) exactamente como hasta ahora si no se completa el
// .env con las variables de R2 (ver .env.example).
//
// R2 es compatible con la API S3, así que se usa el SDK oficial de AWS (@aws-sdk/client-s3 +
// @aws-sdk/lib-storage) apuntando al endpoint de Cloudflare en vez de al de Amazon — no hace falta
// ningún SDK propio de Cloudflare para esto.

const { S3Client, ListObjectsV2Command, DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand, ListMultipartUploadsCommand, AbortMultipartUploadCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const path = require('path');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || '';
// URL pública desde donde se sirven los objetos del bucket (el dominio gratis *.r2.dev que da
// Cloudflare al activar "acceso público" en el bucket, o un dominio propio conectado al bucket).
// Sin barra final (ej. "https://pub-abc123.r2.dev"). Ver README para cómo conseguirlo.
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');

// Las 4 variables que hacen falta para que R2 quede "activo". R2_PUBLIC_URL no se exige acá porque
// sin ella igual se puede subir/listar/borrar — solo no se podría armar un link servible para el
// navegador (getPublicUrl tira su propio error aparte si falta, ver abajo).
const REQUIRED_VARS = { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME };

function isR2Enabled() {
  return Object.values(REQUIRED_VARS).every(v => v.length > 0);
}

// Cliente S3 apuntando al endpoint S3-compatible de R2. Se arma una sola vez (lazy) y se reusa.
let _client = null;
function getClient() {
  if (!isR2Enabled()) {
    throw new Error(
      'R2 no está configurado (faltan R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME en .env). ' +
      'Llamá isR2Enabled() antes de usar cualquier función de lib/r2.js.'
    );
  }
  if (!_client) {
    _client = new S3Client({
      region: 'auto', // R2 no tiene regiones tipo AWS, 'auto' es el valor que espera el SDK
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY
      }
    });
  }
  return _client;
}

// Prueba que las credenciales y el nombre de bucket sean correctos, sin subir ni listar nada pesado.
// Pensado para llamarse una vez al arrancar el server (Fase 3) y avisar por consola si algo está mal
// configurado, en vez de que el primer error aparezca recién cuando alguien intente subir un video.
async function testConnection() {
  const client = getClient();
  await client.send(new HeadBucketCommand({ Bucket: R2_BUCKET_NAME }));
}

// Arma una key de objeto para R2 con el mismo criterio que ya usa Multer para nombres de archivo en
// disco (server.js, storage.filename): un prefijo random + el nombre original saneado, para que dos
// personas subiendo "pelicula.mp4" no se pisen y para que la biblioteca pueda mostrar un nombre
// legible (ver displayNameFor en server.js, que ya sabe separar por "__").
function makeObjectKey(originalName) {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  const safeBase = base.replace(/[^a-zA-Z0-9 _\-]/g, '').trim().slice(0, 80) || 'video';
  return crypto.randomBytes(4).toString('hex') + '__' + safeBase + ext;
}

// Sube un stream (ej. el stream del request HTTP, o un ReadStream de fs) directo a R2, sin pasar por
// disco local ni cargarlo entero en memoria. Usa @aws-sdk/lib-storage (Upload) en vez de PutObject
// simple porque maneja solo la subida en partes (multipart) para archivos grandes — necesario para
// videos de varios GB, que es justo el caso de uso de este proyecto.
// Devuelve la key final del objeto en el bucket.
async function uploadStream(key, bodyStream, contentType) {
  const client = getClient();
  const upload = new Upload({
    client,
    params: {
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: bodyStream,
      ContentType: contentType || 'application/octet-stream'
    },
    queueSize: 4, // partes en paralelo
    partSize: 10 * 1024 * 1024 // 10MB por parte
  });
  await upload.done();
  return key;
}

// --- Cloudflare R2 — Fase 2.7: subida directa desde el navegador (URL prefirmada) ---------------
// Por qué existe esto: el camino de arriba (`uploadStream`, usado por `r2VideoStorage` en server.js)
// igual hace pasar el archivo por el proceso Node — el binario entra por HTTP al server (a través del
// Cloudflare Tunnel/proxy) y de ahí se reenvía a R2. Eso es justo lo que corta un video real con
// `413 Payload Too Large` de Cloudflare (el proxy tiene un tope de tamaño de request, independiente de
// cualquier límite que configure Multer/Express — ver docs/PLAN-PRODUCCION.md, Fase 2.7). Esta función
// arma una URL prefirmada de S3 (R2 es compatible) para que el navegador suba el archivo DIRECTO a R2,
// sin que el binario atraviese el Tunnel en ningún momento — el server nunca ve esos bytes, solo emite
// la URL firmada.
// Nota (documentada a propósito, no resuelta acá): esto firma un PUT simple (`PutObjectCommand`), no
// una subida multipart — el límite de un PUT simple contra S3/R2 es 5GB por objeto. Para películas muy
// pesadas (4K, o encoding poco eficiente) eso puede no alcanzar; el camino multipart prefirmado
// (CreateMultipartUpload + UploadPart firmado por parte + CompleteMultipartUpload) queda anotado como
// posible mejora futura si 5GB resulta insuficiente en la práctica, pero es bastante más trabajo del
// lado del cliente (armar los chunks, reintentar partes sueltas) y no bloquea el caso de uso típico.
// `contentType` viaja DENTRO de la firma (se lo pasamos al comando) — el PUT real desde el navegador
// tiene que mandar el mismo header `Content-Type`, si no coincide R2 rechaza el request con un error de
// firma. `expiresInSeconds` conviene generoso: es un video de varios GB, la subida real puede tardar
// bastante más que el default típico de una URL prefirmada (unos minutos) si la conexión de quien sube
// es lenta.
async function getPresignedUploadUrl(key, contentType, expiresInSeconds) {
  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType || 'application/octet-stream'
  });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

// Lista los objetos del bucket (paginando de a 1000, el máximo por página de la API S3) con el
// mismo shape que ya devuelve GET /api/uploads en modo local (server.js): filename, size, mtime —
// para que Fase 3 pueda enchufar esto en la biblioteca sin tener que tocar el HTML/JS del cliente.
async function listObjects() {
  const client = getClient();
  const results = [];
  let ContinuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET_NAME,
      ContinuationToken
    }));
    for (const obj of page.Contents || []) {
      results.push({
        filename: obj.Key,
        size: obj.Size,
        mtime: obj.LastModified ? new Date(obj.LastModified).getTime() : 0
      });
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return results;
}

async function deleteObject(key) {
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
}

// --- Cloudflare R2 — Fase 3: existencia de un objeto puntual ------------------------------------
// Usado por server.js para validar un `filename` (en realidad una key de R2) que llega desde el
// cliente antes de reutilizarlo (crear sala / cambiar cinta desde la biblioteca) o antes de
// borrarlo — el mismo rol que cumple `fs.existsSync` en modo disco local (ver
// `isValidUploadReference` en server.js). Se usa HEAD en vez de listar todo el bucket y buscar la
// key adentro: HEAD es una sola operación barata contra un objeto puntual, mientras que
// `listObjects()` puede implicar varias páginas si el bucket tiene muchos videos.
async function objectExists(key) {
  const client = getClient();
  try {
    await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    return true;
  } catch (err) {
    const status = err && err.$metadata && err.$metadata.httpStatusCode;
    if (status === 404 || err.name === 'NotFound') return false;
    throw err; // cualquier otro error (credenciales, conexión) sí se propaga, no se confunde con "no existe"
  }
}

// --- Cloudflare R2 — limpieza de subidas multipart abandonadas ----------------------------------
// Por qué existe esto: `uploadStream` (arriba) sube los videos en partes (multipart) vía
// @aws-sdk/lib-storage. Si una subida se corta a medias (se cierra la pestaña, se cae el túnel, se
// reinicia el server local mientras un video está subiendo), las partes que ya llegaron a R2 quedan
// ocupando espacio y facturando, pero como el objeto nunca se "completó" no aparecen en
// `listObjects()` (ListObjectsV2 solo lista objetos completos) — el bucket se ve vacío en el
// dashboard de Cloudflare pero el tamaño ocupado no baja. R2 tiene por defecto una regla de
// lifecycle que las aborta solas a los 7 días de iniciadas, pero si querés liberar el espacio antes
// (o confirmar que el problema es justamente este), hace falta listarlas y abortarlas a mano — eso
// es lo que hacen estas dos funciones, usadas por `scripts/r2-cleanup-multipart.js`.
async function listMultipartUploads() {
  const client = getClient();
  const results = [];
  let KeyMarker, UploadIdMarker;
  do {
    const page = await client.send(new ListMultipartUploadsCommand({
      Bucket: R2_BUCKET_NAME,
      KeyMarker,
      UploadIdMarker
    }));
    for (const u of page.Uploads || []) {
      results.push({
        key: u.Key,
        uploadId: u.UploadId,
        initiated: u.Initiated ? new Date(u.Initiated).getTime() : 0
      });
    }
    KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    UploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (KeyMarker);
  return results;
}

// Cancela una subida multipart puntual (identificada por key + uploadId, ambos vienen de
// listMultipartUploads) y libera el espacio de las partes ya subidas. Operación gratis (no cuenta
// como Class A/B) y sin vuelta atrás: las partes subidas hasta ese punto se borran para siempre.
async function abortMultipartUpload(key, uploadId) {
  const client = getClient();
  await client.send(new AbortMultipartUploadCommand({ Bucket: R2_BUCKET_NAME, Key: key, UploadId: uploadId }));
}

// URL pública servible directo por el navegador (<video src="...">) para una key del bucket. Requiere
// R2_PUBLIC_URL configurada (ver arriba) — si el bucket no tiene acceso público activado, esta URL
// no va a funcionar aunque la variable esté seteada; ver README para activarlo.
function getPublicUrl(key) {
  if (!R2_PUBLIC_URL) {
    throw new Error('R2_PUBLIC_URL no está configurada en .env — hace falta para armar el link público de un objeto.');
  }
  return `${R2_PUBLIC_URL}/${key}`;
}

module.exports = {
  isR2Enabled,
  testConnection,
  makeObjectKey,
  uploadStream,
  getPresignedUploadUrl,
  listObjects,
  deleteObject,
  objectExists,
  listMultipartUploads,
  abortMultipartUpload,
  getPublicUrl
};
