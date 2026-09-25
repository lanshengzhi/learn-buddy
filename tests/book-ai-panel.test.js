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
  context: { scope: 'sentence', anchor: { sentence: 4, chapter: 2 } },
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
  panel.setConversation({ id: '000001', messages: [{ role: 'assistant', content: 'old answer' }] });
  assert.equal(panel.state.personId, 'dad');
  assert.equal(panel.state.bookId, 'book-hash');
  assert.equal(panel.state.chapterIndex, 2);
  assert.equal(panel.state.context, identity.context);
  assert.equal(panel.state.selectedText, 'the exact passage');
  assert.deepEqual(panel.state.messages, [{ role: 'assistant', content: 'old answer' }]);
});

test('streamed deltas update one assistant bubble and completed history wins', () => {
  const panel = new BookAiPanelController();
  panel.openAsk(identity);
  panel.beginTurn('逐词解释');
  panel.appendDelta('逐 ');
  panel.appendDelta('词解释');
  assert.deepEqual(panel.state.messages, [
    { role: 'user', content: '逐词解释' },
    { role: 'assistant', content: '逐 词解释', streaming: true },
  ]);
  panel.completeTurn({ id: '1', messages: [
    { role: 'user', content: '逐词解释' },
    { role: 'assistant', content: '逐 词解释' },
  ] });
  assert.equal(panel.state.streaming, false);
  assert.equal(panel.state.messages.at(-1).streaming, undefined);
});

test('an incomplete answer is not shown as a persisted conversation turn', () => {
  const panel = new BookAiPanelController();
  panel.openAsk(identity);
  panel.setConversation({ id: '1', messages: [{ role: 'assistant', content: 'saved' }] });
  panel.beginTurn('问题');
  panel.appendDelta('未完成的半截回答');
  panel.failTurn('ai_upstream_error');
  assert.equal(panel.state.streaming, false);
  assert.deepEqual(panel.state.messages, [{ role: 'assistant', content: 'saved' }]);
  assert.equal(panel.state.error, 'ai_upstream_error');
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

test('the agreed quick prompts are fixed and integration-ready', () => {
  assert.deepEqual(BOOK_AI_QUICK_PROMPTS.map((prompt) => prompt.label), [
    '句子结构', '逐词解释', '语法点', '中文翻译',
  ]);
  assert.ok(BOOK_AI_QUICK_PROMPTS.every((prompt) => prompt.id && prompt.text));
});
