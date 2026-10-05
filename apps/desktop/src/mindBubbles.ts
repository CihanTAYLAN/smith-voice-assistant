import { linkErrorFromTool } from './linkError.js';
import { parseScreenToolEvent } from './screenStream.js';
import { MEMORY_WRITE_TOOLS, toolLabel } from './useLiveVoice.js';

/**
 * "Smith'in su an aklinda ne var" — pet'in USTUNDEKI dusunce baloncugunun SAF
 * mantigi. React yok, Tauri yok: olay -> metin esleme ve kabarcik listesi.
 *
 * EN KRITIK KURAL — UYDURMA YOK
 * Gemini Live bir dusunce izi (reasoning/thinking blogu) DONDURMEZ. Yani
 * Smith'in "icinden gecirdigi ama soylemedigi" bir metin ELDE YOKTUR. Bu
 * yuzden baloncuk bir LLM'e URETTIRILMEZ ve "dusunuyormus gibi" cumle
 * YAZILMAZ. Gosterilen her satir, GERCEKTEN OLMUS bir olayin birebir
 * karsiligidir:
 *
 *   `audio://tool`        -> hangi arac basladi / bitti / reddedildi; ayrica iki
 *                            sozde-arac: `live_baglanti` hatasi ve
 *                            `ekran_akisi_durumu` degisimi
 *   `audio://speaker`     -> ses izi kapisinin karari (owner/foreign/unknown)
 *   `audio://screen`      -> ekran paylasimi acildi/kapandi
 *   `audio://live-status` -> Live oturumu kuruldu/koptu
 *
 * Olay yoksa kabarcik da yoktur. Bir alan gelmediyse (bos/eksik payload) satir
 * URETILMEZ; tahmin edilmez.
 *
 * ETIKET KAYNAGI: bilinen araclarin birinci-tekil karsiligi asagidaki
 * `TOOL_START` tablosundadir. Tabloda OLMAYAN bir arac icin `useLiveVoice`
 * icindeki `toolLabel` yedegi kullanilir (yeni arac eklenince UI cokmez,
 * teknik adi ya da mevcut etiketi gorunur) — tablo burada TEKRAR YAZILMAZ.
 */

/** Kabarcigin hangi olaydan dogdugu; yalniz stil ve teshis icin. */
export type MindSource = 'tool' | 'memory' | 'gate' | 'speaker' | 'screen' | 'link';

/** `audio://tool` ham yuku. Alanlar OPSIYONEL: bu veri wire'dan gelir. */
export interface ToolPayload {
  ad?: string;
  durum?: string;
  sebep?: string | null;
}

/** `audio://speaker` ham yuku. `karar`: "owner" | "unknown" | "foreign". */
export interface SpeakerPayload {
  karar?: string;
}

/** `audio://screen` ham yuku. */
export interface ScreenPayload {
  aktif?: boolean;
  aralikMs?: number;
}

/** `audio://live-status` ham yuku. */
export interface LinkPayload {
  connected?: boolean;
}

/**
 * Baloncuga girebilecek TEK girdi turu: dort gercek Rust olayindan biri.
 * Baska bir kaynak yok — bu birlesim, "uydurma yok" kuralinin tip seviyesindeki
 * karsiligidir.
 */
export type MindEvent =
  | { kind: 'tool'; payload: ToolPayload }
  | { kind: 'speaker'; payload: SpeakerPayload }
  | { kind: 'screen'; payload: ScreenPayload }
  | { kind: 'link'; payload: LinkPayload };

/** Bir olayin okunur karsiligi. */
export interface MindThought {
  text: string;
  source: MindSource;
}

export interface MindBubble extends MindThought {
  id: string;
  /** Olayin geldigi an (ms). Sonme bunun uzerinden hesaplanir. */
  at: number;
}

export interface PushOptions {
  /** Olayin geldigi an. Disaridan verilir: fonksiyon saf kalsin. */
  now: number;
  /** Yeni kabarcigin kimligi. Disaridan verilir (StrictMode cift updater). */
  id: string;
  ttlMs?: number;
  max?: number;
}

/**
 * Bir kabarcigin ekranda kalma suresi. Kisa tutuluyor: bu bir gecmis arsivi
 * degil, "su an ne oluyor" penceresi. Arac gostergesinin tavani (30 sn) ile
 * karistirilmamali — orasi "calisiyor mu", burasi "az once ne oldu".
 */
export const MIND_TTL_MS = 6_000;
/**
 * Ayni anda gorunen kabarcik tavani. Uc satirdan fazlasi pet'in ustunu kaplar
 * ve seffaf pencerede masaustunu kirletir.
 */
