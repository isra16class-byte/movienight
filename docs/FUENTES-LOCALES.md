# Fuentes locales — 2026-11-25

## Cambio

Las siete páginas conservan Monoton 400, VT323 400 y Space Grotesk 400/500/600/700,
pero cargan `/fonts/fonts.css` y WOFF2 del mismo origen. Se retiran los dos
preconnect y la hoja remota de Google Fonts. `style-src` y `font-src` de la CSP
quedan en `'self'`; los permisos de imágenes/R2 y las restricciones de scripts
no cambian. Los textos legales siguen siendo borradores, sin enlaces nuevos.

Los tres paquetes `@fontsource/*` están fijados en 5.3.0 como devDependencies.
`npm run fonts:build` exporta CSS, 17 WOFF2 (185.280 bytes en total) y las tres
licencias OFL. Se conservan todos los subconjuntos de esas caras y sus rangos
Unicode, `font-display: swap` y los binarios originales. Los nombres llevan
SHA-256 abreviado para evitar reutilizar una fuente anterior al actualizarla.
Los artefactos se versionan: `npm ci --omit=dev` y Docker no necesitan generar
fuentes ni servir `node_modules`. `npm run fonts:build -- --check` comprueba su
reproducción sin escribir y se añade al CI. Tolera LF/CRLF solo en textos.

## Service worker

La caché sube a `movienight-shell-v2`. Precarga fuentes/CSS, scripts de
inicio/biblioteca y el shell existente. Usa una lista cerrada de estáticos:
sesión/admin, salas, API, sockets, subidas y otros orígenes pasan a la red.
Solo guarda respuestas HTTP correctas, sin redirección; un 404/500 no sustituye
la copia válida y un fallo de caché no rompe una respuesta de red correcta.
Las escrituras se ligan a `waitUntil`. La nueva versión solo pide activarse
cuando termina la precarga, y al activar elimina únicamente cachés anteriores
con el prefijo de MovieNight, antes de reclamar los clientes.

## Verificado antes del despliegue

- Reproducción automática sobre el SW anterior: fallaban 5 de 6 casos iniciales;
  el control network-first/offline pasaba. Después pasan 7 tests que ejecutan el
  SW real con red y CacheStorage simulados. Suite completa **222/222**, lint,
  `fonts:build -- --check` y `git diff --check` correctos.
- HTTP real en loopback: siete HTML y CSP con fuentes locales; los 17 WOFF2
  responden 200 `font/woff2` y coinciden byte a byte con los artefactos.
  Express y configuración Helmet extraída de `server.js` reales; servidor
  estático temporal sin `.env`, BD, Redis, R2 o credenciales reales.
- Edge real en ese origen temporal: inicio comparado visualmente con la versión
  anterior; familias y estado `document.fonts` correctos. Al detener únicamente
  ese servidor y recargar, el shell, estilos y fuentes siguen disponibles.
  El modal de login abre y cancela, comprobando también el JS cacheado; no se
  intentó autenticar sin servidor. No es una prueba de sala/vídeo offline.
- El navegador expone comprobaciones DOM de fuentes, pero no el inventario de
  CacheStorage/controlador mediante su evaluación de solo lectura. El respaldo
  se comprobó por recarga con el origen temporal detenido; la lógica de borrado
  y errores se verificó con los tests, no inspeccionando cachés reales.

Pendientes en esta etapa: integrar/desplegar y comprobar el dominio con Chrome
y Edge, actualización desde un SW ya instalado, móvil e instalación PWA.

## Comprobación de la integración

El PR #14 incluyó los artefactos/HTML/SW, pero `server.js` quedó por error fuera
del staging. La CSP integrada conservaba los orígenes de Google aunque el árbol
de trabajo usado en la comprobación local ya los había retirado. Se completa
el cambio en el servidor y se añade una regresión que ejecuta Helmet real con
la configuración de `server.js`: estilos/fuentes solo locales, sin inline y
con los permisos R2 conservados. La cabecera de la imagen desplegada se
comprobó en el cierre siguiente; el cambio de CSP estrecha permisos.

## Cierre del despliegue y aceptación

