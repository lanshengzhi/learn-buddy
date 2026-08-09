/**
 * Service Worker — app shell caching + offline replay audio cache.
 *
 * - /tts requests (audio, keyed by the text|voice|rate request URL):
 *   cache-first with network store on miss. A sentence is replayable offline
 *   exactly while its History entry lives; the page purges orphaned entries
 *   via the audio cache name below (audio-ownership semantics).
 * - navigations: network-first with cached fallback, so app updates flow on
 *   the LAN and the shell still opens offline.
 * - static assets: cache-first over the precached shell.
 */

const SHELL_CACHE = 'learnbuddy-shell-v3';
const AUDIO_CACHE = 'learnbuddy-audio-v1';
// Keep in sync with js/core/sw-config.js.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/bootstrap.js',
  '/js/player.js',
  '/js/core/segmentation.js',
  '/js/core/language.js',
  '/js/core/history-store.js',
  '/js/core/history-repository.js',
  '/js/core/audio-ownership.js',
  '/js/core/rate-presets.js',
  '/js/core/loop-mode.js',
  '/js/core/errors.js',
  '/js/core/tts-client.js',
  '/js/core/playback-preferences.js',
  '/js/core/reader-controller.js',
  '/js/core/sw-config.js',
  '/js/browser/history-idb.js',
  '/js/browser/ownership-store.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== AUDIO_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/tts') {
    event.respondWith(serveAudio(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(serveNavigation(request));
    return;
  }
  event.respondWith(serveStatic(request));
});

async function serveAudio(request) {
  const cache = await caches.open(AUDIO_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('', { status: 503, statusText: 'Offline and not cached' });
  }
}

async function serveNavigation(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, response.clone());
    return response;
  } catch {
    return (await caches.open(SHELL_CACHE)).match('/index.html');
  }
}

async function serveStatic(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
