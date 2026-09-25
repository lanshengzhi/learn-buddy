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
import { ServerApi } from '/js/core/api.js';
import { storedProfile } from '/js/browser/profile.js';
import {
  BOOK_AI_QUICK_PROMPTS, BookAiPanelController, BookAiPanelState, STUDY_ARTIFACT_TYPES,
} from '/js/core/book-ai-panel.js';

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

const bookAi = new BookAiPanelController({ onEvent: renderBookAi });
let bookAiApi = null;
let preservedReaderAnchor = null;

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
  if (!readActive && bookAi.state.panelState !== BookAiPanelState.Closed) closeBookAi();
}

function renderBookAi() {
  const s = bookAi.state;
  const closed = s.panelState === BookAiPanelState.Closed;
  bookAiPanel.hidden = closed;
  bookAiPanel.dataset.state = s.panelState;
  if (closed) return;

  $('book-ai-person').textContent = s.personId ? $('identity-name').textContent || s.personId : '—';
  $('book-ai-book').textContent = s.bookTitle || s.bookId || '—';
  $('book-ai-chapter').textContent = s.chapterIndex == null
    ? '—' : `${s.chapterTitle || `第 ${s.chapterIndex + 1} 章`}`;
  $('book-ai-context').textContent = s.context ? contextLabel(s.context) : '—';
  $('book-ai-selection').textContent = s.selectedText;
  $('book-ai-selection').hidden = !s.selectedText;

  $('book-ai-ask').hidden = s.panelState !== BookAiPanelState.Ask;
  $('book-ai-job').hidden = s.panelState !== BookAiPanelState.Job;
  $('book-ai-artifact-status').hidden = s.panelState !== BookAiPanelState.ArtifactPreview;
  $('book-artifact-preview').hidden = s.panelState !== BookAiPanelState.ArtifactPreview;
  $('book-ai-job-scope').textContent = s.job
    ? `${artifactLabel(s.job.artifactType)} · ${scopeLabel(s.job.contextScope)}`
    : '';
  $('book-ai-job-status').textContent = s.job?.message ?? jobLabel(s.job?.status);
  $('book-ai-job-recheck').hidden = !s.job
    || !['queued', 'preparing', 'uploading', 'waiting_remote', 'downloading'].includes(s.job.status);
  $('book-ai-job-cancel').hidden = !s.job
    || ['not_configured', 'ready', 'failed', 'unknown', 'cancelled'].includes(s.job.status);
  $('book-ai-artifact-summary').textContent = s.artifact
    ? `${s.artifact.title || '学习产物'} · ${s.artifact.type || '未知类型'}`
    : '尚无可预览的学习产物。';
  if (s.artifact) {
    $('book-artifact-title').textContent = s.artifact.title || '学习产物';
    $('book-artifact-content').textContent = s.artifact.previewText || '此产物没有文本预览。';
  }

  $('book-ai-error').hidden = !s.error;
  $('book-ai-error').textContent = s.error ?? '';
  $('book-ai-empty').hidden = s.messages.length > 0;
  $('book-ai-messages').replaceChildren(...s.messages.map((message) => {
    const p = document.createElement('p');
    p.className = `book-ai-message ${message.role}`;
    p.textContent = message.content;
    return p;
  }));
  $('book-ai-messages').scrollTop = $('book-ai-messages').scrollHeight;
  $('book-ai-send').disabled = s.streaming || !s.conversation || !s.context;
  $('book-ai-input').disabled = s.streaming;
  $('book-ai-delete-conversation').disabled = s.streaming || !s.conversation;
  $('book-ai-conversation-list').replaceChildren(...s.conversations.map((conversation) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.toggle('active', conversation.id === s.conversation?.id);
    button.textContent = conversation.title || `对话 ${conversation.id}`;
    button.addEventListener('click', () => {
      void bookAiApi?.resumeBookConversation(conversation.id).then((active) => {
        bookAi.setConversation(active);
        return refreshBookAiConversations();
      }).catch(showBookAiError);
    });
    li.append(button);
    return li;
  }));
}

