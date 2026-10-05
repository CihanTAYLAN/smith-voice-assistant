import { createHash } from 'node:crypto';

import { newMemoryGapId, newMemoryId, type Tx } from '@smith/db';
import { requireRole, type WorkspaceScope } from '@smith/tenancy';

import { contextExcluded, type ContextExcludeRules } from './context-exclude.js';
import { toVectorLiteral } from './embedder.js';
import {
  lockMemoryMaintenance,
  lockMemorySources,
  type MaintenanceMemory,
} from './maintenance-repo.js';
import { redactSecrets } from './redact.js';

export const GAP_STATUSES = ['open', 'asked', 'answered', 'dismissed'] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

export interface MemoryGapRecord {
  id: string;
  workspaceId: string;
  question: string;
  reason: string;
  sourceMemoryIds: string[];
  dedupeKey: string;
  status: string;
  answer: string | null;
  answerMemoryId: string | null;
  createdAt: Date;
  askedAt: Date | null;
  resolvedAt: Date | null;
}

async function memoryGapExcluded(
  tx: Tx,
  scope: WorkspaceScope,
  gap: MemoryGapRecord,
  contextExclude?: string | ContextExcludeRules,
): Promise<boolean> {
  if (contextExcluded({ sourceId: '', content: `${gap.question}\n${gap.reason}` }, contextExclude))
    return true;
  const sources = await tx.memory.findMany({
    where: { workspaceId: scope.workspaceId, id: { in: gap.sourceMemoryIds } },
    select: { sourceId: true, content: true },
  });
  return sources.some((source) =>
    contextExcluded({ sourceId: source.sourceId, content: source.content }, contextExclude),
  );
}

export async function findMemoryGap(
  tx: Tx,
  scope: WorkspaceScope,
  id: string,
  contextExclude?: string | ContextExcludeRules,
): Promise<MemoryGapRecord | null> {
  const gap = await tx.memoryGap.findFirst({ where: { workspaceId: scope.workspaceId, id } });
  if (!gap || (await memoryGapExcluded(tx, scope, gap, contextExclude))) return null;
  return gap;
}

export async function listMemoryGaps(
  tx: Tx,
  scope: WorkspaceScope,
  status: GapStatus,
  limit = 100,
  contextExclude?: string | ContextExcludeRules,
): Promise<MemoryGapRecord[]> {
  const gaps = await tx.memoryGap.findMany({
    where: { workspaceId: scope.workspaceId, status },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
  const visible = await Promise.all(
    gaps.map(async (gap) => ({
      gap,
      excluded: await memoryGapExcluded(tx, scope, gap, contextExclude),
    })),
  );
  return visible.filter(({ excluded }) => !excluded).map(({ gap }) => gap);
}

export async function openMemoryGap(
  tx: Tx,
  scope: WorkspaceScope,
  input: {
    question: string;
    reason: string;
    sources: MaintenanceMemory[];
    contextExclude?: string | ContextExcludeRules;
  },
): Promise<boolean> {
  requireRole(scope, 'member');
  const question = redactSecrets(input.question).text.trim();
  const reason = redactSecrets(input.reason).text.trim();
  if (
    !question ||
    !reason ||
    input.sources.length === 0 ||
    input.sources.some(
      (s) =>
        s.sensitivity === 'secret' ||
        contextExcluded({ sourceId: s.sourceId, content: s.content }, input.contextExclude),
    ) ||
    contextExcluded({ sourceId: '', content: `${question}\n${reason}` }, input.contextExclude)
  )
    return false;
  const sourceMemoryIds = [...new Set(input.sources.map((s) => s.id))].sort();
  const dedupeKey = createHash('sha256')
    .update(
      question
        .normalize('NFKC')
        .toLocaleLowerCase('tr')
        .replace(/[^\p{L}\p{N}]/gu, ''),
    )
    .digest('hex');
  await lockMemoryMaintenance(tx, scope);
  if (!(await lockMemorySources(tx, scope, input.sources))) return false;
  const existing = await tx.memoryGap.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      OR: [{ dedupeKey }, { sourceMemoryIds: { hasSome: sourceMemoryIds } }],
    },
  });
  if (existing) return false;
  await tx.memoryGap.create({
    data: {
      id: newMemoryGapId(),
      workspaceId: scope.workspaceId,
      question,
      reason,
      sourceMemoryIds,
      dedupeKey,
    },
  });
  return true;
}

