/**
 * Mission Control veri katmani.
 *
 * KIMLIK BURADA YOK VE OLMAYACAK: pano hicbir token gormez. Her cagri Rust'taki
 * `mission_call` komutuna gider, token'i `GatewayClient` ekler ve yalniz
 * `/v1/mission/*` yollari gecer (kapi: src-tauri/src/mission.rs). Bu yuzden bu
 * dosyada base URL, parola veya workspace bilgisi bulunmaz.
 *
 * Hatalar YUTULMAZ, tasinir: `MissionResult` her cagride ya deger ya sebep
 * dondurur; pano sebebi ekranda gosterir. Bos ekran + sessiz hata en kotu
 * sonuctur (kullanici gateway'in kapali oldugunu bilemez).
 *
 * HAM HATA KULLANICIYA GITMEZ: `mission_call` hatasi YAPISAL gelir (`MissionHostError`:
 * kapali sinif + durum + Rust'ta maskelenmis mesaj). `toMissionError` sinifi okur ve
 * koda bagli sabit bir Turkce cumleye indirir; ham metin ayristirilmaz, mesaj ekrana
 * ve konsola yazilmaz (yalniz kod ve varsa HTTP durumu loglanir).
 */

export interface Agent {
  id: string;
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
  lastSeenAt: string | null;
}

export interface Task {
  id: string;
  title: string;
  detail: string | null;
  status: string;
  priority: number;
  assigneeId: string | null;
  deliverable: string | null;
  artifactPath: string | null;
  createdBy: string;
  dueAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string | null;
  agentId: string | null;
  kind: string;
  detail: string | null;
  createdAt: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorType: string;
  authorId: string;
  kind: string;
  body: string;
  mentions: string[];
  createdAt: string;
}

export interface AgentRun {
  id: string;
  status: string;
  device: string;
  engine: string;
  exitCode: number | null;
  costMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  logPath: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Board {
  agents: Agent[];
  tasks: Task[];
  events: TaskEvent[];
  /**
   * Durum → izin verilen gecisler. Sunucudan gelir; panoda KOPYASI TUTULMAZ.
   * Sebep: gecis tablosu `packages/mission/src/status.ts`'te tek kaynak ve
   * panonun onu tekrar etmesi zamanla ayrisirdi — kullaniciya gosterilen
   * dugme ile sunucunun kabul ettigi gecis birbirinden kayardi.
   */
  transitions: Record<string, string[]>;
}

export interface TaskDetail {
  task: Task;
  comments: TaskComment[];
  runs: AgentRun[];
}

/**
 * Bir veri yuzeyinin acik durumu. `loading` ilk yukleme (bos gibi GORUNMEZ),
 * `empty` gercekten bos, `stale` son bilinen veri ekranda ama yenileme basarisiz,
 * `error` elde hic veri yok ve istek basarisiz.
 */
export type SurfaceState = 'loading' | 'ready' | 'empty' | 'stale' | 'error';

export type MissionErrorCode =
  'not-found' | 'conflict' | 'validation' | 'unauthorized' | 'unavailable' | 'unknown';

export interface MissionFailure {
  error: string;
  code: MissionErrorCode;
}

export type MissionResult<T> = { ok: true; value: T } | ({ ok: false } & MissionFailure);

/** Mutasyon sonucu; `null` = baska bir mutasyon surdugu icin cagri atlandi (hata degildir). */
export type MutationResult<T> = MissionResult<T> | null;

/** Bilesenlerin eylem geri cagrilarinin donus tipi (sonucun degeri bilesenlerce kullanilmaz). */
export type MutationOutcome = Promise<MutationResult<unknown>>;

const NO_BRIDGE =
  'Mission Control bağlantısı yalnızca Smith masaüstü uygulamasında kullanılabilir.';

/**
 * `mission_call` hatasinin tel bicimi (src-tauri/src/mission.rs `MissionHatasi`).
 * `code` Rust'ta HTTP durumundan turetilir ve `MissionErrorCode` ile ayni degerleri
 * tasir; `status` gateway yanit verdiyse HTTP durumudur; `message` Rust'ta maskelenmis
 * kisa sebeptir (arayuz onu gostermez: kullaniciya `MESSAGES` cumlesi gider).
 */
export interface MissionHostError {
  code: MissionErrorCode;
  status: number | null;
  message: string;
}

/** Sinif basina kullaniciya giden SABIT, eyleme donuk cumle. */
const MESSAGES: Record<MissionErrorCode, string> = {
  'not-found': 'İstenen kayıt artık bulunamıyor.',
  conflict: 'Bu işlem mevcut görev veya ajan durumu nedeniyle tamamlanamadı.',
  validation: 'Girilen bilgiler geçerli değil. Alanları kontrol et.',
  unauthorized: 'Mission Control oturumu doğrulanamadı.',
  unavailable: 'Mission Control bağlantısı kurulamadı. Lütfen yeniden dene.',
  unknown: 'İşlem tamamlanamadı. Lütfen yeniden dene.',
};

const isMissionErrorCode = (value: unknown): value is MissionErrorCode =>
  typeof value === 'string' && Object.keys(MESSAGES).includes(value);

/**
 * Host hatasindan sinif ve durumu okur. Yapisal olmayan her sey (Tauri'nin kendi
 * hatasi, `Error`, metin) ve taninmayan sinif `unknown`dir: ham metin ASLA ayristirilmaz.
 */
function readHostError(error: unknown): Pick<MissionHostError, 'code' | 'status'> {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return { code: 'unknown', status: null };
  }
  return {
    code: isMissionErrorCode(error.code) ? error.code : 'unknown',
    status: 'status' in error && typeof error.status === 'number' ? error.status : null,
  };
}

