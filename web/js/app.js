/**
 * LearnBuddy single-page app (ADR 0003) — reading area on top, editor at the
 * bottom, at every width and on every device. The editor rests as a band
 * (two lines with a mouse, one line on touch), expands to the lower half of
 * the screen when opened, and on touch devices takes over the full space
 * above the virtual keyboard while focused. No view switching: narrowing the
 * window changes nothing.
 *
 * The Reading area shows one of two surfaces over the same playback bar
 * (ticket #19): the Book chapter body (BookView, book.js) or the pasted
 * passage's sentence cards. One ReaderController drives both — the
 * segmentation adapter delegates to the chapter's baked sentences or to
 * Intl.Segmenter — and the active mode decides where progress goes: the
 * server's Reading position (ADR 0007) or the History entry.
 */

import { segmentationService } from './core/segmentation.js';
import { ReaderController } from './core/reader-controller.js';
import { TtsClient } from './core/tts-client.js';
import { RATE_PRESETS } from './core/rate-presets.js';
import { LoopMode } from './core/loop-mode.js';
import { computeFollowAction } from './core/visual-follow.js';
import { HtmlAudioPlayer } from './player.js';
import { createHistoryRepository, registerServiceWorker } from './bootstrap.js';
import { ServerApi } from './core/api.js';
import { detectLanguage, normalizeLanguage } from './core/language.js';
import { storedProfile, switchProfile, storeProfile } from './browser/profile.js';
import { ServerPlaybackPreferences } from './browser/server-playback-preferences.js';
import { BookView } from './book.js';
import { createLearnLookupBridge } from './core/learn-lookup.js';
import { installBookLookupCards } from './core/book-lookup-card.js';

const $ = (id) => document.getElementById(id);

// --- DOM -------------------------------------------------------------------

const readingArea = $('reading-area');
const langBadge = $('lang-badge');
const loadingEl = $('reader-loading');
const errorEl = $('reader-error');
const emptyEl = $('reader-empty');
const listEl = $('sentence-list');
const readerBody = $('reader-body');
const cardsView = $('cards-view');
const bookViewEl = $('book-view');
const isNextShell = Boolean($('learn-face'));
const controls = (prefix = '') => ({
  bar: $(`${prefix}bottom-bar`), prev: $(`${prefix}prev-button`), replay: $(`${prefix}replay-button`),
  play: $(`${prefix}play-button`), next: $(`${prefix}next-button`), rate: $(`${prefix}rate-select`), loop: $(`${prefix}loop-button`),
  icons: { [LoopMode.Off]: $(`${prefix}loop-off-icon`), [LoopMode.All]: $(`${prefix}loop-all-icon`), [LoopMode.One]: $(`${prefix}loop-one-icon`) },
});
const bookControls = controls();
const learnControls = isNextShell ? controls('learn-') : bookControls;

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
const backToBook = $('back-to-book');
const profileChip = $('profile-chip');
const profileGate = $('profile-gate');
const profileChoices = $('profile-choices');
const toastEl = $('toast');

const LANGUAGE_LABELS = { en: '英语', ja: '日语', 'zh-CN': '中文' };

/** Locale code → Chinese UI label (zh-CN is the default, shown as 中文). */
function languageLabel(locale) {
  return LANGUAGE_LABELS[locale] ?? locale;
}

function setReadingLanguage(locale) {
  const normalized = normalizeLanguage(locale);
  if (normalized) document.body.dataset.readingLang = normalized;
  else delete document.body.dataset.readingLang;
}

// Touch devices get the focus takeover (the virtual keyboard needs the room);
// with a mouse, focusing just expands the editor to the lower half (ADR 0003).
const COARSE_POINTER = window.matchMedia('(pointer: coarse)');
let isCoarse = COARSE_POINTER.matches;

// --- shared state ------------------------------------------------------------

let text = '';
let activeEntryId = null; // History entry id backing the current pasted passage
let favFilter = 'all';
let editorTab = 'edit';
let editorCollapsed = true;
let debounceTimer = null;
let cards = [];

