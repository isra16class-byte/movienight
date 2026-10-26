const btn = document.getElementById('createBtn');
const status = document.getElementById('status');
const fileInput = document.getElementById('videoFile');
const dropLabel = document.getElementById('dropLabel');
const fileNameText = document.getElementById('fileNameText');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');

const cassetteIcon = `<svg class="cassette-spin cassette-spin-cyan" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" stroke-dasharray="4 3"/>
  <circle cx="12" cy="12" r="2.5" fill="currentColor"/>
</svg>`;

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) {
    dropLabel.classList.add('has-file');
    fileNameText.textContent = file.name;
  }
});

// --- Modal genérico: reemplaza prompt()/confirm()/alert() nativos del navegador ---
// (mismo componente que room.html/library.html — ver nota junto a .mn-modal-overlay en style.css).
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
function mnPrompt({ title, message = '', placeholder = '', type = 'text', defaultValue = '', okLabel = 'Aceptar', cancelLabel = 'Cancelar', showCancel = true }) {
  return mnDialog({ title, message, showInput: true, inputType: type, placeholder, defaultValue, okLabel, cancelLabel, showCancel });
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

// --- Contraseña de subida (V19) ---------------------------------------------------------------
// Motivo: con R2 conectado, cualquiera con el link llegaba acá y podía subir archivos gigantes sin
// ninguna traba — cada uno se factura (ver requireUploadAuth en server.js). Reusa la MISMA contraseña
// que ya protege la biblioteca (`LIBRARY_PASSWORD`, un solo secreto para todo el server) y el mismo
// clave de sessionStorage (`mn_library_pw`) que usa library.html: si ya la desbloqueaste ahí en esta
// pestaña, acá ni te la vuelve a pedir. El servidor corta a las 3 contraseñas incorrectas seguidas
// (bloqueo de 15 min por IP) — este loop del cliente respeta ese límite vía `attemptsLeft` en la
// respuesta 401, no reintenta indefinidamente.
async function getUploadPassword(message = '') {
  return await mnPrompt({
    title: 'Subida protegida',
    message: message || 'Subir una cinta nueva necesita la contraseña de la biblioteca. Pedísela a quien armó el servidor.',
    placeholder: 'Contraseña',
    type: 'password',
    okLabel: 'Entrar'
  });
}

btn.onclick = async () => {
  const file = fileInput.files[0];
  if (!file) { status.textContent = 'Inserta una cinta primero'; return; }

  // Fase 2bis, "la biblioteca deja de depender de una única LIBRARY_PASSWORD": con sesión iniciada,
  // el server acepta la request sin pedir la contraseña compartida (ver requireUploadAuth en
  // server.js) — no tiene sentido pedirla acá tampoco. Sin sesión, sigue el flujo de siempre.
  let pw = getLibraryPw();
  if (!currentUser && !pw) {
    pw = await getUploadPassword();
    if (pw === null) return; // canceló el prompt
  }

  btn.disabled = true;
  btn.querySelector('span:last-child').textContent = 'GRABANDO...';
  progressWrap.classList.add('active');

  function resetUi(msg) {
    status.textContent = msg;
    btn.disabled = false;
    btn.querySelector('span:last-child').textContent = 'GRABAR SALA';
    progressWrap.classList.remove('active');
  }

  // --- Fase 2.7 del plan de producción: subida directa a Cloudflare R2 -----------------------------
  // Antes, el video siempre pasaba por este server (multipart a /create-room) — eso es justo lo que
  // corta con un `413 Payload Too Large` de CLOUDFLARE (no del server) al subir un video real de
  // varios GB por Cloudflare Tunnel (ver docs/PLAN-PRODUCCION.md, Fase 2.7). Ahora, si el server tiene
  // R2 configurado, el archivo se sube DIRECTO al bucket con una URL prefirmada — nunca atraviesa el
  // Tunnel, así que ese límite deja de aplicar. Si el server NO tiene R2 configurado (modo disco
  // local), /api/uploads/presign responde 404 y se sigue con el flujo clásico de siempre
  // (legacyUploadViaServer), que en ese modo sigue sujeto al mismo límite de Cloudflare de antes —
  // limitación conocida del modo disco, ver el mismo punto del plan.

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

  // Sube `file` directo al bucket con la URL prefirmada — mismo tipo de barra de progreso que antes,
  // solo que ahora el request va directo a R2, no a este server.
  function putDirectToR2(uploadUrl) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressBar.style.width = pct + '%';
          status.innerHTML = `${cassetteIcon} Subiendo cinta... ${pct}%`;
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

  // Confirma la sala una vez que el archivo YA está en R2 — reusa /create-room-from-upload tal cual:
  // esa ruta hasta ahora solo se usaba para reutilizar una cinta ya existente en la biblioteca, pero
  // no necesita saber si la key que le llega es "vieja" o recién subida.
  async function confirmRoomFromKey(pw, key) {
    const res = await fetch('/create-room-from-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-library-password': pw },
      body: JSON.stringify({ filename: key, password: document.getElementById('roomPassword').value.trim() })
    });
    let data;
    try { data = await res.json(); } catch { data = { error: 'Respuesta inválida del servidor' }; }
    return { httpStatus: res.status, data };
  }

  async function confirmRoom(pw, key) {
    status.innerHTML = `${cassetteIcon} Preparando la sala...`;
    const { httpStatus, data } = await confirmRoomFromKey(pw, key);

    if (httpStatus === 401 || httpStatus === 429) {

      if (httpStatus === 401) clearLibraryPw(); // la guardada (si había) es incorrecta
      if (httpStatus === 401 && data.attemptsLeft > 0) {
        const nextPw = await getUploadPassword(`Contraseña incorrecta. Te quedan ${data.attemptsLeft} intento${data.attemptsLeft === 1 ? '' : 's'}.`);
        if (nextPw === null) { resetUi('Subida cancelada.'); return; }
        // El archivo ya está en R2 — solo hace falta reintentar la confirmación, no volver a subirlo.
        return confirmRoom(nextPw, key);
      }
      resetUi('Error: ' + (data.error || 'no se pudo crear la sala'));
      return;
    }
    if (httpStatus < 200 || httpStatus >= 300 || data.error) {
      resetUi('Error: ' + (data.error || 'no se pudo crear la sala'));
      return;
    }

    setLibraryPw(pw); // correcta: no se vuelve a pedir en esta pestaña
    localStorage.setItem('mn_host_' + data.roomId, data.hostToken);
    window.location = `/room/${data.roomId}`;
  }

  async function uploadDirectToR2(pw) {
    status.innerHTML = `${cassetteIcon} Preparando subida...`;
    const { httpStatus, data } = await requestPresign(pw);

    if (httpStatus === 404) return legacyUploadViaServer(pw); // este server no tiene R2 configurado

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
      status.innerHTML = `${cassetteIcon} Subiendo cinta... 0%`;
      progressBar.style.width = '0%';
      await putDirectToR2(data.uploadUrl);
      progressBar.style.width = '100%';
    } catch (err) {
      resetUi(err.message || 'No se pudo subir el archivo. Intenta de nuevo.');
      return;
    }

    await confirmRoom(pw, data.key);
  }

  // --- Flujo clásico (modo disco local, sin R2 configurado): multipart directo a /create-room, igual
  // que siempre. Sigue sujeto al límite de tamaño de Cloudflare si se comparte por Tunnel (ver Fase
  // 2.7 en docs/PLAN-PRODUCCION.md) — limitación conocida de este modo, no algo que se resuelva acá.
  function legacyUploadViaServer(pw) {
    status.innerHTML = `${cassetteIcon} Subiendo cinta... 0%`;
    progressBar.style.width = '0%';

    const form = new FormData();
    form.append('video', file);
    form.append('password', document.getElementById('roomPassword').value.trim());

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/create-room');
    xhr.setRequestHeader('x-library-password', pw);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressBar.style.width = pct + '%';
        status.innerHTML = `${cassetteIcon} Subiendo cinta... ${pct}%`;
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
        resetUi('Error: ' + (data.error || 'no se pudo crear la sala'));
        return;
      }

      if (xhr.status < 200 || xhr.status >= 300 || data.error) {
        resetUi('Error: ' + (data.error || 'no se pudo crear la sala'));
        return;
      }

      setLibraryPw(pw); // correcta: no se vuelve a pedir en esta pestaña
      localStorage.setItem('mn_host_' + data.roomId, data.hostToken);
      progressBar.style.width = '100%';
      status.innerHTML = `${cassetteIcon} Preparando la sala...`;
      window.location = `/room/${data.roomId}`;
    };

    xhr.onerror = () => {
      resetUi('No se pudo subir el archivo. Intenta de nuevo.');
    };

    xhr.send(form);
  }

  uploadDirectToR2(pw);
};

