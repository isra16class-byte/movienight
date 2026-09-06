// --- Envío de emails vía Resend (Fase 2bis del plan de producción — "Recuperación de contraseña") -
//
// Por qué existe este archivo: el flujo de "olvidé mi contraseña" necesita poder mandar un email con
// el link de reseteo, algo que el proyecto no necesitaba hasta ahora. Se eligió Resend (sobre
// Postmark/SES) por tener la API HTTP más simple de las tres (un solo POST con JSON, sin SMTP, sin
// SDK propio) — encaja con el criterio minimalista que ya usa el proyecto en otros lados (ver
// loadDotEnv() en server.js, o sessionStore.js en vez de connect-redis): alcanza con `fetch` (global
// en Node LTS, no hace falta sumar una dependencia nueva al package.json).
//
// Mismo criterio que Postgres (lib/db.js) para "feature opcional, no un escape hatch de producción":
// sin RESEND_API_KEY configurada, /auth/forgot-password queda deshabilitada (404 explícito) pero el
// resto de la app sigue funcionando igual — no hay fallback a "imprimir el link por consola" en
// producción real, porque filtrar el link de reseteo de cualquiera por los logs sería un problema de
// seguridad en sí mismo. En desarrollo local, si no hay API key configurada, igual se loguea el link
// por consola (ver sendPasswordResetEmail) para poder probar el flujo sin depender de una cuenta de
// Resend real — pensado solo para eso, igual que otros escape hatches del proyecto.

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// Remitente del email — Resend exige un dominio verificado en la cuenta para usar algo distinto del
// dominio de pruebas `onboarding@resend.dev` (que solo manda a la casilla con la que te registraste).
const EMAIL_FROM = process.env.EMAIL_FROM || 'MovieNight <onboarding@resend.dev>';

function isEnabled() {
  return !!RESEND_API_KEY;
}

// Envía el email de "olvidé mi contraseña" con el link de reseteo ya armado (ver
// buildResetUrl/APP_BASE_URL en server.js). No tira si Resend responde con error — el caller decide
// qué hacer (loguear y responder igual el mensaje genérico de "si el email existe, te mandamos un
// link", para no delatar por un timing distinto si el email en verdad existe o no).
async function sendPasswordResetEmail(to, resetUrl) {
  if (!isEnabled()) {
    // Solo desarrollo local sin RESEND_API_KEY configurada: se loguea el link en vez de mandarlo,
    // para poder probar el flujo completo sin necesitar una cuenta de Resend real.
    console.log('');
    console.log('📧 RESEND_API_KEY no configurada — no se mandó ningún email de verdad.');
    console.log(`   Link de reseteo para ${to}:`);
    console.log(`   ${resetUrl}`);
    console.log('');
    return { sent: false, devMode: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      subject: 'Recuperá tu contraseña de MovieNight',
      html: `
        <p>Pediste recuperar tu contraseña de MovieNight.</p>
        <p><a href="${resetUrl}">Hacé click acá para elegir una contraseña nueva</a> (el link vence en 1 hora).</p>
        <p>Si no fuiste vos, podés ignorar este email — tu contraseña sigue siendo la misma.</p>
      `
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend respondió ${res.status}: ${body.slice(0, 300)}`);
  }
  return { sent: true };
}

module.exports = { isEnabled, sendPasswordResetEmail };
