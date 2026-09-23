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

import { ShellController, Layer } from '/js/core/shell-controller.js';

const $ = (id) => document.getElementById(id);

const NARROW = window.matchMedia('(max-width: 899.98px)');
const WORD_SELECTION_MAX = 3; // §4.3: ≤3 chars is a word → word card, not the toolbar

const shell = new ShellController({ narrow: NARROW.matches, onEvent: render });

const d3 = $('d3');
const shellScrim = $('shell-scrim');
const selToolbar = $('sel-toolbar');
const selCopy = $('sel-copy');
const lookupDrawer = $('lookup-drawer');

// --- render: state → DOM (idempotent; the shell DOM is tiny) ---------------

function render() {
  const { openLayers, navCollapsed, narrow } = shell.state;
  d3.hidden = !openLayers.includes(Layer.D3);
  const drawerOpen = narrow && openLayers.includes(Layer.Drawer);
  document.body.classList.toggle('drawer-open', drawerOpen);
  shellScrim.hidden = !drawerOpen;
  document.body.classList.toggle('nav-collapsed', navCollapsed && !narrow);
  const toolbarOpen = openLayers.includes(Layer.Toolbar);
  selToolbar.hidden = !toolbarOpen;
  if (toolbarOpen) positionToolbar();
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
$('nav-history').addEventListener('click', () => $('history-button').click());

// Chat：切片 1 惰性占位（按钮 disabled，这里仅防御）。
$('nav-chat').addEventListener('click', () => {});

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
