const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'r2.js'), 'utf8');
const operations = {
  testConnection: [], uploadStream: ['qa-key', null, 'video/mp4'],
  getPresignedUploadUrl: ['qa-key', 'video/mp4', 60], listObjects: [],
  deleteObject: ['qa-key'], objectExists: ['qa-key'], getObjectHead: ['qa-key', 8],
  listMultipartUploads: [], abortMultipartUpload: ['qa-key', 'qa-upload'],
};

// Módulo R2 real; SDK, subida y firma simulados. Nunca lee .env ni accede a la red.
function fixture(error) {
  const state = { warnings: [], counted: [] };
  const commandNames = ['ListObjectsV2', 'DeleteObject', 'HeadBucket', 'HeadObject',
    'ListMultipartUploads', 'AbortMultipartUpload', 'PutObject', 'GetObject'];
  const sdk = {};
  for (const name of commandNames) sdk[name + 'Command'] = class {
    constructor() { this.kind = name; }
  };
  sdk.S3Client = class {
    async send(command) {
      if (error) throw error;
      if (command.kind === 'GetObject') return { Body: [Buffer.from('qa')] };
      return {};
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, Buffer,
    process: { env: { R2_ACCOUNT_ID: 'qa-account', R2_ACCESS_KEY_ID: 'qa-access',
      R2_SECRET_ACCESS_KEY: crypto.randomBytes(24).toString('hex'), R2_BUCKET_NAME: 'qa-bucket' } },
    require: (id) => {
      if (id === '@aws-sdk/client-s3') return sdk;
      if (id === '@aws-sdk/lib-storage') return { Upload: class { async done() { if (error) throw error; } } };
      if (id === '@aws-sdk/s3-request-presigner') return { getSignedUrl: async () => {
        if (error) throw error;
        return 'qa-url';
      } };
      if (id === './metrics') return { recordR2Error: (err) => state.counted.push(err) };
      if (id === './logger') return { warn: (...args) => state.warnings.push(args) };
      if (id === './r2Failure') return require('../lib/r2Failure');
      return require(id);
    },
  });
  return { r2: module.exports, state };
}

test('R2: cada operación fallida conserva el error, cuenta una vez y registra operación/código sin secretos', async () => {
  const marker = crypto.randomBytes(24).toString('hex');
  for (const [operation, args] of Object.entries(operations)) {
    const error = Object.assign(new Error(`https://${marker}.example.invalid/?token=${marker}`), {
      code: 'ETIMEDOUT', $metadata: { attempts: 3, totalRetryDelay: 152, httpStatusCode: 503 },
      bucket: marker, key: marker, password: marker,
    });
    const { r2, state } = fixture(error);
    await assert.rejects(r2[operation](...args), (received) => received === error);
    assert.deepEqual(state.counted, [error]);
    assert.equal(state.warnings.length, 1, `${operation}: falta el evento de fallo`);
    const [details] = state.warnings[0];
    assert.equal(details.event, 'r2_operation_failed');
    assert.equal(details.operation, operation);
    assert.equal(details.code, 'ETIMEDOUT');
    assert.equal(details.attempts, 3);
    assert.equal(details.httpStatus, 503);
    assert.equal(details.retryDelayMs, 152);
    assert.equal(JSON.stringify(state.warnings).includes(marker), false);
  }
});

test('R2: éxitos y objeto inexistente no generan fallos de métricas ni logs', async () => {
  for (const [operation, args] of Object.entries(operations)) {
    const { r2, state } = fixture();
    await r2[operation](...args);
    assert.deepEqual(state.counted, []);
    assert.deepEqual(state.warnings, []);
  }
  for (const error of [Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } }),
    Object.assign(new Error('missing'), { name: 'NotFound' })]) {
    const { r2, state } = fixture(error);
    assert.equal(await r2.objectExists('qa-key'), false);
    assert.deepEqual(state.counted, []);
    assert.deepEqual(state.warnings, []);
  }
});

test('R2: los códigos de red anidados conservan la familia sin direcciones ni mensajes', async () => {
  const marker = crypto.randomBytes(24).toString('hex');
  const nested = Object.assign(new Error(marker), { code: 'ENETUNREACH', address: '2001:db8::1' });
  const error = Object.assign(new AggregateError([nested], marker), { code: 'ETIMEDOUT' });
  error.cause = error;
  const { r2, state } = fixture(error);
  await assert.rejects(r2.testConnection(), (received) => received === error);
  const details = state.warnings[0][0];
  assert.deepEqual(details.networkErrors, [{ code: 'ENETUNREACH', family: 6 }]);
  assert.equal(JSON.stringify(details).includes(marker), false);
  assert.equal(JSON.stringify(details).includes(nested.address), false);
});

test('R2: metadatos y códigos no reconocidos se omiten, sin copiar datos arbitrarios', async () => {
  const marker = crypto.randomBytes(24).toString('hex');
  const error = Object.assign(new Error(marker), {
    code: marker, name: marker, $metadata: { attempts: marker, totalRetryDelay: marker, httpStatusCode: marker },
  });
  const { r2, state } = fixture(error);
  await assert.rejects(r2.listObjects(), (received) => received === error);
  const details = state.warnings[0][0];
  assert.equal(details.code, 'UNKNOWN');
  assert.equal(JSON.stringify(details).includes(marker), false);
  assert.equal(details.attempts, undefined);
});

test('R2: el logger real añade hora y protege también el error reenviado por otra capa', () => {
  const script = `
    const crypto = require('node:crypto');
    const marker = crypto.randomBytes(24).toString('hex');
    const error = Object.assign(new Error('https://' + marker + '.example.invalid/?token=' + marker), {code:'ENOTFOUND'});
    const { rememberR2Failure } = require('./lib/r2Failure');
    const logger = require('./lib/logger');
    const details = rememberR2Failure('testConnection', error);
    logger.warn({event:'r2_operation_failed',...details}, 'Falló una operación de R2');
    logger.error({err:error}, 'Error desde la ruta');
    logger.error({err:new Error('error normal')}, 'Otro error');
    process.stderr.write(marker);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'warn', LOG_PRETTY: '0' },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].operation, 'testConnection');
  assert.equal(typeof lines[0].time, 'number');
  assert.equal(lines[1].err.code, 'ENOTFOUND');
  assert.equal(lines[1].err.operation, 'testConnection');
  assert.equal(result.stdout.includes(result.stderr), false);
  assert.equal(lines[2].err.message, 'error normal');
});
