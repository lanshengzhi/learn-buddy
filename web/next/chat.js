/**
 * Chat DOM adapter (ticket #47) — renders the Chat model into the nav's
 * conversation section (#nav-conversations) and the Chat face (#chat-face),
 * and wires new/open/send. The reading workspace stays owned by /js/app.js;
 * the face switch itself lives in shell.js and only toggles `hidden`, so
 * this module never rebuilds or even touches the reading pane (spec §4.2
 * #2) — Chat and Read stay fully independent (spec user story 20).
 *
 * The nav section rides into the narrow drawer unchanged, same as the
 * shelf — no second layout to maintain.
 */

import { ServerApi } from '/js/core/api.js';
import { Chat } from '/js/core/chat.js';
import { Layer, Face } from '/js/core/shell-controller.js';
import { storedProfile } from '/js/browser/profile.js';
import { onReadReady } from './read-ready.js';

const $ = (id) => document.getElementById(id);

// Same coarse-pointer seam app.js uses for the editor's keyboard takeover.
const COARSE = window.matchMedia('(pointer: coarse)');

/**
 * @param {object} deps
 * @param {import('/js/core/shell-controller.js').ShellController} deps.shell — to close the drawer after a pick on narrow
 * @returns {{activate: () => void}} — the shell calls activate() when the Chat face shows
 */
export function initChat({ shell }) {
  const listEl = $('conversation-list');
  const emptyEl = $('conversation-empty');
  const listNoticeEl = $('conversation-notice');
  const titleEl = $('chat-title');
  const noticeEl = $('chat-notice');
  const messagesEl = $('chat-messages');
  const emptyThreadEl = $('chat-empty');
  const form = $('chat-composer');
  const input = $('chat-input');
  const sendButton = $('chat-send');

  let chat = null;

  const start = () => {
    if (chat || !window.learnbuddyRead) return;
    chat = new Chat({ api: new ServerApi({ profile: storedProfile() }), onEvent: render });
    render();
    // The Chat face may already be showing (clicked before the reader boot
    // announced itself) — load the list now that a Person is known.
    if (shell.state.activeFace === Face.Chat) void chat.refresh();
  };
  onReadReady(start);

  function render() {
    if (!chat) return;
    const s = chat.state;

    // contextual list (nav)
    const listMessage = s.status === 'error' ? s.error : null;
    listNoticeEl.hidden = !listMessage;
    if (listMessage) listNoticeEl.textContent = listMessage;
    emptyEl.hidden = !(s.status === 'ready' && s.conversations.length === 0);
    listEl.replaceChildren(...s.conversations.map((c) => conversationItem(c, s.activeId)));

    // workspace thread
    const active = s.conversations.find((c) => c.id === s.activeId);
    titleEl.textContent = s.activeId === null ? '新对话' : (active?.title ?? '新对话');
    noticeEl.hidden = !s.notice;
    if (s.notice) noticeEl.textContent = s.notice;
    emptyThreadEl.hidden = s.messages.length > 0;
    emptyThreadEl.textContent = s.activeId === null
      ? '开始一段新对话——在下方直接输入第一条消息。'
      : '这段对话还没有消息——在下方输入第一条。';
    messagesEl.replaceChildren(...s.messages.map(bubble));
    // Follow the tail of the thread like any chat surface.
    messagesEl.scrollTop = messagesEl.scrollHeight;

    sendButton.disabled = s.sending;
    input.disabled = s.sending;
  }

  function conversationItem(conversation, activeId) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    // .panel-item carries the shared style (shell.css); .conversation-item
    // stays as the per-concept hook (shell smoke selects it).
    button.className = 'panel-item conversation-item';
    const active = conversation.id === activeId;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'true');

    const title = document.createElement('b');
    title.textContent = conversation.title || '新对话';
    const meta = document.createElement('span');
    meta.className = 'panel-meta';
    meta.textContent = timeLabel(conversation.updatedAt);

    button.append(title, meta);
    button.addEventListener('click', () => {
      // Picking a conversation dismisses the narrow drawer; on wide a no-op.
      shell.close(Layer.Drawer);
      void chat.open(conversation.id);
    });
    li.append(button);
    return li;
  }

  function bubble(message) {
    const div = document.createElement('div');
    div.className = `chat-message ${message.role}`;
    const p = document.createElement('p');
    p.className = 'bubble';
    p.textContent = message.content; // textContent, never innerHTML — model text is data
    div.append(p);
    return div;
  }

  /** 「今天 14:03」/「昨天 21:40」/「06-12」— enough context for a family list. */
  function timeLabel(at) {
    if (!at) return '';
    const date = new Date(at);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    if (sameDay) return `今天 ${hhmm}`;
    if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`;
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  // --- composer ---------------------------------------------------------------

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!chat) return;
    const draft = input.value;
    void chat.send(draft).then((sent) => {
      // Failure keeps the draft in the composer; the notice line says why.
      if (sent) {
        input.value = '';
        input.focus();
      }
    });
  });

  // Enter sends, Shift+Enter breaks the line — the usual chat idiom.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  // Virtual keyboard (spec §4.2): reuse the existing editor-takeover
  // mechanism — the same body class app.js drives for the editor, so there
  // is exactly one keyboard dance. CSS for the chat side lives in shell.css
  // under `body.editor-takeover`.
  input.addEventListener('focus', () => {
    if (COARSE.matches) document.body.classList.add('editor-takeover');
  });
  input.addEventListener('blur', (event) => {
    if (!COARSE.matches || !document.body.classList.contains('editor-takeover')) return;
    // Tapping the send button moves focus to it — keep the takeover so the
    // tap lands; tapping anywhere else retreats it (mirrors app.js).
    if (event.relatedTarget && form.contains(event.relatedTarget)) return;
    document.body.classList.remove('editor-takeover');
  });

  // --- new conversation ---------------------------------------------------------

  const newThread = () => {
    if (!chat) return;
    chat.newThread();
    shell.close(Layer.Drawer);
    input.focus();
  };
  $('conversation-new').addEventListener('click', newThread);
  $('chat-new').addEventListener('click', newThread);

  return {
    /** The shell calls this whenever the Chat face becomes visible. */
    activate() {
      start(); // a late reader boot still lands
      if (chat && chat.state.status === 'idle') void chat.refresh();
    },
  };
}
