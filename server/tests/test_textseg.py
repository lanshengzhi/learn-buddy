import unittest

import textseg


def _has_sudachi():
    try:
        textseg._sudachi()
        return True
    except textseg.TokenizerUnavailable:
        return False


HAVE_SUDACHI = _has_sudachi()


def _has_jieba():
    try:
        textseg._jieba()
        return True
    except textseg.TokenizerUnavailable:
        return False


HAVE_JIEBA = _has_jieba()


class TestRuleTokenizer(unittest.TestCase):
    def test_latin_words_and_separators_partition_the_sentence(self):
        lengths, ruby = textseg.tokenize_rule("Hello, world!")
        self.assertEqual(lengths, [5, 2, 5, 1])
        self.assertEqual(sum(lengths), len("Hello, world!"))
        self.assertEqual(ruby, [])

    def test_words_with_internal_apostrophes_and_hyphens_stay_whole(self):
        lengths, _ = textseg.tokenize_rule("It's well-known.")
        self.assertEqual(lengths, [4, 1, 10, 1])

    def test_cjk_characters_are_single_segments(self):
        lengths, _ = textseg.tokenize_rule("中文 abc")
        self.assertEqual(lengths, [1, 1, 1, 3])
        self.assertEqual(sum(lengths), len("中文 abc"))

    def test_empty_text(self):
        self.assertEqual(textseg.tokenize_rule(""), ([], []))


class TestSplitSentencesEnglish(unittest.TestCase):
    def test_basic_split(self):
        self.assertEqual(
            textseg.split_sentences("Hello world. This is a test.", "en"),
            ["Hello world.", "This is a test."],
        )

    def test_newlines_are_boundaries(self):
        self.assertEqual(
            textseg.split_sentences("First line.\nSecond line.", "en"),
            ["First line.", "Second line."],
        )

    def test_terminator_run_and_closing_quote_stay_together(self):
        self.assertEqual(
            textseg.split_sentences('He said. "Hi there." Then left.', "en"),
            ["He said.", '"Hi there."', "Then left."],
        )

    def test_ellipsis_inside_a_sentence_does_not_split(self):
        self.assertEqual(
            textseg.split_sentences("Well... that's odd. Really odd.", "en"),
            ["Well... that's odd.", "Really odd."],
        )

    def test_abbreviation_does_not_split(self):
        self.assertEqual(
            textseg.split_sentences("Mr. Smith went home. He was tired.", "en"),
            ["Mr. Smith went home.", "He was tired."],
        )

    def test_initialism_does_not_split(self):
        self.assertEqual(
            textseg.split_sentences("U.S.A. is a country.", "en"),
            ["U.S.A. is a country."],
        )

    def test_decimal_does_not_split(self):
        self.assertEqual(
            textseg.split_sentences("3.14 is pi. Then comes tau.", "en"),
            ["3.14 is pi.", "Then comes tau."],
        )

    def test_unpunctuated_text_is_one_sentence(self):
        self.assertEqual(
            textseg.split_sentences("The quick brown fox jumps over the lazy dog", "en"),
            ["The quick brown fox jumps over the lazy dog"],
        )

    def test_overlong_sentence_is_cut_into_usable_chunks(self):
        text = "word " * 120  # 600 chars, no terminator
        sentences = textseg.split_sentences(text, "en")
        self.assertGreater(len(sentences), 1)
        for sentence in sentences:
            self.assertLessEqual(len(sentence), textseg.MAX_SENTENCE_CHARS)

    def test_blank_input(self):
        self.assertEqual(textseg.split_sentences("   \n ", "en"), [])


class TestSplitSentencesJapanese(unittest.TestCase):
    def test_terminators(self):
        self.assertEqual(
            textseg.split_sentences("これは？疑問文です！感嘆文です。", "ja"),
            ["これは？", "疑問文です！", "感嘆文です。"],
        )

    def test_closing_quote_stays_with_sentence(self):
        self.assertEqual(
            textseg.split_sentences("彼は「こんにちは」と言った。それから出かけた。", "ja"),
            ["彼は「こんにちは」と言った。", "それから出かけた。"],
        )

    def test_newline_is_a_boundary(self):
        self.assertEqual(
            textseg.split_sentences("一行目。\n二行目。", "ja"),
            ["一行目。", "二行目。"],
        )


class TestAnnotateRule(unittest.TestCase):
    def test_shape_and_partition(self):
        annotation = textseg.annotate("Hello, world!", "en")
        self.assertEqual(annotation["t"], "Hello, world!")
        self.assertEqual(sum(annotation["w"]), len(annotation["t"]))
        self.assertEqual(annotation["ruby"], [])


