const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../lib/settings');

// Fake mínimo de lib/db.js — mismo criterio que envValidation.test.js inyectando un `env` de mentira
// en vez de tocar process.env real: acá se inyecta un `db` de mentira en vez de tocar Postgres real.
// `rows` es un Map en memoria que simula la tabla app_settings.
function makeFakeDb(initialRows = []) {
  const rows = new Map(initialRows.map((r) => [r.key, r]));
  return {
    isEnabled: () => true,
    listSettings: async () => Array.from(rows.values()),
    setSetting: async (key, value, updatedBy) => {
      rows.set(key, { key, value, updated_at: new Date(), updated_by: updatedBy });
    },
    deleteSetting: async (key) => {
      rows.delete(key);
    },
    _rows: rows
  };
}

test('getSetting: sin Postgres habilitado, cae a env, y si tampoco hay env, al default', async () => {
  const disabledDb = { isEnabled: () => false };
  await settings.init(disabledDb);

  delete process.env.MAX_LIBRARY_VIDEOS;
  assert.equal(settings.getSetting('MAX_LIBRARY_VIDEOS'), 0); // default del catálogo

  process.env.MAX_LIBRARY_VIDEOS = '50';
  assert.equal(settings.getSetting('MAX_LIBRARY_VIDEOS'), 50);
  delete process.env.MAX_LIBRARY_VIDEOS;
});

test('getSetting: un valor en Postgres gana por encima de env y del default', async () => {
  const db = makeFakeDb([{ key: 'MAX_LIBRARY_VIDEOS', value: '999', updated_at: new Date(), updated_by: null }]);
  await settings.init(db);

  process.env.MAX_LIBRARY_VIDEOS = '50'; // no debería importar, Postgres gana
  assert.equal(settings.getSetting('MAX_LIBRARY_VIDEOS'), 999);
  delete process.env.MAX_LIBRARY_VIDEOS;
});

test('getSetting: pide un key desconocido y tira, en vez de devolver undefined en silencio', async () => {
  await settings.init(makeFakeDb());
  assert.throws(() => settings.getSetting('ALGO_QUE_NO_EXISTE'));
});

test('getSetting: tira si se llama antes de init()', () => {
  // No hay forma de "desinicializar" el módulo real entre tests (es un singleton, mismo patrón que
  // lib/db.js) — este test corre primero que nada más en el proceso... salvo que node --test corra
  // los archivos en paralelo, así que en vez de depender del orden, se prueba contra un require
  // fresco del módulo, aislado de la cache de require de los tests anteriores.
  delete require.cache[require.resolve('../lib/settings')];
  const freshSettings = require('../lib/settings');
  assert.throws(() => freshSettings.getSetting('MAX_LIBRARY_VIDEOS'), /init\(\)/);
});

test('validate: rechaza fuera de rango y acepta dentro de rango', async () => {
  await settings.init(makeFakeDb());
  assert.deepEqual(settings.validate('ALERT_HEALTH_FAILURE_THRESHOLD', 5), { ok: true });
  assert.equal(settings.validate('ALERT_HEALTH_FAILURE_THRESHOLD', 0).ok, false);
  assert.equal(settings.validate('ALERT_HEALTH_FAILURE_THRESHOLD', 21).ok, false);
  assert.equal(settings.validate('ALERT_HEALTH_FAILURE_THRESHOLD', NaN).ok, false);
});

test('ROOM_TTL_HOURS: null es un valor válido ("nunca expira"), pero solo para este setting nullable', async () => {
  await settings.init(makeFakeDb());
  assert.deepEqual(settings.validate('ROOM_TTL_HOURS', null), { ok: true });
  // MAX_LIBRARY_VIDEOS no es nullable — null ahí sí se rechaza.
  assert.equal(settings.validate('MAX_LIBRARY_VIDEOS', null).ok, false);
});

test('setSetting: persiste, invalida la cache al toque y valida antes de guardar', async () => {
  const db = makeFakeDb();
  await settings.init(db);

  await settings.setSetting('MAX_LIBRARY_VIDEOS', '250', 'admin-uuid-1', db);
  assert.equal(settings.getSetting('MAX_LIBRARY_VIDEOS'), 250); // ya se ve sin volver a llamar init()
  assert.equal(db._rows.get('MAX_LIBRARY_VIDEOS').value, '250'); // y quedó persistido

  await assert.rejects(() => settings.setSetting('MAX_LIBRARY_VIDEOS', '99999', 'admin-uuid-1', db));
});

test('setSetting: string vacío en ROOM_TTL_HOURS se guarda como "nunca expira"', async () => {
  const db = makeFakeDb();
  await settings.init(db);

  await settings.setSetting('ROOM_TTL_HOURS', '', 'admin-uuid-1', db);
  assert.equal(settings.getSetting('ROOM_TTL_HOURS'), null);
  assert.equal(db._rows.get('ROOM_TTL_HOURS').value, '');
});

test('resetSetting: borra de Postgres y la cache vuelve a caer en env→default', async () => {
  const db = makeFakeDb([{ key: 'MAX_LIBRARY_VIDEOS', value: '999', updated_at: new Date(), updated_by: null }]);
  await settings.init(db);
  assert.equal(settings.getSetting('MAX_LIBRARY_VIDEOS'), 999);

  await settings.resetSetting('MAX_LIBRARY_VIDEOS', db);
  assert.equal(settings.getSetting('MAX_LIBRARY_VIDEOS'), 0); // vuelve al default, sin nada en env
  assert.equal(db._rows.has('MAX_LIBRARY_VIDEOS'), false);
});

test('listAll: refleja el origen correcto de cada parámetro (db / env / default)', async () => {
  const db = makeFakeDb([{ key: 'MAX_LIBRARY_VIDEOS', value: '999', updated_at: new Date(), updated_by: 'admin-uuid-1' }]);
  await settings.init(db);
  process.env.ALERT_COOLDOWN_MS = '120000';

  const all = settings.listAll();
  const byKey = Object.fromEntries(all.map((s) => [s.key, s]));

  assert.equal(byKey.MAX_LIBRARY_VIDEOS.source, 'db');
  assert.equal(byKey.MAX_LIBRARY_VIDEOS.value, 999);
  assert.equal(byKey.ALERT_COOLDOWN_MS.source, 'env');
  assert.equal(byKey.ALERT_COOLDOWN_MS.value, 120000);
  assert.equal(byKey.LIBRARY_ORPHAN_DAYS.source, 'default');
  assert.equal(byKey.LIBRARY_ORPHAN_DAYS.value, 30);

  delete process.env.ALERT_COOLDOWN_MS;
});
