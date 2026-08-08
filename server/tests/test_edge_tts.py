import socket
import threading
import time
import unittest

from edge_tts import (
    EdgeTtsError,
    EdgeTtsSynthesizer,
    OP_BINARY,
    OP_TEXT,
    UpstreamRejected,
    WebSocket,
    WebSocketError,
    audio_from_binary_frame,
    build_ws_url,
    escape_for_ssml,
    generate_sec_ms_gec,
    normalize_voice,
    path_from_text_frame,
    remove_incompatible_characters,
    ssml_message,
    validate_rate,
    validate_request,
    web_socket_headers,
)

SEC_MS_GEC_VECTOR_1750000000 = "81C8AA79A860738D7C6C28578D367A9D88EC6A4F4D98C9FD9F5BC32C4B94CB91"
SEC_MS_GEC_VECTOR_1750000300 = "1DBD56CD1F69288037C4F3C52864598EED75CDC18E58080D7DC1A4512107D38D"


class TestSecMsGec(unittest.TestCase):
    def test_known_vector(self):
        self.assertEqual(generate_sec_ms_gec(1750000000), SEC_MS_GEC_VECTOR_1750000000)

    def test_rounds_down_to_300_second_windows(self):
        # Instants inside the same 300s window produce the same token.
        # Window N covers [N*300, (N+1)*300): 1750000200..1750000499.
        self.assertEqual(
            generate_sec_ms_gec(1750000300), generate_sec_ms_gec(1750000499)
        )
        self.assertNotEqual(
            generate_sec_ms_gec(1750000000), generate_sec_ms_gec(1750000300)
        )

    def test_clock_skew_shifts_the_window(self):
        self.assertEqual(
            generate_sec_ms_gec(1750000000, clock_skew_seconds=300),
            generate_sec_ms_gec(1750000300),
        )

    def test_ws_url_carries_all_tokens_in_query_string(self):
        url = build_ws_url(connection_id="abcd" * 8, clock_skew_seconds=0)
        self.assertIn("wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?", url)
        self.assertIn("TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4", url)
        self.assertIn("ConnectionId=abcd" + "abcd" * 7, url)
        self.assertIn("Sec-MS-GEC-Version=1-143.0.3650.75", url)
        self.assertIn("Sec-MS-GEC=", url)


class TestValidation(unittest.TestCase):
    def test_empty_text(self):
        with self.assertRaises(EdgeTtsError) as ctx:
            validate_request("   ", "en-US-AriaNeural", "+0%")
        self.assertEqual(ctx.exception.code, "empty_text")

    def test_text_too_long(self):
        with self.assertRaises(EdgeTtsError) as ctx:
            validate_request("x" * 501, "en-US-AriaNeural", "+0%")
        self.assertEqual(ctx.exception.code, "text_too_long")

    def test_exactly_500_is_accepted(self):
        text, _, _ = validate_request("x" * 500, "en-US-AriaNeural", "+0%")
        self.assertEqual(len(text), 500)

    def test_invalid_voice(self):
        with self.assertRaises(EdgeTtsError) as ctx:
            validate_request("hi", "", "+0%")
        self.assertEqual(ctx.exception.code, "invalid_voice")
        with self.assertRaises(EdgeTtsError) as ctx:
            validate_request("hi", "not-a-voice", "+0%")
        self.assertEqual(ctx.exception.code, "invalid_voice")

    def test_voice_normalization_to_full_form(self):
        self.assertEqual(
            normalize_voice("en-US-AriaNeural"),
            "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)",
        )
        # Voice names containing an extra dash keep the region part (Android parity).
        self.assertEqual(
            normalize_voice("zh-CN-XiaoxiaoNeural"),
            "Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)",
        )
        # Full form passes through unchanged.
        full = "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)"
        self.assertEqual(normalize_voice(full), full)

    def test_invalid_rate(self):
        for bad in ("0%", "+0", "fast", "+101%", "-91%", "+100.5%"):
            with self.assertRaises(EdgeTtsError) as ctx:
                validate_request("hi", "en-US-AriaNeural", bad)
            self.assertEqual(ctx.exception.code, "invalid_rate", bad)
        for good in ("-90%", "+100%", "-50%", "+0%"):
            validate_request("hi", "en-US-AriaNeural", good)  # no raise


