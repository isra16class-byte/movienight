# Plan: interruptores de acceso en el panel de admin

Fecha: 2026-10-27. Rama: `plan-produccion`. Estado: **plan acordado, sin código todavía**.

Este documento recoge lo decidido en la conversación previa a tocar código. Lo
escrito en la sección 6 («Por verificar») sale de lo que se leyó de `server.js`
en otra sesión y **no se ha comprobado aún contra el código**.

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

## 4. Parches, en orden

Cada parche sigue el flujo del repo: commit local, `git format-patch`, y quien
mantiene el repo lo aplica con `git am` y hace el push.

- [ ] **Parche 1 — tipo `bool` en `lib/settings.js`.** Hoy solo existen `int` y
  `float`. Validación y tests.
- [ ] **Parche 2 — interruptores en el servidor.** Crear sala, unirse, registro,
  contraseña de biblioteca, bloque `disconnect`, regla de sala sin host y
  validación de arranque (3.4). Actualizar `test/hostAuth.test.js` y añadir
  tests nuevos.
- [ ] **Parche 3 — panel.** Selector sí/no en `public/admin.html` y
  `public/js/admin.js` en lugar de la caja de texto (hoy se pinta siempre un
  campo de texto).
- [ ] **Parche 4 — documentación.** `MEMORIA.md`, `CHANGELOG.md` y
  `PLAN-PRODUCCION.md`.

## 5. Otros pendientes, en el orden elegido

- [ ] 1. `hostToken` anónimo: lo cubren los parches 1 a 3, con el matiz de 3.3.
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

## 6. Por verificar antes del parche 1

Leer, antes de escribir código:

- `lib/settings.js`: cómo se define el catálogo y cómo se validan los tipos.
- `lib/hostAuth.js`: `isRoomOwner()` y `setHost()`.
- `server.js`: los bloques de `join-room` y `disconnect` (la sesión anterior
  citó aproximadamente las líneas ~2165-2175, ~2347-2360 y ~2397; pueden haber
  cambiado).

Comprobar en particular:

- Que la regla del control temporal no abra un hueco con
  `ALLOW_ANONYMOUS_ROOMS` encendido (caso nuevo: sala vacía con el link
  filtrado).
- Que `ROOM_TTL_HOURS` siga siendo `nullable` y qué ocurre con las salas
  anónimas vivas si se pone en `null`.
