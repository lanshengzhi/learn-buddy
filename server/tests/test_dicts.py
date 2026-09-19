"""Lookup dictionaries (ADR 0008): fixture databases, the en/ja resolve
chains, the presence check, and the /ai proxy degrade codes."""

import hashlib
import json
import os
import shutil
import tempfile
import unittest
import urllib.error
import urllib.request

from ai import AiProxy, _default_urlopen
from dicts import Dicts, LookupUnavailable


def _write_db(path, statements):
    import sqlite3

    if os.path.isfile(path):
        os.unlink(path)
    connection = sqlite3.connect(path)
    with connection:
        for statement in statements:
            connection.execute(statement)
    connection.close()


def _fixture_dicts(dir):
    """Minimal en/ja/kanji dictionaries in the documented schema."""
    _write_db(
        os.path.join(dir, "en.sqlite"),
        [
            "CREATE TABLE ecdict (word TEXT PRIMARY KEY, phonetic TEXT, translation TEXT, definition TEXT)",
            "INSERT INTO ecdict VALUES ('run', 'rʌn', '跑\n运行', 'move fast')",
            "INSERT INTO ecdict VALUES ('stop', 'stɑp', '停', 'cease')",
        ],
    )
    _write_db(
        os.path.join(dir, "ja.sqlite"),
        [
            "CREATE TABLE forms (text TEXT NOT NULL, entry INTEGER NOT NULL)",
            "CREATE TABLE entries (id INTEGER PRIMARY KEY, reading TEXT)",
            "CREATE TABLE senses (entry INTEGER NOT NULL, ord INTEGER NOT NULL, pos TEXT, gloss TEXT)",
            "CREATE INDEX forms_text ON forms(text)",
            "INSERT INTO entries VALUES (1, 'たべる')",
            "INSERT INTO forms VALUES ('食べる', 1), ('たべる', 1)",
            "INSERT INTO senses VALUES (1, 0, 'v1', 'to eat')",
            "INSERT INTO senses VALUES (1, 1, '', 'to live on')",
        ],
    )
    _write_db(
        os.path.join(dir, "kanji.sqlite"),
        [
            "CREATE TABLE kanji (kanji TEXT PRIMARY KEY, onyomi TEXT, kunyomi TEXT, meanings TEXT)",
            "INSERT INTO kanji VALUES ('食', 'ショク', 'く.う', 'eat|food')",
        ],
    )


class DictsTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        _fixture_dicts(self.dir)
        self.dicts = Dicts(self.dir)

    def tearDown(self):
        self.dicts.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_en_exact_match(self):
        entry = self.dicts.lookup_en("Run")
        self.assertEqual(entry["key"], "en:run")
        self.assertEqual(entry["reading"], "rʌn")
        self.assertEqual([sense["gloss"] for sense in entry["senses"]][:2], ["跑", "运行"])

    def test_en_lemma_fallback(self):
        self.assertEqual(self.dicts.lookup_en("runs")["key"], "en:run")
        self.assertEqual(self.dicts.lookup_en("stopping")["key"], "en:stop")
        self.assertEqual(self.dicts.lookup_en("stopped")["key"], "en:stop")

    def test_en_misses_are_none(self):
        self.assertIsNone(self.dicts.lookup_en("qwertyuiop"))
        self.assertIsNone(self.dicts.lookup_en("日本語"))

    def test_ja_surface_hit(self):
        entry = self.dicts.lookup_ja("食べる")
        self.assertEqual(entry["key"], "ja:食べる")
        self.assertEqual(entry["matched"], "食べる")
        self.assertEqual(entry["reading"], "たべる")
        self.assertEqual(entry["senses"][0], {"pos": "v1", "gloss": "to eat"})

    def test_ja_inflected_form_hits_via_chain(self):
        try:
            from sudachipy import Dictionary  # noqa: F401
        except ImportError:
            self.skipTest("sudachipy not installed")
        entry = self.dicts.lookup_ja("食べられ")
        self.assertEqual(entry["key"], "ja:食べる")

    def test_ja_kanji_fallback_for_single_character(self):
        entry = self.dicts.lookup_ja("食")
        self.assertEqual(entry["key"], "ja:食")
        self.assertIn("eat", entry["senses"][0]["gloss"])

    def test_ja_without_dict_file_raises(self):
        self.dicts.close()
        shutil.rmtree(self.dir, ignore_errors=True)
        os.makedirs(self.dir)
        empty = Dicts(self.dir)
        try:
            with self.assertRaises(LookupUnavailable):
                empty.lookup_ja("何か")
        finally:
            empty.close()

    def test_check_reports_keys(self):
        found = self.dicts.check("ja", ["食べる", "存在しない語"])
        self.assertEqual(found["食べる"], "ja:食べる")
        self.assertIsNone(found["存在しない語"])

    def test_check_unknown_language_all_miss(self):
        found = self.dicts.check("zh", ["红楼梦"])
        self.assertEqual(found, {"红楼梦": None})


class AiProxyTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.url = "http://127.0.0.1:9"

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def make(self, url=None, urlopen=None):
        return AiProxy(
            os.path.join(self.dir, "ai-cache"),
            url=self.url if url is None else url,
            urlopen=urlopen,
        )

    def test_not_configured(self):
        proxy = self.make(url="")
        with self.assertRaises(LookupError) as raised:
            proxy.explain("word", "sentence", "en")
        self.assertEqual(str(raised.exception), "ai_not_configured")

    def test_validation(self):
        proxy = self.make(url="")
        with self.assertRaises(ValueError):
            proxy.explain("", "sentence", "en")

    def test_cache_hit_skips_upstream(self):
        calls = []

        def urlopen(request, timeout):
            calls.append(request)
            raise AssertionError("upstream should not be called on cache hit")

        proxy = self.make(urlopen=urlopen)
        key = hashlib.sha256("word|sentence|en".encode("utf-8")).hexdigest()
        proxy._write_cache(key, {"text": "cached"})
        self.assertEqual(proxy.explain("word", "sentence", "en"), {"text": "cached"})
        self.assertEqual(calls, [])

    def test_upstream_answer_shape_and_cache_write(self):
        def urlopen(request, timeout):
            self.assertEqual(request.full_url, self.url + "/explain")
            payload = json.loads(request.data.decode("utf-8"))
            self.assertEqual(payload, {"word": "run", "sentence": "I run.", "language": "en"})
            return {"text": "It means to run."}

        proxy = self.make(urlopen=urlopen)
        self.assertEqual(proxy.explain("run", "I run.", "en"), {"text": "It means to run."})
        # Second call hits the cache even though the injected upstream died.
        proxy._urlopen = None
        self.assertEqual(proxy.explain("run", "I run.", "en"), {"text": "It means to run."})

    def test_injected_upstream_errors_propagate(self):
        def urlopen(request, timeout):
            raise LookupError("ai_timeout")

        proxy = self.make(urlopen=urlopen)
        with self.assertRaises(LookupError) as raised:
            proxy.explain("run", "I run.", "en")
        self.assertEqual(str(raised.exception), "ai_timeout")

    def test_default_urlopen_maps_degrade_codes(self):
        class FakeResponse:
            def __init__(self, payload):
                self.payload = payload

            def read(self):
                return self.payload

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        request = urllib.request.Request(self.url + "/explain", data=b"{}", method="POST")
        answer = _default_urlopen(request, 0, urlopen=lambda req, timeout: FakeResponse(b'{"text": "hi"}'))
        self.assertEqual(answer, {"text": "hi"})

        def raise_http(req, timeout):
            raise urllib.error.HTTPError("u", 500, "boom", None, None)

        def raise_timeout(req, timeout):
            raise urllib.error.URLError(TimeoutError("timed out"))

        def raise_refused(req, timeout):
            raise urllib.error.URLError(ConnectionRefusedError())

        def bad_json(req, timeout):
            return FakeResponse(b"not json")

        def bad_shape(req, timeout):
            return FakeResponse(b'{"nope": 1}')

        for urlopen, expected in (
            (raise_http, "ai_upstream_error"),
            (raise_timeout, "ai_timeout"),
            (raise_refused, "ai_upstream_error"),
            (bad_json, "ai_upstream_error"),
            (bad_shape, "ai_upstream_error"),
        ):
            with self.assertRaises(LookupError) as raised:
                _default_urlopen(request, 0, urlopen=urlopen)
            self.assertEqual(str(raised.exception), expected)


if __name__ == "__main__":
    unittest.main()
