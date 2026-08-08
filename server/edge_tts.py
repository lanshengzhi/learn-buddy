"""
Edge TTS upstream client — stdlib only, maintained in exactly one place
(ADR 0001). Implements the protocol verified in
research/edge-tts-browser.md and dasan's EdgeTtsProtocol.kt:

- wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
- TrustedClientToken + Sec-MS-GEC (300s-rounded Windows FILETIME ticks + token,
  SHA-256, uppercase hex) + Sec-MS-GEC-Version, all in the query string
- User-Agent gating: only current Edge-family UAs pass the handshake
- speech.config text frame, then one ssml text frame; MP3 bytes arrive in
  binary frames (2-byte big-endian header length, Path:audio headers)

Errors surface as EdgeTtsError carrying a TTS error code (see errors.js
vocabulary) so the HTTP layer can map them to status codes and the frontend
to learner-facing strings.
"""

import base64
import email.utils
import hashlib
import os
import re
import socket
import ssl
import struct
import time
import urllib.parse
import uuid

WSS_HOST = "speech.platform.bing.com"
WSS_PORT = 443
WSS_BASE_PATH = "/consumer/speech/synthesize/readaloud/edge/v1"
TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
CHROMIUM_FULL_VERSION = "143.0.3650.75"
CHROMIUM_MAJOR_VERSION = "143"
SEC_MS_GEC_VERSION = f"1-{CHROMIUM_FULL_VERSION}"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    f"(KHTML, like Gecko) Chrome/{CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 "
    f"Edg/{CHROMIUM_MAJOR_VERSION}.0.0.0"
)
WIN_EPOCH_SECONDS = 11_644_473_600
TICKS_PER_SECOND = 10_000_000

MAX_TEXT_LENGTH = 500
MIN_RATE_PERCENT = -90
MAX_RATE_PERCENT = 100

RATE_RE = re.compile(r"^[+-]\d+%$")
FULL_VOICE_RE = re.compile(r"^Microsoft Server Speech Text to Speech Voice \(.+,.+\)$")
SHORT_VOICE_RE = re.compile(r"^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$")

# Error codes shared with the frontend (web/js/core/errors.js).
CODE_EMPTY_TEXT = "empty_text"
CODE_TEXT_TOO_LONG = "text_too_long"
CODE_INVALID_VOICE = "invalid_voice"
CODE_INVALID_RATE = "invalid_rate"
CODE_UPSTREAM_UNAVAILABLE = "upstream_unavailable"
CODE_UPSTREAM_TIMEOUT = "upstream_timeout"
CODE_NETWORK_FAILURE = "network_failure"
CODE_UNKNOWN = "unknown"


class EdgeTtsError(Exception):
    """Carries a TTS error code (the shared vocabulary) plus a detail message."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class UpstreamRejected(EdgeTtsError):
    """The upstream handshake was rejected (403). The HTTP Date header may
    carry the server's clock for skew adjustment."""

    def __init__(self, server_date=None):
        super().__init__(CODE_UPSTREAM_UNAVAILABLE, "TTS upstream rejected the request")
        self.server_date = server_date


# --------------------------------------------------------------------------
# Protocol helpers
# --------------------------------------------------------------------------


