// Full end-to-end Edge TTS synthesis over a raw WebSocket client with custom headers.
// Proves the complete pipeline (handshake -> speech.config -> ssml -> audio frames -> MP3 file)
// that a relay on claw would implement. Node net+TLS, no dependencies.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');

const HOST = 'speech.platform.bing.com';
const PORT = 443;
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const SEC_MS_GEC_VERSION = '1-143.0.3650.75';
const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';

const secMsGec = () => {
  const now = Math.floor(Date.now() / 1000);
  const rounded = Math.floor(now / 300) * 300;
  const ticks = (rounded + 11644473600) * 10000000;
  return crypto.createHash('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
};
const connectId = () => crypto.randomUUID().replace(/-/g, '');
const ts = (z = false) => {
  const s = new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
  return z ? `${s}Z` : s;
};
const wssUrl = () =>
  `wss://${HOST}/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
  `&ConnectionId=${connectId()}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
const wssPath = () => wssUrl().slice(`wss://${HOST}`.length);

const speechConfigMsg = () =>
  `X-Timestamp:${ts()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
  '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n';

const ssmlMsg = () =>
  `X-RequestId:${connectId()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts(true)}\r\nPath:ssml\r\n\r\n` +
  "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
  "<voice name='en-US-AriaNeural'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>" +
  'Hello from the raw WebSocket test. This sentence should become audio.</prosody></voice></speak>';

// --- minimal WS framing ---
function makeFrame(payload, opcode) {
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.from(payload).map((b, i) => b ^ maskKey[i % 4]);
  let hdr = Buffer.from([0x80 | opcode]);
  const len = masked.length;
  if (len < 126) hdr = Buffer.concat([hdr, Buffer.from([0x80 | len])]);
  else if (len < 65536) hdr = Buffer.concat([hdr, Buffer.from([0x80 | 126, len >> 8, len & 0xff])]);
  else hdr = Buffer.concat([hdr, Buffer.from([0x80 | 127, 0, 0, 0, 0, (len / 0x100000000) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff])]);
  return Buffer.concat([hdr, maskKey, masked]);
}

let audio = [];
let binBuf = Buffer.alloc(0);
let opened = false;
let done = false;

const finish = (ok, why) => {
  if (done) return;
  done = true;
  console.log(ok ? `E2E SUCCESS: ${audio.length} audio frames, ${Buffer.concat(audio).length} bytes total` : `E2E FAILURE: ${why}`);
  if (ok) fs.writeFileSync('/tmp/edge-tts-e2e.mp3', Buffer.concat(audio));
  process.exit(ok ? 0 : 1);
};

const sock = tls.connect({ host: HOST, port: PORT, servername: HOST }, () => {
  const key = crypto.randomBytes(16).toString('base64');
  const req =
    `GET ${wssPath()} HTTP/1.1\r\n` + // strip wss:// prefix -> /consumer/...
    `Host: ${HOST}\r\n` +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    `Sec-WebSocket-Key: ${key}\r\n` +
    'Sec-WebSocket-Version: 13\r\n' +
    `User-Agent: ${EDGE_UA}\r\n` +
    'Origin: https://home-srv.tailf905b5.ts.net\r\n' +
    'Accept-Encoding: gzip, deflate, br, zstd\r\n' +
    'Accept-Language: en-US,en;q=0.9\r\n' +
    `Cookie: muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};\r\n` +
    '\r\n';
  sock.write(req);
});

let handshake = '';
sock.on('data', (chunk) => {
  if (!opened) {
    handshake += chunk.toString('binary');
    const idx = handshake.indexOf('\r\n\r\n');
    if (idx === -1) return;
    const head = handshake.slice(0, idx);
    if (!head.includes('101')) { console.log('HANDSHAKE REJECTED:\n' + head + '\nBODY:' + handshake.slice(idx + 4)); finish(false, 'handshake rejected'); return; }
    opened = true;
    console.log('HANDSHAKE OK (101). Sending speech.config + ssml');
    sock.write(makeFrame(speechConfigMsg(), 0x1));
    sock.write(makeFrame(ssmlMsg(), 0x1));
    const rest = Buffer.from(handshake.slice(idx + 4), 'binary');
    if (rest.length) processFrame(rest);
    return;
  }
  processFrame(chunk);
});

function processFrame(data) {
  binBuf = Buffer.concat([binBuf, data]);
  while (binBuf.length >= 2) {
    const fin = binBuf[0] & 0x80;
    const opcode = binBuf[0] & 0x0f;
    const masked = (binBuf[1] & 0x80) !== 0;
    let len = binBuf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (binBuf.length < 4) return; len = binBuf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (binBuf.length < 10) return; len = Number(binBuf.readBigUInt64BE(2)); off = 10; }
    let maskKey = null;
    if (masked) { if (binBuf.length < off + 4) return; maskKey = binBuf.subarray(off, off + 4); off += 4; }
    if (binBuf.length < off + len) return;
    let payload = binBuf.subarray(off, off + len);
    if (maskKey) payload = Buffer.from(payload.map((b, i) => b ^ maskKey[i % 4]));
    binBuf = binBuf.subarray(off + len);
    handleFrame(opcode, payload, fin);
  }
}

function handleFrame(opcode, payload) {
  if (opcode === 0x1) { // text
    const txt = payload.toString('utf8');
    const path = (txt.match(/^Path:(.*)$/m) || [])[1];
    console.log(`TEXT frame path=${path}`);
    if (path === 'turn.end') setTimeout(() => finish(audio.length > 0, 'no audio before turn.end'), 300);
    return;
  }
  if (opcode === 0x2) { // binary
    const hlen = (payload[0] << 8) | payload[1];
    const headers = payload.toString('utf8', 2, 2 + hlen);
    const path = (headers.match(/^Path:(.*)$/m) || [])[1];
    const data = payload.subarray(2 + hlen);
    if (path === 'audio' && data.length) {
      audio.push(data);
      console.log(`AUDIO frame +${data.length}B (path=audio)`);
    }
    return;
  }
  if (opcode === 0x8) { console.log('close frame'); }
}

sock.on('error', (e) => finish(false, `socket error: ${e.message}`));
sock.setTimeout(20000, () => finish(false, 'timeout'));
