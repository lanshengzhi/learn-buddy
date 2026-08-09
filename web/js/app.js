/**
 * LearnBuddy single-page app (ADR 0003) — reading area on top, editor at the
 * bottom, at every width and on every device. The editor rests as a band
 * (two lines with a mouse, one line on touch), expands to the lower half of
 * the screen when opened, and on touch devices takes over the full space
 * above the virtual keyboard while focused. No view switching: narrowing the
 * window changes nothing.
 *
 * The playback state machine lives in core/reader-controller.js (node-tested);
 * this file is the DOM binding plus the browser-only adapters (audio player,
 * blob URLs, audio ownership refs, history favorites).
 */

import { segmentationService } from './core/segmentation.js';
import { ReaderController } from './core/reader-controller.js';
import { TtsClient, ttsUrl } from './core/tts-client.js';
import { PlaybackPreferences } from './core/playback-preferences.js';
import { RATE_PRESETS } from './core/rate-presets.js';
import { LoopMode } from './core/loop-mode.js';
import { HtmlAudioPlayer } from './player.js';
import { historyRepository, audioOwnership, registerServiceWorker } from './bootstrap.js';
import { detectLanguage } from './core/language.js';

const $ = (id) => document.getElementById(id);

// --- DOM -------------------------------------------------------------------

const readingArea = $('reading-area');
const langBadge = $('lang-badge');
const loadingEl = $('reader-loading');
const errorEl = $('reader-error');
const emptyEl = $('reader-empty');
const listEl = $('sentence-list');
const bottomBar = $('bottom-bar');
const prevButton = $('prev-button');
const replayButton = $('replay-button');
const playButton = $('play-button');
const nextButton = $('next-button');
const rateSelect = $('rate-select');
const loopButton = $('loop-button');
const loopIcons = {
  [LoopMode.Off]: $('loop-off-icon'),
  [LoopMode.All]: $('loop-all-icon'),
  [LoopMode.One]: $('loop-one-icon'),
};

const editorRegion = $('editor-region');
const editorTabs = $('editor-tabs');
const tabEdit = $('tab-edit');
const tabHistory = $('tab-history');
const editPane = $('edit-pane');
const historyPane = $('history-pane');
const editorActions = $('editor-actions');
const textInput = $('text-input');
const pasteButton = $('paste-button');
const pasteError = $('paste-error');
const updateButton = $('update-button');
const autoToggle = $('auto-toggle');
const editorStatus = $('editor-status');
const historyList = $('history-list');
const historyEmpty = $('history-empty');
const filterAll = $('filter-all');
const filterFav = $('filter-fav');
const collapsedStatus = $('collapsed-status');
const collapsedInfo = $('collapsed-info');
const historyButton = $('history-button');
const collapseButton = $('collapse-button');

// Touch devices get the focus takeover (the virtual keyboard needs the room);
// with a mouse, focusing just expands the editor to the lower half (ADR 0003).
const COARSE_POINTER = window.matchMedia('(pointer: coarse)');
let isCoarse = COARSE_POINTER.matches;

// --- state -----------------------------------------------------------------

let text = '';
let activeEntryId = null; // History entry id backing offline replay ownership
let favFilter = 'all';
let editorTab = 'edit';
let editorCollapsed = true;
let debounceTimer = null;
let cards = [];

// --- reader controller (the Reading area's playback state machine) ---------

const ttsClient = new TtsClient();
const recordingTts = {
  speak: async (request) => {
    const blob = await ttsClient.speak(request);
    // Offline replay lives exactly as long as its History entry (ownership rule):
    // an uncommitted passage (auto re-segment) gets its entry on first play.
    if (activeEntryId == null) await ensureHistoryEntry();
    if (activeEntryId != null) {
      await audioOwnership.record(ttsUrl(request), activeEntryId);
    }
    return blob;
  },
};

const controller = new ReaderController({
  segmentation: segmentationService,
  tts: recordingTts,
  player: new HtmlAudioPlayer(),
  prefs: new PlaybackPreferences(localStorage),
  onHistoryProgress: (index) => historyRepository.updateLastSelectedIndex(text, index),
  onStateChange: applyState,
});

