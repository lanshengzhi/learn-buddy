/**
 * Read word / phrase card adapter for issue #69.
 *
 * The baked `{t, w, ruby}` sentence is the authority: its token offsets select
 * a tapped word, and a Selection's exact range selects a phrase. Japanese ruby
 * is promoted to the card's primary reading; JMdict's reading remains secondary.
 * The adapter is additive so the legacy shell keeps its existing lookup path.
 */

import { wordTokens } from './words.js';

const START_ATTR = 'data-lookup-start';
const READING_ATTR = 'data-contextual-reading';
const MAX_CONTEXTUAL_READING = 200;

function isJapanese(language) {
  return String(language ?? '').toLowerCase().startsWith('ja');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Compose the local dictionary card data. Contextual Japanese reading is the
 * primary value; every other dictionary reading remains explicitly secondary.
 * English phonetic and Chinese pinyin are returned unchanged.
 */
export function withContextualReading(entry, language, contextualReading = '') {
  if (!entry) return entry;
  if (!isJapanese(language)) return { ...entry };

  const reading = String(contextualReading || '').trim();
  const alternates = unique([
    entry.reading,
    ...(Array.isArray(entry.alternateReadings) ? entry.alternateReadings : []),
  ]).filter((value) => value !== reading);
  return {
    ...entry,
    ...(reading ? { reading } : {}),
    alternateReadings: alternates,
  };
}

/**
 * Reconstruct the reading for an exact `[start, end)` range from baked ruby.
 * Non-Japanese sentences deliberately return an empty contextual reading.
 */
export function contextualReadingForRange(sentence, start, end, language) {
  if (!isJapanese(language) || !sentence || typeof sentence.t !== 'string') return '';
  const from = Math.max(0, Number(start) || 0);
  const to = Math.min(sentence.t.length, Number(end) || 0);
  if (to <= from) return '';
  const surface = sentence.t.slice(from, to);
  const ruby = Array.isArray(sentence.ruby) ? sentence.ruby : [];
  if (ruby.length === 0) return surface;

  let cursor = from;
  let reading = '';
  for (const annotation of ruby) {
    if (!Array.isArray(annotation)) continue;
    const rubyStart = Number(annotation[0]);
    const rubyLength = Number(annotation[1]);
    const rubyText = String(annotation[2] ?? '');
    if (!Number.isFinite(rubyStart) || !Number.isFinite(rubyLength) || !rubyText) continue;
    const rubyEnd = rubyStart + rubyLength;
    if (rubyEnd <= from || rubyStart >= to) continue;
    const overlapStart = Math.max(from, rubyStart);
    const overlapEnd = Math.min(to, rubyEnd);
    reading += surface.slice(cursor - from, overlapStart - from) + rubyText;
    cursor = overlapEnd;
  }
  reading += surface.slice(cursor - from);
  return reading;
}

/** Preserve the selected surface exactly while grounding it in one sentence. */
export function phraseCardInput(selection, sentence, language) {
  const surface = selection?.text ?? '';
  if (!sentence || !surface.trim()) return null;
  const start = Number(selection.start);
  const end = Number(selection.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return {
    word: surface,
    sentence: sentence.t,
    language,
    start,
    end,
    contextualReading: contextualReadingForRange(sentence, start, end, language),
  };
}

function selectionOffsets(selection, sentence) {
  const range = selection?.getRangeAt?.(0);
  if (!range || !sentence.contains(range.commonAncestorContainer)) return null;
  const before = range.cloneRange();
  before.selectNodeContents(sentence);
  try {
    before.setEnd(range.startContainer, range.startOffset);
  } catch {
    return null;
  }
  return {
    text: selection.toString(),
    start: before.toString().length,
    end: before.toString().length + selection.toString().length,
  };
}

function sentenceForSelection(selection) {
  const range = selection?.getRangeAt?.(0);
  const node = range?.commonAncestorContainer;
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return element?.closest?.('#chapter-body .sent') ?? null;
}

function installCardDetails(bookView, knownWords, getActiveLookup) {
  const hosts = [
    document.getElementById('aside-body'),
    document.getElementById('lookup-card'),
  ].filter(Boolean);

  const render = () => {
    const active = getActiveLookup();
    if (!active?.surface || !active.entry) return;
    for (const host of hosts) {
      const card = host.querySelector('.lookup-card');
      const word = card?.querySelector('.card-word');
      if (!card || word?.textContent !== active.surface) continue;

      const head = card.querySelector('.card-head');
      if (head && !head.querySelector('.card-vocabulary-state')) {
        const state = document.createElement('span');
        state.className = 'card-vocabulary-state';
        const known = knownWords.has(active.entry.key);
        state.textContent = known ? '已认识' : '未认识';
        state.dataset.known = known ? 'true' : 'false';
        head.append(state);
      }

      const readings = active.entry.alternateReadings ?? [];
      if (readings.length && !card.querySelector('.card-alternate-readings')) {
        const alternatives = document.createElement('p');
        alternatives.className = 'muted card-alternate-readings';
        alternatives.textContent = `其他读音：${readings.join('・')}`;
        head?.after(alternatives);
      }

      const actions = card.querySelector('.card-actions');
      if (active.selected && actions && !actions.querySelector('.mark-known')) {
        const mark = document.createElement('button');
        mark.type = 'button';
        mark.className = 'btn tiny mark-known';
        const known = knownWords.has(active.entry.key);
        mark.textContent = known ? '✓ 已认识' : '标记认识';
        mark.addEventListener('click', () => void bookView.markKnown(active.entry.key));
        actions.prepend(mark);
        actions.querySelector('.btn.primary').textContent = '▶ 播放所选';
      }
    }
  };

  const observer = new MutationObserver(render);
  for (const host of hosts) observer.observe(host, { childList: true, subtree: true });
  render();
}

/**
 * Install the additive Read card adapter. It wraps only the local `/lookup`
 * seam and public selection entry points; it never calls NotebookLM or another
 * remote service and never writes a Reading position.
 */
export function installBookLookupCards({ bookView, api, knownWords, isNextShell }) {
  const chapterBody = document.getElementById('chapter-body');
  if (!bookView || !chapterBody) return () => {};

  let activeLookup = { surface: null, contextualReading: '', selected: false };
  let activeResult = null;

  const decorateTokens = () => {
    chapterBody.querySelectorAll('.sent').forEach((sentenceNode) => {
      const index = Number(sentenceNode.dataset.sentence);
      const sentence = bookView.chapter?.sentences?.[index];
      if (!sentence) return;
      const tokens = wordTokens(sentence.t, sentence.w);
      const nodes = sentenceNode.querySelectorAll('.w, .sep');
      tokens.forEach((token, tokenIndex) => {
        const node = nodes[tokenIndex];
        if (!node) return;
        node.setAttribute(START_ATTR, String(token.start));
        if (token.isWord && isJapanese(bookView.book?.lang)) {
          const reading = contextualReadingForRange(
            sentence,
            token.start,
            token.start + token.text.length,
            bookView.book?.lang,
          );
          if (reading) node.setAttribute(READING_ATTR, reading.slice(0, MAX_CONTEXTUAL_READING));
          else node.removeAttribute(READING_ATTR);
        }
      });
    });
  };

  const tokenObserver = new MutationObserver(decorateTokens);
  tokenObserver.observe(chapterBody, { childList: true, subtree: true });
  decorateTokens();

  const rememberToken = (target) => {
    const node = target?.closest?.('.w');
    if (!node) return false;
    const start = Number(node.getAttribute(START_ATTR));
    if (!Number.isFinite(start)) return false;
    activeLookup = {
      surface: node.textContent,
      contextualReading: node.getAttribute(READING_ATTR) ?? '',
      selected: false,
    };
    return true;
  };

  const rememberSelection = (event) => {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    const sentenceNode = sentenceForSelection(selection);
    const index = Number(sentenceNode?.dataset.sentence);
    const sentence = bookView.chapter?.sentences?.[index];
    const offsets = selectionOffsets(selection, sentenceNode);
    const input = offsets ? phraseCardInput(offsets, sentence, bookView.book?.lang) : null;
    if (!input) return false;
    activeLookup = {
      surface: input.word,
      contextualReading: input.contextualReading,
      selected: true,
    };
    activeResult = null;

    // /next/ reserves long selections for the phrase path. The legacy shell
    // already forwards the same selection to BookView's established handler.
    if (isNextShell && input.word.trim().length > 3) {
      event?.stopImmediatePropagation?.();
      bookView.lookupText(input);
    }
    return true;
  };

  chapterBody.addEventListener('pointerover', (event) => rememberToken(event.target), true);
  chapterBody.addEventListener('pointerdown', (event) => {
    if (!rememberToken(event.target)) rememberSelection(event);
  }, true);
  chapterBody.addEventListener('pointerup', rememberSelection, true);

  const originalLookup = api.lookup.bind(api);
  api.lookup = async (language, surface, signal) => {
    const context = activeLookup.surface === surface ? activeLookup : null;
    const entry = await originalLookup(language, surface, signal);
    const enriched = withContextualReading(entry, language, context?.contextualReading);
    if (activeLookup.surface === surface) {
      activeResult = {
        surface,
        selected: context?.selected ?? activeLookup.selected,
        entry: enriched,
      };
    }
    return enriched;
  };

  const originalOpenWord = bookView.openWord.bind(bookView);
  bookView.openWord = (sentenceIndex, surface) => {
    const token = chapterBody
      .querySelector(`.sent[data-sentence="${sentenceIndex}"] .w`)
      && [...chapterBody.querySelectorAll(`.sent[data-sentence="${sentenceIndex}"] .w`)]
        .find((node) => node.textContent === surface);
    if (token) rememberToken(token);
    return originalOpenWord(sentenceIndex, surface);
  };

  const originalLookupText = bookView.lookupText.bind(bookView);
  bookView.lookupText = (input) => {
    if (activeLookup.surface !== input.word) {
      activeLookup = {
        surface: input.word,
        contextualReading: '',
        selected: true,
      };
      activeResult = null;
    }
    return originalLookupText(input);
  };

  installCardDetails(bookView, knownWords, () => activeResult);
  return () => {
    tokenObserver.disconnect();
    chapterBody.removeEventListener('pointerover', rememberToken, true);
  };
}
