const CACHE_NAME = 'mis-pelis-v4';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './config.js',
    './icono.png',
    './manifest.json'
];

// Instalación: Cachear activos estáticos
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Activación: Limpiar caches antiguos y tomar control inmediato
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        }).then(() => self.clients.claim())
    );
});

// Estrategia: Network First con fallback a caché para todo (evita que el código quede obsoleto)
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response && response.status === 200) {
                    const resClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
