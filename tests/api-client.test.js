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

test('StudyJob cancel, retry, and recheck all unwrap the canonical job response', async () => {
  const calls = [];
  const jobs = {
    cancelled: { id: 'job-cancelled', state: 'cancelled' },
    retried: { id: 'job-retried', state: 'queued' },
    rechecked: { id: 'job-rechecked', state: 'unknown' },
  };
  const api = new ServerApi({
    profile: 'dad',
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      if (path.includes('/cancel')) return response({ job: jobs.cancelled });
      if (path.includes('/retry')) return response({ job: jobs.retried });
      return response({ job: jobs.rechecked });
    },
  });

  assert.deepEqual(await api.cancelStudyJob('job-1'), jobs.cancelled);
  assert.deepEqual(await api.retryStudyJob('job-1'), jobs.retried);
  assert.deepEqual(await api.recheckStudyJob('job-1'), jobs.rechecked);
  assert.deepEqual(calls.map(({ path, options }) => `${options.method} ${path}`), [
    'POST /study-jobs/job-1/cancel?profile=dad',
    'POST /study-jobs/job-1/retry?profile=dad',
    'POST /study-jobs/job-1/recheck?profile=dad',
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), { confirm: true });
});

test('Notebook sync and remote cleanup expose explicit confirmation contracts', async () => {
  const calls = [];
  const ref = { mutationStatus: 'confirmed', notebookId: 'nb-1', sourceId: 'src-1' };
  const api = new ServerApi({
    profile: 'dad',
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      if (options?.method === 'POST' && path.includes('remote-cleanup')) {
        return response({ notebookRef: ref, cleanup: { status: 'unsupported' } });
      }
      if (options?.method === 'POST') return response({ notebookRef: ref, reused: false });
      return response({ notebookRef: ref });
    },
  });

  assert.deepEqual((await api.getNotebookSync('book-hash')).notebookRef, ref);
  assert.equal((await api.syncNotebook('book-hash', { confirmUpload: true })).notebookRef.mutationStatus, 'confirmed');
  assert.equal((await api.cleanupNotebookRemote('book-hash')).cleanup.status, 'unsupported');
  assert.deepEqual(calls.map(({ path, options }) => `${options?.method ?? 'GET'} ${path}`), [
    'GET /books/book-hash/notebook-sync?profile=dad',
    'POST /books/book-hash/notebook-sync?profile=dad',
    'POST /books/book-hash/notebook-sync/remote-cleanup?profile=dad',
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { confirmUpload: true, retry: false });
  assert.deepEqual(JSON.parse(calls[2].options.body), { confirm: true });
});

test('StudyArtifact list, preview, download, delete, regenerate, and cleanup stay Person-scoped', async () => {
  const calls = [];
  const api = new ServerApi({
    profile: 'dad',
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      if (options?.method === 'DELETE') return response(null, 204);
      if (path.includes('/study-jobs')) return response({ jobs: [{ id: 'job-local', bookId: 'book-hash' }] });
      if (path.includes('/regenerate?')) return response({ job: { id: 'job-new' }, created: true }, 201);
      if (path.includes('/remote-cleanup?')) {
        return response({ artifact: { id: 'artifact-local' }, cleanup: { status: 'not_requested' } });
      }
      if (path.includes('/study-artifacts/')) {
        return response({ artifact: { id: 'artifact-local', previewData: { kind: 'text', text: 'ready' } } });
      }
      return response({ artifacts: [{ id: 'artifact-local' }] });
    },
  });

  const jobs = await api.listStudyJobs('book-hash');
  const artifacts = await api.listStudyArtifacts('book-hash');
  const artifact = await api.getStudyArtifact('artifact-local');
  const downloadUrl = api.studyArtifactDownloadUrl('artifact-local');
  await api.deleteStudyArtifact('artifact-local');
  const regenerated = await api.regenerateStudyArtifact('artifact-local');
  const cleaned = await api.remoteCleanupStudyArtifact('artifact-local');

  assert.deepEqual(jobs, [{ id: 'job-local', bookId: 'book-hash' }]);
  assert.deepEqual(artifacts, [{ id: 'artifact-local' }]);
  assert.equal(artifact.previewData.text, 'ready');
  assert.equal(downloadUrl, '/study-artifacts/artifact-local/download?profile=dad');
  assert.equal(regenerated.job.id, 'job-new');
  assert.equal(cleaned.cleanup.status, 'not_requested');
  assert.deepEqual(calls.map((call) => `${call.options?.method ?? 'GET'} ${call.path}`), [
    'GET /books/book-hash/study-jobs?profile=dad',
    'GET /books/book-hash/study-artifacts?profile=dad',
    'GET /study-artifacts/artifact-local?profile=dad',
    'DELETE /study-artifacts/artifact-local?profile=dad',
    'POST /study-artifacts/artifact-local/regenerate?profile=dad',
    'POST /study-artifacts/artifact-local/remote-cleanup?profile=dad',
  ]);
  assert.deepEqual(JSON.parse(calls[4].options.body), {});
  assert.deepEqual(JSON.parse(calls[5].options.body), { confirm: true });
});

