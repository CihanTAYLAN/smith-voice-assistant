import { newActorId, newAgentRunId, newWorkspaceId, type DbHandle } from '@smith/db';
import { parseQueuePayload, QueueName } from '@smith/queue';
import { createWorkspaceScope, type WorkspaceScope } from '@smith/tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { abandonExpiredRuns } = vi.hoisted(() => ({
  abandonExpiredRuns: vi.fn((..._args: unknown[]) => Promise.resolve<string[]>([])),
}));

vi.mock('@smith/mission', () => ({ abandonExpiredRuns }));

import { AGENT_RUN_RECONCILE_AFTER_MS, createAgentRunReconciler } from './agent-run-reconciler.js';

const workspaceId = newWorkspaceId();
const actorId = newActorId();
const scope = createWorkspaceScope({ workspaceId, actorId, role: 'member' });

function scopeOfNewWorkspace(): WorkspaceScope {
  return createWorkspaceScope({
    workspaceId: newWorkspaceId(),
    actorId: newActorId(),
    role: 'member',
  });
}

interface FakeJob {
  getState: () => Promise<string>;
  retry: (state: string) => Promise<void>;
}

function fixture(input: {
  runIds: string[];
  job?: FakeJob;
  now?: () => number;
  maxScopes?: number;
  scopeTtlMs?: number;
}) {
  const findMany = vi.fn(() => Promise.resolve(input.runIds.map((id) => ({ id }))));
  const tx = { $executeRaw: () => Promise.resolve(1), agentRun: { findMany } };
  const db = {
    prisma: { $transaction: <T>(fn: (value: typeof tx) => Promise<T>) => fn(tx) },
  } as unknown as DbHandle;
  const add = vi.fn((..._args: unknown[]) => Promise.resolve());
  const getJob = vi.fn((_runId: string) => Promise.resolve(input.job));
  const reconciler = createAgentRunReconciler({
    db,
    queue: { add, getJob } as never,
    ...(input.now ? { now: input.now } : {}),
    ...(input.maxScopes ? { maxScopes: input.maxScopes } : {}),
    ...(input.scopeTtlMs ? { scopeTtlMs: input.scopeTtlMs } : {}),
  });
  return { reconciler, findMany, add, getJob, db };
}

/** Taramada `abandonExpiredRuns`a verilen workspace kimlikleri (cagri sirasiyla). */
function sweptWorkspaces(): string[] {
  return abandonExpiredRuns.mock.calls.map((call) => (call[1] as WorkspaceScope).workspaceId);
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  abandonExpiredRuns.mockReset();
  abandonExpiredRuns.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AgentRun outbox reconciler', () => {
  it('yalniz 60 saniyeden eski queued runlari runId jobId ile yeniden kuyruklar', async () => {
    const now = new Date('2026-10-03T10:00:00.000Z');
    const runId = newAgentRunId();
    const { reconciler, findMany, add } = fixture({ runIds: [runId], now: () => now.getTime() });

    await reconciler.reconcile(scope);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        workspaceId,
        status: 'queued',
        startedAt: { lte: new Date(now.getTime() - AGENT_RUN_RECONCILE_AFTER_MS) },
      },
      select: { id: true },
    });
    expect(add).toHaveBeenCalledWith('run', { workspaceId, actorId, runId }, { jobId: runId });
    expect(parseQueuePayload(QueueName.AGENT_RUN, add.mock.calls[0]?.[1])).toMatchObject({
      workspaceId,
      actorId,
      runId,
    });
  });

  it('retained failed BullMQ jobini duplicate add yerine retry eder', async () => {
    const retry = vi.fn(() => Promise.resolve());
    const { reconciler, add } = fixture({
      runIds: [newAgentRunId()],
      job: { getState: () => Promise.resolve('failed'), retry },
    });

    await reconciler.reconcile(scope);

    expect(retry).toHaveBeenCalledWith('failed');
    expect(add).not.toHaveBeenCalled();
  });

  it.each(['waiting', 'active', 'delayed'])(
    'kuyrukta %s olan isi yeniden eklemez, retry etmez',
    async (state) => {
      const retry = vi.fn(() => Promise.resolve());
      const { reconciler, add } = fixture({
        runIds: [newAgentRunId()],
        job: { getState: () => Promise.resolve(state), retry },
      });

      await reconciler.reconcile(scope);

      expect(add).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
    },
  );

  it('ayni workspace icin eszamanli uzlastirmalar tek taramada birlesir', async () => {
    const { reconciler, findMany } = fixture({ runIds: [] });

    await Promise.all([reconciler.reconcile(scope), reconciler.reconcile(scope)]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(abandonExpiredRuns).toHaveBeenCalledTimes(1);
  });

  it('remember periyodik taramayi baslatir ve Redis hatasi taramayi durdurmaz', async () => {
    vi.useFakeTimers();
    const { reconciler, add } = fixture({ runIds: [newAgentRunId()] });
    add.mockRejectedValueOnce(new Error('redis kapali'));
    reconciler.remember(scope);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(add).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('uzlastirma basarisiz'));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(add).toHaveBeenCalledTimes(2);
  });
});

