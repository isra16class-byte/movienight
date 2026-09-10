# ✅ Pruebas — Panel de administración (paso 9 de `docs/PLAN-PANEL-ADMIN.md`)

Checklist mecánico para cerrar el paso 9 (verificación end-to-end con
Postgres/Redis reales y un admin navegando `public/admin.html` de verdad).
Pensado para copiar y pegar: la mayoría son `curl` a mano contra tu
`docker compose`; las partes que necesitan un navegador real (sync de
video/Socket.io, ver que el panel refleje un cambio en pantalla) están
marcadas explícitamente como "🖱️ navegador".

Convención: `$COOKIES` es un archivo de cookies de `curl` (`-c`/`-b`) para no
tener que copiar el valor de la cookie a mano en cada request.

**Nota sobre un número que difiere del plan escrito**: `docs/PLAN-PANEL-ADMIN.md`
describe el margen de "salas inactivas" como "~30s". El código real
(`RECONNECT_GRACE_MS` en `server.js`, usado directo por
`selectInactiveRoomIds()` en `lib/roomLifecycle.js`) usa **15000ms (15s)**, no
30s — es el mismo margen que ya existía para reconexiones, la sección 7 del
plan lo dice explícito ("mismo margen que ya usa `room.recentDisconnects`"),
así que el número real es el correcto y el "~30s" del texto quedó
desactualizado. Usá **15s** como referencia al probar el paso 5 de este
checklist, no 30s.

---

## 0. Preparación

```bash
# .env — completar antes de levantar
cp .env.example .env
# como mínimo para esta prueba:
#   LIBRARY_PASSWORD=algo
#   DATABASE_URL se arma sola por docker-compose.yml si no la pisás vos
#   SESSION_SECRET=$(openssl rand -hex 32)   # si no la ponés, cada restart desloguea a todos

docker compose up -d --build
docker compose logs -f app   # Ctrl+C cuando veas "escuchando en el puerto..." sin errores
```

**Cuenta admin**:

```bash
# 1. Registrar la cuenta por el flujo normal (HTTP, no hace falta el navegador)
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@test.com","password":"contraseña-de-prueba-larga"}'
# esperado: 201 { "id": "...", "email": "admin@test.com" }

# 2. Promoverla a admin — corre DENTRO del contenedor de la app, tiene DATABASE_URL en su entorno
docker compose exec app node scripts/make-admin.js admin@test.com
# esperado: "✅ "admin@test.com" ahora es administradora..."
```

**Cuenta NO admin** (para probar el 403 más abajo):

```bash
curl -s -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@test.com","password":"contraseña-de-prueba-larga"}'
# no la promuevas — se queda como 'user' a propósito
```

---

## 1. Sesión y permisos de `/admin/*`

```bash
# Sin sesión — 401
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/admin/settings
# esperado: 401

# Login como la cuenta NO admin
curl -s -c cookies_user.txt -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@test.com","password":"contraseña-de-prueba-larga"}'
# esperado: 200 { "id": "...", "email": "user@test.com" }

# Con sesión pero sin rol admin — 403
curl -s -b cookies_user.txt -o /dev/null -w '%{http_code}\n' http://localhost:3000/admin/settings
# esperado: 403

# Login como la cuenta admin
curl -s -c cookies_admin.txt -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@test.com","password":"contraseña-de-prueba-larga"}'
# esperado: 200

# Con sesión de admin — 200
curl -s -b cookies_admin.txt http://localhost:3000/admin/settings | head -c 500; echo
# esperado: 200 { "settings": [ ... 8 parámetros ... ] }
```

A partir de acá, todos los `curl` usan `-b cookies_admin.txt`.

---

## 2. `GET /admin/settings` — catálogo completo

```bash
curl -s -b cookies_admin.txt http://localhost:3000/admin/settings | python3 -m json.tool
```

Confirmar que aparecen las **8 keys** (ni una de más ni de menos) con
`source: "env"` o `"default"` (todavía nadie tocó nada desde el panel):

