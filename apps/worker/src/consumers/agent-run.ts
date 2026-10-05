import { type DbHandle, type Tx, withScope } from '@smith/db';
import { redactSecrets } from '@smith/memory';
import {
  ActiveRunLeaseError,
  AGENT_RUN_HEARTBEAT_MS,
  AGENT_RUN_LEASE_MS,
  addComment,
  appendEvent,
  buildAgentSystemPrompt,
  buildTaskPrompt,
  claimRun,
  deliverTask,
  findAgent,
  findTask,
  finishRun,
  heartbeatRun,
  isLocalAgentDevice,
  listComments,
  LOCAL_AGENT_DEVICES,
  lockTaskForRunCompletion,
  moveTask,
  parseDeliverable,
  setAgentStatus,
  type AgentRecord,
  type AgentRunRecord,
  type TaskRecord,
} from '@smith/mission';
import type { AgentRunJob } from '@smith/queue';
import { createWorkspaceScope, type WorkspaceScope } from '@smith/tenancy';

import { isMissionExecutorEnabled } from '../engines/executor.js';
import { runAgentEngine, type EngineRunResult } from '../engines/index.js';
import { processLog, safeMessage } from '../worker-runtime.js';

/**
 * Prompt'a girecek thread penceresi: DB'den yalniz en yeni N yorum okunur;
 * karakter butcesi `buildTaskPrompt`ta uygulanir. Binlerce yorumlu bir gorev
 * motor prompt'unu sinirsiz sisirmesin.
 */
const TASK_COMMENT_WINDOW = 100;

/**
 * Nihai sonuc yazimi gecici bir DB kesintisinde (Postgres/Docker yeniden
 * baslamasi birkac saniye surer) bir kez dusup sonucu yitirmesin diye sinirli
 * yeniden deneme: ilk deneme + bu kadar gecikmeli yeniden deneme. Hepsi dusunce
 * veriden bagimsiz ASGARI yazim (kosu `failed`, gorev `blocked`, ajan `idle`)
 * `FALLBACK_WRITE_RETRY_DELAYS_MS` ile denenir; o da dusunce is firlatir ve kosuyu
 * lease dolunca uzlastirici sonlandirir (gateway periyodik tarama, worker acilis
 * taramasi). Toplam bekleme kasten kisa: kuyruk concurrency 1, bekleyen is yok sayilmaz.
 */
export const FINAL_WRITE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
export const FALLBACK_WRITE_RETRY_DELAYS_MS = [2_000] as const;

/** Yalniz gizli degerden olusan rapor yerine yazilan metin. */
const SECRET_ONLY_NOTICE = 'gizli icerik atlandi';

/**
 * AGENT_RUN tuketicisi: Mission Control'un is gucunu calistirir (ADR 0007).
 *
 * Akis:
 *   1. Task satirini kilitle, guncel durum calistirilabilir ise kosuyu ustlen
 *      (`queued` → `running`) ve gorevi ayni transaction'da `in_progress` yap.
 *      Kapilar: executor kapali, kosunun cihazi yerel degil (m2/server) ya da
 *      ajan devre disi (offline) ise motor cagrilmaz ve sebep thread'e yazilir.
 *   2. Motoru transaction DISINDA kos (dakikalar surer; DB kilidi tutulmaz).
 *      Motor boyunca kosunun lease'i tazelenir; worker cokerse kuyruk isi
 *      yeniden teslim eder ve `claimRun` sahipsiz kosuyu sonlandirir.
 *   3. Sonuca gore teslim et (`review`) veya engelle (`blocked`). Kosu kaydi HER
 *      DURUMDA kapanir ve calisan ajan `idle`a doner (devre disi ajan korunur).
 *      Gorev bu arada baska duruma tasindiysa sonuc panoya uygulanmaz ama
 *      thread'e `note` olarak yazilir. Yazim sinirli yeniden denenir; ajan ya da
 *      motor kaynakli her metin (rapor, hata) yazilmadan once maskelenir.
 *
 * Kapsam: payload workspaceId + actorId tasir; kapsamsiz kosu YOK. Sistem
 * kapsami kullanilmaz — bu is her zaman bir kullanicinin atamasindan doger.
 */
