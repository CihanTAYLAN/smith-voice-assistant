import { type DbHandle, type Tx, withScope } from '@smith/db';
import {
  AGENT_ENGINES,
  addComment,
  assignTask,
  createAgent,
  createTask,
  deleteAgentIfUnused,
  deliverTask,
  findAgent,
  findAgentBySlug,
  findTask,
  InvalidTransitionError,
  isTaskStatus,
  listAgents,
  listComments,
  listEvents,
  listRuns,
  listTasks,
  MissionError,
  moveTask,
  RUNNABLE_TASK_STATUSES,
  summarizeRunUsage,
  USER_TASK_TRANSITIONS,
  updateAgent,
  type AgentRecord,
} from '@smith/mission';
import type { Queue } from '@smith/queue';
import { ForbiddenError, hasAtLeastRole, requireRole, type WorkspaceScope } from '@smith/tenancy';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';

import { scopeFromAuthHeader } from '../bearer.js';
import { createAgentRunReconciler } from './agent-run-reconciler.js';
import { allowedToolSchema, workRootSchema } from './mission-agent-input.js';

/**
 * MISSION CONTROL UCLARI (`/v1/mission/*`) — ekip, gorev panosu ve etkinlik
 * akisi (ADR 0007).
 *
 * TEK YUZEY, IKI TUKETICI: pano penceresi (masaustu) ve Smith'in sesli
 * araclari ayni ucleri cagirir. Hafizada oldugu gibi ayri bir
 * `/v1/tools/mission/*` yuzeyi ACILMADI — iki yuzey iki dogruluk kaynagi
 * demektir ve zamanla ayrisir.
 *
 * Yetki: `Authorization: Bearer <access token>`, WS ile ayni token. Kapsam
 * token'dan cikar, RLS `withScope` ile uygulanir; hicbir uc kiraci sinirini
 * gecmez.
 *
 * Kuyruk: is, atama COMMIT EDILDIKTEN SONRA kuyruga girer ve `jobId` kosu
 * kaydinin id'sidir. Sira bilincli — commit edilmemis bir atamanin isi
 * kuyruga girerse worker olmayan satiri arar. Kuyruga giris istegi bekletmez
 * ve basarisizligi kaybolmaz: `agent-run-reconciler.ts` kuyruga ulasmamis
 * `queued` kosulari yeniden koyar.
 */

const agentRefSchema = z.string().min(2).max(40);

/**
 * Ajanin kostugu makine. `windows` 2026-09-18'de eklendi: Codex motorunun
 * abonelik kimligi bu makinede yasiyor ve is koku Windows lehcesinde olan bir
 * ajan ancak bu etiketle dogru anlatilir (motor makineyi is koku
 * lehcesinden turetir — `engines/codex.ts` → `resolveCodexHost`).
 */
const agentDeviceSchema = z.enum(['wsl', 'windows', 'm2', 'server']);

const createAgentSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/, 'slug kucuk harfle baslar; kucuk harf, rakam ve tire icerir'),
  displayName: z.string().min(1).max(64),
  role: z.string().min(1).max(48),
  soul: z.string().min(10),
  model: z.string().min(1).optional(),
  parentSlug: agentRefSchema.optional(),
  device: agentDeviceSchema.optional(),
  workRoots: z.array(workRootSchema).max(10).optional(),
  allowedTools: z.array(allowedToolSchema).max(30).optional(),
});

const updateAgentSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  role: z.string().min(1).max(48).optional(),
  soul: z.string().min(10).optional(),
  model: z.string().min(1).nullable().optional(),
  parentSlug: agentRefSchema.nullable().optional(),
  device: agentDeviceSchema.optional(),
  workRoots: z.array(workRootSchema).max(10).optional(),
  allowedTools: z.array(allowedToolSchema).max(30).optional(),
  /**
   * Devre disi birakma yolu. `offline` bir ajani ekipte TUTAR ama panoda
   * "kapali" gosterir — kosu gecmisi olan ajan icin SILMENIN yerine gecen
   * islem budur (bkz. DELETE ucu). `working` elle set edilmez: onu executor
   * yazar, insan eliyle yazmak panoda yalan uretir.
   */
  status: z.enum(['idle', 'offline']).optional(),
});

