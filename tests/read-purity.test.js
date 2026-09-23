import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/next/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/next/shell.css', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../web/next/shell.js', import.meta.url), 'utf8');

const occurrences = (value) => [...html.matchAll(new RegExp(`id="${value}"`, 'g'))].length;

test('Learn markup owns paste, playback, and passage history while Read owns the book pane', () => {
  const learn = html.slice(html.indexOf('id="learn-face"'), html.indexOf('id="chat-face"'));
  const read = html.slice(html.indexOf('id="reading-area"'), html.indexOf('id="learn-face"'));
  for (const id of ['cards-view', 'bottom-bar', 'editor-region', 'history-pane']) {
    assert.ok(learn.includes(`id="${id}"`), `${id} belongs to Learn`);
    assert.ok(!read.includes(`id="${id}"`), `${id} is absent from Read`);
  }
  assert.ok(read.includes('id="book-view"'));
  assert.match(html, /id="read-empty"[^>]*>从书架打开一本书开始阅读/);
});

test('legacy ids remain unique and Read-only learning/library chrome is hidden', () => {
  for (const id of [
    'profile-chip', 'lang-badge', 'reader-empty', 'empty-library-btn', 'chapter-body',
    'bottom-bar', 'prev-button', 'play-button', 'next-button', 'rate-select',
    'text-input', 'history-pane', 'history-list', 'hl-toggle', 'library-btn',
    'library-overlay', 'tab-lookup', 'lookup-drawer',
  ]) assert.equal(occurrences(id), 1, `${id} exists exactly once`);
  assert.match(css, /#library-overlay,[\s\S]*?#cards-view\s*\{\s*display: none !important/);
  assert.match(css, /body\[data-face="learn"\] #lookup-drawer:not\(\[hidden\]\)/);
  assert.doesNotMatch(html, /id="d3(?:"|-)/i);
  assert.doesNotMatch(shell, /Layer\.D3|d3-trigger/);
});

test('face rendering toggles mounted regions with hidden, never reconstructing Read', () => {
  assert.match(shell, /chatFace\.hidden = !chatActive/);
  assert.match(shell, /readingArea\.hidden = !readActive/);
  assert.match(shell, /learnFace\.hidden = !learnActive/);
  assert.doesNotMatch(shell, /readingArea\.replaceChildren|chapterBody\.replaceChildren/);
});
