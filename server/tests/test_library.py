import json
import os
import shutil
import tempfile
import unittest

import epub
import library
import textseg

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def _fixture(name):
    with open(os.path.join(FIXTURES, name), "rb") as fh:
        return fh.read()


class LibraryTestCase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.library = library.Library(
            self.root, ja_tokenizer=textseg.tokenize_rule, now=lambda: 1_758_300_000.0)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def read_json(self, *parts):
        with open(os.path.join(self.root, *parts), encoding="utf-8") as fh:
            return json.load(fh)

    def write_json(self, *parts, payload):
        path = os.path.join(self.root, *parts)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)


class TestProfiles(LibraryTestCase):
    def test_profiles_are_seeded_on_first_read(self):
        response = self.library.profiles()
        self.assertEqual(
            response["profiles"],
            [
                {"id": "dad", "name": "爸爸"},
                {"id": "mom", "name": "妈妈"},
                {"id": "d1", "name": "大女儿"},
                {"id": "d2", "name": "小女儿"},
            ],
        )
        self.assertTrue(os.path.isfile(os.path.join(self.root, "profiles.json")))

    def test_existing_profile_list_is_respected(self):
        with open(os.path.join(self.root, "profiles.json"), "w", encoding="utf-8") as fh:
            json.dump({"profiles": [{"id": "kid", "name": "Kid"}]}, fh)
        self.assertEqual(self.library.profiles()["profiles"], [{"id": "kid", "name": "Kid"}])

    def test_unknown_profile_is_profile_not_found(self):
        with self.assertRaises(library.ApiError) as caught:
            self.library.get_state("nobody")
        self.assertEqual(caught.exception.code, "profile_not_found")

    def test_missing_profile_is_bad_request(self):
        with self.assertRaises(library.ApiError) as caught:
            self.library.get_state("")
        self.assertEqual(caught.exception.code, "bad_request")


class TestState(LibraryTestCase):
    def test_defaults(self):
        self.assertEqual(
            self.library.get_state("dad"),
            {"rate_preset": "Normal", "loop_mode": "All", "lastBook": None, "hl_mode": "underline"},
        )

    def test_partial_update_merges_and_persists(self):
        response = self.library.put_state("dad", {"rate_preset": "Half"})
        self.assertEqual(response["rate_preset"], "Half")
        self.assertEqual(response["loop_mode"], "All")
        response = self.library.put_state("dad", {"lastBook": "abc", "loop_mode": "One"})
        self.assertEqual(response["lastBook"], "abc")
        self.assertEqual(response["loop_mode"], "One")
        self.assertEqual(
            self.read_json("state", "dad", "prefs.json"),
            {"rate_preset": "Half", "loop_mode": "One", "lastBook": "abc", "hl_mode": "underline"},
        )

    def test_unknown_keys_are_ignored(self):
        response = self.library.put_state("dad", {"nonsense": 1})
        self.assertEqual(response, {"rate_preset": "Normal", "loop_mode": "All", "lastBook": None, "hl_mode": "underline"})

    def test_wrong_types_are_bad_request(self):
        for patch in ({"rate_preset": 1}, {"loop_mode": []}, {"lastBook": 3}):
            with self.assertRaises(library.ApiError) as caught:
                self.library.put_state("dad", patch)
            self.assertEqual(caught.exception.code, "bad_request")

    def test_state_is_per_profile(self):
        self.library.put_state("dad", {"rate_preset": "Half"})
        self.assertEqual(self.library.get_state("mom")["rate_preset"], "Normal")


