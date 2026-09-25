/**
 * Server API client — the browser side of the ADR 0007 learner-records API
 * (Profiles, State, History, Words, Books) plus the lookup / AI layer
 * (ADR 0008). Every call carries `?profile=` — "who is asking" — except
 * `GET /profiles`. Errors surface as ApiError with the backend's code
 * (errors.js maps it to a learner-facing string).
 */

import { apiErrorToMessage } from './errors.js';

export const DEFAULT_EXPLANATION_LOCALE = 'zh-CN';

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
   * @param {string} [options.explanationLocale] — learner-facing explanation locale
   */
  constructor({ fetchImpl, baseUrl = '', profile = null, explanationLocale = DEFAULT_EXPLANATION_LOCALE } = {}) {
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrl = baseUrl;
    this.profile = profile;
    this.explanationLocale = explanationLocale || DEFAULT_EXPLANATION_LOCALE;
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

  /** Compile the exact local BookContext used by the Read selection action. */
  async compileBookContext(bookId, context) {
    return (await this.#request(
      this.#withProfile(`/books/${encodeURIComponent(bookId)}/context`),
      { method: 'POST', body: { bookId, ...context } },
    ))?.context ?? null;
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

  // -- Chat / Conversations (ticket #47) ------------------------------------
  // Conversations are LearnBuddy-owned server records, scoped by this
  // instance's profile like every other learner record.

  async listConversations() {
    return (await this.#request(this.#withProfile('/conversations')))?.conversations ?? [];
  }

  async createConversation() {
    return (await this.#request(this.#withProfile('/conversations'), { method: 'POST', body: {} }))
      ?.conversation ?? null;
  }

  async getConversation(conversationId) {
    return (await this.#request(
      this.#withProfile(`/conversations/${encodeURIComponent(conversationId)}`),
    ))?.conversation ?? null;
  }

  /** One turn: the server appends the reply and answers the full Conversation. */
  async sendChatMessage(conversationId, text) {
    return this.#request(this.#withProfile(`/conversations/${encodeURIComponent(conversationId)}/messages`), {
      method: 'POST',
      body: { text },
    });
  }

  // -- BookConversation (Read-owned, ticket #71/#72) -------------------------

  async listBookConversations(bookId) {
    return (await this.#request(
      this.#withProfile(`/books/${encodeURIComponent(bookId)}/book-conversations`),
    ))?.conversations ?? [];
  }

  async openBookConversation(bookId, { newConversation = false } = {}) {
    return (await this.#request(
      this.#withProfile(`/books/${encodeURIComponent(bookId)}/book-conversations`),
      { method: 'POST', body: { new: newConversation } },
    ))?.conversation ?? null;
  }

  async getBookConversation(conversationId) {
    return (await this.#request(
      this.#withProfile(`/book-conversations/${encodeURIComponent(conversationId)}`),
    ))?.conversation ?? null;
  }

  async getNotebookSync(bookId) {
    return this.#request(this.#withProfile(`/books/${encodeURIComponent(bookId)}/notebook-sync`));
  }

  async syncNotebook(bookId, { confirmUpload, retry = false } = {}) {
    return this.#request(
      this.#withProfile(`/books/${encodeURIComponent(bookId)}/notebook-sync`),
      { method: 'POST', body: { confirmUpload, retry } },
    );
  }

  async cleanupNotebookRemote(bookId) {
    return this.#request(
      this.#withProfile(`/books/${encodeURIComponent(bookId)}/notebook-sync/remote-cleanup`),
      { method: 'POST', body: { confirm: true } },
    );
  }

  async cancelStudyJob(jobId) {
    return (await this.#request(this.#withProfile(`/study-jobs/${encodeURIComponent(jobId)}/cancel`), {
      method: 'POST', body: { confirm: true },
    }))?.job ?? null;
  }

  async retryStudyJob(jobId) {
    return (await this.#request(this.#withProfile(`/study-jobs/${encodeURIComponent(jobId)}/retry`), {
      method: 'POST', body: {},
    }))?.job ?? null;
  }

  async listStudyJobs(bookId) {
    return (await this.#request(this.#withProfile(`/books/${encodeURIComponent(bookId)}/study-jobs`)))?.jobs ?? [];
  }

  async listStudyArtifacts(bookId) {
    return (await this.#request(this.#withProfile(`/books/${encodeURIComponent(bookId)}/study-artifacts`)))?.artifacts ?? [];
  }

  async getStudyArtifact(artifactId) {
    return (await this.#request(this.#withProfile(`/study-artifacts/${encodeURIComponent(artifactId)}`)))?.artifact ?? null;
  }

  async deleteStudyArtifact(artifactId) {
    await this.#request(this.#withProfile(`/study-artifacts/${encodeURIComponent(artifactId)}`), { method: 'DELETE' });
  }

  async regenerateStudyArtifact(artifactId) {
    return this.#request(this.#withProfile(`/study-artifacts/${encodeURIComponent(artifactId)}/regenerate`), { method: 'POST', body: {} });
  }

  async remoteCleanupStudyArtifact(artifactId) {
    return this.#request(this.#withProfile(`/study-artifacts/${encodeURIComponent(artifactId)}/remote-cleanup`), { method: 'POST', body: { confirm: true } });
  }

  studyArtifactDownloadUrl(artifactId) {
    return `${this.baseUrl}${this.#withProfile(`/study-artifacts/${encodeURIComponent(artifactId)}/download`)}`;
  }

  async recheckStudyJob(jobId) {
    return (await this.#request(this.#withProfile(`/study-jobs/${encodeURIComponent(jobId)}/recheck`), {
      method: 'POST', body: {},
    }))?.job ?? null;
  }

  async resumeBookConversation(conversationId) {
    return (await this.#request(
      this.#withProfile(`/book-conversations/${encodeURIComponent(conversationId)}/resume`),
      { method: 'POST', body: {} },
    ))?.conversation ?? null;
  }

  async deleteBookConversation(conversationId) {
    await this.#request(
      this.#withProfile(`/book-conversations/${encodeURIComponent(conversationId)}`),
      { method: 'DELETE' },
    );
  }

  /**
   * Stream one BookConversation turn. The host owns the context snapshot and
   * persists only a completed turn; callers receive the same NDJSON boundary
   * as the Python API without treating model text as product instructions.
   */
  async streamBookConversationMessage(conversationId, { bookId, text, context, onEvent, signal }) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${this.#withProfile(
        `/book-conversations/${encodeURIComponent(conversationId)}/messages`,
      )}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ bookId, text, context }),
        signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new ApiError('network_failure', 0);
    }

    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch { /* fixed fallback below */ }
      throw new ApiError(payload?.error ?? 'not_found', response.status);
    }
    if (!response.body?.getReader) throw new ApiError('ai_upstream_error', response.status);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let completed = false;
    const dispatch = async (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { throw new ApiError('ai_upstream_error', response.status); }
      await onEvent?.(event);
      if (event.type === 'done') completed = true;
      if (event.type === 'error') throw new ApiError(event.code ?? 'ai_upstream_error', response.status);
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) await dispatch(line);
        if (done) break;
      }
      if (pending) await dispatch(pending);
      if (!completed) throw new ApiError('ai_upstream_error', response.status);
    } finally {
      reader.releaseLock?.();
    }
  }

  // -- NotebookLM StudyJobs (#76) -------------------------------------------

  async createStudyJob(bookId, request, { confirmWholeBook = false } = {}) {
    return this.#request(
      this.#withProfile(`/books/${encodeURIComponent(bookId)}/study-jobs`),
      { method: 'POST', body: { request, confirmWholeBook } },
    );
  }

  async getStudyJob(jobId) {
    return this.#request(this.#withProfile(`/study-jobs/${encodeURIComponent(jobId)}`));
  }

  async reconcileStudyJob(jobId) {
    return this.#request(
      this.#withProfile(`/study-jobs/${encodeURIComponent(jobId)}/reconcile`),
      { method: 'POST', body: {} },
    );
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

  async aiExplain(word, sentence, language, signal, explanationLocale = this.explanationLocale) {
    return this.#request('/ai', {
      method: 'POST',
      body: { word, sentence, language, explanationLocale },
      signal,
    });
  }
}
