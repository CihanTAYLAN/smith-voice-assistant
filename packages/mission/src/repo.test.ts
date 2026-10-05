import {
  newActorId,
  newAgentId,
  newAgentRunId,
  newTaskId,
  newWorkspaceId,
  withScope,
  type DbHandle,
  type Tx,
} from '@smith/db';
import { createWorkspaceScope } from '@smith/tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_RUN_LEASE_MS,
  abandonExpiredRuns,
  ActiveRunLeaseError,
  assignTask,
  claimRun,
  finishRun,
  heartbeatRun,
  listComments,
  listExpiredRunningRuns,
  lockTaskForRunCompletion,
  moveTask,
  setAgentStatus,
  toStorableExitCode,
} from './repo.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class AsyncMutex {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.locked = true;
    }

    return () => {
      const next = this.waiters.shift();
      if (next) next();
      else this.locked = false;
    };
  }
}

const workspaceId = newWorkspaceId();
const actorId = newActorId();
const taskId = newTaskId();
const agentId = newAgentId();
const runId = newAgentRunId();
const now = new Date('2026-10-03T12:00:00.000Z');
const scope = createWorkspaceScope({ workspaceId, actorId, role: 'member' });

type StatusFilter = string | { in: string[] } | undefined;

function statusMatches(filter: StatusFilter, status: string): boolean {
  if (filter === undefined) return true;
  return typeof filter === 'string' ? filter === status : filter.in.includes(status);
}

class YarisVeritabani {
  readonly taskUpdateReached = deferred();
  readonly allowTaskUpdate = deferred();
  readonly lockSql: string[] = [];
  readonly findManyCalls: Array<{ where: unknown; take?: number | undefined }> = [];
  readonly events: Record<string, unknown>[] = [];
  /** Task kilidi alinirken (baska yazarin isi araya girerken) calisan kanca. */
  onTaskLock: (() => void) | undefined;

  readonly task = {
    id: taskId,
    workspaceId,
    title: 'Yaris gorevi',
    detail: null,
    status: 'assigned',
    priority: 2,
    assigneeId: agentId as string | null,
    parentId: null,
    deliverable: null,
    artifactPath: null,
    createdBy: actorId,
    dueAt: null,
    startedAt: null as Date | null,
    finishedAt: null as Date | null,
    createdAt: now,
    updatedAt: now,
  };

  readonly agent = {
    id: agentId,
    workspaceId,
    slug: 'nova',
    device: 'windows',
    status: 'idle',
  };

  readonly run = {
    id: runId,
    workspaceId,
    taskId,
    agentId,
    device: 'windows',
    engine: 'codex',
    status: 'queued',
    externalSessionId: null,
    exitCode: null,
    costMicros: 0,
    inputTokens: null,
    outputTokens: null,
    logPath: null,
    startedAt: now,
    heartbeatAt: null as Date | null,
    finishedAt: null as Date | null,
  };

  readonly createdRuns: Array<Record<string, unknown>> = [];

  private readonly taskMutex = new AsyncMutex();

  /** Calisan kosu: son atisi `agoMs` once atilmis. */
  runningSince(agoMs: number): void {
    const beat = new Date(now.getTime() - agoMs);
    Object.assign(this.run, { status: 'running', startedAt: beat, heartbeatAt: beat });
    this.task.status = 'in_progress';
    this.agent.status = 'working';
  }

