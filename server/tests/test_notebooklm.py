import base64
import json
import os
import shutil
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock
from http.server import ThreadingHTTPServer

import textseg
from book_ai import NotebookRefs, NotebookSync, StudyJobs
from library import ApiError, Library
from notebooklm_host import NotebookLMProxy
from notebooklm_worker import (
    NotebookLMJobProvider, NotebookLMWorkerApp, NotebookLMWorkerHandler, WorkerServer,
)


class FakeWorkerHandler(NotebookLMWorkerHandler):
    pass


FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def _fixture(name):
    with open(os.path.join(FIXTURES, name), "rb") as handle:
        return handle.read()


class DeterministicJobProvider:
    def __init__(self, result, sequence=None, cleanup_outcomes=None):
        self.result = dict(result)
        self.sequence = list(sequence or [])
        self.cleanup_outcomes = list(cleanup_outcomes or [])
        self.calls = []

    def _next(self):
        return dict(self.sequence.pop(0) if self.sequence else self.result)

    def start_job(self, **request):
        self.calls.append(dict(request))
        return self._next()

    def reconcile_job(self, **request):
        self.calls.append({"reconcile": dict(request)})
        return self._next()

    def cancel_job(self, **request):
        self.calls.append({"cancel": dict(request)})
        return {"state": "cancelled"}

    def delete_artifact(self, **request):
        self.calls.append({"delete_artifact": dict(request)})
        return dict(self.cleanup_outcomes.pop(0))


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

    def test_job_protocol_returns_only_fixed_controlled_result(self):
        calls = []
        request_identity = {
            "jobId": "job-1", "requestId": "study-job:stable-1", "personId": "dad",
            "bookId": "a" * 64, "bookContentHash": "a" * 64,
        }

        remote = {"provider": "notebooklm", "notebookId": "notebook-1",
                  "sourceId": "source-1", "artifactId": "artifact-1"}

        def urlopen(request, timeout):
            calls.append(request)
            return _Response({
                "service": "notebooklm", **request_identity, "state": "ready",
                "remote": remote,
                "artifact": {
                    "remoteArtifactId": "artifact-1", "contentType": "text/plain",
                    "byteSize": 12, "remote": remote, "rawUpstreamBody": "must-not-leak",
                },
            })

        proxy = NotebookLMProxy(url="http://127.0.0.1:8124", urlopen=urlopen)
        result = proxy.job_request(
            job_id=request_identity["jobId"], request_id=request_identity["requestId"],
            book_id=request_identity["bookId"], content_hash=request_identity["bookContentHash"],
            person_id=request_identity["personId"], artifact_type="learning_report",
            context_scope={"scope": "chapter"}, context_text="chapter text",
            notebook_id="notebook-1", source_id="source-1")
        self.assertEqual(result["state"], "ready")
        self.assertNotIn("rawUpstreamBody", result["artifact"])
        self.assertEqual(calls[0].full_url, "http://127.0.0.1:8124/operations/study-jobs")

    def test_job_transport_loss_and_invalid_result_are_unknown(self):
        identity = {
            "job_id": "job-1", "request_id": "study-job:stable-1", "book_id": "a" * 64,
            "content_hash": "a" * 64, "person_id": "dad",
        }
        proxy = NotebookLMProxy(url="http://127.0.0.1:8124", urlopen=_connection_error)
        with self.assertRaises(LookupError) as caught:
            proxy.job_request(**identity, artifact_type="learning_report", context_scope={})
        self.assertEqual(caught.exception.outcome, "unknown")
        self.assertEqual(caught.exception.code, "notebooklm_job_unknown")

        proxy = NotebookLMProxy(url="http://127.0.0.1:8124", urlopen=lambda request, timeout: _Response({
            "service": "notebooklm", **{
                "jobId": identity["job_id"], "requestId": identity["request_id"],
                "personId": identity["person_id"], "bookId": identity["book_id"],
                "bookContentHash": identity["content_hash"],
            }, "state": "ready", "artifact": {"raw": "uncontrolled"},
        }))
        with self.assertRaises(LookupError) as caught:
            proxy.job_request(**identity, artifact_type="learning_report", context_scope={})
        self.assertEqual(caught.exception.outcome, "unknown")
        self.assertEqual(caught.exception.code, "notebooklm_job_unknown")


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


