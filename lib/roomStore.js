// --- Persistencia externa del estado de las salas (Fase 1.1 del plan de producción) -------------
//
// Por qué existe este archivo: hasta ahora `rooms` (server.js) es un objeto plano en memoria del
// proceso Node — si el server se cae (crash, reinicio del hosting, un simple `git am` + reinicio
// manual), todas las salas activas desaparecen sin aviso: cinta cargada, contraseña, quién es host,
// quién está muteado, el chat entero. Este módulo persiste esa parte del estado en Redis para que
// sobreviva a un reinicio del proceso.
//
// Criterio de "fallar rápido y claro" (mismo que ya usa lib/r2.js, ver ese archivo): si Redis está
// configurado pero no responde, el server NO arranca en un modo silencioso "memoria nomás" — eso
// haría creer que hay persistencia cuando en realidad no la hay, justo el tipo de sorpresa que esta
// fase busca evitar. La única forma de correr sin Redis es el escape hatch explícito
// DISABLE_REDIS=1 (ver server.js), pensado solo para desarrollo local sin Docker/Redis instalado —
// nunca para producción.
//
// Qué se persiste y qué no: de todo lo que guarda `room` en server.js, solo una parte tiene sentido
// después de un reinicio real del proceso. Todo lo que está indexado por `socket.id` (hostSocketId,
// userNames, bufferingSockets) o por temporizadores en curso (recentDisconnects, que además guarda un
// `setTimeout` real — no serializable) deja de tener sentido apenas el proceso reinicia: TODOS los
// sockets de Socket.io se desconectan igual en un reinicio (no sobreviven ellos tampoco), así que esos
// campos arrancan limpios de nuevo naturalmente a medida que la gente se reconecta — no hace falta
// (ni se puede) persistirlos. Lo que sí importa mantener:
//   - videoFile / subtitleFile / videoPosition  → qué se está viendo y en qué momento
//   - hostToken / passwordHash / ownerUserId     → credenciales de la sala, no deberían resetearse
//                                                   (ownerUserId agregado en la Fase 2bis, "migración
//                                                   del rol de host" — ver server.js/isRoomOwner())
//   - mutedUserIds                               → por userId (persistente en localStorage del
//                                                   cliente, a diferencia de socket.id), sigue
//                                                   siendo válido cuando esa persona se reconecte
//   - chatHistory / initialVideoAnnounced        → continuidad del chat entre reinicios
// El host vuelve a quedar asignado solo: cuando su cliente se reconecte y mande el mismo `hostToken`
// guardado en su localStorage, el 'join-room' de siempre (ver server.js) ya lo reconoce y llama a
// setHost() — no hace falta ningún manejo especial acá para eso.

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
// Vía de escape SOLO para desarrollo local sin Redis instalado — ver nota grande arriba. En
// producción esto no debería estar seteado nunca: sin él, un Redis caído o mal configurado frena el
// arranque del server en vez de degradar en silencio a memoria (mismo criterio que R2).
const DISABLE_REDIS = process.env.DISABLE_REDIS === '1';

const KEY_PREFIX = 'movienight:room:';
const ROOM_INDEX_KEY = 'movienight:rooms'; // Set con todos los roomId activos, para poder listarlos
                                            // sin usar KEYS/SCAN (evitar barrer todo el keyspace de Redis).

let _client = null;

function isEnabled() {
  return !DISABLE_REDIS;
}

function getClient() {
  if (!_client) {
    _client = new Redis(REDIS_URL, {
      lazyConnect: true,
      // Reintentos con backoff acotado (no loop infinito inmediato) mientras el proceso ya está
      // corriendo — la Fase 1.3 (proceso supervisado) es la que se encarga de reiniciar el proceso
      // entero si Redis se cae en serio y no vuelve; esto es solo para cortes cortos de red.
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
      maxRetriesPerRequest: 3
    });
    _client.on('error', (err) => {
      // ioredis reintenta solo por debajo; esto es best-effort logging para no quedar en silencio
      // si Redis se cae DESPUÉS de un arranque exitoso (testConnection ya pasó en su momento).
      console.error('⚠️  Redis (roomStore) reportó un error de conexión:', err.message);
    });
  }
  return _client;
}

