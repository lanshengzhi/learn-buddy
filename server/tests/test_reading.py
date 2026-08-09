"""Reading normalization (G2P) tests — ADR 0004 / ADR 0005.

Lock the kanji-default contract and the two-output design:

- The Azure primary provider (ADR 0005) gets an **SSML body**: listed surfaces
  become `<phoneme alphabet="sapi" ph="...">` carrying reading + pitch accent
  (e.g. 定める → サダメ'ル = さだめる with ③型 accent on め); everything else
  passes through SSML-escaped.
- The Edge TTS fallback (which cannot take SSML hints) gets **plain text**:
  listed surfaces rewritten to their kana reading, everything else untouched.

Only surfaces the family has *confirmed* a misread live in JA_REPLACE_READINGS;
every common kanji not listed passes through in both forms.
"""

import unittest

from reading import (
    JA_REPLACE_READINGS,
    NORM_VERSION,
    escape_ssml,
    normalize,
    normalize_ja,
    normalize_ja_text,
)


class TestNormalizeJa(unittest.TestCase):
    def setUp(self):
        self._original = dict(JA_REPLACE_READINGS)

    def tearDown(self):
        # Runtime-mutable table: restore the seed exactly so later test
        # modules (and the server tests) still see 定める.
        JA_REPLACE_READINGS.clear()
        JA_REPLACE_READINGS.update(self._original)

    def test_seeded_misread_becomes_a_phoneme(self):
        self.assertIn("定める", JA_REPLACE_READINGS)
        self.assertEqual(
            normalize_ja("定める"),
            '<phoneme alphabet="sapi" ph="サダメ\'ル">定める</phoneme>',
        )
        # The Edge fallback form rewrites to the kana reading instead.
        self.assertEqual(normalize_ja_text("定める"), "さだめる")

    def test_kanji_default_passthrough(self):
        # Common kanji not in the table pass through untouched in both forms.
        self.assertEqual(
            normalize_ja("株式会社は、定款で定めることにより、"),
            "株式会社は、定款で"
            '<phoneme alphabet="sapi" ph="サダメ\'ル">定める</phoneme>'
            "ことにより、",
        )
        self.assertEqual(
            normalize_ja_text("株式会社は、定款で定めることにより、"),
            "株式会社は、定款でさだめることにより、",
        )

    def test_empty_and_short_inputs(self):
        self.assertEqual(normalize_ja(""), "")
        self.assertEqual(normalize_ja_text(""), "")
        self.assertEqual(normalize_ja("abc 123"), "abc 123")
        self.assertEqual(normalize_ja_text("abc 123"), "abc 123")

    def test_ssml_escaping_in_plain_text(self):
        # & < > " ' are escaped in the SSML body; the Edge text form stays
        # raw (EdgeTtsSynthesizer escapes it internally).
        self.assertEqual(
            normalize_ja("A&B <C> \"D\" 'E'"),
            "A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;",
        )
        self.assertEqual(normalize_ja_text("A&B <C> \"D\" 'E'"),
                         "A&B <C> \"D\" 'E'")

    def test_phoneme_attributes_are_not_double_escaped(self):
        # The SAPI apostrophe inside ph="..." is phoneme notation, not text.
        self.assertIn("ph=\"サダメ'ル\"", normalize_ja("定める"))

    def test_listed_surface_is_replaced(self):
        JA_REPLACE_READINGS["発起人"] = ("ほっきにん", "ホッキニン")
        self.assertEqual(
            normalize_ja("発起人ですか"),
            '<phoneme alphabet="sapi" ph="ホッキニン">発起人</phoneme>ですか',
        )
        self.assertEqual(normalize_ja_text("発起人ですか"), "ほっきにんですか")
        # Only the listed surface changes; everything else passes through.
        self.assertEqual(
            normalize_ja("株式会社と発起人。"),
            "株式会社と"
            '<phoneme alphabet="sapi" ph="ホッキニン">発起人</phoneme>'
            "。",
        )

    def test_longest_match_first(self):
        JA_REPLACE_READINGS.update({
            "一昨日": ("おととい", "オトトイ"),
            "一昨昨日": ("さきおととい", "サキオトトイ"),
        })
        self.assertEqual(
            normalize_ja_text("一昨昨日、一昨日。"),
            "さきおととい、おととい。",
        )

    def test_empty_table_passthrough(self):
        # With an empty replacement table both forms are identity (no
        # escaping applies to this kanji text — no special characters).
        JA_REPLACE_READINGS.clear()
        text = "株式会社は、定款で定めることにより、"
        self.assertEqual(normalize_ja(text), text)
        self.assertEqual(normalize_ja_text(text), text)

    def test_text_form_is_idempotent(self):
        # Rewriting to kana removes the listed surface, so re-normalizing the
        # Edge form is stable (the cache-key guarantee).
        JA_REPLACE_READINGS["発起人"] = ("ほっきにん", "ホッキニン")
        once = normalize_ja_text("発起人は株式会社の設立に関わる。")
        self.assertEqual(normalize_ja_text(once), once)


class TestNormalizePlain(unittest.TestCase):
    """en/zh passthrough for the Azure body: escaped, never phoneme-wrapped."""

    def test_escaped_passthrough(self):
        self.assertEqual(
            normalize("Hello & <World> \"x\" 'y'"),
            "Hello &amp; &lt;World&gt; &quot;x&quot; &apos;y&apos;",
        )
        self.assertEqual(normalize("你好，世界。"), "你好，世界。")
        self.assertEqual(normalize(""), "")

    def test_escape_ssml_covers_quotes(self):
        self.assertEqual(
            escape_ssml("a&b<c>d\"e'f"),
            "a&amp;b&lt;c&gt;d&quot;e&apos;f",
        )

    def test_norm_version_is_bumped(self):
        self.assertGreaterEqual(NORM_VERSION, 4)


if __name__ == "__main__":
    unittest.main()
