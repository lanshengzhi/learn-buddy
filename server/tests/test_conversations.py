"""Chat / Conversations API tests (ticket #47).

The AI sidecar is faked in-process via the AiProxy `_urlopen` seam (same
pattern as TestAiEndpoint): tests never touch a real model provider, and the
recorded outbound payload is asserted exactly — the Chat context boundary
(ADR 0015: only the current Conversation's text history) is verified here.
"""

import io
import json
import os
import sys
import unittest
import urllib.error

from ai import _default_urlopen

try:
    from test_api import ApiTestCase
except ImportError:  # `python -m unittest tests.test_conversations` from server/
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from test_api import ApiTestCase


def fake_ai(proxy, reply="好的，这是回复。", calls=None):
    """Routes the app's AiProxy at a fake sidecar; records outbound payloads."""
    proxy.url = "http://ai.test"

    def upstream(request, timeout):
        if calls is not None:
            calls.append({"url": request.full_url, "body": json.loads(request.data.decode("utf-8"))})
        return {"text": reply}

    proxy._urlopen = upstream


class TestConversationLifecycle(ApiTestCase):
    def test_create_list_get_round_trip(self):
        status, _, body = self.json_request("POST", "/conversations?profile=dad", {})
        self.assertEqual(status, 201)
        conversation = json.loads(body)["conversation"]
        self.assertEqual(conversation["messages"], [])
        self.assertEqual(conversation["title"], "新对话")
        self.assertTrue(conversation["id"])

        status, _, body = self.get(f"/conversations?profile=dad")
        self.assertEqual(status, 200)
        summaries = json.loads(body)["conversations"]
        self.assertEqual(len(summaries), 1)
        self.assertEqual(summaries[0]["id"], conversation["id"])
        self.assertEqual(summaries[0]["messageCount"], 0)
        self.assertNotIn("messages", summaries[0])

        status, _, body = self.get(f"/conversations/{conversation['id']}?profile=dad")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["conversation"], conversation)

    def test_send_appends_user_and_assistant_and_titles_the_conversation(self):
        proxy = self.harness.httpd.app.ai
        fake_ai(proxy, reply="你好呀")
        conversation = self.body(self.json_request("POST", "/conversations?profile=dad", {}))["conversation"]

        status, _, body = self.json_request(
            "POST", f"/conversations/{conversation['id']}/messages?profile=dad", {"text": " 你好 "})
        self.assertEqual(status, 200)
        stored = json.loads(body)["conversation"]
        self.assertEqual(
            [(m["role"], m["content"]) for m in stored["messages"]],
            [("user", "你好"), ("assistant", "你好呀")],
        )
        self.assertEqual(stored["title"], "你好")

        # Persisted: a fresh GET sees the same history (reload/re-entry path).
        reread = self.body(self.get(f"/conversations/{conversation['id']}?profile=dad"))["conversation"]
        self.assertEqual(reread["messages"], stored["messages"])
        summary = self.body(self.get("/conversations?profile=dad"))["conversations"][0]
        self.assertEqual(summary["messageCount"], 2)

    def test_follow_up_uses_only_the_current_conversation(self):
        proxy = self.harness.httpd.app.ai
        calls = []
        fake_ai(proxy, calls=calls)
        first = self.body(self.json_request("POST", "/conversations?profile=dad", {}))["conversation"]
        second = self.body(self.json_request("POST", "/conversations?profile=dad", {}))["conversation"]
        self.json_request("POST", f"/conversations/{first['id']}/messages?profile=dad", {"text": "甲一"})
        self.json_request("POST", f"/conversations/{second['id']}/messages?profile=dad", {"text": "乙一"})

        calls.clear()
        status, _, _ = self.json_request(
            "POST", f"/conversations/{first['id']}/messages?profile=dad", {"text": "甲二"})
        self.assertEqual(status, 200)
        # The exact context boundary: only this Conversation's role/content
        # pairs plus the new message — no other Conversation, no profile, no
        # Read content, no message timestamps.
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]["url"].endswith("/chat"))
        self.assertEqual(calls[0]["body"], {
            "messages": [
                {"role": "user", "content": "甲一"},
                {"role": "assistant", "content": "好的，这是回复。"},
                {"role": "user", "content": "甲二"},
            ],
        })

    def test_person_scoping(self):
        proxy = self.harness.httpd.app.ai
        fake_ai(proxy)
        dad_conv = self.body(self.json_request("POST", "/conversations?profile=dad", {}))["conversation"]
        self.json_request("POST", f"/conversations/{dad_conv['id']}/messages?profile=dad", {"text": "爸爸的"})

        # Mom sees her own (empty) list; dad's Conversation is not in it.
        mom_list = self.body(self.get("/conversations?profile=mom"))["conversations"]
        self.assertEqual(mom_list, [])
        dad_list = self.body(self.get("/conversations?profile=dad"))["conversations"]
        self.assertEqual([c["id"] for c in dad_list], [dad_conv["id"]])

        # Mom cannot read or post into dad's Conversation.
        status, _, body = self.get(f"/conversations/{dad_conv['id']}?profile=mom")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "conversation_not_found")
        status, _, body = self.json_request(
            "POST", f"/conversations/{dad_conv['id']}/messages?profile=mom", {"text": "越界"})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "conversation_not_found")

    def test_validation(self):
        status, _, body = self.get("/conversations")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "bad_request")
        status, _, body = self.get("/conversations?profile=nobody")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "profile_not_found")
        status, _, body = self.get("/conversations/999999?profile=dad")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "conversation_not_found")
        status, _, body = self.get("/conversations/..%2F..%2Fprefs?profile=dad")
        self.assertEqual(status, 404)

        conversation = self.body(self.json_request("POST", "/conversations?profile=dad", {}))["conversation"]
        status, _, body = self.json_request(
            "POST", f"/conversations/{conversation['id']}/messages?profile=dad", {"text": "   "})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "bad_request")


