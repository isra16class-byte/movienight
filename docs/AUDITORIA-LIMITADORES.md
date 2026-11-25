# Auditoría de limitadores — 2026-11-25

Base revisada: `9f145f8`. Alcance: login, contraseña de sala y recuperación de contraseña.
Es una investigación con reproducciones; **no cambia las reglas del servidor**.

## Verificado

`node scripts/audit-limiters.js` compila el `server.js` del checkout sin cambiar su lógica;
solo expone funciones/estado en ese módulo de prueba. Usa Express y Socket.IO reales,
HTTP y WebSocket contra **127.0.0.1 en un puerto efímero**, bcrypt real y sesiones en memoria.
Postgres y el envío de correo son dobles de prueba. Redis y R2 están deshabilitados.
El proceso limpia su propio entorno antes de cargar módulos y usa un directorio temporal,
por lo que **no lee `.env`, no usa cuentas reales y no manda emails**. Todas las claves
se generan al ejecutar y no se imprimen ni se escriben en archivos.

La salida 0 del guion significa que se reprodujeron las observaciones siguientes,
**no** que la auditoría esté libre de hallazgos. Al corregir uno habrá que actualizar
su expectativa; el guion es diagnóstico y no se añadió al comando `npm test`.

| Caso | Reproducción y resultado |
|---|---|
| Login incompleto | Seis peticiones con campos ausentes, vacíos, nulos o de tipo incorrecto: todas 400; no consultan usuarios. El login válido posterior devuelve 200. No gastan intentos del limitador específico. |
| Login, cuenta existente | Cuatro contraseñas erradas consecutivas: **401, 401, 429, 429**. |
| Login, cuenta inexistente | Mismo procedimiento con otro email: **401, 401, 401, 429**. |
| Login, otra IP | Tras bloquear la combinación anterior, una IP IPv4 distinta permite el login correcto (200). |
| Recuperación incompleta | Cinco peticiones sin email utilizable: todas 400; no agregan claves al contador específico. |
| Recuperación, cuenta existente | Cuatro pedidos con la misma IP y email: los cuatro responden 200 con idéntico mensaje; solo los tres primeros consultan/generan reset y simulan correo. |
| Recuperación, cuenta inexistente | Mismos cuatro 200 y mensaje; solo tres consultas y ningún reset generado. |
| Recuperación, otra IP | Después del cupo anterior, otra IPv4 genera un reset/correo simulado adicional. |
| Ventana de recuperación | Con reloj controlado en la función real: tres pedidos admitidos, cuarto limitado; al cumplir una hora se admite otro. No fue una espera real de una hora. |
| Sala, contraseña ausente/vacía | En una sala protegida, `join-room` sin `password`, con `password: ''` y con `password: null` consume los tres intentos. El intento posterior con la correcta sigue bloqueado. |
| Descubrimiento de sala | Cinco GET a `/api/room/:id` no gastan intentos: el primer `join-room` con clave errada aún informa dos restantes y el siguiente con la correcta entra (`room-data`). |
| Confirmación de reset | Un token aleatorio inválido recibe 400. No se cambió ninguna contraseña. |

### 1. Diferencia observable en login: permite distinguir cuentas

`server.js`, `/auth/login`: la rama de usuario inexistente ignora `locked` y devuelve
401 en el tercer fallo; la de usuario existente devuelve 429 al bloquear.
Con claves de limitador frescas y tres intentos por email, el estado de la tercera
respuesta permite distinguir ambos casos. Contradice la intención de no enumerar
usuarios anotada en ese mismo handler. El cuarto pedido ya devuelve 429 en ambos.

**Propuesta pendiente de autorización:** responder de forma uniforme al alcanzar el
tercer fallo, exista o no el usuario, manteniendo tres intentos, bloqueo de 15 minutos,
clave IP+email y mensaje genérico. No se modificó el handler.

### 2. La sala cuenta la contraseña ausente/vacía

`join-room` verifica `password || ''` y registra el fallo también para un campo
ausente o nulo. La reproducción devolvió, en este orden:

1. `Contraseña incorrecta. Te quedan 2 intento(s).`
2. `Contraseña incorrecta. Te quedan 1 intento(s).`
3. `Contraseña incorrecta. Se bloquearon los intentos por 15 minutos.`
4. Con la correcta: `Demasiados intentos fallidos. Esperá 15 min y volvé a intentar.`

