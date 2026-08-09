"""Reading normalization (G2P) tests — ADR 0004.

Lock the kana output for polyphonic kanji (context disambiguation), the
corrections table, and the passthrough guarantees. Skipped wholesale when
sudachipy is not installed (the module degrades to identity then, so there
is nothing to lock).
"""

import unittest

try:
    from reading import (
        JA_READING_OVERRIDES,
        NORM_VERSION,
        SUDACHI_AVAILABLE,
        normalize_ja,
    )
    HAVE_SUDACHI = SUDACHI_AVAILABLE
except Exception:  # pragma: no cover - import without sudachipy still works
    HAVE_SUDACHI = False


@unittest.skipUnless(HAVE_SUDACHI, "sudachipy not installed")
class TestNormalizeJa(unittest.TestCase):
    def assert_no_kanji(self, text):
        for ch in text:
            self.assertFalse(
                "\u3400" <= ch <= "\u4dbf" or "\u4e00" <= ch <= "\u9fff",
                f"kanji survived normalization: {text!r}",
            )

    def test_context_disambiguates_same_kanji(self):
        # 行 is ギンコウ in 銀行 but イキ in 行きます.
        self.assertEqual(normalize_ja("銀行で行きます。"), "ぎんこうでいきます。")

    def test_compound_and_jukujikun(self):
        self.assertEqual(normalize_ja("東京大学に通う。"), "とうきょうだいがくにかよう。")
        self.assertEqual(normalize_ja("一生懸命頑張る。"), "いっしょうけんめいがんばる。")

    def test_homophone_surfaces_keep_distinct_readings(self):
        self.assertEqual(normalize_ja("橋を渡る。"), "はしをわたる。")
        self.assertEqual(normalize_ja("箸で食べる。"), "はしでたべる。")

    def test_corrections_table_fixes_analyzer_errors(self):
        # SudachiPy splits these date/number compounds and misreads them;
        # the overrides table pins the correct readings (ADR 0004).
        self.assertEqual(normalize_ja("一日中勉強した。"), "いちにちじゅうべんきょうした。")
        self.assertEqual(normalize_ja("二十日は待った。"), "はつかはまった。")
        self.assertEqual(normalize_ja("一昨日の朝。"), "おとといのあさ。")
        self.assertEqual(normalize_ja("一昨年、引っ越した。"), "おととし、ひっこした。")
        self.assertEqual(normalize_ja("明後日まで待つ。"), "あさってまでまつ。")
        self.assertEqual(normalize_ja("一昨昨日は休みだった。"), "さきおとといはやすみだった。")

    def test_kana_and_particles_pass_through(self):
        # No kanji -> untouched; kana particles keep their surface (は/を/へ).
        self.assertEqual(normalize_ja("こんにちは、元気ですか。"), "こんにちは、げんきですか。")
        self.assertEqual(normalize_ja("これは本です。"), "これはほんです。")

    def test_latin_and_punctuation_are_kept(self):
        self.assertEqual(normalize_ja("Hello 今日"), "Hello きょう")

    def test_output_contains_no_kanji(self):
        self.assert_no_kanji(normalize_ja("銀行で行きます。"))
        self.assert_no_kanji(normalize_ja("一人称は「私」。"))

    def test_idempotent(self):
        once = normalize_ja("一昨日、二十日ぶりに帰った。")
        self.assertEqual(normalize_ja(once), once)

    def test_empty_and_short_inputs(self):
        self.assertEqual(normalize_ja(""), "")
        self.assertEqual(normalize_ja("abc 123"), "abc 123")

    def test_corrections_are_longest_match_first(self):
        # 一昨昨日 must win over 一昨日 (its prefix).
        self.assertIn("一昨昨日", JA_READING_OVERRIDES)
        keys = sorted(JA_READING_OVERRIDES, key=len, reverse=True)
        self.assertEqual(len(keys), len(set(keys)))


if __name__ == "__main__":
    unittest.main()
