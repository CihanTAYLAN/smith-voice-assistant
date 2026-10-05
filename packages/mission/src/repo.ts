import {
  newAgentId,
  newAgentRunId,
  newTaskCommentId,
  newTaskEventId,
  newTaskId,
  withScope,
  type DbHandle,
  type Tx,
} from '@smith/db';
import { requireRole, type WorkspaceScope } from '@smith/tenancy';

import { isLocalAgentDevice, LOCAL_AGENT_DEVICES } from './devices.js';
import { DEFAULT_AGENT_ENGINE, type AgentEngine } from './engines.js';
import { extractMentions } from './mentions.js';
import { assertTransition, isRunnableTaskStatus, type TaskStatus } from './status.js';

/**
 * Mission Control repository'si. Her fonksiyon WorkspaceScope ister ve scoped
 * transaction icinde cagrilir — RLS oturum degiskeni set edilmis demektir.
 *
 * Iki katmanli savunma memory paketiyle ayni: sorguda acik workspace filtresi
 * VAR (birinci katman), RLS politikasi ayrica her satiri tutar (ikinci katman,
 * son soz).
 *
 * Etkinlik akisi (TaskEvent) BURADAN yazilir, cagiranlardan degil. Sebep: uc
 * ayri yazar (UI, sesli arac, executor) var ve "durumu degistirmeyi hatirlayip
 * etkinligi yazmayi unutmak" akisi sessizce delik brakir. Durum degisikligi ve
 * onun kaydi ayni fonksiyonda, ayni transaction'da olur.
 */

