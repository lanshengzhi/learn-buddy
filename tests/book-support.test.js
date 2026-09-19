/**
 * Ticket #19 book-surface support: the pure word-token helpers (words.js),
 * the ReaderController's book additions (explicit locale + Loop-all stopping
 * at the chapter end), and the API-backed HistoryStore's interface mapping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordTokens, nextUnknownWord, wordKey } from '../web/js/core/words.js';
import { ReaderController } from '../web/js/core/reader-controller.js';
import { segmentationService } from '../web/js/core/segmentation.js';
import { LoopMode } from '../web/js/core/loop-mode.js';
import { DEFAULT_RATE_PRESET } from '../web/js/core/rate-presets.js';
import { ApiHistoryStore } from '../web/js/browser/history-api.js';
import { apiErrorToMessage, API_ERROR_CODES } from '../web/js/core/errors.js';

// --- words.js -----------------------------------------------------------------

test('wordTokens reconstructs tokens from the server length array', () => {
  const tokens = wordTokens('東京に住む。', [2, 1, 2, 1]);
  assert.deepEqual(
    tokens.map((t) => [t.text, t.isWord]),
    [['東京', true], ['に', true], ['住む', true], ['。', false]],
  );
});

test('wordTokens marks separators as non-words but keeps every char', () => {
  const tokens = wordTokens('He said "hi"!', [2, 1, 4, 1, 4, 1]);
  assert.equal(tokens.map((t) => t.text).join(''), 'He said "hi"!');
  assert.deepEqual(
    tokens.map((t) => t.isWord),
    [true, false, true, false, false, true, false, false],
  );
});

test('wordTokens falls back to one token when lengths do not sum', () => {
  const tokens = wordTokens('abc', [5]);
  assert.deepEqual(tokens, [{ text: 'abc', start: 0, isWord: true }]);
});

test('wordTokens handles contractions and hyphens as words', () => {
  const tokens = wordTokens("don't co-op", [5, 1, 5]);
  assert.deepEqual(
    tokens.map((t) => t.isWord),
    [true, false, true],
  );
});

test('nextUnknownWord scans forward and stops at the first unknown', () => {
  const sentences = [
    { tokens: [{ text: 'A', isWord: true }, { text: ' ', isWord: false }] },
    { tokens: [{ text: 'B', isWord: true }] },
  ];
  const keys = new Map([['A', 'en:a'], ['B', 'en:b']]);
  const hit = nextUnknownWord(
    sentences,
    0,
    (sentenceIndex, token) => keys.get(token.text) ?? null,
    (key) => key === 'en:a',
  );
  assert.equal(hit.sentenceIndex, 1);
});

test('nextUnknownWord returns null when everything is known or missing', () => {
  const sentences = [{ tokens: [{ text: 'A', isWord: true }] }];
  assert.equal(
    nextUnknownWord(sentences, 0, (i, t) => 'en:a', () => true),
    null,
  );
  assert.equal(
    nextUnknownWord(sentences, 0, () => null, () => false),
    null,
  );
});

test('wordKey builds the server storage key', () => {
  assert.equal(wordKey('ja', '食べる'), 'ja:食べる');
  assert.equal(wordKey('en', null), null);
});

// --- ReaderController book additions -------------------------------------------

class FakePlayer {
  constructor() {
    this.calls = [];
    this._resolvePlay = null;
  }

  play(url) {
    this.calls.push(['play', url]);
    return new Promise((resolve) => {
      this._resolvePlay = resolve;
    });
  }

  pause() { this.calls.push(['pause']); }
  resume() { this.calls.push(['resume']); }
  stop() {
    this.calls.push(['stop']);
    if (this._resolvePlay) {
      const resolve = this._resolvePlay;
      this._resolvePlay = null;
      resolve(null);
    }
  }

  /** Simulates the audio element reaching 'ended'. */
  finish() {
    const resolve = this._resolvePlay;
    this._resolvePlay = null;
    resolve();
  }
}

class FakeTts {
  async speak(request) {
    return new Blob([`audio:${request.text}`]);
  }
}

class FakePrefs {
  ratePreset() { return DEFAULT_RATE_PRESET; }
  loopMode() { return LoopMode.All; }
  saveRatePreset() {}
  saveLoopMode() {}
}

