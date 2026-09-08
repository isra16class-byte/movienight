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

module.exports = { closeRoom };
