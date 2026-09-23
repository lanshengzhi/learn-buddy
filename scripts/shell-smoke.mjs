/**
 * Slice-1 shell smoke (dev machine — like browser-smoke.mjs). Needs the backend on
 * :8123 with the repo data dir. Verifies Read purity, Learn flow, face
 * round-trip position preservation, narrow drawer behavior, and old-shell parity.
 */
import { createRequire } from 'module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/lansy/.local/share/mise/installs/npm-playwright/1.62.1/lib/node_modules/playwright');

const BASE = process.env.LEARNBUDDY_BASE ?? 'http://127.0.0.1:8123';
mkdirSync('shots-shell', { recursive: true });
const errors = [];
let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
};

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });

function watch(page, tag) {
  page.on('console', (msg) => {
    // The Learn smoke stubs /tts with an empty audio payload after verifying
    // its request path; Chrome reports that synthetic blob as a decode error.
    if (msg.type() === 'error' && !msg.text().includes('ERR_REQUEST_RANGE_NOT_SATISFIABLE')) {
      errors.push(`${tag}: ${msg.text()} [${msg.location()?.url ?? ''}]`);
    }
  });
  page.on('pageerror', (err) => errors.push(`${tag}: ${err}`));
}

async function boot(context, path, tag) {
  const page = await context.newPage();
  watch(page, tag);
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  if (await page.locator('#profile-gate').isVisible()) {
    await page.locator('#profile-choices button').first().click();
  }
  await page.waitForSelector('body[data-ready]');
  return page;
}

async function openFirstBook(page) {
  if (await page.locator('#book-view').isVisible()) return; // already reading
  const opener = page.locator('#empty-library-btn');
  await opener.click();
  await page.locator('#library-list li').first().waitFor();
  await page.locator('#library-list li').first().click();
  await page.waitForSelector('#book-view:not([hidden])');
  await page.waitForSelector('#chapter-body .sent');
}

// ---------- wide (1280×900) ----------
const wide = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const wp = await boot(wide, '/next/', 'wide');
check('wide: nav visible', await wp.locator('#shell-nav').isVisible());
check('wide: topbar hidden', !(await wp.locator('#shell-topbar').isVisible()));
await wp.waitForTimeout(300);
check('wide: identity chip shows a person', (await wp.locator('#identity-name').textContent()).trim() !== '…');
await wp.screenshot({ path: 'shots-shell/wide.png' });

await wp.locator('#nav-collapse').click();
check('wide: nav collapses to icon bar', (await wp.locator('#shell-nav').boundingBox()).width <= 60);
check('wide: shelf folds away with the collapsed nav', !(await wp.locator('#nav-shelf').isVisible()));
await wp.locator('#nav-collapse').click();
check('wide: nav re-expands', (await wp.locator('#shell-nav').boundingBox()).width > 200);

// ---------- ticket #46: A-layout shelf (the Read face's contextual list) ----------
check('wide: shelf section visible in the nav', await wp.locator('#nav-shelf').isVisible());
check('wide: Chat entry enabled (#47)',
  !(await wp.locator('#nav-chat').isDisabled()) && (await wp.locator('#nav-chat .nav-note').count()) === 0);
const shelfCount = await wp.locator('#shelf-list .shelf-item').count();
check(`wide: shelf lists the Person's books (${shelfCount})`, shelfCount > 0);

// invalid upload: clear error, shelf intact
writeFileSync('shots-shell/not-a-book.epub', 'definitely not a zip');
await wp.locator('#shelf-upload-input').setInputFiles('shots-shell/not-a-book.epub');
await wp.waitForSelector('#shelf-notice:not([hidden])');
check('wide: invalid epub shows a clear error',
  (await wp.locator('#shelf-notice').textContent()).includes('epub'));
check('wide: failed upload keeps the shelf intact',
  (await wp.locator('#shelf-list .shelf-item').count()) === shelfCount);

// valid upload through the shelf control (duplicate when the fixture is already shelved)
await wp.locator('#shelf-upload-input').setInputFiles('server/tests/fixtures/nav.epub');
await wp.waitForFunction(() =>
  /已加入书架|已有这本书/.test(document.getElementById('shelf-notice').textContent));
check('wide: upload through the shelf reports its outcome', true);
check('wide: shelf still lists the books after upload',
  (await wp.locator('#shelf-list .shelf-item').count()) >= shelfCount);

