import { requireRole, type WorkspaceScope } from '@smith/tenancy';

import { newSessionId } from '../ids.js';
import type { Tx } from '../scoped.js';

/**
 * Oturum repository'si. Her fonksiyon WorkspaceScope ister — kapsamsiz
 * cagri derlenmez. where filtreleri RLS'in birinci katman kopyasidir.
 */

export interface SessionRecord {
  id: string;
  workspaceId: string;
  actorId: string;
  surface: string;
  createdAt: Date;
}

export async function createSession(
  tx: Tx,
  scope: WorkspaceScope,
  input: { surface: string },
): Promise<SessionRecord> {
  requireRole(scope, 'member');
  return tx.session.create({
    data: {
      id: newSessionId(),
      workspaceId: scope.workspaceId,
      actorId: scope.actorId,
      surface: input.surface,
    },
  });
}

export async function findSession(
  tx: Tx,
  scope: WorkspaceScope,
  sessionId: string,
): Promise<SessionRecord | null> {
  return tx.session.findFirst({
    where: { id: sessionId, workspaceId: scope.workspaceId },
  });
}
