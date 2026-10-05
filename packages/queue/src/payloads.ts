import { ACTOR_ID_PATTERN, WORKSPACE_ID_PATTERN } from '@smith/tenancy';
import { z } from 'zod';

import { QueueName } from './queue-names.js';

/**
 * Kuyruk payload sozlesmeleri.
 *
 * Kirmizi cizgi: her is TENANT KAPSAMI tasir. Worker, payload'daki
 * workspaceId'den WorkspaceScope kurar ve veri erisimini onunla yapar —
 * kuyruk uzerinden tenant siniri asilamaz. Kapsamsiz is tanimlanamaz.
 */

const scopedJobBase = z.object({
  workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  /** Isi tetikleyen aktor; sistem tetiklediyse bos birakilir ve reason yazilir. */
  actorId: z.string().regex(ACTOR_ID_PATTERN).optional(),
  reason: z.string().min(8).optional(),
});

export const memoryIndexJobSchema = scopedJobBase.extend({
  kind: z.enum(['message', 'document']),
  /** Kaynak kaydin id'si (msg_* veya ileride doc_*). */
  sourceId: z.string().min(1),
});
export type MemoryIndexJob = z.infer<typeof memoryIndexJobSchema>;

export const memoryMaintenanceJobSchema = scopedJobBase.extend({
  actorId: z.string().regex(ACTOR_ID_PATTERN),
});
export type MemoryMaintenanceJob = z.infer<typeof memoryMaintenanceJobSchema>;

export const sessionSummaryJobSchema = scopedJobBase.extend({
  sessionId: z.string().regex(/^ses_[0-9a-z]{20,32}$/),
  /** Bu mesaj sayisinin altindaki oturumlar ozetlenmez. */
  minMessages: z.number().int().positive().default(10),
});
export type SessionSummaryJob = z.infer<typeof sessionSummaryJobSchema>;

export const agentRunJobSchema = scopedJobBase.extend({
  /**
   * Kosu kaydinin kimligi. Idempotency capasi BURASIDIR: atama, ayni scoped
   * transaction icinde tam bir AgentRun satiri ('queued') yaratir ve isin
   * jobId'si bu id olur. Consumer satiri 'queued' degil bulursa kosmaz —
   * yani cift tetikleme (yeniden deneme, cift tiklama) ikinci kez para
   * harcamaz. Yeniden atama YENI satir uretir, dolayisiyla mesru bir tekrar
   * kosusu engellenmez.
   */
  runId: z.string().regex(/^run_[0-9a-z]{20,32}$/),
});
export type AgentRunJob = z.infer<typeof agentRunJobSchema>;

/** Kuyruk adi → payload semasi. Producer ve consumer ayni semayi kullanir. */
export const QUEUE_PAYLOAD_SCHEMAS = {
  [QueueName.MEMORY_INDEX]: memoryIndexJobSchema,
  [QueueName.MEMORY_MAINTENANCE]: memoryMaintenanceJobSchema,
  [QueueName.SESSION_SUMMARY]: sessionSummaryJobSchema,
  [QueueName.AGENT_RUN]: agentRunJobSchema,
} as const;

export type QueuePayloadMap = {
  [QueueName.MEMORY_INDEX]: MemoryIndexJob;
  [QueueName.MEMORY_MAINTENANCE]: MemoryMaintenanceJob;
  [QueueName.SESSION_SUMMARY]: SessionSummaryJob;
  [QueueName.AGENT_RUN]: AgentRunJob;
};

export class QueuePayloadError extends Error {
  constructor(
    message: string,
    readonly queue: QueueName,
  ) {
    super(message);
    this.name = 'QueuePayloadError';
  }
}

/** Payload'i dogrular; gecersizse is HIC kuyruga girmez / islenmez. */
export function parseQueuePayload<TName extends QueueName>(
  queue: TName,
  raw: unknown,
): QueuePayloadMap[TName] {
  const result = QUEUE_PAYLOAD_SCHEMAS[queue].safeParse(raw);
  if (!result.success) {
    throw new QueuePayloadError(
      `'${queue}' payload'i gecersiz: ${result.error.issues.map((i) => i.message).join('; ')}`,
      queue,
    );
  }
  return result.data as QueuePayloadMap[TName];
}
