const test = require('node:test');
const assert = require('node:assert/strict');
const {
  displayNameFor,
  videoDisplayName,
  isValidUploadReference,
  videoUrlForExistingFile
} = require('../lib/uploadReference');

test('displayNameFor: separa el hash del nombre legible cuando hay "__"', () => {
  assert.equal(displayNameFor('abc123__Mi Pelicula.mp4'), 'Mi Pelicula.mp4');
});

test('displayNameFor: sin "__" (archivos viejos), devuelve el nombre tal cual', () => {
  assert.equal(displayNameFor('archivo-viejo.mp4'), 'archivo-viejo.mp4');
});

test('videoDisplayName: extrae el basename de una ruta y aplica displayNameFor', () => {
  assert.equal(videoDisplayName('/uploads/abc123__Mi Pelicula.mp4'), 'Mi Pelicula.mp4');
});

function fakeR2(enabled, { exists = false } = {}) {
  return {
    isR2Enabled: () => enabled,
    objectExists: async (key) => exists,
    getPublicUrl: (key) => `https://pub-fake.r2.dev/${key}`
  };
}

test('isValidUploadReference: rechaza filenames vacíos, no-string, con traversal o con subcarpetas', async () => {
  const r2 = fakeR2(false);
  const opts = { r2, uploadDir: '/uploads' };
  assert.equal(await isValidUploadReference('', opts), false);
  assert.equal(await isValidUploadReference(null, opts), false);
  assert.equal(await isValidUploadReference(undefined, opts), false);
  assert.equal(await isValidUploadReference('../../etc/passwd', opts), false);
  assert.equal(await isValidUploadReference('sub/carpeta/video.mp4', opts), false);
});

test('isValidUploadReference: modo disco — consulta fs.existsSync en UPLOAD_DIR', async () => {
  const r2 = fakeR2(false);
  const calls = [];
  const fakeFs = { existsSync: (p) => { calls.push(p); return p.endsWith('presente.mp4'); } };
  const opts = { r2, uploadDir: '/uploads', fs: fakeFs };

  assert.equal(await isValidUploadReference('presente.mp4', opts), true);
  assert.equal(await isValidUploadReference('ausente.mp4', opts), false);
  assert.equal(calls[0], require('path').join('/uploads', 'presente.mp4'));
});

test('isValidUploadReference: modo R2 — consulta r2.objectExists, ignora el filesystem', async () => {
  const r2existing = fakeR2(true, { exists: true });
  const r2missing = fakeR2(true, { exists: false });
  const fsThatShouldNotBeCalled = { existsSync: () => { throw new Error('no debería llamarse en modo R2'); } };

  assert.equal(
    await isValidUploadReference('key-real.mp4', { r2: r2existing, uploadDir: '/uploads', fs: fsThatShouldNotBeCalled }),
    true
  );
  assert.equal(
    await isValidUploadReference('key-inexistente.mp4', { r2: r2missing, uploadDir: '/uploads', fs: fsThatShouldNotBeCalled }),
    false
  );
});

test('videoUrlForExistingFile: modo disco local -> ruta bajo /uploads', () => {
  assert.equal(videoUrlForExistingFile('video.mp4', { r2: fakeR2(false) }), '/uploads/video.mp4');
});

test('videoUrlForExistingFile: modo R2 -> URL pública del bucket', () => {
  assert.equal(
    videoUrlForExistingFile('video.mp4', { r2: fakeR2(true) }),
    'https://pub-fake.r2.dev/video.mp4'
  );
});
