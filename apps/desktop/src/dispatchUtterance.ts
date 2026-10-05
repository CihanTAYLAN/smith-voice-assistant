/**
 * Cihaz-ici konusma sevk dikisi (device dispatch seam) — Faz 2.
 *
 * Final transcript'i gateway'e goturen TEK yol burasidir. Metin mevcut `prompt`
 * frame'iyle gonderilir; @smith/protocol degismez.
 *
 * NIYET KAPISI: 2026-08-12'de M2'de olculdu ve **kural tabanli** olmaya karar
 * verildi (bkz. docs/decisions/0001-audio-perception.md "Niyet kapisi").
 * Ozet: cihaz-ici kucuk model (qwen2.5 0.5b/1.5b) gecikme bakimindan sorunsuzdu
 * (p95 114-155 ms, butce 300 ms) ama ayrimi guvenilir yapamadi — simetrik
 * kurulumda komutlarin ucte biri yutuluyordu (FN 8/24), asimetrik kurulumda ise
 * kapi hicbir sey yutmuyordu (tasarruf %5). Wake-word kurali ayni isi 0 ms'de,
 * modelsiz ve deterministik yapar.
 *
 * Kural: wake-word gecen konusma sevk edilir. Sevkten sonra kisa bir takip
 * penceresi boyunca (followUpMs) hitap tekrari istenmez — kullanicinin her
 * cumlede "Smith" demesi gerekmesin diye.
 */

/**
 * Varsayilan hitap kalibi. Global flag YOK (lastIndex tuzagi).
 *
 * FONETIK VARYANTLAR: whisper Turkce'de "Smith" ozel adini neredeyse hicbir
 * zaman dogru yazmaz — en sik "simit" (Turkce'de gercek bir kelime), ayrica
 * "smit / ismit / ismith / ismis" gibi cozer. STT ile guresmek yerine kapi bu
 * gerceklesmeleri kabul eder. Metin `normalizeForWake` ile aksan/nokta
 * sadelestirilip test edilir; boylece "İsmit", "sîmît" vb. de eslesir.
 */
export const DEFAULT_WAKE_WORD =
  /(?<![\p{L}\p{N}_])(smith|smitth?|smit|zmit|simit|simith|ismit|ismith|ismis|ismish|cemil|cemiyet|semt|schmidt|smid)(?![\p{L}\p{N}_])/iu;

/**
 * Wake-word eslestirmeden once metni sadelestirir: kucuk harf + birlesik
 * aksan/nokta isaretlerini (combining marks) atar. JS'te Turkce locale
 * lowercase tuzaklarina girmeden "İ/ı/î" gibi varyantlari tek forma indirger.
 */
export function normalizeForWake(s: string): string {
  return s.toLowerCase().replace(/ı/gu, 'i').normalize('NFKD').replace(/[̀-ͯ]/gu, '');
}

/** Sevkten sonra hitap istenmeyen takip penceresi. */
export const DEFAULT_FOLLOW_UP_MS = 15_000;

export interface UtteranceSink {
  /** Bagli oturum varsa metni gateway'e prompt olarak gonderir. */
  send: (text: string) => void;
  /** Oturum prompt kabul edecek durumda mi (status === 'ready'). */
  ready: boolean;
}

/** Sevk sonucu — cagiran taraf kullaniciya geri bildirim verebilsin diye. */
export type UtteranceOutcome =
  | 'sent'
  | 'dropped-empty'
  | 'dropped-not-ready'
  | 'dropped-no-wake-word'
  /** Sesli "sus" komutu alindi: sevk durduruldu (komut kendisi sevk edilmez). */
  | 'muted'
  /** Sesli "devam" komutu alindi: sevk yeniden acildi. */
  | 'unmuted'
  /** Susturulmus haldeyken gelen normal konusma. */
  | 'dropped-muted';

/**
 * SESLI SUS/DEVAM komutlari (kullanici mandasi 2026-08-12: "her benden bir sey
 * duyduktan sonra hemen cevap ver… ben sana sus diyene kadar").
 *
 * `alwaysOn` modunda hitap gerekmez; Smith duydugu her konusmaya cevap verir.
 * "Sus" denince dinlemeyi birakmaz ama SEVK ETMEYI durdurur (transcript akmaya
 * devam eder — kayit kesintisiz kalir, yalniz Smith konusmaz). "Devam"/"Smith"
 * yeniden acar. Bu iki kalip sevk edilmez: komuttur, istem degil.
 */
export const MUTE_PATTERN = /^\s*(sus|sus bakalim|sessiz ol|kes|dur|bekle)\s*[.!]?\s*$/iu;
export const UNMUTE_PATTERN = /^\s*(devam|devam et|konus|basla|smith|simit|dinle)\s*[.!]?\s*$/iu;

export interface UtteranceGateOptions {
  /** Hitap kalibi. Global (`g`) flag'li regex verilse bile guvenli calisir. */
  wakeWord?: RegExp;
  /** Takip penceresi (ms). 0 verilirse her konusmada hitap zorunlu olur. */
  followUpMs?: number;
  /**
   * true (varsayilan): hitap ZORUNLU DEGIL — duyulan her konusma sevk edilir.
   * Sesli "sus" ile gecici olarak susturulur, "devam" ile acilir.
   */
  alwaysOn?: boolean;
  /** Test edilebilirlik icin saat kaynagi. */
  now?: () => number;
}

export interface UtteranceGate {
  /** Final transcript'i sevk eder ve ne olduğunu bildirir. */
  dispatch: (sink: UtteranceSink, text: string) => UtteranceOutcome;
}

/**
 * Kapili sevk dikisini olusturur. Takip penceresi durumu tasidigi icin
 * ornek uzun omurlu tutulmalidir (App'te useRef).
 */
export function createUtteranceGate(options: UtteranceGateOptions = {}): UtteranceGate {
  const wakeWord = options.wakeWord ?? DEFAULT_WAKE_WORD;
  const followUpMs = options.followUpMs ?? DEFAULT_FOLLOW_UP_MS;
  const alwaysOn = options.alwaysOn ?? true;
  const now = options.now ?? (() => Date.now());
  let lastSentAt: number | null = null;
  let muted = false;

  return {
    dispatch(sink: UtteranceSink, text: string): UtteranceOutcome {
      const trimmed = text.trim();
      if (!trimmed) return 'dropped-empty';

      // Sesli kontrol komutlari baglanti durumundan BAGIMSIZ islenir: gateway
      // kapaliyken "sus" demek de calismali.
      const normalized = normalizeForWake(trimmed);
      if (MUTE_PATTERN.test(normalized)) {
        muted = true;
        return 'muted';
      }
      if (UNMUTE_PATTERN.test(normalized)) {
        muted = false;
        lastSentAt = now(); // takip penceresini ac: hemen konusulabilsin
        return 'unmuted';
      }

      if (!sink.ready) return 'dropped-not-ready'; // bagli degilken transcript birikmez
      if (muted) return 'dropped-muted';

      const at = now();
      if (!alwaysOn) {
        const inFollowUp = lastSentAt !== null && at - lastSentAt < followUpMs;
        // Global flag'li regex'te lastIndex tasar; her cagride sifirla.
        // Hitap, aksan/nokta sadelestirilmis metin uzerinde aranir (fonetik
        // varyant toleransi); sevk edilen metin yine orijinal `trimmed`'dir.
        wakeWord.lastIndex = 0;
        if (!wakeWord.test(normalized) && !inFollowUp) {
          return 'dropped-no-wake-word';
        }
      }

      lastSentAt = at;
      sink.send(trimmed);
      return 'sent';
    },
  };
}