class TestSsml(unittest.TestCase):
    def test_escapes_xml_and_strips_control_chars(self):
        msg = ssml_message("A&B <C> \"D\"\x01\x0f\n", "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)", "+0%", request_id="rid")
        self.assertIn("A&amp;B &lt;C&gt;", msg)
        self.assertNotIn("\x01", msg)
        self.assertNotIn("\x0f", msg)
        self.assertIn("Path:ssml", msg)
        self.assertIn("rate='+0%'", msg)
        self.assertIn("X-RequestId:rid", msg)
        self.assertIn("name='Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)'", msg)

    def test_remove_incompatible_characters_maps_to_space(self):
        self.assertEqual(remove_incompatible_characters("a\x01b\x7fc"), "a b\x7fc")


class TestBinaryFrame(unittest.TestCase):
    def _frame(self, headers_text, payload=b""):
        header = headers_text.encode()
        length = len(header).to_bytes(2, "big")
        return length + header + payload

    def test_extracts_audio_payload(self):
        frame = self._frame("Path:audio\r\nContent-Type:audio/mpeg\r\n\r\n", b"\xff\xf3MP3DATA")
        self.assertEqual(audio_from_binary_frame(frame), b"\xff\xf3MP3DATA")

    def test_terminal_frame_returns_none(self):
        frame = self._frame("Path:audio\r\n\r\n")
        self.assertIsNone(audio_from_binary_frame(frame))

    def test_non_audio_path_raises(self):
        frame = self._frame("Path:response\r\n\r\n", b"x")
        with self.assertRaises(EdgeTtsError):
            audio_from_binary_frame(frame)

    def test_wrong_content_type_raises(self):
        frame = self._frame("Path:audio\r\nContent-Type:application/json\r\n\r\n", b"{}")
        with self.assertRaises(EdgeTtsError):
            audio_from_binary_frame(frame)

    def test_truncated_header_raises(self):
        with self.assertRaises(EdgeTtsError):
            audio_from_binary_frame(b"\x00\x10x")

    def test_text_frame_path(self):
        self.assertEqual(path_from_text_frame("X-RequestId:r\r\nPath:turn.end\r\n\r\n{}"), "turn.end")


# --------------------------------------------------------------------------
# WebSocket codec tests over a socketpair echo server
# --------------------------------------------------------------------------


class WsEchoServer(threading.Thread):
    """One-shot server-side of a WebSocket connection: validates the upgrade
    handshake, then echoes every client text message back (unmasked), and
    answers a final 'close' marker by closing."""

    def __init__(self, sock, respond_403=False, server_date=None):
        super().__init__(daemon=True)
        self.sock = sock
        self.respond_403 = respond_403
        self.server_date = server_date
        self.received = []
        self.error = None

    def run(self):
        try:
            request = b""
            while b"\r\n\r\n" not in request:
                chunk = self.sock.recv(4096)
                if not chunk:
                    return
                request += chunk
            head = request.split(b"\r\n\r\n", 1)[0].decode("latin-1")
            self.received.append(head)
            if self.respond_403:
                date_header = f"Date: {self.server_date}\r\n" if self.server_date else ""
                self.sock.sendall(
                    f"HTTP/1.1 403 Forbidden\r\n{date_header}Content-Length: 0\r\n\r\n".encode()
                )
                return
            # Accept the upgrade (accept key must match; client validates).
            import base64, hashlib
            key_line = next((l for l in head.split("\r\n") if l.lower().startswith("sec-websocket-key:")), "")
            key = key_line.split(":", 1)[1].strip()
            accept = base64.b64encode(
                hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
            ).decode()
            self.sock.sendall(
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n"
                f"Date: {self.server_date or 'Tue, 04 Aug 2026 00:00:00 GMT'}\r\n"
                "\r\n".encode()
            )
            # Read client frames (masked) and echo text frames unmasked.
            while True:
                frame = self._read_frame()
                if frame is None:
                    return
                opcode, payload = frame
                self.received.append((opcode, payload))
                if opcode == 0x8:  # close
                    self._send_frame(0x8, b"")
                    return
                if opcode == 0x9:  # ping
                    self._send_frame(0xA, payload)
                    continue
                self._send_frame(opcode, payload)
        except Exception as exc:  # noqa: BLE001 - test server
            self.error = exc

    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("closed")
            buf += chunk
        return buf

    def _read_frame(self):
        header = self._read_exact(2)
        fin, opcode = header[0] & 0x80, header[0] & 0x0F
        masked = header[1] & 0x80
        length = header[1] & 0x7F
        if length == 126:
            length = int.from_bytes(self._read_exact(2), "big")
        elif length == 127:
            length = int.from_bytes(self._read_exact(8), "big")
        mask = self._read_exact(4) if masked else b""
        payload = self._read_exact(length)
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload

    def _send_frame(self, opcode, payload):
        header = bytes([0x80 | opcode, len(payload)])
        self.sock.sendall(header + payload)


