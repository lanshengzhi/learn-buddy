"""BookConversation and NotebookRef persistence tests (issue #67)."""

import json
import os
import shutil
import tempfile
import unittest

import textseg
from book_ai import BookConversations, NotebookRefs
from library import ApiError, Library
from conversations import Conversations
try:
    from test_server import FakeSynthesizer, ServerHarness
except ImportError:
    from tests.test_server import FakeSynthesizer, ServerHarness

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def _fixture(name):
    with open(os.path.join(FIXTURES, name), "rb") as handle:
        return handle.read()


class BookAiStorageTestCase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.library = Library(self.root, ja_tokenizer=textseg.tokenize_rule, now=lambda: 1000.0)
        self.book_id = self.library.add_book("dad", "nav.epub", _fixture("nav.epub"))[1]["book"]["id"]
        self.conversations = BookConversations(
            self.root, self.library.require_profile, self.library.require_book,
            now=lambda: 1000.0)
        self.refs = NotebookRefs(self.root, self.library.require_book, now=lambda: 1000.0)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def read(self, *parts):
        with open(os.path.join(self.root, *parts), encoding="utf-8") as handle:
            return json.load(handle)


class TestBookConversations(BookAiStorageTestCase):
    def test_default_open_is_idempotent_and_repeated_read_resumes(self):
        first = self.conversations.open("dad", self.book_id)["conversation"]
        repeated = self.conversations.open("dad", self.book_id)
        self.assertFalse(repeated["created"])
        self.assertEqual(repeated["conversation"], first)

        stored = self.read("state", "dad", "book-conversations", f"{first['id']}.json")
        self.assertEqual(stored["bookId"], self.book_id)
        self.assertTrue(stored["active"])
        self.assertIsNone(stored["deletedAt"])
        self.assertEqual(stored["createdAt"], 1_000_000)
        self.assertEqual(stored["updatedAt"], 1_000_000)

    def test_multiple_conversations_resume_activate_and_store_messages(self):
        first = self.conversations.create("dad", self.book_id)["conversation"]
        second = self.conversations.create("dad", self.book_id)["conversation"]
        self.assertNotEqual(first["id"], second["id"])
        self.assertFalse(self.conversations.get("dad", first["id"])["conversation"]["active"])
        self.assertTrue(self.conversations.get("dad", second["id"])["conversation"]["active"])

        self.conversations.append_messages("dad", first["id"], [
            {"role": "user", "content": "Explain this."},
            {"role": "assistant", "content": "Here is the explanation."},
        ])
        resumed = self.conversations.get("dad", first["id"])["conversation"]
        self.assertEqual([m["role"] for m in resumed["messages"]], ["user", "assistant"])
        self.assertEqual(resumed["title"], "Explain this.")
        self.assertTrue(self.conversations.activate("dad", first["id"])["conversation"]["active"])
        self.assertFalse(self.conversations.get("dad", second["id"])["conversation"]["active"])

    def test_historical_snapshots_survive_restart_and_context_change(self):
        conversation = self.conversations.create("dad", self.book_id)["conversation"]
        first = {
            "bookId": self.book_id, "contentHash": self.book_id, "scope": "sentence",
            "anchor": {"sentence": 0}, "text": "first sentence", "dataOnly": True,
        }
        second = {
            "bookId": self.book_id, "contentHash": self.book_id, "scope": "selection",
            "anchor": {"start": 0, "end": 1}, "text": "selected", "dataOnly": True,
        }
        self.conversations.append_turn("dad", conversation["id"], "first", "answer one", first)
        restarted = BookConversations(
            self.root, self.library.require_profile, self.library.require_book,
            now=lambda: 2000.0)
        turn = restarted.prepare_message(
            "dad", conversation["id"], self.book_id, "second", second)
        self.assertEqual(turn["messages"][0]["contextSnapshot"], first)
        self.assertEqual(turn["messages"][1]["contextSnapshot"], first)
        self.assertEqual(turn["contextSnapshot"], second)
        self.assertEqual(turn["messages"][-1], {"role": "user", "content": "second"})

    def test_delete_is_local_soft_delete_and_remote_mapping_is_independent(self):
        conversation = self.conversations.create("dad", self.book_id)["conversation"]
        ref = self.refs.ensure(self.book_id, "remote-notebook-1", "remote-source-1")
        deleted = self.conversations.delete("dad", conversation["id"])["conversation"]
        self.assertFalse(deleted["active"])
        self.assertEqual(deleted["deletedAt"], 1_000_000)
        self.assertEqual(self.refs.get(self.book_id), ref)
        with self.assertRaises(ApiError) as caught:
            self.conversations.get("dad", conversation["id"])
        self.assertEqual(caught.exception.code, "book_conversation_not_found")

    def test_book_conversations_are_person_and_book_scoped_and_isolated_from_chat(self):
        dad = self.conversations.create("dad", self.book_id)["conversation"]
        chat = Conversations(self.root, self.library.require_profile, now=lambda: 1000.0)
        chat.create("dad")
        self.assertEqual(chat.get("dad", dad["id"] if dad["id"] == "000001" else "000001")["conversation"]["messages"], [])
        self.assertEqual(self.conversations.get("dad", dad["id"])["conversation"]["messages"], [])
        self.assertTrue(os.path.isfile(os.path.join(
            self.root, "state", "dad", "conversations", "000001.json")))
        self.assertTrue(os.path.isfile(os.path.join(
            self.root, "state", "dad", "book-conversations", f"{dad['id']}.json")))
        self.assertEqual(self.conversations.list("mom", self.book_id)["conversations"], [])

    def test_scope_and_message_validation(self):
        with self.assertRaises(ApiError) as caught:
            self.conversations.open("dad", "not-a-local-book")
        self.assertEqual(caught.exception.code, "book_not_found")
        conversation = self.conversations.create("dad", self.book_id)["conversation"]
        for messages in ([], [{"role": "system", "content": "no"}], [{"role": "user", "content": " "}]):
            with self.assertRaises(ApiError) as caught:
                self.conversations.append_messages("dad", conversation["id"], messages)
            self.assertEqual(caught.exception.code, "bad_request")


