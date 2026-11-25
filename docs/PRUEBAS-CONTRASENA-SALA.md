# Aceptación de contraseña de sala — 2026-11-25

Dominio de pruebas: `https://sala.movienight-palomitasjuntos.uk/`. A = Chrome admin; B = Edge normal anónimo, confirmado en `/auth/me` al principio y al final. Sin InPrivate, terceros ni elección/subida de archivos. Cinco interruptores por defecto durante toda la prueba.

PR #6 integrado y desplegado. La primera comprobación real detectó un fallo pendiente: `mnPrompt` descartaba `message`. Se corrigió el helper y se repitieron las pruebas de esta tabla con la versión corregida. La regresión automática ahora ejecuta listener y helper reales.

Preparación: la biblioteca no permite fijar contraseña al reutilizar una cinta. Se prepararon por API dos salas protegidas desechables (`0cce87` y `23bea2`) usando una cinta ya existente. Claves aleatorias en memoria, sin registrarlas. El acceso y los reintentos se hicieron desde la interfaz de Edge.

| Prueba | Resultado | Observado | Esperado | Errores de consola |
|---|---|---|---|---|
| Cinco envíos vacíos | PASS | Cada envío muestra «Contraseña de sala requerida. Te quedan 3 intento(s).» | Conservar los 3 intentos y rechazar la entrada vacía | Ninguno reportado |
| Correcta tras los vacíos | PASS | Entra; contador de personas = 1 | Permitir entrar sin bloqueo | Ninguno reportado |
| Primer fallo real | PASS | «Contraseña incorrecta. Te quedan 2 intento(s).» | Mostrar 2 restantes | Ninguno reportado |
| Vacío entre fallos | PASS | «Contraseña de sala requerida. Te quedan 2 intento(s).» | No gastar ni reiniciar el contador | Ninguno reportado |
| Segundo fallo real | PASS | «Contraseña incorrecta. Te quedan 1 intento(s).» | Mostrar 1 restante | Ninguno reportado |
| Tercer fallo real | PASS | «Contraseña incorrecta. Se bloquearon los intentos por 15 minutos.»; diálogo sin campo, solo OK; vuelve al inicio | Bloquear 15 minutos y dejar de pedir contraseña | Ninguno reportado |
| Correcta durante bloqueo | PASS | «Demasiados intentos fallidos. Esperá 15 min y volvé a intentar.» | Rechazar incluso la correcta mientras dure el bloqueo | Ninguno reportado |
| Aislamiento por sala | PASS | Con la misma IP, la correcta permite volver a entrar a la primera sala | El bloqueo de una sala no bloquea otra | Ninguno reportado |
| Limpieza y ajustes | PASS | Salas protegidas cerradas desde el panel; 0 salas, 0 conexiones, 0 subidas; A admin y B anónimo | Cerrar todas las salas de prueba y conservar los cinco valores por defecto | Ninguno reportado en A/B |
| Vencimiento real | NO PROBADO | No se esperaron 15 minutos en el navegador; test con reloj controlado sí pasa | Volver a permitir intentos tras vencer | No aplica |

La sala preliminar sin contraseña `f77e18` también se cerró desde el panel. Valores finales: `HOST_AUTO_TRANSFER=Sí`, `ALLOW_ANONYMOUS_ROOMS=Sí`, `ALLOW_REGISTRATION=Sí`, `ALLOW_LIBRARY_PASSWORD=Sí`, `REQUIRE_ACCOUNT_TO_JOIN=No`.

Despliegue: únicamente `app`; Redis/Postgres mantienen IDs, fecha de inicio y contador de reinicios originales. SHA-256 del servidor y cliente desplegados coincide con el código probado. Suite Windows **200/200**, lint y sintaxis correctos. Los tests VM y el diagnóstico local de Socket.IO se distinguen de esta aceptación real.

Observación aparte: el panel muestra 6 errores R2 acumulados. Los logs registran un timeout `ETIMEDOUT` al probar R2 en el arranque; la salud final devuelve 200 con Redis/Postgres/R2 sanos. No se diagnosticó la causa individual de los seis eventos ni se cambió la configuración. No se probaron concurrencia ni app móvil.
