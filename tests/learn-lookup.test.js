import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLearnLookupBridge } from '../web/js/core/learn-lookup.js';

test('Learn lookup bridge delegates pasted-text lookup to the existing word-card seam', () => {
  const calls = [];
  const bridge = createLearnLookupBridge({ lookupText: (input) => calls.push(input) });
  const input = { word: 'hello', sentence: 'hello there', language: 'en' };
  bridge(input);
  assert.deepEqual(calls, [input]);
});

test('Learn lookup bridge requires the existing BookView lookup path', () => {
  assert.throws(() => createLearnLookupBridge({}), /lookupText is required/);
});
