// --- Sistema de roles: quién es el "dueño" de una sala y quién es el host actual ------------------
// Extraído de server.js en la Fase 5 ("tests") para poder testear esta lógica aislada de Socket.io.
// Comportamiento sin cambios respecto al original — ver docs/MEMORIA.md, sección "Sistema de roles".

// Fase 2bis, "migración del rol de host": si la sala tiene dueño (se creó con una sesión iniciada),
// la única forma válida de reclamar el host es la sesión autenticada de esa cuenta — un hostToken de
// localStorage ya no alcanza. Si la sala es anónima (sin dueño), sigue valiendo el hostToken de
// siempre.
function isRoomOwner(room, { hostToken, sessionUserId } = {}) {
  if (room.ownerUserId) {
    return !!sessionUserId && sessionUserId === room.ownerUserId;
  }
  return !!hostToken && hostToken === room.hostToken;
}

// Único punto por donde una sala cambia de host. Garantiza que nunca haya más de un socket con
// isHost=true a la vez: si ya había un host distinto (conectado), lo degrada primero (y se lo avisa,
// para que su UI de host desaparezca) antes de promover al nuevo. Sin esto, un socket viejo con un
// hostToken todavía válido en localStorage podía "recuperar" el host sin quitárselo a quien ya lo
// tenía (traspaso automático o manual) — quedaban 2, o más, hosts simultáneos.
//
// `io` se recibe como parámetro (en vez de leerlo de un módulo global) para poder testear esta
// función con un `io` de mentira, sin levantar Socket.io real.
function setHost(io, room, roomId, socket) {
  if (room.hostSocketId && room.hostSocketId !== socket.id) {
    const prevHost = io.sockets.sockets.get(room.hostSocketId);
    if (prevHost) {
      prevHost.isHost = false;
      prevHost.emit('host-status', { isHost: false, hostToken: null });
    }
  }
  room.hostSocketId = socket.id;
  socket.isHost = true;
  socket.emit('host-status', { isHost: true, hostToken: room.hostToken });
}

module.exports = { isRoomOwner, setHost };
