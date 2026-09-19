/**
 * Cache names shared between the Service Worker and the page side.
 * Browser-API-free so node tests can import it.
 *
 * ADR 0007: the browser keeps no learner state and no audio — the Service
 * Worker caches only the static app shell. Audio replays go through the
 * server's audio cache over the LAN.
 */

/** App shell cache (HTML/CSS/JS/manifest/icons). Bumped whenever the shell list changes. */
export const SHELL_CACHE_NAME = 'learnbuddy-shell-v6';

/** Same-origin paths the SW precaches at install (single-page app, ADR 0003). */
export const SHELL_ASSETS = [
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
