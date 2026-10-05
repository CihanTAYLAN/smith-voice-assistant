import { spawn, type ChildProcess } from 'node:child_process';

import { collectProcess, type ProcessOutcome } from './process-control.js';
import { assertRunId, isRunId } from './run-dir.js';
import { execCapture, shellQuote } from './wsl-path.js';

type Capture = typeof execCapture;

/**
 * WSL MOTOR SURECLERININ YASAM DONGUSU (ADR 0007 madde 6.3).
 *
 * SORUN (2026-10-03 olculdu): motor `wsl.exe` istemcisi uzerinden WSL icinde
 * kosar. Windows tarafinda `taskkill /T /F` yalniz istemciyi oldurur; eski komut
 * bicimi (`bash -lc "cd x && timeout ... komut"`) Linux tarafindaki `timeout` ve
 * motoru hayatta birakiyordu: iptal, cikti siniri, lease kaybi ya da worker
 * yeniden baslatmasindan sonra motor `SMITH_MISSION_TIMEOUT_MS` dolana kadar
 * dosya yazmaya ve token harcamaya devam ediyordu. Kosu `failed` yazilmisken
 * ayni koke yeniden atama ikinci bir motoru calistirabiliyordu.
 *
 * COZUM, iki parca:
 *   1. `exec timeout ...`: kabuk araya girmez, `timeout` oturum lideri olur.
 *      WSL istemcisi olunce HUP zinciri `timeout`u ve grubunu kapatir (olculdu:
 *      eski bicimde grup hayatta kaliyordu).
 *   2. Her motor sureci `SMITH_RUN_ID` / `SMITH_RUN_OWNER` ortam degiskenlerini
 *      tasir; torunlar da miras alir. Durdurma ve acilis taramasi surecleri
 *      `/proc/<pid>/environ` uzerinden isarete gore bulur. Surec grubuna ya da
 *      ada baglanmak yetmezdi: `setsid` ile ayri oturuma kacan torun (olculdu)
 *      gruptan da adan da kurtulur, ortam degiskeni ise kalitilir.
 *
 * `exec -a smith-run-<id>` bilerek kullanilmadi: coreutils bu makinede `uutils`
 * (tek ikili dosya), `argv[0]`a gore calisan uygulamalarda ada baglanmak bir
 * dagitim guncellemesiyle `timeout`u bozabilirdi. Ortam isareti `argv[0]`dan bagimsizdir.
 */

const RUN_ID_ENV = 'SMITH_RUN_ID';
const RUN_OWNER_ENV = 'SMITH_RUN_OWNER';
const TIMEOUT_KILL_AFTER_SECONDS = 20;
/** coreutils `timeout` suresi dolunca bu kodla cikar. */
const TIMEOUT_EXIT_CODE = 124;
/** Durdurma betigi nazik ~3 sn + zorla ~0,6 sn bekler; WSL cold start icin genis tavan. */
const STOP_COMMAND_TIMEOUT_MS = 15_000;

/**
 * Motoru WSL kabugunda baslatan tek komut dizesi. Iki motor (claude-code, codex)
 * da bunu kullanir. `engineCommand` zaten kabuk guvenli kelimelerden olusur;
 * kullanici metni buraya girmez (prompt dosyadan okunur). Komut sirasi:
 * `cd` -> isaret degiskenleri -> `exec timeout` -> motor -> stdin yonlendirmesi.
 */
export function buildWslEngineCommand(input: {
  runId: string;
  cwd?: string | undefined;
  timeoutSeconds: number;
  engineCommand: string;
  promptPath: string;
  /** Isaretin sahibi: bu worker sureci. Acilis taramasi sahibi olmus surecleri yetim sayar. */
  ownerPid?: number;
}): string {
  assertRunId(input.runId);
  const ownerPid = input.ownerPid ?? process.pid;
  if (!Number.isInteger(ownerPid) || ownerPid < 1) {
    throw new Error(`Gecersiz sahip surec kimligi: ${ownerPid}`);
  }
  if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1) {
    throw new Error(`Gecersiz zaman asimi (saniye): ${input.timeoutSeconds}`);
  }
  const cd = input.cwd ? `cd ${shellQuote(input.cwd)} && ` : '';
  return (
    `${cd}${RUN_ID_ENV}=${shellQuote(input.runId)} ${RUN_OWNER_ENV}=${ownerPid} ` +
    `exec timeout --signal=TERM --kill-after=${TIMEOUT_KILL_AFTER_SECONDS}s ${input.timeoutSeconds}s ` +
    `${input.engineCommand} < ${shellQuote(input.promptPath)}`
  );
}

