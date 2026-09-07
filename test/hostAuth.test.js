const test = require('node:test');
const assert = require('node:assert/strict');
const { isRoomOwner, setHost } = require('../lib/hostAuth');

test('isRoomOwner: sala sin dueño (anónima) — el hostToken alcanza por sí solo', () => {
  const room = { ownerUserId: null, hostToken: 'tok-123' };
  assert.equal(isRoomOwner(room, { hostToken: 'tok-123' }), true);
  assert.equal(isRoomOwner(room, { hostToken: 'otro-token' }), false);
  assert.equal(isRoomOwner(room, {}), false);
  // Con sala anónima, una sessionUserId no alcanza si el hostToken no matchea.
  assert.equal(isRoomOwner(room, { sessionUserId: 'user-1' }), false);
});

test('isRoomOwner: sala con dueño — solo la sesión de esa cuenta autoriza, el hostToken solo no', () => {
  const room = { ownerUserId: 'user-1', hostToken: 'tok-123' };
  assert.equal(isRoomOwner(room, { sessionUserId: 'user-1' }), true);
  assert.equal(isRoomOwner(room, { sessionUserId: 'user-2' }), false);
  assert.equal(isRoomOwner(room, { hostToken: 'tok-123' }), false); // el token solo ya no alcanza
  assert.equal(isRoomOwner(room, {}), false);
});

// --- setHost -------------------------------------------------------------------------------------
// `io` de mentira: solo necesita sockets.sockets.get(id) para encontrar al host anterior.
function makeFakeSocket(id) {
  const emitted = [];
  return {
    id,
    isHost: false,
    emit(event, payload) { emitted.push({ event, payload }); },
    emitted
  };
}

function makeFakeIo(sockets) {
  const map = new Map(sockets.map((s) => [s.id, s]));
  return { sockets: { sockets: map } };
}

test('setHost: primera vez que se asigna, no hay host previo que degradar', () => {
  const room = { hostSocketId: null, hostToken: 'tok-abc' };
  const newHost = makeFakeSocket('socket-1');
  const io = makeFakeIo([newHost]);

  setHost(io, room, 'room-1', newHost);

  assert.equal(room.hostSocketId, 'socket-1');
  assert.equal(newHost.isHost, true);
  assert.deepEqual(newHost.emitted, [
    { event: 'host-status', payload: { isHost: true, hostToken: 'tok-abc' } }
  ]);
});

test('setHost: degrada al host anterior antes de promover al nuevo (nunca dos hosts a la vez)', () => {
  const prevHost = makeFakeSocket('socket-old');
  prevHost.isHost = true;
  const newHost = makeFakeSocket('socket-new');
  const room = { hostSocketId: 'socket-old', hostToken: 'tok-xyz' };
  const io = makeFakeIo([prevHost, newHost]);

  setHost(io, room, 'room-1', newHost);

  assert.equal(prevHost.isHost, false);
  assert.deepEqual(prevHost.emitted, [
    { event: 'host-status', payload: { isHost: false, hostToken: null } }
  ]);
  assert.equal(newHost.isHost, true);
  assert.equal(room.hostSocketId, 'socket-new');
});

test('setHost: si el "host anterior" ya no está conectado, no rompe (solo promueve al nuevo)', () => {
  const newHost = makeFakeSocket('socket-new');
  const room = { hostSocketId: 'socket-desconectado-hace-rato', hostToken: 'tok-xyz' };
  const io = makeFakeIo([newHost]); // el socket viejo no está en el mapa

  assert.doesNotThrow(() => setHost(io, room, 'room-1', newHost));
  assert.equal(room.hostSocketId, 'socket-new');
  assert.equal(newHost.isHost, true);
});

test('setHost: reasignar el mismo socket que ya es host no se "degrada a sí mismo"', () => {
  const host = makeFakeSocket('socket-1');
  host.isHost = true;
  const room = { hostSocketId: 'socket-1', hostToken: 'tok-abc' };
  const io = makeFakeIo([host]);

  setHost(io, room, 'room-1', host);

  assert.equal(host.isHost, true);
  // Solo el emit de "vuelvo a ser host", no un emit previo de "dejaste de ser host".
  assert.deepEqual(host.emitted, [
    { event: 'host-status', payload: { isHost: true, hostToken: 'tok-abc' } }
  ]);
});
