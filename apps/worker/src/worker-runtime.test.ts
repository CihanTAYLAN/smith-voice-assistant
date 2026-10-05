import { EventEmitter } from 'node:events';

import type { createQueueConnection, Worker } from '@smith/queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ActiveRunRegistry,
  attachConnectionDiagnostics,
  attachWorkerDiagnostics,
  closeWorkers,
  type WorkerLog,
} from './worker-runtime.js';

function recordingLog(): { log: WorkerLog; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { log: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

describe('ActiveRunRegistry', () => {
  it('shutdown tum etkin kosulara abort sinyali yollar', () => {
    const registry = new ActiveRunRegistry();
    const first = registry.begin();
    const second = registry.begin();
    registry.abortAll(new Error('SIGTERM'));
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    first.release();
    second.release();
    expect(registry.size).toBe(0);
  });
});

describe('attachWorkerDiagnostics', () => {
  /** BullMQ Worker bir EventEmitter'dir; gercek Redis baglantisi olmadan ayni olay yuzeyi. */
  function fakeWorker(): { worker: Worker; emit: (event: string, ...args: unknown[]) => boolean } {
    const emitter = Object.assign(new EventEmitter(), { name: 'agent-run' });
    return {
      worker: emitter as unknown as Worker,
      emit: (event, ...args) => emitter.emit(event, ...args),
    };
  }

  it('error olayi sureci dusurmez ve secret log kaydina girmez', () => {
    const { worker, emit } = fakeWorker();
    const { log, err } = recordingLog();
    attachWorkerDiagnostics(worker, log);

    const secret = `sk-${'A'.repeat(40)}`;
    expect(() => emit('error', new Error(`ECONNRESET ${secret}`))).not.toThrow();
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('agent-run');
    expect(err[0]).not.toContain(secret);
  });

  it('stalled ve failed olaylarini hata, completed olayini normal cikti yazar', () => {
    const { worker, emit } = fakeWorker();
    const { log, out, err } = recordingLog();
    attachWorkerDiagnostics(worker, log);

    emit('stalled', 'job_1');
    emit('failed', { id: 'job_2' }, new Error('patladi'));
    emit('completed', { id: 'job_3' });

    expect(err).toEqual([
      'is stalled (agent-run/job_1)',
      'is basarisiz (agent-run/job_2): patladi',
    ]);
    expect(out).toEqual(['is tamam (agent-run/job_3)']);
  });
});

describe('attachConnectionDiagnostics', () => {
  it('Redis error olayi sureci dusurmez; yeniden baglanma ve hazir gecisleri gorunur', () => {
    const connection = new EventEmitter() as unknown as ReturnType<typeof createQueueConnection>;
    const { log, out, err } = recordingLog();
    attachConnectionDiagnostics(connection, log);

    expect(() => connection.emit('error', new Error('connect ECONNREFUSED'))).not.toThrow();
    connection.emit('reconnecting', 2000);
    connection.emit('ready');

    expect(err).toEqual([
      'Redis baglanti hatasi: connect ECONNREFUSED',
      'Redis yeniden baglaniyor (2000ms)',
    ]);
    expect(out).toEqual(['Redis baglantisi hazir']);
  });
});

describe('closeWorkers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sure dolmadan kapanirsa zorlamaz', async () => {
    const close = vi.fn(() => Promise.resolve());
    await expect(closeWorkers([{ close }], 1_000)).resolves.toBe('graceful');
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith();
  });

  /**
   * Gercek BullMQ davranisi (5.81.3, `Worker.close`): kapanis bir kez basladiysa
   * ikinci cagri AYNI bekleyen sozu doner ve `force` yok sayilir. Takili bir is
   * (or. cevap vermeyen gomme cagrisi) kapanisi sonsuza dek bekletir.
   */
  function bullmqLikeWorker(): {
    close: (force?: boolean) => Promise<void>;
    closeCalls: Array<boolean | undefined>;
  } {
    let closing: Promise<void> | undefined;
    const closeCalls: Array<boolean | undefined> = [];
    return {
      closeCalls,
      close: (force) => {
        closeCalls.push(force);
        return (closing ??= new Promise<void>(() => undefined));
      },
    };
  }

  it('aktif is sure icinde bitmezse "forced" doner: ikinci close(true) cagrisi sozu cozmez, beklenmez', async () => {
    vi.useFakeTimers();
    const worker = bullmqLikeWorker();

    const closing = closeWorkers([worker], 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(closing).resolves.toBe('forced');
    // Etkisiz zorlama cagrisi yapilmaz: close yalniz nazik kapanis icin bir kez cagrilir.
    expect(worker.closeCalls).toEqual([undefined]);
  });

  it('bir worker takili digeri temiz kapaniyorsa yine sure sonunda "forced" doner', async () => {
    vi.useFakeTimers();
    const hung = bullmqLikeWorker();
    const clean = { close: vi.fn(() => Promise.resolve()) };

    const closing = closeWorkers([clean, hung], 500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(closing).resolves.toBe('forced');
  });
});
