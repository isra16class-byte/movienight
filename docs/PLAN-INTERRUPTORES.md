# Plan: interruptores de acceso en el panel de admin

Fecha: 2026-10-27. Rama: `plan-produccion`. Estado: **fases 1, 2 y 3 de 5 hechas (2026-10-27); fases 4 y 5 pendientes**.

Este documento recoge lo decidido antes de tocar código. La sección 4 («Fases») sustituye
al reparto en 4 parches de la primera versión: al medir el código se vio que el parche 2
original tocaba 8 puntos de `server.js` y el cliente a la vez, y se dividió. La sección 6
separa lo ya comprobado contra el código de lo que sigue pendiente de leer.

---

## 1. Decisión de fondo

Se descartó el «corte duro» (la opción D: exigir cuenta siempre para ser host,
eliminando el `hostToken` anónimo). En su lugar, esas reglas pasan a ser
**interruptores sí/no administrables desde el panel de admin**.

Motivos:

- El proyecto todavía no está en producción, así que se puede configurar en
  caliente y ajustar el valor definitivo antes de salir.
- Con el valor por defecto de cada interruptor, la app se comporta como hoy.
- No se borra código: el `hostToken` queda detrás de un interruptor y se puede
  volver atrás desde el panel.

Se mantiene la prioridad de configuración que ya existe en `lib/settings.js`:
**panel → `.env` → valor por defecto**.

## 2. Los cinco interruptores

| Parámetro | Qué controla | Por defecto |
|---|---|---|
| `ALLOW_ANONYMOUS_ROOMS` | Si se pueden crear salas sin cuenta. Apagado equivale a la opción D | Sí |
| `REQUIRE_ACCOUNT_TO_JOIN` | Si quien solo mira también necesita cuenta | No |
| `ALLOW_REGISTRATION` | Abrir o cerrar el registro de cuentas nuevas | Sí |
| `ALLOW_LIBRARY_PASSWORD` | Si la contraseña compartida sigue valiendo para listar y subir cintas, o solo vale la sesión | Sí |
| `HOST_AUTO_TRANSFER` | Si, al desconectarse el host, el control pasa al siguiente conectado | Sí |

El traspaso manual (`make-host`, cuando el host elige a quién pasar el control)
no lo afecta ningún interruptor.

## 3. Reglas de comportamiento decididas

### 3.1 Traspaso del host

- El comportamiento normal deseado es que, cuando el host se va, **el control
  pase al siguiente**. Eso es lo que ocurre con `HOST_AUTO_TRANSFER` en «Sí».
- Con `HOST_AUTO_TRANSFER` apagado, al irse el host `hostSocketId` queda en
  `null` y nadie controla el video hasta que vuelva. Se enviaría un mensaje de
  sistema al chat avisándolo (se puede quitar si no gusta).

### 3.2 Sala sin host

Hoy el traspaso solo funciona si queda alguien conectado cuando el host se va.
Falla en dos casos:

1. El dueño es el último en irse: no queda nadie a quien pasar el control.
2. Alguien entra después a una sala sin host: al no ser el dueño, `isRoomOwner()`
   le dice que no y queda como invitado aunque esté solo.

Arreglo acordado: **quien entra a una sala sin host recibe el control temporal**.
Si vuelve el dueño, `setHost()` ya degrada al anterior antes de promover, así
que el dueño recupera el control sin cambios adicionales.

**Quién puede recibir ese control temporal** (decidido: automático):

- Si `ALLOW_ANONYMOUS_ROOMS` está encendido: cualquier persona que entre.
- Si está apagado: solo cuentas con sesión. Una sala con solo anónimos puede
  quedar sin host.

**Interacción con `HOST_AUTO_TRANSFER` (decidido al implementar la fase 3):** con el traspaso automático
apagado tampoco hay control temporal. El plan de 3.1 dice que entonces «nadie controla el video hasta que
vuelva» el host; darle el control al primero que entre sería un traspaso automático por otra puerta. El
dueño sí lo recupera siempre (`isRoomOwner`). Si se prefiere lo contrario, es quitar una línea de
`canTakeTemporaryHost()` en `lib/hostAuth.js` (y su test).

