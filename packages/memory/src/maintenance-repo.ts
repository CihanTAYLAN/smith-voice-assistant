import { createHash } from 'node:crypto';

import { newMemoryId, type Tx } from '@smith/db';
import { requireRole, type WorkspaceScope } from '@smith/tenancy';

import { contextExcluded, type ContextExcludeRules } from './context-exclude.js';
import { toVectorLiteral } from './embedder.js';

export interface MaintenanceMemory {
  id: string;
  content: string;
  sensitivity: string;
  sourceType: string;
  sourceId: string;
}

export function memorySetKey(ids: readonly string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');
}

/** Kisa yazma transaction'larini siralar; ag cagrisi boyunca kilit tutulmaz. */
export async function lockMemoryMaintenance(tx: Tx, scope: WorkspaceScope): Promise<void> {
  requireRole(scope, 'member');
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`memory:${scope.workspaceId}`}, 0))`;
}

/** Yazarken tekrar kilitle ve modelin gordugu snapshot'in hala gecerli oldugunu kanitla. */
export async function lockMemorySources(
  tx: Tx,
  scope: WorkspaceScope,
  sources: readonly MaintenanceMemory[],
): Promise<boolean> {
  const ids = sources.map((s) => s.id);
  const rows = await tx.$queryRaw<MaintenanceMemory[]>`
    SELECT "id", "content", "sensitivity", "sourceType", "sourceId" FROM "Memory"
    WHERE "workspaceId" = ${scope.workspaceId} AND "status" = 'active'
      AND "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE
  `;
  return (
    rows.length === sources.length &&
    sources.every((s) =>
      rows.some(
        (r) =>
          r.id === s.id &&
          r.content === s.content &&
          r.sensitivity === s.sensitivity &&
          r.sourceType === s.sourceType &&
          r.sourceId === s.sourceId,
      ),
    )
  );
}

/** Benzerlik DB'de hesaplanir; gunluk donen pencere buyuk hafizayi da zamanla tarar. */
export async function findMemoryClusters(
  tx: Tx,
  scope: WorkspaceScope,
  options: {
    similarity: number;
    limit: number;
    day: string;
    contextExclude?: string | ContextExcludeRules;
  },
): Promise<MaintenanceMemory[][]> {
  const pairs = await tx.$queryRaw<{ a: string; b: string }[]>`
    WITH candidates AS MATERIALIZED (
      SELECT * FROM "Memory" m
      WHERE m."workspaceId" = ${scope.workspaceId} AND m."status" = 'active'
        AND m."sensitivity" IN ('public', 'personal') AND m."sourceType" <> 'profile'
        AND m."embedding" IS NOT NULL AND length(m."content") <= 8000
        AND NOT EXISTS (SELECT 1 FROM "MemoryGap" g WHERE g."workspaceId" = ${scope.workspaceId}
          AND m."id" = ANY(g."sourceMemoryIds"))
      ORDER BY md5(m."id" || ${options.day}) LIMIT 300
    )
    SELECT a."id" AS a, b."id" AS b FROM candidates a JOIN candidates b
      ON a."id" < b."id" AND a."sensitivity" = b."sensitivity"
    WHERE 1 - (a."embedding" <=> b."embedding") >= ${options.similarity}
    ORDER BY a."id", b."id"
  `;
  // Tam bagli kumeler: A~B ve B~C, A~C olmadan tek kume sayilmaz.
  const adjacent = new Set(pairs.map((p) => [p.a, p.b].sort().join('|')));
  const groups: string[][] = [];
  for (const id of [...new Set(pairs.flatMap((p) => [p.a, p.b]))].sort()) {
    const group = groups.find(
      (g) => g.length < 8 && g.every((other) => adjacent.has([id, other].sort().join('|'))),
    );
    if (group) group.push(id);
    else groups.push([id]);
  }
  const selected = groups
    .filter((g) => g.length > 1)
    .sort((a, b) =>
      memorySetKey([options.day, ...a]).localeCompare(memorySetKey([options.day, ...b])),
    )
    .slice(0, options.limit);
  if (selected.length === 0) return [];
  const rows = await tx.memory.findMany({
    where: { workspaceId: scope.workspaceId, status: 'active', id: { in: selected.flat() } },
    select: { id: true, content: true, sensitivity: true, sourceType: true, sourceId: true },
  });
  const allowedRows = rows.filter(
    (row) =>
      !contextExcluded({ sourceId: row.sourceId, content: row.content }, options.contextExclude),
  );
  return selected
    .map((g) => allowedRows.filter((r) => g.includes(r.id)))
    .filter(
      (g) =>
        g.length > 1 &&
        g.every(
          (r) =>
            r.sensitivity === g[0]?.sensitivity &&
            r.sensitivity !== 'secret' &&
            r.sourceType !== 'profile',
        ) &&
        g.reduce((sum, r) => sum + r.content.length, 0) <= 24000,
    );
}

export async function consolidateMemories(
  tx: Tx,
  scope: WorkspaceScope,
  input: {
    sources: MaintenanceMemory[];
    content: string;
    embedding: number[];
    contextExclude?: string | ContextExcludeRules;
  },
): Promise<number> {
  requireRole(scope, 'member');
  const sensitivity = input.sources[0]?.sensitivity;
  if (
    input.sources.length < 2 ||
    !['public', 'personal'].includes(sensitivity ?? '') ||
    input.sources.some(
      (s) =>
        s.sensitivity !== sensitivity ||
        s.sourceType === 'profile' ||
        contextExcluded({ sourceId: s.sourceId, content: s.content }, input.contextExclude),
    )
  )
    return 0;
  await lockMemoryMaintenance(tx, scope);
  if (!(await lockMemorySources(tx, scope, input.sources))) return 0;
  const ids = input.sources.map((s) => s.id);
  const sourceId = `consolidated:${memorySetKey(ids)}`;
  if (contextExcluded({ sourceId, content: input.content }, input.contextExclude)) return 0;
  if (
    await tx.memoryGap.findFirst({
      where: { workspaceId: scope.workspaceId, sourceMemoryIds: { hasSome: ids } },
    })
  )
    return 0;
  const id = newMemoryId();
  const vector = toVectorLiteral(input.embedding);
  await tx.$executeRaw`
    INSERT INTO "Memory" ("id", "workspaceId", "sourceType", "sourceId", "content", "embedding", "sensitivity")
    VALUES (${id}, ${scope.workspaceId}, 'consolidated', ${sourceId}, ${input.content}, ${vector}::vector, ${sensitivity})
  `;
  const updated = await tx.memory.updateMany({
    where: { workspaceId: scope.workspaceId, id: { in: ids }, status: 'active' },
    data: { status: 'superseded', supersededById: id },
  });
  return updated.count;
}

export async function findGapCandidates(
  tx: Tx,
  scope: WorkspaceScope,
  options: { limit: number; day: string; contextExclude?: string | ContextExcludeRules },
): Promise<MaintenanceMemory[]> {
  const rows = await tx.$queryRaw<MaintenanceMemory[]>`
    SELECT m."id", m."content", m."sensitivity", m."sourceType", m."sourceId" FROM "Memory" m
    WHERE m."workspaceId" = ${scope.workspaceId} AND m."status" = 'active'
      AND m."sensitivity" IN ('public', 'personal') AND m."sourceType" NOT IN ('profile', 'answer')
      AND length(m."content") <= 8000
      AND m."content" ~* '(bilinm[iıİI]yor|bilinmed[iıİI]|kaynak.{0,40}(yok|bulunam)|yoktur|varsay[iıİI]m kurul|belirsiz|[cçÇ]eli[sşŞ]ki)'
      AND NOT EXISTS (SELECT 1 FROM "MemoryGap" g WHERE g."workspaceId" = ${scope.workspaceId}
        AND m."id" = ANY(g."sourceMemoryIds"))
    ORDER BY md5(m."id" || ${options.day}) LIMIT ${options.limit}
  `;
  return rows.filter(
    (row) =>
      !contextExcluded({ sourceId: row.sourceId, content: row.content }, options.contextExclude),
  );
}
