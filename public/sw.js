// Service worker de MovieNight — deliberadamente mínimo.
//
// MovieNight es tiempo real (Socket.io) y sirve video pesado desde disco o R2,
// así que este SW NO cachea nada dinámico: ni /room/:id, ni /api/*, ni /uploads,
// ni /socket.io/* (los deja pasar directo a la red, sin interceptar).
//
// Lo único que cachea es el "app shell" estático (HTML de las 3 páginas, CSS,
// manifest, íconos) con estrategia network-first: si hay internet, siempre pide
// la versión fresca del server (y actualiza la cache); si falla la red, usa la
// copia cacheada como respaldo. Esto te deja abrir la app instalada sin pantalla
// en blanco aunque el server esté momentáneamente inalcanzable, pero nunca te
// deja viendo una sala vieja en caché ni un video pisado por otro.

const CACHE_NAME = 'movienight-shell-v1';

const SHELL_URLS = [
  '/',
  '/index.html',
  '/library.html',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Rutas que el SW nunca debe tocar: siempre van directo a la red.
function isDynamic(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/room/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/uploads/') ||
    url.pathname.startsWith('/create-room')
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Solo GET, solo mismo origen, y nunca lo dinámico (rooms, api, sockets, uploads).
  if (req.method !== 'GET' || url.origin !== self.location.origin || isDynamic(url)) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
