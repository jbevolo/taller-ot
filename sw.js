// Cache only the public application shell, never Auth, REST, Storage, or user data.
const SCOPE = self.registration.scope;
const CACHE_PREFIX = `taller-ot:${SCOPE}:`;
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const SHELL_URL = new URL('index.html', SCOPE).href;
const CORE_ASSETS = ['index.html', 'manifest.json', 'icon.png'].map(path => new URL(path, SCOPE).href);
const CDN_ASSETS = [
    'https://cdn.tailwindcss.com/',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(CORE_ASSETS.map(url => new Request(url, { cache: 'reload' })));
        // A temporary CDN outage must not prevent an otherwise valid shell update.
        await Promise.all(CDN_ASSETS.map(url => cache.add(url).catch(() => {})));
        // Do not force activation over an open tab containing an unsaved order.
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name =>
            (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) || name === 'taller-ot-v1'
        ).map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

async function networkFirst(request, cacheKey) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (response.ok) {
            // Storage exhaustion must not discard a successful network response.
            try { await cache.put(cacheKey, response.clone()); } catch {}
            return response;
        }
        return (await cache.match(cacheKey)) || response;
    } catch (error) {
        const cached = await cache.match(cacheKey);
        if (cached) return cached;
        throw error;
    }
}

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    const isShell = url.origin === new URL(SCOPE).origin &&
        (url.pathname === new URL(SHELL_URL).pathname || url.href.split('?')[0] === SCOPE);
    if (event.request.mode === 'navigate' && isShell) {
        // Customer-link queries use the same static shell, including while offline.
        event.respondWith(networkFirst(event.request, SHELL_URL));
    } else if (CORE_ASSETS.includes(url.href) || CDN_ASSETS.includes(url.href)) {
        event.respondWith(networkFirst(event.request, url.href));
    }
});
