/**
 * Shelf DOM adapter (ticket #46) — renders the Shelf model into the nav's
 * bookshelf section (#nav-shelf) and wires upload/open. The reading
 * workspace stays owned by /js/app.js: opening a Book goes through the
 * `window.learnbuddyRead` seam, so this module never rebuilds or even
 * touches the reading pane (spec §4.2 #2).
 *
 * The section lives inside #shell-nav, so it is the contextual list column
 * on wide and rides along into the narrow drawer unchanged — no second
 * layout to maintain (spec §4.2: the drawer holds the same sidebar).
 */

import { ServerApi } from '/js/core/api.js';
import { Shelf, readingLabel, readingFraction } from '/js/core/shelf.js';
import { Layer } from '/js/core/shell-controller.js';
import { storedProfile } from '/js/browser/profile.js';
import { onReadReady } from './read-ready.js';

const $ = (id) => document.getElementById(id);

/**
 * @param {object} deps
 * @param {import('/js/core/shell-controller.js').ShellController} deps.shell — to close the drawer after a pick on narrow
 */
export function initShelf({ shell }) {
  const listEl = $('shelf-list');
  const emptyEl = $('shelf-empty');
  const noticeEl = $('shelf-notice');
  const uploadButton = $('shelf-upload');
  const uploadInput = $('shelf-upload-input');
  const uploadProgress = $('shelf-upload-progress');

  let shelf = null;

  const start = () => {
    if (shelf || !window.learnbuddyRead) return;
    const api = new ServerApi({ profile: storedProfile() });
    shelf = new Shelf({
      api,
      openBook: (bookId) => window.learnbuddyRead.openBook(bookId),
      onEvent: render,
    });
    shelf.markActive(window.learnbuddyRead.currentBookId());
    void shelf.refresh();
  };
  onReadReady(start);

  function render() {
    if (!shelf) return;
    const s = shelf.state;

    uploadProgress.hidden = !s.upload;
    if (s.upload) {
      uploadProgress.firstElementChild.style.width = `${Math.round(s.upload.fraction * 100)}%`;
    }

    const message = s.status === 'error' ? s.error : s.notice;
    noticeEl.hidden = !message;
    if (message) noticeEl.textContent = message;

    emptyEl.hidden = !(s.status === 'ready' && s.books.length === 0);
    listEl.replaceChildren(...s.books.map((book) => shelfItem(book, s.activeBookId)));
  }

  function shelfItem(book, activeBookId) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    // .panel-item carries the shared style (shell.css); .shelf-item stays
    // as the per-concept hook (shell smoke selects it).
    button.className = 'panel-item shelf-item';
    const active = book.id === activeBookId;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'true');

    const title = document.createElement('b');
    title.textContent = book.title || book.fileName || '未命名';

    const meta = document.createElement('span');
    meta.className = 'panel-meta';
    meta.textContent = [book.author, `${book.chapters} 章`].filter(Boolean).join(' · ');

    const track = document.createElement('span');
    track.className = 'shelf-track';
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(readingFraction(book) * 100)}%`;
    track.append(fill);

    const progress = document.createElement('span');
    progress.className = 'panel-meta shelf-reading';
    progress.textContent = readingLabel(book);

    button.append(title, meta, track, progress);
    button.addEventListener('click', () => {
      // Picking a book dismisses the narrow drawer; on wide this is a no-op.
      shell.close(Layer.Drawer);
      void shelf.open(book.id);
    });
    li.append(button);
    return li;
  }

  // --- upload (same contract as the library overlay: raw EPUB via XHR) ----

  uploadButton.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', () => {
    const file = uploadInput.files?.[0];
    uploadInput.value = '';
    if (file && shelf) void shelf.upload(file);
  });

  // --- freshness ------------------------------------------------------------

  // Books can also be opened/uploaded through the reader's own library
  // overlay — re-sync when it closes so the shelf never lies.
  new MutationObserver(() => {
    if ($('library-overlay').hidden && shelf) {
      shelf.markActive(window.learnbuddyRead.currentBookId());
      void shelf.refresh();
    }
  }).observe($('library-overlay'), { attributes: true, attributeFilter: ['hidden'] });

  // On narrow the shelf rides in the drawer; refresh each time it opens so
  // the Reading positions reflect the session so far.
  let drawerWasOpen = false;
  new MutationObserver(() => {
    const open = document.body.classList.contains('drawer-open');
    if (open && !drawerWasOpen && shelf) void shelf.refresh();
    drawerWasOpen = open;
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
