"""Safe host boundary for the optional NotebookLM worker.

The NotebookLM process owns its profile and credentials. This module only
performs a loopback health check and returns a small, credential-free DTO.
It deliberately does not import notebooklm-py into the LearnBuddy host.
"""

import ipaddress
import json
import os
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = ""
STATUS_TIMEOUT_SECONDS = 2


class NotebookLMProxy:
    """Proxy the worker's safe status, never its private configuration."""

    def __init__(self, url=None, timeout=STATUS_TIMEOUT_SECONDS, urlopen=None):
        self.url = os.environ.get("LEARNBUDDY_NOTEBOOKLM_URL", DEFAULT_URL) if url is None else url
        self.timeout = timeout
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
            with self._urlopen(request, self.timeout) as response:
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

    def request(self, _operation, _payload=None):
        """Reserved operation seam; #73 intentionally has no browser operation.

        Future work may add operation methods here, but they must use the same
        loopback boundary and map unavailability/configuration to fixed codes.
        """
        status = self.status()
        if not status.get("configured"):
            raise LookupError(status.get("error", "notebooklm_not_configured"))
        raise LookupError("notebooklm_unavailable")

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
