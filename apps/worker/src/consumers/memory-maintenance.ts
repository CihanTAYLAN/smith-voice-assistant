import { withScope, type DbHandle } from '@smith/db';
import type { MemoryMaintenanceEnv } from '@smith/env';
import type { LlmRouter } from '@smith/llm';
import {
  consolidateMemories,
  contextExcluded,
  EMBED_TIMEOUT_MS,
  findGapCandidates,
  findMemoryClusters,
  openMemoryGap,
  redactSecrets,
  searchMemories,
  type Embedder,
  type MaintenanceMemory,
} from '@smith/memory';
import type { MemoryMaintenanceJob } from '@smith/queue';
import { createWorkspaceScope } from '@smith/tenancy';

import {
  isQuotaError,
  maintenanceJson,
  objectValue,
  safeModelText,
} from './memory-maintenance-model.js';

export interface MaintenanceSummary {
  clusters: number;
  superseded: number;
  gaps: number;
  skipped: number;
  stopped: 'complete' | 'disabled' | 'quota' | 'error' | 'unauthorized' | 'partial';
  stage: 'cluster' | 'gap' | 'answer-check';
  errorClass?: string;
  errorMessage?: string;
  firstErrorClass?: string;
  firstErrorMessage?: string;
}

const MAX_CONSECUTIVE_TRANSIENT_ERRORS = 3;

function isTransientMaintenanceError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const value = current as {
      code?: unknown;
      name?: unknown;
      status?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      (typeof value.status === 'number' && value.status >= 500 && value.status <= 599) ||
      (typeof value.code === 'string' &&
        /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)$/.test(
          value.code,
        )) ||
      (typeof value.name === 'string' && /^(AbortError|TimeoutError)$/.test(value.name)) ||
      (typeof value.message === 'string' &&
        /timeout|timed out|network|fetch failed|valid JSON|gecerli JSON|JSON dondurmedi/i.test(
          value.message,
        ))
    )
      return true;
    current = value.cause;
  }
  return false;
}

function maintenanceErrorSummary(
  error: unknown,
): Pick<MaintenanceSummary, 'errorClass' | 'errorMessage'> {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const cause = (current as { cause?: unknown }).cause;
    if (cause === undefined || (typeof cause === 'object' && !(cause instanceof Error))) break;
    current = cause;
  }
  const errorClass =
    current instanceof Error
      ? current.name || 'Error'
      : Object.prototype.toString.call(current).slice(8, -1) || typeof current;
  const rawMessage = current instanceof Error ? current.message : String(current);
  const errorMessage = redactSecrets(rawMessage).text.replace(/\s+/g, ' ').trim().slice(0, 240);
  return {
    errorClass: errorClass.slice(0, 80),
    errorMessage: errorMessage || 'mesaj yok',
  };
}

