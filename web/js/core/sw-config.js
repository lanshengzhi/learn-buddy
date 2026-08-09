/**
 * Cache names shared between the Service Worker and the page-side ownership
 * cleanup. Browser-API-free so node tests can import it.
 */

/** Service Worker audio cache — offline replay store, keyed by request URL. */
export const AUDIO_CACHE_NAME = 'learnbuddy-audio-v1';
/** App shell cache (HTML/CSS/JS/manifest/icons). Bumped whenever the shell list changes. */
export const SHELL_CACHE_NAME = 'learnbuddy-shell-v4';

/** Same-origin paths the SW precaches at install (single-page app, ADR 0003). */
export const SHELL_ASSETS = [
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
