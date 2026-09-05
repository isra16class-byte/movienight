// Configuración de PM2 (Fase 1.3 del plan de producción — proceso supervisado).
//
// Pensada específicamente para el caso "VPS propio" (ver docs/PLAN-PRODUCCION.md, Fase 0:
// el hosting todavía no está decidido). Si en cambio se termina usando Railway/Render/Fly.io,
// este archivo no hace falta ni se usa: esas plataformas ya reinician el proceso solas si
// crashea, usando `npm start` como comando de arranque — ver README, sección "Proceso
// supervisado" para el detalle de cuándo usar cada camino.
//
// Uso: `pm2 start ecosystem.config.js` (requiere PM2 instalado globalmente: `npm install -g pm2`).
module.exports = {
  apps: [
    {
      name: 'movienight',
      script: 'server.js',
      instances: 1, // una sola instancia alcanza por ahora (Fase 0, decisión de arquitectura) —
                    // no usar cluster mode: `rooms` vive en memoria por proceso (ver MEMORIA.md),
                    // así que dos instancias del mismo proceso no compartirían las salas activas.
      exec_mode: 'fork',
      autorestart: true,
      watch: false, // no reiniciar por cambios de archivos: eso es para desarrollo, no para producción

      // --- Backoff: no reintentar en loop infinito si el problema es persistente ------------------
      // `exp_backoff_restart_delay`: si el proceso se cae, PM2 espera antes de reintentar, y ese
      // tiempo de espera se va duplicando en cada caída consecutiva (arranca en 100ms, hasta un tope
      // de 15s que pone PM2 por default) — así un problema puntual se recupera casi al instante, pero
      // un problema persistente (ej. Redis caído, ver lib/roomStore.js) no termina reintentando cientos
      // de veces por segundo.
      exp_backoff_restart_delay: 100,

      // `min_uptime` + `max_restarts`: si el proceso no llega a estar arriba 30s seguidos, ese
      // reinicio cuenta como "inestable". Después de 10 reinicios inestables seguidos, PM2 deja de
      // intentar reiniciar y lo marca como `errored` — evita el loop infinito de reinicios cuando el
      // problema no se va a resolver solo (ej. falta una variable de entorno obligatoria, o Redis
      // nunca va a responder). Requiere entrar manualmente (`pm2 restart movienight`) una vez
      // resuelta la causa.
      min_uptime: '30s',
      max_restarts: 10,

      // Logs: PM2 ya junta stdout/stderr por su cuenta (`pm2 logs`) — no hace falta redirigir a
      // archivos acá para el alcance actual del proyecto (la Fase 4, observabilidad, es donde
      // correspondería pensar en logs estructurados/rotación si hiciera falta).
    },
  ],
};
