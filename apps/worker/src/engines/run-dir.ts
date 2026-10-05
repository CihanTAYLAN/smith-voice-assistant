import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Smith veri koku: durum dosyalarinin TEK koku. Kural her calisma ortaminda ayni
 * (Rust `src-tauri/src/paths.rs`, Python `sidecar/smith_paths.py`, PowerShell
 * `scripts/smith-common.ps1` `Resolve-SmithDataDir`):
 *   1. `SMITH_DATA_DIR` tanimli ve bos degilse o,
 *   2. degilse ev dizini altinda `.smith` (Windows'ta %USERPROFILE%\.smith, digerlerinde ~/.smith).
 *
 * %LOCALAPPDATA% / %APPDATA% KULLANILMAZ: MSIX paketli bir surecten (Claude Desktop) yazilan o
 * yollar paketin sanal deposuna yonlenir ve baska surec dosyayi gormez (ADR 0006'nin en pahali
 * tuzagi; 2026-10-03'te ses izi, yedek ayari ve gunlukler bu yuzden ikiye bolundu). Ev dizini
 * yonlendirilmez. Kapi: `scripts/check-data-root.mjs`.
 */
export function smithDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home: () => string = homedir,
): string {
  const explicit = env['SMITH_DATA_DIR']?.trim();
  if (explicit) return explicit;
  return join(home(), '.smith');
}

/**
 * Kosu dosyalarinin dizini: <veri koku>/mission/runs/<runId>.
 *
 * IKI MOTOR DA AYNI YERI KULLANIR: teshis icin "bu kosunun dosyalari nerede"
 * sorusunun tek cevabi olsun.
 */
export function engineRunDir(runId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(smithDataDir(env), 'mission', 'runs', runId);
}

/** Kosu dizinini hazirlar ve yolunu dondurur. */
export async function prepareEngineRunDir(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dir = engineRunDir(runId, env);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Kosu kimligi kabuk komutuna, WSL gecici dizin adina ve surec isaretine girer:
 * yalniz harf, rakam, `_` ve `-`. Uretilen kimlikler (`run_...`) zaten bu bicimdedir;
 * kontrol, bicimi bozuk bir degerin kabuga ulasmasini yapisal olarak engeller.
 */
export function isRunId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export function assertRunId(runId: string): void {
  if (!isRunId(runId)) throw new Error(`Gecersiz runId: ${runId}`);
}

/**
 * `engine.log` teshis kaydidir ve EN IYI CABA yazilir: disk dolu, izin ya da
 * antivirus kilidi yuzunden yazilamayan log, biten kosunun sonucunu (rapor, maliyet)
 * atmamali. Yazilamazsa uyari verilir ve olmayan dosyayi gostermemek icin bos yol
 * doner; basarida dosya yolunu dondurur.
 */
export async function writeEngineLog(logPath: string, content: string): Promise<string> {
  try {
    await writeFile(logPath, content, 'utf8');
    return logPath;
  } catch (error) {
    process.stderr.write(
      `[worker] engine.log yazilamadi (${logPath}): ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return '';
  }
}