/**
 * `bash -lc`: login kabugu sart; `claude`/`codex` ~/.local/bin altinda ve
 * non-login kabukta PATH bos kaliyor (bu makinede olculmus tuzak). `WSL_UTF8`:
 * `wsl.exe` varsayilan olarak UTF-16LE yazar.
 */
export function spawnWslEngine(command: string): ChildProcess {
  return spawn('wsl.exe', ['-e', 'bash', '-lc', command], {
    env: { ...process.env, WSL_UTF8: '1' },
  });
}

/**
 * Bir kosunun motor ailesini isaretinden bulan betik parcasi. `/proc/<pid>/environ`
 * NUL ayrilidir; `grep -lzx` her kaydi tam eslestirir. Betigin kendi sureci
 * isareti tasimaz, kendini bulmaz.
 */
function scanScript(runId: string): string {
  const marker = shellQuote(`${RUN_ID_ENV}=${runId}`);
  return `grep -lzx ${marker} /proc/[0-9]*/environ 2>/dev/null | sed 's#/proc/\\([0-9]*\\)/environ#\\1#'`;
}

/**
 * Aileyi once nazikce (TERM, en fazla ~3 sn), sonra zorla (KILL) durdurur.
 * Cikis 0: aile kalmadi. Cikis 1: kalan var (kalan pid'ler `KALAN:` ile yazilir).
 * Tum aile ayni anda TERM alir (`timeout` sarmali dahil); yeni dogan torunlar
 * her turda yeniden taranir.
 */
function stopScript(runId: string): string {
  return [
    `scan() { ${scanScript(runId)}; }`,
    'pids=$(scan)',
    '[ -z "$pids" ] && exit 0',
    'kill -TERM $pids 2>/dev/null',
    'for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.3; pids=$(scan); [ -z "$pids" ] && exit 0; done',
    'kill -KILL $pids 2>/dev/null',
    'sleep 0.3',
    'pids=$(scan)',
    '[ -z "$pids" ] && exit 0',
    'echo "KALAN:$pids"',
    'exit 1',
  ].join('\n');
}

/** Isaretli butun surecleri `/proc/<pid>/environ:DEGISKEN=deger` satirlariyla listeler. */
const LIST_SCRIPT = `grep -a -z -H -E '^(${RUN_ID_ENV}|${RUN_OWNER_ENV})=' /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n'`;

function warn(message: string): void {
  process.stderr.write(`[worker] ${message}\n`);
}

/**
 * Kosunun WSL tarafindaki motor ailesini (torunlar dahil) durdurur. EN IYI CABA
 * ve ASLA FIRLATMAZ: zamanlayici ve olay isleyicilerinden cagrilir, istisna
 * worker surecini dusururdu. Durdurulamazsa uyari verir.
 */
