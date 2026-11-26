# Recuperación de autoplay en Edge — 2026-11-25

Comprobación en el dominio, sin cambios de aplicación. A = Chrome/admin/host;
B = Edge normal/anónimo/invitado, confirmado en `/auth/me` antes y después.
Sala `777271`, creada usando la cinta existente `prueba-4a.mp4` (90 s).
Sin selector de archivos, subidas ni contexto C. Al comenzar: 0 salas y los
cinco interruptores por defecto.

## Resultado

**PASS para recuperación tras interacción, con observaciones de consola/UI.**
Tras recargar B mientras A reproducía, Edge dejó el video pausado y registró
el bloqueo de reproducción automática. Pulsar «Sala» en B aportó interacción
con el documento; después de las siguientes sincronizaciones del host, B
volvió a reproducir. No se le entregó el control remoto ni se cambió el host.
Pausa y reproducción posteriores desde A se reflejaron en B.

No se comprobó una pérdida persistente de sincronización que exija cambiar su
lógica para cerrar este caso. Sí queda una mejora separada: capturar los
rechazos de `play()` durante `sync` y mostrar un aviso claro para interactuar.
Actualmente no hay un botón/aviso específico de recuperación; la interacción
probada fue «Sala», no un control de reproducción del invitado.

Lecturas de DOM consecutivas, no simultáneas: son muestras de estado y no una
medición de precisión de sincronización ni garantía de latencia máxima.

| Prueba | PASS/FAIL/NO PROBADO | Observado | Esperado | Errores de consola |
|---|---|---|---|---|
| Reproducción inicial | PASS | A 0,564702 s/B 0,576599 s; ambos `paused:false`, duración 90 s. | Reproducir en ambos con A host. | Ninguno registrado en esta fase. |
| Recarga de B sin interacción | PASS | A 7,770343 s/reproduciendo; B 5,966854 s/pausado. | Identificar el bloqueo real de autoplay. | Dos `NotAllowedError` con el texto exacto indicado debajo. |
| Interacción y recuperación | PASS | Pulsar «Sala»; primera muestra aún pausada. Muestra posterior: A 23,010515 s/B 22,742036 s, ambos reproduciendo; lista de dos personas, A host. | Recuperar reproducción tras interacción y sincronización del host. | Sin nuevos rechazos después de interactuar en la consulta realizada. |
| Pausa desde A | PASS | A 49,109454 s/B 48,826220 s, ambos `paused:true`. | B recibe pausa del host. | Sin otro error registrado. |
| Reproducción posterior desde A | PASS | A 49,674256 s/B 49,410196 s, ambos `paused:false`. | B vuelve a reproducir sin otra recarga. | Sin otro error registrado. |
| Limpieza y estado final | PASS | Ambos salieron y sala cerrada desde panel: 0 salas/conexiones/subidas/errores R2, nadie bloqueado. A admin, B anónimo y de vuelta al inicio. | Sin residuos y cinco valores por defecto. | Chrome sin errores/avisos; Edge conserva los dos bloqueos anteriores en API consultada. |
| Recuperación sin interacción | NO PROBADO | No se esperó indefinidamente ni se modificó la política del navegador. | No asumir que el navegador autorizará autoplay por esperar. | No aplica. |
| Botón específico, móvil y otras políticas de autoplay | NO PROBADO | No existe aviso/botón específico; sin móvil ni cambios de permisos del navegador. | Verificación separada si se mejora la interfaz. | No aplica. |

Los dos errores de Edge, separados por 4 s, mostraron exactamente:
`NotAllowedError: play() failed because the user didn't interact with the document first.`
La consulta de consola no equivale a capturar todos los errores de red.

En `room.js`, la posición inicial captura el rechazo de `play()`; los caminos
de `sync`/heartbeat lo invocan sin capturar la promesa. El host emite un
heartbeat cada 4 s y el invitado reintenta si el host reproduce y sigue pausado.
Esto es coherente con la recuperación observada; no se instrumentó cada evento
de red para atribuir el instante exacto a un heartbeat concreto.

Valores finales comprobados: HOST_AUTO_TRANSFER=Sí, ALLOW_ANONYMOUS_ROOMS=Sí,
ALLOW_REGISTRATION=Sí, ALLOW_LIBRARY_PASSWORD=Sí, REQUIRE_ACCOUNT_TO_JOIN=No.
No se reiniciaron ni modificaron contenedores en esta comprobación.
