/**
 * BookView — the reading surface for Books (ticket #19, layout decisions in
 * #12): chapter body as sentences of word spans, lookup by gesture
 * (hover 320 ms on fine pointers, long-press 420 ms on touch, selection as a
 * supplement; tapping a sentence stays the play command), the two-tab lookup
 * card (词条 + AI), the lazy 标生词 batch check, chapter navigation, the TOC,
 * and the shared Library.
 *
 * Playback itself stays in the app's single ReaderController / bottom bar —
 * this view only renders state and reports the Reading position, which is
 * the server's record (ADR 0007): debounced 1.2 s writes, flushed on chapter
 * switch and page hide. Word states go to /words and apply to every Book of
 * the Profile.
 */

import { wordTokens, nextUnknownWord } from './core/words.js';
import { defaultVoiceFor } from './core/language.js';

const HOVER_MS = 320;
const HOLD_MS = 420;
const POSITION_DEBOUNCE_MS = 1200;
const MAX_CHECK_BATCH = 180;

const HL_MODES = ['underline', 'dim', 'off'];
const HL_LABELS = { underline: '标生词', dim: '淡已认识', off: '提示：关' };

export class BookView {
  /**
   * @param {object} deps
   * @param {import('./core/api.js').ServerApi} deps.api
   * @param {() => boolean} deps.isWide — wide layout (the aside is visible)
   * @param {(mode: 'book' | 'cards') => void} deps.onView — surface switch hook
   * @param {(sentences: object[], reading: number, locale: string, restored: boolean) => Promise<void>} deps.loadChapter — hands the chapter to the shared controller
   * @param {() => void} deps.followPlaying — re-run the visual follow after layout changes
   * @param {(message: string) => void} deps.toast
   * @param {Set<string>} deps.knownWords — the Profile's 我认识 keys (mutated in place)
   * @param {() => string} deps.rateSsml — the current Rate preset's SSML value
   */
  constructor({ api, isWide, onView, loadChapter, followPlaying, toast, onSentenceTap, knownWords, rateSsml }) {
    this.api = api;
    this.isWide = isWide;
    this.onView = onView;
    this.loadChapter = loadChapter;
    this.followPlaying = followPlaying;
    this.toast = toast;
    this.onSentenceTap = onSentenceTap;
    this.knownWords = knownWords;
    this.rateSsml = rateSsml;

    this.hlMode = 'underline';
    this.book = null;
    this.chapterIndex = null;
    this.chapter = null;
    this.toc = [];
    this.sentenceKeys = []; // per sentence: Map(word surface → resolved key)
    this.checkedSentences = new Set();
    this.observer = null;
    this.cardTarget = null; // {surface, sentenceIndex, selected}
    this.cardEntry = null;
    this.cardState = 'loading'; // loading | missing | unavailable | ready
    this.cardAi = null; // {text} | {error} | undefined (not requested)
    this.cardAiOpen = false;
    this.wordAudio = null;
    this.holdTimer = null;
    this.hoverTimer = null;
    this.holdActive = false;
    this.suppressClick = false;
    this.lastSentence = null;
    this.positionTimer = null;

    // DOM
    this.root = document.getElementById('book-view');
    this.bookTitle = document.getElementById('book-title');
    this.chapterTitle = document.getElementById('chapter-title');
    this.chapterBody = document.getElementById('chapter-body');
    this.bookError = document.getElementById('book-error');
    this.bookScroll = document.getElementById('book-scroll');
    this.prevChapter = document.getElementById('prev-chapter');
    this.nextChapter = document.getElementById('next-chapter');
    this.asideBody = document.getElementById('aside-body');
    this.tabLookup = document.getElementById('tab-lookup');
    this.tabToc = document.getElementById('tab-toc');
    this.tocBtn = document.getElementById('toc-btn');
    this.tocDrawer = document.getElementById('toc-drawer');
    this.tocList = document.getElementById('toc-list');
    this.hlToggle = document.getElementById('hl-toggle');
    this.libraryBtn = document.getElementById('library-btn');
    this.libraryOverlay = document.getElementById('library-overlay');
    this.libraryList = document.getElementById('library-list');
    this.libraryEmpty = document.getElementById('library-empty');
    this.uploadButton = document.getElementById('upload-button');
    this.uploadInput = document.getElementById('upload-input');
    this.uploadProgress = document.getElementById('upload-progress');
    this.uploadStatus = document.getElementById('upload-status');
    this.scrim = document.getElementById('scrim');
    this.lookupDrawer = document.getElementById('lookup-drawer');
    this.lookupCard = document.getElementById('lookup-card');

    this.#bind();
  }