export async function handleAgentRun(
  deps: { db: DbHandle; signal?: AbortSignal },
  payload: AgentRunJob,
): Promise<void> {
  if (!payload.actorId) {
    throw new Error('AGENT_RUN actorId gerektirir (kapsamsiz kosu yasak).');
  }
  const scope = createWorkspaceScope({
    workspaceId: payload.workspaceId,
    actorId: payload.actorId,
    role: 'member',
  });

  // 1. Ustlen + gorevi baslat + baglami TEK transaction'da topla.
  const context = await claimWhenLeaseAllows(deps, scope, payload.runId);

  // Kosu baskasi tarafindan ustlenilmis, gorev artik calistirilamaz durumda
  // oldugu icin iptal edilmis veya executor kapali: motor kapisina ulasma.
  if (!context) return;

  const { run, task, agent, comments } = context;
  // 2. Motoru transaction disinda kos. Lease kaybolur ya da worker kapanirsa
  // motor durdurulur.
  const leaseLost = new AbortController();
  const stopHeartbeat = startLeaseHeartbeat(deps.db, scope, run.id, (reason) =>
    leaseLost.abort(reason),
  );
  const signal = deps.signal ? AbortSignal.any([deps.signal, leaseLost.signal]) : leaseLost.signal;

  const result = await runAgentEngine(run.engine, {
    runId: run.id,
    systemPrompt: buildAgentSystemPrompt(agent),
    prompt: buildTaskPrompt({ task, comments }),
    ...(agent.workRoots[0] ? { cwd: agent.workRoots[0] } : {}),
    workRoots: agent.workRoots,
    allowedTools: agent.allowedTools,
    model: agent.model,
    signal,
  })
    .catch((error: unknown): EngineRunResult => ({
      // Motor hic baslamadi (or. wslpath/spawn hatasi). Bu da bir sonuctur ve
      // basarisiz kosu olarak yazilir; hata yutulmaz, thread'e gecer.
      ok: false,
      text: `Motor baslatilamadi: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: null,
      timedOut: false,
      logPath: '',
    }))
    .finally(stopHeartbeat);

  // 3. Sonucu yaz. Kosu HER DURUMDA kapanir; gorevi ise yalniz hala bu kosunun
  // sahibi ve `in_progress` ise degistiririz (kullanici motor calisirken
  // gorevi tasimis olabilir).
  await persistOutcome(deps.db, scope, { run, task, agent }, describeOutcome(result));
}

/**
 * Ajan ya da motor kaynakli metin DB'ye, thread'e ve sonraki kosularin prompt'una
 * girmeden once maskelenir. NUL (`\0`) de atilir: Postgres text kolonlari onu
 * kabul etmez ve tek bir NUL butun nihai yazimi (rapor, durum, ajan) dusururdu
 * (gercek veritabaninda olculdu: `invalid byte sequence ... 0x00`).
 */
function maskAgentText(text: string): string {
  const redacted = redactSecrets(text.replaceAll('\0', ''));
  return redacted.secretOnly ? SECRET_ONLY_NOTICE : redacted.text;
}

type RunRecordFields = Parameters<typeof finishRun>[3];

/** Motor sonucunun DB'ye yazilacak hali: tum serbest metin maskelidir. */
interface RunOutcome {
  readonly record: RunRecordFields;
  /** true: rapor teslim edilir (`review`); false: gorev `blocked` olur ve `report` thread'e yazilir. */
  readonly delivered: boolean;
  /** Maskeli rapor ya da basarisizlik metni. */
  readonly report: string;
  readonly artifactPath?: string;
  /** Thread yazari: motor sonucu `agent`, sonucun yazilamadigini bildiren son care `system`. */
  readonly author: 'agent' | 'system';
  readonly eventDetail: string;
}

function runRecord(result: EngineRunResult, status: 'ok' | 'failed'): RunRecordFields {
  return {
    status,
    // Ham deger engine.log'da durur; kolona sigmayan deger `finishRun`da cevrilir.
    exitCode: result.exitCode,
    ...(result.sessionId ? { externalSessionId: result.sessionId } : {}),
    ...(result.costMicros === undefined ? {} : { costMicros: result.costMicros }),
    ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
    ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
    ...(result.logPath ? { logPath: result.logPath } : {}),
  };
}

function describeOutcome(result: EngineRunResult): RunOutcome {
  const parsed = result.ok ? parseDeliverable(result.text) : null;
  if (parsed && !parsed.blocked) {
    return {
      record: runRecord(result, 'ok'),
      delivered: true,
      report: maskAgentText(parsed.summary),
      ...(parsed.artifactPath ? { artifactPath: parsed.artifactPath } : {}),
      author: 'agent',
      eventDetail: `teslim edildi${result.costMicros ? ` (${(result.costMicros / 1_000_000).toFixed(4)} USD)` : ''}`,
    };
  }
  // Basarisiz VEYA ajanin kendi bildirdigi engel: sebep thread'e yazilir. Yarim
  // isi teslim gibi gostermek yok.
  return {
    record: runRecord(result, 'failed'),
    delivered: false,
    report: maskAgentText(parsed ? parsed.summary : `Kosu tamamlanamadi: ${result.text}`),
    author: 'agent',
    eventDetail: `basarisiz: ${parsed?.blocked ? 'ajan engel bildirdi' : result.timedOut ? 'zaman asimi' : `exit ${result.exitCode}`}`,
  };
}

/** Veriden bagimsiz son care yazim: yalniz kosu `failed`, gorev `blocked`, ajan `idle`. */
function fallbackOutcome(): RunOutcome {
  return {
    record: { status: 'failed' },
    delivered: false,
    report:
      'Kosu sonucu veritabanina yazilamadi; kosu basarisiz sayildi. ' +
      'Ham cikti kosu dizinindeki engine.log dosyasinda durur.',
    author: 'system',
    eventDetail: 'basarisiz: sonuc kaydedilemedi',
  };
}

interface RunContext {
  readonly run: AgentRunRecord;
  readonly task: TaskRecord;
  readonly agent: AgentRecord;
}

/** `fn`yi ilk deneme + `delaysMs.length` yeniden denemeyle calistirir; hepsi dusunce son hatayi firlatir. */
async function retrying(
  delaysMs: readonly number[],
  fn: () => Promise<void>,
  onRetry: (error: unknown, attempt: number) => void,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fn();
      return;
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined) throw error;
      onRetry(error, attempt + 1);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Terminal durum garantisi: kosu sonucu yazilmadan birakilmaz. Once tam yazim
 * sinirli yeniden denenir; veri kaynakli kalici bir hata (ya da uzun kesinti)
 * varsa asgari `failed` yazimi denenir. O da dusunce firlatir: BullMQ isi
 * `failed` birakir ve kosuyu lease dolunca uzlastirici sonlandirir.
 */
async function persistOutcome(
  db: DbHandle,
  scope: WorkspaceScope,
  context: RunContext,
  outcome: RunOutcome,
): Promise<void> {
  const runId = context.run.id;
  const warnRetry = (error: unknown, attempt: number): void =>
    processLog.err(
      `AgentRun nihai yazim ${attempt}. denemede basarisiz (${runId}): ${safeMessage(error)}`,
    );

  try {
    await retrying(
      FINAL_WRITE_RETRY_DELAYS_MS,
      () => writeOutcome(db, scope, context, outcome),
      warnRetry,
    );
    return;
  } catch (error) {
    processLog.err(
      `AgentRun nihai yazim basarisiz (${runId}), asgari failed yazimi deneniyor: ${safeMessage(error)}`,
    );
  }

  try {
    await retrying(
      FALLBACK_WRITE_RETRY_DELAYS_MS,
      () => writeOutcome(db, scope, context, fallbackOutcome()),
      warnRetry,
    );
  } catch (error) {
    throw new Error(`AgentRun nihai durum yazilamadi (${runId}): ${safeMessage(error)}`, {
      cause: error,
    });
  }
}

/** Sonucu TEK transaction'da yazar; basarisizsa hicbir sey yazilmaz (yeniden denenebilir). */
async function writeOutcome(
  db: DbHandle,
  scope: WorkspaceScope,
  { run, task, agent }: RunContext,
  outcome: RunOutcome,
): Promise<void> {
  const actor =
    outcome.author === 'agent'
      ? ({ authorType: 'agent', authorId: agent.id } as const)
      : ({ authorType: 'system', authorId: 'system' } as const);

  await withScope(db.prisma, scope, async (tx) => {
    const currentTask = await lockTaskForRunCompletion(tx, scope, {
      taskId: task.id,
      agentId: agent.id,
    });
    await finishRun(tx, scope, run.id, outcome.record);
    // Yalniz working -> idle: kullanici ajani calisirken devre disi (offline)
    // biraktiysa bu yazim onu geri almaz.
    await setAgentStatus(tx, scope, agent.id, 'idle', { onlyFrom: ['working'] });

    if (!currentTask) {
      // Sonuc panoya uygulanamaz ama kaybolmaz: rapor thread'de durur.
      await addComment(tx, scope, {
        taskId: task.id,
        ...actor,
        kind: 'note',
        body: `Kosu sonucu panoya uygulanmadi (gorev durumu veya sahibi degisti). Sonuc:\n${outcome.report}`,
      });
      await appendEvent(tx, scope, {
        kind: 'run_finished',
        taskId: task.id,
        agentId: agent.id,
        detail:
          'Kosu terminal oldu; gorev durumu veya sahibi degistigi icin sonuc panoya uygulanmadi.',
      });
      return;
    }

    if (outcome.delivered) {
      await deliverTask(tx, scope, {
        taskId: task.id,
        agentId: agent.id,
        deliverable: outcome.report,
        ...(outcome.artifactPath ? { artifactPath: outcome.artifactPath } : {}),
      });
    } else {
      await moveTask(tx, scope, task.id, 'blocked', actor);
      await addComment(tx, scope, {
        taskId: task.id,
        ...actor,
        kind: 'note',
        body: outcome.report,
      });
    }

    await appendEvent(tx, scope, {
      kind: 'run_finished',
      taskId: task.id,
      agentId: agent.id,
      detail: outcome.eventDetail,
    });
  });
}

/**
 * Kuyruk ayni isi ikinci kez teslim ettiginde kosu baska bir worker'da halen
 * calisiyor olabilir (`ActiveRunLeaseError`). Lease dolana kadar bekler ve
 * yeniden dener: dolarsa `claimRun` sahipsiz kosuyu sonlandirip `null` doner,
 * kosu bitmisse yine `null`. Kuyruk motoru yeniden CALISTIRMAZ.
 */
async function claimWhenLeaseAllows(
  deps: { db: DbHandle; signal?: AbortSignal },
  scope: WorkspaceScope,
  runId: string,
) {
  for (;;) {
    try {
      return await claimContext(deps.db, scope, runId);
    } catch (error) {
      if (!(error instanceof ActiveRunLeaseError)) throw error;
      await waitForLease(error.retryAfterMs, deps.signal);
    }
  }
}

/**
 * Motoru calistirmamanin sebebini sistem notu olarak thread'e, hata olarak
 * akisa yazar ve kosuyu kapatir. Gorev OLDUGU GIBI kalir: yapilmamis is yapilmis
 * ya da engellenmis gibi gosterilmez, sebep gorunur olur.
 */
async function declineRun(
  tx: Tx,
  scope: WorkspaceScope,
  input: {
    run: AgentRunRecord;
    task: TaskRecord;
    agent: AgentRecord;
    status: 'failed' | 'cancelled';
    comment: string;
    eventDetail: string;
  },
): Promise<null> {
  await finishRun(tx, scope, input.run.id, { status: input.status });
  await addComment(tx, scope, {
    taskId: input.task.id,
    authorType: 'system',
    authorId: 'system',
    body: input.comment,
  });
  await appendEvent(tx, scope, {
    kind: 'error',
    taskId: input.task.id,
    agentId: input.agent.id,
    detail: input.eventDetail,
  });
  return null;
}

/**
 * Task satirini kilitler (claimRun), kosuyu ustlenir ve gorevi `in_progress`
 * yapar. `null`: motor cagrilmamali (kosu iptal, sahipsiz, bitmis, executor
 * kapali, cihaz yerel degil ya da ajan devre disi).
 */
async function claimContext(db: DbHandle, scope: WorkspaceScope, runId: string) {
  return withScope(db.prisma, scope, async (tx) => {
    const run = await claimRun(tx, scope, runId);
    if (!run) return null;

    const task = await findTask(tx, scope, run.taskId);
    const agent = await findAgent(tx, scope, run.agentId);
    if (!task || !agent) {
      await finishRun(tx, scope, run.id, { status: 'failed' });
      await appendEvent(tx, scope, {
        kind: 'error',
        taskId: run.taskId,
        agentId: run.agentId,
        detail: 'Kosu iptal: gorev veya ajan kaydi bulunamadi.',
      });
      return null;
    }

    if (!isMissionExecutorEnabled()) {
      // Motor kapali: durumu OLDUGU GIBI bildir. Sessizce "kosuldu" gibi
      // davranmak, panoda yapilmamis isi yapilmis gostermek olurdu.
      return declineRun(tx, scope, {
        run,
        task,
        agent,
        status: 'cancelled',
        comment:
          'Executor kapali oldugu icin kosu yapilmadi. Acmak icin worker ortaminda ' +
          'SMITH_MISSION_EXECUTOR=1 ver.',
        eventDetail: 'Executor kapali (SMITH_MISSION_EXECUTOR != 1)',
      });
    }

    if (!isLocalAgentDevice(run.device)) {
      // Motor bu makinede kosar: m2/server kosusunu yerelde calistirmak yanlis
      // makinede dosya degistirir ve panoya baska makinede kosmus gibi yazar.
      return declineRun(tx, scope, {
        run,
        task,
        agent,
        status: 'failed',
        comment:
          `Bu kosu '${run.device}' cihazi icin olusturulmus; worker yalniz ` +
          `${LOCAL_AGENT_DEVICES.join(' ve ')} cihazlarinda kosar (m2 ve server Faz 2). Kosu yapilmadi.`,
        eventDetail: `Cihaz desteklenmiyor: ${run.device}`,
      });
    }

    // Ajani ustlen: TEK kosullu yazim hem "devre disi degil" kontroludur hem
    // calisiyor isareti. Arada offline'a cekilirse yazim 0 satir doner.
    const claimedAgent = await setAgentStatus(tx, scope, agent.id, 'working', {
      onlyFrom: ['idle', 'working'],
    });
    if (!claimedAgent) {
      return declineRun(tx, scope, {
        run,
        task,
        agent,
        status: 'cancelled',
        comment:
          `@${agent.slug} devre disi (offline) oldugu icin kosu yapilmadi. ` +
          'Ajani etkinlestirip gorevi yeniden ata.',
        eventDetail: `Ajan devre disi (offline): @${agent.slug}`,
      });
    }

    const comments = await listComments(tx, scope, task.id, TASK_COMMENT_WINDOW);
    await moveTask(tx, scope, task.id, 'in_progress', {
      authorType: 'agent',
      authorId: agent.id,
    });
    await addComment(tx, scope, {
      taskId: task.id,
      authorType: 'agent',
      authorId: agent.id,
      kind: 'claim',
      body: `Isi ustlendim (${run.device} / ${run.engine}).`,
    });
    await appendEvent(tx, scope, {
      kind: 'run_started',
      taskId: task.id,
      agentId: agent.id,
      detail: `${run.engine} @ ${run.device}`,
    });

    return { run, task, agent, comments };
  });
}

/**
 * Motor kosarken lease'i tazeler. Gecici DB hatasi kosuyu oldurmez, sonraki
 * atis yeniden dener; ama damga lease suresince yazilamazsa baska bir worker
 * kosuyu sahipsiz sayabilir, bu yuzden `onLost` motoru durdurur. `heartbeatRun`
 * `false` donerse kosu baska yerde sonlandirilmistir: motor hemen durdurulur.
 * Donen fonksiyon zamanlayiciyi durdurur.
 */
function startLeaseHeartbeat(
  db: DbHandle,
  scope: WorkspaceScope,
  runId: string,
  onLost: (reason: Error) => void,
): () => void {
  let lastBeatAt = Date.now();
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void withScope(db.prisma, scope, (tx) => heartbeatRun(tx, scope, runId))
      .then((alive) => {
        if (alive) lastBeatAt = Date.now();
        else onLost(new Error('Kosu lease kaydi artik etkin degil.'));
      })
      .catch((error: unknown) => {
        if (Date.now() - lastBeatAt >= AGENT_RUN_LEASE_MS) {
          onLost(new Error('Kosu lease suresi doldu: heartbeat yazilamadi.', { cause: error }));
        }
      })
      .finally(() => {
        inFlight = false;
      });
  }, AGENT_RUN_HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/** Lease dolana kadar bekler; worker kapanirsa (signal) beklemeyi birakir. */
function waitForLease(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(done, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Kosu iptal edildi.');
}
