const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const avatars = require('../lib/avatars');

const SVG_OK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

// Arma una carpeta temporal con `files` ({ nombre: contenido }) y, si se pasa, un avatars.json.
function makeDir(files, manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatars-test-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(dir, 'avatars.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  }
  return dir;
}

// Cabecera mínima de PNG (solo lo que lee readPngSize) con el ancho y alto pedidos.
function fakePng(width, height, extraBytes = 0) {
  const buf = Buffer.alloc(33 + extraBytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function fakeWebp(kind, width, height) {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(32, 4);
  buf.write('WEBP', 8, 'ascii');
  if (kind === 'VP8X') {
    buf.write('VP8X', 12, 'ascii');
    buf.writeUIntLE(width - 1, 24, 3);
    buf.writeUIntLE(height - 1, 27, 3);
  } else if (kind === 'VP8L') {
    buf.write('VP8L', 12, 'ascii');
    buf[20] = 0x2f;
    buf.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  } else {
    buf.write('VP8 ', 12, 'ascii');
    buf[23] = 0x9d; buf[24] = 0x01; buf[25] = 0x2a;
    buf.writeUInt16LE(width, 26);
    buf.writeUInt16LE(height, 28);
  }
  return buf;
}

// --- Manifiesto ------------------------------------------------------------------------------------

test('manifiesto válido: devuelve los avatares en orden, con hash', () => {
  const dir = makeDir({ 'a.svg': SVG_OK, 'b.svg': SVG_OK + '<!-- b -->' }, [
    { id: 'zorro', name: 'Zorro', file: 'a.svg' },
    { id: 'gato-2', name: 'Gato', file: 'b.svg', placeholder: true }
  ]);
  const { avatars: list, errors } = avatars.loadManifest(dir);
  assert.deepEqual(errors, []);
  assert.deepEqual(list.map((a) => a.id), ['zorro', 'gato-2']);
  assert.equal(list[1].placeholder, true);
  assert.match(list[0].hash, /^[0-9a-f]{8}$/);
});

test('manifiesto inválido: id mal formado deja la lista vacía', () => {
  for (const id of ['A', 'a', 'con espacio', 'con_guion_bajo', 'x'.repeat(33), '', 5, null]) {
    const dir = makeDir({ 'a.svg': SVG_OK }, [{ id, name: 'X', file: 'a.svg' }]);
    const { avatars: list, errors } = avatars.loadManifest(dir);
    assert.deepEqual(list, [], `id ${JSON.stringify(id)} debería ser inválido`);
    assert.ok(errors.length > 0);
  }
});

test('manifiesto inválido: id repetido', () => {
  const dir = makeDir({ 'a.svg': SVG_OK, 'b.svg': SVG_OK }, [
    { id: 'zorro', name: 'A', file: 'a.svg' },
    { id: 'zorro', name: 'B', file: 'b.svg' }
  ]);
  const { avatars: list, errors } = avatars.loadManifest(dir);
  assert.deepEqual(list, []);
  assert.ok(errors.some((e) => e.includes('repetido')));
});

test('manifiesto inválido: archivo repetido', () => {
  const dir = makeDir({ 'a.svg': SVG_OK }, [
    { id: 'uno', name: 'A', file: 'a.svg' },
    { id: 'dos', name: 'B', file: 'a.svg' }
  ]);
  const { avatars: list, errors } = avatars.loadManifest(dir);
  assert.deepEqual(list, []);
  assert.ok(errors.some((e) => e.includes('archivo repetido')));
});

test('manifiesto inválido: archivo con "/" o ".." (aunque exista fuera de la carpeta)', () => {
  // 'a..svg' SÍ existe en la carpeta: debe rechazarse por llevar "..", no por faltar.
  const dir = makeDir({ 'a.svg': SVG_OK, 'a..svg': SVG_OK });
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.svg'), SVG_OK);
  for (const file of ['../a.svg', 'sub/b.svg', 'sub\\b.svg', '..', 'a..svg']) {
    const { avatars: list, errors } = avatars.validateManifest([{ id: 'uno', name: 'A', file }], dir);
    assert.deepEqual(list, [], `file ${file} debería ser inválido`);
    assert.ok(errors.length > 0);
  }
});

test('manifiesto inválido: archivo inexistente', () => {
  const dir = makeDir({}, [{ id: 'uno', name: 'A', file: 'no-esta.svg' }]);
  const { avatars: list, errors } = avatars.loadManifest(dir);
  assert.deepEqual(list, []);
  assert.ok(errors.some((e) => e.includes('no existe')));
});

test('manifiesto inválido: más de 40 avatares', () => {
  const files = { 'a.svg': SVG_OK };
  const entries = [];
  for (let i = 0; i < 41; i++) entries.push({ id: `av-${String(i).padStart(2, '0')}`, name: `A${i}`, file: `f${i}.svg` });
  for (const e of entries) files[e.file] = SVG_OK;
  const dir = makeDir(files, entries);
  const { avatars: list, errors } = avatars.loadManifest(dir);
  assert.deepEqual(list, []);
  assert.ok(errors.some((e) => e.includes('máximo')));
  // Con exactamente 40, es válido.
  const dir40 = makeDir(files, entries.slice(0, 40));
  assert.equal(avatars.loadManifest(dir40).avatars.length, 40);
});

test('manifiesto inválido: JSON roto, ausente o que no es un arreglo', () => {
  assert.deepEqual(avatars.loadManifest(makeDir({}, '{no es json')).avatars, []);
  assert.deepEqual(avatars.loadManifest(makeDir({})).avatars, []);
  const notArray = avatars.loadManifest(makeDir({}, { id: 'uno' }));
  assert.deepEqual(notArray.avatars, []);
  assert.ok(notArray.errors.length > 0);
});

test('init con manifiesto inválido no lanza, deja la lista vacía y registra el error', () => {
  const logged = [];
  const dir = makeDir({}, [{ id: 'MAL', name: 'X', file: 'a.svg' }]);
  const result = avatars.init({ dir, log: { error: (...args) => logged.push(args) } });
  assert.equal(result.count, 0);
  assert.deepEqual(avatars.listAvatars(), []);
  assert.ok(logged.length > 0);
});

// --- resolveAvatar / listAvatars / URL ---------------------------------------------------------------

test('resolveAvatar: id válido, desconocido, null y no-string', () => {
  const dir = makeDir({ 'a.svg': SVG_OK }, [{ id: 'zorro', name: 'Zorro', file: 'a.svg' }]);
  avatars.init({ dir });
  const resolved = avatars.resolveAvatar('zorro');
  assert.equal(resolved.id, 'zorro');
  assert.equal(resolved.name, 'Zorro');
  assert.match(resolved.url, /^\/avatars\/a\.svg\?v=[0-9a-f]{8}$/);
  assert.equal(avatars.resolveAvatar('otro'), null);
  assert.equal(avatars.resolveAvatar(null), null);
  assert.equal(avatars.resolveAvatar(undefined), null);
  for (const bad of [5, {}, [], true, ['zorro']]) assert.equal(avatars.resolveAvatar(bad), null);
  assert.equal(avatars.isValidAvatarId('zorro'), true);
  assert.equal(avatars.isValidAvatarId('otro'), false);
  assert.equal(avatars.isValidAvatarId(null), false);
  assert.deepEqual(avatars.listAvatars(), [resolved]);
});

test('la URL lleva un hash estable que cambia si cambia el contenido', () => {
  const dir = makeDir({ 'a.svg': SVG_OK }, [{ id: 'zorro', name: 'Zorro', file: 'a.svg' }]);
  avatars.init({ dir });
  const first = avatars.resolveAvatar('zorro').url;
  avatars.init({ dir });
  assert.equal(avatars.resolveAvatar('zorro').url, first, 'mismo contenido, misma URL');
  fs.writeFileSync(path.join(dir, 'a.svg'), SVG_OK + '<!-- cambio -->');
  avatars.init({ dir });
  assert.notEqual(avatars.resolveAvatar('zorro').url, first, 'contenido distinto, URL distinta');
});

test('renombrar un id deja a quien lo eligió sin avatar (null, sin error)', () => {
  const dir = makeDir({ 'a.svg': SVG_OK }, [{ id: 'zorro', name: 'Zorro', file: 'a.svg' }]);
  avatars.init({ dir });
  assert.ok(avatars.resolveAvatar('zorro'));
  fs.writeFileSync(path.join(dir, 'avatars.json'), JSON.stringify([{ id: 'zorro-rojo', name: 'Zorro', file: 'a.svg' }]));
  avatars.init({ dir });
  assert.equal(avatars.resolveAvatar('zorro'), null);
});

// --- Límite de cambios -------------------------------------------------------------------------------

test('límite de cambios: 20 por cuenta cada 10 minutos, y se libera al vencer', () => {
  let now = 1_000_000;
  const limiter = avatars.makeAvatarChangeLimiter({ now: () => now });
  for (let i = 0; i < avatars.AVATAR_CHANGE_MAX - 1; i++) {
    assert.equal(limiter.recordFailure('cuenta-1').locked, false);
  }
  assert.equal(limiter.lockedMinutes('cuenta-1'), null);
  assert.equal(limiter.recordFailure('cuenta-1').locked, true);
  assert.equal(limiter.lockedMinutes('cuenta-1'), 10);
  assert.equal(limiter.lockedMinutes('cuenta-2'), null, 'otra cuenta no se ve afectada');
  now += avatars.AVATAR_CHANGE_LOCKOUT_MS + 1;
  assert.equal(limiter.lockedMinutes('cuenta-1'), null);
});

// --- Revisión de archivos (checkIconFile) -------------------------------------------------------------

test('checkIconFile: PNG cuadrado dentro de rango pasa; no cuadrado, chico, enorme o ilegible fallan', () => {
  const dir = makeDir({
    'ok.png': fakePng(256, 256),
    'ancho.png': fakePng(256, 128),
    'chico.png': fakePng(64, 64),
    'enorme.png': fakePng(2048, 2048),
    'roto.png': Buffer.from('no es un png')
  });
  const ok = avatars.checkIconFile(dir, 'ok.png');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.width, 256);
  assert.ok(avatars.checkIconFile(dir, 'ancho.png').errors.some((e) => e.includes('cuadrado')));
  assert.ok(avatars.checkIconFile(dir, 'chico.png').errors.some((e) => e.includes('entre')));
  assert.ok(avatars.checkIconFile(dir, 'enorme.png').errors.some((e) => e.includes('entre')));
  assert.ok(avatars.checkIconFile(dir, 'roto.png').errors.length > 0);
});

test('checkIconFile: un archivo de más de 200 KB falla', () => {
  const dir = makeDir({ 'pesado.png': fakePng(256, 256, 300 * 1024) });
  assert.ok(avatars.checkIconFile(dir, 'pesado.png').errors.some((e) => e.includes('pesa')));
});

test('checkIconFile: WebP lee las dimensiones de los tres tipos de cabecera; si no puede, avisa', () => {
  const dir = makeDir({
    'x.webp': fakeWebp('VP8X', 256, 256),
    'l.webp': fakeWebp('VP8L', 256, 256),
    'v.webp': fakeWebp('VP8 ', 256, 256),
    'raro.webp': Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(8), Buffer.alloc(40)]),
    'ancho.webp': fakeWebp('VP8X', 300, 200)
  });
  for (const f of ['x.webp', 'l.webp', 'v.webp']) {
    const r = avatars.checkIconFile(dir, f);
    assert.deepEqual(r.errors, [], f);
    assert.equal(r.width, 256, f);
    assert.equal(r.height, 256, f);
  }
  const raro = avatars.checkIconFile(dir, 'raro.webp');
  assert.deepEqual(raro.errors, []);
  assert.equal(raro.warnings.length, 1);
  assert.ok(avatars.checkIconFile(dir, 'ancho.webp').errors.some((e) => e.includes('cuadrado')));
});

