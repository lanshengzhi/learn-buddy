import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/next/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/next/shell.css', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../web/next/shell.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('../web/js/core/api.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../web/js/core/book-ai-panel.js', import.meta.url), 'utf8');

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
    'library-overlay', 'tab-lookup', 'lookup-drawer', 'book-ai-panel', 'book-ai-open',
    'book-ai-form', 'book-ai-quick-prompts', 'book-ai-job', 'book-ai-job-list',
    'book-ai-artifact-list', 'book-ai-artifact-status', 'book-artifact-preview',
    'book-artifact-return',
  ]) assert.equal(occurrences(id), 1, `${id} exists exactly once`);
  assert.match(css, /#library-overlay,[\s\S]*?#cards-view\s*\{\s*display: none !important/);
  assert.match(css, /#hl-toggle/);
  assert.match(css, /#library-btn/);
  assert.match(css, /#learn-face #learn-bottom-bar/);
  assert.match(css, /body\[data-face="learn"\] #lookup-drawer:not\(\[hidden\]\)/);
  assert.doesNotMatch(html, /id="d3(?:"|-)/i);
  assert.doesNotMatch(shell, /Layer\.D3|d3-trigger/);
});

test('Book AI has an explicit four-state shell with honest job/artifact gates', () => {
  assert.match(panel, /Closed: 'closed'/);
  assert.match(panel, /Ask: 'ask'/);
  assert.match(panel, /Job: 'job'/);
  assert.match(panel, /ArtifactPreview: 'artifact-preview'/);
  assert.match(panel, /artifact\.status !== 'ready'/);
  assert.match(shell, /bookAi\.openAsk/);
  assert.match(shell, /bookAi\.openJob/);
  assert.match(shell, /bookAi\.openArtifactPreview/);
  assert.match(shell, /bookAi\.returnFromPreview/);
  assert.match(shell, /bookAi\.close/);
  assert.match(html, /data-state="closed"/);
  assert.match(html, /id="book-artifact-return"[^>]*>返回阅读/);
});

test('Book AI shows Person/Book/chapter/context, streams answers, and offers fixed quick prompts', () => {
  for (const id of ['book-ai-person', 'book-ai-book', 'book-ai-chapter', 'book-ai-context']) {
    assert.ok(html.includes(`id="${id}"`), `${id} is visible`);
  }
  assert.match(shell, /streamBookConversationMessage/);
  assert.match(shell, /event\.type === 'delta'/);
  assert.match(shell, /event\.type === 'done'/);
  assert.match(panel, /句子结构/);
  assert.match(panel, /逐词解释/);
  assert.match(panel, /语法点/);
  assert.match(panel, /中文翻译/);
  assert.match(api, /openBookConversation/);
  assert.match(api, /resumeBookConversation/);
  assert.match(api, /deleteBookConversation/);
});

test('Book AI quick prompts send the active sentence/selection snapshot immediately', () => {
  assert.match(shell, /function sendQuickBookAiPrompt\(prompt\)/);
  assert.match(shell, /\['sentence', 'selection'\]\.includes\(bookAi\.state\.context\?\.scope\)/);
  assert.match(shell, /return sendBookAi\(prompt\.text\)/);
  assert.match(shell, /void sendQuickBookAiPrompt\(prompt\)/);
  assert.doesNotMatch(shell, /book-ai-input'\)\.value = prompt\.text/);
  assert.match(panel, /contextSnapshot = structuredClone\(this\.state\.context\)/);
  assert.match(panel, /contextSnapshot: structuredClone\(this\.activeTurn\.contextSnapshot\)/);
  assert.match(shell, /contextMetadataLabel\(message\.contextSnapshot\)/);
  assert.match(shell, /contextLabel\(context\)/);
  assert.match(panel, /conversation: null,[\s\S]*?messages: \[\]/);
  assert.match(panel, /conversation\?\.bookId !== this\.state\.bookId/);
});

test('Book AI rejects stale async Person/Book/chapter context and keeps the mobile composer visible', () => {
  assert.match(shell, /openRequest !== bookAiOpenRequest/);
  assert.match(shell, /read\.profileId\(\) !== personId/);
  assert.match(shell, /activeView\?\.book\?\.id !== book\.id/);
  assert.match(shell, /activeView\?\.chapterIndex !== chapterIndex/);
  assert.match(shell, /bookAiApi\.profile !== personId/);
  assert.match(shell, /window\.visualViewport\?\.addEventListener\('resize'/);
  assert.match(shell, /window\.innerHeight - viewport\.height - viewport\.offsetTop/);
  assert.match(shell, /book-ai-input-focused/);
  assert.doesNotMatch(shell, /book-ai-input[\s\S]{0,180}classList\.add\('editor-takeover'\)/);
  assert.match(css, /bottom: var\(--book-ai-keyboard-inset, 0px\)/);
  assert.match(css, /body\.book-ai-input-focused \.book-artifact-preview/);
});

test('Book AI open/close and preview return are non-reconstructing scroll-safe paths', () => {
  assert.match(shell, /preservedReaderAnchor = \{\s*scrollTop: scroll\.scrollTop/);
  assert.ok(shell.includes("$('book-scroll').scrollTop = preservedReaderAnchor.scrollTop"));
  assert.match(shell, /focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(shell, /bookViewEl\.replaceChildren|chapterBody\.replaceChildren|bookView\.openChapter/);
  assert.match(css, /#reading-area:has\(#book-ai-panel:not\(\[hidden\]\)\)/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) 380px/);
  assert.match(css, /#reading-area:has\(#book-ai-panel:not\(\[hidden\]\)\) #book-view \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.book-ai-panel \{\s*position: fixed;/);
});

test('Book AI task and artifact centers keep every safe action reachable', () => {
  assert.match(html, /id="book-ai-job-list"/);
  assert.match(html, /id="book-ai-artifact-list"/);
  assert.match(api, /async listStudyJobs\(bookId\)/);
  assert.match(api, /async listStudyArtifacts\(bookId\)/);
  assert.match(shell, /refreshBookAiJobs/);
  assert.match(shell, /bookAi\.setJobs/);
  assert.match(shell, /bookAi\.openJob\(jobView\(job\)\)/);
  for (const action of [
    'openArtifactPreview', 'studyArtifactDownloadUrl', 'deleteStudyArtifact',
    'regenerateStudyArtifact', 'remoteCleanupStudyArtifact', 'retryStudyJob',
    'recheckStudyJob',
  ]) assert.match(shell, new RegExp(action));
  assert.match(shell, /result\.job\.state === 'ready'/);
  assert.match(shell, /await refreshBookAiArtifacts/);
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
  assert.match(shell, /end: selection\.endSentenceIndex/);
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
