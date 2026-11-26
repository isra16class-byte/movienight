# Auditoría de dependencias y propuesta — 2026-11-25

Base: `4ed44ad`. La propuesta actualiza únicamente `package-lock.json`;
`package.json`, código de aplicación, permisos, límites y configuración de IP
no cambian. No está integrada ni desplegada en esta etapa.

## Resultado de la auditoría

`npm audit --omit=dev --json` señala **5 paquetes de producción**: uno crítico,
dos altos y dos moderados. Esos cinco agrupan **9 avisos**, no cinco fallos
independientes demostrados. La auditoría completa señala **9 paquetes**:
uno crítico, tres altos y cinco moderados, incluyendo cadenas de dependencias
que heredan un aviso. Los cuatro nodos adicionales son de desarrollo.

Se leyeron las versiones de los ocho paquetes relevantes dentro de
`movienight-app-1`: coinciden con el lockfile anterior. Se comprobó que ESLint,
`@eslint/config-array`, `minimatch` y `brace-expansion` no están instalados en
el contenedor. No se imprimieron variables de entorno, secretos ni logs del
servidor. No se reiniciaron servicios ni se enviaron cargas maliciosas al dominio.

| Paquete / origen | Instalado → propuesto | Aviso y relevancia para MovieNight |
|---|---|---|
| body-parser / Express | 1.20.6 → 1.20.9 | Alta: error de descompresión con bytes sobrantes puede terminar el proceso. `express.json()` usa opciones por defecto y corre antes de autenticación; el flujo es relevante por configuración, sin explotación remota demostrada. [Aviso](https://github.com/advisories/GHSA-27r3-jxmh-p828). |
| engine.io / Socket.IO | 6.6.9 → 6.6.13 | Alta: una revisión EIO distinta u omitida durante upgrade puede provocar una caída. La app conserva upgrades por defecto; `allowEIO3: false` no descarta el caso. [Aviso](https://github.com/advisories/GHSA-2gc4-cqfq-p2gv). |
| proxy-addr / Express | 2.0.7 → 2.0.8 | Crítica según catálogo, pero el caso exige una subred IPv6 de confianza con prefijo corto. La app usa `trust proxy: true`, no esa subred; no se demuestra ese vector concreto. [Aviso](https://github.com/advisories/GHSA-jqcg-44mw-7w3h). |
| ip-address / express-rate-limit | 10.7.0 → 10.7.6 | Tres avisos moderados: comparación entre familias y coste de entradas inválidas. Los helpers revisados pasan antes por `net.isIPv6`; eso reduce la relevancia de ciertas entradas, sin demostrar inmunidad general. [Familias](https://github.com/advisories/GHSA-j6r3-76f7-8jcv), [diagnóstico](https://github.com/advisories/GHSA-h3mg-xc3c-68pw), [zona](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5). |
| qs / Express y body-parser | 6.15.3 → 6.16.2 | Tres avisos moderados relacionados con `comma`/serialización. No se encontraron opciones `comma` ni `qs.stringify` propios en la app. El parser `extended` por sí solo no demuestra esas condiciones. [Arrays](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx), [isBuffer](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g), [toString](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw). |
| ESLint y @eslint/config-array / desarrollo | 10.10.0 → 10.15.0; 0.23.5 → 0.23.6 | Arrastran `minimatch`. No están instalados en runtime; se mantienen dentro de los rangos directos declarados. |
| minimatch / desarrollo | 10.2.6 → 11.0.9 | Aviso moderado por amplificación de patrones. El salto mayor es transitivo y lo declara el ESLint actualizado, no un override impuesto a su versión anterior. [Aviso](https://github.com/advisories/GHSA-g3hv-75wg-m249). |
| brace-expansion / desarrollo | 5.0.9 → 5.1.0 | Avisos de CPU/recursión con patrones controlados. No está instalado en runtime. [CPU](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [anidación](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [coma](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p). |

La confianza en headers de proxy es una cuestión separada: la app prefiere
`cf-connecting-ip` y usa `trust proxy: true`. No se comprobó quién puede acceder
directamente al origen ni se cambió esa política. No se presenta la corrección
de `proxy-addr` como solución automática a una configuración de confianza amplia.

## Propuesta compatible y su preparación

Se copió únicamente el manifiesto/lockfile a una carpeta temporal. Un primer
`npm audit fix --package-lock-only --ignore-scripts --omit=dev`, sin `--force`,
resolvió los paquetes críticos/altos pero dejó dos nodos moderados relacionados
con `qs`/Express. No se aplicó esa salida parcial al proyecto.

En la copia temporal, `npm update express --package-lock-only --ignore-scripts`
resolvió producción a **0 avisos**. Express pasa **4.22.2 → 4.22.3** y su árbol
admite `qs` corregido. Después se actualizó ESLint dentro de su rango 10.x:
la auditoría completa también quedó en **0 avisos**. No se usaron `--force`,
overrides ni cambios de versión mayor de paquetes directos.

El resultado cambia 12 nodos: los de la tabla, Express y dos nodos nuevos
(`ws` 8.23.0 bajo Engine.IO y `@isaacs/nonrecursive-glob-match` 1.1.0 en
desarrollo). Se mantienen Socket.IO 4.8.3, express-rate-limit 8.7.0, los
paquetes de R2, las fuentes fijadas y el resto del código de aplicación.

## Validación y segunda revisión

- Se exportó el código de `origin/plan-produccion` a otra carpeta temporal y
  se aplicó allí el lockfile propuesto. Sin `.env`, cuentas ni servicios reales.
- Instalación limpia `npm ci --ignore-scripts` correcta; tests **223/223**, lint
  con ESLint actualizado y `fonts:build -- --check` correctos.
- Tras aplicar la propuesta a la rama de revisión, se repitieron la instalación
  limpia, los **223/223 tests**, lint y check de fuentes en el checkout de trabajo.
  El árbol local ya usa las versiones propuestas; el contenedor continúa con
  las anteriores hasta un despliegue posterior.
- La auditoría de producción y la completa devuelven **0 avisos** con el
  catálogo consultado. Esto no equivale a ausencia de vulnerabilidades desconocidas.
- Copilot CLI/Fusion hizo una segunda revisión del informe y fragmentos
  seleccionados, sin acceso a herramientas/archivos ni permisos de escritura.
  Coincidió en priorizar body-parser/Engine.IO y distinguir versión presente de
  explotación probada. No inspeccionó todo el repo ni ejecutó tests: las versiones,
  fuentes oficiales, árbol resultante y validación fueron comprobados por Codex.
- Las evidencias de auditoría, propuesta, salida de Copilot y tests quedan
  ignoradas en `acceptance-evidence/`; no se incluyen en Git.

Pendientes para aplicar: revisión del PR, comprobaciones HTTP/Socket.IO con el
árbol actualizado, despliegue solo de `app` y aceptación en navegador. No se ha
reproducido una caída real por estos avisos ni se probaron fallos contra R2/BD.

## Fuera de esta actualización

`multer@1.4.5-lts.2` sigue mostrando un aviso de deprecación. No es uno de los
cinco paquetes señalados en esta auditoría de producción. Migrar a 2.x requiere
revisar por separado la subida a disco, el storage R2 personalizado, cancelación,
límites y errores; no se mezcla ese cambio mayor con esta propuesta de lockfile.
Siguen pendientes las pruebas con archivos que la persona reservó para hacer a mano.