let mode = 'cards'; // legacy surface mode; /next visibility is face-driven
let controller = null; // book controller; remains the only controller on /
let learnController = null;
const pasteController = () => isNextShell ? learnController : controller;
let prefs = null;
let historyRepository = null;
let bookView = null;
let knownWords = new Set();
let chapterSentences = null; // the open chapter's baked sentences

const api = new ServerApi();
const player = new HtmlAudioPlayer();
const ttsClient = new TtsClient();

// The segmentation adapter delegates: book chapters arrive pre-segmented from
// the server (ADR 0007 — the browser does no segmentation of book text);
// pasted passages go through Intl.Segmenter as before.
const activeSegmentation = {
  segment: (value, locale) =>
    mode === 'book' && chapterSentences
      ? chapterSentences.map((sentence) => sentence.t)
      : segmentationService.segment(value, locale),
};

// --- boot ----------------------------------------------------------------------

registerServiceWorker();
bindControls();
void boot();

async function boot() {
  let profiles;
  try {
    profiles = await api.profiles();
  } catch (error) {
    showFatal(error.message ?? '无法连接服务器。');
    return;
  }
  let profileId = storedProfile();
  if (!profileId || !profiles.some((profile) => profile.id === profileId)) {
    profileId = await chooseProfile(profiles);
  }
  api.profile = profileId;

  let state;
  try {
    state = (await api.getState()) ?? {};
  } catch (error) {
    fatal(error.message ?? '无法读取阅读状态。');
    return;
  }
  prefs = new ServerPlaybackPreferences(api, state);
  try {
    knownWords = new Set(await api.getWords());
  } catch {
    knownWords = new Set();
  }
  historyRepository = createHistoryRepository(api);

  const readPrefs = isNextShell ? {
    ratePreset: () => prefs.ratePreset(),
    loopMode: () => prefs.loopMode() === LoopMode.One ? LoopMode.All : prefs.loopMode(),
    saveRatePreset: (preset) => prefs.saveRatePreset(preset),
    saveLoopMode: (loop) => prefs.saveLoopMode(loop),
  } : prefs;
  const makeController = ({ audioPlayer, onHistoryProgress, onStateChange, wrapLoopAll, nextLoopMode, controllerPrefs = prefs }) => new ReaderController({
    segmentation: activeSegmentation, tts: { speak: (request) => ttsClient.speak(request) },
    player: audioPlayer, prefs: controllerPrefs, onHistoryProgress, onStateChange, wrapLoopAll,
    ...(nextLoopMode ? { nextLoopMode } : {}),
  });
  controller = makeController({ audioPlayer: player, controllerPrefs: readPrefs, onHistoryProgress: (index) => isNextShell ? bookView?.reportPosition(index) : onProgress(index), onStateChange: applyState, wrapLoopAll: false,
    ...(isNextShell ? { nextLoopMode: (current) => current === LoopMode.Off ? LoopMode.All : LoopMode.Off } : {}) });
  if (isNextShell) {
    learnController = makeController({ audioPlayer: new HtmlAudioPlayer(), onHistoryProgress: (index) => historyRepository.updateLastSelectedIndex(text, index), onStateChange: applyLearnState, wrapLoopAll: true });
    await learnController.loadText('');
  }

  bookView = new BookView({
    api,
    isWide: () => window.matchMedia('(min-width: 820px)').matches,
    onView: setMode,
    loadChapter: loadChapter,
    followPlaying,
    toast: showToast,
    onSentenceTap: (index) => isNextShell ? controller.selectSentence(index) : controller.onSentenceClicked(index),
    knownWords,
    rateSsml: () => controller.state.ratePreset.ssmlRate,
  });
  if (isNextShell) installBookLookupCards({ bookView, api, knownWords, isNextShell });

  bindProfileChip(profiles, profileId);
  void renderHistory();
  applyState();

  // A-layout seam (#46): the /next shelf opens Books and reads which one is
  // current through this handle. Purely additive — the old shell at / never
  // touches it. BookView exists here, right after a Person was chosen.
  window.learnbuddyRead = {
    openBook: (bookId) => bookView?.openBook(bookId),
    currentBookId: () => bookView?.book?.id ?? null,
  };
  // Additive /next seam only; keep it absent from the live legacy shell.
  if (document.getElementById('learn-face')) {
    window.learnbuddyLookup = createLearnLookupBridge(bookView);
  }
  document.dispatchEvent(new CustomEvent('learnbuddy:read-ready'));

  const lastBook = state.lastBook;
  if (lastBook) {
    try {
      await bookView.openBook(lastBook);
      setEditorCollapsed(true);
      document.body.dataset.ready = '1';
      return;
    } catch {
      // The book is gone from the library — fall back to the paste surface.
    }
  }
  showCardsEmpty();
  document.body.dataset.ready = '1';
}

