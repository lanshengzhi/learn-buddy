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

// --- Books / Reading position (ticket #46: the shelf and resume rely on
// every request carrying ?profile= — that scoping is what keeps Persons'
// positions from crossing) ---

test('listBooks asks for the active profile’s shelf', async () => {
  const calls = [];
  const api = new ServerApi({
    profile: 'dad',
    fetchImpl: async (path) => {
      calls.push(path);
      return response({ books: [{ id: 'x', title: 'Nav Book', reading: null }] });
    },
  });

  const books = await api.listBooks();

  assert.equal(calls[0], '/books?profile=dad');
  assert.equal(books.length, 1);
  assert.equal(books[0].reading, null);
});

test('book detail and chapter requests stay within the active profile', async () => {
  const calls = [];
  const api = new ServerApi({
    profile: 'mom',
    fetchImpl: async (path) => {
      calls.push(path);
      return response({ book: {}, toc: [] });
    },
  });

  await api.getBook('abc');
  await api.getChapter('abc', 2);

  assert.deepEqual(calls, ['/books/abc?profile=mom', '/books/abc/chapters/2?profile=mom']);
});

test('putPosition writes chapter and sentence for the active profile', async () => {
  const calls = [];
  const api = new ServerApi({
    profile: 'd1',
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return response(null, 204);
    },
  });

  await api.putPosition('abc', 1, 2);

  assert.equal(calls[0].path, '/books/abc/position?profile=d1');
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].options.body), { chapter: 1, sentence: 2 });
});

test('the pagehide position flush uses keepalive so the write survives', async () => {
  const calls = [];
  const api = new ServerApi({
    profile: 'dad',
    fetchImpl: async (path, options) => {
      calls.push(options);
      return response(null, 204);
    },
  });

  await api.putPosition('abc', 0, 9, { keepalive: true });

  assert.equal(calls[0].keepalive, true);
});

test('a rejected upload/books request surfaces the server’s error code', async () => {
  const api = new ServerApi({
    profile: 'dad',
    fetchImpl: async () => response({ error: 'not_epub' }, 415),
  });

  await assert.rejects(api.listBooks(), (error) => {
    assert.equal(error.code, 'not_epub');
    assert.equal(error.status, 415);
    assert.equal(error.message, '这不是一个 epub 文件。');
    return true;
  });
});
