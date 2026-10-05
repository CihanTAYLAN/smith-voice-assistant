// Ham WS teshis istemcisi: her olayi ve frame'i oldugu gibi basar.
import WebSocket from 'ws';

const [url, token] = process.argv.slice(2);
const ws = new WebSocket(`${url}/v1/ws?token=${encodeURIComponent(token)}`);

ws.on('open', () => {
  console.log('[open]');
  ws.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      surface: 'cli',
      clientVersion: '0.0.0',
    }),
  );
  console.log('[hello gonderildi]');
});
ws.on('message', (d) => {
  const raw = d.toString('utf8');
  console.log('[message]', raw.slice(0, 200));
  const frame = JSON.parse(raw);
  if (frame.type === 'ready') {
    const msgId = 'msg_' + 'ab'.repeat(16);
    ws.send(
      JSON.stringify({
        type: 'prompt',
        sessionId: frame.sessionId,
        messageId: msgId,
        content: [{ kind: 'text', text: '2+2 kac? Kisa cevap ver.' }],
      }),
    );
    console.log('[prompt gonderildi]', msgId);
  }
});
ws.on('close', (code, reason) => {
  console.log('[close]', code, reason.toString('utf8'));
  process.exit(0);
});
ws.on('error', (e) => console.log('[error]', e.message));
ws.on('unexpected-response', (_req, res) => console.log('[unexpected-response]', res.statusCode));
setTimeout(() => {
  console.log('[timeout 45s]');
  process.exit(1);
}, 45_000);
