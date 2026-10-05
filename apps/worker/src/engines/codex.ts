import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseCodexResult } from './codex-result.js';
import type { EngineRunInput, EngineRunResult } from './engine-result.js';
import { readAllowedEnv, readTimeoutMsEnv } from './engine-config.js';
import { collectProcess, interruptedResult, type ProcessOutcome } from './process-control.js';
import { prepareEngineRunDir, writeEngineLog } from './run-dir.js';
import { buildWslEngineCommand, collectWslEngine, spawnWslEngine } from './wsl-engine.js';
import { isWindowsPath, shellQuote, toWslPath } from './wsl-path.js';
import { prepareWslWorkspace } from './wsl-workspace.js';

/**
 * CODEX MOTORU — ChatGPT abonelik kimligiyle kosan ikinci is gucu (ADR 0007 §4).
 *
 * NEDEN BU MOTOR: Smith'in kendi tool-loop'u (`packages/core`) ile birlikte
 * ikinci gercek kullanim budur; kullanicinin Codex aboneligi boylece Smith
 * gorevlerinde kullanilir (token basina odeme yerine abonelik kotasi).
 *
 * --- OLCULEN GERCEKLER (codex-cli 0.153.4 / 0.155.0, 2026-09-18) -----------
 *
 * 1. **Yazma yalniz WSL'de calisiyor.** Windows'ta `-s workspace-write`
 *    verildiginde motor yine "read-only sandbox" diyerek yazmayi REDDEDIYOR
 *    (olculdu: git deposunda bile). Tek alternatif
 *    `--dangerously-bypass-approvals-and-sandbox` / `danger-full-access`
 *    olurdu — bu repoda yasak (kök AGENTS.md §2). Bu yuzden yazma gorevi
 *    WSL'de kosar: orada sandbox gercek; Windows kokleri `wslpath` ile
 *    cevrilir (`prepareWslWorkspace`).
 * 2. **Kullanicinin `~/.codex/config.toml`'u miras ALINMAZ.** Orada
 *    `sandbox_mode = "danger-full-access"` ve ChatGPT hesabiyla
 *    DESTEKLENMEYEN bir model (`gpt-5.3-codex-spark`) duruyor; ikisi de
 *    kosuyu ya guvensiz ya kirik yapardi. `--ignore-user-config` ile kosu
 *    kendi sinirini tasir. `--ignore-rules` de ayni sebeple: kullanicinin
 *    execpolicy kurallari yazmayi politika gerekcesiyle bloke ediyordu.
 * 3. **Exit kodu guvenilmez** — `turn.failed` halinde bile 0 donduruyor.
 *    Cozum ayristiricida (bkz. codex-result.ts).
 * 4. **`--system-prompt-file` YOK.** Claude Code'da olan bu bayrak Codex'te
 *    bulunmuyor; sistem prompt'u gorev metnine eklenerek verilir (`composePrompt`).
 * 5. **`--skip-git-repo-check` gerekli.** Depo olmayan bir kokte motor
 *    "Not inside a trusted directory" diyerek hic baslamiyor (olculdu).
 *    Yazma siniri git'e degil sandbox'a dayanir.
 *
 * GUVENLIK KAPILARI (claude motoruyla ayni sinif):
 *   1. Sandbox modu ALLOWLIST'ten gecer; `danger-full-access` HICBIR KOSULDA
 *      gecilmez (olculen alternatif buydu, reddedildi). Gecersiz deger
 *      acilista reddedilir, sessizce baska moda dusmez.
 *   2. Is kokleri ajanin `workRoots` listesidir; baska dizin verilmez. Liste
 *      bossa motor WSL'de bos + salt-okunur gecici bir dizinde kosar.
 *   3. Iki katmanli zaman asimi (WSL icinde `timeout`, dis tarafta JS
 *      zamanlayici; Windows'ta surec agaci `taskkill /T /F` ile oldurulur).
 *      Cikti bellekte sinirlidir; iptal, cikti siniri ve zaman asiminda WSL
 *      tarafindaki motor ailesi de durdurulur (`wsl-engine.ts`) ve worker
 *      acilisinda yetim kalanlar supurulur. `wsl.exe` istemcisini oldurmek
 *      Linux tarafindaki motoru oldurmez (olculdu).
 *   4. Motor `SMITH_MISSION_EXECUTOR=1` olmadan hic cagrilmaz (`executor.ts`).
 *   5. Prompt'lar DOSYADAN gecer — komut satirinda kullanici metni tasinmaz.
 */

