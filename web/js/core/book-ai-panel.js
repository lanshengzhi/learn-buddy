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

export const STUDY_ARTIFACT_TYPES = Object.freeze([
  { id: 'learning_report', label: '学习报告', scopes: ['chapter', 'book'] },
  { id: 'mind_map', label: '思维导图', scopes: ['chapter', 'book'] },
  { id: 'flashcard_set', label: '闪卡', scopes: ['selection', 'chapter', 'book'] },
  { id: 'audio_explanation', label: '音频讲解', scopes: ['chapter', 'book'] },
]);

export const BOOK_AI_QUICK_PROMPTS = Object.freeze([
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

export class BookAiPanelController {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.messagesBeforeTurn = [];
    this.activeTurn = null;
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
      jobs: [],
      artifacts: [],
    };
  }

  #set(patch, event) {
    this.state = { ...this.state, ...patch };
    this.onEvent({ type: event, state: this.state });
  }

  openAsk({ personId, bookId, bookTitle, chapterIndex, chapterTitle, context, selectedText = '' }) {
    const newBookContext = !context
      || personId !== this.state.personId
      || bookId !== this.state.bookId
      || chapterIndex !== this.state.chapterIndex;
    this.#set({
      panelState: BookAiPanelState.Ask,
      personId,
      bookId,
      bookTitle,
      chapterIndex,
      chapterTitle,
      context,
      selectedText,
      // A new Person/Book context must never flash the previous thread while
      // its BookConversation is being loaded. Returning from a StudyJob in
      // the same Book keeps the active thread and its immutable context.
      ...(newBookContext ? {
        conversation: null,
        conversations: [],
        messages: [],
        streaming: false,
      } : {}),
      error: null,
      artifact: null,
      ...(newBookContext ? { jobs: [], artifacts: [] } : {}),
    }, 'ask-opened');
    if (newBookContext) this.activeTurn = null;
  }

  setJobs(jobs) {
    this.#set({
      jobs: jobs.filter((job) => job.bookId === this.state.bookId),
      error: null,
    }, 'jobs-loaded');
  }

  openJob(job) {
    const status = job?.state ?? job?.status;
    if (!job || typeof status !== 'string' || job.bookId !== this.state.bookId) return false;
    const normalized = { ...job, status, state: status };
    const knownIndex = this.state.jobs.findIndex((item) => item.id === job.id);
    const jobs = [...this.state.jobs];
    if (knownIndex >= 0) jobs[knownIndex] = { ...jobs[knownIndex], ...normalized };
    else jobs.unshift(normalized);
    this.#set({
      panelState: BookAiPanelState.Job,
      job: normalized,
      jobs,
      error: null,
    }, 'job-opened');
    return true;
  }

  jobAction(job) {
    const state = job?.state ?? job?.status;
    if (state === 'failed' || state === 'not_configured') return 'retry';
    if (state === 'unknown') return 'recheck';
    if (['queued', 'preparing', 'uploading', 'waiting_remote', 'downloading'].includes(state)) return 'cancel';
    return null;
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
    this.#set({
      conversations: conversations.filter((conversation) => conversation.bookId === this.state.bookId),
      error: null,
    }, 'conversations-loaded');
  }

  setConversation(conversation) {
    if (conversation?.bookId !== this.state.bookId) {
      this.#set({ error: 'book_conversation_not_found' }, 'conversation-rejected');
      return false;
    }
    if (this.activeTurn && conversation?.id !== this.activeTurn.conversationId) {
      this.activeTurn = null;
    }
    this.#set({
      conversation,
      messages: [...(conversation?.messages ?? [])],
      streaming: false,
      error: null,
    }, 'conversation-opened');
    return true;
  }

  canSend(context = this.state.context) {
    return !this.state.streaming
      && Boolean(this.state.conversation)
      && this.state.conversation?.bookId === this.state.bookId
      && context?.bookId === this.state.bookId;
  }

  beginTurn(text) {
    this.messagesBeforeTurn = [...this.state.messages];
    const contextSnapshot = structuredClone(this.state.context);
    this.activeTurn = {
      conversationId: this.state.conversation?.id,
      bookId: this.state.bookId,
      contextSnapshot,
    };
    this.#set({
      messages: [
        ...this.state.messages,
        { role: 'user', content: text, contextSnapshot },
      ],
      streaming: true,
      error: null,
    }, 'turn-started');
  }

  appendDelta(text) {
    if (!this.activeTurn || !this.state.streaming
        || this.state.conversation?.id !== this.activeTurn.conversationId) return false;
    const messages = [...this.state.messages];
    const last = messages.at(-1);
    if (last?.role === 'assistant' && last.streaming) {
      messages[messages.length - 1] = { ...last, content: last.content + text };
    } else {
      messages.push({
        role: 'assistant',
        content: text,
        streaming: true,
        contextSnapshot: structuredClone(this.activeTurn.contextSnapshot),
      });
    }
    this.#set({ messages }, 'answer-delta');
    return true;
  }

  completeTurn(conversation) {
    if (!this.activeTurn || conversation?.bookId !== this.state.bookId
        || conversation?.id !== this.activeTurn.conversationId) return false;
    this.#set({
      conversation,
      messages: [...(conversation?.messages ?? this.state.messages)],
      streaming: false,
      error: null,
    }, 'turn-completed');
    this.activeTurn = null;
    this.messagesBeforeTurn = [];
    return true;
  }

  failTurn(code) {
    if (!this.activeTurn) {
      this.#set({ error: code }, 'turn-failed');
      return;
    }
    this.#set({
      messages: this.messagesBeforeTurn,
      streaming: false,
      error: code,
    }, 'turn-failed');
    this.activeTurn = null;
    this.messagesBeforeTurn = [];
  }
}
