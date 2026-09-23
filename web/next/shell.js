/**
 * Shell DOM adapter (map #40, slice 1) — wires ShellController to the DOM.
 * The reader is owned by /js/app.js, unchanged; this module only owns the
 * shell chrome: nav, identity chip, D3 placeholder, drawer, and the
 * selection toolbar.
 *
 * Hard rules from spec §4.2 baked in here:
 *  - #2/#3: opening/closing D3 never touches #shell-main, and every
 *    geometry read (toolbar position, word-card scroll) is live — no
 *    cached offsets anywhere in this file.
 *  - #4: when the word card opens on narrow, the looked-up sentence is
 *    scrolled to the visible strip above the card (scroll-padding-top).
 *  - #6: focusing the editor's textarea collapses the selection toolbar.
 */

import { ShellController, Layer, Face } from '/js/core/shell-controller.js';
import { initShelf } from './shelf.js';
import { initChat } from './chat.js';

const $ = (id) => document.getElementById(id);

const NARROW = window.matchMedia('(max-width: 899.98px)');
const WORD_SELECTION_MAX = 3; // §4.3: ≤3 chars is a word → word card, not the toolbar

const shell = new ShellController({ narrow: NARROW.matches, onEvent: render });

const d3 = $('d3');
const shellScrim = $('shell-scrim');
const selToolbar = $('sel-toolbar');
const selCopy = $('sel-copy');
const lookupDrawer = $('lookup-drawer');
const chatFace = $('chat-face');
const readingArea = $('reading-area');
const editorRegion = $('editor-region');
const navChat = $('nav-chat');
const navRead = $('nav-read');
const navHistory = $('nav-history');
const navShelf = $('nav-shelf');
const navConversations = $('nav-conversations');
const d3Trigger = $('d3-trigger');
const d3TriggerNarrow = $('d3-trigger-narrow');
const topbarTitle = $('shell-topbar-title');

// --- render: state → DOM (idempotent; the shell DOM is tiny) ---------------

function render() {
  const { openLayers, navCollapsed, narrow, activeFace } = shell.state;
  d3.hidden = !openLayers.includes(Layer.D3);
  const drawerOpen = narrow && openLayers.includes(Layer.Drawer);
  document.body.classList.toggle('drawer-open', drawerOpen);
  shellScrim.hidden = !drawerOpen;
  document.body.classList.toggle('nav-collapsed', navCollapsed && !narrow);
  const toolbarOpen = openLayers.includes(Layer.Toolbar);
  selToolbar.hidden = !toolbarOpen;
  if (toolbarOpen) positionToolbar();

  // Face switch (ticket #47): both faces stay mounted; only `hidden`
  // toggles — the reading pane is NEVER rebuilt (spec §4.2 #2), so Chat and
  // Read keep their own state and never see each other's (user story 20).
  const chatActive = activeFace === Face.Chat;
  chatFace.hidden = !chatActive;
  readingArea.hidden = chatActive;
  editorRegion.hidden = chatActive;
  navChat.classList.toggle('active', chatActive);
  navRead.classList.toggle('active', !chatActive);
  if (chatActive) navChat.setAttribute('aria-current', 'page');
  else navChat.removeAttribute('aria-current');
  if (chatActive) navRead.removeAttribute('aria-current');
  else navRead.setAttribute('aria-current', 'page');
  // The contextual panels and Read-only entries swap with the face.
  navConversations.hidden = !chatActive;
  navShelf.hidden = chatActive;
  navHistory.hidden = chatActive;
  d3Trigger.hidden = chatActive;
  d3TriggerNarrow.hidden = chatActive;
  topbarTitle.textContent = chatActive ? 'Chat' : 'Read';
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

// 阅读记录入口：现役 History 面板（编辑区「历史」按钮的既有行为）。
navHistory.addEventListener('click', () => $('history-button').click());

// Face 切换（#47）：Chat / Read 都只切 hidden；窄屏下从抽屉点完即收。
navChat.addEventListener('click', () => {
  shell.setFace(Face.Chat);
  shell.close(Layer.Drawer);
});
navRead.addEventListener('click', () => {
  shell.setFace(Face.Read);
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

// --- D3 placeholder (slice 1 trigger; slice 2: word card 追问 → / AI问书) ---

$('d3-trigger').addEventListener('click', () => shell.open(Layer.D3));
$('d3-trigger-narrow').addEventListener('click', () => shell.open(Layer.D3));
$('d3-back').addEventListener('click', () => shell.close(Layer.D3));

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

// --- selection toolbar (slice 1: copy only) -----------------------------------

let selectionTimer = null;
document.addEventListener('selectionchange', () => {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (!selection || selection.isCollapsed || text.length <= WORD_SELECTION_MAX) {
      shell.close(Layer.Toolbar);
      return;
    }
    const anchor =
      selection.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode
        : selection.anchorNode?.parentElement;
    if (!anchor?.closest('#chapter-body, #sentence-list')) {
      shell.close(Layer.Toolbar);
      return;
    }
    shell.open(Layer.Toolbar);
  }, 150);
});

// §4.2 #6: the keyboard belongs to the bottom sheet — the toolbar retreats.
$('text-input').addEventListener('focus', () => shell.close(Layer.Toolbar));

// §4.3 硬约束:查词与问书只能按选区长度分流。book.js 的旧行为会对 ≤30 字
// 的选区弹词卡;新壳里长选(>3 字)归工具条 —— capture 阶段拦下 pointerup,
// book.js 的处理器收不到;短选照常放行给词卡。
$('chapter-body').addEventListener(
  'pointerup',
  (event) => {
    if (event.pointerType === 'touch') return;
    const text = window.getSelection()?.toString().trim() ?? '';
    if (text.length > WORD_SELECTION_MAX) event.stopPropagation();
  },
  true,
);

// Preserve the selection across the copy tap (mousedown would collapse it).
selCopy.addEventListener('mousedown', (event) => event.preventDefault());
selCopy.addEventListener('click', async () => {
  const text = window.getSelection()?.toString() ?? '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    selCopy.textContent = '已复制';
    setTimeout(() => {
      selCopy.textContent = '复制';
    }, 900);
  } catch {
    /* clipboard unavailable (non-secure context) — the selection stays for Ctrl+C */
  }
  shell.close(Layer.Toolbar);
});

render();