`ROOM_TTL_HOURS`, `MAX_LIBRARY_VIDEOS`, `MAX_LIBRARY_SIZE_GB`,
`R2_PRESIGN_EXPIRES_SECONDS`, `ALERT_HEALTH_FAILURE_THRESHOLD`,
`ALERT_COOLDOWN_MS`, `MULTIPART_ABANDON_DAYS`, `LIBRARY_ORPHAN_DAYS`.

---

## 3. `POST /admin/settings` — el caso central del paso 9: aplica sin reiniciar

Este es el que menciona explícitamente el punto 9 del plan ("cambiar
`MAX_LIBRARY_VIDEOS` desde el panel sin reiniciar el server").

```bash
# 3.1 — Poner el límite en 0 videos (0 = sin límite es el default; usamos un
# número bajo de verdad para forzar el rechazo)
curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/settings \
  -H 'Content-Type: application/json' \
  -d '{"key":"MAX_LIBRARY_VIDEOS","value":"0"}'
```

Antes de fijar el límite real, subí al menos un video de prueba a la
biblioteca (con la cuenta admin logueada, `POST /api/uploads` o
`/library.html` en el navegador con un `.mp4` chico — ver ayuda al final de
este documento para generar uno con `ffmpeg` si no tenés uno a mano).

```bash
# 3.2 — Ahora sí, límite = 1 (o el número de videos que ya tengas en la
# biblioteca en este momento, para que el próximo intento de subir choque)
curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/settings \
  -H 'Content-Type: application/json' \
  -d '{"key":"MAX_LIBRARY_VIDEOS","value":"1"}'
# esperado: 200 { "key": "MAX_LIBRARY_VIDEOS", "value": 1, "source": "db" }

# 3.3 — Confirmar que YA aplica, sin reiniciar el contenedor: intentar subir
# un segundo video (mismo flujo normal, LIBRARY_PASSWORD o la sesión admin)
curl -s -b cookies_admin.txt -o /dev/null -w '%{http_code}\n' \
  -F "video=@/ruta/a/otro-video.mp4" http://localhost:3000/create-room
# esperado: 413 "La biblioteca llegó al límite de 1 video(s)..."
#   (si da otro código, revisar el nombre del campo/ruta real que uses —
#    lo importante acá es que dé 413 por el límite, NO por otra cosa)

# 3.4 — Restaurar default (borra la fila en app_settings, vuelve a 0 = sin límite)
curl -s -b cookies_admin.txt -X DELETE http://localhost:3000/admin/settings/MAX_LIBRARY_VIDEOS
# esperado: 200 { "key": "MAX_LIBRARY_VIDEOS", "value": 0 }

curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/settings \
  -H 'Content-Type: application/json' -d '{"key":"MAX_LIBRARY_VIDEOS","value":"0"}' \
  > /dev/null  # (redundante con el DELETE de arriba, dejalo en 0 de todos modos)
```

### 3.5 Validación de rangos (uno alcanza para confirmar que el validador corre de verdad)

```bash
# Fuera de rango (max declarado: 10000)
curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/settings \
  -H 'Content-Type: application/json' \
  -d '{"key":"MAX_LIBRARY_VIDEOS","value":"999999"}'
# esperado: 400 { "error": "..." }

# Tipo incorrecto
curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/settings \
  -H 'Content-Type: application/json' \
  -d '{"key":"MAX_LIBRARY_VIDEOS","value":"no-es-un-numero"}'
# esperado: 400

# Key inexistente / no administrable
curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/settings \
  -H 'Content-Type: application/json' \
  -d '{"key":"DATABASE_URL","value":"algo"}'
# esperado: 400 "no es un parámetro administrable"
```

---

## 4. CSRF barato (`requireSameOrigin`)

```bash
# Origin de otro host — debería rechazar el POST
curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/settings \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://sitio-malicioso.example' \
  -d '{"key":"MAX_LIBRARY_VIDEOS","value":"5"}'
# esperado: 403 { "error": "Origen no permitido." }

# Sin Origin/Referer (como un curl común) — pasa, por diseño (ver lib/adminAuth.js)
curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/settings \
  -H 'Content-Type: application/json' \
  -d '{"key":"MAX_LIBRARY_VIDEOS","value":"0"}'
# esperado: 200 (dejamos MAX_LIBRARY_VIDEOS otra vez en 0, sin límite)
```

---

## 5. Dashboard y acciones sobre salas

Esta parte necesita salas de verdad — más fácil con **dos pestañas del
navegador** (🖱️) que simulando Socket.io por curl. Con la cuenta admin y
otra cuenta (o anónimo) abiertas en pestañas separadas:

1. 🖱️ Creá 2 salas reales, cada una con al menos un espectador conectado.
2. Confirmá el dashboard:

```bash
curl -s -b cookies_admin.txt http://localhost:3000/admin/stats | python3 -m json.tool
# esperado: activeRooms: 2, connectedUsers >= 2 (uno por pestaña), uploadsInProgress/r2ErrorCount presentes

curl -s -b cookies_admin.txt http://localhost:3000/admin/rooms | python3 -m json.tool
# esperado: 2 filas, cada una con roomId, viewerCount, owner, lastActivity,
# videoRef, y host.name/host.userId con datos reales (no null) si el host
# está conectado
```

3. **Cerrar salas inactivas no debe tocar la sala con gente mirando**:

```bash
# 🖱️ cerrá la pestaña (o pausá sin cerrar) de UNA de las dos salas — dejá la
# otra con el espectador todavía conectado. Esperá al menos 15s (ver nota
# del margen real al principio de este documento) y recién ahí:

curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/rooms/close-inactive
# esperado: { "closed": 1, "roomIds": ["<la sala que quedó vacía>"] }
# la sala con el espectador todavía conectado NO debería aparecer acá —
# confirmalo con GET /admin/rooms de nuevo, tiene que seguir en la lista
curl -s -b cookies_admin.txt http://localhost:3000/admin/rooms | python3 -m json.tool
```

4. **Cerrar una sala puntual**:

```bash
ROOM_ID=<el roomId de la sala que sigue activa>
curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/rooms/$ROOM_ID/close
# esperado: { "closed": true }
# 🖱️ confirmar en la pestaña que seguía mirando: debería recibir room-error
# ("Un administrador cerró esta sala.") y desconectarse

# Sala inexistente — 404
curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/rooms/no-existe-esta-sala/close
# esperado: 404
```

5. **Forzar el barrido por TTL**:

```bash
curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/rooms/sweep-now
# esperado: { "closed": 0, "roomIds": [] } si no hay salas vencidas por TTL
# todavía (24hs default) — es normal que dé 0 en esta prueba, solo confirma
# que la ruta responde sin error
```

6. **Cerrar TODAS — el botón nuclear, con las dos salvaguardas**:

```bash
# 🖱️ Abrí una sala nueva con un espectador conectado, para tener algo real que cerrar.

# Sin el campo confirm — 400
curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/rooms/close-all \
  -H 'Content-Type: application/json' -d '{}'
# esperado: 400 { "error": "Escribí exactamente \"CERRAR TODO\" para confirmar." }

# Con la palabra mal escrita (minúsculas, con tilde, lo que sea) — 400
curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/rooms/close-all \
  -H 'Content-Type: application/json' -d '{"confirm":"cerrar todo"}'
# esperado: 400

# Con la palabra exacta — 200, cierra TODO incluso con gente mirando
curl -s -b cookies_admin.txt -X POST http://localhost:3000/admin/rooms/close-all \
  -H 'Content-Type: application/json' -d '{"confirm":"CERRAR TODO"}'
# esperado: 200 { "closed": N, "roomIds": [...] }
# 🖱️ la pestaña con el espectador debería recibir room-error
# ("...modo mantenimiento.") y desconectarse, aunque estuviera mirando activamente
```

---

## 6. Auditoría (`admin_actions_audit`)

No hay UI para esto en la v1 (a propósito, según el plan) — se confirma con
SQL directo:

```bash
docker compose exec postgres psql -U movienight -d movienight -c \
  "SELECT action, detail, created_at FROM admin_actions_audit ORDER BY created_at DESC LIMIT 20;"
```

Confirmar que aparece **una fila por cada acción de escritura** que hiciste
arriba: al menos un `setting_changed` (con `detail.key`/`from`/`to`), un
`setting_reset`, un `room_closed`, un `rooms_closed_inactive`, un
`sweep_forced` y un `rooms_closed_all` — y que `admin_user_id` corresponde a
la cuenta admin que usaste (no aparece ninguna fila para los intentos que
dieron 400/403, esos ni llegan a auditarse).

---

## 7. 🖱️ `public/admin.html` en el navegador — lo que un curl no prueba

Con la sesión admin ya logueada en el navegador (mismo login que usaste
arriba, o hacelo de nuevo desde `index.html`):

- [ ] Entrar a `http://localhost:3000/admin.html` — carga el dashboard y los
      8 inputs de settings sin redirigir a `/`.
- [ ] Deslogueate (`/auth/logout` o el botón si existe) y entrá de nuevo a
      `/admin.html` directo por URL — **redirige a `/` sin ningún mensaje**
      (ni "acceso denegado" ni nada que confirme que la pantalla existe).
      Volvé a loguearte como admin para seguir.
- [ ] Cambiar `MAX_LIBRARY_VIDEOS` desde el input (no por curl) y confirmar
      que la etiqueta de "desde dónde sale el valor" pasa a decir algo tipo
      "editado acá" / `db`, sin recargar la página.
- [ ] Click en "Restaurar" en esa misma fila — vuelve a mostrar el
      valor/origen de antes (`env` o `default`).
- [ ] El dashboard (contadores + tabla de salas) se refresca solo cada 15s
      sin que hagas nada — confirmalo abriendo una sala nueva en otra
      pestaña y esperando a que aparezca sin recargar `admin.html`.
- [ ] Botón "Cerrar" individual de una fila de la tabla de salas — pide
      confirmación simple (`mnPrompt`/`mnConfirm`) antes de mandar el
      request.
- [ ] "Limpiar salas" — sin pedir confirmación (bajo riesgo, según el
      diseño).
- [ ] "Cerrar salas inactivas" — pide confirmación simple.
- [ ] "Cerrar TODAS las salas" — el botón **no manda nada** hasta escribir
      literalmente `CERRAR TODO` en el campo de texto (probá con el botón
      deshabilitado o con la palabra mal escrita primero, para confirmar que
      no hace nada).
- [ ] Con esa acción, cualquier pestaña que estuviera mirando una sala
      recibe el aviso y se desconecta de verdad (no solo en la respuesta del
      admin).

---

## 8. Regresión rápida — nada del resto se rompió

```bash
docker compose exec app npm test
# esperado: mismos tests en verde que antes (76/76 + los que se hayan sumado)

docker compose exec app npm run lint
# esperado: limpio
```

🖱️ Además, un flujo normal de usuario (sin ser admin) sigue andando igual:
crear sala anónima, unirse por código, chat, cambio de host.

---

## Ayuda: generar un video de prueba chico y válido

Para las partes de este checklist que necesitan subir un archivo que pase la
validación real de magic bytes (Fase 2.5, `lib/fileValidation.js`), no
alcanza con un archivo de texto renombrado a `.mp4`. Un mp4 real y mínimo,
con `ffmpeg`:

```bash
ffmpeg -f lavfi -i color=c=blue:s=320x240:d=2 -f lavfi -i anullsrc -shortest test-video.mp4
```

Esto genera 2 segundos de video azul con audio silencioso — suficiente para
pasar la detección de `file-type` y para que `room.html` lo reproduzca sin
drama en las pruebas de este documento.

---

## Registro del resultado

Una vez corrido todo esto contra Docker Compose real, la entrada
correspondiente queda para agregar a `docs/MEMORIA.md` (sección "Por dónde
seguir") y `docs/CHANGELOG.md`, cerrando el paso 9 y con él las 9 fases del
panel de administración — mismo criterio que ya se usó para
`PRUEBAS-FASE-2BIS.md` en su momento (ver referencia en el histórico).
