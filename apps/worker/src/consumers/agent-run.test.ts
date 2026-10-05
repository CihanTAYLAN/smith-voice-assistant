import {
  newActorId,
  newAgentId,
  newAgentRunId,
  newTaskId,
  newWorkspaceId,
  type DbHandle,
} from '@smith/db';
import { AGENT_RUN_HEARTBEAT_MS, AGENT_RUN_LEASE_MS } from '@smith/mission';
import type { AgentRunJob } from '@smith/queue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runAgentEngine, executor } = vi.hoisted(() => ({
  runAgentEngine: vi.fn(),
  executor: { enabled: true },
}));

vi.mock('../engines/executor.js', () => ({
  isMissionExecutorEnabled: () => executor.enabled,
}));
vi.mock('../engines/index.js', () => ({ runAgentEngine }));

import {
  FALLBACK_WRITE_RETRY_DELAYS_MS,
  FINAL_WRITE_RETRY_DELAYS_MS,
  handleAgentRun,
} from './agent-run.js';

const workspaceId = newWorkspaceId();
const actorId = newActorId();
const taskId = newTaskId();
const agentId = newAgentId();
const runId = newAgentRunId();
const now = new Date('2026-10-03T12:00:00.000Z');

type TaskStatus = 'inbox' | 'assigned' | 'in_progress' | 'review' | 'done' | 'blocked';

const INT4_MAX = 2 ** 31 - 1;
const INT4_MIN = -(2 ** 31);

class SahteMissionDb {
  readonly events: Record<string, unknown>[] = [];
  readonly comments: Array<Record<string, unknown>> = [];
  heartbeatWrites = 0;
  /** true iken yalniz heartbeat yazimlari DB hatasi verir (gecici kesinti). */
  heartbeatFailing = false;
  /** Nihai kosu yazimi (`finishRun`) denemeleri; basarisizlar dahil. */
  terminalWriteAttempts = 0;
  /** Nihai kosu yazimini bu kosul dogruysa DB hatasiyla dusurur (kesinti ya da zehirli veri). */
  failTerminalRunWrite: ((data: Record<string, unknown>) => boolean) | undefined;

  readonly run = {
    id: runId,
    workspaceId,
    taskId,
    agentId,
    device: 'windows',
    engine: 'codex',
    status: 'queued',
    heartbeatAt: null as Date | null,
    externalSessionId: null,
    exitCode: null,
    costMicros: 0,
    inputTokens: null,
    outputTokens: null,
    logPath: null,
    startedAt: now,
    finishedAt: null as Date | null,
  };

  readonly task = {
    id: taskId,
    workspaceId,
    title: 'Kilitli gorev',
    detail: null,
    status: 'assigned' as TaskStatus,
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
    slug: 'codex',
    displayName: 'Codex',
    role: 'developer',
    soul: 'Test agent soul',
    model: null,
    parentId: null,
    device: 'windows',
    workRoots: [] as string[],
    allowedTools: [] as string[],
    status: 'idle',
    lastSeenAt: null,
    createdAt: now,
    updatedAt: now,
  };

