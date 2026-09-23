import json
import os
import shutil
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from edge_tts import EdgeTtsError
from tts_server import AppServer, TtsHandler, TtsServer, default_voice_for


class FakeSynthesizer:
    """Records calls; scripted failures."""

    def __init__(self):
        self.calls = []
        self.fail_with = None  # EdgeTtsError or list of them (raised in order)

    def speak(self, text, voice, rate):
        self.calls.append((text, voice, rate))
        if isinstance(self.fail_with, list):
            if self.fail_with:
                raise self.fail_with.pop(0)
        elif self.fail_with is not None:
            raise self.fail_with
        return b"\xff\xf3" + text.encode() + b"|" + voice.encode() + b"|" + rate.encode()


class FakeAzureSynthesizer:
    """Azure stand-in for provider-selection tests. key controls whether the
    server treats Azure as primary (non-empty key → primary)."""

    def __init__(self, key="test-key"):
        self.key = key
        self.calls = []
        self.fail_with = None  # EdgeTtsError or list of them (raised in order)

    def speak(self, body, voice, rate):
        self.calls.append((body, voice, rate))
        if isinstance(self.fail_with, list):
            if self.fail_with:
                raise self.fail_with.pop(0)
        elif self.fail_with is not None:
            raise self.fail_with
        return b"azure-mp3" + body.encode()


