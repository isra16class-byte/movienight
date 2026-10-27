const test = require('node:test');
const assert = require('node:assert/strict');
const { isRoomOwner, setHost, roomHasLiveHost, canTakeTemporaryHost, assignHostOnJoin } = require('../lib/hostAuth');
const { hydrateRoom } = require('../lib/roomStore');

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

// --- Control temporal de una sala sin host (fase 3 de los interruptores, plan 3.2) -------------------
const OPEN = { autoTransfer: true, allowAnonymous: true }; // los defaults: todo permitido

test('roomHasLiveHost: sin hostSocketId, con un id que ya no está conectado, y con un host vivo', () => {
  const live = makeFakeSocket('socket-live');
  const io = makeFakeIo([live]);
  assert.equal(roomHasLiveHost(io, { hostSocketId: null }), false);
  assert.equal(roomHasLiveHost(io, { hostSocketId: 'socket-muerto' }), false); // id viejo: no controla nada
  assert.equal(roomHasLiveHost(io, { hostSocketId: 'socket-live' }), true);
});

test('canTakeTemporaryHost: con los defaults y sin host, cualquiera lo recibe (con o sin sesión)', () => {
  assert.equal(canTakeTemporaryHost({ hostConnected: false, ...OPEN }), true);
  assert.equal(canTakeTemporaryHost({ hostConnected: false, ...OPEN, sessionUserId: 7 }), true);
});

test('canTakeTemporaryHost: con un host conectado, nadie más lo recibe', () => {
  assert.equal(canTakeTemporaryHost({ hostConnected: true, ...OPEN }), false);
  assert.equal(canTakeTemporaryHost({ hostConnected: true, ...OPEN, sessionUserId: 7 }), false);
});

test('canTakeTemporaryHost: con ALLOW_ANONYMOUS_ROOMS apagado, solo quien tiene sesión de cuenta', () => {
  const base = { hostConnected: false, autoTransfer: true, allowAnonymous: false };
  assert.equal(canTakeTemporaryHost(base), false);
  assert.equal(canTakeTemporaryHost({ ...base, sessionUserId: null }), false);
  assert.equal(canTakeTemporaryHost({ ...base, sessionUserId: 7 }), true);
});

test('canTakeTemporaryHost: con HOST_AUTO_TRANSFER apagado, nadie lo recibe (ni con sesión)', () => {
  const base = { hostConnected: false, autoTransfer: false, allowAnonymous: true };
  assert.equal(canTakeTemporaryHost(base), false);
  assert.equal(canTakeTemporaryHost({ ...base, sessionUserId: 7 }), false);
});

test('assignHostOnJoin: sala anónima sin host — quien entra recibe el control temporal (con el hostToken de la sala)', () => {
  const room = { ownerUserId: null, hostToken: 'tok-abc', hostSocketId: null };
  const joiner = makeFakeSocket('socket-1');
  const io = makeFakeIo([joiner]);

  const role = assignHostOnJoin(io, room, 'room-1', joiner, { hostToken: 'otro', sessionUserId: undefined, ...OPEN });

  assert.equal(role, 'temporary');
  assert.equal(room.hostSocketId, 'socket-1');
  assert.equal(joiner.isHost, true);
  assert.deepEqual(joiner.emitted, [{ event: 'host-status', payload: { isHost: true, hostToken: 'tok-abc' } }]);
});

test('assignHostOnJoin: el dueño de una sala anónima sigue entrando como dueño (no como temporal)', () => {
  const room = { ownerUserId: null, hostToken: 'tok-abc', hostSocketId: null };
  const owner = makeFakeSocket('socket-1');
  const io = makeFakeIo([owner]);

  assert.equal(assignHostOnJoin(io, room, 'room-1', owner, { hostToken: 'tok-abc', ...OPEN }), 'owner');
  assert.equal(room.hostSocketId, 'socket-1');
});

test('assignHostOnJoin: con un host vivo, quien entra queda de invitado y el host no cambia', () => {
  const host = makeFakeSocket('socket-host');
  host.isHost = true;
  const guest = makeFakeSocket('socket-guest');
  const room = { ownerUserId: null, hostToken: 'tok-abc', hostSocketId: 'socket-host' };
  const io = makeFakeIo([host, guest]);

  const role = assignHostOnJoin(io, room, 'room-1', guest, { ...OPEN });

  assert.equal(role, 'guest');
  assert.equal(room.hostSocketId, 'socket-host');
  assert.equal(host.isHost, true);
  assert.equal(host.emitted.length, 0); // al host ni se le avisa
  assert.equal(guest.isHost, false);
  assert.deepEqual(guest.emitted, [{ event: 'host-status', payload: { isHost: false, hostToken: null } }]);
});

test('assignHostOnJoin: un hostSocketId viejo (socket ya caído) no bloquea el control temporal', () => {
  const room = { ownerUserId: null, hostToken: 'tok-abc', hostSocketId: 'socket-caido-hace-rato' };
  const joiner = makeFakeSocket('socket-1');
  const io = makeFakeIo([joiner]);

  assert.equal(assignHostOnJoin(io, room, 'room-1', joiner, { ...OPEN }), 'temporary');
  assert.equal(room.hostSocketId, 'socket-1');
});

