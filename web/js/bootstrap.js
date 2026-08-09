/**
 * Bootstrap — shared browser wiring: history repository with audio-ownership
 * cleanup, IndexedDB stores, and Service Worker
 * registration (secure contexts only; the plain-HTTP LAN origin simply runs
 * without offline replay — see the PWA ticket).
 */

import { HistoryRepository } from './core/history-repository.js';
import { IndexedDbHistoryStore } from './browser/history-idb.js';
import { AudioOwnershipStore } from './browser/ownership-store.js';

export const audioOwnership = new AudioOwnershipStore();

export const historyRepository = new HistoryRepository(new IndexedDbHistoryStore(), {
  onEntriesRemoved: (removedIds) => audioOwnership.forgetEntries(removedIds),
});

export function registerServiceWorker() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Registration failure is non-fatal; the app works without offline replay.
    });
  }
}