class ServerHarness:
    def __init__(self, static_dir, fake_synth, pace_interval=0.01, sleep=time.sleep,
                 normalizer=None, azure=None, data_dir=None, library_obj=None):
        self.tmp = tempfile.mkdtemp()
        self.cache_dir = os.path.join(self.tmp, "cache")
        # Explicit fake providers so tests never depend on the developer's
        # AZURE_SPEECH_KEY; default = no key → Edge primary.
        azure_synth = azure if azure is not None else FakeAzureSynthesizer(key=None)
        self.data_dir = data_dir or os.path.join(self.tmp, "data")
        server_obj = TtsServer(
            static_dir=static_dir,
            cache_dir=self.cache_dir,
            synthesizer=fake_synth,
            azure=azure_synth,
            pace_interval=pace_interval,
            sleep=sleep,
            normalizer=normalizer,
            data_dir=self.data_dir,
            library=library_obj,
        )

        self.httpd = AppServer(("127.0.0.1", 0), TtsHandler, server_obj)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def request(self, method, path, body=None, headers=None):
        url = f"http://127.0.0.1:{self.port}{path}"
        request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    def get(self, path):
        return self.request("GET", path)

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestTtsEndpoint(unittest.TestCase):
    def setUp(self):
        self.fake.calls.clear()

    @classmethod
    def setUpClass(cls):
        cls.fake = FakeSynthesizer()
        cls.static_dir = tempfile.mkdtemp()
        with open(os.path.join(cls.static_dir, "index.html"), "w") as fh:
            fh.write("<h1>LearnBuddy</h1>")
        with open(os.path.join(cls.static_dir, "reader.html"), "w") as fh:
            fh.write("<h1>Reader</h1>")
        os.makedirs(os.path.join(cls.static_dir, "js", "core"))
        with open(os.path.join(cls.static_dir, "js", "core", "language.js"), "w") as fh:
            fh.write("export const x = 1;")
        cls.harness = ServerHarness(cls.static_dir, cls.fake)

    @classmethod
    def tearDownClass(cls):
        cls.harness.close()
        shutil.rmtree(cls.static_dir, ignore_errors=True)

    def _url(self, **params):
        from urllib.parse import urlencode
        return "/tts?" + urlencode(params)

    def test_returns_mp3_with_normalized_voice(self):
        status, headers, body = self.harness.get(self._url(text="hello", voice="en-US-AriaNeural", rate="+0%"))
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/mpeg")
        self.assertIn(b"hello", body)
        self.assertEqual(self.fake.calls[0], ("hello", "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)", "+0%"))

    def test_voice_defaults_by_lang(self):
        self.harness.get(self._url(text="こんにちは", lang="ja"))
        self.assertEqual(self.fake.calls[-1][1], "Microsoft Server Speech Text to Speech Voice (ja-JP, KeitaNeural)")
        self.harness.get(self._url(text="你好", lang="zh"))
        self.assertEqual(self.fake.calls[-1][1], "Microsoft Server Speech Text to Speech Voice (zh-CN, YunxiNeural)")
        self.harness.get(self._url(text="hi"))
        self.assertEqual(self.fake.calls[-1][1], "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)")

    def test_empty_text_is_400(self):
        status, _, body = self.harness.get(self._url(text="   ", voice="en-US-AriaNeural", rate="+0%"))
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "empty_text")

    def test_text_over_500_is_400(self):
        status, _, body = self.harness.get(self._url(text="x" * 501, voice="en-US-AriaNeural", rate="+0%"))
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "text_too_long")

    def test_invalid_voice_and_rate_are_400(self):
        status, _, body = self.harness.get(self._url(text="hi", voice="bogus", rate="+0%"))
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "invalid_voice")
        status, _, body = self.harness.get(self._url(text="hi", voice="en-US-AriaNeural", rate="+200%"))
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "invalid_rate")

    def test_server_cache_hits_skip_the_upstream(self):
        before = len(self.fake.calls)
        self.harness.get(self._url(text="cached sentence", voice="en-US-AriaNeural", rate="-50%"))
        self.harness.get(self._url(text="cached sentence", voice="en-US-AriaNeural", rate="-50%"))
        self.harness.get(self._url(text="cached sentence", voice="en-US-AriaNeural", rate="-50%"))
        # Only the first request reached the upstream.
        self.assertEqual(len(self.fake.calls), before + 1)

    def test_cache_key_includes_rate(self):
        self.harness.get(self._url(text="same text", voice="en-US-AriaNeural", rate="+0%"))
        self.harness.get(self._url(text="same text", voice="en-US-AriaNeural", rate="+50%"))
        self.assertEqual(len(self.fake.calls), 2)

    def test_upstream_failure_maps_to_502_with_code(self):
        fake = FakeSynthesizer()
        fake.fail_with = EdgeTtsError("upstream_unavailable", "boom")
        harness = ServerHarness(self.static_dir, fake)
        try:
            status, _, body = harness.get(harness_url(harness, text="hi", voice="en-US-AriaNeural", rate="+0%"))
            self.assertEqual(status, 502)
            self.assertEqual(json.loads(body)["error"], "upstream_unavailable")
        finally:
            harness.close()

    def test_upstream_timeout_maps_to_504(self):
        fake = FakeSynthesizer()
        fake.fail_with = EdgeTtsError("upstream_timeout", "slow")
        harness = ServerHarness(self.static_dir, fake)
        try:
            status, _, body = harness.get(harness_url(harness, text="hi", voice="en-US-AriaNeural", rate="+0%"))
            self.assertEqual(status, 504)
            self.assertEqual(json.loads(body)["error"], "upstream_timeout")
        finally:
            harness.close()

    def test_pacing_gate_spaces_upstream_connections(self):
        calls = []

        class PacedSynthesizer:
            def speak(self, text, voice, rate):
                calls.append(time.monotonic())
                return b"mp3"

        harness = ServerHarness(self.static_dir, PacedSynthesizer(), pace_interval=0.05)
        try:
            for i in range(3):
                harness.get(harness_url(harness, text=f"t{i}", voice="en-US-AriaNeural", rate="+0%"))
            gaps = [b - a for a, b in zip(calls, calls[1:])]
            self.assertTrue(all(gap >= 0.04 for gap in gaps), gaps)
        finally:
            harness.close()

    # -- reading normalization (ADR 0004) ---------------------------------

    def test_japanese_text_is_reading_normalized_for_edge(self):
        # With no Azure key, Edge is primary; a ja-JP request reaches the
        # Edge synthesizer as the reading-normalized text form (kana), so a
        # confirmed misread like 定める is corrected even on the fallback.
        fake = FakeSynthesizer()
        harness = ServerHarness(self.static_dir, fake)
        try:
            harness.get(harness_url(harness, text="定める", voice="ja-JP-KeitaNeural", rate="+0%"))
            self.assertEqual(fake.calls[0][0], "さだめる")
        finally:
            harness.close()

    def test_english_text_is_not_normalized(self):
        normalizer = lambda text: text.replace("今日は", "キョウハ")
        fake = FakeSynthesizer()
        harness = ServerHarness(self.static_dir, fake, normalizer=normalizer)
        try:
            harness.get(harness_url(harness, text="今日は hello", voice="en-US-AriaNeural", rate="+0%"))
            self.assertEqual(fake.calls[0][0], "今日は hello")
        finally:
            harness.close()

    def test_normalized_ja_and_raw_ja_share_a_cache_entry(self):
        # Cache key is built from the normalized text, so a Japanese sentence
        # and its kana form collide on purpose (same reading, one synthesis).
        def normalizer(text):
            return text.replace("銀行で", "ギンコウで")

        calls = []

        class RecordingSynthesizer:
            def speak(self, text, voice, rate):
                calls.append((text, voice, rate))
                return b"mp3"

        harness = ServerHarness(self.static_dir, RecordingSynthesizer(), normalizer=normalizer)
        try:
            harness.get(harness_url(harness, text="銀行で", voice="ja-JP-KeitaNeural", rate="+0%"))
            harness.get(harness_url(harness, text="ギンコウで", voice="ja-JP-KeitaNeural", rate="+0%"))
            self.assertEqual(len(calls), 1)  # second request hit the server cache
        finally:
            harness.close()


