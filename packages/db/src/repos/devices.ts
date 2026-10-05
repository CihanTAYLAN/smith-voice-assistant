import { requireRole, type WorkspaceScope } from '@smith/tenancy';

import { newDeviceId } from '../ids.js';
import type { Tx } from '../scoped.js';

/**
 * Cihaz registry repository'si (Faz 3). Her fonksiyon WorkspaceScope ister —
 * kapsamsiz cagri derlenmez. where filtreleri RLS'in birinci katman kopyasidir
 * (Session/Memory ile ayni desen).
 */

export interface DeviceRecord {
  id: string;
  workspaceId: string;
  surface: string;
  name: string;
  lastSeenAt: Date;
  createdAt: Date;
}

/**
 * Cihazi kaydeder ya da (ayni workspace+surface varsa) tazeler: `lastSeenAt`
 * guncellenir. Istemci `hello` ile baglaninca cagrilir; boylece registry
 * gercek baglantilardan dolar. Idempotent — tekrar baglanti yan etki uretmez.
 */
export async function registerDevice(
  tx: Tx,
  scope: WorkspaceScope,
  input: { surface: string; name: string },
): Promise<DeviceRecord> {
  requireRole(scope, 'member');
  return tx.device.upsert({
    where: { workspaceId_surface: { workspaceId: scope.workspaceId, surface: input.surface } },
    create: {
      id: newDeviceId(),
      workspaceId: scope.workspaceId,
      surface: input.surface,
      name: input.name,
    },
    update: { name: input.name, lastSeenAt: new Date() },
  });
}

/** Workspace'in kayitli cihazlari, en son gorulen once. */
export async function listDevices(tx: Tx, scope: WorkspaceScope): Promise<DeviceRecord[]> {
  return tx.device.findMany({
    where: { workspaceId: scope.workspaceId },
    orderBy: { lastSeenAt: 'desc' },
  });
}