export const MAX_MIND_BUBBLES = 3;
/** Sonmus kabarciklari suepurme araligi (yalniz kabarcik varken calisir). */
export const MIND_SWEEP_MS = 250;

/**
 * Arac BASLADIGINDA gosterilen birinci-tekil karsilik. Kaynak arac adlari Rust
 * arac tablosudur (`audio/live/tools.rs`); tablo ile bu liste ayrisirsa
 * `toolTable.test.ts` kirmizi olur.
 */
export const TOOL_START: Record<string, string> = {
  hafizada_ara: 'hafızama bakıyorum…',
  hafizaya_kaydet_ACIK_TALEP_ILE: 'bunu aklıma yazıyorum…',
  hafizaya_kaydet: 'bunu aklıma yazıyorum…',
  ekrani_net_gor: 'ekrana yakından bakıyorum…',
  derin_dusun: 'bunu derinlemesine düşünüyorum…',
  internette_ara: 'internete bakıyorum…',
  web_sayfa_oku: 'sayfayı okuyorum…',
  terminal_calistir: 'komutu çalıştırıyorum…',
  dosya_ara: 'dosya arıyorum…',
  dosya_oku: 'dosyayı okuyorum…',
  sistem_durumu: 'sistemi yokluyorum…',
  uygulama_ac: 'uygulamayı açıyorum…',
  ses_kontrol: 'sesi ayarlıyorum…',
  acik_uygulamalar: 'açık pencerelere bakıyorum…',
  ajan_oturumlari: 'kod oturumlarına bakıyorum…',
  kod_gorevi_ver: 'kendi kodumu düzenliyorum…',
  dinleme_modu: 'dinleme modunu ayarlıyorum…',
  ekran_akisi: 'ekran akışını ayarlıyorum…',
  kod_gorevi_durum: 'kod görevinin durumuna bakıyorum…',
  gorev_ver: 'panoya görev yazıyorum…',
  pano_durumu: 'ekip panosuna bakıyorum…',
  gorev_durum: 'görev durumunu değiştiriyorum…',
  yorum_ekle: 'göreve not yazıyorum…',
  ekip_listesi: 'ekibe bakıyorum…',
  arka_plan_sonuc: 'arka plan sonucunu okuyorum…',
  arka_plan_iptal: 'arka plan işini durduruyorum…',
  hatirlatma_kur: 'hatırlatma kuruyorum…',
  hatirlatmalari_listele: 'hatırlatmalara bakıyorum…',
  hatirlatma_iptal: 'hatırlatmayı iptal ediyorum…',
  profil_kaydet: 'profile yazıyorum…',
  profil_sil: 'profilden siliyorum…',
  hafiza_sorusu_cevapla: 'hafıza cevabını yazıyorum…',
  hafiza_sorusu_gec: 'hafıza sorusunu geçiyorum…',
};

/**
 * Kalici yazma araclarinin BITIS karsiligi. Tabloda olmayan hafiza-yazma araci
 * (`hafizaya_kaydet`) varsayilani kullanir; iptal ve silme "yazdim" demez.
 */
const MEMORY_DONE_DEFAULT = 'bunu aklıma yazdım';
const MEMORY_DONE: Record<string, string> = {
  hatirlatma_kur: 'hatırlatmayı kurdum',
  hatirlatma_iptal: 'hatırlatmayı iptal ettim',
  profil_kaydet: 'profilime yazdım',
  profil_sil: 'profilden sildim',
  hafiza_sorusu_cevapla: 'cevabı hafızama yazdım',
  hafiza_sorusu_gec: 'hafıza sorusunu geçtim',
};

/**
 * Olay -> okunur satir. Karsiligi olmayan olay `null` doner (kabarcik yok).
 *
 * `bitti` durumu YALNIZ hafizaya yazma araclarinda satir uretir: diger
 * araclarda bitis, baslangicin tekrarindan baska bir sey soylemez ve kabarcik
 * trafigini iki katina cikarirdi. Hafizada ise bitis GERCEKTEN yeni bir bilgi
 * tasir — kalici bir sey degisti.
 */
export function mindTextFor(event: MindEvent): MindThought | null {
  switch (event.kind) {
    case 'tool':
      return toolThought(event.payload);
    case 'speaker':
      return speakerThought(event.payload);
    case 'screen':
      return screenThought(event.payload);
    case 'link':
      return linkThought(event.payload);
  }
}

