#!/usr/bin/env python3
"""Private NotebookLM worker process (issue #73).

This process is intentionally tiny: it owns no LearnBuddy Book, Person,
Conversation, or reading-position state. It exposes only a loopback health
endpoint for the Python host. Future provider operations will be added behind
this same process boundary; they must never import credentials into the host.
"""

import argparse
import ipaddress
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class NotebookLMWorkerApp:
    def __init__(self, storage_path=None, token_path=None):
        self.storage_path = storage_path
        self.token_path = token_path

    def status(self):
        configured = any(path and os.path.isfile(path) for path in (self.storage_path, self.token_path))
        return {
            "service": "notebooklm",
            "configured": configured,
            # This is a process health result, not an authenticated provider
            # probe. The host will use provider-specific error mapping later.
            "status": "ok",
        }


class NotebookLMWorkerHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/health":
            self._json(404, {"error": "not_found"})
            return
        self._json(200, self.server.worker_app.status())

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
