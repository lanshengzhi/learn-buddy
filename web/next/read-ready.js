/**
 * Reader boot seam (tickets #46/#47) — the one place the /next adapters
 * wait for the reader. app.js dispatches `learnbuddy:read-ready` once its
 * boot has constructed BookView (which only happens after a Person is
 * chosen, so `lb.profile` is set). The event normally fires after these
 * modules evaluated; the `window.learnbuddyRead` check covers a fast boot
 * on a cached page.
 */

/**
 * Calls `start` once the reader exists — immediately if it already does.
 * @param {() => void} start
 */
export function onReadReady(start) {
  if (window.learnbuddyRead) start();
  else document.addEventListener('learnbuddy:read-ready', start, { once: true });
}
