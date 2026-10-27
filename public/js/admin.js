// --- Modal genérico: mismo componente que library.html/room.html (ver esos archivos para el
// comentario completo del bug V10 que motiva el manejo del timer de cierre) ---------------------
let mnModalHideTimer = null;
function mnDialog({ title, message = '', showInput = false, inputType = 'text', placeholder = '',
                     defaultValue = '', okLabel = 'Aceptar', cancelLabel = 'Cancelar', showCancel = true }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('mnModalOverlay');
    const titleEl = document.getElementById('mnModalTitle');
    const messageEl = document.getElementById('mnModalMessage');
    const input = document.getElementById('mnModalInput');
    const errorEl = document.getElementById('mnModalError');
    const okBtn = document.getElementById('mnModalOk');
    const cancelBtn = document.getElementById('mnModalCancel');

    titleEl.textContent = title;
    messageEl.textContent = message;
    messageEl.hidden = !message;
    input.hidden = !showInput;
    input.type = inputType;
    input.placeholder = placeholder;
    input.value = defaultValue;
    errorEl.hidden = true;
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    cancelBtn.hidden = !showCancel;

    if (mnModalHideTimer) { clearTimeout(mnModalHideTimer); mnModalHideTimer = null; }
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('is-visible'));
    setTimeout(() => (showInput ? input : okBtn).focus(), 30);

    function close(result) {
      overlay.classList.remove('is-visible');
      mnModalHideTimer = setTimeout(() => { overlay.hidden = true; mnModalHideTimer = null; }, 150);
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onOk() { close(showInput ? input.value : true); }
    function onCancel() { close(showInput ? null : false); }
    function onKeydown(e) {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape' && showCancel) onCancel();
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKeydown);
  });
}
function mnAlert(message, title = 'MovieNight') {
  return mnDialog({ title, message, showCancel: false, okLabel: 'OK' });
}
function mnConfirm(message, title = '¿Estás seguro?') {
  return mnDialog({ title, message, okLabel: 'Sí', cancelLabel: 'Cancelar' });
}
function mnPrompt({ title, message = '', placeholder = '', type = 'text', okLabel = 'Aceptar', cancelLabel = 'Cancelar', showCancel = true }) {
  return mnDialog({ title, message, showInput: true, inputType: type, placeholder, okLabel, cancelLabel, showCancel });
}

// --- Cuenta: mismo patrón que index.html/library.html, solo para mostrar quién está logueado y
// poder cerrar sesión desde acá — el chequeo real de "sos admin o no" pasa por checkAdminAccess() más
// abajo, no por esto.
let currentUser = null;
const accountBar = document.getElementById('accountBar');
function renderAccountBar() {
  if (!currentUser) { accountBar.innerHTML = ''; return; }
  accountBar.innerHTML = `
    <span>👤 ${escapeHtml(currentUser.email)}</span>
    <span class="account-sep">·</span>
    <button id="logoutBtn">Cerrar sesión</button>
  `;
  document.getElementById('logoutBtn').onclick = async () => {
    try { await fetch('/auth/logout', { method: 'POST' }); } catch (err) { /* igual redirige */ }
    window.location = '/';
  };
}

// --- Chequeo de acceso: si no hay sesión, o la sesión no es de un admin, redirige a index.html sin
// mostrar ni un mensaje de "esto es para admins" (docs/PLAN-PANEL-ADMIN.md, sección 6) — así no se le
// confirma a cualquiera que la pantalla existe. GET /admin/settings hace de chequeo real (404/401/403
// según corresponda, ver lib/adminAuth.js); GET /auth/me solo se usa para pintar el email en la barra.
async function checkAdminAccess() {
  try {
    const meRes = await fetch('/auth/me');
    const me = await meRes.json();
    currentUser = me.loggedIn ? { id: me.id, email: me.email } : null;
  } catch (err) {
    currentUser = null;
  }
  renderAccountBar();

  if (!currentUser) { window.location = '/'; return false; }

  const res = await fetch('/admin/settings');
  if (res.status !== 200) { window.location = '/'; return false; }
  return true;
}

