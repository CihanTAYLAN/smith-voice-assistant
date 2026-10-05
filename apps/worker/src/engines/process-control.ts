import { spawn, type ChildProcess } from 'node:child_process';

import type { EngineRunResult } from './engine-result.js';
import { BoundedOutput } from './output-capture.js';

/**
 * Windows tarafindaki surec agacini durdurur. `child.kill()` Windows'ta yalniz
 * dogrudan cocugu oldurur; motorun baslattigi alt surecler arkada kalirdi.
 *
 * SINIR: WSL motorunun `wsl.exe` istemcisi bu agacin parcasidir ama Linux
 * tarafindaki motor DEGILDIR; onu durdurmak `wsl-engine.ts` (`stopWslEngine`)
 * isidir ve `collectProcess`in `stopRemote` kancasiyla birlikte calisir.
 */
export function terminateProcessTree(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }
  child.kill();
}

export interface ProcessOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
  readonly aborted: boolean;
}

/**
 * Motor sureci bitene kadar bekler. Bellekte yalniz sinirli cikti tutulur
 * (`BoundedOutput`); sinir asilirsa, `timeoutMs` dolarsa ya da `signal` iptal
 * ederse surec agaci durdurulur. Boylece sonsuz ciktili bir motor worker'in
 * heap'ini tuketemez ve kapanan worker arkasinda calisan motor birakmaz.
 *
 * `stopRemote`: Windows surec agaci durdurmak WSL icindeki motoru durdurmaz
 * (`wsl.exe` yalniz istemcidir). Durdurma aninda BIR KEZ cagrilir ve sonuc
 * donmeden once tamamlanmasi beklenir: kosu "durdu" denirken motor yasamamali.
 * Sozlesme: hata firlatmaz (kendi icinde uyarir); durdurma yolundaki bir istisna
 * zamanlayici/olay isleyicisinden worker surecini dusururdu.
 */
export async function collectProcess(
  child: ChildProcess,
  options: {
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    maxOutputBytes?: number;
    stopRemote?: () => Promise<void>;
  },
): Promise<ProcessOutcome> {
  let timedOut = false;
  let outputExceeded = false;
  let aborted = false;
  let remoteStop: Promise<void> | undefined;
  const stop = (): void => {
    terminateProcessTree(child);
    remoteStop ??= options.stopRemote?.();
  };
  const onLimit = (): void => {
    outputExceeded = true;
    stop();
  };
  const stdout = new BoundedOutput(options.maxOutputBytes, onLimit);
  const stderr = new BoundedOutput(options.maxOutputBytes, onLimit);
  const onAbort = (): void => {
    aborted = true;
    stop();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
    });
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut,
      outputExceeded,
      aborted,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    await remoteStop;
  }
}

/**
 * Cikti siniri ya da iptal nedeniyle zorla durdurulan kosunun sonucu; motor
 * ciktisi eksik oldugu icin ayristiriciya gonderilmez. Normal biten kosu icin
 * `null`.
 */
export function interruptedResult(
  outcome: ProcessOutcome,
  signal: AbortSignal | undefined,
  logPath: string,
): EngineRunResult | null {
  const text = outcome.outputExceeded
    ? 'Motor cikti sinirini asti ve surec agaci durduruldu.'
    : outcome.aborted
      ? `Kosu durduruldu: ${abortMessage(signal?.reason)}`
      : null;
  if (text === null) return null;
  return { ok: false, text, exitCode: outcome.exitCode, timedOut: false, logPath };
}

function abortMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'iptal edildi';
}