class TestHistory(LibraryTestCase):
    def test_add_and_list_newest_first(self):
        self.library.add_history("dad", "first")
        self.library.add_history("dad", "second")
        entries = self.library.get_history("dad")["entries"]
        self.assertEqual([entry["text"] for entry in entries], ["second", "first"])
        self.assertEqual(entries[0]["favorite"], False)
        self.assertIsNone(entries[0]["selectedIndex"])

    def test_duplicates_collapse_with_the_newest_timestamp(self):
        clock = [1000.0]

        def now():
            return clock[0]

        self.library.now = now
        first = self.library.add_history("dad", "same")["entry"]
        clock[0] = 2000.0
        second = self.library.add_history("dad", "same")["entry"]
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(second["createdAt"], 2000_000)
        self.assertEqual(len(self.library.get_history("dad")["entries"]), 1)

    def test_blank_text_is_bad_request(self):
        for text in ("", "   \n "):
            with self.assertRaises(library.ApiError) as caught:
                self.library.add_history("dad", text)
            self.assertEqual(caught.exception.code, "bad_request")

    def test_bound_trims_oldest_but_keeps_favorites(self):
        clock = [1000.0]
        self.library.now = lambda: clock[0]
        for index in range(library.MAX_HISTORY_ENTRIES + 2):
            clock[0] = 1000.0 + index
            self.library.add_history("dad", f"entry {index}")
        entries = self.library.get_history("dad")["entries"]
        self.assertEqual(len(entries), library.MAX_HISTORY_ENTRIES)
        texts = [entry["text"] for entry in entries]
        self.assertNotIn("entry 0", texts)
        self.assertNotIn("entry 1", texts)

        # Favorite the oldest surviving entry; later trims must spare it.
        survivor = min(entries, key=lambda entry: entry["createdAt"])
        self.library.patch_history("dad", survivor["id"], {"favorite": True})
        victim = min(
            (entry for entry in entries if entry["id"] != survivor["id"]),
            key=lambda entry: entry["createdAt"],
        )
        clock[0] = 10_000.0
        self.library.add_history("dad", "newcomer one")
        result = self.library.add_history("dad", "newcomer two")
        self.assertEqual(result["trimmed"], [victim["id"]])
        entries = self.library.get_history("dad")["entries"]
        self.assertIn(survivor["id"], [entry["id"] for entry in entries])
        self.assertNotIn(victim["id"], [entry["id"] for entry in entries])
        self.assertEqual(len(entries), library.MAX_HISTORY_ENTRIES + 1)

    def test_favorite_entries_are_not_trimmed(self):
        self.library.add_history("dad", "keeper")
        keeper = self.library.get_history("dad")["entries"][0]
        self.library.patch_history("dad", keeper["id"], {"favorite": True})
        for index in range(library.MAX_HISTORY_ENTRIES + 2):
            self.library.add_history("dad", f"filler {index}")
        entries = self.library.get_history("dad")["entries"]
        self.assertIn("keeper", [entry["text"] for entry in entries])
        self.assertEqual(entries[0]["text"], f"filler {library.MAX_HISTORY_ENTRIES + 1}")

    def test_patch_updates_favorite_and_selected_index(self):
        entry_id = self.library.add_history("dad", "text")["entry"]["id"]
        result = self.library.patch_history("dad", entry_id, {"favorite": True, "selectedIndex": 4})
        self.assertEqual(result["entry"]["favorite"], True)
        self.assertEqual(result["entry"]["selectedIndex"], 4)
        result = self.library.patch_history("dad", entry_id, {"selectedIndex": None})
        self.assertIsNone(result["entry"]["selectedIndex"])

    def test_patch_wrong_types_are_bad_request(self):
        entry_id = self.library.add_history("dad", "text")["entry"]["id"]
        for patch in ({"favorite": "yes"}, {"selectedIndex": "1"}, {"selectedIndex": -1}):
            with self.assertRaises(library.ApiError) as caught:
                self.library.patch_history("dad", entry_id, patch)
            self.assertEqual(caught.exception.code, "bad_request")

    def test_patch_unknown_entry_is_entry_not_found(self):
        with self.assertRaises(library.ApiError) as caught:
            self.library.patch_history("dad", 999, {"favorite": True})
        self.assertEqual(caught.exception.code, "entry_not_found")

    def test_delete_removes_the_entry(self):
        entry_id = self.library.add_history("dad", "doomed")["entry"]["id"]
        self.library.delete_history("dad", entry_id)
        self.assertEqual(self.library.get_history("dad")["entries"], [])
        with self.assertRaises(library.ApiError) as caught:
            self.library.delete_history("dad", entry_id)
        self.assertEqual(caught.exception.code, "entry_not_found")

    def test_history_is_per_profile(self):
        self.library.add_history("dad", "dad text")
        self.assertEqual(self.library.get_history("mom")["entries"], [])


class TestWords(LibraryTestCase):
    def test_add_remove_and_sort(self):
        response = self.library.update_words("dad", ["ja:食べる", "en:house"], [])
        self.assertEqual(response["words"], ["en:house", "ja:食べる"])
        response = self.library.update_words("dad", ["ja:食べる"], ["en:house"])
        self.assertEqual(response["words"], ["ja:食べる"])
        self.assertEqual(self.read_json("state", "dad", "words.json"), {"words": ["ja:食べる"]})

    def test_duplicates_are_collapsed(self):
        self.library.update_words("dad", ["ja:食べる", "ja:食べる"], [])
        self.assertEqual(self.library.get_words("dad")["words"], ["ja:食べる"])

    def test_missing_both_lists_is_bad_request(self):
        with self.assertRaises(library.ApiError) as caught:
            self.library.update_words("dad", None, None)
        self.assertEqual(caught.exception.code, "bad_request")

    def test_bad_list_contents_are_bad_request(self):
        for add, remove in (("ja:x", []), ([1], []), ([], ["x", None])):
            with self.assertRaises(library.ApiError) as caught:
                self.library.update_words("dad", add, remove)
            self.assertEqual(caught.exception.code, "bad_request")

    def test_words_are_per_profile(self):
        self.library.update_words("dad", ["ja:食べる"], [])
        self.assertEqual(self.library.get_words("mom")["words"], [])