export async function stopWslEngine(runId: string, capture: Capture = execCapture): Promise<void> {
  try {
    assertRunId(runId);
    const result = await capture('wsl.exe', ['-e', 'bash', '-c', stopScript(runId)], {
      timeoutMs: STOP_COMMAND_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      warn(
        `WSL motor ailesi tamamen durmadi (${runId}): ${result.stdout.trim() || result.stderr.trim()}`,
      );
    }
  } catch (error) {
    warn(
      `WSL motor ailesi durdurulamadi (${runId}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface EngineProcessRef {
  readonly pid: number;
  readonly runId: string;
  /** Isareti koyan worker surecinin Windows kimligi; bilinmiyorsa `null`. */
  readonly ownerPid: number | null;
}

const LIST_LINE = new RegExp(`^/proc/(\\d+)/environ:(${RUN_ID_ENV}|${RUN_OWNER_ENV})=(.*)$`);

/**
 * `LIST_SCRIPT` ciktisini surec basina toplar. Gecersiz bicimli kosu kimligi
 * (durdurma betigine girmesin) ve gurultu satirlari atilir.
 */
export function parseEngineProcessList(output: string): EngineProcessRef[] {
  const byPid = new Map<number, { runId?: string; ownerPid?: number }>();
  for (const line of output.split(/\r?\n/)) {
    const match = LIST_LINE.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    const value = match[3] ?? '';
    const entry = byPid.get(pid) ?? {};
    if (match[2] === RUN_ID_ENV) {
      if (isRunId(value)) entry.runId = value;
    } else {
      const ownerPid = Number(value);
      if (Number.isInteger(ownerPid) && ownerPid > 0) entry.ownerPid = ownerPid;
    }
    byPid.set(pid, entry);
  }
  return [...byPid].flatMap(([pid, entry]) =>
    entry.runId ? [{ pid, runId: entry.runId, ownerPid: entry.ownerPid ?? null }] : [],
  );
}

export async function listEngineProcesses(
  capture: Capture = execCapture,
): Promise<EngineProcessRef[]> {
  const listed = await capture('wsl.exe', ['-e', 'bash', '-c', LIST_SCRIPT]);
  if (listed.code !== 0) {
    throw new Error(
      `WSL motor listesi alinamadi (cikis kodu ${listed.code}): ${listed.stderr.trim()}`,
    );
  }
  return parseEngineProcessList(listed.stdout);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: surec var ama yetkimiz yok. Yasiyor sayilir: yanlislikla oldurmeyiz.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Worker acilisinda yetim motorlari supurur: sahibi (isareti koyan worker sureci)
 * olmus ya da bilinmeyen motor aileleri durdurulur. Sahibi yasayan baska bir
 * worker'in ya da bu surecin kosusuna dokunulmaz; PID yeniden kullanimi yanlis
 * "yasiyor" sonucu verirse motor kendi zaman asimiyla biter (guvenli yon).
 * Donus: durdurulan kosu kimlikleri.
 */
export async function sweepOrphanWslEngines(
  options: {
    capture?: Capture;
    isOwnerAlive?: (pid: number) => boolean;
    stop?: (runId: string) => Promise<void>;
  } = {},
): Promise<string[]> {
  const capture = options.capture ?? execCapture;
  const isOwnerAlive = options.isOwnerAlive ?? isProcessAlive;
  const stop = options.stop ?? ((runId: string) => stopWslEngine(runId, capture));

  const orphans = new Set<string>();
  for (const ref of await listEngineProcesses(capture)) {
    const ownerAlive =
      ref.ownerPid !== null && (ref.ownerPid === process.pid || isOwnerAlive(ref.ownerPid));
    if (!ownerAlive) orphans.add(ref.runId);
  }
  for (const runId of orphans) await stop(runId);
  return [...orphans];
}

/**
 * `collectProcess` + WSL tarafi durdurma. Iptal, cikti siniri ve dis zaman
 * asimi `stopRemote` kancasiyla aileyi durdurur. Ic `timeout` kendi suresi
 * dolunca (cikis 124) grubunu kendisi oldurur ama ayri oturuma kacan torunlar
 * kalabilir (olculdu): o durumda da aile temizlenir.
 */
export async function collectWslEngine(
  child: ChildProcess,
  runId: string,
  options: { timeoutMs: number; signal?: AbortSignal | undefined },
  stop: (runId: string) => Promise<void> = stopWslEngine,
): Promise<ProcessOutcome> {
  const outcome = await collectProcess(child, { ...options, stopRemote: () => stop(runId) });
  const stoppedByUs = outcome.timedOut || outcome.aborted || outcome.outputExceeded;
  if (outcome.exitCode === TIMEOUT_EXIT_CODE && !stoppedByUs) await stop(runId);
  return outcome;
}
