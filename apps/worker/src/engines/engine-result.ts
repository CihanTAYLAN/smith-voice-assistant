/**
 * MOTOR SOZLESMESI — iki motor (claude-code, codex) ayni girdiyi alir, ayni
 * sonucu dondurur.
 *
 * NEDEN PAYLASILAN DOSYA: cagiran taraf (`consumers/agent-run.ts`) hangi
 * motorun kostugunu bilmek zorunda kalmasin (ADR 0007: "cagiran degismez").
 * Ikinci motor gelmeden bu dosya yoktu; tipi tek motorun dosyasinda tutmak
 * artik yanlis ev olurdu.
 *
 * `EngineRunInput.systemPrompt` NOTU: Claude Code bunu `--system-prompt-file`
 * ile ayri tasir; Codex CLI'da olculdu ki boyle bir bayrak YOK, sistem
 * prompt'u gorev metnine eklenerek verilir (bkz. `engines/codex.ts`).
 */

export interface EngineRunInput {
  runId: string;
  /** Ajanin SOUL'undan uretilen sistem prompt'u. */
  systemPrompt: string;
  /** Gorev metni (baslik + ayrinti + thread). */
  prompt: string;
  /** Motorun calisacagi dizin; yoksa ajanin ilk is koku. */
  cwd?: string;
  /** Ajanin erisebilecegi kokler. */
  workRoots: string[];
  allowedTools: string[];
  model?: string | null;
  signal?: AbortSignal;
}

/**
 * Kosu sonucu. `ok` YALNIZ surec basarili VE motor basarili dediginde true:
 * biri digerini ortmez (bu ayrim pahaliya ogrenildi — Codex `exec` hata
 * halinde bile exit 0 donduruyor, olculdu).
 */
export interface EngineRunResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  costMicros?: number;
  inputTokens?: number;
  outputTokens?: number;
  exitCode: number | null;
  timedOut: boolean;
  logPath: string;
}
