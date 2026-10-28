/* 捞一条 service worker — offline cache + notifications */
const CACHE = 'laoyitiao-v1';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// network-first for same-origin navigations & assets, fall back to cache
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});

// ---- notifications ----
// The page asks the SW to show a reminder (local mode). Later, a push server can
// send the same payload through the 'push' event below.
self.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'show-reminder') {
    e.waitUntil(showReminder(msg.payload));
  }
});

self.addEventListener('push', (e) => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch (_) { payload = { body: e.data && e.data.text() }; }
  e.waitUntil(showReminder(payload));
});

function showReminder(p) {
  p = p || {};
  const title = p.title || '捞一条';
  const options = {
    body: p.body || '有一条在等你。',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: p.tag || 'laoyitiao-reminder',
    renotify: true,
    data: { itemId: p.itemId || null, url: p.url || null, sceneId: p.sceneId || null },
    actions: [
      { action: 'watch', title: '现在看' },
      { action: 'later', title: '现在不方便' },
      { action: 'dismiss', title: '不看了' }
    ]
  };
  return self.registration.showNotification(title, options);
}

self.addEventListener('notificationclick', (e) => {
  const n = e.notification;
  const action = e.action || 'open';
  const data = n.data || {};
  n.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const params = new URLSearchParams({ nAction: action, itemId: data.itemId || '', sceneId: data.sceneId || '' });
    const target = './?' + params.toString() + '#/';
    if (all.length) {
      const c = all[0];
      c.postMessage({ type: 'notification-action', action, itemId: data.itemId, sceneId: data.sceneId, url: data.url });
      try { await c.focus(); } catch (_) {}
      if (action === 'watch' && data.url) {
        try { await self.clients.openWindow(data.url); } catch (_) {}
      }
      return;
    }
    if (action === 'watch' && data.url) {
      await self.clients.openWindow(target);
      try { await self.clients.openWindow(data.url); } catch (_) {}
      return;
    }
    await self.clients.openWindow(target);
  })());
});
