/**
 * @file sw.js
 * @description Service Worker para la PWA "Gestión de Taller OT".
 * Maneja el cache de assets estáticos para funcionamiento offline.
 * @version 1.0
 */

/** @type {string} Nombre del cache actual */
const CACHE_NAME = "taller-ot-v3";

/** @type {string[]} Assets a precachear para uso offline */
const ASSETS = [
 "index.html",
 "manifest.json",
 "https://cdn.tailwindcss.com",
 "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
];

/**
 * Evento 'install' - Se ejecuta cuando el SW se instala por primera vez.
 * Precachea todos los assets definidos en ASSETS para disponibilidad offline.
 * @param {ExtendableEvent} e - Evento de instalación
 */
self.addEventListener("install", (e) => {
 e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

/**
 * Evento 'fetch' - Intercepta todas las peticiones de red.
 * Estrategia: Cache-First (cache primero, fallback a red).
 * @param {FetchEvent} e - Evento de petición HTTP
 */
self.addEventListener("fetch", (e) => {
 e.respondWith(caches.match(e.request).then((res) => res || fetch(e.request)));
});