  // --- open / navigate ------------------------------------------------------

  /** Opens a Book at its Reading position (or chapter 0) and switches the view. */
  async openBook(bookId) {
    let book;
    let toc = [];
    try {
      // The detail response carries the TOC at the top level, next to `book`.
      const detail = await this.api.getBook(bookId);
      book = detail.book;
      toc = detail.toc ?? [];
    } catch (error) {
      this.toast(error.message ?? '书打不开了。');
      return;
    }
    this.book = book;
    this.bookTitle.textContent = book.title || '未命名';
    this.toc = toc;
    this.checkedSentences = new Set();
    // The app opens here next time — /state.lastBook is the Profile's bookmark.
    this.api.putState({ lastBook: bookId }).catch(() => {});
    await this.openChapter(book.reading?.chapter ?? 0, { restored: (book.reading?.sentence ?? 0) > 0 });
    this.onView('book');
  }

  async openChapter(index, { restored = false } = {}) {
    this.flushPosition();
    this.closeCard();
    this.chapterIndex = index;
    this.lastSentence = null;
    this.#showChapterLoading();
    let payload;
    try {
      payload = await this.api.getChapter(this.book.id, index);
    } catch (error) {
      this.chapterBody.replaceChildren();
      this.bookError.textContent = error.message ?? '章节加载失败。';
      this.bookError.hidden = false;
      return;
    }
    this.chapter = payload.chapter;
    const sentenceCount = this.chapter.sentences.length;
    const reading = Math.min(payload.reading?.sentence ?? 0, Math.max(sentenceCount - 1, 0));
    this.chapterTitle.textContent = this.chapter.title || `第 ${index + 1} 章`;
    this.bookError.hidden = true;
    this.prevChapter.disabled = this.chapter.prev == null;
    this.nextChapter.disabled = this.chapter.next == null;
    this.#renderChapterBody();
    await this.loadChapter(this.chapter.sentences, reading, this.book.lang, restored && reading > 0);
    this.#restoreScroll();
    this.#restartObserver();
    if (restored && reading > 0) this.toast(`已回到上次阅读位置：${this.chapterTitle.textContent}`);
  }

  // --- TOC ---------------------------------------------------------------------

  toggleToc() {
    if (this.tocDrawer.hidden) {
      this.#renderTocList();
      this.tocDrawer.hidden = false;
      this.scrim.hidden = false;
    } else {
      this.tocDrawer.hidden = true;
      if (this.lookupDrawer.hidden) this.scrim.hidden = true;
    }
  }

  closeOverlays() {
    this.tocDrawer.hidden = true;
    this.closeCard();
  }

  // --- library -------------------------------------------------------------------

  async openLibrary() {
    this.libraryOverlay.hidden = false;
    await this.refreshLibrary();
  }

  closeLibrary() {
    this.libraryOverlay.hidden = true;
    this.uploadProgress.hidden = true;
  }