function contextLabel(context) {
  const anchor = context.anchor ?? {};
  if (context.scope === 'selection') return `选区 · 第 ${Number(anchor.start ?? 0) + 1}–${Number(anchor.end ?? 0) + 1} 句`;
  if (context.scope === 'sentence') return `当前句 · 第 ${Number(anchor.sentence ?? 0) + 1} 句`;
  if (context.scope === 'chapter') return '当前章节';
  if (context.scope === 'book') return '整本书';
  return context.scope ?? '—';
}

function artifactLabel(type) {
  return STUDY_ARTIFACT_TYPES.find((artifact) => artifact.id === type)?.label ?? '学习产物';
}

function scopeLabel(scope) {
  if (scope?.scope === 'selection') {
    const anchor = scope.anchor ?? {};
    return `选区 · 第 ${Number(anchor.start ?? 0) + 1}–${Number(anchor.end ?? 0) + 1} 句`;
  }
  if (scope?.scope === 'chapter') return `当前章节 · 第 ${Number(scope.anchor?.chapter ?? 0) + 1} 章`;
  if (scope?.scope === 'book') return '整本书（已明确确认云端处理）';
  return scope?.scope ?? '范围未知';
}

function jobLabel(status) {
  return ({
    not_configured: 'NotebookLM 尚未配置；本地阅读不受影响。',
    queued: '任务已排队。',
    preparing: '正在准备上下文。',
    uploading: '正在上传到 NotebookLM。',
    waiting_remote: 'NotebookLM 正在生成。',
    downloading: '正在下载产物。',
    ready: '学习产物已完成。',
    failed: 'NotebookLM 暂时无法完成这次生成；本地阅读不受影响。',
    unknown: '远端结果未知；不会自动重试。',
    cancelled: '任务已取消。',
  })[status] ?? '学习产物生成尚未启用。';
}

function showBookAiError(error) {
  bookAi.failTurn(providerMessage(error) ?? error.message ?? error.code ?? 'AI 暂时不可用，请稍后再试。');
}

function providerMessage(error) {
  return ({
    notebooklm_not_configured: 'NotebookLM 尚未配置；可继续本地阅读。',
    notebooklm_auth_required: 'NotebookLM 需要重新登录；可继续本地阅读。',
    notebooklm_unavailable: 'NotebookLM 暂时不可用；可继续本地阅读。',
    notebooklm_quota: 'NotebookLM 当前用量受限，请稍后再试。',
    notebooklm_source_rejected: 'NotebookLM 未能处理这本书或所选范围。',
    notebooklm_job_unknown: '远端结果未知；不会自动重复生成。',
    artifact_download_failed: '产物下载失败；本地阅读不受影响。',
  })[error?.code];
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
    if (bookAi.state.panelState !== BookAiPanelState.Closed) {
      event.preventDefault();
      event.stopPropagation();
      closeBookAi();
      return;
    }
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

function sentenceForNode(node) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return element?.closest?.('#chapter-body .sent') ?? null;
}