// open a book straight from the shelf — wait for the active mark, which
// lands only after openBook resolves (the chapter is rendered); counting
// sentences right after the click races the chapter re-render.
await wp.locator('#shelf-list .shelf-item').first().click();
await wp.waitForSelector('#shelf-list .shelf-item.active');
check('wide: shelf marks the open book active', true);
check('wide: shelf opens the book in the workspace',
  (await wp.locator('#chapter-body .sent').count()) > 0);
await wp.locator('#chapter-body .sent').nth(3).click();
await wp.locator('#book-scroll').evaluate((el) => (el.scrollTop = 500));
const scrollBefore = await wp.locator('#book-scroll').evaluate((el) => el.scrollTop);
const wideSelectedBefore = await wp.locator('#chapter-body .sent.selected').getAttribute('data-sentence');
check('wide: Read hides playback, lookup, paste editor, and legacy library controls',
  !(await wp.locator('#bottom-bar').isVisible())
  && !(await wp.locator('#tab-lookup').isVisible())
  && !(await wp.locator('#editor-region').isVisible())
  && !(await wp.locator('#library-overlay').isVisible())
  && !(await wp.locator('#hl-toggle').isVisible())
  && !(await wp.locator('#library-btn').isVisible()));
await wp.locator('#nav-learn').click();
check('wide: Learn shows paste editor, playback, and history entry',
  await wp.locator('#editor-region').isVisible()
  && await wp.locator('#bottom-bar').isVisible()
  && await wp.locator('#nav-history').isVisible());
const wideRoundTrip = await wp.locator('#book-scroll').evaluate((el) => el.scrollTop);
const wideSentenceCount = await wp.locator('#chapter-body .sent').count();
const wideSelectedAfter = await wp.locator('#chapter-body .sent.selected').getAttribute('data-sentence');
check(`wide: face round-trip preserves reader DOM and position (${wideSelectedBefore}→${wideSelectedAfter}; scroll ${scrollBefore}→${wideRoundTrip})`,
  wideRoundTrip === scrollBefore && wideSelectedBefore === wideSelectedAfter && wideSentenceCount > 0);
await wp.locator('#nav-read').click();
check('wide: 阅读记录 belongs to Learn', !(await wp.locator('#nav-history').isVisible()));
await wp.locator('#nav-learn').click();
await wp.locator('#nav-history').click();
check('wide: 阅读记录 opens History pane on Learn', await wp.locator('#history-pane').isVisible());

// ---------- narrow (390×844 touch) ----------
const narrow = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const np = await boot(narrow, '/next/', 'narrow');
check('narrow: topbar visible', await np.locator('#shell-topbar').isVisible());
check('narrow: drawer starts closed', !(await np.evaluate(() => document.body.classList.contains('drawer-open'))));
await np.locator('#shell-nav-toggle').click();
check('narrow: ☰ opens the drawer', await np.evaluate(() => document.body.classList.contains('drawer-open')));
check('narrow: scrim shows with drawer', await np.locator('#shell-scrim').isVisible());
await np.screenshot({ path: 'shots-shell/narrow-drawer.png' });
await np.locator('#shell-scrim').click({ position: { x: 370, y: 400 } });
check('narrow: scrim tap closes the drawer', !(await np.evaluate(() => document.body.classList.contains('drawer-open'))));

// ticket #46: the same shelf rides in the narrow drawer
await np.locator('#shell-nav-toggle').click();
check('narrow: shelf rides in the drawer', await np.locator('#nav-shelf').isVisible());
await np.locator('#shelf-list .shelf-item').first().click();
check('narrow: picking from the shelf closes the drawer',
  !(await np.evaluate(() => document.body.classList.contains('drawer-open'))));
await np.waitForSelector('#shelf-list .shelf-item.active');
await np.waitForSelector('#book-view:not([hidden])');
check('narrow: shelf opens the book in the workspace',
  (await np.locator('#chapter-body .sent').count()) > 0);

await openFirstBook(np);
await np.locator('#chapter-body .sent').nth(3).click();
await np.locator('#book-scroll').evaluate((el) => (el.scrollTop = 300));
await np.waitForTimeout(100);
const nBefore = await np.locator('#book-scroll').evaluate((el) => el.scrollTop);
const nSelectedBefore = await np.locator('#chapter-body .sent.selected').getAttribute('data-sentence');
await np.locator('#shell-nav-toggle').click();
await np.locator('#nav-learn').click();
check('narrow: Learn editor remains available after drawer switch', await np.locator('#editor-region').isVisible());
await np.locator('#shell-nav-toggle').click();
await np.locator('#nav-read').click();
const nAfter = await np.locator('#book-scroll').evaluate((el) => el.scrollTop);
const nSelectedAfter = await np.locator('#chapter-body .sent.selected').getAttribute('data-sentence');
check(`narrow: Read → Learn → Read preserves position (${nSelectedBefore}→${nSelectedAfter}; scroll ${nBefore}→${nAfter})`,
  nBefore === nAfter && nSelectedBefore === nSelectedAfter);

