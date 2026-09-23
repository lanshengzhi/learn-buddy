import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chat, chatErrorMessage } from '../web/js/core/chat.js';

const SUMMARIES = [
  { id: '000002', title: '第二段', createdAt: 2000, updatedAt: 3000, messageCount: 2 },
  { id: '000001', title: '第一段', createdAt: 1000, updatedAt: 1500, messageCount: 4 },
];

const THREADS = {
  '000001': { id: '000001', title: '第一段', createdAt: 1000, updatedAt: 1500, messages: [
    { role: 'user', content: '早安', at: 1100 },
    { role: 'assistant', content: '早安！', at: 1101 },
  ] },
  '000002': { id: '000002', title: '第二段', createdAt: 2000, updatedAt: 3000, messages: [
    { role: 'user', content: '天气', at: 2100 },
    { role: 'assistant', content: '晴天。', at: 2101 },
  ] },
};

function fakeApi({
  conversations = SUMMARIES,
  failList = null,
  failSend = null,
  failCreate = null,
  reply = '模型回复',
} = {}) {
  const calls = { list: 0, create: 0, get: [], send: [] };
  let nextId = 3;
  return {
    calls,
    async listConversations() {
      calls.list += 1;
      if (failList) throw failList;
      return conversations;
    },
    async createConversation() {
      calls.create += 1;
      if (failCreate) throw failCreate;
      const id = String(nextId++).padStart(6, '0');
      return { id, title: '新对话', createdAt: 9000, updatedAt: 9000, messages: [] };
    },
    async getConversation(id) {
      calls.get.push(id);
      const conversation = THREADS[id];
      if (!conversation) throw Object.assign(new Error('这段对话不存在了。'), { code: 'conversation_not_found' });
      return conversation;
    },
    async sendChatMessage(id, text) {
      calls.send.push({ id, text });
      if (failSend) throw failSend;
      const base = THREADS[id] ?? { id, title: '新对话', createdAt: 9000, messages: [] };
      return {
        conversation: {
          ...base,
          title: base.messages.length ? base.title : text.slice(0, 24),
          updatedAt: 9500,
          messages: [
            ...base.messages,
            { role: 'user', content: text, at: 9400 },
            { role: 'assistant', content: reply, at: 9401 },
          ],
        },
      };
    },
  };
}

const recorder = () => {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
};

test('chat starts idle with an empty fresh thread', () => {
  const chat = new Chat({ api: fakeApi() });
  assert.equal(chat.state.status, 'idle');
  assert.deepEqual(chat.state.conversations, []);
  assert.equal(chat.state.activeId, null);
  assert.deepEqual(chat.state.messages, []);
  assert.equal(chat.state.sending, false);
});

test('refresh loads the current Person’s list and reopens the newest Conversation', async () => {
  const { events, onEvent } = recorder();
  const api = fakeApi();
  const chat = new Chat({ api, onEvent });
  await chat.refresh();
  assert.equal(chat.state.status, 'ready');
  assert.deepEqual(chat.state.conversations, SUMMARIES);
  assert.deepEqual(api.calls.get, ['000002']); // newest first — continuity after reload
  assert.equal(chat.state.activeId, '000002');
  assert.deepEqual(chat.state.messages, THREADS['000002'].messages);
  assert.ok(events.every((e) => e.type === 'chat-changed'));
});

test('refresh on an empty list stays on a fresh thread and does not auto-open later', async () => {
  const api = fakeApi({ conversations: [] });
  const chat = new Chat({ api });
  await chat.refresh();
  assert.equal(chat.state.activeId, null);
  assert.deepEqual(chat.state.messages, []);
  // A later refresh (e.g. drawer reopen) must not yank the user out of a
  // thread they started.
  chat.newThread();
  api.listConversations = async () => SUMMARIES;
  await chat.refresh();
  assert.equal(chat.state.activeId, null);
});

test('a failed refresh keeps the last good list and reports the error', async () => {
  const failList = Object.assign(new Error('网络错误。'), { code: 'network_failure' });
  const api = fakeApi({ failList });
  const chat = new Chat({ api });
  await chat.refresh();
  assert.equal(chat.state.status, 'error');
  assert.equal(chat.state.error, '网络错误。');
  api.listConversations = async () => SUMMARIES;
  await chat.refresh();
  assert.equal(chat.state.status, 'ready');
  assert.deepEqual(chat.state.conversations, SUMMARIES);
});

test('open loads a stored Conversation; an unknown one keeps the current thread', async () => {
  const api = fakeApi();
  const chat = new Chat({ api });
  await chat.refresh();
  await chat.open('000001');
  assert.equal(chat.state.activeId, '000001');
  assert.deepEqual(chat.state.messages, THREADS['000001'].messages);
  await chat.open('999999');
  assert.equal(chat.state.activeId, '000001'); // unchanged
  assert.equal(chat.state.notice, '这段对话不存在了——另选一段或新建。');
});

test('newThread resets to an empty unsaved thread', async () => {
  const chat = new Chat({ api: fakeApi() });
  await chat.refresh();
  chat.newThread();
  assert.equal(chat.state.activeId, null);
  assert.deepEqual(chat.state.messages, []);
});