class TestBooks(LibraryTestCase):
    def _upload(self, name="nav.epub", profile="dad", data=None):
        return self.library.add_book(profile, name, data if data is not None else _fixture(name))

    def test_upload_parses_and_writes_the_layout(self):
        duplicate, response = self._upload()
        self.assertEqual(duplicate, False)
        book = response["book"]
        self.assertEqual(book["title"], "Nav Book")
        self.assertEqual(book["author"], "Test Author")
        self.assertEqual(book["lang"], "en")
        self.assertEqual(book["chapters"], 2)
        self.assertEqual(book["uploadedBy"], "dad")
        self.assertEqual(book["addedAt"], 1_758_300_000)
        self.assertIsNone(book["reading"])
        book_dir = os.path.join(self.root, "books", book["id"])
        self.assertTrue(os.path.isfile(os.path.join(book_dir, "book.epub")))
        self.assertTrue(os.path.isfile(os.path.join(book_dir, "manifest.json")))
        self.assertTrue(os.path.isfile(os.path.join(book_dir, "chapters", "0000.json")))
        self.assertTrue(os.path.isfile(os.path.join(book_dir, "chapters", "0001.json")))
        manifest = self.read_json("books", book["id"], "manifest.json")
        self.assertEqual(manifest["parseVersion"], epub.PARSE_VERSION)
        self.assertEqual(manifest["fileName"], "nav.epub")
        self.assertEqual(manifest["toc"][0], {"index": 0, "title": "Chapter One"})

    def test_reuploading_the_same_bytes_is_idempotent(self):
        _, first = self._upload()
        duplicate, second = self._upload(name="renamed.epub", data=_fixture("nav.epub"))
        self.assertEqual(duplicate, True)
        self.assertEqual(second["book"]["id"], first["book"]["id"])
        self.assertEqual(len(self.library.list_books("dad")["books"]), 1)

    def test_stale_parse_version_reparses(self):
        # A parser upgrade (e.g. a language pipeline fix) must refresh the
        # baked chapters of previously uploaded books on the next upload.
        _, first = self._upload()
        book_id = first["book"]["id"]
        stale = self.read_json("books", book_id, "manifest.json")
        stale["parseVersion"] = epub.PARSE_VERSION - 1
        self.write_json("books", book_id, "manifest.json", payload=stale)
        duplicate, second = self._upload()
        self.assertEqual(duplicate, False)
        self.assertEqual(second["book"]["id"], book_id)
        manifest = self.read_json("books", book_id, "manifest.json")
        self.assertEqual(manifest["parseVersion"], epub.PARSE_VERSION)

    def test_filename_is_reduced_to_a_basename(self):
        _, response = self._upload(name="../../evil.epub", data=_fixture("nav.epub"))
        manifest = self.read_json("books", response["book"]["id"], "manifest.json")
        self.assertEqual(manifest["fileName"], "evil.epub")

    def test_upload_needs_a_name_and_a_known_profile(self):
        with self.assertRaises(library.ApiError) as caught:
            self.library.add_book("dad", "", _fixture("nav.epub"))
        self.assertEqual(caught.exception.code, "bad_request")
        with self.assertRaises(library.ApiError) as caught:
            self.library.add_book("nobody", "nav.epub", _fixture("nav.epub"))
        self.assertEqual(caught.exception.code, "profile_not_found")

    def test_upload_over_the_limit_is_too_large(self):
        small = library.Library(self.root + "-small", max_upload_bytes=10)
        try:
            with self.assertRaises(library.ApiError) as caught:
                small.add_book("dad", "nav.epub", _fixture("nav.epub"))
            self.assertEqual(caught.exception.code, "too_large")
        finally:
            shutil.rmtree(small.root, ignore_errors=True)

    def test_not_epub_and_parse_failed_codes_survive(self):
        with self.assertRaises(library.ApiError) as caught:
            self.library.add_book("dad", "junk.epub", b"not a zip")
        self.assertEqual(caught.exception.code, "not_epub")

    def test_list_books_includes_each_profiles_own_reading(self):
        _, response = self._upload("ncx.epub")
        book_id = response["book"]["id"]
        self.library.put_position(book_id, "dad", 0, 1)
        books = self.library.list_books("dad")["books"]
        self.assertEqual(books[0]["reading"], {"chapter": 0, "sentence": 1})
        books = self.library.list_books("mom")["books"]
        self.assertIsNone(books[0]["reading"])

    def test_list_books_is_newest_first(self):
        clock = [1000.0]
        self.library.now = lambda: clock[0]
        _, first = self._upload("nav.epub")
        clock[0] = 2000.0
        _, second = self._upload("spine.epub")
        books = self.library.list_books("dad")["books"]
        self.assertEqual([book["id"] for book in books], [second["book"]["id"], first["book"]["id"]])

    def test_get_book_returns_metadata_and_toc(self):
        _, response = self._upload()
        detail = self.library.get_book(response["book"]["id"])
        self.assertEqual(detail["book"]["title"], "Nav Book")
        self.assertEqual(
            detail["toc"],
            [{"index": 0, "title": "Chapter One"}, {"index": 1, "title": "Chapter Two"}],
        )

    def test_get_book_with_profile_includes_that_profiles_reading(self):
        # Reopening the app resumes the right CHAPTER: the detail response
        # carries the asker's reading when a profile asks (#17 acceptance).
        _, response = self._upload()
        book_id = response["book"]["id"]
        self.library.put_position(book_id, "dad", 1, 2)
        detail = self.library.get_book(book_id, "dad")
        self.assertEqual(detail["book"]["reading"], {"chapter": 1, "sentence": 2})
        self.assertIsNone(self.library.get_book(book_id)["book"].get("reading"))

    def test_unknown_or_malformed_book_id_is_book_not_found(self):
        for book_id in ("deadbeef", "../../etc", ""):
            with self.assertRaises(library.ApiError) as caught:
                self.library.get_book(book_id)
            self.assertEqual(caught.exception.code, "book_not_found")

    def test_get_chapter_returns_reading_for_the_asking_profile(self):
        _, response = self._upload()
        book_id = response["book"]["id"]
        self.library.put_position(book_id, "dad", 1, 1)
        chapter = self.library.get_chapter(book_id, 0, "dad")
        self.assertEqual(chapter["chapter"]["prev"], None)
        self.assertEqual(chapter["chapter"]["next"], 1)
        self.assertEqual(chapter["reading"], {"sentence": 0})
        chapter = self.library.get_chapter(book_id, 1, "dad")
        self.assertEqual(chapter["chapter"]["prev"], 0)
        self.assertEqual(chapter["chapter"]["next"], None)
        self.assertEqual(chapter["reading"], {"sentence": 1})
        self.assertEqual(self.library.get_chapter(book_id, 1, "mom")["reading"], {"sentence": 0})

    def test_unknown_chapter_is_chapter_not_found(self):
        _, response = self._upload()
        book_id = response["book"]["id"]
        for index in (2, -1):
            with self.assertRaises(library.ApiError) as caught:
                self.library.get_chapter(book_id, index, "dad")
            self.assertEqual(caught.exception.code, "chapter_not_found")

    def test_position_write_validates_and_anchors_the_sentence_text(self):
        _, response = self._upload("ncx.epub")
        book_id = response["book"]["id"]
        self.library.put_position(book_id, "dad", 0, 0)
        position = self.read_json("books", book_id, "positions", "dad.json")
        self.assertEqual(position["chapter"], 0)
        self.assertEqual(position["sentence"], 0)
        self.assertEqual(position["text"], "ある日の暮方の事である。")

    def test_position_write_clamps_out_of_range_sentences(self):
        _, response = self._upload()
        book_id = response["book"]["id"]
        self.library.put_position(book_id, "dad", 1, 999)
        self.assertEqual(self.library.get_chapter(book_id, 1, "dad")["reading"], {"sentence": 2})

    def test_position_write_rejects_bad_values(self):
        _, response = self._upload()
        book_id = response["book"]["id"]
        cases = [
            ("dad", "0", 0, "bad_request"),
            ("dad", 0, "0", "bad_request"),
            ("dad", 0, -1, "bad_request"),
            ("dad", 5, 0, "chapter_not_found"),
            ("nobody", 0, 0, "profile_not_found"),
        ]
        for profile, chapter, sentence, code in cases:
            with self.assertRaises(library.ApiError) as caught:
                self.library.put_position(book_id, profile, chapter, sentence)
            self.assertEqual(caught.exception.code, code, (profile, chapter, sentence))

    def test_position_write_unknown_book_is_book_not_found(self):
        with self.assertRaises(library.ApiError) as caught:
            self.library.put_position("a" * 64, "dad", 0, 0)
        self.assertEqual(caught.exception.code, "book_not_found")


if __name__ == "__main__":
    unittest.main()