/** First-run (or stale-device) profile gate; resolves with the chosen id. */
function chooseProfile(profiles) {
  return new Promise((resolve) => {
    profileChoices.replaceChildren(
      ...profiles.map((profile) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn gate-choice';
        button.textContent = profile.name;
        button.addEventListener('click', () => {
          profileGate.hidden = true;
          storeProfile(profile.id);
          resolve(profile.id);
        });
        return button;
      }),
    );
    profileGate.hidden = false;
  });
}

/** The header chip: tap → the same gate, but switching reloads the app. */
function bindProfileChip() {
  const chip = $('profile-chip');
  chip.hidden = api.profile == null;
  chip.textContent = api.profile ?? '档案';
  chip.onclick = () => {
    void (async () => {
      let profiles = [];
      try {
        profiles = await api.profiles();
      } catch {
        showToast('取不到档案清单。');
        return;
      }
      profileChoices.replaceChildren(
        ...profiles.map((profile) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn gate-choice';
          button.textContent = `${profile.name}${profile.id === api.profile ? '（当前）' : ''}`;
          button.addEventListener('click', () => {
            if (profile.id === api.profile) {
              profileGate.hidden = true;
              return;
            }
            void (async () => {
              // Persist the pending position before the reload wipes context.
              bookView?.flushPosition();
              switchProfile(profile.id);
            })();
          });
          return button;
        }),
      );
      profileGate.hidden = false;
    })();
  };
}

function fatal(message) {
  showCardsEmpty();
  emptyEl.hidden = false;
  emptyEl.classList.add('error');
  emptyEl.textContent = message;
}

// --- surfaces -------------------------------------------------------------------

function setMode(next) {
  mode = next;
  if (controller) controller.wrapLoopAll = mode !== 'book';
  document.body.dataset.view = mode;
  if (!isNextShell) {
    cardsView.hidden = mode === 'book';
    bookViewEl.hidden = mode !== 'book';
  } else if (mode === 'book') {
    bookViewEl.hidden = false;
  }
  backToBook.hidden = mode === 'book';
  applyState();
}

/** Empty paste surface: invites paste or upload (no book open yet). */
function showCardsEmpty() {
  const paste = pasteController();
  if (!paste) return; // boot may fail before the controller exists — fatal() shows the message
  setMode('cards');
  setText('');
  void paste.loadText('');
  renderSentences(paste.state.sentences);
  applyLearnState();
  if (!isNextShell) {
    emptyEl.textContent = '在书库选一本书开始阅读，或在下方粘贴文本。';
    emptyEl.hidden = false;
    $('empty-library-btn').hidden = false;
  }
  setEditorCollapsed(false);
}

/** The BookView→controller bridge: a chapter's baked sentences take over. */
async function loadChapter(sentences, reading, locale, restored) {
  chapterSentences = sentences;
  setReadingLanguage(locale);
  setMode('book');
  await controller.loadText(
    sentences.map((sentence) => sentence.t).join('\n'),
    reading,
    locale,
  );
  applyState();
}

function onProgress(index) {
  if (mode === 'book') {
    bookView?.reportPosition(index);
    return;
  }
  historyRepository.updateLastSelectedIndex(text, index);
}

// --- history ---------------------------------------------------------------------

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

// --- passage loading -----------------------------------------------------------

function setText(value) {
  text = value;
  textInput.value = value;
  updateButton.disabled = text.trim() === '';
  langBadge.hidden = text.trim() === '';
  setReadingLanguage(text.trim() === '' ? null : detectLanguage(text));
  if (text.trim() === '') langBadge.textContent = '';
}

