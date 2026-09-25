"""Local persistence for Read-owned Book AI records (issue #67).

BookConversations and ordinary Chat Conversations deliberately use different
file trees:

```
state/<person>/book-conversations/NNNNNN.json
books/<book-content-hash>/notebook-ref.json
```

The first is Person-scoped product data. The second is a non-authoritative
NotebookLM mapping: ``bookId`` and ``bookContentHash`` always remain the local
SHA-256 identity, even when remote provider IDs are present. Both stores use
``library._write_json`` so a complete JSON document replaces its destination
atomically.
"""

import json
import os
import re
import threading
import time
import uuid

from library import ApiError, _read_json, _write_json

DEFAULT_TITLE = "新对话"
MAX_MESSAGE_CHARS = 8000
MAX_MESSAGES = 500
_ID_RE = re.compile(r"[0-9]{6}")


class BookConversations:
    """Person/Book-scoped conversations with at most one active thread.

    ``open`` is the default Read entry point: it returns the existing active
    conversation for a Book or creates one. ``create`` deliberately supports
    multiple historical conversations for the same Person and Book.
    """

    def __init__(self, root, require_profile, require_book, now=None):
        self.root = os.path.abspath(root)
        self.require_profile = require_profile
        self.require_book = require_book
        self.now = now or time.time

    def list(self, profile_id, book_id):
        self._require_scope(profile_id, book_id)
        documents = [
            document for document in self._read_all(profile_id)
            if document.get("bookId") == book_id and document.get("deletedAt") is None
        ]
        documents.sort(
            key=lambda document: (document.get("updatedAt", 0), document.get("id", "")),
            reverse=True,
        )
        return {"conversations": [self._summary(document) for document in documents]}

    def open(self, profile_id, book_id, notebook_ref_id=None):
        """Return this Book's active conversation, creating it when needed."""
        self._require_scope(profile_id, book_id)
        active = next((
            document for document in self._read_all(profile_id)
            if document.get("bookId") == book_id
            and document.get("active") is True
            and document.get("deletedAt") is None
        ), None)
        if active is not None:
            return {"conversation": active, "created": False}
        return {"conversation": self._new(profile_id, book_id, notebook_ref_id), "created": True}

    def create(self, profile_id, book_id, notebook_ref_id=None):
        """Create and activate a new conversation, retaining older threads."""
        self._require_scope(profile_id, book_id)
        return {"conversation": self._new(profile_id, book_id, notebook_ref_id), "created": True}

    def get(self, profile_id, conversation_id):
        self.require_profile(profile_id)
        return {"conversation": self._require(profile_id, conversation_id)}

    def prepare_message(self, profile_id, conversation_id, book_id, text, context_snapshot):
        """Validate one turn without writing it and return its model boundary.

        The snapshot is defensively copied here and sent to the model as data.
        It is persisted only after a complete answer arrives, so a failed or
        disconnected stream leaves the BookConversation unchanged.
        """
        self.require_profile(profile_id)
        conversation = self._require(profile_id, conversation_id)
        if conversation.get("bookId") != book_id:
            raise ApiError("book_conversation_not_found", f"unknown book conversation: {conversation_id}")
        if not isinstance(text, str) or not text.strip():
            raise ApiError("bad_request", "text is required")
        text = text.strip()
        if len(text) > MAX_MESSAGE_CHARS:
            raise ApiError("too_large", f"message exceeds {MAX_MESSAGE_CHARS} characters")
        if len(conversation["messages"]) + 2 > MAX_MESSAGES:
            raise ApiError("too_large", "book conversation is full")
        if not isinstance(context_snapshot, dict):
            raise ApiError("bad_request", "context snapshot is required")
        snapshot = json.loads(json.dumps(context_snapshot, ensure_ascii=False))
        if snapshot.get("bookId") != book_id:
            raise ApiError("book_not_found", "context belongs to another book")
        history = [
            {"role": message["role"], "content": message["content"]}
            for message in conversation["messages"]
        ]
        history.append({"role": "user", "content": text})
        return {
            "conversation": conversation,
            "messages": history,
            "text": text,
            "contextSnapshot": snapshot,
        }

    def append_turn(self, profile_id, conversation_id, text, answer, context_snapshot):
        """Atomically retain a completed turn with the context actually sent."""
        if not isinstance(answer, str) or not answer.strip():
            raise LookupError("ai_upstream_error")
        stored = [
            {"role": "user", "content": text.strip(), "at": self._timestamp(),
             "contextSnapshot": context_snapshot},
            {"role": "assistant", "content": answer.strip(), "at": self._timestamp(),
             "contextSnapshot": context_snapshot},
        ]
        return self.append_messages(profile_id, conversation_id, stored)

    def activate(self, profile_id, conversation_id):
        self.require_profile(profile_id)
        conversation = self._require(profile_id, conversation_id)
        if conversation.get("active") is True:
            return {"conversation": conversation}
        at = self._timestamp()
        for document in self._read_all(profile_id):
            if document.get("bookId") != conversation["bookId"] or document.get("deletedAt") is not None:
                continue
            should_be_active = document["id"] == conversation_id
            if document.get("active") is should_be_active:
                continue
            document["active"] = should_be_active
            document["updatedAt"] = at
            self._write(profile_id, document)
        conversation = self._require(profile_id, conversation_id)
        return {"conversation": conversation}

    def append_messages(self, profile_id, conversation_id, messages):
        """Append validated message records in one atomic conversation write."""
        self.require_profile(profile_id)
        conversation = self._require(profile_id, conversation_id)
        if not isinstance(messages, list) or not messages:
            raise ApiError("bad_request", "messages must be a non-empty list")
        at = self._timestamp()
        stored = []
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in ("user", "assistant") \
                    or not isinstance(message.get("content"), str) or not message["content"].strip():
                raise ApiError("bad_request", "messages must contain role and content")
            message_at = message.get("at", at)
            if not isinstance(message_at, int) or isinstance(message_at, bool) or message_at < 0:
                message_at = at
            record = {
                "role": message["role"],
                "content": message["content"].strip(),
                "at": message_at,
            }
            if "contextSnapshot" in message:
                if not isinstance(message["contextSnapshot"], dict):
                    raise ApiError("bad_request", "contextSnapshot must be an object")
                record["contextSnapshot"] = json.loads(json.dumps(
                    message["contextSnapshot"], ensure_ascii=False))
            stored.append(record)
        conversation["messages"].extend(stored)
        if conversation.get("title") == DEFAULT_TITLE and stored[0]["role"] == "user":
            conversation["title"] = stored[0]["content"][:24]
        conversation["updatedAt"] = at
        self._write(profile_id, conversation)
        return {"conversation": conversation}

    def delete(self, profile_id, conversation_id):
        """Soft-delete only this local conversation; no remote action occurs."""
        self.require_profile(profile_id)
        conversation = self._require(profile_id, conversation_id)
        if conversation.get("deletedAt") is not None:
            raise ApiError("book_conversation_not_found", f"unknown book conversation: {conversation_id}")
        at = self._timestamp()
        conversation["active"] = False
        conversation["deletedAt"] = at
        conversation["updatedAt"] = at
        self._write(profile_id, conversation)
        return {"conversation": conversation}

    def _require_scope(self, profile_id, book_id):
        self.require_profile(profile_id)
        self.require_book(book_id)
        return book_id

    def _new(self, profile_id, book_id, notebook_ref_id):
        if notebook_ref_id is not None and (not isinstance(notebook_ref_id, str) or not notebook_ref_id.strip()):
            raise ApiError("bad_request", "notebookRefId must be a non-empty string or null")
        at = self._timestamp()
        for document in self._read_all(profile_id):
            if document.get("bookId") == book_id and document.get("deletedAt") is None:
                document["active"] = False
                document["updatedAt"] = at
                self._write(profile_id, document)
        conversation = {
            "id": self._next_id(profile_id),
            "bookId": book_id,
            "notebookRefId": notebook_ref_id,
            "title": DEFAULT_TITLE,
            "active": True,
            "messages": [],
            "createdAt": at,
            "updatedAt": at,
            "deletedAt": None,
        }
        self._write(profile_id, conversation)
        return conversation

    def _dir(self, profile_id):
        return os.path.join(self.root, "state", profile_id, "book-conversations")

    def _path(self, profile_id, conversation_id):
        return os.path.join(self._dir(profile_id), f"{conversation_id}.json")

    def _write(self, profile_id, document):
        _write_json(self._path(profile_id, document["id"]), document)

    def _require(self, profile_id, conversation_id):
        if not isinstance(conversation_id, str) or not _ID_RE.fullmatch(conversation_id):
            raise ApiError("book_conversation_not_found", f"unknown book conversation: {conversation_id}")
        document = _read_json(self._path(profile_id, conversation_id), None)
        if not self._valid(document, conversation_id) or document.get("deletedAt") is not None:
            raise ApiError("book_conversation_not_found", f"unknown book conversation: {conversation_id}")
        return document

    def _read_all(self, profile_id):
        directory = self._dir(profile_id)
        names = sorted(os.listdir(directory)) if os.path.isdir(directory) else []
        documents = []
        for name in names:
            if not name.endswith(".json"):
                continue
            document = _read_json(os.path.join(directory, name), None)
            if self._valid(document, name[:-5]):
                documents.append(document)
        return documents

    def _next_id(self, profile_id):
        ids = [int(document["id"]) for document in self._read_all(profile_id)]
        return f"{(max(ids) + 1) if ids else 1:06d}"

    def _timestamp(self):
        return int(self.now() * 1000)

    @staticmethod
    def _valid(document, conversation_id):
        return (
            isinstance(document, dict)
            and document.get("id") == conversation_id
            and isinstance(document.get("bookId"), str)
            and isinstance(document.get("messages"), list)
        )

    @staticmethod
    def _summary(document):
        return {
            "id": document.get("id", ""),
            "bookId": document.get("bookId", ""),
            "notebookRefId": document.get("notebookRefId"),
            "title": document.get("title", ""),
            "active": document.get("active") is True,
            "createdAt": document.get("createdAt", 0),
            "updatedAt": document.get("updatedAt", 0),
            "messageCount": len(document.get("messages", [])),
        }


