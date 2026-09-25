"""AI context explanation — the Python side of 查义's second layer (ADR 0008,
decision in #15): a thin proxy in front of the `learnbuddy-ai` Node service
(pi SDK wrapping whatever model pi is configured with).

The frontend never talks to the AI service directly; this proxy owns the
cache (SHA-256 of word|sentence|language|explanationLocale, shared across
Profiles — an explanation is a language fact, not learner state) and the degrade codes
copied from the TTS exception vocabulary:

- `ai_not_configured` — LEARNBUDDY_AI_URL unset (tab shows the copy, entry stays)
- `ai_upstream_error` — the service answered non-200 or unusable
- `ai_timeout`        — 20 s elapse without an answer (retryable in the tab)
- `ai_usage_limit`    — the sidecar flagged a usage wall (ADR 0013); copy
  says 用量受限, never "quota exhausted"

Requests carry only the target word, its sentence, source language and
explanation locale — never Profile identity. The explanation locale defaults
to zh-CN so Chinese-native learners get a truthful, explicit contract.

Chat (ticket #47): `chat()` is the sibling turn call — the current
Conversation's text history plus the new message, nothing else (ADR 0015).
Chat replies are Person-scoped conversation state, so they are NEVER cached
in the shared ai-cache (that cache is for Person-independent language
facts). Upstream provider error text is never forwarded (spec §9.2): only
the fixed codes above cross the HTTP boundary.
"""

import hashlib
import json
import os
import urllib.error
import urllib.request

AI_TIMEOUT_SECONDS = 20
DEFAULT_EXPLANATION_LOCALE = "zh-CN"


