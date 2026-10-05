import type { EngineRunResult } from './engine-result.js';

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // Claude bazen JSON'dan once uyari yazar; yalniz son TAM satir yedektir.
  for (const candidate of [trimmed, trimmed.split(/\r?\n/).at(-1) ?? '']) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      return record(parsed);
    } catch {
      // Kesilmis JSON onarilmaz: tam bir sonuc bulunamazsa kosu basarisizdir.
    }
  }
  return null;
}

/** stderr'den mesaja alinan en fazla karakter (tam cikti `engine.log`ta). */
const STDERR_EXCERPT_CHARS = 800;

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Surecin basarisi ve motorun raporu birlikte gecerlidir; biri digerini ortmez. */
export function parseClaudeCodeResult(input: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  timeoutSeconds: number;
  logPath: string;
}): EngineRunResult {
  const json = parseJson(input.stdout);
  const timedOut = input.timedOut || input.exitCode === 124;
  const message = typeof json?.result === 'string' ? json.result.trim() : '';
  // Motor mesaji yoksa neden yalniz stderr'dedir (`claude` yok: exit 127, `cd` koku yok: exit 1).
  const stderrExcerpt = input.stderr.trim().slice(0, STDERR_EXCERPT_CHARS);
  const base = {
    exitCode: input.exitCode,
    timedOut,
    logPath: input.logPath,
    ...(typeof json?.session_id === 'string' && json.session_id
      ? { sessionId: json.session_id }
      : {}),
  };
  if (timedOut) {
    return {
      ...base,
      ok: false,
      text: `Kosu ${input.timeoutSeconds} saniyede tamamlanmadi ve durduruldu.`,
    };
  }
  if (input.exitCode !== 0) {
    const reason = input.exitCode === null ? 'surec sinyalle durdu' : `exit ${input.exitCode}`;
    const detail = message || stderrExcerpt;
    return {
      ...base,
      ok: false,
      text: `Motor basarisiz (${reason}).${detail ? ` ${detail}` : ''}`,
    };
  }
  if (
    !json ||
    !message ||
    (json.is_error !== undefined && json.is_error !== false) ||
    (json.subtype !== undefined && json.subtype !== 'success')
  ) {
    return {
      ...base,
      ok: false,
      text: message || stderrExcerpt || 'Motor cikisi gecersiz veya bos.',
    };
  }
  const usage = record(json.usage);
  return {
    ...base,
    ok: true,
    text: message,
    ...(nonNegativeNumber(json.total_cost_usd)
      ? { costMicros: Math.round(json.total_cost_usd * 1_000_000) }
      : {}),
    ...(nonNegativeNumber(usage?.input_tokens) ? { inputTokens: usage.input_tokens } : {}),
    ...(nonNegativeNumber(usage?.output_tokens) ? { outputTokens: usage.output_tokens } : {}),
  };
}