  handle(): DbHandle {
    const task = this.task;
    const tx = {
      $executeRaw: (): Promise<number> => Promise.resolve(1),
      $queryRaw: (strings: TemplateStringsArray): Promise<unknown[]> =>
        Promise.resolve(strings.join('?').includes('FOR UPDATE') ? [this.task] : []),
      agentRun: {
        findFirst: (args: {
          where: { id?: string; workspaceId?: string; status?: string };
        }): Promise<typeof this.run | null> => {
          const matches =
            (!args.where.id || args.where.id === this.run.id) &&
            (!args.where.workspaceId || args.where.workspaceId === this.run.workspaceId) &&
            (!args.where.status || args.where.status === this.run.status);
          return Promise.resolve(matches ? this.run : null);
        },
        updateMany: (args: {
          where: { id?: string; workspaceId?: string; status?: string };
          data: Record<string, unknown> & {
            status?: string;
            startedAt?: Date;
            heartbeatAt?: Date;
            finishedAt?: Date;
          };
        }): Promise<{ count: number }> => {
          const heartbeatOnly = args.data.heartbeatAt !== undefined && !args.data.status;
          if (heartbeatOnly && this.heartbeatFailing) {
            return Promise.reject(new Error('db kesintisi'));
          }
          if ('exitCode' in args.data) {
            // `finishRun` yazimi: AgentRun.exitCode gercek kolon gibi int4'tur.
            this.terminalWriteAttempts += 1;
            const exit = args.data.exitCode;
            if (typeof exit === 'number' && (exit > INT4_MAX || exit < INT4_MIN)) {
              return Promise.reject(
                new Error(
                  `Value out of range for the type: value "${exit}" is out of range for type integer`,
                ),
              );
            }
            if (this.failTerminalRunWrite?.(args.data)) {
              return Promise.reject(new Error('db kesintisi (nihai yazim)'));
            }
          }
          if (args.where.id && args.where.id !== this.run.id) return Promise.resolve({ count: 0 });
          if (args.where.workspaceId && args.where.workspaceId !== this.run.workspaceId) {
            return Promise.resolve({ count: 0 });
          }
          if (args.where.status && args.where.status !== this.run.status) {
            return Promise.resolve({ count: 0 });
          }
          if (heartbeatOnly) this.heartbeatWrites += 1;
          Object.assign(this.run, args.data);
          return Promise.resolve({ count: 1 });
        },
      },
      task: {
        findFirst: (): Promise<typeof task> => Promise.resolve(task),
        update: (args: { data: Partial<typeof task> }): Promise<typeof task> => {
          Object.assign(task, args.data);
          return Promise.resolve(task);
        },
      },
      agent: {
        findFirst: (): Promise<typeof this.agent> => Promise.resolve(this.agent),
        updateMany: (args: {
          where: { status?: string | { in: string[] } };
          data: { status?: string };
        }): Promise<{ count: number }> => {
          // Kosullu gecis (`WHERE status IN (...)`) gercek veritabani gibi sayim doner.
          const filter = args.where.status;
          const allowed =
            filter === undefined
              ? true
              : typeof filter === 'string'
                ? filter === this.agent.status
                : filter.in.includes(this.agent.status);
          if (!allowed) return Promise.resolve({ count: 0 });
          Object.assign(this.agent, args.data);
          return Promise.resolve({ count: 1 });
        },
      },
      taskComment: {
        findMany: (): Promise<[]> => Promise.resolve([]),
        create: (args: { data: Record<string, unknown> }): Promise<Record<string, unknown>> => {
          this.comments.push(args.data);
          return Promise.resolve({ ...args.data, createdAt: now });
        },
      },
      taskEvent: {
        create: (args: { data: Record<string, unknown> }): Promise<Record<string, unknown>> => {
          this.events.push(args.data);
          return Promise.resolve({ ...args.data, createdAt: now });
        },
      },
    };
    return {
      prisma: {
        ...tx,
        $transaction: <T>(fn: (value: typeof tx) => Promise<T>): Promise<T> => fn(tx),
      },
      pool: null,
      close: () => Promise.resolve(),
    } as unknown as DbHandle;
  }
}

function payload(): AgentRunJob {
  return { workspaceId, actorId, runId };
}

