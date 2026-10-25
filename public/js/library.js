const cassetteIcon = `<svg class="cassette-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color:var(--cyan)">
  <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" stroke-dasharray="4 3"/>
  <circle cx="12" cy="12" r="2.5" fill="currentColor"/>
</svg>`;

const params = new URLSearchParams(location.search);
const fromRoom = params.get('fromRoom');
const roomHostToken = fromRoom ? localStorage.getItem('mn_host_' + fromRoom) : null;
const useLabel = fromRoom ? '🔁 USAR' : '▶ USAR';

if (fromRoom) {
  document.getElementById('libTitle').textContent = 'ELEGIR CINTA PARA LA SALA';
  document.getElementById('libTagline').textContent = 'Elige un video ya subido para cambiar la cinta de tu sala activa, o sube uno nuevo.';
  const backLink = document.getElementById('backLink');
  backLink.href = `/room/${fromRoom}`;
  backLink.textContent = '◂ Volver a la sala';
  document.getElementById('newUploadWrap').style.display = 'block';
  if (!roomHostToken) {
    document.getElementById('libTagline').textContent = 'No tienes permisos de host en esa sala desde este navegador — solo puedes ver la biblioteca.';
  }
}

const tapeList = document.getElementById('tapeList');

function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

function formatDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' · ' +
         d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Modal genérico: reemplaza prompt()/confirm()/alert() nativos del navegador ---
// (mismo componente que en room.html — ver nota junto a .mn-modal-overlay en style.css)
//
// Bug (V10): close() agenda `overlay.hidden = true` recién a los 150ms, para que se vea la
// animación de fade-out. Si se abre un mnDialog() nuevo ANTES de que ese timeout dispare (ej.
// mnLibraryFetch reabriendo el prompt de contraseña apenas el fetch anterior vuelve con 401), el
// timer viejo igual dispara después y oculta el modal recién abierto (overlay.hidden = true le gana
// a la clase is-visible) — queda invisible con su Promise sin resolver, y de fondo se ve lo que
// hubiera debajo del overlay (ej. "Cargando cintas..."). Pasaba siempre en localhost, donde el
// fetch a sí mismo tarda bien menos de 150ms, y casi nunca a través de Cloudflare Tunnel, donde el
// viaje de ida y vuelta ya tarda más que eso. Se guarda el id del timeout en una variable de módulo
// y se cancela al abrir un modal nuevo.
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

// --- Contraseña de biblioteca guardada SOLO en sessionStorage (por pestaña) ---------------------
// Antes vivía en localStorage (`mn_library_pw`, en texto plano, legible por cualquier script del
// origen y compartida entre pestañas). Ahora dura lo que la pestaña y se comparte entre index.html y
// library.html dentro de ella. Todo acceso a la clave pasa por estas tres funciones; si el storage
// lanza (algunos modos privados), no se guarda nada y la web pide la contraseña cada vez.
const MN_LIBRARY_PW_KEY = 'mn_library_pw';
function getLibraryPw() {
  try { return sessionStorage.getItem(MN_LIBRARY_PW_KEY) || ''; } catch { return ''; }
}
function setLibraryPw(pw) {
  try { sessionStorage.setItem(MN_LIBRARY_PW_KEY, pw); } catch { /* sin storage: se pedirá de nuevo */ }
}
function clearLibraryPw() {
  try { sessionStorage.removeItem(MN_LIBRARY_PW_KEY); } catch { /* sin storage: nada que borrar */ }
}
// Migración: borra la contraseña que dejó la versión anterior en localStorage.
try { localStorage.removeItem(MN_LIBRARY_PW_KEY); } catch { /* sin storage: nada que migrar */ }

// --- Contraseña de biblioteca (V9): protege listar/borrar cintas, separada de la contraseña de cada
// sala. Se guarda en sessionStorage tras la primera vez que se ingresa correctamente, así no se vuelve
// a pedir mientras la pestaña siga abierta (ver mnLibraryFetch, usado por todas las
// llamadas a /api/uploads).
async function mnLibraryFetch(url, options = {}) {
  let pw = getLibraryPw();
  while (true) {
    const headers = Object.assign({}, options.headers, { 'x-library-password': pw });
    const res = await fetch(url, Object.assign({}, options, { headers }));
    if (res.status !== 401) {
      // 429 = IP bloqueada por demasiados intentos: la contraseña NO se llegó a comparar, así que
      // no se sabe si es correcta y no se guarda (antes se guardaba una contraseña mala).
      if (pw && res.status !== 429) setLibraryPw(pw);
      return res;
    }
    clearLibraryPw(); // 401: la guardada (si había) es incorrecta
    pw = await mnPrompt({
      title: 'Biblioteca protegida',
      message: pw
        ? 'Contraseña incorrecta. Probá de nuevo (te la pasa quien armó el servidor).'
        : 'Esta biblioteca es compartida entre todas las salas. Pedile la contraseña a quien armó el servidor.',
      placeholder: 'Contraseña de la biblioteca',
      type: 'password',
      okLabel: 'Entrar',
      showCancel: false
    });
  }
}

