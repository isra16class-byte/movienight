# Errores de lectura JSON — aceptación 2026-11-25

PR #18, código probado y desplegado `58bffce`. El callback de `express.json()`
separa sus errores del manejador de subidas, con respuestas JSON de texto fijo.
No cambia opciones del parser, límite de 100 KB, autenticación o limitadores.
El manejador no adjunta el cuerpo ni los mensajes/headers recibidos a sus
respuestas o diagnósticos. Un fallo interno se registra/reporta con un error
nuevo y genérico; si ya se enviaron headers, delega un error saneado y el
manejador de subidas evita intentar una segunda respuesta.

## Reproducción y validación local

Cinco de las siete regresiones iniciales fallaban por responder 502; JSON válido
y errores de subida pasaban. Tras el arreglo pasan ocho regresiones HTTP con
Express/Multer reales y los bloques reales del servidor. Incluyen JSON/gzip
inválido, límite plano/comprimido, charset/compresión, flujo válido/no JSON,
fallo interno, headers enviados y conservación de errores de subida.

Sin `.env` ni BD/R2 reales; el fixture usa rutas de prueba y errores sintéticos
de Multer/validación/storage, sin leer/subir archivos. La función real de reporte
se ejecuta con Sentry simulado: no equivale a verificar su SDK/integraciones
externas. Copilot revisó diff/tests seleccionados sin herramientas ni acceso a
archivos; su observación sobre headers enviados se resolvió y cubrió con una
regresión. Revisión final sin bloqueos concretos. Suite **231/231**, lint,
check de fuentes y diff correctos.

## Despliegue y aceptación

Imagen construida desde exportación limpia de `58bffce`; una sola recreación
de `app` con `up -d --no-deps app`. Redis/Postgres conservaron IDs, imágenes,
fechas de inicio y contadores de reinicio. App `healthy`, sin reinicios
adicionales durante la aceptación. `server.js`, `package.json` y lockfile
coinciden por SHA-256 con el commit. Imagen previa conservada como
`movienight-app:before-json-58bffce`. El cierre posterior solo añade documentación.

Las peticiones de API se hicieron con datos sintéticos, sin cookies ni
contraseñas reales, tanto dentro del contenedor como por HTTPS en el dominio.
No se provocaron fallos internos ni errores de storage en servicios reales.
Los pasos de navegador usaron A = Chrome/admin y B = Edge normal/anónimo.

| Prueba | PASS/FAIL/NO PROBADO | Observado | Esperado | Errores de consola |
|---|---|---|---|---|
| API: JSON inválido | PASS | Interno y dominio: 400, «El cuerpo JSON de la solicitud no es válido.». | Error de cliente, sin texto de subida. | No aplica: cliente HTTP. |
| API: gzip truncado | PASS | Interno y dominio: mismo 400 y mensaje anterior. | Error de cliente sin caída. | No aplica: cliente HTTP. |
| API: exceso de tamaño | PASS | Interno y dominio: 413, «El cuerpo JSON supera el tamaño permitido.». | Mantener límite y clasificar tamaño. | No aplica: cliente HTTP. |
| API: charset no soportado | PASS | Interno y dominio: 415, «La codificación del cuerpo JSON no está soportada.». | No reflejar el header recibido. | No aplica: cliente HTTP. |
| API: compresión no soportada | PASS | Interno y dominio: mismo 415 y mensaje anterior. | Error de codificación, sin texto de subida. | No aplica: cliente HTTP. |
| API: gzip válido sin credenciales | PASS | Interno y dominio: 400, «Faltan email y/o contraseña.». | Llegar a la validación normal del login sin intentar autenticar. | No aplica: cliente HTTP. |
| API y salud tras los errores | PASS | Interno y dominio: `/api/access-policy` y `/health` 200. | Servidor disponible. | No aplica: cliente HTTP. |
| Sesión admin y biblioteca | PASS | Tras recrear app, A abrió admin y listó las cinco cintas. | Conservar sesión y acceso. | Sin errores/avisos nuevos en API consultada. |
| Login inválido en navegador | PASS | Un intento ficticio en B: «No se pudo iniciar sesión» y «Email o contraseña incorrectos. ¿Olvidaste tu contraseña?». Se canceló. | Aviso normal, sin falso error de conexión. | Sin errores/avisos nuevos en API consultada. |
| Estado final de B | PASS | `/auth/me` confirmó `{"loggedIn":false}` antes/después del intento; volvió al inicio. | Seguir anónimo. | Sin errores/avisos nuevos en API consultada. |
| Panel final | PASS | 0 salas/conexiones/subidas/errores R2; nadie bloqueado; HOST_AUTO_TRANSFER/ALLOW_ANONYMOUS_ROOMS/ALLOW_REGISTRATION/ALLOW_LIBRARY_PASSWORD en Sí, REQUIRE_ACCOUNT_TO_JOIN en No. | Valores por defecto y sin residuos. | Sin errores/avisos nuevos en API consultada. |
| Fallo interno y headers enviados en dominio | NO PROBADO | Solo cubiertos por regresiones HTTP locales. | No provocar artificialmente fallos internos en el servidor compartido. | No aplica. |
| Subida real de archivos | NO PROBADO | Sin selector de archivos ni contexto C; no se crearon salas. | Pruebas manuales reservadas para la persona. | No aplica. |

La consulta de consola cubre errores/avisos capturados desde este despliegue,
no todos los errores de red ni el histórico. Evidencias locales ignoradas en
`acceptance-evidence/`, fuera de Git.
