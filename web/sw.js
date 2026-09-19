/**
 * Service Worker — static app shell only (ADR 0007): the browser keeps no
 * learner state and no audio. Audio requests are never intercepted; replays
 * need the LAN and the server's audio cache.
 *
 * - navigations: network-first with cached fallback, so app updates flow on
 *   the LAN and the shell still opens offline.
 * - static assets: network-first with cached fallback. Cache-first here was
 *   the bug: the SW only re-installs when sw.js itself changes, so a deploy
 *   that left sw.js untouched kept serving stale JS/CSS until a manual cache
 *   clear. Network-first makes the deployed code live on the next load; the
 *   precached shell is only the offline fallback.
 */

// The shell list is duplicated from js/core/sw-config.js (classic worker: no
// module imports). Keep the two in sync; the cache name is bumped whenever
// the shell list changes.
const SHELL_CACHE = 'learnbuddy-shell-v6';
// Replaced by scripts/deploy.sh on every deploy so the browser detects a new
// SW (bytes changed), re-precaches the fresh shell, and purges old caches.
const DEPLOY_STAMP = 'dev';
// Keep in sync with js/core/sw-config.js.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/bootstrap.js',
  '/js/book.js',
  '/js/player.js',
  '/js/core/api.js',
  '/js/core/segmentation.js',
  '/js/core/language.js',
  '/js/core/words.js',
  '/js/core/history-store.js',
  '/js/core/history-repository.js',
  '/js/core/rate-presets.js',
  '/js/core/loop-mode.js',
  '/js/core/errors.js',
  '/js/core/tts-client.js',
  '/js/core/playback-preferences.js',
  '/js/core/reader-controller.js',
  '/js/core/visual-follow.js',
  '/js/core/sw-config.js',
  '/js/browser/profile.js',
  '/js/browser/history-api.js',
  '/js/browser/server-playback-preferences.js',
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
        Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // /tts and the learner-records API are network-only.
  if (url.pathname === '/tts' || url.pathname === '/lookup' || url.pathname === '/lookup/check' || url.pathname === '/state') {
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(serveNavigation(request));
    return;
  }
  event.respondWith(serveStatic(request));
});

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
  try {
    const response = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await caches.open(SHELL_CACHE)).match(request);
  }
}