**Distinción respecto a biblioteca:** por lectura de `enterRoom()`, la web pregunta la
clave antes de conectar el socket. Abrir el link no envía automáticamente un intento
vacío. El diálogo sí acepta un envío vacío; cancelar vuelve al inicio sin conectar.
Los GET de descubrimiento no gastan el cupo, como confirma el guion.

**Decisión pendiente:** si se quiere igualar a biblioteca, omitir el campo, `null` o
`''` podría rechazarse sin contar; un espacio seguiría siendo un intento. El control
de bloqueo debería mantenerse antes de esa excepción. No se aplicó este cambio.

### 3. Recuperación: el vacío no reproduce el defecto

`/auth/forgot-password` valida el email antes del contador. El límite específico es
de **tres solicitudes por hora para cada combinación IP+email**, con respuesta
genérica también cuando se agotó. No es el contador de tres fallos/15 minutos.

Los comentarios junto a los limitadores de login y recuperación afirman que cambiar
de IP no alcanza para reintentar el mismo email. Eso no coincide con la clave ni con
la reproducción: una IP distinta obtiene otro cupo. Cambiar dirección dentro de un
mismo /64 IPv6 es un caso diferente, cubierto por `rateLimitKeyFromIp` y sus tests.
No se cambió la política a un límite global por email: eso requiere decidir el riesgo
de abuso frente al de bloquear a la víctima desde otra IP.

`/auth/reset-password` no tiene otro limitador específico de tokens; está bajo el
general de 300 peticiones/5 minutos por IP. Sus tokens se generan con 32 bytes
aleatorios y se consultan mediante hash SHA-256. No se verificaron 300 peticiones ni
un reset exitoso. Las peticiones inválidas sí pueden gastar el cupo **general**;
eso es distinto de consumir un intento del limitador específico.

### Observación de cliente, separada de la política de seguridad

Por lectura de `public/js/room.js` y ejecución de su handler `room-error` en un VM
con diálogo simulado: tanto el mensaje con intentos restantes como el del tercer
fallo abren un prompt con título «Contraseña incorrecta», sin pasar el mensaje del
servidor al diálogo. Se pierden el conteo y el aviso de bloqueo, y se ofrece un
reintento que ya no puede prosperar. No se verificó en un navegador real ni se
cambió el cliente. Conviene tratarlo en otro cambio de UX.

## Antigüedad comprobada

`git blame` y `git show` sitúan la diferencia de login en `f3b6ebe` (2026-09-05),
el conteo vacío de salas en `6506db4` (2026-09-05), y la clave/ventana de recuperación
en `4a3e03d` (2026-09-06). Son anteriores a la serie de interruptores.
Esto no diagnostica las rarezas de reconexión/chat, que siguen siendo otro tema.

## Checks y límites de la verificación

- `npm run lint`: pasa.
- `npm test` en este checkout Windows: **176/180 pasan; 4 fallan** en
  `test/clientGuards.test.js`. Es un fallo previo: su helper busca `\n}\n`, pero
  `public/js/index.js` y `library.js` están en CRLF (`core.autocrlf=true`).
  Los mismos cuatro tests pasan al normalizar únicamente las lecturas a LF en memoria,
  sin modificar los archivos. **No se afirma que `npm test` pase en Windows**.
- El guion diagnóstico con HTTP/Socket.IO termina correctamente y reproduce la tabla.
- **NO verificado:** Postgres, Redis o Resend reales; navegador, app móvil y dominio
  de pruebas; espera real de 15 minutos/una hora; carreras de peticiones simultáneas;
  resistencia distribuida; recuperación completa con cambio de contraseña.
- No se cambió la acumulación de fallos sin ventana de login/salas/biblioteca;
  sigue siendo una decisión de diseño pendiente, fuera de esta auditoría.

## Próximos pasos que requieren decisión

1. Autorizar o rechazar la respuesta uniforme de login (primer arreglo recomendado).
2. Decidir qué constituye un intento vacío de contraseña de sala.
3. Tratar después, por separado, mensajes de sala y compatibilidad CRLF de los tests.
4. Mantener sin cambios el cupo IP+email hasta que se decida otra política.
