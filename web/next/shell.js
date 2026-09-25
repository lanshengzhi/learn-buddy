/**
 * Shell DOM adapter (map #40, slice 1) — wires ShellController to the DOM.
 * The reader is owned by /js/app.js; this module owns shell chrome, face
 * visibility, identity chip, drawer, and the selection toolbar.
 *
 * Hard rules from spec §4.2 baked in here:
 *  - #2/#3: face/layer changes never rebuild #shell-main, and every
 *    geometry read (toolbar position, word-card scroll) is live — no
 *    cached offsets anywhere in this file.
 *  - #4: when the word card opens on narrow, the looked-up sentence is
 *    scrolled to the visible strip above the card (scroll-padding-top).
 *  - #6: focusing the editor's textarea collapses the selection toolbar.
 */

import { ShellController, Layer, Face } from '/js/core/shell-controller.js';
import { detectLanguage } from '/js/core/language.js';
import { initShelf } from './shelf.js';
import { initChat } from './chat.js';
import { onReadReady } from './read-ready.js';

const $ = (id) => document.getElementById(id);

const NARROW = window.matchMedia('(max-width: 899.98px)');
const WORD_SELECTION_MAX = 3; // §4.3: ≤3 chars is a word → word card, not the toolbar

const shell = new ShellController({ narrow: NARROW.matches, onEvent: render });

const shellScrim = $('shell-scrim');
const selToolbar = $('sel-toolbar');
const selCopy = $('sel-copy');
const selHighlight = $('sel-highlight');
const selAskBook = $('sel-ask-book');
// Learn keeps the established phrase lookup action. In Read this control is
// hidden so the Book actions are exactly Copy / Highlight / Ask Book.
const selLookup = $('sel-lookup');
const bookAiPanel = $('book-ai-panel');
const bookAiBook = $('book-ai-book');
const bookAiContext = $('book-ai-context');
const bookAiSelection = $('book-ai-selection');
const bookAiError = $('book-ai-error');
const lookupDrawer = $('lookup-drawer');
const chatFace = $('chat-face');
const readingArea = $('reading-area');
const learnFace = $('learn-face');
const readEmpty = $('read-empty');
const bookView = $('book-view');
const navChat = $('nav-chat');
const navRead = $('nav-read');
const navLearn = $('nav-learn');
const navHistory = $('nav-history');
const navShelf = $('nav-shelf');
const navConversations = $('nav-conversations');
const topbarTitle = $('shell-topbar-title');

// --- render: state → DOM (idempotent; the shell DOM is tiny) ---------------

function render() {
  const { openLayers, navCollapsed, narrow, activeFace } = shell.state;
  document.body.dataset.face = activeFace;
  const drawerOpen = narrow && openLayers.includes(Layer.Drawer);
  document.body.classList.toggle('drawer-open', drawerOpen);
  shellScrim.hidden = !drawerOpen;
  document.body.classList.toggle('nav-collapsed', navCollapsed && !narrow);
  const toolbarOpen = openLayers.includes(Layer.Toolbar);
  selToolbar.hidden = !toolbarOpen;
  selLookup.hidden = activeFace !== Face.Learn;
  if (toolbarOpen) positionToolbar();

  // Face switch (ticket #47): both faces stay mounted; only `hidden`
  // toggles — the reading pane is NEVER rebuilt (spec §4.2 #2), so Chat and
  // Read keep their own state and never see each other's (user story 20).
  const chatActive = activeFace === Face.Chat;
  const learnActive = activeFace === Face.Learn;
  const readActive = activeFace === Face.Read;
  chatFace.hidden = !chatActive;
  readingArea.hidden = !readActive;
  learnFace.hidden = !learnActive;
  readEmpty.hidden = !bookView.hidden;
  navChat.classList.toggle('active', chatActive);
  navRead.classList.toggle('active', readActive);
  navLearn.classList.toggle('active', learnActive);
  for (const [button, active] of [[navChat, chatActive], [navRead, readActive], [navLearn, learnActive]]) {
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  navConversations.hidden = !chatActive;
  navShelf.hidden = !readActive;
  navHistory.hidden = !learnActive;
  topbarTitle.textContent = chatActive ? 'Chat' : learnActive ? '学习' : 'Read';
  if (chatActive) chatAdapter.activate();
}

function positionToolbar() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const rect = selection.getRangeAt(0).getBoundingClientRect(); // live, never cached
  selToolbar.style.left = `${rect.left + rect.width / 2}px`;
  selToolbar.style.top = `${Math.max(8, rect.top - selToolbar.offsetHeight - 8)}px`;
}

// --- nav --------------------------------------------------------------------

