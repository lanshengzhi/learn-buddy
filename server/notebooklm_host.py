"""Safe host boundary for the optional NotebookLM worker.

The NotebookLM process owns its profile and credentials. This module only
performs a loopback health check and returns a small, credential-free DTO.
It deliberately does not import notebooklm-py into the LearnBuddy host.
"""

import ipaddress
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = ""
STATUS_TIMEOUT_SECONDS = 2
OPERATION_TIMEOUT_SECONDS = 180
_OPERATION_PATH = "/operations/sync-book"
_JOB_PATH = "/operations/study-jobs"
_SAFE_ERROR_RE = re.compile(r"[a-z0-9_]{1,64}")
_JOB_STATES = {
    "not_configured", "queued", "preparing", "uploading", "waiting_remote",
    "downloading", "ready", "failed", "unknown", "cancelled",
}
_JOB_ERRORS = {
    "notebooklm_not_configured", "notebooklm_auth_required", "notebooklm_unavailable",
    "notebooklm_quota", "notebooklm_source_rejected", "notebooklm_job_unknown",
    "artifact_download_failed",
}


class NotebookLMProxy:
    """Proxy the worker's safe status, never its private configuration."""

    def __init__(self, url=None, timeout=STATUS_TIMEOUT_SECONDS, urlopen=None,
                 operation_timeout=OPERATION_TIMEOUT_SECONDS):
        self.url = os.environ.get("LEARNBUDDY_NOTEBOOKLM_URL", DEFAULT_URL) if url is None else url
        self.timeout = timeout
        self.operation_timeout = operation_timeout
        self._urlopen = urlopen or urllib.request.urlopen

    def status(self):
        """Return ``{provider, configured, available, error?}`` safely.

        Missing configuration and a stopped worker are deliberately distinct,
        but both are ordinary status responses. No URL, profile path, cookie,
        token, or upstream response is ever included.
        """
        if not self.url:
            return _status("notebooklm_not_configured")
        try:
            self._validate_url()
        except ValueError:
            return _status("notebooklm_not_configured")
        request = urllib.request.Request(self.url.rstrip("/") + "/health", method="GET")
        try:
            with self._urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, UnicodeDecodeError):
            return _status("notebooklm_unavailable")
        if not isinstance(payload, dict) or payload.get("service") != "notebooklm":
            return _status("notebooklm_unavailable")
        configured = payload.get("configured") is True
        return {
            "provider": "notebooklm",
            "configured": configured,
            "available": True,
            "status": "configured" if configured else "not_configured",
            **({} if configured else {"error": "notebooklm_not_configured"}),
        }

    def sync_source(self, *, book_id, content_hash, title, file_name, request_id, data):
        """Submit one explicit EPUB mutation to the private worker.

        The response is deliberately narrow and validated. A transport loss is
        classified as an unknown mutation because the worker may have committed
        before the host lost its response.
        """
        if not self.url:
            raise NotebookLMOperationError("notebooklm_not_configured", "not_sent")
        try:
            self._validate_url()
        except ValueError:
            raise NotebookLMOperationError("notebooklm_not_configured", "not_sent")
        quoted_book = urllib.parse.quote(book_id, safe="")
        quoted_hash = urllib.parse.quote(content_hash, safe="")
        quoted_title = urllib.parse.quote(title or "Book", safe="")
        quoted_file = urllib.parse.quote(file_name or "book.epub", safe="")
        request = urllib.request.Request(
            self.url.rstrip("/") + _OPERATION_PATH,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/epub+zip",
                "Content-Length": str(len(data)),
                "X-LearnBuddy-Book-Id": quoted_book,
                "X-LearnBuddy-Book-Content-Hash": quoted_hash,
                "X-LearnBuddy-Book-Title": quoted_title,
                "X-LearnBuddy-Source-File": quoted_file,
                "X-LearnBuddy-Sync-Request-Id": request_id,
            },
        )
        try:
            with self._urlopen(request, timeout=self.operation_timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, ValueError, UnicodeDecodeError) as error:
            raise NotebookLMOperationError("notebooklm_mutation_unknown", "unknown") from error
        if not isinstance(payload, dict) or payload.get("bookId") != book_id \
                or payload.get("bookContentHash") != content_hash \
                or payload.get("requestId") != request_id:
            raise NotebookLMOperationError("notebooklm_mutation_unknown", "unknown")
        outcome = payload.get("outcome")
        if outcome not in ("confirmed", "not_sent", "rejected", "unknown"):
            raise NotebookLMOperationError("notebooklm_mutation_unknown", "unknown")
        result = {"outcome": outcome}
        if outcome == "confirmed":
            if not all(isinstance(payload.get(field), str) and payload[field].strip()
                       for field in ("notebookId", "sourceId")):
                raise NotebookLMOperationError("notebooklm_mutation_unknown", "unknown")
            result.update({"notebookId": payload["notebookId"], "sourceId": payload["sourceId"]})
        elif payload.get("error"):
            error_code = payload["error"]
            if not _SAFE_ERROR_RE.fullmatch(error_code):
                raise NotebookLMOperationError("notebooklm_mutation_unknown", "unknown")
            result["error"] = error_code
        return result

    def job_request(self, *, job_id, request_id, book_id, content_hash, person_id,
                    artifact_type, context_scope):
        """Submit or reconcile one stable remote job request.

        The host persists ``request_id`` before this call.  Repeating the exact
        request is therefore a reconciliation request, not permission to start
        a second generation.
        """
        return self._job_operation(
            "submit", job_id=job_id, request_id=request_id, book_id=book_id,
            content_hash=content_hash, person_id=person_id, artifact_type=artifact_type,
            context_scope=context_scope)

    def reconcile_job(self, *, job_id, request_id, book_id, content_hash, person_id,
                      artifact_type, context_scope):
        """Recheck stable identity after a worker restart without resubmitting."""
        return self._job_operation(
            "reconcile", job_id=job_id, request_id=request_id, book_id=book_id,
            content_hash=content_hash, person_id=person_id, artifact_type=artifact_type,
            context_scope=context_scope)

    def cancel_job(self, *, job_id, request_id, book_id, content_hash, person_id):
        return self._job_operation(
            "cancel", job_id=job_id, request_id=request_id, book_id=book_id,
            content_hash=content_hash, person_id=person_id)

    def _job_operation(self, action, **identity):
        if not self.url:
            raise NotebookLMOperationError("notebooklm_not_configured", "not_configured")
        try:
            self._validate_url()
        except ValueError as error:
            raise NotebookLMOperationError("notebooklm_not_configured", "not_configured") from error
        payload = {
            "service": "notebooklm", "action": action,
            "jobId": identity["job_id"], "requestId": identity["request_id"],
            "personId": identity["person_id"], "bookId": identity["book_id"],
            "bookContentHash": identity["content_hash"],
        }
        if action in ("submit", "reconcile"):
            payload.update({
                "artifactType": identity["artifact_type"],
                "contextScope": identity["context_scope"],
            })
        path = {"submit": _JOB_PATH, "reconcile": f"{_JOB_PATH}/reconcile",
                "cancel": f"{_JOB_PATH}/cancel"}[action]
        request = urllib.request.Request(
            self.url.rstrip("/") + path,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST", headers={"Content-Type": "application/json; charset=utf-8"},
        )
        try:
            with self._urlopen(request, timeout=self.operation_timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError,
                ValueError, UnicodeDecodeError) as error:
            raise NotebookLMOperationError("notebooklm_unavailable", "failed") from error
        return self._validate_job_result(result, payload)

    @staticmethod
    def _validate_job_result(result, request):
        if not isinstance(result, dict) or result.get("service") != "notebooklm" \
                or any(result.get(key) != request.get(key)
                       for key in ("jobId", "requestId", "personId", "bookId", "bookContentHash")):
            raise NotebookLMOperationError("notebooklm_job_unknown", "unknown")
        state = result.get("state")
        if state not in _JOB_STATES:
            raise NotebookLMOperationError("notebooklm_job_unknown", "unknown")
        error = result.get("error")
        if error is not None and error not in _JOB_ERRORS:
            raise NotebookLMOperationError("notebooklm_job_unknown", "unknown")
        controlled = {"state": state, "error": error, "artifact": None}
        if state == "ready":
            artifact = result.get("artifact")
            allowed = ("remoteArtifactId", "contentType", "byteSize")
            if not isinstance(artifact, dict) \
                    or not isinstance(artifact.get("remoteArtifactId"), str) \
                    or not artifact["remoteArtifactId"].strip() \
                    or ("contentType" in artifact and not isinstance(artifact["contentType"], str)) \
                    or ("byteSize" in artifact and (not isinstance(artifact["byteSize"], int)
                                                    or isinstance(artifact["byteSize"], bool)
                                                    or artifact["byteSize"] < 0)):
                raise NotebookLMOperationError("notebooklm_job_unknown", "unknown")
            controlled["artifact"] = {
                key: artifact[key] for key in allowed if key in artifact
            }
        return controlled

    def _validate_url(self):
        parsed = urllib.parse.urlparse(self.url)
        if parsed.scheme != "http" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("worker URL must be an unauthenticated loopback HTTP URL")
        host = parsed.hostname
        try:
            addresses = {ipaddress.ip_address(host)}
        except ValueError:
            if host not in ("localhost", "localhost.localdomain"):
                raise ValueError("worker URL must use loopback")
        else:
            if any(not address.is_loopback for address in addresses):
                raise ValueError("worker URL must use loopback")


class NotebookLMOperationError(LookupError):
    """Provider failure with the safe outcome needed by the host state machine."""

    def __init__(self, code, outcome):
        super().__init__(code)
        self.code = code
        self.outcome = outcome


def _status(error):
    status = {
        "notebooklm_not_configured": "not_configured",
        "notebooklm_unavailable": "unavailable",
    }.get(error, "unavailable")
    return {
        "provider": "notebooklm",
        "configured": False,
        "available": False,
        "status": status,
        "error": error,
    }
