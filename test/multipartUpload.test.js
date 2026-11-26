const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable, PassThrough } = require('node:stream');
const multer = require('multer');

const source = require('node:fs').readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf('const storage = multer.diskStorage');
const end = source.indexOf('// --- Fase 2.5 del plan de producción: validación de video en modo disco local', start);
assert.ok(start >= 0 && end > start);

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'movienight-multipart-'));
  t.after(async () => {
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  });
  const state = { uploads: [], deletes: [], finished: 0 };
  const context = {
    multer, path, Readable, AbortController, Buffer,
    crypto: require('node:crypto'), UPLOAD_DIR: directory,
    metrics: { uploadStarted() {}, uploadFinished() { state.finished++; } },
    fileValidation: {
      SNIFF_BYTES: 4,
      isValidVideoBuffer: options.validate ?? (async buffer => ({ valid: buffer[0] === 97, reason: 'formato inválido' }))
    },
    r2: {
      isR2Enabled: () => Boolean(options.r2),
      makeObjectKey: () => 'synthetic-key',
      uploadStream(key, body, type, signal) {
        state.uploads.push({ key, type, signal });
        return options.upload ? options.upload(body, signal) : collect(body);
      },
      async deleteObject(key) { state.deletes.push(key); }
    }
  };
  const middleware = vm.runInNewContext(source.slice(start, end) +
    '\n({ r2VideoStorage, uploadVideoTracked, trackVideoUpload, subtitleUpload })', context);
  return { directory, state, ...middleware };
}

function multipart(parts) {
  const req = new PassThrough();
  req.headers = { 'content-type': 'multipart/form-data; boundary=MovieNightFixture', 'transfer-encoding': 'chunked' };
  req.res = new EventEmitter();
  const headersAndContent = parts.map(part => {
    const disposition = 'Content-Disposition: form-data; name="' + part.name + '"';
    const fileHeaders = part.filename
      ? '; filename="' + part.filename + '"\r\nContent-Type: application/octet-stream'
      : '';
    return '--MovieNightFixture\r\n' + disposition + fileHeaders + '\r\n\r\n' + part.data + '\r\n';
  });
  req.end(headersAndContent.join('') + '--MovieNightFixture--\r\n');
  return req;
}

function parse(middleware, req) {
  return new Promise(resolve => middleware(req, req.res, resolve));
}

function videoRequest() {
  const req = new EventEmitter();
  req.res = new EventEmitter();
  const stream = new PassThrough();
  const file = { stream, fieldname: 'video', originalname: 'fixture.mp4', mimetype: 'video/mp4' };
  return { req, stream, file };
}

test('Multer procesa bytes sintéticos en disco y campos planos usados por video', { timeout: 5000 }, async t => {
  const { directory, state, uploadVideoTracked } = await fixture(t);
  const req = multipart([
    { name: 'video', filename: 'fixture.mp4', data: 'abcdef' },
    { name: 'hostToken', data: 'fixture-token' },
    { name: 'password', data: 'fixture-password' },
  ]);
  assert.equal(await parse(uploadVideoTracked, req), undefined);
  assert.equal(req.body.hostToken, 'fixture-token');
  assert.equal(req.body.password, 'fixture-password');
  assert.match(req.file.filename, /^[0-9a-f]{8}__fixture\.mp4$/);
  assert.equal(await fs.readFile(path.join(directory, req.file.filename), 'utf8'), 'abcdef');
  assert.equal(state.finished, 1);
});

test('Multer conserva el buffer del subtítulo y aplica el límite inclusivo de 5 MiB', { timeout: 5000 }, async t => {
  const { subtitleUpload } = await fixture(t);
  const middleware = subtitleUpload.single('subtitle');
  const data = 's'.repeat(5 * 1024 * 1024);
  const exact = multipart([{ name: 'subtitle', filename: 'fixture.srt', data }, { name: 'hostToken', data: 'fixture-token' }]);
  assert.equal(await parse(middleware, exact), undefined);
  assert.equal(exact.file.buffer.length, data.length);
  assert.equal(exact.body.hostToken, 'fixture-token');
  const oversized = multipart([{ name: 'subtitle', filename: 'fixture.srt', data: data + 's' }]);
  const err = await parse(middleware, oversized);
  assert.equal(err.code, 'LIMIT_FILE_SIZE');
  assert.equal(err.field, 'subtitle');
});

test('Los dos middlewares rechazan campos anidados y conservan LIMIT_UNEXPECTED_FILE', { timeout: 5000 }, async t => {
  const { uploadVideoTracked, subtitleUpload } = await fixture(t);
  for (const middleware of [uploadVideoTracked, subtitleUpload.single('subtitle')]) {
    const nested = await parse(middleware, multipart([{ name: 'metadata[title]', data: 'fixture' }]));
    assert.equal(nested.code, 'LIMIT_FIELD_NESTING');
    const wrong = await parse(middleware, multipart([{ name: 'extra', filename: 'fixture.txt', data: 'fixture' }]));
    assert.equal(wrong.code, 'LIMIT_UNEXPECTED_FILE');
  }
});