$('shell-nav-toggle').addEventListener('click', () => shell.toggleNav());
$('nav-collapse').addEventListener('click', () => shell.toggleNav());
shellScrim.addEventListener('click', () => shell.close(Layer.Drawer));

// 阅读记录 belongs to Learn; show its existing history pane.
navHistory.addEventListener('click', () => $('history-button').click());

// Face switches only toggle hidden; narrow drawer closes after selection.
navChat.addEventListener('click', () => {
  shell.setFace(Face.Chat);
  shell.close(Layer.Drawer);
});
navRead.addEventListener('click', () => {
  shell.setFace(Face.Read);
  shell.close(Layer.Drawer);
});
navLearn.addEventListener('click', () => {
  shell.setFace(Face.Learn);
  shell.close(Layer.Drawer);
});

// Read 面的上下文书架（#46）：列出当前 Person 的书、上传 EPUB、点开即读。
initShelf({ shell });

// Chat 面（#47）：当前 Person 的 Conversation 列表 + 文字对话工作区。
const chatAdapter = initChat({ shell });

// --- identity chip: proxies the existing profile gate ------------------------

const profileChip = $('profile-chip');
const identityName = $('identity-name');
$('identity-chip').addEventListener('click', () => profileChip.click());
const syncIdentity = () => {
  identityName.textContent = profileChip.textContent;
};
new MutationObserver(syncIdentity).observe(profileChip, {
  childList: true,
  characterData: true,
  subtree: true,
});
syncIdentity();

// --- viewport: crossing ~900px resets the layer stack ------------------------

NARROW.addEventListener('change', (event) => shell.setNarrow(event.matches));

// --- Escape peels one layer (capture phase beats the app's own handler) ------

window.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== 'Escape') return;
    const closed = shell.back();
    if (closed) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  true,
);

// --- §4.2 #4: scroll the looked-up sentence above the bottom card -----------

let lastTappedSentence = null;
document.addEventListener(
  'pointerdown',
  (event) => {
    const sentence = event.target.closest?.('.sent');
    if (sentence) lastTappedSentence = sentence;
  },
  true,
);

new MutationObserver(() => {
  if (lookupDrawer.hidden || !shell.state.narrow || !lastTappedSentence) return;
  lastTappedSentence.scrollIntoView({ block: 'start', behavior: 'instant' });
}).observe(lookupDrawer, { attributes: true, attributeFilter: ['hidden'] });

// --- Read selection actions ---------------------------------------------------

let selectionTimer = null;
let activeSelection = null;

function sentenceFor(selection) {
  const node = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
    ? selection.anchorNode
    : selection?.anchorNode?.parentElement;
  return node?.closest?.('#chapter-body .sent') ?? null;
}

/** Return the exact browser selection, but only when it is in the open Book. */
function readSelection() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const sentence = sentenceFor(selection);
  const book = window.learnbuddyRead?.bookView?.();
  if (!sentence || !book?.book || book.chapter == null) return null;
  return {
    text,
    sentence,
    sentenceIndex: Number(sentence.dataset.sentence),
    chapter: book.chapterIndex,
    bookId: book.book.id,
  };
}

function highlightKey(bookId, chapter, sentence) {
  return `${bookId}:${chapter}:${sentence}`;
}

function readHighlights() {
  try {
    const profile = window.learnbuddyRead?.profileId?.() ?? 'default';
    return new Set(JSON.parse(localStorage.getItem(`learnbuddy:highlights:${profile}`) || '[]'));
  } catch {
    return new Set();
  }
}

function writeHighlights(highlights) {
  try {
    const profile = window.learnbuddyRead?.profileId?.() ?? 'default';
    localStorage.setItem(`learnbuddy:highlights:${profile}`, JSON.stringify([...highlights]));
  } catch {
    /* private mode or disabled storage: the current sentence still highlights */
  }
}

let highlights = new Set();
function applyHighlights() {
  const book = window.learnbuddyRead?.bookView?.();
  const bookId = book?.book?.id;
  for (const sentence of document.querySelectorAll('#chapter-body .sent')) {
    const key = highlightKey(bookId, book?.chapterIndex, sentence.dataset.sentence);
    const marked = Boolean(bookId) && highlights.has(key);
    sentence.dataset.highlightAnchor = marked ? key : '';
    sentence.classList.toggle('sentence-highlight', marked);
  }
}

const highlightObserver = new MutationObserver(applyHighlights);
highlightObserver.observe($('chapter-body'), { childList: true, subtree: false });

function rememberSelection() {
  const selection = shell.state.activeFace === Face.Read ? readSelection() : null;
  if (!selection) return false;
  activeSelection = selection;
  return true;
}