PR #14 (fuentes/SW) y #15 (CSP/guardián) integrados. Código final desplegado:
`9d61e49ea29c118c4bb33fd6e62411a94dd3e9f4`. Hubo dos recreaciones de `app`,
ambas desde exportaciones limpias de Git, sin `.env`, videos locales ni
evidencias en las imágenes. Redis y Postgres conservaron sus IDs, inicio y
contadores de reinicios en ambos despliegues. Salud interna y pública 200 con
Redis/Postgres/R2 habilitados y sanos. Los paquetes Fontsource no están
instalados en runtime; sus artefactos públicos sí están incluidos.

Se compararon con el commit 27 archivos de runtime: servidor, siete HTML,
SW, CSS de fuentes y 17 WOFF2. Textos por SHA-256 normalizando LF/CRLF y
binarios sin normalizar. Todos coinciden. Suite final **223/223**, lint,
check reproducible de fuentes y `git diff --check` correctos antes del commit
de la corrección de CSP.

| Prueba | Resultado | Observado / esperado | Errores de consola |
|---|---|---|---|
| HTTP del dominio: siete páginas | PASS | 200; CSS local, sin referencias Google; cabecera real con `style-src 'self'` y `font-src 'self'` | No corresponde: HTTP |
| HTTP del dominio: 17 WOFF2/CSS/SW | PASS | WOFF2 200 `font/woff2`, bytes iguales al commit; CSS y SW 200 `no-store`; SW servido contiene v2 | No corresponde: HTTP |
| Inicio en Edge | PASS | Aspecto comparado antes/después; las tres familias cargadas, CSS solo del mismo origen | Ninguno registrado por la API consultada |
| Admin y biblioteca en Chrome | PASS | Sesión admin conservada, familias cargadas y biblioteca lista sus cintas existentes | Ninguno registrado |
| Sala en Chrome/Edge | PASS | Sala `4a9673` desde `metrics-test.mp4` existente, dos participantes y A host; nombre «Fuentes B Ñ» visible y fuentes de cuerpo/OSD cargadas | Ninguno registrado |
| Respaldo con servidor temporal detenido | PASS local | Edge recarga shell, fuentes y estilos; abre/cancela modal mediante JS cacheado. No se detuvo el dominio real | Sin errores en la consulta anterior al corte; no consultada después |
| Inspección directa de versión activa/migración del SW del dominio | NO PROBADO | El protocolo interno de Edge está bloqueado por la política del control del navegador; el evaluador DOM tampoco expone CacheStorage/controlador. No se usaron vías alternativas | No corresponde |
| Limpieza y configuración | PASS | Sala cerrada desde el panel; 0 salas/conexiones/subidas, cinco valores por defecto; B anónimo confirmado al inicio/final con `/auth/me` | Ninguno registrado en las consultas |
| Móvil, instalación PWA y archivo real | NO PROBADO | Pendientes manuales; no se eligieron archivos ni se usó contexto C | No corresponde |

Los errores HTTP, escrituras fallidas, activación incompleta y limpieza de
versiones se verificaron con los tests del SW; no se provocaron fallos del
dominio. La inspección manual opcional de la versión activa puede hacerse en
las herramientas de desarrollo de Edge, Aplicación → Service Workers. No se
afirma haber inspeccionado su CacheStorage ni una migración v1→v2 en vivo.

Estado final: A en `/admin.html` con admin y B en el inicio sin sesión.
`HOST_AUTO_TRANSFER=Sí`, `ALLOW_ANONYMOUS_ROOMS=Sí`, `ALLOW_REGISTRATION=Sí`,
`ALLOW_LIBRARY_PASSWORD=Sí`, `REQUIRE_ACCOUNT_TO_JOIN=No`. Sin videos borrados,
archivos seleccionados/subidos, cambios de credenciales ni de la CSP del beacon.

## Referencias

- [Instalación de Fontsource](https://fontsource.org/docs/getting-started/install).
- [Cache.addAll](https://developer.mozilla.org/en-US/docs/Web/API/Cache/addAll).
- [ExtendableEvent.waitUntil](https://developer.mozilla.org/en-US/docs/Web/API/ExtendableEvent/waitUntil).