class TestStudyJobRunner(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.library = Library(self.root, ja_tokenizer=textseg.tokenize_rule, now=lambda: 1000.0)
        self.book_id = self.library.add_book("dad", "nav.epub", _fixture("nav.epub"))[1]["book"]["id"]
        self.jobs = StudyJobs(self.root, self.library.require_profile,
                              self.library.require_book, now=lambda: 1000.0)
        self.refs = NotebookRefs(self.root, self.library.require_book, now=lambda: 1000.0)
        self.refs.ensure(self.book_id, "notebook-1", "source-1")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_illegal_scope_and_unconfirmed_whole_book_never_reach_provider(self):
        from book_ai import StudyJobRunner
        from book_context import BookContextCompiler

        provider = DeterministicJobProvider({"state": "waiting_remote"})
        runner = StudyJobRunner(
            self.library, BookContextCompiler(self.library), self.jobs, self.refs, provider)
        with self.assertRaises(ApiError) as caught:
            runner.create("dad", self.book_id, {
                "requestId": "bad-scope", "artifactType": "audio_explanation",
                "contextScope": {"scope": "selection", "anchor": {"start": 0, "end": 1}},
            })
        self.assertEqual(caught.exception.code, "bad_request")
        with self.assertRaises(ApiError) as caught:
            runner.create("dad", self.book_id, {
                "requestId": "book-no-confirm", "artifactType": "learning_report",
                "contextScope": {"scope": "book", "anchor": {}},
            })
        self.assertEqual(caught.exception.code, "cloud_confirmation_required")
        self.assertEqual(provider.calls, [])


class TestStudyJobStateMachine(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.library = Library(self.root, ja_tokenizer=textseg.tokenize_rule, now=lambda: 1000.0)
        self.book_id = self.library.add_book("dad", "nav.epub", _fixture("nav.epub"))[1]["book"]["id"]
        self.jobs = StudyJobs(self.root, self.library.require_profile,
                              self.library.require_book, now=lambda: 1000.0)
        self.request = {
            "requestId": "study-job:stable-1",
            "personId": "dad",
            "bookId": self.book_id,
            "bookContentHash": self.book_id,
            "artifactType": "learning_report",
            "contextScope": {"scope": "chapter", "anchor": {"chapter": 0}},
        }

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def create(self):
        return self.jobs.create("dad", self.book_id, dict(self.request))["job"]

    def test_durable_identity_and_state_history_survive_restart(self):
        first = self.create()
        restarted = StudyJobs(self.root, self.library.require_profile, self.library.require_book)
        repeated = restarted.create("dad", self.book_id, dict(self.request))
        self.assertFalse(repeated["created"])
        self.assertEqual(repeated["job"]["id"], first["id"])
        for state in ("preparing", "uploading", "waiting_remote", "downloading"):
            self.jobs.transition("dad", first["id"], state)
        job = StudyJobs(self.root, self.library.require_profile, self.library.require_book).get(
            "dad", first["id"])
        self.assertEqual([item["to"] for item in job["history"]],
                         ["queued", "preparing", "uploading", "waiting_remote", "downloading"])
        self.assertFalse(job["terminal"])
        remote = {"provider": "notebooklm", "notebookId": "notebook-1",
                  "sourceId": "source-1", "artifactId": "artifact-1"}
        self.assertEqual(
            self.jobs.transition("dad", first["id"], "ready",
                                 artifact_result={"remoteArtifactId": "artifact-1", "remote": remote},
                                 remote_provenance=remote)["successful"],
            True)

    def test_all_terminal_states_and_fixed_errors_are_validated(self):
        first = self.create()
        self.jobs.transition("dad", first["id"], "not_configured")
        for state, error in (
            ("failed", "notebooklm_auth_required"),
            ("failed", "notebooklm_unavailable"),
            ("failed", "notebooklm_quota"),
            ("failed", "notebooklm_source_rejected"),
            ("failed", "artifact_download_failed"),
            ("unknown", "notebooklm_job_unknown"),
            ("cancelled", None),
        ):
            request = dict(self.request, requestId=f"{self.request['requestId']}:{state}:{error}")
            job = self.jobs.create("dad", self.book_id, request)["job"]
            if state == "failed":
                updated = self.jobs.transition("dad", job["id"], "failed", error=error)
            elif state == "unknown":
                updated = self.jobs.transition("dad", job["id"], "preparing")
                updated = self.jobs.transition("dad", job["id"], "unknown", error=error)
            else:
                updated = self.jobs.cancel("dad", job["id"])
            self.assertEqual(updated["state"], state)
            self.assertEqual(updated["error"], error)
            self.assertTrue(updated["terminal"])
        invalid = self.jobs.create("dad", self.book_id, dict(
            self.request, requestId="study-job:invalid-error"))["job"]
        with self.assertRaises(ApiError) as caught:
            self.jobs.transition("dad", invalid["id"], "failed", error="raw_upstream_secret")
        self.assertEqual(caught.exception.code, "bad_request")

    def test_not_configured_state_and_error_are_fixed(self):
        job = self.create()
        not_configured = self.jobs.transition("dad", job["id"], "not_configured")
        self.assertEqual(not_configured["state"], "not_configured")
        self.assertEqual(not_configured["error"], "notebooklm_not_configured")
        self.assertTrue(not_configured["terminal"])

    def test_only_ready_publishes_an_artifact_and_invalid_transitions_fail(self):
        job = self.create()
        with self.assertRaises(ApiError):
            self.jobs.transition("dad", job["id"], "downloading")
        with self.assertRaises(ApiError):
            self.jobs.transition("dad", job["id"], "preparing",
                                 artifact_result={"remoteArtifactId": "remote-1"})
        with self.assertRaises(ApiError):
            self.jobs.transition("dad", job["id"], "ready")
        self.jobs.transition("dad", job["id"], "preparing")
        self.jobs.transition("dad", job["id"], "uploading")
        self.jobs.transition("dad", job["id"], "waiting_remote")
        self.jobs.transition("dad", job["id"], "downloading")
        remote = {"provider": "notebooklm", "notebookId": "notebook-1",
                  "sourceId": "source-1", "artifactId": "remote-1"}
        ready = self.jobs.transition(
            "dad", job["id"], "ready",
            artifact_result={"remoteArtifactId": "remote-1", "remote": remote},
            remote_provenance=remote)
        self.assertTrue(ready["successful"])
        self.assertEqual(ready["artifactResult"]["remoteArtifactId"], "remote-1")

    def test_unknown_cancel_stays_unknown_and_never_resubmits(self):
        job = self.create()
        self.jobs.transition("dad", job["id"], "preparing")
        unknown = self.jobs.transition(
            "dad", job["id"], "unknown", error="notebooklm_job_unknown")
        cancelled = self.jobs.cancel("dad", job["id"])
        self.assertEqual(cancelled["state"], "unknown")
        self.assertFalse(cancelled["cancelled"])
        self.assertIsNotNone(cancelled["cancelRequestedAt"])
        self.assertEqual(cancelled["error"], unknown["error"])
        repeated = self.jobs.create("dad", self.book_id, dict(self.request))
        self.assertEqual(repeated["job"]["state"], "unknown")
        self.assertEqual(repeated["job"]["requestId"], job["requestId"])


class _FakeNotebookLMContext:
    def __init__(self, client):
        self.client = client

    async def __aenter__(self):
        return self.client

    async def __aexit__(self, *args):
        return False


class _FakeNotebookLMClient:
    calls = []

    @classmethod
    def from_storage(cls, profile=None):
        return _FakeNotebookLMContext(cls())

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def _record(self, name, **kwargs):
        self.calls.append({"name": name, **kwargs})

    @property
    def sources(self):
        return self

    @property
    def artifacts(self):
        return self

    @property
    def mind_maps(self):
        return self

    async def add_text(self, notebook_id, title, content, wait=True, idempotent=False):
        self._record("add_text", notebook_id=notebook_id, title=title, content=content,
                      wait=wait, idempotent=idempotent)
        return types.SimpleNamespace(id="scope-source-1")

    async def generate_study_guide(self, notebook_id, source_ids=None):
        self._record("generate_study_guide", notebook_id=notebook_id, source_ids=source_ids)
        return types.SimpleNamespace(task_id="report-1")

    async def generate_flashcards(self, notebook_id, source_ids=None):
        self._record("generate_flashcards", notebook_id=notebook_id, source_ids=source_ids)
        return types.SimpleNamespace(task_id="flashcards-1")

    async def generate_audio(self, notebook_id, source_ids=None):
        self._record("generate_audio", notebook_id=notebook_id, source_ids=source_ids)
        return types.SimpleNamespace(task_id="audio-1")

    async def generate(self, notebook_id, source_ids=None, kind=None, wait=True):
        self._record("generate_mind_map", notebook_id=notebook_id, source_ids=source_ids,
                      kind=kind, wait=wait)
        return types.SimpleNamespace(id="mind-map-1")

    async def poll_status(self, notebook_id, artifact_id):
        self._record("poll_status", notebook_id=notebook_id, artifact_id=artifact_id)
        return types.SimpleNamespace(is_complete=True, is_failed=False)

    async def _download(self, method, notebook_id, path, artifact_id):
        self._record(method, notebook_id=notebook_id, path=path, artifact_id=artifact_id)
        with open(path, "wb") as handle:
            handle.write(b"artifact")

    async def download_report(self, notebook_id, path, artifact_id):
        await self._download("download_report", notebook_id, path, artifact_id)

    async def download_mind_map(self, notebook_id, path, artifact_id):
        await self._download("download_mind_map", notebook_id, path, artifact_id)

    async def download_flashcards(self, notebook_id, path, artifact_id, output_format="json"):
        self._record("download_flashcards", notebook_id=notebook_id, path=path,
                      artifact_id=artifact_id, output_format=output_format)
        with open(path, "wb") as handle:
            handle.write(b"artifact")

    async def download_audio(self, notebook_id, path, artifact_id):
        await self._download("download_audio", notebook_id, path, artifact_id)


class TestNotebookLMJobProvider(unittest.TestCase):
    def test_all_four_types_use_the_documented_082_calls(self):
        fake = types.SimpleNamespace(
            NotebookLMClient=_FakeNotebookLMClient,
            MindMapKind=types.SimpleNamespace(INTERACTIVE="interactive"),
        )
        provider = NotebookLMJobProvider()
        generation_names = {
            "learning_report": "generate_study_guide",
            "mind_map": "generate_mind_map",
            "flashcard_set": "generate_flashcards",
            "audio_explanation": "generate_audio",
        }
        download_names = {
            "learning_report": "download_report",
            "mind_map": "download_mind_map",
            "flashcard_set": "download_flashcards",
            "audio_explanation": "download_audio",
        }
        for artifact_type in generation_names:
            _FakeNotebookLMClient.calls = []
            request = {
                "personId": "dad", "requestId": f"request-{artifact_type}",
                "bookId": "a" * 64, "bookContentHash": "a" * 64,
                "artifactType": artifact_type, "notebookId": "notebook-1", "sourceId": "source-1",
                "contextScope": {"scope": "chapter"}, "contextText": "bounded chapter text",
            }
            with mock.patch.dict(sys.modules, {"notebooklm": fake}):
                started = provider.start_job(**request)
                request["remoteProvenance"] = started["remote"]
                ready = provider.reconcile_job(**request)
            self.assertEqual(started["state"], "waiting_remote")
            self.assertEqual(ready["state"], "ready")
            self.assertEqual(ready["artifact"]["byteSize"], 8)
            self.assertEqual(base64.b64decode(ready["artifact"]["dataBase64"]), b"artifact")
            self.assertEqual(ready["remote"]["sourceId"], "source-1")
            self.assertEqual(ready["remote"]["scopeSourceId"], "scope-source-1")
            names = [call["name"] for call in _FakeNotebookLMClient.calls]
            self.assertEqual(names[0:2], ["add_text", generation_names[artifact_type]])
            self.assertEqual(names[-2:], ["poll_status", download_names[artifact_type]])
            add_text = _FakeNotebookLMClient.calls[0]
            self.assertTrue(add_text["wait"])
            self.assertTrue(add_text["idempotent"])


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

    def test_worker_reports_explicit_cleanup_outcomes_without_deleting_local_data(self):
        remote = {"provider": "notebooklm", "notebookId": "notebook-1",
                  "sourceId": "source-1", "artifactId": "remote-1"}
        provider = DeterministicJobProvider(
            {"state": "cancelled", "error": None, "artifact": None},
            cleanup_outcomes=[
                {"outcome": "not_found"},
                {"outcome": "partial", "error": "artifact_cleanup_failed"},
            ],
        )
        app = NotebookLMWorkerApp(job_provider=provider)
        for artifact_id, expected in (
            ("artifact-local-1", {"outcome": "not_found"}),
            ("artifact-local-2", {"outcome": "partial", "error": "artifact_cleanup_failed"}),
        ):
            result = app.delete_artifact({
                "service": "notebooklm", "artifactId": artifact_id, "remote": remote,
            })
            self.assertEqual(result, expected)
            self.assertEqual(provider.calls[-1]["delete_artifact"], {
                "service": "notebooklm", "artifactId": artifact_id, "remote": remote,
            })

    def test_worker_protocol_reconciles_identity_and_explicitly_cancels(self):
        root = tempfile.mkdtemp()
        try:
            storage = os.path.join(root, "storage_state.json")
            with open(storage, "w", encoding="utf-8") as handle:
                handle.write("{}")
            remote = {"provider": "notebooklm", "notebookId": "notebook-1",
                      "sourceId": "source-1", "artifactId": "artifact-1"}
            provider = DeterministicJobProvider({
                "state": "ready", "error": None, "remote": remote,
                "artifact": {"remoteArtifactId": "artifact-1", "contentType": "text/plain",
                             "byteSize": 12, "remote": remote},
            })
            app = NotebookLMWorkerApp(storage_path=storage, provider=DeterministicProvider(),
                                      job_provider=provider)
            request = {
                "jobId": "job-1", "requestId": "study-job:stable-1", "personId": "dad",
                "bookId": "a" * 64, "bookContentHash": "a" * 64,
                "artifactType": "learning_report", "contextScope": {"scope": "chapter"},
                "notebookId": "notebook-1", "sourceId": "source-1", "contextText": "chapter text",
            }
            first = app.submit_job(request)
            repeated = app.submit_job(request)
            self.assertEqual(first["state"], "ready")
            self.assertEqual(repeated, first)
            self.assertEqual(len(provider.calls), 1)
            self.assertEqual(repeated["artifact"]["remoteArtifactId"], "artifact-1")
            restarted_app = NotebookLMWorkerApp(storage_path=storage, provider=DeterministicProvider(),
                                                job_provider=provider)
            reconcile_request = dict(request, remoteProvenance=remote)
            restarted = restarted_app.reconcile_job(reconcile_request)
            self.assertEqual(restarted, first)
            self.assertEqual(provider.calls[-1]["reconcile"]["requestId"], "study-job:stable-1")
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