// --- Catálogo de parámetros: etiqueta y descripción en criollo para cada key de lib/settings.js
// (sección 1.1 del plan) — el backend no manda estas dos cosas, solo key/type/min/max/value/source.
const SETTINGS_META = {
  ROOM_TTL_HOURS: {
    label: 'TTL de sala (horas)',
    desc: 'Horas sin actividad antes de que una sala expire. Vacío = nunca expira.'
  },
  MAX_LIBRARY_VIDEOS: {
    label: 'Tope de videos en biblioteca',
    desc: 'Cantidad máxima de videos guardados en la biblioteca. 0 = sin límite.'
  },
  MAX_LIBRARY_SIZE_GB: {
    label: 'Tope de tamaño de biblioteca (GB)',
    desc: 'Espacio máximo ocupado por la biblioteca. 0 = sin límite.'
  },
  R2_PRESIGN_EXPIRES_SECONDS: {
    label: 'Vencimiento de URL prefirmada (seg.)',
    desc: 'Cuánto dura válida la URL de subida directa a R2 antes de vencer.'
  },
  ALERT_HEALTH_FAILURE_THRESHOLD: {
    label: 'Umbral de alertas por salud',
    desc: 'Healthchecks seguidos en falla antes de mandar una alerta.'
  },
  ALERT_COOLDOWN_MS: {
    label: 'Cooldown de alertas (ms)',
    desc: 'Cuánto esperar antes de reenviar la misma alerta.'
  },
  MULTIPART_ABANDON_DAYS: {
    label: 'Antigüedad de subida abandonada (días)',
    desc: 'A partir de cuántos días una subida multipart a R2 se considera abandonada y se limpia.'
  },
  LIBRARY_ORPHAN_DAYS: {
    label: 'Antigüedad de video huérfano (días)',
    desc: 'A partir de cuántos días un video sin sala asociada aparece en el reporte de huérfanos.'
  },
  HOST_AUTO_TRANSFER: {
    label: 'Traspaso automático del host',
    desc: 'Si el host se desconecta, el control pasa solo al siguiente conectado. En "No", la sala queda sin control remoto hasta que vuelva el host.'
  },
  ALLOW_ANONYMOUS_ROOMS: {
    label: 'Permitir salas sin cuenta',
    desc: 'Si está en "No", crear una sala nueva exige una cuenta (aunque se sepa la contraseña de biblioteca). Las salas anónimas que ya existen siguen hasta que expiren.'
  },
  ALLOW_REGISTRATION: {
    label: 'Permitir registro de cuentas nuevas',
    desc: 'Si está en "No", nadie puede crear una cuenta nueva. Las cuentas que ya existen siguen entrando normalmente.'
  },
  ALLOW_LIBRARY_PASSWORD: {
    label: 'Permitir la contraseña de biblioteca',
    desc: 'Si está en "No", la contraseña compartida deja de valer para listar y subir cintas, y solo sirve la sesión de una cuenta. Un anónimo ya no puede crear sala ni subir archivos.'
  },
  REQUIRE_ACCOUNT_TO_JOIN: {
    label: 'Exigir cuenta para entrar a una sala',
    desc: 'Si está en "Sí", quien solo mira también necesita iniciar sesión: abre el link, se lo manda a iniciar sesión y vuelve solo a la sala. Quien ya está dentro sigue hasta que se reconecte.'
  }
};

const SOURCE_LABEL = { db: 'editado acá', env: 'desde tu .env', default: 'por defecto' };

const settingsList = document.getElementById('settingsList');