const engineResult = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  text: 'tamamlandi',
  exitCode: 0,
  timedOut: false,
  logPath: '',
  ...overrides,
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('handleAgentRun gorev durumu kapisi', () => {
  beforeEach(() => {
    runAgentEngine.mockReset();
    runAgentEngine.mockResolvedValue({
      ok: false,
      text: 'test motoru calisti',
      exitCode: 1,
      timedOut: false,
      logPath: '',
    });
  });

  it.each<TaskStatus>(['blocked', 'done', 'inbox'])(
    '%s gorevin bekleyen kosusunu iptal eder ve motoru cagirmadan doner',
    async (status) => {
      const db = new SahteMissionDb();
      db.task.status = status;

      await handleAgentRun({ db: db.handle() }, payload());

      expect(runAgentEngine).not.toHaveBeenCalled();
      expect(db.run.status).toBe('cancelled');
      expect(db.run.finishedAt).toBeInstanceOf(Date);
    },
  );

  it('zaten cancelled run icin motoru cagirmaz', async () => {
    const db = new SahteMissionDb();
    db.run.status = 'cancelled';
    db.run.finishedAt = now;

    await handleAgentRun({ db: db.handle() }, payload());

    expect(runAgentEngine).not.toHaveBeenCalled();
    expect(db.run.status).toBe('cancelled');
  });

  it.each<TaskStatus>(['blocked', 'assigned', 'review', 'done'])(
    'motor calisirken gorev %s olursa kosuyu yine terminal yapar ve yeni durumu ezmez',
    async (movedTo) => {
      const db = new SahteMissionDb();
      runAgentEngine.mockImplementation(() => {
        db.task.status = movedTo;
        return Promise.resolve(engineResult());
      });

      await expect(handleAgentRun({ db: db.handle() }, payload())).resolves.toBeUndefined();

      expect(db.run.status).toBe('ok');
      expect(db.run.finishedAt).toBeInstanceOf(Date);
      expect(db.agent.status).toBe('idle');
      expect(db.task.status).toBe(movedTo);
      expect(db.task.deliverable).toBeNull();
    },
  );

  it('motor calisirken gorev baska ajana verilirse sonuc o ajanin gorevine yazilmaz', async () => {
    const db = new SahteMissionDb();
    runAgentEngine.mockImplementation(() => {
      db.task.assigneeId = newAgentId();
      return Promise.resolve(engineResult());
    });

    await handleAgentRun({ db: db.handle() }, payload());

    expect(db.run.status).toBe('ok');
    expect(db.task.status).toBe('in_progress');
    expect(db.task.deliverable).toBeNull();
  });

  it('normal akista sonuc teslim edilir (review)', async () => {
    const db = new SahteMissionDb();
    runAgentEngine.mockResolvedValue(engineResult());

    await handleAgentRun({ db: db.handle() }, payload());

    expect(db.run.status).toBe('ok');
    expect(db.task.status).toBe('review');
    expect(db.task.deliverable).toBe('tamamlandi');
  });
});

