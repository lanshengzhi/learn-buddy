"""Compile bounded, Book-owned context for Book AI.

The compiler is deliberately a data-only boundary: it reads the local Library's
baked chapters and returns text plus provenance.  It does not build prompts or
call a model.  A context always carries the Book id and the hash of the EPUB
bytes; callers must pass that pair when a context is persisted or sent.
"""

import hashlib
import json
import os
import re

from library import ApiError, _read_json

DEFAULT_MAX_CONTEXT_CHARS = 4000
NEIGHBOR_SENTENCES = 1
VALID_SCOPES = ("sentence", "selection", "chapter", "book")


def _require_int(value, field, minimum=0):
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise ApiError("bad_request", f"{field} must be an integer >= {minimum}")
    return value


def _token_estimate(text):
    # This is a measured, deterministic budget aid, not tokenizer output.
    return len(text) // 4 + (1 if text else 0)


def _manifest(library, book_id):
    if not isinstance(book_id, str) or not re.fullmatch(r"[0-9a-f]{64}", book_id):
        raise ApiError("book_not_found", f"unknown book: {book_id}")
    manifest = _read_json(os.path.join(library.root, "books", book_id, "manifest.json"), None)
    if not isinstance(manifest, dict) or manifest.get("id") != book_id:
        raise ApiError("book_not_found", f"unknown book: {book_id}")
    return manifest


def _book_hash(library, book_id):
    path = os.path.join(library.root, "books", book_id, "book.epub")
    try:
        digest_builder = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest_builder.update(chunk)
        digest = digest_builder.hexdigest()
    except OSError as error:
        raise ApiError("book_not_found", "book content is unavailable") from error
    # The directory id is content-addressed.  Verify it rather than trusting a
    # stale or hand-edited manifest; this is the fail-closed book binding.
    if digest != book_id:
        raise ApiError("book_not_found", "book content does not match its id")
    return digest


def _chapter(library, book_id, index, manifest):
    index = _require_int(index, "chapter")
    if index >= manifest.get("chapters", 0):
        raise ApiError("chapter_not_found", f"no chapter {index}")
    data = _read_json(os.path.join(library.root, "books", book_id, "chapters", f"{index:04d}.json"), None)
    if not isinstance(data, dict) or not isinstance(data.get("sentences"), list):
        raise ApiError("chapter_not_found", f"no chapter {index}")
    return data


def _text(sentence):
    if isinstance(sentence, dict) and isinstance(sentence.get("t"), str):
        return sentence["t"]
    return str(sentence or "")


def _fit(parts, max_chars):
    """Keep whole sentences where possible, and expose exact truncation."""
    original = sum(len(text) + (1 if index else 0) for index, text in enumerate(parts))
    kept = []
    used = 0
    for text in parts:
        if not text:
            continue
        extra = len(text) + (1 if kept else 0)
        if used + extra > max_chars:
            remaining = max_chars - used - (1 if kept else 0)
            if remaining > 0:
                kept.append(text[:remaining])
            break
        kept.append(text)
        used += extra
    return "\n".join(kept), original, len("\n".join(kept)) < original


class BookContextCompiler:
    """Compile a context from local chapter data, never from caller text."""

    def __init__(self, library, max_chars=DEFAULT_MAX_CONTEXT_CHARS):
        self.library = library
        self.max_chars = max_chars

    def compile(self, book_id, scope, chapter=0, sentence=None, start=None, end=None,
                 selected_text=None, expected_book_id=None, content_hash=None, max_chars=None):
        manifest = _manifest(self.library, book_id)
        digest = _book_hash(self.library, book_id)
        if expected_book_id is not None and expected_book_id != book_id:
            raise ApiError("book_not_found", "context belongs to another book")
        if content_hash is not None and content_hash != digest:
            raise ApiError("book_not_found", "context content hash does not match book")
        if scope not in VALID_SCOPES:
            raise ApiError("bad_request", "scope must be sentence, selection, chapter, or book")
        budget = self.max_chars if max_chars is None else _require_int(max_chars, "maxChars", 1)
        if budget > self.max_chars:
            raise ApiError("bad_request", f"maxChars exceeds the {self.max_chars} character budget")
        if selected_text is not None and (not isinstance(selected_text, str) or not selected_text.strip()):
            raise ApiError("bad_request", "selectedText must be non-empty text or null")
        selected = None
        if scope in ("sentence", "selection"):
            data = _chapter(self.library, book_id, chapter, manifest)
            sentences = data["sentences"]
            if scope == "sentence":
                target = _require_int(sentence if sentence is not None else 0, "sentence")
                if target >= len(sentences):
                    raise ApiError("chapter_not_found", "sentence is outside chapter")
                selected = (max(0, target - NEIGHBOR_SENTENCES), min(len(sentences) - 1, target + NEIGHBOR_SENTENCES))
                anchor = {"chapter": chapter, "sentence": target}
            else:
                first = _require_int(start if start is not None else 0, "start")
                last = _require_int(end if end is not None else first, "end")
                if last < first or last >= len(sentences):
                    raise ApiError("bad_request", "selection is outside chapter")
                selected = (max(0, first - NEIGHBOR_SENTENCES), min(len(sentences) - 1, last + NEIGHBOR_SENTENCES))
                anchor = {"chapter": chapter, "start": first, "end": last}
            if scope == "sentence":
                parts = [_text(sentences[offset]) for offset in range(selected[0], selected[1] + 1)]
            else:
                parts = [_text(sentences[offset]) for offset in range(selected[0], selected[1] + 1)]
            text, original, truncated = _fit(parts, budget)
        elif scope == "chapter":
            data = _chapter(self.library, book_id, chapter, manifest)
            parts = [_text(item) for item in data["sentences"]]
            text, original, truncated = _fit(parts, budget)
            anchor = {"chapter": chapter}
        else:
            parts = []
            for index in range(manifest.get("chapters", 0)):
                data = _chapter(self.library, book_id, index, manifest)
                parts.extend(_text(item) for item in data["sentences"])
            text, original, truncated = _fit(parts, budget)
            anchor = {"wholeBook": True}
        context = {
            "bookId": book_id,
            "book": {"id": book_id, "title": manifest.get("title", ""), "contentHash": digest},
            "contentHash": digest,
            "scope": scope,
            "mode": scope,
            "anchor": anchor,
            # The text is data for the caller/model boundary.  The compiler
            # never appends prompt-like instructions to retrieved content.
            "text": text,
            "dataOnly": True,
            "metadata": {
                "budgetChars": budget,
                "originalChars": original,
                "includedChars": len(text),
                "tokenEstimate": _token_estimate(text),
                "truncated": truncated,
            },
        }
        if selected_text is not None:
            # This is provenance for the exact browser selection. It never
            # replaces the host-assembled, bounded context text above.
            context["selectedText"] = selected_text
        return context

    def snapshot(self, context):
        """Return a defensive, fail-closed JSON snapshot for a turn."""
        if not isinstance(context, dict) or not context.get("bookId") or not context.get("contentHash"):
            raise ApiError("bad_request", "context snapshot is invalid")
        manifest = _manifest(self.library, context["bookId"])
        if context["contentHash"] != _book_hash(self.library, context["bookId"]):
            raise ApiError("book_not_found", "context content hash does not match book")
        if context.get("scope") not in VALID_SCOPES:
            raise ApiError("bad_request", "context snapshot scope is invalid")
        return json.loads(json.dumps(context, ensure_ascii=False, sort_keys=True))
