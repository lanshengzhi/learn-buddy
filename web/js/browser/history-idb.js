/**
 * IndexedDB-backed HistoryStore (the browser implementation of the
 * HistoryStore interface; tests use InMemoryHistoryStore). Records mirror
 * dasan's HistoryItemEntity: auto-increment id, text, createdAt, and the
 * learner's last selected sentence index.
 */

import { HistoryItem } from '../core/history-store.js';

const DB_NAME = 'learnbuddy';
const STORE_NAME = 'history';
const DB_VERSION = 2; // v2: records gain the `favorite` flag (defaults to false on old records)

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE_NAME)) return;
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      store.createIndex('text', 'text', { unique: true });
      store.createIndex('createdAt', 'createdAt');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const result = fn(store);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDbHistoryStore {
  async #db() {
    if (!this._db) this._db = await openDb();
    return this._db;
  }

  async listRecent(limit) {
    const db = await this.#db();
    const items = await tx(db, 'readonly', (store) => requestToPromise(store.getAll()));
    return items
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
      .slice(0, limit)
      .map(toItem);
  }

  async listFavorites() {
    const db = await this.#db();
    const items = await tx(db, 'readonly', (store) => requestToPromise(store.getAll()));
    return items.filter((i) => i.favorite).map(toItem);
  }

  async findByText(text) {
    const db = await this.#db();
    const index = db.transaction(STORE_NAME).objectStore(STORE_NAME).index('text');
    const item = await requestToPromise(index.get(text));
    return item ? toItem(item) : null;
  }

  async insert({ text, createdAt, lastSelectedIndex = null }) {
    const db = await this.#db();
    const id = await tx(db, 'readwrite', (store) =>
      requestToPromise(store.add({ text, createdAt, lastSelectedIndex })),
    );
    return id;
  }

  async updateTimestamp(id, createdAt) {
    const db = await this.#db();
    await tx(db, 'readwrite', (store) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const item = request.result;
        if (item) store.put({ ...item, createdAt });
      };
      return request;
    });
  }

  async updateLastSelectedIndex(id, lastSelectedIndex) {
    const db = await this.#db();
    await tx(db, 'readwrite', (store) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const item = request.result;
        if (item) store.put({ ...item, lastSelectedIndex });
      };
      return request;
    });
  }

  async setFavorite(id, favorite) {
    const db = await this.#db();
    await tx(db, 'readwrite', (store) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const item = request.result;
        if (item) store.put({ ...item, favorite });
      };
      return request;
    });
  }

  async deleteById(id) {
    const db = await this.#db();
    await tx(db, 'readwrite', (store) => requestToPromise(store.delete(id)));
  }

  async trim(limit) {
    const db = await this.#db();
    const items = await tx(db, 'readonly', (store) => requestToPromise(store.getAll()));
    const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    const keep = new Set(sorted.slice(0, limit).map((i) => i.id));
    // Favorites are exempt from trimming (ADR 0002).
    for (const item of items) {
      if (item.favorite) keep.add(item.id);
    }
    const removed = items.filter((i) => !keep.has(i.id)).map((i) => i.id);
    if (removed.length > 0) {
      await tx(db, 'readwrite', (store) => {
        removed.forEach((id) => store.delete(id));
        return Promise.resolve();
      });
    }
    return removed;
  }
}

function toItem(record) {
  return new HistoryItem({
    id: record.id,
    text: record.text,
    createdAt: record.createdAt,
    lastSelectedIndex: record.lastSelectedIndex ?? null,
    favorite: record.favorite ?? false,
  });
}
