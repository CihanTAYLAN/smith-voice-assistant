import { issueAccessToken } from '@smith/auth';
import { newMemoryGapId, type DbHandle, type Tx } from '@smith/db';
import type { Embedder } from '@smith/memory';
import type { MemoryMaintenanceJob, Queue } from '@smith/queue';
import type { Role } from '@smith/tenancy';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createMemoryRoutes } from './memory.js';

const workspaceId = 'ws_aaaaaaaaaaaaaaaaaaaa';
const actorId = 'act_bbbbbbbbbbbbbbbbbbbb';
const secret = 'hafiza-route-test-secret';
interface Row {
  id: string;
  workspaceId: string;
  content: string;
  sourceType: string;
  sourceId: string;
  sensitivity: string;
  status: string;
  supersededById: string | null;
}
interface Gap {
  id: string;
  workspaceId: string;
  question: string;
  sourceMemoryIds: string[];
  status: string;
  answer?: string;
  answerMemoryId?: string;
}
interface Where {
  workspaceId: string;
  id?: string | { in: string[] };
  status?: string | { in: string[] };
}
function matches(row: { id: string; workspaceId: string; status: string }, where: Where): boolean {
  return (
    row.workspaceId === where.workspaceId &&
    (!where.id ||
      (typeof where.id === 'string' ? row.id === where.id : where.id.in.includes(row.id))) &&
    (!where.status ||
      (typeof where.status === 'string'
        ? row.status === where.status
        : where.status.in.includes(row.status)))
  );
}

/** Gercek JWT, route, withScope ve repo; yalniz DB ile embedder sahte. */
function fixture() {
  const rows: Row[] = [
    {
      id: 'mem_aaaaaaaaaaaaaaaaaaaa',
      workspaceId,
      content: 'Cihan Globex projesinde calisiyor. Tam rolu bilinmiyor.',
      sourceType: 'note',
      sourceId: 'note:globex-role',
      sensitivity: 'personal',
      status: 'active',
      supersededById: null,
    },
  ];
  const gaps: Gap[] = [
    {
      id: newMemoryGapId(),
      workspaceId,
      question: 'Globex projesindeki tam rolun ne?',
      sourceMemoryIds: [rows[0]!.id],
      status: 'open',
    },
  ];
  const rls: unknown[] = [];
  const updateGap = vi.fn((args: { where: Where; data: Partial<Gap> }) => {
    const found = gaps.filter((g) => matches(g, args.where));
    found.forEach((g) => Object.assign(g, args.data));
    return Promise.resolve({ count: found.length });
  });
  const tx = {
    $executeRaw: vi.fn((parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      if (sql.includes('set_config')) rls.push(values[1]);
      if (sql.includes('INSERT INTO "Memory"')) {
        const [id, ws, sourceId, content] = values;
        rows.push({
          id: String(id),
          workspaceId: String(ws),
          content: String(content),
          sourceType: 'answer',
          sourceId: String(sourceId),
          sensitivity: 'personal',
          status: 'active',
          supersededById: null,
        });
      }
      return Promise.resolve(1);
    }),
    $queryRaw: vi.fn((_parts: TemplateStringsArray, ws: string, ids: string[]) =>
      Promise.resolve(
        rows
          .filter((r) => r.workspaceId === ws && r.status === 'active' && ids.includes(r.id))
          .map((r) => ({ ...r })),
      ),
    ),
    memory: {
      findMany: vi.fn((args: { where: Where }) =>
        Promise.resolve(rows.filter((r) => matches(r, args.where)).map((r) => ({ ...r }))),
      ),
      updateMany: vi.fn((args: { where: Where; data: Partial<Row> }) => {
        const found = rows.filter((r) => matches(r, args.where));
        found.forEach((r) => Object.assign(r, args.data));
        return Promise.resolve({ count: found.length });
      }),
    },
    memoryGap: {
      findFirst: vi.fn((args: { where: Where }) =>
        Promise.resolve(gaps.find((g) => matches(g, args.where)) ?? null),
      ),
      findMany: vi.fn((args: { where: Where }) =>
        Promise.resolve(gaps.filter((g) => matches(g, args.where))),
      ),
      updateMany: updateGap,
    },
  };
  // Transaction'lar sirali ve rollback'li; RLS motorunu taklit ettigi iddia edilmez.
  let tail: Promise<unknown> = Promise.resolve();
  const db = {
    prisma: {
      $transaction: <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
        const run = tail.then(async () => {
          const before = structuredClone({ rows, gaps });
          try {
            return await fn(tx as unknown as Tx);
          } catch (error) {
            rows.splice(0, rows.length, ...before.rows);
            gaps.splice(0, gaps.length, ...before.gaps);
            throw error;
          }
        });
        tail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    },
  } as unknown as DbHandle;
  const embedder = {
    model: 'test',
    embed: vi.fn<Embedder['embed']>().mockResolvedValue([1, 0]),
    embedBatch: vi.fn<Embedder['embedBatch']>().mockResolvedValue([]),
  };
  const add = vi.fn().mockResolvedValue({ id: 'queued-test' });
  const deps = {
    db,
    sessionSecret: secret,
    embedder,
    maintenanceQueue: { add } as unknown as Pick<Queue<MemoryMaintenanceJob>, 'add'>,
    maintenanceEnabled: true,
  };
  const app = new Hono();
  app.onError(() => new Response('islem basarisiz', { status: 500 }));
  app.route('/v1/memory', createMemoryRoutes(deps));
  return { app, rows, gaps, rls, embedder, add, updateGap, deps };
}