describe('handleAgentRun lease ve iptal', () => {
  beforeEach(() => {
    runAgentEngine.mockReset();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Motoru istenen ana kadar asili tutar ve aldigi iptal sinyalini disari verir. */
  function hangingEngine() {
    const finish = deferred<ReturnType<typeof engineResult>>();
    const seen: { signal?: AbortSignal } = {};
    runAgentEngine.mockImplementation((_engine: string, input: { signal: AbortSignal }) => {
      seen.signal = input.signal;
      return finish.promise;
    });
    return { finish, seen };
  }

  it('kuyruk ayni kosuyu yeniden teslim ederse lease dolana kadar bekler, motoru CALISTIRMADAN sonlandirir', async () => {
    const db = new SahteMissionDb();
    db.run.status = 'running';
    db.run.heartbeatAt = new Date(now.getTime() - 10_000);
    db.task.status = 'in_progress';
    db.agent.status = 'working';

    const handling = handleAgentRun({ db: db.handle() }, payload());
    await vi.advanceTimersByTimeAsync(AGENT_RUN_LEASE_MS - 10_000 - 1_000);
    expect(db.run.status).toBe('running');

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(handling).resolves.toBeUndefined();

    expect(runAgentEngine).not.toHaveBeenCalled();
    expect(db.run.status).toBe('failed');
    expect(db.task.status).toBe('blocked');
    expect(db.agent.status).toBe('idle');
    expect(db.events).toContainEqual(
      expect.objectContaining({ kind: 'run_abandoned', detail: 'yarida kaldi: worker durdu' }),
    );
  });

  it('asil worker beklerken kosuyu bitirirse sahipsiz saymaz ve dokunmaz', async () => {
    const db = new SahteMissionDb();
    db.run.status = 'running';
    db.run.heartbeatAt = new Date(now.getTime() - 10_000);
    db.task.status = 'in_progress';

    const handling = handleAgentRun({ db: db.handle() }, payload());
    await vi.advanceTimersByTimeAsync(1_000);
    db.run.status = 'ok';
    db.run.finishedAt = new Date();
    await vi.advanceTimersByTimeAsync(AGENT_RUN_LEASE_MS);
    await expect(handling).resolves.toBeUndefined();

    expect(runAgentEngine).not.toHaveBeenCalled();
    expect(db.run.status).toBe('ok');
    expect(db.task.status).toBe('in_progress');
    expect(db.events).not.toContainEqual(expect.objectContaining({ kind: 'run_abandoned' }));
  });

  it('lease beklerken worker kapanirsa bekleme iptal edilir', async () => {
    const db = new SahteMissionDb();
    db.run.status = 'running';
    db.run.heartbeatAt = new Date(now.getTime() - 10_000);
    db.task.status = 'in_progress';
    const shutdown = new AbortController();

    const handling = handleAgentRun({ db: db.handle(), signal: shutdown.signal }, payload());
    const rejected = expect(handling).rejects.toThrow('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    shutdown.abort(new Error('SIGTERM: worker kapaniyor'));

    await rejected;
    expect(db.run.status).toBe('running');
  });

  it('motor calisirken lease heartbeat ile tazelenir ve motor bitince durur', async () => {
    const db = new SahteMissionDb();
    const { finish } = hangingEngine();

    const handling = handleAgentRun({ db: db.handle() }, payload());
    await vi.advanceTimersByTimeAsync(0);
    const claimedBeat = db.run.heartbeatAt;
    expect(claimedBeat).toBeInstanceOf(Date);

    await vi.advanceTimersByTimeAsync(AGENT_RUN_HEARTBEAT_MS * 2);
    expect(db.heartbeatWrites).toBe(2);
    expect(db.run.heartbeatAt?.getTime()).toBeGreaterThan(claimedBeat?.getTime() ?? Infinity);

    finish.resolve(engineResult());
    await handling;
    await vi.advanceTimersByTimeAsync(AGENT_RUN_HEARTBEAT_MS * 3);
    expect(db.heartbeatWrites).toBe(2);
  });

  it('gecici DB kesintisi motoru oldurmez; lease suresince yazilamazsa durdurur', async () => {
    const db = new SahteMissionDb();
    db.heartbeatFailing = true;
    const { finish, seen } = hangingEngine();

    const handling = handleAgentRun({ db: db.handle() }, payload());
    await vi.advanceTimersByTimeAsync(AGENT_RUN_LEASE_MS - AGENT_RUN_HEARTBEAT_MS);
    expect(seen.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(AGENT_RUN_HEARTBEAT_MS);
    expect(seen.signal?.aborted).toBe(true);
    expect(String(seen.signal?.reason)).toMatch(/lease suresi doldu/);

    finish.resolve(engineResult({ ok: false, text: 'durduruldu', exitCode: null }));
    await handling;
    expect(db.run.status).toBe('failed');
  });

  it('kosu baska yerde sonlandirilmissa (heartbeat false) motoru hemen durdurur', async () => {
    const db = new SahteMissionDb();
    const { finish, seen } = hangingEngine();

    const handling = handleAgentRun({ db: db.handle() }, payload());
    await vi.advanceTimersByTimeAsync(0);
    db.run.status = 'failed';
    await vi.advanceTimersByTimeAsync(AGENT_RUN_HEARTBEAT_MS);

    expect(seen.signal?.aborted).toBe(true);
    expect(String(seen.signal?.reason)).toMatch(/lease kaydi artik etkin degil/);
    finish.resolve(engineResult({ ok: false, text: 'durduruldu', exitCode: null }));
    await handling;
  });

  it('worker kapanirsa etkin motor iptal sinyali alir ve kosu terminal olur', async () => {
    const db = new SahteMissionDb();
    const { finish, seen } = hangingEngine();
    const shutdown = new AbortController();

    const handling = handleAgentRun({ db: db.handle(), signal: shutdown.signal }, payload());
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.signal?.aborted).toBe(false);

    shutdown.abort(new Error('SIGTERM: worker kapaniyor'));
    expect(seen.signal?.aborted).toBe(true);
    finish.resolve(engineResult({ ok: false, text: 'Kosu durduruldu: SIGTERM', exitCode: null }));
    await handling;

    expect(db.run.status).toBe('failed');
    expect(db.task.status).toBe('blocked');
    expect(db.agent.status).toBe('idle');
  });
});

describe('handleAgentRun cikis kodu ve gizli icerik', () => {
  const GEMINI_KEY = `AIza${'A'.repeat(35)}`;
  const GITHUB_TOKEN = `ghp_${'a'.repeat(36)}`;

  beforeEach(() => {
    runAgentEngine.mockReset();
    executor.enabled = true;
  });

  it('Windows isaretsiz cikis kodu (wsl.exe altyapi hatasi) nihai yazimi dusurmez', async () => {
    const db = new SahteMissionDb();
    runAgentEngine.mockResolvedValue(
      engineResult({ ok: false, text: 'Motor basarisiz.', exitCode: 4_294_967_295 }),
    );

    await expect(handleAgentRun({ db: db.handle() }, payload())).resolves.toBeUndefined();

    expect(db.run.status).toBe('failed');
    expect(db.run.exitCode).toBe(-1);
    expect(db.task.status).toBe('blocked');
    expect(db.agent.status).toBe('idle');
    // Olay akisi ham degeri korur (engine.log ile ayni).
    expect(db.events).toContainEqual(
      expect.objectContaining({ kind: 'run_finished', detail: 'basarisiz: exit 4294967295' }),
    );
  });

  it('teslim raporundaki gizli degerler deliverable, yorum ve olay akisinda maskelenir', async () => {
    const db = new SahteMissionDb();
    runAgentEngine.mockResolvedValue(
      engineResult({
        text: `Yapildi, kanit:\nGEMINI_API_KEY=${GEMINI_KEY}\nDB_PASSWORD=mavi kus ucuyor 1923\n`,
      }),
    );

    await handleAgentRun({ db: db.handle() }, payload());

    const everything = JSON.stringify([db.task, db.comments, db.events]);
    expect(db.task.status).toBe('review');
    expect(everything).not.toContain(GEMINI_KEY);
    expect(everything).not.toContain('mavi kus ucuyor 1923');
    expect(db.task.deliverable).toContain('Yapildi, kanit:');
    expect(db.task.deliverable).toContain('[GIZLI]');
    const deliver = db.comments.find((comment) => comment.kind === 'deliver');
    expect(deliver?.body).toBe(db.task.deliverable);
  });

  it('rapordaki NUL karakter nihai yazimi dusurmez: Postgres text kolonu NUL kabul etmez, temizlenir', async () => {
    const db = new SahteMissionDb();
    runAgentEngine.mockResolvedValue(engineResult({ text: 'rapor\u0000govdesi' }));

    await handleAgentRun({ db: db.handle() }, payload());

    expect(db.task.status).toBe('review');
    expect(db.task.deliverable).toBe('raporgovdesi');
    expect(JSON.stringify(db.comments)).not.toContain('\\u0000');
  });

  it('yalniz gizli degerden olusan rapor "gizli icerik atlandi" olarak yazilir', async () => {
    const db = new SahteMissionDb();
    runAgentEngine.mockResolvedValue(engineResult({ text: `GEMINI_API_KEY=${GEMINI_KEY}` }));

    await handleAgentRun({ db: db.handle() }, payload());

    expect(db.task.deliverable).toBe('gizli icerik atlandi');
    expect(JSON.stringify(db.comments)).not.toContain(GEMINI_KEY);
  });

  it('basarisiz kosunun hata metni ve ajanin engel raporu maskelenir', async () => {
    const failed = new SahteMissionDb();
    runAgentEngine.mockResolvedValue(
      engineResult({
        ok: false,
        text: `git push reddedildi: https://u:${GITHUB_TOKEN}@github.com/x`,
        exitCode: 1,
      }),
    );
    await handleAgentRun({ db: failed.handle() }, payload());
    expect(failed.task.status).toBe('blocked');
    expect(JSON.stringify([failed.comments, failed.events])).not.toContain(GITHUB_TOKEN);
    expect(failed.comments.at(-1)?.body).toEqual(expect.stringContaining('Kosu tamamlanamadi'));

    const blocked = new SahteMissionDb();
    runAgentEngine.mockResolvedValue(
      engineResult({ text: `Denedim.\nENGEL: token ${GITHUB_TOKEN} gecersiz` }),
    );
    await handleAgentRun({ db: blocked.handle() }, payload());
    expect(blocked.task.status).toBe('blocked');
    expect(JSON.stringify([blocked.comments, blocked.events])).not.toContain(GITHUB_TOKEN);
  });

  it('gorev motor calisirken tasinirsa uygulanamayan sonuc thread e maskeli note olarak yazilir', async () => {
    const db = new SahteMissionDb();
    runAgentEngine.mockImplementation(() => {
      db.task.status = 'blocked';
      return Promise.resolve(engineResult({ text: `Rapor govdesi.\nDB_PASSWORD=${GEMINI_KEY}` }));
    });

    await handleAgentRun({ db: db.handle() }, payload());

    expect(db.task.status).toBe('blocked');
    expect(db.task.deliverable).toBeNull();
    const note = db.comments.find((comment) => comment.kind === 'note');
    expect(note).toMatchObject({ authorType: 'agent', authorId: agentId });
    expect(note?.body).toEqual(expect.stringContaining('panoya uygulanmadi'));
    expect(note?.body).toEqual(expect.stringContaining('Rapor govdesi.'));
    expect(note?.body).not.toContain(GEMINI_KEY);
  });

  it('uygulanamayan BASARISIZ sonuc da thread e yazilir (neden kaybolmaz)', async () => {
    const db = new SahteMissionDb();
    runAgentEngine.mockImplementation(() => {
      db.task.assigneeId = newAgentId();
      return Promise.resolve(
        engineResult({ ok: false, text: 'Motor basarisiz (exit 127). claude yok', exitCode: 127 }),
      );
    });

    await handleAgentRun({ db: db.handle() }, payload());

    const note = db.comments.find((comment) => comment.kind === 'note');
    expect(note?.body).toEqual(expect.stringContaining('claude yok'));
  });
});

describe('handleAgentRun ajan ve cihaz kapilari', () => {
  beforeEach(() => {
    runAgentEngine.mockReset();
    runAgentEngine.mockResolvedValue(engineResult());
    executor.enabled = true;
  });

  it('devre disi (offline) ajanin kosusunu iptal eder: motor cagrilmaz, ajan offline kalir', async () => {
    const db = new SahteMissionDb();
    db.agent.status = 'offline';

    await handleAgentRun({ db: db.handle() }, payload());

    expect(runAgentEngine).not.toHaveBeenCalled();
    expect(db.run.status).toBe('cancelled');
    expect(db.run.finishedAt).toBeInstanceOf(Date);
    expect(db.agent.status).toBe('offline');
    expect(db.task.status).toBe('assigned');
    expect(db.comments).toContainEqual(
      expect.objectContaining({
        authorType: 'system',
        body: expect.stringContaining('devre disi (offline)') as unknown,
      }),
    );
    expect(db.events).toContainEqual(expect.objectContaining({ kind: 'error', taskId }));
  });

  it('kosu sirasinda offline a cekilen ajan kosu sonunda idle a ezilmez', async () => {
    const db = new SahteMissionDb();
    runAgentEngine.mockImplementation(() => {
      db.agent.status = 'offline';
      return Promise.resolve(engineResult());
    });

    await handleAgentRun({ db: db.handle() }, payload());

    expect(db.run.status).toBe('ok');
    expect(db.task.status).toBe('review');
    expect(db.agent.status).toBe('offline');
  });

  it.each(['idle', 'working'])(
    '%s ajan kosuyu ustlenir ve kosu sonunda idle olur',
    async (status) => {
      const db = new SahteMissionDb();
      db.agent.status = status;

      await handleAgentRun({ db: db.handle() }, payload());

      expect(runAgentEngine).toHaveBeenCalledTimes(1);
      expect(db.agent.status).toBe('idle');
    },
  );

  it.each(['m2', 'server'])(
    '%s cihaz kosusu yerelde calistirilmaz: acik gerekceyle failed yazilir',
    async (device) => {
      const db = new SahteMissionDb();
      db.run.device = device;

      await handleAgentRun({ db: db.handle() }, payload());

      expect(runAgentEngine).not.toHaveBeenCalled();
      expect(db.run.status).toBe('failed');
      expect(db.run.finishedAt).toBeInstanceOf(Date);
      expect(db.agent.status).toBe('idle');
      expect(db.comments).toContainEqual(
        expect.objectContaining({
          authorType: 'system',
          body: expect.stringContaining(`'${device}'`) as unknown,
        }),
      );
      expect(db.events).toContainEqual(expect.objectContaining({ kind: 'error', taskId }));
    },
  );

  it.each(['wsl', 'windows'])('%s cihaz kosusu calisir', async (device) => {
    const db = new SahteMissionDb();
    db.run.device = device;

    await handleAgentRun({ db: db.handle() }, payload());

    expect(runAgentEngine).toHaveBeenCalledTimes(1);
    expect(db.run.status).toBe('ok');
  });

  it('executor kapaliysa kosu cancelled yazilir ve sebep thread e duser (mevcut davranis)', async () => {
    const db = new SahteMissionDb();
    executor.enabled = false;

    await handleAgentRun({ db: db.handle() }, payload());

    expect(runAgentEngine).not.toHaveBeenCalled();
    expect(db.run.status).toBe('cancelled');
    expect(db.comments).toContainEqual(
      expect.objectContaining({
        authorType: 'system',
        body: expect.stringContaining('SMITH_MISSION_EXECUTOR=1') as unknown,
      }),
    );
  });
});

describe('handleAgentRun terminal durum garantisi', () => {
  beforeEach(() => {
    runAgentEngine.mockReset();
    runAgentEngine.mockResolvedValue(engineResult());
    executor.enabled = true;
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(now);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const sum = (values: readonly number[]): number =>
    values.reduce((total, value) => total + value, 0);

  it('nihai yazim gecici kesintide yeniden denenir ve sonuc eksiksiz uygulanir', async () => {
    const db = new SahteMissionDb();
    let failuresLeft = 2;
    db.failTerminalRunWrite = () => failuresLeft-- > 0;

    const handling = handleAgentRun({ db: db.handle() }, payload());
    await vi.advanceTimersByTimeAsync(sum(FINAL_WRITE_RETRY_DELAYS_MS));
    await expect(handling).resolves.toBeUndefined();

    expect(db.terminalWriteAttempts).toBe(3);
    expect(db.run.status).toBe('ok');
    expect(db.task.status).toBe('review');
    expect(db.task.deliverable).toBe('tamamlandi');
    expect(db.agent.status).toBe('idle');
  });

  it('veri nihai yazimi surekli dusuruyorsa asgari failed yazimi yapilir ve kosu terminal olur', async () => {
    const db = new SahteMissionDb();
    runAgentEngine.mockResolvedValue(engineResult({ sessionId: 'zehirli-oturum' }));
    // Zehirli alan yalniz tam yazimda var; asgari yazim onu birakir.
    db.failTerminalRunWrite = (data) => typeof data.externalSessionId === 'string';

    const handling = handleAgentRun({ db: db.handle() }, payload());
    await vi.advanceTimersByTimeAsync(sum(FINAL_WRITE_RETRY_DELAYS_MS));
    await expect(handling).resolves.toBeUndefined();

    expect(db.terminalWriteAttempts).toBe(1 + FINAL_WRITE_RETRY_DELAYS_MS.length + 1);
    expect(db.run.status).toBe('failed');
    expect(db.run.externalSessionId).toBeNull();
    expect(db.task.status).toBe('blocked');
    expect(db.task.deliverable).toBeNull();
    expect(db.agent.status).toBe('idle');
    expect(db.comments).toContainEqual(
      expect.objectContaining({
        authorType: 'system',
        kind: 'note',
        body: expect.stringContaining('yazilamadi') as unknown,
      }),
    );
    expect(db.events).toContainEqual(
      expect.objectContaining({ kind: 'run_finished', detail: 'basarisiz: sonuc kaydedilemedi' }),
    );
  });

  it('veritabani tamamen kapaliysa sinirli denemeden sonra firlatir (is failed olur, uzlastirici sonlandirir)', async () => {
    const db = new SahteMissionDb();
    db.failTerminalRunWrite = () => true;

    const handling = handleAgentRun({ db: db.handle() }, payload());
    const rejected = expect(handling).rejects.toThrow(/nihai durum yazilamadi/);
    await vi.advanceTimersByTimeAsync(
      sum(FINAL_WRITE_RETRY_DELAYS_MS) + sum(FALLBACK_WRITE_RETRY_DELAYS_MS),
    );
    await rejected;

    expect(db.terminalWriteAttempts).toBe(
      1 + FINAL_WRITE_RETRY_DELAYS_MS.length + 1 + FALLBACK_WRITE_RETRY_DELAYS_MS.length,
    );
    expect(db.run.status).toBe('running');
  });

  it('yeniden deneme gecikmeleri sinirlidir (sonsuz bekleme yok)', () => {
    expect(
      sum(FINAL_WRITE_RETRY_DELAYS_MS) + sum(FALLBACK_WRITE_RETRY_DELAYS_MS),
    ).toBeLessThanOrEqual(30_000);
  });
});