def socketpair_with_server(respond_403=False, server_date=None):
    client, server = socket.socketpair()
    echo = WsEchoServer(server, respond_403=respond_403, server_date=server_date)
    echo.start()
    return client, echo


class TestWebSocketCodec(unittest.TestCase):
    def test_handshake_and_masked_echo_roundtrip(self):
        client, echo = socketpair_with_server()
        try:
            ws = WebSocket.connect("example.test", 443, "/ws", {"User-Agent": "Edg/143"}, sock=client)
            ws.send_text("hello")
            ws.send_text("世界")
            opcodes = []
            messages = []
            for opcode, payload in ws.recv_messages():
                opcodes.append(opcode)
                messages.append(payload.decode("utf-8"))
                if messages[-1] == "世界":
                    break
            self.assertEqual(opcodes, [OP_TEXT, OP_TEXT])
            self.assertEqual(messages, ["hello", "世界"])
            # The server saw masked client frames with the right opcodes.
            self.assertEqual([m[0] for m in echo.received[1:]], [OP_TEXT, OP_TEXT])
            # Client UA header arrived verbatim.
            self.assertIn("User-Agent: Edg/143", echo.received[0])
        finally:
            ws.close()

    def test_ping_is_answered_with_pong(self):
        client, echo = socketpair_with_server()
        try:
            ws = WebSocket.connect("example.test", 443, "/ws", {}, sock=client)
            echo._send_frame(0x9, b"pingdata")
            # The next client message still works; the ping was absorbed.
            ws.send_text("after-ping")
            for opcode, payload in ws.recv_messages():
                self.assertEqual(opcode, OP_TEXT)
                self.assertEqual(payload, b"after-ping")
                break
        finally:
            ws.close()
        # The pong arrives on the wire slightly after the echo; poll briefly.
        deadline = time.time() + 1
        while not any(m[0] == 0xA and m[1] == b"pingdata" for m in echo.received[1:]):
            if time.time() > deadline:
                break
            time.sleep(0.01)
        self.assertTrue(any(m[0] == 0xA and m[1] == b"pingdata" for m in echo.received[1:]))

    def test_403_rejection_raises_upstream_rejected_with_server_date(self):
        client, echo = socketpair_with_server(
            respond_403=True, server_date="Wed, 05 Aug 2026 12:00:00 GMT"
        )
        try:
            with self.assertRaises(UpstreamRejected) as ctx:
                WebSocket.connect("example.test", 443, "/ws", {}, sock=client)
            self.assertEqual(ctx.exception.server_date, "Wed, 05 Aug 2026 12:00:00 GMT")
        finally:
            client.close()

    def test_accept_key_mismatch_rejected(self):
        client, server = socket.socketpair()
        thread = threading.Thread(
            target=lambda s: s.sendall(
                b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                b"Connection: Upgrade\r\nSec-WebSocket-Accept: WRONG\r\n\r\n"
            ),
            args=(server,),
            daemon=True,
        )
        thread.start()
        try:
            with self.assertRaises(WebSocketError):
                WebSocket.connect("example.test", 443, "/ws", {}, sock=client)
        finally:
            client.close()