export interface AgentRecord {
  id: string;
  workspaceId: string;
  slug: string;
  displayName: string;
  role: string;
  soul: string;
  model: string | null;
  parentId: string | null;
  device: string;
  workRoots: string[];
  allowedTools: string[];
  status: string;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskRecord {
  id: string;
  workspaceId: string;
  title: string;
  detail: string | null;
  status: string;
  priority: number;
  assigneeId: string | null;
  parentId: string | null;
  deliverable: string | null;
  artifactPath: string | null;
  createdBy: string;
  dueAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskCommentRecord {
  id: string;
  taskId: string;
  authorType: string;
  authorId: string;
  agentId: string | null;
  kind: string;
  body: string;
  mentions: string[];
  createdAt: Date;
}

export interface TaskEventRecord {
  id: string;
  taskId: string | null;
  agentId: string | null;
  kind: string;
  detail: string | null;
  createdAt: Date;
}

export interface AgentRunRecord {
  id: string;
  taskId: string;
  agentId: string;
  device: string;
  engine: string;
  status: string;
  externalSessionId: string | null;
  exitCode: number | null;
  costMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  logPath: string | null;
  startedAt: Date;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Etkinlik akisi
// ---------------------------------------------------------------------------

/**
 * Akisa satir ekler. Append-only: guncelleme/silme yolu YOKTUR — pano
 * gecmisi bir kayittir, bir gorunum degil.
 */
export async function appendEvent(
  tx: Tx,
  scope: WorkspaceScope,
  input: { kind: string; detail?: string; taskId?: string; agentId?: string },
): Promise<void> {
  requireRole(scope, 'member');
  await tx.taskEvent.create({
    data: {
      id: newTaskEventId(),
      workspaceId: scope.workspaceId,
      kind: input.kind,
      detail: input.detail ?? null,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
    },
  });
}

/** Etkinlik akisi: yeniden eskiye. Panonun "ne oldu" paneli. */
export async function listEvents(
  tx: Tx,
  scope: WorkspaceScope,
  limit = 50,
): Promise<TaskEventRecord[]> {
  return tx.taskEvent.findMany({
    where: { workspaceId: scope.workspaceId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      taskId: true,
      agentId: true,
      kind: true,
      detail: true,
      createdAt: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Ekip
// ---------------------------------------------------------------------------

export async function createAgent(
  tx: Tx,
  scope: WorkspaceScope,
  input: {
    slug: string;
    displayName: string;
    role: string;
    soul: string;
    model?: string;
    parentId?: string;
    device?: string;
    workRoots?: string[];
    allowedTools?: string[];
  },
): Promise<AgentRecord> {
  requireRole(scope, 'member');
  const agent = await tx.agent.create({
    data: {
      id: newAgentId(),
      workspaceId: scope.workspaceId,
      slug: input.slug,
      displayName: input.displayName,
      role: input.role,
      soul: input.soul,
      model: input.model ?? null,
      parentId: input.parentId ?? null,
      ...(input.device ? { device: input.device } : {}),
      workRoots: input.workRoots ?? [],
      allowedTools: input.allowedTools ?? [],
    },
  });
  await appendEvent(tx, scope, {
    kind: 'agent_created',
    agentId: agent.id,
    detail: `${agent.displayName} (@${agent.slug}) ekibe katildi — rol: ${agent.role}`,
  });
  return agent;
}

/** Org semasi ve pano bunu bir kez cekip hiyerarsiyi kendisi kurar. */
export async function listAgents(tx: Tx, scope: WorkspaceScope): Promise<AgentRecord[]> {
  return tx.agent.findMany({
    where: { workspaceId: scope.workspaceId },
    orderBy: [{ role: 'asc' }, { slug: 'asc' }],
  });
}

export async function findAgent(
  tx: Tx,
  scope: WorkspaceScope,
  agentId: string,
): Promise<AgentRecord | null> {
  return tx.agent.findFirst({ where: { id: agentId, workspaceId: scope.workspaceId } });
}

/**
 * Sesli delegasyonun giris kapisi: "bunu Nova'ya ver" cumlesinde Smith'in
 * elinde slug vardir, id yoktur.
 */
export async function findAgentBySlug(
  tx: Tx,
  scope: WorkspaceScope,
  slug: string,
): Promise<AgentRecord | null> {
  return tx.agent.findFirst({
    where: { workspaceId: scope.workspaceId, slug: slug.toLowerCase() },
  });
}

/**
 * Ajan profilini gunceller. SOUL da buradan degisir: ajanin davranisi tek
 * kaynaktan (DB) gelir, kod icinde ikinci bir kisilik tanimi yoktur.
 */
export async function updateAgent(
  tx: Tx,
  scope: WorkspaceScope,
  agentId: string,
  patch: {
    displayName?: string;
    role?: string;
    soul?: string;
    model?: string | null;
    parentId?: string | null;
    device?: string;
    workRoots?: string[];
    allowedTools?: string[];
    status?: string;
  },
): Promise<AgentRecord | null> {
  requireRole(scope, 'member');
  const existing = await findAgent(tx, scope, agentId);
  if (!existing) return null;

  const updated = await tx.agent.update({ where: { id: agentId }, data: patch });
  if (patch.soul !== undefined && patch.soul !== existing.soul) {
    await appendEvent(tx, scope, {
      kind: 'agent_soul_updated',
      agentId,
      detail: `@${existing.slug} SOUL guncellendi`,
    });
  }
  return updated;
}

/**
 * Ajani siler — YALNIZ kosu gecmisi yoksa.
 *
 * NEDEN KOSULLU: `AgentRun.agentId` CASCADE'dir, yani ajani silmek onun butun
 * kosularini (ve dolayisiyla harcanan maliyetin kaydini) da siler. Yanlis
 * yazilmis taze bir ajani temizlemek mesru bir istir; calismis bir ajani silmek
 * ise MUHASEBE KAYBIDIR ve geri alinamaz. Bu yuzden kosusu olan ajan silinmez,
 * `offline` isaretlenir (cagiran bu ayrimi kullaniciya soyler).
 *
 * Donus: silindi mi. `false` = kosu gecmisi var.
 */
export async function deleteAgentIfUnused(
  tx: Tx,
  scope: WorkspaceScope,
  agentId: string,
): Promise<{ deleted: boolean; runCount: number }> {
  requireRole(scope, 'member');
  const runCount = await tx.agentRun.count({
    where: { workspaceId: scope.workspaceId, agentId },
  });
  if (runCount > 0) return { deleted: false, runCount };

  const agent = await findAgent(tx, scope, agentId);
  if (!agent) return { deleted: false, runCount: 0 };

  // Olay akisi KALIR (TaskEvent.agentId SetNull): "kim ne yapti" gecmisi bir
  // ajanin silinmesiyle yeniden yazilmaz.
  await appendEvent(tx, scope, {
    kind: 'agent_deleted',
    detail: `@${agent.slug} (${agent.role}) ekipten silindi — kosu gecmisi yoktu`,
  });
  await tx.agent.deleteMany({ where: { id: agentId, workspaceId: scope.workspaceId } });
  return { deleted: true, runCount: 0 };
}

export type AgentStatus = 'idle' | 'working' | 'offline';

/**
 * Ajanin canlilik durumu. `lastSeenAt` yalniz burada tazelenir; panodaki
 * "nabiz" gostergesi bu alani okur.
 *
 * `onlyFrom` gecisi KOSULLU yapar (`WHERE status IN (...)`): kullanici bir
 * ajani `offline`a cekmisse worker'in kosu sonundaki `idle` yazimi bunu ezmez
 * (devre disi birakma etkisiz kalirdi). Donus: yazim uygulandi mi; `false`
 * durumun `onlyFrom` disinda oldugunu soyler.
 */
export async function setAgentStatus(
  tx: Tx,
  scope: WorkspaceScope,
  agentId: string,
  status: AgentStatus,
  options: { onlyFrom?: readonly AgentStatus[] } = {},
): Promise<boolean> {
  requireRole(scope, 'member');
  const updated = await tx.agent.updateMany({
    where: {
      id: agentId,
      workspaceId: scope.workspaceId,
      ...(options.onlyFrom ? { status: { in: [...options.onlyFrom] } } : {}),
    },
    data: { status, lastSeenAt: new Date() },
  });
  return updated.count > 0;
}

// ---------------------------------------------------------------------------
// Gorevler
// ---------------------------------------------------------------------------

export async function createTask(
  tx: Tx,
  scope: WorkspaceScope,
  input: {
    title: string;
    detail?: string;
    priority?: number;
    parentId?: string;
    createdBy: string;
    dueAt?: Date;
  },
): Promise<TaskRecord> {
  requireRole(scope, 'member');
  const task = await tx.task.create({
    data: {
      id: newTaskId(),
      workspaceId: scope.workspaceId,
      title: input.title,
      detail: input.detail ?? null,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      parentId: input.parentId ?? null,
      createdBy: input.createdBy,
      dueAt: input.dueAt ?? null,
    },
  });
  await appendEvent(tx, scope, {
    kind: 'created',
    taskId: task.id,
    detail: task.title,
  });
  return task;
}

export async function findTask(
  tx: Tx,
  scope: WorkspaceScope,
  taskId: string,
): Promise<TaskRecord | null> {
  return tx.task.findFirst({ where: { id: taskId, workspaceId: scope.workspaceId } });
}

/**
 * Gorev satirini transaction sonuna kadar kilitler. Claim ve kullanici durum
 * degisikligi ayni kilidi alir; boylece "blocked yazilirken queued run claim
 * edildi" yarisi iki atomik siradan birine indirgenir.
 */
async function findTaskForUpdate(
  tx: Tx,
  scope: WorkspaceScope,
  taskId: string,
): Promise<TaskRecord | null> {
  const rows = await tx.$queryRaw<TaskRecord[]>`
    SELECT *
    FROM "Task"
    WHERE "id" = ${taskId} AND "workspaceId" = ${scope.workspaceId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Pano sorgusu. Siralama panonun okunma bicimini yansitir: once oncelik,
 * sonra en yeni hareket.
 */
export async function listTasks(
  tx: Tx,
  scope: WorkspaceScope,
  filter: { status?: TaskStatus; assigneeId?: string; limit?: number } = {},
): Promise<TaskRecord[]> {
  return tx.task.findMany({
    where: {
      workspaceId: scope.workspaceId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.assigneeId ? { assigneeId: filter.assigneeId } : {}),
    },
    orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }],
    take: filter.limit ?? 200,
  });
}

/**
 * Kod -> HTTP durumu eslemesi gateway'de genel kurala baglidir: `*_not_found`
 * ile bitenler 404, digerleri 409. Bu yuzden 409 olmasi gereken yeni koda
 * `_not_found` sonu verilmez.
 */
export type MissionErrorCode =
  | 'task_not_found'
  | 'agent_not_found'
  | 'already_assigned'
  | 'active_run'
  | 'agent_offline'
  | 'device_unsupported';

export class MissionError extends Error {
  constructor(
    message: string,
    readonly code: MissionErrorCode,
  ) {
    super(message);
    this.name = 'MissionError';
  }
}

/**
 * Atama = panonun kalbi. Uc sey AYNI transaction'da olur:
 *   1. gorev `assigned` durumuna gecer ve sahibi yazilir,
 *   2. kosu kaydi ('queued') yaratilir,
 *   3. etkinlik akisina satir duser.
 *
 * Kosu kaydinin BURADA yaratilmasi bilincli: kuyruga atilan isin jobId'si bu
 * satirin id'si olur ve consumer yalniz 'queued' satiri gorurse kosar. Boylece
 * cift tetikleme ikinci kez para harcamaz — idempotency kuyrukta degil
 * veritabaninda capalidir (kuyruk kaydi temizlenebilir, satir kalir).
 *
 * YENIDEN ATAMA: gorevin bekleyen (`queued`) kosusu otomatik iptal edilir ve
 * atama surer (ADR 0007 madde 5): eski ajanin kuyrukta duran isi tutup
 * calismasin. Calisan (`running`) kosu varken atama `active_run` ile
 * reddedilir: motor disaridan nazikce durdurulamadigi icin ikinci bir kosu ayni
 * dosyalara yazar ve son bitiren digerinin teslim/engel durumunu ezerdi.
 *
 * REVIZYON VE YENIDEN ACMA: `review` (revizyon) ve `done` (yeniden acma)
 * durumundaki gorev de atanir (status.ts): yeni kosu, ayni ya da baska ajanla.
 * Yeniden acilan gorev bitmis sayilmaz (`finishedAt` temizlenir); yorumlar,
 * kosu gecmisi ve ilk baslangic damgasi korunur.
 *
 * Atama kapilari (hicbiri kosu/iptal yazmadan once degerlendirilir): devre
 * disi (`offline`) ajan `agent_offline`, yerel olmayan cihaz (`m2`, `server`)
 * `device_unsupported` ile reddedilir.
 */
export async function assignTask(
  tx: Tx,
  scope: WorkspaceScope,
  input: { taskId: string; agentId: string; engine?: AgentEngine },
): Promise<{ task: TaskRecord; run: AgentRunRecord }> {
  requireRole(scope, 'member');

  const task = await findTaskForUpdate(tx, scope, input.taskId);
  if (!task) throw new MissionError(`Gorev bulunamadi: ${input.taskId}`, 'task_not_found');

  const runningRun = await tx.agentRun.findFirst({
    where: { workspaceId: scope.workspaceId, taskId: task.id, status: 'running' },
    select: { id: true },
  });
  if (runningRun) {
    throw new MissionError(
      `Gorev yeniden atanamaz: ${runningRun.id} kosusu calisiyor. Kosunun bitmesini bekle; ` +
        'worker durmussa lease dolunca sahipsiz kosu otomatik sonlandirilir, sonra yeniden ata.',
      'active_run',
    );
  }

  const agent = await findAgent(tx, scope, input.agentId);
  if (!agent) throw new MissionError(`Ajan bulunamadi: ${input.agentId}`, 'agent_not_found');
  if (agent.status === 'offline') {
    throw new MissionError(
      `Ajan devre disi (offline): @${agent.slug}. Atamadan once ajani etkinlestir.`,
      'agent_offline',
    );
  }
  if (!isLocalAgentDevice(agent.device)) {
    throw new MissionError(
      `@${agent.slug} ajaninin cihazi '${agent.device}': bu surumde kosu yalniz ` +
        `${LOCAL_AGENT_DEVICES.join(' ve ')} cihazlarinda yapilir (m2 ve server Faz 2). ` +
        'Ajani yerel bir cihaza al.',
      'device_unsupported',
    );
  }

  const from = task.status as TaskStatus;
  assertTransition(from, 'assigned');

  const supersededRuns = await tx.agentRun.updateMany({
    where: { workspaceId: scope.workspaceId, taskId: task.id, status: 'queued' },
    data: { status: 'cancelled', finishedAt: new Date() },
  });

  const updated = await tx.task.update({
    where: { id: task.id },
    data: {
      status: 'assigned',
      assigneeId: agent.id,
      ...(from === 'done' ? { finishedAt: null } : {}),
    },
  });

  const run = await tx.agentRun.create({
    data: {
      id: newAgentRunId(),
      workspaceId: scope.workspaceId,
      taskId: task.id,
      agentId: agent.id,
      device: agent.device,
      // Motor atama aninda SECILIR ve satira yazilir: kosunun hangi is gucuyle
      // yapildigi sonradan geriye donuk tahmin edilemez (ayni ajan farkli
      // gorevlerde farkli motorla kosabilir). Varsayilan: claude-code.
      engine: input.engine ?? DEFAULT_AGENT_ENGINE,
      status: 'queued',
    },
  });

  await appendEvent(tx, scope, {
    kind: 'assigned',
    taskId: task.id,
    agentId: agent.id,
    detail:
      `${task.title} → @${agent.slug} (${input.engine ?? DEFAULT_AGENT_ENGINE})` +
      // Revizyon ve yeniden acma akista gorunur: atama durum olayi yazmaz, onceki
      // durum burada kaybolursa "bitmis" bir gorevin neden yeniden atandigi okunamaz.
      (from === 'review' || from === 'done' ? `, ${from} durumundan yeniden atandi` : '') +
      (supersededRuns.count > 0 ? ', onceki bekleyen kosu iptal edildi' : ''),
  });

  return { task: updated, run };
}

/**
 * Durum degisikligi. Gecerlilik status.ts'te tanimli; gecersiz gecis
 * InvalidTransitionError ile reddedilir. Ayni duruma yazma no-op'tur ve
 * akisa gurultu yazmaz.
 *
 * Sahip ve bitis damgasi durumdan TURETILIR: `inbox` daima sahipsizdir (sahip
 * temizlenir, olay yine eski sahibe baglanir) ve `done`dan cikan gorev bitmis
 * sayilmaz.
 */
export async function moveTask(
  tx: Tx,
  scope: WorkspaceScope,
  taskId: string,
  to: TaskStatus,
  by: { authorType: 'user' | 'agent' | 'system'; authorId: string },
): Promise<TaskRecord> {
  requireRole(scope, 'member');
  const task = await findTaskForUpdate(tx, scope, taskId);
  if (!task) throw new MissionError(`Gorev bulunamadi: ${taskId}`, 'task_not_found');

  const from = task.status as TaskStatus;
  if (from === to) return task;
  assertTransition(from, to);
  // Olay eski sahibe baglanir: `inbox` gecisi asagida sahibi temizler.
  const previousAssigneeId = task.assigneeId;

  const updated = await tx.task.update({
    where: { id: taskId },
    data: {
      status: to,
      // Zaman damgalari ve sahip durumdan TURETILIR; cagiranin ayrica set etmesi
      // gerekmez, dolayisiyla unutulamaz.
      ...(to === 'in_progress' && !task.startedAt ? { startedAt: new Date() } : {}),
      ...(to === 'done' ? { finishedAt: new Date() } : {}),
      ...(from === 'done' ? { finishedAt: null } : {}),
      ...(to === 'inbox' ? { assigneeId: null } : {}),
    },
  });

  // Pano gorevi artik calistirilabilir saymiyorsa queued kosu da terminal
  // olur. Ayni task row lock altinda yapildigi icin worker claim'iyle arada
  // pencere yoktur. Running kosu ayri bir motor-iptal sozlesmesi gerektirir.
  if (!isRunnableTaskStatus(to)) {
    await tx.agentRun.updateMany({
      where: { workspaceId: scope.workspaceId, taskId, status: 'queued' },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
  }

  await appendEvent(tx, scope, {
    kind: 'status',
    taskId,
    ...(previousAssigneeId ? { agentId: previousAssigneeId } : {}),
    detail: `${from} → ${to} (${by.authorType}:${by.authorId})`,
  });
  return updated;
}

/**
 * Teslim: executor isini bitirdiginde ozeti ve varsa uretilen dosyanin yolunu
 * yazar, gorevi `review`'a tasir ve thread'e `deliver` yorumu dusurur.
 *
 * Gorev `done`'a BURADAN gecmez — inceleme insanin isidir (status.ts).
 */
export async function deliverTask(
  tx: Tx,
  scope: WorkspaceScope,
  input: { taskId: string; agentId: string; deliverable: string; artifactPath?: string },
): Promise<TaskRecord> {
  requireRole(scope, 'member');
  const task = await findTask(tx, scope, input.taskId);
  if (!task) throw new MissionError(`Gorev bulunamadi: ${input.taskId}`, 'task_not_found');

  assertTransition(task.status as TaskStatus, 'review');

  const updated = await tx.task.update({
    where: { id: input.taskId },
    data: {
      status: 'review',
      deliverable: input.deliverable,
      artifactPath: input.artifactPath ?? null,
    },
  });

  await addComment(tx, scope, {
    taskId: input.taskId,
    authorType: 'agent',
    authorId: input.agentId,
    kind: 'deliver',
    body: input.deliverable,
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

/**
 * Gorev thread'ine yorum. `kind` ekip dinamigini tasir: claim (isi ustlendim),
 * review (inceledim), refute (katilmiyorum), deliver (teslim), note (not).
 *
 * @mention'lar govdeden BURADA cikarilir; cagiranin ayrica gondermesi
 * gerekmez, boylece UI ile ajan yolu ayrisamaz.
 */
export async function addComment(
  tx: Tx,
  scope: WorkspaceScope,
  input: {
    taskId: string;
    authorType: 'user' | 'agent' | 'system';
    authorId: string;
    body: string;
    kind?: 'note' | 'claim' | 'review' | 'refute' | 'deliver';
  },
): Promise<TaskCommentRecord> {
  requireRole(scope, 'member');
  const mentions = extractMentions(input.body);
  const comment = await tx.taskComment.create({
    data: {
      id: newTaskCommentId(),
      workspaceId: scope.workspaceId,
      taskId: input.taskId,
      authorType: input.authorType,
      authorId: input.authorId,
      agentId: input.authorType === 'agent' ? input.authorId : null,
      kind: input.kind ?? 'note',
      body: input.body,
      mentions,
    },
  });

  await appendEvent(tx, scope, {
    kind: 'comment',
    taskId: input.taskId,
    ...(input.authorType === 'agent' ? { agentId: input.authorId } : {}),
    detail: `${comment.kind}: ${input.body.slice(0, 160)}`,
  });
  return comment;
}

export async function listComments(
  tx: Tx,
  scope: WorkspaceScope,
  taskId: string,
  limit?: number,
): Promise<TaskCommentRecord[]> {
  const comments = await tx.taskComment.findMany({
    where: { workspaceId: scope.workspaceId, taskId },
    orderBy: { createdAt: limit === undefined ? 'asc' : 'desc' },
    ...(limit === undefined ? {} : { take: limit }),
    select: {
      id: true,
      taskId: true,
      authorType: true,
      authorId: true,
      agentId: true,
      kind: true,
      body: true,
      mentions: true,
      createdAt: true,
    },
  });
  return limit === undefined ? comments : comments.reverse();
}

// ---------------------------------------------------------------------------
// Kosular
// ---------------------------------------------------------------------------

export async function findRun(
  tx: Tx,
  scope: WorkspaceScope,
  runId: string,
): Promise<AgentRunRecord | null> {
  return tx.agentRun.findFirst({ where: { id: runId, workspaceId: scope.workspaceId } });
}

/**
 * LEASE: calisan kosunun canlilik sozlesmesi. Worker motor calisirken her
 * `AGENT_RUN_HEARTBEAT_MS`te `heartbeatAt`i tazeler (`heartbeatRun`);
 * `AGENT_RUN_LEASE_MS` boyunca damga gelmeyen 'running' kosu sahipsiz sayilir
 * (worker coktu). Oran bilincli: lease birkac kacirilmis atisi tolere eder.
 */
export const AGENT_RUN_HEARTBEAT_MS = 15_000;
export const AGENT_RUN_LEASE_MS = 90_000;

const ABANDONED_RUN_REASON = 'yarida kaldi: worker durdu';

/** CAS kaybinda (arada baska yazar kosuyu degistirdi) bir sonraki okuma icin bekleme. */
const LEASE_RECHECK_MS = 1_000;

/**
 * Kosu 'running' ve lease'i etkin: baska bir worker onu halen kosuyor olabilir.
 * Cagiran `retryAfterMs` sonra yeniden dener; kosuya dokunulmaz.
 */
export class ActiveRunLeaseError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Kosu lease'i halen etkin; ${retryAfterMs}ms sonra yeniden dene.`);
    this.name = 'ActiveRunLeaseError';
  }
}

/**
 * Kosuyu ustlenir: task satirini kilitler, guncel task durumu calistirilabilir
 * ise `queued` → `running` yapar. Task calistirilamaz durumdaysa queued run'i
 * `cancelled` yapar. Kuyruk ayni isi ikinci kez teslim ederse (worker coktu)
 * 'running' kosu burada UZLASTIRILIR: lease'i doluysa `ActiveRunLeaseError`,
 * dolmussa kosu yeniden calistirilmadan sonlandirilir (`abandonStaleRun`).
 * Donus `null` ise consumer hicbir motor cagirmamalidir.
 *
 * Run yazimi yine kosullu WHERE ile CAS yapar; task row lock'i kullanici durum
 * degisikligiyle yarisi, CAS ise iki worker arasindaki yarisi kapatir.
 */
export async function claimRun(
  tx: Tx,
  scope: WorkspaceScope,
  runId: string,
): Promise<AgentRunRecord | null> {
  requireRole(scope, 'member');
  const candidate = await findRun(tx, scope, runId);
  if (!candidate) return null;

  if (candidate.status === 'running') {
    await abandonStaleRun(tx, scope, candidate);
    return null;
  }
  if (candidate.status !== 'queued') return null;

  // moveTask ile AYNI satir kilidi. Bloklama once commit ederse kosu iptal
  // edilir; claim once commit ederse gorev atomik olarak in_progress'e
  // alinmadan motor kapisina ulasilmaz (consumer bunu ayni transaction'da yapar).
  const task = await findTaskForUpdate(tx, scope, candidate.taskId);
  if (!task || !isRunnableTaskStatus(task.status)) {
    await tx.agentRun.updateMany({
      where: { id: runId, workspaceId: scope.workspaceId, status: 'queued' },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    return null;
  }

  const now = new Date();
  const claimed = await tx.agentRun.updateMany({
    where: { id: runId, workspaceId: scope.workspaceId, status: 'queued' },
    data: { status: 'running', startedAt: now, heartbeatAt: now },
  });
  if (claimed.count === 0) return null;
  return findRun(tx, scope, runId);
}

/**
 * Lease'i dolmus 'running' kosuyu sahipsiz ilan eder: kosu `failed`, gorev
 * `blocked`, ajan `idle` olur ve akisa `run_abandoned` duser. Kosu YENIDEN
 * CALISTIRILMAZ: yarim kalan motor dosya yazmis ya da komut kosmus olabilir;
 * tekrar karari panodan, insan tarafindan verilir.
 *
 * Sonlandirma yolu TEKTIR: kuyruk yeniden teslimi (`claimRun`), gateway
 * uzlastiricisi ve worker acilis taramasi (`abandonExpiredRuns`) hep bunu
 * cagirir. Lease etkinse `ActiveRunLeaseError` firlatir ve hicbir sey yazmaz.
 */
export async function abandonStaleRun(
  tx: Tx,
  scope: WorkspaceScope,
  run: AgentRunRecord,
): Promise<void> {
  const leaseLeftMs =
    (run.heartbeatAt ?? run.startedAt).getTime() + AGENT_RUN_LEASE_MS - Date.now();
  if (leaseLeftMs > 0) throw new ActiveRunLeaseError(leaseLeftMs);

  const task = await findTaskForUpdate(tx, scope, run.taskId);
  // Kilit alinirken sonuc ya da gec bir atis yazilmis olabilir: CAS, damganin
  // okudugumuz deger olmasini sart kosar.
  const abandoned = await tx.agentRun.updateMany({
    where: {
      id: run.id,
      workspaceId: scope.workspaceId,
      status: 'running',
      heartbeatAt: run.heartbeatAt,
    },
    data: { status: 'failed', finishedAt: new Date() },
  });
  if (abandoned.count === 0) throw new ActiveRunLeaseError(LEASE_RECHECK_MS);

  if (
    task?.assigneeId === run.agentId &&
    (task.status === 'assigned' || task.status === 'in_progress')
  ) {
    await moveTask(tx, scope, task.id, 'blocked', { authorType: 'system', authorId: 'system' });
  }
  // Devre disi birakilmis ajan idle'a cevrilmez (yalniz working -> idle).
  await setAgentStatus(tx, scope, run.agentId, 'idle', { onlyFrom: ['working'] });
  await appendEvent(tx, scope, {
    kind: 'run_abandoned',
    taskId: run.taskId,
    agentId: run.agentId,
    detail: ABANDONED_RUN_REASON,
  });
}

/**
 * Lease suresi dolmus `running` kosular: sahipsiz adaylari. Bos `heartbeatAt`
 * (lease oncesi satir) `startedAt` olarak okunur, `abandonStaleRun` ile ayni
 * kural. Aday olmak sonlandirmak demek degildir: kuyrukta etkin is varsa
 * kuyruk yeniden teslim eder ve `claimRun` sonlandirir (`abandonExpiredRuns`).
 */
export async function listExpiredRunningRuns(
  tx: Tx,
  scope: WorkspaceScope,
  limit = 50,
): Promise<AgentRunRecord[]> {
  requireRole(scope, 'member');
  const cutoff = new Date(Date.now() - AGENT_RUN_LEASE_MS);
  return tx.agentRun.findMany({
    where: {
      workspaceId: scope.workspaceId,
      status: 'running',
      OR: [{ heartbeatAt: { lte: cutoff } }, { heartbeatAt: null, startedAt: { lte: cutoff } }],
    },
    orderBy: { startedAt: 'asc' },
    take: limit,
  });
}

/**
 * Lease'i dolmus `running` kosulari, kuyrukta ETKIN ISI OLMAYANLAR icin
 * sonlandirir (`abandonStaleRun`). Gateway uzlastiricisi (periyodik) ve worker
 * acilis taramasi ayni fonksiyonu kullanir; boylece sonlandirma kurali tek yerdedir.
 *
 * Neden kuyruga bakilir: nihai sonuc yazimi dusen ya da Redis verisi sifirlanan
 * kosu icin hicbir is yeniden teslim edilmez ve kosu sonsuza dek `running`
 * kalirdi (`active_run` kilidi). Kuyrukta bekleyen/calisan/ertelenmis is varsa
 * ya baska worker kosuyor ya da kuyruk yeniden teslim edecek ve `claimRun` ayni
 * mantikla sonlandiracak: dokunulmaz. `hasLiveJob` kuyruga ozgu bilgiyi disaridan
 * alir; bu paket kuyruga bagimli degildir.
 *
 * Her kosu kendi transaction'inda sonlanir. Arada heartbeat gelirse
 * (`ActiveRunLeaseError`) kosu canlidir ve atlanir. Donus: sonlandirilan kosu id'leri.
 */
export async function abandonExpiredRuns(
  db: Pick<DbHandle, 'prisma'>,
  scope: WorkspaceScope,
  hasLiveJob: (runId: string) => Promise<boolean>,
): Promise<string[]> {
  const candidates = await withScope(db.prisma, scope, (tx) => listExpiredRunningRuns(tx, scope));
  const abandoned: string[] = [];
  for (const run of candidates) {
    if (await hasLiveJob(run.id)) continue;
    try {
      await withScope(db.prisma, scope, (tx) => abandonStaleRun(tx, scope, run));
      abandoned.push(run.id);
    } catch (error) {
      if (!(error instanceof ActiveRunLeaseError)) throw error;
    }
  }
  return abandoned;
}

/** Lease'i tazeler. `false`: kosu artik 'running' degil, sahiplik kaybedildi. */
export async function heartbeatRun(tx: Tx, scope: WorkspaceScope, runId: string): Promise<boolean> {
  requireRole(scope, 'member');
  const updated = await tx.agentRun.updateMany({
    where: { id: runId, workspaceId: scope.workspaceId, status: 'running' },
    data: { heartbeatAt: new Date() },
  });
  return updated.count === 1;
}

/**
 * Sonuc yazimindan once gorev satirini kilitler. Motor dakikalarca calisirken
 * kullanici gorevi baska duruma tasimis ya da baska ajana vermis olabilir;
 * `null` donerse sonuc panoya UYGULANMAZ (kosu yine kapatilir).
 */
export async function lockTaskForRunCompletion(
  tx: Tx,
  scope: WorkspaceScope,
  input: { taskId: string; agentId: string },
): Promise<TaskRecord | null> {
  requireRole(scope, 'member');
  const task = await findTaskForUpdate(tx, scope, input.taskId);
  if (!task || task.status !== 'in_progress' || task.assigneeId !== input.agentId) return null;
  return task;
}

const INT4_MIN = -(2 ** 31);
const INT4_MAX = 2 ** 31 - 1;
const UINT32_MAX = 2 ** 32 - 1;

/**
 * `AgentRun.exitCode` kolonu int4'tur. Windows surec cikis kodlari ise
 * isaretsiz 32 bittir: `wsl.exe` altyapi hatasi (dagitim bulunamadi) 4294967295,
 * NTSTATUS kodlari 3221225786 doner. Ham deger Postgres'te `22003` ile reddedilir,
 * tum sonuc islemi geri alinir ve zaten basarisiz olan kosunun basarisizligi bile
 * yazilamazdi. Isaretsiz 32 bit aralik bit deseni korunarak isaretliye cevrilir
 * (4294967295 -> -1); tam sayi olmayan ya da 32 bit disindaki deger `null` olur.
 * Ham deger kaybolmaz: motorlar onu `engine.log` icine `# exit:` satiriyla yazar.
 */
export function toStorableExitCode(code: number | null | undefined): number | null {
  if (code === null || code === undefined || !Number.isInteger(code)) return null;
  if (code >= INT4_MIN && code <= INT4_MAX) return code;
  if (code > INT4_MAX && code <= UINT32_MAX) return code | 0;
  return null;
}

export async function finishRun(
  tx: Tx,
  scope: WorkspaceScope,
  runId: string,
  result: {
    status: 'ok' | 'failed' | 'cancelled';
    exitCode?: number | null;
    externalSessionId?: string;
    costMicros?: number;
    inputTokens?: number;
    outputTokens?: number;
    logPath?: string;
  },
): Promise<void> {
  requireRole(scope, 'member');
  await tx.agentRun.updateMany({
    where: { id: runId, workspaceId: scope.workspaceId },
    data: {
      status: result.status,
      finishedAt: new Date(),
      exitCode: toStorableExitCode(result.exitCode),
      externalSessionId: result.externalSessionId ?? null,
      costMicros: result.costMicros ?? 0,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      logPath: result.logPath ?? null,
    },
  });
}

/** Ajan basina maliyet paneli ve gorev gecmisi bunu okur. */
export async function listRuns(
  tx: Tx,
  scope: WorkspaceScope,
  filter: { taskId?: string; agentId?: string; limit?: number } = {},
): Promise<AgentRunRecord[]> {
  return tx.agentRun.findMany({
    where: {
      workspaceId: scope.workspaceId,
      ...(filter.taskId ? { taskId: filter.taskId } : {}),
      ...(filter.agentId ? { agentId: filter.agentId } : {}),
    },
    orderBy: { startedAt: 'desc' },
    take: filter.limit ?? 50,
  });
}

/**
 * MOTOR KULLANIM OZETI — panelin "kullanim" bolumu bunu okur.
 *
 * NEDEN PENCERE: bu bir MUHASEBE kaydi degil, calisma ozetidir (kota/olcum ve
 * fatura isi `@smith/billing`in kapsamindadir, Faz 2). Son N kosu uzerinden
 * toplanir; panelin sorusu "hangi motor ne kadar is yapti, ne kadari basarisiz
 * oldu, ne kadar token/kota harcadi" ve bu soru icin pencere yeterlidir.
 *
 * Kapsam: `listRuns` gibi scoped transaction icinde cagrilir; RLS son soz.
 */
export const RUN_USAGE_WINDOW = 200;

export interface EngineUsage {
  engine: string;
  runs: number;
  ok: number;
  failed: number;
  cancelled: number;
  /** `queued`/`running` gibi henuz sonuclanmamis kosular. */
  pending: number;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
}

export interface RunUsageSummary {
  engines: EngineUsage[];
  totals: Omit<EngineUsage, 'engine'>;
  recent: AgentRunRecord[];
  /** Ozetin dayandigi kosu sayisi (pencere dolarsa `RUN_USAGE_WINDOW`). */
  sampled: number;
}

function emptyUsage(engine: string): EngineUsage {
  return {
    engine,
    runs: 0,
    ok: 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
    costMicros: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

export async function summarizeRunUsage(
  tx: Tx,
  scope: WorkspaceScope,
  window = RUN_USAGE_WINDOW,
): Promise<RunUsageSummary> {
  requireRole(scope, 'member');
  const recent = await listRuns(tx, scope, { limit: window });

  const byEngine = new Map<string, EngineUsage>();
  for (const run of recent) {
    let usage = byEngine.get(run.engine);
    if (!usage) {
      usage = emptyUsage(run.engine);
      byEngine.set(run.engine, usage);
    }
    usage.runs += 1;
    if (run.status === 'ok') usage.ok += 1;
    else if (run.status === 'failed') usage.failed += 1;
    else if (run.status === 'cancelled') usage.cancelled += 1;
    else usage.pending += 1;
    usage.costMicros += run.costMicros ?? 0;
    usage.inputTokens += run.inputTokens ?? 0;
    usage.outputTokens += run.outputTokens ?? 0;
  }

  const engines = [...byEngine.values()].sort((a, b) => b.runs - a.runs);
  // Totals per-engine satirlardan TURETILIR: ikinci bir sayac tutmak, iki
  // sayinin zamanla ayrisip panelde celiskili iki rakam gosterme riskidir.
  const totals = engines.reduce<Omit<EngineUsage, 'engine'>>(
    (acc, item) => ({
      runs: acc.runs + item.runs,
      ok: acc.ok + item.ok,
      failed: acc.failed + item.failed,
      cancelled: acc.cancelled + item.cancelled,
      pending: acc.pending + item.pending,
      costMicros: acc.costMicros + item.costMicros,
      inputTokens: acc.inputTokens + item.inputTokens,
      outputTokens: acc.outputTokens + item.outputTokens,
    }),
    {
      runs: 0,
      ok: 0,
      failed: 0,
      cancelled: 0,
      pending: 0,
      costMicros: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
  );

  return { engines, totals, recent, sampled: recent.length };
}
