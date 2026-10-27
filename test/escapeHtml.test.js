const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const escapeHtml = require('../public/js/escape-html.js');

const PUBLIC = path.join(__dirname, '..', 'public');

test('escapeHtml: escapa & < > " \'', () => {
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('>'), '&gt;');
  assert.equal(escapeHtml('"'), '&quot;');
  assert.equal(escapeHtml("'"), '&#39;');
});

test('escapeHtml: texto sin caracteres especiales (acentos, emojis, espacios) queda igual', () => {
  const text = 'Hola, ¿cómo estás? 🎬 ñandú — 100% listo';
  assert.equal(escapeHtml(text), text);
});

test('escapeHtml: escapa el & primero y una sola vez (no hay doble escapado de las entidades que genera)', () => {
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;'); // texto que YA parece una entidad se muestra tal cual
  assert.equal(escapeHtml('"<&>\''), '&quot;&lt;&amp;&gt;&#39;');
});

test('escapeHtml: null y undefined dan cadena vacía; números y booleanos se convierten', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(12.5), '12.5');
  assert.equal(escapeHtml(false), 'false');
});

test('escapeHtml: un valor hostil no puede salirse de un atributo entre comillas dobles ni simples', () => {
  const hostile = '" onfocus="alert(1)" x=\'y\' autofocus="';
  const inDouble = `<input value="${escapeHtml(hostile)}">`;
  const inSingle = `<input value='${escapeHtml(hostile)}'>`;
  // Dentro de las comillas del atributo no queda ninguna comilla sin escapar: el valor es una sola cadena.
  assert.equal((inDouble.match(/"/g) || []).length, 2);
  assert.equal((inSingle.match(/'/g) || []).length, 2);
});

test('escapeHtml: un <script> o <img onerror> queda inerte como texto', () => {
  const out = escapeHtml('<img src=x onerror="alert(1)"><script>alert(2)</script>');
  assert.equal(/[<>]/.test(out), false);
  assert.equal(out.includes('"'), false);
});

// --- Guardián: una sola copia, cargada antes de quien la usa -------------------------------------

// Scripts de cada página en orden de aparición: { page, srcs: ['/js/escape-html.js', '/js/admin.js', ...] }.
function pageScripts() {
  return fs.readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.html'))
    .map((page) => {
      const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
      const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
      return { page, srcs };
    });
}

test('guardián: ningún .js de public/js define su propia copia de escapeHtml', () => {
  const dir = path.join(PUBLIC, 'js');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'escape-html.js')) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(/function\s+escapeHtml\w*\s*\(/.test(code), false, `${file} define su propia copia de escapeHtml`);
    assert.equal(/(const|let|var)\s+escapeHtml\w*\s*=/.test(code), false, `${file} define su propia copia de escapeHtml`);
  }
});

test('guardián: toda página cuyo script usa escapeHtml carga escape-html.js ANTES de ese script', () => {
  let checked = 0;
  for (const { page, srcs } of pageScripts()) {
    const sharedAt = srcs.indexOf('/js/escape-html.js');
    for (const [i, src] of srcs.entries()) {
      if (!src.startsWith('/js/') || src === '/js/escape-html.js') continue;
      const code = fs.readFileSync(path.join(PUBLIC, src), 'utf8');
      if (!/\bescapeHtml\w*\(/.test(code)) continue;
      checked++;
      assert.notEqual(sharedAt, -1, `${page}: ${src} usa escapeHtml pero la página no carga /js/escape-html.js`);
      assert.ok(sharedAt < i, `${page}: /js/escape-html.js tiene que ir ANTES de ${src}`);
    }
  }
  assert.ok(checked >= 4, `se esperaba revisar al menos 4 páginas (admin, index, library, room), se revisaron ${checked}`);
});

test('guardián: ninguna página carga escape-html.js inline (la CSP no permite scripts inline)', () => {
  for (const f of fs.readdirSync(PUBLIC).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      assert.equal(m[1].trim(), '', `${f} tiene un <script> inline con código`);
    }
  }
});
