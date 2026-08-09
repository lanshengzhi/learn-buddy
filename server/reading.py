"""Japanese reading normalization (the G2P stage) — ADR 0004 / ADR 0005.

Two ear-verified findings drive this design:

1. The legacy provider (Edge TTS) cannot take furigana / SSML reading hints
   (no custom SSML, no <phoneme>), so the only lever before synthesis was
   text rewriting.
2. Kana-izing text breaks pitch accent. Katakana pushes ja voices into the
   loanword head-high accent (カブシキガイシャ sounds カ↑ブシキ…), and hiragana
   loses the lexical accent derived from kanji dictionaries. Both were
   rejected by ear after deployment. Kanji text is the only input that keeps
   native, dictionary-accented pronunciation.

So the normalizer is **kanji-default**: the original text passes through
untouched, and only surfaces in JA_REPLACE_READINGS — words the family has
*confirmed* misread — are touched.

ADR 0005 moves synthesis to Azure Speech, which accepts real SSML. Each entry
therefore carries two forms:

- a **kana reading** (さだめる) for the Edge TTS fallback, which still cannot
  take SSML hints and gets plain text;
- a **SAPI phoneme** (サダメ'ル — katakana with the "'" accent marker, here
  さだめる with ③型 accent on め) for Azure's <phoneme>, which controls the
  reading AND the pitch accent at once — the dual control kana text alone
  cannot provide.

The list stays minimal and ear-verified, growing from real usage rather than
speculation. The SudachiPy morphological analyzer is not used in this path;
its context disambiguation remains the reference for computing readings when
new entries are added (ADR 0004 "Considered Options").
"""

import re

# Bump when the normalization output for the same input changes, so the
# server audio cache never serves stale audio after a logic change.
NORM_VERSION = 4

# Kanji surfaces the provider misreads, mapped to (kana_reading, sapi_phoneme).
# Applied longest-first. Seed with words confirmed by real listening; keep
# small — every entry is a curated exception to the kanji-default rule.
JA_REPLACE_READINGS = {
    "定める": ("さだめる", "サダメ'ル"),
}

# CJK Unified Ideographs (basic + extension A).
_KANJI_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")

# SSML/XML 1.0 character entities, in an order that keeps & first.
_SSML_ESCAPES = (
    ("&", "&amp;"),
    ("<", "&lt;"),
    (">", "&gt;"),
    ('"', "&quot;"),
    ("'", "&apos;"),
)


def escape_ssml(text):
    """Escape & < > " ' so text can be embedded in SSML (Azure path)."""
    for char, entity in _SSML_ESCAPES:
        text = text.replace(char, entity)
    return text


def _has_kanji(s):
    return bool(_KANJI_RE.search(s))


def _replacement_pattern():
    # Built per call so JA_REPLACE_READINGS can grow at runtime (learner
    # overrides); the table is tiny, so this is negligible.
    return re.compile(
        "|".join(re.escape(k) for k in sorted(JA_REPLACE_READINGS, key=len, reverse=True))
    )


def _apply_replacements(text, ssml):
    """Walk the text replacing listed surfaces; the ssml flag picks the form:
    ssml=True → <phoneme> wrap with escaped plain-text filler; ssml=False →
    kana reading with untouched filler (Edge escapes internally)."""
    pattern = _replacement_pattern()
    parts = []
    last = 0
    for match in pattern.finditer(text):
        surface = match.group(0)
        kana, phoneme = JA_REPLACE_READINGS[surface]
        parts.append(escape_ssml(text[last:match.start()]) if ssml else text[last:match.start()])
        if ssml:
            parts.append(
                f'<phoneme alphabet="sapi" ph="{phoneme}">{escape_ssml(surface)}</phoneme>'
            )
        else:
            parts.append(kana)
        last = match.end()
    parts.append(escape_ssml(text[last:]) if ssml else text[last:])
    return "".join(parts)


def normalize_ja(text):
    """SSML-embeddable body for Japanese (the Azure provider): listed surfaces
    become <phoneme> carrying reading + pitch accent; all other text passes
    through escaped. Kanji-default: identity up to escaping when the
    replacement table is empty or the text has no kanji."""
    if not text:
        return text
    if not _has_kanji(text) or not JA_REPLACE_READINGS:
        return escape_ssml(text)
    return _apply_replacements(text, ssml=True)


def normalize_ja_text(text):
    """Plain text for the Edge TTS fallback (which cannot take SSML hints):
    listed surfaces rewritten to their kana reading, everything else
    untouched. Identity when the replacement table is empty or the text has
    no kanji."""
    if not text or not JA_REPLACE_READINGS or not _has_kanji(text):
        return text
    return _apply_replacements(text, ssml=False)


def normalize(text):
    """SSML-embeddable body for non-Japanese text (en/zh): escaped
    passthrough, never phoneme-wrapped."""
    return escape_ssml(text) if text else text
