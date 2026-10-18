#!/usr/bin/env python3
"""Prepara una imagen para usarla como avatar: recorta a cuadrado, escala y guarda un PNG.

Uso (desde la raíz del repo; en Windows puedes usar `py` en vez de `python`):

    python scripts/prepare-avatar.py RUTA_IMAGEN ID [opciones]

Ejemplos:

    python scripts/prepare-avatar.py "C:\\fotos\\zorro.jpg" zorro
    python scripts/prepare-avatar.py zorro.jpg zorro --box 120,40,1100,1020 --size 256
    python scripts/prepare-avatar.py zorro.jpg zorro --add --name "Zorro" --author "Ana" \\
        --link https://ejemplo.com/zorro --license "CC BY 4.0"

Qué hace:
  1. Abre la imagen (JPG, PNG, WebP...) y respeta la orientación de las fotos de celular.
  2. Recorta a cuadrado: la zona de --box (izquierda,arriba,derecha,abajo, en píxeles de la
     imagen original; debe ser cuadrada) o, sin --box, el cuadrado central del lado menor.
  3. Escala a --size x --size (por defecto 256; entre 128 y 1024) y guarda public/avatars/ID.png.
  4. Si pesa más de 200 KB, reduce los colores a una paleta (y lo avisa). Si aun así no cabe, falla
     y te dice que uses un --size menor. No toca nada más.
  5. Valida el resultado con el mismo código del servidor (lib/avatars.js) si `node` está instalado.

Con --add (y --name) además agrega el icono al final de public/avatars/avatars.json y una fila a
public/avatars/CREDITS.md. Lo que no pases con --author, --link o --license queda como «NO INFORMADO»:
no se inventa ningún origen ni licencia.

Requisitos: Python 3 (probado con 3.12) y Pillow (`pip install pillow`). No usa nada de npm ni cambia package.json.
Si ID.png ya existe, falla salvo que pases --force (reemplazar la imagen de un id no cambia su id).
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover - depende del equipo
    sys.exit("Falta Pillow. Instálalo con:  pip install pillow")

ID_PATTERN = re.compile(r"^[a-z0-9-]{2,32}$")  # el mismo que ID_PATTERN en lib/avatars.js
MIN_SIZE, MAX_SIZE = 128, 1024  # límites de dimensión que revisa check-avatars
MAX_BYTES = 200 * 1024  # peso máximo que revisa check-avatars
MAX_AVATARS = 40
NO_INFO = "NO INFORMADO"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AVATARS_DIR = os.path.join(REPO_ROOT, "public", "avatars")
MANIFEST = os.path.join(AVATARS_DIR, "avatars.json")
CREDITS = os.path.join(AVATARS_DIR, "CREDITS.md")


class Fallo(Exception):
    """Error pensado para mostrarse tal cual, sin traza."""


def parse_box(text):
    try:
        parts = [int(p) for p in text.split(",")]
    except ValueError:
        parts = []
    if len(parts) != 4:
        raise Fallo('--box debe ser "izquierda,arriba,derecha,abajo", por ejemplo --box 120,40,1100,1020.')
    return tuple(parts)


def crop_square(im, box):
    """Devuelve la imagen recortada a cuadrado y la caja realmente usada."""
    width, height = im.size
    if box is None:
        side = min(width, height)
        left, top = (width - side) // 2, (height - side) // 2
        box = (left, top, left + side, top + side)
    left, top, right, bottom = box
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise Fallo(
            f"La caja {left},{top},{right},{bottom} se sale de la imagen, que mide {width}x{height} px "
            "(izquierda y arriba desde 0; derecha y abajo hasta el ancho y el alto)."
        )
    if right - left != bottom - top:
        raise Fallo(
            f"La caja no es cuadrada: mide {right - left}x{bottom - top} px. "
            "Ajusta los números para que derecha-izquierda sea igual a abajo-arriba."
        )
    return im.crop(box), box


def resample_filter():
    resampling = getattr(Image, "Resampling", Image)
    return resampling.LANCZOS


def save_png(im, path, max_bytes):
    """Guarda el PNG; si pasa del límite, prueba con una paleta. Devuelve (bytes, usó_paleta)."""
    im.save(path, format="PNG", optimize=True)
    size = os.path.getsize(path)
    if size <= max_bytes:
        return size, False
    quant = getattr(Image, "Quantize", Image)
    method = quant.FASTOCTREE if im.mode == "RGBA" else quant.MEDIANCUT
    im.quantize(colors=256, method=method).save(path, format="PNG", optimize=True)
    return os.path.getsize(path), True


def validate_with_server_code(out_path):
    """Corre checkIconFile de lib/avatars.js sobre el archivo. Devuelve (errores, avisos) o None."""
    if not shutil.which("node"):
        return None
    script = (
        "const a=require('./lib/avatars');const p=process.argv[1];"
        "const r=a.checkIconFile(require('path').dirname(p),require('path').basename(p));"
        "console.log(JSON.stringify(r));"
    )
    try:
        out = subprocess.run(
            ["node", "-e", script, out_path], cwd=REPO_ROOT, capture_output=True, text=True, timeout=30
        )
        data = json.loads(out.stdout.strip().splitlines()[-1])
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None
    return data.get("errors", []), data.get("warnings", [])


def detect_newline(text):
    return "\r\n" if "\r\n" in text else "\n"


def add_to_manifest(avatar_id, name, filename):
    with open(MANIFEST, "r", encoding="utf-8", newline="") as fh:
        raw = fh.read()
    try:
        entries = json.loads(raw)
    except ValueError as err:
        raise Fallo(f"avatars.json no es un JSON válido ({err}); no lo toqué.")
    if not isinstance(entries, list):
        raise Fallo("avatars.json debe ser un arreglo; no lo toqué.")
    if any(isinstance(e, dict) and e.get("id") == avatar_id for e in entries):
        raise Fallo(f'El id "{avatar_id}" ya está en avatars.json. Quita --add para solo reemplazar la imagen.')
    if len(entries) >= MAX_AVATARS:
        raise Fallo(f"avatars.json ya tiene {len(entries)} avatares y el máximo es {MAX_AVATARS}.")
    entries.append({"id": avatar_id, "name": name, "file": filename})
    nl = detect_newline(raw)
    lines = []
    for entry in entries:
        body = ", ".join(f"{json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}" for k, v in entry.items())
        lines.append("  { " + body + " }")
    with open(MANIFEST, "w", encoding="utf-8", newline="") as fh:
        fh.write("[" + nl + ("," + nl).join(lines) + nl + "]" + nl)


def cell(text):
    return (text or NO_INFO).replace("|", "/").replace("\r", " ").replace("\n", " ").strip() or NO_INFO


def add_to_credits(avatar_id, name, author, link, license_):
    """Agrega una fila a la tabla de «## Iconos». Devuelve (ok, fila)."""
    row = f"| `{avatar_id}` | {cell(name)} | {cell(author)} | {cell(link)} | {cell(license_)} |"
    try:
        with open(CREDITS, "r", encoding="utf-8", newline="") as fh:
            raw = fh.read()
    except OSError:
        return False, row
    nl = detect_newline(raw)
    lines = raw.split(nl)
    try:
        start = next(i for i, l in enumerate(lines) if l.strip() == "## Iconos")
    except StopIteration:
        return False, row
    last = None
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("## "):
            break
        if lines[i].startswith("|"):
            last = i
    if last is None:
        return False, row
    lines.insert(last + 1, row)
    with open(CREDITS, "w", encoding="utf-8", newline="") as fh:
        fh.write(nl.join(lines))
    return True, row


