# Presencia, reconexión y espectadores fantasma — 2026-11-25

Se reprodujeron fallos de registro de entrada y de avisos de presencia con el servidor y Socket.IO reales, en loopback. También se reprodujeron con `server.js` anterior a los cinco interruptores. Se preparó un arreglo y se repitieron las mismas secuencias correctamente. Pendientes revisión del PR, despliegue y navegador real.

## Reproducciones y resultado del arreglo

| Caso | Antes | Después | Comprobación |
|---|---|---|---|
| Dos `join-room` del mismo socket | 1 socket, 2 espectadores contados y 2 avisos «se unió»; tras desconectar, 0 sockets pero contador 1 | 1 registro/aviso; al salir, contador 0 | Socket.IO real local y test del handler |
| Desconectar mientras espera la entrada | Al liberar la lectura de avatar pendiente, se registra 1 espectador/nombre sin socket | No se registra espectador, nombre ni host | Socket.IO real local con lectura retenida de forma controlada y test del handler |
| Reconexión solapada: entra el socket nuevo antes de salir el viejo, mismo `userId` | 2 avisos de entrada; 15 s después de cerrar el viejo anuncia una salida aunque el nuevo sigue dentro | 1 aviso; mientras quede un socket de esa identidad, no anuncia salida | Socket.IO real local con espera real de 15,3 s y test con reloj controlado |
| Reconexión ordenada dentro de la gracia | 1 aviso, sin falsa salida | Se conserva el resultado | Control positivo con Socket.IO real y test |
| Pedir otra sala con el mismo socket sin desconectarse | Permanece en las dos; al desconectar, la primera queda con contador/nombre 1 y 0 sockets | Se rechaza la segunda entrada; al desconectar, ambas quedan en 0 | Socket.IO real local y test |
| Dos entradas concurrentes del mismo socket | Se pueden registrar dos admisiones al completar la validación | Solo una admisión | Test de handlers reales y validación retenida |
| Sala cerrada/reemplazada durante la entrada | Puede mutarse la sala anterior tras completar la validación | Se rechaza la entrada pendiente con «La sala no existe.» | Test de handlers reales |
| Timer de salida de una sala cerrada | Puede intentar guardarla después de cerrada | No llama a guardar la sala cerrada | Test con persistencia simulada; no prueba Redis real |
| Callback viejo de salida ya encolado | Puede consumir la gracia de una salida posterior | Se valida la identidad de la salida pendiente | Test con reloj controlado |
| Entrada repetida después de ceder el control | Puede volver a asignar host | Conserva el control que ya tiene el otro socket | Test con reglas de host reales |

En las reproducciones locales se usó un servidor compilado en un directorio temporal: sin leer `.env`, con Redis/R2 deshabilitados, BD/correo simulados y puerto efímero ligado únicamente a `127.0.0.1`. Las salas y clientes eran sintéticos; no se tocaron el dominio de pruebas, sus salas, contenedores o ajustes. La espera del avatar fue instrumentación del diagnóstico, no una interrupción de una BD real. Los resultados locales quedan en las evidencias ignoradas.

## Antigüedad

`git blame` y `git log` muestran:

- `52e268e`, 2026-08-15: incremento del contador y asignación de `currentRoom` sin protección contra admisiones repetidas.
- `82603af`, 2026-08-18: avisos y margen de reconexión basados en `recentDisconnects`; solo contemplan que la desconexión ocurra antes de la nueva entrada.
- `6506db4`, 2026-09-05: validación asíncrona de contraseña en `join-room`.
- `fc1d27c`, 2026-10-18: espera asíncrona del avatar antes de registrar presencia.
- `35bc9d1`, 2026-10-27: primer interruptor. Las reproducciones anteriores se repitieron con el `server.js` de su padre `dc13a97119bca79569138ac77e97ee9bc6e9c1ed`, conservando el entorno y dependencias actuales del diagnóstico. No fue un despliegue histórico completo.

Los defectos reproducidos son anteriores a los interruptores. Esto no demuestra qué secuencia exacta causó cada reporte original de una persona: no había una traza de esos incidentes.

## Arreglo preparado

Después de las esperas de validación se comprueba que el socket siga conectado, la sala siga siendo el mismo objeto y la conexión no haya sido admitida ya. Una entrada repetida a la misma sala devuelve sus datos sin volver a contar, anunciar ni asignar host. El contador deriva del registro de sockets admitidos.

Cada conexión queda ligada a una sola sala; para cambiar de sala se debe desconectar primero, como hace la web al navegar. Una petición de otra sala con el mismo socket se rechaza con «Salí de la sala actual antes de entrar en otra.». Este límite del protocolo queda explícito; no se probó todavía la app móvil con él.

Los avisos siguen usando la identidad estable `userId` que ya usa el sistema. Las pestañas/sockets continúan contando por separado y permanecen en la lista; se evita repetir el aviso si esa identidad ya está presente. Solo se programa salida cuando se va su último socket. El margen sigue siendo 15 segundos; se comprueba que el callback corresponda a la salida vigente y que la sala siga existiendo antes de emitir o guardar. El silencio se conserva mientras la identidad siga presente.

Se mantienen los chequeos de cuenta/contraseña y las reglas de propietario/host. Los tests de contraseña ahora representan conexiones nuevas por intento, conservando sesión y limitador compartidos, en vez de reutilizar artificialmente una conexión admitida para entrar después a otra sala/IP. Sus aserciones de seguridad se conservan.

## Verificación y límites

- Antes del arreglo: 8 de las 9 regresiones iniciales fallaban; la reconexión ordenada pasaba.
- Después: 10 regresiones de presencia correctas, suite completa **215/215**, lint y `git diff --check` correctos. Los handlers, el helper de presencia y las reglas de host/acceso son reales; transporte/avatar/reloj/persistencia son dobles en los tests.
- El diagnóstico adicional repitió las secuencias con HTTP/Socket.IO reales y la espera real de gracia, con los resultados de la tabla.
- No verificados: navegador real, app móvil, Redis/R2/Postgres reales, red remota inestable ni adaptador distribuido. No se ha desplegado este arreglo. Se reprodujeron contador y registros internos fantasma; no se afirma haber reproducido una fila visual fantasma en un navegador/móvil.