test('checkIconFile: formato no permitido y archivo inexistente fallan', () => {
  const dir = makeDir({ 'a.gif': 'GIF89a' });
  assert.ok(avatars.checkIconFile(dir, 'a.gif').errors.some((e) => e.includes('formato')));
  assert.ok(avatars.checkIconFile(dir, 'no-esta.png').errors.some((e) => e.includes('no existe')));
});

test('checkIconFile: un SVG correcto pasa (el xmlns no cuenta como referencia externa)', () => {
  const dir = makeDir({ 'ok.svg': SVG_OK, 'size.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' });
  assert.deepEqual(avatars.checkIconFile(dir, 'ok.svg').errors, []);
  assert.deepEqual(avatars.checkIconFile(dir, 'size.svg').errors, []);
});

test('checkIconFile: SVG inseguro o incompleto falla', () => {
  const bad = {
    'script.svg': '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>',
    'onload.svg': '<svg viewBox="0 0 1 1" onload="alert(1)"/>',
    'onclick.svg': '<svg viewBox="0 0 1 1"><rect onclick = "x()"/></svg>',
    'js.svg': '<svg viewBox="0 0 1 1"><a href="javascript:alert(1)"/></svg>',
    'foreign.svg': '<svg viewBox="0 0 1 1"><foreignObject/></svg>',
    'ext.svg': '<svg viewBox="0 0 1 1"><image href="https://ejemplo.com/a.png"/></svg>',
    'sinviewbox.svg': '<svg><circle r="1"/></svg>',
    'nosvg.svg': '<html></html>'
  };
  const dir = makeDir(bad);
  for (const f of Object.keys(bad)) {
    assert.ok(avatars.checkIconFile(dir, f).errors.length > 0, `${f} debería fallar`);
  }
});

// --- El public/avatars/ REAL --------------------------------------------------------------------------

test('public/avatars/ real: el manifiesto es válido y cada icono cumple la revisión (mismo código que check-avatars)', () => {
  const report = avatars.checkManifestFiles(avatars.DEFAULT_AVATARS_DIR);
  assert.deepEqual(report.manifestErrors, []);
  assert.ok(report.entries.length > 0, 'el manifiesto no puede estar vacío');
  assert.ok(report.entries.length <= avatars.MAX_AVATARS);
  for (const entry of report.entries) {
    assert.deepEqual(entry.check.errors, [], `${entry.file}: ${entry.check.errors.join(' ')}`);
  }
  // El cargador del servidor acepta lo mismo y respeta el orden del manifiesto.
  const result = avatars.init({ dir: avatars.DEFAULT_AVATARS_DIR });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(avatars.listAvatars().map((a) => a.id), report.entries.map((e) => e.id));
  for (const a of avatars.listAvatars()) {
    assert.match(a.id, avatars.ID_PATTERN);
    assert.equal(avatars.resolveAvatar(a.id).id, a.id);
  }
});
