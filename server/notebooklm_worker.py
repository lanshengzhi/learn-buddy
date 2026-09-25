#!/usr/bin/env python3
"""Private NotebookLM worker process (issue #73).

This process is intentionally tiny: it owns no LearnBuddy Book, Person,
Conversation, or reading-position state. It exposes only a loopback health
endpoint for the Python host. Future provider operations will be added behind
this same process boundary; they must never import credentials into the host.
"""

import argparse
import asyncio
import hashlib
import ipaddress
import json
import os
import re
import sys
import tempfile
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class NotebookLMWorkerApp:
    def __init__(self, storage_path=None, token_path=None, provider=None, max_source_bytes=256 * 1024 * 1024):
        self.storage_path = storage_path
        self.token_path = token_path
        self.provider = provider or NotebookLMSyncProvider()
        self.max_source_bytes = max_source_bytes

    def status(self):
        configured = any(path and os.path.isfile(path) for path in (self.storage_path, self.token_path))
        return {
            "service": "notebooklm",
            "configured": configured,
            # This is a process health result, not an authenticated provider
            # probe. Provider operations still return explicit mutation outcomes.
            "status": "ok",
        }

    def sync_book(self, *, book_id, content_hash, title, file_name, request_id, data):
        if not self.status().get("configured"):
            return self._result(book_id, content_hash, request_id, "not_sent", "notebooklm_not_configured")
        if not re.fullmatch(r"[0-9a-f]{64}", book_id or "") or book_id != content_hash:
            return self._result(book_id, content_hash, request_id, "rejected", "notebooklm_source_rejected")
        if len(data) > self.max_source_bytes or hashlib.sha256(data).hexdigest() != content_hash:
            return self._result(book_id, content_hash, request_id, "rejected", "notebooklm_source_rejected")
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(prefix="learnbuddy-", suffix=".epub", delete=False) as handle:
                handle.write(data)
                temporary_path = handle.name
            return self.provider.sync_epub(
                notebook_title=title or "Book",
                file_path=temporary_path,
                file_name=file_name or "book.epub",
            )
        except Exception as error:  # provider boundary; never expose raw errors
            return _provider_outcome(error)
        finally:
            if temporary_path:
                try:
                    os.unlink(temporary_path)
                except OSError:
                    pass

    @staticmethod
    def _result(book_id, content_hash, request_id, outcome, error=None, notebook_id=None, source_id=None):
        result = {
            "service": "notebooklm",
            "bookId": book_id,
            "bookContentHash": content_hash,
            "requestId": request_id,
            "outcome": outcome,
        }
        if error:
            result["error"] = error
        if notebook_id:
            result["notebookId"] = notebook_id
        if source_id:
            result["sourceId"] = source_id
        return result


class NotebookLMSyncProvider:
    """Lazy notebooklm-py adapter; it exists only inside the worker process."""

    def sync_epub(self, *, notebook_title, file_path, file_name):
        async def run():
            from notebooklm import NotebookLMClient

            profile = os.environ.get("NOTEBOOKLM_PROFILE") or None
            async with NotebookLMClient.from_storage(profile=profile) as client:
                notebook = await client.notebooks.create(notebook_title)
                source = await client.sources.add_file(
                    notebook.id,
                    file_path,
                    mime_type="application/epub+zip",
                    title=file_name,
                    wait=True,
                )
                return notebook.id, source.id

        try:
            notebook_id, source_id = asyncio.run(run())
        except Exception as error:
            raise _classify_provider_error(error)
        return {
            "outcome": "confirmed",
            "notebookId": notebook_id,
            "sourceId": source_id,
        }


def _classify_provider_error(error):
    if getattr(error, "unconfirmed", False):
        return _ProviderError("notebooklm_mutation_unknown", "unknown")
    try:
        from notebooklm import AuthError, NotebookLimitError, RateLimitError, SourceProcessingError
    except ImportError:
        return _ProviderError("notebooklm_unavailable", "unknown")
    if isinstance(error, AuthError):
        return _ProviderError("notebooklm_authentication_required", "rejected")
    if isinstance(error, (RateLimitError, NotebookLimitError)):
        return _ProviderError("notebooklm_quota_limited", "rejected")
    if isinstance(error, SourceProcessingError):
        return _ProviderError("notebooklm_source_rejected", "rejected")
    return _ProviderError("notebooklm_mutation_unknown", "unknown")