class AiProxy:
    def __init__(self, cache_dir, url=None, timeout=AI_TIMEOUT_SECONDS, urlopen=None,
                 stream_open=None):
        # url=None reads the environment; url="" forces the not-configured
        # degrade so tests never depend on the developer's environment.
        self.url = os.environ.get("LEARNBUDDY_AI_URL", "") if url is None else url
        self.cache_dir = cache_dir
        self.timeout = timeout
        self._urlopen = urlopen or _default_urlopen
        self._stream_open = stream_open or _default_stream_open

    def explain(self, word, sentence, language, explanation_locale=DEFAULT_EXPLANATION_LOCALE):
        word = (word or "").strip()
        sentence = (sentence or "").strip()
        language = (language or "").strip()
        explanation_locale = (explanation_locale or DEFAULT_EXPLANATION_LOCALE).strip()
        if not word or not language or not explanation_locale:
            raise ValueError("word, language and explanation locale are required")
        key = hashlib.sha256(
            f"{word}|{sentence}|{language}|{explanation_locale}".encode("utf-8")
        ).hexdigest()
        cached = self._read_cache(key)
        if cached is not None:
            return cached
        if not self.url:
            raise LookupError("ai_not_configured")
        answer = self._ask(word, sentence, language, explanation_locale)
        self._write_cache(key, answer)
        return answer

    def chat(self, messages):
        """One Chat turn: `messages` is exactly the current Conversation's
        text history plus the new user message (assembled by
        conversations.py, ADR 0015). Uncached by design."""
        cleaned = self._clean_messages(messages)
        if not self.url:
            raise LookupError("ai_not_configured")
        body = json.dumps({"messages": cleaned}, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.url.rstrip("/") + "/chat",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return self._urlopen(request, self.timeout)

    def book_chat_stream(self, messages, context):
        """Open the private sidecar's explicit NDJSON Book AI stream.

        The caller owns parsing and persistence. This method only validates the
        payload, opens the response, and maps transport/HTTP failures onto the
        same fixed product codes as ordinary AI calls; it never exposes an
        upstream response body.
        """
        cleaned = self._clean_messages(messages)
        if not isinstance(context, dict) or not isinstance(context.get("text"), str) \
                or context.get("dataOnly") is not True or not context.get("bookId") \
                or not context.get("contentHash"):
            raise ValueError("a valid BookContext snapshot is required")
        if not self.url:
            raise LookupError("ai_not_configured")
        body = json.dumps({"messages": cleaned, "context": context}, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.url.rstrip("/") + "/book-chat",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return self._stream_open(request, self.timeout)

    # -- internals ----------------------------------------------------------

    @staticmethod
    def _clean_messages(messages):
        if not isinstance(messages, list) or not messages:
            raise ValueError("messages must be a non-empty list")
        cleaned = []
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in ("user", "assistant") \
                    or not isinstance(message.get("content"), str) or not message["content"].strip():
                raise ValueError("messages must be {role: user|assistant, content} entries")
            cleaned.append({"role": message["role"], "content": message["content"]})
        if cleaned[-1]["role"] != "user":
            raise ValueError("the last message must be the new user message")
        return cleaned

    def _ask(self, word, sentence, language, explanation_locale):
        body = json.dumps(
            {
                "word": word,
                "sentence": sentence,
                "language": language,
                "explanationLocale": explanation_locale,
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = urllib.request.Request(
            self.url.rstrip("/") + "/explain",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return self._urlopen(request, self.timeout)

    def _read_cache(self, key):
        try:
            with open(os.path.join(self.cache_dir, f"{key}.json"), "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    def _write_cache(self, key, answer):
        os.makedirs(self.cache_dir, exist_ok=True)
        path = os.path.join(self.cache_dir, f"{key}.json")
        tmp = f"{path}.tmp.{os.getpid()}"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(answer, fh, ensure_ascii=False)
            os.replace(tmp, path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def _default_stream_open(request, timeout, urlopen=None):
    """Open a sidecar response without ever copying its error body outward."""
    open_url = urlopen or urllib.request.urlopen
    try:
        return open_url(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        code = "ai_upstream_error"
        try:
            payload = json.loads(error.read().decode("utf-8"))
            if isinstance(payload, dict) and payload.get("error") == "usage_limit":
                code = "ai_usage_limit"
        except (ValueError, UnicodeDecodeError):
            pass
        raise LookupError(code) from error
    except (TimeoutError, urllib.error.URLError) as error:
        reason = getattr(error, "reason", None)
        timed_out = isinstance(error, TimeoutError) or isinstance(reason, TimeoutError) \
            or "timed out" in str(reason).lower()
        raise LookupError("ai_timeout" if timed_out else "ai_upstream_error") from error


def _default_urlopen(request, timeout, urlopen=None):
    """The default upstream call; raises LookupError with the degrade codes."""
    open_url = urlopen or urllib.request.urlopen
    try:
        with open_url(request, timeout=timeout) as response:
            answer = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # The sidecar flags a usage wall with {"error": "usage_limit"} so the
        # family sees 用量受限 instead of a generic failure (ADR 0013). Only
        # the fixed code is read — the upstream's own text is discarded.
        code = "ai_upstream_error"
        try:
            payload = json.loads(error.read().decode("utf-8"))
            if isinstance(payload, dict) and payload.get("error") == "usage_limit":
                code = "ai_usage_limit"
        except (ValueError, UnicodeDecodeError):
            pass
        raise LookupError(code) from error
    except (TimeoutError, urllib.error.URLError, ValueError) as error:
        # A read timeout surfaces as a bare TimeoutError (no .reason); a connect
        # timeout arrives wrapped in URLError. Both mean the 20 s budget is out.
        reason = getattr(error, "reason", None)
        timed_out = (
            isinstance(error, TimeoutError)
            or isinstance(reason, TimeoutError)
            or "timed out" in str(reason).lower()
        )
        raise LookupError("ai_timeout" if timed_out else "ai_upstream_error") from error
    if not isinstance(answer, dict) or not isinstance(answer.get("text"), str):
        raise LookupError("ai_upstream_error")
    return {"text": answer["text"]}