class NotebookRefs:
    """One non-authoritative NotebookLM mapping per local Book content hash."""

    def __init__(self, root, require_book, now=None):
        self.root = os.path.abspath(root)
        self.require_book = require_book
        self.now = now or time.time

    def get(self, book_id):
        self.require_book(book_id)
        document = self._read(book_id)
        return self._view(document) if document is not None else None

    def status(self, book_id):
        """Return independent upload, sync, and deletion states."""
        return self.get(book_id) or self._empty(book_id, self._timestamp())

    def ensure(self, book_id, notebook_id, source_id):
        """Create a confirmed mapping once, or return the identical mapping."""
        self.require_book(book_id)
        notebook_id = self._require_id(notebook_id, "notebookId")
        source_id = self._require_id(source_id, "sourceId")
        document = self._read(book_id)
        if document is not None:
            if document.get("notebookId") not in (None, notebook_id) \
                    or document.get("sourceId") not in (None, source_id):
                raise ApiError("bad_request", "book already has a different NotebookRef")
            if document.get("notebookId") is None or document.get("sourceId") is None:
                self.finish(book_id, document.get("syncRequestId"), {
                    "outcome": "confirmed",
                    "notebookId": notebook_id,
                    "sourceId": source_id,
                })
            document = self._read(book_id)
            if document.get("uploadStatus") != "uploaded" or document.get("syncStatus") != "synced":
                self.set_upload_status(book_id, "uploaded")
                self.set_sync_status(book_id, "synced")
            return self.get(book_id)
        at = self._timestamp()
        document = {
            "bookId": book_id,
            "bookContentHash": book_id,
            "provider": "notebooklm",
            "notebookId": notebook_id,
            "sourceId": source_id,
            "uploadStatus": "uploaded",
            "syncStatus": "synced",
            "mutationStatus": "confirmed",
            "syncRequestId": None,
            "lastError": None,
            "uploadedAt": at,
            "syncedAt": at,
            "localDeletedAt": None,
            "remoteDeletedAt": None,
            "createdAt": at,
            "updatedAt": at,
        }
        self._write(book_id, document)
        return self._view(document)

    def begin(self, book_id, request_id):
        """Durably record one provider mutation before bytes leave the host."""
        self.require_book(book_id)
        request_id = self._require_id(request_id, "requestId")
        document = self._read(book_id) or self._empty(book_id, self._timestamp())
        if document.get("syncRequestId") == request_id:
            return self._view(document)
        at = self._timestamp()
        document.update({
            "syncRequestId": request_id,
            "attempt": int(document.get("attempt", 0)) + 1,
            "uploadStatus": "uploading",
            "syncStatus": "syncing",
            "mutationStatus": "in_progress",
            "lastError": None,
            "updatedAt": at,
        })
        self._write(book_id, document)
        return self._view(document)

    def finish(self, book_id, request_id, result):
        """Commit exactly the confirmed/not-sent/rejected/unknown outcome."""
        self.require_book(book_id)
        document = self._read(book_id)
        if document is None or document.get("syncRequestId") != request_id:
            raise ApiError("notebook_ref_conflict", "a newer Notebook sync owns this mapping")
        if not isinstance(result, dict):
            raise ApiError("notebook_ref_conflict", "invalid Notebook sync outcome")
        outcome = result.get("outcome")
        if outcome not in ("confirmed", "not_sent", "rejected", "unknown"):
            raise ApiError("notebook_ref_conflict", "invalid Notebook sync outcome")
        at = self._timestamp()
        document["mutationStatus"] = outcome
        document["updatedAt"] = at
        if outcome == "confirmed":
            notebook_id = self._require_id(result.get("notebookId"), "notebookId")
            source_id = self._require_id(result.get("sourceId"), "sourceId")
            for field, value in (("notebookId", notebook_id), ("sourceId", source_id)):
                if document.get(field) not in (None, value):
                    raise ApiError("bad_request", f"{field} conflicts with the existing NotebookRef")
                document[field] = value
            document.update({
                "uploadStatus": "uploaded",
                "syncStatus": "synced",
                "lastError": None,
                "uploadedAt": at,
                "syncedAt": at,
            })
        elif outcome == "not_sent":
            document.update({
                "uploadStatus": "not_sent",
                "syncStatus": "not_synced",
                "lastError": result.get("error"),
            })
        elif outcome == "rejected":
            document.update({
                "uploadStatus": "rejected",
                "syncStatus": "failed",
                "lastError": result.get("error"),
            })
        else:
            document.update({
                "uploadStatus": "unknown",
                "syncStatus": "unknown",
                "lastError": result.get("error", "notebooklm_mutation_unknown"),
            })
        self._write(book_id, document)
        return self._view(document)

    def set_upload_status(self, book_id, status):
        return self._set_status(book_id, "upload", status)

    def set_sync_status(self, book_id, status):
        return self._set_status(book_id, "sync", status)

    def delete_local(self, book_id):
        """Mark local mapping metadata deleted without changing remote state."""
        return self._delete_side(book_id, "localDeletedAt")

    def delete_remote(self, book_id):
        """Mark remote cleanup complete without changing the local Book."""
        return self._delete_side(book_id, "remoteDeletedAt")

    def _set_status(self, book_id, side, status):
        document = self.get(book_id)
        if document is None:
            raise ApiError("notebook_ref_not_found", f"no NotebookRef for book: {book_id}")
        status = self._require_id(status, "status")
        at = self._timestamp()
        document[f"{side}Status"] = status
        document["updatedAt"] = at
        if side == "upload" and status == "uploaded":
            document["uploadedAt"] = at
        if side == "sync" and status == "synced":
            document["syncedAt"] = at
        return self._write_and_view(book_id, document)

    def _delete_side(self, book_id, field):
        document = self.get(book_id)
        if document is None:
            raise ApiError("notebook_ref_not_found", f"no NotebookRef for book: {book_id}")
        at = self._timestamp()
        if document.get(field) is None:
            document[field] = at
        document["updatedAt"] = at
        return self._write_and_view(book_id, document)

    def _path(self, book_id):
        return os.path.join(self.root, "books", book_id, "notebook-ref.json")

    def _read(self, book_id):
        document = _read_json(self._path(book_id), None)
        if not isinstance(document, dict) or document.get("bookId") != book_id \
                or document.get("bookContentHash") != book_id \
                or document.get("provider") != "notebooklm":
            return None
        return document

    def _write(self, book_id, document):
        _write_json(self._path(book_id), document)

    def _write_and_view(self, book_id, document):
        self._write(book_id, document)
        return self._view(document)

    def _timestamp(self):
        return int(self.now() * 1000)

    @staticmethod
    def _empty(book_id, at):
        return {
            "bookId": book_id,
            "bookContentHash": book_id,
            "provider": "notebooklm",
            "notebookId": None,
            "sourceId": None,
            "uploadStatus": "not_uploaded",
            "syncStatus": "not_synced",
            "mutationStatus": "not_sent",
            "syncRequestId": None,
            "lastError": None,
            "uploadedAt": None,
            "syncedAt": None,
            "localDeletedAt": None,
            "remoteDeletedAt": None,
            "createdAt": at,
            "updatedAt": at,
        }

    @staticmethod
    def _view(document):
        result = dict(document)
        result["deletionStatus"] = {
            "local": "deleted" if document.get("localDeletedAt") is not None else "active",
            "remote": "deleted" if document.get("remoteDeletedAt") is not None else "active",
        }
        return result

    @staticmethod
    def _require_id(value, field):
        if not isinstance(value, str) or not value.strip():
            raise ApiError("bad_request", f"{field} must be a non-empty string")
        return value.strip()