/** Host hatasini kullaniciya tasimadan eyleme donuk bir hataya cevirir. */
export function toMissionError(error: unknown): MissionFailure {
  const { code } = readHostError(error);
  return { code, error: MESSAGES[code] };
}

function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * `conflict`: bu ucun 409'unun TEK anlamli sebebi biliniyorsa genel mesaj yerine
 * eyleme donuk metin (ornegin ayni slug, kosu gecmisi olan ajan).
 */
async function call<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  conflict?: string,
): Promise<MissionResult<T>> {
  if (!hasTauri()) return { ok: false, error: NO_BRIDGE, code: 'unavailable' };
  try {
    const core = await import('@tauri-apps/api/core');
    const value = await core.invoke<T>('mission_call', { method, path, body: body ?? null });
    return { ok: true, value };
  } catch (error) {
    const safe = toMissionError(error);
    const { status } = readHostError(error);
    console.error(
      `[MissionControl] mission_call başarısız (${safe.code}${status === null ? '' : `, HTTP ${status}`})`,
    );
    return {
      ok: false,
      ...(conflict && safe.code === 'conflict' ? { ...safe, error: conflict } : safe),
    };
  }
}

export const fetchBoard = (): Promise<MissionResult<Board>> =>
  call<Board>('GET', '/v1/mission/board');

export const fetchTask = (taskId: string): Promise<MissionResult<TaskDetail>> =>
  call<TaskDetail>('GET', `/v1/mission/tasks/${taskId}`);

export const createTask = (input: {
  title: string;
  detail?: string;
  priority?: number;
  assignee?: string;
}): Promise<MissionResult<{ task: Task; runId: string | null }>> =>
  call('POST', '/v1/mission/tasks', { ...input, via: 'ui' });

/**
 * MOTOR SECENEKLERI — atama aninda secilir (varsayilan ilk satir).
 *
 * KANONIK KAYNAK `packages/mission/src/engines.ts` (`AGENT_ENGINES`). Masaustu
 * o pakete bagimli OLAMAZ: mission paketi prisma/@smith/db cekiyor ve renderer
 * paketine girmemeli. Iki liste ayrisirsa gateway atamayi 400 ile reddeder —
 * yani drift SESSIZ olmaz; yanlis motorla kosu baslamaz.
 */
