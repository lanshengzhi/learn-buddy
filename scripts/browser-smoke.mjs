/**
 * Browser smoke test (dev machine only — needs the backend running and
 * Playwright's chromium installed). Exercises the real UI flow:
 * paste → read → cards → tap-to-play → loop/rate controls → back → history.
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
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

try {
  // 1. Paste screen renders.
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#text-input');

  // 2. Read button is disabled while empty, enables with text.
  const readDisabled = await page.isDisabled('#read-button');
  console.log('read disabled on empty:', readDisabled);
  await page.fill('#text-input', PASSAGE);
  console.log('read enabled after typing:', !(await page.isDisabled('#read-button')));

  // 3. Submit → Reader screen, cards rendered, first selected.
  await page.click('#read-button');
  await page.waitForURL('**/reader.html');
  await page.waitForSelector('.sentence-list li');
  const cardCount = await page.locator('.sentence-list li').count();
  const firstSelected = await page.locator('.sentence-list li').first().evaluate((el) => el.classList.contains('selected'));
  console.log(`cards: ${cardCount}, first selected: ${firstSelected}`);
  const cardTexts = await page.locator('.sentence-list li').allTextContents();
  console.log('card texts:', JSON.stringify(cardTexts));

  // 4. Tap a card → audio loads and plays (playing class appears).
  await page.locator('.sentence-list li').nth(1).click();
  await page.waitForFunction(() => {
    const card = document.querySelector('.sentence-list li.playing');
    return card !== null;
  }, { timeout: 15000 });
  console.log('playing card highlighted after tap');

  // 5. Loop toggle cycles to Loop-all (tinted icon).
  await page.click('#loop-button');
  const loopLabel = await page.getAttribute('#loop-button', 'aria-label');
  console.log('loop after one toggle:', loopLabel);

  // 6. Rate select switches to 2×.
  await page.selectOption('#rate-select', 'Double');
  console.log('rate label now:', await page.getAttribute('#rate-select', 'aria-label') ?? '(select)');

  // 7. Back to paste; history shows the entry.
  await page.click('#back-button');
  await page.waitForURL('**/index.html');
  await page.waitForSelector('.history-list li');
  const historyText = await page.locator('.history-entry').first().textContent();
  console.log('history entry:', JSON.stringify(historyText?.slice(0, 40)));

  // 8. Open history entry → reader again, restoring lastSelectedIndex.
  await page.locator('.history-entry').first().click();
  await page.waitForURL('**/reader.html');
  await page.waitForSelector('.sentence-list li');
  console.log('history reopen OK');

  // 9. Delete the entry from history.
  await page.click('#back-button');
  await page.waitForURL('**/index.html');
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
  // Loop mode persists (ADR 0009) and was left in Loop-all by step 5 —
  // cycle it back to Off once on the reader so the sentence ends naturally.
  await page.fill('#text-input', 'Offline replay sentence.');
  await page.click('#read-button');
  await page.waitForSelector('.sentence-list li');
  for (let i = 0; i < 3; i++) {
    const label = await page.getAttribute('#loop-button', 'aria-label');
    if (label === 'Loop all off') break;
    await page.click('#loop-button');
  }
  await page.locator('.sentence-list li').first().click();
  await page.waitForFunction(() => !!document.querySelector('.sentence-list li.playing'), { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.sentence-list li.playing'), { timeout: 15000 });
  console.log('sentence played online (SW audio cache filled)');

  await page.context().setOffline(true);
  await page.click('#back-button');
  await page.waitForURL('**/index.html');
  await page.locator('.history-entry').first().click();
  await page.waitForSelector('.sentence-list li');
  await page.locator('.sentence-list li').first().click();
  await page.waitForFunction(() => !!document.querySelector('.sentence-list li.playing'), { timeout: 10000 });
  console.log('OFFLINE REPLAY OK — cached audio played without network');
  await page.context().setOffline(false);

  if (errors.length > 0) {
    console.log('\nCONSOLE/PAGE ERRORS:');
    for (const e of errors) console.log('  -', e);
    process.exitCode = 1;
  } else {
    console.log('\nSMOKE TEST PASSED — no console errors');
  }
} finally {
  await browser.close();
}
