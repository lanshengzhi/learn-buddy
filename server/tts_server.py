#!/usr/bin/env python3
"""LearnBuddy backend — one process (stdlib; SudachiPy only on the
Japanese epub-parse path) serving:

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
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote_plus, urlparse

from ai import AiProxy, DEFAULT_EXPLANATION_LOCALE
from azure_tts import AzureTtsSynthesizer
from dicts import Dicts, LookupUnavailable, MAX_CHECK_WORDS
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
from library import ApiError, Library
from book_context import BookContextCompiler
from conversations import Conversations
from book_ai import (
    BookConversations, NotebookRefs, NotebookSync, StudyJobRunner, StudyJobs,
)
from notebooklm_host import NotebookLMProxy
import reading

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_STATIC_DIR = os.path.join(REPO_ROOT, "web")
DEFAULT_CACHE_DIR = os.path.join(REPO_ROOT, "server", "cache")
DEFAULT_DATA_DIR = os.path.join(REPO_ROOT, "server", "data")

# JSON request bodies stay small; epubs have their own (Library) limit.
JSON_BODY_LIMIT = 1024 * 1024

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
    # Book / Profile API (ADR 0007).
    "bad_request": 400,
    "profile_not_found": 404,
    "book_not_found": 404,
    "chapter_not_found": 404,
    "entry_not_found": 404,
    "not_found": 404,
    "too_large": 413,
    "not_epub": 415,
    "parse_failed": 422,
    # Lookup / AI layer (ADR 0008).
    "lookup_unavailable": 503,
    "ai_not_configured": 503,
    "ai_upstream_error": 502,
    "ai_timeout": 504,
    # Chat / Conversations (ticket #47; ai_usage_limit per ADR 0013).
    "conversation_not_found": 404,
    "ai_usage_limit": 503,
    # Read-owned Book AI (#71).
    "book_conversation_not_found": 404,
    # Lazy NotebookLM sync (#74).
    "cloud_confirmation_required": 400,
    "notebook_ref_conflict": 409,
    # Durable NotebookLM StudyJobs (#75).
    "study_job_not_found": 404,
    "study_job_conflict": 409,
    "study_job_not_cancellable": 409,
    "invalid_study_job_transition": 409,
    "notebook_ref_not_found": 409,
    "study_job_not_retryable": 409,
    "study_job_not_recheckable": 409,
    # NotebookLM product failures (the host never forwards worker bodies).
    "notebooklm_not_configured": 503,
    "notebooklm_auth_required": 503,
    "notebooklm_unavailable": 502,
    "notebooklm_quota": 503,
    "notebooklm_source_rejected": 422,
    "notebooklm_job_unknown": 502,
    "artifact_download_failed": 502,
}

# Hand-written routes: path says what, `?profile=` says who is asking.
ROUTE_TABLE = (
    ("GET", re.compile(r"^/profiles$"), "api_profiles"),
    ("GET", re.compile(r"^/state$"), "api_get_state"),
    ("PUT", re.compile(r"^/state$"), "api_put_state"),
    ("GET", re.compile(r"^/history$"), "api_get_history"),
    ("POST", re.compile(r"^/history$"), "api_post_history"),
    ("PATCH", re.compile(r"^/history/(?P<entry>[^/]+)$"), "api_patch_history"),
    ("DELETE", re.compile(r"^/history/(?P<entry>[^/]+)$"), "api_delete_history"),
    ("GET", re.compile(r"^/words$"), "api_get_words"),
    ("POST", re.compile(r"^/words$"), "api_post_words"),
    ("GET", re.compile(r"^/books$"), "api_list_books"),
    ("POST", re.compile(r"^/books$"), "api_add_book"),
    ("GET", re.compile(r"^/books/(?P<book>[^/]+)$"), "api_get_book"),
    ("POST", re.compile(r"^/books/(?P<book>[^/]+)/context$"), "api_compile_context"),
    ("GET", re.compile(r"^/books/(?P<book>[^/]+)/notebook-sync$"), "api_notebook_sync_status"),
    ("POST", re.compile(r"^/books/(?P<book>[^/]+)/notebook-sync$"), "api_notebook_sync"),
    ("GET", re.compile(r"^/books/(?P<book>[^/]+)/study-jobs$"), "api_list_study_jobs"),
    ("POST", re.compile(r"^/books/(?P<book>[^/]+)/study-jobs$"), "api_create_study_job"),
    ("GET", re.compile(r"^/study-jobs/(?P<job>[^/]+)$"), "api_get_study_job"),
    ("POST", re.compile(r"^/study-jobs/(?P<job>[^/]+)/reconcile$"), "api_reconcile_study_job"),
    ("POST", re.compile(r"^/study-jobs/(?P<job>[^/]+)/cancel$"), "api_cancel_study_job"),
    ("POST", re.compile(r"^/study-jobs/(?P<job>[^/]+)/retry$"), "api_retry_study_job"),
    ("POST", re.compile(r"^/study-jobs/(?P<job>[^/]+)/recheck$"), "api_recheck_study_job"),
    ("GET", re.compile(r"^/books/(?P<book>[^/]+)/chapters/(?P<chapter>[^/]+)$"), "api_get_chapter"),
    ("PUT", re.compile(r"^/books/(?P<book>[^/]+)/position$"), "api_put_position"),
    ("GET", re.compile(r"^/conversations$"), "api_list_conversations"),
    ("POST", re.compile(r"^/conversations$"), "api_create_conversation"),
    ("GET", re.compile(r"^/conversations/(?P<conversation>[^/]+)$"), "api_get_conversation"),
    ("POST", re.compile(r"^/conversations/(?P<conversation>[^/]+)/messages$"), "api_post_conversation_message"),
    ("GET", re.compile(r"^/books/(?P<book>[^/]+)/book-conversations$"), "api_list_book_conversations"),
    ("POST", re.compile(r"^/books/(?P<book>[^/]+)/book-conversations$"), "api_create_book_conversation"),
    ("GET", re.compile(r"^/book-conversations/(?P<conversation>[^/]+)$"), "api_get_book_conversation"),
    ("POST", re.compile(r"^/book-conversations/(?P<conversation>[^/]+)/resume$"), "api_resume_book_conversation"),
    ("DELETE", re.compile(r"^/book-conversations/(?P<conversation>[^/]+)$"), "api_delete_book_conversation"),
    ("POST", re.compile(r"^/book-conversations/(?P<conversation>[^/]+)/messages$"), "api_post_book_conversation_message"),
    ("GET", re.compile(r"^/lookup$"), "api_lookup"),
    ("POST", re.compile(r"^/lookup/check$"), "api_lookup_check"),
    ("POST", re.compile(r"^/ai$"), "api_ai"),
    ("GET", re.compile(r"^/notebooklm/status$"), "api_notebooklm_status"),
)


class TtsServer:
    def __init__(self, static_dir=DEFAULT_STATIC_DIR, cache_dir=DEFAULT_CACHE_DIR,
                 synthesizer=None, azure=None, pace_interval=PACE_INTERVAL_SECONDS,
                 sleep=time.sleep, normalizer=None, data_dir=None, library=None,
                 notebooklm=None):
        self.static_dir = os.path.abspath(static_dir)
        self.cache = AudioCache(cache_dir)
        self.synthesizer = synthesizer or EdgeTtsSynthesizer()
        # azure is injectable for tests; the default reads AZURE_SPEECH_KEY
        # from the environment and reports key=None when it is absent.
        self.azure = azure if azure is not None else AzureTtsSynthesizer()
        self.normalizer = normalizer or reading.normalize_ja
        self.pace_gate = PaceGate(interval=pace_interval, sleep=sleep)
        self.synthesis_lock = threading.Lock()
        data_dir = data_dir or DEFAULT_DATA_DIR
        self.library = library if library is not None else Library(data_dir)
        self.conversations = Conversations(data_dir, self.library.require_profile)
        self.book_context = BookContextCompiler(self.library)
        # Read-owned Book AI data is host-owned from #67 onward. Routes are
        # added separately by #71; keeping the stores on the app here makes the
        # persistence boundary explicit and ready for that API slice.
        self.book_conversations = BookConversations(
            data_dir, self.library.require_profile, self.library.require_book)
        self.notebook_refs = NotebookRefs(data_dir, self.library.require_book)
        self.study_jobs = StudyJobs(
            data_dir, self.library.require_profile, self.library.require_book)
        self.dicts = Dicts(os.path.join(data_dir, "dicts"))
        self.ai = AiProxy(os.path.join(data_dir, "ai-cache"))
        # The optional NotebookLM process is deliberately a separate, private
        # service. The host only proxies its safe status and never sees its
        # credentials or profile files.
        self.notebooklm = notebooklm or NotebookLMProxy()
        self.notebook_sync = NotebookSync(self.library, self.notebook_refs, self.notebooklm)
        self.study_job_runner = StudyJobRunner(
            self.library, self.book_context, self.study_jobs,
            self.notebook_refs, self.notebooklm)

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
            return
        if self._dispatch_api("GET", parsed):
            return
        self._handle_static(parsed.path)

    def do_POST(self):
        self._handle_write("POST")

    def do_PUT(self):
        self._handle_write("PUT")

    def do_PATCH(self):
        self._handle_write("PATCH")

    def do_DELETE(self):
        self._handle_write("DELETE")

    def _handle_write(self, method):
        if not self._dispatch_api(method, urlparse(self.path)):
            self._json_error(404, "not_found")

    # -- Book / Profile API (ADR 0007) -------------------------------------

    def _dispatch_api(self, method, parsed):
        route = None
        for route_method, pattern, handler_name in ROUTE_TABLE:
            if route_method != method:
                continue
            match = pattern.match(parsed.path)
            if match:
                route = (handler_name, match.groupdict())
                break
        if route is None:
            return False
        handler_name, groups = route
        params = _parse_query(parsed.query)
        try:
            getattr(self, handler_name)(params, groups)
        except ApiError as error:
            self._json_error(STATUS_BY_CODE.get(error.code, 500), error.code)
        except Exception:  # pragma: no cover - unexpected bugs
            traceback.print_exc()
            self._json_error(500, CODE_UNKNOWN)
        return True

    def _library(self):
        return self.server.app.library

    def api_profiles(self, params, groups):
        self._json_response(200, self._library().profiles())

    def api_get_state(self, params, groups):
        self._json_response(200, self._library().get_state(params.get("profile", "")))

    def api_put_state(self, params, groups):
        body = self._read_json()
        self._json_response(200, self._library().put_state(params.get("profile", ""), body))

    def api_get_history(self, params, groups):
        self._json_response(200, self._library().get_history(params.get("profile", "")))

    def api_post_history(self, params, groups):
        body = self._read_json()
        self._json_response(200, self._library().add_history(params.get("profile", ""), body.get("text")))

    def api_patch_history(self, params, groups):
        body = self._read_json()
        self._json_response(200, self._library().patch_history(
            params.get("profile", ""), groups["entry"], body))

    def api_delete_history(self, params, groups):
        self._library().delete_history(params.get("profile", ""), groups["entry"])
        self._no_content()

    def api_get_words(self, params, groups):
        self._json_response(200, self._library().get_words(params.get("profile", "")))

    def api_post_words(self, params, groups):
        body = self._read_json()
        self._json_response(200, self._library().update_words(
            params.get("profile", ""), body.get("add"), body.get("remove")))

    def api_list_books(self, params, groups):
        self._json_response(200, self._library().list_books(params.get("profile", "")))

    def api_add_book(self, params, groups):
        # Raw epub body (no multipart), size-capped before it is read.
        data = self._read_body(self._library().max_upload_bytes)
        duplicate, payload = self._library().add_book(
            params.get("profile", ""), params.get("name", ""), data)
        if duplicate:
            payload["duplicate"] = True
        self._json_response(200 if duplicate else 201, payload)

    def api_get_book(self, params, groups):
        self._json_response(200, self._library().get_book(groups["book"], params.get("profile", "") or None))

    def api_compile_context(self, params, groups):
        body = self._read_json()
        scope = body.get("scope")
        context = self.server.app.book_context.compile(
            groups["book"], scope,
            chapter=body.get("chapter", 0),
            sentence=body.get("sentence"),
            start=body.get("start"),
            end=body.get("end"),
            selected_text=body.get("selectedText"),
            expected_book_id=body.get("bookId"),
            content_hash=body.get("contentHash"),
            max_chars=body.get("maxChars"),
        )
        self._json_response(200, {"context": context})

    def api_notebook_sync_status(self, params, groups):
        self._json_response(200, self.server.app.notebook_sync.status(groups["book"]))

    def api_notebook_sync(self, params, groups):
        body = self._read_json()
        result = self.server.app.notebook_sync.sync(
            groups["book"], confirm_upload=body.get("confirmUpload"),
            retry=body.get("retry", False),
        )
        self._json_response(200, result)

    def api_list_study_jobs(self, params, groups):
        result = self.server.app.study_jobs.list(params.get("profile", ""), groups["book"])
        self._json_response(200, {**result, "book": groups["book"]})

    def api_create_study_job(self, params, groups):
        profile = params.get("profile", "")
        body = self._read_json()
        request = body.get("request")
        if not isinstance(request, dict):
            raise ApiError("bad_request", "request must be an object")
        request = dict(request)
        request.setdefault("bookId", groups["book"])
        request.setdefault("bookContentHash", groups["book"])
        request.setdefault("personId", profile)
        created = self.server.app.study_job_runner.create(
            profile, groups["book"], request, confirm_whole_book=body.get("confirmWholeBook") is True)
        self._json_response(201 if created["created"] else 200, {
            "job": created["job"], "book": groups["book"],
        })

    def api_get_study_job(self, params, groups):
        job = self.server.app.study_jobs.get(params.get("profile", ""), groups["job"])
        self._json_response(200, {"job": job, "book": job["bookId"]})

    def api_reconcile_study_job(self, params, groups):
        self._read_json()
        job = self.server.app.study_job_runner.reconcile(
            params.get("profile", ""), groups["job"])
        self._json_response(200, {"job": job, "book": job["bookId"]})

    def api_cancel_study_job(self, params, groups):
        body = self._read_json()
        if body.get("confirm") is not True:
            raise ApiError("bad_request", "explicit cancellation confirmation is required")
        job = self.server.app.study_jobs.cancel(
            params.get("profile", ""), groups["job"], provider=self.server.app.notebooklm)
        self._json_response(200, {"job": job, "book": job["bookId"]})

    def api_retry_study_job(self, params, groups):
        self._read_json()
        job = self.server.app.study_job_runner.retry(params.get("profile", ""), groups["job"])
        self._json_response(200, {"job": job, "book": job["bookId"]})

    def api_recheck_study_job(self, params, groups):
        self._read_json()
        job = self.server.app.study_job_runner.recheck(params.get("profile", ""), groups["job"])
        self._json_response(200, {"job": job, "book": job["bookId"]})

    def api_get_chapter(self, params, groups):
        self._json_response(200, self._library().get_chapter(
            groups["book"], groups["chapter"], params.get("profile", "")))

    def api_put_position(self, params, groups):
        body = self._read_json()
        self._library().put_position(
            groups["book"], params.get("profile", ""), body.get("chapter"), body.get("sentence"))
        self._no_content()

    # -- Chat / Conversations (ticket #47, ADR 0015) --------------------------

    def _conversations(self):
        return self.server.app.conversations

    def api_list_conversations(self, params, groups):
        self._json_response(200, self._conversations().list(params.get("profile", "")))

    def api_create_conversation(self, params, groups):
        self._read_json()  # empty object; keeps the Content-Length contract
        self._json_response(201, self._conversations().create(params.get("profile", "")))

    def api_get_conversation(self, params, groups):
        self._json_response(200, self._conversations().get(
            params.get("profile", ""), groups["conversation"]))

    def api_post_conversation_message(self, params, groups):
        body = self._read_json()
        try:
            result = self._conversations().post_message(
                params.get("profile", ""), groups["conversation"], body.get("text"),
                self.server.app.ai.chat)
        except LookupError as error:
            # ai_not_configured / ai_upstream_error / ai_timeout /
            # ai_usage_limit — the stored Conversation is untouched.
            code = str(error)
            self._json_error(STATUS_BY_CODE.get(code, 502), code)
            return
        self._json_response(200, result)

    # -- Read-owned Book AI (#71) -------------------------------------------

    def _book_conversations(self):
        return self.server.app.book_conversations

    def _book_conversation_response(self, result, status=200):
        conversation = result["conversation"]
        self._json_response(status, {
            "conversation": conversation,
            "book": conversation["bookId"],
            "contextScope": None,
        })

    def api_list_book_conversations(self, params, groups):
        result = self._book_conversations().list(params.get("profile", ""), groups["book"])
        self._json_response(200, {**result, "book": groups["book"], "contextScope": None})

    def api_create_book_conversation(self, params, groups):
        body = self._read_json()
        store = self._book_conversations()
        result = store.create(
            params.get("profile", ""), groups["book"], body.get("notebookRefId")
        ) if body.get("new") is True else store.open(
            params.get("profile", ""), groups["book"], body.get("notebookRefId")
        )
        self._book_conversation_response(result, 201 if result["created"] else 200)

    def api_get_book_conversation(self, params, groups):
        result = self._book_conversations().get(params.get("profile", ""), groups["conversation"])
        self._book_conversation_response(result)

    def api_resume_book_conversation(self, params, groups):
        self._read_json()
        result = self._book_conversations().activate(params.get("profile", ""), groups["conversation"])
        self._book_conversation_response(result)

    def api_delete_book_conversation(self, params, groups):
        self._book_conversations().delete(params.get("profile", ""), groups["conversation"])
        self._no_content()

    def api_post_book_conversation_message(self, params, groups):
        profile = params.get("profile", "")
        body = self._read_json()
        raw_context = body.get("context")
        try:
            conversation = self._book_conversations().get(profile, groups["conversation"])["conversation"]
            context = self._validated_book_context(
                conversation["bookId"], raw_context, body.get("bookId"))
            turn = self._book_conversations().prepare_message(
                profile, groups["conversation"], conversation["bookId"], body.get("text"), context)
        except ApiError:
            raise
        try:
            upstream = self.server.app.ai.book_chat_stream(turn["messages"], context)
        except (LookupError, ValueError) as error:
            code = str(error) if isinstance(error, LookupError) else "bad_request"
            self._json_error(STATUS_BY_CODE.get(code, 502), code)
            return

        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self._ndjson({
            "type": "meta",
            "conversation": {"id": conversation["id"], "bookId": conversation["bookId"]},
            "book": context["book"],
            "contextScope": context["scope"],
            "context": context,
        })
        answer = []
        completed = False
        try:
            for raw_line in upstream:
                try:
                    event = json.loads(raw_line.decode("utf-8"))
                    event_type = event.get("type") if isinstance(event, dict) else None
                    if event_type == "delta" and isinstance(event.get("text"), str):
                        answer.append(event["text"])
                        self._ndjson({"type": "delta", "text": event["text"]})
                    elif event_type == "done":
                        completed = True
                        break
                    elif event_type == "error":
                        code = event.get("code")
                        if code not in ("ai_not_configured", "ai_upstream_error",
                                        "ai_timeout", "ai_usage_limit"):
                            code = "ai_upstream_error"
                        self._ndjson({"type": "error", "code": code})
                        return
                except (UnicodeDecodeError, ValueError, AttributeError):
                    self._ndjson({"type": "error", "code": "ai_upstream_error"})
                    return
            if not completed:
                self._ndjson({"type": "error", "code": "ai_upstream_error"})
                return
            result = self._book_conversations().append_turn(
                profile, groups["conversation"], turn["text"], "".join(answer), context)
            self._ndjson({
                "type": "done",
                "conversation": result["conversation"],
                "contextScope": context["scope"],
            })
        except TimeoutError:
            self._ndjson({"type": "error", "code": "ai_timeout"})
        except OSError:
            self._ndjson({"type": "error", "code": "ai_upstream_error"})
        finally:
            upstream.close()
        self.close_connection = True

    def _validated_book_context(self, book_id, context, expected_book_id=None):
        snapshot = self.server.app.book_context.snapshot(context)
        compiled = self.server.app.book_context.compile(
            book_id, snapshot["scope"],
            chapter=(snapshot.get("anchor") or {}).get("chapter", 0),
            sentence=(snapshot.get("anchor") or {}).get("sentence"),
            start=(snapshot.get("anchor") or {}).get("start"),
            end=(snapshot.get("anchor") or {}).get("end"),
            selected_text=snapshot.get("selectedText"),
            expected_book_id=expected_book_id if expected_book_id is not None else snapshot["bookId"],
            content_hash=snapshot["contentHash"],
            max_chars=(snapshot.get("metadata") or {}).get("budgetChars"),
        )
        if snapshot != compiled:
            raise ApiError("bad_request", "context snapshot does not match the bound Book content")
        return snapshot

    # -- lookup / AI (ADR 0008) --------------------------------------------

    def api_lookup(self, params, groups):
        word = params.get("word", "")
        lang = _lookup_lang(params.get("lang", ""))
        try:
            entry = self._lookup(lang, word)
        except LookupUnavailable as error:
            self._json_error(503, "lookup_unavailable")
            return
        if entry is None:
            self._json_error(404, "entry_not_found")
            return
        self._json_response(200, {"lang": lang, "word": word, **entry})

    def api_lookup_check(self, params, groups):
        body = self._read_json()
        lang = _lookup_lang(body.get("lang", ""))
        words = body.get("words")
        if not isinstance(words, list) or any(not isinstance(word, str) for word in words):
            raise ApiError("bad_request", "words must be a list of strings")
        if len(words) > MAX_CHECK_WORDS:
            raise ApiError("too_large", f"check accepts at most {MAX_CHECK_WORDS} words")
        self._json_response(200, {"words": self.server.app.dicts.check(lang, words)})

    def api_ai(self, params, groups):
        body = self._read_json()
        word, sentence, language = body.get("word"), body.get("sentence"), body.get("language")
        explanation_locale = body.get("explanationLocale", DEFAULT_EXPLANATION_LOCALE)
        if not isinstance(word, str) or not isinstance(language, str) \
                or (sentence is not None and not isinstance(sentence, str)) \
                or not isinstance(explanation_locale, str):
            raise ApiError("bad_request", "word, language and explanationLocale must be strings")
        try:
            answer = self.server.app.ai.explain(word, sentence or "", language, explanation_locale)
        except ValueError as error:
            raise ApiError("bad_request", str(error)) from error
        except LookupError as error:
            code = str(error)
            self._json_error(STATUS_BY_CODE.get(code, 502), code)
            return
        self._json_response(200, answer)

    def api_notebooklm_status(self, params, groups):
        # This is a status-only seam for the optional provider. A missing or
        # stopped worker is a normal safe result, not a host failure.
        self._json_response(200, self.server.app.notebooklm.status())

    def _lookup(self, lang, word):
        dicts = self.server.app.dicts
        if lang == "en":
            return dicts.lookup_en(word)
        if lang == "ja":
            return dicts.lookup_ja(word)
        if lang == "zh":
            return dicts.lookup_zh(word)
        return None

    # -- request / response helpers ----------------------------------------

    def _read_body(self, limit):
        header = self.headers.get("Content-Length")
        if header is None:
            raise ApiError("bad_request", "Content-Length is required")
        try:
            length = int(header)
        except ValueError as error:
            raise ApiError("bad_request", "invalid Content-Length") from error
        if length < 0:
            raise ApiError("bad_request", "invalid Content-Length")
        if length > limit:
            # The unread body would desync keep-alive; close instead.
            self.close_connection = True
            raise ApiError("too_large", f"body exceeds {limit} bytes")
        return self.rfile.read(length) if length else b""

    def _read_json(self):
        raw = self._read_body(JSON_BODY_LIMIT)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise ApiError("bad_request", "body is not valid JSON") from error
        if not isinstance(body, dict):
            raise ApiError("bad_request", "body must be a JSON object")
        return body

    def _json_response(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _no_content(self):
        self.send_response(204)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _ndjson(self, payload):
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
        self.wfile.flush()

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
        static_root = os.path.abspath(self.server.app.static_dir)
        # The next-generation shell lives in <static_dir>/next/ and is served
        # under /next/ while the old shell keeps / (ADR 0014). Same
        # traversal guard, rooted at the subdirectory.
        if path == "/next" or path.startswith("/next/"):
            path = path[len("/next"):]
            if path in ("", "/"):
                path = "/index.html"
            static_root = os.path.join(static_root, "next")
        elif path == "/":
            path = "/index.html"
        candidate = os.path.abspath(os.path.join(static_root, unquote_plus(path).lstrip("/")))
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


def _lookup_lang(lang):
    """Canonical lookup language code: zh-CN / zh-TW all resolve to zh."""
    lang = (lang or "").strip().lower()
    if lang.startswith("zh"):
        return "zh"
    return lang


def _parse_query(query):
    params = {}
    for pair in query.split("&"):
        if not pair:
            continue
        name, _, value = pair.partition("=")
        params[name] = unquote_plus(value)
    return params


def run(static_dir=DEFAULT_STATIC_DIR, cache_dir=DEFAULT_CACHE_DIR, port=8000, host="0.0.0.0",
        data_dir=DEFAULT_DATA_DIR):
    app = TtsServer(static_dir=static_dir, cache_dir=cache_dir, data_dir=data_dir)
    httpd = AppServer((host, port), TtsHandler, app)
    print(f"LearnBuddy serving {static_dir} on http://{host}:{port} (cache: {cache_dir}, data: {data_dir})", flush=True)
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
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR)
    args = parser.parse_args(argv)
    run(static_dir=args.static, cache_dir=args.cache_dir, port=args.port, host=args.host,
        data_dir=args.data_dir)


if __name__ == "__main__":
    main()
