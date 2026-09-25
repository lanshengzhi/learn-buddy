"""BookConversation HTTP and streaming contract tests (issue #71)."""

import io
import json
import os
import sys
import unittest
import urllib.error

from ai import _default_stream_open

try:
    from test_api import ApiTestCase
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from test_api import ApiTestCase


class FakeStream:
    def __init__(self, events):
        self.events = events
        self.closed = False

    def __iter__(self):
        return iter(self.events)

    def close(self):
        self.closed = True


def stream_events(*events):
    return FakeStream([(json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8") for event in events])


class TestBookConversationApi(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.book_id = self.body(self.upload())["book"]["id"]
        self.proxy = self.harness.httpd.app.ai
        self.calls = []
        self.proxy.url = "http://ai.test"

    def fake_stream(self, reply="这是流式回答。", error=None):
        def open_stream(request, timeout):
            self.calls.append({
                "url": request.full_url,
                "body": json.loads(request.data.decode("utf-8")),
            })
            if error is not None:
                raise error
            chunks = ["这是", "流式", "回答。"] if reply == "这是流式回答。" else [reply]
            events = [{"type": "delta", "text": chunk} for chunk in chunks]
            events.append({"type": "done"})
            return stream_events(*events)

        self.proxy._stream_open = open_stream

    def context(self, scope="sentence", **anchor):
        response = self.json_request("POST", f"/books/{self.book_id}/context", {
            "bookId": self.book_id,
            "scope": scope,
            "chapter": anchor.pop("chapter", 0),
            **anchor,
        })
        self.assertEqual(response[0], 200)
        return self.body(response)["context"]

    def open_conversation(self, profile="dad", new=False):
        response = self.json_request(
            "POST", f"/books/{self.book_id}/book-conversations?profile={profile}", {"new": new})
        self.assertEqual(response[0], 201)
        return self.body(response)["conversation"]

    def messages(self, conversation_id, profile="dad", context=None, text="解释这段文字。"):
        context = context or self.context()
        return self.json_request(
            "POST", f"/book-conversations/{conversation_id}/messages?profile={profile}",
            {"bookId": self.book_id, "text": text, "context": context})

    def ndjson(self, response):
        return [json.loads(line) for line in response[2].splitlines() if line]

    def test_default_open_has_one_active_conversation_and_lifecycle_is_book_scoped(self):
        first = self.open_conversation()
        repeated = self.body(self.json_request(
            "POST", f"/books/{self.book_id}/book-conversations?profile=dad", {}))["conversation"]
        self.assertEqual(repeated["id"], first["id"])

        second = self.open_conversation(new=True)
        listed = self.body(self.get(f"/books/{self.book_id}/book-conversations?profile=dad"))["conversations"]
        self.assertEqual(len(listed), 2)
        self.assertEqual([item["id"] for item in listed if item["active"]], [second["id"]])

        resumed = self.body(self.json_request(
            "POST", f"/book-conversations/{first['id']}/resume?profile=dad", {}))["conversation"]
        self.assertTrue(resumed["active"])
        self.assertFalse(self.body(self.get(
            f"/book-conversations/{second['id']}?profile=dad"))["conversation"]["active"])

        status, _, body = self.harness.request(
            "DELETE", f"/book-conversations/{first['id']}?profile=dad")
        self.assertEqual(status, 204)
        self.assertEqual(body, b"")
        self.assertEqual(self.body(self.get(
            f"/books/{self.book_id}/book-conversations?profile=dad"))["conversations"][0]["id"], second["id"])

    def test_person_isolation(self):
        dad = self.open_conversation("dad")
        mom = self.open_conversation("mom")
        self.fake_stream(reply="爸爸的私有回答")
        self.messages(dad["id"], profile="dad", text="爸爸的私有问题")

        # Conversation ids are allocated inside each Person's store, so equal
        # numeric ids are not shared records: each profile sees only its data.
        dad_stored = self.body(self.get(
            f"/book-conversations/{dad['id']}?profile=dad"))["conversation"]
        mom_stored = self.body(self.get(
            f"/book-conversations/{mom['id']}?profile=mom"))["conversation"]
        self.assertEqual([m["content"] for m in dad_stored["messages"]],
                         ["爸爸的私有问题", "爸爸的私有回答"])
        self.assertEqual(mom_stored["messages"], [])

        mom_list = self.body(self.get(
            f"/books/{self.book_id}/book-conversations?profile=mom"))["conversations"]
        self.assertEqual(mom_list[0]["messageCount"], 0)

    def test_stream_meta_delta_done_and_only_current_turn_boundary(self):
        self.fake_stream()
        conversation = self.open_conversation()
        context = self.context("sentence", sentence=1)
        status, headers, body = self.messages(conversation["id"], context=context)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/x-ndjson; charset=utf-8")
        events = self.ndjson((status, headers, body))
        self.assertEqual([event["type"] for event in events], ["meta", "delta", "delta", "delta", "done"])
        self.assertEqual(events[0]["conversation"], {"id": conversation["id"], "bookId": self.book_id})
        self.assertEqual(events[0]["contextScope"], "sentence")
        self.assertEqual(events[0]["book"]["contentHash"], self.book_id)
        self.assertEqual("".join(event["text"] for event in events if event["type"] == "delta"), "这是流式回答。")
        self.assertEqual(events[-1]["conversation"]["messages"][-1]["content"], "这是流式回答。")

        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.calls[0]["url"].endswith("/book-chat"))
        self.assertEqual(self.calls[0]["body"], {
            "messages": [{"role": "user", "content": "解释这段文字。"}],
            "context": context,
        })

    def test_every_scope_and_historical_snapshot_stay_stable_after_selection_changes(self):
        self.fake_stream(reply="回答")
        conversation = self.open_conversation()
        contexts = {
            scope: self.context(scope, **anchor)
            for scope, anchor in (
                ("sentence", {"sentence": 0}),
                ("selection", {"start": 0, "end": 1, "selectedText": "  Chapter  "}),
                ("chapter", {"chapter": 1}),
                ("book", {}),
            )
        }
        for scope, context in contexts.items():
            status, _, _ = self.messages(
                conversation["id"], context=context, text=f"{scope} question")
            self.assertEqual(status, 200)
            outbound = self.calls[-1]["body"]["messages"]
            self.assertTrue(outbound)
            for message in outbound[:-1]:
                self.assertIn("contextSnapshot", message)
            self.assertNotIn("contextSnapshot", outbound[-1])

        stored = self.body(self.get(
            f"/book-conversations/{conversation['id']}?profile=dad"))["conversation"]
        self.assertEqual(len(stored["messages"]), 8)
        for index, scope in enumerate(contexts):
            user = stored["messages"][index * 2]
            assistant = stored["messages"][index * 2 + 1]
            self.assertEqual(user["contextSnapshot"], contexts[scope])
            self.assertEqual(assistant["contextSnapshot"], contexts[scope])

        # A later request has its own snapshot; it cannot rewrite old history.
        self.messages(conversation["id"], context=contexts["selection"], text="follow up")
        reread = self.body(self.get(
            f"/book-conversations/{conversation['id']}?profile=dad"))["conversation"]
        self.assertEqual(reread["messages"][0]["contextSnapshot"], contexts["sentence"])
        self.assertEqual(reread["messages"][-2]["contextSnapshot"], contexts["selection"])
        follow_up_messages = self.calls[-1]["body"]["messages"]
        historical = follow_up_messages[:-1]
        self.assertEqual(len(historical), 8)
        for message, stored in zip(historical, reread["messages"][:-1]):
            self.assertEqual(message["contextSnapshot"], stored["contextSnapshot"])
        self.assertEqual(follow_up_messages[-1], {"role": "user", "content": "follow up"})

    def test_cross_book_context_is_rejected_before_the_model_and_not_persisted(self):
        self.fake_stream()
        conversation = self.open_conversation()
        other_id = self.body(self.upload("spine.epub", profile="dad"))["book"]["id"]
        other_context = self.body(self.json_request(
            "POST", f"/books/{other_id}/context",
            {"bookId": other_id, "scope": "sentence", "chapter": 0, "sentence": 0}))["context"]
        status, _, body = self.json_request(
            "POST", f"/book-conversations/{conversation['id']}/messages?profile=dad",
            {"bookId": self.book_id, "text": "越界问题", "context": other_context})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "book_not_found")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.body(self.get(
            f"/book-conversations/{conversation['id']}?profile=dad"))["conversation"]["messages"], [])

    def test_model_errors_are_fixed_and_failed_stream_does_not_persist(self):
        conversation = self.open_conversation()
        self.proxy._stream_open = lambda request, timeout: (_ for _ in ()).throw(
            LookupError("ai_upstream_error"))
        status, _, body = self.messages(conversation["id"])
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body), {"error": "ai_upstream_error"})

        self.fake_stream(error=LookupError("ai_usage_limit"))
        status, _, body = self.messages(conversation["id"], text="用量受限")
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body), {"error": "ai_usage_limit"})
        self.assertEqual(self.body(self.get(
            f"/book-conversations/{conversation['id']}?profile=dad"))["conversation"]["messages"], [])

    def test_upstream_body_never_leaks_and_incomplete_stream_is_not_saved(self):
        conversation = self.open_conversation()
        self.proxy._stream_open = lambda request, timeout: _default_stream_open(
            request, timeout, urlopen=lambda request, timeout: (_ for _ in ()).throw(
                urllib.error.HTTPError(
                    request.full_url, 500, "Server Error", {},
                    io.BytesIO(b'{"error":"upstream_error","detail":"provider secret trace"}'))))
        status, _, body = self.messages(conversation["id"])
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body), {"error": "ai_upstream_error"})

        def incomplete(request, timeout):
            return stream_events({"type": "delta", "text": "半截"})
        self.proxy._stream_open = incomplete
        status, _, body = self.messages(conversation["id"], text="断流")
        self.assertEqual(status, 200)
        events = self.ndjson((status, {}, body))
        self.assertEqual([event["type"] for event in events], ["meta", "delta", "error"])
        self.assertEqual(events[-1]["code"], "ai_upstream_error")
        self.assertEqual(self.body(self.get(
            f"/book-conversations/{conversation['id']}?profile=dad"))["conversation"]["messages"], [])

    def test_ordinary_chat_does_not_receive_book_context(self):
        self.fake_stream()
        conversation = self.open_conversation()
        context = self.context()
        self.messages(conversation["id"], context=context)
        calls = []
        self.proxy._urlopen = lambda request, timeout: calls.append(
            json.loads(request.data.decode("utf-8"))) or {"text": "普通回复"}
        status, _, body = self.json_request("POST", "/conversations?profile=dad", {})
        chat = self.body((status, {}, body))["conversation"]
        self.json_request("POST", f"/conversations/{chat['id']}/messages?profile=dad", {"text": "普通问题"})
        self.assertEqual(calls, [{"messages": [{"role": "user", "content": "普通问题"}]}])


if __name__ == "__main__":
    unittest.main()
