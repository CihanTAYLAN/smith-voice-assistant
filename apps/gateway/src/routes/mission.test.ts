import { issueAccessToken } from '@smith/auth';
import { newActorId, newAgentRunId, newTaskId, newWorkspaceId } from '@smith/db';
import type * as DbExports from '@smith/db';
import { MissionError, TASK_TRANSITIONS, USER_TASK_TRANSITIONS } from '@smith/mission';
import type * as MissionExports from '@smith/mission';
import { ForbiddenError } from '@smith/tenancy';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tx: {
    $queryRaw: vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) =>
      Promise.resolve([]),
    ),
    agentRun: { findMany: vi.fn(() => Promise.resolve([])) },
  },
  withScope: vi.fn(),
  createTask: vi.fn(),
  assignTask: vi.fn(),
  findTask: vi.fn(),
  findAgent: vi.fn(),
  findAgentBySlug: vi.fn(),
  deliverTask: vi.fn(),
  listTasks: vi.fn(),
  summarizeRunUsage: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgentIfUnused: vi.fn(),
  listAgents: vi.fn(),
  listEvents: vi.fn(),
  moveTask: vi.fn(),
}));

vi.mock('@smith/db', async (importActual) => {
  const actual = await importActual<typeof DbExports>();
  return {
    ...actual,
    withScope: mocks.withScope,
  };
});

vi.mock('@smith/mission', async (importActual) => {
  const actual = await importActual<typeof MissionExports>();
  return {
    ...actual,
    createTask: mocks.createTask,
    assignTask: mocks.assignTask,
    findTask: mocks.findTask,
    findAgent: mocks.findAgent,
    findAgentBySlug: mocks.findAgentBySlug,
    deliverTask: mocks.deliverTask,
    listTasks: mocks.listTasks,
    summarizeRunUsage: mocks.summarizeRunUsage,
    createAgent: mocks.createAgent,
    updateAgent: mocks.updateAgent,
    deleteAgentIfUnused: mocks.deleteAgentIfUnused,
    listAgents: mocks.listAgents,
    listEvents: mocks.listEvents,
    moveTask: mocks.moveTask,
  };
});

import { createMissionRoutes } from './mission.js';

const SECRET = 'mission-route-test-secret';
const workspaceId = newWorkspaceId();
const actorId = newActorId();
const taskId = newTaskId();
const runId = newAgentRunId();
const agentA = {
  id: 'agt_aaaaaaaaaaaaaaaaaaaa',
  slug: 'nova',
  displayName: 'Nova',
  role: 'developer',
  soul: 'test soul for nova',
  model: null,
  parentId: null,
  device: 'windows',
  workRoots: [],
  allowedTools: [],
  status: 'idle',
  createdAt: new Date(),
  updatedAt: new Date(),
};
const agentB = { ...agentA, id: 'agt_bbbbbbbbbbbbbbbbbbbb', slug: 'atlas' };

function appWith(queueAdd = vi.fn(() => Promise.resolve())): Hono {
  const app = new Hono();
  app.route(
    '/v1/mission',
    createMissionRoutes({
      db: { prisma: {} } as never,
      sessionSecret: SECRET,
      agentRunQueue: { add: queueAdd } as never,
    }),
  );
  return app;
}

