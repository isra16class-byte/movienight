const test = require('node:test');
const assert = require('node:assert/strict');
const { closeRoom } = require('../lib/roomLifecycle');

// --- fakes -----------------------------------------------------------------------------------------
// `io` de mentira: necesita `to(roomId).emit(...)` (broadcast) y `sockets.adapter.rooms.get(roomId)` +
// `sockets.sockets.get(socketId)` (para encontrar y desconectar a cada socket de la sala), igual que
// el bloque original dentro de sweepExpiredRooms() en server.js.
function makeFakeSocket(id) {
  const left = [];
  let disconnected = false;
  return {
    id,
    leave(roomId) { left.push(roomId); },
    disconnect(force) { disconnected = true; this._disconnectForce = force; },
    get _left() { return left; },
    get _disconnected() { return disconnected; }
  };
}

function makeFakeIo(socketsInRoomIds, allSockets) {
  const broadcastEmitted = [];
  const roomsAdapter = new Map();
  if (socketsInRoomIds) roomsAdapter.set('room-1', new Set(socketsInRoomIds));
  const socketsMap = new Map(allSockets.map((s) => [s.id, s]));
  return {
    to(roomId) {
      return { emit(event, payload) { broadcastEmitted.push({ roomId, event, payload }); } };
    },
    sockets: { adapter: { rooms: roomsAdapter }, sockets: socketsMap },
    _broadcastEmitted: broadcastEmitted
  };
}

function makeFakeRoomStore() {
  const deletedRoomIds = [];
  return {
    async deleteRoom(roomId) { deletedRoomIds.push(roomId); },
    _deletedRoomIds: deletedRoomIds
  };
}

// --- tests -------------------------------------------------------------------------------------------

test('closeRoom: avisa a todos los sockets de la sala con el motivo recibido', async () => {
  const io = makeFakeIo([], []);
  const rooms = { 'room-1': { hostSocketId: 'socket-1' } };
  const roomStore = makeFakeRoomStore();

  await closeRoom(io, rooms, roomStore, 'room-1', 'Cerrada por un administrador.');

  assert.deepEqual(io._broadcastEmitted, [
    { roomId: 'room-1', event: 'room-error', payload: 'Cerrada por un administrador.' }
  ]);
});

test('closeRoom: desconecta y saca de la sala a cada socket que seguía adentro', async () => {
  const s1 = makeFakeSocket('socket-1');
  const s2 = makeFakeSocket('socket-2');
  const io = makeFakeIo(['socket-1', 'socket-2'], [s1, s2]);
  const rooms = { 'room-1': {} };
  const roomStore = makeFakeRoomStore();

  await closeRoom(io, rooms, roomStore, 'room-1', 'motivo');

  assert.deepEqual(s1._left, ['room-1']);
  assert.equal(s1._disconnected, true);
  assert.deepEqual(s2._left, ['room-1']);
  assert.equal(s2._disconnected, true);
});

test('closeRoom: si un socket del set ya no está conectado, no rompe (solo lo salta)', async () => {
  const s1 = makeFakeSocket('socket-1');
  // 'socket-fantasma' está en el set de la sala pero no en io.sockets.sockets (se desconectó justo
  // en el medio) — no debería tirar.
  const io = makeFakeIo(['socket-1', 'socket-fantasma'], [s1]);
  const rooms = { 'room-1': {} };
  const roomStore = makeFakeRoomStore();

  await assert.doesNotReject(() => closeRoom(io, rooms, roomStore, 'room-1', 'motivo'));
  assert.equal(s1._disconnected, true);
});

test('closeRoom: si nadie estaba conectado a la sala, no rompe (no hay set en el adapter)', async () => {
  const io = makeFakeIo(null, []); // sin entrada en roomsAdapter para 'room-1'
  const rooms = { 'room-1': {} };
  const roomStore = makeFakeRoomStore();

  await assert.doesNotReject(() => closeRoom(io, rooms, roomStore, 'room-1', 'motivo'));
});

test('closeRoom: borra la sala de `rooms` en memoria', async () => {
  const io = makeFakeIo([], []);
  const rooms = { 'room-1': {}, 'room-2': {} };
  const roomStore = makeFakeRoomStore();

  await closeRoom(io, rooms, roomStore, 'room-1', 'motivo');

  assert.equal('room-1' in rooms, false);
  assert.equal('room-2' in rooms, true); // no toca otras salas
});

test('closeRoom: borra la sala de roomStore (Redis)', async () => {
  const io = makeFakeIo([], []);
  const rooms = { 'room-1': {} };
  const roomStore = makeFakeRoomStore();

  await closeRoom(io, rooms, roomStore, 'room-1', 'motivo');

  assert.deepEqual(roomStore._deletedRoomIds, ['room-1']);
});
