/**
 * Shelf — the A-layout bookshelf model (ticket #46): the current Person's
 * Book list with per-Person Reading positions, plus the EPUB upload
 * lifecycle. DOM-free; the /next adapter (web/next/shelf.js) subscribes via
 * onEvent and renders from state, following the ShellController pattern.
 *
 * All data comes from the existing ServerApi (/books): positions are read
 * and stored per Profile by the server, and the api instance here carries
 * the active profile — so switching Persons can never cross positions.
 * A failed refresh or upload keeps the last good book list; stored books
 * and positions are never touched by a failed upload (the server validates
 * before writing, and this model only replaces `books` on success).
 */

/** One-line progress label for a shelf entry. */
export function readingLabel(book) {
  return book.reading ? `读到第 ${book.reading.chapter + 1} 章` : '未开始';
}

/** 0..1 fill for the progress track, from the per-Person Reading position. */
export function readingFraction(book) {
  if (!book.reading || !book.chapters) return 0;
  return Math.min(1, (book.reading.chapter + 1) / book.chapters);
}

export class Shelf {
  /**
   * @param {object} deps
   * @param {{listBooks: () => Promise<object[]>, uploadBook: (file: object, options: object) => Promise<{book: object, duplicate: boolean}>}} deps.api — ServerApi-shaped, profile already set
   * @param {(bookId: string) => Promise<void>} deps.openBook — the reader seam; resolves after the chapter loaded (open failures are toasted by the reader, not thrown)
   * @param {(event: object) => void} [deps.onEvent] — `{type:'shelf-changed'}` after every state mutation
   */
  constructor({ api, openBook, onEvent = () => {} }) {
    this.api = api;
    this.openBook = openBook;
    this.onEvent = onEvent;
    this.state = {
      status: 'idle', // idle | loading | ready | error
      books: [],
      error: null, // learner-facing line when status === 'error'
      activeBookId: null, // the Book open in the reading workspace
      upload: null, // { fraction } while an upload runs
      notice: null, // outcome line: added / duplicate / upload failed
    };
  }

  /** Reloads the shelf from the server; a failure keeps the last good list. */
  async refresh() {
    this.#patch({ status: 'loading', error: null });
    try {
      const books = await this.api.listBooks();
      this.#patch({ status: 'ready', books });
    } catch (error) {
      this.#patch({ status: 'error', error: error.message ?? '书架加载失败。' });
    }
  }

  /** Opens a Book in the reading workspace and marks it on the shelf. */
  async open(bookId) {
    await this.openBook(bookId);
    this.#patch({ activeBookId: bookId });
  }

  /** Syncs the active marker when a Book was opened outside the shelf. */
  markActive(bookId) {
    if (bookId === this.state.activeBookId) return;
    this.#patch({ activeBookId: bookId });
  }

  /**
   * Uploads an EPUB for the current Person (raw body + ?name= via
   * ServerApi's XHR path, 256 MB cap server-side). Success refreshes the
   * shelf; failure only sets the notice — the shelf itself is unchanged.
   */
  async upload(file) {
    this.#patch({ upload: { fraction: 0 }, notice: null });
    try {
      const { duplicate } = await this.api.uploadBook(file, {
        onProgress: (fraction) => this.#patch({ upload: { fraction } }),
      });
      this.#patch({ upload: null, notice: duplicate ? '书库里已有这本书。' : '已加入书架。' });
      await this.refresh();
    } catch (error) {
      if (error.name === 'AbortError') {
        this.#patch({ upload: null });
        return;
      }
      this.#patch({ upload: null, notice: error.message ?? '上传失败。' });
    }
  }

  #patch(patch) {
    this.state = { ...this.state, ...patch };
    this.onEvent({ type: 'shelf-changed' });
  }
}