export async function handleMemoryMaintenance(
  deps: {
    db: DbHandle;
    llm: LlmRouter;
    embedder: Embedder;
    config: MemoryMaintenanceEnv;
    log: (summary: MaintenanceSummary) => void;
  },
  payload: MemoryMaintenanceJob,
): Promise<void> {
  const summary: MaintenanceSummary = {
    clusters: 0,
    superseded: 0,
    gaps: 0,
    skipped: 0,
    stopped: 'complete',
    stage: 'cluster',
  };
  let consecutiveTransientErrors = 0;
  let firstTransientError: Pick<MaintenanceSummary, 'errorClass' | 'errorMessage'> | undefined;
  let circuitOpen = false;
  const skipTransientItem = (error: unknown): void => {
    summary.skipped += 1;
    consecutiveTransientErrors += 1;
    firstTransientError ??= maintenanceErrorSummary(error);
    if (consecutiveTransientErrors >= MAX_CONSECUTIVE_TRANSIENT_ERRORS) circuitOpen = true;
  };
  const markSuccessfulItem = (): void => {
    consecutiveTransientErrors = 0;
  };
  try {
    if (deps.config.SMITH_MEMORY_MAINTENANCE === '0') {
      summary.stopped = 'disabled';
      return;
    }
    const scope = createWorkspaceScope({ ...payload, role: 'member' });
    const member = await withScope(deps.db.prisma, scope, (tx) =>
      tx.membership.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          actorId: scope.actorId,
          role: { in: ['owner', 'admin', 'member'] },
        },
        select: { actorId: true },
      }),
    );
    if (!member) {
      summary.stopped = 'unauthorized';
      return;
    }
    const day = new Date().toISOString().slice(0, 10);
    const clusters = await withScope(deps.db.prisma, scope, (tx) =>
      findMemoryClusters(tx, scope, {
        similarity: deps.config.SMITH_MEMORY_MAINTENANCE_SIMILARITY,
        limit: deps.config.SMITH_MEMORY_MAINTENANCE_MAX_CLUSTERS,
        day,
      }),
    );
    const pending: { id: string; sources: MaintenanceMemory[]; conflict: boolean }[] = [];
    for (const sources of clusters) {
      summary.clusters += 1;
      if (circuitOpen) {
        summary.skipped += 1;
        continue;
      }
      // Secret ve redakte edilmesi gereken kayitlar kayipsiz birlestirilemez.
      if (
        sources.some(
          (s) =>
            s.sensitivity === 'secret' ||
            redactSecrets(s.content).text !== s.content ||
            contextExcluded({ sourceId: s.sourceId, content: s.content }),
        )
      ) {
        summary.skipped += 1;
        continue;
      }
      try {
        const result = objectValue(
          await maintenanceJson(
            deps.llm,
            'Bu kayitlarin TUM olgularini, zaman ve belirsizlik nitelemelerini koruyarak tekrarlari kaldir. ' +
              'Celiski varsa birlestirme: {"kind":"conflict"}. Ilgisiz veya kayipsiz birlestirilemiyorsa {"kind":"skip"}. ' +
              'Aksi halde {"kind":"consolidated","preservesAllFacts":true,"content":"..."}.',
            sources,
          ),
        );
        if (result.kind === 'conflict') {
          pending.push({ id: sources[0]?.id ?? '', sources, conflict: true });
          summary.skipped += 1;
          markSuccessfulItem();
          continue;
        }
        if (result.kind === 'skip') {
          summary.skipped += 1;
          markSuccessfulItem();
          continue;
        }
        if (result.kind !== 'consolidated' || result.preservesAllFacts !== true)
          throw new Error('Gecersiz sikistirma karari.');
        const content = safeModelText(result.content, 24000);
        if (contextExcluded({ sourceId: 'consolidated:pending', content })) {
          summary.skipped += 1;
          markSuccessfulItem();
          continue;
        }
        const embedding = await deps.embedder.embed(content, {
          singleAttempt: true,
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
        const count = await withScope(deps.db.prisma, scope, (tx) =>
          consolidateMemories(tx, scope, { sources, content, embedding }),
        );
        summary.superseded += count;
        if (count === 0) summary.skipped += 1;
        markSuccessfulItem();
      } catch (error) {
        if (isQuotaError(error) || !isTransientMaintenanceError(error)) throw error;
        skipTransientItem(error);
      }
    }
    if (circuitOpen) return;
    summary.stage = 'gap';
    const candidates = await withScope(deps.db.prisma, scope, (tx) =>
      findGapCandidates(tx, scope, {
        limit: deps.config.SMITH_MEMORY_MAINTENANCE_MAX_GAPS,
        day,
      }),
    );
    const used = new Set(pending.flatMap((p) => p.sources.map((s) => s.id)));
    for (const candidate of candidates) {
      if (
        !used.has(candidate.id) &&
        !contextExcluded({ sourceId: candidate.sourceId, content: candidate.content })
      )
        pending.push({ id: candidate.id, sources: [candidate], conflict: false });
    }
    let sourceBudget = 24000;
    const batch = pending.slice(0, deps.config.SMITH_MEMORY_MAINTENANCE_MAX_GAPS).filter((p) => {
      const size = p.sources.reduce((sum, s) => sum + s.content.length, 0);
      if (
        size > sourceBudget ||
        !p.sources.every(
          (s) => s.sensitivity !== 'secret' && redactSecrets(s.content).text === s.content,
        )
      )
        return false;
      sourceBudget -= size;
      return true;
    });
    summary.skipped += pending.length - batch.length;
    if (batch.length === 0) return;
    const inputs: ((typeof batch)[number] & { recall: { id: string; content: string }[] })[] = [];
    let recallBudget = 24000;
    for (const candidate of batch) {
      if (circuitOpen) {
        summary.skipped += 1;
        continue;
      }
      try {
        const vectors = await deps.embedder.embedBatch(
          [candidate.sources.map((s) => s.content).join('\n')],
          { singleAttempt: true, signal: AbortSignal.timeout(EMBED_TIMEOUT_MS) },
        );
        const vector = vectors[0];
        if (!vector) throw new Error('Bosluk embedding eksik.');
        const hits = await withScope(deps.db.prisma, scope, (tx) =>
          searchMemories(tx, scope, vector, { limit: 10, minSimilarity: 0.35 }),
        );
        const recall = hits
          .filter(
            (h) =>
              !candidate.sources.some((s) => s.id === h.id) &&
              h.content.length <= 8000 &&
              !contextExcluded({ sourceId: h.sourceId, content: h.content }),
          )
          .slice(0, 5)
          .map((h) => ({ id: h.id, content: redactSecrets(h.content).text }));
        const size = recall.reduce((sum, h) => sum + h.content.length, 0);
        // Kaniti kirpip yanlis bir bosluk acmak yerine adayi sonraki kosuya birak.
        if (size > recallBudget) {
          summary.skipped += 1;
          markSuccessfulItem();
          continue;
        }
        recallBudget -= size;
        inputs.push({ ...candidate, recall });
        markSuccessfulItem();
      } catch (error) {
        if (isQuotaError(error) || !isTransientMaintenanceError(error)) throw error;
        skipTransientItem(error);
      }
    }
    if (inputs.length === 0) return;
    summary.stage = 'answer-check';
    for (const input of inputs) {
      if (circuitOpen) {
        summary.skipped += 1;
        continue;
      }
      try {
        const result = await maintenanceJson(
          deps.llm,
          'Her aday icin tam bir karar ver: [{"id":"aday id", "kind":"gap", "question":"tek soru", "reason":"kisa gerekce"}] ' +
            'Gercekten Cihan\'a sorulabilir bir eksik veya celiski degilse kind="skip" kullan. ' +
            'Recall icinde cevabi varsa kind="answered" ve answerEvidenceId="recall id" kullan, soru ACMA. ' +
            "Bilinmiyor diyen kayit cevap kaniti degildir. Kaynakta kamuya acik bilgi yoksa Cihan'a sormak uygundur. " +
            'Eski ve yeni tarihli farki celiski sanma. Kimlikleri girdiden aynen al.',
          [input],
        );
        if (!Array.isArray(result) || result.length !== 1)
          throw new Error('Bosluk karar sayisi uyusmuyor.');
        const decision = objectValue(result[0]);
        if (decision.id !== input.id) throw new Error('Bosluk karari kimligi uyusmuyor.');
        if (decision.kind === 'skip') summary.skipped += 1;
        else if (decision.kind === 'answered') {
          if (!input.recall.some((h) => h.id === decision.answerEvidenceId))
            throw new Error('Cevap kaniti recall icinde yok.');
          summary.skipped += 1;
        } else {
          if (decision.kind !== 'gap') throw new Error('Gecersiz bosluk karari.');
          const question = safeModelText(decision.question, 300);
          const reason = safeModelText(decision.reason, 1000);
          if (contextExcluded({ sourceId: '', content: `${question}\n${reason}` })) {
            summary.skipped += 1;
            markSuccessfulItem();
            continue;
          }
          const opened = await withScope(deps.db.prisma, scope, (tx) =>
            openMemoryGap(tx, scope, { question, reason, sources: input.sources }),
          );
          if (opened) summary.gaps += 1;
          else summary.skipped += 1;
        }
        markSuccessfulItem();
      } catch (error) {
        if (isQuotaError(error) || !isTransientMaintenanceError(error)) throw error;
        skipTransientItem(error);
      }
    }
  } catch (error) {
    summary.stopped = isQuotaError(error) ? 'quota' : 'error';
    Object.assign(summary, maintenanceErrorSummary(error));
    if (summary.stopped !== 'quota')
      throw new Error('Hafiza bakimi basarisiz; kayitlar korunuyor.', { cause: error });
  } finally {
    if (summary.stopped === 'complete' && summary.skipped > 0) {
      summary.stopped = 'partial';
      if (firstTransientError) Object.assign(summary, firstTransientError);
      if (circuitOpen) {
        summary.errorClass = 'CircuitBreaker';
        summary.errorMessage = 'Ardisik 3 gecici hata; kalan kalemler denenmedi.';
        if (firstTransientError?.errorClass && firstTransientError.errorMessage) {
          summary.firstErrorClass = firstTransientError.errorClass;
          summary.firstErrorMessage = firstTransientError.errorMessage;
        }
      }
    }
    deps.log(summary);
  }
}