// selection toolbar: select >3 chars across spans
const selLen = await np.evaluate(() => {
  const spans = [...document.querySelectorAll('#chapter-body .sent')[5].querySelectorAll('span')];
  const range = document.createRange();
  range.setStartBefore(spans[0]);
  range.setEndAfter(spans[Math.min(6, spans.length - 1)]);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return sel.toString().trim().length;
});
await np.waitForTimeout(400);
check(`narrow: toolbar appears for a long selection (${selLen} chars)`,
  selLen > 3 && (await np.locator('#sel-toolbar').isVisible()));
await np.keyboard.press('Escape');
check('narrow: Escape peels the toolbar', !(await np.locator('#sel-toolbar').isVisible()));

// wide: a long selection in Read still opens the copy toolbar, not a lookup card
await wp.locator('#nav-read').click();
const wideSel = await wp.evaluate(() => {
  const sentence = document.querySelectorAll('#chapter-body .sent')[5];
  const text = document.createTreeWalker(sentence, NodeFilter.SHOW_TEXT).nextNode();
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, Math.min(12, text.textContent.length));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const rect = range.getBoundingClientRect();
  document.getElementById('chapter-body').dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, clientX: rect.x + 2, clientY: rect.y + 2, pointerType: 'mouse',
  }));
  return sel.toString().trim().length;
});
await wp.waitForTimeout(400);
check(`wide: toolbar owns long selections (§4.3, ${wideSel} chars)`,
  wideSel > 3 && (await wp.locator('#sel-toolbar').isVisible()));
check('wide: Read keeps the lookup drawer hidden',
  !(await wp.locator('#lookup-drawer').isVisible()));
await wp.keyboard.press('Escape');

// ---------- ticket #46: resume + per-Person positions ----------
// Selecting a sentence writes the Reading position back (debounced 1.2 s);
// TTS may fail in a dev env, but the selection — and so the position — is
// recorded before the audio request.
const positionWrite = wp.waitForResponse((response) => response.url().includes('/position'));
await wp.locator('#chapter-body .sent').nth(2).evaluate((el) => el.click());
await wp.waitForFunction(() => document.querySelector('#chapter-body .sent.selected')?.dataset.sentence === '2');
await positionWrite;
await wp.waitForTimeout(1600);
const resumeExpected = await wp.locator('#chapter-body .sent.selected').getAttribute('data-sentence');
await wp.reload({ waitUntil: 'networkidle' });
await wp.waitForSelector('body[data-ready]');
check('wide: reload resumes the last book', await wp.locator('#book-view').isVisible());
const resumed = await wp.locator('#chapter-body .sent.selected').getAttribute('data-sentence');
check(`wide: reload restores a valid Reading position (${resumeExpected}→${resumed})`,
  resumed != null && Number.isInteger(Number(resumed)) && Number(resumed) >= 0);

// Switching Person must never cross positions: the next Person's shelf shows
// the same Book as unread. The gate reloads the page by design.
await wp.locator('#identity-chip').click();
await wp.locator('#profile-choices button').nth(1).click();
await wp.waitForSelector('body[data-ready]');
const otherLabel = await wp.locator('#shelf-list .shelf-item').first().locator('.shelf-reading').textContent();
check(`wide: another Person sees their own position (${otherLabel.trim()})`, otherLabel.trim() === '未开始');

// ---------- old shell untouched ----------
const op = await boot(wide, '/', 'old');
check('old: no shell chrome at /', (await op.locator('#shell-nav').count()) === 0);
check('old: reader intact at /', (await op.locator('#text-input').count()) === 1);

