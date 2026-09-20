"""Server-side learner records, Profiles and the Book Library.

The server is the only store of learner records (ADR 0007). Everything lives
under one data root:

```
profiles.json                                   # read-only Profile list
state/<profile>/prefs.json                      # rate_preset, loop_mode, lastBook
state/<profile>/history.json                    # History entries, newest first
state/<profile>/words.json                      # 我认识 word states
books/<sha256>/
    book.epub                                   # the upload, kept for re-parsing
    manifest.json                               # metadata + toc + parseVersion
    chapters/NNNN.json                          # baked sentences + words + ruby
    positions/<profile>.json                    # Reading position per Profile
```

One file per record class, written `.tmp` + atomic rename; no locks, so
concurrent writes within a class are last-write-wins. Errors surface as
`ApiError(code)` carrying the shared API error vocabulary.
"""

import hashlib
import json
import os
import re
import threading
import time

import epub
import textseg

MAX_HISTORY_ENTRIES = 50
ANCHOR_TEXT_CHARS = 40
DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024

DEFAULT_STATE = {"rate_preset": "Normal", "loop_mode": "All", "lastBook": None, "hl_mode": "underline"}
DEFAULT_PROFILES = [
    {"id": "dad", "name": "爸爸"},
    {"id": "mom", "name": "妈妈"},
    {"id": "d1", "name": "大女儿"},
    {"id": "d2", "name": "小女儿"},
]

_SHA256_RE = re.compile(r"[0-9a-f]{64}")


class ApiError(Exception):
    """An API error carrying a code the handler maps to an HTTP status."""

    def __init__(self, code, message=""):
        super().__init__(message or code)
        self.code = code
        self.message = message


def _tmp_path(path):
    return f"{path}.tmp.{os.getpid()}.{threading.get_ident()}"


def _write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = _tmp_path(path)
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def _write_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = _tmp_path(path)
    with open(tmp, "wb") as handle:
        handle.write(data)
    os.replace(tmp, path)


def _read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as error:
        raise ApiError("unknown", f"corrupt data file: {path}") from error


def _require_int(value, field):
    if not isinstance(value, int) or isinstance(value, bool):
        raise ApiError("bad_request", f"{field} must be an integer")
    return value


def _require_numeric_id(value, field):
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    raise ApiError("bad_request", f"{field} must be a number")


def _clamp_sentence(sentence, sentences):
    """Reads tolerate a stale position after a re-parse; writes clamp rather
    than reject so a debounced save never loses the reader's place."""
    if not sentences:
        return 0
    return max(0, min(sentence, len(sentences) - 1))


def _sorted_entries(entries):
    return sorted(entries, key=lambda entry: (entry.get("createdAt", 0), entry.get("id", 0)), reverse=True)


def _trim_history(entries, limit):
    """Keep every Favorite plus the newest `limit` non-favorites; returns
    `(kept_entries, removed_ids)`."""
    kept_ids = {entry["id"] for entry in _sorted_entries([e for e in entries if not e.get("favorite")])[:limit]}
    kept_ids.update(entry["id"] for entry in entries if entry.get("favorite"))
    removed = [entry["id"] for entry in entries if entry["id"] not in kept_ids]
    return [entry for entry in entries if entry["id"] in kept_ids], removed


