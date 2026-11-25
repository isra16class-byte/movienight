const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
const modalStart = source.indexOf('let mnModalHideTimer');
const modalEnd = source.indexOf('// --- Contraseña de biblioteca', modalStart);
const loginStart = source.indexOf('async function doLogin()');
const loginEnd = source.indexOf('\n}\n', loginStart);
assert.ok(modalStart >= 0 && modalEnd > modalStart && loginStart >= 0 && loginEnd > loginStart);
const client = source.slice(modalStart, modalEnd) + source.slice(loginStart, loginEnd + 3);
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Ejecuta doLogin y los modales reales; solo el DOM y la respuesta HTTP son dobles.
function fixture(response) {
  const elements = new Map();
  for (const id of ['mnModalOverlay', 'mnModalTitle', 'mnModalMessage', 'mnModalInput',
    'mnModalError', 'mnModalOk', 'mnModalCancel']) {
    const listeners = new Map();
    elements.set(id, {
      hidden: true, value: '', textContent: '', classList: { add() {}, remove() {} }, focus() {},
      addEventListener: (event, fn) => listeners.set(event, fn),
      removeEventListener: (event) => listeners.delete(event),
      click: () => listeners.get('click')?.(),
    });
  }
  const state = { requests: [], recovery: [], rendered: 0, navigated: 0 };
  const context = vm.createContext({
    document: { getElementById: (id) => {
      assert.ok(elements.has(id), `elemento inesperado: ${id}`);
      return elements.get(id);
    } },
    requestAnimationFrame: (fn) => fn(), setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, options) => {
      state.requests.push({ url, body: JSON.parse(options.body) });
      return { json: async () => response };
    },
    currentUser: null,
    renderAccountBar: () => { state.rendered++; },
    goToPendingRoom: () => { state.navigated++; },
    doForgotPassword: async (email) => { state.recovery.push(email); },
  });
  vm.runInContext(client, context);
  async function click(id, value) {
    if (value !== undefined) elements.get('mnModalInput').value = value;
    elements.get(id).click();
    await tick();
  }
  return { state, context, elements, click, start: () => context.doLogin() };
}

for (const error of ['Email o contraseña incorrectos.',
  'Demasiados intentos fallidos. Esperá 15 min y volvé a intentar.']) {
  test(`login UI: muestra el rechazo del servidor y permite cancelar: ${error}`, async () => {
    const f = fixture({ error });
    const task = f.start();
    await f.click('mnModalOk', 'qa@example.invalid');
    await f.click('mnModalOk', 'clave-solo-de-prueba');
    assert.equal(f.elements.get('mnModalTitle').textContent, 'No se pudo iniciar sesión');
    assert.equal(f.elements.get('mnModalMessage').textContent, `${error}\n\n¿Olvidaste tu contraseña?`);
    assert.equal(f.elements.get('mnModalCancel').hidden, false);
    await f.click('mnModalCancel');
    await task;
    assert.equal(f.state.requests.length, 1);
    assert.equal(f.state.requests[0].url, '/auth/login');
    assert.deepEqual(f.state.recovery, []);
    assert.equal(f.state.rendered, 0);
  });
}

test('login UI: aceptar el aviso ofrece recuperar la misma cuenta', async () => {
  const f = fixture({ error: 'Email o contraseña incorrectos.' });
  const task = f.start();
  await f.click('mnModalOk', 'qa@example.invalid');
  await f.click('mnModalOk', 'clave-solo-de-prueba');
  await f.click('mnModalOk');
  await task;
  assert.deepEqual(f.state.recovery, ['qa@example.invalid']);
});

test('login UI: un éxito actualiza la cuenta y continúa tras cerrar el aviso', async () => {
  const f = fixture({ id: 'qa', email: 'qa@example.invalid' });
  const task = f.start();
  await f.click('mnModalOk', 'qa@example.invalid');
  await f.click('mnModalOk', 'clave-solo-de-prueba');
  assert.equal(f.elements.get('mnModalMessage').textContent, 'Sesión iniciada.');
  assert.equal(f.state.rendered, 1);
  assert.equal(f.context.currentUser.email, 'qa@example.invalid');
  assert.equal(f.state.navigated, 0);
  await f.click('mnModalOk');
  await task;
  assert.equal(f.state.navigated, 1);
});