  handle(): DbHandle {
    const task = this.task;
    const prisma = {
      $transaction: async <T>(fn: (tx: object) => Promise<T>): Promise<T> => {
        let releaseTaskLock: (() => void) | undefined;
        const tx = {
          $executeRaw: (): Promise<number> => Promise.resolve(1),
          $queryRaw: async (strings: TemplateStringsArray): Promise<unknown[]> => {
            const sql = strings.join('?');
            if (!sql.includes('FOR UPDATE')) return [];
            // Ayni transaction ayni satir kilidini yeniden alabilir (re-entrant).
            releaseTaskLock ??= await this.taskMutex.acquire();
            this.lockSql.push(sql);
            this.onTaskLock?.();
            return [this.task];
          },
          task: {
            update: async (args: { data: Partial<typeof task> }): Promise<typeof task> => {
              this.taskUpdateReached.resolve();
              await this.allowTaskUpdate.promise;
              Object.assign(task, args.data);
              return task;
            },
          },
          agent: {
            findFirst: (): Promise<typeof this.agent> => Promise.resolve(this.agent),
            updateMany: (args: {
              where: { status?: StatusFilter };
              data: { status?: string };
            }): Promise<{ count: number }> => {
              // Kosullu gecis (`WHERE status IN (...)`) gercek veritabani gibi sayim doner.
              if (!statusMatches(args.where.status, this.agent.status)) {
                return Promise.resolve({ count: 0 });
              }
              Object.assign(this.agent, args.data);
              return Promise.resolve({ count: 1 });
            },
          },
          agentRun: {
            findMany: (args: {
              where: { status?: StatusFilter };
              take?: number;
            }): Promise<Array<typeof this.run>> => {
              this.findManyCalls.push(args);
              return Promise.resolve(
                statusMatches(args.where.status, this.run.status) ? [{ ...this.run }] : [],
              );
            },
            findFirst: (args: {
              where: { id?: string; workspaceId?: string; taskId?: string; status?: StatusFilter };
            }): Promise<typeof this.run | null> => {
              const matches =
                (!args.where.id || args.where.id === this.run.id) &&
                (!args.where.workspaceId || args.where.workspaceId === this.run.workspaceId) &&
                (!args.where.taskId || args.where.taskId === this.run.taskId) &&
                statusMatches(args.where.status, this.run.status);
              // Gercek istemci gibi anlik GORUNTU doner (sonraki yazimlar onu degistirmez).
              return Promise.resolve(matches ? { ...this.run } : null);
            },
            create: (args: { data: Record<string, unknown> }): Promise<Record<string, unknown>> => {
              this.createdRuns.push(args.data);
              return Promise.resolve(args.data);
            },
            updateMany: (args: {
              where: {
                id?: string;
                workspaceId?: string;
                taskId?: string;
                status?: StatusFilter;
                heartbeatAt?: Date | null;
              };
              data: { status?: string; startedAt?: Date; heartbeatAt?: Date; finishedAt?: Date };
            }): Promise<{ count: number }> => {
              const beatMatches =
                !('heartbeatAt' in args.where) ||
                (args.where.heartbeatAt?.getTime() ?? null) ===
                  (this.run.heartbeatAt?.getTime() ?? null);
              const matches =
                (!args.where.id || args.where.id === this.run.id) &&
                (!args.where.workspaceId || args.where.workspaceId === this.run.workspaceId) &&
                (!args.where.taskId || args.where.taskId === this.run.taskId) &&
                statusMatches(args.where.status, this.run.status) &&
                beatMatches;
              if (!matches) return Promise.resolve({ count: 0 });
              Object.assign(this.run, args.data);
              return Promise.resolve({ count: 1 });
            },
          },
          taskEvent: {
            create: (args: { data: Record<string, unknown> }): Promise<Record<string, unknown>> => {
              this.events.push(args.data);
              return Promise.resolve({ ...args.data, createdAt: now });
            },
          },
        };

        try {
          return await fn(tx);
        } finally {
          releaseTaskLock?.();
        }
      },
    };
    return { prisma, pool: null, close: () => Promise.resolve() } as unknown as DbHandle;
  }
}

/** Uretimdeki gibi `withScope` icinde (RLS oturum degiskeni set edilerek) calistirir. */
function inTx<T>(db: YarisVeritabani, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withScope(db.handle().prisma, scope, fn);
}