// Control de edición según el tipo del parámetro: los booleanos (interruptores) usan un selector
// Sí/No en vez de un campo de texto. Los valores del selector ('1'/'0') los acepta POST /admin/settings.
function renderSettingControl(setting) {
  const key = escapeHtml(setting.key);
  if (setting.type === 'bool') {
    const yes = setting.value === true ? 'selected' : '';
    const no = setting.value === true ? '' : 'selected';
    return `<select class="admin-setting-select" data-key="${key}">
          <option value="1" ${yes}>Sí</option>
          <option value="0" ${no}>No</option>
        </select>`;
  }
  const displayValue = setting.value === null ? '' : setting.value;
  return `<input type="text" inputmode="decimal" value="${escapeHtml(String(displayValue))}"
               placeholder="${setting.nullable ? 'vacío = nunca' : ''}" data-key="${key}">`;
}

async function loadSettings() {
  try {
    const res = await fetch('/admin/settings');
    const data = await res.json();
    renderSettings(data.settings || []);
  } catch (err) {
    settingsList.innerHTML = '<li class="library-empty">No se pudieron cargar los parámetros.</li>';
  }
}

function renderSettings(list) {
  settingsList.innerHTML = '';
  list.forEach((setting) => {
    const meta = SETTINGS_META[setting.key] || { label: setting.key, desc: '' };
    const li = document.createElement('li');
    li.className = 'admin-setting-row';
    const sourceClass = setting.source === 'db' ? 'is-db' : '';
    li.innerHTML = `
      <div class="admin-setting-info">
        <div class="admin-setting-name">${escapeHtml(meta.label)}</div>
        <div class="admin-setting-desc">${escapeHtml(meta.desc)}</div>
        <span class="admin-setting-source ${sourceClass}">${escapeHtml(SOURCE_LABEL[setting.source] || setting.source)}</span>
      </div>
      <div class="admin-setting-controls">
        ${renderSettingControl(setting)}
        <button class="admin-save-btn" data-key="${escapeHtml(setting.key)}">Guardar</button>
        <button class="admin-reset-btn" data-key="${escapeHtml(setting.key)}" ${setting.source === 'db' ? '' : 'disabled'}>Restaurar</button>
      </div>
    `;
    settingsList.appendChild(li);
  });

  settingsList.querySelectorAll('.admin-save-btn').forEach((btn) => {
    btn.addEventListener('click', () => saveSetting(btn.dataset.key));
  });
  settingsList.querySelectorAll('.admin-reset-btn').forEach((btn) => {
    btn.addEventListener('click', () => resetSetting(btn.dataset.key));
  });
}

async function saveSetting(key) {
  const input = settingsList.querySelector(`input[data-key="${key}"], select[data-key="${key}"]`);
  const value = input.value;
  try {
    const res = await fetch('/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      await mnAlert(data.error || 'No se pudo guardar el parámetro.', 'Error');
      return;
    }
    await loadSettings();
  } catch (err) {
    await mnAlert('No se pudo conectar con el servidor. Intenta de nuevo.');
  }
}

