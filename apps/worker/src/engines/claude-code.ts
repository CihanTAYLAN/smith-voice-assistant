import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseClaudeCodeResult } from './claude-code-result.js';
import { readAllowedEnv, readTimeoutMsEnv } from './engine-config.js';
import type { EngineRunInput, EngineRunResult } from './engine-result.js';
import { interruptedResult } from './process-control.js';
import { prepareEngineRunDir, writeEngineLog } from './run-dir.js';
import { shellQuote, toWslPath } from './wsl-path.js';
import { buildWslEngineCommand, collectWslEngine, spawnWslEngine } from './wsl-engine.js';
import { prepareWslWorkspace } from './wsl-workspace.js';

/**
 * CLAUDE CODE MOTORU — Mission Control'un Faz 1 is gucu (ADR 0007).
 *
 * NEDEN BU MOTOR: Smith'in kendi tool-loop'u (`packages/core`) henuz yok.
 * Ajanlara bugun gercek is yaptirmanin yolu, makinede kurulu ve kimligi
 * dogrulanmis headless bir ajan CLI'sini kosmaktir. ADR 0007 §4'un ongordugu
 * ikinci motor geldi (Codex, `engines/codex.ts`); cagiran (agent-run consumer)
 * ilk motora ozgu hicbir sey bilmiyor — ortak sozlesme `engine-result.ts`.
 *
 * NEDEN WSL: `claude` bu makinede yalniz WSL tarafinda kurulu (Windows'ta yok).
 * Bunun bir yan faydasi var: ajan sonucu gateway'e POST ETMEZ, worker stdout'u
 * toplar — WSL'den Windows localhost'a erisimin NAT'ta kapali olmasi bu yuzden
 * bu hatti hic etkilemez. `workRoots` Windows yolu ise (`C:\...`) `wslpath` ile
 * WSL yoluna cevrilir (`prepareWslWorkspace`).
 *
 * GUVENLIK KAPILARI (ADR 0003: cihaz-tarafi araclar cihaz sahibinin
 * yetkisiyle kosar, sandbox sinifi izolasyon aranmaz — ama sinirsiz da degil):
 *   1. `--add-dir` ve "bos kok = dosya izni yok" kapisi YALNIZ DOSYA ARACLARI
 *      (Read, Edit, Write) icindir: liste bossa dosya izni verilmez ve ajan WSL
 *      home'a degil, bos + salt-okunur gecici bir dizine (`prepareWslWorkspace`)
 *      girer. Adsiz `Bash` izni (desensiz) komutlarini yol siniri olmadan kosar:
 *      Bash izinli bir ajan `cd ~` ile bu kapiyi asar. Bash'i kisitlamak icin
 *      `allowedTools` icinde desen kullan (or. `Bash(git:*)`); desensiz Bash
 *      cihaz sahibinin yetkisiyle kosar (ADR 0003) ve bu bilincli kabul edilmis bir
 *      sinirdir, kapi iddiasi degil.
 *   2. `--permission-mode` allowlist'ten gecer; `bypassPermissions` ve
 *      `--dangerously-skip-permissions` HICBIR KOSULDA gecilmez. Gecersiz
 *      deger acilista reddedilir, sessizce baska moda dusmez.
 *   3. Iki katmanli zaman asimi: WSL icinde `timeout`, dis tarafta JS zamanlayici.
 *      Yalniz JS tarafi yeterli degildi: `wsl.exe`'yi oldurmek Linux
 *      tarafindaki sureci oldurmez (olculdu). Cikti bellekte sinirlidir; iptal,
 *      cikti siniri ve zaman asiminda WSL tarafindaki motor ailesi de durdurulur
 *      (`wsl-engine.ts`: ortam isareti + `stopWslEngine`), worker acilisinda
 *      yetim kalanlar supurulur.
 *   4. Motor `SMITH_MISSION_EXECUTOR=1` olmadan hic cagrilmaz (consumer'da).
 *   5. Prompt'lar dosyadan gecer; komut satirinda kullanici metni tasinmaz —
 *      shell enjeksiyonu yuzeyi yok.
 */

/** Gecilmesine izin verilen izin modlari. Liste kasten kisa. */
const ALLOWED_PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const;
type PermissionMode = (typeof ALLOWED_PERMISSION_MODES)[number];

/** Motorun yapilandirmasi — cagiran degil ortam belirler. */
export function readEngineConfig(): {
  permissionMode: PermissionMode;
  timeoutMs: number;
} {
  return {
    // Executor kapisi BURADA DEGIL, `executor.ts`te: iki motor ayni anahtardan
    // gecer ve kapi tek yerde yasar.
    permissionMode: readAllowedEnv(
      'SMITH_MISSION_PERMISSION_MODE',
      ALLOWED_PERMISSION_MODES,
      'acceptEdits',
    ),
    timeoutMs: readTimeoutMsEnv('SMITH_MISSION_TIMEOUT_MS'),
  };
}

/** Zorunlu arac allowlistini Claude Code CLI sozlesmesine cevirir. */
export function buildClaudeAllowedToolsArgs(allowedTools: readonly string[]): string[] {
  return allowedTools.length > 0 ? ['--allowedTools', ...allowedTools.map(shellQuote)] : [];
}

export async function runClaudeCode(input: EngineRunInput): Promise<EngineRunResult> {
  const config = readEngineConfig();
  const dir = await prepareEngineRunDir(input.runId);

  const systemPath = join(dir, 'system.md');
  const promptPath = join(dir, 'prompt.md');
  await writeFile(systemPath, input.systemPrompt, 'utf8');
  await writeFile(promptPath, input.prompt, 'utf8');

  const wslSystem = await toWslPath(systemPath);
  const wslPrompt = await toWslPath(promptPath);
  const workspace = await prepareWslWorkspace(input);

  try {
    // Komut WSL kabuguna tek bir dize olarak verilir. Icindeki tum degerler
    // BIZIM urettigimiz yollar ve sabit bayraklar; kullanici metni yalniz
    // dosyalardan okunur.
    const flags = [
      '--print',
      '--output-format',
      'json',
      '--system-prompt-file',
      shellQuote(wslSystem),
      '--permission-mode',
      config.permissionMode,
    ];
    if (input.model) flags.push('--model', shellQuote(input.model));
    for (const root of workspace.workRoots) flags.push('--add-dir', shellQuote(root));
    flags.push(...buildClaudeAllowedToolsArgs(input.allowedTools));

    const timeoutSeconds = Math.ceil(config.timeoutMs / 1000);
    const command = buildWslEngineCommand({
      runId: input.runId,
      cwd: workspace.cwd,
      timeoutSeconds,
      engineCommand: `claude ${flags.join(' ')}`,
      promptPath: wslPrompt,
    });

    const started = Date.now();
    const child = spawnWslEngine(command);

    // Dis zamanlayici ic `timeout`tan sonra devreye girer: normal halde ic
    // taraf temiz kapatir, bu yalniz kabuk hic donmezse calisir.
    const outcome = await collectWslEngine(child, input.runId, {
      timeoutMs: config.timeoutMs + 30_000,
      signal: input.signal,
    });

    const timedOut = outcome.timedOut || outcome.exitCode === 124;
    const durationMs = Date.now() - started;
    const logPath = await writeEngineLog(
      join(dir, 'engine.log'),
      [
        `# komut`,
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

    return (
      interruptedResult(outcome, input.signal, logPath) ??
      parseClaudeCodeResult({
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exitCode: outcome.exitCode,
        timedOut,
        timeoutSeconds,
        logPath,
      })
    );
  } finally {
    await workspace.cleanup();
  }
}
