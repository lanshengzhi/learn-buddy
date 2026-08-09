/**
 * Sentence segmentation — the seam the Reader splits text through.
 *
 * The interface exists so a future AI-backed segmentation backend can replace
 * the local implementation without touching the Reading area (ADR 0001). Behavior:
 * Intl.Segmenter sentence iteration with per-locale granularity, trimmed
 * chunks, empty chunks dropped, and a fixed-length fallback for overlong or
 * unpunctuated text.
 */

export const MAX_SENTENCE_LENGTH = 250;

/**
 * @interface SegmentationService
 * Splits text into sentences for a locale.
 * @param {string} text
 * @param {string} locale — 'en' | 'ja' | 'zh-CN'
 * @returns {string[]}
 */

/** Local implementation backed by Intl.Segmenter (sentence granularity). */
export class IntlSegmenterSegmentationService {
  #segmenters = new Map();

  segment(text, locale = 'en') {
    if (text.trim() === '') return [];
    const segmenter = this.#segmenterFor(locale);
    const sentences = [];
    for (const { segment } of segmenter.segment(text)) {
      const chunk = segment.trim();
      if (chunk !== '') sentences.push(...splitOverlong(chunk));
    }
    return sentences.length > 0 ? sentences : splitOverlong(text.trim());
  }

  #segmenterFor(locale) {
    let segmenter = this.#segmenters.get(locale);
    if (!segmenter) {
      segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
      this.#segmenters.set(locale, segmenter);
    }
    return segmenter;
  }
}

/** Default service instance (module-level singleton). */
export const segmentationService = new IntlSegmenterSegmentationService();

/**
 * Splits text into sentences using the default SegmentationService.
 * Convenience wrapper mirroring SegmentationRepository.segment.
 */
export function split(text, locale = 'en') {
  return segmentationService.segment(text, locale);
}

/**
 * Fixed-length fallback: splits text that has no usable sentence boundary
 * (or a suspiciously long single sentence) into MAX_SENTENCE_LENGTH chunks
 * so the Reading area never produces an unusable card. Character-index arithmetic,
 * so surrogate pairs may be split mid-pair.
 */
export function splitOverlong(text) {
  if (text.length <= MAX_SENTENCE_LENGTH) return [text];
  const result = [];
  let index = 0;
  while (index < text.length) {
    const end = Math.min(index + MAX_SENTENCE_LENGTH, text.length);
    result.push(text.substring(index, end).trim());
    index = end;
  }
  return result;
}
