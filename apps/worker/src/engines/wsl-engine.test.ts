import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildWslEngineCommand,
  collectWslEngine,
  parseEngineProcessList,
  stopWslEngine,
  sweepOrphanWslEngines,
} from './wsl-engine.js';

const RUN = 'run_abcdefghij0123456789';
const OTHER_RUN = 'run_zyxwvutsrq9876543210';

type Capture = NonNullable<Parameters<typeof stopWslEngine>[1]>;

function capturing(result: { stdout?: string; stderr?: string; code: number | null }): {
  capture: Capture;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const capture: Capture = (command, args) => {
    calls.push({ command, args });
    return Promise.resolve({
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      code: result.code,
    });
  };
  return { capture, calls };
}

describe('buildWslEngineCommand', () => {
  it('cd, isaret degiskenleri, exec timeout ve stdin yonlendirmesini sirasiyla kurar', () => {
    expect(
      buildWslEngineCommand({
        runId: RUN,
        cwd: '/home/alice/proje',
        timeoutSeconds: 420,
        engineCommand: "claude '--print'",
        promptPath: '/mnt/c/x/prompt.md',
        ownerPid: 4321,
      }),
    ).toBe(
      `cd '/home/alice/proje' && SMITH_RUN_ID='${RUN}' SMITH_RUN_OWNER=4321 ` +
        "exec timeout --signal=TERM --kill-after=20s 420s claude '--print' < '/mnt/c/x/prompt.md'",
    );
  });

  it('cwd yoksa cd eklemez; sahip varsayilani bu worker surecidir', () => {
    const command = buildWslEngineCommand({
      runId: RUN,
      timeoutSeconds: 60,
      engineCommand: 'codex exec -',
      promptPath: '/tmp/p.md',
    });
    expect(command.startsWith(`SMITH_RUN_ID='${RUN}' SMITH_RUN_OWNER=${process.pid} exec `)).toBe(
      true,
    );
    expect(command).not.toContain('cd ');
  });

  it('cwd ve prompt yolundaki tirnagi alintilar (kabuga sizmaz)', () => {
    const command = buildWslEngineCommand({
      runId: RUN,
      cwd: "/home/o'brien/proje",
      timeoutSeconds: 60,
      engineCommand: 'claude',
      promptPath: "/tmp/it's.md",
    });
    expect(command).toContain(String.raw`cd '/home/o'\''brien/proje' && `);
    expect(command).toContain(String.raw`< '/tmp/it'\''s.md'`);
  });

  it('exec kullanir: kabuk araya girmez, istemci olunce HUP zinciri grubu da kapatir', () => {
    expect(
      buildWslEngineCommand({
        runId: RUN,
        timeoutSeconds: 60,
        engineCommand: 'claude',
        promptPath: '/tmp/p.md',
      }),
    ).toMatch(/ exec timeout /);
  });

  it.each(['', 'run; rm -rf ~', "run'x", 'run$(id)', 'run x'])(
    'gecersiz runId %j kabuk komutuna girmeden reddedilir',
    (runId) => {
      expect(() =>
        buildWslEngineCommand({
          runId,
          timeoutSeconds: 60,
          engineCommand: 'claude',
          promptPath: '/tmp/p.md',
        }),
      ).toThrow(/Gecersiz runId/);
    },
  );
});

describe('parseEngineProcessList', () => {
  it('pid basina runId ve sahip kimligini toplar', () => {
    const output = [
      '/proc/101/environ:SMITH_RUN_OWNER=4321',
      `/proc/101/environ:SMITH_RUN_ID=${RUN}`,
      `/proc/202/environ:SMITH_RUN_ID=${RUN}`,
      '/proc/202/environ:SMITH_RUN_OWNER=4321',
      `/proc/303/environ:SMITH_RUN_ID=${OTHER_RUN}`,
      '/proc/303/environ:SMITH_RUN_OWNER=99',
    ].join('\n');

    expect(parseEngineProcessList(output)).toEqual([
      { pid: 101, runId: RUN, ownerPid: 4321 },
      { pid: 202, runId: RUN, ownerPid: 4321 },
      { pid: 303, runId: OTHER_RUN, ownerPid: 99 },
    ]);
  });

  it('sahip bilgisi eksik ya da bozuksa null olur (sahipsiz sayilir)', () => {
    const output = [
      `/proc/101/environ:SMITH_RUN_ID=${RUN}`,
      `/proc/202/environ:SMITH_RUN_ID=${OTHER_RUN}`,
      '/proc/202/environ:SMITH_RUN_OWNER=abc',
    ].join('\n');

    expect(parseEngineProcessList(output)).toEqual([
      { pid: 101, runId: RUN, ownerPid: null },
      { pid: 202, runId: OTHER_RUN, ownerPid: null },
    ]);
  });

  it('gurultuyu, bos satiri ve gecersiz runId yi yok sayar (durdurma betigine girmez)', () => {
    const output = [
      '',
      'grep: /proc/55/environ: Permission denied',
      '/proc/9/environ:SMITH_RUN_ID=run; rm -rf ~',
      `/proc/10/environ:SMITH_RUN_ID=${RUN}`,
      '/proc/10/environ:SMITH_RUN_OWNER=7',
      '/proc/xyz/environ:SMITH_RUN_ID=run_1',
    ].join('\r\n');

    expect(parseEngineProcessList(output)).toEqual([{ pid: 10, runId: RUN, ownerPid: 7 }]);
  });
});