/**
 * Re-segments `text`, keeping the selected sentence when its exact text still
 * exists; otherwise the first sentence is selected. Stops any playback first.
 * Switches the surface to the pasted passage (the Book stays open in the
 * background — 回到书 brings it back).
 */
async function resegment({ commit = false, initialIndex = -1 } = {}) {
  setMode('cards');
  const paste = pasteController();
  const current = paste.state.sentences[paste.state.selectedSentenceIndex];
  paste.dispose();
  let index = initialIndex;
  if (index < 0 && current && mode === 'cards') {
    const locale = detectLanguage(text);
    index = segmentationService.segment(text, locale).indexOf(current.text);
  }
  if (commit) await ensureHistoryEntry();
  await paste.loadText(text, index);
  renderSentences(paste.state.sentences);
  applyLearnState();
  if (commit) await renderHistory();
}

async function openHistoryEntry(entry) {
  setText(entry.text);
  activeEntryId = entry.id;
  await resegment({ initialIndex: entry.lastSelectedIndex ?? -1 });
  setEditorCollapsed(true);
}

// --- the collapsible editor ------------------------------------------------------

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
  // The editor's height change resizes the reading viewport instantly on
  // fine pointers (desktop expand/collapse); re-follow so a playing sentence
  // newly covered by the playback bar scrolls back into view. On touch the
  // takeover animates flex-grow instead — the transitionend listener below
  // re-follows once the layout has settled.
  followPlaying();
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

// --- rendering -------------------------------------------------------------------

function renderSentences(sentences) {
  cards = [];
  listEl.replaceChildren();
  for (const sentence of sentences) {
    const li = document.createElement('li');
    li.dataset.index = String(sentence.index);
    li.setAttribute('role', 'button');
    li.tabIndex = 0;
    li.textContent = sentence.text;
    const playSentence = () => {
      pasteController().onSentenceClicked(sentence.index);
      // Tapping a sentence means listening, not editing — collapse the editor.
      if (!editorCollapsed) setEditorCollapsed(true);
    };
    li.addEventListener('click', playSentence);
    li.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      playSentence();
    });
    listEl.append(li);
    cards.push(li);
  }
}

function updateStatus() {
  const paste = pasteController();
  if (!paste) return;
  if (!isNextShell && mode === 'book' && bookView?.book) {
    const summary = `《${bookView.book.title || '未命名'}》 第 ${(bookView.chapterIndex ?? 0) + 1} 章 · 选中第 ${(controller.state.selectedSentenceIndex ?? -1) + 1} 句`;
    editorStatus.textContent = summary;
    collapsedInfo.textContent = summary;
    langBadge.hidden = true;
    return;
  }
  const n = paste.state.sentences.length;
  const selected = paste.state.selectedSentenceIndex;
  const summary =
    n > 0
      ? `${n} 句 · 选中第 ${(selected ?? -1) + 1} 句 · ${languageLabel(detectLanguage(text))}`
      : '';
  editorStatus.textContent = summary;
  collapsedInfo.textContent = summary;
  langBadge.textContent = languageLabel(detectLanguage(text));
}

function renderBar(s, c, keepVisible = false) {
  if (!c.bar) return;
  c.prev.disabled = s.selectedSentenceIndex == null || s.selectedSentenceIndex <= 0;
  c.next.disabled = s.selectedSentenceIndex == null || s.selectedSentenceIndex >= s.sentences.length - 1;
  c.replay.disabled = s.selectedSentenceIndex == null;
  const active = (s.playingSentenceIndex != null && !s.isAudioPaused) || s.isAudioLoading;
  c.play.disabled = s.selectedSentenceIndex == null && s.playingSentenceIndex == null && !s.isAudioLoading;
  const iconPrefix = isNextShell && c === learnControls ? 'learn-' : '';
  $(`${iconPrefix}play-icon`).toggleAttribute('hidden', active);
  $(`${iconPrefix}pause-icon`).toggleAttribute('hidden', !active);
  c.play.setAttribute('aria-label', active ? '暂停' : '播放');
  c.rate.value = s.ratePreset.name;
  const label = s.loopMode === LoopMode.Off ? '关' : s.loopMode === LoopMode.All ? '全部' : '单句';
  c.loop.setAttribute('aria-label', `循环：${label}`);
  for (const [kind, icon] of Object.entries(c.icons)) icon.toggleAttribute('hidden', kind !== s.loopMode);
  c.loop.classList.toggle('tinted', s.loopMode !== LoopMode.Off);
  c.bar.hidden = !keepVisible && s.sentences.length === 0;
}

