#!/usr/bin/env python3
"""LearnBuddy backend — one stdlib-only process serving:

- GET /tts?text&voice&rate → audio/mpeg (MP3): Azure Speech primary when
  AZURE_SPEECH_KEY is set (ADR 0005), Edge TTS as the automatic fallback
  (no key, or any Azure failure), with a server audio cache keyed by
  SHA-256(text|voice|rate) shared by the whole family (ADR 0001). Japanese
  text is reading-normalized first (ADR 0004/0005, see server/reading.py):
  Azure gets an SSML body with <phoneme> hints; the Edge fallback gets
  plain text with kana readings. Client-side validation → 400s; upstream
  failures → 502/504; Edge keeps its single retry + 403 clock-skew retry +
  ~3s connection pacing (EdgeTtsSynthesizer + the PaceGate below); Azure
  needs no pacing.
- static files (the web/ frontend).

Errors: JSON {"error": "<code>"} using the shared error-code vocabulary
(web/js/core/errors.js). Run locally with:  python3 server/tts_server.py
"""

import argparse
import hashlib
import json
import mimetypes
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote_plus, urlparse

from azure_tts import AzureTtsSynthesizer
from edge_tts import (
    EdgeTtsError,
    EdgeTtsSynthesizer,
    CODE_EMPTY_TEXT,
    CODE_INVALID_RATE,
    CODE_INVALID_VOICE,
    CODE_NETWORK_FAILURE,
    CODE_TEXT_TOO_LONG,
    CODE_UNKNOWN,
    CODE_UPSTREAM_TIMEOUT,
    CODE_UPSTREAM_UNAVAILABLE,
    validate_request,
)
import reading

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_STATIC_DIR = os.path.join(REPO_ROOT, "web")
DEFAULT_CACHE_DIR = os.path.join(REPO_ROOT, "server", "cache")

# Upstream throttling: research showed ~1s bursts get intermittent 403s even
# with a legal Edge UA; ~3s spacing is stable (research/edge-tts-browser.md).
PACE_INTERVAL_SECONDS = 3.0


class PaceGate:
    """Serializes upstream connections to at least `interval` seconds apart.
    The synthesis lock in TtsServer serializes synthesis; this gate paces."""

    def __init__(self, interval=PACE_INTERVAL_SECONDS, sleep=time.sleep):
        self.interval = interval
        self.sleep = sleep
        self.lock = threading.Lock()
        self.last_connect = 0.0

    def wait(self):
        with self.lock:
            now = time.monotonic()
            wait = self.last_connect + self.interval - now
            if wait > 0:
                self.sleep(wait)
            self.last_connect = time.monotonic()


class AudioCache:
    """Server audio cache: MP3 bytes keyed by SHA-256(text|voice|rate),
    shared by all family devices. A speed layer only — offline replay is the
    Service Worker's job (ADR 0001)."""

    def __init__(self, directory, lock=None):
        self.directory = directory
        os.makedirs(directory, exist_ok=True)
        self.lock = lock or threading.Lock()

    @staticmethod
    def key(text, voice, rate):
        payload = f"{text}|{voice}|{rate}".encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def path_for(self, key):
        return os.path.join(self.directory, f"{key}.mp3")

    def get(self, key):
        path = self.path_for(key)
        try:
            with open(path, "rb") as fh:
                return fh.read()
        except OSError:
            return None

    def put(self, key, data):
        with self.lock:
            path = self.path_for(key)
            tmp = f"{path}.tmp.{os.getpid()}"
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, path)


def default_voice_for(lang):
    if lang == "ja":
        return "ja-JP-KeitaNeural"
    if lang in ("zh", "zh-CN"):
        return "zh-CN-YunxiNeural"
    return "en-US-AriaNeural"


def _is_japanese_voice(voice):
    """True when the (normalized, long-form) voice is a ja-JP neural voice."""
    return "ja-JP" in voice


# HTTP status per error code (frontend reads the JSON code, not the status).
STATUS_BY_CODE = {
    CODE_EMPTY_TEXT: 400,
    CODE_TEXT_TOO_LONG: 400,
    CODE_INVALID_VOICE: 400,
    CODE_INVALID_RATE: 400,
    CODE_UPSTREAM_UNAVAILABLE: 502,
    CODE_NETWORK_FAILURE: 502,
    CODE_UPSTREAM_TIMEOUT: 504,
    CODE_UNKNOWN: 500,
}


