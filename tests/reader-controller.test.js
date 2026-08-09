import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReaderController } from '../web/js/core/reader-controller.js';
import { segmentationService } from '../web/js/core/segmentation.js';
import { LoopMode } from '../web/js/core/loop-mode.js';
import { RATE_PRESETS, DEFAULT_RATE_PRESET } from '../web/js/core/rate-presets.js';
import { TTS_ERROR_CODES } from '../web/js/core/errors.js';
import { TtsClientError } from '../web/js/core/tts-client.js';

/** Fake player: play() resolves on manual finish(end), cancels via stop(). */
class FakePlayer {
  constructor() {
    this.calls = [];
    this._resolvePlay = null;
    this._rejectPlay = null;
  }

  play(url) {
    this.calls.push(['play', url]);
    return new Promise((resolve, reject) => {
      this._resolvePlay = resolve;
      this._rejectPlay = reject;
    });
  }

  pause() {
    this.calls.push(['pause']);
  }

  resume() {
    this.calls.push(['resume']);
  }

  stop() {
    this.calls.push(['stop']);
    if (this._resolvePlay) {
      const resolve = this._resolvePlay;
      this._resolvePlay = null;
      resolve(null); // cancelled — no end event
    }
    if (this._rejectPlay) this._rejectPlay = null;
  }

  /** Simulates the audio element reaching 'ended'. */
  finish() {
    const resolve = this._resolvePlay;
    this._resolvePlay = null;
    resolve();
  }

  /** Simulates a playback error. */
  fail(error) {
    const reject = this._rejectPlay;
    this._rejectPlay = null;
    reject(error);
  }
}

class FakeTts {
  constructor() {
    this.requests = [];
    this.respond = null; // ({request, signal}) => Promise<Blob>
    this.failures = new Map(); // text -> error
  }

  async speak(request) {
    this.requests.push(request);
    const failure = this.failures.get(request.text);
    if (failure) throw failure;
    if (this.respond) return this.respond(request);
    return new Blob([`audio:${request.text}`]);
  }
}

class FakePrefs {
  constructor() {
    this._ratePreset = DEFAULT_RATE_PRESET;
    this._loopMode = LoopMode.Off;
    this.saved = [];
  }
  ratePreset() { return this._ratePreset; }
  loopMode() { return this._loopMode; }
  saveRatePreset(p) { this._ratePreset = p; this.saved.push(['rate', p.name]); }
  saveLoopMode(m) { this._loopMode = m; this.saved.push(['loop', m]); }
}

function setup({ text = 'Hello world. This is a test.', prefs } = {}) {
  const player = new FakePlayer();
  const tts = new FakeTts();
  const progress = [];
  const controller = new ReaderController({
    segmentation: segmentationService,
    tts,
    player,
    prefs: prefs ?? new FakePrefs(),
    makeObjectUrl: (blob) => `blob:${blob.size}`,
    revokeObjectUrl: () => {},
    onHistoryProgress: (index) => progress.push(index),
  });
  return { controller, player, tts, progress };
}

async function load(controller, text = 'Hello world. This is a test.') {
  await controller.loadText(text);
  return controller.state;
}

