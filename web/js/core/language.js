/**
 * Language detection — script-based triage of pasted text, feeding both
 * sentence segmentation and Voice selection. Ported verbatim from dasan's
 * LanguageDetector (kotlin) to preserve ADR 0007 behavior:
 *
 * - kana (hiragana or katakana) present → Japanese
 * - Han ideographs present, no kana → Simplified Chinese
 * - otherwise → English
 *
 * Known limitation (dasan ADR 0007, preserved): Japanese text without kana
 * (e.g. 日本) is detected as Chinese and spoken with the Chinese voice.
 * CJK punctuation alone is deliberately not a signal.
 *
 * @param {string} text
 * @returns {'ja' | 'zh-CN' | 'en'}
 */
export function detectLanguage(text) {
  if (hasKana(text)) return 'ja';
  if (hasHanIdeographs(text)) return 'zh-CN';
  return 'en';
}

// Hiragana and Katakana blocks.
const KANA_START = 0x3040;
const KANA_END = 0x30ff;
// CJK Unified Ideographs.
const HAN_START = 0x4e00;
const HAN_END = 0x9fff;

function hasKana(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= KANA_START && code <= KANA_END) return true;
  }
  return false;
}

function hasHanIdeographs(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= HAN_START && code <= HAN_END) return true;
  }
  return false;
}

/**
 * Default neural voice for a detected locale — mirrors TtsRepository.defaultVoiceFor.
 * @param {string} locale — 'en' | 'ja' | 'zh-CN'
 */
export function defaultVoiceFor(locale) {
  switch (locale) {
    case 'ja':
      return 'ja-JP-KeitaNeural';
    case 'zh-CN':
      return 'zh-CN-YunxiNeural';
    default:
      return 'en-US-AriaNeural';
  }
}
