import base64
import hashlib
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


def _read_bytes(path):
    with open(path, "rb") as handle:
        return handle.read()


def _tree_bytes(root):
    return {
        os.path.relpath(os.path.join(directory, name), root): _read_bytes(
            os.path.join(directory, name))
        for directory, _, names in os.walk(root) for name in names
    }


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
        self.job_calls = []
        self.artifact_data = json.dumps({"summary": "deterministic artifact"}, ensure_ascii=False).encode("utf-8")

    def sync_source(self, **kwargs):
        self.calls.append(kwargs)
        return {"outcome": "confirmed", "notebookId": "notebook-1", "sourceId": "source-1"}

    def job_request(self, **kwargs):
        self.job_calls.append(dict(kwargs))
        remote = {
            "provider": "notebooklm", "notebookId": kwargs["notebook_id"],
            "sourceId": kwargs["source_id"], "artifactId": f"artifact-{len(self.job_calls) - 1}",
        }
        return {"state": "waiting_remote", "error": None, "artifact": None, "remote": remote}

    def reconcile_job(self, **kwargs):
        remote = kwargs["remote_provenance"]
        return {
            "state": "ready", "error": None, "remote": remote,
            "artifact": {
                "remoteArtifactId": remote["artifactId"], "contentType": "application/json",
                "byteSize": len(self.artifact_data),
                "dataBase64": base64.b64encode(self.artifact_data).decode("ascii"),
                "remote": remote,
            },
        }

    def cancel_job(self, **kwargs):
        return {"state": "cancelled", "error": None, "artifact": None}


class _ArtifactNotebookLM(_DeterministicNotebookLM):
    def __init__(self, cleanup_outcomes=None):
        super().__init__()
        self.artifact_data = json.dumps({"summary": "deterministic artifact"}, ensure_ascii=False).encode("utf-8")
        self.cleanup_outcomes = list(cleanup_outcomes or [])

    def reconcile_job(self, **kwargs):
        remote = kwargs["remote_provenance"]
        return {
            "state": "ready", "error": None, "remote": remote,
            "artifact": {
                "remoteArtifactId": remote["artifactId"],
                "contentType": "application/json", "byteSize": len(self.artifact_data),
                "dataBase64": base64.b64encode(self.artifact_data).decode("ascii"), "remote": remote,
            },
        }

    def delete_artifact(self, *, artifact_id, remote):
        self.cleanup_calls = getattr(self, "cleanup_calls", [])
        self.cleanup_calls.append({"artifact_id": artifact_id, "remote": dict(remote)})
        return dict(self.cleanup_outcomes.pop(0))