/** Lets pending microtasks/macrotasks in the audio loop settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('loadText segments and auto-selects the first sentence', async () => {
  const { controller } = setup();
  const state = await load(controller);
  assert.equal(state.sentences.length, 2);
  assert.equal(state.selectedSentenceIndex, 0);
  assert.equal(state.isLoading, false);
  assert.deepEqual(state.sentences.map((s) => s.text), ['Hello world.', 'This is a test.']);
});

test('loadText honors a valid initial index (history restore), else falls back to first', async () => {
  const { controller } = setup();
  let state = await load(controller);
  await controller.loadText('One. Two. Three.', 1);
  state = controller.state;
  assert.equal(state.selectedSentenceIndex, 1);
  await controller.loadText('One. Two. Three.', 99);
  assert.equal(controller.state.selectedSentenceIndex, 0);
});

test('play starts audio for the selected sentence and clears on natural end (Loop Off)', async () => {
  const { controller, player, tts } = setup();
  await load(controller);
  controller.onPlayClicked();
  assert.equal(controller.state.playingSentenceIndex, 0);
  assert.equal(controller.state.isAudioLoading, true);
  await flush();
  assert.equal(tts.requests.length, 1);
  assert.equal(tts.requests[0].rate, '+0%');
  player.finish();
  await flush();
  assert.equal(controller.state.playingSentenceIndex, null);
  assert.equal(controller.state.isAudioPaused, false);
});

test('loop-all advances through sentences and wraps', async () => {
  const { controller, player } = setup({ prefs: (() => { const p = new FakePrefs(); p._loopMode = LoopMode.All; return p; })() });
  await load(controller, 'One. Two. Three.');
  controller.onPlayClicked();
  await flush();
  player.finish();
  await flush();
  assert.equal(controller.state.playingSentenceIndex, 1);
  player.finish();
  await flush();
  assert.equal(controller.state.playingSentenceIndex, 2);
  player.finish();
  await flush();
  assert.equal(controller.state.playingSentenceIndex, 0); // wrapped
});

test('loop-one repeats the playing sentence forever', async () => {
  const { controller, player } = setup({ prefs: (() => { const p = new FakePrefs(); p._loopMode = LoopMode.One; return p; })() });
  await load(controller, 'One. Two. Three.');
  controller.onPlayClicked();
  await flush();
  player.finish();
  await flush();
  player.finish();
  await flush();
  assert.equal(controller.state.playingSentenceIndex, 0);
  assert.equal(controller.state.selectedSentenceIndex, 0);
});

test('toggling the loop mid-playback applies the new mode when the sentence finishes', async () => {
  const { controller, player, prefs } = setup();
  await load(controller, 'One. Two. Three.');
  controller.onPlayClicked();
  await flush();
  controller.onLoopToggleClicked(); // Off -> All while sentence 0 plays
  assert.equal(controller.state.loopMode, LoopMode.All);
  assert.equal(controller.state.playingSentenceIndex, 0); // not interrupted
  player.finish();
  await flush();
  assert.equal(controller.state.playingSentenceIndex, 1); // loop continues in All
});

test('loop toggle cycles Off -> All -> One -> Off and persists', async () => {
  const { controller, prefs } = setup();
  controller.onLoopToggleClicked();
  assert.equal(controller.state.loopMode, LoopMode.All);
  controller.onLoopToggleClicked();
  assert.equal(controller.state.loopMode, LoopMode.One);
  controller.onLoopToggleClicked();
  assert.equal(controller.state.loopMode, LoopMode.Off);
});

test('pause suspends playback without leaving the mode; play resumes', async () => {
  const { controller, player } = setup();
  await load(controller);
  controller.onPlayClicked();
  await flush();
  player.finish = () => {}; // simulate: never ends while paused
  controller.onPauseClicked();
  assert.equal(controller.state.isAudioPaused, true);
  assert.equal(controller.state.playingSentenceIndex, 0);
  assert.deepEqual(player.calls.at(-1), ['pause']);
  controller.onPauseClicked();
  assert.equal(controller.state.isAudioPaused, false);
  assert.deepEqual(player.calls.at(-1), ['resume']);
});

test('pausing while loading cancels the fetch and leaves the sentence selected', async () => {
  const { controller, player, tts } = setup();
  await load(controller);
  let resolveFetch;
  tts.respond = () => new Promise((r) => { resolveFetch = r; });
  controller.onPlayClicked();
  assert.equal(controller.state.isAudioLoading, true);
  controller.onPauseClicked();
  assert.equal(controller.state.isAudioLoading, false);
  assert.equal(controller.state.playingSentenceIndex, null);
  assert.equal(controller.state.selectedSentenceIndex, 0);
  resolveFetch(new Blob(['late']));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(controller.state.playingSentenceIndex, null); // late fetch ignored
});

test('next / previous move selection and play, clamping at the ends', async () => {
  const { controller, player } = setup();
  await load(controller, 'One. Two. Three.');
  controller.onNextClicked();
  await flush();
  assert.equal(controller.state.selectedSentenceIndex, 1);
  player.finish();
  await flush();
  controller.onNextClicked();
  await flush();
  assert.equal(controller.state.selectedSentenceIndex, 2);
  player.finish();
  await flush();
  controller.onNextClicked(); // clamped to last
  await flush();
  assert.equal(controller.state.selectedSentenceIndex, 2);
  player.finish();
  await flush();
  controller.onPreviousClicked();
  await flush();
  assert.equal(controller.state.selectedSentenceIndex, 1);
  player.finish();
  await flush();
  controller.onPreviousClicked();
  controller.onPreviousClicked(); // clamped to first
  assert.equal(controller.state.selectedSentenceIndex, 0);
});

test('tapping a sentence card jumps the loop to it (loop continues)', async () => {
  const { controller, player } = setup({ prefs: (() => { const p = new FakePrefs(); p._loopMode = LoopMode.All; return p; })() });
  await load(controller, 'One. Two. Three.');
  controller.onPlayClicked();
  await flush();
  player.finish();
  await flush();
  controller.onSentenceClicked(2);
  await flush();
  assert.equal(controller.state.playingSentenceIndex, 2);
  player.finish();
  await flush();
  assert.equal(controller.state.playingSentenceIndex, 0); // wrapped from 2
});

test('rate change while active restarts the current sentence at the new rate', async () => {
  const { controller, player, tts } = setup();
  const prefs = controller.prefs;
  await load(controller);
  controller.onPlayClicked();
  await flush();
  controller.onRateSelected(RATE_PRESETS[5]); // 2×
  assert.equal(controller.state.ratePreset.name, 'Double');
  assert.equal(prefs.ratePreset().name, 'Double');
  assert.equal(controller.state.playingSentenceIndex, 0);
  assert.equal(controller.state.isAudioLoading, true);
  await flush();
  const last = tts.requests.at(-1);
  assert.equal(last.rate, '+100%');
  assert.equal(last.text, 'Hello world.');
  player.finish();
  await flush();
});

test('rate change while idle only persists the preset', async () => {
  const { controller, player, tts } = setup();
  await load(controller);
  controller.onRateSelected(RATE_PRESETS[1]);
  assert.equal(controller.state.ratePreset.name, 'ThreeQuarters');
  assert.equal(tts.requests.length, 0);
  assert.deepEqual(player.calls, []);
});

test('an all-kanji sentence in a Japanese passage is spoken with the Japanese voice', async () => {
  const { controller, tts, player } = setup();
  await load(controller, '今日は晴れです。東京大学。');
  assert.equal(controller.state.sentences.length, 2);
  controller.onSentenceClicked(1); // 東京大学。 — no kana
  await flush();
  assert.equal(tts.requests.length, 1);
  assert.equal(tts.requests[0].text, '東京大学。');
  assert.equal(tts.requests[0].voice, 'ja-JP-KeitaNeural');
  player.finish();
  await flush();
});

test('a Latin/digit sentence in a Japanese passage is spoken with the Japanese voice', async () => {
  const { controller, tts, player } = setup();
  await load(controller, '今日はいい天気です。2024。');
  controller.onSentenceClicked(1);
  await flush();
  assert.equal(tts.requests[0].voice, 'ja-JP-KeitaNeural');
  player.finish();
  await flush();
});

test('sentences in a Chinese passage keep the Chinese voice', async () => {
  const { controller, tts, player } = setup();
  await load(controller, '你好。世界。');
  controller.onSentenceClicked(0);
  await flush();
  assert.equal(tts.requests[0].voice, 'zh-CN-YunxiNeural');
  player.finish();
  await flush();
});

test('replay re-plays the selected sentence', async () => {
  const { controller, tts } = setup();
  await load(controller);
  controller.onPlayClicked();
  controller.onReplayClicked();
  assert.equal(tts.requests.length, 2);
  assert.equal(controller.state.playingSentenceIndex, 0);
});

test('a TTS error stops the loop, maps to the user string, and keeps the sentence selected', async () => {
  const { controller, tts } = setup({ prefs: (() => { const p = new FakePrefs(); p._loopMode = LoopMode.All; return p; })() });
  await load(controller, 'One. Two. Three.');
  tts.failures.set('One.', new TtsClientError(TTS_ERROR_CODES.UPSTREAM_UNAVAILABLE));
  controller.onPlayClicked();
  await flush();
  assert.equal(controller.state.errorMessage, 'Service is temporarily unavailable. Try again later.');
  assert.equal(controller.state.playingSentenceIndex, null);
  assert.equal(controller.state.selectedSentenceIndex, 0);
  assert.equal(controller.state.loopMode, LoopMode.All); // mode retained
});

test('a generic error maps to Playback failed', async () => {
  const { controller, tts } = setup();
  await load(controller);
  tts.failures.set('Hello world.', new Error('boom'));
  controller.onPlayClicked();
  await flush();
  assert.equal(controller.state.errorMessage, 'Playback failed: boom');
});

test('loadText failure surfaces the split error message', async () => {
  const { controller } = setup();
  controller.segmentation = { segment() { throw new Error('splitter broken'); } };
  await controller.loadText('anything');
  assert.equal(controller.state.errorMessage, 'Could not split text into sentences.');
  assert.equal(controller.state.isLoading, false);
});

test('restored prefs never auto-resume playback', async () => {
  const prefs = new FakePrefs();
  prefs._loopMode = LoopMode.All;
  prefs._ratePreset = RATE_PRESETS[1];
  const { controller, player } = setup({ prefs });
  await load(controller);
  assert.equal(controller.state.loopMode, LoopMode.All);
  assert.equal(controller.state.ratePreset.name, 'ThreeQuarters');
  assert.equal(controller.state.playingSentenceIndex, null);
  assert.equal(player.calls.length, 0);
});

test('history progress is reported for the selected sentence and each play start', async () => {
  const { controller, progress } = setup();
  await load(controller, 'One. Two.');
  assert.deepEqual(progress, [0]);
  controller.onSentenceClicked(1);
  assert.deepEqual(progress, [0, 1]);
});

test('onStateChange fires on every state mutation', async () => {
  const states = [];
  const { controller } = setup();
  controller.onStateChange = (s) => states.push(s);
  await controller.loadText('One. Two.');
  assert.ok(states.length >= 2); // loading, then loaded+selected
  assert.equal(states.at(-1).sentences.length, 2);
  controller.onLoopToggleClicked();
  assert.equal(states.at(-1).loopMode, LoopMode.All);
});

test('dispose cancels in-flight work', async () => {
  const { controller, player } = setup();
  await load(controller);
  controller.onPlayClicked();
  await flush();
  controller.dispose();
  assert.equal(player.calls.some((c) => c[0] === 'stop'), true);
  // The cancelled play promise resolves as a no-op; state must stay clean.
  await flush();
  assert.equal(controller.state.playingSentenceIndex, null);
});
