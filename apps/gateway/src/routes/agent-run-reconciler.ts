import { type DbHandle, withScope } from '@smith/db';
import { abandonExpiredRuns } from '@smith/mission';
import { type AgentRunJob, hasLiveJob, type Queue } from '@smith/queue';
import type { WorkspaceScope } from '@smith/tenancy';

/** `queued` bir kosu bu sureden uzun kuyruga ulasmamissa Redis handoff'u kayip sayilir. */
export const AGENT_RUN_RECONCILE_AFTER_MS = 60_000;
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Taranan workspace listesinin siniri. Her gecerli token'li istek workspace'i
 * listeye ekler ve eskiden hic silinmiyordu: cok workspace'li (Faz 2) kurulumda
 * her biri dakikada bir veritabani sorgusu ve Redis aramasi demekti. En az
 * kullanilan workspace sinir asilinca, bir gunden uzun suredir istek gormeyen
 * workspace ise zaman asimiyla dusurulur; yeniden istek gelirse geri girer.
 */
const MAX_REMEMBERED_SCOPES = 100;
const SCOPE_TTL_MS = 24 * 60 * 60 * 1000;

export interface AgentRunReconciler {
  /** Workspace'i tarama listesine alir; ilk cagri periyodik taramayi baslatir. */
  remember(scope: WorkspaceScope): void;
  reconcile(scope: WorkspaceScope): Promise<void>;
}

interface RememberedScope {
  readonly scope: WorkspaceScope;
  readonly seenAt: number;
}

/**
 * `AgentRun` kaydi iki yonden kalici tutulur ve ikisi de burada uzlastirilir.
 *
 * 1. `queued` (outbox): atama kosuyu DB'de yazar, kuyruga girmesi ikinci ve
 *    kaybolabilir bir adimdir (Redis kapali, istek kesildi). Kuyrukta karsiligi
 *    olmayanlar ayni `jobId=runId` ile yeniden eklenir. Idempotenttir: BullMQ
 *    duplicate jobId'yi yok sayar, worker da yalniz `queued` satiri ustlenir.
 * 2. `running` (sahipsiz kosu): worker coker, nihai sonuc yazimi DB kesintisiyle
 *    dusar ya da Redis verisi sifirlanirsa kosu `running` kalir ve gorev
 *    `active_run` ile kalici kilitlenirdi. Lease'i dolmus ve kuyrukta canli isi
 *    olmayan kosu paketin tek sonlandirma yoluyla (`abandonExpiredRuns`:
 *    failed / gorev blocked / ajan idle) kapatilir. Kosu YENIDEN CALISTIRILMAZ.
 *
 * Workspace listesi gelen yetkili isteklerden ogrenilir (RLS altinda tum
 * workspace'leri gezmenin yolu yok); gateway yeniden basladiktan sonra ilk
 * istek listeyi tazeler. Liste sinirlidir (`MAX_REMEMBERED_SCOPES`, `SCOPE_TTL_MS`).
 *
 * Bilinen sinir: yeniden kuyruklama son gorulen istegin actor'u ile yapilir
 * (`AgentRun` satirinda olusturan actor yok); cok actor'lu workspace'te olay
 * kimligi yaniltici olabilir. Tek kullanicili Faz 1'de etkisizdir, kalici cozum
 * `createdBy` kolonu (migration) gerektirir.
 */
export function createAgentRunReconciler(input: {
  db: DbHandle;
  queue: Pick<Queue<AgentRunJob>, 'add' | 'getJob'>;
  now?: () => number;
  maxScopes?: number;
  scopeTtlMs?: number;
}): AgentRunReconciler {
  const now = input.now ?? Date.now;
  const maxScopes = input.maxScopes ?? MAX_REMEMBERED_SCOPES;
  const scopeTtlMs = input.scopeTtlMs ?? SCOPE_TTL_MS;
  const scopes = new Map<string, RememberedScope>();
  const inFlight = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;

  async function requeueStaleRuns(scope: WorkspaceScope): Promise<void> {
    const runs = await withScope(input.db.prisma, scope, (tx) =>
      tx.agentRun.findMany({
        where: {
          workspaceId: scope.workspaceId,
          status: 'queued',
          startedAt: { lte: new Date(now() - AGENT_RUN_RECONCILE_AFTER_MS) },
        },
        select: { id: true },
      }),
    );

    for (const run of runs) {
      const job = await input.queue.getJob(run.id);
      if (job) {
        // Kuyruktaki is bekliyor/calisiyor: dokunma. `removeOnFail` ile saklanan
        // basarisiz is ayni jobId'yi tutar, yeni `add` yok sayilirdi: yeniden dene.
        if ((await job.getState()) !== 'failed') continue;
        await job.retry('failed');
      } else {
        await input.queue.add(
          'run',
          { workspaceId: scope.workspaceId, actorId: scope.actorId, runId: run.id },
          { jobId: run.id },
        );
      }
      console.warn(`[gateway] AgentRun yeniden kuyruga alindi: ${run.id}`);
    }
  }

  async function abandonOrphanedRuns(scope: WorkspaceScope): Promise<void> {
    const abandoned = await abandonExpiredRuns(input.db, scope, (runId) =>
      hasLiveJob(input.queue, runId),
    );
    for (const runId of abandoned) {
      console.warn(`[gateway] AgentRun sahipsiz, sonlandirildi: ${runId}`);
    }
  }

  const reconcile = (scope: WorkspaceScope): Promise<void> => {
    const running = inFlight.get(scope.workspaceId);
    if (running) return running;
    const work = (async () => {
      await requeueStaleRuns(scope);
      await abandonOrphanedRuns(scope);
    })().finally(() => inFlight.delete(scope.workspaceId));
    inFlight.set(scope.workspaceId, work);
    return work;
  };

  const sweep = (): void => {
    const cutoff = now() - scopeTtlMs;
    for (const [workspaceId, entry] of scopes) {
      if (entry.seenAt < cutoff) {
        scopes.delete(workspaceId);
        continue;
      }
      reconcile(entry.scope).catch((error: unknown) => {
        console.warn(
          `[gateway] AgentRun uzlastirma basarisiz (${workspaceId}): ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  };

  return {
    remember(scope) {
      // Silip yeniden eklemek Map sirasini tazeler: ilk anahtar daima en az kullanilandir.
      scopes.delete(scope.workspaceId);
      scopes.set(scope.workspaceId, { scope, seenAt: now() });
      for (const oldest of scopes.keys()) {
        if (scopes.size <= maxScopes) break;
        scopes.delete(oldest);
      }
      timer ??= setInterval(sweep, SWEEP_INTERVAL_MS).unref();
    },
    reconcile,
  };
}
