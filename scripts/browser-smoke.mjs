/**
 * Browser smoke test (dev machine only — needs the backend running and
 * Playwright's chromium installed). Exercises the real single-page UI flow
 * (ADR 0003): the profile gate, the reading-on-top / editor-at-the-bottom
 * layout at every width, the touch focus takeover with the one-line
 * collapsed band, the collapsible editor with a mouse, history favorites,
 * and — for the book surface (ticket #19) — upload → read → lookup → resume
 * where you left off.
 *
 * Usage:  LEARNBUDDY_DATA=$(mktemp -d) python3 server/tts_server.py --port 8123 --data-dir $LEARNBUDDY_DATA &
 *         node scripts/browser-smoke.mjs
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  // Dev-machine fallback: playwright installed via mise as a global tool.
  const require = createRequire(import.meta.url);
  const pw = require(process.env.PLAYWRIGHT_MODULE ?? '/home/lansy/.local/share/mise/installs/npm-playwright/1.62.1/lib/node_modules/playwright');
  chromium = pw.chromium;
}

const BASE = process.env.LEARNBUDDY_BASE ?? 'http://127.0.0.1:8123';
const PASSAGE = 'Hello world. This is a test sentence. How are you today?';
const FIXTURE = process.env.LEARNBUDDY_EPUB ?? 'server/tests/fixtures/nav.epub';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/google-chrome-stable',
});
const errors = [];
function watch(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
}

/** Boots a page through the profile gate (or skips it when already chosen). */
async function open(context, url = BASE + '/') {
  const page = await context_page(context);
  async function context_page(context) {
    const page = await context.newPage();
    watch(page);
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('#text-input');
    return page;
  }
  return page;
}

async function passGate(page, name = '爸爸') {
  const gateVisible = await page.locator('#profile-gate').isVisible().catch(() => false);
  if (!gateVisible) return;
  await page.locator('.gate-choice', { hasText: name }).first().click();
  await page.waitForFunction(() => document.getElementById('profile-gate').hidden);
  await page.waitForFunction(() => document.body.dataset.ready === '1');
}


/** Cycles the loop toggle until 关 (the server default is loop-all). */
async function loopToOff(page) {
  for (let i = 0; i < 3; i++) {
    const label = await page.getAttribute('#loop-button', 'aria-label');
    if (label === '循环：关') return;
    await page.click('#loop-button');
  }
  throw new Error('loop toggle did not reach 关 within three clicks');
}

// ==== Mobile (touch) flow: profile gate, single page, focus takeover ========
// Touch emulation makes `(pointer: coarse)` match, so the takeover path runs.
const mobileCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await mobileCtx.newPage();
watch(page);

