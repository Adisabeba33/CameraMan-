// Оффлайн-оболочка: приложение целиком локальное, сеть нужна только за обновлениями.
//
// Стратегия — «сначала сеть»: приложение весит десятки килобайт, поэтому свежесть
// важнее экономии. Кэш остаётся полноценным запасом на случай офлайна.

const CACHE = 'chrono-camera-v5';
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
      // reload — мимо HTTP-кэша: иначе в оболочку попадут файлы разных версий
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
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

  const isNav = req.mode === 'navigate';
  const key = isNav ? './index.html' : req;
  // Модули импортируют друг друга без версий в именах, поэтому любой
  // подтянутый из HTTP-кэша файл может оказаться из другой сборки.
  const net = isNav ? fetch(req) : fetch(req, { cache: 'no-store' });

  e.respondWith(
    net
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
