import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOK_AI_QUICK_PROMPTS,
  STUDY_ARTIFACT_TYPES,
  BookAiPanelController,
  BookAiPanelState,
} from '../web/js/core/book-ai-panel.js';

const identity = {
  personId: 'dad',
  bookId: 'book-hash',
  bookTitle: 'Nav Book',
  chapterIndex: 2,
  chapterTitle: 'Arrival',
  context: {
    bookId: 'book-hash',
    book: { id: 'book-hash', title: 'Nav Book', contentHash: 'book-hash' },
    contentHash: 'book-hash',
    scope: 'sentence',
    anchor: { sentence: 4, chapter: 2 },
    text: 'The exact sentence.',
  },
  selectedText: 'the exact passage',
};

test('Book AI exposes only the four explicit panel states', () => {
  assert.deepEqual(Object.values(BookAiPanelState), [
    'closed', 'ask', 'job', 'artifact-preview',
  ]);
  const panel = new BookAiPanelController();
  assert.equal(panel.state.panelState, BookAiPanelState.Closed);
  panel.openAsk(identity);
  assert.equal(panel.state.panelState, BookAiPanelState.Ask);
  panel.openJob({ status: 'waiting_remote' });
  assert.equal(panel.state.panelState, BookAiPanelState.Job);
  panel.returnFromPreview();
  assert.equal(panel.state.panelState, BookAiPanelState.Ask);
  panel.close();
  assert.equal(panel.state.panelState, BookAiPanelState.Closed);
});

test('ask state retains active identity/context and conversation messages', () => {
  const panel = new BookAiPanelController();
  panel.openAsk(identity);
  panel.setConversation({
    id: '000001',
    bookId: identity.bookId,
    messages: [{ role: 'assistant', content: 'old answer' }],
  });
  assert.equal(panel.state.personId, 'dad');
  assert.equal(panel.state.bookId, 'book-hash');
  assert.equal(panel.state.chapterIndex, 2);
  assert.equal(panel.state.context, identity.context);
  assert.equal(panel.state.selectedText, 'the exact passage');
  assert.deepEqual(panel.state.messages, [{ role: 'assistant', content: 'old answer' }]);
});

test('opening another Book clears the previous Book thread and rejects a stale conversation', () => {
  const panel = new BookAiPanelController();
  panel.openAsk(identity);
  panel.setConversation({
    id: '000001',
    bookId: identity.bookId,
    messages: [{ role: 'user', content: 'private old question' }],
  });
  panel.openAsk({ ...identity, bookId: 'other-book', bookTitle: 'Other Book' });
  assert.equal(panel.state.conversation, null);
  assert.deepEqual(panel.state.messages, []);
  assert.equal(panel.setConversation({ id: '000002', bookId: identity.bookId }), false);
  assert.deepEqual(panel.state.messages, []);
  assert.equal(panel.state.error, 'book_conversation_not_found');
});

test('returning from a StudyJob keeps the same BookConversation and active context', () => {
  const panel = new BookAiPanelController();
  const conversation = {
    id: '000001', bookId: identity.bookId, messages: [{ role: 'user', content: 'saved question' }],
  };
  panel.openAsk(identity);
  panel.setConversation(conversation);
  panel.openJob({ status: 'waiting_remote', artifactType: 'mind_map', contextScope: { scope: 'book' } });
  panel.openAsk(identity);
  assert.equal(panel.state.conversation, conversation);
  assert.deepEqual(panel.state.messages, conversation.messages);
  assert.equal(panel.state.context, identity.context);
  assert.equal(panel.state.panelState, BookAiPanelState.Ask);
});

test('streamed deltas retain the sent snapshot and completed history wins', () => {
  const panel = new BookAiPanelController();
  panel.openAsk(identity);
  panel.setConversation({ id: '1', bookId: identity.bookId, messages: [] });
  panel.beginTurn('逐词解释');
  panel.appendDelta('逐 ');
  panel.appendDelta('词解释');
  assert.deepEqual(panel.state.messages, [
    { role: 'user', content: '逐词解释', contextSnapshot: identity.context },
    {
      role: 'assistant',
      content: '逐 词解释',
      streaming: true,
      contextSnapshot: identity.context,
    },
  ]);
  panel.completeTurn({ id: '1', bookId: identity.bookId, messages: [
    { role: 'user', content: '逐词解释' },
    { role: 'assistant', content: '逐 词解释' },
  ] });
  assert.equal(panel.state.streaming, false);
  assert.equal(panel.state.messages.at(-1).streaming, undefined);
});

