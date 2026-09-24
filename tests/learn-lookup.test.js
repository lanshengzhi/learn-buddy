import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLearnLookupBridge } from '../web/js/core/learn-lookup.js';

test('Learn lookup bridge delegates pasted-text lookup to the existing word-card seam', () => {
  const calls = [];
  const bridge = createLearnLookupBridge({ lookupText: (input) => calls.push(input) });
  const input = { word: '你好', sentence: '你好。', language: 'zh-CN' };
  bridge(input);
  assert.deepEqual(calls, [input]);
});

test('Learn lookup bridge requires the existing BookView lookup path', () => {
  assert.throws(() => createLearnLookupBridge({}), /lookupText is required/);
});