// ---------- ticket #47: Chat flow (self-contained: stub sidecar + throwaway
// backend on a temp data dir; no model provider is ever touched) ----------
const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const stubRequests = [];
let stubUp = true;
const stub = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/chat') {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      stubRequests.push(JSON.parse(raw));
      res.writeHead(stubUp ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(stubUp ? JSON.stringify({ text: `stub 回复 ${stubRequests.length}` }) : JSON.stringify({ error: 'upstream_error' }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubPort = stub.address().port;

const chatPort = await freePort();
const chatData = mkdtempSync(path.join(os.tmpdir(), 'learnbuddy-chat-smoke-'));
const chatBackend = spawn(
  process.env.LEARNBUDDY_PYTHON ?? 'python3',
  ['server/tts_server.py', '--port', String(chatPort), '--data-dir', chatData],
  { env: { ...process.env, LEARNBUDDY_AI_URL: `http://127.0.0.1:${stubPort}` }, stdio: 'ignore' },
);
try {
  const CHAT_BASE = `http://127.0.0.1:${chatPort}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    try {
      up = (await fetch(`${CHAT_BASE}/profiles`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  check('chat: throwaway backend booted with a stub sidecar', up);

  const chatCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const cp = await chatCtx.newPage();
  watch(cp, 'chat');
  await cp.goto(`${CHAT_BASE}/next/`, { waitUntil: 'networkidle' });
  if (await cp.locator('#profile-gate').isVisible()) {
    await cp.locator('#profile-choices button').first().click();
  }
  await cp.waitForSelector('body[data-ready]');
  check('read: empty state is Read-specific and learning controls stay hidden',
    (await cp.locator('#read-empty').textContent()).includes('书架打开一本书')
      && !(await cp.locator('#bottom-bar').isVisible())
      && !(await cp.locator('#editor-region').isVisible()));
  let ttsRequested = false;
  await cp.route('**/tts**', async (route) => {
    ttsRequested = true;
    await route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from('') });
  });
  await cp.locator('#nav-learn').click();
  await cp.locator('#text-input').fill('Hello there. This is a study passage.');
  await cp.locator('#update-button').click();
  await cp.waitForSelector('#sentence-list li');
  check('learn: paste and 断句 renders sentence cards', (await cp.locator('#sentence-list li').count()) >= 2);
  await cp.locator('#sentence-list li').first().evaluate((el) => {
    const text = el.firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(5, text.textContent.length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await cp.waitForSelector('#sel-toolbar:not([hidden])');
  await cp.locator('#sel-lookup').click();
  await cp.waitForSelector('#lookup-drawer:not([hidden])');
  check(`learn: selected pasted word opens existing lookup word card (seam=${await cp.evaluate(() => typeof window.learnbuddyLookup)})`,
    await cp.locator('#lookup-card .card-word').isVisible());
  await cp.locator('#lookup-card .card-actions button').last().click();
  check('learn: playback controls are available', await cp.locator('#play-button').isEnabled());
  await cp.locator('#play-button').click();
  await cp.waitForTimeout(300);
  check('learn: play path requests speech audio', ttsRequested);
  await cp.locator('#nav-read').click();
  check('read: learning cards and editor hidden again',
    !(await cp.locator('#editor-region').isVisible()) && !(await cp.locator('#bottom-bar').isVisible()));

  check('chat: nav entry enabled', !(await cp.locator('#nav-chat').isDisabled()));
  await cp.locator('#nav-chat').click();
  check('chat: face shows', await cp.locator('#chat-face').isVisible());
  check('chat: reading area hidden (not rebuilt)', !(await cp.locator('#reading-area').isVisible()));
  check('chat: conversation panel swaps in', await cp.locator('#nav-conversations').isVisible());
  check('chat: shelf hidden on the Chat face', !(await cp.locator('#nav-shelf').isVisible()));
  check('chat: provider disclosure stated',
    (await cp.locator('.chat-footnote').textContent()).includes('模型服务商'));

  // first message on a fresh thread creates the Conversation and answers
  await cp.locator('#chat-input').fill('你好，Pi');
  await cp.locator('#chat-send').click();
  await cp.waitForSelector('.chat-message.assistant .bubble');
  check('chat: reply rendered', (await cp.locator('.chat-message.assistant .bubble').textContent()).includes('stub 回复'));
  check('chat: sidecar got exactly the one user message',
    stubRequests.length === 1
      && stubRequests[0].messages.length === 1
      && stubRequests[0].messages[0].role === 'user'
      && stubRequests[0].messages[0].content === '你好，Pi');
  check('chat: conversation listed', (await cp.locator('#conversation-list .conversation-item').count()) === 1);

  // follow-up carries only this Conversation's text history
  await cp.locator('#chat-input').fill('接着问');
  await cp.locator('#chat-send').click();
  await cp.waitForFunction(() => document.querySelectorAll('.chat-message').length === 4);
  check('chat: follow-up context is the current Conversation only',
    stubRequests.length === 2
      && stubRequests[1].messages.map((m) => m.role).join(',') === 'user,assistant,user'
      && !('profile' in stubRequests[1]));

  // persistence: reload → the stored Conversation reopens
  await cp.reload({ waitUntil: 'networkidle' });
  await cp.waitForSelector('body[data-ready]');
  await cp.locator('#nav-chat').click();
  await cp.waitForSelector('.chat-message');
  check('chat: reload reopens the stored Conversation', (await cp.locator('.chat-message').count()) === 4);

  // failure: sidecar down → safe line, draft kept, history intact
  stubUp = false;
  await cp.locator('#chat-input').fill('会失败的');
  await cp.locator('#chat-send').click();
  await cp.waitForSelector('#chat-notice:not([hidden])');
  check('chat: failure shows the safe unavailable line',
    (await cp.locator('#chat-notice').textContent()).includes('暂时不可用'));
  check('chat: draft kept for retry', (await cp.locator('#chat-input').inputValue()) === '会失败的');
  check('chat: history intact after failure', (await cp.locator('.chat-message').count()) === 4);
  stubUp = true;
  await cp.screenshot({ path: 'shots-shell/chat-face.png' });

  // Chat/Read independence: open a book, scroll, switch to Chat and back —
  // the reading pane is never rebuilt (spec §4.2 #2, user story 20).
  await cp.locator('#nav-read').click();
  check('chat: Read face back', await cp.locator('#reading-area').isVisible());
  await cp.locator('#shelf-upload-input').setInputFiles('server/tests/fixtures/nav.epub');
  await cp.waitForFunction(() =>
    /已加入书架|已有这本书/.test(document.getElementById('shelf-notice').textContent));
  await cp.locator('#shelf-list .shelf-item').first().click();
  await cp.waitForSelector('#chapter-body .sent');
  // The fixture chapter is short (no overflow), so instead of a scroll
  // offset, mark the pane itself: a rebuild would drop the marker.
  await cp.evaluate(() => {
    document.getElementById('chapter-body').dataset.smokeMark = 'alive';
  });
  await cp.locator('#nav-chat').click();
  await cp.waitForSelector('#chat-face:not([hidden])');
  await cp.locator('#nav-read').click();
  const paneSurvived = await cp.evaluate(
    () => document.getElementById('chapter-body').dataset.smokeMark === 'alive',
  );
  check('chat: face round-trip never rebuilds the reading pane (§4.2 #2)', paneSurvived);
  check('chat: book view intact after the round-trip', (await cp.locator('#chapter-body .sent').count()) > 0);

  // Person switching swaps which Conversations show
  await cp.locator('#nav-chat').click();
  await cp.locator('#identity-chip').click();
  await cp.locator('#profile-choices button').nth(1).click();
  await cp.waitForSelector('body[data-ready]');
  await cp.locator('#nav-chat').click();
  await cp.waitForSelector('#chat-face:not([hidden])');
  await cp.waitForTimeout(300);
  check('chat: another Person sees their own (empty) list',
    (await cp.locator('#conversation-list .conversation-item').count()) === 0);
  await chatCtx.close();
} finally {
  chatBackend.kill();
  stub.close();
}

await browser.close();
// Optional services degrade by design (ADR 0012): without dicts or an AI
// sidecar, /lookup and /ai answer 503 and the reader keeps working. And the
// smoke deliberately uploads an invalid EPUB — 4xx from POST /books is the
// product's validation feedback (#46), not a failure. Their resource-load
// console errors are expected.
const DEGRADED_OK = /\/(lookup|ai)(\?|$)/;
const REJECTED_UPLOAD = /\/books\?/;
// The chat section deliberately kills the stub sidecar — the resulting 502
// on the message send is the product's degrade path (#47), not a failure.
const DEGRADED_CHAT = /\/conversations\/[^/]+\/messages/;
const unexpected = errors
  .filter((e) => !/favicon|sw\.js|service worker|manifest/i.test(e))
  .filter((e) => !(e.includes('503') && DEGRADED_OK.test(e)))
  .filter((e) => !(/ 4\d\d /.test(e) && REJECTED_UPLOAD.test(e)))
  .filter((e) => !(/ 502 /.test(e) && DEGRADED_CHAT.test(e)));
check(`no console errors (${unexpected.length})`, unexpected.length === 0);
if (unexpected.length) console.log(unexpected.join('\n'));
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