// Se llama una sola vez al arrancar el server (igual que r2.testConnection()) para chequear que
// Redis responda ANTES de aceptar tráfico — así el error aparece claro en consola al arrancar, no a
// mitad de la primera sala que alguien intente crear.
async function testConnection() {
  const client = getClient();
  await client.connect();
  await client.ping();
}

// Cierra la conexión a Redis prolijamente (Fase 1.4 del plan de producción, graceful shutdown) —
// `QUIT` espera a que terminen los comandos en curso antes de cerrar el socket, a diferencia de
// cortar la conexión de golpe. Si nunca se llegó a crear el cliente (ej. DISABLE_REDIS=1, o el
// proceso se cae antes de conectar) no hay nada que cerrar. No tira si falla: en un shutdown ya se
// está cerrando el proceso de todos modos, no tiene sentido bloquear ni loguear como error fatal.
async function closeConnection() {
  if (!_client) return;
  try {
    await _client.quit();
  } catch (err) {
    console.error('⚠️  Error cerrando la conexión a Redis (roomStore) durante el shutdown:', err.message);
  }
}

// Chequeo liviano de vida para el healthcheck (Fase 1.5 del plan de producción) — a diferencia de
// testConnection() (que además hace connect() y solo tiene sentido llamarla una vez al arrancar),
// esto reusa el cliente ya conectado y solo confirma que sigue respondiendo. Nunca tira: devuelve un
// resultado estructurado para que el endpoint de /health arme la respuesta, sea cual sea el estado.
async function ping() {
  if (!isEnabled()) return { enabled: false, ok: true }; // DISABLE_REDIS=1: no aplica, no es una falla
  try {
    await getClient().ping();
    return { enabled: true, ok: true };
  } catch (err) {
    return { enabled: true, ok: false, error: err.message };
  }
}

// --- Serialización -------------------------------------------------------------------------------
// Redis (a través de ioredis) solo guarda strings — Sets y Maps de JS (mutedUserIds, userNames, etc.)
// no tienen equivalente directo, así que se convierten a JSON. Ver la nota grande de arriba sobre
// qué campos se incluyen y por qué.
function serializeRoom(room) {
  return JSON.stringify({
    videoFile: room.videoFile,
    subtitleFile: room.subtitleFile,
    hostToken: room.hostToken,
    // ownerUserId (Fase 2bis, "migración del rol de host"): id de la cuenta que creó la sala, o null
    // si se creó sin sesión iniciada. Tiene que sobrevivir a un reinicio igual que hostToken — si no
    // se persistiera, una sala "con dueño" perdería esa protección después de un simple restart del
    // proceso y volvería a aceptar cualquier hostToken viejo dando vueltas.
    ownerUserId: room.ownerUserId || null,
    passwordHash: room.passwordHash,
    mutedUserIds: [...room.mutedUserIds],
    initialVideoAnnounced: room.initialVideoAnnounced,
    chatHistory: room.chatHistory,
    videoPosition: room.videoPosition
  });
}

// Reconstruye un objeto `room` completo (mismo shape que makeRoom() en server.js) a partir de lo
// guardado en Redis, completando con los valores "recién arrancado" los campos que dependen de
// conexiones de socket en vivo (ver nota grande de arriba: no sobreviven a un reinicio de todos
// modos, así que no hace falta ni tiene sentido persistirlos).
function hydrateRoom(data) {
  return {
    videoFile: data.videoFile,
    subtitleFile: data.subtitleFile || null,
    viewers: 0,
    hostToken: data.hostToken,
    hostSocketId: null,
    ownerUserId: data.ownerUserId || null,
    passwordHash: data.passwordHash || null,
    mutedUserIds: new Set(data.mutedUserIds || []),
    userNames: new Map(),
    bufferingSockets: new Set(),
    recentDisconnects: new Map(),
    initialVideoAnnounced: !!data.initialVideoAnnounced,
    chatHistory: Array.isArray(data.chatHistory) ? data.chatHistory : [],
    videoPosition: data.videoPosition || { time: 0, paused: true }
  };
}

