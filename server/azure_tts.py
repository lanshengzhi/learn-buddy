"""Azure Speech REST TTS client — stdlib only (urllib). ADR 0005.

The primary synthesis provider when AZURE_SPEECH_KEY is set; Edge TTS stays
as the automatic fallback in tts_server.py. Azure accepts real SSML, so the
<phoneme alphabet="sapi"> reading + pitch-accent hints produced by
reading.py actually work here (Edge could not take them — ADR 0004).

Protocol:

- POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
- Headers: Ocp-Apim-Subscription-Key, Content-Type: application/ssml+xml,
  X-Microsoft-OutputFormat: audio-24khz-48kbitrate-mono-mp3, User-Agent
- Body: an SSML envelope (<speak xml:lang> <voice name="{full voice name}">
  <prosody rate="{rate}"> {ssml body} </prosody> </voice> </speak>) built
  around the normalized body from reading.py. The full voice name is the
  same one Edge accepts, so the voice/rate/lang contract is unchanged.

Failures surface as AzureTtsError carrying the shared TTS error codes (the
edge_tts vocabulary, web/js/core/errors.js), so tts_server.py's error
mapping keeps working unchanged.
"""

import os
import re
import socket
import urllib.error
import urllib.request

from edge_tts import (
    EdgeTtsError,
    CODE_NETWORK_FAILURE,
    CODE_UPSTREAM_TIMEOUT,
    CODE_UPSTREAM_UNAVAILABLE,
    CODE_UNKNOWN,
)

DEFAULT_REGION = "japaneast"
ENDPOINT = "https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"
OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3"
USER_AGENT = "LearnBuddy/1.0 (family TTS proxy)"
TIMEOUT_SECONDS = 30

# Full voice names are "Microsoft Server Speech Text to Speech Voice (ja-JP,
# KeitaNeural)"; the envelope's xml:lang comes from the lang-region part.
_LANG_FROM_VOICE_RE = re.compile(
    r"^Microsoft Server Speech Text to Speech Voice \(([^,]+),"
)


class AzureTtsError(EdgeTtsError):
    """An Azure Speech synthesis failure, carrying a shared TTS error code.
    Subtypes EdgeTtsError so the HTTP layer's error mapping keeps working."""


class AzureTtsSynthesizer:
    """Synthesizes MP3 bytes for one request via the Azure Speech REST API.

    speak(ssml_body, voice, rate): ssml_body is the SSML-embeddable body from
    reading.py (phoneme-wrapped misreads + escaped text). Request validation
    happens once in TtsServer before this is reached, so speak does not
    re-validate. The rate is applied as SSML prosody (same syntax Edge used).
    """

    def __init__(self, key=None, region=None, open=None, timeout=TIMEOUT_SECONDS):
        # key/region default from the environment; injectable for tests.
        self.key = key if key is not None else os.environ.get("AZURE_SPEECH_KEY")
        self.region = region or os.environ.get("AZURE_SPEECH_REGION") or DEFAULT_REGION
        self.timeout = timeout
        self.open = open or urllib.request.urlopen

    def speak(self, ssml_body, voice, rate):
        if not self.key:
            raise AzureTtsError(
                CODE_UPSTREAM_UNAVAILABLE, "AZURE_SPEECH_KEY is not configured"
            )
        request = urllib.request.Request(
            ENDPOINT.format(region=self.region),
            data=self._envelope(ssml_body, voice, rate).encode("utf-8"),
            method="POST",
            headers={
                "Ocp-Apim-Subscription-Key": self.key,
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with self.open(request, timeout=self.timeout) as response:
                audio = response.read()
        except (EdgeTtsError, OSError) as error:
            raise _to_tts_error(error)
        if not audio:
            raise AzureTtsError(
                CODE_UPSTREAM_UNAVAILABLE, "Azure Speech returned no audio"
            )
        return audio

    def _envelope(self, ssml_body, voice, rate):
        lang = _lang_from_voice(voice)
        return (
            '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
            f'xml:lang="{lang}">'
            f'<voice name="{voice}">'
            f'<prosody rate="{rate}">{ssml_body}</prosody>'
            "</voice>"
            "</speak>"
        )


def _lang_from_voice(voice):
    match = _LANG_FROM_VOICE_RE.match(voice)
    if not match:
        raise AzureTtsError(
            CODE_UPSTREAM_UNAVAILABLE, f"Voice has no usable lang for Azure: {voice!r}"
        )
    return match.group(1)


def _to_tts_error(error):
    if isinstance(error, EdgeTtsError):
        return error
    if isinstance(error, urllib.error.HTTPError):
        return AzureTtsError(
            CODE_UPSTREAM_UNAVAILABLE,
            f"Azure Speech rejected the request (HTTP {error.code})",
        )
    if isinstance(error, urllib.error.URLError):
        if isinstance(error.reason, (socket.timeout, TimeoutError)):
            return AzureTtsError(CODE_UPSTREAM_TIMEOUT, "Azure Speech request timed out")
        return AzureTtsError(
            CODE_NETWORK_FAILURE, f"Azure Speech request failed: {error.reason}"
        )
    if isinstance(error, (socket.timeout, TimeoutError)):
        return AzureTtsError(CODE_UPSTREAM_TIMEOUT, "Azure Speech request timed out")
    if isinstance(error, OSError):
        return AzureTtsError(
            CODE_NETWORK_FAILURE, f"Azure Speech request failed: {error}"
        )
    return AzureTtsError(CODE_UNKNOWN, f"Azure Speech synthesis failed: {error}")
