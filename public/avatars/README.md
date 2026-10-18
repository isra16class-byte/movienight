# Avatares

Lista fija de iconos que las personas con cuenta pueden elegir. El orden y los nombres salen de
`avatars.json`; el origen y la licencia de cada icono están en `CREDITS.md` (hoy todos figuran como
«NO INFORMADO», revisa ese archivo antes de publicar).

## Cómo agregar, quitar o reemplazar iconos

1. Copia los iconos nuevos a esta carpeta (`public/avatars/`), con el nombre de archivo igual al id.
2. Edita `avatars.json`: es un arreglo con una entrada por icono, en el orden en que se muestran:

   ```json
   { "id": "zorro", "name": "Zorro", "file": "zorro.png" }
   ```

   - `id`: letras minúsculas, números y guiones, de 2 a 32 caracteres. Único.
   - `name`: el nombre que ve la gente.
   - `file`: nombre del archivo en esta carpeta (sin `/` ni `..`). Debe existir.
   - `placeholder`: es opcional. Solo se usa para un icono provisional (`"placeholder": true`) y la
     revisión avisa mientras quede alguno. Los iconos reales no lo llevan.
3. Si quitas un icono, borra también su archivo y su entrada del manifiesto.
4. Agrega una fila por icono en `CREDITS.md` con autor o fuente, enlace y licencia. Lo que no conste se
   escribe «NO INFORMADO»; no se inventa.
5. Corre la revisión: `npm run check:avatars`.
6. Reinicia el servidor: el manifiesto se lee al arrancar.

Máximo 40 avatares. Si el manifiesto es inválido, el servidor arranca igual pero la lista queda
vacía y el error queda en el log.

## Los ids no se renombran

El `id` es lo que se guarda en la base de datos y lo que viaja en los eventos de la sala. Si
renombras un id, quien lo había elegido se queda sin avatar (no da error, simplemente deja de verse).
Puedes cambiar el `name` o reemplazar el archivo de un id sin problema: la URL lleva un hash del
contenido (`?v=...`), así que los navegadores y Cloudflare recogen el archivo nuevo.

## Formato recomendado

- **PNG o WebP cuadrado de 256x256, fondo transparente, 100 KB o menos**, o **SVG**.
- Límites que revisa el script: formatos png, webp y svg; 200 KB como máximo; PNG (y WebP, si se
  puede leer la cabecera) cuadrado y entre 128 y 1024 px.
- SVG: con `viewBox` (o `width` y `height`), sin `<script`, sin atributos `on*=`, sin
  `javascript:`, sin `<foreignObject` y sin referencias `http(s)` externas.

## Revisión

```
npm run check:avatars
```

Imprime una tabla con el formato, el tamaño y las dimensiones de cada icono, avisa cuántos
marcadores quedan sin reemplazar, avisa si `CREDITS.md` no existe o no menciona algún id del manifiesto,
y sale con código distinto de 0 si hay errores (los avisos no fallan la revisión).
