import { withScope, type DbHandle } from '@smith/db';
import type { MemoryMaintenanceEnv } from '@smith/env';
import {
  memoryMaintenanceJobSchema,
  QueueName,
  type MemoryMaintenanceJob,
  type Queue,
} from '@smith/queue';
import { createSystemScope, createWorkspaceScope, type WorkspaceScope } from '@smith/tenancy';

type MaintenanceQueue = Pick<
  Queue<MemoryMaintenanceJob>,
  'upsertJobScheduler' | 'getJobSchedulers' | 'removeJobScheduler'
>;
const PREFIX = 'memory-maintenance-';

/** Yalniz RLS'siz kok Actor kesfi sistem kapsaminda; uyelik ve hafiza tenant kapsaminda. */
export async function maintenanceScopes(db: DbHandle): Promise<WorkspaceScope[]> {
  const discovery = createSystemScope(
    'Periyodik hafiza bakimi icin kok Actor workspace listesini kesfet.',
  );
  const scopes = new Map<string, WorkspaceScope>();
  let cursor: string | undefined;
  for (;;) {
    const actors = await withScope(db.prisma, discovery, (tx) =>
      tx.actor.findMany({
        select: { id: true, workspaceIds: true },
        orderBy: { id: 'asc' },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );
    for (const actor of actors) {
      for (const workspaceId of actor.workspaceIds) {
        if (scopes.has(workspaceId)) continue;
        const scope = createWorkspaceScope({ workspaceId, actorId: actor.id, role: 'member' });
        const membership = await withScope(db.prisma, scope, (tx) =>
          tx.membership.findFirst({
            where: { workspaceId, actorId: actor.id, role: { in: ['owner', 'admin', 'member'] } },
            select: { actorId: true },
          }),
        );
        if (membership) scopes.set(workspaceId, scope);
      }
    }
    if (actors.length < 100) return [...scopes.values()];
    cursor = actors.at(-1)?.id;
  }
}

export async function syncMemoryMaintenanceSchedules(
  db: DbHandle,
  queue: MaintenanceQueue,
  config: MemoryMaintenanceEnv,
): Promise<void> {
  const scopes = config.SMITH_MEMORY_MAINTENANCE === '0' ? [] : await maintenanceScopes(db);
  const wanted = new Set(scopes.map((s) => `${PREFIX}${s.workspaceId}`));
  const existing = await queue.getJobSchedulers(0, -1, true);
  for (const scheduler of existing) {
    if (scheduler.key.startsWith(PREFIX) && !wanted.has(scheduler.key))
      await queue.removeJobScheduler(scheduler.key);
  }
  for (const scope of scopes) {
    const repeat = config.SMITH_MEMORY_MAINTENANCE_INTERVAL_MS
      ? { every: config.SMITH_MEMORY_MAINTENANCE_INTERVAL_MS }
      : { pattern: '30 3 * * *', tz: config.SMITH_MEMORY_MAINTENANCE_TIMEZONE };
    const current = existing.find((s) => s.key === `${PREFIX}${scope.workspaceId}`);
    const currentPayload = memoryMaintenanceJobSchema.safeParse(current?.template?.data);
    if (
      current &&
      currentPayload.success &&
      currentPayload.data.actorId === scope.actorId &&
      current.every === repeat.every &&
      current.pattern === repeat.pattern &&
      current.tz === repeat.tz
    )
      continue;
    await queue.upsertJobScheduler(`${PREFIX}${scope.workspaceId}`, repeat, {
      name: QueueName.MEMORY_MAINTENANCE,
      data: {
        workspaceId: scope.workspaceId,
        actorId: scope.actorId,
        reason: 'periyodik-hafiza-bakimi',
      },
      opts: { attempts: 1 },
    });
  }
}
