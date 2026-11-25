# Diagnóstico de los 6 errores R2 — 2026-11-25

**Resultado:** no se reprodujo un fallo actual de acceso a R2. La evidencia disponible apunta a problemas transitorios de conexión y DNS poco después del arranque. No permite reconstruir la causa individual de los seis eventos ni garantizar que no vuelvan a ocurrir.

Se revisó el contenedor real de la app con operaciones de lectura. No se reinició ningún servicio ni se cambiaron credenciales, red, timeouts, aplicación o datos del bucket. No se eligieron/subieron archivos. Los nombres del bucket, endpoints privados, direcciones y secretos se excluyeron de las salidas registradas.

## Evidencia histórica confirmada

- Inicio de `app`: `2026-11-25T20:49:50.061Z` (15:49:50 en Ecuador).
- Aviso de arranque: `2026-11-25T20:49:54.638Z`, `AggregateError` / `ETIMEDOUT`. El SDK informó 3 intentos y 152 ms de demora de reintentos. El error final agrupó dos conexiones IPv4 agotadas y dos rutas IPv6 inaccesibles (`ENETUNREACH`), todas hacia TCP/443.
- Último error conservado por las métricas: `2026-11-25T20:51:07.523Z`, `getaddrinfo ENOTFOUND` para el endpoint del bucket (nombre redactado).
- Muestra final: `2026-11-25T21:21:34.506Z` (16:21:34 en Ecuador), contador todavía en **6**, con **30,45 minutos desde el último error**. Salas activas, conexiones y subidas: 0.
- `/health` devolvió **200**, con Redis, Postgres y R2 habilitados y sanos.

## Comprobaciones actuales

| Comprobación | Resultado | Medida |
|---|---|---|
| `HeadBucket` autenticado, SDK real | 5/5 correctas | 316, 467, 432, 1252 y 250 ms |
| DNS del endpoint general y del bucket | 6/6 correctas | 4–32 ms; devolvieron IPv4 e IPv6 |
| TLS con selección automática | 4/4 correctas | 26–44 ms, conexión IPv4, certificado verificado |
| TLS forzado a IPv4, solo en el diagnóstico | 4/4 correctas | 27–29 ms, certificado verificado |
| TLS forzado a IPv6, solo en el diagnóstico | Fallo reproducido | `ENETUNREACH`, 9 ms |

Las comprobaciones de red y `HeadBucket` se ejecutaron en procesos auxiliares dentro del mismo contenedor. No modificaron el cliente R2 del proceso de la app. El contador de la app se leyó mediante `/metrics` con su token desde el entorno, sin mostrarlo.

Node real: **v22.23.5**, selección automática activada y espera por candidato de **250 ms**. La [documentación oficial de Node 22](https://nodejs.org/docs/latest-v22.x/api/net.html#socketconnectoptions-connectlistener) explica que esa selección alterna familias y devuelve un `AggregateError` si todos los candidatos fallan. El IPv6 inaccesible está confirmado; no explica por sí solo los timeouts IPv4 ni el fallo DNS histórico. La selección automática funcionó en las cuatro muestras actuales.

## Qué significa el contador

`lib/r2.js` registra el error de una operación cuando el SDK termina rechazándola; `testConnection()` también pasa por ese contador, por lo que las comprobaciones de salud y arranque pueden incrementarlo. No representa exclusivamente reproducciones o subidas fallidas. Los reintentos internos de una llamada del SDK no se cuentan individualmente por el wrapper.

`lib/metrics.js` conserva un contador acumulado en memoria y **solo el último error**, no una lista con los seis. Recuperarse no pone el contador en cero. El mensaje de arranque sugiere revisar las credenciales, pero el error concreto fue de red y las cinco operaciones autenticadas actuales funcionaron; no hay evidencia aquí de una configuración de acceso permanentemente inválida.

## Conclusión y límites

No se encontró un fallo persistente que justifique un cambio de configuración con esta muestra. Tampoco se alteraron la selección de red ni los reintentos de la app. Si el contador vuelve a aumentar, conviene capturar la operación, el código y la hora de cada fallo con redacción de secretos: el contador actual no permite atribuir retrospectivamente los seis eventos. La capa responsable del fallo DNS no quedó determinada.

No se probaron escrituras, borrados, subidas, reproducción prolongada, arranque en frío nuevo ni una interrupción de red controlada. No se reinició para intentar reproducir el incidente. Esta observación de unos 30 minutos sin errores nuevos no demuestra disponibilidad futura ni equivale a una prueba de carga.
