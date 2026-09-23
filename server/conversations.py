"""Conversation records — LearnBuddy's own Chat history (ticket #47, spec
family-hub-v1 §2/§6, ADR 0015).

Conversations are product data owned by this server, grouped per Person
(profile), one JSON file per Conversation:

```
state/<profile>/conversations/NNNNNN.json   # one Conversation per file
```

Written `.tmp` + atomic rename like the rest of the library; profile scoping
goes through the Library's `require_profile` (injected, so this module keeps
no profile vocabulary of its own).

Pi (the Node sidecar) only performs the model call. `post_message` hands it
exactly the current Conversation's text messages plus the new user message —
never Read content (EPUB bytes, chapter text, reading positions), never
other Conversations, never the Person or any other profile's record
(ADR 0012/0015). The sidecar's own session files are not the source of truth
for the family's Conversation history.
"""

import os
import re
import time

from library import ApiError, _read_json, _write_json

DEFAULT_TITLE = "新对话"
TITLE_CHARS = 24
MAX_MESSAGES = 500
MAX_MESSAGE_CHARS = 8000

_ID_RE = re.compile(r"[0-9]{6}")


class Conversations:
    """File-backed Conversations under `<root>/state/<profile>/conversations/`."""

    def __init__(self, root, require_profile, now=None):
        self.root = os.path.abspath(root)
        self.require_profile = require_profile
        self.now = now or time.time

    # -- reads -------------------------------------------------------------

    def list(self, profile_id):
        self.require_profile(profile_id)
        conversations = [self._summary(document) for document in self._read_all(profile_id)]
        conversations.sort(key=lambda c: (c["updatedAt"], c["id"]), reverse=True)
        return {"conversations": conversations}

    def get(self, profile_id, conversation_id):
        self.require_profile(profile_id)
        return {"conversation": self._require(profile_id, conversation_id)}

    # -- writes ------------------------------------------------------------

    def create(self, profile_id):
        self.require_profile(profile_id)
        at = int(self.now() * 1000)
        conversation = {
            "id": self._next_id(profile_id),
            "title": DEFAULT_TITLE,
            "createdAt": at,
            "updatedAt": at,
            "messages": [],
        }
        _write_json(self._path(profile_id, conversation["id"]), conversation)
        return {"conversation": conversation}

    def post_message(self, profile_id, conversation_id, text, ask):
        """Appends `text` (user), asks the model with ONLY this Conversation's
        text history plus the new message, and appends the assistant reply —
        both or neither: a failed model call raises LookupError(code) and
        leaves the stored Conversation untouched (spec user story 13)."""
        self.require_profile(profile_id)
        conversation = self._require(profile_id, conversation_id)
        if not isinstance(text, str) or not text.strip():
            raise ApiError("bad_request", "text is required")
        text = text.strip()
        if len(text) > MAX_MESSAGE_CHARS:
            raise ApiError("too_large", f"message exceeds {MAX_MESSAGE_CHARS} characters")
        if len(conversation["messages"]) >= MAX_MESSAGES:
            raise ApiError("too_large", "conversation is full")
        # The context boundary, enforced here so no caller can widen it:
        # exactly this Conversation's role/content pairs plus the new text.
        history = [
            {"role": message["role"], "content": message["content"]}
            for message in conversation["messages"]
        ]
        history.append({"role": "user", "content": text})
        answer = ask(history)  # LookupError(code) on model failure — nothing written
        reply = answer.get("text", "").strip() if isinstance(answer, dict) else ""
        if not reply:
            raise LookupError("ai_upstream_error")
        at = int(self.now() * 1000)
        conversation["messages"].append({"role": "user", "content": text, "at": at})
        conversation["messages"].append({"role": "assistant", "content": reply, "at": at})
        if conversation["title"] == DEFAULT_TITLE:
            conversation["title"] = text[:TITLE_CHARS]
        conversation["updatedAt"] = at
        _write_json(self._path(profile_id, conversation_id), conversation)
        return {"conversation": conversation}

    # -- internals ---------------------------------------------------------

    def _dir(self, profile_id):
        return os.path.join(self.root, "state", profile_id, "conversations")

    def _path(self, profile_id, conversation_id):
        return os.path.join(self._dir(profile_id), f"{conversation_id}.json")

    def _require(self, profile_id, conversation_id):
        if not isinstance(conversation_id, str) or not _ID_RE.fullmatch(conversation_id):
            raise ApiError("conversation_not_found", f"unknown conversation: {conversation_id}")
        document = _read_json(self._path(profile_id, conversation_id), None)
        if not isinstance(document, dict) or document.get("id") != conversation_id \
                or not isinstance(document.get("messages"), list):
            raise ApiError("conversation_not_found", f"unknown conversation: {conversation_id}")
        return document

    def _read_all(self, profile_id):
        directory = self._dir(profile_id)
        names = sorted(os.listdir(directory)) if os.path.isdir(directory) else []
        documents = []
        for name in names:
            if not name.endswith(".json"):
                continue
            document = _read_json(os.path.join(directory, name), None)
            if isinstance(document, dict) and isinstance(document.get("messages"), list):
                documents.append(document)
        return documents

    def _next_id(self, profile_id):
        ids = [int(document["id"]) for document in self._read_all(profile_id)
               if str(document.get("id", "")).isdigit()]
        return f"{(max(ids) + 1) if ids else 1:06d}"

    @staticmethod
    def _summary(document):
        return {
            "id": document.get("id", ""),
            "title": document.get("title", ""),
            "createdAt": document.get("createdAt", 0),
            "updatedAt": document.get("updatedAt", 0),
            "messageCount": len(document.get("messages", [])),
        }