// --- Cuenta: login/registro/logout (Fase 2bis del plan de producción) ---------------------------
// Mismo componente y misma lógica que index.html (ver ese comentario para el porqué de encadenar
// mnPrompt() en vez de un formulario nuevo) — duplicado acá porque el proyecto no tiene un sistema de
// includes entre páginas (mismo criterio que ya usa con mnDialog, cassetteIcon, etc. en cada archivo).
let currentUser = null;
const accountBar = document.getElementById('accountBar');

function renderAccountBar() {
  if (currentUser) {
    accountBar.innerHTML = `
      <span>👤 ${escapeHtml(currentUser.email)}</span>
      <span class="account-sep">·</span>
      <button id="logoutBtn">Cerrar sesión</button>
    `;
    document.getElementById('logoutBtn').onclick = doLogout;
  } else {
    accountBar.innerHTML = `
      <button id="loginBtn">🔑 Iniciar sesión</button>
      <span class="account-sep">·</span>
      <button id="registerBtn">Crear cuenta</button>
    `;
    document.getElementById('loginBtn').onclick = doLogin;
    document.getElementById('registerBtn').onclick = doRegister;
  }
}

async function refreshAuthState() {
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    currentUser = data.loggedIn ? { id: data.id, email: data.email } : null;
  } catch (err) {
    currentUser = null;
  }
  renderAccountBar();
}

async function doLogin() {
  const email = await mnPrompt({ title: 'Iniciar sesión', placeholder: 'Email', type: 'email', okLabel: 'Siguiente' });
  if (email === null) return;
  const password = await mnPrompt({ title: 'Iniciar sesión', message: email, placeholder: 'Contraseña', type: 'password', okLabel: 'Entrar' });
  if (password === null) return;
  try {
    const res = await fetch('/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.error) {
      const retry = await mnConfirm(`${data.error}\n\n¿Olvidaste tu contraseña?`, 'No se pudo iniciar sesión');
      if (retry) await doForgotPassword(email);
      return;
    }
    currentUser = { id: data.id, email: data.email };
    renderAccountBar();
    loadTapes(); // con sesión, el server ahora deja pasar sin la contraseña de biblioteca (ver requireLibraryAuth)
    await mnAlert('Sesión iniciada.');
  } catch (err) {
    await mnAlert('No se pudo conectar con el servidor. Intenta de nuevo.');
  }
}

