import { issueAccessToken } from '@smith/auth';
import { readFileSync } from 'node:fs';
import { newActorId, newWorkspaceId, type DbHandle } from '@smith/db';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createToolRoutes } from './tools.js';

const SECRET = 'reminders-test-secret';
const NOW = new Date('2026-10-03T06:00:00.000Z');
const workspaceId = newWorkspaceId();
const actorId = newActorId();
const otherWorkspaceId = newWorkspaceId();
const otherActorId = newActorId();

interface Row {
  id: string;
  workspaceId: string;
  actorId: string;
  text: string;
  dueAt: Date;
  source: string;
  createdAt: Date;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  idempotencyKey: string | null;
}

interface Where {
  id?: string;
  workspaceId?: string;
  actorId?: string;
  deliveredAt?: null;
  cancelledAt?: null;
  dueAt?: { lte: Date };
  claimToken?: string;
  claimExpiresAt?: { gt: Date };
  idempotencyKey?: string;
}

interface ReminderResponse {
  id: string;
  text: string;
  due_at: string;
  due_at_yerel: string;
  claimToken?: string;
  claimExpiresAt?: string;
}

/** Real JWT and withScope, fake Prisma only. No sockets or DB clients.
 * The fake does NOT enforce RLS: cross-tenant assertions exercise the actual
 * application filters, while rawCalls separately prove transaction scoping.
 */
class Store {
  rows: Row[] = [];
  rawCalls: unknown[][] = [];
  queries: { sql: string; values: unknown[] }[] = [];

  handle(): DbHandle {
    const matches = (row: Row, where: Where) =>
      (where.id === undefined || row.id === where.id) &&
      (where.workspaceId === undefined || row.workspaceId === where.workspaceId) &&
      (where.actorId === undefined || row.actorId === where.actorId) &&
      (where.deliveredAt === undefined || row.deliveredAt === where.deliveredAt) &&
      (where.cancelledAt === undefined || row.cancelledAt === where.cancelledAt) &&
      (where.claimToken === undefined || row.claimToken === where.claimToken) &&
      (where.idempotencyKey === undefined || row.idempotencyKey === where.idempotencyKey) &&
      (where.claimExpiresAt === undefined ||
        (row.claimExpiresAt !== null && row.claimExpiresAt > where.claimExpiresAt.gt)) &&
      (where.dueAt === undefined || row.dueAt <= where.dueAt.lte);

    const tx = {
      // Simulate SQL outcomes, not PostgreSQL locks/RLS. SQL shape is asserted separately.
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        this.queries.push({ sql, values });
        if (sql.includes('INSERT INTO')) {
          const [id, workspace, actor, text, dueAt, key] = values as [
            string,
            string,
            string,
            string,
            Date,
            string,
          ];
          let row = this.rows.find(
            (entry) =>
              entry.workspaceId === workspace &&
              entry.actorId === actor &&
              entry.idempotencyKey === key,
          );
          if (!row) {
            row = seed({
              id,
              workspaceId: workspace,
              actorId: actor,
              text,
              dueAt,
              idempotencyKey: key,
            });
          }
          return Promise.resolve([{ ...row }]);
        }
        const [workspace, actor, now, expiredBy, claimToken, expiresAt] = values as [
          string,
          string,
          Date,
          Date,
          string,
          Date,
        ];
        const rows = this.rows
          .filter(
            (row) =>
              row.workspaceId === workspace &&
              row.actorId === actor &&
              !row.deliveredAt &&
              !row.cancelledAt &&
              row.dueAt <= now &&
              (!row.claimExpiresAt || row.claimExpiresAt <= expiredBy),
          )
          .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.id.localeCompare(b.id))
          .slice(0, 20);
        for (const row of rows) Object.assign(row, { claimToken, claimExpiresAt: expiresAt });
        return Promise.resolve(rows.map((row) => ({ ...row })));
      },
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        this.rawCalls.push([strings.join('?'), ...values]);
        return Promise.resolve(1);
      },
      reminder: {
        create: ({
          data,
        }: {
          data: Omit<
            Row,
            | 'createdAt'
            | 'deliveredAt'
            | 'cancelledAt'
            | 'claimToken'
            | 'claimExpiresAt'
            | 'idempotencyKey'
          >;
        }) => {
          const row: Row = {
            ...data,
            createdAt: new Date(),
            deliveredAt: null,
            cancelledAt: null,
            claimToken: null,
            claimExpiresAt: null,
            idempotencyKey: null,
          };
          this.rows.push(row);
          return Promise.resolve({ ...row });
        },
        findMany: ({
          where,
          orderBy,
          take,
        }: {
          where: Where;
          orderBy: { dueAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' }[];
          take: number;
        }) => {
          const rows = this.rows.filter((row) => matches(row, where));
          rows.sort((a, b) => {
            for (const rule of orderBy) {
              const diff = rule.dueAt
                ? a.dueAt.getTime() - b.dueAt.getTime()
                : a.id.localeCompare(b.id);
              if (diff !== 0) return (rule.dueAt ?? rule.id) === 'asc' ? diff : -diff;
            }
            return 0;
          });
          return Promise.resolve(rows.slice(0, take).map((row) => ({ ...row })));
        },
        updateMany: ({
          where,
          data,
        }: {
          where: Where;
          data: { deliveredAt?: Date; cancelledAt?: Date };
        }) => {
          const rows = this.rows.filter((row) => matches(row, where));
          for (const row of rows) Object.assign(row, data);
          return Promise.resolve({ count: rows.length });
        },
        findFirst: ({ where }: { where: Where }) => {
          const row = this.rows.find((entry) => matches(entry, where));
          return Promise.resolve(row ? { ...row } : null);
        },
      },
    };
    return {
      prisma: { $transaction: <T>(fn: (value: typeof tx) => Promise<T>) => fn(tx) },
    } as unknown as DbHandle;
  }
}