class TestHostWiring(unittest.TestCase):
    def test_host_owns_book_ai_stores_separate_from_chat(self):
        static_dir = tempfile.mkdtemp()
        with open(os.path.join(static_dir, "index.html"), "w", encoding="utf-8") as handle:
            handle.write("<h1>LearnBuddy</h1>")
        harness = ServerHarness(static_dir, FakeSynthesizer(), pace_interval=0)
        try:
            self.assertIsInstance(harness.httpd.app.book_conversations, BookConversations)
            self.assertIsInstance(harness.httpd.app.notebook_refs, NotebookRefs)
            self.assertIsInstance(harness.httpd.app.conversations, Conversations)
            self.assertIsNot(harness.httpd.app.book_conversations, harness.httpd.app.conversations)
        finally:
            harness.close()
            shutil.rmtree(static_dir, ignore_errors=True)


class TestNotebookRefs(BookAiStorageTestCase):
    def test_mapping_is_idempotent_and_local_book_identity_wins(self):
        first = self.refs.ensure(self.book_id, "notebook-remote", "source-remote")
        repeated = self.refs.ensure(self.book_id, "notebook-remote", "source-remote")
        self.assertEqual(repeated, first)
        self.assertEqual(first["bookId"], self.book_id)
        self.assertEqual(first["bookContentHash"], self.book_id)
        self.assertNotEqual(first["bookId"], first["notebookId"])
        self.assertNotEqual(first["bookId"], first["sourceId"])
        self.assertEqual(len(os.listdir(os.path.join(self.root, "books", self.book_id))), 4)

    def test_status_timestamps_and_local_remote_cleanup_are_separate(self):
        self.refs.ensure(self.book_id, "notebook-remote", "source-remote")
        uploaded = self.refs.set_upload_status(self.book_id, "uploaded")
        self.assertEqual(uploaded["uploadedAt"], 1_000_000)
        self.assertIsNone(uploaded["remoteDeletedAt"])
        synced = self.refs.set_sync_status(self.book_id, "synced")
        self.assertEqual(synced["syncedAt"], 1_000_000)

        class UnsupportedProvider:
            def __init__(self):
                self.calls = []

            def delete_notebook(self, **request):
                self.calls.append(request)
                return {"outcome": "unsupported", "error": "notebook_cleanup_unsupported"}

        provider = UnsupportedProvider()
        remote = self.refs.cleanup_remote(self.book_id, provider)
        self.assertEqual(remote["remoteCleanup"]["status"], "unsupported")
        self.assertIsNone(remote["remoteDeletedAt"])
        self.assertIsNone(remote["localDeletedAt"])
        self.assertEqual(provider.calls, [{"notebook_id": "notebook-remote", "source_id": "source-remote"}])
        self.assertTrue(os.path.isfile(os.path.join(
            self.root, "books", self.book_id, "notebook-ref.json")))
        self.assertTrue(os.path.isfile(os.path.join(self.root, "books", self.book_id, "book.epub")))
        local_deleted = self.refs.delete_local(self.book_id)
        self.assertEqual(local_deleted["localDeletedAt"], 1_000_000)

    def test_conflicting_or_missing_mappings_are_rejected(self):
        self.refs.ensure(self.book_id, "notebook-remote", "source-remote")
        with self.assertRaises(ApiError) as caught:
            self.refs.ensure(self.book_id, "different-notebook", "source-remote")
        self.assertEqual(caught.exception.code, "bad_request")
        with self.assertRaises(ApiError) as caught:
            self.refs.set_sync_status("a" * 64, "synced")
        self.assertEqual(caught.exception.code, "book_not_found")


if __name__ == "__main__":
    unittest.main()
