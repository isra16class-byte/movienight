const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setImmediate } = require('node:timers/promises');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'library.js'), 'utf8');

function sourceBetween(first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

const client = [
  sourceBetween('let mnModalHideTimer', '// --- Contraseña de biblioteca guardada'),
  sourceBetween('async function mnLibraryFetch(', '// --- Cuenta:'),
  sourceBetween('async function useTape(', 'async function deleteTape('),
].join('\n');

class Element extends EventTarget {
  classList = { add() {}, remove() {} };

  removeAttribute(name) {
    if (name === 'maxlength') this.maxLength = -1;
  }

  focus() { this.focused = true; }
  click() { this.dispatchEvent(new Event('click')); }
}

function fixture({ fromRoom = null, needsLibraryPassword = false } = {}) {
  const elements = new Map();
  const button = new Element();
  const state = { requests: [], libraryPassword: 'biblioteca-inicial', savedHost: [] };
  const window = {};
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    }
  };
  const getModal = name => document.getElementById('mnModal' + name);
  const li = { querySelector: () => button };
  const context = {
    document, window, fromRoom, roomHostToken: 'host-de-prueba', cassetteIcon: '<svg/>', useLabel: 'USAR',
    requestAnimationFrame: callback => callback(),
    setTimeout: () => 1,
    clearTimeout: () => {},
    getLibraryPw: () => state.libraryPassword,
    setLibraryPw: value => { state.libraryPassword = value; },
    clearLibraryPw: () => { state.libraryPassword = ''; },
    localStorage: { setItem: (...args) => state.savedHost.push(args) },
    async fetch(url, options) {
      state.requests.push({ url, body: JSON.parse(options.body), libraryPassword: options.headers['x-library-password'] });
      if (needsLibraryPassword && state.requests.length === 1) {
        return { status: 401, json: async () => ({ attemptsLeft: 2 }) };
      }
      return { status: 200, json: async () => ({ roomId: 'abc123', hostToken: 'host-creado' }) };
    }
  };
  const useTape = vm.runInNewContext(client + '\nuseTape', context);
  return { start: () => useTape('cinta.mp4', li), button, getModal, state, window };
}

test('biblioteca crea una sala con la contraseña opcional y conserva la clave de biblioteca por separado', async () => {
  const f = fixture();
  const pending = f.start();
  const input = f.getModal('Input');
  assert.equal(input.type, 'password');
  assert.equal(input.placeholder, 'Contraseña de la sala (opcional)');
  assert.equal(input.maxLength, 60);
  assert.equal(input.autocomplete, 'new-password');
  assert.equal(f.getModal('Ok').textContent, 'Crear sala');

  input.value = '  sala de prueba  ';
  f.getModal('Ok').click();
  await pending;

  assert.equal(input.value, '');
  assert.deepEqual(f.state.requests, [{
    url: '/create-room-from-upload',
    body: { filename: 'cinta.mp4', password: 'sala de prueba' },
    libraryPassword: 'biblioteca-inicial'
  }]);
  assert.deepEqual(f.state.savedHost, [['mn_host_abc123', 'host-creado']]);
  assert.equal(f.window.location, '/room/abc123');
});

test('biblioteca crea una sala abierta al confirmar sin contraseña', async () => {
  const f = fixture();
  const pending = f.start();
  f.getModal('Ok').click();
  await pending;
  assert.equal(f.state.requests.length, 1);
  assert.equal(f.state.requests[0].body.password, '');
});

test('Cancelar descarta la contraseña, recupera el botón y no solicita crear una sala', async () => {
  const f = fixture();
  const pending = f.start();
  const input = f.getModal('Input');
  input.value = 'descartada';
  f.getModal('Cancel').click();
  await pending;

  assert.equal(input.value, '');
  assert.deepEqual(f.state.requests, []);
  assert.equal(f.window.location, undefined);
  assert.equal(f.button.disabled, false);
  assert.equal(f.button.textContent, 'USAR');
  assert.equal(f.button.focused, true);
});

test('el reintento de autenticación de biblioteca conserva la contraseña de sala en el cuerpo', async () => {
  const f = fixture({ needsLibraryPassword: true });
  const pending = f.start();
  const input = f.getModal('Input');
  input.value = 'contraseña de sala';
  f.getModal('Ok').click();
  await setImmediate();

  assert.equal(input.placeholder, 'Contraseña de la biblioteca');
  assert.equal(input.maxLength, -1);
  assert.equal(input.autocomplete, 'off');
  assert.equal(input.value, '');
  input.value = 'biblioteca-nueva';
  f.getModal('Ok').click();
  await pending;

  assert.equal(f.state.requests.length, 2);
  assert.deepEqual(f.state.requests[1].body, f.state.requests[0].body);
  assert.equal(f.state.requests[1].libraryPassword, 'biblioteca-nueva');
  assert.equal(f.state.libraryPassword, 'biblioteca-nueva');
});

test('cambiar la cinta en una sala existente va directo a la ruta de cambio', async () => {
  const f = fixture({ fromRoom: 'sala-existente' });
  await f.start();
  assert.deepEqual(f.state.requests, [{
    url: '/room/sala-existente/change-video-from-upload',
    body: { filename: 'cinta.mp4', hostToken: 'host-de-prueba' },
    libraryPassword: undefined
  }]);
  assert.equal(f.getModal('Title').textContent, undefined);
  assert.equal(f.window.location, '/room/sala-existente');
});
