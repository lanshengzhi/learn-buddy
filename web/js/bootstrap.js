/**
 * Bootstrap — browser wiring: the server API client, the History repository
 * over the API store, the Service Worker shell registration (secure contexts
 * only; the plain-HTTP LAN origin simply runs without a precached shell).
 * Learner records live only on the server (ADR 0007): no IndexedDB stores,
 * no audio ownership — the browser keeps just `lb.profile` (profile.js).
 */

import { HistoryRepository } from './core/history-repository.js';
import { ApiHistoryStore } from './browser/history-api.js';

export function createHistoryRepository(api) {
  return new HistoryRepository(new ApiHistoryStore(api));
}

export function registerServiceWorker() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Registration failure is non-fatal; the shell cache is a nicety.
    });
  }
}
