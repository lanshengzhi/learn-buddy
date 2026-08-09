"""Japanese reading normalization (the G2P stage) — ADR 0004.

Two ear-verified findings drive this design:

1. Edge TTS cannot take furigana / SSML reading hints (no custom SSML, no
   <phoneme>), so the only lever before synthesis is text rewriting.
2. Kana-izing text breaks pitch accent. Katakana pushes Edge's ja voices into
   the loanword head-high accent (カブシキガイシャ sounds カ↑ブシキ…), and
   hiragana loses the lexical accent Edge derives from kanji dictionaries —
   Edge reads kana with its own default accent contours. Both were rejected
   by ear after deployment. Kanji text is the only input that keeps Edge's
   native, dictionary-accented pronunciation.

So the normalizer is **kanji-default**: the original text passes through
untouched, and only surfaces in JA_REPLACE_READINGS — words the family has
*confirmed* Edge TTS misreads — are rewritten to their correct hiragana
reading. Every entry trades away Edge's native accent for a guaranteed
reading, so the list must stay minimal and ear-verified, growing from real
usage rather than speculation.

The SudachiPy morphological analyzer is not used in this path; its context
disambiguation remains the reference for computing readings when new entries
are added, and for the planned DeepSeek/BYOK fallback and learner-override
layers (ADR 0004 "Considered Options").
"""

import re

# Bump when the normalization output for the same input changes, so the
# server audio cache never serves stale audio after a logic change.
NORM_VERSION = 3

# Kanji surfaces Edge TTS misreads, mapped to the correct hiragana reading.
# Applied longest-first. Seed with words confirmed by real listening; keep
# small — every entry sacrifices Edge's native pitch accent.
JA_REPLACE_READINGS = {}

# CJK Unified Ideographs (basic + extension A).
_KANJI_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


def _has_kanji(s):
    return bool(_KANJI_RE.search(s))


def _apply_replacements(text):
    # Built per call so JA_REPLACE_READINGS can grow at runtime (learner
    # overrides); the table is tiny, so this is negligible.
    pattern = re.compile(
        "|".join(re.escape(k) for k in sorted(JA_REPLACE_READINGS, key=len, reverse=True))
    )
    return pattern.sub(lambda m: JA_REPLACE_READINGS[m.group(0)], text)


def normalize_ja(text):
    """Return the text with confirmed-misread surfaces rewritten to kana.

    Kanji-default: everything else — including all common kanji Edge reads
    with correct dictionary accent — passes through unchanged. Identity when
    the replacement table is empty or the text has no kanji.
    """
    if not text or not JA_REPLACE_READINGS or not _has_kanji(text):
        return text
    return _apply_replacements(text)