export class MemoryGapConflict extends Error {
  constructor() {
    super('Bosluk veya kaynaklari degisti; guncel kaydi yeniden oku.');
  }
}

export async function transitionMemoryGap(
  tx: Tx,
  scope: WorkspaceScope,
  id: string,
  action: 'asked' | 'dismissed',
): Promise<'ok' | 'missing' | 'conflict'> {
  requireRole(scope, 'member');
  await lockMemoryMaintenance(tx, scope);
  const gap = await findMemoryGap(tx, scope, id);
  if (!gap) return 'missing';
  if (gap.status === action) return 'ok';
  if (!['open', 'asked'].includes(gap.status)) return 'conflict';
  await tx.memoryGap.updateMany({
    where: { workspaceId: scope.workspaceId, id, status: gap.status },
    data:
      action === 'asked'
        ? { status: action, askedAt: new Date() }
        : { status: action, resolvedAt: new Date() },
  });
  return 'ok';
}

/** Cevap, soru baglamiyla saklanir: tek basina 'evet' aranabilir bir olgu degildir. */
export function memoryGapAnswerContent(
  question: string,
  answer: string,
  sources: readonly MaintenanceMemory[],
): string {
  return redactSecrets(
    `Soru: ${question}\nCihan'in guncel cevabi: ${answer}\nOnceki kaynak baglami (yukaridaki cevap ilgili belirsizlik veya celiskinin yerini alir; diger olgular korunur):\n${sources.map((s) => s.content).join('\n')}`,
  ).text;
}

export async function answerMemoryGap(
  tx: Tx,
  scope: WorkspaceScope,
  input: {
    id: string;
    question: string;
    answer: string;
    embedding: number[];
    sources: MaintenanceMemory[];
    contextExclude?: string | ContextExcludeRules;
  },
): Promise<string> {
  requireRole(scope, 'member');
  await lockMemoryMaintenance(tx, scope);
  const gap = await findMemoryGap(tx, scope, input.id);
  const ids = input.sources.map((s) => s.id).sort();
  if (
    !gap ||
    !['open', 'asked'].includes(gap.status) ||
    gap.question !== input.question ||
    JSON.stringify([...gap.sourceMemoryIds].sort()) !== JSON.stringify(ids) ||
    !(await lockMemorySources(tx, scope, input.sources))
  )
    throw new MemoryGapConflict();
  const safe = redactSecrets(input.answer);
  const content = memoryGapAnswerContent(gap.question, safe.text, input.sources);
  if (
    !safe.text.trim() ||
    safe.secretOnly ||
    input.sources.some(
      (s) =>
        s.sensitivity === 'secret' ||
        contextExcluded({ sourceId: s.sourceId, content: s.content }, input.contextExclude),
    ) ||
    contextExcluded({ sourceId: gap.id, content }, input.contextExclude)
  )
    throw new MemoryGapConflict();
  const id = newMemoryId();
  const vector = toVectorLiteral(input.embedding);
  await tx.$executeRaw`
    INSERT INTO "Memory" ("id", "workspaceId", "sourceType", "sourceId", "content", "embedding", "sensitivity")
    VALUES (${id}, ${scope.workspaceId}, 'answer', ${gap.id}, ${content}, ${vector}::vector, 'personal')
  `;
  await tx.memory.updateMany({
    where: { workspaceId: scope.workspaceId, id: { in: ids }, status: 'active' },
    data: { status: 'superseded', supersededById: id },
  });
  await tx.memoryGap.updateMany({
    where: { workspaceId: scope.workspaceId, id: gap.id, status: { in: ['open', 'asked'] } },
    data: { status: 'answered', answer: safe.text, answerMemoryId: id, resolvedAt: new Date() },
  });
  return id;
}

export function getMemoryGapSources(
  tx: Tx,
  scope: WorkspaceScope,
  ids: string[],
  contextExclude?: string | ContextExcludeRules,
): Promise<MaintenanceMemory[]> {
  return tx.memory
    .findMany({
      where: {
        workspaceId: scope.workspaceId,
        status: 'active',
        id: { in: ids },
        sensitivity: { in: ['public', 'personal'] },
      },
      select: { id: true, content: true, sensitivity: true, sourceType: true, sourceId: true },
    })
    .then((rows) =>
      rows.filter(
        (row) => !contextExcluded({ sourceId: row.sourceId, content: row.content }, contextExclude),
      ),
    );
}
