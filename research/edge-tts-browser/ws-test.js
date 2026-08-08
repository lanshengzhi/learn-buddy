// Empirical test: can a spec-compliant (browser-like) WebSocket talk to Edge TTS directly?
// No custom handshake headers are possible via `new WebSocket()` — exactly the browser constraint.
// Node 26 global WebSocket is undici's WHATWG implementation.
const crypto = require('crypto');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const SEC_MS_GEC_VERSION = '1-143.0.3650.75';

function secMsGec(nowSec = Math.floor(Date.now() / 1000)) {
  const rounded = Math.floor(nowSec / 300) * 300; // round down to 5 min
  const ticks = (rounded + 11644473600) * 10000000; // Windows file time
  return crypto.createHash('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

function connectId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function timestamp(extraZ = false) {
  const d = new Date();
  const fmt = d.toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
  return extraZ ? `${fmt}Z` : fmt;
}

function wssUrl() {
  return (
    'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&ConnectionId=${connectId()}` +
    `&Sec-MS-GEC=${secMsGec()}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
  );
}

const speechConfig = (ts) =>
  `X-Timestamp:${ts}\r\n` +
  'Content-Type:application/json; charset=utf-8\r\n' +
  'Path:speech.config\r\n\r\n' +
  '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n';

const ssml = (reqId, ts) =>
  `X-RequestId:${reqId}\r\n` +
  'Content-Type:application/ssml+xml\r\n' +
  `X-Timestamp:${ts}Z\r\n` +
  'Path:ssml\r\n\r\n' +
  "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
  "<voice name='en-US-AriaNeural'>" +
  "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>" +
  'Hello world. This is a direct Edge TTS browser test.' +
  '</prosody></voice></speak>';

function parseBinaryFrame(buf) {
  const headerLen = (buf[0] << 8) | buf[1];
  const headers = buf.toString('utf8', 2, 2 + headerLen);
  const data = buf.subarray(2 + headerLen);
  const pathMatch = headers.match(/^Path:(.*)$/m);
  return { path: pathMatch ? pathMatch[1].trim() : null, headers, data };
}

async function run() {
  const url = wssUrl();
  console.log('URL:', url);
  const ws = new WebSocket(url);

  const audioChunks = [];
  let turnStart = false;
  let timeoutId;

  const done = (ok, reason) => {
    clearTimeout(timeoutId);
    try { ws.close(); } catch {}
    if (ok) {
      console.log(`RESULT: SUCCESS (${audioChunks.length} audio frames, ${audioChunks.reduce((a, c) => a + c.length, 0)} bytes)`);
      require('fs').writeFileSync('/tmp/edge-tts-browser-test.mp3', Buffer.concat(audioChunks));
    } else {
      console.log(`RESULT: FAILURE — ${reason}`);
    }
    process.exit(ok ? 0 : 1);
  };

  timeoutId = setTimeout(() => done(false, 'timeout after 20s'), 20000);

  ws.addEventListener('open', () => {
    console.log('OPEN: connection accepted, readyState =', ws.readyState);
    ws.send(speechConfig(timestamp()));
    ws.send(ssml(connectId(), timestamp()));
    console.log('SENT speech.config + ssml');
  });

  ws.addEventListener('message', (ev) => {
    const data = ev.data;
    if (typeof data === 'string') {
      const path = (data.match(/^Path:(.*)$/m) || [])[1];
      console.log(`TEXT FRAME: path=${path}`);
      if (path === 'turn.start') turnStart = true;
      if (path === 'response' || path === 'turn.end') {
        setTimeout(() => done(turnStart && audioChunks.length > 0, turnStart && audioChunks.length > 0 ? 'turn.end reached with audio' : 'no audio before end'), 500);
      }
      return;
    }
    // binary frame
    try {
      const parsed = parseBinaryFrame(Buffer.from(data));
      if (parsed.path === 'audio') {
        audioChunks.push(parsed.data);
        console.log(`AUDIO FRAME: +${parsed.data.length} bytes (content-type header present: ${parsed.headers.includes('audio/mpeg')})`);
      } else if (parsed.path) {
        console.log(`BINARY FRAME: path=${parsed.path}`);
      }
    } catch (e) {
      console.log('parse error:', e.message);
    }
  });

  ws.addEventListener('error', (ev) => {
    console.log('WS ERROR event:', ev.message || ev.type);
    done(false, 'websocket error event');
  });

  ws.addEventListener('close', (ev) => {
    console.log(`CLOSE: code=${ev.code} reason=${ev.reason || '(none)'}`);
    if (audioChunks.length === 0) done(false, `closed early code=${ev.code}`);
  });
}

run();