/** Return the exact browser selection, but only when it is in the open Book. */
function readSelection() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const range = selection.getRangeAt(0);
  const startSentence = sentenceForNode(range.startContainer);
  const endSentence = sentenceForNode(range.endContainer);
  const sentence = startSentence;
  const book = window.learnbuddyRead?.bookView?.();
  // Both endpoints must be in the mounted chapter. This rejects a selection
  // that merely begins in the Book and extends into another surface.
  if (!startSentence || !endSentence || !book?.book || book.chapter == null
      || startSentence.closest('#chapter-body') !== endSentence.closest('#chapter-body')) return null;
  return {
    text,
    sentence,
    sentenceIndex: Number(sentence.dataset.sentence),
    endSentenceIndex: Number(endSentence.dataset.sentence),
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

// A panel must never continue showing or sending the previous Book's identity.
// Closing is non-reconstructing; a same-Book chapter change restores its exact
// scroll box, while a Book switch drops the old anchor before restoration.
new MutationObserver(() => {
  if (bookAi.state.panelState === BookAiPanelState.Closed) return;
  const view = window.learnbuddyRead?.bookView?.();
  if (!view?.book) return;
  if (view.book.id !== bookAi.state.bookId) closeBookAi({ restore: false });
  else if (view.chapterIndex !== bookAi.state.chapterIndex) closeBookAi();
}).observe($('chapter-title'), { childList: true, characterData: true, subtree: true });

function rememberSelection() {
  const selection = shell.state.activeFace === Face.Read ? readSelection() : null;
  if (!selection) {
    activeSelection = null;
    return false;
  }
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

function rememberReaderAnchor() {
  const scroll = $('book-scroll');
  const selected = document.querySelector('#chapter-body .sent.selected, #chapter-body .sent.playing')
    ?? lastTappedSentence;
  preservedReaderAnchor = {
    scrollTop: scroll.scrollTop,
    sentenceIndex: selected ? Number(selected.dataset.sentence) : null,
  };
}

function restoreReaderAnchor() {
  if (!preservedReaderAnchor) return;
  $('book-scroll').scrollTop = preservedReaderAnchor.scrollTop;
  // Do not scroll a sentence into view here: restoring the exact scroll box is
  // the acceptance contract. The selected sentence remains the same DOM node.
  preservedReaderAnchor = null;
}

function closeBookAi({ restore = true } = {}) {
  if (studyJobTimer) window.clearTimeout(studyJobTimer);
  studyJobTimer = null;
  bookAi.close();
  if (restore) restoreReaderAnchor();
  else preservedReaderAnchor = null;
  if (document.activeElement?.closest?.('#book-ai-panel, #book-ai-open')) {
    $('book-ai-open').focus({ preventScroll: true });
  }
}

function currentSentenceAnchor(view) {
  const selected = document.querySelector('#chapter-body .sent.selected, #chapter-body .sent.playing')
    ?? lastTappedSentence;
  const sentenceIndex = selected ? Number(selected.dataset.sentence) : view.lastSentence ?? 0;
  return Number.isInteger(sentenceIndex) && sentenceIndex >= 0 ? sentenceIndex : 0;
}

async function openBookAi(selection = null) {
  const view = window.learnbuddyRead?.bookView?.();
  const book = view?.book;
  if (!book || view.chapterIndex == null || !bookAiApi || typeof window.learnbuddyRead?.compileContext !== 'function') return;
  rememberReaderAnchor();
  const sentenceIndex = selection?.sentenceIndex ?? currentSentenceAnchor(view);
  const request = selection ? {
    scope: 'selection',
    chapter: selection.chapter,
    start: selection.sentenceIndex,
    end: selection.endSentenceIndex,
    selectedText: selection.text,
  } : {
    scope: 'sentence',
    chapter: view.chapterIndex,
    sentence: sentenceIndex,
  };
  let context;
  try {
    context = await window.learnbuddyRead.compileContext({ bookId: book.id, ...request });
  } catch (error) {
    preservedReaderAnchor = null;
    bookAi.openAsk({
      personId: window.learnbuddyRead.profileId(),
      bookId: book.id,
      bookTitle: book.title,
      chapterIndex: view.chapterIndex,
      chapterTitle: view.chapter?.title ?? $('chapter-title').textContent,
      context: null,
      selectedText: selection?.text ?? '',
    });
    showBookAiError(error);
    return;
  }

  bookAi.openAsk({
    personId: window.learnbuddyRead.profileId(),
    bookId: book.id,
    bookTitle: book.title,
    chapterIndex: view.chapterIndex,
    chapterTitle: view.chapter?.title ?? $('chapter-title').textContent,
    context,
    selectedText: selection?.text ?? '',
  });
  renderArtifactTypeControls();
  await refreshBookAiConversations();
  const active = bookAi.state.conversations.find((conversation) => conversation.active)
    ?? bookAi.state.conversations[0];
  if (active) {
    try {
      bookAi.setConversation(await bookAiApi.resumeBookConversation(active.id));
    } catch (error) {
      showBookAiError(error);
    }
  }
}

async function refreshBookAiConversations() {
  if (!bookAiApi || !bookAi.state.bookId) return;
  try {
    let conversations = await bookAiApi.listBookConversations(bookAi.state.bookId);
    if (conversations.length === 0) {
      await bookAiApi.openBookConversation(bookAi.state.bookId);
      conversations = await bookAiApi.listBookConversations(bookAi.state.bookId);
    }
    bookAi.setConversations(conversations);
  } catch (error) {
    showBookAiError(error);
  }
}

async function sendBookAi(text) {
  const s = bookAi.state;
  const draft = text.trim();
  if (!draft || !s.conversation || !s.context || s.streaming) return false;
  bookAi.beginTurn(draft);
  try {
    await bookAiApi.streamBookConversationMessage(s.conversation.id, {
      bookId: s.bookId,
      text: draft,
      context: s.context,
      onEvent(event) {
        if (event.type === 'delta' && typeof event.text === 'string') bookAi.appendDelta(event.text);
        if (event.type === 'done') bookAi.completeTurn(event.conversation);
      },
    });
    return true;
  } catch (error) {
    showBookAiError(error);
    return false;
  }
}

selAskBook.addEventListener('click', () => {
  const selection = rememberSelection() || activeSelection;
  if (selection) void openBookAi(selection);
  shell.close(Layer.Toolbar);
});

$('book-ai-open').addEventListener('click', () => void openBookAi());
$('book-ai-close').addEventListener('click', closeBookAi);
$('book-artifact-return').addEventListener('click', () => {
  bookAi.returnFromPreview();
  restoreReaderAnchor();
  $('book-ai-input').focus({ preventScroll: true });
});
$('book-ai-artifact-back').addEventListener('click', () => {
  bookAi.returnFromPreview();
  restoreReaderAnchor();
  $('book-ai-open').focus({ preventScroll: true });
});
let selectedArtifactType = STUDY_ARTIFACT_TYPES[0].id;
let studyJobTimer = null;

function renderArtifactTypeControls() {
  const artifact = STUDY_ARTIFACT_TYPES.find((item) => item.id === selectedArtifactType);
  $('book-ai-artifact-buttons').replaceChildren(...STUDY_ARTIFACT_TYPES.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.classList.toggle('active', item.id === selectedArtifactType);
    button.addEventListener('click', () => {
      selectedArtifactType = item.id;
      renderArtifactTypeControls();
    });
    return button;
  }));
  const availableScopes = artifact.scopes.filter(
    (scope) => scope !== 'selection' || Boolean(bookAi.state.selectedText));
  $('book-ai-artifact-scope').replaceChildren(...availableScopes.map((scope) => {
    const option = document.createElement('option');
    option.value = scope;
    option.textContent = { selection: '当前选区', chapter: '当前章节', book: '整本书' }[scope];
    return option;
  }));
  const scope = $('book-ai-artifact-scope').value;
  $('book-ai-whole-book-confirm').hidden = scope !== 'book';
  $('book-ai-generate').disabled = !bookAiApi || !bookAi.state.bookId;
}

