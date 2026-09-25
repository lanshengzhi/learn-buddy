import json
import os
import shutil
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

import textseg
from book_ai import NotebookRefs, NotebookSync
from library import ApiError, Library
from notebooklm_host import NotebookLMProxy
from notebooklm_worker import NotebookLMWorkerApp, NotebookLMWorkerHandler, WorkerServer


class FakeWorkerHandler(NotebookLMWorkerHandler):
    pass


FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def _fixture(name):
    with open(os.path.join(FIXTURES, name), "rb") as handle:
        return handle.read()


class DeterministicProvider:
    def __init__(self, outcomes=None):
        self.outcomes = list(outcomes or [{"outcome": "confirmed", "notebookId": "nb-1", "sourceId": "src-1"}])
        self.calls = []

    def sync_epub(self, *, notebook_title, file_path, file_name):
        with open(file_path, "rb") as handle:
            self.calls.append({"title": notebook_title, "fileName": file_name, "data": handle.read()})
        return dict(self.outcomes.pop(0) if len(self.outcomes) > 1 else self.outcomes[0])


class TestNotebookLMProxy(unittest.TestCase):
    def test_safe_status_and_no_credentials(self):
        responses = {
            "http://127.0.0.1:8124/health": {
                "service": "notebooklm",
                "configured": True,
                "status": "ok",
                # A malicious/accidental worker must not be allowed to widen
                # the host contract with secrets.
                "cookie": "SID=secret",
                "token": "master-secret",
                "profile": "/var/lib/private/profile",
            }
        }

        def urlopen(request, timeout):
            payload = responses[request.full_url]
            return _Response(payload)

        proxy = NotebookLMProxy(url="http://127.0.0.1:8124", urlopen=urlopen)
        status = proxy.status()
        self.assertEqual(status, {
            "provider": "notebooklm",
            "configured": True,
            "available": True,
            "status": "configured",
        })
        self.assertNotIn("secret", json.dumps(status))

    def test_missing_worker_is_safe_not_configured_or_unavailable(self):
        proxy = NotebookLMProxy(url="", urlopen=lambda request, timeout: self.fail("must not call"))
        self.assertEqual(proxy.status()["error"], "notebooklm_not_configured")

        proxy = NotebookLMProxy(url="http://127.0.0.1:8124", urlopen=_connection_error)
        self.assertEqual(proxy.status()["error"], "notebooklm_unavailable")
        self.assertEqual(proxy.status()["status"], "unavailable")

    def test_non_loopback_worker_url_is_not_configured(self):
        proxy = NotebookLMProxy(url="http://192.0.2.10:8124", urlopen=lambda request, timeout: self.fail("must not call"))
        self.assertEqual(proxy.status()["error"], "notebooklm_not_configured")


class _Response:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def read(self):
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _connection_error(request, timeout):
    raise OSError("worker is stopped")


