const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/room.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('// --- Recuperación de reproducción bloqueada');
const end = source.indexOf('// --- Fin de recuperación de reproducción', start);
const syncStart = source.indexOf('// --- Sincronización (solo se emite si soy host) ---');
const syncEnd = source.indexOf('// El host manda su posición', syncStart);
const dataStart = source.indexOf('// --- Posición inicial de la cinta ---');
const dataEnd = source.indexOf('\n});', dataStart) + 4;
assert.ok(start >= 0 && end > start && syncStart >= 0 && syncEnd > syncStart && dataEnd > dataStart);

// Código real; DOM, media y sockets simulados. No equivale a probar autoplay en navegador.
function fixture({ host = false } = {}) {
  const state = { plays: 0, emitted: [], now: 0, behavior: () => Promise.resolve() };
  const events = new Map();
  const handlers = {};
  const elements = {
    playbackNotice: { hidden: true }, playbackNoticeText: { textContent: '' },
    resumePlaybackBtn: { addEventListener: (_type, handler) => { state.resume = handler; } },
  };
  const player = {
    paused: true, currentTime: 0, playbackRate: 1, src: 'video-a.mp4',
    addEventListener: (event, handler, options) => {
      if (!events.has(event)) events.set(event, []);
      events.get(event).push({ handler, once: options?.once });
    },
    removeEventListener: (event, handler) => {
      events.set(event, (events.get(event) || []).filter(listener => listener.handler !== handler));
    },
    play: () => {
      state.plays++;
      return Promise.resolve(state.behavior()).then(() => { player.paused = false; fire('play'); });
    },
    pause: () => {
      if (player.paused) return;
      player.paused = true;
      fire('pause');
    },
  };
  function fire(event) {
    for (const listener of [...(events.get(event) || [])]) {
      if (listener.once) events.get(event).splice(events.get(event).indexOf(listener), 1);
      listener.handler();
    }
  }
  const context = vm.createContext({
    player, isHost: host, ignoreSync: false, lastKnownTime: 0,
    performance: { now: () => state.now },
    document: { getElementById: id => elements[id] },
    socket: { on: (event, handler) => { handlers[event] = handler; }, emit: (...args) => state.emitted.push(args) },
    setTimeout: () => 0, updateSubtitleTrack: () => {}, playPauseBtn: {},
  });
  vm.runInContext(source.slice(start, end) + source.slice(syncStart, syncEnd) + source.slice(dataStart, dataEnd), context);
  const hostButton = source.match(/^playPauseBtn\.onclick = .*;$/m)[0];
  vm.runInContext(hostButton, context);
  return {
    state, player, elements, fire,
    sync: data => handlers.sync(data), data: data => handlers['room-data'](data),
    reset: () => vm.runInContext('resetPlaybackRecovery()', context),
    hostClick: () => context.playPauseBtn.onclick(),
  };
}
const settle = () => new Promise(setImmediate);
const blocked = () => Object.assign(new Error('detalle del navegador'), { name: 'NotAllowedError' });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('autoplay: rechazo muestra aviso y heartbeat no repite intentos hasta el gesto', async () => {
  const f = fixture();
  f.state.behavior = () => Promise.reject(blocked());
  f.sync({ type: 'play', time: 12 });
  await settle();
  assert.equal(f.elements.playbackNotice.hidden, false);
  assert.match(f.elements.playbackNoticeText.textContent, /Tocá «Reanudar video»/);
  for (let i = 0; i < 3; i++) f.sync({ type: 'heartbeat', time: 20 + i, paused: false });
  await settle();
  assert.equal(f.state.plays, 1);
  f.state.behavior = () => Promise.resolve();
  f.state.resume();
  assert.equal(f.state.plays, 2, 'play se invoca dentro del gesto, antes de await');
  await settle();
  assert.equal(f.player.paused, false);
  assert.equal(f.elements.playbackNotice.hidden, true);
  assert.deepEqual(f.state.emitted, [], 'el invitado no emite controles de host');
});

test('autoplay: pausa del host oculta el aviso e invalida el botón', async () => {
  const f = fixture();
  f.state.behavior = () => Promise.reject(blocked());
  f.sync({ type: 'heartbeat', time: 10, paused: false });
  await settle();
  f.sync({ type: 'pause', time: 11 });
  f.state.resume();
  await settle();
  assert.equal(f.state.plays, 1);
  assert.equal(f.player.paused, true);
  assert.equal(f.elements.playbackNotice.hidden, true);
});

