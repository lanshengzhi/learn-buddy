import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextualReadingForRange,
  phraseCardInput,
  withContextualReading,
} from '../web/js/core/book-lookup-card.js';

test('English cards keep ECDICT phonetic as the primary reading', () => {
  const entry = {
    key: 'en:stop machine',
    matched: 'stop machine',
    reading: 'ˈstɑp məˈʃiːn',
    senses: [{ pos: '', gloss: '停机' }],
  };
  assert.deepEqual(withContextualReading(entry, 'en', ''), entry);
});

test('Chinese cards keep phrase pinyin as the primary reading', () => {
  const entry = {
    key: 'zh:红楼梦',
    matched: '红楼梦',
    reading: 'Hóng lóu Mèng',
    senses: [{ pos: '', gloss: 'A Dream of Red Mansions' }],
  };
  assert.deepEqual(withContextualReading(entry, 'zh-CN', ''), entry);
});

test('Japanese contextual reading is primary and dictionary readings stay secondary', () => {
  const entry = {
    key: 'ja:行く',
    matched: '行く',
    reading: 'いく',
    alternateReadings: ['いって', 'ゆく'],
    senses: [{ pos: 'v5', gloss: 'to go' }],
  };
  const card = withContextualReading(entry, 'ja', 'いって');
  assert.equal(card.reading, 'いって');
  assert.deepEqual(card.alternateReadings, ['いく', 'ゆく']);
});

test('baked Japanese ruby resolves the exact selected range', () => {
  const sentence = {
    t: '銀行に行くことが必要だ。',
    w: [],
    ruby: [[0, 2, 'ぎんこう'], [3, 1, 'い']],
  };
  assert.equal(contextualReadingForRange(sentence, 0, 2, 'ja'), 'ぎんこう');
  assert.equal(contextualReadingForRange(sentence, 0, 3, 'ja'), 'ぎんこうに');
  assert.equal(contextualReadingForRange(sentence, 0, 4, 'ja'), 'ぎんこうにい');
  assert.equal(contextualReadingForRange(sentence, 0, 4, 'zh'), '');
  assert.equal(contextualReadingForRange(sentence, 0, 1, 'ja'), '');
  assert.equal(contextualReadingForRange(sentence, 1, 4, 'ja'), '');
  assert.equal(contextualReadingForRange(sentence, 0, 3, 'ja'), 'ぎんこうに');
});

test('a selected phrase keeps its exact surface and current sentence', () => {
  const sentence = { t: 'I stop machine now.', w: [], ruby: [] };
  const input = phraseCardInput(
    { text: ' stop machine ', start: 1, end: 15 },
    sentence,
    'en',
  );
  assert.deepEqual(input, {
    word: ' stop machine ',
    sentence: 'I stop machine now.',
    language: 'en',
    start: 1,
    end: 15,
    contextualReading: '',
  });
});
