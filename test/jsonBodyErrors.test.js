const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { once } = require('node:events');
const { gzipSync } = require('node:zlib');
const express = require('express');
const multer = require('multer');

// Monta los bloques reales del servidor con Express/Multer reales y HTTP local.
// Sin arrancar server.js, cargar .env, tocar archivos de video ni usar BD/R2.
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8').replace(/\r\n/g, '\n');
const parserStart = source.indexOf('// --- Lectura de JSON de la API');
const parserEnd = source.indexOf('// --- Sesiones de usuario', parserStart);
const uploadStart = source.indexOf('app.use((err, req, res, next) => {');
const uploadEnd = source.indexOf('\n});', uploadStart) + 4;
const reportStart = source.indexOf('function reportHttpError(');
const reportEnd = source.indexOf('\n}', reportStart) + 2;
assert.ok(parserStart >= 0 && parserEnd > parserStart);
assert.ok(uploadStart >= 0 && uploadEnd > uploadStart);
assert.ok(reportStart >= 0 && reportEnd > reportStart);

async function fixture(t) {
  const app = express();
  const state = { routes: 0, logs: [], reports: [], delegated: [], r2: false };
  const context = {
    app, express, multer,
    logger: { error: (...args) => state.logs.push(args) },
    sentry: { captureException: (err, options) => state.reports.push({
      route: options.tags.route, message: err.message, body: err.body, options,
    }) },
    r2: { isR2Enabled: () => state.r2 },
  };
  // Provoca un error interno documentado de raw-body, sin falsificar el parser.
  app.use((req, _res, next) => {
    if (req.path === '/parser-internal-error') req.setEncoding('utf8');
    if (req.path === '/parser-headers-sent') {
      _res.writeHead(200, { 'content-type': 'application/json' });
      _res.write('{"started":true}');
    }
    next();
  });
  vm.runInNewContext(source.slice(reportStart, reportEnd), context);
  vm.runInNewContext(source.slice(parserStart, parserEnd), context);
  app.post(['/auth/login', '/parser-internal-error'], (req, res) => {
    state.routes++;
    res.json({ body: req.body });
  });
  app.post('/upload/:kind', (req, _res, next) => {
    if (req.params.kind === 'size') return next(new multer.MulterError('LIMIT_FILE_SIZE'));
    if (req.params.kind === 'field') return next(new multer.MulterError('LIMIT_UNEXPECTED_FILE'));
    if (req.params.kind === 'validation') {
      return next(Object.assign(new Error('El archivo no es un video válido.'), { isVideoValidationError: true }));
    }
    // Un error posterior al parser no debe reclasificarse aunque lleve status 400.
    next(Object.assign(new Error('fallo de storage simulado'), { status: 400 }));
  });
  vm.runInNewContext(source.slice(uploadStart, uploadEnd), context);
  // Observa la delegación final sin que Express imprima el stack en el test.
  app.use((err, _req, res, _next) => {
    state.delegated.push({ message: err.message, body: err.body, stack: err.stack });
    res.end();
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
    server.closeAllConnections();
  }));
  await once(server, 'listening');

  async function request(body, headers = {}, route = '/auth/login') {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: route, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers },
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, contentType: res.headers['content-type'], body: JSON.parse(text) }); }
          catch (err) { reject(err); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('HTTP local sin respuesta')));
      req.end(data);
    });
  }
  return { request, state };
}

function assertJsonError(result, status, message) {
  assert.equal(result.status, status);
  assert.match(result.contentType, /^application\/json\b/);
  assert.deepEqual(result.body, { error: message });
}

test('JSON inválido: 400 seguro antes de la ruta, sin logs/reportes de subida ni cuerpo sensible', async t => {
  const { request, state } = await fixture(t);
  for (const body of ['{"password":"qa-body-marker",', '"qa-body-marker"']) {
    assertJsonError(await request(body), 400, 'El cuerpo JSON de la solicitud no es válido.');
  }
  assert.equal(state.routes, 0);
  assert.deepEqual(state.logs, []);
  assert.deepEqual(state.reports, []);
  assert.equal((await request('{}')).status, 200, 'el servidor continúa atendiendo');
});

test('JSON gzip inválido o truncado: 400, sin caída ni clasificación de subida', async t => {
  const { request, state } = await fixture(t);
  for (const body of [gzipSync('{"password":'), gzipSync('{}').subarray(0, 12)]) {
    assertJsonError(await request(body, { 'content-encoding': 'gzip' }),
      400, 'El cuerpo JSON de la solicitud no es válido.');
  }
  assert.equal(state.routes, 0);
  assert.deepEqual(state.logs, []);
  assert.deepEqual(state.reports, []);
  assert.equal((await request('{}')).status, 200);
});