class TtsServer:
    def __init__(self, static_dir=DEFAULT_STATIC_DIR, cache_dir=DEFAULT_CACHE_DIR,
                 synthesizer=None, azure=None, pace_interval=PACE_INTERVAL_SECONDS,
                 sleep=time.sleep, normalizer=None):
        self.static_dir = os.path.abspath(static_dir)
        self.cache = AudioCache(cache_dir)
        self.synthesizer = synthesizer or EdgeTtsSynthesizer()
        # azure is injectable for tests; the default reads AZURE_SPEECH_KEY
        # from the environment and reports key=None when it is absent.
        self.azure = azure if azure is not None else AzureTtsSynthesizer()
        self.normalizer = normalizer or reading.normalize_ja
        self.pace_gate = PaceGate(interval=pace_interval, sleep=sleep)
        self.synthesis_lock = threading.Lock()

    def _use_azure(self):
        """Azure is primary exactly when it holds a subscription key."""
        return bool(self.azure.key)

    def synthesize(self, text, voice, rate):
        """Runs one synthesis honoring validation, normalization, cache,
        provider selection, and pacing. Japanese voices pass through the G2P
        reading normalizer first (ADR 0004/0005) — Azure receives the SSML
        body (phoneme hints), the Edge fallback receives plain kana text —
        and the cache key covers the normalized body plus the normalization
        version so readings never go stale."""
        text, voice, rate = validate_request(text, voice, rate)
        if _is_japanese_voice(voice):
            azure_body = self.normalizer(text)
            edge_text = reading.normalize_ja_text(text)
        else:
            azure_body = reading.normalize(text)
            edge_text = text
        key = AudioCache.key(f"{reading.NORM_VERSION}|{azure_body}", voice, rate)

        cached = self.cache.get(key)
        if cached is not None:
            return key, cached, True

        with self.synthesis_lock:
            audio = self._synthesize(azure_body, edge_text, voice, rate)
        self.cache.put(key, audio)
        return key, audio, False

    def _synthesize(self, azure_body, edge_text, voice, rate):
        """Azure first (no pacing) when configured; any Azure failure falls
        back to Edge, paced ~3s. Raises EdgeTtsError with the shared codes."""
        if self._use_azure():
            try:
                return self.azure.speak(azure_body, voice, rate)
            except EdgeTtsError:
                pass  # fall through to the Edge fallback
        self.pace_gate.wait()
        return self.synthesizer.speak(edge_text, voice, rate)


class AppServer(ThreadingHTTPServer):
    """Carries the TtsServer application on the server instance so request
    handlers can reach it as self.server.app."""

    def __init__(self, address, handler, app):
        super().__init__(address, handler)
        self.app = app


class TtsHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/tts":
            self._handle_tts(parsed)
        else:
            self._handle_static(parsed.path)

    # -- /tts --------------------------------------------------------------

    def _handle_tts(self, parsed):
        params = _parse_query(parsed.query)
        text = params.get("text", "")
        voice = params.get("voice", "") or default_voice_for(params.get("lang", "en"))
        rate = params.get("rate", "+0%")
        try:
            key, audio, cache_hit = self.server.app.synthesize(text, voice, rate)
        except EdgeTtsError as error:
            self._json_error(STATUS_BY_CODE.get(error.code, 500), error.code)
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("X-Cache", "hit" if cache_hit else "miss")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(audio)

    def _json_error(self, status, code):
        body = json.dumps({"error": code}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # -- static ------------------------------------------------------------

    def _handle_static(self, path):
        if path == "/":
            path = "/index.html"
        candidate = os.path.abspath(os.path.join(self.server.app.static_dir, unquote_plus(path).lstrip("/")))
        static_root = os.path.abspath(self.server.app.static_dir)
        if not candidate.startswith(static_root + os.sep) and candidate != static_root:
            self._json_error(404, "not_found")
            return
        if not os.path.isfile(candidate):
            self._json_error(404, "not_found")
            return
        with open(candidate, "rb") as fh:
            body = fh.read()
        content_type = mimetypes.guess_type(candidate)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), time.strftime("%Y-%m-%d %H:%M:%S"), fmt % args))


def _parse_query(query):
    params = {}
    for pair in query.split("&"):
        if not pair:
            continue
        name, _, value = pair.partition("=")
        params[name] = unquote_plus(value)
    return params


def run(static_dir=DEFAULT_STATIC_DIR, cache_dir=DEFAULT_CACHE_DIR, port=8000, host="0.0.0.0"):
    app = TtsServer(static_dir=static_dir, cache_dir=cache_dir)
    httpd = AppServer((host, port), TtsHandler, app)
    print(f"LearnBuddy serving {static_dir} on http://{host}:{port} (cache: {cache_dir})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


def main(argv=None):
    parser = argparse.ArgumentParser(description="LearnBuddy backend (TTS proxy + static hosting)")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--static", default=DEFAULT_STATIC_DIR)
    parser.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR)
    args = parser.parse_args(argv)
    run(static_dir=args.static, cache_dir=args.cache_dir, port=args.port, host=args.host)


if __name__ == "__main__":
    main()