try {
  // 0. First run on a fresh device: the profile gate asks 谁在读？
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#profile-gate:not([hidden])');
  console.log('profile gate shown on first run');
  await page.click('.gate-choice');
  await page.waitForFunction(() => document.getElementById('profile-gate').hidden);
  await page.waitForFunction(() => document.body.dataset.ready === '1');
  console.log('gate resolved, app booted');

  // 1. One page at phone size: reading area on top, editor expanded on empty text.
  await page.waitForSelector('#text-input');
  console.log('update disabled on empty:', await page.isDisabled('#update-button'));
  console.log('reading area visible at 390px:', await page.locator('#reading-area').isVisible());

  // 2. Focusing the textarea takes over: the editor grows into the space above
  //    the (emulated) keyboard and the reading area slides out of view.
  await page.fill('#text-input', PASSAGE);
  await page.waitForFunction(() => document.body.classList.contains('editor-takeover'));
  await page.waitForFunction(
    () => document.getElementById('reading-area').getBoundingClientRect().height < 60,
    { timeout: 5000 },
  );
  console.log('touch: focus → takeover, reading area vacated');
  console.log('update enabled after typing:', !(await page.isDisabled('#update-button')));

  // 3. 更新 commits, collapses to the one-line band, reading returns.
  await page.click('#update-button');
  await page.waitForFunction(() => document.body.classList.contains('editor-collapsed'));
  await page.waitForFunction(
    () => document.getElementById('editor-region').getBoundingClientRect().height < 100,
    { timeout: 5000 },
  );
  await page.waitForSelector('.sentence-list li');
  const bandH = await page.locator('#editor-region').evaluate((el) => el.getBoundingClientRect().height);
  console.log(`touch: update collapsed to ${Math.round(bandH)}px band (expect < 100)`);
  if (bandH >= 100) throw new Error(`mobile collapsed band too tall: ${bandH}`);
  const firstSelected = await page
    .locator('.sentence-list li')
    .first()
    .evaluate((el) => el.classList.contains('selected'));
  console.log(`cards: ${await page.locator('.sentence-list li').count()}, first selected: ${firstSelected}`);

  // 4. Tap a sentence → audio plays; the play icon toggles via the hidden
  //    ATTRIBUTE contract (SVGElement has no hidden IDL; CSS matches the
  //    attribute), and returns to play when playback ends. Loop starts at the
  //    server default (loop-all); the sentence must END here, so go to 关 first.
  await loopToOff(page);
  await page.locator('.sentence-list li').nth(1).click();
  await page.waitForFunction(() => document.querySelector('.sentence-list li.playing') !== null, { timeout: 15000 });
  const iconAttrs = await page.evaluate(() => ({
    play: document.getElementById('play-icon').getAttribute('hidden'),
    pause: document.getElementById('pause-icon').getAttribute('hidden'),
  }));
  const iconToggled = iconAttrs.play !== null && iconAttrs.pause === null;
  console.log('play icon shows pause while playing:', iconToggled);
  if (!iconToggled) throw new Error(`icon did not toggle: ${JSON.stringify(iconAttrs)}`);
  await page.waitForFunction(() => document.querySelector('.sentence-list li.playing') === null, { timeout: 30000 });
  const endedAttrs = await page.evaluate(() => ({
    play: document.getElementById('play-icon').getAttribute('hidden'),
    pause: document.getElementById('pause-icon').getAttribute('hidden'),
  }));
  const iconRestored = endedAttrs.play === null && endedAttrs.pause !== null;
  console.log('play icon back to play after ended:', iconRestored);
  if (!iconRestored) throw new Error(`icon did not restore: ${JSON.stringify(endedAttrs)}`);

  // 5. Loop toggle cycles to Loop-all (from 关); rate set to 2×.
  await page.click('#loop-button');
  console.log('loop after one toggle:', await page.getAttribute('#loop-button', 'aria-label'));
  const loopAttrs = await page.evaluate(() => ({
    off: document.getElementById('loop-off-icon').getAttribute('hidden'),
    all: document.getElementById('loop-all-icon').getAttribute('hidden'),
    one: document.getElementById('loop-one-icon').getAttribute('hidden'),
  }));
  const loopShowsAll = loopAttrs.off !== null && loopAttrs.all === null && loopAttrs.one !== null;
  console.log('loop icon shows 全部 while on:', loopShowsAll);
  if (!loopShowsAll) throw new Error(`loop icon did not switch: ${JSON.stringify(loopAttrs)}`);
  await page.selectOption('#rate-select', 'Double');
  console.log('rate set to 2×');

  // 6. 历史 button in the collapsed band → editor expands onto the history tab;
  //    entry present; favorite; filter.
  await page.click('#history-button');
  await page.waitForFunction(() => document.body.classList.contains('editor-expanded'));
  await page.waitForSelector('.history-list li');
  console.log('history entry:', JSON.stringify((await page.locator('.history-entry').first().textContent())?.slice(0, 40)));
  await page.click('.star-btn');
  await page.waitForFunction(() => document.querySelectorAll('.star-btn.on').length === 1);
  console.log('starred: true');
  await page.click('#filter-fav');
  await page.waitForFunction(() => document.querySelectorAll('.history-list li').length === 1);
  console.log('favorites filter shows 1 entry');
  await page.click('#filter-all');

  // 7. Open the entry → loads and collapses the editor (no view switch).
  await page.locator('.history-entry').first().click();
  await page.waitForFunction(() => document.body.classList.contains('editor-collapsed'));
  await page.waitForSelector('.sentence-list li');
  console.log('history reopen collapses editor OK');

  // 8. 收起 button collapses the expanded editor; tapping outside retreats
  //    the takeover.
  await page.click('#history-button');
  await page.waitForFunction(() => document.body.classList.contains('editor-expanded'));
  await page.click('#collapse-button');
  await page.waitForFunction(() => document.body.classList.contains('editor-collapsed'));
  console.log('收起 button collapses OK');
  await page.click('#text-input');
  await page.waitForFunction(() => document.body.classList.contains('editor-takeover'));
  await page.click('.app-header h1');
  await page.waitForFunction(() => document.body.classList.contains('editor-collapsed'));
  console.log('blur (tap outside) retreats takeover OK');

  // 9. Delete the entry from history (still favorited — delete works on favorites).
  await page.click('#history-button');
  await page.waitForSelector('.history-list li');
  await page.click('.delete-entry');
  await page.waitForFunction(() => document.querySelectorAll('.history-list li').length === 0);
  console.log('history entry deleted');

  // 10. Service worker registers on secure contexts (localhost); the plain-HTTP
  //     LAN origin runs without a shell cache by design (bootstrap guard).
  await page.reload({ waitUntil: 'networkidle' });
  const secure = await page.evaluate(() => window.isSecureContext);
  const cacheNames = secure
    ? await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return reg?.active ? await caches.keys() : [];
      })
    : [];
  console.log(`secure context: ${secure}; caches:`, JSON.stringify(cacheNames));
  if (cacheNames.some((name) => name.includes('audio'))) {
    throw new Error(`audio cache should be retired (ADR 0007): ${JSON.stringify(cacheNames)}`);
  }
} finally {
  await mobileCtx.close();
}