// --- Chat / Conversations (ticket #47: every request stays inside the
// active profile; a turn carries only the new text — the server assembles
// the Conversation context, so nothing else can leak from the client) ---

test('listConversations asks for the active profile’s Conversations', async () => {
  const calls = [];
  const api = new ServerApi({
    profile: 'mom',
    fetchImpl: async (path) => {
      calls.push(path);
      return response({ conversations: [{ id: '000001', title: '早安', updatedAt: 1 }] });
    },
  });

  const conversations = await api.listConversations();

  assert.equal(calls[0], '/conversations?profile=mom');
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].id, '000001');
});

test('createConversation posts an empty object and returns the Conversation', async () => {
  const calls = [];
  const api = new ServerApi({
    profile: 'dad',
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return response({ conversation: { id: '000001', title: '新对话', messages: [] } }, 201);
    },
  });

  const conversation = await api.createConversation();

  assert.equal(calls[0].path, '/conversations?profile=dad');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {});
  assert.equal(conversation.id, '000001');
});

test('getConversation stays inside the active profile', async () => {
  const calls = [];
  const api = new ServerApi({
    profile: 'd1',
    fetchImpl: async (path) => {
      calls.push(path);
      return response({ conversation: { id: '000002', messages: [] } });
    },
  });

  await api.getConversation('000002');

  assert.deepEqual(calls, ['/conversations/000002?profile=d1']);
});

test('sendChatMessage carries exactly the new text — nothing else crosses', async () => {
  const calls = [];
  const api = new ServerApi({
    profile: 'dad',
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return response({ conversation: { id: '000001', messages: [] } });
    },
  });

  await api.sendChatMessage('000001', '今天怎么样？');

  assert.equal(calls[0].path, '/conversations/000001/messages?profile=dad');
  assert.equal(calls[0].options.method, 'POST');
  // The exact client-side boundary: {text} only — no history, no book, no
  // position, no other Conversation (the server owns context assembly).
  assert.deepEqual(JSON.parse(calls[0].options.body), { text: '今天怎么样？' });
});

test('a failed send surfaces the server’s degrade code', async () => {
  const api = new ServerApi({
    profile: 'dad',
    fetchImpl: async () => response({ error: 'ai_usage_limit' }, 503),
  });

  await assert.rejects(api.sendChatMessage('000001', 'hi'), (error) => {
    assert.equal(error.code, 'ai_usage_limit');
    assert.equal(error.status, 503);
    assert.equal(error.message, 'AI 用量受限，请稍后再试。');
    return true;
  });
});

test('an over-limit Conversation surfaces too_large, not a generic failure', async () => {
  // The server refuses an over-limit turn with its own mapped code (413)
  // instead of letting it degenerate into a sidecar rejection.
  const api = new ServerApi({
    profile: 'dad',
    fetchImpl: async () => response({ error: 'too_large' }, 413),
  });

  await assert.rejects(api.sendChatMessage('000001', 'hi'), (error) => {
    assert.equal(error.code, 'too_large');
    assert.equal(error.status, 413);
    return true;
  });
});

test('BookConversation lifecycle stays scoped to the active Person and Book', async () => {
  const calls = [];
  const api = new ServerApi({
    profile: 'dad',
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      if (path.endsWith('/book-conversations') && (!options || options.method !== 'POST')) {
        return response({ conversations: [{ id: '000001', bookId: 'abc', active: true }] });
      }
      return response({ conversation: { id: '000001', bookId: 'abc', messages: [] } });
    },
  });

  await api.listBookConversations('abc');
  await api.openBookConversation('abc', { newConversation: true });
  await api.resumeBookConversation('000001');
  await api.deleteBookConversation('000001');

  assert.deepEqual(calls.map((call) => `${call.options?.method ?? 'GET'} ${call.path}`), [
    'GET /books/abc/book-conversations?profile=dad',
    'POST /books/abc/book-conversations?profile=dad',
    'POST /book-conversations/000001/resume?profile=dad',
    'DELETE /book-conversations/000001?profile=dad',
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { new: true });
});

test('BookConversation answer API parses split NDJSON and preserves the context snapshot', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('{"type":"meta","contextScope":"selection"}\n{"type":"del'),
    encoder.encode('ta","text":"回答"}\n{"type":"done","conversation":{"id":"1"}}\n'),
  ];
  const calls = [];
  const api = new ServerApi({
    profile: 'dad',
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      let index = 0;
      return {
        ok: true,
        status: 200,
        body: { getReader: () => ({ read: async () => index < chunks.length
          ? { value: chunks[index++], done: false } : { done: true }, releaseLock() {} }) },
      };
    },
  });
  const events = [];
  const context = { bookId: 'abc', scope: 'selection', anchor: { start: 0, end: 0 } };

  await api.streamBookConversationMessage('1', {
    bookId: 'abc', text: '解释', context, onEvent: (event) => events.push(event),
  });

  assert.equal(calls[0].path, '/book-conversations/1/messages?profile=dad');
  assert.deepEqual(JSON.parse(calls[0].options.body), { bookId: 'abc', text: '解释', context });
  assert.deepEqual(events.map((event) => event.type), ['meta', 'delta', 'done']);
});
