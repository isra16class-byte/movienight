# Fuentes de MovieNight

Artefactos locales exportados sin modificar los WOFF2 de Fontsource 5.3.0:

- `@fontsource/monoton`: normal 400, latin y latin-ext.
- `@fontsource/space-grotesk`: normal 400/500/600/700, latin, latin-ext y vietnamese.
- `@fontsource/vt323`: normal 400, latin, latin-ext y vietnamese.

Cada familia conserva su licencia SIL Open Font License 1.1 en `LICENSE-*.txt`.
El CSS conserva los rangos Unicode y `font-display: swap`; cada archivo WOFF2
lleva un hash de contenido en el nombre. No se contacta un CDN desde el navegador.

Para regenerar: `npm ci` y `npm run fonts:build`. Para comprobar sin escribir:
`npm run fonts:build -- --check`. Los tres paquetes son devDependencies fijadas;
el servidor y la imagen de producción sirven estos archivos ya versionados.
No necesitan paquetes de fuentes en runtime ni un nuevo paso de build Docker.

Al actualizar los paquetes, revisá los artefactos y licencias, regenerá la lista
de fuentes en `sw.js` y aumentá su versión de caché. Los binarios antiguos que ya
no se referencien se pueden retirar en ese mismo cambio.

Documentación: https://fontsource.org/docs/getting-started/install