Riesgo conocido: si el dueño no está, cualquiera con el link toma el control.
Esto ya ocurre hoy mientras hay gente conectada; lo nuevo es que también ocurre
con la sala vacía.

### 3.3 Al apagar `ALLOW_ANONYMOUS_ROOMS`

Decidido: **solo bloquea crear salas nuevas**. Las salas anónimas que ya existen
siguen funcionando hasta expirar (24 h sin actividad, `ROOM_TTL_HOURS`).

Consecuencia a tener presente: no hay un «botón de emergencia» inmediato si se
filtra un `hostToken`. Ese token sigue valiendo hasta que la sala venza. Si más
adelante importa, se puede añadir la variante en que el `hostToken` deja de
valer al instante.

### 3.4 Sin `DATABASE_URL` (decidido: opción B, cortar el arranque)

Las cuentas viven en PostgreSQL. Sin `DATABASE_URL` no existen cuentas, así que
un interruptor que exija cuenta sería imposible de cumplir.

Decisión: **el servidor no arranca** y muestra un error claro, igual que ya
hace con Redis, R2 y Postgres mal configurados («fallar rápido»).

Cuentan como «exigen cuenta»:

- `ALLOW_ANONYMOUS_ROOMS` apagado
- `REQUIRE_ACCOUNT_TO_JOIN` encendido
- `ALLOW_LIBRARY_PASSWORD` apagado

El choque solo puede darse por valores fijados en el `.env`, porque el panel
necesita Postgres para guardar cualquier valor.

## 4. Fases, en orden

Cada fase es una sesión y un patch: commit local, `git format-patch`, y quien mantiene el
repo lo aplica con `git am` y hace el push. Cada patch deja tests y lint en verde y
actualiza `MEMORIA.md` y `CHANGELOG.md` en el mismo commit (en la fase 5 también
`PLAN-PRODUCCION.md`). Las fases se aplican una tras otra.

**Regla de orden:** cada clave se agrega al catálogo de `lib/settings.js` en la fase en
que ya hace algo. Así el panel nunca muestra un interruptor sin efecto.

| Fase | Contenido | Tamaño |
|---|---|---|
| **1. Infraestructura** ✅ | Tipo `bool` en `lib/settings.js` y `lib/envValidation.js`, selector sí/no en el panel (`public/admin.html` y `public/js/admin.js`), y `HOST_AUTO_TRANSFER` como primer interruptor (un `if` en `disconnect`) | Chico-medio |
| **2. `ALLOW_ANONYMOUS_ROOMS`** ✅ | Exigir sesión en `/create-room` y `/create-room-from-upload` (ver 6.1, punto 1), mensaje en `public/js/index.js`, y validación de arranque (3.4), escrita de forma genérica para que la reusen las demás fases | Medio |
| **3. Control temporal** ✅ | Regla de sala sin host en `join-room` (3.2), apoyada en la fase 2, con tests, incluida la sala restaurada tras un reinicio | Medio |
| **4. Registro y biblioteca** | `ALLOW_REGISTRATION` y `ALLOW_LIBRARY_PASSWORD`: condiciones en `/auth/register`, `requireLibraryAuth` y `requireUploadAuth` | Chico-medio |
| **5. `REQUIRE_ACCOUNT_TO_JOIN`** | Rechazo en `join-room` y pantalla de «necesitas cuenta» en `room.js`. Si hace falta, se parte en 5a (servidor) y 5b (cliente) | **Pesada** |

### 4.0 Fase 1, hecha (2026-10-27)

- `lib/settings.js`: tipo `bool` (acepta 1/true y 0/false; se guarda como `'1'`/`'0'`; un valor ilegible
  del `.env` cae al default) y la clave `HOST_AUTO_TRANSFER` (default `true`).
- `lib/envValidation.js`: `BOOL_SETTING_VARS`, con un warning si el valor no es 1/true/0/false.
- `server.js`, bloque `disconnect`: con el interruptor apagado no hay traspaso; `hostSocketId` queda en
  `null` y, si queda gente, se avisa en el chat (el aviso se puede quitar si no gusta, ver 3.1).