class NotebookSync:
    """Explicit, serialized lazy synchronization for one local Book.

    The lock makes concurrent HTTP requests reuse the same durable attempt.
    An ``unknown`` provider mutation is never submitted again, even when the
    same user repeats the request; only a known rejection can be retried with
    a fresh explicit ``retry=True`` decision.
    """

    def __init__(self, library, refs, provider):
        self.library = library
        self.refs = refs
        self.provider = provider
        self._lock = threading.Lock()

    def status(self, book_id):
        return {"notebookRef": self.refs.status(book_id)}

    def sync(self, book_id, confirm_upload=False, retry=False):
        if confirm_upload is not True:
            raise ApiError("cloud_confirmation_required", "explicit upload confirmation is required")
        if not isinstance(retry, bool):
            raise ApiError("bad_request", "retry must be a boolean")
        with self._lock:
            current = self.refs.get(book_id)
            # Refs written by the pre-#74 persistence layer have remote IDs
            # but no durable mutation receipt. Treat them as unknown rather
            # than creating a second Notebook/Source pair.
            if current is not None and (current.get("notebookId") or current.get("sourceId")) \
                    and current.get("mutationStatus") is None:
                return self._result(current, reused=True, retry_required=False,
                                    blocked_reason="notebooklm_mutation_unknown")
            if current is not None and current.get("mutationStatus") == "confirmed":
                return self._result(current, reused=True, retry_required=False)
            if current is not None and current.get("mutationStatus") in ("unknown", "in_progress"):
                return self._result(current, reused=True, retry_required=False,
                                    blocked_reason="notebooklm_mutation_unknown")
            if current is not None and current.get("mutationStatus") not in (None, "not_sent", "rejected") \
                    and retry is not True:
                return self._result(current, reused=True, retry_required=True)
            attempt = int(current.get("attempt", 0)) + 1 if current is not None else 1
            request_id = f"{book_id}:{attempt}"
            book = self.library.get_book(book_id)["book"]
            data = self.library.epub_data(book_id)
            self.refs.begin(book_id, request_id)
            try:
                outcome = self.provider.sync_source(
                    book_id=book_id,
                    content_hash=book_id,
                    title=book["title"],
                    file_name=book.get("fileName", "book.epub"),
                    request_id=request_id,
                    data=data,
                )
            except LookupError as error:
                outcome = {
                    "outcome": getattr(error, "outcome", "unknown"),
                    "error": str(error) or "notebooklm_mutation_unknown",
                }
            except Exception:
                outcome = {"outcome": "unknown", "error": "notebooklm_mutation_unknown"}
            current = self.refs.finish(book_id, request_id, outcome)
            return self._result(current, reused=False, retry_required=False)

    @staticmethod
    def _result(document, reused, retry_required, blocked_reason=None):
        return {
            "notebookRef": document,
            "reused": reused,
            "requiresExplicitRetry": retry_required,
            **({"blockedReason": blocked_reason} if blocked_reason else {}),
        }


