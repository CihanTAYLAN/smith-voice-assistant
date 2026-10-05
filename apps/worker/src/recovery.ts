import type { DbHandle } from '@smith/db';
import { abandonExpiredRuns } from '@smith/mission';
import { agentRunJobSchema, hasLiveJob, type AgentRunJob, type Queue } from '@smith/queue';
import { createWorkspaceScope, type WorkspaceScope } from '@smith/tenancy';

import { isMissionExecutorEnabled } from './engines/executor.js';
import { sweepOrphanWslEngines } from './engines/wsl-engine.js';
import { safeMessage, type WorkerLog } from './worker-runtime.js';

/**
 * ACILIS TELAFISI (t2-worker #5). Windows'ta worker'i durdurma yolu zorla
 * olduruculuktur (`taskkill /T /F`, Node SIGTERM teslim etmez): zarif kapanis
 * akisi sahada calismaz. Calisan kosu `running` kalir, WSL'deki motor yetim
 * kalir. Telafi acilista yapilir:
 *
 *   1. Lease'i dolmus `running` kosular, kuyrukta canli isi yoksa sonlandirilir
 *      (`failed` / gorev `blocked` / ajan `idle`). Canli isi olanlari kuyruk
 *      yeniden teslim eder ve `claimRun` ayni mantikla sonlandirir.
 *   2. Sahibi olmus worker surecinin WSL motorlari durdurulur.
 *
 * Nazik durdurma (smith-up'a "once nazikce durdur" adimi) bu isin disindadir.
 */

type RecoveryQueue = Pick<Queue<AgentRunJob>, 'getJobs' | 'getJob'>;

/** Kosu izinin kuyrukta bulunabilecegi butun durumlar (removeOnComplete/removeOnFail ile tutulanlar dahil). */
const DISCOVERY_STATES: Parameters<RecoveryQueue['getJobs']>[0] = [
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'failed',
  'completed',
];
const DISCOVERY_LIMIT = 300;

/**
 * Worker'in hangi workspace'lere bakacagini kuyruk isleri soyler: her is
 * `workspaceId` ve `actorId` tasir. RLS altinda (`smith_app`) tum workspace'leri
 * gezmenin yolu yoktur ve sistem kapsami bos kume doner; kuyruk izi tek dogru
 * kaynaktir. Kuyruk kaydi hic kalmamis kosu (Redis sifirlanmis) gateway
 * uzlastiricisinin periyodik taramasina kalir. Actor kimligi olmayan is atlanir
 * (kapsamsiz kosu yasak).
 */
export async function collectQueueScopes(
  queue: Pick<RecoveryQueue, 'getJobs'>,
): Promise<WorkspaceScope[]> {
  const jobs = await queue.getJobs(DISCOVERY_STATES, 0, DISCOVERY_LIMIT - 1);
  const scopes = new Map<string, WorkspaceScope>();
  for (const job of jobs) {
    const payload = agentRunJobSchema.safeParse(job.data);
    if (!payload.success || !payload.data.actorId || scopes.has(payload.data.workspaceId)) continue;
    scopes.set(
      payload.data.workspaceId,
      createWorkspaceScope({
        workspaceId: payload.data.workspaceId,
        actorId: payload.data.actorId,
        role: 'member',
      }),
    );
  }
  return [...scopes.values()];
}

/** Donus: sonlandirilan kosu kimlikleri. Bir workspace'in hatasi digerlerini durdurmaz. */
export async function recoverStaleRuns(deps: {
  db: DbHandle;
  queue: RecoveryQueue;
  log: WorkerLog;
}): Promise<string[]> {
  const abandoned: string[] = [];
  for (const scope of await collectQueueScopes(deps.queue)) {
    try {
      const runIds = await abandonExpiredRuns(deps.db, scope, (runId) =>
        hasLiveJob(deps.queue, runId),
      );
      for (const runId of runIds) deps.log.out(`sahipsiz AgentRun sonlandirildi: ${runId}`);
      abandoned.push(...runIds);
    } catch (error) {
      deps.log.err(`acilis taramasi basarisiz (${scope.workspaceId}): ${safeMessage(error)}`);
    }
  }
  return abandoned;
}

/**
 * Yetim WSL motorlarini supurur. Yalniz Windows'ta ve executor aciksa: executor
 * kapaliyken worker WSL'e dokunmaz (kapali bir sanal makineyi bosuna
 * uyandirmaz), WSL de yalniz Windows'ta vardir. Donus: durdurulan kosu kimlikleri.
 */
export async function recoverOrphanEngines(deps: {
  log: WorkerLog;
  platform?: NodeJS.Platform;
  sweep?: () => Promise<string[]>;
}): Promise<string[]> {
  if ((deps.platform ?? process.platform) !== 'win32' || !isMissionExecutorEnabled()) return [];
  const swept = await (deps.sweep ?? sweepOrphanWslEngines)();
  for (const runId of swept) deps.log.out(`yetim WSL motoru durduruldu: ${runId}`);
  return swept;
}

/**
 * Acilis telafisinin giris noktasi. ASLA FIRLATMAZ: telafi basarisizsa worker
 * yine de kuyrugu tuketmeye baslar (tarama hatasi hizmeti durdurmamali); sebep
 * loglanir ve gateway uzlastiricisi aynisini periyodik yapar.
 */
export async function recoverAfterRestart(deps: {
  db: DbHandle;
  queue: RecoveryQueue;
  log: WorkerLog;
  platform?: NodeJS.Platform;
  sweep?: () => Promise<string[]>;
}): Promise<void> {
  const runs = recoverStaleRuns(deps).catch((error: unknown) => {
    deps.log.err(`sahipsiz kosu taramasi basarisiz: ${safeMessage(error)}`);
  });
  const engines = recoverOrphanEngines({
    log: deps.log,
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.sweep ? { sweep: deps.sweep } : {}),
  }).catch((error: unknown) => {
    deps.log.err(`yetim WSL motor taramasi basarisiz: ${safeMessage(error)}`);
  });
  await Promise.all([runs, engines]);
}