/** Reddedilen sozu bekler ve nedenini dondurur; beklenmedik basarida null verir. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (cause: unknown) => cause,
  );
}

describe('Mission task/run yarisi', () => {
  it('blocked islemi task kilidini once alirsa eszamanli claim iptal edilmis run gorur', async () => {
    const db = new YarisVeritabani();
    const handle = db.handle();

    const blocking = handle.prisma.$transaction((tx) =>
      moveTask(tx, scope, taskId, 'blocked', { authorType: 'user', authorId: actorId }),
    );
    await db.taskUpdateReached.promise;

    const claiming = handle.prisma.$transaction((tx) => claimRun(tx, scope, runId));
    await Promise.resolve();

    // Claim transaction'i ayni task row lock'unda bekliyor; run henuz running degil.
    expect(db.run.status).toBe('queued');
    db.allowTaskUpdate.resolve();

    const [, claimed] = await Promise.all([blocking, claiming]);
    expect(claimed).toBeNull();
    expect(db.task.status).toBe('blocked');
    expect(db.run.status).toBe('cancelled');
    expect(db.run.finishedAt).toBeInstanceOf(Date);
    expect(db.lockSql).toHaveLength(2);
    expect(db.lockSql.every((sql) => /FOR UPDATE/.test(sql))).toBe(true);
  });
});

describe('yeniden atama (aktif kosu)', () => {
  it('calisan (running) kosusu olan gorevin yeniden atanmasini reddeder ve dogru yolu soyler', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.run.status = 'running';

    const error = await rejection(
      db.handle().prisma.$transaction((tx) => assignTask(tx, scope, { taskId, agentId })),
    );

    expect(error).toMatchObject({ name: 'MissionError', code: 'active_run' });
    // Mesaj var olmayan bir eylemi ("iptal et") degil, gercek yolu soylemeli.
    expect((error as Error).message).toContain(runId);
    expect((error as Error).message).toMatch(/bitmesini bekle/);
    expect((error as Error).message).not.toMatch(/iptal et/);
    expect(db.task.status).toBe('assigned');
    expect(db.createdRuns).toHaveLength(0);
    expect(db.run.status).toBe('running');
  });

  it('bekleyen (queued) kosuyu iptal eder ve atama surer (ADR 0007 madde 5)', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.run.status = 'queued';
    const newAgent = newAgentId();
    db.agent.id = newAgent;

    const assigned = await db
      .handle()
      .prisma.$transaction((tx) => assignTask(tx, scope, { taskId, agentId: newAgent }));

    expect(db.run.status).toBe('cancelled');
    expect(db.run.finishedAt).toBeInstanceOf(Date);
    expect(assigned.task.status).toBe('assigned');
    expect(assigned.task.assigneeId).toBe(newAgent);
    expect(db.createdRuns).toHaveLength(1);
    expect(db.createdRuns[0]).toMatchObject({ status: 'queued', taskId, agentId: newAgent });
    expect(db.events).toContainEqual(
      expect.objectContaining({
        kind: 'assigned',
        detail: expect.stringContaining('onceki bekleyen kosu iptal edildi') as unknown,
      }),
    );
  });

  it('atama baska bir nedenle reddedilirse bekleyen kosuya dokunmaz', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.run.status = 'queued';
    db.agent.status = 'offline';

    await expect(
      db.handle().prisma.$transaction((tx) => assignTask(tx, scope, { taskId, agentId })),
    ).rejects.toMatchObject({ code: 'agent_offline' });

    expect(db.run.status).toBe('queued');
    expect(db.createdRuns).toHaveLength(0);
  });

  it('offline ajana atamayi reddeder (agent_offline) ve hicbir seyi degistirmez', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.run.status = 'failed';
    db.task.status = 'blocked';
    db.agent.status = 'offline';

    const error = await rejection(
      db.handle().prisma.$transaction((tx) => assignTask(tx, scope, { taskId, agentId })),
    );

    expect(error).toMatchObject({ name: 'MissionError', code: 'agent_offline' });
    expect((error as Error).message).toContain('@nova');
    expect(db.task.status).toBe('blocked');
    expect(db.createdRuns).toHaveLength(0);
  });

  it.each(['m2', 'server'])(
    '%s cihazindaki ajana atamayi reddeder (device_unsupported): Faz 2 yerel kosu yok',
    async (device) => {
      const db = new YarisVeritabani();
      db.allowTaskUpdate.resolve();
      db.agent.device = device;
      db.run.status = 'failed';
      db.task.status = 'blocked';

      const error = await rejection(
        db.handle().prisma.$transaction((tx) => assignTask(tx, scope, { taskId, agentId })),
      );

      expect(error).toMatchObject({ name: 'MissionError', code: 'device_unsupported' });
      expect((error as Error).message).toContain(device);
      expect(db.createdRuns).toHaveLength(0);
      expect(db.task.status).toBe('blocked');
    },
  );

  it.each(['wsl', 'windows'])('%s cihazindaki ajana atama kabul edilir', async (device) => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.agent.device = device;
    db.run.status = 'failed';
    db.task.status = 'blocked';

    await db.handle().prisma.$transaction((tx) => assignTask(tx, scope, { taskId, agentId }));

    expect(db.createdRuns).toHaveLength(1);
  });

  it('409 kodlari *_not_found ile bitmez (gateway esleme kurali: not_found 404, digerleri 409)', async () => {
    const codes: string[] = [];
    for (const setup of [
      (db: YarisVeritabani) => (db.run.status = 'running'),
      (db: YarisVeritabani) => (db.agent.status = 'offline'),
      (db: YarisVeritabani) => (db.agent.device = 'm2'),
    ]) {
      const db = new YarisVeritabani();
      db.allowTaskUpdate.resolve();
      setup(db);
      const error = await rejection(
        db.handle().prisma.$transaction((tx) => assignTask(tx, scope, { taskId, agentId })),
      );
      codes.push((error as { code: string }).code);
    }
    expect(codes).toEqual(['active_run', 'agent_offline', 'device_unsupported']);
    expect(codes.some((code) => code.endsWith('_not_found'))).toBe(false);
  });

  it.each(['ok', 'failed', 'cancelled'])(
    '%s biten kosudan sonra gorev yeniden atanabilir',
    async (status) => {
      const db = new YarisVeritabani();
      db.allowTaskUpdate.resolve();
      db.run.status = status;
      db.task.status = 'blocked';

      const assigned = await db
        .handle()
        .prisma.$transaction((tx) => assignTask(tx, scope, { taskId, agentId }));

      expect(assigned.task.status).toBe('assigned');
      expect(db.createdRuns).toHaveLength(1);
      expect(db.createdRuns[0]).toMatchObject({ status: 'queued', taskId, agentId });
    },
  );
});

describe('revizyon ve yeniden acma (atama)', () => {
  it.each(['review', 'done'])(
    '%s durumundaki gorev atamayla yeni kosu yaratir ve akista nereden acildigini soyler',
    async (status) => {
      const db = new YarisVeritabani();
      db.allowTaskUpdate.resolve();
      db.task.status = status;
      db.run.status = 'ok';

      const assigned = await db
        .handle()
        .prisma.$transaction((tx) => assignTask(tx, scope, { taskId, agentId }));

      expect(assigned.task.status).toBe('assigned');
      expect(assigned.task.assigneeId).toBe(agentId);
      expect(db.createdRuns).toHaveLength(1);
      expect(db.createdRuns[0]).toMatchObject({ status: 'queued', taskId, agentId });
      // Biten onceki kosu gecmis olarak kalir; yeni kosu ayri bir satirdir.
      expect(db.run.status).toBe('ok');
      expect(db.events).toContainEqual(
        expect.objectContaining({
          kind: 'assigned',
          detail: expect.stringContaining(`${status} durumundan yeniden atandi`) as unknown,
        }),
      );
    },
  );

  it('done gorev baska ajana verilince sahibi degisir ve bitis damgasi temizlenir', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.task.status = 'done';
    db.task.finishedAt = now;
    db.run.status = 'ok';
    const newAgent = newAgentId();
    db.agent.id = newAgent;

    const assigned = await db
      .handle()
      .prisma.$transaction((tx) => assignTask(tx, scope, { taskId, agentId: newAgent }));

    expect(assigned.task.assigneeId).toBe(newAgent);
    // Yeniden acilan gorev bitmis sayilmaz: damga durumdan turetilir.
    expect(assigned.task.finishedAt).toBeNull();
    expect(db.createdRuns[0]).toMatchObject({ status: 'queued', taskId, agentId: newAgent });
  });

  it('yeniden atama baska durumlarin bitis damgasina dokunmaz', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.task.status = 'review';
    db.task.finishedAt = now;
    db.run.status = 'ok';

    await db.handle().prisma.$transaction((tx) => assignTask(tx, scope, { taskId, agentId }));

    expect(db.task.finishedAt).toEqual(now);
  });

  it.each(['review', 'done'])(
    '%s durumunda bile calisan (running) kosu varsa atama active_run ile reddedilir',
    async (status) => {
      const db = new YarisVeritabani();
      db.allowTaskUpdate.resolve();
      db.task.status = status;
      db.run.status = 'running';

      const error = await rejection(
        db.handle().prisma.$transaction((tx) => assignTask(tx, scope, { taskId, agentId })),
      );

      expect(error).toMatchObject({ name: 'MissionError', code: 'active_run' });
      expect(db.task.status).toBe(status);
      expect(db.createdRuns).toHaveLength(0);
      expect(db.run.status).toBe('running');
    },
  );

  it.each(['review', 'done'])(
    '%s durumundaki goreve takili kalmis bekleyen (queued) kosu atamada iptal edilir',
    async (status) => {
      const db = new YarisVeritabani();
      db.allowTaskUpdate.resolve();
      db.task.status = status;
      db.run.status = 'queued';

      await db.handle().prisma.$transaction((tx) => assignTask(tx, scope, { taskId, agentId }));

      expect(db.run.status).toBe('cancelled');
      expect(db.createdRuns).toHaveLength(1);
    },
  );
});

describe('sahipsiz geri alma (inbox)', () => {
  const user = { authorType: 'user', authorId: actorId } as const;

  it.each(['review', 'done', 'assigned', 'blocked'])(
    '%s -> inbox sahibi temizler (inbox daima sahipsizdir) ve bekleyen kosuyu iptal eder',
    async (status) => {
      const db = new YarisVeritabani();
      db.allowTaskUpdate.resolve();
      db.task.status = status;
      db.run.status = 'queued';

      const moved = await inTx(db, (tx) => moveTask(tx, scope, taskId, 'inbox', user));

      expect(moved.status).toBe('inbox');
      expect(moved.assigneeId).toBeNull();
      expect(db.run.status).toBe('cancelled');
      // Akis, gorevi kimin biraktigini kaybetmez: olay eski sahibe baglidir.
      expect(db.events).toContainEqual(
        expect.objectContaining({
          kind: 'status',
          taskId,
          agentId,
          detail: expect.stringContaining(`${status} → inbox`) as unknown,
        }),
      );
    },
  );

  it('done -> inbox bitis damgasini da temizler', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.task.status = 'done';
    db.task.finishedAt = now;

    const moved = await inTx(db, (tx) => moveTask(tx, scope, taskId, 'inbox', user));

    expect(moved.finishedAt).toBeNull();
  });

  it('inbox disindaki gecisler sahibi korur ve done bitis damgasi yazar', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.task.status = 'review';

    const moved = await inTx(db, (tx) => moveTask(tx, scope, taskId, 'done', user));

    expect(moved.status).toBe('done');
    expect(moved.assigneeId).toBe(agentId);
    expect(moved.finishedAt).toBeInstanceOf(Date);
  });

  it('done gorevin inbox disina elle tasinmasi reddedilir', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.task.status = 'done';

    await expect(
      inTx(db, (tx) => moveTask(tx, scope, taskId, 'review', user)),
    ).rejects.toMatchObject({ name: 'InvalidTransitionError' });
    expect(db.task.status).toBe('done');
  });
});

describe('kosu lease ve sahipsiz kosu uzlastirmasi', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claim yeni kosuya heartbeat damgasi koyar', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();

    const claimed = await inTx(db, (tx) => claimRun(tx, scope, runId));

    expect(claimed).toMatchObject({ status: 'running' });
    expect(db.run.heartbeatAt).toEqual(now);
  });

  it('lease etkinken running kosuya dokunmaz ve kalan sureyi bildirir', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.runningSince(10_000);

    const error = await rejection(inTx(db, (tx) => claimRun(tx, scope, runId)));

    expect(error).toBeInstanceOf(ActiveRunLeaseError);
    expect((error as ActiveRunLeaseError).retryAfterMs).toBe(AGENT_RUN_LEASE_MS - 10_000);
    expect(db.run.status).toBe('running');
    expect(db.task.status).toBe('in_progress');
    expect(db.events).toHaveLength(0);
  });

  it('lease suresi dolmus running kosuyu yeniden calistirmadan failed/blocked/idle yapar', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.runningSince(AGENT_RUN_LEASE_MS + 1_000);

    const claimed = await inTx(db, (tx) => claimRun(tx, scope, runId));

    expect(claimed).toBeNull();
    expect(db.run.status).toBe('failed');
    expect(db.run.finishedAt).toBeInstanceOf(Date);
    expect(db.task.status).toBe('blocked');
    expect(db.agent.status).toBe('idle');
    expect(db.events).toContainEqual(
      expect.objectContaining({
        kind: 'run_abandoned',
        taskId,
        agentId,
        detail: 'yarida kaldi: worker durdu',
      }),
    );
    // Durum degisikligi atlanmaz: gorev gecisi de akista gorunur.
    const statusEvent = db.events.find((event) => event.kind === 'status');
    expect(statusEvent?.detail).toContain('in_progress → blocked');
  });

  it('heartbeat NULL (lease oncesi satir) startedAt olarak okunur', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();

    db.runningSince(10_000);
    db.run.heartbeatAt = null;
    await expect(inTx(db, (tx) => claimRun(tx, scope, runId))).rejects.toBeInstanceOf(
      ActiveRunLeaseError,
    );

    db.runningSince(AGENT_RUN_LEASE_MS + 1_000);
    db.run.heartbeatAt = null;
    await expect(inTx(db, (tx) => claimRun(tx, scope, runId))).resolves.toBeNull();
    expect(db.run.status).toBe('failed');
  });

  it('gorev artik bu kosunun degilse gorev durumuna dokunmadan yalniz kosuyu kapatir', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.runningSince(AGENT_RUN_LEASE_MS + 1_000);
    db.task.status = 'review';

    await inTx(db, (tx) => claimRun(tx, scope, runId));

    expect(db.run.status).toBe('failed');
    expect(db.task.status).toBe('review');
    expect(db.events).toContainEqual(expect.objectContaining({ kind: 'run_abandoned' }));
  });

  it('kilit beklenirken gec bir heartbeat gelirse kosuyu sonlandirmaz', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.runningSince(AGENT_RUN_LEASE_MS + 1_000);
    // Asil worker kilit alinirken hayatta cikti ve damgayi tazeledi.
    db.onTaskLock = () => {
      db.run.heartbeatAt = new Date(now.getTime());
    };

    const error = await rejection(inTx(db, (tx) => claimRun(tx, scope, runId)));

    expect(error).toBeInstanceOf(ActiveRunLeaseError);
    expect(db.run.status).toBe('running');
    expect(db.task.status).toBe('in_progress');
    expect(db.events).toHaveLength(0);
  });

  it('heartbeatRun yalniz running kosuyu tazeler', async () => {
    const db = new YarisVeritabani();
    db.runningSince(10_000);
    vi.setSystemTime(new Date(now.getTime() + 5_000));

    await expect(inTx(db, (tx) => heartbeatRun(tx, scope, runId))).resolves.toBe(true);
    expect(db.run.heartbeatAt?.getTime()).toBe(now.getTime() + 5_000);

    db.run.status = 'failed';
    await expect(inTx(db, (tx) => heartbeatRun(tx, scope, runId))).resolves.toBe(false);
  });

  it('listExpiredRunningRuns yalniz lease suresi dolmus running kosulari sorgular', async () => {
    const db = new YarisVeritabani();
    db.runningSince(AGENT_RUN_LEASE_MS + 1_000);

    const runs = await inTx(db, (tx) => listExpiredRunningRuns(tx, scope));

    expect(runs.map((run) => run.id)).toEqual([runId]);
    const cutoff = new Date(now.getTime() - AGENT_RUN_LEASE_MS);
    expect(db.findManyCalls[0]).toMatchObject({
      where: {
        workspaceId,
        status: 'running',
        // heartbeat yoksa startedAt lease baslangicidir (abandonStaleRun ile ayni kural).
        OR: [{ heartbeatAt: { lte: cutoff } }, { heartbeatAt: null, startedAt: { lte: cutoff } }],
      },
    });
  });

  it('abandonExpiredRuns kuyrukta etkin isi olmayan sahipsiz kosuyu failed/blocked/idle yapar', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.runningSince(AGENT_RUN_LEASE_MS + 1_000);
    const hasLiveJob = vi.fn(() => Promise.resolve(false));

    const abandoned = await abandonExpiredRuns(db.handle(), scope, hasLiveJob);

    expect(abandoned).toEqual([runId]);
    expect(hasLiveJob).toHaveBeenCalledWith(runId);
    expect(db.run.status).toBe('failed');
    expect(db.run.finishedAt).toBeInstanceOf(Date);
    expect(db.task.status).toBe('blocked');
    expect(db.agent.status).toBe('idle');
    expect(db.events).toContainEqual(expect.objectContaining({ kind: 'run_abandoned', taskId }));
  });

  it('abandonExpiredRuns kuyrukta etkin is varsa kosuya dokunmaz (kuyruk yeniden teslim edecek)', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.runningSince(AGENT_RUN_LEASE_MS + 1_000);

    const abandoned = await abandonExpiredRuns(db.handle(), scope, () => Promise.resolve(true));

    expect(abandoned).toEqual([]);
    expect(db.run.status).toBe('running');
    expect(db.task.status).toBe('in_progress');
    expect(db.events).toHaveLength(0);
  });

  it('abandonExpiredRuns arada heartbeat gelirse (lease yenilendi) kosuyu sonlandirmaz', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.runningSince(AGENT_RUN_LEASE_MS + 1_000);
    db.onTaskLock = () => {
      db.run.heartbeatAt = new Date(now.getTime());
    };

    const abandoned = await abandonExpiredRuns(db.handle(), scope, () => Promise.resolve(false));

    expect(abandoned).toEqual([]);
    expect(db.run.status).toBe('running');
    expect(db.task.status).toBe('in_progress');
  });

  it('sahipsiz kosu sonlandirilirken devre disi (offline) ajan idle yapilmaz', async () => {
    const db = new YarisVeritabani();
    db.allowTaskUpdate.resolve();
    db.runningSince(AGENT_RUN_LEASE_MS + 1_000);
    db.agent.status = 'offline';

    await abandonExpiredRuns(db.handle(), scope, () => Promise.resolve(false));

    expect(db.run.status).toBe('failed');
    expect(db.agent.status).toBe('offline');
  });
});

describe('ajan durum gecisleri (kosullu)', () => {
  it('onlyFrom disindaki durumu ezmez ve false doner', async () => {
    const db = new YarisVeritabani();
    db.agent.status = 'offline';

    await expect(
      inTx(db, (tx) => setAgentStatus(tx, scope, agentId, 'idle', { onlyFrom: ['working'] })),
    ).resolves.toBe(false);
    expect(db.agent.status).toBe('offline');
  });

  it('onlyFrom icindeki durumu degistirir ve true doner', async () => {
    const db = new YarisVeritabani();
    db.agent.status = 'working';

    await expect(
      inTx(db, (tx) => setAgentStatus(tx, scope, agentId, 'idle', { onlyFrom: ['working'] })),
    ).resolves.toBe(true);
    expect(db.agent.status).toBe('idle');
  });

  it('kosulsuz cagri eskisi gibi her durumu yazar', async () => {
    const db = new YarisVeritabani();
    db.agent.status = 'offline';

    await expect(inTx(db, (tx) => setAgentStatus(tx, scope, agentId, 'idle'))).resolves.toBe(true);
    expect(db.agent.status).toBe('idle');
  });
});

describe('cikis kodu int4 siniri (Windows isaretsiz 32 bit)', () => {
  it.each([0, 1, 124, -1, 2_147_483_647, -2_147_483_648])('%i oldugu gibi saklanir', (code) => {
    expect(toStorableExitCode(code)).toBe(code);
  });

  it('isaretsiz 32 bit degerler bit deseni korunarak isaretliye cevrilir', () => {
    // wsl.exe altyapi hatasi (ornegin dagitim bulunamadi) ve NTSTATUS kodlari.
    expect(toStorableExitCode(4_294_967_295)).toBe(-1);
    expect(toStorableExitCode(3_221_225_786)).toBe(-1_073_741_510);
    expect(toStorableExitCode(2_147_483_648)).toBe(-2_147_483_648);
  });

  it.each([
    4_294_967_296,
    -2_147_483_649,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null,
    undefined,
  ])('%s kolona sigmaz: null olur (ham deger engine.log icinde kalir)', (code) => {
    expect(toStorableExitCode(code)).toBeNull();
  });

  it('finishRun kolona sigmayan cikis kodunu yazimi dusurmeden saklanabilir hale getirir', async () => {
    const db = new YarisVeritabani();

    await inTx(db, (tx) =>
      finishRun(tx, scope, runId, { status: 'failed', exitCode: 4_294_967_295 }),
    );

    expect(db.run.status).toBe('failed');
    expect(db.run.exitCode).toBe(-1);
  });

  it('finishRun cikis kodu verilmezse null yazar', async () => {
    const db = new YarisVeritabani();

    await inTx(db, (tx) => finishRun(tx, scope, runId, { status: 'cancelled' }));

    expect(db.run.exitCode).toBeNull();
  });
});

describe('sonuc yazimi kilidi', () => {
  it('gorev hala in_progress ve bu ajanin ise gorevi doner', async () => {
    const db = new YarisVeritabani();
    db.task.status = 'in_progress';
    await expect(
      inTx(db, (tx) => lockTaskForRunCompletion(tx, scope, { taskId, agentId })),
    ).resolves.toMatchObject({ id: taskId });
  });

  it.each(['blocked', 'assigned', 'review', 'done', 'inbox'])(
    'gorev %s durumuna tasinmissa null doner',
    async (status) => {
      const db = new YarisVeritabani();
      db.task.status = status;
      await expect(
        inTx(db, (tx) => lockTaskForRunCompletion(tx, scope, { taskId, agentId })),
      ).resolves.toBeNull();
    },
  );

  it('gorev baska ajana verilmisse null doner', async () => {
    const db = new YarisVeritabani();
    db.task.status = 'in_progress';
    db.task.assigneeId = newAgentId();
    await expect(
      inTx(db, (tx) => lockTaskForRunCompletion(tx, scope, { taskId, agentId })),
    ).resolves.toBeNull();
  });
});

describe('yorum penceresi', () => {
  it('limit verilince en yeni yorumlari DB tarafinda alir ve eski-yeni dondurur', async () => {
    const newest = { id: 'newest' };
    const older = { id: 'older' };
    const findMany = vi.fn().mockResolvedValue([newest, older]);
    const result = await listComments({ taskComment: { findMany } } as never, scope, taskId, 2);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, take: 2 }),
    );
    expect(result).toEqual([older, newest]);
  });

  it('limitsiz cagri tum yorumlari eski-yeni okur', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const result = await listComments({ taskComment: { findMany } } as never, scope, taskId);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'asc' } }),
    );
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty('take');
    expect(result).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});
