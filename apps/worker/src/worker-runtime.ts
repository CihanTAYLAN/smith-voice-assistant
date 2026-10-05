import { redactSecrets } from '@smith/memory';
import type { createQueueConnection, Worker } from '@smith/queue';

/**
 * Surec duzeyi calisma zamani yardimcilari: etkin kosularin kaydi, kuyruk
 * olay dinleyicileri ve sure sinirli kapanis. `index.ts` yalniz bunlari baglar.
 */

/** Calisan motor kosularinin iptal denetleyicileri: kapanista hepsi durdurulur. */
export class ActiveRunRegistry {
  private readonly controllers = new Set<AbortController>();

  get size(): number {
    return this.controllers.size;
  }

  begin(): { signal: AbortSignal; release: () => void } {
    const controller = new AbortController();
    this.controllers.add(controller);
    return {
      signal: controller.signal,
      release: () => this.controllers.delete(controller),
    };
  }

  abortAll(reason: unknown): void {
    for (const controller of this.controllers) controller.abort(reason);
  }
}

export interface WorkerLog {
  out(line: string): void;
  err(line: string): void;
}

export const processLog: WorkerLog = {
  out: (line) => void process.stdout.write(`[worker] ${line}\n`),
  err: (line) => void process.stderr.write(`[worker] ${line}\n`),
};

/** Hata mesaji log'a girmeden once secret maskelenir (baglanti dizgeleri anahtar tasiyabilir). */
export function safeMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).text;
}

/**
 * Worker olaylarini dinler. `error` dinleyicisi ZORUNLU: BullMQ Worker bir
 * EventEmitter'dir ve dinleyicisiz `error` olayi (Redis kopmasi, kilit
 * yenileme hatasi) tum worker surecini dusurur.
 */
export function attachWorkerDiagnostics(worker: Worker, log: WorkerLog = processLog): void {
  worker.on('error', (error) => log.err(`kuyruk hatasi (${worker.name}): ${safeMessage(error)}`));
  worker.on('stalled', (jobId) => log.err(`is stalled (${worker.name}/${jobId})`));
  worker.on('failed', (job, error) =>
    log.err(`is basarisiz (${worker.name}/${job?.id ?? '?'}): ${safeMessage(error)}`),
  );
  worker.on('completed', (job) => log.out(`is tamam (${worker.name}/${job.id})`));
}

/** Redis baglantisinin saglik gecislerini gorunur kilar; `error` dinleyicisi surecin dusmesini onler. */
export function attachConnectionDiagnostics(
  connection: ReturnType<typeof createQueueConnection>,
  log: WorkerLog = processLog,
): void {
  connection.on('error', (error) => log.err(`Redis baglanti hatasi: ${safeMessage(error)}`));
  connection.on('reconnecting', (delayMs: number) =>
    log.err(`Redis yeniden baglaniyor (${delayMs}ms)`),
  );
  connection.on('ready', () => log.out('Redis baglantisi hazir'));
}

/**
 * Worker'lari nazikce kapatir (aktif isler bitsin). `graceMs` icinde
 * bitmezse `'forced'` doner ve kapanisi BEKLEMEZ: cagiran baglantiyi keser ve
 * surecten cikar (bkz. `index.ts` `shutdown`).
 *
 * NEDEN `close(true)` ile zorlanmaz: BullMQ (5.81.3) `Worker.close` kapanis bir
 * kez basladiysa AYNI bekleyen sozu doner ve `force` yok sayilir; takili bir is
 * (or. cevap vermeyen bir gomme cagrisi) kapanisi sonsuza dek bekletirdi ve
 * "zorla kapatildi" logu yalan olurdu. Gercekten zorlayan tek sey baglantiyi
 * kesip surecten cikmaktir.
 */
export async function closeWorkers(
  workers: ReadonlyArray<Pick<Worker, 'close'>>,
  graceMs: number,
): Promise<'graceful' | 'forced'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'forced'>((resolve) => {
    timer = setTimeout(() => resolve('forced'), graceMs);
  });
  const graceful = Promise.all(workers.map((worker) => worker.close())).then(
    () => 'graceful' as const,
  );
  try {
    return await Promise.race([graceful, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