class TestProviderSelection(unittest.TestCase):
    """Azure primary when a key is present; Edge fallback on any Azure
    failure; the pace gate spaces Edge only (ADR 0005)."""

    @classmethod
    def setUpClass(cls):
        cls.static_dir = tempfile.mkdtemp()
        with open(os.path.join(cls.static_dir, "index.html"), "w") as fh:
            fh.write("<h1>LearnBuddy</h1>")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.static_dir, ignore_errors=True)

    def test_azure_is_primary_when_key_present(self):
        azure = FakeAzureSynthesizer(key="test-key")
        edge = FakeSynthesizer()
        harness = ServerHarness(self.static_dir, edge, azure=azure)
        try:
            harness.get(harness_url(harness, text="hello", voice="en-US-AriaNeural", rate="+0%"))
            self.assertEqual(len(azure.calls), 1)
            self.assertEqual(edge.calls, [])
        finally:
            harness.close()

    def test_edge_is_primary_without_key(self):
        azure = FakeAzureSynthesizer(key=None)
        edge = FakeSynthesizer()
        harness = ServerHarness(self.static_dir, edge, azure=azure)
        try:
            harness.get(harness_url(harness, text="hello", voice="en-US-AriaNeural", rate="+0%"))
            self.assertEqual(edge.calls[0][0], "hello")
            self.assertEqual(azure.calls, [])
        finally:
            harness.close()

    def test_azure_failure_falls_back_to_edge(self):
        azure = FakeAzureSynthesizer(key="test-key")
        azure.fail_with = EdgeTtsError("upstream_unavailable", "azure boom")
        edge = FakeSynthesizer()
        harness = ServerHarness(self.static_dir, edge, azure=azure)
        try:
            status, _, body = harness.get(harness_url(harness, text="hello", voice="en-US-AriaNeural", rate="+0%"))
            self.assertEqual(status, 200)
            self.assertEqual(len(azure.calls), 1)
            self.assertEqual(len(edge.calls), 1)
            self.assertEqual(edge.calls[0][0], "hello")
        finally:
            harness.close()

    def test_both_providers_failing_surfaces_edge_error(self):
        azure = FakeAzureSynthesizer(key="test-key")
        azure.fail_with = EdgeTtsError("upstream_timeout", "azure slow")
        edge = FakeSynthesizer()
        edge.fail_with = EdgeTtsError("upstream_unavailable", "edge down")
        harness = ServerHarness(self.static_dir, edge, azure=azure)
        try:
            status, _, body = harness.get(harness_url(harness, text="hello", voice="en-US-AriaNeural", rate="+0%"))
            self.assertEqual(status, 502)
            self.assertEqual(json.loads(body)["error"], "upstream_unavailable")
            self.assertEqual(len(azure.calls), 1)
            self.assertEqual(len(edge.calls), 1)
        finally:
            harness.close()

    def test_azure_receives_phoneme_ssml_body_for_japanese(self):
        azure = FakeAzureSynthesizer(key="test-key")
        edge = FakeSynthesizer()
        harness = ServerHarness(self.static_dir, edge, azure=azure)
        try:
            harness.get(harness_url(harness, text="定める", voice="ja-JP-KeitaNeural", rate="+0%"))
            body, voice, rate = azure.calls[0]
            self.assertEqual(voice, "Microsoft Server Speech Text to Speech Voice (ja-JP, KeitaNeural)")
            self.assertIn('<phoneme alphabet="sapi" ph="サダメ\'ル">定める</phoneme>', body)
        finally:
            harness.close()

    def test_azure_needs_no_pacing(self):
        # A 60s pace interval would serialize two Azure calls for minutes if
        # the gate applied; Azure is primary here so both return quickly.
        azure = FakeAzureSynthesizer(key="test-key")
        edge = FakeSynthesizer()
        harness = ServerHarness(self.static_dir, edge, azure=azure, pace_interval=60)
        try:
            start = time.monotonic()
            harness.get(harness_url(harness, text="one", voice="en-US-AriaNeural", rate="+0%"))
            harness.get(harness_url(harness, text="two", voice="en-US-AriaNeural", rate="+0%"))
            elapsed = time.monotonic() - start
            self.assertLess(elapsed, 5)
            self.assertEqual(len(azure.calls), 2)
            self.assertEqual(edge.calls, [])
        finally:
            harness.close()


