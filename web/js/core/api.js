/**
 * Server API client — the browser side of the ADR 0007 learner-records API
 * (Profiles, State, History, Words, Books) plus the lookup / AI layer
 * (ADR 0008). Every call carries `?profile=` — "who is asking" — except
 * `GET /profiles`. Errors surface as ApiError with the backend's code
 * (errors.js maps it to a learner-facing string).
 */

import { apiErrorToMessage } from './errors.js';

export class ApiError extends Error {
  constructor(code, status) {
    super(apiErrorToMessage(code));
    this.code = code;
    this.status = status;
  }
}

export class ServerApi {
  /**
   * @param {object} [options]
   * @param {typeof fetch} [options.fetchImpl] — seam for tests
   * @param {string} [options.baseUrl] — origin prefix, default '' (same origin)
   * @param {string} [options.profile] — the active Profile id; set after boot
   */
  constructor({ fetchImpl, baseUrl = '', profile = null } = {}) {
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrl = baseUrl;
    this.profile = profile;
  }

  #url(path, { withProfile = true } = {}) {
    const url = new URL(path, `${location.origin}${this.baseUrl || '/'}`);
    if (withProfile && this.profile) url.searchParams.set('profile', this.profile);
    return `${url.pathname}${url.search}`;
  }

  async #request(path, { method = 'GET', body = null, signal, keepalive = false } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body !== null ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== null ? JSON.stringify(body) : undefined,
        signal,
        // The position flush runs in pagehide: without keepalive the browser
        // aborts the request as the navigation starts and the write is lost
        // (#17 acceptance: close mid-debounce must still save the position).
        keepalive,
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new ApiError('network_failure', 0);
    }
    if (response.status === 204) return null;
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // 204 or empty body — fall through
    }
    if (!response.ok) {
      const code = payload && typeof payload.error === 'string' ? payload.error : 'not_found';
      throw new ApiError(code, response.status);
    }
    return payload;
  }

  #withProfile(path) {
    return this.profile ? `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(this.profile)}` : path;
  }

  // -- Profiles / State ----------------------------------------------------

  async profiles() {
    return (await this.#request('/profiles'))?.profiles ?? [];
  }

  async getState() {
    return this.#request(this.#withProfile('/state'));
  }

  async putState(patch) {
    return this.#request(this.#withProfile('/state'), { method: 'PUT', body: patch });
  }

  // -- History -------------------------------------------------------------

  async getHistory() {
    return (await this.#request(this.#withProfile('/history')))?.entries ?? [];
  }

  async addHistory(text) {
    return this.#request(this.#withProfile('/history'), { method: 'POST', body: { text } });
  }

  async patchHistory(entryId, patch) {
    return this.#request(this.#withProfile(`/history/${encodeURIComponent(entryId)}`), {
      method: 'PATCH',
      body: patch,
    });
  }

  async deleteHistory(entryId) {
    await this.#request(this.#withProfile(`/history/${encodeURIComponent(entryId)}`), { method: 'DELETE' });
  }

  // -- Words ---------------------------------------------------------------

  async getWords() {
    return (await this.#request(this.#withProfile('/words')))?.words ?? [];
  }

  async updateWords(add, remove) {
    return this.#request(this.#withProfile('/words'), { method: 'POST', body: { add, remove } });
  }

  // -- Books ----------------------------------------------------------------

  async listBooks() {
    return (await this.#request(this.#withProfile('/books')))?.books ?? [];
  }

  /** Raw-body epub upload with XHR progress (upload events); resolves {book, duplicate}. */
  uploadBook(file, { onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.baseUrl}${this.#withProfile(`/books?name=${encodeURIComponent(file.name)}`)}`);
      xhr.responseType = 'json';
      xhr.upload.addEventListener('progress', (event) => {
        if (onProgress && event.lengthComputable) onProgress(event.loaded / event.total);
      });
      xhr.addEventListener('load', () => {
        const status = xhr.status;
        if (status === 200 || status === 201) {
          resolve({ book: xhr.response?.book ?? null, duplicate: status === 200 });
        } else {
          const code = xhr.response?.error ?? (status === 0 ? 'network_failure' : 'not_found');
          reject(new ApiError(code, status));
        }
      });
      xhr.addEventListener('error', () => reject(new ApiError('network_failure', 0)));
      xhr.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      if (signal) signal.addEventListener('abort', () => xhr.abort());
      xhr.send(file);
    });
  }

  async getBook(bookId) {
    // ?profile= makes the detail carry this Profile's reading position
    // (chapter-level resume, #17 acceptance).
    return this.#request(this.#withProfile(`/books/${encodeURIComponent(bookId)}`));
  }

  async getChapter(bookId, chapterIndex) {
    return this.#request(
      this.#withProfile(`/books/${encodeURIComponent(bookId)}/chapters/${chapterIndex}`),
    );
  }

  async putPosition(bookId, chapter, sentence, { keepalive = false } = {}) {
    await this.#request(this.#withProfile(`/books/${encodeURIComponent(bookId)}/position`), {
      method: 'PUT',
      body: { chapter, sentence },
      // Only the pagehide flush needs keepalive; the debounced path is a
      // normal in-page request.
      keepalive,
    });
  }

  // -- Lookup / AI (ADR 0008) ------------------------------------------------

  async lookup(lang, word, signal) {
    const params = new URLSearchParams({ lang, word });
    const response = await this.fetchImpl(`${this.baseUrl}/lookup?${params}`, { signal });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // non-JSON — fall through
    }
    if (!response.ok) {
      const code = payload?.error ?? 'not_found';
      throw new ApiError(code, response.status);
    }
    return payload;
  }

  async checkWords(lang, words) {
    return (await this.#request('/lookup/check', { method: 'POST', body: { lang, words } }))?.words ?? {};
  }

  async aiExplain(word, sentence, language, signal) {
    return this.#request('/ai', { method: 'POST', body: { word, sentence, language }, signal });
  }
}
