// Very small offline shell: caches core assets so the app boots offline
const CACHE = 'agent-shell-v1';
const CORE = [
'/agent/index.html',
'/agent/style.css',
'/agent/main.js',
'/manifest.webmanifest'
];


self.addEventListener('install', (e) => {
e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)));
});


self.addEventListener('activate', (e) => {
e.waitUntil(
caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
);
});


self.addEventListener('fetch', (e) => {
const { request } = e;
// Network first for API, cache first for static assets
if (request.url.includes('/.netlify/functions/')) return;
e.respondWith(
caches.match(request).then((cached) => cached || fetch(request))
);
});