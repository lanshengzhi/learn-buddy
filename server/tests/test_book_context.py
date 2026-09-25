"""BookContext compiler contract tests (#68)."""

import json
import os
import shutil
import tempfile
import sys
import unittest

import textseg
from book_context import BookContextCompiler
from library import ApiError, Library

try:
    from test_api import ApiTestCase, _fixture
except ImportError:  # python -m unittest from repo root
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tests"))
    from test_api import ApiTestCase, _fixture


class TestBookContextCompiler(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.library = Library(self.root, ja_tokenizer=textseg.tokenize_rule, now=lambda: 100)
        self.book_id = self.library.add_book("dad", "nav.epub", _fixture("nav.epub"))[1]["book"]["id"]
        self.compiler = BookContextCompiler(self.library)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_scope_is_bound_to_book_hash_and_default_is_not_whole_book(self):
        context = self.compiler.compile(self.book_id, "sentence", chapter=0, sentence=0)
        self.assertEqual(context["bookId"], self.book_id)
        self.assertEqual(context["contentHash"], self.book_id)
        self.assertEqual(context["scope"], "sentence")
        self.assertEqual(context["anchor"], {"chapter": 0, "sentence": 0})
        self.assertTrue(context["dataOnly"])
        self.assertNotEqual(context["metadata"]["truncated"], True)
        with self.assertRaises(ApiError) as caught:
            self.compiler.compile(self.book_id, None)
        self.assertEqual(caught.exception.code, "bad_request")

    def test_selection_has_bounded_neighbor_context_and_truncation_metadata(self):
        context = self.compiler.compile(
            self.book_id, "selection", chapter=0, start=1, end=1, max_chars=10)
        self.assertEqual(context["anchor"], {"chapter": 0, "start": 1, "end": 1})
        self.assertLessEqual(context["metadata"]["includedChars"], 10)
        self.assertTrue(context["metadata"]["truncated"])
        self.assertEqual(context["metadata"]["originalChars"], sum(len(item["t"]) for item in self._sentences(0, 0, 2)) + 2)

    def test_chapter_and_explicit_book_scope_are_bounded(self):
        chapter = self.compiler.compile(self.book_id, "chapter", chapter=0, max_chars=12)
        self.assertEqual(chapter["scope"], "chapter")
        self.assertTrue(chapter["metadata"]["truncated"])
        book = self.compiler.compile(self.book_id, "book", max_chars=20)
        self.assertEqual(book["scope"], "book")
        self.assertTrue(book["metadata"]["truncated"])
        self.assertEqual(book["metadata"]["budgetChars"], 20)

    def test_cross_book_or_stale_content_binding_fails_closed(self):
        other = self.library.add_book("dad", "ncx.epub", _fixture("ncx.epub"))[1]["book"]["id"]
        with self.assertRaises(ApiError) as caught:
            self.compiler.compile(self.book_id, "sentence", expected_book_id=other)
        self.assertEqual(caught.exception.code, "book_not_found")
        with self.assertRaises(ApiError) as caught:
            self.compiler.compile(self.book_id, "sentence", content_hash="0" * 64)
        self.assertEqual(caught.exception.code, "book_not_found")

        epub_path = os.path.join(self.root, "books", self.book_id, "book.epub")
        with open(epub_path, "ab") as handle:
            handle.write(b"tampered")
        with self.assertRaises(ApiError) as caught:
            self.compiler.compile(self.book_id, "sentence")
        self.assertEqual(caught.exception.code, "book_not_found")

    def test_snapshot_is_immutable_and_retains_sent_context(self):
        context = self.compiler.compile(self.book_id, "sentence", chapter=0, sentence=0)
        snapshot = self.compiler.snapshot(context)
        context["text"] = "changed after send"
        self.assertNotEqual(snapshot["text"], context["text"])
        self.assertEqual(snapshot["bookId"], self.book_id)
        with open(os.path.join(self.root, "books", self.book_id, "book.epub"), "ab") as handle:
            handle.write(b"tampered-after-send")
        with self.assertRaises(ApiError) as caught:
            self.compiler.snapshot(snapshot)
        self.assertEqual(caught.exception.code, "book_not_found")

    def _sentences(self, chapter, first, last):
        with open(os.path.join(self.root, "books", self.book_id, "chapters", f"{chapter:04d}.json"), encoding="utf-8") as handle:
            return json.load(handle)["sentences"][first:last + 1]


class TestBookContextEndpoint(ApiTestCase):
    def test_api_compiles_context_with_fail_closed_binding(self):
        book_id = json.loads(self.upload()[2])["book"]["id"]
        status, _, body = self.json_request("POST", f"/books/{book_id}/context", {
            "bookId": book_id, "scope": "sentence", "chapter": 0, "sentence": 0,
        })
        self.assertEqual(status, 200)
        context = json.loads(body)["context"]
        self.assertEqual(context["bookId"], book_id)
        self.assertEqual(context["scope"], "sentence")
        self.assertEqual(context["contentHash"], book_id)
        self.assertEqual(context["anchor"], {"chapter": 0, "sentence": 0})
        self.assertNotIn("selectedText", context)

        status, _, body = self.json_request("POST", f"/books/{book_id}/context", {
            "bookId": book_id, "scope": "selection", "chapter": 0,
            "start": 0, "end": 0, "selectedText": "  Chapter  ",
        })
        self.assertEqual(status, 200)
        selection_context = json.loads(body)["context"]
        self.assertEqual(selection_context["selectedText"], "  Chapter  ")
        self.assertEqual(selection_context["anchor"], {"chapter": 0, "start": 0, "end": 0})

        status, _, body = self.json_request("POST", f"/books/{book_id}/context", {
            "bookId": "b" * 64, "scope": "sentence",
        })
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "book_not_found")


if __name__ == "__main__":
    unittest.main()
