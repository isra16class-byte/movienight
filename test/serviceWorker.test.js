const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const origin = 'https://movienight.test';

function worker({ network = async () => new Response('nuevo'), installError = false, writeError = false } = {}) {
  const handlers = {};
  const entries = new Map();
  const deleted = [];
  let installed = [];
  let skipped = false;
  let claimed = false;
  let fetches = 0;
  const cache = {
    async addAll(urls) {
      installed = Array.from(urls);
      if (installError) throw new Error('Recurso no disponible');
    },
    async put(req, res) {
      if (writeError) throw new Error('Sin espacio');
      entries.set(req.url, res);
    },
    async match(req) { return entries.get(req.url)?.clone(); },
  };
  vm.runInNewContext(source, {
    URL,
    self: {
      location: { origin },
      addEventListener: (name, handler) => { handlers[name] = handler; },
      skipWaiting: async () => { skipped = true; },
      clients: { claim: async () => { claimed = true; } },
    },
    caches: {
      open: async () => cache,
      match: cache.match,
      keys: async () => ['movienight-shell-v1', 'movienight-shell-v2', 'otra-cache'],
      delete: async name => { deleted.push(name); },
    },
    fetch: async req => { fetches++; return network(req); },
  });
  async function lifecycle(name) {
    const pending = [];
    handlers[name]({ waitUntil: promise => pending.push(promise) });
    await Promise.all(pending);
  }
  async function request(url, method = 'GET') {
    let response;
    const pending = [];
    handlers.fetch({
      request: new Request(new URL(url, origin), { method }),
      respondWith: promise => { response = promise; },
      waitUntil: promise => pending.push(promise),
    });
    const result = await response;
    await Promise.all(pending);
    // Permite observar también las escrituras no ligadas a waitUntil del SW anterior.
    await new Promise(setImmediate);
    return result;
  }
  return {
    lifecycle, request, entries, deleted,
    get installed() { return installed; },
    get skipped() { return skipped; },
    get claimed() { return claimed; },
    get fetches() { return fetches; },
  };
}

test('SW: precarga las fuentes locales y todos los recursos del shell existen', async () => {
  const sw = worker();
  await sw.lifecycle('install');
  assert.ok(sw.installed.includes('/fonts/fonts.css'));
  const css = fs.readFileSync(path.join(__dirname, '../public/fonts/fonts.css'), 'utf8');
  const fontUrls = [...css.matchAll(/url\(['"]?([^)'"\s]+)/g)].map(m => '/fonts/' + m[1].replace(/^\.\//, ''));
  assert.ok(fontUrls.length > 0);
  for (const url of fontUrls) assert.ok(sw.installed.includes(url), `Falta precargar ${url}`);
  for (const url of sw.installed) {
    const file = url === '/' ? 'index.html' : url.slice(1);
    assert.ok(fs.existsSync(path.join(__dirname, '../public', file)), `No existe ${url}`);
  }
  assert.equal(sw.skipped, true);
});

test('SW: una instalación incompleta no activa el worker nuevo', async () => {
  const sw = worker({ installError: true });
  await assert.rejects(sw.lifecycle('install'), /Recurso no disponible/);
  assert.equal(sw.skipped, false);
});

test('SW: ignora sesión, admin, salas, API, videos, sockets y otros orígenes', async () => {
  const sw = worker();
  for (const url of ['/auth/me', '/admin.html', '/admin/stats', '/api/uploads', '/room/abcdef', '/uploads/video.mp4', '/socket.io/socket.io.js', '/create-room', 'https://otro.test/style.css']) {
    assert.equal(await sw.request(url), undefined, url);
  }
  assert.equal(await sw.request('/style.css', 'POST'), undefined);
  assert.equal(sw.fetches, 0);
});

test('SW: un 404 o 500 no pisa una fuente válida que ya estaba cacheada', async () => {
  for (const status of [404, 500]) {
    const sw = worker({ network: async () => new Response('error', { status }) });
    const key = origin + '/fonts/fonts.css';
    sw.entries.set(key, new Response('fuentes válidas'));
    assert.equal((await sw.request('/fonts/fonts.css')).status, status);
    assert.equal(await sw.entries.get(key).text(), 'fuentes válidas');
  }
});

test('SW: network-first actualiza el shell y offline recupera la última copia válida', async () => {
  let offline = false;
  const sw = worker({ network: async () => {
    if (offline) throw new Error('Sin red');
    return new Response('fuentes nuevas');
  } });
  assert.equal(await (await sw.request('/fonts/fonts.css')).text(), 'fuentes nuevas');
  offline = true;
  assert.equal(await (await sw.request('/fonts/fonts.css')).text(), 'fuentes nuevas');
});

test('SW: un fallo de escritura de caché no rompe una respuesta de red correcta', async () => {
  const sw = worker({ writeError: true });
  assert.equal(await (await sw.request('/style.css')).text(), 'nuevo');
});

test('SW: al activar solo elimina versiones anteriores de su propio shell', async () => {
  const sw = worker();
  await sw.lifecycle('activate');
  assert.deepEqual(sw.deleted, ['movienight-shell-v1']);
  assert.equal(sw.claimed, true);
});
