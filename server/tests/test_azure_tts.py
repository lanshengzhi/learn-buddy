"""Azure Speech REST client tests — hermetic (fake HTTP, no network).

Lock the REST contract: endpoint, auth header, output format, SSML envelope
(xml:lang + full voice name + prosody rate), body passthrough of the
reading.py SSML body, and the mapping of HTTP/transport failures onto the
shared TTS error codes (the edge_tts vocabulary).
"""

import socket
import unittest
import urllib.error

from azure_tts import (
    DEFAULT_REGION,
    ENDPOINT,
    OUTPUT_FORMAT,
    USER_AGENT,
    AzureTtsError,
    AzureTtsSynthesizer,
)
from edge_tts import EdgeTtsError

JA_VOICE = "Microsoft Server Speech Text to Speech Voice (ja-JP, KeitaNeural)"
EN_VOICE = "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)"


class FakeResponse:
    def __init__(self, data=b""):
        self._data = data

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class RecordingOpener:
    """Stand-in for urllib.request.urlopen: records Requests, raises scripted
    errors, returns a scripted response."""

    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append((request, timeout))
        if self.error is not None:
            raise self.error
        return self.response


def make_synth(opener=None, **kwargs):
    kwargs.setdefault("open", opener or RecordingOpener(FakeResponse(b"MP3")))
    kwargs.setdefault("key", "test-key")
    return AzureTtsSynthesizer(**kwargs)


class TestRequest(unittest.TestCase):
    def test_post_to_region_endpoint_with_expected_headers(self):
        opener = RecordingOpener(FakeResponse(b"MP3"))
        synth = make_synth(opener)
        synth.speak("こんにちは", JA_VOICE, "+0%")
        request, timeout = opener.requests[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(
            request.full_url,
            ENDPOINT.format(region=DEFAULT_REGION),
        )
        headers = {k.lower(): v for k, v in request.header_items()}
        self.assertEqual(headers.get("ocp-apim-subscription-key"), "test-key")
        self.assertEqual(headers.get("content-type"), "application/ssml+xml")
        self.assertEqual(headers.get("x-microsoft-outputformat"), OUTPUT_FORMAT)
        self.assertEqual(headers.get("user-agent"), USER_AGENT)
        self.assertEqual(timeout, 30)

    def test_envelope_carries_lang_voice_and_prosody_rate(self):
        opener = RecordingOpener(FakeResponse(b"MP3"))
        synth = make_synth(opener)
        synth.speak("体", JA_VOICE, "-50%")
        body = opener.requests[0][0].data.decode("utf-8")
        self.assertIn(
            '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
            'xml:lang="ja-JP">',
            body,
        )
        self.assertIn(f'<voice name="{JA_VOICE}">', body)
        self.assertIn('<prosody rate="-50%">', body)
        self.assertIn("</voice></speak>", body)

    def test_ssml_body_passes_through_verbatim(self):
        opener = RecordingOpener(FakeResponse(b"MP3"))
        synth = make_synth(opener)
        body_arg = '<phoneme alphabet="sapi" ph="サダメ\'ル">定める</phoneme>'
        synth.speak(body_arg, JA_VOICE, "+0%")
        body = opener.requests[0][0].data.decode("utf-8")
        self.assertIn(body_arg, body)

    def test_envelope_does_not_double_escape_the_body(self):
        # Escaping happens once in reading.py; the envelope embeds the body
        # verbatim (double-escaping would turn &amp; into &amp;amp;).
        opener = RecordingOpener(FakeResponse(b"MP3"))
        synth = make_synth(opener)
        synth.speak("A&amp;B &lt;tag&gt;", EN_VOICE, "+0%")
        body = opener.requests[0][0].data.decode("utf-8")
        self.assertIn("A&amp;B &lt;tag&gt;", body)
        self.assertNotIn("&amp;amp;", body)

    def test_returns_audio_bytes(self):
        opener = RecordingOpener(FakeResponse(b"\xff\xf3MP3"))
        synth = make_synth(opener)
        self.assertEqual(synth.speak("hi", EN_VOICE, "+0%"), b"\xff\xf3MP3")

    def test_region_override(self):
        opener = RecordingOpener(FakeResponse(b"MP3"))
        synth = make_synth(opener, region="eastus")
        synth.speak("hi", EN_VOICE, "+0%")
        self.assertIn("https://eastus.tts.speech.microsoft.com/", opener.requests[0][0].full_url)


class TestErrorMapping(unittest.TestCase):
    def test_missing_key_is_upstream_unavailable(self):
        synth = AzureTtsSynthesizer(key=None, open=RecordingOpener())
        with self.assertRaises(EdgeTtsError) as ctx:
            synth.speak("hi", EN_VOICE, "+0%")
        self.assertEqual(ctx.exception.code, "upstream_unavailable")

    def test_http_error_maps_to_upstream_unavailable(self):
        for status in (400, 401, 403, 429, 500, 503):
            error = urllib.error.HTTPError("url", status, "err", {}, None)
            synth = make_synth(RecordingOpener(error=error))
            with self.assertRaises(EdgeTtsError) as ctx:
                synth.speak("hi", EN_VOICE, "+0%")
            self.assertEqual(ctx.exception.code, "upstream_unavailable", status)

    def test_timeout_maps_to_upstream_timeout(self):
        synth = make_synth(RecordingOpener(error=socket.timeout("timed out")))
        with self.assertRaises(EdgeTtsError) as ctx:
            synth.speak("hi", EN_VOICE, "+0%")
        self.assertEqual(ctx.exception.code, "upstream_timeout")

    def test_urlerror_timeout_maps_to_upstream_timeout(self):
        error = urllib.error.URLError(socket.timeout("timed out"))
        synth = make_synth(RecordingOpener(error=error))
        with self.assertRaises(EdgeTtsError) as ctx:
            synth.speak("hi", EN_VOICE, "+0%")
        self.assertEqual(ctx.exception.code, "upstream_timeout")

    def test_urlerror_network_maps_to_network_failure(self):
        error = urllib.error.URLError(ConnectionError("connection refused"))
        synth = make_synth(RecordingOpener(error=error))
        with self.assertRaises(EdgeTtsError) as ctx:
            synth.speak("hi", EN_VOICE, "+0%")
        self.assertEqual(ctx.exception.code, "network_failure")

    def test_empty_response_is_upstream_unavailable(self):
        synth = make_synth(RecordingOpener(FakeResponse(b"")))
        with self.assertRaises(AzureTtsError) as ctx:
            synth.speak("hi", EN_VOICE, "+0%")
        self.assertEqual(ctx.exception.code, "upstream_unavailable")

    def test_azure_errors_are_edge_tts_error_subtypes(self):
        # The HTTP layer catches EdgeTtsError; Azure errors must be visible
        # to that handler and carry the shared vocabulary.
        synth = make_synth(RecordingOpener(FakeResponse(b"")))
        with self.assertRaises(EdgeTtsError) as ctx:
            synth.speak("hi", EN_VOICE, "+0%")
        self.assertTrue(isinstance(ctx.exception, AzureTtsError))


if __name__ == "__main__":
    unittest.main()