function generationScope() {
  const scope = $('book-ai-artifact-scope').value;
  const chapter = bookAi.state.chapterIndex ?? 0;
  if (scope === 'book') return { scope, anchor: { wholeBook: true } };
  if (scope === 'chapter') return { scope, anchor: { chapter } };
  const anchor = bookAi.state.context?.anchor ?? {};
  return {
    scope,
    anchor: {
      chapter,
      start: anchor.start ?? 0,
      end: anchor.end ?? anchor.sentence ?? anchor.start ?? 0,
    },
  };
}

function jobView(job) {
  return {
    ...job,
    status: job.state,
    message: providerMessage({ code: job.error }) ?? jobLabel(job.state),
  };
}

function scheduleJobRecheck(jobId) {
  if (studyJobTimer) window.clearTimeout(studyJobTimer);
  if (!['queued', 'preparing', 'uploading', 'waiting_remote', 'downloading'].includes(bookAi.state.job?.status)) return;
  studyJobTimer = window.setTimeout(async () => {
    try {
      const result = await bookAiApi.reconcileStudyJob(jobId);
      bookAi.openJob(jobView(result.job));
      scheduleJobRecheck(jobId);
    } catch (error) {
      showBookAiError(error);
    }
  }, 2500);
}

$('book-ai-artifact-scope').addEventListener('change', renderArtifactTypeControls);
$('book-ai-generate').addEventListener('click', async () => {
  const s = bookAi.state;
  const scope = generationScope();
  const confirmWholeBook = scope.scope === 'book' && $('book-ai-whole-book-input').checked;
  if (scope.scope === 'book' && !confirmWholeBook) {
    showBookAiError({ code: 'cloud_confirmation_required' });
    return;
  }
  $('book-ai-generate').disabled = true;
  try {
    const result = await bookAiApi.createStudyJob(s.bookId, {
      artifactType: selectedArtifactType,
      contextScope: scope,
    }, { confirmWholeBook });
    bookAi.openJob(jobView(result.job));
    scheduleJobRecheck(result.job.id);
  } catch (error) {
    showBookAiError(error);
  } finally {
    renderArtifactTypeControls();
  }
});
$('book-ai-job-recheck').addEventListener('click', async () => {
  const job = bookAi.state.job;
  if (!job?.id) return;
  try {
    const result = await bookAiApi.reconcileStudyJob(job.id);
    bookAi.openJob(jobView(result.job));
    scheduleJobRecheck(job.id);
  } catch (error) {
    showBookAiError(error);
  }
});
$('book-ai-job-cancel').addEventListener('click', async () => {
  const job = bookAi.state.job;
  if (!job?.id) return;
  try {
    const result = await bookAiApi.cancelStudyJob(job.id);
    bookAi.openJob(jobView(result.job));
  } catch (error) {
    showBookAiError(error);
  }
});
renderArtifactTypeControls();

