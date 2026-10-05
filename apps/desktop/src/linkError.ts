/**
 * Live baglanti hatasinin gorunurlugu: saf mantik (React yok, Tauri yok).
 *
 * KAYNAK: Rust cekirdegi (`audio/live.rs`) plansiz bir Live kapanisinda
 * `audio://tool` olayini `ad='live_baglanti'`, `durum='hata'`, `sebep=<metin>`
 * ile yayar. `LiveEvent` uzerinde exhaustive match yapan `lib.rs`i degistirmemek
 * icin yeni bir varyant yerine mevcut arac kanali kullanildi; bu yuzden olay,
 * gercek bir arac cagrisi DEGILDIR ve arac gostergelerine (acik arac listesi,
 * ret bildirimi) GIRMEMELIDIR.
 *
 * `sebep` bicimi (`hata_ozeti`): "<sinif ozeti>; kod=<kod> sebep=<sebep>; <N> sn
 * sonra yeniden denenecek". Sinif burada o ozetin on ekinden okunur; Rust
 * metni degisirse `linkError.test.ts` kirmizi olur.
 *
 * TEMIZLENME: hata, bir SONRAKI basarili baglantida (`audio://live-status`
 * connected=true) silinir. Zamanlayici KULLANILMAZ: yeniden deneme 5 dakikayi
 * bulabilir ve hata o sure boyunca gorunur kalmali.
 */

/** `audio://tool` olayinin hata kanali icin sozde arac adi (Rust: `LIVE_BAGLANTI`). */
export const LIVE_BAGLANTI = 'live_baglanti';
/** `durum` degeri (Rust: `TOOL_HATA`). */
export const LIVE_BAGLANTI_HATA = 'hata';

/**
 * Rust metninden turetilen siniflar + `olaylar`: bu sinif Rust'tan GELMEZ, masaustu
 * olay koprusu (Tauri `listen`) kurulamadiginda arayuz kendisi uretir
 * (`eventBridgeError`). Ikisi de ayni HUD yuzeyinde gorunur.
 */
export type LinkErrorKind = 'ag' | 'kota' | 'kalici' | 'bilinmiyor' | 'mikrofon' | 'olaylar';

export interface LinkError {
  kind: LinkErrorKind;
  /** Bir sonraki denemeye kalan sure (sn); metinde yoksa null (uydurulmaz). */
  retrySec: number | null;
  /** Rust'in verdigi ham metin; yalniz teshis icin, kullaniciya GOSTERILMEZ. */
  raw: string;
  /** Satir icin okunur metin (`linkErrorText`). */
  text: string;
  /** HUD'da tek satir; tam aciklama ve eylem text alanindadir. */
  summary: string;
  /** Dusunce baloncugu icin kisa metin (`linkErrorBubble`). */
  bubble: string;
}

/** `audio://tool` ham yuku; `sebep` yalniz bazi durumlarda dolu gelir. */
export interface LinkToolEvent {
  ad: string;
  durum: string;
  sebep?: string | null;
}

/** Bekleme suresi: kisa sureler saniye, uzunlar dakika (300 sn -> "5 dk"). */
function sure(sn: number): string {
  return sn >= 120 ? `${Math.round(sn / 60)} dk` : `${sn} sn`;
}

function kindOf(raw: string): LinkErrorKind {
  if (raw.startsWith('mikrofon kapisi')) return 'mikrofon';
  if (raw.startsWith('kota veya yuk')) return 'kota';
  if (raw.startsWith('kalici hata')) return 'kalici';
  if (raw.startsWith('ag hatasi')) return 'ag';
  return 'bilinmiyor';
}