class FakeConnection:
    """Test stand-in: streams two binary audio frames then turn.end."""

    def __init__(self, audio_bytes=b"\xff\xf3MP3"):
        self.audio_bytes = audio_bytes
        self.sent = []
        self._messages = iter([
            (OP_BINARY, _audio_frame(audio_bytes[:3])),
            (OP_BINARY, _audio_frame(audio_bytes[3:])),
            (OP_TEXT, b"X-RequestId:r\r\nPath:turn.end\r\n\r\n{}"),
        ])

    def send_text(self, payload):
        self.sent.append(payload)

    def recv_messages(self):
        return self._messages

    def close(self):
        pass


class TestSynthesizerRetry(unittest.TestCase):
    def test_retries_once_on_upstream_unavailable(self):
        calls = []
        attempts = []

        def fake_open(url, headers):
            attempts.append(1)
            if len(attempts) == 1:
                raise EdgeTtsError("upstream_unavailable", "boom")
            return FakeConnection(b"\xff\xf3MP3")

        synth = EdgeTtsSynthesizer(open_connection=fake_open)
        self.assertEqual(synth.speak("hi", "en-US-AriaNeural", "+0%"), b"\xff\xf3MP3")
        self.assertEqual(len(attempts), 2)
        self.assertEqual(calls, [])

    def test_gives_up_after_two_failures(self):
        attempts = []

        def fake_open(url, headers):
            attempts.append(1)
            raise EdgeTtsError("upstream_unavailable", "boom")

        synth = EdgeTtsSynthesizer(open_connection=fake_open)
        with self.assertRaises(EdgeTtsError) as ctx:
            synth.speak("hi", "en-US-AriaNeural", "+0%")
        self.assertEqual(ctx.exception.code, "upstream_unavailable")
        self.assertEqual(len(attempts), 2)

    def test_validation_errors_are_not_retried(self):
        calls = []

        def fake_open(url, headers):
            calls.append(1)
            raise AssertionError("must not connect")

        synth = EdgeTtsSynthesizer(open_connection=fake_open)
        with self.assertRaises(EdgeTtsError) as ctx:
            synth.speak("", "en-US-AriaNeural", "+0%")
        self.assertEqual(ctx.exception.code, "empty_text")
        self.assertEqual(calls, [])

    def test_403_retries_once_after_clock_skew_adjustment(self):
        attempts = []

        def fake_open(url, headers):
            attempts.append(1)
            raise UpstreamRejected(server_date="Wed, 05 Aug 2026 12:00:00 GMT")

        synth = EdgeTtsSynthesizer(open_connection=fake_open)
        with self.assertRaises(UpstreamRejected):
            synth.speak("hi", "en-US-AriaNeural", "+0%")
        self.assertEqual(len(attempts), 2)
        self.assertNotEqual(synth.clock_skew_seconds, 0)

    def test_assembles_audio_from_binary_frames(self):
        conn = FakeConnection(b"AAABBB")
        synth = EdgeTtsSynthesizer(open_connection=lambda url, headers: conn)
        audio = synth.speak("hello", "en-US-AriaNeural", "+0%")
        self.assertEqual(audio, b"AAABBB")
        self.assertEqual(len(conn.sent), 2)  # speech.config + ssml


def _audio_frame(payload):
    header = b"Path:audio\r\nContent-Type:audio/mpeg\r\n\r\n"
    return len(header).to_bytes(2, "big") + header + payload

class TestConnectionPath(unittest.TestCase):
    def test_default_open_connection_passes_path_only_target(self):
        """Regression: absolute-form request targets (full wss:// URL) are
        rejected with 400 by the upstream; the GET target must be path-only."""
        import edge_tts as et_module

        captured = {}

        def spy(*args, **kwargs):
            captured["path"] = args[2]
            raise WebSocketError(0, "stop")

        original = et_module.WebSocket.connect
        et_module.WebSocket.connect = spy
        try:
            synth = et_module.EdgeTtsSynthesizer()
            with self.assertRaises(WebSocketError):
                synth._synthesize_once("Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)", "+0%", "hi")
        finally:
            et_module.WebSocket.connect = original

        self.assertFalse(captured["path"].startswith("wss://"), captured["path"])
        self.assertTrue(captured["path"].startswith("/consumer/"), captured["path"])
        self.assertIn("Sec-MS-GEC=", captured["path"])
        self.assertIn("Sec-MS-GEC-Version=1-143.0.3650.75", captured["path"])


if __name__ == "__main__":
    unittest.main()
