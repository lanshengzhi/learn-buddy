import json
import os
import shutil
import tempfile
import unittest
from http.server import ThreadingHTTPServer

from notebooklm_host import NotebookLMProxy
from notebooklm_worker import NotebookLMWorkerApp, NotebookLMWorkerHandler, WorkerServer


class FakeWorkerHandler(NotebookLMWorkerHandler):
    pass


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
