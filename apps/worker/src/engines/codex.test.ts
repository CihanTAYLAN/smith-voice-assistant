import { afterEach, describe, expect, it } from 'vitest';

import {
  assertPathDialect,
  buildCodexArgs,
  composePrompt,
  readCodexConfig,
  resolveCodexHost,
  runCodex,
  spawnWindows,
} from './codex.js';

/**
 * Bu testteki asil iddia GUVENLIK: motorun urettigi argumanlarda tehlikeli
 * bayrak BULUNMAZ ve sandbox allowlist disina cikamaz. "Calisiyor mu" sorusu
 * sahada olculur (bkz. docs); burada "yanlis sey gecmiyor mu" dogrulanir.
 */

const BASE_ARGS = {
  sandbox: 'workspace-write' as const,
  lastMessagePath: 'C:\\Users\\x\\.smith\\mission\\runs\\run_1\\last-message.txt',
  workRoots: ['/home/alice/proje'],
  model: null,
};

describe('buildCodexArgs', () => {
  it('beklenen bayraklari sirayla uretir ve prompt icin `-` koyar', () => {
    expect(buildCodexArgs(BASE_ARGS)).toEqual([
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '-s',
      'workspace-write',
      '--skip-git-repo-check',
      '--json',
      '-o',
      'C:\\Users\\x\\.smith\\mission\\runs\\run_1\\last-message.txt',
      '--add-dir',
      '/home/alice/proje',
      '-',
    ]);
  });

  it('TEHLIKELI bayraklari HICBIR KOSULDA uretmez', () => {
    const args = buildCodexArgs({ ...BASE_ARGS, model: 'gpt-5.3-codex' });
    for (const forbidden of [
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
      'danger-full-access',
      '--full-auto',
    ]) {
      expect(args).not.toContain(forbidden);
    }
  });

  it('model verilirse `-m` ekler, verilmezse eklemez', () => {
    expect(buildCodexArgs({ ...BASE_ARGS, model: 'gpt-5.3-codex' })).toContain('gpt-5.3-codex');
    expect(buildCodexArgs(BASE_ARGS)).not.toContain('-m');
  });

  it('her is koku icin bir `--add-dir` uretir', () => {
    const args = buildCodexArgs({
      ...BASE_ARGS,
      workRoots: ['/home/a', '/home/b'],
    });
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(2);
  });

  it('kullanici metnini argumana KOYMAZ (prompt stdin`den gelir)', () => {
    const args = buildCodexArgs(BASE_ARGS);
    expect(args.at(-1)).toBe('-');
    expect(args.join(' ')).not.toContain('GOREV');
  });
});

describe('assertPathDialect', () => {
  it('WSL motoruna Windows yolunu reddeder', () => {
    expect(() => assertPathDialect('wsl', ['C:\\projeler\\x'])).toThrow(/uygun degil/);
    expect(() => assertPathDialect('wsl', ['\\\\wsl.localhost\\Ubuntu\\home\\x'])).toThrow();
  });

  it('Windows motoruna POSIX yolunu reddeder', () => {
    expect(() => assertPathDialect('windows', ['/home/alice/proje'])).toThrow(/uygun degil/);
  });

  it('dogru lehceyi kabul eder', () => {
    expect(() => assertPathDialect('wsl', ['/home/alice/proje'])).not.toThrow();
    expect(() => assertPathDialect('windows', ['C:\\projeler\\x', 'C:/projeler/y'])).not.toThrow();
    expect(() => assertPathDialect('wsl', [])).not.toThrow();
  });
});

describe('composePrompt', () => {
  it('sistem prompt`unu gorev metninin onune koyar', () => {
    const composed = composePrompt({ systemPrompt: 'SOUL', prompt: 'Gorev: X' });
    expect(composed).toBe('SOUL\n\n--- GOREV ---\n\nGorev: X\n');
  });
});

