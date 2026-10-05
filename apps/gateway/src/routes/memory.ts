import { withScope, type DbHandle } from '@smith/db';
import {
  answerMemoryGap,
  EMBED_TIMEOUT_MS,
  findMemoryGap,
  GAP_STATUSES,
  getMemoryGapSources,
  listMemoryGaps,
  MemoryGapConflict,
  memoryGapAnswerContent,
  redactSecrets,
  transitionMemoryGap,
  type Embedder,
} from '@smith/memory';
import { QueueName, type MemoryMaintenanceJob, type Queue } from '@smith/queue';
import { ForbiddenError, requireRole } from '@smith/tenancy';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { scopeFromAuthHeader } from '../bearer.js';

const gapId = z.string().regex(/^gap_[0-9a-z]{20,32}$/);
const answerSchema = z.object({ answer: z.string().trim().min(1).max(4000) }).strict();
const querySchema = z.object({
  status: z.enum(GAP_STATUSES).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export function createMemoryRoutes(deps: {
  db: DbHandle;
  sessionSecret: string;
  embedder: Embedder;
  maintenanceQueue: Pick<Queue<MemoryMaintenanceJob>, 'add'>;
  maintenanceEnabled: boolean;
}): Hono {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 20_000 }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const scope = scopeFromAuthHeader(deps.sessionSecret, c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);
    if (c.req.method !== 'GET') {
      try {
        requireRole(scope, 'member');
      } catch (error) {
        if (error instanceof ForbiddenError) return c.json({ error: 'yetki yetersiz' }, 403);
        throw error;
      }
    }
    await next();
  });
  const scopeOf = (auth: string | undefined) => {
    const scope = scopeFromAuthHeader(deps.sessionSecret, auth);
    if (!scope) throw new Error('Hafiza auth middleware calismadi.');
    return scope;
  };

  app.get('/gaps', async (c) => {
    const query = querySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'gecersiz sorgu' }, 400);
    const scope = scopeOf(c.req.header('authorization'));
    const gaps = await withScope(deps.db.prisma, scope, (tx) =>
      listMemoryGaps(tx, scope, query.data.status, query.data.limit),
    );
    return c.json({ gaps });
  });

  app.post('/gaps/:id/answer', async (c) => {
    const id = gapId.safeParse(c.req.param('id'));
    const body = answerSchema.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return c.json({ error: 'gecersiz bosluk veya cevap' }, 400);
    const safe = redactSecrets(body.data.answer);
    if (safe.secretOnly || !safe.text.trim())
      return c.json({ error: 'cevap yalniz gizli veri iceremez' }, 400);
    const scope = scopeOf(c.req.header('authorization'));
    const snapshot = await withScope(deps.db.prisma, scope, async (tx) => {
      const gap = await findMemoryGap(tx, scope, id.data);
      return gap
        ? { gap, sources: await getMemoryGapSources(tx, scope, gap.sourceMemoryIds) }
        : null;
    });
    if (!snapshot) return c.json({ error: 'bosluk bulunamadi' }, 404);
    if (
      !['open', 'asked'].includes(snapshot.gap.status) ||
      snapshot.sources.length !== snapshot.gap.sourceMemoryIds.length
    )
      return c.json({ error: 'bosluk veya kaynaklari degisti' }, 409);
    const embedding = await deps.embedder.embed(
      memoryGapAnswerContent(snapshot.gap.question, safe.text, snapshot.sources),
      {
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(EMBED_TIMEOUT_MS)]),
        singleAttempt: true,
      },
    );
    try {
      const memoryId = await withScope(deps.db.prisma, scope, (tx) =>
        answerMemoryGap(tx, scope, {
          id: id.data,
          question: snapshot.gap.question,
          answer: safe.text,
          embedding,
          sources: snapshot.sources,
        }),
      );
      return c.json({ ok: true, memoryId, status: 'answered' });
    } catch (error) {
      if (error instanceof MemoryGapConflict) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  for (const action of ['asked', 'dismiss'] as const) {
    app.post(`/gaps/:id/${action}`, async (c) => {
      const id = gapId.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'gecersiz bosluk' }, 400);
      const scope = scopeOf(c.req.header('authorization'));
      const status = action === 'dismiss' ? 'dismissed' : 'asked';
      const result = await withScope(deps.db.prisma, scope, (tx) =>
        transitionMemoryGap(tx, scope, id.data, status),
      );
      if (result === 'missing') return c.json({ error: 'bosluk bulunamadi' }, 404);
      if (result === 'conflict') return c.json({ error: 'bosluk zaten kapandi' }, 409);
      return c.json({ ok: true, status });
    });
  }

  app.post('/maintenance/run', async (c) => {
    if (!deps.maintenanceEnabled) return c.json({ error: 'hafiza bakimi kapali' }, 503);
    const scope = scopeOf(c.req.header('authorization'));
    // Tamamlanana kadar workspace basina tek elle tetikleme.
    const job = await deps.maintenanceQueue.add(
      QueueName.MEMORY_MAINTENANCE,
      {
        workspaceId: scope.workspaceId,
        actorId: scope.actorId,
        reason: 'kullanici-elle-tetikledi',
      },
      {
        jobId: `manual-memory-maintenance-${scope.workspaceId}`,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    return c.json({ queued: true, jobId: job.id }, 202);
  });
  return app;
}