let store: Store;
let app: Hono;
let token: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store = new Store();
  app = new Hono();
  // Exercise the real tools mount, including the existing memory routes.
  app.route(
    '/v1/tools',
    createToolRoutes({
      db: store.handle(),
      sessionSecret: SECRET,
      embedder: {
        model: 'test',
        embed: () => Promise.reject(new Error('Reminder routes must not embed')),
        embedBatch: () => Promise.reject(new Error('Reminder routes must not embed')),
      },
    }),
  );
  token = issueAccessToken(SECRET, { workspaceId, actorId, role: 'owner' });
});

afterEach(() => vi.useRealTimers());

describe('audit regressions', () => {
  it('gives a due reminder to only one concurrent caller', async () => {
    seed();
    const results = await Promise.all([list('/due'), list('/due')]);
    expect(results.map((rows) => rows.length).sort()).toEqual([0, 1]);
    expect(store.queries).toHaveLength(2);
    const sql = store.queries[0]?.sql ?? '';
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/UPDATE "Reminder"/);
    expect(sql).toMatch(/RETURNING/);
    expect(sql).toContain('"workspaceId" = ?');
    expect(sql).toContain('"actorId" = ?');
    expect(sql).toContain('"claimExpiresAt" <= ?');
    expect(sql).toContain('LIMIT 20');
  });

  it('renews an expired lease and rejects the old token', async () => {
    const row = seed();
    const [first] = await list('/due');
    vi.setSystemTime(new Date(NOW.getTime() + 119_999));
    expect(await list('/due')).toEqual([]);
    vi.setSystemTime(new Date(NOW.getTime() + 120_000));
    const [second] = await list('/due');
    expect(second?.id).toBe(row.id);
    expect(second?.claimToken).not.toBe(first?.claimToken);
    expect(
      (await request(`/${row.id}/delivered`, 'POST', { claimToken: first?.claimToken })).status,
    ).toBe(409);
    expect(
      (await request(`/${row.id}/delivered`, 'POST', { claimToken: second?.claimToken })).status,
    ).toBe(200);
  });

  it('requires a token, refuses wrong/unclaimed/expired leases and retains delivered ACK idempotency', async () => {
    const row = seed();
    expect((await request(`/${row.id}/delivered`, 'POST')).status).toBe(400);
    expect((await request(`/${row.id}/delivered`, 'POST', { claimToken: 'unknown' })).status).toBe(
      409,
    );
    const [claimed] = await list('/due');
    expect((await request(`/${row.id}/delivered`, 'POST', { claimToken: 'wrong' })).status).toBe(
      409,
    );
    vi.setSystemTime(new Date(NOW.getTime() + 120_000));
    expect(
      (await request(`/${row.id}/delivered`, 'POST', { claimToken: claimed?.claimToken })).status,
    ).toBe(409);
    expect(row.deliveredAt).toBeNull();
    const [renewed] = await list('/due');
    expect(
      (await request(`/${row.id}/delivered`, 'POST', { claimToken: renewed?.claimToken })).status,
    ).toBe(200);
    vi.setSystemTime(new Date(NOW.getTime() + 300_000));
    expect(
      (await request(`/${row.id}/delivered`, 'POST', { claimToken: renewed?.claimToken })).status,
    ).toBe(200);
    expect((await request(`/${row.id}/delivered`, 'POST', { claimToken: 'wrong' })).status).toBe(
      409,
    );
  });

  it('reports the losing terminal action as a conflict under concurrent requests', async () => {
    const row = seed();
    const [claimed] = await list('/due');
    const responses = await Promise.all([
      request(`/${row.id}/cancel`, 'POST'),
      request(`/${row.id}/delivered`, 'POST', { claimToken: claimed?.claimToken }),
    ]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(Boolean(row.deliveredAt)).not.toBe(Boolean(row.cancelledAt));
  });

  it('returns the first creation on concurrent retries and after its due date', async () => {
    const body = {
      text: 'İlk kayıt',
      due_at: '2026-10-03T07:00:00Z',
      idempotency_key: 'live-call-123',
    };
    const responses = await Promise.all([request('', 'POST', body), request('', 'POST', body)]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 201]);
    const original = (await responses[0]?.json()) as ReminderResponse;
    expect(await responses[1]?.json()).toEqual(original);
    expect(store.rows).toHaveLength(1);
    expect(
      store.queries.some((query) =>
        /ON CONFLICT \("workspaceId", "actorId", "idempotencyKey"\)/.test(query.sql),
      ),
    ).toBe(true);
    vi.setSystemTime(new Date(NOW.getTime() + 7_200_000));
    token = issueAccessToken(SECRET, { workspaceId, actorId, role: 'owner' });
    const retry = await request('', 'POST', { ...body, text: 'Değiştirilmiş' });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(original);
  });

  it.each(['workspace', 'actor'])('scopes idempotency keys by %s', async (boundary) => {
    const body = { text: 'Hatırlat', due_at: '2026-10-03T07:00:00Z', idempotency_key: 'same-key' };
    expect((await request('', 'POST', body)).status).toBe(201);
    const otherToken = issueAccessToken(SECRET, {
      workspaceId: boundary === 'workspace' ? otherWorkspaceId : workspaceId,
      actorId: boundary === 'actor' ? otherActorId : actorId,
      role: 'member',
    });
    expect((await request('', 'POST', body, otherToken)).status).toBe(201);
    expect(store.rows).toHaveLength(2);
  });

  it.each(['', 'x'.repeat(81), 'çağrı', '😀', '\u0000', '\n', 1, null])(
    'rejects invalid idempotency keys (%#)',
    async (key) => {
      expect(
        (
          await request('', 'POST', {
            text: 'Hatırlat',
            due_at: '2026-10-03T07:00:00Z',
            idempotency_key: key,
          })
        ).status,
      ).toBe(400);
      expect(store.rows).toHaveLength(0);
    },
  );

  it('accepts an 80-character ASCII key and leaves unkeyed requests independent', async () => {
    expect(
      (
        await request('', 'POST', {
          text: 'Hatırlat',
          due_at: '2026-10-03T07:00:00Z',
          idempotency_key: 'x'.repeat(80),
        })
      ).status,
    ).toBe(201);
    expect((await create()).id).not.toBe((await create()).id);
  });

  it('uses Istanbul February 29 even when UTC is still February 28', async () => {
    vi.setSystemTime(new Date('2028-02-29T00:30:00+03:00'));
    token = issueAccessToken(SECRET, { workspaceId, actorId, role: 'owner' });
    await create('Sınır', '2029-02-28T00:30:00+03:00');
    for (const due_at of ['2029-02-28T00:30:00.001+03:00', '2029-03-01T00:30:00+03:00']) {
      expect((await request('', 'POST', { text: 'Fazla', due_at })).status).toBe(400);
    }
  });

  it('counts Unicode code points, matching VARCHAR(500)', async () => {
    expect((await create('😀'.repeat(500))).text).toBe('😀'.repeat(500));
    expect(
      (await request('', 'POST', { text: '😀'.repeat(501), due_at: '2026-10-03T07:00:00Z' }))
        .status,
    ).toBe(400);
  });

  it.each(['', '/missing/cancel', '/missing/delivered'])(
    'limits every POST body to 16 KiB without Content-Length (%s)',
    async (path) => {
      const res = await request(path, 'POST', {
        text: 'ok',
        due_at: '2026-10-03T07:00:00Z',
        extra: 'x'.repeat(16 * 1024),
      });
      expect(res.status).toBe(413);
      expect(store.rawCalls).toHaveLength(0);
    },
  );

  it('accepts exactly 16 KiB and rejects oversized declared bodies', async () => {
    const body = { text: 'ok', due_at: '2026-10-03T07:00:00Z', extra: '' };
    body.extra = 'x'.repeat(16 * 1024 - JSON.stringify(body).length);
    expect((await request('', 'POST', body)).status).toBe(201);
    const res = await app.request('/v1/tools/reminders', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-length': '16385' },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });

  it('counts UTF-8 bytes even when Content-Length understates the body', async () => {
    const body = JSON.stringify({
      text: 'ok',
      due_at: '2026-10-03T07:00:00Z',
      extra: '😀'.repeat(5000),
    });
    expect(body.length).toBeLessThan(16 * 1024);
    const res = await app.request('/v1/tools/reminders', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-length': '2' },
      body,
    });
    expect(res.status).toBe(413);
    expect(store.rawCalls).toHaveLength(0);
  });

  it('does not cache lease responses or expose tokens through the pending list', async () => {
    seed();
    const res = await request('/due');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const pending = await list();
    expect(pending[0]).not.toHaveProperty('claimToken');
    expect(pending[0]).not.toHaveProperty('claimExpiresAt');
  });

  it('stops a streamed body at the limit before JSON parsing and cancels the source', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(4096));
          if (pulls === 10) controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const init = {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: stream,
      duplex: 'half' as const,
    };
    const res = await app.request(new Request('http://localhost/v1/tools/reminders', init));
    expect(res.status).toBe(413);
    expect(pulls).toBe(5);
    expect(cancel).toHaveBeenCalledOnce();
    expect(store.rawCalls).toHaveLength(0);
  });

  it('ships an explicit reverse-order rollback and documents Prisma history handling', () => {
    const migration = new URL(
      '../../../../packages/db/prisma/migrations/20261003000000_add_reminder/',
      import.meta.url,
    );
    const down = readFileSync(new URL('down.sql', migration), 'utf8');
    expect(down).toMatch(
      /BEGIN;[\s\S]*REVOKE[\s\S]*DROP POLICY[\s\S]*DROP CONSTRAINT[\s\S]*DROP INDEX[\s\S]*DROP TABLE[\s\S]*COMMIT;/,
    );
    const up = readFileSync(new URL('migration.sql', migration), 'utf8');
    expect(up).toContain('"claimToken" TEXT');
    expect(up).toContain('"claimExpiresAt" TIMESTAMPTZ(3)');
    expect(up).toContain('CREATE UNIQUE INDEX "Reminder_workspaceId_actorId_idempotencyKey_key"');
    const readme = readFileSync(new URL('README.md', migration), 'utf8');
    expect(readme).toContain('db execute');
    expect(readme).toContain('migrate resolve');
    expect(readme).toContain('otomatik');
  });
});