test('JSON demasiado grande: conserva el límite de 100 KB y devuelve 413 incluso con gzip', async t => {
  const { request, state } = await fixture(t);
  const body = JSON.stringify({ value: 'x'.repeat(103000) });
  assertJsonError(await request(body), 413, 'El cuerpo JSON supera el tamaño permitido.');
  assertJsonError(await request(gzipSync(body), { 'content-encoding': 'gzip' }),
    413, 'El cuerpo JSON supera el tamaño permitido.');
  assert.equal(state.routes, 0);
  assert.deepEqual(state.logs, []);
});

test('JSON con charset o compresión no soportados: 415 sin reflejar headers del cliente', async t => {
  const { request, state } = await fixture(t);
  for (const headers of [
    { 'content-type': 'application/json; charset=qa-unsupported' },
    { 'content-encoding': 'qa-unsupported' },
  ]) {
    assertJsonError(await request('{}', headers), 415, 'La codificación del cuerpo JSON no está soportada.');
  }
  assert.equal(state.routes, 0);
  assert.deepEqual(state.logs, []);
  assert.deepEqual(state.reports, []);
});

test('JSON válido, gzip válido y cuerpos no JSON siguen llegando a la ruta', async t => {
  const { request, state } = await fixture(t);
  const body = { email: 'qa@example.invalid', value: ['ñ', 1] };
  for (const [data, headers] of [
    [JSON.stringify(body), {}],
    [gzipSync(JSON.stringify(body)), { 'content-encoding': 'gzip' }],
  ]) {
    const result = await request(data, headers);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { body });
  }
  assert.deepEqual((await request('')).body, { body: {} });
  assert.deepEqual((await request('contenido', { 'content-type': 'text/plain' })).body, { body: {} });
  assert.equal(state.routes, 4);
  assert.deepEqual(state.logs, []);
});

test('Error interno de lectura JSON: 500 y diagnóstico seguro, sin anunciar fallo de subida', async t => {
  const { request, state } = await fixture(t);
  assertJsonError(await request('{"password":"qa-body-marker"}', {}, '/parser-internal-error'),
    500, 'No se pudo leer el cuerpo JSON de la solicitud.');
  assert.equal(state.routes, 0);
  assert.equal(state.logs.length, 1);
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].route, 'json parser');
  assert.deepEqual(JSON.parse(JSON.stringify(state.reports[0].options)), {
    tags: { source: 'http', route: 'json parser' },
  });
  assert.doesNotMatch(JSON.stringify({ logs: state.logs, reports: state.reports }), /qa-body-marker|subiendo|upload middleware/);
  assert.equal((await request('{}')).status, 200);
});

test('Headers enviados: delega un error saneado sin escribir otra respuesta ni loguear una subida', async t => {
  const { request, state } = await fixture(t);
  const result = await request('{"password":"qa-body-marker",', {}, '/parser-headers-sent');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { started: true });
  assert.equal(state.delegated.length, 1);
  assert.equal(state.delegated[0].message, 'No se pudo leer el cuerpo JSON de la solicitud.');
  assert.equal(state.delegated[0].body, undefined);
  assert.doesNotMatch(JSON.stringify(state.delegated), /qa-body-marker/);
  assert.deepEqual(state.logs, []);
  assert.deepEqual(state.reports, []);
});

test('Multer, validación de video y fallos posteriores de storage conservan sus respuestas', async t => {
  const { request, state } = await fixture(t);
  assertJsonError(await request('{}', {}, '/upload/size'), 400, 'El archivo supera el límite permitido (8GB).');
  assertJsonError(await request('{}', {}, '/upload/field'), 400, 'Unexpected field');
  assertJsonError(await request('{}', {}, '/upload/validation'), 400, 'El archivo no es un video válido.');
  assertJsonError(await request('{}', {}, '/upload/storage'), 502, 'No se pudo guardar el video.');
  state.r2 = true;
  assertJsonError(await request('{}', {}, '/upload/storage'), 502,
    'No se pudo subir el video a Cloudflare R2 (revisa credenciales/conexión en el .env).');
  assert.equal(state.logs.length, 2);
  assert.equal(state.reports.length, 2);
  assert.ok(state.reports.every(report => report.route === 'upload middleware'));
});