async function resetSetting(key) {
  const ok = await mnConfirm(`¿Restaurar "${key}" a su valor de .env/default?`);
  if (!ok) return;
  try {
    const res = await fetch(`/admin/settings/${encodeURIComponent(key)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || data.error) {
      await mnAlert(data.error || 'No se pudo restaurar el parámetro.', 'Error');
      return;
    }
    await loadSettings();
  } catch (err) {
    await mnAlert('No se pudo conectar con el servidor. Intenta de nuevo.');
  }
}

// --- Dashboard (contadores) y salas activas -------------------------------------------------------
async function loadStats() {
  try {
    const res = await fetch('/admin/stats');
    const data = await res.json();
    document.getElementById('statActiveRooms').textContent = data.activeRooms;
    document.getElementById('statConnectedUsers').textContent = data.connectedUsers;
    document.getElementById('statUploads').textContent = data.uploadsInProgress;
    document.getElementById('statR2Errors').textContent = data.r2ErrorCount;
  } catch (err) { /* el dashboard no es crítico, se reintenta en el próximo refresh */ }
}

const roomsList = document.getElementById('roomsList');

async function loadRooms() {
  try {
    const res = await fetch('/admin/rooms');
    const data = await res.json();
    renderRooms(data.rooms || []);
  } catch (err) {
    roomsList.innerHTML = '<li class="library-empty">No se pudo cargar la lista de salas.</li>';
  }
}

// --- Bloqueados ahora (GET /admin/security): IPs bloqueadas por intentos fallidos de login, biblioteca y
// salas con contraseña. Es el estado en memoria del servidor (se vacía al reiniciar), no un historial. ---
const securityList = document.getElementById('securityList');

async function loadSecurity() {
  try {
    const res = await fetch('/admin/security');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const asList = (v) => (Array.isArray(v) ? v : []);
    renderSecurity([
      ...asList(data.login).map((e) => ({ ...e, source: 'Login' })),
      ...asList(data.library).map((e) => ({ ...e, source: 'Biblioteca' })),
      ...asList(data.roomJoin).map((e) => ({ ...e, source: 'Sala' }))
    ]);
  } catch (err) {
    securityList.innerHTML = '<li class="library-empty">No se pudo cargar la lista de bloqueados.</li>';
  }
}

function renderSecurity(items) {
  if (!items.length) {
    securityList.innerHTML = '<li class="library-empty">Nadie bloqueado ahora mismo.</li>';
    return;
  }
  const now = Date.now(); // minutos restantes calculados desde que llegó la respuesta
  securityList.innerHTML = '';
  items.forEach((item) => {
    const minLeft = Math.max(1, Math.ceil((Number(item.lockedUntil) - now) / 60000));
    let extra = '';
    if (item.source === 'Login' && item.emailMasked) extra = ` — ${escapeHtml(item.emailMasked)}`;
    else if (item.source === 'Sala' && item.roomId) extra = ` — ${escapeHtml(item.roomId)}`;
    const li = document.createElement('li');
    li.className = 'tape-item';
    li.innerHTML = `
      <span class="tape-item-icon">🔒</span>
      <div class="tape-item-info">
        <div class="tape-item-name">${escapeHtml(item.source)}${extra}</div>
        <div class="tape-item-meta tape-item-meta-wrap">${escapeHtml(item.ip)} · vence en ${escapeHtml(String(minLeft))} min</div>
      </div>
    `;
    securityList.appendChild(li);
  });
}

function formatLastActivity(iso) {
  if (!iso) return 'sin actividad registrada';
  const d = new Date(iso);
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' · ' +
         d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function renderRooms(rooms) {
  if (!rooms.length) {
    roomsList.innerHTML = '<li class="library-empty">No hay salas activas ahora mismo.</li>';
    return;
  }
  roomsList.innerHTML = '';
  rooms.forEach((room) => {
    const li = document.createElement('li');
    li.className = 'tape-item admin-room-item';
    const hostLabel = room.host
      ? `Host: ${escapeHtml(room.host.name || 'sin nombre')}`
      : 'Sin host asignado';
    li.innerHTML = `
      <span class="tape-item-icon">📼</span>
      <div class="tape-item-info">
        <div class="tape-item-name">${escapeHtml(room.roomId)} — ${escapeHtml(room.videoRef || 'sin video')}</div>
        <div class="tape-item-meta">${room.viewerCount} viewer${room.viewerCount === 1 ? '' : 's'} · ${escapeHtml(room.owner)} · ${formatLastActivity(room.lastActivity)}</div>
        <div class="admin-room-host">${hostLabel}</div>
      </div>
      <div class="tape-item-actions">
        <button class="close-btn" data-room="${escapeHtml(room.roomId)}">Cerrar</button>
      </div>
    `;
    roomsList.appendChild(li);
  });

  roomsList.querySelectorAll('.close-btn').forEach((btn) => {
    btn.addEventListener('click', () => closeSingleRoom(btn.dataset.room));
  });
}

async function closeSingleRoom(roomId) {
  const ok = await mnConfirm(`¿Cerrar la sala "${roomId}"? Se desconecta a quien esté mirando ahora.`);
  if (!ok) return;
  try {
    const res = await fetch(`/admin/rooms/${encodeURIComponent(roomId)}/close`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || data.error) { await mnAlert(data.error || 'No se pudo cerrar la sala.', 'Error'); return; }
    await refreshDashboard();
  } catch (err) {
    await mnAlert('No se pudo conectar con el servidor. Intenta de nuevo.');
  }
}

// --- Zona de riesgo: los 3 botones de acción global -------------------------------------------------
document.getElementById('sweepNowBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/admin/rooms/sweep-now', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || data.error) { await mnAlert(data.error || 'No se pudo forzar el barrido.', 'Error'); return; }
    await mnAlert(`Barrido forzado: ${data.closed} sala${data.closed === 1 ? '' : 's'} cerrada${data.closed === 1 ? '' : 's'} por TTL vencido.`);
    await refreshDashboard();
  } catch (err) {
    await mnAlert('No se pudo conectar con el servidor. Intenta de nuevo.');
  }
});

document.getElementById('closeInactiveBtn').addEventListener('click', async () => {
  const ok = await mnConfirm('¿Cerrar todas las salas sin espectadores conectados? No afecta a las que tienen gente mirando.');
  if (!ok) return;
  try {
    const res = await fetch('/admin/rooms/close-inactive', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || data.error) { await mnAlert(data.error || 'No se pudieron cerrar las salas inactivas.', 'Error'); return; }
    await mnAlert(`${data.closed} sala${data.closed === 1 ? '' : 's'} inactiva${data.closed === 1 ? '' : 's'} cerrada${data.closed === 1 ? '' : 's'}.`);
    await refreshDashboard();
  } catch (err) {
    await mnAlert('No se pudo conectar con el servidor. Intenta de nuevo.');
  }
});

document.getElementById('closeAllBtn').addEventListener('click', async () => {
  const confirmText = await mnPrompt({
    title: '⚠️ Cerrar TODAS las salas',
    message: 'Esto desconecta a TODOS los espectadores en TODAS las salas, incluidas las que tienen gente mirando ahora. Escribí exactamente CERRAR TODO para confirmar.',
    placeholder: 'CERRAR TODO',
    okLabel: 'Cerrar todas'
  });
  if (confirmText === null) return;
  if (confirmText !== 'CERRAR TODO') {
    await mnAlert('No coincide con "CERRAR TODO" — no se hizo nada.', 'Cancelado');
    return;
  }
  try {
    const res = await fetch('/admin/rooms/close-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: confirmText })
    });
    const data = await res.json();
    if (!res.ok || data.error) { await mnAlert(data.error || 'No se pudieron cerrar todas las salas.', 'Error'); return; }
    await mnAlert(`${data.closed} sala${data.closed === 1 ? '' : 's'} cerrada${data.closed === 1 ? '' : 's'}.`);
    await refreshDashboard();
  } catch (err) {
    await mnAlert('No se pudo conectar con el servidor. Intenta de nuevo.');
  }
});

async function refreshDashboard() {
  await Promise.all([loadStats(), loadRooms(), loadSecurity()]);
}

// --- Arranque: chequeo de acceso -> primera carga -> refresh periódico del dashboard (15s, mismo
// espíritu que el "REC" decorativo de abajo, pero con datos reales) --------------------------------
(async () => {
  const allowed = await checkAdminAccess();
  if (!allowed) return;
  document.getElementById('adminLoading').style.display = 'none';
  document.getElementById('adminBody').style.display = 'block';
  await Promise.all([loadSettings(), refreshDashboard()]);
  setInterval(refreshDashboard, 15000);
})();

// --- Contador REC decorativo (mismo componente que library.html/room.html) ---
let recSeconds = 0;
const recTimeEl = document.getElementById('recTime');
setInterval(() => {
  recSeconds++;
  const m = String(Math.floor(recSeconds / 60)).padStart(2, '0');
  const s = String(recSeconds % 60).padStart(2, '0');
  recTimeEl.textContent = `${m}:${s}`;
}, 1000);