export const ENGINE_OPTIONS = [
  { value: 'claude-code', label: 'Claude Code (WSL)' },
  { value: 'codex', label: 'Codex (abonelik)' },
] as const;

export const assignTask = (
  taskId: string,
  assignee: string,
  engine?: string,
): Promise<MissionResult<{ task: Task; runId: string }>> =>
  call('POST', `/v1/mission/tasks/${taskId}/assign`, {
    assignee,
    ...(engine ? { engine } : {}),
  });

export const moveTask = (taskId: string, status: string): Promise<MissionResult<{ task: Task }>> =>
  call('POST', `/v1/mission/tasks/${taskId}/status`, { status });

export const commentTask = (
  taskId: string,
  body: string,
  kind?: string,
): Promise<MissionResult<{ comment: TaskComment }>> =>
  call('POST', `/v1/mission/tasks/${taskId}/comments`, kind ? { body, kind } : { body });

/**
 * ALAN SINIRLARI: gateway semasinin (`apps/gateway/src/routes/mission.ts`)
 * aynasi. Form bu sinirlari kendisi uygular; boylece kullanici sunucunun 400'u
 * yerine alanin yaninda uyari gorur. Drift sessiz degildir: sunucu daha siki
 * olursa istek 400 ile reddedilir ve katalogdaki "gecerli degil" mesaji cikar.
 */
export const FIELD_LIMITS = {
  taskTitleMin: 3,
  taskTitleMax: 200,
  commentMax: 4000,
  displayNameMax: 64,
  roleMax: 48,
  soulMin: 10,
} as const;

/** Ajan kimligi (slug): kucuk harfle baslar; kucuk harf, rakam, tire; 2-32 karakter. */
export const AGENT_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** Ajanin kostugu makine; kanonik kaynak gateway `agentDeviceSchema`. */
export const AGENT_DEVICES = ['wsl', 'windows', 'm2', 'server'] as const;

export interface NewAgent {
  slug: string;
  displayName: string;
  role: string;
  soul: string;
  device?: string;
  workRoots?: string[];
  allowedTools?: string[];
  parentSlug?: string;
}

export const createAgent = (input: NewAgent): Promise<MissionResult<{ agent: Agent }>> =>
  call(
    'POST',
    '/v1/mission/agents',
    input,
    'Bu ajan kimliği zaten kullanımda. Başka bir kimlik seç.',
  );

/**
 * Ajan profilini kismi gunceller (SOUL, rol, cihaz, kokler, durum).
 *
 * `status: 'offline'` = DEVRE DISI BIRAK. Kosu gecmisi olan bir ajanin
 * SILINMESI sunucuda reddedilir (maliyet kaydi da silinirdi); onun yerine bu
 * kullanilir.
 */
export const updateAgent = (
  agentId: string,
  patch: Partial<
    Pick<
      Agent,
      'displayName' | 'role' | 'soul' | 'device' | 'workRoots' | 'allowedTools' | 'status'
    >
  >,
): Promise<MissionResult<{ agent: Agent }>> =>
  call('PATCH', `/v1/mission/agents/${agentId}`, patch);

/**
 * Ajani siler. Sunucu KOSULLU: kosusu olan ajan icin 409 doner; pano kendi
 * kafasina gore "silindi" demez, sebebi (kosu gecmisi) ve cikis yolunu
 * (devre disi birakma) yazar.
 */
export const deleteAgent = (agentId: string): Promise<MissionResult<{ deleted: boolean }>> =>
  call(
    'DELETE',
    `/v1/mission/agents/${agentId}`,
    undefined,
    'Koşu geçmişi olan ajan silinemez. Bunun yerine devre dışı bırakabilirsin.',
  );
