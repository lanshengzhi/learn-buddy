// Local echo server: captures the exact HTTP Upgrade request a spec-compliant
// WebSocket (undici) sends, so we can see what a browser-like handshake contains.
const http = require('http');
const crypto = require('crypto');

const server = http.createServer((req, res) => {
  const upgrade = req.headers.upgrade || '';
  if (upgrade.toLowerCase() !== 'websocket') {
    res.writeHead(400); res.end('not a ws upgrade'); return;
  }
  console.log('=== HANDSHAKE REQUEST ===');
  console.log(req.method, req.url);
  for (const [k, v] of Object.entries(req.headers)) {
    console.log(`${k}: ${v}`);
  }
  console.log('==========================');
  const accept = crypto
    .createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  res.writeHead(101, {
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Accept': accept,
  });
  res.end();
});

server.listen(18789, '127.0.0.1', () => {
  console.log('echo ws server on 127.0.0.1:18789');
  const ws = new WebSocket('ws://127.0.0.1:18789/echo?TrustedClientToken=x&Sec-MS-GEC=y');
  ws.addEventListener('open', () => { console.log('client open'); setTimeout(() => { ws.close(); server.close(); }, 100); });
  ws.addEventListener('error', (e) => console.log('client error', e.message));
});