function applyState() {
  if (!controller) return;
  const s = controller.state;
  if (!isNextShell) {
    if (mode === 'book') applyBookState(s);
    else applyCardsState(s);
    renderBar(s, bookControls);
    followPlaying();
    updateStatus();
    return;
  }
  applyBookState(s);
  renderBar(s, bookControls, true);
  followPlaying();
}

function applyLearnState() {
  const paste = pasteController();
  if (!paste) return;
  const s = paste.state;
  applyCardsState(s);
  renderBar(s, learnControls);
  followLearnPlaying();
  updateStatus();
}

function applyCardsState(s) {
  loadingEl.hidden = !s.isLoading;
  errorEl.hidden = !s.errorMessage;
  if (s.errorMessage) errorEl.textContent = s.errorMessage;
  emptyEl.hidden = s.isLoading || s.sentences.length > 0;
  if (!isNextShell) learnControls.bar.hidden = s.sentences.length === 0;

  for (const card of cards) {
    const index = Number(card.dataset.index);
    const isSelected = s.selectedSentenceIndex === index;
    card.classList.toggle('selected', isSelected);
    if (isSelected) card.setAttribute('aria-current', 'true');
    else card.removeAttribute('aria-current');
    const isPlaying =
      s.playingSentenceIndex === index ||
      (s.isAudioLoading && s.selectedSentenceIndex === index);
    card.classList.toggle('playing', isPlaying);
    card.classList.toggle('loading', s.isAudioLoading && s.selectedSentenceIndex === index);
  }
}

function applyBookState(s) {
  if (!isNextShell) bookControls.bar.hidden = s.sentences.length === 0;
  const sentences = bookView?.chapterBody?.querySelectorAll('.sent') ?? [];
  for (const sentence of sentences) {
    const index = Number(sentence.dataset.sentence);
    const isSelected = s.selectedSentenceIndex === index;
    sentence.classList.toggle('selected', isSelected);
    if (isSelected) sentence.setAttribute('aria-current', 'true');
    else sentence.removeAttribute('aria-current');
    const isPlaying =
      s.playingSentenceIndex === index ||
      (s.isAudioLoading && s.selectedSentenceIndex === index);
    sentence.classList.toggle('playing', isPlaying);
  }
}