test('autoplay: resolución tardía no revive reproducción después de una pausa', async () => {
  const f = fixture();
  const pending = deferred();
  f.state.behavior = () => pending.promise;
  f.sync({ type: 'play', time: 0 });
  f.sync({ type: 'heartbeat', time: 4, paused: false });
  assert.equal(f.state.plays, 1, 'no duplica un intento pendiente');
  f.sync({ type: 'pause', time: 5 });
  pending.resolve();
  await settle();
  assert.equal(f.player.paused, true);
  assert.equal(f.elements.playbackNotice.hidden, true);
});

test('autoplay: rechazo viejo no muestra aviso sobre una cinta nueva pausada', async () => {
  const f = fixture();
  const pending = deferred();
  f.state.behavior = () => pending.promise;
  f.sync({ type: 'play', time: 0 });
  f.data({ videoFile: 'video-b.mp4', position: { time: 30, paused: true } });
  f.fire('loadedmetadata');
  pending.reject(blocked());
  await settle();
  assert.equal(f.elements.playbackNotice.hidden, true);
  assert.equal(f.player.currentTime, 30);
  f.state.resume();
  assert.equal(f.state.plays, 1);
});

test('autoplay: estado inicial en reproducción usa el mismo aviso y nueva cinta borra el anterior', async () => {
  const f = fixture();
  f.state.behavior = () => Promise.reject(blocked());
  f.data({ videoFile: 'video-b.mp4', position: { time: 18, paused: false } });
  f.fire('loadedmetadata');
  await settle();
  assert.equal(f.elements.playbackNotice.hidden, false);
  assert.equal(f.player.currentTime, 18);
  f.data({ videoFile: 'video-c.mp4', position: { time: 0, paused: true } });
  f.fire('loadedmetadata');
  assert.equal(f.elements.playbackNotice.hidden, true);
  f.state.resume();
  assert.equal(f.state.plays, 1);
});

test('autoplay: promesa vieja no borra un bloqueo más reciente y el fin limpia el aviso', async () => {
  const f = fixture();
  const pending = deferred();
  f.state.behavior = () => pending.promise;
  f.sync({ type: 'play', time: 0 });
  f.reset();
  f.state.behavior = () => Promise.reject(blocked());
  f.sync({ type: 'play', time: 20 });
  await settle();
  pending.resolve();
  await settle();
  assert.equal(f.elements.playbackNotice.hidden, false);
  f.fire('ended');
  assert.equal(f.elements.playbackNotice.hidden, true);
  f.state.resume();
  assert.equal(f.state.plays, 2);
});

test('autoplay: AbortError se captura sin aviso; otros fallos muestran texto fijo y pueden reintentarse', async () => {
  for (const error of [Object.assign(new Error('interrumpido'), { name: 'AbortError' }),
    Object.assign(new Error('https://private.invalid/?secret=qa'), { name: 'NotSupportedError' }), null]) {
    const f = fixture();
    f.state.behavior = () => { throw error; };
    f.sync({ type: 'play', time: 0 });
    await settle();
    assert.equal(f.elements.playbackNotice.hidden, error?.name === 'AbortError');
    assert.doesNotMatch(f.elements.playbackNoticeText.textContent, /private|secret|interrumpido/);
    f.state.behavior = () => Promise.resolve();
    f.state.resume();
    await settle();
    assert.equal(f.player.paused, false);
  }
});

test('autoplay: el control normal del host conserva su emisión y permite pausar', async () => {
  const f = fixture({ host: true });
  f.hostClick();
  await settle();
  assert.equal(f.state.emitted.length, 1);
  assert.equal(f.state.emitted[0][0], 'sync');
  assert.equal(f.state.emitted[0][1].type, 'play');
  f.hostClick();
  assert.equal(f.player.paused, true);
  assert.equal(f.state.emitted[1][1].type, 'pause');
});

test('autoplay: dos fuentes antes de metadata solo aplican la posición más nueva', async () => {
  const f = fixture();
  f.data({ videoFile: 'video-b.mp4', position: { time: 18, paused: false } });
  f.data({ videoFile: 'video-c.mp4', position: { time: 30, paused: true } });
  f.fire('loadedmetadata');
  await settle();
  assert.equal(f.player.currentTime, 30);
  assert.equal(f.player.paused, true);
  assert.equal(f.state.plays, 0, 'la fuente vieja no inicia reproducción');
});

