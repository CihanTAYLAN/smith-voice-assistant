import { describe, expect, it, vi } from 'vitest';

import { execCapture, isWindowsPath, shellQuote, toWslPath } from './wsl-path.js';

describe('execCapture', () => {
  it('yanit vermeyen yardimci sureci timeout ile durdurur', async () => {
    await expect(
      execCapture(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/50ms/);
  });

  it('sure icinde biten komutun ciktisini ve cikis kodunu dondurur', async () => {
    await expect(
      execCapture(process.execPath, ['-e', "process.stdout.write('tamam')"], { timeoutMs: 10_000 }),
    ).resolves.toMatchObject({ stdout: 'tamam', code: 0 });
  });
});

describe('toWslPath', () => {
  it('wslpath ciktisini WSL yoluna cevirir', async () => {
    const capture = vi.fn().mockResolvedValue({ stdout: '/mnt/c/repo\n', stderr: '', code: 0 });
    await expect(toWslPath('C:\\repo', capture)).resolves.toBe('/mnt/c/repo');
    expect(capture).toHaveBeenCalledWith('wsl.exe', ['-e', 'wslpath', '-a', 'C:\\repo']);
  });

  it('wslpath basarisiz olursa (cikis kodu) tahmin yurutmeden hata verir', async () => {
    const capture = vi.fn().mockResolvedValue({ stdout: '', stderr: 'boom', code: 1 });
    await expect(toWslPath('C:\\repo', capture)).rejects.toThrow(/cikis kodu 1/);
  });

  it('POSIX olmayan cikti yol sayilmaz', async () => {
    const capture = vi.fn().mockResolvedValue({ stdout: 'garip\n', stderr: '', code: 0 });
    await expect(toWslPath('C:\\repo', capture)).rejects.toThrow(/donusumu basarisiz/);
  });
});

describe('isWindowsPath', () => {
  it.each(['C:\\repo', 'c:/repo', '\\\\sunucu\\paylasim'])('%s Windows yoludur', (path) => {
    expect(isWindowsPath(path)).toBe(true);
  });

  it.each(['/home/alice/proje', '//wsl.localhost/Ubuntu', 'relative/path'])(
    '%s Windows yolu degildir',
    (path) => {
      expect(isWindowsPath(path)).toBe(false);
    },
  );
});

describe('shellQuote', () => {
  it.each([
    ['yol', "'yol'"],
    ['', "''"],
    ['bosluklu yol', "'bosluklu yol'"],
    ["O'Brien", String.raw`'O'\''Brien'`],
    ['$HOME `id` $(id) ; rm', "'$HOME `id` $(id) ; rm'"],
  ])('%j tek tirnakla guvenli alintilanir', (value, expected) => {
    expect(shellQuote(value)).toBe(expected);
  });
});