function toolThought(p: ToolPayload): MindThought | null {
  const ad = p.ad ?? '';
  if (ad === '') return null;

  // Sozde-araclar (gercek arac degil, Rust'ta `LiveEvent` varyanti yok):
  // plansiz baglanti hatasi ve ekran akisi degisimi. Hata metni sinifa gore
  // kullaniciya ne yapacagini soyler (`linkError.ts`).
  const linkError = linkErrorFromTool({ ad, durum: p.durum ?? '', sebep: p.sebep ?? null });
  if (linkError !== null) return { text: linkError.bubble, source: 'link' };
  const akis = parseScreenToolEvent({ ad, durum: p.durum ?? '' });
  if (akis !== null) return screenThought({ aktif: akis });
  if (ad === 'dinleme_modu_durumu' || ad === 'live_baglanti' || ad === 'ekran_akisi_durumu')
    return null;

  if (p.durum === 'basladi') {
    return { text: TOOL_START[ad] ?? toolLabel(ad), source: 'tool' };
  }
  if (p.durum === 'reddedildi') {
    // Ret ariza degil politika; kullanicinin bilmesi gereken tek sey islemin
    // YAPILMADIGI. Teknik gerekce (`sebep`) baloncuga girmez — panodaki
    // bildirime gider.
    return {
      text: MEMORY_WRITE_TOOLS.has(ad)
        ? 'aklıma yazamadım, ses izi doğrulanmadı'
        : 'bunu yapamam, ses izi doğrulanmadı',
      source: 'gate',
    };
  }
  if (p.durum === 'bitti' && MEMORY_WRITE_TOOLS.has(ad)) {
    return { text: MEMORY_DONE[ad] ?? MEMORY_DONE_DEFAULT, source: 'memory' };
  }
  // Bilinmeyen durum (Rust yeni bir asama eklerse) sessizce yok sayilir.
  return null;
}

function speakerThought(p: SpeakerPayload): MindThought | null {
  switch (p.karar) {
    case 'owner':
      return { text: 'sesini tanıdım', source: 'speaker' };
    case 'foreign':
      return { text: 'bu ses sana ait değil', source: 'speaker' };
    case 'unknown':
      return { text: 'sesini çıkaramadım', source: 'speaker' };
    default:
      return null;
  }
}

function screenThought(p: ScreenPayload): MindThought | null {
  if (p.aktif === true) return { text: 'ekranını görüyorum', source: 'screen' };
  if (p.aktif === false) return { text: 'ekrana artık bakmıyorum', source: 'screen' };
  return null;
}

function linkThought(p: LinkPayload): MindThought | null {
  if (p.connected === true) return { text: 'bağlantım kuruldu', source: 'link' };
  if (p.connected === false) return { text: 'bağlantım koptu, dönüyorum…', source: 'link' };
  return null;
}

/**
 * Sonmus kabarciklari atar. Hicbir sey sonmediyse AYNI DIZIYI dondurur;
 * React'in gereksiz render'i boylece atlanir.
 */
export function pruneMindBubbles(
  bubbles: MindBubble[],
  now: number,
  ttlMs: number = MIND_TTL_MS,
): MindBubble[] {
  const live = bubbles.filter((b) => now - b.at < ttlMs);
  return live.length === bubbles.length ? bubbles : live;
}

/**
 * Olayi listeye isler. SAF fonksiyon: `now` ve `id` disaridan gelir (aynen
 * `useLiveVoice.appendChunk` gibi — StrictMode updater'i iki kez cagirir,
 * sayaci burada artirsak ayni kabarcik iki farkli kimlik alirdi).
 *
 * TEKRAR BASTIRMA: ayni metin ZATEN ekrandaysa yeni kabarcik ACILMAZ, mevcut
 * olanin zamani tazelenir ("hala oluyor"). Tazeleme YERINDE yapilir, kabarcik
 * listenin sonuna TASINMAZ: sira ilk gorunme sirasidir ve satirlarin gozunun
 * onunde yer degistirmesi okumayi bozardi.
 *
 * Karsilastirma listedeki TUM canli kabarciklara bakar, yalniz sonuncuya
 * degil: araya baska bir olay girdiginde ayni cumleden iki tane gorunmesi
 * tekrar bastirmanin basarisizligi olurdu.
 */
export function pushMindBubble(
  bubbles: MindBubble[],
  event: MindEvent,
  o: PushOptions,
): MindBubble[] {
  const thought = mindTextFor(event);
  if (!thought) return bubbles;

  const ttlMs = o.ttlMs ?? MIND_TTL_MS;
  const max = o.max ?? MAX_MIND_BUBBLES;
  const live = pruneMindBubbles(bubbles, o.now, ttlMs);

  const hitIndex = live.findIndex((b) => b.text === thought.text);
  const hit = hitIndex >= 0 ? live[hitIndex] : undefined;
  if (hit) {
    const next = [...live];
    next[hitIndex] = { ...hit, at: o.now };
    return next;
  }

  const next = [...live, { id: o.id, text: thought.text, source: thought.source, at: o.now }];
  return next.length > max ? next.slice(next.length - max) : next;
}
