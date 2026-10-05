import { newActorId, newAgentRunId, newWorkspaceId, type DbHandle } from '@smith/db';
import { describe, expect, it, vi } from 'vitest';

const { abandonExpiredRuns, executor } = vi.hoisted(() => ({
  abandonExpiredRuns: vi.fn((..._args: unknown[]) => Promise.resolve<string[]>([])),
  executor: { enabled: true },
}));

vi.mock('@smith/mission', () => ({ abandonExpiredRuns }));
vi.mock('./engines/executor.js', () => ({ isMissionExecutorEnabled: () => executor.enabled }));

import {
  collectQueueScopes,
  recoverAfterRestart,
  recoverOrphanEngines,
  recoverStaleRuns,
} from './recovery.js';
import type { WorkerLog } from './worker-runtime.js';

function recordingLog(): { log: WorkerLog; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { log: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

interface FakeJob {
  data: unknown;
  getState: () => Promise<string>;
}

function jobFor(workspaceId: string, actorId: string | undefined, state = 'failed'): FakeJob {
  return {
    data: { workspaceId, ...(actorId ? { actorId } : {}), runId: newAgentRunId() },
    getState: () => Promise.resolve(state),
  };
}

function queueOf(jobs: FakeJob[], byId: Record<string, string> = {}) {
  const getJobs = vi.fn((..._args: unknown[]) => Promise.resolve(jobs));
  const getJob = vi.fn((id: string) => {
    const state = byId[id];
    return Promise.resolve(state ? { getState: () => Promise.resolve(state) } : undefined);
  });
  return { getJobs, getJob } as never;
}

describe('collectQueueScopes', () => {
  it('kuyruktaki islerin workspace kapsamlarini workspace basina bir kez toplar', async () => {
    const wsA = newWorkspaceId();
    const wsB = newWorkspaceId();
    const actor = newActorId();
    const queue = queueOf([
      jobFor(wsA, actor),
      jobFor(wsA, actor, 'active'),
      jobFor(wsB, actor, 'completed'),
    ]);

    const scopes = await collectQueueScopes(queue);

    expect(scopes.map((scope) => scope.workspaceId).sort()).toEqual([wsA, wsB].sort());
    expect(scopes.every((scope) => scope.actorId === actor && scope.role === 'member')).toBe(true);
  });

  it('actor kimligi olmayan ve bozuk yuklu isleri atlar (kapsamsiz kosu yasak)', async () => {
    const ws = newWorkspaceId();
    const queue = queueOf([
      jobFor(ws, undefined),
      { data: { workspaceId: 'bozuk' }, getState: () => Promise.resolve('failed') },
    ]);

    await expect(collectQueueScopes(queue)).resolves.toEqual([]);
  });

  it('tum canli ve izi tutulan durumlara bakar', async () => {
    const getJobs = vi.fn((..._args: unknown[]) => Promise.resolve([]));

    await collectQueueScopes({ getJobs });

    const states = getJobs.mock.calls[0]?.[0];
    expect(states).toEqual(
      expect.arrayContaining([
        'active',
        'waiting',
        'delayed',
        'prioritized',
        'failed',
        'completed',
      ]),
    );
  });
});

describe('recoverStaleRuns', () => {
  const db = {} as DbHandle;

  it('her workspace icin sahipsiz kosulari paketin tek yoluyla sonlandirir ve loglar', async () => {
    const wsA = newWorkspaceId();
    const wsB = newWorkspaceId();
    const actor = newActorId();
    const orphan = newAgentRunId();
    abandonExpiredRuns.mockReset();
    abandonExpiredRuns.mockResolvedValueOnce([orphan]).mockResolvedValueOnce([]);
    const { log, out } = recordingLog();

    const abandoned = await recoverStaleRuns({
      db,
      queue: queueOf([jobFor(wsA, actor), jobFor(wsB, actor)]),
      log,
    });

    expect(abandoned).toEqual([orphan]);
    expect(abandonExpiredRuns).toHaveBeenCalledTimes(2);
    expect(abandonExpiredRuns).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ workspaceId: wsA }),
      expect.any(Function),
    );
    expect(out).toEqual([`sahipsiz AgentRun sonlandirildi: ${orphan}`]);
  });

  it('kuyrukta canli is sorgusu kuyruk durumuna bakar', async () => {
    abandonExpiredRuns.mockReset();
    abandonExpiredRuns.mockResolvedValue([]);
    const live = newAgentRunId();
    const dead = newAgentRunId();
    const queue = queueOf([jobFor(newWorkspaceId(), newActorId())], {
      [live]: 'waiting',
      [dead]: 'failed',
    });

    await recoverStaleRuns({ db, queue, log: recordingLog().log });

    const hasLiveJob = abandonExpiredRuns.mock.calls[0]?.[2] as (id: string) => Promise<boolean>;
    await expect(hasLiveJob(live)).resolves.toBe(true);
    await expect(hasLiveJob(dead)).resolves.toBe(false);
    await expect(hasLiveJob(newAgentRunId())).resolves.toBe(false);
  });

  it('bir workspace hata verirse digerleri yine taranir (acilis taramasi worker i durdurmaz)', async () => {
    const actor = newActorId();
    abandonExpiredRuns.mockReset();
    abandonExpiredRuns.mockRejectedValueOnce(new Error('db kapali')).mockResolvedValueOnce([]);
    const { log, err } = recordingLog();

    await recoverStaleRuns({
      db,
      queue: queueOf([jobFor(newWorkspaceId(), actor), jobFor(newWorkspaceId(), actor)]),
      log,
    });

    expect(abandonExpiredRuns).toHaveBeenCalledTimes(2);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('db kapali');
  });
});

describe('recoverOrphanEngines', () => {
  it('Windows disinda ve executor kapaliyken WSL e hic dokunmaz', async () => {
    const sweep = vi.fn(() => Promise.resolve<string[]>([]));
    const { log } = recordingLog();

    executor.enabled = true;
    await recoverOrphanEngines({ log, platform: 'linux', sweep });
    executor.enabled = false;
    await recoverOrphanEngines({ log, platform: 'win32', sweep });

    expect(sweep).not.toHaveBeenCalled();
  });

  it('Windows ve executor aciksa yetim motorlari supurur ve loglar', async () => {
    executor.enabled = true;
    const run = newAgentRunId();
    const sweep = vi.fn(() => Promise.resolve([run]));
    const { log, out } = recordingLog();

    await expect(recoverOrphanEngines({ log, platform: 'win32', sweep })).resolves.toEqual([run]);

    expect(out).toEqual([`yetim WSL motoru durduruldu: ${run}`]);
  });
});

describe('recoverAfterRestart', () => {
  it('iki taramayi da calistirir; biri patlarsa digeri yine kosar ve hata loglanir', async () => {
    executor.enabled = true;
    abandonExpiredRuns.mockReset();
    abandonExpiredRuns.mockResolvedValue([]);
    const sweep = vi.fn(() => Promise.reject(new Error('wsl yok')));
    const { log, err } = recordingLog();

    await expect(
      recoverAfterRestart({
        db: {} as DbHandle,
        queue: queueOf([jobFor(newWorkspaceId(), newActorId())]),
        log,
        platform: 'win32',
        sweep,
      }),
    ).resolves.toBeUndefined();

    expect(abandonExpiredRuns).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(err.join('\n')).toContain('wsl yok');
  });
});