function request(path = '', method = 'GET', body?: unknown, auth = token) {
  return app.request(`/v1/tools/reminders${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function create(text = 'Toplantıyı hatırlat', due_at = '2026-10-03T10:00:00+03:00') {
  const res = await request('', 'POST', { text, due_at });
  expect(res.status).toBe(201);
  return (await res.json()) as ReminderResponse;
}

async function list(path = '', auth = token) {
  const res = await request(path, 'GET', undefined, auth);
  expect(res.status).toBe(200);
  return ((await res.json()) as { reminders: ReminderResponse[] }).reminders;
}

function seed(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: `rem_${String(store.rows.length).padStart(32, '0')}`,
    workspaceId,
    actorId,
    text: 'Hatırlat',
    source: 'voice',
    createdAt: new Date(NOW.getTime() - 60_000),
    dueAt: new Date(NOW),
    deliveredAt: null,
    cancelledAt: null,
    claimToken: null,
    claimExpiresAt: null,
    idempotencyKey: null,
    ...overrides,
  };
  store.rows.push(row);
  return row;
}

describe('reminder creation', () => {
  it('returns UTC and Istanbul time, derives ownership from the token', async () => {
    const res = await request('', 'POST', {
      text: '  Toplantıyı hatırlat  ',
      due_at: '2026-10-03T10:00:00+03:00',
      workspaceId: otherWorkspaceId,
      actorId: otherActorId,
      source: 'untrusted',
      deliveredAt: NOW.toISOString(),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ReminderResponse;
    expect(body).toEqual({
      id: body.id,
      text: 'Toplantıyı hatırlat',
      due_at: '2026-10-03T07:00:00.000Z',
      due_at_yerel: '3 Ekim 2026 10:00',
    });
    expect(body.id).toMatch(/^rem_[0-9a-z]{32}$/);
    expect(store.rows[0]).toMatchObject({
      workspaceId,
      actorId,
      source: 'voice',
      deliveredAt: null,
    });
    expect(store.rawCalls).toEqual([
      ['SELECT set_config(?, ?, true)', 'smith.workspace_id', workspaceId],
    ]);
  });

  it.each(['', '   ', '\n\t', 'x'.repeat(501)])('rejects invalid text (%#)', async (text) => {
    expect((await request('', 'POST', { text, due_at: '2026-10-04T00:00:00Z' })).status).toBe(400);
    expect(store.rows).toHaveLength(0);
    expect(store.rawCalls).toHaveLength(0);
  });

  it('accepts 500 characters', async () => {
    expect((await create('x'.repeat(500))).text).toHaveLength(500);
  });

  it.each([
    '2026-10-03T05:59:59.999Z',
    '2026-10-03T06:00:00.000Z',
    '2027-10-03T06:00:00.001Z',
    '2026-10-04T10:00:00',
    '2026-10-04',
    '2026-02-30T10:00:00Z',
    '2027-02-30T10:00:00Z',
    '2027-02-29T10:00:00Z',
    'not-a-date',
    '2026-10-04T10:00:00+29:00',
  ])('rejects invalid, past or too distant dates: %s', async (due_at) => {
    expect((await request('', 'POST', { text: 'Hatırlat', due_at })).status).toBe(400);
    expect(store.rows).toHaveLength(0);
    expect(store.rawCalls).toHaveLength(0);
  });

  it('accepts the next millisecond and the inclusive one-year boundary', async () => {
    await create('Yakın', '2026-10-03T06:00:00.001Z');
    await create('Bir yıl sonra', '2027-10-03T06:00:00.000Z');
  });

  it('clamps the one-year boundary after February 29', async () => {
    vi.setSystemTime(new Date('2028-02-29T06:00:00Z'));
    token = issueAccessToken(SECRET, { workspaceId, actorId, role: 'owner' });
    await create('Yıldönümü', '2029-02-28T06:00:00Z');
    expect(
      (await request('', 'POST', { text: 'Fazla', due_at: '2029-02-28T06:00:00.001Z' })).status,
    ).toBe(400);
  });

  it.each([null, {}, { text: 42 }, { text: 'Hatırlat', due_at: 42 }])(
    'rejects malformed bodies (%#)',
    async (body) => {
      expect((await request('', 'POST', body)).status).toBe(400);
    },
  );

  it('rejects broken JSON', async () => {
    const res = await app.request('/v1/tools/reminders', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
  });
});

describe('pending and due lists', () => {
  it('returns pending reminders nearest first, including overdue ones', async () => {
    const later = seed({ dueAt: new Date(NOW.getTime() + 60_000) });
    const overdue = seed({ dueAt: new Date(NOW.getTime() - 60_000) });
    const due = seed();
    seed({ deliveredAt: NOW });
    seed({ cancelledAt: NOW });
    expect((await list()).map((row) => row.id)).toEqual([overdue.id, due.id, later.id]);
  });

  it('caps pending lists at 50 with stable ordering for equal dates', async () => {
    const rows = Array.from({ length: 55 }, () => seed());
    store.rows.reverse();
    expect((await list()).map((row) => row.id)).toEqual(rows.slice(0, 50).map((row) => row.id));
  });

  it('claims only due pending reminders without acknowledging delivery', async () => {
    seed({ dueAt: new Date(NOW.getTime() + 1) });
    const exact = seed();
    const overdue = seed({ dueAt: new Date(NOW.getTime() - 1) });
    seed({ deliveredAt: NOW });
    seed({ cancelledAt: NOW });
    const claimed = await list('/due');
    expect(claimed.map((row) => row.id)).toEqual([overdue.id, exact.id]);
    expect(claimed[0]?.claimToken).toEqual(expect.any(String));
    expect(claimed[0]?.claimExpiresAt).toBe('2026-10-03T06:02:00.000Z');
    expect(await list('/due')).toEqual([]);
    expect(overdue.deliveredAt).toBeNull();
  });

  it('caps due lists at the earliest 20', async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      seed({ dueAt: new Date(NOW.getTime() - i * 1000) }),
    );
    expect((await list('/due')).map((row) => row.id)).toEqual(
      rows
        .reverse()
        .slice(0, 20)
        .map((row) => row.id),
    );
  });

  it('returns an empty array when nothing is pending', async () => {
    expect(await list()).toEqual([]);
    expect(await list('/due')).toEqual([]);
  });
});

describe('terminal actions', () => {
  it.each(['cancel', 'delivered'])(
    '%s is idempotent and preserves the first timestamp',
    async (action) => {
      const row = seed();
      const [claimed] = await list('/due');
      const first = await request(`/${row.id}/${action}`, 'POST', {
        claimToken: claimed?.claimToken,
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ ok: true });
      const snapshot = structuredClone(row);
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));
      expect(
        (await request(`/${row.id}/${action}`, 'POST', { claimToken: row.claimToken })).status,
      ).toBe(200);
      expect(row).toEqual(snapshot);
      expect(action === 'cancel' ? row.cancelledAt : row.deliveredAt).toEqual(NOW);
      expect(await list()).toEqual([]);
      expect(await list('/due')).toEqual([]);
    },
  );

  it.each(['cancel', 'delivered'])('the first terminal action wins (%s first)', async (action) => {
    const row = seed();
    await list('/due');
    await request(`/${row.id}/${action}`, 'POST', { claimToken: row.claimToken });
    const snapshot = structuredClone(row);
    const second = action === 'cancel' ? 'delivered' : 'cancel';
    const res = await request(`/${row.id}/${second}`, 'POST', { claimToken: row.claimToken });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: action === 'cancel' ? 'zaten iptal edildi' : 'zaten teslim edildi',
    });
    expect(row).toEqual(snapshot);
  });

  it('rejects delivery before due time but allows cancellation', async () => {
    const row = seed({ dueAt: new Date(NOW.getTime() + 1) });
    expect(
      (await request(`/${row.id}/delivered`, 'POST', { claimToken: 'unclaimed' })).status,
    ).toBe(409);
    expect(row.deliveredAt).toBeNull();
    expect((await request(`/${row.id}/cancel`, 'POST')).status).toBe(200);
  });

  it.each(['cancel', 'delivered'])('returns 404 for unknown IDs (%s)', async (action) => {
    expect((await request(`/missing/${action}`, 'POST', { claimToken: 'unknown' })).status).toBe(
      404,
    );
  });
});

describe('authentication and scope', () => {
  it.each([
    ['', 'GET'],
    ['', 'POST'],
    ['/due', 'GET'],
    ['/missing/cancel', 'POST'],
    ['/missing/delivered', 'POST'],
  ])('requires a valid token: %s %s', async (path, method) => {
    expect((await request(path, method, undefined, '')).status).toBe(401);
    expect((await request(path, method, undefined, 'invalid')).status).toBe(401);
    expect(store.rawCalls).toHaveLength(0);
  });

  it.each(['workspace', 'actor'])('isolates another %s for reads and writes', async (boundary) => {
    const own = seed();
    const foreign = seed(
      boundary === 'workspace' ? { workspaceId: otherWorkspaceId } : { actorId: otherActorId },
    );
    const snapshot = structuredClone(foreign);
    expect((await list()).map((row) => row.id)).toEqual([own.id]);
    expect((await list('/due')).map((row) => row.id)).toEqual([own.id]);
    for (const action of ['cancel', 'delivered']) {
      const res = await request(`/${foreign.id}/${action}`, 'POST', { claimToken: 'foreign' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'hatirlatma bulunamadi' });
    }
    expect(foreign).toEqual(snapshot);
    expect(store.rawCalls).toHaveLength(4);
    expect(store.rawCalls.every((call) => call[2] === workspaceId)).toBe(true);
  });

  it('switches transaction scope when another workspace calls the same app', async () => {
    seed();
    const other = seed({ workspaceId: otherWorkspaceId, actorId: otherActorId });
    const otherToken = issueAccessToken(SECRET, {
      workspaceId: otherWorkspaceId,
      actorId: otherActorId,
      role: 'member',
    });
    expect((await list('/due', otherToken)).map((row) => row.id)).toEqual([other.id]);
    expect(store.rawCalls[0]?.[2]).toBe(otherWorkspaceId);
    expect(
      (
        await request(
          `/${other.id}/delivered`,
          'POST',
          { claimToken: other.claimToken },
          otherToken,
        )
      ).status,
    ).toBe(200);
    expect(store.rawCalls[1]?.[2]).toBe(otherWorkspaceId);
  });

  it('allows viewer reads but refuses every write', async () => {
    const row = seed();
    token = issueAccessToken(SECRET, { workspaceId, actorId, role: 'viewer' });
    expect(await list()).toHaveLength(1);
    expect((await request('/due')).status).toBe(403);
    for (const path of ['', `/${row.id}/cancel`, `/${row.id}/delivered`]) {
      expect(
        (await request(path, 'POST', { text: 'Hatırlat', due_at: '2026-10-04T00:00:00Z' })).status,
      ).toBe(403);
    }
    expect(row.deliveredAt).toBeNull();
    expect(row.cancelledAt).toBeNull();
    expect(store.rawCalls).toHaveLength(1);
  });
});