class _ProviderError(Exception):
    def __init__(self, code, outcome):
        super().__init__(code)
        self.code = code
        self.outcome = outcome


def _provider_outcome(error):
    if isinstance(error, _ProviderError):
        return {"outcome": error.outcome, "error": error.code}
    return {"outcome": "unknown", "error": "notebooklm_mutation_unknown"}


class NotebookLMWorkerHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/health":
            self._json(404, {"error": "not_found"})
            return
        self._json(200, self.server.worker_app.status())

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/operations/sync-book":
            self._json(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._json(400, {"error": "bad_request"})
            return
        if length < 0 or length > self.server.worker_app.max_source_bytes:
            self._json(413, {"error": "source_too_large"})
            return
        data = self.rfile.read(length)
        try:
            result = self.server.worker_app.sync_book(
                book_id=urllib.parse.unquote(self.headers.get("X-LearnBuddy-Book-Id", "")),
                content_hash=urllib.parse.unquote(self.headers.get("X-LearnBuddy-Book-Content-Hash", "")),
                title=urllib.parse.unquote(self.headers.get("X-LearnBuddy-Book-Title", "")),
                file_name=urllib.parse.unquote(self.headers.get("X-LearnBuddy-Source-File", "")),
                request_id=self.headers.get("X-LearnBuddy-Sync-Request-Id", ""),
                data=data,
            )
        except Exception:
            result = NotebookLMWorkerApp._result("", "", "", "unknown", "notebooklm_mutation_unknown")
        result = {**result, "bookId": self.headers.get("X-LearnBuddy-Book-Id", ""),
                  "bookContentHash": self.headers.get("X-LearnBuddy-Book-Content-Hash", ""),
                  "requestId": self.headers.get("X-LearnBuddy-Sync-Request-Id", "")}
        self._json(200, result)

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Do not log request details or any provider configuration.
        sys.stderr.write("notebooklm-worker: " + (fmt % args) + "\n")


class WorkerServer(ThreadingHTTPServer):
    def __init__(self, address, handler, worker_app):
        super().__init__(address, handler)
        self.worker_app = worker_app


def _loopback_host(host):
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host in ("localhost", "localhost.localdomain")


def _profile_paths():
    """Resolve credential locations inside the worker only.

    The paths are never sent to the host. ``NOTEBOOKLM_HOME`` and
    ``NOTEBOOKLM_PROFILE`` are the current notebooklm-py configuration names.
    The package's public path helpers are used when available; the fallback
    keeps health useful in minimal test/install environments.
    """
    try:
        from notebooklm.paths import get_storage_path, get_master_token_path
        profile = os.environ.get("NOTEBOOKLM_PROFILE") or None
        return get_storage_path(profile=profile), get_master_token_path(profile=profile)
    except (ImportError, OSError, ValueError):
        home = os.path.expanduser(os.environ.get("NOTEBOOKLM_HOME", "~/.notebooklm"))
        profile = os.environ.get("NOTEBOOKLM_PROFILE") or "default"
        profile_dir = os.path.join(home, "profiles", profile)
        return (
            os.path.join(profile_dir, "storage_state.json"),
            os.path.join(profile_dir, "master_token.json"),
        )


def run(host="127.0.0.1", port=8124):
    if not _loopback_host(host):
        raise ValueError("NotebookLM worker must bind to loopback")
    app = NotebookLMWorkerApp(*_profile_paths())
    httpd = WorkerServer((host, port), NotebookLMWorkerHandler, app)
    print(f"NotebookLM worker listening on http://{host}:{port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="LearnBuddy private NotebookLM worker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8124)
    args = parser.parse_args(argv)
    try:
        run(args.host, args.port)
    except ValueError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