function request(
  app: Hono,
  path: string,
  method = 'POST',
  body?: unknown,
  role: 'owner' | 'admin' | 'member' | 'viewer' = 'owner',
) {
  const token = issueAccessToken(SECRET, { workspaceId, actorId, role });
  return app.request(`/v1/mission${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  mocks.withScope.mockImplementation(
    (_prisma: unknown, _scope: unknown, fn: (tx: typeof mocks.tx) => unknown) => fn(mocks.tx),
  );
  mocks.findAgent.mockResolvedValue(null);
  mocks.findAgentBySlug.mockResolvedValue(agentA);
  mocks.findTask.mockResolvedValue({
    id: taskId,
    workspaceId,
    assigneeId: agentA.id,
    status: 'assigned',
  });
  mocks.createTask.mockResolvedValue({ id: taskId, workspaceId, status: 'backlog' });
  mocks.assignTask.mockResolvedValue({
    task: { id: taskId, workspaceId, status: 'assigned', assigneeId: agentA.id },
    run: { id: runId, status: 'queued' },
  });
  mocks.deliverTask.mockResolvedValue({ id: taskId, status: 'review' });
  mocks.listTasks.mockResolvedValue([]);
  mocks.summarizeRunUsage.mockResolvedValue({ totals: {} });
  mocks.createAgent.mockResolvedValue(agentA);
  mocks.updateAgent.mockResolvedValue(agentA);
  mocks.deleteAgentIfUnused.mockResolvedValue({ deleted: true, runCount: 0 });
  mocks.listAgents.mockResolvedValue([]);
  mocks.listEvents.mockResolvedValue([]);
  mocks.moveTask.mockResolvedValue({ id: taskId, workspaceId, status: 'review' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Mission HTTP guvenlik regresyonlari', () => {
  it('parent task ayni scoped transactionda bulunamazsa create etmez', async () => {
    mocks.findTask.mockResolvedValueOnce(null);
    const response = await request(appWith(), '/tasks', 'POST', {
      title: 'Alt gorev',
      parentId: newTaskId(),
    });

    expect(response.status).toBe(404);
    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(mocks.findTask).toHaveBeenCalledWith(mocks.tx, expect.anything(), expect.any(String));
  });

  it('Redis enqueue reddetse de committed AgentRun ile 201 doner ve hatayi loglar', async () => {
    const queueAdd = vi.fn(() => Promise.reject(new Error('redis kapali')));
    const response = await request(appWith(queueAdd), '/tasks', 'POST', {
      title: 'Kuyruk dayaniklilik gorevi',
      assignee: 'nova',
    });

    expect(response.status).toBe(201);
    expect(queueAdd).toHaveBeenCalledWith(
      'run',
      expect.objectContaining({ workspaceId, actorId, runId }),
      { jobId: runId },
    );
    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('outbox uzlastiracak')),
    );
  });

  it('Redis enqueue asili kalsa da (hic cozulmez) istek doner', async () => {
    const queueAdd = vi.fn(() => new Promise<void>(() => undefined));
    const response = await Promise.race([
      request(appWith(queueAdd), `/tasks/${taskId}/assign`, 'POST', { assignee: 'nova' }),
      new Promise<'zaman-asimi'>((resolve) => setTimeout(() => resolve('zaman-asimi'), 2000)),
    ]);

    expect(response).not.toBe('zaman-asimi');
    expect((response as Response).status).toBe(202);
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it('task assignee disindaki agent teslimini 409 reddeder', async () => {
    mocks.findAgentBySlug.mockResolvedValueOnce(agentB);
    const response = await request(appWith(), `/tasks/${taskId}/deliver`, 'POST', {
      agent: 'atlas',
      deliverable: 'Yanlis agent teslimi',
    });

    expect(response.status).toBe(409);
    expect(mocks.deliverTask).not.toHaveBeenCalled();
    expect(mocks.tx.$queryRaw).toHaveBeenCalled();
    const [sql] = mocks.tx.$queryRaw.mock.calls[0] ?? [];
    expect(sql?.join('?')).toMatch(/WHERE "id" = \? AND "workspaceId" = \?[\s\S]*FOR UPDATE/);
  });

  it('atanmis agent teslimi kabul edilir', async () => {
    const response = await request(appWith(), `/tasks/${taskId}/deliver`, 'POST', {
      agent: 'nova',
      deliverable: 'Dogru agent teslimi',
    });

    expect(response.status).toBe(200);
    expect(mocks.deliverTask).toHaveBeenCalledTimes(1);
  });

  it('viewer usage istegini domain ve DB oncesi 403 reddeder', async () => {
    mocks.summarizeRunUsage.mockRejectedValue(
      new ForbiddenError("Bu islem en az 'member' rolu gerektirir.", 'member'),
    );
    const response = await request(appWith(), '/usage', 'GET', undefined, 'viewer');

    expect(response.status).toBe(403);
    expect(mocks.summarizeRunUsage).not.toHaveBeenCalled();
  });

  it('viewer yazma istegini DB oncesi 403 reddeder', async () => {
    const response = await request(
      appWith(),
      '/tasks',
      'POST',
      { title: 'Yetkisiz gorev' },
      'viewer',
    );

    expect(response.status).toBe(403);
    expect(mocks.withScope).not.toHaveBeenCalled();
  });

  it('viewer okuma uclarini kullanabilir', async () => {
    const response = await request(appWith(), '/tasks', 'GET', undefined, 'viewer');

    expect(response.status).toBe(200);
  });

  it('member istegi workspace i AgentRun uzlastiricisina kaydeder, viewer kaydetmez', async () => {
    vi.useFakeTimers();
    const app = appWith();

    await request(app, '/tasks', 'GET', undefined, 'viewer');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.tx.agentRun.findMany).not.toHaveBeenCalled();

    await request(app, '/tasks', 'GET');
    await vi.advanceTimersByTimeAsync(60_000);
    // Tarama iki sorgu atar (queued outbox + lease'i dolmus running); niyet, queued
    // taramasinin yapildigidir, sorgu sayisi degil.
    const queuedScan: unknown = expect.objectContaining({ status: 'queued' });
    expect(mocks.tx.agentRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: queuedScan }),
    );
  });

  it('domain ForbiddenError yazma rotasinda 500 degil 403 olur', async () => {
    mocks.createTask.mockRejectedValue(
      new ForbiddenError("Bu islem en az 'admin' rolu gerektirir.", 'admin'),
    );
    const response = await request(appWith(), '/tasks', 'POST', { title: 'Domain reddi' });

    expect(response.status).toBe(403);
  });
});

/**
 * `active_run` paketin kod birlesimine henuz eklenmedi (derleme bagimliligi
 * yok); hata ayni bicimde, kod string olarak uretilir.
 */
function missionErrorWithCode(message: string, code: string): MissionError {
  return Object.assign(new MissionError(message, 'already_assigned'), { code });
}

describe('MissionError kodlarinin HTTP durumu', () => {
  it('active_run kodu 409 Conflict doner ve kuyruga is koymaz', async () => {
    mocks.assignTask.mockRejectedValue(
      missionErrorWithCode('Aktif kosusu olan gorev yeniden atanamaz', 'active_run'),
    );
    const queueAdd = vi.fn(() => Promise.resolve());

    const response = await request(appWith(queueAdd), `/tasks/${taskId}/assign`, 'POST', {
      assignee: 'nova',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Aktif kosusu olan gorev yeniden atanamaz' });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('active_run gorev olusturup atayan istekte de 409 doner', async () => {
    mocks.assignTask.mockRejectedValue(missionErrorWithCode('Aktif kosu var', 'active_run'));

    const response = await request(appWith(), '/tasks', 'POST', {
      title: 'Atamali gorev',
      assignee: 'nova',
    });

    expect(response.status).toBe(409);
  });

  // Genel kural: YALNIZ `*_not_found` ile biten kodlar 404; digerleri (gorevin o anki
  // durumuyla celisen reddler) 409. Yeni kodlar bu tabloya eklenmeden dogru eslenir.
  it.each(['task_not_found', 'agent_not_found'] as const)('%s kodu 404 doner', async (code) => {
    mocks.assignTask.mockRejectedValue(new MissionError('Reddedildi', code));

    const response = await request(appWith(), `/tasks/${taskId}/assign`, 'POST', {
      assignee: 'nova',
    });

    expect(response.status).toBe(404);
  });

  it.each(['already_assigned', 'agent_offline', 'device_unsupported', 'henuz_bilinmeyen_kod'])(
    '%s kodu 409 doner (404 ile bitmeyen her kod catisma sayilir)',
    async (code) => {
      mocks.assignTask.mockRejectedValue(missionErrorWithCode('Reddedildi', code));

      const response = await request(appWith(), `/tasks/${taskId}/assign`, 'POST', {
        assignee: 'nova',
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'Reddedildi' });
    },
  );

  it('yeni kodlar *_not_found soneki tasirsa 404 kalir', async () => {
    mocks.assignTask.mockRejectedValue(missionErrorWithCode('Cihaz yok', 'device_not_found'));

    const response = await request(appWith(), `/tasks/${taskId}/assign`, 'POST', {
      assignee: 'nova',
    });

    expect(response.status).toBe(404);
  });
});

describe('ajan olusturma ve guncelleme', () => {
  const validAgent = {
    slug: 'nova',
    displayName: 'Nova',
    role: 'developer',
    soul: 'on karakterlik soul metni',
  };

  it.each(['member', 'viewer'] as const)('%s ajan olusturamaz: 403, DB e inilmez', async (role) => {
    const response = await request(appWith(), '/agents', 'POST', validAgent, role);

    expect(response.status).toBe(403);
    expect(mocks.createAgent).not.toHaveBeenCalled();
    expect(mocks.withScope).not.toHaveBeenCalled();
  });

  it.each(['admin', 'owner'] as const)('%s ajan olusturabilir', async (role) => {
    const response = await request(appWith(), '/agents', 'POST', validAgent, role);

    expect(response.status).toBe(201);
    expect(mocks.createAgent).toHaveBeenCalledOnce();
  });

  it.each(['member', 'viewer'] as const)(
    '%s ajan guncelleyemez: 403, DB e inilmez',
    async (role) => {
      const response = await request(
        appWith(),
        `/agents/${agentA.id}`,
        'PATCH',
        { displayName: 'Yeni ad' },
        role,
      );

      expect(response.status).toBe(403);
      expect(mocks.updateAgent).not.toHaveBeenCalled();
      expect(mocks.withScope).not.toHaveBeenCalled();
    },
  );

  it('admin ajan guncelleyebilir', async () => {
    mocks.findAgent.mockResolvedValueOnce(agentA);

    const response = await request(
      appWith(),
      `/agents/${agentA.id}`,
      'PATCH',
      { displayName: 'Yeni ad' },
      'admin',
    );

    expect(response.status).toBe(200);
    expect(mocks.updateAgent).toHaveBeenCalledOnce();
  });

  it.each([
    ['allowedTools', ['Read', '--dangerously-skip-permissions']],
    ['allowedTools', ['-x']],
    ['allowedTools', ['Bash;rm -rf /']],
    ['workRoots', ['C:\\']],
    ['workRoots', ['/mnt/c']],
    ['workRoots', ['\\\\sunucu\\paylasim']],
    ['workRoots', ['/home/x/../../etc']],
    ['workRoots', ['goreli/yol']],
  ])('%s=%j 400 ile reddedilir (olusturma)', async (field, value) => {
    const response = await request(appWith(), '/agents', 'POST', { ...validAgent, [field]: value });

    expect(response.status).toBe(400);
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it.each([
    ['allowedTools', ['Read', '--dangerously-skip-permissions']],
    ['workRoots', ['C:\\']],
    ['workRoots', ['\\\\sunucu\\paylasim']],
  ])('%s=%j 400 ile reddedilir (guncelleme)', async (field, value) => {
    const response = await request(appWith(), `/agents/${agentA.id}`, 'PATCH', {
      [field]: value,
    });

    expect(response.status).toBe(400);
    expect(mocks.updateAgent).not.toHaveBeenCalled();
  });

  it('gecerli arac ve is kokleri kabul edilir', async () => {
    const response = await request(appWith(), '/agents', 'POST', {
      ...validAgent,
      allowedTools: ['Read', 'Bash(git:*)'],
      workRoots: ['/home/alice/workspace/proje', 'C:\\Users\\alice\\proje'],
    });

    expect(response.status).toBe(201);
    expect(mocks.createAgent).toHaveBeenCalledWith(
      mocks.tx,
      expect.anything(),
      expect.objectContaining({
        allowedTools: ['Read', 'Bash(git:*)'],
        workRoots: ['/home/alice/workspace/proje', 'C:\\Users\\alice\\proje'],
      }),
    );
  });
});

describe('ajan silme', () => {
  const deleteAgent = (role: 'owner' | 'admin' | 'member' | 'viewer') =>
    request(appWith(), `/agents/${agentA.id}`, 'DELETE', undefined, role);

  it.each(['member', 'viewer'] as const)('%s ajan silemez: 403, DB e inilmez', async (role) => {
    const response = await deleteAgent(role);

    expect(response.status).toBe(403);
    expect(mocks.deleteAgentIfUnused).not.toHaveBeenCalled();
    expect(mocks.withScope).not.toHaveBeenCalled();
  });

  it.each(['admin', 'owner'] as const)('%s kosu gecmisi olmayan ajani silebilir', async (role) => {
    mocks.findAgent.mockResolvedValueOnce(agentA);

    const response = await deleteAgent(role);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, slug: agentA.slug });
    expect(mocks.deleteAgentIfUnused).toHaveBeenCalledOnce();
  });

  it('kosu gecmisi olan ajan admin icin de 409 ile korunur', async () => {
    mocks.findAgent.mockResolvedValueOnce(agentA);
    mocks.deleteAgentIfUnused.mockResolvedValueOnce({ deleted: false, runCount: 3 });

    const response = await deleteAgent('admin');

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ runCount: 3 });
  });
});

describe('gorev durumu rotasi', () => {
  const setStatus = (status: string, role: 'member' | 'viewer' = 'member') =>
    request(appWith(), `/tasks/${taskId}/status`, 'POST', { status }, role);

  it.each(['assigned', 'in_progress'])(
    'kullanici eylemiyle %s hedefli gecis 409 ile reddedilir ve Ata ve calistir yolunu soyler',
    async (status) => {
      const response = await setStatus(status);

      expect(response.status).toBe(409);
      const { error } = (await response.json()) as { error: string };
      expect(error).toContain('Ata ve calistir');
      expect(error).toContain(`/tasks/:id/assign`);
      expect(mocks.moveTask).not.toHaveBeenCalled();
      expect(mocks.withScope).not.toHaveBeenCalled();
    },
  );

  it.each(['inbox', 'review', 'done', 'blocked'])(
    '%s hedefli gecis eskisi gibi moveTask e gider',
    async (status) => {
      const response = await setStatus(status);

      expect(response.status).toBe(200);
      expect(mocks.moveTask).toHaveBeenCalledWith(mocks.tx, expect.anything(), taskId, status, {
        authorType: 'user',
        authorId: actorId,
      });
    },
  );

  it('gecersiz durum adi 400 kalir', async () => {
    const response = await setStatus('uydurma');

    expect(response.status).toBe(400);
  });

  it('viewer durum degistiremez', async () => {
    const response = await setStatus('review', 'viewer');

    expect(response.status).toBe(403);
    expect(mocks.moveTask).not.toHaveBeenCalled();
  });
});

describe('GET /board gecis tablosu', () => {
  it('panoya yalniz sunucunun kabul ettigi gecisler gider (assigned/in_progress hedefi yok)', async () => {
    const response = await request(appWith(), '/board', 'GET');

    expect(response.status).toBe(200);
    const { transitions } = (await response.json()) as { transitions: Record<string, string[]> };
    expect(Object.keys(transitions).sort()).toEqual(
      ['assigned', 'blocked', 'done', 'in_progress', 'inbox', 'review'].sort(),
    );
    for (const targets of Object.values(transitions)) {
      expect(targets).not.toContain('assigned');
      expect(targets).not.toContain('in_progress');
    }
    expect(transitions.inbox).toEqual(['blocked']);
    // Revizyon ve yeniden acma ATAMAYLA yapilir (domain tablosunda `assigned` hedefi
    // var, /status kabul etmedigi icin panoya dugme olarak gelmez): pano yalniz
    // sahipsiz geri alma (`inbox`) dugmesini gosterir, "Ata ve calistir" ayri durur.
    expect(transitions.review).toEqual(['done', 'inbox', 'blocked']);
    expect(transitions.done).toEqual(['inbox']);
  });

  it('review ve done icin domain tablosu atamayi icerir, pano tablosu icermez', async () => {
    expect(TASK_TRANSITIONS.review).toContain('assigned');
    expect(TASK_TRANSITIONS.done).toContain('assigned');

    const response = await request(appWith(), '/board', 'GET');
    const { transitions } = (await response.json()) as { transitions: Record<string, string[]> };
    expect(transitions.review).not.toContain('assigned');
    expect(transitions.done).not.toContain('assigned');
    expect(transitions).toEqual(USER_TASK_TRANSITIONS);
  });
});