describe('lease dolmus running kosularin sonlandirilmasi', () => {
  it('reconcile sahipsiz kosulari paketin tek sonlandirma yoluyla kapatir ve uyarir', async () => {
    const orphan = newAgentRunId();
    abandonExpiredRuns.mockResolvedValueOnce([orphan]);
    const { reconciler, db } = fixture({ runIds: [] });

    await reconciler.reconcile(scope);

    expect(abandonExpiredRuns).toHaveBeenCalledWith(db, scope, expect.any(Function));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(orphan));
  });

  it('kuyrukta canli is sorgusu kuyruk durumuna bakar (active canli; failed ve kayitsiz degil)', async () => {
    const { reconciler, getJob } = fixture({ runIds: [] });
    await reconciler.reconcile(scope);
    const hasLiveJob = abandonExpiredRuns.mock.calls[0]?.[2] as (id: string) => Promise<boolean>;

    const states: Record<string, string | undefined> = {
      run_active: 'active',
      run_failed: 'failed',
      run_missing: undefined,
    };
    getJob.mockImplementation((id: string) => {
      const state = states[id];
      return Promise.resolve(
        state ? { getState: () => Promise.resolve(state) } : undefined,
      ) as never;
    });

    await expect(hasLiveJob('run_active')).resolves.toBe(true);
    await expect(hasLiveJob('run_failed')).resolves.toBe(false);
    await expect(hasLiveJob('run_missing')).resolves.toBe(false);
  });

  it('periyodik tarama sonlandirmayi da calistirir ve veritabani hatasi taramayi durdurmaz', async () => {
    vi.useFakeTimers();
    abandonExpiredRuns.mockRejectedValueOnce(new Error('db kapali'));
    const { reconciler } = fixture({ runIds: [] });
    reconciler.remember(scope);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(abandonExpiredRuns).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('uzlastirma basarisiz'));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(abandonExpiredRuns).toHaveBeenCalledTimes(2);
  });
});

describe('taranan workspace listesi sinirli (LRU ve TTL)', () => {
  it('sinir asilinca en az kullanilan workspace listeden dusurulur', async () => {
    vi.useFakeTimers();
    const { reconciler } = fixture({ runIds: [], maxScopes: 2 });
    const a = scopeOfNewWorkspace();
    const b = scopeOfNewWorkspace();
    const c = scopeOfNewWorkspace();

    reconciler.remember(a);
    reconciler.remember(b);
    reconciler.remember(a); // a yeniden kullanildi: en eski artik b
    reconciler.remember(c);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sweptWorkspaces().sort()).toEqual([a.workspaceId, c.workspaceId].sort());
  });

  it('uzun suredir istek gormeyen workspace taramadan ve listeden dusurulur', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const { reconciler } = fixture({ runIds: [], now: () => clock, scopeTtlMs: 10 * 60_000 });
    const stale = scopeOfNewWorkspace();
    const fresh = scopeOfNewWorkspace();

    reconciler.remember(stale);
    clock = 9 * 60_000;
    reconciler.remember(fresh);
    clock = 11 * 60_000; // stale 11 dk once goruldu (TTL 10 dk), fresh 2 dk once
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweptWorkspaces()).toEqual([fresh.workspaceId]);

    abandonExpiredRuns.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweptWorkspaces()).toEqual([fresh.workspaceId]);
  });

  it('varsayilan sinirlarda tek kullanicili kurulum her taramada listede kalir', async () => {
    vi.useFakeTimers();
    const { reconciler } = fixture({ runIds: [] });
    reconciler.remember(scope);

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(abandonExpiredRuns).toHaveBeenCalledTimes(5);
  });
});
