/**
 * Slice-1 shell smoke (dev machine — like browser-smoke.mjs). Needs the backend on
 * :8123 with the repo data dir. Verifies #44's acceptance on real chromium:
 * wide 3-column + nav collapse + D3 toggle, narrow drawer + fullscreen D3 +
 * bottom word card + selection toolbar, and §4.2 #2/#3: scroll position
 * survives D3 open/close.
 */
import { createRequire } from 'module';
import { mkdirSync, writeFileSync } from 'fs';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/lansy/.local/share/mise/installs/npm-playwright/1.62.1/lib/node_modules/playwright');

const BASE = 'http://127.0.0.1:8123';
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
    if (msg.type() === 'error') errors.push(`${tag}: ${msg.text()} [${msg.location()?.url ?? ''}]`);
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
check('wide: Chat entry present but clearly disabled',
  (await wp.locator('#nav-chat').isDisabled()) && (await wp.locator('#nav-chat .nav-note').textContent()).includes('未启用'));
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

// open a book straight from the shelf
await wp.locator('#shelf-list .shelf-item').first().click();
await wp.waitForSelector('#book-view:not([hidden])');
check('wide: shelf opens the book in the workspace',
  (await wp.locator('#chapter-body .sent').count()) > 0);
// the open resolves after restore-scroll's rAF — wait for the mark itself
await wp.waitForSelector('#shelf-list .shelf-item.active');
check('wide: shelf marks the open book active', true);
const scrollBefore = await wp.locator('#book-scroll').evaluate((el) => (el.scrollTop = 500));
await wp.locator('#d3-trigger').click();
check('wide: D3 opens as a column', await wp.locator('#d3').isVisible());
await wp.screenshot({ path: 'shots-shell/wide-d3.png' });
await wp.locator('#d3-back').click();
check('wide: D3 closes', !(await wp.locator('#d3').isVisible()));

// 阅读记录 entry → existing History panel
await wp.locator('#nav-history').click();
check('wide: 阅读记录 opens History pane', await wp.locator('#history-pane').isVisible());
await wp.keyboard.press('Escape');

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
await np.waitForSelector('#book-view:not([hidden])');
check('narrow: shelf opens the book in the workspace',
  (await np.locator('#chapter-body .sent').count()) > 0);

await openFirstBook(np);
await np.locator('#book-scroll').evaluate((el) => (el.scrollTop = 300));
await np.waitForTimeout(100);
const nBefore = await np.locator('#book-scroll').evaluate((el) => el.scrollTop);
await np.locator('#d3-trigger-narrow').click();
const d3Box = await np.locator('#d3').boundingBox();
check('narrow: D3 is a fullscreen overlay', Math.abs(d3Box.width - 390) < 2 && Math.abs(d3Box.height - 844) < 2);
const nDuring = await np.locator('#book-scroll').evaluate((el) => el.scrollTop);
await np.screenshot({ path: 'shots-shell/narrow-d3.png' });
await np.keyboard.press('Escape');
check('narrow: Escape closes D3', !(await np.locator('#d3').isVisible()));
const nAfter = await np.locator('#book-scroll').evaluate((el) => el.scrollTop);
check(`narrow: scroll survives D3 toggle (§4.2 #2/#3, ${nBefore}→${nDuring}→${nAfter})`,
  nBefore === nDuring && nDuring === nAfter);

// word card: touch long-press (HOLD_MS=420) on a word span opens the card
await np.evaluate(() => {
  const word = document.querySelectorAll('#chapter-body .sent')[3].querySelector('.w');
  const rect = word.getBoundingClientRect();
  word.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, clientX: rect.x + 2, clientY: rect.y + 2, pointerType: 'touch',
  }));
});
await np.waitForSelector('#lookup-drawer:not([hidden])');
const cardBox = await np.locator('#lookup-drawer').boundingBox();
check(`narrow: word card ≤ 62% viewport (${Math.round(cardBox.height)}px)`, cardBox.height <= 0.62 * 844 + 4);
const sentTop = await np.locator('#chapter-body .sent').nth(3).evaluate((el) => el.getBoundingClientRect().top);
check(`narrow: looked-up sentence in the visible strip (§4.2 #4, top=${Math.round(sentTop)})`,
  sentTop > -10 && sentTop < 0.45 * 844);
await np.screenshot({ path: 'shots-shell/narrow-wordcard.png' });
await np.keyboard.press('Escape');

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

// wide: a long selection shows the shell toolbar, not the book's lookup card
const wideSel = await wp.evaluate(() => {
  const spans = [...document.querySelectorAll('#chapter-body .sent')[5].querySelectorAll('.w')];
  const range = document.createRange();
  range.setStartBefore(spans[0]);
  range.setEndAfter(spans[Math.min(6, spans.length - 1)]);
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
check('wide: book lookup drawer did not hijack the selection',
  !(await wp.locator('#lookup-drawer').isVisible()));
await wp.keyboard.press('Escape');

// ---------- ticket #46: resume + per-Person positions ----------
// Selecting a sentence writes the Reading position back (debounced 1.2 s);
// TTS may fail in a dev env, but the selection — and so the position — is
// recorded before the audio request.
await wp.locator('#chapter-body .sent').nth(2).click();
await wp.waitForTimeout(1600);
await wp.reload({ waitUntil: 'networkidle' });
await wp.waitForSelector('body[data-ready]');
check('wide: reload resumes the last book', await wp.locator('#book-view').isVisible());
const resumed = await wp.locator('#chapter-body .sent.selected').getAttribute('data-sentence');
check(`wide: resume lands on the saved sentence (${resumed})`, resumed === '2');

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

await browser.close();
// Optional services degrade by design (ADR 0012): without dicts or an AI
// sidecar, /lookup and /ai answer 503 and the reader keeps working. And the
// smoke deliberately uploads an invalid EPUB — 4xx from POST /books is the
// product's validation feedback (#46), not a failure. Their resource-load
// console errors are expected.
const DEGRADED_OK = /\/(lookup|ai)(\?|$)/;
const REJECTED_UPLOAD = /\/books\?/;
const unexpected = errors
  .filter((e) => !/favicon|sw\.js|service worker|manifest/i.test(e))
  .filter((e) => !(e.includes('503') && DEGRADED_OK.test(e)))
  .filter((e) => !(/ 4\d\d /.test(e) && REJECTED_UPLOAD.test(e)));
check(`no console errors (${unexpected.length})`, unexpected.length === 0);
if (unexpected.length) console.log(unexpected.join('\n'));
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
