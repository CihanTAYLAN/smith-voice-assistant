/**
 * SMITH DASHBOARD veri katmani.
 *
 * KIMLIK BURADA YOK VE OLMAYACAK: panel token gormez. Dosya/grafik cagrilari
 * dogrudan Rust komutlarina gider; gateway cagrilari `mission_call`
 * kopruunden gecer (kapi: src-tauri/src/mission.rs — `/v1/mission/*` +
 * hafiza OKUMA uclari; yazma uclarina pano erisemez).
 *
 * HATALAR YUTULMAZ, TIPLI TASINIR: her cagri ya deger ya `code` + kisa Turkce
 * mesaj dondurur; panel mesaji ekranda gosterir. Ham Rust/gateway metni (yol,
 * komut adi, sunucu govdesi) kullaniciya HIC basilmaz; maskelenmis hali yalniz
 * Rust log'una (`[dashboard] ...`) ve konsola gider. Beyaz/bos ekran bu
 * katmanin yasak sonucudur.
 *
 * IKI HATA KAYNAGI: gateway cagrilari (`mission_call`) YAPISAL hata dondurur
 * (`HostError`: sinif + durum + maskeli mesaj) ve sinif oradan okunur; dosya
 * komutlari (`dashboard_fs_*`) Rust metni dondurur ve `PATTERNS` ile siniflanir.
 */

export type DashboardErrorCode =
  | 'unavailable'
  | 'offline'
  | 'denied'
  | 'conflict'
  | 'too-large'
  | 'binary'
  | 'not-found'
  | 'no-vault'
  | 'failed';

export type Result<T> =
  { ok: true; value: T } | { ok: false; error: string; code: DashboardErrorCode };

const MESSAGES: Record<DashboardErrorCode, string> = {
  unavailable: 'Masaüstü bağlantısı yok. Bu paneli Smith uygulamasında aç.',
  offline: 'Smith sunucusuna ulaşılamıyor. Sunucunun çalıştığını kontrol et.',
  denied: 'Bu işlem için erişim izni yok.',
  conflict: 'Dosya diskte değişmiş. Değişikliklerini koruyup dosyayı yeniden yükle.',
  'too-large': 'Dosya çok büyük (en fazla 512 KB).',
  binary: 'Bu dosya metin değil, açılamıyor.',
  'not-found': 'Dosya veya klasör bulunamadı.',
  'no-vault': 'Vault klasörü bulunamadı. SMITH_VAULT_DIR ayarını kontrol et.',
  failed: 'İşlem tamamlanamadı. Yeniden dene.',
};

/**
 * Dosya komutlarinin Rust metninden kod cikarir (ilk eslesen kazanir; sira
 * onemli). Metinler `dashboard.rs` kaynaklidir; degisirlerse sonuc `failed`e
 * duser ve mesaj yine guvenlidir. Gateway metni buraya GELMEZ (`HostError`).
 */
const PATTERNS: [RegExp, DashboardErrorCode][] = [
  [/diskte degisti/i, 'conflict'],
  [/cok buyuk/i, 'too-large'],
  [/ikili dosya/i, 'binary'],
  [/vault koku yok/i, 'no-vault'],
  [/dosya yok|bulunamad|not found/i, 'not-found'],
  [/izin verilmeyen|denied|forbidden|permission|`\.git`/i, 'denied'],
];

/**
 * `mission_call` hatasinin yapisal hali (src-tauri/src/mission.rs `MissionHatasi`):
 * kapali bir sinif, gateway yanit verdiyse HTTP durumu ve Rust'ta maskelenmis kisa
 * sebep. Sinif ham metin parcalanarak DEGIL buradan okunur.
 */
interface HostError {
  code: string;
  status: number | null;
  message: string;
}

/** `mission_call` sinifi -> panel kodu. Tablo disi sinif (`validation`, `unknown`...) `failed`. */
const HOST_CODES = new Map<string, DashboardErrorCode>([
  ['not-found', 'not-found'],
  ['conflict', 'conflict'],
  ['unauthorized', 'denied'],
  ['unavailable', 'offline'],
]);

function hostErrorOf(error: unknown): HostError | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  if (typeof error.code !== 'string') return null;
  return {
    code: error.code,
    status: 'status' in error && typeof error.status === 'number' ? error.status : null,
    message: 'message' in error && typeof error.message === 'string' ? error.message : '',
  };
}