test('autoplay: una posición nueva de la misma fuente o un sync previo a metadata ganan al estado inicial', async () => {
  const f = fixture();
  f.data({ videoFile: 'video-b.mp4', position: { time: 18, paused: false } });
  f.data({ videoFile: 'video-b.mp4', position: { time: 40, paused: true } });
  f.fire('loadedmetadata');
  assert.equal(f.player.currentTime, 40);
  assert.equal(f.state.plays, 0);
  f.data({ videoFile: 'video-c.mp4', position: { time: 0, paused: false } });
  f.sync({ type: 'pause', time: 55 });
  f.fire('loadedmetadata');
  await settle();
  assert.equal(f.player.currentTime, 55);
  assert.equal(f.player.paused, true);
  assert.equal(f.state.plays, 0);
});

test('autoplay: el botón play del host bloqueado reintenta y emite solo cuando reproduce', async () => {
  const f = fixture({ host: true });
  f.state.behavior = () => Promise.reject(blocked());
  f.hostClick();
  await settle();
  assert.equal(f.player.paused, true);
  assert.deepEqual(f.state.emitted, []);
  f.state.behavior = () => Promise.resolve();
  f.hostClick();
  await settle();
  assert.equal(f.player.paused, false);
  assert.equal(f.state.emitted.length, 1);
  assert.equal(f.state.emitted[0][1].type, 'play');
});

test('autoplay: seek antes de metadata conserva el estado inicial y usa el tiempo más reciente', async () => {
  const f = fixture();
  f.data({ videoFile: 'video-b.mp4', position: { time: 18, paused: false } });
  f.sync({ type: 'seek', time: 60 });
  f.fire('loadedmetadata');
  await settle();
  assert.equal(f.player.currentTime, 60);
  assert.equal(f.player.paused, false);
  assert.equal(f.state.plays, 1);
});

test('autoplay: reanudar invitado alcanza la última posición del host más el tiempo transcurrido', async () => {
  const f = fixture();
  f.state.behavior = () => Promise.reject(blocked());
  f.sync({ type: 'play', time: 20 });
  await settle();
  f.state.now = 1000;
  f.sync({ type: 'heartbeat', time: 30, paused: false });
  f.state.now = 3500;
  f.state.behavior = () => Promise.resolve();
  f.state.resume();
  await settle();
  assert.equal(f.player.currentTime, 32.5);
  assert.equal(f.player.playbackRate, 1);
  f.player.currentTime = 33;
  f.sync({ type: 'heartbeat', time: 36, paused: false });
  assert.equal(f.player.currentTime, 36, 'el primer heartbeat confirma la posición sin una corrección lenta');
  assert.deepEqual(f.state.emitted, []);
});

test('autoplay: alcanzar la posición no permite al invitado superar la duración ni cambiar el reloj del host', async () => {
  const f = fixture();
  f.player.duration = 90;
  f.state.behavior = () => Promise.reject(blocked());
  f.sync({ type: 'play', time: 89 });
  await settle();
  f.state.now = 5000;
  f.state.behavior = () => Promise.resolve();
  f.state.resume();
  await settle();
  assert.ok(f.player.currentTime < 90 && f.player.currentTime >= 89);
  const host = fixture({ host: true });
  host.state.behavior = () => Promise.reject(blocked());
  host.hostClick();
  await settle();
  host.player.currentTime = 10;
  host.state.now = 5000;
  host.state.behavior = () => Promise.resolve();
  host.state.resume();
  await settle();
  assert.equal(host.player.currentTime, 10);
});

test('autoplay: todos los caminos de play usan la captura y el botón tiene nombre accesible', () => {
  assert.equal((source.match(/player\.play\(/g) || []).length, 1);
  const html = fs.readFileSync(path.join(__dirname, '../public/room.html'), 'utf8');
  assert.match(html, /id="playbackNotice" hidden/);
  assert.match(html, /id="resumePlaybackBtn">▶ Reanudar video<\/button>/);
  assert.match(html, /id="playbackNoticeText" role="status" aria-live="polite"/);
});
