import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EXPLANATION_LOCALE, ServerApi } from '../web/js/core/api.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

test('AI explanation sends the default Chinese explanation locale', async () => {
  const calls = [];
  const api = new ServerApi({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return response({ text: '中文解释' });
    },
  });

  await api.aiExplain('run', 'I run.', 'en');

  assert.equal(DEFAULT_EXPLANATION_LOCALE, 'zh-CN');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    word: 'run',
    sentence: 'I run.',
    language: 'en',
    explanationLocale: 'zh-CN',
  });
});

test('AI explanation locale is configurable without sharing a cache contract', async () => {
  const calls = [];
  const api = new ServerApi({
    explanationLocale: 'en-US',
    fetchImpl: async (path, options) => {
      calls.push(options);
      return response({ text: 'English explanation' });
    },
  });

  await api.aiExplain('run', 'I run.', 'en');

  assert.equal(JSON.parse(calls[0].body).explanationLocale, 'en-US');
});
