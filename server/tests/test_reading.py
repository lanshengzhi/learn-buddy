"""Reading normalization (G2P) tests — ADR 0004.

Lock the kanji-default contract: the original text passes through untouched
and only surfaces in JA_REPLACE_READINGS (confirmed Edge misreads) are
rewritten. Two ear-verified findings motivate this: katakana triggers Edge's
loanword head-high accent and hiragana loses the lexical accent that kanji
provides — both were rejected by ear after deployment, so the normalizer is
identity unless a word is explicitly listed.
"""

import unittest

from reading import JA_REPLACE_READINGS, NORM_VERSION, normalize_ja


class TestNormalizeJa(unittest.TestCase):
    def test_empty_table_is_identity(self):
        self.assertEqual(JA_REPLACE_READINGS, {})
        self.assertEqual(normalize_ja("株式会社は、定款で定めることにより、"),
                         "株式会社は、定款で定めることにより、")
        self.assertEqual(normalize_ja("発起人ですか"), "発起人ですか")
        self.assertEqual(normalize_ja("コーヒーを飲む。"), "コーヒーを飲む。")
        self.assertEqual(normalize_ja("こんにちは。"), "こんにちは。")

    def test_empty_and_short_inputs(self):
        self.assertEqual(normalize_ja(""), "")
        self.assertEqual(normalize_ja("abc 123"), "abc 123")

    def test_listed_surface_is_replaced(self):
        JA_REPLACE_READINGS["発起人"] = "ほっきにん"
        try:
            self.assertEqual(normalize_ja("発起人ですか"), "ほっきにんですか")
            # Only the listed surface changes; everything else passes through.
            self.assertEqual(normalize_ja("株式会社と発起人。"),
                             "株式会社とほっきにん。")
        finally:
            JA_REPLACE_READINGS.clear()

    def test_longest_match_first(self):
        JA_REPLACE_READINGS.update({
            "一昨日": "おととい",
            "一昨昨日": "さきおととい",
        })
        try:
            self.assertEqual(normalize_ja("一昨昨日、一昨日。"),
                             "さきおととい、おととい。")
        finally:
            JA_REPLACE_READINGS.clear()

    def test_idempotent(self):
        JA_REPLACE_READINGS["発起人"] = "ほっきにん"
        try:
            once = normalize_ja("発起人は株式会社の設立に関わる。")
            self.assertEqual(normalize_ja(once), once)
        finally:
            JA_REPLACE_READINGS.clear()


if __name__ == "__main__":
    unittest.main()
