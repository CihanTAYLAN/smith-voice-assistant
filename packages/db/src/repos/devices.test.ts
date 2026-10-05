import { createWorkspaceScope } from '@smith/tenancy';
import { describe, expect, it, vi } from 'vitest';

import type { Tx } from '../scoped.js';

import { listDevices, registerDevice } from './devices.js';

const WS = 'ws_00000000000000000000';
const ACTOR = 'act_00000000000000000000';
const owner = createWorkspaceScope({ workspaceId: WS, actorId: ACTOR, role: 'owner' });

const rec = {
  id: 'dev_00000000000000000000',
  workspaceId: WS,
  surface: 'cli',
  name: 'Cli',
  lastSeenAt: new Date('2026-08-24T00:00:00Z'),
  createdAt: new Date('2026-08-24T00:00:00Z'),
};

function fakeTx() {
  const upsert = vi.fn().mockResolvedValue(rec);
  const findMany = vi.fn().mockResolvedValue([rec]);
  const tx = { device: { upsert, findMany } } as unknown as Tx;
  return { tx, upsert, findMany };
}

describe('devices repo', () => {
  it('registerDevice upsert eder: (workspace,surface) key, create id + update lastSeenAt', async () => {
    const { tx, upsert } = fakeTx();
    const out = await registerDevice(tx, owner, { surface: 'cli', name: 'Cli' });
    expect(out).toEqual(rec);

    const arg = upsert.mock.calls[0]?.[0] as {
      where: { workspaceId_surface: { workspaceId: string; surface: string } };
      create: { id: string; workspaceId: string; surface: string; name: string };
      update: { name: string; lastSeenAt: Date };
    };
    expect(arg.where.workspaceId_surface).toEqual({ workspaceId: WS, surface: 'cli' });
    expect(arg.create).toMatchObject({ workspaceId: WS, surface: 'cli', name: 'Cli' });
    expect(arg.create.id).toMatch(/^dev_[0-9a-z]{20,32}$/);
    expect(arg.update.name).toBe('Cli');
    expect(arg.update.lastSeenAt).toBeInstanceOf(Date);
  });

  it('listDevices workspace filtreli + lastSeenAt desc', async () => {
    const { tx, findMany } = fakeTx();
    const out = await listDevices(tx, owner);
    expect(out).toEqual([rec]);
    expect(findMany.mock.calls[0]?.[0]).toEqual({
      where: { workspaceId: WS },
      orderBy: { lastSeenAt: 'desc' },
    });
  });

  it('registerDevice viewer rolunu reddeder (requireRole member) — yazma yapilmaz', async () => {
    const viewer = createWorkspaceScope({ workspaceId: WS, actorId: ACTOR, role: 'viewer' });
    const { tx, upsert } = fakeTx();
    await expect(registerDevice(tx, viewer, { surface: 'cli', name: 'Cli' })).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });
});
