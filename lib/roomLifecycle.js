// --- Cierre de una sala: la parte de sweepExpiredRooms() que no depende de "por qué" se cierra -----
// Extraído de server.js (paso 5 de docs/PLAN-PANEL-ADMIN.md) para poder testear esta lógica aislada
// de Socket.io, y para reusarla desde las acciones operativas del panel de administración (paso 7:
// "sweep-now" ya llamaba a esto vía sweepExpiredRooms(), pero "cerrar una sala puntual", "cerrar
// inactivas" y "cerrar TODAS" necesitaban la misma lógica sin pasar por el chequeo de TTL). Sin
// cambio de comportamiento respecto al bloque original dentro de sweepExpiredRooms() — ver
// docs/CHANGELOG.md.
//
// `io`, `rooms` y `roomStore` se reciben como parámetros (mismo criterio que ya usa
// lib/hostAuth.js::setHost con `io`) en vez de leerlos de un módulo global, para poder testear esta
// función con un `io`/`rooms` de mentira, sin levantar Socket.io real.
//
// `reason` es el mensaje que ve quien estaba mirando la sala (evento `room-error`) — cambia según el
// disparador (TTL vencido, cerrada por un administrador, "cerrar todas" en modo mantenimiento) para
// que el mensaje en pantalla ya diga la causa real, en vez de un genérico "la sala se cerró".
async function closeRoom(io, rooms, roomStore, roomId, reason) {
  io.to(roomId).emit('room-error', reason);
  const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
  if (socketsInRoom) {
    for (const socketId of [...socketsInRoom]) {
      const s = io.sockets.sockets.get(socketId);
      if (s) { s.leave(roomId); s.disconnect(true); }
    }
  }
  delete rooms[roomId];
  await roomStore.deleteRoom(roomId);
}

// --- Selector de "salas inactivas" (paso 7 de docs/PLAN-PANEL-ADMIN.md, secciones 1.3/5.1/7) --------
// Lógica pura (sin Socket.io ni Redis) a propósito, para poder testearla con objetos `rooms` de
// mentira — separada de closeRoom() de arriba (que sí necesita `io`/`roomStore` reales o de mentira)
// porque decidir QUÉ salas están inactivas es un cálculo, no una acción con efectos secundarios.
//
// Una sala está "inactiva" si tiene 0 viewers conectados Y quedó así hace al menos `marginMs` — el
// margen (ver server.js, RECONNECT_GRACE_MS) es el mismo que ya usa el proyecto para no floodear el
// chat con reconexiones cortas (alguien con wifi inestable no debería contar como "sala inactiva" el
// segundo exacto en que se corta). `room.emptySince` (server.js::makeRoom / lib/roomStore.js::hydrateRoom)
// es `null` mientras haya al menos un viewer, o el timestamp desde el que la sala quedó en 0.
function selectInactiveRoomIds(rooms, now, marginMs) {
  return Object.keys(rooms).filter((roomId) => {
    const room = rooms[roomId];
    return room.viewers === 0 && typeof room.emptySince === 'number' && (now - room.emptySince) >= marginMs;
  });
}

// --- Palabra de confirmación para "Cerrar TODAS las salas" (sección 1.3 del plan) --------------------
// Constante compartida entre el front (public/admin.html, paso 8) y el back (esta validación) para no
// tener el literal duplicado en dos archivos — aunque técnicamente el front no importa este módulo
// (es HTML/JS vanilla sin build step), documentarla acá deja un solo lugar "canónico" que citar.
const CLOSE_ALL_CONFIRMATION_PHRASE = 'CERRAR TODO';

// Comparación exacta (sin trim ni normalización de mayúsculas) a propósito: escribir la frase entera
// tal cual es justo lo que hace que este botón sea distinto de un `confirm()` de un click, ver la
// sección 1.3 del plan sobre por qué esta acción necesita una fricción mayor.
function isValidCloseAllConfirmation(confirm) {
  return confirm === CLOSE_ALL_CONFIRMATION_PHRASE;
}

module.exports = { closeRoom, selectInactiveRoomIds, CLOSE_ALL_CONFIRMATION_PHRASE, isValidCloseAllConfirmation };
