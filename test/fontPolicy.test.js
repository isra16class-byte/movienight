const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const helmet = require('helmet');

test('CSP real: estilos y fuentes solo locales, conservando R2 y la prohibición de inline', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('app.use(helmet({');
  const end = source.indexOf('\n}));', start) + 5;
  assert.ok(start >= 0 && end > start);
  const headers = new Map();
  vm.runInNewContext(source.slice(start, end), {
    app: { use: middleware => middleware({ headers: {}, secure: true }, {
      setHeader: (name, value) => headers.set(name.toLowerCase(), value),
      removeHeader: name => headers.delete(name.toLowerCase()),
    }, () => {}) },
    helmet,
    RUNNING_WITHOUT_HTTPS: false,
    r2CspOrigins: { connectSrc: ['https://storage.test'], mediaSrc: ['https://video.test'] },
  });
  const csp = headers.get('content-security-policy');
  assert.match(csp, /(?:^|;)style-src 'self'(?:;|$)/);
  assert.match(csp, /(?:^|;)font-src 'self'(?:;|$)/);
  assert.match(csp, /connect-src 'self' https:\/\/storage.test;/);
  assert.match(csp, /media-src 'self' https:\/\/video.test;/);
  assert.doesNotMatch(csp, /fonts\.(googleapis|gstatic)\.com|unsafe-inline/);
});
