# Avatares

Lista fija de iconos que las personas con cuenta pueden elegir. Hoy son **marcadores**
(`avatar-01` … `avatar-10`, formas simples dibujadas para esto); la idea es reemplazarlos por
iconos reales sin tocar código.

## Cómo reemplazar los marcadores

1. Copia los iconos nuevos a esta carpeta (`public/avatars/`).
2. Edita `avatars.json`: es un arreglo con una entrada por icono, en el orden en que se muestran:

   ```json
   { "id": "zorro", "name": "Zorro", "file": "zorro.png" }
   ```

   - `id`: letras minúsculas, números y guiones, de 2 a 32 caracteres. Único.
   - `name`: el nombre que ve la gente.
   - `file`: nombre del archivo en esta carpeta (sin `/` ni `..`). Debe existir.
   - `placeholder`: solo los marcadores llevan `"placeholder": true`. Quítalo en los iconos reales.
3. Borra los marcadores que ya no uses (archivo y entrada del manifiesto).
4. Corre la revisión: `npm run check:avatars`.
5. Reinicia el servidor: el manifiesto se lee al arrancar.

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
marcadores quedan sin reemplazar y sale con código distinto de 0 si hay errores.