const createTaskSchema = z.object({
  title: z.string().min(3).max(200),
  detail: z.string().max(8000).optional(),
  priority: z.number().int().min(1).max(3).optional(),
  dueAt: z.string().datetime().optional(),
  parentId: z.string().min(1).optional(),
  /** Varsa gorev ayni cagrida atanir — "bunu Nova'ya ver" tek istektir. */
  assignee: agentRefSchema.optional(),
  /** ui | voice — akista "Smith acti" ile "ben actim" ayrisir. */
  via: z.enum(['ui', 'voice']).optional(),
});

/**
 * Atama istegi. `engine` OPSIYONEL ve varsayilani `claude-code`dir: eski
 * istemciler (ve Smith'in sesli araclari) motor belirtmeden calismaya devam
 * eder — sozlesme geriye donuk uyumludur.
 */
const assignSchema = z.object({
  assignee: agentRefSchema,
  engine: z.enum(AGENT_ENGINES).optional(),
});
const statusSchema = z.object({ status: z.string().min(1) });
const commentSchema = z.object({
  body: z.string().min(1).max(4000),
  kind: z.enum(['note', 'claim', 'review', 'refute']).optional(),
});
const deliverSchema = z.object({
  agent: agentRefSchema,
  deliverable: z.string().min(1).max(8000),
  artifactPath: z.string().min(1).optional(),
});

class DeliveryAgentMismatchError extends Error {
  constructor() {
    super('Gorev yalniz atanmis ajan tarafindan teslim edilebilir.');
    this.name = 'DeliveryAgentMismatchError';
  }
}

/**
 * /status ile elle yapilamayan hedefler: calisma yalniz /assign ile baslar (kosu
 * kaydi orada olusur). Elle yazilan `assigned`/`in_progress`, sahipsiz ya da kosusuz
 * gorevi "calisiyor" gosterir ve hicbir sey calismaz.
 */
/**
 * Panoya giden gecis tablosu = sunucunun /status ile KABUL ettikleri. Pano kendi
 * kopyasini tutsaydi ya da ham tabloyu alsaydi kullaniciya her zaman 409 yiyen
 * dugmeler gosterilirdi. Tek kaynak `packages/mission/src/status.ts`.
 */
