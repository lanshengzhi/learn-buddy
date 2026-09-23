/**
 * Chat — the A-layout Conversation model (ticket #47): the current Person's
 * Conversation list plus the open thread. DOM-free; the /next adapter
 * (web/next/chat.js) subscribes via onEvent and renders from state,
 * following the Shelf pattern.
 *
 * Conversations are LearnBuddy's own server-side records, scoped by the api
 * instance's profile — switching Persons (which reloads the app) switches
 * which Conversations load. `send` hands the server only the new text; the
 * server assembles the model context from the stored Conversation (ADR
 * 0015), so no Read content or other Conversations can leak into a turn
 * from this model. A failed send leaves the thread's messages untouched and
 * reports a fixed, safe line — the adapter keeps the draft for retry.
 */

/**
 * Learner-facing line for a failed turn. Never carries upstream provider
 * text (spec §9.2); every failure reassures that stored history is intact
 * (spec user story 13).
 */
export function chatErrorMessage(error) {
  switch (error?.code) {
    case 'ai_usage_limit':
      return 'AI 用量受限，请稍后再试——之前的对话都还在。';
    case 'ai_not_configured':
      return 'Chat 还没有配置好，暂时不可用。';
    case 'conversation_not_found':
      return '这段对话不存在了——另选一段或新建。';
    case 'too_large':
      // Message over the limit, a full Conversation, or a history payload
      // past the sidecar's chat body cap — all recoverable by the family.
      return '内容太长了——缩短这条消息，或另起一段新对话。';
    default:
      // ai_upstream_error / ai_timeout / network_failure / …
      return 'Chat 暂时不可用，请稍后再试——之前的对话都还在。';
  }
}

export class Chat {
  /**
   * @param {object} deps
   * @param {{listConversations: () => Promise<object[]>, createConversation: () => Promise<object>, getConversation: (id: string) => Promise<object>, sendChatMessage: (id: string, text: string) => Promise<{conversation: object}>}} deps.api — ServerApi-shaped, profile already set
   * @param {(event: object) => void} [deps.onEvent] — `{type:'chat-changed'}` after every state mutation
   */
  constructor({ api, onEvent = () => {} }) {
    this.api = api;
    this.onEvent = onEvent;
    this.state = {
      status: 'idle', // idle | loading | ready | error — the list, not the thread
      conversations: [], // summaries, newest first
      activeId: null, // null = a fresh, not-yet-saved thread
      messages: [], // the open thread's messages
      sending: false,
      error: null, // list load failure
      notice: null, // send/open outcome line (failures)
    };
    this.#autoOpened = false;
  }

  #autoOpened;

  /**
   * Loads the Person's Conversation list; the first load reopens the newest
   * Conversation so a refresh or re-entry continues where the Person left
   * off. A failure keeps the last good list.
   */
  async refresh() {
    this.#patch({ status: 'loading', error: null });
    try {
      const conversations = await this.api.listConversations();
      this.#patch({ status: 'ready', conversations });
    } catch (error) {
      this.#patch({ status: 'error', error: error.message ?? '对话列表加载失败。' });
      return;
    }
    if (!this.#autoOpened) {
      this.#autoOpened = true;
      const newest = this.state.conversations[0];
      if (newest) await this.open(newest.id);
    }
  }

  /** Opens a stored Conversation in the workspace. */
  async open(conversationId) {
    this.#patch({ notice: null });
    try {
      const conversation = await this.api.getConversation(conversationId);
      this.#patch({ activeId: conversation.id, messages: conversation.messages ?? [] });
    } catch (error) {
      this.#patch({ notice: chatErrorMessage(error) });
    }
  }

  /** ＋ 新对话: a fresh empty thread — saved on the server by its first send. */
  newThread() {
    if (this.state.activeId === null && this.state.messages.length === 0 && !this.state.notice) return;
    this.#patch({ activeId: null, messages: [], notice: null });
  }

  /**
   * Sends one message in the open thread — creating the Conversation first
   * when the thread is fresh. Resolves true on success; the caller keeps
   * the draft until then. Concurrent sends are ignored.
   */
  async send(text) {
    const content = (text ?? '').trim();
    if (!content || this.state.sending) return false;
    this.#patch({ sending: true, notice: null });
    try {
      let id = this.state.activeId;
      if (id === null) {
        const created = await this.api.createConversation();
        id = created.id;
        this.#patch({ activeId: id });
      }
      const { conversation } = await this.api.sendChatMessage(id, content);
      this.#patch({ sending: false, activeId: conversation.id, messages: conversation.messages ?? [] });
      this.#syncSummary(conversation);
      return true;
    } catch (error) {
      // Nothing was appended, server-side either (the turn is atomic) — the
      // stored Conversation is exactly as before.
      this.#patch({ sending: false, notice: chatErrorMessage(error) });
      return false;
    }
  }

  // --- internals -----------------------------------------------------------

  #syncSummary(conversation) {
    const summary = {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: (conversation.messages ?? []).length,
    };
    const rest = this.state.conversations.filter((c) => c.id !== summary.id);
    const conversations = [summary, ...rest].sort(
      (a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1),
    );
    this.#patch({ conversations });
  }

  #patch(patch) {
    this.state = { ...this.state, ...patch };
    this.onEvent({ type: 'chat-changed' });
  }
}
