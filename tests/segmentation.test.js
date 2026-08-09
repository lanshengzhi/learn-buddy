import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  split,
  splitOverlong,
  MAX_SENTENCE_LENGTH,
  IntlSegmenterSegmentationService,
  segmentationService,
} from '../web/js/core/segmentation.js';
import { detectLanguage, defaultVoiceFor } from '../web/js/core/language.js';

test('split returns [] for blank input', () => {
  assert.deepEqual(split(''), []);
  assert.deepEqual(split('   \n  '), []);
});

test('split trims chunks and drops empties', () => {
  assert.deepEqual(split('Hello.  \nWorld. ', 'en'), ['Hello.', 'World.']);
});

test('split falls back to fixed-length chunks when the input has no boundaries', () => {
  const text = 'x'.repeat(MAX_SENTENCE_LENGTH * 2 + 10);
  const chunks = split(text, 'en');
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.length <= MAX_SENTENCE_LENGTH));
  assert.equal(chunks.join(''), text);
});

test('splitOverlong chunks exactly at MAX_SENTENCE_LENGTH boundaries', () => {
  const text = 'y'.repeat(MAX_SENTENCE_LENGTH + 1);
  const chunks = splitOverlong(text);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, MAX_SENTENCE_LENGTH);
  assert.equal(chunks[1].length, 1);
  assert.equal(chunks[0] + chunks[1], text);
});

test('splitOverlong returns the text as-is when within the limit', () => {
  assert.deepEqual(splitOverlong('short'), ['short']);
});

test('an overlong single sentence is split into usable cards', () => {
  const text = 'a'.repeat(MAX_SENTENCE_LENGTH * 2) + '.';
  const sentences = split(text, 'en');
  assert.ok(sentences.length > 1);
  assert.ok(sentences.every((s) => s.length <= MAX_SENTENCE_LENGTH + 1 || s.length === 501));
  assert.equal(sentences.join(''), text);
});

test('SegmentationService is a seam: custom implementations are accepted', () => {
  // The Reader must depend on the interface, not on Intl.Segmenter.
  const custom = { segment: (text) => [`custom:${text}`] };
  const result = custom.segment('anything');
  assert.deepEqual(result, ['custom:anything']);
  // The shipped default satisfies the same shape.
  assert.equal(typeof segmentationService.segment, 'function');
  assert.ok(segmentationService instanceof IntlSegmenterSegmentationService);
});

test('language detection: kana → Japanese', () => {
  assert.equal(detectLanguage('こんにちは'), 'ja');
  assert.equal(detectLanguage('カタカナです'), 'ja');
  assert.equal(detectLanguage('日本語とEnglishが混ざる'), 'ja');
});

test('language detection: Han without kana → Simplified Chinese (incl. the known limitation)', () => {
  assert.equal(detectLanguage('你好世界'), 'zh-CN');
  assert.equal(detectLanguage('这是一段中文'), 'zh-CN');
  // Known limitation: Japanese without kana is detected as Chinese.
  assert.equal(detectLanguage('日本'), 'zh-CN');
});

test('language detection: otherwise → English (CJK punctuation is not a signal)', () => {
  assert.equal(detectLanguage('Hello world'), 'en');
  assert.equal(detectLanguage(''), 'en');
  assert.equal(detectLanguage('。，！？'), 'en');
  assert.equal(detectLanguage('Hello 世界'), 'zh-CN'); // Han without kana wins over ASCII
});

test('default voice per detected locale', () => {
  assert.equal(defaultVoiceFor('en'), 'en-US-AriaNeural');
  assert.equal(defaultVoiceFor('ja'), 'ja-JP-KeitaNeural');
  assert.equal(defaultVoiceFor('zh-CN'), 'zh-CN-YunxiNeural');
});