async function doRegister() {
  const email = await mnPrompt({ title: 'Crear cuenta', placeholder: 'Email', type: 'email', okLabel: 'Siguiente' });
  if (email === null) return;
  const password = await mnPrompt({ title: 'Crear cuenta', message: `${email} — mínimo 8 caracteres`, placeholder: 'Contraseña', type: 'password', okLabel: 'Crear' });
  if (password === null) return;
  try {
    const res = await fetch('/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.error) { await mnAlert(data.error, 'No se pudo crear la cuenta'); return; }
    await mnAlert('Cuenta creada. Ahora iniciá sesión.');
    await doLogin();
  } catch (err) {
    await mnAlert('No se pudo conectar con el servidor. Intenta de nuevo.');
  }
}

async function doLogout() {
  try { await fetch('/auth/logout', { method: 'POST' }); } catch (err) { /* igual se limpia el estado local */ }
  currentUser = null;
  renderAccountBar();
}

async function doForgotPassword(prefillEmail = '') {
  const email = await mnPrompt({ title: 'Recuperar contraseña', message: 'Te mandamos un link para elegir una nueva.', placeholder: 'Email', type: 'email', defaultValue: prefillEmail, okLabel: 'Enviar' });
  if (email === null) return;
  try {
    const res = await fetch('/auth/forgot-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    await mnAlert(data.message || data.error || 'Si ese email tiene una cuenta, te mandamos un link.');
  } catch (err) {
    await mnAlert('No se pudo conectar con el servidor. Intenta de nuevo.');
  }
}

refreshAuthState();

async function loadTapes() {
  try {
    const res = await mnLibraryFetch('/api/uploads');
    const tapes = await res.json();
    if (!res.ok || !Array.isArray(tapes)) {
      // Ej. 429 por bloqueo de IP: mostrar el mensaje del servidor en vez de "no hay cintas".
      tapeList.innerHTML = '';
      const li = document.createElement('li');
      li.className = 'library-empty';
      li.textContent = (tapes && tapes.error) || 'No se pudo cargar la biblioteca. Intenta de nuevo.';
      tapeList.appendChild(li);
      return;
    }
    renderTapes(tapes);
  } catch (err) {
    tapeList.innerHTML = '<li class="library-empty">No se pudo cargar la biblioteca. Intenta de nuevo.</li>';
  }
}

function renderTapes(tapes) {
  if (!tapes.length) {
    tapeList.innerHTML = '<li class="library-empty">📼 Todavía no hay cintas subidas.<br>Crea una sala desde la pantalla principal y aparecerá aquí.</li>';
    return;
  }
  tapeList.innerHTML = '';
  tapes.forEach(tape => {
    const li = document.createElement('li');
    li.className = 'tape-item';
    li.innerHTML = `
      <span class="tape-item-icon">📼</span>
      <div class="tape-item-info">
        <div class="tape-item-name">${escapeHtml(tape.displayName)}</div>
        <div class="tape-item-meta">${formatSize(tape.size)} · ${formatDate(tape.mtime)}</div>
      </div>
      <div class="tape-item-actions">
        <button class="use-btn">${useLabel}</button>
        <button class="delete-btn">🗑</button>
      </div>
    `;
    li.querySelector('.use-btn').addEventListener('click', () => useTape(tape.filename, li));
    li.querySelector('.delete-btn').addEventListener('click', () => deleteTape(tape.filename, li));
    tapeList.appendChild(li);
  });
}

async function useTape(filename, li) {
  const btn = li.querySelector('.use-btn');
  btn.disabled = true;
  btn.innerHTML = cassetteIcon;
  try {
    if (fromRoom) {
      if (!roomHostToken) { await mnAlert('No tienes permisos de host en esa sala desde este navegador.'); btn.disabled = false; btn.textContent = useLabel; return; }
      const res = await fetch(`/room/${fromRoom}/change-video-from-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, hostToken: roomHostToken })
      });
      const data = await res.json();
      if (data.error) { await mnAlert('Error: ' + data.error); btn.disabled = false; btn.textContent = useLabel; return; }
      window.location = `/room/${fromRoom}`;
      return;
    }
    // Fase 2bis, "quién puede crear salas" (2026-09-06): /create-room-from-upload ahora exige la
    // misma LIBRARY_PASSWORD que /create-room — mnLibraryFetch ya sabe pedirla/reintentar ante un
    // 401, igual que hace para listar/borrar la biblioteca.
    const res = await mnLibraryFetch('/create-room-from-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename })
    });
    const data = await res.json();
    if (data.error) { await mnAlert('Error: ' + data.error); btn.disabled = false; btn.textContent = useLabel; return; }
    localStorage.setItem('mn_host_' + data.roomId, data.hostToken);
    window.location = `/room/${data.roomId}`;
  } catch (err) {
    await mnAlert('No se pudo completar la acción. Intenta de nuevo.');
    btn.disabled = false;
    btn.textContent = useLabel;
  }
}

async function deleteTape(filename, li) {
  if (!(await mnConfirm('¿Borrar esta cinta del servidor? No se puede deshacer.'))) return;
  try {
    const res = await mnLibraryFetch('/api/uploads/' + encodeURIComponent(filename), { method: 'DELETE' });
    const data = await res.json();
    if (data.error) { await mnAlert('Error: ' + data.error); return; }
    li.remove();
    if (!tapeList.children.length) renderTapes([]);
  } catch (err) {
    await mnAlert('No se pudo borrar el archivo. Intenta de nuevo.');
  }
}

loadTapes();

// --- Subir una cinta nueva directo a la sala activa (solo cuando venimos de una sala) ---
if (fromRoom) {
  const newTapeFile = document.getElementById('newTapeFile');
  const newTapeFileName = document.getElementById('newTapeFileName');
  const newTapeProgressWrap = document.getElementById('newTapeProgressWrap');
  const newTapeProgressBar = document.getElementById('newTapeProgressBar');
  const newTapeStatus = document.getElementById('newTapeStatus');

  // --- Contraseña de subida (V19) ---------------------------------------------------------------
  // Mismo motivo y misma contraseña que en index.html (ver ese comentario): el server exige
  // `x-library-password` en /room/:id/change-video y corta a los 3 intentos incorrectos (bloqueo de
  // 15 min por IP, ver requireUploadAuth en server.js). Reusa el mismo sessionStorage `mn_library_pw`
  // que ya usa mnLibraryFetch acá mismo — si ya se desbloqueó la biblioteca en esta pestaña, no
  // vuelve a pedir nada.
  async function getUploadPassword(message = '') {
    return await mnPrompt({
      title: 'Subida protegida',
      message: message || 'Subir una cinta nueva necesita la contraseña de la biblioteca. Pedísela a quien armó el servidor.',
      placeholder: 'Contraseña',
      type: 'password',
      okLabel: 'Entrar'
    });
  }

  newTapeFile.addEventListener('change', async () => {
    const file = newTapeFile.files[0];
    if (!file) return;
    if (!roomHostToken) { newTapeStatus.textContent = 'No tienes permisos de host en esta sala desde este navegador.'; return; }

    // Fase 2bis, "la biblioteca deja de depender de una única LIBRARY_PASSWORD": con sesión iniciada
    // no hace falta pedir la contraseña compartida (ver requireUploadAuth en server.js).
    let pw = getLibraryPw();
    if (!currentUser && !pw) {
      pw = await getUploadPassword();
      if (pw === null) return; // canceló el prompt
    }

    newTapeFileName.textContent = file.name;
    newTapeProgressWrap.classList.add('active');

    function resetUi(msg) {
      newTapeStatus.textContent = msg;
      newTapeProgressWrap.classList.remove('active');
    }

    // --- Fase 2.7 del plan de producción: subida directa a Cloudflare R2 ---------------------------
    // Mismo motivo y mismo camino que en index.html (ver ese archivo para el comentario completo): si
    // el server tiene R2 configurado, el archivo sube DIRECTO al bucket con una URL prefirmada, sin
    // pasar por este server ni por el Cloudflare Tunnel — así se evita el `413 Payload Too Large` de
    // Cloudflare con videos reales. Si /api/uploads/presign responde 404 (sin R2 configurado), se sigue
    // con el flujo clásico de multipart directo a /room/:id/change-video.

    async function requestPresign(pw) {
      const res = await fetch('/api/uploads/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-library-password': pw },
        body: JSON.stringify({ filename: file.name, contentType: file.type || 'application/octet-stream' })
      });
      let data;
      try { data = await res.json(); } catch { data = {}; }
      return { httpStatus: res.status, data };
    }

    function putDirectToR2(uploadUrl) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            newTapeProgressBar.style.width = pct + '%';
            newTapeStatus.innerHTML = `${cassetteIcon} Subiendo cinta... ${pct}%`;
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Cloudflare R2 rechazó la subida (código ${xhr.status}). Si esto persiste, revisá la configuración de CORS del bucket (ver README).`));
        };
        xhr.onerror = () => reject(new Error('No se pudo subir el archivo directo a Cloudflare R2. Revisá tu conexión o la configuración de CORS del bucket (ver README).'));
        xhr.send(file);
      });
    }

    // Reusa /room/:id/change-video-from-upload tal cual — hasta ahora solo servía para reutilizar una
    // cinta ya presente en la biblioteca, pero no necesita saber si la key llegó de ahí o de recién
    // subirla directo a R2.
    async function confirmChangeVideoFromKey(key) {
      const res = await fetch(`/room/${fromRoom}/change-video-from-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: key, hostToken: roomHostToken })
      });
      let data;
      try { data = await res.json(); } catch { data = { error: 'Respuesta inválida del servidor' }; }
      return { httpStatus: res.status, data };
    }

    async function confirmChangeVideo(key) {
      newTapeStatus.textContent = 'Preparando la sala...';
      const { httpStatus, data } = await confirmChangeVideoFromKey(key);
      if (httpStatus < 200 || httpStatus >= 300 || data.error) {
        resetUi('Error: ' + (data.error || 'no se pudo cambiar la cinta'));
        return;
      }
      newTapeProgressBar.style.width = '100%';
      newTapeStatus.textContent = 'Listo, volviendo a la sala...';
      window.location = `/room/${fromRoom}`;
    }

    async function uploadDirectToR2(pw) {
      newTapeStatus.innerHTML = `${cassetteIcon} Preparando subida...`;
      const { httpStatus, data } = await requestPresign(pw);

      if (httpStatus === 404) return legacyUploadViaServer(pw); // sin R2 configurado

      if (httpStatus === 401 || httpStatus === 429) {

        if (httpStatus === 401) clearLibraryPw(); // la guardada (si había) es incorrecta
        if (httpStatus === 401 && data.attemptsLeft > 0) {
          const nextPw = await getUploadPassword(`Contraseña incorrecta. Te quedan ${data.attemptsLeft} intento${data.attemptsLeft === 1 ? '' : 's'}.`);
          if (nextPw === null) { resetUi('Subida cancelada.'); return; }
          return uploadDirectToR2(nextPw);
        }
        resetUi('Error: ' + (data.error || 'no se pudo preparar la subida'));
        return;
      }
      if (httpStatus < 200 || httpStatus >= 300 || data.error) {
        resetUi('Error: ' + (data.error || 'no se pudo preparar la subida'));
        return;
      }

      try {
        newTapeStatus.innerHTML = `${cassetteIcon} Subiendo cinta... 0%`;
        newTapeProgressBar.style.width = '0%';
        await putDirectToR2(data.uploadUrl);
        newTapeProgressBar.style.width = '100%';
      } catch (err) {
        resetUi(err.message || 'No se pudo subir el archivo. Intenta de nuevo.');
        return;
      }

      setLibraryPw(pw); // correcta: no se vuelve a pedir en esta pestaña
      await confirmChangeVideo(data.key);
    }

    // --- Flujo clásico (modo disco local, sin R2 configurado): multipart directo a change-video, igual
    // que siempre — sigue sujeto al límite de Cloudflare si se comparte por Tunnel (ver Fase 2.7 en
    // docs/PLAN-PRODUCCION.md), limitación conocida de este modo.
    function legacyUploadViaServer(pw) {
      newTapeStatus.innerHTML = `${cassetteIcon} Subiendo cinta... 0%`;
      newTapeProgressBar.style.width = '0%';

      const form = new FormData();
      form.append('video', file);
      form.append('hostToken', roomHostToken);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/room/${fromRoom}/change-video`);
      xhr.setRequestHeader('x-library-password', pw);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          newTapeProgressBar.style.width = pct + '%';
          newTapeStatus.innerHTML = `${cassetteIcon} Subiendo cinta... ${pct}%`;
        }
      };
      xhr.onload = async () => {
        let data;
        try { data = JSON.parse(xhr.responseText); } catch { data = { error: 'Respuesta inválida del servidor' }; }

        if (xhr.status === 401 || xhr.status === 429) {

          if (xhr.status === 401) clearLibraryPw(); // la guardada (si había) es incorrecta
          if (xhr.status === 401 && data.attemptsLeft > 0) {
            const nextPw = await getUploadPassword(`Contraseña incorrecta. Te quedan ${data.attemptsLeft} intento${data.attemptsLeft === 1 ? '' : 's'}.`);
            if (nextPw === null) { resetUi('Subida cancelada.'); return; }
            legacyUploadViaServer(nextPw);
            return;
          }
          resetUi('Error: ' + (data.error || 'no se pudo cambiar la cinta'));
          return;
        }

        if (xhr.status < 200 || xhr.status >= 300 || data.error) {
          resetUi('Error: ' + (data.error || 'no se pudo cambiar la cinta'));
          return;
        }
        setLibraryPw(pw); // correcta: no se vuelve a pedir en esta pestaña
        newTapeProgressBar.style.width = '100%';
        newTapeStatus.textContent = 'Listo, volviendo a la sala...';
        window.location = `/room/${fromRoom}`;
      };
      xhr.onerror = () => {
        resetUi('No se pudo subir el archivo. Intenta de nuevo.');
      };
      xhr.send(form);
    }

    uploadDirectToR2(pw);
  });
}

// --- Contador REC decorativo ---
let recSeconds = 0;
const recTimeEl = document.getElementById('recTime');
setInterval(() => {
  recSeconds++;
  const m = String(Math.floor(recSeconds / 60)).padStart(2, '0');
  const s = String(recSeconds % 60).padStart(2, '0');
  recTimeEl.textContent = `${m}:${s}`;
}, 1000);
