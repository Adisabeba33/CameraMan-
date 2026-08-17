// Оффлайн-оболочка: приложение целиком локальное, сеть нужна только за обновлениями.
//
// Стратегия — «сначала сеть»: приложение весит десятки килобайт, поэтому свежесть
// важнее экономии. Кэш остаётся полноценным запасом на случай офлайна.

const CACHE = 'chrono-camera-v3';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/ui.js',
  './js/camera.js',
  './js/capture.js',
  './js/pipeline.js',
  './js/modes.js',
  './js/gl/glcore.js',
  './js/gl/shaders.js',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  const key = req.mode === 'navigate' ? './index.html' : req;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit || caches.match('./index.html')))
  );
});
