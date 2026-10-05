import { spawn } from 'node:child_process';

import { terminateProcessTree } from './process-control.js';

/**
 * WSL KOPRU YARDIMCILARI — iki motor da (claude-code, codex) ayni deseni
 * kullanir: kosu dosyalari Windows tarafinda durur, motor WSL icinde kosar.
 * Bu yuzden yollar CEVRILIR, string oyunu YAPILMAZ.
 */

/**
 * WSL komutlarinin ust suresi. WSL servisi kilitliyse ya da ilk acilis
 * bekliyorsa `wsl.exe` yanit vermez; sinirsiz beklemek is kuyrugunu asili
 * birakirdi. Soguk WSL acilisina yetecek kadar genis tutulur.
 */
const WSL_COMMAND_TIMEOUT_MS = 30_000;

/**
 * POSIX tek-tirnak alintilama. Yollar ve model adlari icin; disaridan gelen
 * serbest metin bu yoldan HIC gecmez (prompt'lar dosyadan okunur).
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `C:\a`, `C:/a` ya da UNC (`\\sunucu\paylasim`): WSL icin cevrilmesi gereken yol. */
export function isWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\');
}

/**
 * Windows yolunu WSL yoluna cevirir (`wslpath -a`). Tahminle uretilmez:
 * `C:\a\b` → `/mnt/c/a/b` donusumu surucu harfi ve baglama noktasina gore
 * degisir; elle yazilan bir cevirici sessizce yanlis yola duser.
 */
export async function toWslPath(
  windowsPath: string,
  capture: typeof execCapture = execCapture,
): Promise<string> {
  const { stdout, code } = await capture('wsl.exe', ['-e', 'wslpath', '-a', windowsPath]);
  if (code !== 0) throw new Error(`wslpath cikis kodu ${code}: ${windowsPath}`);
  const converted = stdout.trim().split(/\r?\n/).pop()?.trim();
  if (!converted?.startsWith('/')) {
    throw new Error(`wslpath donusumu basarisiz: ${windowsPath} → ${stdout.trim()}`);
  }
  return converted;
}

export function execCapture(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const timeoutMs = options.timeoutMs ?? WSL_COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    // WSL_UTF8: `wsl.exe` varsayilan olarak UTF-16LE yazar ve cikti okunamaz
    // hale gelir (bu makinede olculmus tuzak).
    const child = spawn(command, args, { env: { ...process.env, WSL_UTF8: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      terminateProcessTree(child);
      reject(new Error(`${command} ${timeoutMs}ms icinde tamamlanmadi.`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}
