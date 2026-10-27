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

// --- Control temporal de una sala sin host (docs/PLAN-INTERRUPTORES.md, 3.2) ------------------------
// El traspaso automático (evento 'disconnect') solo funciona si queda alguien conectado cuando el host
// se va. Falla si el dueño es el último en irse, y tras un reinicio del proceso: hostSocketId no se
// guarda en Redis (hydrateRoom() en lib/roomStore.js lo deja en null), así que TODA sala restaurada
// vuelve sin host. Sin esta regla, quien entrara a una sala así quedaba de invitado aunque estuviera
// solo, porque isRoomOwner() solo reconoce al dueño.

// ¿La sala tiene hoy un host realmente conectado? No alcanza con mirar `room.hostSocketId !== null`:
// un id que quedó de antes (socket ya caído) no controla nada, y tratarlo como host dejaría la sala
// bloqueada sin nadie que pueda recibir el control temporal.
function roomHasLiveHost(io, room) {
  return !!room.hostSocketId && io.sockets.sockets.has(room.hostSocketId);
}

// Decide si quien entra recibe el control temporal. Solo se llama cuando NO es el dueño (el dueño ya
// recupera el control por isRoomOwner). Todo se recibe por parámetro para poder testearlo sin Socket.io.
//   - hostConnected:  resultado de roomHasLiveHost() (ya hay un host vivo → nadie más lo recibe)
//   - autoTransfer:   interruptor HOST_AUTO_TRANSFER. Apagado, el plan (3.1) dice que "nadie controla el
//                     video hasta que vuelva" el host; darle el control al primero que entre sería un
//                     traspaso automático por otra puerta, así que tampoco hay control temporal.
//   - allowAnonymous: interruptor ALLOW_ANONYMOUS_ROOMS. Encendido, cualquier persona que entre; apagado,
//                     solo quien tiene sesión de cuenta (una sala con solo anónimos puede quedar sin host).
function canTakeTemporaryHost({ hostConnected, autoTransfer, allowAnonymous, sessionUserId }) {
  if (hostConnected) return false;
  if (!autoTransfer) return false;
  return !!allowAnonymous || !!sessionUserId;
}

// Qué rol recibe quien se acaba de unir. Orden: dueño → control temporal → invitado. Emite el
// 'host-status' que corresponda (setHost emite el suyo para dueño y temporal). Devuelve
// 'owner' | 'temporary' | 'guest' (no lo usa el cliente; sirve para tests y para loguear).
//
// Si vuelve el dueño, isRoomOwner() lo reconoce y setHost() degrada al host temporal antes de promoverlo
// (nunca hay dos hosts), así que el dueño recupera el control sin cambios adicionales.
function assignHostOnJoin(io, room, roomId, socket, { hostToken, sessionUserId, autoTransfer, allowAnonymous }) {
  if (isRoomOwner(room, { hostToken, sessionUserId })) {
    setHost(io, room, roomId, socket);
    return 'owner';
  }
  if (canTakeTemporaryHost({ hostConnected: roomHasLiveHost(io, room), autoTransfer, allowAnonymous, sessionUserId })) {
    setHost(io, room, roomId, socket);
    return 'temporary';
  }
  socket.isHost = false;
  socket.emit('host-status', { isHost: false, hostToken: null });
  return 'guest';
}

module.exports = { isRoomOwner, setHost, roomHasLiveHost, canTakeTemporaryHost, assignHostOnJoin };
