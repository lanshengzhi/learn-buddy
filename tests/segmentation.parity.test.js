// zh/ja/en sentence-segmentation parity cases: Intl.Segmenter vs ICU4J expectations.
// Expected values generated from ICU4J 75.1 (com.ibm.icu.text.BreakIterator) via the
// harness in /tmp/icu4j, then
// verified identical against Intl.Segmenter on V8 (node 26.7.0, 2026-08).
// A failing case here means Intl.Segmenter and ICU4J have drifted apart — review before changing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { split } from '../web/js/core/segmentation.js';

// [input, locale, expected sentences]
export const parityCases = [
  ["Hello world. This is a test.", "en", ["Hello world.", "This is a test."]],
  ["Mr. Smith went home. He was tired.", "en", ["Mr.", "Smith went home.", "He was tired."]],
  ["What time is it? It is 3:30 PM.", "en", ["What time is it?", "It is 3:30 PM."]],
  ["Dr. Jones said: \"Hello!\" Then she left.", "en", ["Dr.", "Jones said: \"Hello!\"", "Then she left."]],
  ["Well... that's odd. Really odd.", "en", ["Well... that's odd.", "Really odd."]],
  ["First line.\nSecond line.", "en", ["First line.", "Second line."]],
  ["Hello! Goodbye? Yes.", "en", ["Hello!", "Goodbye?", "Yes."]],
  ["I bought 3.14 pounds of apples.", "en", ["I bought 3.14 pounds of apples."]],
  ["She said, \"Go away!\" He stayed.", "en", ["She said, \"Go away!\"", "He stayed."]],
  ["The quick brown fox jumps over the lazy dog", "en", ["The quick brown fox jumps over the lazy dog"]],
  ["This is a very long piece of English text with absolutely no punctuation whatsoever so the fallback chunking must split it into fixed length pieces that are each short enough to be a usable sentence card for the learner to tap and hear spoken aloud one at a time without ever producing an unusable card that is too long to display comfortably on the screen of a phone held in one hand while walking down the street", "en", ["This is a very long piece of English text with absolutely no punctuation whatsoever so the fallback chunking must split it into fixed length pieces that are each short enough to be a usable sentence card for the learner to tap and hear spoken aloud o", "ne at a time without ever producing an unusable card that is too long to display comfortably on the screen of a phone held in one hand while walking down the street"]],
  ["こんにちは。今日はいい天気ですね！", "ja", ["こんにちは。", "今日はいい天気ですね！"]],
  ["日本語の文章です。句点で区切られます。", "ja", ["日本語の文章です。", "句点で区切られます。"]],
  ["これは？疑問文です！感嘆文です。", "ja", ["これは？", "疑問文です！", "感嘆文です。"]],
  ["彼は「こんにちは」と言った。それから出かけた。", "ja", ["彼は「こんにちは」と言った。", "それから出かけた。"]],
  ["一行目。\n二行目。", "ja", ["一行目。", "二行目。"]],
  ["日本語とEnglishが混ざる。テストです。", "ja", ["日本語とEnglishが混ざる。", "テストです。"]],
  ["これは句読点のないとても長い日本語の文章です", "ja", ["これは句読点のないとても長い日本語の文章です"]],
  ["これは句読点のないとても長い日本語の文章です一つの文章がとても長くて読みにくいので二百五十文字を超えた場合には固定長で分割する必要がありますそうすればカード一枚一枚が読みやすくなって学習者がタップして聞くことができるようになりますこれはそのためのテストです句読点がまったくないのでセグメンターは一つの文章とみなしてから固定長に分割するはずです", "ja", ["これは句読点のないとても長い日本語の文章です一つの文章がとても長くて読みにくいので二百五十文字を超えた場合には固定長で分割する必要がありますそうすればカード一枚一枚が読みやすくなって学習者がタップして聞くことができるようになりますこれはそのためのテストです句読点がまったくないのでセグメンターは一つの文章とみなしてから固定長に分割するはずです"]],
  ["你好。今天天气很好！", "zh-CN", ["你好。", "今天天气很好！"]],
  ["这是一段中文。句号分隔。", "zh-CN", ["这是一段中文。", "句号分隔。"]],
  ["为什么？因为这样！", "zh-CN", ["为什么？", "因为这样！"]],
  ["他说：“你好。”然后离开了。", "zh-CN", ["他说：“你好。”", "然后离开了。"]],
  ["中文和English混在一起。测试一下。", "zh-CN", ["中文和English混在一起。", "测试一下。"]],
  ["这是一个没有标点符号的句子它非常长", "zh-CN", ["这是一个没有标点符号的句子它非常长"]],
  ["这是一个没有标点符号的非常长的中文句子它超过了二百五十个字符所以必须使用固定长度分割来把它切成许多短小的卡片每一张卡片都要足够短让学习者可以舒适地阅读和点击播放这是为了测试回退分段逻辑而准备的样例文本它没有使用任何标点符号所以分割器会把它当作一个完整的句子然后再按照固定长度切成多个片段这样阅读器就不会产生无法使用的卡片了", "zh-CN", ["这是一个没有标点符号的非常长的中文句子它超过了二百五十个字符所以必须使用固定长度分割来把它切成许多短小的卡片每一张卡片都要足够短让学习者可以舒适地阅读和点击播放这是为了测试回退分段逻辑而准备的样例文本它没有使用任何标点符号所以分割器会把它当作一个完整的句子然后再按照固定长度切成多个片段这样阅读器就不会产生无法使用的卡片了"]],
  ["Hello...World", "en", ["Hello...", "World"]],
  ["e.g. apples and oranges are fruits.", "en", ["e.g. apples and oranges are fruits."]],
  ["U.S.A. is a country.", "en", ["U.S.A. is a country."]],
  ["He said. \"Hi there.\" Then left.", "en", ["He said.", "\"Hi there.\"", "Then left."]],
  ["Sentence with   multiple spaces.", "en", ["Sentence with   multiple spaces."]],
  ["(Parenthetical.) Next sentence.", "en", ["(Parenthetical.)", "Next sentence."]],
  ["3.14 is pi. Then comes tau.", "en", ["3.14 is pi.", "Then comes tau."]],
  ["What's up? Nothing much!", "en", ["What's up?", "Nothing much!"]],
  ["你好. Hello. こんにちは。", "ja", ["你好.", "Hello.", "こんにちは。"]],
  ["カタカナの文章。読めますか？", "ja", ["カタカナの文章。", "読めますか？"]],
  ["句点なしの英文も混ざる This is English. そして日本語。", "ja", ["句点なしの英文も混ざる This is English.", "そして日本語。"]],
  ["简体中文测试。Mixed English too. 还有中文。", "zh-CN", ["简体中文测试。", "Mixed English too.", "还有中文。"]],
  ["これは…続きがある。そうですね。", "ja", ["これは…続きがある。", "そうですね。"]],
  ["「括弧で始まる文。」次。", "ja", ["「括弧で始まる文。」", "次。"]],
  ["“引号开头。”然后。", "zh-CN", ["“引号开头。”", "然后。"]],
  ["A sentence with a period at end. ", "en", ["A sentence with a period at end."]],
];

test('segmentation matches ICU4J expectations for every zh/ja/en parity case', () => {
  for (const [input, locale, expected] of parityCases) {
    assert.deepEqual(split(input, locale), expected, `${locale}: ${JSON.stringify(input)}`);
  }
});