// Visual follow (page-turn style, ported from ReaderScreen.kt): stay still
// while the playing card is fully visible; scroll it to the top of the list
// viewport otherwise. Downward (forward) page-turns animate; targets above
// the viewport (loop wrap, upward retargeting) jump instantly. The geometry
// decision lives in core/visual-follow.js (node-tested); this binding only
// executes the returned action. The viewport is #reader-body or #book-scroll
// — the list's scroll container — never the content element itself.
function followController(controllerToFollow, container, selector) {
  const playing = controllerToFollow?.state.playingSentenceIndex;
  if (playing == null) return;
  const card = [...document.querySelectorAll(selector)].find((el) => Number(el.dataset.sentence ?? el.dataset.index) === playing);
  if (!card) return;
  const action = computeFollowAction(container.getBoundingClientRect(), card.getBoundingClientRect());
  if (action === 'jump-top-instant') card.scrollIntoView({ behavior: 'instant', block: 'start' });
  else if (action === 'scroll-top-smooth') card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function followPlaying() {
  if (!isNextShell && mode !== 'book') followController(controller, readerBody, '.sentence-list li');
  else followController(controller, $('book-scroll'), '.sent');
}
function followLearnPlaying() { followController(pasteController(), readerBody, '.sentence-list li'); }

// Layout changes mid-playback (window resize, editor collapse/expand) can
// newly cover the playing sentence without any state change — re-run the
// follow then. Deliberately NOT the scroll event: that would fight the
// learner's own scrolling while a sentence is playing.
let followScheduled = false;
window.addEventListener('resize', () => {
  if (followScheduled) return;
  followScheduled = true;
  requestAnimationFrame(() => {
    followScheduled = false;
    followPlaying();
  });
});
// The editor expand/collapse animates #reading-area's flex-grow (ADR 0003);
// re-follow once the new viewport has settled.
readingArea.addEventListener('transitionend', (e) => {
  if (e.propertyName === 'flex-grow') followPlaying();
});

// --- controls ----------------------------------------------------------------------

function bindControls() {
  for (const c of [bookControls, ...(isNextShell ? [learnControls] : [])]) {
    for (const preset of RATE_PRESETS) {
      const option = document.createElement('option'); option.value = preset.name; option.textContent = preset.label; c.rate.append(option);
    }
    const target = c === bookControls ? () => controller : pasteController;
    c.prev.addEventListener('click', () => target()?.onPreviousClicked());
    c.replay.addEventListener('click', () => target()?.onReplayClicked());
    c.next.addEventListener('click', () => target()?.onNextClicked());
    c.play.addEventListener('click', () => {
      const playerController = target(); if (!playerController) return;
      if (playerController.state.playingSentenceIndex != null || playerController.state.isAudioLoading) playerController.onPauseClicked();
      else playerController.onPlayClicked();
    });
    c.loop.addEventListener('click', () => target()?.onLoopToggleClicked());
    c.rate.addEventListener('change', () => {
      const preset = RATE_PRESETS.find((p) => p.name === c.rate.value);
      if (preset) target()?.onRateSelected(preset);
    });
  }

  // --- editor ----------------------------------------------------------------

  textInput.addEventListener('input', () => {
    setText(textInput.value);
    if (autoToggle.checked && pasteController() && text.trim() !== '') {
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
    if (text.trim() === '' || !pasteController()) return;
    void resegment({ commit: true }).then(() => setEditorCollapsed(true));
  });

  autoToggle.addEventListener('change', () => {
    if (autoToggle.checked && text.trim() !== '' && pasteController()) void resegment();
  });

  tabEdit.addEventListener('click', () => setEditorTab('edit'));
  tabHistory.addEventListener('click', () => setEditorTab('history'));

  historyButton.addEventListener('click', () => {
    void renderHistory();
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

  // --- book surface -----------------------------------------------------------

  $('empty-library-btn').addEventListener('click', () => bookView?.openLibrary());
  backToBook.addEventListener('click', () => {
    if (!bookView) return;
    if (bookView.book) void bookView.openChapter(bookView.chapterIndex ?? 0);
    else void bookView.openLibrary();
  });

  bindProfileChip();

  // --- keyboard (PC) ------------------------------------------------------------

  document.addEventListener('keydown', handleKeydown);

  COARSE_POINTER.addEventListener('change', (e) => {
    isCoarse = e.matches;
    if (!isCoarse && document.body.classList.contains('editor-takeover')) {
      setEditorCollapsed(true);
    }
  });
}

function handleKeydown(e) {
  if (!controller) return;
  if (e.key === 'Escape') {
    bookView?.closeOverlays();
    if (!editorCollapsed) setEditorCollapsed(true);
    return;
  }
  if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if (e.key === ' ') {
    e.preventDefault();
    (document.body.dataset.face === 'read' ? bookControls.play : learnControls.play).click();
    return;
  }
  if (e.key === 'ArrowRight') (document.body.dataset.face === 'read' ? bookControls.next : learnControls.next).click();
  if (e.key === 'ArrowLeft') (document.body.dataset.face === 'read' ? bookControls.prev : learnControls.prev).click();
  if (isNextShell) {
    if (e.key === 'a' && document.body.dataset.face === 'read') bookView.openAiTab();
    return;
  }
  if (mode !== 'book') return;
  if (e.key === 'k') void bookView.markCurrentKnown();
  if (e.key === 'n') {
    const from =
      controller.state.playingSentenceIndex ?? controller.state.selectedSentenceIndex ?? 0;
    const hit = bookView.nextUnknown(from);
    if (hit) bookView.openWord(hit.sentenceIndex, hit.token.text);
    else showToast('这一章没有未标记的生词了。');
  }
  if (e.key === 'a') bookView.openAiTab();
}

// --- toast ---------------------------------------------------------------------

let toastTimer = null;

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3000);
}
