/**
 * Explicit Read-owned Book AI panel state (issue #72).
 *
 * The reader is not part of this state. Callers may change these four states
 * without mounting or replacing #book-view, which is what preserves its DOM,
 * selection anchor, and scroll position.
 */

export const BookAiPanelState = Object.freeze({
  Closed: 'closed',
  Ask: 'ask',
  Job: 'job',
  ArtifactPreview: 'artifact-preview',
});

export const BOOK_AI_QUICK_PROMPTS = Object.freeze([
  { id: 'sentence-structure', label: '句子结构', text: '请分析当前内容的句子结构。' },
  { id: 'word-by-word', label: '逐词解释', text: '请逐词解释当前内容。' },
  { id: 'grammar', label: '语法点', text: '请说明当前内容中的语法点。' },
  { id: 'chinese', label: '中文翻译', text: '请把当前内容翻译成中文。' },
]);

export class BookAiPanelController {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.messagesBeforeTurn = [];
    this.state = {
      panelState: BookAiPanelState.Closed,
      personId: null,
      bookId: null,
      bookTitle: '',
      chapterIndex: null,
      chapterTitle: '',
      context: null,
      selectedText: '',
      conversations: [],
      conversation: null,
      messages: [],
      streaming: false,
      error: null,
      job: { status: 'unavailable', message: '学习产物生成尚未启用。' },
      artifact: null,
    };
  }

  #set(patch, event) {
    this.state = { ...this.state, ...patch };
    this.onEvent({ type: event, state: this.state });
  }

  openAsk({ personId, bookId, bookTitle, chapterIndex, chapterTitle, context, selectedText = '' }) {
    this.#set({
      panelState: BookAiPanelState.Ask,
      personId,
      bookId,
      bookTitle,
      chapterIndex,
      chapterTitle,
      context,
      selectedText,
      error: null,
      artifact: null,
    }, 'ask-opened');
  }

  openJob(job = this.state.job) {
    // No generation API exists yet. A caller may still inject a real product
    // job later; this panel never fabricates a successful job or artifact.
    this.#set({ panelState: BookAiPanelState.Job, job, error: null }, 'job-opened');
  }

  openArtifactPreview(artifact) {
    if (!artifact || artifact.status !== 'ready') {
      this.#set({ error: '只有已完成的本地学习产物才能预览。' }, 'artifact-rejected');
      return false;
    }
    this.#set({
      panelState: BookAiPanelState.ArtifactPreview,
      artifact,
      error: null,
    }, 'artifact-opened');
    return true;
  }

  returnFromPreview() {
    this.#set({ panelState: BookAiPanelState.Ask, artifact: null }, 'artifact-returned');
  }

  close() {
    this.#set({ panelState: BookAiPanelState.Closed }, 'panel-closed');
  }

  setConversations(conversations) {
    this.#set({ conversations: [...conversations], error: null }, 'conversations-loaded');
  }

  setConversation(conversation) {
    this.#set({
      conversation,
      messages: [...(conversation?.messages ?? [])],
      streaming: false,
      error: null,
    }, 'conversation-opened');
  }

  beginTurn(text) {
    this.messagesBeforeTurn = [...this.state.messages];
    this.#set({
      messages: [...this.state.messages, { role: 'user', content: text }],
      streaming: true,
      error: null,
    }, 'turn-started');
  }

  appendDelta(text) {
    const messages = [...this.state.messages];
    const last = messages.at(-1);
    if (last?.role === 'assistant' && last.streaming) {
      messages[messages.length - 1] = { ...last, content: last.content + text };
    } else {
      messages.push({ role: 'assistant', content: text, streaming: true });
    }
    this.#set({ messages }, 'answer-delta');
  }

  completeTurn(conversation) {
    this.#set({
      conversation,
      messages: [...(conversation?.messages ?? this.state.messages)],
      streaming: false,
      error: null,
    }, 'turn-completed');
  }

  failTurn(code) {
    this.#set({
      messages: this.messagesBeforeTurn,
      streaming: false,
      error: code,
    }, 'turn-failed');
    this.messagesBeforeTurn = [];
  }
}