test('assignHostOnJoin: ALLOW_ANONYMOUS_ROOMS apagado — un anónimo queda de invitado, una cuenta recibe el control', () => {
  const policy = { autoTransfer: true, allowAnonymous: false };

  const room1 = { ownerUserId: 'user-owner', hostToken: 'tok-abc', hostSocketId: null };
  const anon = makeFakeSocket('socket-anon');
  assert.equal(assignHostOnJoin(makeFakeIo([anon]), room1, 'room-1', anon, { ...policy }), 'guest');
  assert.equal(room1.hostSocketId, null); // la sala puede quedar sin host
  assert.equal(anon.isHost, false);

  const room2 = { ownerUserId: 'user-owner', hostToken: 'tok-abc', hostSocketId: null };
  const account = makeFakeSocket('socket-account');
  assert.equal(assignHostOnJoin(makeFakeIo([account]), room2, 'room-1', account, { ...policy, sessionUserId: 'user-2' }), 'temporary');
  assert.equal(room2.hostSocketId, 'socket-account');
});

test('assignHostOnJoin: HOST_AUTO_TRANSFER apagado — nadie recibe el control temporal, el dueño sí lo recupera', () => {
  const policy = { autoTransfer: false, allowAnonymous: true };
  const room = { ownerUserId: 'user-owner', hostToken: 'tok-abc', hostSocketId: null };

  const other = makeFakeSocket('socket-other');
  assert.equal(assignHostOnJoin(makeFakeIo([other]), room, 'room-1', other, { ...policy, sessionUserId: 'user-2' }), 'guest');
  assert.equal(room.hostSocketId, null);

  const owner = makeFakeSocket('socket-owner');
  assert.equal(assignHostOnJoin(makeFakeIo([owner]), room, 'room-1', owner, { ...policy, sessionUserId: 'user-owner' }), 'owner');
  assert.equal(room.hostSocketId, 'socket-owner');
});

test('assignHostOnJoin: el dueño era el último en irse — el siguiente recibe el control y el dueño lo recupera al volver (nunca dos hosts)', () => {
  // Estado tras el 'disconnect' del dueño con la sala vacía: hostSocketId en null (server.js).
  const room = { ownerUserId: 'user-owner', hostToken: 'tok-abc', hostSocketId: null };
  const temp = makeFakeSocket('socket-temp');
  const owner = makeFakeSocket('socket-owner');
  const io = makeFakeIo([temp, owner]);

  assert.equal(assignHostOnJoin(io, room, 'room-1', temp, { ...OPEN, sessionUserId: 'user-2' }), 'temporary');
  assert.equal(temp.isHost, true);

  assert.equal(assignHostOnJoin(io, room, 'room-1', owner, { ...OPEN, sessionUserId: 'user-owner' }), 'owner');
  assert.equal(room.hostSocketId, 'socket-owner');
  assert.equal(owner.isHost, true);
  assert.equal(temp.isHost, false);
  assert.deepEqual(temp.emitted.at(-1), { event: 'host-status', payload: { isHost: false, hostToken: null } });
  assert.equal([temp, owner].filter((s) => s.isHost).length, 1);
});

test('sala restaurada tras un reinicio: vuelve sin host y el primero que entra lo recibe; el segundo, no', () => {
  // hostSocketId no se guarda en Redis: hydrateRoom() reconstruye la sala con el de siempre en null.
  const room = hydrateRoom({
    videoFile: 'peli.mp4',
    hostToken: 'tok-persistido',
    ownerUserId: null,
    chatHistory: [],
    videoPosition: { time: 0, paused: true }
  });
  assert.equal(room.hostSocketId, null);

  const first = makeFakeSocket('socket-1');
  const second = makeFakeSocket('socket-2');
  const io = makeFakeIo([first, second]);

  assert.equal(assignHostOnJoin(io, room, 'room-1', first, { ...OPEN }), 'temporary');
  assert.equal(room.hostSocketId, 'socket-1');
  assert.equal(assignHostOnJoin(io, room, 'room-1', second, { ...OPEN }), 'guest');
  assert.equal(room.hostSocketId, 'socket-1');
  assert.equal(second.isHost, false);
});

test('sala restaurada con dueño y ALLOW_ANONYMOUS_ROOMS apagado: un anónimo no la toma, el dueño sí', () => {
  const room = hydrateRoom({ videoFile: 'peli.mp4', hostToken: 'tok', ownerUserId: 'user-owner' });
  const policy = { autoTransfer: true, allowAnonymous: false };
  const anon = makeFakeSocket('socket-anon');
  const owner = makeFakeSocket('socket-owner');
  const io = makeFakeIo([anon, owner]);

  assert.equal(assignHostOnJoin(io, room, 'room-1', anon, { ...policy }), 'guest');
  assert.equal(room.hostSocketId, null);
  assert.equal(assignHostOnJoin(io, room, 'room-1', owner, { ...policy, sessionUserId: 'user-owner' }), 'owner');
  assert.equal(room.hostSocketId, 'socket-owner');
});
