/**
 * History — the local, learner-visible list of texts submitted from the
 * Paste screen, bounded to MAX_ENTRIES. Mirrors dasan's HistoryRepository
 * (dedupe by text with newest timestamp, trimming, deletion) and adds the
 * audio-ownership hook: when entries are removed (delete or trim), the
 * repository reports the removed ids so AudioOwnership can purge audio
 * cache entries that no live entry references.
 */

import { InMemoryHistoryStore } from './history-store.js';

export const MAX_ENTRIES = 50;

export class HistoryRepository {
  /**
   * @param {HistoryStore} store
   * @param {object} [options]
   * @param {number} [options.maxEntries=50]
   * @param {() => number} [options.now=Date.now] — clock seam for tests
   * @param {(removedIds: number[]) => void|Promise<void>} [options.onEntriesRemoved]
   */
  constructor(
    store = new InMemoryHistoryStore(),
    { maxEntries = MAX_ENTRIES, now = Date.now, onEntriesRemoved } = {},
  ) {
    this.store = store;
    this.maxEntries = maxEntries;
    this.now = now;
    this.onEntriesRemoved = onEntriesRemoved ?? (() => {});
  }

  async getRecent() {
    return this.store.listRecent(this.maxEntries);
  }

  /**
   * Adds a text to History. Duplicates collapse into the single existing
   * entry with the newest timestamp; the oldest entries are trimmed past the
   * bound. Returns the (existing or new) entry.
   */
  async add(text) {
    const trimmed = text.trim();
    if (trimmed === '') return null;

    const existing = await this.store.findByText(trimmed);
    if (existing) {
      await this.store.updateTimestamp(existing.id, this.now());
    } else {
      await this.store.insert({ text: trimmed, createdAt: this.now() });
    }

    const removedIds = await this.store.trim(this.maxEntries);
    if (removedIds.length > 0) await this.onEntriesRemoved(removedIds);
    return (await this.store.findByText(trimmed)) ?? null;
  }

  /** Removes one entry; its audio cache entries are purged by the ownership hook. */
  async deleteEntry(id) {
    await this.store.deleteById(id);
    await this.onEntriesRemoved([id]);
  }

  async updateLastSelectedIndex(text, lastSelectedIndex) {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const existing = await this.store.findByText(trimmed);
    if (!existing) return;
    await this.store.updateLastSelectedIndex(existing.id, lastSelectedIndex);
  }

  /** Resolves the entry id for a text, or null when not in History. */
  async entryIdForText(text) {
    const existing = await this.store.findByText(text.trim());
    return existing ? existing.id : null;
  }
}