describe('readCodexConfig', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('varsayilan makine `auto` ve sandbox workspace-write`tir', () => {
    delete process.env.SMITH_CODEX_HOST;
    delete process.env.SMITH_CODEX_SANDBOX;
    expect(readCodexConfig()).toMatchObject({ host: 'auto', sandbox: 'workspace-write' });
  });

  it('danger-full-access ve yazim hatasini acilista reddeder', () => {
    process.env.SMITH_CODEX_SANDBOX = 'danger-full-access';
    expect(() => readCodexConfig()).toThrow(/SMITH_CODEX_SANDBOX/);
    process.env.SMITH_CODEX_SANDBOX = 'read-ony';
    expect(() => readCodexConfig()).toThrow(/SMITH_CODEX_SANDBOX/);
    process.env.SMITH_CODEX_SANDBOX = 'read-only';
    expect(readCodexConfig().sandbox).toBe('read-only');
  });

  it('gecersiz hostu reddeder', () => {
    process.env.SMITH_CODEX_HOST = 'kubernetes';
    expect(() => readCodexConfig()).toThrow(/SMITH_CODEX_HOST/);
  });

  it('bos birakilan degeri verilmemis sayar', () => {
    process.env.SMITH_CODEX_HOST = '';
    process.env.SMITH_CODEX_SANDBOX = '';
    expect(readCodexConfig()).toMatchObject({ host: 'auto', sandbox: 'workspace-write' });
  });

  it('acikca secilen makineyi oldugu gibi tasir', () => {
    process.env.SMITH_CODEX_HOST = 'windows';
    expect(readCodexConfig().host).toBe('windows');
  });

  it('zaman asimi: varsayilan 15 dakika, gecerli deger okunur, gecersiz deger acilista reddedilir', () => {
    delete process.env.SMITH_CODEX_TIMEOUT_MS;
    expect(readCodexConfig().timeoutMs).toBe(15 * 60 * 1000);
    process.env.SMITH_CODEX_TIMEOUT_MS = '600000';
    expect(readCodexConfig().timeoutMs).toBe(600_000);
    process.env.SMITH_CODEX_TIMEOUT_MS = '5000';
    expect(() => readCodexConfig()).toThrow(/SMITH_CODEX_TIMEOUT_MS gecersiz: 5000/);
  });
});

describe('resolveCodexHost', () => {
  /**
   * Bu testlerin iddiasi: yazma yetkili kosu yalniz WSL'de gercek sandbox'a
   * sahiptir (Windows'ta `workspace-write` yazmayi reddediyor, olculdu); bu
   * yuzden Windows koklu is de WSL'de kosar ve kokler `wslpath` ile cevrilir.
   */
  it('auto yazma gorevini Windows kokunde de sandboxli WSL motoruna yollar', () => {
    expect(resolveCodexHost('auto', ['C:\\projeler\\x'])).toBe('wsl');
    expect(resolveCodexHost('auto', ['C:/projeler/x'])).toBe('wsl');
    expect(resolveCodexHost('auto', ['\\\\sunucu\\paylasim'])).toBe('wsl');
    expect(resolveCodexHost('auto', ['/home/alice/proje'])).toBe('wsl');
  });

  it('karisik Windows/POSIX koklerini WSL icinde birlestirir', () => {
    expect(resolveCodexHost('auto', ['/home/x', 'C:\\y'])).toBe('wsl');
  });

  it('bos kokte secimden bagimsiz WSL doner (bos salt-okunur dizin yalniz orada kurulur)', () => {
    expect(resolveCodexHost('auto', [])).toBe('wsl');
    expect(resolveCodexHost('windows', [])).toBe('wsl');
  });

  it('is kokleri varken acik secim turetmenin onune gecer', () => {
    expect(resolveCodexHost('windows', ['/home/x'])).toBe('windows');
    expect(resolveCodexHost('wsl', ['C:\\y'])).toBe('wsl');
  });
});

describe('Windows yazma kapisi', () => {
  it('acikca Windows secilse bile workspace-write kosusunu baslatmaz', async () => {
    await expect(
      runCodex({
        runId: 'run_test',
        systemPrompt: 'sistem',
        prompt: 'gorev',
        cwd: 'C:\\repo',
        workRoots: ['C:\\repo'],
        allowedTools: [],
        host: 'windows',
        sandbox: 'workspace-write',
      }),
    ).rejects.toThrow(/workspace-write Windows/);
  });
});

describe('spawnWindows', () => {
  it('cocuk prompt u okumadan cikarsa stdin hatasi worker surecini dusurmez', async () => {
    // Kucuk prompt boru tamponuna sigar ve hata dogmaz; tamponu asan prompt +
    // erken cikan cocuk `write EOF` / `EPIPE` uretir (dinleyici yoksa yakalanmamis istisna).
    const child = spawnWindows(process.execPath, ['-e', 'process.exit(0)'], {
      promptText: 'x'.repeat(4_000_000),
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('close', resolve);
    });

    expect(exitCode).toBe(0);
  });
});