- Panel: los booleanos usan un selector Sí/No en vez de un campo de texto.
- Los otros cuatro interruptores se suman al catálogo y a `BOOL_SETTING_VARS` en la fase donde hacen algo.

### 4.0b Fase 2, hecha (2026-10-27)

- `lib/accessPolicy.js` (nuevo, puro y testeado): `roomCreationBlock()` (la regla de crear sala),
  `validateAccessPolicy()` (la validación de arranque de 3.4) y la lista `ACCOUNT_REQUIRING_SWITCHES`,
  a la que las fases 4 y 5 suman su interruptor.
- `server.js`: el middleware `requireAccountToCreateRoom` va **antes** de `requireUploadAuth` y de la
  subida en `/create-room` y `/create-room-from-upload`. Responde 403 con `code: 'ACCOUNT_REQUIRED'`
  (no 401: el cliente lo leería como contraseña de biblioteca incorrecta y reabriría el prompt). La
  contraseña de biblioteca no sustituye a la sesión. Va antes de la subida, así que no se guarda ningún
  archivo ni se gasta un intento de contraseña.
- `GET /api/access-policy` (público, solo booleanos, sin caché): el cliente sabe de antemano si hace
  falta cuenta. Las fases siguientes le suman sus campos.
- `public/js/index.js`: sin sesión y con el interruptor apagado, avisa antes de pedir contraseña o
  subir nada.
- Arranque: tras `settings.init()`, si algún interruptor exige cuenta y no hay `DATABASE_URL`, el
  server sale con código 1 nombrando la clave.
- **Decisión sobre `/api/uploads/presign` y `change-video`: no se tocan.** `library.js` usa ambas para
  cambiar el video de una sala que ya existe, y 3.3 dice que las salas existentes siguen funcionando.
  Consecuencia: alguien sin cuenta pero con la contraseña de biblioteca aún puede pedir una URL
  prefirmada y subir un archivo suelto a R2 (sin sala). Eso lo cierra `ALLOW_LIBRARY_PASSWORD` en la fase 4.

### 4.0c Fase 3, hecha (2026-10-27)

- `lib/hostAuth.js`: `roomHasLiveHost(io, room)` (un `hostSocketId` de un socket ya caído **no** cuenta como host),
  `canTakeTemporaryHost()` (la regla, pura) y `assignHostOnJoin()` (dueño → control temporal → invitado; emite el
  `host-status` que corresponda y devuelve `'owner' | 'temporary' | 'guest'`).
- La regla: no hay host vivo **y** `HOST_AUTO_TRANSFER` encendido **y** (`ALLOW_ANONYMOUS_ROOMS` encendido **o** quien entra
  tiene sesión de cuenta). Ver la interacción con `HOST_AUTO_TRANSFER` en 3.2.
- `server.js`, bloque `join-room`: el `if/else` de `isRoomOwner` pasa a una llamada a `assignHostOnJoin()`. No se agrega mensaje
  al chat (con la sala vacía no lo vería nadie; el cliente se entera por `host-status`).
- `lib/roomStore.js`: se exporta `hydrateRoom` solo para testear que una sala restaurada vuelve con `hostSocketId: null`.
- Si vuelve el dueño, `setHost()` degrada al temporal antes de promoverlo: nunca hay dos hosts (test incluido).
- **Observación, sin cambiar:** `setHost()` le manda al host (también al temporal) el `hostToken` de la sala. En una sala anónima
  eso ya ocurría con el traspaso automático y con `make-host`; ahora también lo recibe quien entra a una sala sin host. En salas
  con dueño el `hostToken` no autoriza nada (`isRoomOwner`).

### 4.1 Por qué la fase 5 es la pesada

Los otros interruptores son condicionales de pocas líneas. `REQUIRE_ACCOUNT_TO_JOIN` no:
`public/js/room.js` no tiene nada de login (el login vive en `index.js`), así que hay que
decidir **qué ve quien abre un link de sala sin cuenta**: redirigir al inicio con el
link guardado para volver, un formulario de login dentro de la sala, o solo un aviso.
Esa decisión de producto queda abierta hasta empezar la fase 5.

### 4.2 Decisiones que cambia el código (de la medición del 2026-10-27)

