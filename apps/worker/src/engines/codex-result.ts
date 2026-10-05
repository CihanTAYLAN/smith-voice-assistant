import type { EngineRunResult } from './engine-result.js';

/**
 * CODEX CIKTISI AYRISTIRICI (`codex exec --json` → JSONL olay akisi).
 *
 * SOZLESME OLCULDU, TAHMIN EDILMEDI (codex-cli 0.153.4 ve 0.155.0, 2026-09-18):
 *
 *   {"type":"thread.started","thread_id":"01a0b1c0-..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
 *   {"type":"turn.completed","usage":{"input_tokens":23037,"cached_input_tokens":12416,
 *                                    "cache_write_input_tokens":0,"output_tokens":5,
 *                                    "reasoning_output_tokens":0}}
 *
 * Hata hali de olculdu:
 *   {"type":"error","message":"{...\"message\":\"...\"}"}
 *   {"type":"turn.failed","error":{"message":"{...}"}}
 *
 * UC OLGU BU DOSYANIN VAROLUS SEBEBI:
 *
 * 1. **Exit kodu yalan soyleyebilir.** Basarisiz turda (`turn.failed`) surec
 *    yine de 0 ile donuyor. Yalniz exit koduna bakan bir motor, yapilmamis isi
 *    "basarili kosu" diye panele yazardi — bu deponun yasak sinifi.
 * 2. **stderr gurultusu stdout'a karisabilir.** Codex, MCP sunucu hatalarini
 *    (`rmcp::transport::worker: ... AuthRequired`) JSONL akisinin ARASINA
 *    basiyor. Bu yuzden satir satir ayristirilir ve JSON olmayan satirlar
 *    sessizce ATLANIR; ama hicbir terminal olay yoksa kosu basarisizdir.
 * 3. **Hata mesaji JSON-icinde-JSON geliyor.** Yukaridaki `message` alani
 *    kacisli bir JSON dizesidir; ham haliyle thread'e yazilirsa kullanici
 *    okunamaz bir blok gorur. `unwrapMessage` insan-okunur kismi cikarir.
 */

interface CodexEvent {
  type: string;
  thread_id?: unknown;
  item?: unknown;
  usage?: unknown;
  message?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Tek satiri olaya cevirir; JSON olmayan (log gurultusu) satirlar icin null. */
function parseLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;
    // Alanlar TEK TEK tasinir; `as` ile tip zorlamak, sema degistiginde
    // derleyicinin uyarmasini engellerdi.
    return {
      type: parsed.type,
      thread_id: parsed.thread_id,
      item: parsed.item,
      usage: parsed.usage,
      message: parsed.message,
      error: parsed.error,
    };
  } catch {
    return null; // Kesilmis satir: olay sayilmaz.
  }
}

/**
 * Motorun hata metnini insan-okunur hale getirir. Codex hatayi kacisli JSON
 * dizesi olarak tasiyor; icindeki `error.message` asil sebeptir
 * ("... model is not supported when using Codex with a ChatGPT account.").
 */
export function unwrapMessage(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith('{')) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return text;
    const inner = isRecord(parsed.error) ? parsed.error : null;
    if (inner && typeof inner.message === 'string' && inner.message.trim()) {
      return inner.message.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
    return text;
  } catch {
    return text;
  }
}

function failureTextOf(event: CodexEvent): string | null {
  if (event.type === 'turn.failed' && isRecord(event.error)) {
    const message = event.error.message;
    if (typeof message === 'string' && message.trim()) return unwrapMessage(message);
  }
  if (event.type === 'error' && typeof event.message === 'string' && event.message.trim()) {
    return unwrapMessage(event.message);
  }
  return null;
}

/**
 * Surecin basarisi ve motorun raporu BIRLIKTE gecerli; biri digerini ortmez.
 */
export function parseCodexResult(input: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  timeoutSeconds: number;
  logPath: string;
}): EngineRunResult {
  const events: CodexEvent[] = [];
  for (const line of input.stdout.split(/\r?\n/)) {
    const event = parseLine(line);
    if (event) events.push(event);
  }

  const timedOut = input.timedOut || input.exitCode === 124;

  const base = {
    exitCode: input.exitCode,
    timedOut,
    logPath: input.logPath,
  };

  let sessionId: string | undefined;
  let text = '';
  let failure: string | null = null;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let completed = false;

  for (const event of events) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      sessionId = event.thread_id;
      continue;
    }
    if (event.type === 'item.completed' && isRecord(event.item)) {
      const item = event.item;
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
        // Son ajan mesaji nihai cevaptir; onceki turlarin ara mesajlari degil.
        text = item.text.trim();
      }
      continue;
    }
    if (event.type === 'turn.completed') {
      completed = true;
      if (isRecord(event.usage)) {
        if (nonNegativeNumber(event.usage.input_tokens)) {
          inputTokens = Math.trunc(event.usage.input_tokens);
        }
        if (nonNegativeNumber(event.usage.output_tokens)) {
          outputTokens = Math.trunc(event.usage.output_tokens);
        }
      }
      continue;
    }
    const failed = failureTextOf(event);
    if (failed) failure = failed;
  }

  if (timedOut) {
    return {
      ...base,
      ok: false,
      text: `Kosu ${input.timeoutSeconds} saniyede tamamlanmadi ve durduruldu.`,
    };
  }

  if (failure) {
    return { ...base, ok: false, text: `Codex hatasi: ${failure}` };
  }

  if (input.exitCode !== 0) {
    const reason = input.exitCode === null ? 'surec sinyalle durdu' : `exit ${input.exitCode}`;
    return { ...base, ok: false, text: `Motor basarisiz (${reason}).${text ? ` ${text}` : ''}` };
  }

  if (!completed || !text) {
    return {
      ...base,
      ok: false,
      text: 'Codex sonuc bildirmedi (tur tamamlanmadi veya bos cevap dondu).',
    };
  }

  return {
    ...base,
    ok: true,
    text,
    ...(sessionId ? { sessionId } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}