test('R2 conserva exactamente los bytes validados y el tamaño en archivos cortos y más largos', { timeout: 5000 }, async t => {
  const uploaded = [];
  const { uploadVideoTracked, state } = await fixture(t, {
    r2: true,
    async upload(body) { uploaded.push(await collect(body)); }
  });
  for (const data of ['ab', 'abcdefgh']) {
    const req = multipart([{ name: 'video', filename: 'fixture.mp4', data }]);
    assert.equal(await parse(uploadVideoTracked, req), undefined);
    assert.equal(req.file.key, 'synthetic-key');
    assert.equal(req.file.size, data.length);
  }
  assert.deepEqual(uploaded, [Buffer.from('ab'), Buffer.from('abcdefgh')]);
  assert.equal(state.finished, 2);

  const invalid = multipart([{ name: 'video', filename: 'fixture.mp4', data: 'invalid' }]);
  const err = await parse(uploadVideoTracked, invalid);
  assert.equal(err.isVideoValidationError, true);
  assert.equal(state.uploads.length, 2);
});

test('R2 no inicia una carga si el cliente cancela mientras se valida la cabecera', { timeout: 5000 }, async t => {
  const validating = Promise.withResolvers();
  const validation = Promise.withResolvers();
  const { r2VideoStorage, state } = await fixture(t, {
    validate() {
      validating.resolve();
      return validation.promise;
    }
  });
  const { req, stream, file } = videoRequest();
  const finished = new Promise(resolve => r2VideoStorage._handleFile(req, file, resolve));
  stream.write('abcdef');
  await validating.promise;
  req.aborted = true;
  req.emit('aborted');
  validation.resolve({ valid: true });
  assert.match((await finished).message, /cancelada/);
  assert.equal(state.uploads.length, 0);
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(req.res.listenerCount('close'), 0);
});

test('R2 conserva la causa si el cliente cancela mientras se espera la cabecera', { timeout: 5000 }, async t => {
  const { r2VideoStorage, state } = await fixture(t);
  const { req, file } = videoRequest();
  const finished = new Promise(resolve => r2VideoStorage._handleFile(req, file, resolve));
  req.aborted = true;
  req.emit('aborted');
  assert.match((await finished).message, /cancelada/);
  assert.equal(state.uploads.length, 0);
});

test('El límite de Multer detiene el stream activo de R2 y conserva el error de tamaño', { timeout: 5000 }, async t => {
  const { r2VideoStorage, state } = await fixture(t, { r2: true });
  const middleware = multer({ storage: r2VideoStorage, limits: { fileSize: 8 } }).single('video');
  const exact = multipart([{ name: 'video', filename: 'fixture.mp4', data: 'abcdefgh' }]);
  assert.equal(await parse(middleware, exact), undefined);
  assert.equal(exact.file.size, 8);

  const stub = new PassThrough();
  const waiting = Promise.withResolvers();
  const limitedR2 = await fixture(t, {
    async upload(body) {
      waiting.resolve();
      return collect(body);
    }
  });
  const streaming = multer({ storage: limitedR2.r2VideoStorage, limits: { fileSize: 8 } }).single('video');
  stub.headers = { 'content-type': 'multipart/form-data; boundary=fixture', 'transfer-encoding': 'chunked' };
  stub.res = new EventEmitter();
  const finished = parse(streaming, stub);
  stub.write('--fixture\r\nContent-Disposition: form-data; name="video"; filename="fixture.mp4"\r\n\r\nabcdef\r\n');
  await waiting.promise;
  stub.end('ghi\r\n--fixture--\r\n');
  const err = await finished;
  assert.equal(err.code, 'LIMIT_FILE_SIZE');
  assert.equal(limitedR2.state.uploads[0].signal.reason.code, 'LIMIT_FILE_SIZE');
  assert.deepEqual(limitedR2.state.deletes, []);
  assert.deepEqual(state.deletes, []);
});

test('Si R2 completa tarde tras cerrar la respuesta, borra la key y finaliza la métrica una vez', { timeout: 5000 }, async t => {
  const completedRead = Promise.withResolvers();
  const stored = Promise.withResolvers();
  const { r2VideoStorage, trackVideoUpload, state } = await fixture(t, {
    async upload(body) {
      await collect(body);
      completedRead.resolve();
      await stored.promise;
    }
  });
  const { req, stream, file } = videoRequest();
  let forwarded = 0;
  let callbacks = 0;
  const finished = Promise.withResolvers();
  trackVideoUpload((request, _res, next) => r2VideoStorage._handleFile(request, file, (err, info) => {
    callbacks++;
    finished.resolve({ err, info });
    next(err);
  }))(req, req.res, () => { forwarded++; });
  stream.end('abcdef');
  await completedRead.promise;
  req.res.destroyed = true;
  req.res.emit('close');
  stored.resolve();
  const { err, info } = await finished.promise;
  assert.match(err.message, /cancelada/);
  assert.equal(info, undefined);
  assert.deepEqual(state.deletes, ['synthetic-key']);
  assert.equal(state.finished, 1);
  assert.equal(forwarded, 0);
  assert.equal(callbacks, 1);
});