function retryOf(raw: string): number | null {
  const m = /(\d+) sn sonra/.exec(raw);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

/** Kullaniciya ne oldugunu ve ne yapacagini anlatan metin. */
export function linkErrorText(e: Pick<LinkError, 'kind' | 'retrySec'>): string {
  const sonra = e.retrySec === null ? '' : ` ${sure(e.retrySec)} sonra yeniden denenecek.`;
  switch (e.kind) {
    case 'mikrofon':
      return 'Konuşma algılama arızalandı. Bu oturumda sürekli ses aktarımı kullanılıyor; sessizlik de gönderilir.';
    case 'ag':
      return `Gemini Live bağlantısı koptu (ağ hatası).${sonra} İnternet bağlantısını kontrol et.`;
    case 'kota':
      return `Gemini Live kota veya yük sınırına takıldı.${sonra} Sık tekrarlanırsa bir süre bekle ya da kullanımı azalt.`;
    case 'kalici':
      return `Gemini Live bağlantısı kurulamıyor (kalıcı hata). API anahtarını ve izinleri kontrol et.${sonra}`;
    case 'bilinmiyor':
      return `Gemini Live bağlantısı koptu.${sonra}`;
    case 'olaylar':
      return 'Masaüstü olayları dinlenemiyor; göstergeler eski kalabilir. Pencereyi yeniden aç.';
  }
}

/** Dusunce baloncugu icin kisa karsilik (birinci tekil). */
export function linkErrorBubble(e: Pick<LinkError, 'kind' | 'retrySec'>): string {
  const deneme =
    e.retrySec === null ? 'yeniden deniyorum…' : `${sure(e.retrySec)} sonra deniyorum…`;
  switch (e.kind) {
    case 'mikrofon':
      return 'konuşma algılama arızalandı, sürekli ses aktarımına geçtim';
    case 'ag':
    case 'bilinmiyor':
      return `bağlantı koptu, ${deneme}`;
    case 'kota':
      return `kota sınırı, ${deneme}`;
    case 'kalici':
      return 'bağlantı kurulamıyor, anahtar ve izinler kontrol edilmeli';
    case 'olaylar':
      return 'olayları dinleyemiyorum, pencereyi yeniden açmalısın';
  }
}

const SUMMARIES: Record<LinkErrorKind, string> = {
  mikrofon: 'Sürekli ses aktarımı',
  ag: 'Ağ hatası',
  kota: 'Kota / yük sınırı',
  kalici: 'Kalıcı hata',
  bilinmiyor: 'Bağlantı hatası',
  olaylar: 'Olay köprüsü hatası',
};

/** HUD'daki tek satir: sinif adi + varsa bekleme suresi. */
function linkErrorSummary(e: Pick<LinkError, 'kind' | 'retrySec'>): string {
  return e.retrySec === null
    ? SUMMARIES[e.kind]
    : `${SUMMARIES[e.kind]}: ${e.retrySec} sn sonra tekrar`;
}

function buildLinkError(kind: LinkErrorKind, retrySec: number | null, raw: string): LinkError {
  const parts = { kind, retrySec };
  return {
    ...parts,
    raw,
    text: linkErrorText(parts),
    summary: linkErrorSummary(parts),
    bubble: linkErrorBubble(parts),
  };
}

/** Rust'in `sebep` metnini yapisal hataya cevirir. Bos/bozuk metinde cokmez. */
export function parseLinkError(sebep: string | null | undefined): LinkError {
  const raw = sebep ?? '';
  return buildLinkError(kindOf(raw), retryOf(raw), raw);
}

/**
 * Masaustu olay koprusu (Tauri `listen`) kurulamadi: Live baglantisi hakkinda
 * bir sey bilinmiyor, gostergeler eski kalabilir. "Gemini Live koptu" DEMEYIZ:
 * sorun yerel ve baglanti hakkinda hicbir iddia tasimaz.
 */
export function eventBridgeError(): LinkError {
  return buildLinkError('olaylar', null, '');
}

/**
 * `audio://tool` olayi bir baglanti hatasiysa yapisal hatayi, degilse null
 * doner. `live_baglanti` ve `mikrofon_akisi` hata olaylari kabul edilir.
 */
export function linkErrorFromTool(ev: LinkToolEvent): LinkError | null {
  if ((ev.ad !== LIVE_BAGLANTI && ev.ad !== 'mikrofon_akisi') || ev.durum !== LIVE_BAGLANTI_HATA)
    return null;
  return parseLinkError(ev.sebep);
}

/**
 * `audio://live-status` sonrasi hata durumu: basarili baglanti (true) hatayi
 * temizler; oturum kapandi (false) hatayi KORUR (ayni nesne, React render
 * atlasin).
 */
export function linkErrorAfterStatus(prev: LinkError | null, connected: boolean): LinkError | null {
  return connected ? null : prev;
}