document.addEventListener('selectionchange', () => {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const selection = window.getSelection?.();
    if (shell.state.activeFace === Face.Learn) {
      const text = selection?.toString().trim() ?? '';
      const anchor = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode : selection?.anchorNode?.parentElement;
      if (!selection || selection.isCollapsed || !text || text.length <= WORD_SELECTION_MAX
          || !anchor?.closest('#sentence-list')) {
        shell.close(Layer.Toolbar);
        return;
      }
      activeSelection = null;
      shell.open(Layer.Toolbar);
      return;
    }
    if (!rememberSelection() || activeSelection.text.trim().length <= WORD_SELECTION_MAX) {
      shell.close(Layer.Toolbar);
      return;
    }
    shell.open(Layer.Toolbar);
  }, 150);
});

// §4.2 #6: the keyboard belongs to the bottom sheet — the toolbar retreats.
$('text-input').addEventListener('focus', () => shell.close(Layer.Toolbar));

// Selectionchange can race the pointerup listener. Capture valid Read ranges
// before the established BookView lookup handler sees them.
$('chapter-body').addEventListener('pointerdown', rememberSelection, true);
$('chapter-body').addEventListener('pointerup', rememberSelection, true);

// Preserve the exact selection across each toolbar tap (mousedown otherwise
// collapses it before click handlers can read it).
for (const button of [selCopy, selHighlight, selAskBook, selLookup]) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
}

selCopy.addEventListener('click', async () => {
  const selection = rememberSelection() || activeSelection;
  const text = selection?.text ?? window.getSelection()?.toString() ?? '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    selCopy.textContent = '已复制';
    setTimeout(() => { selCopy.textContent = '复制'; }, 900);
  } catch {
    /* clipboard unavailable (non-secure context) — selection remains usable */
  }
  shell.close(Layer.Toolbar);
});

selHighlight.addEventListener('click', () => {
  const selection = rememberSelection() || activeSelection;
  if (!selection) return;
  const key = highlightKey(selection.bookId, selection.chapter, selection.sentenceIndex);
  highlights.add(key);
  writeHighlights(highlights);
  applyHighlights();
  shell.close(Layer.Toolbar);
});

selAskBook.addEventListener('click', async () => {
  const selection = rememberSelection() || activeSelection;
  if (!selection || typeof window.learnbuddyRead?.compileContext !== 'function') return;
  bookAiError.hidden = true;
  const book = window.learnbuddyRead?.bookView?.();
  bookAiPanel.hidden = false;
  bookAiBook.textContent = book.book.title || book.book.id;
  bookAiContext.textContent = `第 ${selection.chapter + 1} 章 · 第 ${selection.sentenceIndex + 1} 句 · 选区`;
  bookAiSelection.textContent = selection.text;
  bookAiSelection.hidden = false;
  try {
    const context = await window.learnbuddyRead.compileContext({
      bookId: selection.bookId,
      scope: 'selection',
      chapter: selection.chapter,
      start: selection.sentenceIndex,
      end: selection.sentenceIndex,
      selectedText: selection.text,
    });
    bookAiContext.textContent = `${context?.scope ?? 'selection'} · 第 ${selection.chapter + 1} 章 · 第 ${selection.sentenceIndex + 1} 句`;
  } catch (error) {
    bookAiError.textContent = error.message ?? '暂时无法打开书本上下文。';
    bookAiError.hidden = false;
  }
  shell.close(Layer.Toolbar);
});

$('book-ai-close').addEventListener('click', () => { bookAiPanel.hidden = true; });

selLookup.addEventListener('mousedown', (event) => event.preventDefault());
selLookup.addEventListener('click', () => {
  const selection = window.getSelection();
  const word = selection?.toString().trim() ?? '';
  const anchor = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
    ? selection.anchorNode
    : selection?.anchorNode?.parentElement;
  const sentence = anchor?.closest('#sentence-list li');
  if (!word || !sentence || shell.state.activeFace !== Face.Learn || !window.learnbuddyLookup) return;
  const text = sentence.textContent;
  const language = detectLanguage(text, document.body.dataset.readingLang);
  window.learnbuddyLookup({ word, sentence: text, language });
  shell.close(Layer.Toolbar);
});

new MutationObserver(() => {
  readEmpty.hidden = !bookView.hidden;
  if (!bookView.hidden) {
    highlights = readHighlights();
    applyHighlights();
  }
}).observe(bookView, { attributes: true, attributeFilter: ['hidden'] });

onReadReady(() => {
  highlights = readHighlights();
  applyHighlights();
});

render();
