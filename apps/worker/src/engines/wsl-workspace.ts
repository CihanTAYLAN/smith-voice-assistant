import { assertRunId } from './run-dir.js';
import { execCapture, isWindowsPath, toWslPath } from './wsl-path.js';

type Capture = typeof execCapture;

/** Motorun WSL icinde calisacagi dizin ve erisebilecegi kokler (hepsi WSL yolu). */
export interface WslWorkspace {
  readonly cwd: string;
  readonly workRoots: string[];
  /** Kosu bitince cagrilir; hata firlatmaz (biten kosunun sonucunu kaybettirmez). */
  cleanup(): Promise<void>;
}

/**
 * Motorun WSL tarafindaki calisma alanini hazirlar.
 *
 * - Windows kokleri (`C:\...`) `wslpath` ile cevrilir; yazma gorevi WSL'de
 *   sandbox'la kosar (native Windows `workspace-write` yazmayi reddediyor).
 * - Kok listesi BOSsa ajan "dosya isi olmayan ajan"dir: WSL login home'una
 *   (varsayilan cwd) birakilmaz, root sahipli `0555` bos bir gecici dizinde
 *   kosar ve kosu bitince dizin silinir. Boylece `acceptEdits` /
 *   `workspace-write` bile yazacak yer bulamaz. Bu YALNIZ dosya araclari icin
 *   gecerlidir: adsiz `Bash` izni `cd` ile dizini terk edebilir (bkz.
 *   `claude-code.ts`, guvenlik kapisi 1).
 */
export async function prepareWslWorkspace(
  input: { runId: string; cwd?: string | undefined; workRoots: readonly string[] },
  capture: Capture = execCapture,
): Promise<WslWorkspace> {
  if (input.workRoots.length === 0) return createEmptyWorkspace(input.runId, capture);

  const workRoots = await Promise.all(input.workRoots.map((root) => toWorkRoot(root, capture)));
  // Motor dizini is kokleri disina cikamaz: cwd her zaman kokten biridir.
  const cwd = workRoots[input.cwd === undefined ? 0 : input.workRoots.indexOf(input.cwd)];
  if (cwd === undefined) {
    throw new Error(`Calisma dizini is koklerinden biri degil: ${input.cwd}`);
  }
  return { cwd, workRoots, cleanup: () => Promise.resolve() };
}

async function toWorkRoot(root: string, capture: Capture): Promise<string> {
  return isWindowsPath(root) ? toWslPath(root, capture) : root;
}

async function createEmptyWorkspace(runId: string, capture: Capture): Promise<WslWorkspace> {
  assertRunId(runId);
  const prefix = `/tmp/smith-mission-${runId}.`;
  // Login olmayan kabuk: root profilinin stdout'a yazdigi bir sey dizin yolunu bozmasin.
  const created = await capture('wsl.exe', [
    '-u',
    'root',
    '-e',
    'bash',
    '-c',
    `dir=$(mktemp -d ${prefix}XXXXXX) && chmod 0555 "$dir" && printf "%s" "$dir"`,
  ]);
  const cwd = created.stdout.trim();
  if (created.code !== 0 || !cwd.startsWith(prefix)) {
    throw new Error('Salt-okunur gecici WSL calisma dizini olusturulamadi.');
  }
  return {
    cwd,
    workRoots: [],
    async cleanup() {
      const removed = await capture('wsl.exe', ['-u', 'root', '-e', 'rmdir', '--', cwd]).catch(
        () => null,
      );
      if (removed?.code !== 0) {
        process.stderr.write(`[worker] gecici WSL dizini temizlenemedi: ${cwd}\n`);
      }
    },
  };
}