/** Gecilmesine izin verilen sandbox modlari. Liste kasten kisa. */
export const CODEX_SANDBOXES = ['read-only', 'workspace-write'] as const;
export type CodexSandbox = (typeof CODEX_SANDBOXES)[number];

/** Motorun kosacagi makine. */
export const CODEX_HOSTS = ['wsl', 'windows'] as const;
export type CodexHost = (typeof CODEX_HOSTS)[number];

/** `auto`: makineyi `resolveCodexHost` secer (yazma gorevi icin WSL). */
export const CODEX_HOST_SETTINGS = ['auto', 'wsl', 'windows'] as const;
export type CodexHostSetting = (typeof CODEX_HOST_SETTINGS)[number];

export interface CodexConfig {
  host: CodexHostSetting;
  sandbox: CodexSandbox;
  timeoutMs: number;
  /** CLI yolu/adi. PATH'te `codex` varsa varsayilan yeter. */
  bin: string;
}

/**
 * Motorun yapilandirmasi — cagiran degil ortam belirler. Gecersiz sandbox/makine
 * degeri ACILISTA reddedilir (`readAllowedEnv`); sessizce baska moda dusmez.
 */
export function readCodexConfig(): CodexConfig {
  return {
    host: readAllowedEnv('SMITH_CODEX_HOST', CODEX_HOST_SETTINGS, 'auto'),
    sandbox: readAllowedEnv('SMITH_CODEX_SANDBOX', CODEX_SANDBOXES, 'workspace-write'),
    timeoutMs: readTimeoutMsEnv('SMITH_CODEX_TIMEOUT_MS'),
    bin: process.env.SMITH_CODEX_BIN ?? 'codex',
  };
}

/**
 * MOTORUN KOSACAGI MAKINEYI SECER.
 *
 * Yazma yetkili (`workspace-write`) kosu yalniz WSL'de gercek sandbox'a sahip
 * (olculdu, ust notlar madde 1). Bu yuzden `auto` HER ZAMAN `wsl`dir: Windows
 * koklu is de WSL'de kosar ve kokler `wslpath` ile cevrilir
 * (`prepareWslWorkspace`). Bos liste de `wsl`dir: bos + salt-okunur gecici
 * calisma dizini yalniz orada kurulur. Acik `windows` secimi yalniz is
 * kokleri varken gecerlidir ve `workspace-write` ile birlikte `runCodex`ta
 * reddedilir.
 */
export function resolveCodexHost(
  setting: CodexHostSetting,
  workRoots: readonly string[],
): CodexHost {
  if (workRoots.length === 0) return 'wsl';
  return setting === 'auto' ? 'wsl' : setting;
}

/**
 * Motora verilecek (cevrimden SONRAKI) is kokunun makinenin lehcesinde
 * oldugunu dogrular. NEDEN HATA: Windows motoruna `/home/...` verilirse Codex
 * ya hic baslamaz ya da sessizce YANLIS dizinde calisir.
 */
export function assertPathDialect(host: CodexHost, roots: readonly string[]): void {
  const wrong = roots.filter((root) =>
    host === 'wsl' ? isWindowsPath(root) : root.startsWith('/') && !isUncPath(root),
  );
  if (wrong.length === 0) return;
  const expected =
    host === 'wsl' ? 'WSL (ornek: /home/alice/proje)' : 'Windows (ornek: C:\\projeler\\x)';
  throw new Error(
    `Is koku ${host} motoruna uygun degil: ${wrong.join(', ')}. Beklenen bicim: ${expected}.`,
  );
}

function isUncPath(value: string): boolean {
  return value.startsWith('//');
}