  async refreshLibrary() {
    let books = [];
    try {
      books = await this.api.listBooks();
    } catch (error) {
      this.libraryEmpty.hidden = false;
      this.libraryEmpty.textContent = error.message ?? '书库加载失败。';
      return;
    }
    this.libraryEmpty.hidden = books.length > 0;
    this.libraryList.replaceChildren(
      ...books.map((book) => {
        const li = document.createElement('li');
        li.className = 'library-entry';
        li.setAttribute('role', 'button');
        li.tabIndex = 0;

        const titles = document.createElement('div');
        titles.className = 'library-titles';
        const title = document.createElement('b');
        title.textContent = book.title || book.fileName || '未命名';
        const meta = document.createElement('span');
        meta.className = 'muted';
        meta.textContent = [book.author, LANG_LABELS[book.lang] ?? book.lang, `${book.chapters} 章`]
          .filter(Boolean)
          .join(' · ');
        titles.append(title, meta);

        const progress = document.createElement('span');
        progress.className = 'library-progress';
        progress.textContent = book.reading ? `读到第 ${book.reading.chapter + 1} 章` : '未开始';

        const open = () => {
          this.closeLibrary();
          void this.openBook(book.id);
        };
        li.append(titles, progress);
        li.addEventListener('click', open);
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        });
        return li;
      }),
    );
  }

  async uploadBook(file) {
    const bar = this.uploadProgress.firstElementChild;
    this.uploadProgress.hidden = false;
    bar.style.width = '0%';
    this.uploadStatus.textContent = '上传中…';
    try {
      const { duplicate } = await this.api.uploadBook(file, {
        onProgress: (fraction) => {
          bar.style.width = `${Math.round(fraction * 100)}%`;
          if (fraction >= 1) this.uploadStatus.textContent = '解析中…';
        },
      });
      this.uploadStatus.textContent = duplicate ? '书库里已有这本书。' : '已加入书库。';
      await this.refreshLibrary();
    } catch (error) {
      this.uploadStatus.textContent = error.message ?? '上传失败。';
    } finally {
      setTimeout(() => {
        this.uploadProgress.hidden = true;
      }, 2500);
    }
  }

  // --- gestures ---------------------------------------------------------------------

  #bind() {
    this.prevChapter.addEventListener('click', () => {
      if (this.chapter?.prev != null) void this.openChapter(this.chapter.prev);
    });
    this.nextChapter.addEventListener('click', () => {
      if (this.chapter?.next != null) void this.openChapter(this.chapter.next);
    });
    this.tocBtn.addEventListener('click', () => this.toggleToc());
    this.libraryBtn.addEventListener('click', () => void this.openLibrary());
    document.getElementById('library-close').addEventListener('click', () => this.closeLibrary());
    this.uploadButton.addEventListener('click', () => this.uploadInput.click());
    this.uploadInput.addEventListener('change', () => {
      const file = this.uploadInput.files?.[0];
      this.uploadInput.value = '';
      if (file) void this.uploadBook(file);
    });
    this.scrim.addEventListener('click', () => this.closeOverlays());

    this.hlToggle.addEventListener('click', () => {
      this.hlMode = HL_MODES[(HL_MODES.indexOf(this.hlMode) + 1) % HL_MODES.length];
      this.applyHlMode();
      this.api.putState({ hl_mode: this.hlMode }).catch(() => {});
    });

    this.tabLookup.addEventListener('click', () => this.#showAsideTab('lookup'));
    this.tabToc.addEventListener('click', () => this.#showAsideTab('toc'));

    // Tap on a sentence = play; long-press suppresses the click it follows.
    this.chapterBody.addEventListener('click', (event) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      const sentence = event.target.closest('.sent');
      if (sentence) this.onSentenceTap?.(Number(sentence.dataset.sentence));
    });

    this.chapterBody.addEventListener('pointerover', (event) => this.#onPointerOver(event));
    this.chapterBody.addEventListener('pointerout', (event) => this.#onPointerOut(event));
    this.chapterBody.addEventListener('pointerdown', (event) => this.#onPointerDown(event));
    this.chapterBody.addEventListener('pointermove', (event) => this.#onPointerMove(event));
    this.chapterBody.addEventListener('pointerup', (event) => {
      this.#endHold();
      this.#onSelection(event);
    });
    this.chapterBody.addEventListener('pointercancel', () => this.#endHold());

    window.addEventListener('pagehide', () => this.flushPosition());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushPosition();
    });
  }

  /** Set by the app: a plain sentence tap plays it through the shared controller. */
  onSentenceTap = null;

  #onPointerOver(event) {
    if (!isFinePointer() || this.holdActive) return;
    const word = event.target.closest?.('.w');
    if (!word) return;
    clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => {
      this.#showCardFor(word);
    }, HOVER_MS);
  }

  #onPointerOut(event) {
    if (!isFinePointer()) return;
    if (!event.target.closest?.('.w')) return;
    clearTimeout(this.hoverTimer);
  }

  #onPointerDown(event) {
    if (isFinePointer()) return;
    const word = event.target.closest?.('.w');
    if (!word) return;
    this.holdStart = { x: event.clientX, y: event.clientY };
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.holdActive = true;
      this.suppressClick = true;
      navigator.vibrate?.(30);
      word.classList.add('held');
      this.#showCardFor(word);
    }, HOLD_MS);
  }

  #onPointerMove(event) {
    if (isFinePointer() || !this.holdTimer) return;
    if (Math.hypot(event.clientX - this.holdStart.x, event.clientY - this.holdStart.y) > 10) {
      this.#cancelHold();
    }
  }

  #endHold() {
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.holdStart = null;
    document.querySelectorAll('.w.held').forEach((el) => el.classList.remove('held'));
    // The click after a long-press lands on pointerup; keep suppressing it.
    if (this.suppressClick) {
      setTimeout(() => {
        this.suppressClick = false;
      }, 350);
    }
  }

  #cancelHold() {
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.holdStart = null;
  }

  #onSelection(event) {
    if (event.pointerType === 'touch') return;
    const selection = window.getSelection?.();
    const text = selection?.toString().trim();
    if (!text || text.length > 30) return;
    const sentence = selection.anchorNode?.parentElement?.closest?.('.sent');
    if (!sentence) return;
    this.#showCard({ surface: text, sentenceIndex: Number(sentence.dataset.sentence), selected: true });
  }

  #showCardFor(wordSpan) {
    const sentence = wordSpan.closest('.sent');
    if (!sentence) return;
    this.#showCard({ surface: wordSpan.textContent, sentenceIndex: Number(sentence.dataset.sentence) });
  }

  #showCard({ surface, sentenceIndex, selected = false }) {
    this.cardTarget = { surface, sentenceIndex, selected };
    this.cardState = 'loading';
    this.cardEntry = null;
    this.cardAiOpen = false;
    this.cardAi = undefined;
    if (this.isWide()) {
      this.#showAsideTab('lookup');
      this.followPlaying();
    } else {
      this.lookupDrawer.hidden = false;
      this.scrim.hidden = false;
    }
    this.renderCard();
    void this.#requestLookup(surface);
  }

  closeCard() {
    this.lookupDrawer.hidden = true;
    if (this.tocDrawer.hidden) this.scrim.hidden = true;
    this.cardTarget = null;
  }

  async #requestLookup(surface) {
    const lang = this.book?.lang ?? 'en';
    let state = 'ready';
    let entry = null;
    try {
      entry = await this.api.lookup(lang, surface);
    } catch (error) {
      if (error.code === 'entry_not_found') {
        this.cardState = 'missing';
      } else {
        this.cardState = 'unavailable';
      }
      if (this.cardTarget?.surface !== surface) return;
      this.cardEntry = null;
      this.renderCard();
      return;
    }
    if (this.cardTarget?.surface !== surface) return;
    this.cardState = 'ready';
    this.cardEntry = entry;
    this.renderCard();
  }

  #requestAi(word, sentence) {
    void (async () => {
      try {
        const payload = await this.api.aiExplain(word, sentence, this.book?.lang ?? 'en');
        this.cardAi = { text: payload?.text || '（AI 没有返回内容。）' };
      } catch (error) {
        this.cardAi = { error: error.message ?? 'AI 解释失败。' };
      }
      this.renderCard();
    })();
  }

  /** Toggles 我认识 on the resolved entry; applies to every Book's spans. */
  async markKnown(key) {
    try {
      if (this.knownWords.has(key)) {
        await this.api.updateWords([], [key]);
        this.knownWords.delete(key);
      } else {
        await this.api.updateWords([key], []);
        this.knownWords.add(key);
      }
    } catch {
      this.toast('词状态没有保存，稍后再试。');
      return;
    }
    document.querySelectorAll(`.w[data-key="${CSS.escape(key)}"]`).forEach((span) => {
      span.classList.toggle('known', this.knownWords.has(key));
      span.classList.toggle('unknown', !this.knownWords.has(key));
    });
    this.renderCard();
  }

  /** PC shortcut `n`: the next not-我认识 word from `fromSentence` on. */
  nextUnknown(fromSentence) {
    if (!this.chapter) return null;
    return nextUnknownWord(
      this.chapter.sentences.map((sentence) => ({ tokens: this.tokens(sentence) })),
      Math.max(0, fromSentence ?? 0),
      (sentenceIndex, token) => this.sentenceKeys[sentenceIndex]?.get(token.text) ?? null,
      (key) => this.knownWords.has(key),
    );
  }

  /** Opens the lookup card for a word found by the `n` scan and scrolls there. */
  openWord(sentenceIndex, surface) {
    this.#showCard({ surface, sentenceIndex });
    const target = document.querySelector(`.sent[data-sentence="${sentenceIndex}"]`);
    if (target) target.scrollIntoView({ behavior: 'instant', block: 'center' });
  }

  /** PC shortcut `k`: marks the card's resolved entry 我认识 (toggles). */
  markCurrentKnown() {
    if (!this.cardTarget) return;
    const key = this.cardEntry?.key;
    if (key) void this.markKnown(key);
  }

  /** PC shortcut `a`: switches the card to the AI section (requesting it). */
  openAiTab() {
    if (!this.cardTarget) return;
    const sentence = this.chapter?.sentences[this.cardTarget.sentenceIndex];
    this.cardAiOpen = true;
    if (this.cardAi == null) this.#requestAi(this.cardTarget.surface, sentence?.t ?? '');
    this.renderCard();
  }

  // --- rendering ----------------------------------------------------------------------

  #showChapterLoading() {
    this.bookError.hidden = true;
    this.chapterBody.replaceChildren(paragraph('载入中…', 'muted'));
  }

  #renderChapterBody() {
    this.sentenceKeys = this.chapter.sentences.map(() => new Map());
    const fragment = document.createDocumentFragment();
    this.chapter.sentences.forEach((sentence, position) => {
      // The server's chapter sentences are positional ({t, w, ruby}) — the
      // array position IS the sentence index (same as ReaderController's).
      const p = document.createElement('p');
      p.className = 'sent';
      p.dataset.sentence = String(position);
      for (const token of this.tokens(sentence)) {
        const span = document.createElement('span');
        span.className = token.isWord ? 'w' : 'sep';
        span.textContent = token.text;
        p.append(span);
      }
      fragment.append(p);
    });
    this.chapterBody.replaceChildren(fragment);
    this.applyHlMode();
  }

  tokens(sentence) {
    return wordTokens(sentence.t, sentence.w);
  }

  applyHlMode() {
    this.hlToggle.textContent = HL_LABELS[this.hlMode];
    this.chapterBody.dataset.hl = this.hlMode;
  }

  #restartObserver() {
    this.observer?.disconnect();
    this.checkedSentences = new Set();
    this.observer = new IntersectionObserver(
      (entries) => {
        const indexes = new Set();
        for (const record of entries) {
          if (record.isIntersecting) indexes.add(Number(record.target.dataset.sentence));
        }
        if (indexes.size > 0) void this.#checkBatch([...indexes]);
      },
      { root: this.bookScroll, rootMargin: '300px 0px' },
    );
    this.chapterBody.querySelectorAll('.sent').forEach((el) => this.observer.observe(el));
  }

  /** The 标生词 lazy batch: resolve the words of freshly visible sentences. */
  async #checkBatch(indexes) {
    const fresh = indexes.filter((index) => !this.checkedSentences.has(index));
    if (fresh.length === 0) return;
    fresh.forEach((index) => this.checkedSentences.add(index));
    const words = new Set();
    for (const index of fresh) {
      for (const token of this.tokens(this.chapter.sentences[index])) {
        if (token.isWord) words.add(token.text);
      }
    }
    if (words.size === 0) return;
    if (words.size > MAX_CHECK_BATCH) return;
    let found;
    try {
      found = await this.api.checkWords(this.book?.lang ?? 'en', [...words]);
    } catch {
      return; // no dictionaries yet — leave unmarked; re-checking happens on view
    }
    for (const index of fresh) {
      const sentence = this.chapter.sentences[index];
      if (!sentence) continue;
      for (const token of this.tokens(sentence)) {
        if (!token.isWord) continue;
        const key = found[token.text];
        if (key) this.sentenceKeys[index].set(token.text, key);
      }
    }
    for (const [surface, key] of Object.entries(found)) {
      if (!key) continue;
      this.chapterBody.querySelectorAll('.w').forEach((span) => {
        if (span.textContent !== surface) return;
        const spanSentence = span.closest('.sent');
        if (!spanSentence || !fresh.includes(Number(spanSentence.dataset.sentence))) return;
        span.dataset.key = key;
        span.classList.toggle('known', this.knownWords.has(key));
        span.classList.toggle('unknown', !this.knownWords.has(key));
      });
    }
  }

  #showAsideTab(tab) {
    this.tabLookup.classList.toggle('active', tab === 'lookup');
    this.tabToc.classList.toggle('active', tab === 'toc');
    if (tab === 'toc') this.#renderTocList();
    else if (this.cardTarget) this.renderCard();
  }

  #renderTocList() {
    const build = () => {
      const fragment = document.createDocumentFragment();
      for (const entry of this.toc) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'toc-entry';
        button.classList.toggle('current', entry.index === this.chapterIndex);
        button.textContent = entry.title || `第 ${entry.index + 1} 章`;
        button.addEventListener('click', () => {
          if (this.tocDrawer) this.tocDrawer.hidden = true;
          if (this.lookupDrawer.hidden) this.scrim.hidden = true;
          void this.openChapter(entry.index);
        });
        fragment.append(button);
      }
      return fragment;
    };
    this.tocList.replaceChildren(build());
    this.asideBody.replaceChildren(build());
  }

  /** Lookup card node: 词条 tab by default; AI section when opened. */
  renderCard() {
    if (!this.cardTarget) return;
    const card = this.#buildCard();
    if (this.isWide()) {
      const existing = this.asideBody.querySelector('.card');
      if (existing) existing.replaceWith(card);
      else this.asideBody.replaceChildren(card);
    } else {
      this.lookupCard.replaceChildren(card);
    }
  }

  #buildCard() {
    const { surface, sentenceIndex, selected } = this.cardTarget;
    const entry = this.cardEntry;
    const card = document.createElement('div');
    card.className = 'card lookup-card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const word = document.createElement('b');
    word.className = 'card-word';
    word.textContent = surface;
    head.append(word);
    if (entry?.matched && entry.matched !== surface) {
      head.append(span(entry.matched, 'muted card-matched'));
    }
    if (entry?.reading) head.append(span(entry.reading, 'card-reading'));
    card.append(head);

    if (this.cardState === 'loading') {
      card.append(paragraph('查词典中…', 'muted'));
    } else if (this.cardState === 'unavailable') {
      card.append(paragraph('词典还没有就绪。', 'error'));
    } else if (this.cardState === 'missing') {
      card.append(paragraph('词典里没有这个词。', 'muted'));
    } else if (entry) {
      const senses = document.createElement('ol');
      senses.className = 'card-senses';
      entry.senses.slice(0, 8).forEach((sense, index) => {
        const li = document.createElement('li');
        li.append(span(sense.gloss));
        if (sense.pos) li.append(span(sense.pos, 'muted card-pos'));
        if (index === 0 && entry.key && !selected) {
          const known = this.knownWords.has(entry.key);
          const mark = document.createElement('button');
          mark.type = 'button';
          mark.className = 'btn tiny mark-known';
          mark.textContent = known ? '✓ 已认识' : '标记认识';
          mark.addEventListener('click', () => void this.markKnown(entry.key));
          li.append(mark);
        }
        senses.append(li);
      });
      card.append(senses);
    }

    const sentence = this.chapter?.sentences[sentenceIndex];
    if (sentence) card.append(paragraph(sentence.t, 'muted card-context'));

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const speak = document.createElement('button');
    speak.type = 'button';
    speak.className = 'btn primary';
    speak.textContent = '▶ 这个词';
    speak.addEventListener('click', () => this.speakWord(surface));
    actions.append(speak);
    const aiTab = document.createElement('button');
    aiTab.type = 'button';
    aiTab.className = 'btn secondary';
    aiTab.textContent = this.cardAiOpen ? '词条' : '问 AI';
    aiTab.addEventListener('click', () => {
      this.cardAiOpen = !this.cardAiOpen;
      if (this.cardAiOpen && this.cardAi == null) this.#requestAi(surface, sentence?.t ?? '');
      this.renderCard();
    });
    actions.append(aiTab);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn secondary';
    close.textContent = '关闭';
    close.addEventListener('click', () => this.closeCard());
    actions.append(close);
    card.append(actions);

    if (this.cardAiOpen && this.cardAi != null) {
      if (this.cardAi.error) {
        const line = paragraph(this.cardAi.error, 'error');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn tiny';
        retry.textContent = '重试';
        retry.addEventListener('click', () => {
          this.cardAi = undefined;
          this.renderCard();
          this.#requestAi(surface, sentence?.t ?? '');
        });
        line.append(' ', retry);
        card.append(line);
      } else {
        card.append(paragraph(this.cardAi.text, 'card-ai-text'));
      }
    } else if (this.cardAiOpen) {
      card.append(paragraph('问 AI 中…', 'muted'));
    }
    return card;
  }

  speakWord(surface, entry) {
    this.wordAudio?.pause();
    const voice = defaultVoiceFor(this.book?.lang ?? 'en');
    const params = new URLSearchParams({
      text: surface,
      voice,
      rate: this.rateSsml?.() ?? '+0%',
    });
    this.wordAudio = new Audio(`/tts?${params}`);
    this.wordAudio.play().catch(() => {});
  }

  // --- Reading position (the server's record) -------------------------------------

  /** App calls this for every newly playing sentence: debounced write-back. */
  reportPosition(sentence) {
    if (this.book == null || this.chapterIndex == null) return;
    this.lastSentence = sentence;
    clearTimeout(this.positionTimer);
    this.positionTimer = setTimeout(() => {
      this.positionTimer = null;
      void this.api.putPosition(this.book.id, this.chapterIndex, sentence).catch(() => {});
    }, POSITION_DEBOUNCE_MS);
  }

  flushPosition() {
    if (this.positionTimer == null || this.lastSentence == null) return;
    clearTimeout(this.positionTimer);
    this.positionTimer = null;
    // keepalive: the fetch must survive the navigation that triggered the
    // pagehide — a plain fetch is aborted and the position is lost (#17).
    void this.api.putPosition(this.book.id, this.chapterIndex, this.lastSentence, { keepalive: true }).catch(() => {});
  }

  #restoreScroll() {
    // Runs after the controller has applied its state (selected = playing).
    requestAnimationFrame(() => {
      const target =
        document.querySelector('.sent.selected') ?? document.querySelector('.sent.playing') ?? null;
      if (target) target.scrollIntoView({ behavior: 'instant', block: 'center' });
      else this.bookScroll.scrollTop = 0;
    });
  }
}

function span(text, className = '') {
  const el = document.createElement('span');
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function paragraph(text, className) {
  const p = document.createElement('p');
  p.textContent = text;
  if (className) p.className = className;
  return p;
}

function isFinePointer() {
  return window.matchMedia('(pointer: fine)').matches;
}

const LANG_LABELS = { en: '英语', ja: '日语', 'zh-CN': '中文' };
