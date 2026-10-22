/**
 * Offline support: the app shell is served from cache and refreshed in the background.
 * Live data (TUMonline, MVG, Mensa…) has its own last-known-copy fallback in cachedFetch,
 * so cross-origin requests pass straight through here.
 */
const SHELL_CACHE = 'flight-deck-shell-v1';
const SHELL = [
  './', 'index.html', 'style.css', 'data.js', 'calendar.js', 'services.js', 'optimizer.js', 'squad.js',
  'settings.js', 'today.js', 'palette.js', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Stale-while-revalidate for our own files and Google Fonts; everything else goes to the network
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const ours = url.origin === self.location.origin;
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (event.request.method !== 'GET' || (!ours && !fonts)) return;
  event.respondWith(caches.open(SHELL_CACHE).then(async cache => {
    const hit = await cache.match(event.request, { ignoreSearch: ours });
    const fresh = fetch(event.request).then(res => {
      if (res.ok || res.type === 'opaque') cache.put(event.request, res.clone());
      return res;
    }).catch(() => hit);
    return hit || fresh;
  }));
});

// Tapping a "leave now" notification opens the app on Today
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then(list =>
    list.length ? list[0].focus() : self.clients.openWindow('./')));
});
