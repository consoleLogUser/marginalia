/**
 * sw.js — Le « service worker » : il garde une copie de l'app elle-même (HTML, CSS, JS, icônes)
 * pour qu'elle s'ouvre instantanément, même sans réseau. Tes NOTES, elles, ne passent jamais par ici :
 * elles sont dans IndexedDB et sur GitHub. Les appels à l'API GitHub ne sont jamais mis en cache.
 *
 * VERSION change à chaque modification de l'app (scripts/stamp-sw.js) : le navigateur voit alors un
 * nouveau service worker, l'app te propose « Mettre à jour », et l'ancienne copie est effacée.
 */
const VERSION = 'marginalia-d243438ebbf1';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/api.js',
  'js/core/days.js',
  'js/core/events.js',
  'js/core/fiche.js',
  'js/core/inbox.js',
  'js/core/journal.js',
  'js/core/model.js',
  'js/core/ops.js',
  'js/core/review.js',
  'js/data/github.js',
  'js/data/library.js',
  'js/data/repo.js',
  'js/data/storage.js',
  'js/ui/appliquer.js',
  'js/ui/connexion.js',
  'js/ui/core.js',
  'js/ui/lire.js',
  'js/ui/progres.js',
  'js/ui/reglages.js',
  'js/ui/retenir.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon.svg',
  'icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('marginalia-') && key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// L'app demande la mise à jour quand tu touches « Mettre à jour ».
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // api.github.com : toujours le réseau, jamais le cache
  if (!SHELL.some((path) => url.pathname.endsWith(path.replace(/^\.\//, '/'))) && request.mode !== 'navigate') return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (hit) return hit;
    try {
      return await fetch(request);
    } catch (err) {
      if (request.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      throw err;
    }
  })());
});