class TestConversationFailures(ApiTestCase):
    """A failed model request leaves the stored Conversation intact and the
    family sees a fixed, safe code — never upstream provider text (ADR 0013,
    spec §9.2)."""

    def _conversation_with_history(self):
        proxy = self.harness.httpd.app.ai
        fake_ai(proxy)
        conversation = self.body(self.json_request("POST", "/conversations?profile=dad", {}))["conversation"]
        self.json_request("POST", f"/conversations/{conversation['id']}/messages?profile=dad",
                          {"text": "第一句"})
        return conversation

    def test_ai_not_configured(self):
        conversation = self._conversation_with_history()
        self.harness.httpd.app.ai.url = ""
        status, _, body = self.json_request(
            "POST", f"/conversations/{conversation['id']}/messages?profile=dad", {"text": "第二句"})
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"], "ai_not_configured")
        stored = self.body(self.get(f"/conversations/{conversation['id']}?profile=dad"))["conversation"]
        self.assertEqual(len(stored["messages"]), 2)  # history intact, nothing appended

    def test_upstream_error_preserves_history(self):
        conversation = self._conversation_with_history()
        proxy = self.harness.httpd.app.ai

        def failing(request, timeout):
            raise LookupError("ai_upstream_error")

        proxy._urlopen = failing
        status, _, body = self.json_request(
            "POST", f"/conversations/{conversation['id']}/messages?profile=dad", {"text": "第二句"})
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body)["error"], "ai_upstream_error")
        stored = self.body(self.get(f"/conversations/{conversation['id']}?profile=dad"))["conversation"]
        self.assertEqual([m["content"] for m in stored["messages"]], ["第一句", "好的，这是回复。"])

        # Recovery: a working sidecar again continues the same Conversation.
        fake_ai(proxy, reply="恢复了")
        status, _, body = self.json_request(
            "POST", f"/conversations/{conversation['id']}/messages?profile=dad", {"text": "第二句"})
        self.assertEqual(status, 200)
        stored = json.loads(body)["conversation"]
        self.assertEqual(stored["messages"][-1]["content"], "恢复了")

    def test_timeout_maps_to_ai_timeout(self):
        conversation = self._conversation_with_history()
        proxy = self.harness.httpd.app.ai

        def slow(request, timeout):
            raise LookupError("ai_timeout")

        proxy._urlopen = slow
        status, _, body = self.json_request(
            "POST", f"/conversations/{conversation['id']}/messages?profile=dad", {"text": "第二句"})
        self.assertEqual(status, 504)
        self.assertEqual(json.loads(body)["error"], "ai_timeout")

    def test_usage_limit_surfaces_its_own_code(self):
        conversation = self._conversation_with_history()
        proxy = self.harness.httpd.app.ai

        def walled_transport(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 502, "Bad Gateway", {},
                io.BytesIO(b'{"error":"usage_limit","retryAfterMinutes":40}'))

        proxy._urlopen = lambda request, timeout: _default_urlopen(
            request, timeout, urlopen=walled_transport)
        status, _, body = self.json_request(
            "POST", f"/conversations/{conversation['id']}/messages?profile=dad", {"text": "第二句"})
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"], "ai_usage_limit")
        stored = self.body(self.get(f"/conversations/{conversation['id']}?profile=dad"))["conversation"]
        self.assertEqual(len(stored["messages"]), 2)

    def test_upstream_error_text_is_never_forwarded(self):
        conversation = self._conversation_with_history()
        proxy = self.harness.httpd.app.ai

        def leaky_transport(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 500, "Server Error", {},
                io.BytesIO(b'{"error":"upstream_error","detail":"provider secret trace"}'))

        proxy._urlopen = lambda request, timeout: _default_urlopen(
            request, timeout, urlopen=leaky_transport)
        status, headers, body = self.json_request(
            "POST", f"/conversations/{conversation['id']}/messages?profile=dad", {"text": "第二句"})
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body), {"error": "ai_upstream_error"})  # no upstream text

    def test_chat_replies_are_not_cached(self):
        proxy = self.harness.httpd.app.ai
        calls = []
        fake_ai(proxy, calls=calls)
        conversation = self.body(self.json_request("POST", "/conversations?profile=dad", {}))["conversation"]
        # The same text twice still reaches the sidecar twice — Chat turns are
        # Person-scoped state, never ai-cache material.
        self.json_request("POST", f"/conversations/{conversation['id']}/messages?profile=dad",
                          {"text": "同一句话"})
        conversation2 = self.body(self.json_request("POST", "/conversations?profile=dad", {}))["conversation"]
        self.json_request("POST", f"/conversations/{conversation2['id']}/messages?profile=dad",
                          {"text": "同一句话"})
        self.assertEqual(len(calls), 2)
        cache_dir = os.path.join(self.harness.data_dir, "ai-cache")
        self.assertFalse(os.path.isdir(cache_dir) and os.listdir(cache_dir))


if __name__ == "__main__":
    unittest.main()
