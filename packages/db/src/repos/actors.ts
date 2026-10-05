import type { WorkspaceId } from '@smith/tenancy';

import type { Tx } from '../scoped.js';

/**
 * Actor global bir kimliktir (RLS'e tabi degil); Membership tenant verisidir.
 */

export interface ActorRecord {
  id: string;
  email: string;
  displayName: string;
  /**
   * Kesif icin denormalize liste (bkz. schema.prisma Actor yorumu). Rol/yetki
   * kararlarinda KULLANILMAZ -- sadece "hangi workspace'e bakayim" sorusuna
   * RLS'e carpmadan cevap verir. Gercek karar findMembership'ten gelir.
   */
  workspaceIds: string[];
}

export async function findActorByEmail(tx: Tx, email: string): Promise<ActorRecord | null> {
  return tx.actor.findUnique({
    where: { email },
    select: { id: true, email: true, displayName: true, workspaceIds: true },
  });
}

export interface MembershipRecord {
  workspaceId: string;
  actorId: string;
  role: string;
}

/**
 * Verilen workspace'te bu actor'un uyeligini dondurur.
 *
 * Bilincli olarak WorkspaceScope degil ham WorkspaceId alir: giris/kayit
 * akislarinda henuz dogrulanmis bir scope yoktur, hedef workspace istekten
 * gelen bir parametredir. Branded tip cagiran tarafi once toWorkspaceId()
 * ile dogrulamaya zorlar; duz string kabul edilmez.
 */
export async function findMembership(
  tx: Tx,
  workspaceId: WorkspaceId,
  actorId: string,
): Promise<MembershipRecord | null> {
  return tx.membership.findFirst({
    where: { workspaceId, actorId },
  });
}