describe('stopWslEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runId yi tek tirnakli isaret olarak betige koyar; once TERM sonra KILL gonderir', async () => {
    const { capture, calls } = capturing({ code: 0 });

    await stopWslEngine(RUN, capture);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('wsl.exe');
    expect(calls[0]?.args.slice(0, 3)).toEqual(['-e', 'bash', '-c']);
    const script = calls[0]?.args[3] ?? '';
    expect(script).toContain(`'SMITH_RUN_ID=${RUN}'`);
    expect(script.indexOf('kill -TERM')).toBeGreaterThan(-1);
    expect(script.indexOf('kill -KILL')).toBeGreaterThan(script.indexOf('kill -TERM'));
  });

  it('betik aileyi tamamen durduramazsa (cikis kodu != 0) uyari yazar, firlatmaz', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { capture } = capturing({ code: 1, stdout: 'KALAN:123 456' });

    await expect(stopWslEngine(RUN, capture)).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(RUN));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('KALAN:123 456'));
  });

  it('WSL yanit vermezse (zaman asimi) uyari yazar, firlatmaz', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const capture: Capture = () =>
      Promise.reject(new Error('wsl.exe 15000ms icinde tamamlanmadi.'));

    await expect(stopWslEngine(RUN, capture)).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('15000ms'));
  });

  it('gecersiz runId WSL e hic gitmez, firlatmaz', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { capture, calls } = capturing({ code: 0 });

    await expect(stopWslEngine('run; rm -rf ~', capture)).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Gecersiz runId'));
  });
});

describe('sweepOrphanWslEngines', () => {
  const listing = (...rows: Array<[number, string, number | null]>): string =>
    rows
      .flatMap(([pid, runId, owner]) => [
        `/proc/${pid}/environ:SMITH_RUN_ID=${runId}`,
        ...(owner === null ? [] : [`/proc/${pid}/environ:SMITH_RUN_OWNER=${owner}`]),
      ])
      .join('\n');

  it('sahibi olmus surecin kosusunu durdurur; sahibi yasayan ve kendi kosusunu birakir', async () => {
    const { capture } = capturing({
      code: 0,
      stdout: listing([1, RUN, 111], [2, RUN, 111], [3, OTHER_RUN, 222]),
    });
    const stop = vi.fn((_runId: string) => Promise.resolve());

    const swept = await sweepOrphanWslEngines({
      capture,
      stop,
      isOwnerAlive: (pid) => pid === 222,
    });

    expect(swept).toEqual([RUN]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(RUN);
  });

  it('sahip bilgisi olmayan surec orfan sayilir', async () => {
    const { capture } = capturing({ code: 0, stdout: listing([1, RUN, null]) });
    const stop = vi.fn((_runId: string) => Promise.resolve());

    await expect(
      sweepOrphanWslEngines({ capture, stop, isOwnerAlive: () => true }),
    ).resolves.toEqual([RUN]);
  });

  it('kendi worker surecinin kosusunu asla durdurmaz', async () => {
    const { capture } = capturing({ code: 0, stdout: listing([1, RUN, process.pid]) });
    const stop = vi.fn((_runId: string) => Promise.resolve());

    await expect(sweepOrphanWslEngines({ capture, stop })).resolves.toEqual([]);
    expect(stop).not.toHaveBeenCalled();
  });

  it('hic motor yoksa hicbir seyi durdurmaz', async () => {
    const { capture } = capturing({ code: 0, stdout: '' });
    const stop = vi.fn((_runId: string) => Promise.resolve());

    await expect(sweepOrphanWslEngines({ capture, stop })).resolves.toEqual([]);
    expect(stop).not.toHaveBeenCalled();
  });

  it('listeleme basarisizsa sessiz gecmez: hata verir', async () => {
    const { capture } = capturing({ code: 1, stderr: 'WSL yok' });

    await expect(sweepOrphanWslEngines({ capture })).rejects.toThrow(/WSL motor listesi/);
  });
});

describe('collectWslEngine', () => {
  const node = (script: string) => spawn(process.execPath, ['-e', script]);

  it('ic timeout 124 ile bitirirse (dis zamanlayici degil) ayri oturuma kacan torunlar icin de durdurur', async () => {
    const stop = vi.fn((_runId: string) => Promise.resolve());

    const outcome = await collectWslEngine(
      node('process.exit(124)'),
      RUN,
      { timeoutMs: 10_000 },
      stop,
    );

    expect(outcome.exitCode).toBe(124);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(RUN);
  });

  it('normal bitiste durdurmaz', async () => {
    const stop = vi.fn((_runId: string) => Promise.resolve());

    const outcome = await collectWslEngine(
      node("process.stdout.write('tamam')"),
      RUN,
      { timeoutMs: 10_000 },
      stop,
    );

    expect(outcome.exitCode).toBe(0);
    expect(stop).not.toHaveBeenCalled();
  });

  it('iptalde collectProcess kancasi yoluyla yalniz bir kez durdurur', async () => {
    const stop = vi.fn((_runId: string) => Promise.resolve());
    const controller = new AbortController();
    const collecting = collectWslEngine(
      node('setInterval(() => undefined, 1000)'),
      RUN,
      { timeoutMs: 20_000, signal: controller.signal },
      stop,
    );
    setTimeout(() => controller.abort(new Error('worker kapaniyor')), 100);

    const outcome = await collecting;

    expect(outcome.aborted).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(RUN);
  });
});
