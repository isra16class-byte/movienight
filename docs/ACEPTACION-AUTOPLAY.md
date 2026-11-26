# Recuperación y aviso de autoplay en Edge — 2026-11-25

## Ajuste de posición al reanudar — 2026-11-26

La primera aceptación del aviso desplegado (`0ca4b3e`, sala `5266da`) detectó
un desfase inicial: muestra consecutiva A 19,642553 s/B 16,448045 s, ambos
reproduciendo tras pulsar el botón. El aviso y la pausa del host funcionaron,
pero la corrección suave habitual tardaba en recuperar unos 3 s. La sala se
cerró desde el panel antes de preparar el ajuste, conservando valores por defecto.

Ahora el reintento del invitado usa la última posición/pausa recibida del host
y el tiempo transcurrido en un reloj monotónico. El primer heartbeat después de
confirmar reproducción ajusta una vez la estimación; después se conserva la
corrección de deriva habitual. El tiempo queda limitado al final del video,
sin cambiar el reloj ni las emisiones del host. Pausa, fin o nueva cinta
invalidan la recuperación pendiente.

Una regresión nueva fallaba antes (30 frente a 32,5 s esperados). Después pasan
las quince regresiones de recuperación y la suite **246/246**, lint y sintaxis.
Copilot revisó el diff seleccionado sin herramientas y no encontró bloqueos;
no ejecutó ni verificó independientemente las pruebas. Falta desplegar este
ajuste y repetir la aceptación del dominio. La estimación no elimina la latencia
de red ni promete coincidencia exacta al milisegundo.

## Mejora preparada, pendiente de despliegue

Después de la prueba del dominio descrita debajo, se añadió un aviso centrado
con botón accesible «▶ Reanudar video». El mensaje pide interactuar cuando el
navegador bloquea autoplay; el botón invoca `play()` dentro del gesto real,
sin emitir controles ni cambiar el rol del invitado. Una reproducción exitosa
oculta el aviso; la pausa del host, fin de video o cambio de cinta lo limpian.

Todos los caminos de `play()` del cliente usan la misma captura. Tras un rechazo
no se repiten intentos por heartbeat hasta el gesto; se conserva el último estado
de reproducción recibido. Se evitan intentos simultáneos y se invalidan promesas
anteriores con pausa/cambio de cinta. También se cancelan los listeners antiguos
de metadatos: una cinta/posición u orden más reciente gana al estado inicial;
seek conserva el estado y actualiza el tiempo pendiente. `AbortError` no genera un aviso falso; otros
fallos muestran texto fijo de reintento sin detalles recibidos.

**Verificado localmente:** trece regresiones de código real con DOM/media/sockets
simulados; suite 244/244, lint, fuentes y sintaxis de `room.js` correctos. Incluyen bloqueo,
reintento, pausa, promesas tardías, estado inicial, nueva cinta, fin y controles
del host, dos fuentes antes de metadatos y órdenes recibidas antes de cargar.
Esto no equivale a un navegador ni a servicios externos reales. Copilot revisó
diff/tests seleccionados sin herramientas; su observación sobre metadatos viejos
se resolvió y cubrió. El play del host bloqueado conserva su semántica anterior:
reintenta según `player.paused`, sin convertirse en otra orden de pausa remota.
Revisión final sin bloqueos en los fragmentos seleccionados.

**Navegadores reales, servidor temporal local:** HTML/CSS/JS del cliente actual,
Socket.IO real con backend de prueba simulado y video sintético generado de 120 s.
Sin `.env`, cuentas, Redis/Postgres/R2 ni archivos de usuario. No se subió nada.

| Prueba de la mejora local | PASS/FAIL/NO PROBADO | Observado | Esperado | Errores de consola |
|---|---|---|---|---|
| Edge recargado mientras Chrome reproduce | PASS | Edge pausado; aviso y botón visibles, centrados y legibles. | Explicar cómo habilitar reproducción. | Ninguno registrado en API consultada. |
| Botón Reanudar | PASS | Video reproduce y aviso se oculta; Chrome sigue host. | Reintento local dentro de la interacción. | Ninguno registrado. |
| Host pausa con Edge bloqueado | PASS | Aviso desaparece y Edge permanece pausado. | Respetar el estado más reciente del host. | Ninguno registrado. |
| Nuevo play del host y reintento | PASS | Aviso aparece de nuevo y botón vuelve a reanudar. | Recuperación reutilizable. | Ninguno registrado. |
| Versión final tras ajustar metadatos | PASS | Edge contra un segundo fixture local con estado de host simulado: recarga muestra aviso, botón reanuda y lo oculta, `paused:false`. 0 sync del invitado y proceso/pestaña propios cerrados. | Verificar el flujo con el último código. | Ninguno registrado. |
| Autoridad y limpieza | PASS | Backend del fixture registró 0 eventos sync del invitado. Dos pestañas de QA cerradas y servidor detenido por PID. | Sin nuevos controles del invitado ni procesos residuales propios. | Chrome/Edge sin errores/avisos registrados. |
| Dominio al finalizar QA local | PASS | A admin; B anónimo en `/auth/me`; panel 0 salas/conexiones/subidas/errores R2 y cinco valores por defecto. | Conservar el entorno compartido. | No se probó la mejora en el dominio. |
| Mejora desplegada y móvil/fullscreen | NO PROBADO | Cambio aún en revisión, sin reiniciar app. | Aceptación posterior al despliegue. | No aplica. |

La interfaz nueva se comprobó localmente; la sincronización con el servidor real
del dominio sigue pendiente. La recuperación conserva los ajustes de deriva
existentes y no promete sincronización inmediata al milisegundo.

## Prueba previa en el dominio, antes del aviso

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
