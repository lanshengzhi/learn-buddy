/**
 * History store — the persistence seam behind HistoryRepository.
 *
 * The interface's browser implementation lives in history-idb.js (IndexedDB);
 * an in-memory implementation is used by node tests. Entries are ordered
 * newest-first.
 */

export class HistoryItem {
  /**
   * @param {object} init
   * @param {number} init.id
   * @param {string} init.text
   * @param {number} init.createdAt — epoch millis
   * @param {number|null} [init.lastSelectedIndex]
   * @param {boolean} [init.favorite=false] — star flag; exempt from trimming
   */
  constructor({ id, text, createdAt, lastSelectedIndex = null, favorite = false }) {
    this.id = id;
    this.text = text;
    this.createdAt = createdAt;
    this.lastSelectedIndex = lastSelectedIndex;
    this.favorite = favorite;
  }
}

/**
 * @interface HistoryStore
 * @method listRecent(limit) -> Promise<HistoryItem[]>
 * @method listFavorites() -> Promise<HistoryItem[]>
 * @method findByText(text) -> Promise<HistoryItem|null>
 * @method insert({text, createdAt, lastSelectedIndex}) -> Promise<number> (new id)
 * @method updateTimestamp(id, createdAt) -> Promise<void>
 * @method updateLastSelectedIndex(id, lastSelectedIndex) -> Promise<void>
 * @method setFavorite(id, favorite) -> Promise<void>
 * @method deleteById(id) -> Promise<void>
 * @method trim(limit) -> Promise<number[]> (ids of removed entries; favorites are kept)
 */

/** In-memory HistoryStore used by tests (and as a non-persistent fallback). */
export class InMemoryHistoryStore {
  constructor() {
    this.items = [];
    this.nextId = 1;
  }

  async listRecent(limit) {
    // Newest first; ties on createdAt break by insertion order (id desc),
    // matching the IndexedDB compound index in history-idb.js.
    return [...this.items]
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
      .slice(0, limit);
  }

  async listFavorites() {
    return this.items.filter((i) => i.favorite);
  }

  async findByText(text) {
    return this.items.find((i) => i.text === text) ?? null;
  }

  async insert({ text, createdAt, lastSelectedIndex = null }) {
    const item = new HistoryItem({ id: this.nextId++, text, createdAt, lastSelectedIndex });
    this.items.push(item);
    return item.id;
  }

  async updateTimestamp(id, createdAt) {
    const item = this.items.find((i) => i.id === id);
    if (item) item.createdAt = createdAt;
  }

  async updateLastSelectedIndex(id, lastSelectedIndex) {
    const item = this.items.find((i) => i.id === id);
    if (item) item.lastSelectedIndex = lastSelectedIndex;
  }

  async setFavorite(id, favorite) {
    const item = this.items.find((i) => i.id === id);
    if (item) item.favorite = favorite;
  }

  async deleteById(id) {
    this.items = this.items.filter((i) => i.id !== id);
  }

  async trim(limit) {
    const sorted = [...this.items].sort((a, b) => b.createdAt - a.createdAt);
    const keep = new Set(sorted.slice(0, limit).map((i) => i.id));
    // Favorites are exempt from trimming (ADR 0002).
    for (const item of this.items) {
      if (item.favorite) keep.add(item.id);
    }
    const removed = this.items.filter((i) => !keep.has(i.id)).map((i) => i.id);
    this.items = this.items.filter((i) => keep.has(i.id));
    return removed;
  }
}
