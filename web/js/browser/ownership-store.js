/**
 * AudioOwnership browser store — persists the reference map in IndexedDB and
 * purges orphaned audio from the Service Worker cache. The pure reference
 * logic lives in core/audio-ownership.js; this file is the browser adapter.
 */

import { AUDIO_CACHE_NAME } from '../core/sw-config.js';
import { record, forgetEntries, refsToObject, refsFromObject } from '../core/audio-ownership.js';

const DB_NAME = 'learnbuddy-ownership';
const STORE_NAME = 'audio-ownership';
const RECORD_KEY = 'refs';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getRecord(db) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(RECORD_KEY);
    request.onsuccess = () => resolve(request.result ?? {});
    request.onerror = () => reject(request.error);
  });
}

function putRecord(db, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(value, RECORD_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export class AudioOwnershipStore {
  #dbPromise = null;

  #db() {
    if (!this.#dbPromise) this.#dbPromise = openDb();
    return this.#dbPromise;
  }

  async #load() {
    const db = await this.#db();
    return refsFromObject(await getRecord(db));
  }

  async #save(refs) {
    const db = await this.#db();
    await putRecord(db, refsToObject(refs));
  }

  /** Records that a history entry references an audio URL. */
  async record(url, entryId) {
    const refs = await this.#load();
    record(refs, url, entryId);
    await this.#save(refs);
  }

  /**
   * Drops removed entry ids and purges audio cache entries that no live
   * history entry references anymore (the ownership lifetime rule).
   * @param {number[]} entryIds
   */
  async forgetEntries(entryIds) {
    if (entryIds.length === 0) return;
    const refs = await this.#load();
    const orphaned = forgetEntries(refs, entryIds);
    await this.#save(refs);
    await this.purgeFromCache(orphaned);
  }

  /** Deletes the given URLs from the Service Worker audio cache. */
  async purgeFromCache(urls) {
    if (urls.length === 0) return;
    if (!('caches' in globalThis)) return;
    const cache = await caches.open(AUDIO_CACHE_NAME);
    await Promise.all(urls.map((url) => cache.delete(url)));
  }
}