function makeController(prefs = new FakePrefs()) {
  const player = new FakePlayer();
  const controller = new ReaderController({
    segmentation: segmentationService,
    tts: new FakeTts(),
    player,
    prefs,
    makeObjectUrl: () => 'blob:url',
    revokeObjectUrl: () => {},
    onHistoryProgress: () => {},
  });
  return { controller, player };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('loadText accepts an explicit chapter locale for voice selection', async () => {
  const { controller } = makeController();
  // An all-kanji chapter sentence in a ja book keeps the Japanese voice
  // even without kana (the paste-flow detector would call it Chinese).
  await controller.loadText('東京大学。', -1, 'ja');
  controller.onSentenceClicked(0);
  await flush();
  assert.equal(controller.state.playingSentenceIndex, 0);
});

test('loop-all with wrapLoopAll=false stops at the chapter end', async () => {
  const { controller, player } = makeController();
  controller.wrapLoopAll = false;
  await controller.loadText('One. Two. Three.');
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
  assert.equal(controller.state.playingSentenceIndex, null); // chapter end, no wrap
});

test('loop-all with wrapLoopAll=true still wraps (paste flow unchanged)', async () => {
  const { controller, player } = makeController();
  await controller.loadText('One. Two. Three.');
  controller.onPlayClicked();
  await flush();
  player.finish();
  await flush();
  player.finish();
  await flush();
  player.finish();
  await flush();
  assert.equal(controller.state.playingSentenceIndex, 0); // wrapped
});

// --- ApiHistoryStore -------------------------------------------------------------

class FakeApi {
  constructor() {
    this.entries = [];
    this.calls = [];
  }

  async getHistory() { this.calls.push(['history']); return this.entries; }
  async addHistory(text) {
    const entry = { id: this.entries.length + 1, text, createdAt: Date.now(), favorite: false };
    this.entries.unshift(entry);
    return { entry, trimmed: [] };
  }
  async patchHistory(id, patch) {
    const entry = this.entries.find((entry) => entry.id === id);
    Object.assign(entry, patch);
  }
  async deleteHistory(id) {
    this.entries = this.entries.filter((entry) => entry.id !== id);
  }
}

test('ApiHistoryStore maps the HistoryStore interface onto the API', async () => {
  const api = new FakeHistoryApi();
  const store = new ApiHistoryStore(api);
  await store.insert({ text: 'hello' });
  await store.setFavorite(1, true);
  await store.updateLastSelectedIndex(1, 3);
  const recent = await store.listRecent(50);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].lastSelectedIndex, 3);
  const favorites = await store.listFavorites();
  assert.equal(favorites[0].favorite, true);
  await store.deleteById(1);
  assert.equal((await store.listRecent(50)).length, 0);
  for (const call of ['add', 'delete', 'list', 'patch']) {
    assert.ok(api.calls.includes(call), `missing API call: ${call}`);
  }
});

class FakeHistoryApi {
  constructor() {
    this.entries = [];
    this.calls = [];
  }
  async getHistory() {
    this.calls.push('list');
    return this.entries.map((entry) => ({
      id: entry.id,
      text: entry.text,
      createdAt: entry.createdAt,
      favorite: Boolean(entry.favorite),
      selectedIndex: entry.selectedIndex ?? null,
    }));
  }
  async addHistory(text) {
    this.calls.push('add');
    const entry = { id: 1, text, createdAt: 1, favorite: false };
    this.entries.push(entry);
    return { entry, trimmed: [] };
  }
  async patchHistory(id, patch) {
    this.calls.push('patch');
    const entry = this.entries.find((entry) => entry.id === id);
    if (patch.favorite !== undefined) entry.favorite = patch.favorite;
    if (patch.selectedIndex !== undefined) entry.selectedIndex = patch.selectedIndex;
    return entry;
  }
  async deleteHistory(id) {
    this.calls.push('delete');
    this.entries = this.entries.filter((entry) => entry.id !== id);
  }
}

// --- error vocabulary -------------------------------------------------------------

test('API error codes map to learner-facing strings', () => {
  assert.equal(apiErrorToMessage(API_ERROR_CODES.NOT_EPUB), '这不是一个 epub 文件。');
  assert.equal(apiErrorToMessage('never_seen'), '请求的内容不存在。');
});