def harness_url(harness, **params):
    from urllib.parse import urlencode
    return "/tts?" + urlencode(params)


class TestStaticServing(unittest.TestCase):
    def test_serves_frontend_files(self):
        fake = FakeSynthesizer()
        static_dir = tempfile.mkdtemp()
        with open(os.path.join(static_dir, "index.html"), "w") as fh:
            fh.write("<h1>hi</h1>")
        os.makedirs(os.path.join(static_dir, "js"))
        with open(os.path.join(static_dir, "js", "app.js"), "w") as fh:
            fh.write("console.log(1)")
        harness = ServerHarness(static_dir, fake)
        try:
            status, headers, body = harness.get("/")
            self.assertEqual(status, 200)
            self.assertEqual(body, b"<h1>hi</h1>")
            self.assertIn("text/html", headers["Content-Type"])
            status, _, body = harness.get("/js/app.js")
            self.assertEqual(status, 200)
            self.assertEqual(body, b"console.log(1)")
            status, _, _ = harness.get("/missing.html")
            self.assertEqual(status, 404)
        finally:
            harness.close()

    def test_next_shell_served_under_prefix(self):
        static_dir = tempfile.mkdtemp()
        with open(os.path.join(static_dir, "index.html"), "w") as fh:
            fh.write("<h1>old shell</h1>")
        next_dir = os.path.join(static_dir, "next")
        os.makedirs(next_dir)
        with open(os.path.join(next_dir, "index.html"), "w") as fh:
            fh.write("<h1>new shell</h1>")
        with open(os.path.join(next_dir, "shell.css"), "w") as fh:
            fh.write("body{}")
        harness = ServerHarness(static_dir, FakeSynthesizer())
        try:
            status, _, body = harness.get("/")
            self.assertEqual(status, 200)
            self.assertEqual(body, b"<h1>old shell</h1>")
            status, _, body = harness.get("/next/")
            self.assertEqual(status, 200)
            self.assertEqual(body, b"<h1>new shell</h1>")
            status, headers, body = harness.get("/next/shell.css")
            self.assertEqual(status, 200)
            self.assertEqual(body, b"body{}")
            self.assertIn("text/css", headers["Content-Type"])
            # The /next/ root must not be escapable, even onto a file that
            # exists in the old shell's root.
            status, _, _ = harness.get("/next/../index.html")
            self.assertEqual(status, 404)
            status, _, _ = harness.get("/next/%2e%2e/index.html")
            self.assertEqual(status, 404)
        finally:
            harness.close()

    def test_path_traversal_is_blocked(self):
        harness = ServerHarness(self.static_dir if hasattr(self, "static_dir") else tempfile.mkdtemp(), FakeSynthesizer())
        try:
            status, _, _ = harness.get("/../../etc/passwd")
            self.assertEqual(status, 404)
            status, _, _ = harness.get("/..%2f..%2fetc%2fpasswd")
            self.assertEqual(status, 404)
        finally:
            harness.close()


if __name__ == "__main__":
    unittest.main()
