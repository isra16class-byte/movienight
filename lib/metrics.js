// --- Métricas básicas (Fase 4 del plan de producción, "métricas básicas") -------------------------
// Por qué existe este archivo: `/health` (Fase 1.5) responde "¿está sano el proceso?" (sí/no, con el
// detalle de cada dependencia), pero no da ningún panorama operativo de qué está pasando ADENTRO del
// proceso — cuántas salas hay activas, cuánta gente conectada, si hay subidas en curso, si R2 viene
// fallando. Este módulo junta esos contadores en un solo lugar para que `GET /metrics` (server.js)
// los exponga, sin acoplar esa ruta a los detalles internos de cada parte del código.
//
// Contadores en memoria, a propósito (no Redis): la Fase 0 ya decidió que **una sola instancia
// alcanza por ahora** (Fase 3, escalado horizontal, queda pospuesta) — no hay otra instancia con la
// que sincronizar esto. Si el proceso reinicia, los contadores acumulativos (errores de R2 vistos
// hasta ahora) vuelven a cero; es una limitación aceptada para un primer endpoint de métricas, igual
// que documenta la Fase 4 del plan ("aunque sea un endpoint simple para empezar, antes de pensar en
// Prometheus/Grafana"). Lo que sí importa mirar en el tiempo (tendencias, alertas) debería salir de
// Sentry o de un servicio de métricas real más adelante, no de este contador volátil.

// Subidas de video en curso (Fase 1/2/2.5): incrementado/decrementado alrededor de
// `upload.single('video')` en server.js, para los dos modos que pasan por el proceso (disco local y
// streaming a R2 vía `r2VideoStorage`). La subida directa a R2 por URL prefirmada (Fase 2.7) NO pasa
// por acá a propósito: el binario nunca atraviesa el server en ese camino, así que no hay nada que
// contar como "en curso" de este lado — ver `docs/PLAN-PRODUCCION.md` Fase 2.7 para el detalle de por
// qué existe ese tercer camino.
let uploadsInProgress = 0;

function uploadStarted() {
  uploadsInProgress++;
}

function uploadFinished() {
  // Nunca debería ir negativo, pero Math.max(0, ...) es una red de seguridad barata por si algún
  // camino de error llega a llamar a esto sin haber llamado antes a uploadStarted() (no debería
  // pasar con el wrapper de server.js, pero un contador en -1 sería confuso de leer en /metrics).
  uploadsInProgress = Math.max(0, uploadsInProgress - 1);
}

// Errores de R2 (Fase 4): cuenta cualquier operación real contra el bucket que termine en error
// (subida, presign, listar, borrar, leer cabecera) — ver lib/r2.js, que llama a `recordR2Error` desde
// un wrapper común. No cuenta el caso de "objeto no existe" (404 de `objectExists`), que es un
// resultado válido, no una falla de R2.
let r2ErrorCount = 0;
let r2LastError = null; // { message, at } — último error visto, para diagnóstico rápido sin ir a los logs

function recordR2Error(err) {
  r2ErrorCount++;
  r2LastError = {
    message: (err && err.message) || String(err),
    at: new Date().toISOString()
  };
}

function snapshot() {
  return {
    uploadsInProgress,
    r2ErrorCount,
    r2LastError
  };
}

module.exports = {
  uploadStarted,
  uploadFinished,
  recordR2Error,
  snapshot
};
