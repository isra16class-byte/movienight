// Escapado de texto para insertarlo en HTML (plantillas con innerHTML), UNA sola copia para todas las
// páginas. Antes había cuatro (admin.js, library.js, room.js y `escapeHtmlLocal` en index.js) que
// usaban `textContent` + `innerHTML`: escapaban `&`, `<` y `>` pero NO las comillas, así que un valor de
// otra persona dentro de un atributo (`value="${escapeHtml(x)}"`) podía cerrar la comilla y agregar
// atributos. Hoy ningún valor de otra persona llega a un atributo (ver la auditoría de `innerHTML` en
// docs/MEMORIA.md), pero esta función ya no depende de que eso siga siendo así.
//
// Escapa `& < > " '`. `null` y `undefined` dan '' y cualquier otro valor se convierte con String() (igual
// que la copia de room.js, la más tolerante). No usa el DOM: es una función pura, también testeable en Node.
//
// Se carga como <script src="/js/escape-html.js" defer></script> ANTES del script de cada página que la
// usa (la CSP no permite scripts inline; los `defer` se ejecutan en orden). test/escapeHtml.test.js vigila
// que ninguna página la use sin cargarla y que no vuelva a aparecer una copia local.
function escapeHtml(str) {
  if (str == null) return '';
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str).replace(/[&<>"']/g, (ch) => entities[ch]);
}

// Para los tests (Node). En el navegador `module` no existe y esta línea no hace nada.
if (typeof module !== 'undefined' && module.exports) module.exports = escapeHtml;