function request(
  app: Hono,
  path: string,
  options: { method?: string; body?: unknown; role?: Role | null; workspace?: string } = {},
) {
  const role = options.role === undefined ? 'member' : options.role;
  return app.request(`/v1/memory${path}`, {
    method: options.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(role
        ? {
            authorization: `Bearer ${issueAccessToken(secret, { workspaceId: options.workspace ?? workspaceId, actorId, role })}`,
          }
        : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe('/v1/memory', () => {
  it('cevap yeni Memory yazar, bosluk kapanir, kaynak superseded olur; diger olgular korunur', async () => {
    const f = fixture();
    const response = await request(f.app, `/gaps/${f.gaps[0]!.id}/answer`, {
      body: { answer: 'Yazilim muhendisiyim.' },
    });
    expect(response.status).toBe(200);
    expect(f.gaps[0]).toMatchObject({
      status: 'answered',
      answer: 'Yazilim muhendisiyim.',
      answerMemoryId: f.rows[1]!.id,
    });
    expect(f.rows[0]).toMatchObject({ status: 'superseded', supersededById: f.rows[1]!.id });
    expect(f.rows[1]?.content).toContain('Globex projesinde calisiyor');
    expect(f.rows[1]?.content).toContain('Yazilim muhendisiyim.');
    expect(f.rows[1]?.sourceType).toBe('answer');
    expect(f.rls.every((ws) => ws === workspaceId)).toBe(true);
    expect(f.rls.length).toBeGreaterThan(1);
  });

  it('ikinci cevap yeni hafiza yazmaz', async () => {
    const f = fixture();
    const path = `/gaps/${f.gaps[0]!.id}/answer`;
    expect((await request(f.app, path, { body: { answer: 'Muhendis' } })).status).toBe(200);
    expect((await request(f.app, path, { body: { answer: 'Muhendis' } })).status).toBe(409);
    expect(f.rows).toHaveLength(2);
    expect(f.embedder.embed).toHaveBeenCalledTimes(1);
  });

  it('sir hem kayittan hem embedding girdisinden redakte edilir', async () => {
    const f = fixture();
    const token = `sk-${'A'.repeat(40)}`;
    expect(
      (
        await request(f.app, `/gaps/${f.gaps[0]!.id}/answer`, {
          body: { answer: `Muhendisim. api_key=${token}` },
        })
      ).status,
    ).toBe(200);
    expect(JSON.stringify(f.rows)).not.toContain(token);
    expect(JSON.stringify(f.gaps)).not.toContain(token);
    expect(JSON.stringify(vi.mocked(f.embedder.embed).mock.calls)).not.toContain(token);
  });

  it('embedding hatasinda hicbir yazim olmaz', async () => {
    const f = fixture();
    vi.mocked(f.embedder.embed).mockRejectedValue(new Error('embedding failed'));
    expect(
      (await request(f.app, `/gaps/${f.gaps[0]!.id}/answer`, { body: { answer: 'Muhendis' } }))
        .status,
    ).toBe(500);
    expect(f.gaps[0]?.status).toBe('open');
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]?.status).toBe('active');
  });

  it('cevabin son yazimi duserse Memory ve kaynak degisimi rollback olur', async () => {
    const f = fixture();
    f.updateGap.mockRejectedValueOnce(new Error('write failed'));
    expect(
      (await request(f.app, `/gaps/${f.gaps[0]!.id}/answer`, { body: { answer: 'Muhendis' } }))
        .status,
    ).toBe(500);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]?.status).toBe('active');
    expect(f.gaps[0]?.status).toBe('open');
  });

  it('embedding sirasinda dismissed olan bosluk cevapla geri acilmaz', async () => {
    const f = fixture();
    const id = f.gaps[0]!.id;
    vi.mocked(f.embedder.embed).mockImplementationOnce(async () => {
      expect((await request(f.app, `/gaps/${id}/dismiss`)).status).toBe(200);
      return [1];
    });
    expect(
      (await request(f.app, `/gaps/${id}/answer`, { body: { answer: 'Muhendis' } })).status,
    ).toBe(409);
    expect(f.rows).toHaveLength(1);
    expect(f.gaps[0]?.status).toBe('dismissed');
  });

  it('embedding sirasinda kaynak degisirse cevap yeni olguyu ezmez', async () => {
    const f = fixture();
    vi.mocked(f.embedder.embed).mockImplementationOnce(() => {
      f.rows[0]!.content = 'degisti';
      return Promise.resolve([1]);
    });
    expect(
      (await request(f.app, `/gaps/${f.gaps[0]!.id}/answer`, { body: { answer: 'Muhendis' } }))
        .status,
    ).toBe(409);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]?.content).toBe('degisti');
  });

  it('baska tenant boslugu goremez veya cevaplayamaz', async () => {
    const f = fixture();
    const workspace = 'ws_cccccccccccccccccccc';
    expect(
      (await request(f.app, `/gaps/${f.gaps[0]!.id}/answer`, { workspace, body: { answer: 'x' } }))
        .status,
    ).toBe(404);
    expect(await (await request(f.app, '/gaps', { method: 'GET', workspace })).json()).toEqual({
      gaps: [],
    });
    expect(f.embedder.embed).not.toHaveBeenCalled();
  });

  it.each(['answer', 'asked', 'dismiss'])('%s kimliksiz 401, viewer 403', async (action) => {
    const f = fixture();
    const path = `/gaps/${f.gaps[0]!.id}/${action}`;
    expect((await request(f.app, path, { role: null, body: { answer: 'x' } })).status).toBe(401);
    expect((await request(f.app, path, { role: 'viewer', body: { answer: 'x' } })).status).toBe(
      403,
    );
    expect(f.rls).toHaveLength(0);
    expect(f.embedder.embed).not.toHaveBeenCalled();
  });

  it('asked, liste filtresi ve dismiss durumlari', async () => {
    const f = fixture();
    const id = f.gaps[0]!.id;
    expect((await request(f.app, `/gaps/${id}/asked`)).status).toBe(200);
    expect(await (await request(f.app, '/gaps?status=open', { method: 'GET' })).json()).toEqual({
      gaps: [],
    });
    const asked = await request(f.app, '/gaps?status=asked', { method: 'GET', role: 'viewer' });
    expect(asked.status).toBe(200);
    expect(asked.headers.get('cache-control')).toBe('no-store');
    expect((await request(f.app, `/gaps/${id}/dismiss`)).status).toBe(200);
    expect((await request(f.app, `/gaps/${id}/asked`)).status).toBe(409);
  });

  it('girdi ve bos cevap dogrulanir', async () => {
    const f = fixture();
    const path = `/gaps/${f.gaps[0]!.id}/answer`;
    for (const answer of ['', '  ', 'x'.repeat(4001), 42])
      expect((await request(f.app, path, { body: { answer } })).status).toBe(400);
    expect((await request(f.app, '/gaps?status=invalid', { method: 'GET' })).status).toBe(400);
    expect((await request(f.app, '/gaps/bad/asked')).status).toBe(400);
    expect(f.embedder.embed).not.toHaveBeenCalled();
  });

  it('elle tetikleme kapsamli ve dedupe edilen kuyruk isi acar', async () => {
    const f = fixture();
    expect((await request(f.app, '/maintenance/run', { role: 'viewer' })).status).toBe(403);
    expect((await request(f.app, '/maintenance/run')).status).toBe(202);
    expect(f.add).toHaveBeenCalledWith(
      'memory-maintenance',
      expect.objectContaining({ workspaceId, actorId }),
      expect.objectContaining({ attempts: 1, jobId: `manual-memory-maintenance-${workspaceId}` }),
    );
    const disabled = createMemoryRoutes({ ...f.deps, maintenanceEnabled: false });
    const r = await disabled.request('/maintenance/run', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${issueAccessToken(secret, { workspaceId, actorId, role: 'member' })}`,
      },
    });
    expect(r.status).toBe(503);
    expect(f.add).toHaveBeenCalledTimes(1);
  });
});