class TestSplitSentencesChinese(unittest.TestCase):
    def test_terminators(self):
        self.assertEqual(
            textseg.split_sentences("甄士隐梦幻识通灵，贾雨村风尘怀闺秀。此开卷第一回也。", "zh"),
            ["甄士隐梦幻识通灵，贾雨村风尘怀闺秀。", "此开卷第一回也。"],
        )

    def test_comma_does_not_split(self):
        self.assertEqual(
            textseg.split_sentences("今当中秋，瓜果设宴；亲友齐来。", "zh"),
            ["今当中秋，瓜果设宴；亲友齐来。"],
        )

    def test_U_FF0E_period_terminates(self):
        # The PG transcription of 红楼梦 uses `．`(U+FF0E) as its period
        # (research/rare-hanzi.md §6: 21,290 occurrences vs `。` 7,886).
        self.assertEqual(
            textseg.split_sentences("列位看官．你道此书从何而来．", "zh"),
            ["列位看官．", "你道此书从何而来．"],
        )

    def test_closing_quote_stays_with_sentence(self):
        self.assertEqual(
            textseg.split_sentences("宝玉问道：“你从哪里来？”袭人说：“从东边来。”", "zh"),
            ["宝玉问道：“你从哪里来？”", "袭人说：“从东边来。”"],
        )

    def test_newline_is_a_boundary(self):
        self.assertEqual(
            textseg.split_sentences("甄士隐梦幻识通灵。\n贾雨村风尘怀闺秀。", "zh"),
            ["甄士隐梦幻识通灵。", "贾雨村风尘怀闺秀。"],
        )

    def test_overlong_sentence_is_cut_into_usable_chunks(self):
        text = "字" * 600
        sentences = textseg.split_sentences(text, "zh")
        self.assertGreater(len(sentences), 1)
        for sentence in sentences:
            self.assertLessEqual(len(sentence), textseg.MAX_SENTENCE_CHARS)


@unittest.skipUnless(HAVE_JIEBA, "jieba is not installed")
class TestAnnotateChinese(unittest.TestCase):
    def test_word_lengths_partition(self):
        annotation = textseg.annotate("甄士隐梦幻识通灵，贾雨村风尘怀闺秀。", "zh")
        self.assertEqual(sum(annotation["w"]), len(annotation["t"]))
        self.assertEqual(annotation["ruby"], [])
        # A multi-character token, not one segment per character.
        self.assertIn(3, annotation["w"])

    def test_seam_is_used_when_the_partition_matches(self):
        annotation = textseg.annotate(
            "宝玉笑道：好妹妹。", "zh",
            zh_tokenizer=lambda t: ([2, 1, 1, 1, 1, 1, 1, 1], []),
        )
        self.assertEqual(annotation["w"], [2, 1, 1, 1, 1, 1, 1, 1])

    def test_seam_mismatch_falls_back_to_rule(self):
        annotation = textseg.annotate(
            "宝玉笑道：好妹妹。", "zh", zh_tokenizer=lambda t: ([2, 2], [])
        )
        self.assertEqual(annotation["w"], [1] * 9)


@unittest.skipUnless(HAVE_SUDACHI, "sudachipy is not installed")
class TestAnnotateJapanese(unittest.TestCase):
    def test_word_lengths_and_ruby(self):
        annotation = textseg.annotate("ある日の暮方の事である。", "ja")
        self.assertEqual(annotation["t"], "ある日の暮方の事である。")
        self.assertEqual(annotation["w"], [2, 1, 1, 2, 1, 1, 1, 2, 1])
        self.assertEqual(sum(annotation["w"]), len(annotation["t"]))
        self.assertEqual(
            annotation["ruby"],
            [[2, 1, "ひ"], [4, 2, "くれがた"], [7, 1, "こと"]],
        )

    def test_kana_only_sentences_have_no_ruby(self):
        annotation = textseg.annotate("こんにちは。", "ja")
        self.assertEqual(annotation["ruby"], [])
        self.assertEqual(sum(annotation["w"]), len(annotation["t"]))

    def test_input_is_chunked_under_the_sudachi_limit(self):
        # A tiny injected limit forces the chunking path; each chunk is
        # tokenized separately but the annotation still partitions the whole
        # sentence and keeps absolute ruby offsets.
        text = "あ" * 20 + "日" + "あ" * 20
        lengths, ruby = textseg.tokenize_ja(text, max_bytes=9)
        self.assertEqual(sum(lengths), len(text))
        self.assertEqual(ruby, [[20, 1, "ひ"]])

    def test_chunking_never_breaks_a_multibyte_character(self):
        text = "日本語" * 5
        lengths, _ = textseg.tokenize_ja(text, max_bytes=4)
        self.assertEqual(sum(lengths), len(text))


if __name__ == "__main__":
    unittest.main()
