import type { DbHandle, Tx } from '@smith/db';
import { memoryMaintenanceEnvSchema } from '@smith/env';
import type { MemoryMaintenanceJob, Queue } from '@smith/queue';
import { describe, expect, it, vi } from 'vitest';

import { syncMemoryMaintenanceSchedules } from './memory-maintenance-scheduler.js';

const workspaceId = 'ws_aaaaaaaaaaaaaaaaaaaa';
const actorId = 'act_bbbbbbbbbbbbbbbbbbbb';
function fixture() {
  const config = memoryMaintenanceEnvSchema.parse({
    SMITH_MEMORY_MAINTENANCE_TIMEZONE: 'Europe/Istanbul',
  });
  const actors = vi.fn().mockResolvedValue([{ id: actorId, workspaceIds: [workspaceId] }]);
  const membership = vi.fn().mockResolvedValue({ actorId });
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    actor: { findMany: actors },
    membership: { findFirst: membership },
  } as unknown as Tx;
  const db = {
    prisma: { $transaction: <T>(fn: (tx: Tx) => Promise<T>) => fn(tx) },
  } as unknown as DbHandle;
  const upsert = vi.fn().mockResolvedValue({});
  const get = vi.fn().mockResolvedValue([]);
  const remove = vi.fn().mockResolvedValue(true);
  const queue = {
    upsertJobScheduler: upsert,
    getJobSchedulers: get,
    removeJobScheduler: remove,
  } as unknown as Pick<
    Queue<MemoryMaintenanceJob>,
    'upsertJobScheduler' | 'getJobSchedulers' | 'removeJobScheduler'
  >;
  return { config, actors, membership, db, queue, upsert, get, remove };
}

describe('hafiza bakimi zamanlamasi', () => {
  it('yerel 03:30 icin workspace basina tek cron kurar', async () => {
    const f = fixture();
    await syncMemoryMaintenanceSchedules(f.db, f.queue, f.config);
    expect(f.upsert).toHaveBeenCalledWith(
      `memory-maintenance-${workspaceId}`,
      { pattern: '30 3 * * *', tz: 'Europe/Istanbul' },
      expect.objectContaining({
        data: { workspaceId, actorId, reason: 'periyodik-hafiza-bakimi' },
        opts: { attempts: 1 },
      }),
    );
    expect(f.membership).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId, actorId, role: { in: ['owner', 'admin', 'member'] } },
      }),
    );
  });
  it('aralik cron yerine every olarak kurulur', async () => {
    const f = fixture();
    f.config.SMITH_MEMORY_MAINTENANCE_INTERVAL_MS = 3_600_000;
    await syncMemoryMaintenanceSchedules(f.db, f.queue, f.config);
    expect(f.upsert.mock.calls[0]?.[1]).toEqual({ every: 3_600_000 });
  });
  it('ayni takvimi tekrar upsert etmez, bekleyen isi korur', async () => {
    const f = fixture();
    f.get.mockResolvedValue([
      {
        key: `memory-maintenance-${workspaceId}`,
        pattern: '30 3 * * *',
        tz: 'Europe/Istanbul',
        template: { data: { workspaceId, actorId } },
      },
    ]);
    await syncMemoryMaintenanceSchedules(f.db, f.queue, f.config);
    expect(f.upsert).not.toHaveBeenCalled();
  });
  it('kapali bayrak eski takvimleri kaldirir ve DB kesfi yapmaz', async () => {
    const f = fixture();
    f.config.SMITH_MEMORY_MAINTENANCE = '0';
    f.get.mockResolvedValue([{ key: `memory-maintenance-${workspaceId}` }, { key: 'unrelated' }]);
    await syncMemoryMaintenanceSchedules(f.db, f.queue, f.config);
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(`memory-maintenance-${workspaceId}`);
    expect(f.actors).not.toHaveBeenCalled();
    expect(f.upsert).not.toHaveBeenCalled();
  });
  it('uyelik yoksa takvim kurulmaz', async () => {
    const f = fixture();
    f.membership.mockResolvedValue(null);
    await syncMemoryMaintenanceSchedules(f.db, f.queue, f.config);
    expect(f.upsert).not.toHaveBeenCalled();
  });
  it('ayni workspace icin birden fazla aktor takvimi cogaltmaz', async () => {
    const f = fixture();
    f.actors.mockResolvedValue([
      { id: actorId, workspaceIds: [workspaceId] },
      { id: 'act_cccccccccccccccccccc', workspaceIds: [workspaceId] },
    ]);
    await syncMemoryMaintenanceSchedules(f.db, f.queue, f.config);
    expect(f.upsert).toHaveBeenCalledTimes(1);
  });
  it('gecersiz esik, aralik, bayrak ve saat dilimi acilista reddedilir', () => {
    for (const raw of [
      { SMITH_MEMORY_MAINTENANCE_SIMILARITY: '2' },
      { SMITH_MEMORY_MAINTENANCE_INTERVAL_MS: '-1' },
      { SMITH_MEMORY_MAINTENANCE: 'false' },
      { SMITH_MEMORY_MAINTENANCE_TIMEZONE: 'invalid' },
    ]) {
      expect(memoryMaintenanceEnvSchema.safeParse(raw).success).toBe(false);
    }
    expect(memoryMaintenanceEnvSchema.parse({})).toMatchObject({
      SMITH_MEMORY_MAINTENANCE: '1',
      SMITH_MEMORY_MAINTENANCE_MAX_CLUSTERS: 10,
      SMITH_MEMORY_MAINTENANCE_SIMILARITY: 0.92,
    });
  });
});