// Guarda (o actualiza) el estado persistible de una sala. Se llama después de cada mutación
// relevante de `room` en server.js (crear sala, cambiar cinta, mute, chat, posición del video,
// etc.) — ver los comentarios en cada call site de por qué esa mutación puntual necesita guardarse.
// No tira si Redis falla: un error de un solo `save` no debería tirar abajo el evento de socket o la
// request HTTP que lo disparó (mismo criterio que unhandledRejection en server.js) — sí se loguea,
// para poder notar si Redis empieza a fallar de forma sostenida.
async function saveRoom(roomId, room) {
  const client = getClient();
  try {
    await client.multi()
      .set(KEY_PREFIX + roomId, serializeRoom(room))
      .sadd(ROOM_INDEX_KEY, roomId)
      .exec();
  } catch (err) {
    console.error(`⚠️  No se pudo guardar la sala ${roomId} en Redis:`, err.message);
  }
}

// Borra el estado persistido de una sala (para cuando exista un mecanismo de expiración/cierre de
// salas — Fase 2.6 del plan, todavía no implementada; esta función queda lista para cuando haga
// falta, no la llama nadie todavía).
async function deleteRoom(roomId) {
  const client = getClient();
  try {
    await client.multi()
      .del(KEY_PREFIX + roomId)
      .srem(ROOM_INDEX_KEY, roomId)
      .exec();
  } catch (err) {
    console.error(`⚠️  No se pudo borrar la sala ${roomId} de Redis:`, err.message);
  }
}

// Carga todas las salas guardadas en Redis al arrancar el server, para repoblar el objeto `rooms` en
// memoria (server.js) antes de aceptar conexiones — así una sala que ya existía sigue existiendo
// después de un reinicio, en vez de que todo el mundo reciba "la sala no existe" hasta crear una
// nueva. Usa SMEMBERS sobre el índice (ROOM_INDEX_KEY) en vez de KEYS/SCAN por patrón: con KEYS el
// costo crece con el tamaño TOTAL del keyspace de Redis (puede haber otras apps compartiendo la
// misma instancia) y puede bloquear el server de Redis un rato si hay muchas keys; SMEMBERS es O(N)
// sobre el tamaño del propio Set, que es exactamente la cantidad de salas de este proyecto.
async function loadAllRooms() {
  const client = getClient();
  const roomIds = await client.smembers(ROOM_INDEX_KEY);
  const result = {};
  if (roomIds.length === 0) return result;

  const values = await client.mget(roomIds.map((id) => KEY_PREFIX + id));
  for (let i = 0; i < roomIds.length; i++) {
    const raw = values[i];
    if (!raw) {
      // La key individual desapareció (ej. expiró o se borró a mano) pero el índice todavía la
      // menciona — se limpia el índice y se salta, en vez de reventar con un JSON.parse(null).
      client.srem(ROOM_INDEX_KEY, roomIds[i]).catch(() => {});
      continue;
    }
    try {
      result[roomIds[i]] = hydrateRoom(JSON.parse(raw));
    } catch (err) {
      console.error(`⚠️  No se pudo leer la sala ${roomIds[i]} desde Redis (dato corrupto, se descarta):`, err.message);
    }
  }
  return result;
}

module.exports = {
  isEnabled,
  testConnection,
  saveRoom,
  deleteRoom,
  loadAllRooms,
  closeConnection,
  ping,
  // Se expone el cliente ya conectado para que otros módulos que también necesiten Redis (hoy:
  // lib/sessionStore.js, Fase 2bis - Sesiones) reusen la MISMA conexión en vez de abrir una segunda —
  // es la misma instancia de Redis de todos modos, así que no hay ninguna ventaja en duplicar la
  // conexión, y sí una desventaja (el doble de overhead de reconexión/backoff si Redis se cae).
  getClient
};
