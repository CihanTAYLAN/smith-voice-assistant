import { spawn } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { collectProcess, interruptedResult, type ProcessOutcome } from './process-control.js';

function node(script: string) {
  return spawn(process.execPath, ['-e', script]);
}

const IDLE = 'setInterval(() => undefined, 1000)';

describe('collectProcess', () => {
  it('stdout, stderr ve cikis kodunu toplar', async () => {
    const outcome = await collectProcess(
      node("process.stdout.write('merhaba'); process.stderr.write('uyari')"),
      { timeoutMs: 10_000 },
    );
    expect(outcome).toMatchObject({
      exitCode: 0,
      stdout: 'merhaba',
      stderr: 'uyari',
      timedOut: false,
      outputExceeded: false,
      aborted: false,
    });
  });

  it('sinirsiz cikti yayan sureci bellek siniri asilinca durdurur', async () => {
    const flood =
      "const chunk = 'x'.repeat(65536); setInterval(() => process.stdout.write(chunk), 1)";
    const outcome = await collectProcess(node(flood), { timeoutMs: 20_000, maxOutputBytes: 1_024 });

    expect(outcome.outputExceeded).toBe(true);
    expect(Buffer.byteLength(outcome.stdout)).toBeLessThanOrEqual(1_024);
  });

  it('iptal sinyali sureci durdurur', async () => {
    const controller = new AbortController();
    const collecting = collectProcess(node(IDLE), { timeoutMs: 20_000, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('worker kapaniyor')), 100);

    const outcome = await collecting;
    expect(outcome.aborted).toBe(true);
    expect(outcome.timedOut).toBe(false);
  });

  it('baslamadan iptal edilmis sinyalle sureci hemen durdurur', async () => {
    const controller = new AbortController();
    controller.abort(new Error('onceden iptal'));
    const outcome = await collectProcess(node(IDLE), {
      timeoutMs: 20_000,
      signal: controller.signal,
    });
    expect(outcome.aborted).toBe(true);
  });

  it('sure dolunca sureci durdurur', async () => {
    const outcome = await collectProcess(node(IDLE), { timeoutMs: 150 });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.aborted).toBe(false);
  });
});

describe('collectProcess uzak durdurma (WSL tarafi)', () => {
  /** Uzak durdurma gercekten bitene kadar sonuc donmemelidir: kosu "durdu" derken motor yasamasin. */
  function slowRemoteStop() {
    const state = { finished: false };
    const stopRemote = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      state.finished = true;
    });
    return { state, stopRemote };
  }

  it('iptalde bir kez calisir ve sonuc donmeden tamamlanir', async () => {
    const { state, stopRemote } = slowRemoteStop();
    const controller = new AbortController();
    const collecting = collectProcess(node(IDLE), {
      timeoutMs: 20_000,
      signal: controller.signal,
      stopRemote,
    });
    setTimeout(() => controller.abort(new Error('worker kapaniyor')), 100);

    const outcome = await collecting;

    expect(outcome.aborted).toBe(true);
    expect(stopRemote).toHaveBeenCalledTimes(1);
    expect(state.finished).toBe(true);
  });

  it('zaman asiminda calisir', async () => {
    const { state, stopRemote } = slowRemoteStop();

    const outcome = await collectProcess(node(IDLE), { timeoutMs: 150, stopRemote });

    expect(outcome.timedOut).toBe(true);
    expect(stopRemote).toHaveBeenCalledTimes(1);
    expect(state.finished).toBe(true);
  });

  it('cikti siniri asilinca (stdout ve stderr ikisi de asarsa bile) bir kez calisir', async () => {
    const { stopRemote } = slowRemoteStop();
    const flood =
      "const chunk = 'x'.repeat(65536); setInterval(() => { process.stdout.write(chunk); process.stderr.write(chunk); }, 1)";

    const outcome = await collectProcess(node(flood), {
      timeoutMs: 20_000,
      maxOutputBytes: 1_024,
      stopRemote,
    });

    expect(outcome.outputExceeded).toBe(true);
    expect(stopRemote).toHaveBeenCalledTimes(1);
  });

  it('surec kendiliginden biterse calismaz', async () => {
    const { stopRemote } = slowRemoteStop();

    const outcome = await collectProcess(node("process.stdout.write('tamam')"), {
      timeoutMs: 10_000,
      stopRemote,
    });

    expect(outcome.exitCode).toBe(0);
    expect(stopRemote).not.toHaveBeenCalled();
  });
});

describe('interruptedResult', () => {
  const normal: ProcessOutcome = {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    outputExceeded: false,
    aborted: false,
  };

  it('normal biten kosu icin null doner', () => {
    expect(interruptedResult(normal, undefined, 'engine.log')).toBeNull();
  });

  it('cikti siniri asilan kosuyu basarisiz sonuc yapar', () => {
    expect(interruptedResult({ ...normal, outputExceeded: true }, undefined, 'engine.log')).toEqual(
      {
        ok: false,
        text: 'Motor cikti sinirini asti ve surec agaci durduruldu.',
        exitCode: 0,
        timedOut: false,
        logPath: 'engine.log',
      },
    );
  });

  it('iptal sebebini sonuca yazar', () => {
    const controller = new AbortController();
    controller.abort(new Error('SIGTERM: worker kapaniyor'));
    const result = interruptedResult({ ...normal, aborted: true }, controller.signal, 'engine.log');
    expect(result).toMatchObject({ ok: false, text: 'Kosu durduruldu: SIGTERM: worker kapaniyor' });
  });
});
