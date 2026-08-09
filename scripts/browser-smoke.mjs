/**
 * Browser smoke test (dev machine only — needs the backend running and
 * Playwright's chromium installed). Exercises the real single-page UI flow
 * (ADR 0003): the reading-on-top / editor-at-the-bottom layout at every
 * width, the touch focus takeover with the one-line collapsed band, the
 * collapsible editor with a mouse, history favorites, and offline replay.
 *
 * Usage:  python3 server/tts_server.py --port 8123 &
 *         node scripts/browser-smoke.mjs
 */

import { createRequire } from 'module';

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

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/home/lansy/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome',
});
const errors = [];
function watch(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
}

// ==== Mobile (touch) flow: single page, focus takeover, one-line band ======
// Touch emulation makes `(pointer: coarse)` match, so the takeover path runs.
const mobileCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await mobileCtx.newPage();
watch(page);

try {
  // 1. One page at phone size: reading area on top, editor expanded on empty text.
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
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
  //    attribute), and returns to play when playback ends.
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

  // 5. Loop toggle cycles to Loop-all; rate set to 2×.
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

  // 10. Service worker registers (localhost is a secure context).
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg?.active != null;
  }, { timeout: 10000 });
  console.log('service worker active');

  // 11. Offline replay: play a sentence, go offline, reload, replay from cache.
  await page.fill('#text-input', 'Offline replay sentence.');
  await page.click('#update-button');
  await page.waitForSelector('.sentence-list li');
  // Loop persists and step 5 left it on 全部; cycle back to 关 (Off → All →
  // One → Off) so the sentence ends naturally.
  for (let i = 0; i < 3; i++) {
    const label = await page.getAttribute('#loop-button', 'aria-label');
    if (label === '循环：关') break;
    await page.click('#loop-button');
  }
  await page.locator('.sentence-list li').first().click();
  await page.waitForFunction(() => document.querySelector('.sentence-list li.playing') !== null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('.sentence-list li.playing') === null, { timeout: 30000 });
  console.log('online replay finished');

  await page.context().setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.fill('#text-input', 'Offline replay sentence.');
  await page.click('#update-button');
  await page.waitForSelector('.sentence-list li');
  await page.locator('.sentence-list li').first().click();
  await page.waitForFunction(() => document.querySelector('.sentence-list li.playing') !== null, { timeout: 15000 });
  console.log('offline replay OK (audio served from SW cache)');
  await page.context().setOffline(false);
} finally {
  await mobileCtx.close();
}

// ==== Desktop flow: same single page, collapsible editor (fine pointer) ====
const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const dpage = await desktopCtx.newPage();
watch(dpage);

try {
  await dpage.goto(BASE + '/', { waitUntil: 'networkidle' });

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

console.log('console errors:', errors.length);
await browser.close();

process.exit(errors.length > 0 ? 1 : 0);
