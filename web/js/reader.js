/**
 * Reader screen — sentence cards, playback controls, Loop toggle, Rate
 * control, and visual follow. The state machine lives in
 * core/reader-controller.js (node-tested); this file is the DOM binding plus
 * the browser-only adapters (audio player, blob URLs, audio ownership refs).
 */

import { segmentationService } from './core/segmentation.js';
import { ReaderController } from './core/reader-controller.js';
import { TtsClient, ttsUrl } from './core/tts-client.js';
import { PlaybackPreferences } from './core/playback-preferences.js';
import { RATE_PRESETS } from './core/rate-presets.js';
import { LoopMode } from './core/loop-mode.js';
import { HtmlAudioPlayer } from './player.js';
import { historyRepository, audioOwnership, registerServiceWorker } from './bootstrap.js';

const text = sessionStorage.getItem('learnbuddy-pending-text') ?? '';
const initialSelected = Number(sessionStorage.getItem('learnbuddy-pending-selected') ?? -1);
if (text === '') location.replace('/index.html');

// --- DOM -------------------------------------------------------------------

const loadingEl = document.getElementById('reader-loading');
const errorEl = document.getElementById('reader-error');
const emptyEl = document.getElementById('reader-empty');
const listEl = document.getElementById('sentence-list');
const bottomBar = document.getElementById('bottom-bar');
const prevButton = document.getElementById('prev-button');
const replayButton = document.getElementById('replay-button');
const playButton = document.getElementById('play-button');
const nextButton = document.getElementById('next-button');
const rateSelect = document.getElementById('rate-select');
const loopButton = document.getElementById('loop-button');
const loopIcons = {
  [LoopMode.Off]: document.getElementById('loop-off-icon'),
  [LoopMode.All]: document.getElementById('loop-all-icon'),
  [LoopMode.One]: document.getElementById('loop-one-icon'),
};

document.getElementById('back-button').addEventListener('click', () => {
  location.href = '/index.html';
});

for (const preset of RATE_PRESETS) {
  const option = document.createElement('option');
  option.value = preset.name;
  option.textContent = preset.label;
  rateSelect.append(option);
}

// --- adapters ---------------------------------------------------------------

const historyEntryId = await historyRepository.entryIdForText(text);

const ttsClient = new TtsClient();
const recordingTts = {
  speak: async (request) => {
    const blob = await ttsClient.speak(request);
    // Record the audio reference against the open History entry so offline
    // replay lives exactly as long as its History entry (ADR 0008).
    if (historyEntryId != null) {
      await audioOwnership.record(ttsUrl(request), historyEntryId);
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

// --- rendering --------------------------------------------------------------

let cards = [];

function renderSentences(sentences) {
  cards = [];
  listEl.replaceChildren();
  for (const sentence of sentences) {
    const li = document.createElement('li');
    li.dataset.index = String(sentence.index);
    li.textContent = sentence.text;
    li.addEventListener('click', () => controller.onSentenceClicked(sentence.index));
    listEl.append(li);
    cards.push(li);
  }
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
    const isPlaying = s.playingSentenceIndex === index ||
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
  document.getElementById('play-icon').hidden = isActive;
  document.getElementById('pause-icon').hidden = !isActive;
  playButton.setAttribute('aria-label', isActive ? 'Pause' : 'Play');

  rateSelect.value = s.ratePreset.name;
  const loopLabel =
    s.loopMode === LoopMode.Off ? 'all off' : s.loopMode === LoopMode.All ? 'all on' : 'one on';
  loopButton.setAttribute('aria-label', `Loop ${loopLabel}`);
  for (const [mode, icon] of Object.entries(loopIcons)) {
    icon.hidden = mode !== s.loopMode;
  }
  loopButton.classList.toggle('tinted', s.loopMode !== LoopMode.Off);

  followPlaying();
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

// --- controls ---------------------------------------------------------------

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

await controller.loadText(text, initialSelected);
renderSentences(controller.state.sentences);
applyState();

registerServiceWorker();
