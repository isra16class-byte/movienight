const params = new URLSearchParams(location.search);
const token = params.get('token');
const tagline = document.getElementById('tagline');
const formWrap = document.getElementById('formWrap');
const status = document.getElementById('status');
const submitBtn = document.getElementById('submitBtn');
const newPassword = document.getElementById('newPassword');
const confirmPassword = document.getElementById('confirmPassword');

if (!token) {
  tagline.textContent = 'Este link no trae ningún token — pedí uno nuevo desde la pantalla de inicio de sesión.';
  formWrap.style.display = 'none';
}

async function submitReset() {
  const pw = newPassword.value;
  const pw2 = confirmPassword.value;
  if (pw.length < 8) { status.textContent = 'La contraseña necesita al menos 8 caracteres.'; return; }
  if (pw !== pw2) { status.textContent = 'Las dos contraseñas no coinciden.'; return; }

  submitBtn.disabled = true;
  status.textContent = 'Guardando...';
  try {
    const res = await fetch('/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: pw })
    });
    const data = await res.json();
    if (data.error) {
      status.textContent = 'Error: ' + data.error;
      submitBtn.disabled = false;
      return;
    }
    formWrap.style.display = 'none';
    tagline.textContent = 'Listo — ya podés iniciar sesión con tu contraseña nueva.';
    status.textContent = '';
  } catch (err) {
    status.textContent = 'No se pudo conectar con el servidor. Intentá de nuevo.';
    submitBtn.disabled = false;
  }
}

submitBtn.onclick = submitReset;
confirmPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitReset(); });
