// Service worker de MovieNight — deliberadamente mínimo.
//
// MovieNight es tiempo real (Socket.io) y sirve video pesado desde disco o R2,
// así que este SW NO cachea nada dinámico: ni /room/:id, ni /api/*, ni /uploads,
// ni /socket.io/* (los deja pasar directo a la red, sin interceptar).
//
// Lo único que cachea es el "app shell" estático (inicio/biblioteca, JS, CSS,
// fuentes, manifest e íconos) con estrategia network-first: si hay internet, pide
// la versión fresca del server (y actualiza la cache); si falla la red, usa la
// copia cacheada como respaldo. Esto te deja abrir la app instalada sin pantalla
// en blanco aunque el server esté momentáneamente inalcanzable, pero nunca te
// deja viendo una sala vieja en caché ni un video pisado por otro.

const CACHE_NAME = 'movienight-shell-v2';

const SHELL_URLS = [
  '/',
  '/index.html',
  '/library.html',
  '/style.css',
  '/js/sw-register.js',
  '/js/escape-html.js',
  '/js/index.js',
  '/js/library.js',
  '/fonts/fonts.css',
  // BEGIN FONT ASSETS — generado por npm run fonts:build
  '/fonts/monoton-latin-400-normal.54dd0ac1cf6c.woff2',
  '/fonts/monoton-latin-ext-400-normal.d6f53ac76feb.woff2',
  '/fonts/space-grotesk-latin-400-normal.65fd17fcbd2e.woff2',
  '/fonts/space-grotesk-latin-500-normal.1b1a8131d9ed.woff2',
  '/fonts/space-grotesk-latin-600-normal.685bbbf69fa6.woff2',
  '/fonts/space-grotesk-latin-700-normal.35f8aec56cfd.woff2',
  '/fonts/space-grotesk-latin-ext-400-normal.a6658ce608a3.woff2',
  '/fonts/space-grotesk-latin-ext-500-normal.ed7e064eda94.woff2',
  '/fonts/space-grotesk-latin-ext-600-normal.0bdc872e2806.woff2',
  '/fonts/space-grotesk-latin-ext-700-normal.7ce350b706d7.woff2',
  '/fonts/space-grotesk-vietnamese-400-normal.4e7fc2191af9.woff2',
  '/fonts/space-grotesk-vietnamese-500-normal.d5eb999d825d.woff2',
  '/fonts/space-grotesk-vietnamese-600-normal.21ea402c1d5a.woff2',
  '/fonts/space-grotesk-vietnamese-700-normal.96a6d0a746a0.woff2',
  '/fonts/vt323-latin-400-normal.8ddbebcc1048.woff2',
  '/fonts/vt323-latin-ext-400-normal.4435f062ebe7.woff2',
  '/fonts/vt323-vietnamese-400-normal.84b335a53b55.woff2',
  // END FONT ASSETS
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('movienight-shell-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Lista cerrada de estáticos: nunca sesión/admin, API, salas, sockets o videos.
  if (req.method !== 'GET' || url.origin !== self.location.origin || !SHELL_URLS.includes(url.pathname)) {
    return;
  }

  const response = fetch(req);
  // Mantener viva la escritura sin bloquear la respuesta ni perder una copia buena
  // por un 404/500, una redirección o un fallo de almacenamiento.
  event.waitUntil(response.then((res) => {
    if (!res.ok || res.redirected) return;
    const copy = res.clone();
    return caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
  }).catch(() => {}));
  event.respondWith(response.catch(() =>
    caches.open(CACHE_NAME).then((cache) => cache.match(req))
  ));
});
