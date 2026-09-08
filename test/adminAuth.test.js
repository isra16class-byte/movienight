const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRequireAdmin, isSameOrigin, requireSameOrigin } = require('../lib/adminAuth');

// --- fakes -----------------------------------------------------------------------------------------
function makeFakeLog() {
  const errors = [];
  return { error(obj, msg) { errors.push({ obj, msg }); }, _errors: errors };
}

function makeFakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
  return res;
}

function makeFakeReq({ session, userById } = {}) {
  return { session, _userById: userById };
}

function makeFakeDb({ enabled = true, users = {} } = {}) {
  return {
    isEnabled: () => enabled,
    findUserById: async (userId) => users[userId] || null
  };
}

// --- requireAdmin ------------------------------------------------------------------------------------

test('requireAdmin: 404 si Postgres/cuentas no están habilitadas (ni siquiera confirma que exista sesión)', async () => {
  const db = makeFakeDb({ enabled: false });
  const requireAdmin = makeRequireAdmin(db, makeFakeLog());
  const req = makeFakeReq({ session: { userId: 'user-1' } });
  const res = makeFakeRes();
  let nextCalled = false;

  await requireAdmin(req, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 404);
  assert.equal(nextCalled, false);
});

test('requireAdmin: 401 sin sesión iniciada', async () => {
  const db = makeFakeDb({ users: { 'user-1': { id: 'user-1', role: 'admin' } } });
  const requireAdmin = makeRequireAdmin(db, makeFakeLog());
  const res = makeFakeRes();
  let nextCalled = false;

  await requireAdmin(makeFakeReq({ session: null }), res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('requireAdmin: 403 si la sesión es válida pero la cuenta no es admin', async () => {
  const db = makeFakeDb({ users: { 'user-1': { id: 'user-1', role: 'user' } } });
  const requireAdmin = makeRequireAdmin(db, makeFakeLog());
  const req = makeFakeReq({ session: { userId: 'user-1' } });
  const res = makeFakeRes();
  let nextCalled = false;

  await requireAdmin(req, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('requireAdmin: 403 si la cuenta de la sesión ya no existe (se borró, la sesión sigue viva)', async () => {
  const db = makeFakeDb({ users: {} }); // ningún usuario
  const requireAdmin = makeRequireAdmin(db, makeFakeLog());
  const req = makeFakeReq({ session: { userId: 'user-fantasma' } });
  const res = makeFakeRes();
  let nextCalled = false;

  await requireAdmin(req, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('requireAdmin: deja pasar y setea req.adminUser cuando la sesión es de un admin real', async () => {
  const adminUser = { id: 'user-1', role: 'admin', email: 'admin@test.com' };
  const db = makeFakeDb({ users: { 'user-1': adminUser } });
  const requireAdmin = makeRequireAdmin(db, makeFakeLog());
  const req = makeFakeReq({ session: { userId: 'user-1' } });
  const res = makeFakeRes();
  let nextCalled = false;

  await requireAdmin(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null); // no se llamó a res.status: el siguiente handler responde
  assert.deepEqual(req.adminUser, adminUser);
});

test('requireAdmin: 500 y loguea si la consulta a Postgres tira, sin dejar pasar', async () => {
  const db = { isEnabled: () => true, findUserById: async () => { throw new Error('Postgres se cayó'); } };
  const log = makeFakeLog();
  const requireAdmin = makeRequireAdmin(db, log);
  const req = makeFakeReq({ session: { userId: 'user-1' } });
  const res = makeFakeRes();
  let nextCalled = false;

  await requireAdmin(req, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 500);
  assert.equal(nextCalled, false);
  assert.equal(log._errors.length, 1);
});

// --- isSameOrigin / requireSameOrigin -----------------------------------------------------------------

function makeFakeReqWithHeaders(headers) {
  return { get: (name) => headers[name.toLowerCase()] };
}

test('isSameOrigin: true si no hay Origin ni Referer para comparar', () => {
  assert.equal(isSameOrigin(makeFakeReqWithHeaders({ host: 'movienight.example.com' })), true);
});

test('isSameOrigin: true si el Origin coincide con el host propio', () => {
  const req = makeFakeReqWithHeaders({ host: 'movienight.example.com', origin: 'https://movienight.example.com' });
  assert.equal(isSameOrigin(req), true);
});

test('isSameOrigin: false si el Origin es de otro sitio', () => {
  const req = makeFakeReqWithHeaders({ host: 'movienight.example.com', origin: 'https://sitio-malicioso.com' });
  assert.equal(isSameOrigin(req), false);
});

test('isSameOrigin: sin Origin, usa el Referer como respaldo', () => {
  const same = makeFakeReqWithHeaders({ host: 'movienight.example.com', referer: 'https://movienight.example.com/admin.html' });
  assert.equal(isSameOrigin(same), true);

  const different = makeFakeReqWithHeaders({ host: 'movienight.example.com', referer: 'https://otro-sitio.com/pagina' });
  assert.equal(isSameOrigin(different), false);
});

test('isSameOrigin: Origin con formato inválido se trata como "no coincide", no rompe', () => {
  const req = makeFakeReqWithHeaders({ host: 'movienight.example.com', origin: 'no-es-una-url' });
  assert.equal(isSameOrigin(req), false);
});

test('requireSameOrigin: deja pasar cuando el origen coincide', () => {
  const req = makeFakeReqWithHeaders({ host: 'movienight.example.com', origin: 'https://movienight.example.com' });
  const res = makeFakeRes();
  let nextCalled = false;

  requireSameOrigin(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('requireSameOrigin: responde 403 cuando el origen no coincide', () => {
  const req = makeFakeReqWithHeaders({ host: 'movienight.example.com', origin: 'https://sitio-malicioso.com' });
  const res = makeFakeRes();
  let nextCalled = false;

  requireSameOrigin(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});