test('send in an open thread posts only the new text and appends both messages', async () => {
  const api = fakeApi();
  const chat = new Chat({ api });
  await chat.refresh();
  await chat.open('000001');

  const sent = await chat.send('  后续问题  ');
  assert.equal(sent, true);
  // The context boundary client-side: exactly {text} crosses — the server
  // assembles history from its own stored Conversation.
  assert.deepEqual(api.calls.send, [{ id: '000001', text: '后续问题' }]);
  assert.equal(api.calls.create, 0);
  assert.deepEqual(
    chat.state.messages.map((m) => [m.role, m.content]),
    [['user', '早安'], ['assistant', '早安！'], ['user', '后续问题'], ['assistant', '模型回复']],
  );
  assert.equal(chat.state.sending, false);
  // The list summary follows the thread (title kept, count bumped, re-sorted).
  const summary = chat.state.conversations.find((c) => c.id === '000001');
  assert.equal(summary.messageCount, 4);
  assert.equal(chat.state.conversations[0].id, '000001');
});

test('send on a fresh thread creates the Conversation first, then sends', async () => {
  const api = fakeApi({ conversations: [] });
  const chat = new Chat({ api });
  await chat.refresh();

  const sent = await chat.send('第一条消息');
  assert.equal(sent, true);
  assert.equal(api.calls.create, 1);
  assert.deepEqual(api.calls.send, [{ id: '000003', text: '第一条消息' }]);
  assert.equal(chat.state.activeId, '000003');
  assert.deepEqual(
    chat.state.messages.map((m) => [m.role, m.content]),
    [['user', '第一条消息'], ['assistant', '模型回复']],
  );
  // The new Conversation joins the list with its server-assigned title.
  assert.equal(chat.state.conversations[0].id, '000003');
  assert.equal(chat.state.conversations[0].title, '第一条消息');
});

test('a failed send leaves the thread intact and returns false (draft stays)', async () => {
  const failSend = Object.assign(new Error('AI 服务暂时不可用。'), { code: 'ai_upstream_error' });
  const api = fakeApi({ failSend });
  const chat = new Chat({ api });
  await chat.refresh();
  await chat.open('000001');

  const sent = await chat.send('会失败');
  assert.equal(sent, false);
  assert.deepEqual(chat.state.messages, THREADS['000001'].messages); // nothing appended
  assert.equal(chat.state.sending, false);
  assert.equal(chat.state.notice, 'Chat 暂时不可用，请稍后再试——之前的对话都还在。');

  // Recovery: the next send goes through on the same thread.
  api.sendChatMessage = fakeApi().sendChatMessage;
  assert.equal(await chat.send('会失败'), true);
  assert.equal(chat.state.messages.at(-1).content, '模型回复');
});

test('a failed first send keeps the thread fresh (no half-created Conversation)', async () => {
  const failSend = Object.assign(new Error('Chat 暂时不可用。'), { code: 'ai_timeout' });
  const api = fakeApi({ conversations: [], failSend });
  const chat = new Chat({ api });
  await chat.refresh();

  assert.equal(await chat.send('第一条'), false);
  assert.equal(api.calls.create, 1);
  assert.equal(chat.state.activeId, '000003'); // the empty Conversation exists…
  assert.deepEqual(chat.state.messages, []); // …but no message was recorded
  assert.equal(chat.state.conversations.length, 0);
});

test('concurrent sends are serialized away — the second is ignored', async () => {
  const api = fakeApi();
  let release;
  api.sendChatMessage = (id, text) => {
    api.calls.send.push({ id, text });
    return new Promise((resolve) => {
      release = () =>
        resolve({
          conversation: { ...THREADS[id], updatedAt: 9500, messages: [...THREADS[id].messages, { role: 'user', content: text, at: 1 }, { role: 'assistant', content: '模型回复', at: 2 }] },
        });
    });
  };
  const chat = new Chat({ api });
  await chat.refresh();
  await chat.open('000001');
  const first = chat.send('一');
  const second = await chat.send('二');
  assert.equal(second, false); // ignored while the first is in flight
  release();
  assert.equal(await first, true);
  assert.deepEqual(api.calls.send, [{ id: '000001', text: '一' }]);
});

test('chat failure lines are fixed and safe — never upstream text', () => {
  assert.equal(
    chatErrorMessage(Object.assign(new Error('provider raw trace'), { code: 'ai_usage_limit' })),
    'AI 用量受限，请稍后再试——之前的对话都还在。',
  );
  assert.equal(
    chatErrorMessage(Object.assign(new Error('x'), { code: 'ai_not_configured' })),
    'Chat 还没有配置好，暂时不可用。',
  );
  assert.equal(
    chatErrorMessage(Object.assign(new Error('500 Internal…'), { code: 'ai_upstream_error' })),
    'Chat 暂时不可用，请稍后再试——之前的对话都还在。',
  );
  // An over-limit Conversation is its own mapped code (413 too_large), not a
  // generic upstream failure — the family can shorten the message or start
  // a new Conversation (spec user story 13: recoverable, history intact).
  assert.equal(
    chatErrorMessage(Object.assign(new Error('x'), { code: 'too_large' })),
    '内容太长了——缩短这条消息，或另起一段新对话。',
  );
  assert.equal(chatErrorMessage(new Error('socket hang up')), 'Chat 暂时不可用，请稍后再试——之前的对话都还在。');
});

test('the model holds no reader vocabulary — Chat and Read stay independent', async () => {
  // Spec user story 20: moving between faces must not expose or disturb the
  // other surface. The Chat model's whole surface is list/open/new/send on
  // Conversation records; nothing here names books, chapters, or positions.
  const chat = new Chat({ api: fakeApi() });
  await chat.refresh();
  const keys = Object.keys(chat.state).sort();
  assert.deepEqual(keys, ['activeId', 'conversations', 'error', 'messages', 'notice', 'sending', 'status']);
});
