import { requireRole, type WorkspaceScope } from '@smith/tenancy';

import { newMessageId } from '../ids.js';
import type { Tx } from '../scoped.js';

export interface MessageRecord {
  id: string;
  workspaceId: string;
  sessionId: string;
  authorRole: string;
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
}

export async function appendMessage(
  tx: Tx,
  scope: WorkspaceScope,
  input: {
    sessionId: string;
    authorRole: 'user' | 'assistant';
    text: string;
    inputTokens?: number;
    outputTokens?: number;
  },
): Promise<MessageRecord> {
  requireRole(scope, 'member');
  return tx.message.create({
    data: {
      id: newMessageId(),
      workspaceId: scope.workspaceId,
      sessionId: input.sessionId,
      authorRole: input.authorRole,
      text: input.text,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
    },
  });
}

/** Tek mesaji id ile dondurur (kapsamli). Arka plan indeksleme icin. */
export async function findMessage(
  tx: Tx,
  scope: WorkspaceScope,
  messageId: string,
): Promise<MessageRecord | null> {
  return tx.message.findFirst({
    where: { id: messageId, workspaceId: scope.workspaceId },
  });
}

/**
 * Oturumun EN YENI `limit` mesajini eski→yeni sirayla dondurur (LLM baglami ve ozet
 * icin). Eskiden `createdAt asc + take` ILK `limit` mesaji aliyordu: uzun oturumun
 * kuyrugu (ozet tuketicisinde 200'u asan oturumun son mesajlari) kalici gorunmezdi.
 * `id` esitlik bozucudur (ayni milisaniyedeki mesajlar deterministik siralanir).
 */
export async function listSessionMessages(
  tx: Tx,
  scope: WorkspaceScope,
  sessionId: string,
  limit = 50,
): Promise<MessageRecord[]> {
  const newestFirst = await tx.message.findMany({
    where: { workspaceId: scope.workspaceId, sessionId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
  return newestFirst.reverse();
}
