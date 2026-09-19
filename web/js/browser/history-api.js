/**
 * History store over the server API (ADR 0007): History is a per-Profile
 * learner record on claw, not IndexedDB. The HistoryStore interface
 * (history-store.js) is preserved — same methods, different IO — so
 * HistoryRepository's dedupe/trim/favorite semantics are unchanged.
 *
 * The server does the dedupe+trim inside POST /history; the repository's
 * split insert→trim sequence maps onto it (trim() is a no-op here because
 * the POST response already carries which entries were trimmed).
 */

export class ApiHistoryStore {
  constructor(api) {
    this.api = api;
    // The last POST's trimmed ids, exposed for trim() (the ownership purge
    // hook is retired with ADR 0007; consumers ignore the ids today).
    this.lastTrimmed = [];
  }

  async listRecent(limit) {
    const entries = await this.api.getHistory();
    return entries.slice(0, limit).map(toHistoryItem);
  }

  async listFavorites() {
    const entries = await this.api.getHistory();
    return entries.filter((entry) => entry.favorite).map(toHistoryItem);
  }

  async findByText(text) {
    const entries = await this.api.getHistory();
    const entry = entries.find((entry) => entry.text === text);
    return entry ? toHistoryItem(entry) : null;
  }

  async insert({ text }) {
    const payload = await this.api.addHistory(text);
    this.lastTrimmed = payload?.trimmed ?? [];
    return toHistoryItem(payload?.entry ?? { id: -1, text, createdAt: Date.now() });
  }

  async updateTimestamp() {
    // The server already bumps the timestamp on duplicate POSTs; nothing to do.
  }

  async updateLastSelectedIndex(id, lastSelectedIndex) {
    await this.api.patchHistory(id, { selectedIndex: lastSelectedIndex });
  }

  async setFavorite(id, favorite) {
    await this.api.patchHistory(id, { favorite });
  }

  async deleteById(id) {
    await this.api.deleteHistory(id);
  }

  async trim() {
    const trimmed = this.lastTrimmed;
    this.lastTrimmed = [];
    return trimmed;
  }
}

function toHistoryItem(entry) {
  return {
    id: entry.id,
    text: entry.text,
    createdAt: entry.createdAt,
    lastSelectedIndex: entry.selectedIndex ?? null,
    favorite: Boolean(entry.favorite),
  };
}