class TestNotebookLMSyncBoundary(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.library = Library(self.root, ja_tokenizer=textseg.tokenize_rule, now=lambda: 1000.0)
        self.book_id = self.library.add_book("dad", "nav.epub", _fixture("nav.epub"))[1]["book"]["id"]
        self.provider = DeterministicProvider()
        storage = os.path.join(self.root, "storage_state.json")
        with open(storage, "w", encoding="utf-8") as handle:
            handle.write("{}")
        self.worker = WorkerServer(("127.0.0.1", 0), NotebookLMWorkerHandler,
                                   NotebookLMWorkerApp(storage_path=storage, provider=self.provider))
        self.thread = threading.Thread(target=self.worker.serve_forever, daemon=True)
        self.thread.start()
        self.proxy = NotebookLMProxy(url=f"http://127.0.0.1:{self.worker.server_address[1]}")
        self.refs = NotebookRefs(self.root, self.library.require_book, now=lambda: 1000.0)
        self.sync = NotebookSync(self.library, self.refs, self.proxy)

    def tearDown(self):
        self.worker.shutdown()
        self.worker.server_close()
        shutil.rmtree(self.root, ignore_errors=True)

    def test_import_and_read_do_not_upload_and_explicit_sync_is_idempotent(self):
        self.library.get_book(self.book_id)
        self.library.get_chapter(self.book_id, 0, "dad")
        self.assertEqual(self.provider.calls, [])
        with self.assertRaises(ApiError) as caught:
            self.sync.sync(self.book_id)
        self.assertEqual(caught.exception.code, "cloud_confirmation_required")
        self.assertEqual(self.provider.calls, [])

        first = self.sync.sync(self.book_id, confirm_upload=True)
        self.assertEqual(first["notebookRef"]["bookContentHash"], self.book_id)
        self.assertEqual(first["notebookRef"]["uploadStatus"], "uploaded")
        self.assertEqual(first["notebookRef"]["syncStatus"], "synced")
        self.assertEqual(len(self.provider.calls), 1)
        self.assertEqual(self.provider.calls[0]["data"], self.library.epub_data(self.book_id))

        repeated = self.sync.sync(self.book_id, confirm_upload=True)
        self.assertTrue(repeated["reused"])
        self.assertEqual(repeated["notebookRef"]["sourceId"], "src-1")
        self.assertEqual(len(self.provider.calls), 1)

    def test_unknown_mutation_is_not_resubmitted_and_local_read_survives(self):
        self.provider.outcomes = [{"outcome": "unknown", "error": "notebooklm_mutation_unknown"}]
        first = self.sync.sync(self.book_id, confirm_upload=True)
        self.assertEqual(first["notebookRef"]["mutationStatus"], "unknown")
        self.assertEqual(first["notebookRef"]["deletionStatus"], {"local": "active", "remote": "active"})
        repeated = self.sync.sync(self.book_id, confirm_upload=True, retry=True)
        self.assertTrue(repeated["reused"])
        self.assertEqual(repeated["blockedReason"], "notebooklm_mutation_unknown")
        self.assertEqual(len(self.provider.calls), 1)
        self.refs.delete_remote(self.book_id)
        self.assertEqual(self.library.get_book(self.book_id)["book"]["id"], self.book_id)

    def test_changed_content_is_a_new_explicit_sync_decision(self):
        self.sync.sync(self.book_id, confirm_upload=True)
        second_id = self.library.add_book("dad", "ncx.epub", _fixture("ncx.epub"))[1]["book"]["id"]
        self.assertNotEqual(second_id, self.book_id)
        self.assertIsNone(self.refs.get(second_id))
        self.sync.sync(second_id, confirm_upload=True)
        self.assertEqual(len(self.provider.calls), 2)
        self.assertEqual(self.refs.get(self.book_id)["bookId"], self.book_id)
        self.assertEqual(self.refs.get(second_id)["bookId"], second_id)


class TestNotebookLMWorker(unittest.TestCase):
    def test_worker_health_exposes_only_safe_status(self):
        root = tempfile.mkdtemp()
        try:
            storage = os.path.join(root, "storage_state.json")
            with open(storage, "w", encoding="utf-8") as handle:
                handle.write('{"cookies": "do-not-leak"}')
            app = NotebookLMWorkerApp(storage_path=storage, token_path=os.path.join(root, "missing.json"))
            httpd = WorkerServer(("127.0.0.1", 0), NotebookLMWorkerHandler, app)
            import threading
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                import urllib.request
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{httpd.server_address[1]}/health", timeout=2
                ) as response:
                    status = response.status
                    payload = json.loads(response.read())
            finally:
                httpd.shutdown()
                httpd.server_close()
            self.assertEqual(status, 200)
            self.assertEqual(payload, {
                "service": "notebooklm",
                "configured": True,
                "status": "ok",
            })
            self.assertNotIn("do-not-leak", json.dumps(payload))
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_worker_is_disabled_when_no_credentials_exist(self):
        app = NotebookLMWorkerApp(storage_path="/missing/storage_state.json", token_path="/missing/master_token.json")
        self.assertEqual(app.status()["configured"], False)


if __name__ == "__main__":
    unittest.main()
