import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/next/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/next/shell.css', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../web/next/shell.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('../web/js/core/api.js', import.meta.url), 'utf8');

const occurrences = (value) => [...html.matchAll(new RegExp(`id="${value}"`, 'g'))].length;

test('Read and Learn own separate mounted playback bars; Read keeps its book pane', () => {
  const learn = html.slice(html.indexOf('id="learn-face"'), html.indexOf('id="chat-face"'));
  const read = html.slice(html.indexOf('id="reading-area"'), html.indexOf('id="learn-face"'));
  for (const id of ['cards-view', 'learn-bottom-bar', 'editor-region', 'history-pane']) assert.ok(learn.includes(`id="${id}"`), `${id} belongs to Learn`);
  for (const id of ['book-view', 'bottom-bar', 'tab-lookup']) assert.ok(read.includes(`id="${id}"`), `${id} belongs to Read`);
  assert.match(html, /id="read-empty"[^>]*>从书架打开一本书开始阅读/);
  assert.match(html, /id="tab-lookup"[^>]*>查义/);
  assert.doesNotMatch(css, /#reading-area #bottom-bar\s*\{/);
});

test('legacy ids remain unique; Read lookup returns while study/library tools stay hidden', () => {
  for (const id of [
    'profile-chip', 'lang-badge', 'reader-empty', 'empty-library-btn', 'chapter-body',
    'bottom-bar', 'prev-button', 'play-button', 'next-button', 'rate-select',
    'text-input', 'history-pane', 'history-list', 'hl-toggle', 'library-btn',
    'library-overlay', 'tab-lookup', 'lookup-drawer',
  ]) assert.equal(occurrences(id), 1, `${id} exists exactly once`);
  assert.match(css, /#library-overlay,[\s\S]*?#cards-view\s*\{\s*display: none !important/);
  assert.match(css, /#hl-toggle/);
  assert.match(css, /#library-btn/);
  assert.match(css, /#learn-face #learn-bottom-bar/);
  assert.match(css, /body\[data-face="learn"\] #lookup-drawer:not\(\[hidden\]\)/);
  assert.doesNotMatch(html, /id="d3(?:"|-)/i);
  assert.doesNotMatch(shell, /Layer\.D3|d3-trigger/);
});

test('Read selection actions are exact, sentence-anchored, and open a Book AI surface', () => {
  assert.match(html, /id="sel-copy"[^>]*>复制/);
  assert.match(html, /id="sel-highlight"[^>]*>马克笔/);
  assert.match(html, /id="sel-ask-book"[^>]*>AI 问书/);
  assert.match(html, /id="book-ai-panel"/);
  assert.match(shell, /selection\.toString\(\)/);
  assert.match(shell, /sentenceIndex: Number\(sentence\.dataset\.sentence\)/);
  assert.match(shell, /highlightKey\(selection\.bookId, selection\.chapter, selection\.sentenceIndex\)/);
  assert.match(shell, /data-highlight-anchor|highlightAnchor/);
  assert.match(shell, /scope: 'selection'/);
  assert.match(shell, /start: selection\.sentenceIndex/);
  assert.match(shell, /end: selection\.sentenceIndex/);
  assert.match(shell, /selectedText: selection\.text/);
  assert.match(shell, /compileContext/);
  assert.match(api, /compileBookContext/);
});

test('face and controller surface visibility stay independent without rebuilding Read', () => {
  assert.match(shell, /chatFace\.hidden = !chatActive/);
  assert.match(shell, /readingArea\.hidden = !readActive/);
  assert.match(shell, /learnFace\.hidden = !learnActive/);
  assert.match(shell, /readEmpty\.hidden = !bookView\.hidden/);
  assert.doesNotMatch(shell, /readingArea\.replaceChildren|chapterBody\.replaceChildren/);
  const app = readFileSync(new URL('../web/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(!isNextShell\) \{\s*cardsView\.hidden = mode === 'book';\s*bookViewEl\.hidden = mode !== 'book';/);
  assert.match(app, /const pasteController = \(\) => isNextShell \? learnController : controller/);
  assert.match(app, /renderBar\(s, bookControls\)/);
  assert.match(app, /renderBar\(s, learnControls\)/);
  assert.match(app, /new HtmlAudioPlayer\(\)/);
});