// ==== Desktop flow: same single page, collapsible editor (fine pointer) ====
const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const dpage = await desktopCtx.newPage();
watch(dpage);

try {
  await dpage.goto(BASE + '/', { waitUntil: 'networkidle' });
  // The desktop context shares no storage with the mobile one → gate again.
  // Server-side records are per-Profile, so each context gets its own —
  // browser contexts no longer isolate History the way IndexedDB did.
  await passGate(dpage, '妈妈');

  // 12. Same one page at 1440px: editor expanded on empty text, reading visible.
  await dpage.waitForFunction(() => document.body.classList.contains('editor-expanded'));
  console.log('desktop: editor expanded on empty text:', await dpage.locator('#editor-region').isVisible());
  console.log('desktop: reading area visible:', await dpage.locator('#reading-area').isVisible());

  // 13. Type + 更新 → editor collapses to the band, sentences render on top.
  await dpage.fill('#text-input', PASSAGE);
  await dpage.click('#update-button');
  await dpage.waitForFunction(() => document.body.classList.contains('editor-collapsed'));
  await dpage.waitForSelector('.sentence-list li');
  console.log('desktop: update collapsed editor, sentences:', await dpage.locator('.sentence-list li').count());
  const collapsedH = await dpage.locator('#editor-region').evaluate((el) => el.getBoundingClientRect().height);
  console.log('desktop: collapsed editor height:', Math.round(collapsedH), '(expect < 130)');

  // 14. Focus → expands to the lower half; Escape collapses.
  await dpage.focus('#text-input');
  await dpage.waitForFunction(() => document.body.classList.contains('editor-expanded'));
  const expandedH = await dpage.locator('#editor-region').evaluate((el) => el.getBoundingClientRect().height);
  console.log('desktop: expanded editor height:', Math.round(expandedH), '(expect ≈ 450)');
  await dpage.keyboard.press('Escape');
  await dpage.waitForFunction(() => document.body.classList.contains('editor-collapsed'));

  // 15. Tapping a sentence collapses the editor (ADR 0003). (Escape keeps
  //     focus on the textarea, so blur it first to re-trigger the expansion.)
  await dpage.locator('#text-input').blur();
  await dpage.focus('#text-input');
  await dpage.waitForFunction(() => document.body.classList.contains('editor-expanded'));
  await dpage.locator('.sentence-list li').first().click();
  await dpage.waitForFunction(() => document.body.classList.contains('editor-collapsed'));
  console.log('desktop: sentence tap collapses editor OK');

  // 16. 历史 button while collapsed → editor expands onto the history tab.
  await dpage.click('#history-button');
  await dpage.waitForFunction(() => document.body.classList.contains('editor-expanded'));
  console.log('desktop: history pane visible after 历史:', await dpage.locator('#history-pane').isVisible());

  // 17. Narrowing the window changes nothing — no breakpoint (the complaint
  //     that started ADR 0003).
  await dpage.setViewportSize({ width: 500, height: 900 });
  await dpage.waitForTimeout(400);
  const readingVisible = await dpage.locator('#reading-area').isVisible();
  const stillExpanded = await dpage.evaluate(() => document.body.classList.contains('editor-expanded'));
  console.log('narrowed to 500px: reading visible:', readingVisible, 'editor still expanded:', stillExpanded);
  if (!readingVisible) throw new Error('narrowing the window hid the reading area');
} finally {
  await desktopCtx.close();
}