class TestStudyArtifactEndpoint(ApiTestCase):
    def _sync(self, book_id):
        self.harness.httpd.app.notebook_refs.ensure(book_id, "notebook-1", "source-1")

    def _ready_artifact(self, profile, book_id, request_id, artifact_type="learning_report"):
        request = {
            "requestId": request_id, "artifactType": artifact_type,
            "contextScope": {"scope": "chapter", "anchor": {"chapter": 0}},
        }
        status, _, body = self.json_request(
            "POST", f"/books/{book_id}/study-jobs?profile={profile}", {"request": request})
        self.assertEqual(status, 201, body)
        job = json.loads(body)["job"]
        status, _, body = self.json_request(
            "POST", f"/study-jobs/{job['id']}/reconcile?profile={profile}", {})
        self.assertEqual(status, 200, body)
        ready = json.loads(body)["job"]
        self.assertEqual(ready["state"], "ready")
        return ready["artifactId"]

    def test_original_preview_download_isolation_and_local_delete_preserve_reading_data(self):
        provider = _ArtifactNotebookLM()
        self.harness.httpd.app.study_job_runner.provider = provider
        dad_book = json.loads(self.upload()[2])["book"]["id"]
        other_book = json.loads(self.upload("spine.epub")[2])["book"]["id"]
        for book_id in (dad_book, other_book):
            self._sync(book_id)
        status, _, _ = self.json_request(
            "PUT", f"/books/{dad_book}/position?profile=dad", {"chapter": 1, "sentence": 2})
        self.assertEqual(status, 204)

        dad_artifact_id = self._ready_artifact("dad", dad_book, "study-job:artifact-dad")
        mom_artifact_id = self._ready_artifact("mom", dad_book, "study-job:artifact-mom")
        other_artifact_id = self._ready_artifact("dad", other_book, "study-job:artifact-other")

        status, _, body = self.get(f"/books/{dad_book}/study-artifacts?profile=dad")
        self.assertEqual(status, 200)
        dad_listing = json.loads(body)
        self.assertEqual(dad_listing["book"], dad_book)
        self.assertEqual([item["id"] for item in dad_listing["artifacts"]], [dad_artifact_id])
        self.assertEqual(json.loads(self.get(f"/books/{other_book}/study-artifacts?profile=dad")[2])["artifacts"][0]["id"],
                         other_artifact_id)
        self.assertEqual(json.loads(self.get(f"/books/{dad_book}/study-artifacts?profile=mom")[2])["artifacts"][0]["id"],
                         mom_artifact_id)
        for profile in ("mom", "d1"):
            self.assertEqual(self.get(f"/study-artifacts/{dad_artifact_id}?profile={profile}")[0], 404)
            self.assertEqual(self.get(f"/study-artifacts/{dad_artifact_id}/download?profile={profile}")[0], 404)

        status, _, body = self.get(f"/study-artifacts/{dad_artifact_id}?profile=dad")
        artifact = json.loads(body)["artifact"]
        expected_hash = hashlib.sha256(provider.artifact_data).hexdigest()
        self.assertEqual((artifact["byteSize"], artifact["contentHash"]), (len(provider.artifact_data), expected_hash))
        self.assertEqual(artifact["previewData"], {
            "kind": "structured", "data": {"summary": "deterministic artifact"},
        })
        self.assertNotIn("originalPath", artifact)
        status, headers, downloaded = self.get(f"/study-artifacts/{dad_artifact_id}/download?profile=dad")
        self.assertEqual(status, 200)
        self.assertEqual(downloaded, provider.artifact_data)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertIn(dad_artifact_id, headers["Content-Disposition"])

        class UnavailableProvider:
            def job_request(self, **kwargs):
                raise AssertionError("ready local artifact must not submit a provider job")

            def reconcile_job(self, **kwargs):
                raise AssertionError("ready local artifact must not contact the provider")

            def delete_artifact(self, **kwargs):
                raise AssertionError("local preview must not trigger remote cleanup")

        self.harness.httpd.app.notebooklm = UnavailableProvider()
        self.harness.httpd.app.study_job_runner.provider = self.harness.httpd.app.notebooklm
        self.assertEqual(json.loads(self.get(f"/study-artifacts/{dad_artifact_id}?profile=dad")[2])["artifact"],
                         artifact)
        self.assertEqual(self.get(f"/study-artifacts/{dad_artifact_id}/download?profile=dad")[2],
                         provider.artifact_data)

        data_dir = self.harness.data_dir
        book_dir = os.path.join(data_dir, "books", dad_book)
        # This snapshot includes the EPUB, chapters, NotebookRef, positions, and
        # any Book-owned annotation/highlight files. Person definitions live
        # separately, and neither boundary may be touched by artifact deletion.
        book_data_before = _tree_bytes(book_dir)
        profiles_before = _read_bytes(os.path.join(data_dir, "profiles.json"))
        status, _, body = self.harness.request(
            "DELETE", f"/study-artifacts/{dad_artifact_id}?profile=dad")
        self.assertEqual(status, 204, body)
        self.assertEqual(json.loads(self.get(f"/books/{dad_book}/study-artifacts?profile=dad")[2])["artifacts"], [])
        self.assertEqual(self.get(f"/study-artifacts/{dad_artifact_id}/download?profile=dad")[0], 404)
        self.assertEqual(_tree_bytes(book_dir), book_data_before)
        self.assertEqual(_read_bytes(os.path.join(data_dir, "profiles.json")), profiles_before)
        self.assertEqual(json.loads(self.get(f"/books/{dad_book}/study-artifacts?profile=mom")[2])["artifacts"][0]["id"],
                         mom_artifact_id)
        self.assertEqual(json.loads(self.get(f"/books/{other_book}/study-artifacts?profile=dad")[2])["artifacts"][0]["id"],
                         other_artifact_id)

    def test_invalid_artifact_never_becomes_ready_and_reconcile_recovers_idempotently(self):
        book_id = json.loads(self.upload()[2])["book"]["id"]
        self._sync(book_id)
        request = {
            "requestId": "study-job:artifact-interruption",
            "artifactType": "learning_report",
            "contextScope": {"scope": "chapter", "anchor": {"chapter": 0}},
        }
        initial_provider = _DeterministicNotebookLM()
        self.harness.httpd.app.study_job_runner.provider = initial_provider
        _, _, body = self.json_request(
            "POST", f"/books/{book_id}/study-jobs?profile=dad", {"request": request})
        job = json.loads(body)["job"]
        remote = {
            "provider": "notebooklm", "notebookId": "notebook-1",
            "sourceId": "source-1", "artifactId": "artifact-interrupted",
        }

        class InterruptedProvider:
            def __init__(self):
                self.calls = 0

            def reconcile_job(self, **kwargs):
                self.calls += 1
                data = b'{"summary":"recovered"}'
                return {
                    "state": "ready", "error": None, "remote": remote,
                    "artifact": {
                        "remoteArtifactId": remote["artifactId"], "contentType": "application/json",
                        "byteSize": len(data) if self.calls > 1 else 99,
                        "dataBase64": base64.b64encode(data).decode("ascii"), "remote": remote,
                    },
                }

        provider = InterruptedProvider()
        self.harness.httpd.app.study_job_runner.provider = provider
        status, _, body = self.json_request(
            "POST", f"/study-jobs/{job['id']}/reconcile?profile=dad", {})
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body)["error"], "artifact_download_failed")
        persisted = self.body(self.get(f"/study-jobs/{job['id']}?profile=dad"))["job"]
        self.assertEqual(persisted["state"], "downloading")
        self.assertIsNone(persisted.get("artifactId"))

        status, _, body = self.json_request(
            "POST", f"/study-jobs/{job['id']}/reconcile?profile=dad", {})
        self.assertEqual(status, 200, body)
        ready = json.loads(body)["job"]
        self.assertEqual(ready["state"], "ready")
        self.assertEqual(self.get(f"/study-artifacts/{ready['artifactId']}/download?profile=dad")[2],
                         b'{"summary":"recovered"}')
        artifact_count = len(json.loads(
            self.get(f"/books/{book_id}/study-artifacts?profile=dad")[2])["artifacts"])
        self.assertEqual(artifact_count, 1)

    def test_remote_cleanup_is_explicit_and_regeneration_keeps_the_prior_artifact(self):
        provider = _ArtifactNotebookLM([
            {"outcome": "not_found"},
            {"outcome": "partial", "error": "artifact_cleanup_failed"},
        ])
        self.harness.httpd.app.study_job_runner.provider = provider
        self.harness.httpd.app.notebooklm = provider
        book_id = json.loads(self.upload()[2])["book"]["id"]
        self._sync(book_id)
        first_id = self._ready_artifact("dad", book_id, "study-job:artifact-cleanup-1")
        second_id = self._ready_artifact("dad", book_id, "study-job:artifact-cleanup-2")

        status, _, body = self.json_request(
            "POST", f"/study-artifacts/{first_id}/remote-cleanup?profile=dad", {})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "bad_request")
        self.assertFalse(hasattr(provider, "cleanup_calls"))

        for artifact_id, expected in (
            (first_id, {"status": "not_found", "error": None}),
            (second_id, {"status": "partial", "error": "artifact_cleanup_failed"}),
        ):
            status, _, body = self.json_request(
                "POST", f"/study-artifacts/{artifact_id}/remote-cleanup?profile=dad", {"confirm": True})
            self.assertEqual(status, 200, body)
            result = json.loads(body)
            self.assertEqual(result["cleanup"], {**expected, "at": result["cleanup"]["at"]})
            self.assertEqual(result["artifact"]["status"], "ready")
            self.assertEqual(self.get(f"/study-artifacts/{artifact_id}/download?profile=dad")[0], 200)
        self.assertEqual([call["artifact_id"] for call in provider.cleanup_calls], [first_id, second_id])

        before_ids = {item["id"] for item in json.loads(
            self.get(f"/books/{book_id}/study-artifacts?profile=dad")[2])["artifacts"]}
        status, _, body = self.json_request(
            "POST", f"/study-artifacts/{first_id}/regenerate?profile=dad", {})
        self.assertEqual(status, 201, body)
        regenerated = json.loads(body)
        self.assertTrue(regenerated["created"])
        self.assertNotEqual(regenerated["job"]["id"], self.harness.httpd.app.study_artifacts.get(
            "dad", first_id)["jobId"])
        after = json.loads(self.get(f"/books/{book_id}/study-artifacts?profile=dad")[2])["artifacts"]
        self.assertTrue(before_ids.issubset({item["id"] for item in after}))
        self.assertEqual(self.get(f"/study-artifacts/{first_id}/download?profile=dad")[2], provider.artifact_data)


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

        class CleanupProvider:
            def __init__(self):
                self.calls = []

            def delete_notebook(self, **request):
                self.calls.append(request)
                return {"outcome": "unsupported", "error": "notebook_cleanup_unsupported"}

        cleanup_provider = CleanupProvider()
        self.harness.httpd.app.notebooklm = cleanup_provider
        status, _, body = self.json_request(
            "POST", f"/books/{book_id}/notebook-sync/remote-cleanup", {})
        self.assertEqual(status, 400)
        self.assertEqual(cleanup_provider.calls, [])
        status, _, body = self.json_request(
            "POST", f"/books/{book_id}/notebook-sync/remote-cleanup", {"confirm": True})
        self.assertEqual(status, 200, body)
        result = json.loads(body)
        self.assertEqual(result["cleanup"]["status"], "unsupported")
        self.assertIsNone(result["notebookRef"]["remoteDeletedAt"])
        self.assertEqual(cleanup_provider.calls, [{"notebook_id": "notebook-1", "source_id": "source-1"}])
        self.assertEqual(self.get(f"/books/{book_id}/chapters/0?profile=dad")[0], 200)