1. **La contraseña de biblioteca sola alcanza para crear una sala.** `requireUploadAuth`
   deja pasar con `LIBRARY_PASSWORD` sin sesión. Si se apaga `ALLOW_ANONYMOUS_ROOMS` sin
   cubrir eso, el interruptor se esquiva. Hay que exigir sesión al crear sala aunque la
   contraseña sea correcta. Las rutas que cuelgan de `requireUploadAuth` son
   `/create-room`, `/create-room-from-upload`, `/api/uploads/presign` y
   `/room/:id/change-video`; hay que decidir en la fase 2 cuáles de ellas cuentan como
   «crear sala» y cuáles siguen aceptando la contraseña.
2. **El selector del panel va primero, no último** (regla de orden de arriba).
3. **La validación de arranque (opción B de 3.4) es viable.** `settings.init()` funciona
   sin Postgres (cae a `.env` y valor por defecto), así que puede leer el valor efectivo.
   Solo saltaría por valores fijados en el `.env`.
4. **`hostSocketId` no se guarda en Redis.** Tras un reinicio toda sala vuelve sin host.
   Con la regla del control temporal, el primero que entre a una sala restaurada lo
   recibe si cumple el criterio de 3.2. Esto va a tests en la fase 3.
5. **`envValidation` ya trata los booleanos con `=== '1'`.** Los interruptores nuevos
   aceptarán `1/true` y `0/false`, y se registran ahí para que un typo avise.

## 5. Otros pendientes, en el orden elegido

- [ ] 1. `hostToken` anónimo: lo cubren las fases 1 a 5, con el matiz de 3.3.
- [ ] 2. Unificar `escapeHtml()` (hoy hay 4 copias) y que escape `"` y `'`.
  Cierra lo anotado en la auditoría de `innerHTML`.
- [ ] 3. Prueba en móvil de `room.html`: rotación y teclado de Android. No
  requiere código.
- [ ] 4. Espacio en R2. La línea «Las salas nunca expiran» de `MEMORIA.md` está
  desactualizada: desde la Fase 2.6 las salas expiran a las 24 h. Lo que se
  acumula es el video en R2, que no se borra a propósito. Corregir esa línea y
  revisar cuánto ocupa el bucket.
- [ ] 5. Fuentes propias, para poder quitar `fonts.googleapis.com` y
  `fonts.gstatic.com` de la CSP.
- [ ] 6. Beacon de Cloudflare (se desactiva en el panel de Cloudflare),
  `favicon.ico` (404) y la meta `apple-mobile-web-app-capable` obsoleta.

## 6. Verificación contra el código

### 6.1 Ya comprobado (2026-10-27, `server.js` de 2780 líneas)

- `requireUploadAuth` protege `/create-room` (~l. 1664), `/create-room-from-upload`
  (~l. 1695), `/api/uploads/presign` (~l. 1644) y `/room/:id/change-video` (~l. 1719).
  `requireLibraryAuth` protege listar y borrar en `/api/uploads` (~l. 1953 y 1981).
- `lib/roomStore.js` no persiste `hostSocketId` (queda en `null` al restaurar).
- `lib/settings.js` solo define los tipos `int` y `float`; el catálogo es `SETTINGS`.
- `lib/envValidation.js` lee los flags booleanos con `=== '1'`.
- `public/js/room.js` no contiene lógica de login ni llamadas a `/auth`.

### 6.2 Por leer antes de cada fase

- `lib/settings.js`: cómo `validate()` y `listAll()` usan `type`, para añadir `bool` (fase 1).
- `lib/hostAuth.js`: `isRoomOwner()` y `setHost()` (fase 3).
- `server.js`: los bloques `join-room` y `disconnect`. La sesión anterior citó
  aproximadamente las líneas ~2165-2175, ~2347-2360 y ~2397; pueden haber cambiado.

Comprobar en particular:

- Que la regla del control temporal no abra un hueco con `ALLOW_ANONYMOUS_ROOMS`
  encendido (caso nuevo: sala vacía con el link filtrado).
- Que `ROOM_TTL_HOURS` siga siendo `nullable` y qué ocurre con las salas anónimas vivas
  si se pone en `null`.
