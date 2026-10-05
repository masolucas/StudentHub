// Folio service worker.
// For now it only makes the app installable. It deliberately caches nothing,
// so every deploy shows up immediately while we build. Push notifications
// (build step 10) will be handled here.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