def generate_sec_ms_gec(now=None, clock_skew_seconds=0):
    """Sec-MS-GEC token: (unix seconds rounded down to 300 + WIN_EPOCH) *
    10_000_000 as a decimal string, concatenated with the trusted client
    token, SHA-256, uppercase hex."""
    now = time.time() if now is None else now
    rounded = int((now + clock_skew_seconds) // 300) * 300
    ticks = (rounded + WIN_EPOCH_SECONDS) * TICKS_PER_SECOND
    payload = f"{ticks}{TRUSTED_CLIENT_TOKEN}".encode("ascii")
    return hashlib.sha256(payload).hexdigest().upper()


def new_connection_id():
    return uuid.uuid4().hex


def build_ws_url(connection_id=None, clock_skew_seconds=0):
    connection_id = connection_id or new_connection_id()
    return (
        f"wss://{WSS_HOST}{WSS_BASE_PATH}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}"
        f"&ConnectionId={connection_id}"
        f"&Sec-MS-GEC={generate_sec_ms_gec(clock_skew_seconds=clock_skew_seconds)}"
        f"&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}"
    )


def web_socket_headers():
    return {
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
        "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent": USER_AGENT,
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": f"muid={uuid.uuid4().hex.upper()};",
    }


def validate_request(text, voice, rate):
    """Mirrors EdgeTtsProtocol.validate; returns the normalized triple."""
    text = text.strip() if isinstance(text, str) else ""
    if not text:
        raise EdgeTtsError(CODE_EMPTY_TEXT, "Text is empty")
    if len(text) > MAX_TEXT_LENGTH:
        raise EdgeTtsError(CODE_TEXT_TOO_LONG, "Text exceeds maximum length")

    voice = normalize_voice(voice)
    validate_rate(rate)
    return text, voice, rate


def normalize_voice(voice):
    voice = (voice or "").strip()
    if not voice:
        raise EdgeTtsError(CODE_INVALID_VOICE, "voice is required")
    if FULL_VOICE_RE.match(voice):
        return voice
    match = SHORT_VOICE_RE.fullmatch(voice)
    if not match:
        raise EdgeTtsError(CODE_INVALID_VOICE, f"Invalid voice '{voice}'")
    lang, region, name = match.group(1), match.group(2), match.group(3)
    dash = name.find("-")
    if dash != -1:
        region = f"{region}-{name[:dash]}"
        name = name[dash + 1 :]
    return f"Microsoft Server Speech Text to Speech Voice ({lang}-{region}, {name})"


def validate_rate(rate):
    rate = rate or ""
    if not RATE_RE.fullmatch(rate):
        raise EdgeTtsError(CODE_INVALID_RATE, "rate must be an edge-tts SSML rate like '+0%' or '-50%'")
    numeric = int(rate[:-1])
    if numeric < MIN_RATE_PERCENT or numeric > MAX_RATE_PERCENT:
        raise EdgeTtsError(
            CODE_INVALID_RATE,
            f"rate must be between {MIN_RATE_PERCENT}% and {MAX_RATE_PERCENT}%",
        )


def speech_config_message():
    return (
        "X-Timestamp:2026-01-01T00:00:00.000Z\r\n"
        "Content-Type:application/json; charset=utf-8\r\n"
        "Path:speech.config\r\n\r\n"
        '{"context":{"synthesis":{"audio":{"metadataoptions":{'
        '"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"'
        '},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
    )


def _timestamp():
    return time.strftime("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)", time.gmtime())


def ssml_message(text, voice, rate, request_id=None):
    request_id = request_id or new_connection_id()
    return (
        f"X-RequestId:{request_id}\r\n"
        "Content-Type:application/ssml+xml\r\n"
        f"X-Timestamp:{_timestamp()}Z\r\n"
        "Path:ssml\r\n\r\n"
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>"
        f"<voice name='{voice}'>"
        f"<prosody pitch='+0Hz' rate='{rate}' volume='+0%'>"
        f"{escape_for_ssml(remove_incompatible_characters(text))}"
        "</prosody>"
        "</voice>"
        "</speak>"
    )


def remove_incompatible_characters(text):
    out = []
    for ch in text:
        code = ord(ch)
        out.append(" " if (code <= 8 or 11 <= code <= 12 or 14 <= code <= 31) else ch)
    return "".join(out)


def escape_for_ssml(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def parse_headers(header_bytes):
    headers = {}
    header_text = header_bytes.decode("utf-8", "replace")
    for line in header_text.split("\r\n"):
        if not line:
            continue
        separator = line.find(":")
        if separator <= 0:
            raise EdgeTtsError(CODE_UPSTREAM_UNAVAILABLE, "TTS upstream returned malformed frame headers")
        headers[line[:separator]] = line[separator + 1 :]
    return headers


def path_from_text_frame(text):
    header_text = text.split("\r\n\r\n", 1)[0]
    return parse_headers(header_text.encode("utf-8")).get("Path")


def audio_from_binary_frame(frame):
    """Extracts the MP3 payload of one Edge binary frame. Mirrors
    EdgeTtsProtocol.audioFromBinaryFrame, including the terminal-frame rule
    (a frame without Content-Type whose payload is empty signals turn end)."""
    if len(frame) < 2:
        raise EdgeTtsError(CODE_UPSTREAM_UNAVAILABLE, "TTS upstream returned an invalid audio frame")
    header_length = (frame[0] << 8) | frame[1]
    header_end = 2 + header_length
    if header_end > len(frame):
        raise EdgeTtsError(CODE_UPSTREAM_UNAVAILABLE, "TTS upstream returned an invalid audio frame")
    headers = parse_headers(frame[2:header_end])
    if headers.get("Path") != "audio":
        raise EdgeTtsError(CODE_UPSTREAM_UNAVAILABLE, "TTS upstream returned a non-audio frame")
    data = frame[header_end:]
    content_type = headers.get("Content-Type")
    if content_type is None:
        if not data:
            return None
        raise EdgeTtsError(CODE_UPSTREAM_UNAVAILABLE, "TTS upstream returned an invalid terminal frame")
    if content_type != "audio/mpeg":
        raise EdgeTtsError(CODE_UPSTREAM_UNAVAILABLE, "TTS upstream returned unsupported audio content")
    if not data:
        raise EdgeTtsError(CODE_UPSTREAM_UNAVAILABLE, "TTS upstream returned an empty audio frame")
    return data


# --------------------------------------------------------------------------
# Minimal RFC 6455 client (masked frames, ping/pong, fragmentation)
# --------------------------------------------------------------------------

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class WebSocketError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class WebSocket:
    def __init__(self, sock):
        self.sock = sock
        self.buffer = b""

    @classmethod
    def connect(cls, host, port, path, headers, timeout=30, sock=None, server_date_cb=None):
        """Performs the HTTP/1.1 upgrade handshake over a socket.

        sock: pre-connected socket (tests inject a socketpair end). When
        None, a TLS connection to host:port is established. server_date_cb
        receives the response Date header for clock-skew adjustment.
        """
        if sock is None:
            raw = socket.create_connection((host, port), timeout=timeout)
            context = ssl.create_default_context()
            sock = context.wrap_socket(raw, server_hostname=host)
        sock.settimeout(timeout)

        key = base64.b64encode(os.urandom(16)).decode()
        host_header = host if port in (80, 443) else f"{host}:{port}"
        request_lines = [f"GET {path} HTTP/1.1", f"Host: {host_header}"]
        request_lines += [f"{name}: {value}" for name, value in headers.items()]
        request_lines += [
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
            "",
            "",
        ]
        sock.sendall("\r\n".join(request_lines).encode("utf-8"))

        response = b""
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                raise WebSocketError(0, "Connection closed during handshake")
            response += chunk
            if len(response) > 65536:
                raise WebSocketError(0, "Handshake response too large")

        head, _, _ = response.partition(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        status_line = lines[0]
        status_match = re.match(r"HTTP/\d\.\d (\d{3})", status_line)
        if not status_match:
            raise WebSocketError(0, f"Malformed handshake response: {status_line!r}")
        status = int(status_match.group(1))
        if status != 101:
            if status == 403:
                server_date = None
                for line in lines[1:]:
                    if line.lower().startswith("date:"):
                        server_date = line.split(":", 1)[1].strip()
                        break
                raise UpstreamRejected(server_date=server_date)
            raise WebSocketError(status, f"Handshake failed with status {status}")

        headers_seen = {}
        for line in lines[1:]:
            name, _, value = line.partition(":")
            headers_seen[name.lower()] = value.strip()
        if server_date_cb is not None:
            server_date_cb(headers_seen.get("date"))

        expected_accept = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
        ).decode()
        if headers_seen.get("sec-websocket-accept") != expected_accept:
            raise WebSocketError(0, "Sec-WebSocket-Accept mismatch")

        return cls(sock)

    def send_text(self, payload):
        self._send_frame(OP_TEXT, payload.encode("utf-8"))

    def send_binary(self, payload):
        self._send_frame(OP_BINARY, payload)

    def _send_frame(self, opcode, payload):
        mask = os.urandom(4)
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + mask + masked)

    def _read_exact(self, n):
        while len(self.buffer) < n:
            chunk = self.sock.recv(max(4096, n - len(self.buffer)))
            if not chunk:
                raise WebSocketError(0, "Connection closed mid-frame")
            self.buffer += chunk
        data, self.buffer = self.buffer[:n], self.buffer[n:]
        return data

    def _recv_frame(self):
        b1, b2 = self._read_exact(2)
        fin = b1 & 0x80
        opcode = b1 & 0x0F
        masked = b2 & 0x80
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_exact(8))[0]
        mask = self._read_exact(4) if masked else None
        payload = self._read_exact(length)
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return fin, opcode, payload

    def recv_messages(self):
        """Yields (opcode, payload) for complete text/binary messages;
        handles ping/pong/continuation; returns (stops) on close."""
        while True:
            first_fin = None
            first_opcode = None
            data = b""
            while True:
                fin, opcode, payload = self._recv_frame()
                if opcode == OP_CLOSE:
                    return
                if opcode == OP_PING:
                    self._send_frame(OP_PONG, payload)
                    continue
                if opcode == OP_PONG:
                    continue
                if first_opcode is None:
                    first_opcode = opcode
                data += payload
                if fin:
                    break
            yield first_opcode, data

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# --------------------------------------------------------------------------
# Synthesis orchestration
# --------------------------------------------------------------------------


