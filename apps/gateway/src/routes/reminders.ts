import { newReminderId, withScope, type DbHandle, type Tx } from '@smith/db';
import { hasAtLeastRole, type WorkspaceScope } from '@smith/tenancy';
import { Hono } from 'hono';
import { z } from 'zod';

import { scopeFromAuthHeader } from '../bearer.js';
import { reminderBodyLimit } from './reminders-body-limit.js';
import { claimDue, createKeyedReminder } from './reminders-queries.js';

const createSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .refine((text) => [...text].length <= 500),
  idempotency_key: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[\x20-\x7e]+$/)
    .optional(),
  due_at: z
    .string()
    .datetime({ offset: true })
    .refine((value) => Number.isFinite(Date.parse(value))),
});

const localTime = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function serialize(row: { id: string; text: string; dueAt: Date }) {
  return {
    id: row.id,
    text: row.text,
    due_at: row.dueAt.toISOString(),
    due_at_yerel: localTime.format(row.dueAt),
  };
}

const calendar = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'longOffset',
});

/** Clamp the anniversary in Istanbul's calendar, including just after midnight. */
function oneYearAfter(now: Date): Date {
  const parts = Object.fromEntries(
    calendar.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  const year = Number(parts['year']) + 1;
  const month = Number(parts['month']);
  const day = Math.min(Number(parts['day']), new Date(Date.UTC(year, month, 0)).getUTCDate());
  const anniversary = new Date(Date.UTC(year, month - 1, day));
  const offset =
    calendar
      .formatToParts(anniversary)
      .find((part) => part.type === 'timeZoneName')
      ?.value.replace('GMT', '') || 'Z';
  return new Date(
    `${year}-${parts['month']}-${String(day).padStart(2, '0')}T${parts['hour']}:${parts['minute']}:${parts['second']}.${String(now.getUTCMilliseconds()).padStart(3, '0')}${offset}`,
  );
}

const deliveredSchema = z.object({ claimToken: z.string().min(1).max(128) });

export function createReminderRoutes(deps: { db: DbHandle; sessionSecret: string }) {
  const app = new Hono<{ Variables: { scope: WorkspaceScope } }>();

  app.use('*', async (c, next) => {
    const scope = scopeFromAuthHeader(deps.sessionSecret, c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);
    if (
      (c.req.method === 'POST' || c.req.path.endsWith('/due')) &&
      !hasAtLeastRole(scope, 'member')
    ) {
      return c.json({ error: "Bu islem en az 'member' rolu gerektirir." }, 403);
    }
    c.header('Cache-Control', 'no-store');
    c.set('scope', scope);
    await next();
  });

  app.use('*', reminderBodyLimit);

  app.post('/', async (c) => {
    const body = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        {
          error:
            'text 1-500 karakter, due_at ofsetli ISO 8601, idempotency_key 1-80 yazdirilabilir ASCII olmali',
        },
        400,
      );
    }
    const scope = c.get('scope');
    const dueAt = new Date(body.data.due_at);
    const now = new Date();
    const validWindow = dueAt > now && dueAt <= oneYearAfter(now);
    if (body.data.idempotency_key === undefined && !validWindow) {
      return c.json({ error: 'due_at gelecekte ve en fazla bir yil sonra olmali' }, 400);
    }
    const id = newReminderId();
    const row = await withScope(deps.db.prisma, scope, async (tx) => {
      const idempotencyKey = body.data.idempotency_key;
      if (idempotencyKey !== undefined) {
        // Lost responses may be retried after dueAt; replay the original first.
        const existing = await tx.reminder.findFirst({
          where: {
            workspaceId: scope.workspaceId,
            actorId: scope.actorId,
            idempotencyKey,
          },
        });
        if (existing) return existing;
      }
      if (!validWindow) return null;
      const data = { id, text: body.data.text, dueAt };
      return idempotencyKey !== undefined
        ? createKeyedReminder(tx, scope, { ...data, idempotencyKey })
        : tx.reminder.create({
            data: {
              ...data,
              workspaceId: scope.workspaceId,
              actorId: scope.actorId,
              source: 'voice',
            },
          });
    });
    if (!row) return c.json({ error: 'due_at gelecekte ve en fazla bir yil sonra olmali' }, 400);
    return c.json(serialize(row), row.id === id ? 201 : 200);
  });

  app.get('/', async (c) => {
    const scope = c.get('scope');
    const rows = await withScope(deps.db.prisma, scope, (tx) => listPending(tx, scope));
    return c.json({ reminders: rows.map(serialize) });
  });

  // Claim commits before the response; abandoned leases become eligible in 120s.
  app.get('/due', async (c) => {
    const scope = c.get('scope');
    const rows = await withScope(deps.db.prisma, scope, (tx) => claimDue(tx, scope, new Date()));
    return c.json({
      reminders: rows.map((row) => ({
        ...serialize(row),
        claimToken: row.claimToken,
        claimExpiresAt: row.claimExpiresAt?.toISOString(),
      })),
    });
  });

  for (const action of ['cancel', 'delivered'] as const) {
    app.post(`/:id/${action}`, async (c) => {
      const scope = c.get('scope');
      let claimToken: string | undefined;
      if (action === 'delivered') {
        const body = deliveredSchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: 'claimToken gerekli' }, 400);
        claimToken = body.data.claimToken;
      }
      const now = new Date();
      const result = await withScope(deps.db.prisma, scope, async (tx) => {
        const where = {
          id: c.req.param('id'),
          workspaceId: scope.workspaceId,
          actorId: scope.actorId,
        };
        const { count } = await tx.reminder.updateMany({
          where: {
            ...where,
            deliveredAt: null,
            cancelledAt: null,
            ...(claimToken !== undefined
              ? { dueAt: { lte: now }, claimToken, claimExpiresAt: { gt: now } }
              : {}),
          },
          data: action === 'cancel' ? { cancelledAt: now } : { deliveredAt: now },
        });
        return { count, row: count === 0 ? await tx.reminder.findFirst({ where }) : null };
      });
      if (result.count > 0) return c.json({ ok: true });
      const row = result.row;
      if (!row) return c.json({ error: 'hatirlatma bulunamadi' }, 404);
      if (action === 'cancel') {
        if (row.deliveredAt) return c.json({ error: 'zaten teslim edildi' }, 409);
      } else {
        if (row.cancelledAt) return c.json({ error: 'zaten iptal edildi' }, 409);
        if (row.claimToken !== claimToken) return c.json({ error: 'claimToken eslesmiyor' }, 409);
        // Successful ACK retries remain valid after expiry, only for the same token.
        if (!row.deliveredAt)
          return c.json({ error: 'teslim kirasi gecersiz veya suresi dolmus' }, 409);
      }
      return c.json({ ok: true });
    });
  }

  return app;
}

function listPending(tx: Tx, scope: WorkspaceScope) {
  return tx.reminder.findMany({
    where: {
      workspaceId: scope.workspaceId,
      actorId: scope.actorId,
      deliveredAt: null,
      cancelledAt: null,
    },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    take: 50,
  });
}