export function createMissionRoutes(deps: {
  db: DbHandle;
  sessionSecret: string;
  agentRunQueue: Queue;
}): Hono {
  const app = new Hono();

  const scopeOf = (authHeader: string | undefined) =>
    scopeFromAuthHeader(deps.sessionSecret, authHeader);
  const runReconciler = createAgentRunReconciler({
    db: deps.db,
    queue: deps.agentRunQueue,
  });

  /**
   * Yazma uclari ve maliyet okumasi en az 'member' ister (domain ayni kurali
   * uygular). Viewer DB'ye inmeden temiz bir 403 alir, 500 degil. Token'siz
   * istegi rota kendi 401'iyle reddeder.
   */
  const memberGuard: MiddlewareHandler = async (c, next) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return next();
    const readOnly = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (!readOnly || c.req.path.endsWith('/usage')) {
      try {
        requireRole(scope, 'member');
      } catch (error) {
        return errorResponse(c, error);
      }
    }
    if (hasAtLeastRole(scope, 'member')) runReconciler.remember(scope);
    return next();
  };
  app.use('*', memberGuard);

  /**
   * Ajan tanimi (SOUL, is kokleri, izinli araclar) worker'in motor bayraklarina
   * akar: kullanicinin makinesinde dosya/arac erisimi tanimlamak owner/admin isidir.
   * `member` gorev acabilir ve atayabilir ama ajanin yetkisini genisletemez.
   */
  const adminGuard: MiddlewareHandler = async (c, next) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (scope) {
      try {
        requireRole(scope, 'admin');
      } catch (error) {
        return errorResponse(c, error);
      }
    }
    return next();
  };

  /**
   * Ajan referansi slug VEYA id olabilir: sesli yolda elde daima slug ("nova")
   * vardir, UI id gonderir. Tek cozumleyici ikisini de kabul eder.
   */
  const resolveAgent = (tx: Tx, scope: WorkspaceScope, ref: string): Promise<AgentRecord | null> =>
    ref.startsWith('agt_')
      ? findAgent(tx, scope, ref)
      : findAgentBySlug(tx, scope, ref.replace(/^@/, ''));

  /**
   * Kosuyu kuyruga koyar. `jobId` = kosu id'si: ayni atama iki kez kuyruga
   * girse BullMQ ikinci isi kabul etmez; kabul etse de consumer 'queued'
   * olmayan satiri gorup atlar. Iki katmanli koruma, cunku bu is para harcar.
   *
   * ISTEGI BEKLETMEZ: Redis kapaliyken BullMQ komutlari reddetmez, baglanti
   * gelene kadar asili kalir. Atama zaten commit edildi; kuyruga girememesi
   * kaybolmaz, `queued` AgentRun satiri outbox'tir ve uzlastirici yeniden koyar.
   */
  const enqueueRun = (runId: string, scope: WorkspaceScope): void => {
    void deps.agentRunQueue
      .add(
        'run',
        { workspaceId: scope.workspaceId, actorId: scope.actorId, runId },
        { jobId: runId },
      )
      .catch((error: unknown) => {
        console.warn(
          `[gateway] AgentRun ilk enqueue basarisiz (${runId}); outbox uzlastiracak: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };

  // -------------------------------------------------------------------------
  // Pano
  // -------------------------------------------------------------------------

  /**
   * Panonun tek acilis cagrisi: org semasi, kanban ve akis birlikte gelir.
   * Uc ayri istek yerine tek istek — pencere acilirken yarim durum gostermez.
   */
  app.get('/board', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const board = await withScope(deps.db.prisma, scope, async (tx) => ({
      agents: await listAgents(tx, scope),
      tasks: await listTasks(tx, scope),
      events: await listEvents(tx, scope, 60),
      /**
       * Gecis tablosu panoya BURADAN gider. Pano kendi kopyasini tutsaydi
       * kullaniciya gosterilen dugmeler ile sunucunun kabul ettigi gecisler
       * zamanla ayrisirdi (kullanici 409 yiyen bir dugmeye basar). Kaynak
       * `packages/mission/src/status.ts`, /status'un kabul ettigine suzulmus.
       */
      transitions: USER_TASK_TRANSITIONS,
    }));
    return c.json(board);
  });

  /**
   * Sesli brifing: "panoda ne var" sorusunun veri karsiligi. Konusma metnini
   * model kurar; buradan yalniz sayilar ve basliklar doner.
   */
  app.get('/summary', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const summary = await withScope(deps.db.prisma, scope, async (tx) => {
      const tasks = await listTasks(tx, scope);
      const agents = await listAgents(tx, scope);
      const counts: Record<string, number> = {};
      for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
      const slugOf = new Map(agents.map((a) => [a.id, a.slug]));
      return {
        counts,
        // Kullanicinin eylem bekleyen isleri: inceleme ve engel.
        review: tasks
          .filter((t) => t.status === 'review')
          .map((t) => ({
            id: t.id,
            title: t.title,
            agent: t.assigneeId ? (slugOf.get(t.assigneeId) ?? null) : null,
          })),
        blocked: tasks
          .filter((t) => t.status === 'blocked')
          .map((t) => ({ id: t.id, title: t.title })),
        working: agents
          .filter((a) => a.status === 'working')
          .map((a) => ({ slug: a.slug, displayName: a.displayName })),
        squadSize: agents.length,
      };
    });
    return c.json(summary);
  });

  app.get('/events', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const raw = Number(c.req.query('limit') ?? 60);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 200) : 60;
    const events = await withScope(deps.db.prisma, scope, (tx) => listEvents(tx, scope, limit));
    return c.json({ events });
  });

  // -------------------------------------------------------------------------
  // Kullanim (motor is gucu)
  // -------------------------------------------------------------------------

  /**
   * MOTOR KULLANIM OZETI — panelin "kullanim" bolumu ve maliyet sorusu.
   *
   * Salt okuma; kapsam token'dan cikar ve RLS `withScope` ile uygulanir.
   * Pencere siniri ve neden muhasebe olmadigi: `summarizeRunUsage`.
   */
  app.get('/usage', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const usage = await withScope(deps.db.prisma, scope, (tx) => summarizeRunUsage(tx, scope));
    return c.json(usage);
  });

  // -------------------------------------------------------------------------
  // Ekip
  // -------------------------------------------------------------------------

  app.get('/agents', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);
    const agents = await withScope(deps.db.prisma, scope, (tx) => listAgents(tx, scope));
    return c.json({ agents });
  });

  app.post('/agents', adminGuard, async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const body = createAgentSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: body.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    const input = body.data;

    try {
      const agent = await withScope(deps.db.prisma, scope, async (tx) => {
        const parent = input.parentSlug ? await findAgentBySlug(tx, scope, input.parentSlug) : null;
        if (input.parentSlug && !parent) {
          throw new MissionError(`Ust ajan bulunamadi: ${input.parentSlug}`, 'agent_not_found');
        }
        return createAgent(tx, scope, {
          slug: input.slug,
          displayName: input.displayName,
          role: input.role,
          soul: input.soul,
          ...(input.model ? { model: input.model } : {}),
          ...(parent ? { parentId: parent.id } : {}),
          ...(input.device ? { device: input.device } : {}),
          ...(input.workRoots ? { workRoots: input.workRoots } : {}),
          ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        });
      });
      return c.json({ agent }, 201);
    } catch (error) {
      // Ayni slug ikinci kez: benzersizlik kisiti DB'de, mesaj kullaniciya.
      if (error instanceof Error && error.message.includes('Unique constraint')) {
        return c.json({ error: `Bu slug zaten kullanimda: ${input.slug}` }, 409);
      }
      return errorResponse(c, error);
    }
  });

  /** Panodan SOUL / rol / cihaz duzenleme. */
  app.patch('/agents/:id', adminGuard, async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const body = updateAgentSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: body.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    const patch = body.data;

    try {
      const agent = await withScope(deps.db.prisma, scope, async (tx) => {
        const target = await resolveAgent(tx, scope, c.req.param('id'));
        if (!target) return null;

        let parentId: string | null | undefined;
        if (patch.parentSlug === null) {
          parentId = null;
        } else if (patch.parentSlug !== undefined) {
          const parent = await findAgentBySlug(tx, scope, patch.parentSlug);
          if (!parent) {
            throw new MissionError(`Ust ajan bulunamadi: ${patch.parentSlug}`, 'agent_not_found');
          }
          // Kendi ustu olmak org semasini dongue cevirir.
          if (parent.id === target.id) {
            throw new MissionError('Bir ajan kendi ustu olamaz', 'agent_not_found');
          }
          parentId = parent.id;
        }

        return updateAgent(tx, scope, target.id, {
          ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
          ...(patch.role === undefined ? {} : { role: patch.role }),
          ...(patch.soul === undefined ? {} : { soul: patch.soul }),
          ...(patch.model === undefined ? {} : { model: patch.model }),
          ...(patch.device === undefined ? {} : { device: patch.device }),
          ...(patch.workRoots === undefined ? {} : { workRoots: patch.workRoots }),
          ...(patch.allowedTools === undefined ? {} : { allowedTools: patch.allowedTools }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(parentId === undefined ? {} : { parentId }),
        });
      });
      if (!agent) return c.json({ error: 'ajan bulunamadi' }, 404);
      return c.json({ agent });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  /**
   * Ajani siler — YALNIZ kosu gecmisi yoksa (409 aksi halde).
   *
   * `AgentRun.agentId` CASCADE oldugu icin calismis bir ajani silmek harcanan
   * maliyetin kaydini da siler; bu geri alinamaz bir muhasebe kaybidir. Yanlis
   * yazilmis TAZE bir ajani temizlemek ise mesru bir istir ve panoda karsiligi
   * olmali. Ayrim sunucuda, panoda degil: iki istemci ayni kurali tekrar
   * etmesin.
   *
   * Yetki: olusturma ve guncelleme gibi en az `admin`; ekibi bicimlendirmek
   * `member`in isi degil, ajan tanimi isidir (bkz. `adminGuard`).
   */
  app.delete('/agents/:id', adminGuard, async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const sonuc = await withScope(deps.db.prisma, scope, async (tx) => {
      const target = await resolveAgent(tx, scope, c.req.param('id'));
      if (!target) return null;
      return { slug: target.slug, ...(await deleteAgentIfUnused(tx, scope, target.id)) };
    });

    if (!sonuc) return c.json({ error: 'ajan bulunamadi' }, 404);
    if (!sonuc.deleted) {
      return c.json(
        {
          error:
            `@${sonuc.slug} silinemez: ${sonuc.runCount} kosu kaydi var ve silmek ` +
            'maliyet gecmisini de silerdi. Devre disi birakmak icin status=offline gonder.',
          runCount: sonuc.runCount,
        },
        409,
      );
    }
    return c.json({ deleted: true, slug: sonuc.slug });
  });

  // -------------------------------------------------------------------------
  // Gorevler
  // -------------------------------------------------------------------------

  app.get('/tasks', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const status = c.req.query('status');
    if (status !== undefined && !isTaskStatus(status)) {
      return c.json({ error: `gecersiz durum: ${status}` }, 400);
    }
    const tasks = await withScope(deps.db.prisma, scope, (tx) =>
      listTasks(tx, scope, status === undefined ? {} : { status }),
    );
    return c.json({ tasks });
  });

  app.get('/tasks/:id', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const detail = await withScope(deps.db.prisma, scope, async (tx) => {
      const task = await findTask(tx, scope, c.req.param('id'));
      if (!task) return null;
      return {
        task,
        comments: await listComments(tx, scope, task.id),
        runs: await listRuns(tx, scope, { taskId: task.id }),
      };
    });
    if (!detail) return c.json({ error: 'gorev bulunamadi' }, 404);
    return c.json(detail);
  });

  /**
   * Gorev yarat — istege bagli olarak ayni cagrida ata ve kosuyu kuyruga koy.
   * Sesli akisin tek adimi budur: "sabah brifingini hazirla, Nova'ya ver".
   */
  app.post('/tasks', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const body = createTaskSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: body.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    const input = body.data;

    try {
      const created = await withScope(deps.db.prisma, scope, async (tx) => {
        if (input.parentId) {
          const parent = await findTask(tx, scope, input.parentId);
          if (!parent) {
            throw new MissionError(`Ust gorev bulunamadi: ${input.parentId}`, 'task_not_found');
          }
        }
        const task = await createTask(tx, scope, {
          title: input.title,
          ...(input.detail ? { detail: input.detail } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.parentId ? { parentId: input.parentId } : {}),
          ...(input.dueAt ? { dueAt: new Date(input.dueAt) } : {}),
          createdBy: input.via === 'voice' ? 'smith' : scope.actorId,
        });

        if (!input.assignee) return { task, runId: null as string | null };

        const agent = await resolveAgent(tx, scope, input.assignee);
        if (!agent) {
          throw new MissionError(`Ajan bulunamadi: ${input.assignee}`, 'agent_not_found');
        }
        const assigned = await assignTask(tx, scope, { taskId: task.id, agentId: agent.id });
        return { task: assigned.task, runId: assigned.run.id };
      });

      if (created.runId) enqueueRun(created.runId, scope);
      return c.json(created, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/tasks/:id/assign', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const body = assignSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: body.error.issues.map((i) => i.message).join('; ') }, 400);
    }

    try {
      const assigned = await withScope(deps.db.prisma, scope, async (tx) => {
        const agent = await resolveAgent(tx, scope, body.data.assignee);
        if (!agent) {
          throw new MissionError(`Ajan bulunamadi: ${body.data.assignee}`, 'agent_not_found');
        }
        return assignTask(tx, scope, {
          taskId: c.req.param('id'),
          agentId: agent.id,
          ...(body.data.engine ? { engine: body.data.engine } : {}),
        });
      });
      enqueueRun(assigned.run.id, scope);
      return c.json({ task: assigned.task, runId: assigned.run.id }, 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/tasks/:id/status', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const body = statusSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'status gerekli' }, 400);

    const next = body.data.status;
    if (!isTaskStatus(next)) return c.json({ error: `gecersiz durum: ${next}` }, 400);
    if (RUNNABLE_TASK_STATUSES.includes(next)) {
      return c.json(
        {
          error:
            `Gorev durumu elle '${next}' yapilamaz: calisma yalniz atamayla baslar ve kosu ` +
            "kaydi olusur. 'Ata ve calistir' (POST /tasks/:id/assign) kullan.",
        },
        409,
      );
    }

    try {
      const task = await withScope(deps.db.prisma, scope, (tx) =>
        moveTask(tx, scope, c.req.param('id'), next, {
          authorType: 'user',
          authorId: scope.actorId,
        }),
      );
      return c.json({ task });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/tasks/:id/comments', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const body = commentSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'body gerekli' }, 400);

    try {
      const comment = await withScope(deps.db.prisma, scope, async (tx) => {
        const task = await findTask(tx, scope, c.req.param('id'));
        if (!task) throw new MissionError('Gorev bulunamadi', 'task_not_found');
        return addComment(tx, scope, {
          taskId: task.id,
          authorType: 'user',
          authorId: scope.actorId,
          body: body.data.body,
          ...(body.data.kind ? { kind: body.data.kind } : {}),
        });
      });
      return c.json({ comment }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  /**
   * Teslim ucu. Yerel executor bunu KULLANMAZ (worker repo'yu dogrudan cagirir);
   * bu uc, kendi cihazinda kosan bir ajanin teslimini bildirmesi icin durur —
   * Faz 2'de uzak cihaz ajanlari bu yolu kullanacak.
   */
  app.post('/tasks/:id/deliver', async (c) => {
    const scope = scopeOf(c.req.header('authorization'));
    if (!scope) return c.json({ error: 'yetkisiz' }, 401);

    const body = deliverSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'agent ve deliverable gerekli' }, 400);

    try {
      const task = await withScope(deps.db.prisma, scope, async (tx) => {
        const agent = await resolveAgent(tx, scope, body.data.agent);
        if (!agent) throw new MissionError('Ajan bulunamadi', 'agent_not_found');
        // Gorev satiri kilitlenir: kontrol edilen atanan, teslim anina kadar
        // eszamanli bir yeniden atamayla degisemez.
        const taskId = c.req.param('id');
        await tx.$queryRaw`
          SELECT "id" FROM "Task"
          WHERE "id" = ${taskId} AND "workspaceId" = ${scope.workspaceId}
          FOR UPDATE
        `;
        const lockedTask = await findTask(tx, scope, taskId);
        if (!lockedTask) throw new MissionError('Gorev bulunamadi', 'task_not_found');
        if (lockedTask.assigneeId !== agent.id) throw new DeliveryAgentMismatchError();
        return deliverTask(tx, scope, {
          taskId,
          agentId: agent.id,
          deliverable: body.data.deliverable,
          ...(body.data.artifactPath ? { artifactPath: body.data.artifactPath } : {}),
        });
      });
      return c.json({ task });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return app;
}

/**
 * Domain hatalarini HTTP'ye cevirir; beklenmeyen hata YUKARI GIDER (yutulmaz).
 * Gecersiz durum gecisi 409: istek bicimsel olarak dogru ama panonun o anki
 * durumuyla celisiyor.
 *
 * `MissionError` kodlari: YALNIZ `*_not_found` ile bitenler 404; digerleri
 * (`active_run`, `already_assigned`, `agent_offline`, ...) gorevin/ajanin o anki
 * durumuyla celisen reddlerdir, 409. Kural sonekle tanimli oldugundan paketin
 * yeni kodlari bu dosyada liste guncellemeden dogru eslenir.
 */
function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof ForbiddenError) return c.json({ error: error.message }, 403);
  if (error instanceof MissionError) {
    return c.json({ error: error.message }, error.code.endsWith('_not_found') ? 404 : 409);
  }
  if (error instanceof DeliveryAgentMismatchError) return c.json({ error: error.message }, 409);
  if (error instanceof InvalidTransitionError) return c.json({ error: error.message }, 409);
  throw error;
}