// --- history ---------------------------------------------------------------

function formatTime(createdAt) {
  const date = new Date(createdAt);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round((startOfToday - startOfDay) / 86400000);
  if (dayDiff === 0) {
    return `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (dayDiff === 1) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

async function renderHistory() {
  const entries = await historyRepository.getRecent();
  const filtered = favFilter === 'fav' ? entries.filter((e) => e.favorite) : entries;
  historyEmpty.hidden = filtered.length > 0;
  historyEmpty.textContent = favFilter === 'fav' ? '暂无收藏' : '暂无历史';
  historyList.replaceChildren();
  for (const entry of filtered) {
    const li = document.createElement('li');

    const star = document.createElement('button');
    star.type = 'button';
    star.className = `star-btn${entry.favorite ? ' on' : ''}`;
    star.textContent = entry.favorite ? '★' : '☆';
    star.setAttribute('aria-label', entry.favorite ? '取消收藏' : '收藏');
    star.addEventListener('click', async () => {
      await historyRepository.setFavorite(entry.id, !entry.favorite);
      await renderHistory();
    });

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'history-entry';
    open.textContent = entry.text;
    open.title = entry.text;
    open.addEventListener('click', () => void openHistoryEntry(entry));

    const time = document.createElement('span');
    time.className = 'entry-time';
    time.textContent = formatTime(entry.createdAt);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete-entry';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', '删除该历史');
    remove.addEventListener('click', async () => {
      await historyRepository.deleteEntry(entry.id);
      await renderHistory();
    });

    li.append(star, open, time, remove);
    historyList.append(li);
  }
}

/** Commits the current text to History (dedupe + trim) and caches its id. */
async function ensureHistoryEntry() {
  const entry = await historyRepository.add(text);
  activeEntryId = entry ? entry.id : null;
  return activeEntryId;
}

// --- passage loading -------------------------------------------------------

function setText(value) {
  text = value;
  textInput.value = value;
  updateButton.disabled = text.trim() === '';
  langBadge.hidden = text.trim() === '';
  if (text.trim() === '') langBadge.textContent = '';
}

/**
 * Re-segments `text`, keeping the selected sentence when its exact text still
 * exists; otherwise the first sentence is selected. Stops any playback first.
 * `commit` records the passage in History (dedupe) so offline replay works.
 */
async function resegment({ commit = false, initialIndex = -1 } = {}) {
  const current = controller.state.sentences[controller.state.selectedSentenceIndex];
  controller.dispose();
  let index = initialIndex;
  if (index < 0 && current) {
    const locale = detectLanguage(text);
    index = segmentationService.segment(text, locale).indexOf(current.text);
  }
  if (commit) await ensureHistoryEntry();
  await controller.loadText(text, index);
  renderSentences(controller.state.sentences);
  applyState();
  if (commit) await renderHistory();
}

async function openHistoryEntry(entry) {
  setText(entry.text);
  activeEntryId = entry.id;
  await resegment({ initialIndex: entry.lastSelectedIndex ?? -1 });
  setEditorCollapsed(true);
}

// --- the collapsible editor ------------------------------------------------

function applyLayout() {
  const collapsed = editorCollapsed;

  editorTabs.hidden = collapsed;
  editorActions.hidden = collapsed;
  collapsedStatus.hidden = !collapsed;
  editPane.hidden = collapsed ? false : editorTab !== 'edit';
  historyPane.hidden = collapsed || editorTab !== 'history';
  langBadge.hidden = text.trim() === '';
}

function setEditorCollapsed(collapsed) {
  editorCollapsed = collapsed;
  if (collapsed) {
    editorTab = 'edit';
    document.body.classList.remove('editor-takeover');
  }
  document.body.classList.toggle('editor-collapsed', collapsed);
  document.body.classList.toggle('editor-expanded', !collapsed);
  applyLayout();
}

function setEditorTab(tab) {
  editorTab = tab;
  tabEdit.classList.toggle('active', tab === 'edit');
  tabHistory.classList.toggle('active', tab === 'history');
  applyLayout();
}

function showPasteError(message) {
  pasteError.textContent = message;
  pasteError.hidden = false;
}

// --- rendering -------------------------------------------------------------

function renderSentences(sentences) {
  cards = [];
  listEl.replaceChildren();
  for (const sentence of sentences) {
    const li = document.createElement('li');
    li.dataset.index = String(sentence.index);
    li.textContent = sentence.text;
    li.addEventListener('click', () => {
      controller.onSentenceClicked(sentence.index);
      // Tapping a sentence means listening, not editing — collapse the editor.
      if (!editorCollapsed) setEditorCollapsed(true);
    });
    listEl.append(li);
    cards.push(li);
  }
}

function updateStatus() {
  const n = controller.state.sentences.length;
  const selected = controller.state.selectedSentenceIndex;
  const summary =
    n > 0
      ? `${n} 句 · 选中第 ${(selected ?? -1) + 1} 句 · ${detectLanguage(text)}`
      : '';
  editorStatus.textContent = summary;
  collapsedInfo.textContent = summary;
  langBadge.textContent = detectLanguage(text);
}

function applyState() {
  const s = controller.state;
  loadingEl.hidden = !s.isLoading;
  errorEl.hidden = !s.errorMessage;
  if (s.errorMessage) errorEl.textContent = s.errorMessage;
  emptyEl.hidden = s.isLoading || s.sentences.length > 0;
  bottomBar.hidden = s.sentences.length === 0;

  for (const card of cards) {
    const index = Number(card.dataset.index);
    card.classList.toggle('selected', s.selectedSentenceIndex === index);
    const isPlaying =
      s.playingSentenceIndex === index ||
      (s.isAudioLoading && s.selectedSentenceIndex === index);
    card.classList.toggle('playing', isPlaying);
    card.classList.toggle('loading', s.isAudioLoading && s.selectedSentenceIndex === index);
  }

  const selected = s.selectedSentenceIndex;
  prevButton.disabled = selected == null || selected <= 0;
  nextButton.disabled = selected == null || selected >= s.sentences.length - 1;
  replayButton.disabled = selected == null;
  const isActive = (s.playingSentenceIndex != null && !s.isAudioPaused) || s.isAudioLoading;
  playButton.disabled = selected == null && s.playingSentenceIndex == null && !s.isAudioLoading;
  // SVGElement has no `hidden` IDL — assigning `.hidden` on an SVG icon is a
  // non-reflecting expando, and CSS `[hidden] { display: none }` matches the
  // ATTRIBUTE. Use toggleAttribute so the triangle actually leaves.
  $('play-icon').toggleAttribute('hidden', isActive);
  $('pause-icon').toggleAttribute('hidden', !isActive);
  playButton.setAttribute('aria-label', isActive ? '暂停' : '播放');

  rateSelect.value = s.ratePreset.name;
  const loopLabel =
    s.loopMode === LoopMode.Off ? '关' : s.loopMode === LoopMode.All ? '全部' : '单句';
  loopButton.setAttribute('aria-label', `循环：${loopLabel}`);
  for (const [mode, icon] of Object.entries(loopIcons)) {
    icon.toggleAttribute('hidden', mode !== s.loopMode);
  }
  loopButton.classList.toggle('tinted', s.loopMode !== LoopMode.Off);

  followPlaying();
  updateStatus();
}

// Visual follow (page-turn style, ported from ReaderScreen.kt): stay still
// while the playing card is fully visible; scroll it to the top of the list
// viewport otherwise. Downward (forward) page-turns animate; targets above
// the viewport (loop wrap, upward retargeting) jump instantly.
function followPlaying() {
  const playing = controller.state.playingSentenceIndex;
  if (playing == null) return;
  const card = cards.find((c) => Number(c.dataset.index) === playing);
  if (!card) return;
  const listRect = listEl.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const fullyVisible = cardRect.top >= listRect.top && cardRect.bottom <= listRect.bottom;
  if (fullyVisible) return;
  if (cardRect.top < listRect.top) {
    listEl.scrollTop += cardRect.top - listRect.top;
  } else {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// --- controls --------------------------------------------------------------

for (const preset of RATE_PRESETS) {
  const option = document.createElement('option');
  option.value = preset.name;
  option.textContent = preset.label;
  rateSelect.append(option);
}

prevButton.addEventListener('click', () => controller.onPreviousClicked());
replayButton.addEventListener('click', () => controller.onReplayClicked());
nextButton.addEventListener('click', () => controller.onNextClicked());
playButton.addEventListener('click', () => {
  if (controller.state.playingSentenceIndex != null || controller.state.isAudioLoading) {
    controller.onPauseClicked();
  } else {
    controller.onPlayClicked();
  }
});
loopButton.addEventListener('click', () => controller.onLoopToggleClicked());
rateSelect.addEventListener('change', () => {
  const preset = RATE_PRESETS.find((p) => p.name === rateSelect.value);
  if (preset) controller.onRateSelected(preset);
});

// --- editor ----------------------------------------------------------------

textInput.addEventListener('input', () => {
  setText(textInput.value);
  if (autoToggle.checked && text.trim() !== '') {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void resegment(), 800);
  }
});

textInput.addEventListener('focus', () => {
  if (editorCollapsed) setEditorCollapsed(false);
  if (isCoarse) document.body.classList.add('editor-takeover');
});

textInput.addEventListener('blur', (e) => {
  if (!isCoarse || !document.body.classList.contains('editor-takeover')) return;
  // Tapping a control inside the editor (更新, tabs, 收起, paste) moves focus
  // to it — keep the takeover so that control's click still lands; the
  // control's own handler collapses. Tapping outside retreats the takeover.
  if (e.relatedTarget && editorRegion.contains(e.relatedTarget)) return;
  setEditorCollapsed(true);
});

pasteButton.addEventListener('click', async () => {
  try {
    if (!navigator.clipboard?.readText) {
      showPasteError('无法访问剪贴板——请手动粘贴。');
      textInput.focus();
      return;
    }
    const clipboardText = await navigator.clipboard.readText();
    if (!clipboardText || clipboardText.trim() === '') {
      showPasteError('剪贴板中没有文本。');
      return;
    }
    setText(clipboardText);
    pasteError.hidden = true;
  } catch {
    showPasteError('无法读取剪贴板——请手动粘贴。');
    textInput.focus();
  }
});

updateButton.addEventListener('click', () => {
  if (text.trim() === '') return;
  void resegment({ commit: true }).then(() => setEditorCollapsed(true));
});

autoToggle.addEventListener('change', () => {
  if (autoToggle.checked && text.trim() !== '') void resegment();
});

tabEdit.addEventListener('click', () => setEditorTab('edit'));
tabHistory.addEventListener('click', () => setEditorTab('history'));

historyButton.addEventListener('click', () => {
  setEditorCollapsed(false);
  setEditorTab('history');
});

collapseButton.addEventListener('click', () => setEditorCollapsed(true));

filterAll.addEventListener('click', () => {
  favFilter = 'all';
  filterAll.classList.add('active');
  filterFav.classList.remove('active');
  void renderHistory();
});
filterFav.addEventListener('click', () => {
  favFilter = 'fav';
  filterFav.classList.add('active');
  filterAll.classList.remove('active');
  void renderHistory();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !editorCollapsed) setEditorCollapsed(true);
});

// --- pointer handling ------------------------------------------------------

COARSE_POINTER.addEventListener('change', (e) => {
  isCoarse = e.matches;
  if (!isCoarse && document.body.classList.contains('editor-takeover')) {
    setEditorCollapsed(true);
  }
});

// --- boot ------------------------------------------------------------------

renderHistory();
registerServiceWorker();
// Empty text has nothing to read — invite the paste/edit surface. Once there
// is text, rest collapsed so the reading area owns the screen.
setEditorCollapsed(text.trim() !== '');
