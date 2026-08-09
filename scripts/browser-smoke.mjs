/**
 * Browser smoke test (dev machine only — needs the backend running and
 * Playwright's chromium installed). Exercises the real single-page UI flow
 * (ADR 0002): mobile Paste view ⇄ Reader view, desktop reading-on-top with
 * the collapsible editor, history favorites, and offline replay.
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
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

try {
  // ==== Mobile flow: Paste view ⇄ Reader view ==============================
  // 1. Paste view renders; read/update disabled while empty.
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#text-input');
  console.log('read disabled on empty:', await page.isDisabled('#read-button'));
  await page.fill('#text-input', PASSAGE);
  console.log('read enabled after typing:', !(await page.isDisabled('#read-button')));

  // 2. Read → Reader view in-page (no navigation), cards rendered, first selected.
  await page.click('#read-button');
  await page.waitForFunction(() => document.body.classList.contains('view-read'));
  await page.waitForSelector('.sentence-list li');
  const cardCount = await page.locator('.sentence-list li').count();
  const firstSelected = await page.locator('.sentence-list li').first().evaluate((el) => el.classList.contains('selected'));
  console.log(`cards: ${cardCount}, first selected: ${firstSelected}`);
  console.log('card texts:', JSON.stringify(await page.locator('.sentence-list li').allTextContents()));

  // 3. Tap a card → audio loads and plays (playing class appears).
  await page.locator('.sentence-list li').nth(1).click();
  await page.waitForFunction(() => document.querySelector('.sentence-list li.playing') !== null, { timeout: 15000 });
  console.log('playing card highlighted after tap');

  // 3b. Play button icon toggles via the hidden ATTRIBUTE — the SVG `.hidden`
  // property is a non-reflecting expando (SVGElement has no hidden IDL), and
  // CSS `[hidden] { display: none }` matches the attribute. Assert the
  // attribute, not the property, or the triangle never visually leaves.
  const iconAttrs = await page.evaluate(() => ({
    play: document.getElementById('play-icon').getAttribute('hidden'),
    pause: document.getElementById('pause-icon').getAttribute('hidden'),
  }));
  const iconToggled = iconAttrs.play !== null && iconAttrs.pause === null;
  console.log('play icon shows pause while playing:', iconToggled);
  if (!iconToggled) throw new Error(`icon did not toggle: ${JSON.stringify(iconAttrs)}`);

  // 3c. When playback ends, the icon returns to play (triangle) — the same
  // attribute-reflection contract as 3b, on the way back.
  await page.waitForFunction(() => document.querySelector('.sentence-list li.playing') === null, { timeout: 30000 });
  const endedAttrs = await page.evaluate(() => ({
    play: document.getElementById('play-icon').getAttribute('hidden'),
    pause: document.getElementById('pause-icon').getAttribute('hidden'),
  }));
  const iconRestored = endedAttrs.play === null && endedAttrs.pause !== null;
  console.log('play icon back to play after ended:', iconRestored);
  if (!iconRestored) throw new Error(`icon did not restore: ${JSON.stringify(endedAttrs)}`);

  // 4. Loop toggle cycles to Loop-all; the active mode's icon is shown via
  // the same hidden-ATTRIBUTE contract (loop icons are SVGs too).
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

  // 5. Back to Paste view; open the History tab; entry present; favorite; filter.
  await page.click('#back-button');
  await page.waitForFunction(() => !document.body.classList.contains('view-read'));
  await page.click('#tab-history');
  await page.waitForSelector('.history-list li');
  console.log('history entry:', JSON.stringify((await page.locator('.history-entry').first().textContent())?.slice(0, 40)));
  await page.click('.star-btn');
  await page.waitForFunction(() => document.querySelectorAll('.star-btn.on').length === 1);
  console.log('starred: true');
  await page.click('#filter-fav');
  await page.waitForFunction(() => document.querySelectorAll('.history-list li').length === 1);
  console.log('favorites filter shows 1 entry');
  await page.click('#filter-all');

  // 6. Open history entry → Reader view again (lastSelectedIndex restored).
  await page.locator('.history-entry').first().click();
  await page.waitForFunction(() => document.body.classList.contains('view-read'));
  await page.waitForSelector('.sentence-list li');
  console.log('history reopen OK');

  // 7. Delete the entry from history (still favorited — delete works on favorites).
  await page.click('#back-button');
  await page.waitForFunction(() => !document.body.classList.contains('view-read'));
  await page.waitForSelector('.history-list li');
  await page.click('.delete-entry');
  await page.waitForFunction(() => document.querySelectorAll('.history-list li').length === 0);
  console.log('history entry deleted');

  // 8. Service worker registers (localhost is a secure context).
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg?.active != null;
  }, { timeout: 10000 });
  console.log('service worker active');

  // 9. Offline replay: play a sentence, go offline, reload, replay from cache.
  await page.fill('#text-input', 'Offline replay sentence.');
  await page.click('#read-button');
  await page.waitForSelector('.sentence-list li');
  // Loop persists (ADR 0009) and step 4 left it on 全部; cycle back to 关
  // (Off → All → One → Off) so the sentence ends naturally.
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
  await page.click('#read-button');
  await page.waitForSelector('.sentence-list li');
  await page.locator('.sentence-list li').first().click();
  await page.waitForFunction(() => document.querySelector('.sentence-list li.playing') !== null, { timeout: 15000 });
  console.log('offline replay OK (audio served from SW cache)');
  await page.context().setOffline(false);

  // ==== Desktop flow: reading on top, collapsible editor at the bottom =====
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload({ waitUntil: 'networkidle' });

  // 10. Desktop shows both areas; empty text invites the editor (expanded).
  await page.waitForFunction(() => document.body.classList.contains('editor-expanded'));
  console.log('desktop: editor expanded on empty text:', await page.locator('#editor-region').isVisible());
  console.log('desktop: reading area visible:', await page.locator('#reading-area').isVisible());

  // 11. Type + 更新 → editor collapses to two lines, sentences render on top.
  await page.fill('#text-input', PASSAGE);
  await page.click('#update-button');
  await page.waitForFunction(() => document.body.classList.contains('editor-collapsed'));
  await page.waitForSelector('.sentence-list li');
  console.log('desktop: update collapsed editor, sentences:', await page.locator('.sentence-list li').count());
  const collapsedEditorH = await page.locator('#editor-region').evaluate((el) => el.getBoundingClientRect().height);
  console.log('desktop: collapsed editor height:', Math.round(collapsedEditorH), '(expect < 130)');

  // 12. Focus the editor → expands to the lower half; Escape collapses.
  await page.focus('#text-input');
  await page.waitForFunction(() => document.body.classList.contains('editor-expanded'));
  const expandedH = await page.locator('#editor-region').evaluate((el) => el.getBoundingClientRect().height);
  console.log('desktop: expanded editor height:', Math.round(expandedH), '(expect ≈ 450)');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.body.classList.contains('editor-collapsed'));

  // 13. 历史 button while collapsed → editor expands onto the history tab.
  await page.click('#history-button');
  await page.waitForFunction(() => document.body.classList.contains('editor-expanded'));
  console.log('desktop: history pane visible after 历史:', await page.locator('#history-pane').isVisible());

  // 14. No console/page errors.
  console.log('console errors:', errors.length);
} finally {
  await browser.close();
}

process.exit(errors.length > 0 ? 1 : 0);
