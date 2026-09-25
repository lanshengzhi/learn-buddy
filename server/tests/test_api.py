import io
import json
import os
import shutil
import socket
import sys
import tempfile
import unittest
import zipfile

from library import Library

try:
    from test_server import FakeSynthesizer, ServerHarness
except ImportError:  # `python -m unittest tests.test_api` from server/
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from test_server import FakeSynthesizer, ServerHarness

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


CONTAINER = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""

SPINELESS_OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Empty</dc:title></metadata>
  <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
</package>
"""


class ApiTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.static_dir = tempfile.mkdtemp()
        with open(os.path.join(cls.static_dir, "index.html"), "w", encoding="utf-8") as fh:
            fh.write("<h1>LearnBuddy</h1>")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.static_dir, ignore_errors=True)

    def setUp(self):
        self.harness = ServerHarness(self.static_dir, FakeSynthesizer(), pace_interval=0)

    def tearDown(self):
        self.harness.close()

    # -- helpers -----------------------------------------------------------

    def get(self, path):
        return self.harness.get(path)

    def json_request(self, method, path, payload):
        body = json.dumps(payload).encode("utf-8")
        return self.harness.request(method, path, body=body, headers={"Content-Type": "application/json"})

    def body(self, status_headers_body):
        return json.loads(status_headers_body[2])

    def upload(self, name="nav.epub", data=None, profile="dad"):
        return self.harness.request(
            "POST",
            f"/books?profile={profile}&name={name}",
            body=data if data is not None else _fixture(name),
            headers={"Content-Type": "application/epub+zip"},
        )


class TestProfilesEndpoint(ApiTestCase):
    def test_profiles_are_served_with_no_store(self):
        status, headers, body = self.get("/profiles")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(
            [profile["id"] for profile in json.loads(body)["profiles"]],
            ["dad", "mom", "d1", "d2"],
        )


class TestStateEndpoint(ApiTestCase):
    def test_defaults_then_partial_update(self):
        status, _, body = self.get("/state?profile=dad")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"rate_preset": "Normal", "loop_mode": "All", "lastBook": None, "hl_mode": "underline"})

        status, headers, body = self.json_request("PUT", "/state?profile=dad", {"rate_preset": "Half"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(json.loads(body), {"rate_preset": "Half", "loop_mode": "All", "lastBook": None, "hl_mode": "underline"})

    def test_missing_and_unknown_profiles(self):
        status, _, body = self.get("/state")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "bad_request")
        status, _, body = self.get("/state?profile=nobody")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "profile_not_found")

    def test_broken_json_is_bad_request(self):
        status, _, body = self.harness.request(
            "PUT", "/state?profile=dad", body=b"{not json", headers={"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "bad_request")


class TestHistoryEndpoint(ApiTestCase):
    def _add(self, text, profile="dad"):
        status, _, body = self.json_request("POST", f"/history?profile={profile}", {"text": text})
        return status, json.loads(body)

    def test_lifecycle(self):
        status, payload = self._add("  Hello world.  ")
        self.assertEqual(status, 200)
        self.assertEqual(payload["entry"]["text"], "Hello world.")
        self.assertEqual(payload["trimmed"], [])
        entry_id = payload["entry"]["id"]

        status, _, body = self.get("/history?profile=dad")
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)["entries"]), 1)

        status, _, body = self.json_request("PATCH", f"/history/{entry_id}?profile=dad", {
            "favorite": True, "selectedIndex": 3,
        })
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["entry"]["favorite"], True)
        self.assertEqual(json.loads(body)["entry"]["selectedIndex"], 3)

        status, _, body = self.harness.request("DELETE", f"/history/{entry_id}?profile=dad")
        self.assertEqual(status, 204)
        self.assertEqual(body, b"")
        status, _, body = self.get("/history?profile=dad")
        self.assertEqual(json.loads(body)["entries"], [])

    def test_missing_fields_and_unknown_ids(self):
        status, _, body = self.json_request("POST", "/history?profile=dad", {})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "bad_request")

        status, _, body = self.json_request("PATCH", "/history/999?profile=dad", {"favorite": True})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "entry_not_found")

        status, _, body = self.harness.request("DELETE", "/history/nope?profile=dad")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "bad_request")


class TestWordsEndpoint(ApiTestCase):
    def test_roundtrip(self):
        status, _, body = self.get("/words?profile=dad")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"words": []})

        status, _, body = self.json_request("POST", "/words?profile=dad", {
            "add": ["ja:食べる"], "remove": [],
        })
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"words": ["ja:食べる"]})

        status, _, body = self.json_request("POST", "/words?profile=dad", {
            "add": [], "remove": ["ja:食べる"],
        })
        self.assertEqual(json.loads(body), {"words": []})


class TestBooksEndpoint(ApiTestCase):
    def test_upload_list_detail_chapter_and_position(self):
        status, _, body = self.upload()
        self.assertEqual(status, 201)
        book = json.loads(body)["book"]
        self.assertEqual(book["title"], "Nav Book")
        self.assertEqual(book["uploadedBy"], "dad")
        book_id = book["id"]

        # Same bytes again: idempotent, 200 + duplicate.
        status, _, body = self.upload()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["duplicate"], True)
        self.assertEqual(json.loads(body)["book"]["id"], book_id)

        status, headers, body = self.get(f"/books?profile=dad")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        books = json.loads(body)["books"]
        self.assertEqual(len(books), 1)
        self.assertIsNone(books[0]["reading"])

        status, _, body = self.get(f"/books/{book_id}")
        self.assertEqual(status, 200)
        detail = json.loads(body)
        self.assertEqual(detail["book"]["fileName"], "nav.epub")
        self.assertEqual(
            detail["toc"],
            [{"index": 0, "title": "Chapter One"}, {"index": 1, "title": "Chapter Two"}],
        )

        status, _, body = self.get(f"/books/{book_id}/chapters/0?profile=dad")
        self.assertEqual(status, 200)
        chapter = json.loads(body)
        self.assertEqual(chapter["chapter"]["index"], 0)
        self.assertEqual(chapter["chapter"]["next"], 1)
        self.assertEqual(chapter["reading"], {"sentence": 0})
        self.assertEqual(chapter["chapter"]["sentences"][0]["t"], "Chapter One")

        status, _, body = self.json_request(
            "PUT", f"/books/{book_id}/position?profile=dad", {"chapter": 1, "sentence": 2})
        self.assertEqual(status, 204)
        self.assertEqual(body, b"")

        status, _, body = self.get(f"/books/{book_id}/chapters/1?profile=dad")
        self.assertEqual(json.loads(body)["reading"], {"sentence": 2})
        status, _, body = self.get(f"/books/{book_id}/chapters/0?profile=dad")
        self.assertEqual(json.loads(body)["reading"], {"sentence": 0})

        books = json.loads(self.get("/books?profile=dad")[2])["books"]
        self.assertEqual(books[0]["reading"], {"chapter": 1, "sentence": 2})
        books = json.loads(self.get("/books?profile=mom")[2])["books"]
        self.assertIsNone(books[0]["reading"])

    def test_chapter_number_must_be_numeric_and_exist(self):
        book_id = json.loads(self.upload()[2])["book"]["id"]
        status, _, body = self.get(f"/books/{book_id}/chapters/abc?profile=dad")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "bad_request")
        status, _, body = self.get(f"/books/{book_id}/chapters/99?profile=dad")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "chapter_not_found")

    def test_unknown_book_is_book_not_found(self):
        status, _, body = self.get(f"/books/{'a' * 64}")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "book_not_found")
        status, _, body = self.get(f"/books/{'a' * 64}/chapters/0?profile=dad")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "book_not_found")

    def test_books_list_needs_a_profile(self):
        status, _, body = self.get("/books")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "bad_request")

    def test_not_epub_is_415(self):
        status, _, body = self.upload(name="junk.epub", data=b"definitely not a zip")
        self.assertEqual(status, 415)
        self.assertEqual(json.loads(body)["error"], "not_epub")

    def test_failed_uploads_preserve_books_and_positions(self):
        # #46: an invalid/unreadable upload must never corrupt the shelf or
        # the Reading positions already stored for any profile.
        book_id = json.loads(self.upload()[2])["book"]["id"]
        status, _, _ = self.json_request(
            "PUT", f"/books/{book_id}/position?profile=dad", {"chapter": 1, "sentence": 2})
        self.assertEqual(status, 204)

        status, _, body = self.upload(name="junk.epub", data=b"definitely not a zip")
        self.assertEqual(status, 415)
        broken = _zip({"META-INF/container.xml": CONTAINER, "OEBPS/content.opf": SPINELESS_OPF})
        status, _, body = self.upload(name="broken.epub", data=broken)
        self.assertEqual(status, 422)

        books = json.loads(self.get("/books?profile=dad")[2])["books"]
        self.assertEqual([b["id"] for b in books], [book_id])
        self.assertEqual(books[0]["reading"], {"chapter": 1, "sentence": 2})
        chapter = json.loads(self.get(f"/books/{book_id}/chapters/1?profile=dad")[2])
        self.assertEqual(chapter["reading"], {"sentence": 2})

    def test_unreadable_epub_is_422(self):
        data = _zip({"META-INF/container.xml": CONTAINER, "OEBPS/content.opf": SPINELESS_OPF})
        status, _, body = self.upload(name="broken.epub", data=data)
        self.assertEqual(status, 422)
        self.assertEqual(json.loads(body)["error"], "parse_failed")

    def test_upload_over_the_limit_is_413(self):
        root = tempfile.mkdtemp()
        harness = ServerHarness(
            self.static_dir, FakeSynthesizer(), pace_interval=0,
            library_obj=Library(root, max_upload_bytes=10),
        )
        try:
            status, _, body = harness.request(
                "POST", "/books?profile=dad&name=nav.epub", body=_fixture("nav.epub"),
                headers={"Content-Type": "application/epub+zip"},
            )
            self.assertEqual(status, 413)
            self.assertEqual(json.loads(body)["error"], "too_large")
        finally:
            harness.close()
            shutil.rmtree(root, ignore_errors=True)

    def test_oversized_json_body_is_413(self):
        # Raw socket: the server rejects on Content-Length before reading the
        # body, so there is no body to finish sending (urllib would surface
        # the early close as a URLError instead of the response).
        with socket.create_connection(("127.0.0.1", self.harness.port), timeout=5) as sock:
            headers = (
                "POST /history?profile=dad HTTP/1.1\r\n"
                "Host: 127.0.0.1\r\n"
                f"Content-Length: {1024 * 1024 + 1}\r\n"
                "Content-Type: application/json\r\n\r\n"
            )
            sock.sendall(headers.encode("ascii"))
            response = sock.makefile("rb").read()
        self.assertIn(b"413", response.split(b"\r\n", 1)[0])
        self.assertIn(b'"error": "too_large"', response)


class _DeterministicNotebookLM:
    def __init__(self):
        self.calls = []

    def sync_source(self, **kwargs):
        self.calls.append(kwargs)
        return {"outcome": "confirmed", "notebookId": "notebook-1", "sourceId": "source-1"}


class TestNotebookLMSyncEndpoint(ApiTestCase):
    def test_sync_is_explicit_and_reuses_the_content_hash_mapping(self):
        provider = _DeterministicNotebookLM()
        self.harness.httpd.app.notebook_sync.provider = provider
        book_id = json.loads(self.upload()[2])["book"]["id"]

        status, _, body = self.json_request(
            "POST", f"/books/{book_id}/notebook-sync", {})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "cloud_confirmation_required")
        self.assertEqual(provider.calls, [])

        status, _, body = self.json_request(
            "POST", f"/books/{book_id}/notebook-sync", {"confirmUpload": True})
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(result["notebookRef"]["bookContentHash"], book_id)
        self.assertEqual(result["notebookRef"]["sourceId"], "source-1")
        self.assertEqual(len(provider.calls), 1)

        status, _, body = self.json_request(
            "POST", f"/books/{book_id}/notebook-sync", {"confirmUpload": True})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["reused"])
        self.assertEqual(len(provider.calls), 1)

        status, _, body = self.get(f"/books/{book_id}/notebook-sync")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["notebookRef"]["deletionStatus"], {
            "local": "active", "remote": "active",
        })


class TestNotebookLMStatusEndpoint(ApiTestCase):
    def test_browser_sees_only_safe_status(self):
        self.harness.httpd.app.notebooklm.url = ""
        status, headers, body = self.get("/notebooklm/status")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(json.loads(body), {
            "provider": "notebooklm",
            "configured": False,
            "available": False,
            "status": "not_configured",
            "error": "notebooklm_not_configured",
        })
        self.assertNotIn("token", body.decode("utf-8").lower())
        self.assertNotIn("cookie", body.decode("utf-8").lower())

    def test_local_reader_endpoints_survive_an_unconfigured_worker(self):
        status, _, _ = self.get("/profiles")
        self.assertEqual(status, 200)
        status, _, body = self.get("/books?profile=dad")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["books"], [])


class TestRouting(ApiTestCase):
    def test_unknown_path_is_not_found(self):
        status, _, body = self.get("/nope")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "not_found")

    def test_wrong_method_on_a_known_path_is_not_found(self):
        status, _, body = self.harness.request("POST", "/profiles")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "not_found")


if __name__ == "__main__":
    unittest.main()


class TestLookupEndpoints(ApiTestCase):
    """Lookup dictionary endpoints (ADR 0008). The harness's data dir has no
    dicts by default — the degrade path is tested first, then fixture dbs."""

    def get_url(self, path, params):
        from urllib.parse import urlencode

        return self.get(f"{path}?{urlencode(params)}")

    def test_lookup_without_dicts_degrades(self):
        status, _, body = self.get_url("/lookup", {"lang": "ja", "word": "何か"})
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"], "lookup_unavailable")

    def test_check_without_dicts_reports_all_misses(self):
        status, _, body = self.json_request("POST", "/lookup/check", {"lang": "ja", "words": ["何か"]})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["words"], {"何か": None})

    def test_check_rejects_bad_bodies(self):
        status, _, body = self.json_request("POST", "/lookup/check", {"lang": "ja", "words": "not-a-list"})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "bad_request")
        status, _, body = self.json_request("POST", "/lookup/check", {"lang": "ja", "words": ["w"] * 201})
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(body)["error"], "too_large")

    def _with_fixture_dicts(self):
        try:
            from test_dicts import _write_db
        except ImportError:  # `python -m unittest tests.test_api` from server/
            from tests.test_dicts import _write_db

        dicts_dir = os.path.join(self.harness.data_dir, "dicts")
        os.makedirs(dicts_dir, exist_ok=True)
        _write_db(
            os.path.join(dicts_dir, "en.sqlite"),
            [
                "CREATE TABLE ecdict (word TEXT PRIMARY KEY, phonetic TEXT, translation TEXT, definition TEXT)",
                "INSERT INTO ecdict VALUES ('run', 'rʌn', '跑', 'move fast')",
                "INSERT INTO ecdict VALUES ('stop machine', 'ˈstɑp məˈʃiːn', '停机', 'a machine that stops')",
            ],
        )
        _write_db(
            os.path.join(dicts_dir, "ja.sqlite"),
            [
                "CREATE TABLE forms (text TEXT NOT NULL, entry INTEGER NOT NULL)",
                "CREATE TABLE entries (id INTEGER PRIMARY KEY, reading TEXT)",
                "CREATE TABLE senses (entry INTEGER NOT NULL, ord INTEGER NOT NULL, pos TEXT, gloss TEXT)",
                "INSERT INTO entries VALUES (1, 'たべる'), (2, 'いって'), (3, 'いく')",
                "INSERT INTO forms VALUES ('食べる', 1), ('たべる', 1), ('行く', 2), ('行って', 2), ('行く', 3)",
                "INSERT INTO senses VALUES (1, 0, 'v1', 'to eat'), (2, 0, 'v5', 'to go'), (3, 0, 'v5', 'to go')",
            ],
        )
        _write_db(
            os.path.join(dicts_dir, "zh.sqlite"),
            [
                "CREATE TABLE cedict (traditional TEXT, simplified TEXT, pinyin TEXT, glosses TEXT)",
                "CREATE INDEX cedict_simplified ON cedict(simplified)",
                "CREATE INDEX cedict_traditional ON cedict(traditional)",
                "INSERT INTO cedict VALUES ('寶玉', '宝玉', 'bao3 yu4', '/precious jade/')",
            ],
        )

    def test_lookup_resolves_en_and_ja(self):
        self._with_fixture_dicts()
        status, _, body = self.get_url("/lookup", {"lang": "en", "word": "run"})
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload["key"], "en:run")
        self.assertEqual(payload["reading"], "rʌn")
        self.assertEqual(payload["senses"][0]["gloss"], "跑")
        self.assertEqual(payload["glossLanguage"], "zh")
        self.assertEqual(payload["glossSource"], "ECDICT translation")

        status, _, body = self.get_url("/lookup", {"lang": "ja", "word": "食べる"})
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload["key"], "ja:食べる")
        self.assertEqual(payload["reading"], "たべる")

        status, _, body = self.get_url("/lookup", {"lang": "ja", "word": "行く"})
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload["reading"], "いって")
        self.assertEqual(payload["alternateReadings"], ["いく"])

    def test_lookup_resolves_an_english_phrase_without_tokenizing_it(self):
        self._with_fixture_dicts()
        status, _, body = self.get_url(
            "/lookup", {"lang": "en", "word": "stop machine"}
        )
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload["word"], "stop machine")
        self.assertEqual(payload["key"], "en:stop machine")
        self.assertEqual(payload["reading"], "ˈstɑp məˈʃiːn")
        self.assertEqual(payload["senses"][0]["gloss"], "停机")

    def test_lookup_resolves_zh(self):
        self._with_fixture_dicts()
        # zh-CN canonicalizes to zh.
        status, _, body = self.get_url("/lookup", {"lang": "zh-CN", "word": "宝玉"})
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload["lang"], "zh")
        self.assertEqual(payload["key"], "zh:宝玉")
        self.assertEqual(payload["reading"], "bǎo yù")
        # Mixed-tradition text: the traditional form hits the same entry.
        status, _, body = self.get_url("/lookup", {"lang": "zh", "word": "寶玉"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["key"], "zh:宝玉")

    def test_lookup_misses_are_404(self):
        self._with_fixture_dicts()
        status, _, body = self.get_url("/lookup", {"lang": "en", "word": "qwertyuiop"})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "entry_not_found")
        status, _, body = self.get_url("/lookup", {"lang": "fr", "word": "bonjour"})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "entry_not_found")
        status, _, body = self.get_url("/lookup", {"lang": "zh", "word": "甄士隐"})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "entry_not_found")


class TestAiEndpoint(ApiTestCase):
    def test_not_configured_degrades(self):
        self.harness.httpd.app.ai.url = ""
        status, _, body = self.json_request("POST", "/ai", {"word": "run", "sentence": "I run.", "language": "en"})
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"], "ai_not_configured")

    def test_bad_request(self):
        status, _, body = self.json_request("POST", "/ai", {"sentence": "I run.", "language": "en"})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "bad_request")

    def test_upstream_answer_is_proxied(self):
        class FakeResponse:
            def read(self):
                return json.dumps({"text": "to run fast"}).encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        proxy = self.harness.httpd.app.ai
        proxy.url = "http://ai.test"
        requests = []
        def upstream(request, timeout):
            requests.append(json.loads(request.data.decode("utf-8")))
            return {"text": "to run fast"}
        proxy._urlopen = upstream
        status, _, body = self.json_request("POST", "/ai", {
            "word": "run", "sentence": "I run.", "language": "en",
            "explanationLocale": "zh-CN",
        })
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"text": "to run fast"})
        self.assertEqual(requests, [{
            "word": "run", "sentence": "I run.", "language": "en",
            "explanationLocale": "zh-CN",
        }])
