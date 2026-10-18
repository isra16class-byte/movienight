# Créditos de los avatares

Origen y licencia de cada icono de `public/avatars/`. **Cada id del manifiesto (`avatars.json`) debe
aparecer aquí**: `npm run check:avatars` avisa si falta alguno.

## ⚠️ Pendiente de aclarar

**Ningún icono tiene hoy autor, enlace ni licencia confirmados.** Todo lo que figura como
«NO INFORMADO» en la tabla es un dato que no consta; no se ha supuesto ni inventado nada.

- **Los 5 iconos**: autor o fuente, enlace y licencia o permiso de uso → **NO INFORMADO**.
  Los archivos originales llegaron con nombres del tipo `Gemini_Generated_Image_….jpg`, lo que sugiere
  que son imágenes generadas con una herramienta de IA, pero eso es solo una pista por el nombre del
  archivo: no está confirmado cómo se generaron ni qué términos de uso aplican a su uso en MovieNight.
- **`pajaro-rojo`**: el personaje se parece bastante a un personaje de marca conocido. Hay que revisar
  si hay algún problema de marca o derechos antes de publicar.
- Mientras esto no se aclare, no se debe presentar la lista de avatares como libre de derechos.

## Iconos

| id | Nombre | Autor o fuente | Enlace | Licencia o permiso |
|---|---|---|---|---|
| `koala-ninja` | Koala ninja | NO INFORMADO | NO INFORMADO | NO INFORMADO |
| `caballero` | Caballero | NO INFORMADO | NO INFORMADO | NO INFORMADO |
| `viajero` | Viajero | NO INFORMADO | NO INFORMADO | NO INFORMADO |
| `pajaro-rojo` | Pájaro rojo | NO INFORMADO | NO INFORMADO | NO INFORMADO |
| `trex` | T-rex | NO INFORMADO | NO INFORMADO | NO INFORMADO |

## Modificaciones hechas en este repo

Los originales eran JPEG de entre 992 y 1088 px. Para cumplir los límites de `check:avatars` (PNG,
cuadrado, 200 KB como máximo) se **recortaron a cuadrado** alrededor del personaje y se **redujeron a
256x256 px en PNG**. En `caballero` el recorte es un encuadre cerrado (casco, corona y capa) del original,
que era una escena más amplia. No se cambiaron colores ni se retocó el dibujo, y el fondo es el original
(no es transparente).