def main():
    ap = argparse.ArgumentParser(
        description="Recorta a cuadrado, escala y guarda un avatar PNG en public/avatars/.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Más detalle en el encabezado de scripts/prepare-avatar.py y en public/avatars/README.md.",
    )
    ap.add_argument("imagen", help="ruta de la imagen original (jpg, png, webp...)")
    ap.add_argument("id", help="id del avatar: minúsculas, números y guiones, de 2 a 32 caracteres")
    ap.add_argument("--box", metavar="IZQ,ARR,DER,ABA", help='zona a recortar: "izquierda,arriba,derecha,abajo" en px (cuadrada). Sin esto: centrado.')
    ap.add_argument("--size", type=int, default=256, metavar="PX", help=f"lado final en px ({MIN_SIZE}-{MAX_SIZE}; por defecto 256)")
    ap.add_argument("--force", action="store_true", help="reemplazar el archivo si ya existe")
    ap.add_argument("--add", action="store_true", help="agregar el icono a avatars.json y a CREDITS.md (requiere --name)")
    ap.add_argument("--name", metavar="NOMBRE", help="nombre visible, por ejemplo «Zorro» (solo con --add)")
    ap.add_argument("--author", metavar="TEXTO", help="autor o fuente (solo con --add; si no, NO INFORMADO)")
    ap.add_argument("--link", metavar="URL", help="enlace de origen (solo con --add; si no, NO INFORMADO)")
    ap.add_argument("--license", dest="license_", metavar="TEXTO", help="licencia o permiso (solo con --add; si no, NO INFORMADO)")
    args = ap.parse_args()

    if not ID_PATTERN.match(args.id):
        raise Fallo(f'El id "{args.id}" no vale: usa letras minúsculas, números y guiones, de 2 a 32 caracteres.')
    if not MIN_SIZE <= args.size <= MAX_SIZE:
        raise Fallo(f"--size debe estar entre {MIN_SIZE} y {MAX_SIZE}.")
    if args.add and not (args.name and args.name.strip()):
        raise Fallo('Con --add hace falta --name "Nombre visible".')
    if not args.add and any([args.name, args.author, args.link, args.license_]):
        raise Fallo("--name, --author, --link y --license solo se usan junto con --add.")
    if not os.path.isfile(args.imagen):
        raise Fallo(f"No encuentro la imagen: {args.imagen}")
    if not os.path.isdir(AVATARS_DIR):
        raise Fallo(f"No existe {AVATARS_DIR}; ejecuta el script dentro del repo de MovieNight.")

    filename = f"{args.id}.png"
    out_path = os.path.join(AVATARS_DIR, filename)
    if os.path.exists(out_path) and not args.force:
        raise Fallo(f"{filename} ya existe. Pasa --force si quieres reemplazar su imagen (el id no cambia).")
    if args.add:  # comprobar antes de escribir nada
        with open(MANIFEST, "r", encoding="utf-8") as fh:
            try:
                existing = json.load(fh)
            except ValueError:
                existing = None
        if isinstance(existing, list) and any(isinstance(e, dict) and e.get("id") == args.id for e in existing):
            raise Fallo(f'El id "{args.id}" ya está en avatars.json. Quita --add para solo reemplazar la imagen.')

    try:
        im = Image.open(args.imagen)
        im.load()
    except Exception as err:  # Pillow lanza varios tipos según el archivo
        raise Fallo(f"No pude abrir la imagen como imagen válida: {err}")
    im = ImageOps.exif_transpose(im)
    im = im.convert("RGBA" if "A" in im.getbands() or "transparency" in im.info else "RGB")

    cropped, box = crop_square(im, parse_box(args.box) if args.box else None)
    side = box[2] - box[0]
    result = cropped.resize((args.size, args.size), resample_filter())

    size_bytes, used_palette = save_png(result, out_path, MAX_BYTES)
    if size_bytes > MAX_BYTES:
        os.remove(out_path)
        raise Fallo(
            f"Aun con paleta de colores pesa {size_bytes // 1024} KB y el máximo es {MAX_BYTES // 1024} KB. "
            f"Prueba con un --size menor que {args.size}."
        )

    print(f"Original: {im.size[0]}x{im.size[1]} px")
    print(f"Recorte:  --box {box[0]},{box[1]},{box[2]},{box[3]}  ({side}x{side} px, {'centrado' if not args.box else 'tu caja'})")
    print(f"Salida:   {os.path.relpath(out_path, REPO_ROOT)}  {args.size}x{args.size} px, {size_bytes / 1024:.1f} KB")
    if side < args.size:
        print(f"AVISO: el recorte ({side} px) es más chico que --size ({args.size}); se amplió y puede verse borroso.")
    if used_palette:
        print("AVISO: pesaba más de 200 KB y se redujo a una paleta de 256 colores; revisa que los colores sigan bien.")
    if im.mode == "RGB":
        print("Nota: el fondo se deja tal cual (JPG y similares no tienen transparencia).")

    check = validate_with_server_code(out_path)
    if check is None:
        print("Validación del servidor: omitida (no hay `node` disponible). Corre `npm run check:avatars` después.")
    else:
        errors, warnings = check
        for msg in errors:
            print(f"ERROR de validación: {msg}")
        for msg in warnings:
            print(f"AVISO de validación: {msg}")
        if errors:
            raise Fallo("La imagen no pasa la validación del servidor; revisa los errores de arriba.")
        print("Validación del servidor (lib/avatars.js): ok")

    if args.add:
        add_to_manifest(args.id, args.name.strip(), filename)
        print(f"avatars.json: agregado «{args.name.strip()}» ({args.id}) al final de la lista.")
        ok, row = add_to_credits(args.id, args.name.strip(), args.author, args.link, args.license_)
        if ok:
            print("CREDITS.md: fila agregada.")
        else:
            print("AVISO: no pude insertar la fila en CREDITS.md. Pégala tú en la tabla «Iconos»:")
            print("  " + row)
        if not (args.author and args.link and args.license_):
            print(f"AVISO: quedó «{NO_INFO}» en lo que no pasaste; complétalo en CREDITS.md cuando lo sepas.")
        print("Revisa también la sección «Pendiente de aclarar» de CREDITS.md (menciona la cantidad de iconos).")
        print("Siguiente: npm run check:avatars  y reinicia el servidor.")
    else:
        print("No se tocó avatars.json ni CREDITS.md (usa --add --name \"...\" para agregarlo a la lista).")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fallo as err:
        print(f"ERROR: {err}", file=sys.stderr)
        sys.exit(1)
