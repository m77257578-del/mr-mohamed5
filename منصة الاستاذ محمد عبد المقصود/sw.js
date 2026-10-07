const CACHE = 'ostaz-platform-v2';
const ROOT = self.registration.scope;
const SHELL = [ROOT, new URL('manifest.webmanifest', ROOT).href, new URL('app-icon-192.png', ROOT).href, new URL('app-icon-512.png', ROOT).href];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/') || url.pathname.startsWith('/public-files/') || url.pathname === '/hero') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(ROOT, response.clone()));
      return response;
    }).catch(() => caches.match(ROOT)));
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});