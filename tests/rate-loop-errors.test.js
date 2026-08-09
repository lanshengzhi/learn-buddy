import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATE_PRESETS, DEFAULT_RATE_PRESET, ratePresetByName, isValidSsmlRate } from '../web/js/core/rate-presets.js';
import { nextLoopMode, LoopMode, loopModeByName } from '../web/js/core/loop-mode.js';
import { ttsErrorToMessage, TTS_ERROR_CODES } from '../web/js/core/errors.js';
import { TtsClient, TtsClientError, ttsUrl } from '../web/js/core/tts-client.js';
import { PlaybackPreferences } from '../web/js/core/playback-preferences.js';

test('rate presets: six tiers mapped linearly to SSML rate', () => {
  assert.deepEqual(
    RATE_PRESETS.map((p) => [p.label, p.ssmlRate]),
    [
      ['0.5×', '-50%'],
      ['0.75×', '-25%'],
      ['1×', '+0%'],
      ['1.25×', '+25%'],
      ['1.5×', '+50%'],
      ['2×', '+100%'],
    ],
  );
  assert.equal(DEFAULT_RATE_PRESET.name, 'Normal');
});

test('rate preset lookup falls back to Normal for unknown names', () => {
  assert.equal(ratePresetByName('Double').label, '2×');
  assert.equal(ratePresetByName('Nope').name, 'Normal');
});

test('SSML rate validation mirrors the upstream bounds (-90%..+100%)', () => {
  for (const p of RATE_PRESETS) assert.equal(isValidSsmlRate(p.ssmlRate), true);
  assert.equal(isValidSsmlRate('+0%'), true);
  assert.equal(isValidSsmlRate('-90%'), true);
  assert.equal(isValidSsmlRate('+100%'), true);
  assert.equal(isValidSsmlRate('+101%'), false);
  assert.equal(isValidSsmlRate('-91%'), false);
  assert.equal(isValidSsmlRate('0%'), false);
  assert.equal(isValidSsmlRate('+0'), false);
  assert.equal(isValidSsmlRate('fast'), false);
});

test('loop toggle cycles Off -> All -> One -> Off', () => {
  assert.equal(nextLoopMode(LoopMode.Off), LoopMode.All);
  assert.equal(nextLoopMode(LoopMode.All), LoopMode.One);
  assert.equal(nextLoopMode(LoopMode.One), LoopMode.Off);
  assert.equal(loopModeByName('All'), LoopMode.All);
  assert.equal(loopModeByName('garbage'), LoopMode.Off);
});

test('backend error codes map to the learner-facing strings', () => {
  assert.equal(ttsErrorToMessage(TTS_ERROR_CODES.EMPTY_TEXT), 'Selected sentence is empty.');
  assert.equal(ttsErrorToMessage(TTS_ERROR_CODES.TEXT_TOO_LONG), 'Sentence is too long.');
  assert.equal(ttsErrorToMessage(TTS_ERROR_CODES.INVALID_VOICE), 'Voice is not available.');
  assert.equal(ttsErrorToMessage(TTS_ERROR_CODES.INVALID_RATE), 'Playback rate is invalid.');
  assert.equal(ttsErrorToMessage(TTS_ERROR_CODES.NETWORK_FAILURE), 'Check your connection.');
  assert.equal(
    ttsErrorToMessage(TTS_ERROR_CODES.UPSTREAM_UNAVAILABLE),
    'Service is temporarily unavailable. Try again later.',
  );
  assert.equal(
    ttsErrorToMessage(TTS_ERROR_CODES.UPSTREAM_TIMEOUT),
    'Service is temporarily unavailable. Try again later.',
  );
  assert.equal(ttsErrorToMessage(TTS_ERROR_CODES.UNKNOWN), 'Something went wrong. Please try again.');
  assert.equal(ttsErrorToMessage('weird_code'), 'Something went wrong. Please try again.');
});

test('ttsUrl is the canonical SW cache key (text|voice|rate)', () => {
  const url = ttsUrl({ text: 'Hello world.', voice: 'en-US-AriaNeural', rate: '+0%' });
  assert.equal(url, '/tts?text=Hello+world.&voice=en-US-AriaNeural&rate=%2B0%25');
  assert.equal(ttsUrl({ text: 'Hello world.', voice: 'en-US-AriaNeural', rate: '+0%', baseUrl: 'http://x' }), 'http://x/tts?text=Hello+world.&voice=en-US-AriaNeural&rate=%2B0%25');
});

test('tts client maps backend codes to TtsClientError', async () => {
  const fetchImpl = async (url, init) => {
    assert.ok(url.startsWith('/tts?text='));
    assert.equal(init.signal, 'signal-1');
    return new Response(JSON.stringify({ error: 'text_too_long' }), { status: 400 });
  };
  const client = new TtsClient({ fetchImpl });
  await assert.rejects(
    client.speak({ text: 'x'.repeat(501), voice: 'v', rate: '+0%', signal: 'signal-1' }),
    (e) => e instanceof TtsClientError && e.code === 'text_too_long',
  );
});

test('tts client returns the MP3 blob on success', async () => {
  const fetchImpl = async () => new Response(new Blob(['mp3bytes'], { type: 'audio/mpeg' }), { status: 200 });
  const client = new TtsClient({ fetchImpl });
  const blob = await client.speak({ text: 'hi', voice: 'v', rate: '+0%' });
  assert.equal(blob.type, 'audio/mpeg');
});

test('tts client maps non-JSON failures to unknown', async () => {
  const fetchImpl = async () => new Response('gateway broke', { status: 502 });
  const client = new TtsClient({ fetchImpl });
  await assert.rejects(
    client.speak({ text: 'hi', voice: 'v', rate: '+0%' }),
    (e) => e instanceof TtsClientError && e.code === 'unknown',
  );
});

test('playback preferences persist rate preset and loop mode', () => {
  const storage = new Map();
  const prefs = new PlaybackPreferences({
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, v),
  });
  assert.equal(prefs.ratePreset().name, 'Normal');
  assert.equal(prefs.loopMode(), 'Off');
  prefs.saveRatePreset(RATE_PRESETS[5]);
  prefs.saveLoopMode(LoopMode.One);
  assert.equal(prefs.ratePreset().label, '2×');
  assert.equal(prefs.loopMode(), 'One');
  // Corrupt values fall back to defaults.
  storage.set('loop_mode', 'bogus');
  assert.equal(prefs.loopMode(), 'Off');
});