class TestStudyJobEndpoint(ApiTestCase):
    def _sync(self, book_id):
        self.harness.httpd.app.notebook_refs.ensure(book_id, "notebook-1", "source-1")

    def test_four_types_use_legal_scopes_confirmation_and_controlled_provenance(self):
        provider = _DeterministicNotebookLM()
        self.harness.httpd.app.study_job_runner.provider = provider
        book_id = json.loads(self.upload()[2])["book"]["id"]
        self._sync(book_id)
        cases = (
            ("learning_report", "chapter", {"chapter": 0}, False),
            ("mind_map", "book", {}, True),
            ("flashcard_set", "selection", {"start": 0, "end": 1, "chapter": 0}, False),
            ("audio_explanation", "chapter", {"chapter": 0}, False),
        )
        for index, (artifact_type, scope, anchor, confirm) in enumerate(cases):
            request = {
                "requestId": f"study-job:api-{artifact_type}",
                "artifactType": artifact_type,
                "contextScope": {"scope": scope, "anchor": anchor},
            }
            path = f"/books/{book_id}/study-jobs?profile=dad"
            status, _, body = self.json_request(
                "POST", path, {"request": request, "confirmWholeBook": confirm})
            if confirm:
                unconfirmed_status, _, unconfirmed_body = self.json_request(
                    "POST", path, {"request": dict(request, requestId=request["requestId"] + "-unconfirmed")})
                self.assertEqual(unconfirmed_status, 400)
                self.assertEqual(json.loads(unconfirmed_body)["error"], "cloud_confirmation_required")
            self.assertEqual(status, 201, body)
            job = json.loads(body)["job"]
            self.assertEqual(job["artifactType"], artifact_type)
            self.assertEqual(job["contextScope"]["scope"], scope)
            self.assertEqual(job["state"], "waiting_remote")
            self.assertEqual(job["remoteProvenance"], {
                "provider": "notebooklm", "notebookId": "notebook-1",
                "sourceId": "source-1", "artifactId": f"artifact-{index}",
            })
            self.assertTrue(job["request"]["context"]["text"])
            self.assertEqual(provider.job_calls[index]["context_scope"]["scope"], scope)

        invalid = self.json_request("POST", f"/books/{book_id}/study-jobs?profile=dad", {
            "request": {"artifactType": "learning_report", "requestId": "study-job:invalid",
                        "contextScope": {"scope": "selection", "anchor": {}}},
        })
        self.assertEqual(invalid[0], 400)
        self.assertEqual(json.loads(invalid[2])["error"], "bad_request")

    def test_job_identity_position_and_person_data_are_unchanged(self):
        provider = _DeterministicNotebookLM()
        self.harness.httpd.app.study_job_runner.provider = provider
        book_id = json.loads(self.upload()[2])["book"]["id"]
        self._sync(book_id)
        status, _, _ = self.json_request(
            "PUT", f"/books/{book_id}/position?profile=dad", {"chapter": 0, "sentence": 0})
        self.assertEqual(status, 204)
        before_book = self.get(f"/books/{book_id}?profile=dad")[2]
        before_profiles = self.get("/profiles")[2]
        request = {
            "requestId": "study-job:stable-76", "artifactType": "flashcard_set",
            "contextScope": {"scope": "selection", "anchor": {"chapter": 0, "start": 0, "end": 1}},
        }
        path = f"/books/{book_id}/study-jobs?profile=dad"
        status, _, body = self.json_request("POST", path, {"request": request})
        self.assertEqual(status, 201)
        job = json.loads(body)["job"]
        repeated = self.json_request("POST", path, {"request": request})
        self.assertEqual(repeated[0], 200)
        self.assertEqual(json.loads(repeated[2])["job"]["id"], job["id"])
        self.assertEqual(len(provider.job_calls), 1)
        self.assertEqual(self.get(f"/books/{book_id}?profile=dad")[2], before_book)
        self.assertEqual(self.get("/profiles")[2], before_profiles)

        status, _, body = self.json_request("POST", f"/study-jobs/{job['id']}/reconcile?profile=dad", {})
        self.assertEqual(status, 200)
        ready = json.loads(body)["job"]
        self.assertEqual(ready["state"], "ready")
        self.assertEqual(ready["artifactResult"]["remote"]["artifactId"], "artifact-0")
        self.assertEqual(self.get(f"/books/{book_id}?profile=dad")[2], before_book)

    def test_job_actions_map_failures_and_preserve_local_read(self):
        provider = _DeterministicNotebookLM()
        self.harness.httpd.app.study_job_runner.provider = provider
        book_id = json.loads(self.upload()[2])["book"]["id"]
        self._sync(book_id)
        request = {
            "requestId": "study-job:api-failure-1",
            "artifactType": "learning_report",
            "contextScope": {"scope": "chapter", "anchor": {"chapter": 0}},
        }
        _, _, body = self.json_request(
            "POST", f"/books/{book_id}/study-jobs?profile=dad", {"request": request})
        job = json.loads(body)["job"]
        self.harness.httpd.app.study_jobs.transition(
            "dad", job["id"], "failed", error="notebooklm_unavailable")

        class FailedProvider:
            def __init__(self):
                self.request_ids = []

            def job_request(self, **kwargs):
                self.request_ids.append(kwargs["request_id"])
                return {"state": "failed", "error": "notebooklm_unavailable", "artifact": None}

        failed_provider = FailedProvider()
        self.harness.httpd.app.study_job_runner.provider = failed_provider
        status, _, body = self.json_request(
            "POST", f"/study-jobs/{job['id']}/retry?profile=dad", {})
        self.assertEqual(status, 200)
        result = json.loads(body)["job"]
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["error"], "notebooklm_unavailable")
        self.assertEqual(failed_provider.request_ids, [result["requestId"]])
        self.assertNotEqual(result["requestId"], job["requestId"])
        self.assertNotIn("rawUpstream", body.decode("utf-8"))
        self.assertEqual(self.get(f"/books/{book_id}/chapters/0?profile=dad")[0], 200)

        self.harness.httpd.app.study_job_runner.provider = _DeterministicNotebookLM()
        unknown_request = dict(request, requestId="study-job:api-unknown-1")
        _, _, body = self.json_request(
            "POST", f"/books/{book_id}/study-jobs?profile=dad",
            {"request": unknown_request})
        unknown_job = json.loads(body)["job"]
        self.harness.httpd.app.study_jobs.transition(
            "dad", unknown_job["id"], "unknown", error="notebooklm_job_unknown")

        class UnknownProvider:
            def __init__(self):
                self.submits = 0
                self.rechecks = 0

            def job_request(self, **kwargs):
                self.submits += 1
                return {"state": "waiting_remote", "error": None, "artifact": None, "remote": {
                    "provider": "notebooklm", "notebookId": "notebook-1",
                    "sourceId": "source-1", "artifactId": "artifact-retry",
                }}

            def reconcile_job(self, **kwargs):
                self.rechecks += 1
                remote = kwargs["remote_provenance"]
                data = b"unknown reconciled"
                return {"state": "ready", "error": None, "remote": remote, "artifact": {
                    "remoteArtifactId": remote["artifactId"], "contentType": "text/plain",
                    "byteSize": len(data), "dataBase64": base64.b64encode(data).decode("ascii"),
                    "remote": remote,
                }}

        unknown_provider = UnknownProvider()
        self.harness.httpd.app.study_job_runner.provider = unknown_provider
        status, _, body = self.json_request(
            "POST", f"/study-jobs/{unknown_job['id']}/recheck?profile=dad", {})
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["job"]["state"], "ready")
        self.assertEqual((unknown_provider.rechecks, unknown_provider.submits), (1, 0))

        invalid_provider = type("InvalidProvider", (), {
            "job_request": lambda self, **kwargs: {
                "state": "ready", "error": None, "artifact": {"raw": "upstream secret"},
            },
        })()
        retry_request = dict(request, requestId="study-job:api-invalid-1")
        _, _, body = self.json_request(
            "POST", f"/books/{book_id}/study-jobs?profile=dad",
            {"request": retry_request})
        invalid_job = json.loads(body)["job"]
        self.harness.httpd.app.study_jobs.transition(
            "dad", invalid_job["id"], "failed", error="notebooklm_unavailable")
        self.harness.httpd.app.study_job_runner.provider = invalid_provider
        status, _, body = self.json_request(
            "POST", f"/study-jobs/{invalid_job['id']}/retry?profile=dad", {})
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body), {"error": "notebooklm_job_unknown"})
        self.assertNotIn("upstream secret", body.decode("utf-8"))


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