// ==== Visual follow (issue #8): the playing sentence never sits under the
// playback bar. Geometry loop on a touch viewport, then the Q4 trigger paths
// (resize, editor expand/collapse) on a fine-pointer viewport. =============
const longPassage = Array.from(
  { length: 30 },
  (_, i) => `Sentence number ${i + 1} with some words to read.`,
).join(' ');

const followCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const fpage = await followCtx.newPage();
watch(fpage);

// Resolves when the playing card is fully above the playback bar (tolerance
// ±1px for subpixel rounding), or throws on timeout.
async function waitFollowed(page, tag) {
  await page.waitForFunction(
    () => {
      const body = document.getElementById('reader-body');
      const bar = document.getElementById('bottom-bar');
      const playing = document.querySelector('.sentence-list li.playing');
      if (!body || !bar || !playing) return false;
      const bodyRect = body.getBoundingClientRect();
      const cardRect = playing.getBoundingClientRect();
      return cardRect.top >= bodyRect.top - 1 && cardRect.bottom <= bar.getBoundingClientRect().top + 1;
    },
    { timeout: 5000 },
  );
  const rects = await page.evaluate(() => {
    const body = document.getElementById('reader-body').getBoundingClientRect();
    const card = document.querySelector('.sentence-list li.playing').getBoundingClientRect();
    const bar = document.getElementById('bottom-bar').getBoundingClientRect();
    return { cardTop: Math.round(card.top), cardBottom: Math.round(card.bottom), bodyTop: Math.round(body.top), barTop: Math.round(bar.top) };
  });
  console.log(`follow ${tag}: playing card above bar`, JSON.stringify(rects));
}

try {
  await fpage.goto(BASE + '/', { waitUntil: 'networkidle' });
  await passGate(fpage, '大女儿');
  await fpage.fill('#text-input', longPassage);
  await fpage.click('#update-button');
  await fpage.waitForSelector('.sentence-list li');
  const cardCount = await fpage.locator('.sentence-list li').count();
  console.log(`follow: ${cardCount} sentences rendered`);
  if (cardCount < 25) throw new Error(`expected a long passage, got ${cardCount} sentences`);

  // Loop-all at 2× so the loop advances quickly (from the loop-all default,
  // cycle back to 关 first so the single click lands on 全部).
  await loopToOff(fpage);
  await fpage.click('#loop-button');
  if ((await fpage.getAttribute('#loop-button', 'aria-label')) !== '循环：全部') {
    throw new Error('loop did not reach Loop-all after one toggle');
  }
  await fpage.selectOption('#rate-select', 'Double');
  await fpage.locator('.sentence-list li').first().click();
  await fpage.waitForFunction(() => document.querySelector('.sentence-list li.playing') !== null, { timeout: 15000 });
  await waitFollowed(fpage, 'first');

  // Each advance must end with the playing card settled above the bar.
  for (let i = 0; i < 3; i++) {
    const prev = await fpage.evaluate(() =>
      Number(document.querySelector('.sentence-list li.playing')?.dataset.index ?? -1),
    );
    await fpage.waitForFunction(
      (prevIndex) => {
        const el = document.querySelector('.sentence-list li.playing');
        return el && Number(el.dataset.index) !== prevIndex;
      },
      prev,
      { timeout: 30000 },
    );
    await waitFollowed(fpage, `advance ${i + 1}`);
  }
} finally {
  await followCtx.close();
}

// Q4 trigger paths: while PAUSED (no state changes), manually scroll the
// playing card out of view, then resize / expand / collapse the editor — only
// the follow re-run hooks can pull it back.
const followDesktopCtx = await browser.newContext({ viewport: { width: 800, height: 900 } });
const qpage = await followDesktopCtx.newPage();
watch(qpage);

