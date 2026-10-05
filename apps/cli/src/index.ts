import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { parseServerFrame, PROTOCOL_VERSION, type ClientFrame } from '@smith/protocol';
import WebSocket from 'ws';

import { executeDeviceTool, type DeviceToolResult } from './device-tools.js';
import { fetchWsTicket } from './ticket.js';

/**
 * Smith terminal istemcisi (dilim surumu): tek atimlik soru sor, akan
 * cevabi stdout'a yaz, temiz cik.
 *
 * Kullanim:
 *   SMITH_TOKEN=<TOKEN> smith-cli --url ws://127.0.0.1:4100 "soru"
 *
 * Kimlik: JWT `Authorization` basligiyla bir kerelik WebSocket bileti alir
 * (`POST /v1/ws/ticket`); WebSocket URL'ine yalniz bilet girer. `--token` hala
 * kabul edilir ama komut satiri `ps` ciktisinda gorunur: `SMITH_TOKEN` onerilir.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = arg('url') ?? 'ws://127.0.0.1:4100';
const token = arg('token') ?? process.env.SMITH_TOKEN;
const promptText = process.argv
  .filter((a) => !a.startsWith('--'))
  .slice(2)
  .pop();

if (!token || !promptText) {
  console.error('Kullanim: SMITH_TOKEN=<token> smith-cli --url <ws-url> "soru"');
  process.exit(2);
}

const newMsgId = (): string => `msg_${randomUUID().replace(/-/g, '')}`;

// JWT URL'e (erisim gunlugu, proxy kaydi) ve WS el sikismasina girmez: kisa omurlu bilet.
const ticket = await fetchWsTicket({ wsUrl: url, token }).catch((error: unknown) => {
  console.error(`[cli] ${error instanceof Error ? error.message : 'bilet alinamadi'}`);
  return process.exit(1);
});
const ws = new WebSocket(`${url}/v1/ws?ticket=${encodeURIComponent(ticket)}`);
const send = (frame: ClientFrame): void => ws.send(JSON.stringify(frame));

const timeout = setTimeout(() => {
  console.error('\n[cli] zaman asimi (120s)');
  process.exit(1);
}, 120_000);

ws.on('open', () => {
  send({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    surface: 'cli',
    clientVersion: '0.0.0',
  });
});

ws.on('message', (raw: Buffer) => {
  const frame = parseServerFrame(JSON.parse(raw.toString('utf8')));

  switch (frame.type) {
    case 'ready':
      send({
        type: 'prompt',
        sessionId: frame.sessionId,
        messageId: newMsgId(),
        content: [{ kind: 'text', text: promptText }],
      });
      return;
    case 'delta':
      process.stdout.write(frame.text);
      return;
    case 'usage':
      process.stderr.write(`\n[usage] in=${frame.inputTokens} out=${frame.outputTokens}\n`);
      return;
    case 'done':
      clearTimeout(timeout);
      process.stdout.write('\n');
      ws.close();
      process.exit(frame.stopReason === 'end_turn' ? 0 : 1);
      return;
    case 'error':
      clearTimeout(timeout);
      console.error(`\n[hata:${frame.code}] ${frame.message}`);
      ws.close();
      process.exit(1);
      return;
    case 'tool_call': {
      // Device-locus arac: YEREL calistir, tool_result don. Hata CLI'yi
      // cokertmez → ok:false doner, model turu devam eder.
      let out: DeviceToolResult;
      try {
        out = executeDeviceTool(frame.name, frame.input);
      } catch (error) {
        out = {
          ok: false,
          result: { error: error instanceof Error ? error.message : String(error) },
        };
      }
      send({
        type: 'tool_result',
        sessionId: frame.sessionId,
        toolCallId: frame.toolCallId,
        ok: out.ok,
        result: out.result,
      });
      return;
    }
    case 'pong':
      return;
  }
});

ws.on('error', (error) => {
  clearTimeout(timeout);
  console.error('[cli] baglanti hatasi:', error.message);
  process.exit(1);
});
