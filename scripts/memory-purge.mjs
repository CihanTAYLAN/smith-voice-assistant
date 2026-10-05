import { pathToFileURL } from 'node:url';

import { contextExcluded, parseContextExclude } from '../packages/memory/src/context-exclude.ts';
import pg from 'pg';

const MEMORY_SELECT = `SELECT "id", "workspaceId", "sourceType", "sourceId", "content", "status", "supersededById"
FROM "Memory" ORDER BY "workspaceId", "id"`;
const GAP_SELECT = `SELECT "id", "workspaceId", "question", "sourceMemoryIds"
FROM "MemoryGap" ORDER BY "workspaceId", "id"`;

export function buildPurgePlan(memories, gaps, rawRules) {
  const rules = typeof rawRules === 'string' ? parseContextExclude(rawRules) : rawRules;
  const matched = memories.filter((row) =>
    contextExcluded({ sourceId: row.sourceId, content: row.content }, rules),
  );
  const memoryIds = matched.map((row) => row.id).sort();
  const memoryIdSet = new Set(memoryIds);
  const consolidatedIds = new Set(
    matched.filter((row) => row.sourceType === 'consolidated').map((row) => row.id),
  );
  const reactivateIds = memories
    .filter(
      (row) =>
        row.status === 'superseded' &&
        consolidatedIds.has(row.supersededById) &&
        !memoryIdSet.has(row.id),
    )
    .map((row) => row.id)
    .sort();
  const matchedGaps = gaps.filter(
    (gap) =>
      gap.sourceMemoryIds.some((id) => memoryIdSet.has(id)) ||
      contextExcluded({ sourceId: '', content: gap.question }, rules),
  );
  const gapIds = matchedGaps.map((gap) => gap.id).sort();
  const counts = new Map();
  for (const row of matched) counts.set(row.sourceType, (counts.get(row.sourceType) ?? 0) + 1);
  const sourceTypeCounts = Object.fromEntries(
    [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  const sampleSourceIds = [...new Set(matched.map((row) => row.sourceId))].sort().slice(0, 20);
  const workspaceIds = [
    ...new Set([
      ...matched.map((row) => row.workspaceId),
      ...matchedGaps.map((gap) => gap.workspaceId),
    ]),
  ].sort();

  return { memoryIds, gapIds, reactivateIds, sourceTypeCounts, sampleSourceIds, workspaceIds };
}

async function loadSnapshot(client) {
  const memoryResult = await client.query(MEMORY_SELECT);
  const gapResult = await client.query(GAP_SELECT);
  return { memories: memoryResult.rows, gaps: gapResult.rows };
}

function writeReport(plan, apply, write) {
  write(apply ? 'MOD: UYGULA' : 'MOD: KURU KOSU, veritabanina yazilmadi.');
  write(`Eslesen Memory: ${plan.memoryIds.length}`);
  write(`Silinecek MemoryGap: ${plan.gapIds.length}`);
  write(`Yeniden aktif olacak kaynak: ${plan.reactivateIds.length}`);
  write('sourceType dagilimi:');
  const distributions = Object.entries(plan.sourceTypeCounts);
  if (distributions.length === 0) write('  (yok)');
  for (const [sourceType, count] of distributions) write(`  ${sourceType}: ${count}`);
  write('Ornek sourceId (en fazla 20):');
  if (plan.sampleSourceIds.length === 0) write('  (yok)');
  for (const sourceId of plan.sampleSourceIds) write(`  ${sourceId}`);
}

export async function executeMemoryPurge({ client, apply, rawRules, write = console.log }) {
  write('UYARI: --apply oncesinde dev veritabaninin yedegini alin.');
  const rules = parseContextExclude(rawRules);
  if (rules.sourceGlobs.length === 0 && rules.keywords.length === 0) {
    throw new Error('SMITH_CONTEXT_EXCLUDE bos; islem yapilmadi.');
  }

  await client.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    if (!apply) {
      const snapshot = await loadSnapshot(client);
      const plan = buildPurgePlan(snapshot.memories, snapshot.gaps, rules);
      writeReport(plan, false, write);
      await client.query('ROLLBACK');
      return plan;
    }

    const locked = new Set();
    let plan;
    while (true) {
      const snapshot = await loadSnapshot(client);
      plan = buildPurgePlan(snapshot.memories, snapshot.gaps, rules);
      const missingLocks = plan.workspaceIds.filter((workspaceId) => !locked.has(workspaceId));
      if (missingLocks.length === 0) break;
      for (const workspaceId of missingLocks) {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('memory:' || $1::text, 0))`,
          [workspaceId],
        );
        locked.add(workspaceId);
      }
    }

    writeReport(plan, true, write);
    if (plan.reactivateIds.length > 0) {
      await client.query(
        `UPDATE "Memory" SET "status" = 'active', "supersededById" = NULL
WHERE "id" = ANY($1::text[])`,
        [plan.reactivateIds],
      );
    }
    if (plan.gapIds.length > 0) {
      await client.query(`DELETE FROM "MemoryGap" WHERE "id" = ANY($1::text[])`, [plan.gapIds]);
    }
    if (plan.memoryIds.length > 0) {
      await client.query(`DELETE FROM "Memory" WHERE "id" = ANY($1::text[])`, [plan.memoryIds]);
    }
    await client.query('COMMIT');
    return plan;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--apply');
  if (unknown.length > 0) throw new Error(`Bilinmeyen arguman: ${unknown.join(', ')}`);
  const databaseUrl = process.env.MIGRATE_DATABASE_URL;
  if (!databaseUrl) throw new Error('MIGRATE_DATABASE_URL gerekli (superuser baglantisi).');
  const rawRules = process.env.SMITH_CONTEXT_EXCLUDE ?? '';
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await executeMemoryPurge({
      client,
      apply: process.argv.includes('--apply'),
      rawRules,
    });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      `memory-purge basarisiz: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