$('book-ai-job-back').addEventListener('click', () => {
  if (studyJobTimer) window.clearTimeout(studyJobTimer);
  studyJobTimer = null;
  bookAi.openAsk({
    personId: bookAi.state.personId,
    bookId: bookAi.state.bookId,
    bookTitle: bookAi.state.bookTitle,
    chapterIndex: bookAi.state.chapterIndex,
    chapterTitle: bookAi.state.chapterTitle,
    context: bookAi.state.context,
    selectedText: bookAi.state.selectedText,
  });
});

$('book-ai-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('book-ai-input');
  const draft = input.value;
  void sendBookAi(draft).then((sent) => {
    if (!sent) return;
    input.value = '';
    input.focus({ preventScroll: true });
  });
});
$('book-ai-input').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  $('book-ai-form').requestSubmit();
});
const BOOK_AI_COARSE = window.matchMedia('(pointer: coarse)');
$('book-ai-input').addEventListener('focus', () => {
  if (BOOK_AI_COARSE.matches) document.body.classList.add('editor-takeover');
});
$('book-ai-input').addEventListener('blur', (event) => {
  if (!BOOK_AI_COARSE.matches || !document.body.classList.contains('editor-takeover')) return;
  if (event.relatedTarget && $('book-ai-form').contains(event.relatedTarget)) return;
  document.body.classList.remove('editor-takeover');
});
$('book-ai-quick-prompts').replaceChildren(...BOOK_AI_QUICK_PROMPTS.map((prompt) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.prompt = prompt.id;
  button.textContent = prompt.label;
  button.addEventListener('click', () => {
    $('book-ai-input').value = prompt.text;
    $('book-ai-input').focus({ preventScroll: true });
  });
  return button;
}));
$('book-ai-new-conversation').addEventListener('click', () => {
  if (!bookAiApi || !bookAi.state.bookId) return;
  void bookAiApi.openBookConversation(bookAi.state.bookId, { newConversation: true })
    .then((conversation) => {
      bookAi.setConversation(conversation);
      return refreshBookAiConversations();
    })
    .catch(showBookAiError);
});
$('book-ai-delete-conversation').addEventListener('click', () => {
  const conversationId = bookAi.state.conversation?.id;
  if (!bookAiApi || !conversationId) return;
  void bookAiApi.deleteBookConversation(conversationId)
    .then(async () => {
      const remaining = (await bookAiApi.listBookConversations(bookAi.state.bookId))
        .filter((conversation) => conversation.id !== conversationId);
      bookAi.setConversations(remaining);
      if (remaining[0]) bookAi.setConversation(await bookAiApi.resumeBookConversation(remaining[0].id));
      else {
        const created = await bookAiApi.openBookConversation(bookAi.state.bookId, { newConversation: true });
        bookAi.setConversation(created);
        await refreshBookAiConversations();
      }
    })
    .catch(showBookAiError);
});

// Later artifact tickets drive these public transitions. Until then they remain
// unreachable product controls rather than simulated jobs or fake results.
window.learnbuddyBookAi = Object.freeze({
  openJob: (job) => bookAi.openJob(job),
  previewArtifact: (artifact) => bookAi.openArtifactPreview(artifact),
  returnToReading: () => bookAi.returnFromPreview(),
});

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
  bookAiApi = new ServerApi({ profile: storedProfile() });
});

render();