// --- Cuenta: login/registro/logout (Fase 2bis del plan de producción) ---------------------------
// UI mínima a propósito: en vez de armar un formulario nuevo, se encadenan mnPrompt() (el mismo
// componente que ya usa el proyecto para pedir contraseñas) — email primero, contraseña después. Es
// un par de popups en vez de un único formulario, pero no suma ningún componente nuevo y resuelve el
// caso real (todavía no había NINGUNA forma de loguearse desde el navegador, ver docs/PLAN-PRODUCCION.md).
let currentUser = null; // { id, email } o null

const accountBar = document.getElementById('accountBar');

function renderAccountBar() {
  if (currentUser) {
    accountBar.innerHTML = `
      <span>👤 ${escapeHtmlLocal(currentUser.email)}</span>
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

// No hay ninguna dependencia externa de escape de HTML en este archivo (index.html no lo necesitaba
// hasta ahora) — reusa el mismo patrón de escapeHtml que ya usa library.html.
function escapeHtmlLocal(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function refreshAuthState() {
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    currentUser = data.loggedIn ? { id: data.id, email: data.email } : null;
  } catch (err) {
    currentUser = null; // si falla la consulta, se trata como "no logueado" — no bloquea el resto de la página
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

// --- Unirse a sala con código ---
const joinBtn = document.getElementById('joinBtn');
const joinCode = document.getElementById('joinCode');
const joinStatus = document.getElementById('joinStatus');

async function tryJoin() {
  const code = joinCode.textContent.trim().toLowerCase();
  if (!code) { joinStatus.textContent = 'Escribe un código de sala'; return; }
  joinBtn.disabled = true;
  joinStatus.innerHTML = `${cassetteIcon} Buscando sala...`;
  try {
    const res = await fetch(`/api/room/${code}`);
    const data = await res.json();
    if (data.error) {
      joinStatus.textContent = 'Esa sala no existe. Revisa el código.';
      joinBtn.disabled = false;
      return;
    }
    window.location = `/room/${code}`;
  } catch (err) {
    joinStatus.textContent = 'Error al buscar la sala. Intenta de nuevo.';
    joinBtn.disabled = false;
  }
}

joinBtn.onclick = tryJoin;

// joinCode pasó de <input> a <div contenteditable> por el mismo motivo que el chat de la sala
// (ver room.html): la barra de autofill de Chrome para Android (llave/tarjeta/ubicación) aparece
// sobre CUALQUIER <input>/<textarea> sin importar autocomplete="off", pero nunca sobre elementos
// contenteditable. Eso trae 3 cosas que un <input> resolvía solo y ahora hay que manejar a mano:
joinCode.addEventListener('keydown', (e) => {
  // 1) Enter no "envía" solo: por default inserta un salto de línea, hay que interceptarlo.
  if (e.key === 'Enter') {
    e.preventDefault();
    tryJoin();
  }
});
joinCode.addEventListener('paste', (e) => {
  // 2) Un paste normal puede traer HTML/formato pegado — se fuerza a texto plano.
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
});
joinCode.addEventListener('input', () => {
  // 3) No existe el atributo maxlength — se recorta a mano a 6 caracteres (el largo real de un
  // código de sala) y también se limpian saltos de línea, por si algo los coló vía paste.
  const clean = joinCode.textContent.replace(/[\r\n]+/g, '').slice(0, 6);
  if (clean !== joinCode.textContent) {
    joinCode.textContent = clean;
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(joinCode);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
});

// --- Contador REC decorativo (ambiente, no tiene efecto funcional) ---
let recSeconds = 0;
const recTimeEl = document.getElementById('recTime');
setInterval(() => {
  recSeconds++;
  const m = String(Math.floor(recSeconds / 60)).padStart(2, '0');
  const s = String(recSeconds % 60).padStart(2, '0');
  recTimeEl.textContent = `${m}:${s}`;
}, 1000);