/**
 * `codex exec` arguman dizisi. SAF fonksiyon: surec baslatmadan test edilir
 * (hangi bayragin gectigini ve TEHLIKELI bayragin GECMEDIGINI test dogrular).
 *
 * `-` son arguman: prompt stdin'den okunur. Boylece kullanici metni komut
 * satirina hic girmez (shell enjeksiyonu yuzeyi yok).
 */
export function buildCodexArgs(input: {
  sandbox: CodexSandbox;
  lastMessagePath: string;
  workRoots: readonly string[];
  model?: string | null;
}): string[] {
  const args = [
    'exec',
    // Kullanicinin interaktif Codex ayarlari/kurallari miras alinmaz (olculen
    // gerekce yukarida, madde 2). Kosunun sinirini bu motor tanimlar.
    '--ignore-user-config',
    '--ignore-rules',
    '-s',
    input.sandbox,
    '--skip-git-repo-check',
    '--json',
    // Nihai cevap AYRI DOSYAYA da yazilir: JSONL akisini ayristirmak zorunda
    // kalmadan ham cevap elimizde olur (teshis + iki kaynaktan dogrulama).
    '-o',
    input.lastMessagePath,
  ];
  if (input.model) args.push('-m', input.model);
  for (const root of input.workRoots) args.push('--add-dir', root);
  args.push('-');
  return args;
}

/** Sistem prompt'u + gorev metni. Codex'te ayri sistem prompt bayragi yok. */
export function composePrompt(input: Pick<EngineRunInput, 'systemPrompt' | 'prompt'>): string {
  return `${input.systemPrompt}\n\n--- GOREV ---\n\n${input.prompt}\n`;
}

