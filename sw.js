/**
 * Offline support: the app shell is served from cache and refreshed in the background.
 * Live data (TUMonline, MVG, Mensa…) has its own last-known-copy fallback in cachedFetch.
 */
const CACHE_PREFIX = 'tum-calendar-';
const SHELL_CACHE = `${CACHE_PREFIX}v3`;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/timetable.js', 'js/calendar.js', 'js/services.js', 'js/autopilot.js', 'js/squad.js', 'js/state.js', 'js/app.js',
  'js/seed.js', 'icons/icon.svg', 'icons/icon-192.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

// Only our own old caches: other projects on the same github.io origin keep theirs
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys
      .filter(k => (k.startsWith(CACHE_PREFIX) || k.startsWith('flight-deck-cupertino')) && k !== SHELL_CACHE)
      .map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Stale-while-revalidate for our own files and Google Fonts; everything else goes to the network
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const ours = url.origin === self.location.origin && url.pathname.startsWith(new URL('./', self.location).pathname);
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

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then(list =>
    list.length ? list[0].focus() : self.clients.openWindow('./')));
});