class EdgeTtsSynthesizer:
    """Synthesizes MP3 bytes for one request with the Android retry policy:

    - client-side validation errors propagate (400s)
    - one retry on upstream_unavailable / upstream_timeout
    - on a 403 handshake rejection, adjust the clock skew from the server's
      Date header and retry once (mirrors synthesizeWithClockSkewRetry)
    """

    def __init__(self, open_connection=None, timeout=30):
        self.open_connection = open_connection or self._default_open_connection
        self.timeout = timeout
        self.clock_skew_seconds = 0

    def _default_open_connection(self, url, headers):
        # The GET request target must be path-only (absolute-form request
        # targets are rejected with 400 by the upstream).
        parsed = urllib.parse.urlsplit(url)
        path = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        return WebSocket.connect(
            WSS_HOST,
            WSS_PORT,
            path,
            headers,
            timeout=self.timeout,
            server_date_cb=self._note_server_date,
        )

    def _note_server_date(self, server_date):
        # Clock skew correction is triggered by the caller on 403; the Date
        # header is captured during the handshake before the error surfaces.
        self._last_server_date = server_date

    def speak(self, text, voice, rate):
        """Validates and synthesizes; returns MP3 bytes. Raises EdgeTtsError
        with the shared error codes."""
        text, voice, rate = validate_request(text, voice, rate)
        try:
            return self._synthesize_once(voice, rate, text)
        except UpstreamRejected as rejected:
            self._adjust_clock_skew(rejected.server_date)
            return self._synthesize_once(voice, rate, text)
        except EdgeTtsError as error:
            if error.code in (CODE_UPSTREAM_UNAVAILABLE, CODE_UPSTREAM_TIMEOUT):
                return self._synthesize_once(voice, rate, text)
            raise

    def _adjust_clock_skew(self, server_date):
        # RFC 1123 dates are timezone-aware; parsedate_to_datetime yields UTC
        # regardless of the host locale/timezone (unlike strptime + mktime).
        if not server_date:
            return
        try:
            server_epoch = email.utils.parsedate_to_datetime(server_date).timestamp()
        except (TypeError, ValueError):
            return
        self.clock_skew_seconds = int(server_epoch - time.time())

    def _synthesize_once(self, voice, rate, text):
        url = build_ws_url(clock_skew_seconds=self.clock_skew_seconds)
        connection = self.open_connection(url, web_socket_headers())
        audio = bytearray()
        try:
            connection.send_text(speech_config_message())
            connection.send_text(ssml_message(text, voice, rate))
            for opcode, payload in connection.recv_messages():
                if opcode == OP_TEXT:
                    path = path_from_text_frame(payload.decode("utf-8", "replace"))
                    if path == "turn.end":
                        break
                    if path in ("audio.metadata", "response", "turn.start"):
                        continue
                    raise EdgeTtsError(
                        CODE_UPSTREAM_UNAVAILABLE,
                        "TTS upstream returned an unknown response",
                    )
                elif opcode == OP_BINARY:
                    chunk = audio_from_binary_frame(payload)
                    if chunk:
                        audio.extend(chunk)
        except (EdgeTtsError, WebSocketError, OSError, ssl.SSLError, socket.timeout) as error:
            raise _to_tts_error(error)
        finally:
            connection.close()

        if not audio:
            raise EdgeTtsError(CODE_UPSTREAM_UNAVAILABLE, "TTS upstream returned no audio")
        return bytes(audio)


def _to_tts_error(error):
    if isinstance(error, EdgeTtsError):
        return error
    if isinstance(error, UpstreamRejected):
        return error
    if isinstance(error, WebSocketError):
        if error.status == 403:
            return UpstreamRejected()
        return EdgeTtsError(CODE_UPSTREAM_UNAVAILABLE, f"TTS upstream failed: {error}")
    if isinstance(error, socket.timeout):
        return EdgeTtsError(CODE_UPSTREAM_TIMEOUT, "TTS generation timed out")
    if isinstance(error, OSError):
        return EdgeTtsError(CODE_NETWORK_FAILURE, f"Network request failed: {error}")
    return EdgeTtsError(CODE_UPSTREAM_UNAVAILABLE, f"TTS upstream failed: {error}")