class Library:
    """File-backed learner records and Books under `root`."""

    def __init__(self, root, max_upload_bytes=DEFAULT_MAX_UPLOAD_BYTES,
                 ja_tokenizer=None, now=None):
        self.root = os.path.abspath(root)
        self.max_upload_bytes = max_upload_bytes
        self.ja_tokenizer = ja_tokenizer or textseg.tokenize_ja
        self.now = now or time.time
        os.makedirs(self.root, exist_ok=True)

    # -- paths -------------------------------------------------------------

    @property
    def books_dir(self):
        return os.path.join(self.root, "books")

    def _state_path(self, profile_id, name):
        return os.path.join(self.root, "state", profile_id, f"{name}.json")

    def _book_path(self, book_id, *parts):
        return os.path.join(self.books_dir, book_id, *parts)

    def _manifest_path(self, book_id):
        return self._book_path(book_id, "manifest.json")

    def _chapter_path(self, book_id, index):
        return self._book_path(book_id, "chapters", f"{index:04d}.json")

    def _position_path(self, book_id, profile_id):
        return self._book_path(book_id, "positions", f"{profile_id}.json")

    # -- Profiles ----------------------------------------------------------

    def profiles(self):
        path = os.path.join(self.root, "profiles.json")
        if not os.path.isfile(path):
            _write_json(path, {"profiles": [dict(profile) for profile in DEFAULT_PROFILES]})
        document = _read_json(path, {"profiles": []})
        profiles = document.get("profiles", []) if isinstance(document, dict) else []
        return {"profiles": [profile for profile in profiles if isinstance(profile, dict) and profile.get("id")]}

    def require_profile(self, profile_id):
        if not profile_id:
            raise ApiError("bad_request", "profile is required")
        if "/" in profile_id or "\\" in profile_id or profile_id in (".", ".."):
            raise ApiError("profile_not_found", f"unknown profile: {profile_id}")
        if profile_id not in {profile["id"] for profile in self.profiles()["profiles"]}:
            raise ApiError("profile_not_found", f"unknown profile: {profile_id}")
        return profile_id

    # -- state (prefs) -----------------------------------------------------

    def get_state(self, profile_id):
        self.require_profile(profile_id)
        stored = _read_json(self._state_path(profile_id, "prefs"), {})
        state = dict(DEFAULT_STATE)
        if isinstance(stored, dict):
            for key in DEFAULT_STATE:
                if key in stored:
                    state[key] = stored[key]
        return state

    def put_state(self, profile_id, patch):
        self.require_profile(profile_id)
        if not isinstance(patch, dict):
            raise ApiError("bad_request", "body must be an object")
        state = self.get_state(profile_id)
        for key, value in patch.items():
            if key not in DEFAULT_STATE:
                continue
            if key == "lastBook":
                if value is not None and not isinstance(value, str):
                    raise ApiError("bad_request", "lastBook must be a string or null")
            elif not isinstance(value, str):
                raise ApiError("bad_request", f"{key} must be a string")
            state[key] = value
        _write_json(self._state_path(profile_id, "prefs"), state)
        return state

    # -- History -----------------------------------------------------------

    def _read_history(self, profile_id):
        document = _read_json(self._state_path(profile_id, "history"), None)
        if not isinstance(document, dict) or not isinstance(document.get("entries"), list):
            return {"entries": [], "nextId": 1}
        return document

    def get_history(self, profile_id):
        self.require_profile(profile_id)
        return {"entries": _sorted_entries(self._read_history(profile_id)["entries"])}

    def add_history(self, profile_id, text):
        self.require_profile(profile_id)
        if not isinstance(text, str) or not text.strip():
            raise ApiError("bad_request", "text is required")
        text = text.strip()
        created_at = int(self.now() * 1000)
        document = self._read_history(profile_id)
        entries = document["entries"]
        entry = next((existing for existing in entries if existing.get("text") == text), None)
        if entry is None:
            next_id = document.get("nextId")
            if not isinstance(next_id, int) or next_id <= max((e.get("id", 0) for e in entries), default=0):
                next_id = max((e.get("id", 0) for e in entries), default=0) + 1
            entry = {
                "id": next_id,
                "text": text,
                "createdAt": created_at,
                "favorite": False,
                "selectedIndex": None,
            }
            document["nextId"] = entry["id"] + 1
            entries.append(entry)
        else:
            entry["createdAt"] = created_at
        document["entries"], trimmed = _trim_history(entries, MAX_HISTORY_ENTRIES)
        _write_json(self._state_path(profile_id, "history"), document)
        return {"entry": entry, "trimmed": trimmed}

    def patch_history(self, profile_id, entry_id, patch):
        self.require_profile(profile_id)
        entry_id = _require_numeric_id(entry_id, "entry id")
        if not isinstance(patch, dict):
            raise ApiError("bad_request", "body must be an object")
        document = self._read_history(profile_id)
        entry = next((existing for existing in document["entries"] if existing.get("id") == entry_id), None)
        if entry is None:
            raise ApiError("entry_not_found", f"no history entry {entry_id}")
        if "favorite" in patch:
            if not isinstance(patch["favorite"], bool):
                raise ApiError("bad_request", "favorite must be a boolean")
            entry["favorite"] = patch["favorite"]
        if "selectedIndex" in patch:
            value = patch["selectedIndex"]
            if value is not None and (
                not isinstance(value, int) or isinstance(value, bool) or value < 0
            ):
                raise ApiError("bad_request", "selectedIndex must be a non-negative integer or null")
            entry["selectedIndex"] = value
        _write_json(self._state_path(profile_id, "history"), document)
        return {"entry": entry}

    def delete_history(self, profile_id, entry_id):
        self.require_profile(profile_id)
        entry_id = _require_numeric_id(entry_id, "entry id")
        document = self._read_history(profile_id)
        remaining = [entry for entry in document["entries"] if entry.get("id") != entry_id]
        if len(remaining) == len(document["entries"]):
            raise ApiError("entry_not_found", f"no history entry {entry_id}")
        document["entries"] = remaining
        _write_json(self._state_path(profile_id, "history"), document)

    # -- words -------------------------------------------------------------

    def get_words(self, profile_id):
        self.require_profile(profile_id)
        document = _read_json(self._state_path(profile_id, "words"), {})
        words = document.get("words", []) if isinstance(document, dict) else []
        return {"words": [word for word in words if isinstance(word, str)]}

    def update_words(self, profile_id, add=None, remove=None):
        self.require_profile(profile_id)
        if add is None and remove is None:
            raise ApiError("bad_request", "add or remove is required")
        for name, values in (("add", add), ("remove", remove)):
            if values is None:
                continue
            if not isinstance(values, list) or not all(isinstance(value, str) and value for value in values):
                raise ApiError("bad_request", f"{name} must be a list of strings")
        words = set(self.get_words(profile_id)["words"])
        words.update(add or [])
        words.difference_update(remove or [])
        result = sorted(words)
        _write_json(self._state_path(profile_id, "words"), {"words": result})
        return {"words": result}

    # -- Books -------------------------------------------------------------

    def add_book(self, profile_id, name, data):
        self.require_profile(profile_id)
        if not isinstance(name, str) or not name.strip():
            raise ApiError("bad_request", "name is required")
        if len(data) > self.max_upload_bytes:
            raise ApiError("too_large", "epub exceeds the upload limit")
        book_id = hashlib.sha256(data).hexdigest()
        manifest_path = self._manifest_path(book_id)
        if os.path.isfile(manifest_path):
            manifest = _read_json(manifest_path, {})
            return True, {"book": self._book_summary(manifest, profile_id)}
        try:
            parsed = epub.parse_epub(data, ja_tokenizer=self.ja_tokenizer)
        except epub.ParseError as error:
            raise ApiError(error.code, error.message) from error

        _write_bytes(self._book_path(book_id, "book.epub"), data)
        for index, chapter in enumerate(parsed["chapters"]):
            _write_json(self._chapter_path(book_id, index), {
                "index": index,
                "title": chapter["title"],
                "sentences": chapter["sentences"],
            })
        manifest = {
            "id": book_id,
            "title": parsed["title"],
            "author": parsed["author"],
            "lang": parsed["lang"],
            "chapters": len(parsed["chapters"]),
            "toc": [
                {"index": index, "title": chapter["title"]}
                for index, chapter in enumerate(parsed["chapters"])
            ],
            "parseVersion": epub.PARSE_VERSION,
            "fileName": os.path.basename(name.strip()),
            "uploadedBy": profile_id,
            "addedAt": int(self.now()),
            "size": len(data),
        }
        # The manifest is written last: its presence marks the book complete.
        _write_json(manifest_path, manifest)
        return False, {"book": self._book_summary(manifest, profile_id)}

    def list_books(self, profile_id):
        self.require_profile(profile_id)
        books = []
        for book_id in sorted(os.listdir(self.books_dir)) if os.path.isdir(self.books_dir) else []:
            manifest_path = self._manifest_path(book_id)
            if not os.path.isfile(manifest_path):
                continue
            manifest = _read_json(manifest_path, {})
            if isinstance(manifest, dict) and manifest.get("id") == book_id:
                books.append(self._book_summary(manifest, profile_id))
        books.sort(key=lambda book: (book["addedAt"], book["id"]), reverse=True)
        return {"books": books}

    def get_book(self, book_id, profile_id=None):
        manifest = self._require_manifest(book_id)
        book = {**self._book_info(manifest), "fileName": manifest.get("fileName", "")}
        if profile_id is not None:
            # The asker's reading rides along so reopening the app resumes the
            # right chapter (the library list carries the same field).
            self.require_profile(profile_id)
            book["reading"] = self._reading(book_id, profile_id)
        return {"book": book, "toc": manifest.get("toc", [])}

    def get_chapter(self, book_id, index, profile_id):
        self.require_profile(profile_id)
        manifest = self._require_manifest(book_id)
        index = _require_numeric_id(index, "chapter")
        count = manifest.get("chapters", 0)
        if index < 0 or index >= count:
            raise ApiError("chapter_not_found", f"no chapter {index}")
        chapter = _read_json(self._chapter_path(book_id, index), None)
        if not isinstance(chapter, dict):
            raise ApiError("chapter_not_found", f"no chapter {index}")
        sentences = chapter.get("sentences", [])
        return {
            "chapter": {
                "index": index,
                "title": chapter.get("title", ""),
                "prev": index - 1 if index > 0 else None,
                "next": index + 1 if index + 1 < count else None,
                "sentences": sentences,
            },
            "reading": {"sentence": self._reading_sentence(book_id, profile_id, index, sentences)},
        }

    def put_position(self, book_id, profile_id, chapter, sentence):
        self.require_profile(profile_id)
        manifest = self._require_manifest(book_id)
        chapter = _require_int(chapter, "chapter")
        if chapter < 0 or chapter >= manifest.get("chapters", 0):
            raise ApiError("chapter_not_found", f"no chapter {chapter}")
        sentence = _require_int(sentence, "sentence")
        if sentence < 0:
            raise ApiError("bad_request", "sentence must not be negative")
        chapter_data = _read_json(self._chapter_path(book_id, chapter), None)
        if not isinstance(chapter_data, dict):
            raise ApiError("chapter_not_found", f"no chapter {chapter}")
        sentences = chapter_data.get("sentences", [])
        sentence = _clamp_sentence(sentence, sentences)
        text = sentences[sentence]["t"][:ANCHOR_TEXT_CHARS] if sentences else ""
        _write_json(self._position_path(book_id, profile_id), {
            "chapter": chapter,
            "sentence": sentence,
            "text": text,
        })

    # -- internals ---------------------------------------------------------

    def _require_manifest(self, book_id):
        if not isinstance(book_id, str) or not _SHA256_RE.fullmatch(book_id):
            raise ApiError("book_not_found", f"unknown book: {book_id}")
        manifest = _read_json(self._manifest_path(book_id), None)
        if not isinstance(manifest, dict):
            raise ApiError("book_not_found", f"unknown book: {book_id}")
        return manifest

    def _book_info(self, manifest):
        return {
            "id": manifest.get("id", ""),
            "title": manifest.get("title", ""),
            "author": manifest.get("author", ""),
            "lang": manifest.get("lang", ""),
            "chapters": manifest.get("chapters", 0),
            "addedAt": manifest.get("addedAt", 0),
            "uploadedBy": manifest.get("uploadedBy", ""),
        }

    def _book_summary(self, manifest, profile_id):
        return {
            **self._book_info(manifest),
            "reading": self._reading(manifest.get("id", ""), profile_id),
        }

    def _stored_position(self, book_id, profile_id):
        position = _read_json(self._position_path(book_id, profile_id), None)
        return position if isinstance(position, dict) else None

    def _reading(self, book_id, profile_id):
        position = self._stored_position(book_id, profile_id)
        if position is None:
            return None
        chapter = position.get("chapter")
        sentence = position.get("sentence")
        if not isinstance(chapter, int) or not isinstance(sentence, int):
            return None
        return {"chapter": chapter, "sentence": sentence}

    def _reading_sentence(self, book_id, profile_id, index, sentences):
        position = self._stored_position(book_id, profile_id)
        if position is None or position.get("chapter") != index:
            return 0
        sentence = position.get("sentence", 0)
        if not isinstance(sentence, int) or sentence < 0:
            return 0
        return _clamp_sentence(sentence, sentences)