async function scrollPlayingOutOfView(page) {
  await page.evaluate(() => {
    const body = document.getElementById('reader-body');
    body.scrollTop = body.scrollHeight;
  });
  const out = await page.evaluate(() => {
    const body = document.getElementById('reader-body').getBoundingClientRect();
    const card = document.querySelector('.sentence-list li.playing').getBoundingClientRect();
    // Scrolled to the bottom, the first sentence's card sits above the viewport.
    return card.bottom <= body.top + 1 || card.top >= body.bottom - 1;
  });
  if (!out) throw new Error('expected the playing card to be out of view after manual scroll');
}

try {
  await qpage.goto(BASE + '/', { waitUntil: 'networkidle' });
  await passGate(qpage, '小女儿');
  await qpage.fill('#text-input', longPassage);
  await qpage.click('#update-button');
  await qpage.waitForSelector('.sentence-list li');

  // Loop-one at 2× (from the loop-all default: cycle to 关, then two clicks),
  // play the first sentence, then pause mid-playback.
  await loopToOff(qpage);
  await qpage.click('#loop-button');
  await qpage.click('#loop-button');
  if ((await qpage.getAttribute('#loop-button', 'aria-label')) !== '循环：单句') {
    throw new Error('loop did not reach Loop-one after two toggles');
  }
  await qpage.selectOption('#rate-select', 'Double');
  await qpage.locator('.sentence-list li').first().click();
  await qpage.waitForFunction(() => document.querySelector('.sentence-list li.playing') !== null, { timeout: 15000 });
  await qpage.click('#play-button'); // pause — no state changes from here on
  await qpage.waitForFunction(
    () => document.getElementById('pause-icon').getAttribute('hidden') !== null,
    { timeout: 5000 },
  );

  // 18. Resize: the reading viewport shrinks; follow re-runs and pulls the
  //     playing card back into view (no sentence change involved).
  await scrollPlayingOutOfView(qpage);
  await qpage.setViewportSize({ width: 800, height: 700 });
  await waitFollowed(qpage, 'resize');

  // 19. Editor expand (fine pointer: focus expands to the lower half) and
  //     collapse; both re-trigger follow after the flex-grow transition.
  await scrollPlayingOutOfView(qpage);
  await qpage.focus('#text-input');
  await qpage.waitForFunction(() => document.body.classList.contains('editor-expanded'));
  await waitFollowed(qpage, 'editor-expand');

  await scrollPlayingOutOfView(qpage);
  await qpage.keyboard.press('Escape');
  await qpage.waitForFunction(() => document.body.classList.contains('editor-collapsed'));
  await waitFollowed(qpage, 'editor-collapse');
} finally {
  await followDesktopCtx.close();
}

// ==== Book surface (ticket #19): upload → read → lookup → resume ===========
// Uploads the tiny nav-epub fixture (English), opens it, resumes at the
// server-side position after a reload, hover-looks a word up, and marks it
// 我认识 — which must land in the server's /words for the Profile.
const bookCtx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const bpage = await bookCtx.newPage();
watch(bpage);

