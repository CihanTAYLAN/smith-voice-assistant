import type { Queue, SessionSummaryJob } from '@smith/queue';
import type { WorkspaceScope } from '@smith/tenancy';

/**
 * LIVE KONUSMA OZETI ZAMANLAYICISI.
 *
 * SORUN: Live konusmasi `Session` + `Message` olarak yazilir ama acikca
 * "kaydet" denmeyen hicbir sey uzun vadeli hafizaya (Memory) girmezdi;
 * `SESSION_SUMMARY` kuyrugunun tuketicisi (apps/worker) vardi, URETICISI
 * yoktu. Bu dosya o eksik halkayi kapatir: bosta kalan her oturum icin TEK
 * ozet isi.
 *
 * MEKANIZMA (debounce): her `conversation/append`, oturumun ozet isini
 * "bosta kalma penceresi + pay" kadar SONRAYA yeniden kurar. Kullanici
 * konustukca is ileri kayar; sessizlik pencereyi astiginda is calisir. Is,
 * oturuma ozel bir BullMQ deduplication kimligi tasir; bir oturum icin
 * kuyrukta en fazla BIR bekleyen is bulunur:
 * - `replace`: bekleyen is TEK atomik komutla yenilenir ve gecikme bastan
 *   baslar. Eski "once sil, sonra ekle" iki ayri komuttu; ikincisi basarisiz
 *   olursa is tamamen kaybolurdu.
 * - `keepLastIfActive`: is zaten kosuyorsa yeni istegin son hali tutulur ve
 *   kosu bitince tek bir devam isi olarak kuyruga girer (paralel kosu yok).
 *   Bu modda `ttl` yok sayilir; anahtar is bitene kadar yasar.
 *
 * NEDEN gateway'de zamanlayici (setInterval) degil: bekleyen is Redis'te
 * yasar, gateway yeniden baslasa da kaybolmaz; capraz-tenant tarama (RLS
 * altinda tum oturumlari gezmek) gerekmez.
 *
 * Pay (grace) gereksinimi: oturum siniri `findActiveSession` icindeki
 * `> idleMs` karsilastirmasidir. Is tam `idleMs` sonra kosarsa sinirda gelen
 * bir mesaj hem eski oturuma yazilip hem ozetin disinda kalabilirdi. Pay,
 * is kosmadan once oturumun gercekten kapandigini (sonraki mesajin YENI
 * oturuma gidecegini) garanti eder.
 */

/** Bosta kalan oturum, ozetlenmeye deger sayilmak icin en az bu kadar mesaj ister. */
export const SUMMARY_MIN_MESSAGES = 4;

/** Bosta kalma penceresinin ustune eklenen pay (ms); bkz. dosya basindaki "Pay" notu. */
export const SUMMARY_GRACE_MS = 60_000;

/** Deduplication kimligi oturuma ozeldir. */
export function summaryDeduplicationId(sessionId: string): string {
  return `session-summary-${sessionId}`;
}

/** Konusma rotasinin ihtiyac duydugu dar arayuz; test sahte uygulayabilir. */
export interface SessionSummaryScheduler {
  /** Oturumun ozet isini `delayMs` sonraya (yeniden) kurar. */
  schedule(input: { scope: WorkspaceScope; sessionId: string; delayMs: number }): Promise<void>;
}

export function createSessionSummaryScheduler(
  queue: Pick<Queue<SessionSummaryJob>, 'add'>,
): SessionSummaryScheduler {
  return {
    async schedule({ scope, sessionId, delayMs }) {
      await queue.add(
        'summarize',
        {
          workspaceId: scope.workspaceId,
          actorId: scope.actorId,
          sessionId,
          minMessages: SUMMARY_MIN_MESSAGES,
          reason: 'live-bosta-kaldi',
        },
        {
          delay: delayMs,
          deduplication: {
            id: summaryDeduplicationId(sessionId),
            replace: true,
            keepLastIfActive: true,
          },
        },
      );
    },
  };
}
