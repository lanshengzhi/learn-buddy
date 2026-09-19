/**
 * Book word tokens — the pure shape behind the reading surface's word spans
 * and the 标生词 machinery. The server bakes each sentence as `{t, w, ruby}`:
 * `w` is a list of segment lengths whose sum is `len(t)` (server/textseg.py).
 * These helpers reconstruct the tokens, resolve the "next unknown word" scan,
 * and build the word-state keys the server stores (`ja:食べる` / `en:run`).
 */

/**
 * Reconstructs a sentence's tokens from its length array. Separator segments
 * that merely surround a word (English rule tokenizer: `"hi"` is one segment)
 * are subdivided locally so every letter run still gets a word span.
 * @param {string} text — the sentence text (t)
 * @param {number[]} lengths — the length array (w)
 * @returns {{text: string, start: number, isWord: boolean}[]} — token list in order
 */
export function wordTokens(text, lengths) {
  if (!Array.isArray(lengths) || lengths.reduce((a, b) => a + b, 0) !== text.length) {
    return [{ text, start: 0, isWord: WORD_RE.test(text.trim()) }];
  }
  const tokens = [];
  let start = 0;
  for (const length of lengths) {
    const token = text.slice(start, start + length);
    if (WORD_RE.test(token) || !HAS_WORD_RE.test(token)) {
      tokens.push({ text: token, start, isWord: WORD_RE.test(token) });
    } else {
      // Punctuation-wrapped words ("hi") subdivide locally; the sub-lengths
      // still partition the segment, so spans reconstruct t exactly.
      let local = 0;
      for (const piece of token.matchAll(WORD_RUN_RE)) {
        if (piece.index > local) {
          tokens.push({ text: token.slice(local, piece.index), start: start + local, isWord: false });
        }
        tokens.push({ text: piece[0], start: start + piece.index, isWord: true });
        local = piece.index + piece[0].length;
      }
      if (local < token.length) {
        tokens.push({ text: token.slice(local), start: start + local, isWord: false });
      }
    }
    start += length;
  }
  return tokens;
}

/**
 * The "next unknown word" scan (Migaku's next-lookup, PC shortcut `n`):
 * from `startIndex` (inclusive) forward through the sentence token lists,
 * the first word token whose resolved key is not in the known set and is
 * present in the dictionary. Returns `{sentenceIndex, token}` or null.
 *
 * @param {{tokens: {text: string, isWord: boolean}[]}[]} sentences — token lists per sentence
 * @param {number} startIndex — sentence index to start from
 * @param {(sentenceIndex: number, token: object) => string|null} resolve — the word's key (ja:食べる) or null when absent from the dictionary
 * @param {(key: string) => boolean} isKnown — true when the profile marked it 我认识
 */
export function nextUnknownWord(sentences, startIndex, keyFor, isKnown) {
  for (let index = startIndex; index < sentences.length; index += 1) {
    for (const token of sentences[index].tokens) {
      if (!token.isWord) continue;
      const key = keyFor(index, token);
      if (key != null && !isKnown(key)) return { sentenceIndex: index, token };
    }
  }
  return null;
}

/** Word-state keys look like "ja:食べる" / "en:run". */
export function wordKey(lang, matched) {
  return matched ? `${lang}:${matched}` : null;
}

// A "word" token: letters/numbers/CJK, with internal apostrophes/hyphens —
// everything a learner can look up (don't, co-op, 三十六計).
const WORD_RE = /^[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*$/u;
const HAS_WORD_RE = /[\p{L}\p{N}]/u;
const WORD_RUN_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
