const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');

// Estos tests miran la FORMA del código del cliente (no se ejecuta en Node): vigilan dos mejoras que son
// fáciles de perder en un refactor. El comportamiento real se verificó con un DOM simulado contra el
// servidor (ver docs/CHANGELOG.md).

// Cuerpo de una función de primer nivel: desde `async function name(` hasta el `\n}\n` que la cierra.
function functionBody(code, name) {
  const start = code.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `no se encontró la función ${name}`);
  const end = code.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `no se encontró el cierre de ${name}`);
  return code.slice(start, end);
}

test('doRegister (index.js y library.js): consulta si el registro está abierto ANTES de pedir el email', () => {
  for (const file of ['index.js', 'library.js']) {
    const body = functionBody(read(file), 'doRegister');
    const check = body.indexOf('isRegistrationOpen()');
    const firstPrompt = body.indexOf('mnPrompt(');
    assert.notEqual(check, -1, `${file}: doRegister no consulta isRegistrationOpen()`);
    assert.ok(check < firstPrompt, `${file}: isRegistrationOpen() tiene que ir antes del primer mnPrompt`);
  }
});

test('isRegistrationOpen (index.js y library.js): lee allowRegistration y, si la consulta falla, asume abierto', () => {
  for (const file of ['index.js', 'library.js']) {
    const body = functionBody(read(file), 'isRegistrationOpen');
    assert.match(body, /\/api\/access-policy/, `${file}: no consulta /api/access-policy`);
    assert.match(body, /allowRegistration/, `${file}: no lee allowRegistration`);
    assert.match(body, /catch[\s\S]*return true/, `${file}: ante un error de red tiene que asumir abierto`);
  }
});

test('library.js: mnLibraryFetch muestra los intentos que quedan cuando el server los manda', () => {
  const body = functionBody(read('library.js'), 'mnLibraryFetch');
  assert.match(body, /attemptsLeft/);
  assert.match(body, /Te quedan/);
});

test('library.js: con attemptsLeft 0 (IP ya bloqueada) no pide otra contraseña y la consulta de bloqueo tiene guarda anti-bucle', () => {
  const body = functionBody(read('library.js'), 'mnLibraryFetch');
  assert.match(body, /attemptsLeft === 0 && !lockProbeDone/);
  assert.match(body, /lockProbeDone = true/);
});