STUDY_JOB_STATES = (
    "not_configured", "queued", "preparing", "uploading", "waiting_remote",
    "downloading", "ready", "failed", "unknown", "cancelled",
)
STUDY_JOB_ERRORS = (
    "notebooklm_not_configured", "notebooklm_auth_required", "notebooklm_unavailable",
    "notebooklm_quota", "notebooklm_source_rejected", "notebooklm_job_unknown",
    "artifact_download_failed",
)
_STUDY_JOB_TRANSITIONS = {
    "queued": {"preparing", "not_configured", "failed", "unknown", "cancelled"},
    "preparing": {"uploading", "waiting_remote", "not_configured", "failed", "unknown", "cancelled"},
    "uploading": {"waiting_remote", "failed", "unknown", "cancelled"},
    "waiting_remote": {"downloading", "failed", "unknown", "cancelled"},
    "downloading": {"ready", "failed", "unknown", "cancelled"},
}


class StudyJobs:
    """Person-scoped durable state and request identity for one StudyJob.

    The provider request is persisted before the worker sees it.  ``requestId``
    is therefore stable across a host restart and can be used by the worker to
    reconcile rather than create a second remote generation.
    """

    def __init__(self, root, require_profile, require_book, now=None):
        self.root = os.path.abspath(root)
        self.require_profile = require_profile
        self.require_book = require_book
        self.now = now or time.time
        self._lock = threading.RLock()

    def list(self, profile_id, book_id):
        self.require_profile(profile_id)
        self.require_book(book_id)
        jobs = [self._view(job) for job in self._read_all(profile_id)
                if job.get("bookId") == book_id]
        jobs.sort(key=lambda job: (job.get("createdAt", 0), job.get("id", "")), reverse=True)
        return {"jobs": jobs}

    def get(self, profile_id, job_id):
        self.require_profile(profile_id)
        return self._view(self._require(profile_id, job_id))

    def create(self, profile_id, book_id, request):
        """Create once for a request identity; a repeated call reuses it."""
        self.require_profile(profile_id)
        self.require_book(book_id)
        if not isinstance(request, dict) or not request:
            raise ApiError("bad_request", "request must be a non-empty object")
        request = json.loads(json.dumps(request, ensure_ascii=False))
        request_id = request.get("requestId")
        if request_id is None:
            job_id = uuid.uuid4().hex
            request_id = f"study-job:{job_id}"
            request["requestId"] = request_id
        elif not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 128:
            raise ApiError("bad_request", "requestId must be a non-empty string of at most 128 characters")
        else:
            request_id = request_id.strip()
            request["requestId"] = request_id
        if request.get("personId") != profile_id:
            raise ApiError("profile_not_found", "request context belongs to another Person")
        if request.get("bookId") != book_id or request.get("bookContentHash") != book_id:
            raise ApiError("book_not_found", "request context belongs to another book")
        if not isinstance(request.get("artifactType"), str) or not request["artifactType"].strip() \
                or not isinstance(request.get("contextScope"), dict):
            raise ApiError("bad_request", "artifactType and contextScope are required")
        with self._lock:
            existing = next((job for job in self._read_all(profile_id)
                             if job.get("requestId") == request_id), None)
            if existing is not None:
                if (existing.get("bookId") != book_id or existing.get("request") != request):
                    raise ApiError("study_job_conflict", "requestId belongs to a different StudyJob")
                return {"job": self._view(existing), "created": False}
            at = self._timestamp()
            job_id = f"job-{uuid.uuid4().hex}"
            document = {
                "id": job_id,
                "requestId": request_id,
                "personId": profile_id,
                "bookId": book_id,
                "provider": "notebooklm",
                "request": request,
                "state": "queued",
                "error": None,
                "artifactResult": None,
                "cancelRequestedAt": None,
                "createdAt": at,
                "updatedAt": at,
                "history": [{"from": None, "to": "queued", "at": at, "reason": "created"}],
            }
            self._write(profile_id, document)
            return {"job": self._view(document), "created": True}

    def transition(self, profile_id, job_id, state, *, error=None, artifact_result=None, reason=None):
        """Apply one validated durable transition and retain its history."""
        if state not in STUDY_JOB_STATES:
            raise ApiError("bad_request", "invalid StudyJob state")
        with self._lock:
            document = self._require(profile_id, job_id)
            current = document["state"]
            if state == current and not artifact_result and error is None:
                return self._view(document)
            if state not in _STUDY_JOB_TRANSITIONS.get(current, set()):
                raise ApiError("invalid_study_job_transition",
                               f"StudyJob cannot transition from {current} to {state}")
            if state == "ready":
                if not isinstance(artifact_result, dict) or not artifact_result:
                    raise ApiError("bad_request", "ready requires a controlled artifact result")
            elif artifact_result is not None:
                raise ApiError("bad_request", "only ready may publish an artifact result")
            if state == "not_configured":
                error = "notebooklm_not_configured"
            if error is not None and error not in STUDY_JOB_ERRORS:
                raise ApiError("bad_request", "invalid NotebookLM error code")
            if state == "failed" and error in (None, "notebooklm_not_configured", "notebooklm_job_unknown"):
                raise ApiError("bad_request", "failed jobs require a fixed provider or download error")
            if state == "unknown" and error != "notebooklm_job_unknown":
                raise ApiError("bad_request", "unknown jobs require notebooklm_job_unknown")
            if state in ("ready", "cancelled") and error is not None:
                raise ApiError("bad_request", "successful or cancelled jobs cannot claim an error")
            at = self._timestamp()
            document["state"] = state
            document["error"] = error
            document["updatedAt"] = at
            if artifact_result is not None:
                document["artifactResult"] = json.loads(json.dumps(artifact_result, ensure_ascii=False))
            document["history"].append({
                "from": current, "to": state, "at": at, "reason": reason or state,
            })
            self._write(profile_id, document)
            return self._view(document)

    def cancel(self, profile_id, job_id):
        """Record explicit cancellation without rewriting an unknown result."""
        with self._lock:
            document = self._require(profile_id, job_id)
            if document["state"] == "unknown":
                if document.get("cancelRequestedAt") is None:
                    at = self._timestamp()
                    document["cancelRequestedAt"] = at
                    document["updatedAt"] = at
                    self._write(profile_id, document)
                return self._view(document)
            if document["state"] == "cancelled":
                return self._view(document)
            if document["state"] in ("ready", "failed"):
                raise ApiError("study_job_not_cancellable", f"StudyJob is already {document['state']}")
            return self.transition(profile_id, job_id, "cancelled", reason="user_cancelled")

    def _dir(self, profile_id):
        return os.path.join(self.root, "state", profile_id, "study-jobs")

    def _path(self, profile_id, job_id):
        return os.path.join(self._dir(profile_id), f"{job_id}.json")

    def _require(self, profile_id, job_id):
        if not isinstance(job_id, str) or not re.fullmatch(r"job-[0-9a-f]{32}", job_id):
            raise ApiError("study_job_not_found", f"unknown StudyJob: {job_id}")
        document = _read_json(self._path(profile_id, job_id), None)
        if not self._valid(document, job_id) or document.get("personId") != profile_id:
            raise ApiError("study_job_not_found", f"unknown StudyJob: {job_id}")
        return document

    def _read_all(self, profile_id):
        directory = self._dir(profile_id)
        names = sorted(os.listdir(directory)) if os.path.isdir(directory) else []
        documents = []
        for name in names:
            if name.endswith(".json"):
                document = _read_json(os.path.join(directory, name), None)
                if self._valid(document, name[:-5]):
                    documents.append(document)
        return documents

    def _write(self, profile_id, document):
        _write_json(self._path(profile_id, document["id"]), document)

    def _timestamp(self):
        return int(self.now() * 1000)

    @staticmethod
    def _valid(document, job_id):
        return (
            isinstance(document, dict)
            and document.get("id") == job_id
            and isinstance(document.get("personId"), str)
            and isinstance(document.get("bookId"), str)
            and isinstance(document.get("requestId"), str)
            and isinstance(document.get("request"), dict)
            and document.get("state") in STUDY_JOB_STATES
            and isinstance(document.get("history"), list)
        )

    @staticmethod
    def _view(document):
        result = dict(document)
        result["terminal"] = document["state"] in ("not_configured", "ready", "failed", "unknown", "cancelled")
        result["successful"] = document["state"] == "ready"
        result["cancelled"] = document["state"] == "cancelled"
        return result
