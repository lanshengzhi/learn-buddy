/**
 * Language detection — script-based triage of pasted text, feeding both
 * sentence segmentation and Voice selection. Script-based triage:
 *
 * - kana (hiragana or katakana) present → Japanese
 * - no kana → fallbackLocale when given (the passage's detected language);
 *   otherwise Han ideographs present → Simplified Chinese; otherwise English
 *
 * A kana-less sentence inside a Japanese passage therefore inherits
 * Japanese — an all-kanji sentence (e.g. 東京大学) is spoken in Japanese.
 * Known limitation: a whole Japanese passage without kana (e.g. 日本) is
 * detected as Chinese and spoken with the Chinese voice.
 * CJK punctuation alone is deliberately not a signal.
 *
 * @param {string} text
 * @param {'en' | 'ja' | 'zh' | 'zh-CN'} [fallbackLocale] — passage locale, inherited by kana-less text
 * @returns {'ja' | 'zh-CN' | 'en'}
 */
export function detectLanguage(text, fallbackLocale) {
  const fallback = normalizeLanguage(fallbackLocale);
  if (hasKana(text)) return 'ja';
  if (hasHanIdeographs(text)) return fallback ?? 'zh-CN';
  return fallback ?? 'en';
}

/** Normalize server EPUB locales to the browser's canonical locale names. */
export function normalizeLanguage(locale) {
  return locale === 'zh' ? 'zh-CN' : locale;
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
    case 'zh':
    case 'zh-CN':
      return 'zh-CN-YunxiNeural';
    default:
      return 'en-US-AriaNeural';
  }
}
