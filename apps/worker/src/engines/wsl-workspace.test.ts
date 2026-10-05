import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareWslWorkspace } from './wsl-workspace.js';

const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });

describe('prepareWslWorkspace', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Windows koklerini wslpath ile cevirir, POSIX kokune dokunmaz', async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce(ok('/mnt/c/repo\n'))
      .mockResolvedValueOnce(ok('/mnt/d/extra\n'));
    const workspace = await prepareWslWorkspace(
      { runId: 'run_123', cwd: 'C:\\repo', workRoots: ['C:\\repo', '/home/x', 'D:\\extra'] },
      capture,
    );
    expect(workspace).toMatchObject({
      cwd: '/mnt/c/repo',
      workRoots: ['/mnt/c/repo', '/home/x', '/mnt/d/extra'],
    });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('cwd verilmezse ilk koku kullanir', async () => {
    const workspace = await prepareWslWorkspace(
      { runId: 'run_123', workRoots: ['/home/a', '/home/b'] },
      vi.fn(),
    );
    expect(workspace.cwd).toBe('/home/a');
  });

  it('is koklerinin disindaki cwd reddedilir (motor kok disina cikamaz)', async () => {
    await expect(
      prepareWslWorkspace({ runId: 'run_123', cwd: '/etc', workRoots: ['/home/a'] }, vi.fn()),
    ).rejects.toThrow(/is koklerinden biri degil/);
  });

  it('wslpath basarisizsa kosu baslamaz', async () => {
    const capture = vi.fn().mockResolvedValue({ stdout: '', stderr: 'x', code: 1 });
    await expect(
      prepareWslWorkspace({ runId: 'run_123', workRoots: ['C:\\repo'] }, capture),
    ).rejects.toThrow(/wslpath/);
  });

  it('bos kokte root sahipli 0555 gecici dizin kurar ve rmdir ile temizler', async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce(ok('/tmp/smith-mission-run_123.abcd\n'))
      .mockResolvedValueOnce(ok(''));
    const workspace = await prepareWslWorkspace({ runId: 'run_123', workRoots: [] }, capture);
    expect(workspace.cwd).toMatch(/^\/tmp\/smith-mission-run_123\./);
    expect(workspace.workRoots).toEqual([]);

    const create = capture.mock.calls[0]?.[1] as string[];
    expect(create.slice(0, 3)).toEqual(['-u', 'root', '-e']);
    expect(create.join(' ')).toContain('chmod 0555');

    await workspace.cleanup();
    expect(capture.mock.calls[1]?.[1]).toEqual([
      '-u',
      'root',
      '-e',
      'rmdir',
      '--',
      '/tmp/smith-mission-run_123.abcd',
    ]);
  });

  it('gecici dizin kurulamazsa WSL home yedegine dusmeden hata verir', async () => {
    const capture = vi.fn().mockResolvedValue({ stdout: '', stderr: 'denied', code: 1 });
    await expect(prepareWslWorkspace({ runId: 'run_123', workRoots: [] }, capture)).rejects.toThrow(
      /gecici WSL calisma dizini/,
    );
  });

  it('beklenmeyen yola isaret eden dizin ciktisini kabul etmez', async () => {
    const capture = vi.fn().mockResolvedValue(ok('/home/alice\n'));
    await expect(prepareWslWorkspace({ runId: 'run_123', workRoots: [] }, capture)).rejects.toThrow(
      /gecici WSL calisma dizini/,
    );
  });

  it('shell metakarakteri iceren runId reddedilir', async () => {
    await expect(
      prepareWslWorkspace({ runId: 'run; rm -rf ~', workRoots: [] }, vi.fn()),
    ).rejects.toThrow(/Gecersiz runId/);
  });

  it('temizlik basarisiz olsa da hata firlatmaz, stderr uzerinden bildirir', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const capture = vi
      .fn()
      .mockResolvedValueOnce(ok('/tmp/smith-mission-run_123.abcd\n'))
      .mockRejectedValueOnce(new Error('wsl yanit vermedi'));
    const workspace = await prepareWslWorkspace({ runId: 'run_123', workRoots: [] }, capture);

    await expect(workspace.cleanup()).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('/tmp/smith-mission-run_123.abcd'));
  });
});
