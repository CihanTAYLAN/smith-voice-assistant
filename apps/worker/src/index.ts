import { createDb } from '@smith/db';
import { loadEnv, workerEnvSchema } from '@smith/env';
import { createLlmRouterFromEnv, describeChain } from '@smith/llm';
import { createEmbedderFromEnv } from '@smith/memory';
import { initTracing } from '@smith/observability';
import {
  createQueue,
  createQueueConnection,
  createQueueWorker,
  QueueName,
  type Worker,
} from '@smith/queue';

import { handleAgentRun } from './consumers/agent-run.js';
import { handleMemoryIndex } from './consumers/memory-index.js';
import { handleMemoryMaintenance } from './consumers/memory-maintenance.js';
import { syncMemoryMaintenanceSchedules } from './memory-maintenance-scheduler.js';
import { handleSessionSummary } from './consumers/session-summary.js';
import { readEngineConfig } from './engines/claude-code.js';
import { readCodexConfig } from './engines/codex.js';
import { isMissionExecutorEnabled } from './engines/executor.js';
import { recoverAfterRestart } from './recovery.js';
import {
  ActiveRunRegistry,
  attachConnectionDiagnostics,
  attachWorkerDiagnostics,
  closeWorkers,
  processLog,
  safeMessage,
} from './worker-runtime.js';

/** Kapanista aktif islerin sonlanmasi icin taninan sure; dolarsa zorla kapatilir. */
const SHUTDOWN_GRACE_MS = 30_000;

const env = loadEnv(workerEnvSchema);
const db = createDb(env.DATABASE_URL);
const connection = createQueueConnection(env.REDIS_URL);
const activeRuns = new ActiveRunRegistry();
const embedder = createEmbedderFromEnv(env);

const tracing = initTracing({
  baseUrl: env.LANGFUSE_BASE_URL,
  publicKey: env.LANGFUSE_PUBLIC_KEY,
  secretKey: env.LANGFUSE_SECRET_KEY,
});

/**
 * LLM yapilandirmasi (router + YEDEK ZINCIRI) gateway ile AYNI cozucuden gelir.
 * Onceden elle kuruluyordu ve uc Ollama'ya sabitliydi: bulut modeli secildiginde
 * worker o adi YEREL uca soruyordu ve SESSION_SUMMARY her seferinde dusuyordu.
 * Tek cozucu (createLlmRouterFromEnv) bu sapmayi yapisal olarak kapatir —
 * yedek zinciri de boylece iki tarafta ayni.
 */
const llmBaseUrl = env.SMITH_LLM_BASE_URL ?? `${env.OLLAMA_BASE_URL}/v1`;

const llm = createLlmRouterFromEnv(env, {
  onFallback: ({ role, from, to, reason }) => {
    process.stderr.write(`[worker] llm yedek: ${role} ${from} -> ${to} (${reason})\n`);
  },
});

// Motor ayarlari ACILISTA dogrulanir: gecersiz izin modu/sandbox degeri
// burada surec durdurur, calisma aninda sessizce baska moda dusmez.
const claudeEngine = readEngineConfig();
const codexEngine = readCodexConfig();
process.stdout.write(`[worker] llm: ${describeChain(env)} @ ${llmBaseUrl}\n`);
process.stdout.write(
  `[worker] basladi (tracing: ${tracing.enabled ? 'acik' : 'kapali'}, ` +
    `mission executor: ${isMissionExecutorEnabled() ? 'acik' : 'kapali'})\n`,
);
// Hangi motorun hangi sinirla kosacagi ACILISTA gorunur olsun: motor ayari
// sessizce yanlis olursa is ya guvensiz ya kirik kosar ve sebebi log'da
// gorunmezdi.
process.stdout.write(
  `[worker] motorlar: claude-code/${claudeEngine.permissionMode} · ` +
    `codex/${codexEngine.host}:${codexEngine.sandbox}\n`,
);