try {
  await bpage.goto(BASE + '/', { waitUntil: 'networkidle' });
  await passGate(bpage, '大女儿');

  // 20. The profile chip re-opens the gate (a switch would reload — close it).
  await bpage.click('#profile-chip');
  await bpage.waitForSelector('#profile-gate:not([hidden])');
  console.log('profile chip reopens the gate');
  await bpage.evaluate(() => { document.getElementById('profile-gate').hidden = true; });

  // 21. Upload through the library overlay (XHR progress path). The entry
  //     point differs by surface: the bookbar's 书库 when a book is already
  //     open (warm server), the empty state's button on a fresh server.
  const epub = readFileSync(FIXTURE);
  const startView = await bpage.evaluate(() => document.body.dataset.view);
  await bpage.click(startView === 'book' ? '#library-btn' : '#empty-library-btn');
  await bpage.waitForSelector('#library-overlay:not([hidden])');
  await bpage.evaluate((bytes) => {
    const file = new File([new Uint8Array(bytes)], 'nav.epub', { type: 'application/epub+zip' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('upload-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, Array.from(epub));
  await bpage.waitForFunction(() => document.querySelectorAll('.library-list li').length > 0, { timeout: 20000 });
  console.log('library shows the uploaded book');

  // 22. Open the book → the chapter renders as sentences of word spans.
  await bpage.locator('.library-entry').first().click();
  await bpage.waitForFunction(() => document.body.dataset.view === 'book', { timeout: 10000 });
  await bpage.waitForSelector('#chapter-body .sent .w', { timeout: 15000 });
  console.log('book view open, sentences:', await bpage.locator('#chapter-body .sent').count());

  // 23. Tap a sentence → it becomes the selected (playing) sentence; the
  //     debounced write-back persists it server-side. (At 2× the short
  //     chapter can play through and stop before we check — selected is the
  //     stable signal.)
  await bpage.locator('#chapter-body .sent').nth(1).click();
  await bpage.waitForFunction(
    () => document.querySelector('#chapter-body .sent.selected')?.dataset.sentence === '1',
    { timeout: 15000 },
  );
  console.log('sentence tap selects + plays (book mode)');
  await bpage.waitForTimeout(1900); // position debounce (1.2s) + margin

  // 24. Reload → the app returns to the same book and the same sentence.
  await bpage.reload({ waitUntil: 'networkidle' });
  await bpage.waitForFunction(() => document.body.dataset.view === 'book', { timeout: 10000 });
  await bpage.waitForSelector('#chapter-body .sent.selected', { timeout: 15000 });
  const selected = await bpage.evaluate(() => document.querySelector('#chapter-body .sent.selected')?.dataset.sentence);
  console.log('reopened to the server-side reading position, sentence', selected);
  if (selected !== '1') throw new Error(`expected sentence 1 after reopen, got ${selected}`);

  // 25. Hover-lookup: dwell on a word, the card opens in the (wide) aside.
  const word = bpage.locator('#chapter-body .sent .w').first();
  await word.hover();
  await bpage.waitForTimeout(600); // hover dwell (320ms) + request
  const cardVisible = await bpage.locator('.book-aside .card').isVisible().catch(() => false);
  console.log('hover lookup card visible in aside:', cardVisible);
  if (!cardVisible) throw new Error('lookup card did not appear on hover');

  // 26. 我认识 writes /words: click 标记认识 → the Profile's word list flips.
  //     标记认识 toggles, and the server may already hold the key from an
  //     earlier run — the assertion is the FLIP, not the absolute value.
  const mark = bpage.locator('.book-aside .mark-known').first();
  const before = await bpage.evaluate(async () => {
    const profile = localStorage.getItem('lb.profile');
    return (await (await fetch(`/words?profile=${profile}`)).json()).words;
  });
  const key = 'en:chapter';
  await mark.click();
  await bpage.waitForFunction(
    (beforeWords) => new Promise(async (resolve) => {
      const profile = localStorage.getItem('lb.profile');
      const words = (await (await fetch(`/words?profile=${profile}`)).json()).words;
      resolve(words.includes('en:chapter') !== beforeWords.includes('en:chapter'));
    }),
    before,
    { timeout: 15000 },
  );
  const words = await bpage.evaluate(async () => {
    const profile = localStorage.getItem('lb.profile');
    return (await (await fetch(`/words?profile=${profile}`)).json()).words;
  });
  console.log(`words after 标记认识: before=${JSON.stringify(before)} after=${JSON.stringify(words)}`);
  if (before.includes(key) === words.includes(key)) {
    throw new Error('我认识 did not flip /words');
  }

  // 27. Offline: the server is the only truth (ADR 0007). On a secure context
  //     the SW shell still opens and degrades to the paste state; on the
  //     plain-HTTP LAN origin there is no SW — the reload fails by design.
  const bookSecure = await bpage.evaluate(() => window.isSecureContext);
  if (bookSecure) {
    await bpage.context().setOffline(true);
    await bpage.reload({ waitUntil: 'domcontentloaded' });
    await bpage.waitForSelector('#text-input', { timeout: 10000 });
    console.log('shell opens offline, degrades to the paste surface');
    await bpage.context().setOffline(false);
  } else {
    console.log('plain-HTTP LAN origin: no service worker (skip offline shell)');
  }
} finally {
  await bookCtx.close();
}

// Expected network noise from the deliberate offline step (ADR 0007: the
// server is the only truth — offline degrades by design).
const offlineNoise = (error) =>
  /Failed to load resource|net::ERR_INTERNET_DISCONNECTED|Failed to fetch/i.test(error);
const fatalErrors = errors.filter((error) => !offlineNoise(error));
console.log('console errors:', errors.length, '(fatal:', fatalErrors.length, ')');
for (const error of fatalErrors) console.log('  ERROR:', error);
await browser.close();

process.exit(fatalErrors.length > 0 ? 1 : 0);
