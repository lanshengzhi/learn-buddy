"""AI context explanation — the Python side of 查义's second layer (ADR 0008,
decision in #15): a thin proxy in front of the `learnbuddy-ai` Node service
(pi SDK wrapping whatever model pi is configured with).

The frontend never talks to the AI service directly; this proxy owns the
cache (SHA-256 of word|sentence|language, shared across Profiles — an
explanation is a language fact, not learner state) and the degrade codes
copied from the TTS exception vocabulary:

- `ai_not_configured` — LEARNBUDDY_AI_URL unset (tab shows the copy, entry stays)
- `ai_upstream_error` — the service answered non-200 or unusable
- `ai_timeout`        — 20 s elapse without an answer (retryable in the tab)

Requests carry only the target word, its sentence and the language — never
Profile identity.
"""

import hashlib
import json
import os
import urllib.error
import urllib.request

AI_TIMEOUT_SECONDS = 20


class AiProxy:
    def __init__(self, cache_dir, url=None, timeout=AI_TIMEOUT_SECONDS, urlopen=None):
        # url=None reads the environment; url="" forces the not-configured
        # degrade so tests never depend on the developer's environment.
        self.url = os.environ.get("LEARNBUDDY_AI_URL", "") if url is None else url
        self.cache_dir = cache_dir
        self.timeout = timeout
        self._urlopen = urlopen or _default_urlopen

    def explain(self, word, sentence, language):
        word = (word or "").strip()
        sentence = (sentence or "").strip()
        language = (language or "").strip()
        if not word or not language:
            raise ValueError("word and language are required")
        key = hashlib.sha256(f"{word}|{sentence}|{language}".encode("utf-8")).hexdigest()
        cached = self._read_cache(key)
        if cached is not None:
            return cached
        if not self.url:
            raise LookupError("ai_not_configured")
        answer = self._ask(word, sentence, language)
        self._write_cache(key, answer)
        return answer

    # -- internals ----------------------------------------------------------

    def _ask(self, word, sentence, language):
        body = json.dumps({"word": word, "sentence": sentence, "language": language}, ensure_ascii=False).encode("utf-8")
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


def _default_urlopen(request, timeout, urlopen=None):
    """The default upstream call; raises LookupError with the degrade codes."""
    open_url = urlopen or urllib.request.urlopen
    try:
        with open_url(request, timeout=timeout) as response:
            answer = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise LookupError("ai_upstream_error") from error
    except (TimeoutError, urllib.error.URLError, ValueError) as error:
        reason = getattr(error, "reason", None)
        timed_out = isinstance(reason, TimeoutError) or "timed out" in str(reason).lower()
        raise LookupError("ai_timeout" if timed_out else "ai_upstream_error") from error
    if not isinstance(answer, dict) or not isinstance(answer.get("text"), str):
        raise LookupError("ai_upstream_error")
    return {"text": answer["text"]}