// createQueueWorker payload'i iceride dogrular; handler dogrulanmis payload alir.
const maintenanceQueue = createQueue(QueueName.MEMORY_MAINTENANCE, connection);
// Ilk is alinmadan once tum worker sureclerinde ortak kota siniri kurulur.
await maintenanceQueue.setGlobalConcurrency(1);
const workers: Worker[] = [
  createQueueWorker(
    QueueName.MEMORY_MAINTENANCE,
    connection,
    (payload) =>
      handleMemoryMaintenance(
        {
          db,
          llm,
          embedder,
          config: env,
          log: (summary) =>
            process.stdout.write(`[memory-maintenance] ${JSON.stringify(summary)}\n`),
        },
        payload,
      ),
    { concurrency: 1 },
  ),
  createQueueWorker(QueueName.MEMORY_INDEX, connection, (payload) =>
    handleMemoryIndex({ db, embedder }, payload),
  ),
  createQueueWorker(QueueName.SESSION_SUMMARY, connection, (payload) =>
    handleSessionSummary({ db, llm, embedder }, payload),
  ),
  createQueueWorker(QueueName.AGENT_RUN, connection, async (payload) => {
    // Kapanista etkin motor kosusu iptal sinyali alir (surec agaci durdurulur).
    const active = activeRuns.begin();
    try {
      await handleAgentRun({ db, signal: active.signal }, payload);
    } finally {
      active.release();
    }
  }),
];

for (const worker of workers) attachWorkerDiagnostics(worker);
attachConnectionDiagnostics(connection);

let scheduleSync: Promise<void> | undefined;
function refreshMaintenanceSchedules(): void {
  if (scheduleSync) return;
  scheduleSync = syncMemoryMaintenanceSchedules(db, maintenanceQueue, env)
    .catch(() =>
      processLog.err('hafiza bakimi zamanlamasi kurulamadi; bir sonraki taramada tekrar denenecek'),
    )
    .finally(() => {
      scheduleSync = undefined;
    });
}
refreshMaintenanceSchedules();
// Yeni workspace ve uyelik degisimleri worker yeniden baslatilmadan gorulur.
const maintenanceTimer = setInterval(refreshMaintenanceSchedules, 60 * 60 * 1000);
maintenanceTimer.unref();

// Acilis telafisi (t2-worker #5): Windows'ta durdurma yolu zorla olduruculuktur,
// zarif kapanis calismaz. Lease'i dolmus sahipsiz kosular sonlandirilir, sahibi
// olmus worker'in WSL motorlari supurulur. Telafi hizmeti geciktirmez ve hata verirse
// yalniz loglanir (`recoverAfterRestart` firlatmaz).
const recoveryQueue = createQueue(QueueName.AGENT_RUN, connection);
void recoverAfterRestart({ db, queue: recoveryQueue, log: processLog })
  .then(() => recoveryQueue.close())
  .catch((error: unknown) =>
    processLog.err(`acilis telafisi kuyrugu kapanamadi: ${safeMessage(error)}`),
  );

async function shutdown(signal: string): Promise<void> {
  clearInterval(maintenanceTimer);
  process.stdout.write(`[worker] ${signal} — kapaniyor...\n`);
  activeRuns.abortAll(new Error(`${signal}: worker kapaniyor`));
  if ((await closeWorkers(workers, SHUTDOWN_GRACE_MS)) === 'forced') {
    // BullMQ `close(true)` kapanis basladiktan sonra etkisizdir ve `quit()` bekleyen
    // (bloklayan) komutlari bekler: takili is kapanisi sonsuza dek tutardi. Tek
    // gercek zorlama baglantiyi kesip cikmaktir; yarim kalan kosu lease dolunca
    // uzlastirilir, WSL'de kalan motorlar acilis taramasiyla supurulur.
    process.stderr.write('[worker] kapanis suresi doldu, baglanti kesilip cikiliyor\n');
    connection.disconnect();
    process.exit(1);
  }
  await scheduleSync;
  await maintenanceQueue.close();
  await connection.quit();
  await db.close();
  if (tracing.enabled) await tracing.shutdown();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
