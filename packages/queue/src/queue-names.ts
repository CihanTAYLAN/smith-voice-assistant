/**
 * Merkezi kuyruk adi registry'si (earlier-project deseninden).
 *
 * apps/gateway ve apps/worker'daki her BullMQ kuyruk adi BURADAN gelir.
 * Baska yerde kuyruk adi tanimlamak producer ile consumer'in sessizce
 * ayrismasina yol acar; registry bunu tip duzeyinde imkansiz kilar.
 *
 * Kural: kuyruk ancak somut bir consumer planiyla eklenir — "belki lazim
 * olur" kuyrugu eklenmez.
 */
export const QueueName = {
  /** pgvector embedding uretimi: mesaj/dokuman → vektor (memory paketi tuketir). */
  MEMORY_INDEX: 'memory-index',
  MEMORY_MAINTENANCE: 'memory-maintenance',
  /** Uzun sohbet oturumlarinin asenkron ozetlenmesi (llm 'summarizer' rolu). */
  SESSION_SUMMARY: 'session-summary',
  /**
   * Mission Control kosusu: bir gorev bir ajana atandiginda o ajanin headless
   * motorunu (Claude Code) hedef cihazda calistirir (ADR 0007). Tuketici:
   * apps/worker/consumers/agent-run.ts.
   */
  AGENT_RUN: 'agent-run',
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QueueName);
