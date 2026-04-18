const CACHE_NAME = 'mis-pelis-v1';
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

// Activación: Limpiar caches antiguos
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        })
    );
});

// Estrategia diferenciada para mayor velocidad
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url); // Use URL constructor for proper parsing
    const isApi = url.host.includes('api.themoviedb.org') || url.host.includes('martiperpocketbase');

    if (isApi) {
        // ESTRATEGIA: NETWORK FIRST para datos (queremos info fresca)
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const resClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
    } else {
        // ESTRATEGIA: CACHE FIRST para activos (arranque instantáneo)
        event.respondWith(
            caches.match(event.request)
                .then(cachedResponse => {
                    if (cachedResponse) return cachedResponse;

                    return fetch(event.request).then(response => {
                        const resClone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
                        return response;
                    });
                })
        );
    }
});