test('a stale stream cannot write into a newly opened Person/Book context', () => {
  const panel = new BookAiPanelController();
  panel.openAsk(identity);
  panel.setConversation({ id: '1', bookId: identity.bookId, messages: [] });
  panel.beginTurn('旧书问题');
  panel.openAsk({ ...identity, personId: 'mom', bookId: 'other-book' });
  assert.equal(panel.appendDelta('旧书回答'), false);
  assert.equal(panel.completeTurn({
    id: '1', bookId: identity.bookId, messages: [{ role: 'assistant', content: '旧书回答' }],
  }), false);
  assert.deepEqual(panel.state.messages, []);
  assert.equal(panel.state.streaming, false);
});

test('an incomplete answer is not shown as a persisted conversation turn', () => {
  const panel = new BookAiPanelController();
  panel.openAsk(identity);
  panel.setConversation({
    id: '1', bookId: identity.bookId, messages: [{ role: 'assistant', content: 'saved' }],
  });
  panel.beginTurn('问题');
  panel.appendDelta('未完成的半截回答');
  panel.failTurn('ai_upstream_error');
  assert.equal(panel.state.streaming, false);
  assert.deepEqual(panel.state.messages, [{ role: 'assistant', content: 'saved' }]);
  assert.equal(panel.state.error, 'ai_upstream_error');
});

test('job actions are safe and unknown is recheck-only', () => {
  const panel = new BookAiPanelController();
  assert.equal(panel.jobAction({ state: 'queued' }), 'cancel');
  for (const state of ['preparing', 'uploading', 'waiting_remote', 'downloading']) {
    assert.equal(panel.jobAction({ state }), 'cancel');
  }
  assert.equal(panel.jobAction({ state: 'failed' }), 'retry');
  assert.equal(panel.jobAction({ state: 'not_configured' }), 'retry');
  assert.equal(panel.jobAction({ state: 'unknown' }), 'recheck');
  assert.equal(panel.jobAction({ state: 'ready' }), null);
  assert.equal(panel.jobAction({ state: 'cancelled' }), null);
  assert.equal(panel.jobAction(null), null);
});

test('provider failure is rendered as a fixed product code and never raw body', () => {
  const panel = new BookAiPanelController();
  panel.openAsk(identity);
  panel.failTurn('notebooklm_unavailable');
  assert.equal(panel.state.error, 'notebooklm_unavailable');
  assert.equal(panel.state.messages.length, 0);
});

test('only a ready local artifact can enter center preview', () => {
  const panel = new BookAiPanelController();
  panel.openAsk(identity);
  assert.equal(panel.openArtifactPreview({ status: 'downloading' }), false);
  assert.equal(panel.state.panelState, BookAiPanelState.Ask);
  assert.match(panel.state.error, /已完成/);
  assert.equal(panel.openArtifactPreview({ status: 'ready', type: 'report' }), true);
  assert.equal(panel.state.panelState, BookAiPanelState.ArtifactPreview);
});

test('the four artifact types expose only their legal scopes', () => {
  assert.deepEqual(STUDY_ARTIFACT_TYPES.map((artifact) => [artifact.id, artifact.scopes]), [
    ['learning_report', ['chapter', 'book']],
    ['mind_map', ['chapter', 'book']],
    ['flashcard_set', ['selection', 'chapter', 'book']],
    ['audio_explanation', ['chapter', 'book']],
  ]);
});

test('job status requires a real product job and retains visible type and scope', () => {
  const panel = new BookAiPanelController();
  panel.openAsk(identity);
  assert.equal(panel.openJob(), false);
  assert.equal(panel.state.panelState, BookAiPanelState.Ask);
  assert.equal(panel.openJob({
    status: 'waiting_remote', artifactType: 'flashcard_set',
    contextScope: { scope: 'selection', anchor: { start: 2, end: 4 } },
  }), true);
  assert.equal(panel.state.job.artifactType, 'flashcard_set');
  assert.equal(panel.state.job.contextScope.scope, 'selection');
});

test('the agreed quick prompts are fixed, executable, and never imply whole-Book scope', () => {
  assert.deepEqual(BOOK_AI_QUICK_PROMPTS, [
    {
      id: 'sentence-structure',
      label: '句子结构',
      text: '请分析当前句子或选区的句子结构，不要重新分段。',
    },
    {
      id: 'word-by-word',
      label: '逐词解释',
      text: '请逐词解释当前句子或选区。',
    },
    {
      id: 'grammar',
      label: '语法点',
      text: '请说明当前句子或选区中的语法点。',
    },
    {
      id: 'chinese',
      label: '中文翻译',
      text: '请把当前句子或选区翻译成中文。',
    },
  ]);
  assert.ok(BOOK_AI_QUICK_PROMPTS.every((prompt) => !prompt.text.includes('整本书')));
});
