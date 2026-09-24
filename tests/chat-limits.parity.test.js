// Chat limit parity (spec #45 / ticket #47): the same numbers live in three
// files across two languages — the server's Conversation bounds
// (server/conversations.py), the composer's maxlength (web/next/index.html),
// and the sidecar's /chat body cap (ai-service/index.mjs). A drift means the
// composer allows what the server rejects, or the sidecar 400s a turn the
// server just sent — a permanent "Chat 暂时不可用" for a long Conversation.
// Assert the values here instead of trusting the cross-referencing comments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const conversationsPy = readFileSync(new URL('../server/conversations.py', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../web/next/index.html', import.meta.url), 'utf8');
const sidecarMjs = readFileSync(new URL('../ai-service/index.mjs', import.meta.url), 'utf8');

function pyConstant(name) {
  const match = conversationsPy.match(new RegExp(`^${name} = ([\\d_]+)`, 'm'));
  assert.ok(match, `${name} missing from server/conversations.py`);
  return Number(match[1].replaceAll('_', ''));
}

test('the composer maxlength matches the server’s per-message limit', () => {
  const match = indexHtml.match(/id="chat-input"[^>]*maxlength="(\d+)"/);
  assert.ok(match, 'chat-input maxlength missing from web/next/index.html');
  assert.equal(Number(match[1]), pyConstant('MAX_MESSAGE_CHARS'));
});

test('the sidecar /chat body cap matches the server’s chat body budget', () => {
  const match = sidecarMjs.match(/const MAX_CHAT_BODY_BYTES = ([\d_]+);/);
  assert.ok(match, 'MAX_CHAT_BODY_BYTES missing from ai-service/index.mjs');
  assert.equal(Number(match[1].replaceAll('_', '')), pyConstant('MAX_CHAT_BODY_BYTES'));
});

test('the chat body cap comfortably exceeds the worst-case Conversation payload', () => {
  // 4 bytes/char is the UTF-8 worst case; JSON escaping only inflates ASCII.
  const worstCaseBytes = pyConstant('MAX_MESSAGES') * pyConstant('MAX_MESSAGE_CHARS') * 4;
  assert.ok(
    pyConstant('MAX_CHAT_BODY_BYTES') >= worstCaseBytes * 2,
    'the sidecar cap must leave headroom past the worst-case legitimate turn',
  );
});
