import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Shelf, readingLabel, readingFraction } from '../web/js/core/shelf.js';

const BOOKS = [
  {
    id: 'a'.repeat(64),
    title: 'Nav Book',
    author: 'Author',
    lang: 'en',
    chapters: 10,
    reading: { chapter: 2, sentence: 5 },
  },
  { id: 'b'.repeat(64), title: 'Fresh Book', author: '', lang: 'ja', chapters: 4, reading: null },
];

function fakeApi({ books = BOOKS, uploadResult = { book: BOOKS[0], duplicate: false }, failUpload = null } = {}) {
  const calls = { listBooks: 0, uploadBook: [] };
  return {
    calls,
    async listBooks() {
      calls.listBooks += 1;
      return books;
    },
    async uploadBook(file, { onProgress } = {}) {
      calls.uploadBook.push(file);
      onProgress?.(0.4);
      onProgress?.(1);
      if (failUpload) throw failUpload;
      return uploadResult;
    },
  };
}

const recorder = () => {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
};

test('shelf starts idle with an empty list', () => {
  const shelf = new Shelf({ api: fakeApi(), openBook: async () => {} });
  assert.equal(shelf.state.status, 'idle');
  assert.deepEqual(shelf.state.books, []);
  assert.equal(shelf.state.activeBookId, null);
  assert.equal(shelf.state.upload, null);
});

test('refresh loads the current Person’s books with their positions', async () => {
  const { events, onEvent } = recorder();
  const api = fakeApi();
  const shelf = new Shelf({ api, openBook: async () => {}, onEvent });
  await shelf.refresh();
  assert.equal(shelf.state.status, 'ready');
  assert.deepEqual(shelf.state.books, BOOKS);
  assert.equal(api.calls.listBooks, 1);
  assert.ok(events.every((e) => e.type === 'shelf-changed'));
});

test('a failed refresh keeps the last good list and reports the error', async () => {
  const api = fakeApi();
  const shelf = new Shelf({ api, openBook: async () => {} });
  await shelf.refresh();
  api.listBooks = async () => {
    throw new Error('网络错误。');
  };
  await shelf.refresh();
  assert.equal(shelf.state.status, 'error');
  assert.equal(shelf.state.error, '网络错误。');
  assert.deepEqual(shelf.state.books, BOOKS); // never silently dropped
});

test('open hands the book id to the reader seam and marks it active', async () => {
  const opened = [];
  const shelf = new Shelf({ api: fakeApi(), openBook: async (id) => opened.push(id) });
  await shelf.open(BOOKS[0].id);
  assert.deepEqual(opened, [BOOKS[0].id]);
  assert.equal(shelf.state.activeBookId, BOOKS[0].id);
});

test('markActive syncs books opened elsewhere; same id is a no-op', () => {
  const { events, onEvent } = recorder();
  const shelf = new Shelf({ api: fakeApi(), openBook: async () => {}, onEvent });
  shelf.markActive(BOOKS[1].id);
  assert.equal(shelf.state.activeBookId, BOOKS[1].id);
  shelf.markActive(BOOKS[1].id);
  assert.equal(events.length, 1);
});

test('a new upload reports progress, notices, and refreshes the shelf', async () => {
  const api = fakeApi();
  const shelf = new Shelf({ api, openBook: async () => {} });
  const file = { name: 'nav.epub' };
  await shelf.upload(file);
  assert.deepEqual(api.calls.uploadBook, [file]);
  assert.equal(shelf.state.upload, null);
  assert.equal(shelf.state.notice, '已加入书架。');
  assert.equal(api.calls.listBooks, 1); // refreshed after the upload
  assert.equal(shelf.state.status, 'ready');
});

test('a duplicate upload says so instead of pretending to add', async () => {
  const api = fakeApi({ uploadResult: { book: BOOKS[0], duplicate: true } });
  const shelf = new Shelf({ api, openBook: async () => {} });
  await shelf.upload({ name: 'nav.epub' });
  assert.equal(shelf.state.notice, '书库里已有这本书。');
});

test('a failed upload surfaces the server’s message and keeps the shelf intact', async () => {
  const failUpload = Object.assign(new Error('这不是一个 epub 文件。'), { code: 'not_epub' });
  const api = fakeApi({ failUpload });
  const shelf = new Shelf({ api, openBook: async () => {} });
  await shelf.refresh();
  await shelf.upload({ name: 'junk.epub' });
  assert.equal(shelf.state.upload, null);
  assert.equal(shelf.state.notice, '这不是一个 epub 文件。');
  assert.deepEqual(shelf.state.books, BOOKS); // the stored shelf is untouched
});

test('reading labels and progress come from the per-Person position', () => {
  assert.equal(readingLabel(BOOKS[0]), '读到第 3 章');
  assert.equal(readingLabel(BOOKS[1]), '未开始');
  assert.equal(readingFraction(BOOKS[0]), 0.3);
  assert.equal(readingFraction(BOOKS[1]), 0);
  assert.equal(readingFraction({ chapters: 0, reading: { chapter: 0, sentence: 0 } }), 0);
});