export async function runCodex(
  input: EngineRunInput & { host?: CodexHostSetting; sandbox?: CodexSandbox; bin?: string },
): Promise<EngineRunResult> {
  if (input.allowedTools.length > 0) {
    return {
      ok: false,
      text:
        'Codex motoru allowedTools allowlistini henuz uygulamiyor; ' +
        `arac siniri belirlenmeden kosu baslatilmadi: ${input.allowedTools.join(', ')}.`,
      exitCode: null,
      timedOut: false,
      logPath: '',
    };
  }

  const config = readCodexConfig();
  const host = resolveCodexHost(input.host ?? config.host, input.workRoots);
  const sandbox = input.sandbox ?? config.sandbox;
  const bin = input.bin ?? config.bin;
  if (host === 'windows' && sandbox === 'workspace-write') {
    throw new Error(
      'Codex workspace-write Windows hostunda desteklenmiyor. SMITH_CODEX_HOST=wsl kullan.',
    );
  }

  const workspace =
    host === 'wsl'
      ? await prepareWslWorkspace(input)
      : {
          cwd: input.cwd,
          workRoots: input.workRoots,
          cleanup: () => Promise.resolve(),
        };

  try {
    assertPathDialect(host, workspace.workRoots);

    const dir = await prepareEngineRunDir(input.runId);
    const promptPath = join(dir, 'prompt.md');
    const lastMessagePath = join(dir, 'last-message.txt');
    const promptText = composePrompt(input);
    await writeFile(promptPath, promptText, 'utf8');

    /*
     * WSL MOTORU POSIX YOL GORUR, kosu dosyalari ise Windows tarafinda durur.
     * Cevrim `wslpath` ile yapilir — ilk surumde bu adim atlanmisti ve motor
     * "No such file or directory" ile 300 ms'de oluyordu (olculdu, 2026-09-18).
     * Ayni desen claude motorunda da var; ortak yardimci: `wsl-path.ts`.
     */
    const argvLastMessage = host === 'wsl' ? await toWslPath(lastMessagePath) : lastMessagePath;
    const argvPromptPath = host === 'wsl' ? await toWslPath(promptPath) : promptPath;

    const timeoutSeconds = Math.ceil(config.timeoutMs / 1000);
    const args = buildCodexArgs({
      sandbox,
      lastMessagePath: argvLastMessage,
      workRoots: workspace.workRoots,
      model: input.model ?? null,
    });

    const started = Date.now();
    // Dis zamanlayici ic `timeout`tan sonra devreye girer. Windows'ta surec
    // agaci ayri oldurulur: `kill()` yalniz dogrudan cocugu oldurur ve
    // Codex'in baslattigi komutlar arkada kalirdi. WSL'de ayrica Linux
    // tarafindaki motor ailesi durdurulur (`wsl-engine.ts`).
    const collectOptions = { timeoutMs: config.timeoutMs + 30_000, signal: input.signal };
    let command: string;
    let outcome: ProcessOutcome;
    if (host === 'wsl') {
      command = buildWslEngineCommand({
        runId: input.runId,
        cwd: workspace.cwd,
        timeoutSeconds,
        engineCommand: [bin, ...args].map(shellQuote).join(' '),
        promptPath: argvPromptPath,
      });
      outcome = await collectWslEngine(spawnWslEngine(command), input.runId, collectOptions);
    } else {
      command = `${[bin, ...args].join(' ')} < ${promptPath}`;
      outcome = await collectProcess(
        spawnWindows(bin, args, { cwd: workspace.cwd, promptText }),
        collectOptions,
      );
    }

    const timedOut = outcome.timedOut || outcome.exitCode === 124;
    const durationMs = Date.now() - started;

    const logPath = await writeEngineLog(
      join(dir, 'engine.log'),
      [
        '# motor: codex',
        `# makine: ${host} / sandbox: ${sandbox} / bin: ${bin}`,
        '# komut',
        command,
        '',
        `# exit: ${outcome.exitCode} / sure: ${durationMs}ms / zaman asimi: ${timedOut}`,
        '',
        '# stdout',
        outcome.stdout,
        '',
        '# stderr',
        outcome.stderr,
      ].join('\n'),
    );

    const interrupted = interruptedResult(outcome, input.signal, logPath);
    if (interrupted) return interrupted;

    const result = parseCodexResult({
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exitCode: outcome.exitCode,
      timedOut,
      timeoutSeconds,
      logPath,
    });

    /*
     * CLI YOKSA SEBEBINI SOYLE. Ayristirici yalniz JSONL sozlesmesini bilir; bu
     * makinede BEKLENEN durum (WSL'de codex henuz kurulu degil) 127 ile doner ve
     * ham haliyle "sonuc bildirmedi" gibi teshis edilemez bir metin uretirdi.
     * Motor tarafinda, yapilmasi gereken seyi soyleyen bir mesaja cevrilir.
     */
    if (!result.ok && isCommandMissing(outcome.exitCode, outcome.stderr)) {
      return {
        ...result,
        text:
          `Codex CLI bulunamadi ('${bin}', makine: ${host}). ` +
          (host === 'wsl'
            ? 'WSL icinde kurup giris yap: `bun add -g @openai/codex` + `codex login`.'
            : 'Kurulumu kontrol et veya SMITH_CODEX_BIN ile tam yolu ver.'),
      };
    }

    return result;
  } finally {
    await workspace.cleanup();
  }
}

/** `bash: codex: command not found` / Windows `is not recognized as ...` */
function isCommandMissing(exitCode: number | null, stderr: string): boolean {
  if (exitCode === 127) return true;
  return /command not found|not recognized as an internal or external command/i.test(stderr);
}

/**
 * Windows: kabuk YOK, argumanlar dizi olarak gecer (alintilama katmani yok).
 * Prompt stdin'den verilir.
 */
export function spawnWindows(
  bin: string,
  args: readonly string[],
  options: { cwd?: string | undefined; promptText: string },
) {
  const child = spawn(bin, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    // `.exe`/`.cmd` cozumlemesi Windows'ta PATH uzerinden kabuk olmadan
    // yapilamaz; `shell` ACMIYORUZ — bunun yerine tam yol verilebilir
    // (SMITH_CODEX_BIN). `windowsHide` konsol penceresi acilmasin diye.
    windowsHide: true,
  });
  // Cocuk prompt'u okumadan cikarsa (`EPIPE` / `write EOF`) stdin 'error' yayar ve
  // dinleyici yoksa worker sureci yakalanmamis istisnayla coker (uc kuyruk birden
  // durur). Sonuc zaten 'close' / 'error' ile okunur; bu hata yeni bilgi tasimaz.
  child.stdin.on('error', () => undefined);
  child.stdin.end(options.promptText);
  return child;
}