const MASKS: [RegExp, string][] = [
  [/[A-Za-z]:\\[^\s"'`]*/g, '<yol>'],
  [/\/(?:Users|home)\/[^\s"'`]*/g, '<yol>'],
  [/\bBearer\s+[\w.~+/=-]{8,}/gi, 'Bearer <gizli>'],
  [/\b(token|secret|password|passwd|key|authorization)\b\s*[=:]\s*\S+/gi, '$1=<gizli>'],
  [/\b[\w-]{32,}\b/g, '<gizli>'],
];

const LOG_COMMAND = 'dashboard_log';
const MAX_LOG_LENGTH = 400;

function messageOf(error: unknown): string {
  const host = hostErrorOf(error);
  if (host) return `${host.code} ${host.status ?? '-'} ${host.message}`;
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

function maskDetail(error: unknown): string {
  const raw = error instanceof Error ? (error.stack ?? error.message) : messageOf(error);
  return MASKS.reduce((text, [pattern, mask]) => text.replace(pattern, mask), raw).slice(
    0,
    MAX_LOG_LENGTH,
  );
}

function failure(code: DashboardErrorCode): Result<never> {
  return { ok: false, code, error: MESSAGES[code] };
}

/**
 * Teknik hata kaydi: kod kullaniciya, MASKELI ayrinti Rust log'una ve konsola
 * gider. Yol, token ve sunucu govdesi hicbir zaman oldugu gibi yazilmaz.
 * Log komutunun kendi hatasi tekrar loglanmaz (sonsuz dongu olmasin).
 */
export function reportDashboardError(operation: string, error: unknown): DashboardErrorCode {
  const host = hostErrorOf(error);
  const text = messageOf(error);
  const code = host
    ? (HOST_CODES.get(host.code) ?? 'failed')
    : (PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? 'failed');
  console.error('[dashboard]', { operation, code });
  if (operation !== LOG_COMMAND) dashboardLog(`${operation} ${code} ${maskDetail(error)}`);
  return code;
}

export function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
  if (!hasTauri()) return failure('unavailable');
  try {
    const core = await import('@tauri-apps/api/core');
    return { ok: true, value: await core.invoke<T>(cmd, args) };
  } catch (error) {
    return failure(reportDashboardError(cmd, error));
  }
}

/** Teshis satiri: Rust log'una duser (`[dashboard] ...` → desktop.err.log). */
export function dashboardLog(message: string): void {
  void invoke(LOG_COMMAND, { message });
}

/** Panel cizildi sinyali — Rust'taki boot watchdog'unu besler (beyaz ekran nobeti). */
export function dashboardReady(): void {
  void invoke('dashboard_ready');
}

/** Pencere komutu (surukleme/kapatma). Sonuc doner; cagiran hatayi gosterebilsin. */
export function windowCmd(cmd: string): Promise<Result<unknown>> {
  return invoke(cmd);
}

// --- dosya yoneticisi -------------------------------------------------------

export interface FsRoot {
  label: string;
  path: string;
}

export interface FsEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size: number;
  mtimeMs: number;
}

export interface FileContent {
  content: string;
  mtimeMs: number;
  size: number;
}

export interface FsWriteResult {
  mtimeMs: number;
  size: number;
}

/** Giris sinirini asan bir dizinin listesi kesilmistir; toplam ve limit buradan okunur. */
export interface FsTruncation {
  /** Dizindeki toplam giris sayisi (gosterilmeyenler dahil). */
  total: number;
  /** Listenin tasidigi en cok giris. */
  limit: number;
}

/**
 * Dizin listesi: duz bir `FsEntry` dizisi gibi okunur (dosya agaci onu oyle tuketir);
 * dizin giris sinirini astiysa liste KESILMISTIR ve `truncation` bunu soyler. Eskiden
 * Rust listeyi sessizce kesiyor, panel eksik listeyi tam saniyordu.
 */
export type FsEntryList = FsEntry[] & { truncation?: FsTruncation };

/** `dashboard_fs_list` yaniti (src-tauri/src/dashboard.rs `FsListing`). */
interface FsListing extends FsTruncation {
  entries: FsEntry[];
  truncated: boolean;
}

export const fsRoots = () => invoke<FsRoot[]>('dashboard_fs_roots');

export async function fsList(path: string): Promise<Result<FsEntryList>> {
  const result = await invoke<FsListing>('dashboard_fs_list', { path });
  if (!result.ok) return result;
  const { entries, truncated, total, limit } = result.value;
  return {
    ok: true,
    value: truncated ? Object.assign(entries, { truncation: { total, limit } }) : entries,
  };
}

export const fsRead = (path: string) => invoke<FileContent>('dashboard_fs_read', { path });
export const fsWrite = (path: string, content: string, expectedMtimeMs: number | null) =>
  invoke<FsWriteResult>('dashboard_fs_write', { path, content, expectedMtimeMs });

// --- bilgi grafigi ----------------------------------------------------------

export interface VaultNode {
  id: string;
  label: string;
  vault: string;
  size: number;
}

export interface VaultEdge {
  from: string;
  to: string;
}

export interface VaultGraph {
  root: string;
  nodes: VaultNode[];
  edges: VaultEdge[];
}

export const vaultGraph = () => invoke<VaultGraph>('dashboard_vault_graph');

// --- hafiza (gateway kopru, SALT OKUMA) -------------------------------------

export interface MemoryRecord {
  id: string;
  content: string;
  sourceType: string;
  sourceId: string;
  sensitivity: string;
  createdAt: string;
}

export interface MemoryList {
  records: MemoryRecord[];
}

async function missionCall<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  return invoke<T>('mission_call', { method, path, body: body ?? null });
}

const MEMORY_LIMIT = 300;
const MEMORY_FRESH_MS = 30_000;

let memoryCache: { value: MemoryList; at: number } | null = null;
let memoryFlight: Promise<Result<MemoryList>> | null = null;

/**
 * Son 300 hafiza kaydi. Bilgi grafigi ile Hafiza bolumu AYNI okumayi paylasir:
 * eszamanli cagrilar tek istege iner, taze (30 sn) kopya yeniden kullanilir.
 * `refresh` kopyayi atlar; basarisiz okuma kopyayi da dusurur.
 */
export function memoryList(refresh = false): Promise<Result<MemoryList>> {
  if (memoryFlight) return memoryFlight;
  if (!refresh && memoryCache && Date.now() - memoryCache.at < MEMORY_FRESH_MS) {
    return Promise.resolve({ ok: true, value: memoryCache.value });
  }
  memoryFlight = missionCall<MemoryList>('GET', `/v1/tools/memory/list?limit=${MEMORY_LIMIT}`)
    .then((result) => {
      memoryCache = result.ok ? { value: result.value, at: Date.now() } : null;
      return result;
    })
    .finally(() => {
      memoryFlight = null;
    });
  return memoryFlight;
}

export interface MemoryMatch {
  content: string;
  similarity: number;
}

export const memorySearch = (query: string, limit = 20) =>
  missionCall<{ results: MemoryMatch[] }>('POST', '/v1/tools/memory/search', { query, limit });

export type MemoryGapStatus = 'open' | 'asked' | 'answered' | 'dismissed';

export interface MemoryGap {
  id: string;
  question: string;
  reason: string;
  status: MemoryGapStatus;
  createdAt: string;
  askedAt: string | null;
}

export interface MemoryGapList {
  gaps: MemoryGap[];
}

export const memoryGaps = () => missionCall<MemoryGapList>('GET', '/v1/memory/gaps?status=open');

export const answerMemoryGap = (id: string, answer: string) =>
  missionCall<{ ok: true; status: 'answered'; memoryId: string }>(
    'POST',
    `/v1/memory/gaps/${encodeURIComponent(id)}/answer`,
    { answer },
  );

export const dismissMemoryGap = (id: string) =>
  missionCall<{ ok: true; status: 'dismissed' }>(
    'POST',
    `/v1/memory/gaps/${encodeURIComponent(id)}/dismiss`,
    {},
  );

// --- motor nobeti + kullanim (kontrol bolumu) -------------------------------

/**
 * Motor nobeti Rust'tan gelir (CLI + kimlik probu), gateway'den DEGIL: "bu
 * makinede hangi is gucu hazir" sorusu cihazin kendi ozelligidir ve cevabi
 * sunucuda yok.
 */
export interface EngineStatus {
  id: string;
  label: string;
  host: string;
  available: boolean;
  version: string | null;
  identity: string | null;
  note: string | null;
}

export const engines = () => invoke<EngineStatus[]>('dashboard_engines');

/** `GET /v1/mission/usage` cevabi (`packages/mission` → `RunUsageSummary`). */
export interface EngineUsage {
  engine: string;
  runs: number;
  ok: number;
  failed: number;
  cancelled: number;
  pending: number;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
}

export interface RunUsageSummary {
  engines: EngineUsage[];
  totals: Omit<EngineUsage, 'engine'>;
  sampled: number;
}

export const runUsage = () => missionCall<RunUsageSummary>('GET', '/v1/mission/usage');

/** `GET /v1/mission/summary` cevabi (panonun sayilari, sesli brifingle ayni). */
export interface MissionSummary {
  counts: Record<string, number>;
  review: { id: string; title: string; agent: string | null }[];
  blocked: { id: string; title: string }[];
  working: { slug: string; displayName: string }[];
  squadSize: number;
}

export const missionSummary = () => missionCall<MissionSummary>('GET', '/v1/mission/summary');
