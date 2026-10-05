import { randomUUID } from 'node:crypto';

import type { Tx } from '@smith/db';
import type { WorkspaceScope } from '@smith/tenancy';

type Reminder = Awaited<ReturnType<Tx['reminder']['findFirstOrThrow']>>;

/** Called only inside withScope. Row locks prevent two pollers claiming one row. */
export async function claimDue(tx: Tx, scope: WorkspaceScope, now: Date) {
  const claimToken = randomUUID();
  const expiresAt = new Date(now.getTime() + 120_000);
  const rows = await tx.$queryRaw<Reminder[]>`
    WITH candidates AS (
      SELECT "id" FROM "Reminder"
      WHERE "workspaceId" = ${scope.workspaceId}
        AND "actorId" = ${scope.actorId}
        AND "deliveredAt" IS NULL AND "cancelledAt" IS NULL
        AND "dueAt" <= ${now}
        AND ("claimExpiresAt" IS NULL OR "claimExpiresAt" <= ${now})
      ORDER BY "dueAt" ASC, "id" ASC
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Reminder" AS reminder
    SET "claimToken" = ${claimToken}, "claimExpiresAt" = ${expiresAt}
    FROM candidates
    WHERE reminder."id" = candidates."id"
    RETURNING reminder.*
  `;
  // UPDATE RETURNING has no ordering guarantee.
  return rows.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.id.localeCompare(b.id));
}

/** The unique index arbitrates concurrent inserts, including a lost 201 retry. */
export async function createKeyedReminder(
  tx: Tx,
  scope: WorkspaceScope,
  data: { id: string; text: string; dueAt: Date; idempotencyKey: string },
) {
  const [row] = await tx.$queryRaw<Reminder[]>`
    INSERT INTO "Reminder" ("id", "workspaceId", "actorId", "text", "dueAt", "idempotencyKey")
    VALUES (${data.id}, ${scope.workspaceId}, ${scope.actorId}, ${data.text}, ${data.dueAt}, ${data.idempotencyKey})
    ON CONFLICT ("workspaceId", "actorId", "idempotencyKey")
    DO UPDATE SET "idempotencyKey" = EXCLUDED."idempotencyKey"
    RETURNING *
  `;
  if (!row) throw new Error('Reminder INSERT RETURNING returned no row');
  return row;
}
