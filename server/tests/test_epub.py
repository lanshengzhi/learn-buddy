import io
import os
import unittest
import zipfile

import epub
import textseg

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def _fixture(name):
    with open(os.path.join(FIXTURES, name), "rb") as fh:
        return fh.read()


def _zip(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, text in files.items():
            archive.writestr(name, text)
    return buffer.getvalue()


def _has_sudachi():
    try:
        textseg._sudachi()
        return True
    except textseg.TokenizerUnavailable:
        return False


HAVE_SUDACHI = _has_sudachi()

CONTAINER = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""


def _package(manifest, spine, metadata=""):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:test</dc:identifier>
    <dc:title>Test</dc:title>
    <dc:language>en</dc:language>
    {metadata}
  </metadata>
  <manifest>{manifest}</manifest>
  <spine>{spine}</spine>
</package>
"""


class TestParseNavBook(unittest.TestCase):
    def setUp(self):
        self.book = epub.parse_epub(_fixture("nav.epub"))

    def test_metadata(self):
        self.assertEqual(self.book["title"], "Nav Book")
        self.assertEqual(self.book["author"], "Test Author")
        self.assertEqual(self.book["lang"], "en")

    def test_chapters_follow_the_nav_and_can_cross_spine_documents(self):
        self.assertEqual([c["title"] for c in self.book["chapters"]], ["Chapter One", "Chapter Two"])
        first = [s["t"] for s in self.book["chapters"][0]["sentences"]]
        self.assertEqual(first, [
            "Chapter One",
            "Hello world.",
            "This is the first chapter.",
            "The dog1 barked.",
            "A brown dog",
            "Chapter Two",
            "Prelude text before the anchor.",
            "It comes first.",
        ])
        second = [s["t"] for s in self.book["chapters"][1]["sentences"]]
        self.assertEqual(second, ["Part Two", "The second part starts here.", "And it ends."])

    def test_image_alt_text_is_kept_and_footnote_marker_survives(self):
        first = self.book["chapters"][0]["sentences"]
        self.assertIn("A brown dog", [s["t"] for s in first])
        self.assertIn("The dog1 barked.", [s["t"] for s in first])

    def test_every_sentence_partitions_exactly(self):
        for chapter in self.book["chapters"]:
            for sentence in chapter["sentences"]:
                self.assertEqual(sum(sentence["w"]), len(sentence["t"]))
                self.assertEqual(sentence["ruby"], [])

    def test_parse_version_is_exposed(self):
        self.assertIsInstance(epub.PARSE_VERSION, int)


@unittest.skipUnless(HAVE_SUDACHI, "sudachipy is not installed")
class TestParseNcxBook(unittest.TestCase):
    def setUp(self):
        self.book = epub.parse_epub(_fixture("ncx.epub"))

    def test_metadata_and_chapters(self):
        self.assertEqual(self.book["title"], "羅生門")
        self.assertEqual(self.book["author"], "芥川龍之介")
        self.assertEqual(self.book["lang"], "ja")
        self.assertEqual([c["title"] for c in self.book["chapters"]], ["第一章", "第二章"])

    def test_source_ruby_is_dropped_from_the_text(self):
        sentences = [s["t"] for s in self.book["chapters"][0]["sentences"]]
        self.assertEqual(sentences, ["ある日の暮方の事である。", "彼は下人である。"])

    def test_sudachi_word_lengths_and_ruby(self):
        sentence = self.book["chapters"][0]["sentences"][0]
        self.assertEqual(sum(sentence["w"]), len(sentence["t"]))
        self.assertEqual(sentence["ruby"], [[2, 1, "ひ"], [4, 2, "くれがた"], [7, 1, "こと"]])


class TestAnchors(unittest.TestCase):
    def test_anchor_on_an_empty_element_still_slices(self):
        # Real epubs often mark a mid-document boundary with <a id="mid"></a>
        # rather than an id on a text-bearing element; the anchor must carry
        # into the next block, or the next chapter starts at the doc top.
        package = _package(
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>',
            '<itemref idref="c1"/>',
        )
        nav = (
            '<html><body><nav epub:type="toc"><ol>'
            '<li><a href="c1.xhtml">One</a></li>'
            '<li><a href="c1.xhtml#mid">Two</a></li>'
            '</ol></nav></body></html>'
        )
        doc = (
            '<html><head><title>C</title></head><body>'
            '<p>First part text.</p><a id="mid"></a><p>Second part text.</p>'
            '</body></html>'
        )
        book = epub.parse_epub(_zip({
            "META-INF/container.xml": CONTAINER,
            "OEBPS/content.opf": package,
            "OEBPS/nav.xhtml": nav,
            "OEBPS/c1.xhtml": doc,
        }), ja_tokenizer=textseg.tokenize_rule)
        self.assertEqual([c["title"] for c in book["chapters"]], ["One", "Two"])
        self.assertEqual([s["t"] for s in book["chapters"][0]["sentences"]], ["First part text."])
        self.assertEqual([s["t"] for s in book["chapters"][1]["sentences"]], ["Second part text."])


class TestParseSpineFallbackBook(unittest.TestCase):
    def test_spine_documents_become_chapters(self):
        book = epub.parse_epub(_fixture("spine.epub"))
        self.assertEqual([c["title"] for c in book["chapters"]], ["Alpha", "Beta"])
        self.assertEqual(
            [s["t"] for s in book["chapters"][0]["sentences"]],
            ["First document text."],
        )
        self.assertEqual(
            [s["t"] for s in book["chapters"][1]["sentences"]],
            ["Second document text."],
        )


class TestLanguageDetection(unittest.TestCase):
    def test_declared_language_wins(self):
        book = epub.parse_epub(_fixture("nav.epub"))
        self.assertEqual(book["lang"], "en")

    def test_language_is_detected_when_not_declared(self):
        package = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
  <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>
"""
        doc = '<html><head><title>C</title></head><body><p>これはテストです。</p></body></html>'
        book = epub.parse_epub(_zip({
            "META-INF/container.xml": CONTAINER,
            "OEBPS/content.opf": package,
            "OEBPS/c1.xhtml": doc,
        }), ja_tokenizer=textseg.tokenize_rule)
        self.assertEqual(book["lang"], "ja")


class TestChineseBook(unittest.TestCase):
    """Chinese books: zh sentence splitting + the jieba word annotation
    (issue #21). The zh_tokenizer seam keeps tests independent of jieba."""

    _OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:test</dc:identifier>
    <dc:title>Honglou</dc:title>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>
"""

    @classmethod
    def setUpClass(cls):
        doc = (
            '<html><head><title>C</title></head><body>'
            '<p>甄士隐梦幻识通灵，贾雨村风尘怀闺秀。此开卷第一回也。</p>'
            '</body></html>'
        )
        cls.book = epub.parse_epub(_zip({
            "META-INF/container.xml": CONTAINER,
            "OEBPS/content.opf": cls._OPF,
            "OEBPS/c1.xhtml": doc,
        }), zh_tokenizer=textseg.tokenize_rule)

    def test_zh_sentences_are_split_on_terminators(self):
        self.assertEqual(
            [s["t"] for s in self.book["chapters"][0]["sentences"]],
            ["甄士隐梦幻识通灵，贾雨村风尘怀闺秀。", "此开卷第一回也。"],
        )

    def test_zh_word_lengths_partition_the_sentence(self):
        sentence = self.book["chapters"][0]["sentences"][0]
        self.assertEqual(sum(sentence["w"]), len(sentence["t"]))
        self.assertEqual(sentence["ruby"], [])

    def test_missing_zh_tokenizer_is_a_parse_failure(self):
        def broken(text):
            raise textseg.TokenizerUnavailable("jieba missing")

        doc = '<html><head><title>C</title></head><body><p>甄士隐梦幻识通灵。</p></body></html>'
        with self.assertRaises(epub.ParseError) as caught:
            epub.parse_epub(_zip({
                "META-INF/container.xml": CONTAINER,
                "OEBPS/content.opf": self._OPF,
                "OEBPS/c1.xhtml": doc,
            }), zh_tokenizer=broken)
        self.assertEqual(caught.exception.code, "parse_failed")


class TestParseErrors(unittest.TestCase):
    def _code(self, data, **kwargs):
        with self.assertRaises(epub.ParseError) as caught:
            epub.parse_epub(data, **kwargs)
        return caught.exception.code

    def test_not_a_zip_is_not_epub(self):
        self.assertEqual(self._code(b"definitely not a zip"), "not_epub")

    def test_zip_without_container_is_not_epub(self):
        self.assertEqual(self._code(_zip({"readme.txt": "hi"})), "not_epub")

    def test_container_without_rootfile_is_not_epub(self):
        data = _zip({"META-INF/container.xml": "<container/>"})
        self.assertEqual(self._code(data), "not_epub")

    def test_missing_opf_is_not_epub(self):
        self.assertEqual(self._code(_zip({"META-INF/container.xml": CONTAINER})), "not_epub")

    def test_malformed_opf_is_parse_failed(self):
        data = _zip({
            "META-INF/container.xml": CONTAINER,
            "OEBPS/content.opf": "<package><unclosed>",
        })
        self.assertEqual(self._code(data), "parse_failed")

    def test_spineless_opf_is_parse_failed(self):
        package = _package('<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>', "")
        data = _zip({
            "META-INF/container.xml": CONTAINER,
            "OEBPS/content.opf": package,
            "OEBPS/c1.xhtml": "<html><body><p>Text.</p></body></html>",
        })
        self.assertEqual(self._code(data), "parse_failed")

    def test_book_with_no_text_is_parse_failed(self):
        package = _package('<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>', '<itemref idref="c1"/>')
        data = _zip({
            "META-INF/container.xml": CONTAINER,
            "OEBPS/content.opf": package,
            "OEBPS/c1.xhtml": '<html><body><img src="cover.png" alt=""/></body></html>',
        })
        self.assertEqual(self._code(data), "parse_failed")

    def test_missing_spine_document_is_parse_failed(self):
        package = _package('<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>', '<itemref idref="c1"/>')
        data = _zip({"META-INF/container.xml": CONTAINER, "OEBPS/content.opf": package})
        self.assertEqual(self._code(data), "parse_failed")

    def test_tokenizer_failure_is_parse_failed(self):
        def broken_tokenizer(text):
            raise epub.textseg.TokenizerUnavailable("no sudachipy")

        self.assertEqual(
            self._code(_fixture("ncx.epub"), ja_tokenizer=broken_tokenizer),
            "parse_failed",
        )


if __name__ == "__main__":
    unittest.main()
