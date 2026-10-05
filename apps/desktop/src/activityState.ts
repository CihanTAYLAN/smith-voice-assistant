import { type ActiveTool, type LiveLink } from './useLiveVoice.js';

/**
 * Smith'in BASKIN faaliyeti — panel aksani, yuz gorev modu ve ortam etiketinin
 * ORTAK oncelik sirasidir (UI_IMPLEMENTATION_PLAN.md §5.3).
 *
 * TEK KAYNAK: bu dosya oncelik sirasini TEK yerde tutar; hudState.ts'teki
 * `sessionState()` (Turkce cumle) ve `toFaceState()` (Face.tsx pozu) ayni
 * `resolveActivityState()` cagrisindan turer — iki yer birbirinden BAGIMSIZ
 * sirlama yapip sessizce ayrisamaz.
 *
 * UYDURMA YOK: her deger GERCEK bir olaydan turer. "reading/researching/acting"
 * ayrimi yeni bir sinyal DEGIL — zaten var olan arac ADININ (`ActiveTool.name`)
 * kategorize edilmis hali (`MEMORY_WRITE_TOOLS`in yaptigi ayrimin ayni turden
 * genisletilmis hali). Sistemde gercekte OLMAYAN bir sinyal (duygu durumu,
 * "waiting for confirmation" gibi UI'a hic bildirilmeyen bir olay) burada YOK.
 */
export type ActivityState =
  | 'error'
  | 'muted'
  | 'speaking'
  | 'acting'
  | 'researching'
  | 'reading'
  | 'thinking'
  | 'listening'
  | 'waiting'
  | 'idle';

export interface ActivityInput {
  micError: string | null;
  hostReady: boolean;
  capturing: boolean;
  link: LiveLink;
  /** `resolveActivityState` bunu OKUMAZ (yukaridaki not); hudState.ts'teki metin
      detayi ("ses hatti yanit vermiyor") icin cagiran tarafta kalir. */
  linkStalled: boolean;
  assistantSpeaking: boolean;
  thinking: boolean;
  tools: ActiveTool[];
}

/**
 * Arac ADI -> kaba faaliyet kategorisi. Kaynak gercegi arac adlarinin
 * KENDISI (Rust arac tablosu `audio/live/tools.rs`); burada yeni bir veri
 * UYDURULMUYOR, var olan ad sadece kumeleniyor. Tablo ile bu liste ayrisirsa
 * `toolTable.test.ts` kirmizi olur: yeni arac sinifsiz kalmaz.
 *
 * Listede olmayan arac icin calisma zamani varsayilani `'acting'`: "bir sey
 * yapiyor" en guvenli genel iddiadir — "okuyor"/"araştırıyor" gibi daha
 * spesifik bir iddia, dogrulanmadan atilmaz.
 */
export const TOOL_CATEGORY: Record<
  string,
  Extract<ActivityState, 'reading' | 'researching' | 'acting' | 'thinking'>
> = {
  hafizada_ara: 'researching',
  internette_ara: 'researching',
  dosya_ara: 'researching',
  ajan_oturumlari: 'researching',
  web_sayfa_oku: 'reading',
  dosya_oku: 'reading',
  ekrani_net_gor: 'reading',
  acik_uygulamalar: 'reading',
  sistem_durumu: 'reading',
  pano_durumu: 'reading',
  ekip_listesi: 'reading',
  derin_dusun: 'thinking',
  terminal_calistir: 'acting',
  uygulama_ac: 'acting',
  ses_kontrol: 'acting',
  kod_gorevi_ver: 'acting',
  kod_gorevi_durum: 'reading',
  hafizaya_kaydet: 'acting',
  hafizaya_kaydet_ACIK_TALEP_ILE: 'acting',
  gorev_ver: 'acting',
  gorev_durum: 'acting',
  yorum_ekle: 'acting',
  ekran_akisi: 'acting',
  dinleme_modu: 'acting',
  arka_plan_sonuc: 'reading',
  arka_plan_iptal: 'acting',
  hatirlatma_kur: 'acting',
  hatirlatmalari_listele: 'reading',
  hatirlatma_iptal: 'acting',
  profil_kaydet: 'acting',
  profil_sil: 'acting',
  hafiza_sorusu_cevapla: 'acting',
  hafiza_sorusu_gec: 'acting',
};

function toolActivity(tools: ActiveTool[]): ActivityState | null {
  const first = tools[0];
  if (!first) return null;
  return TOOL_CATEGORY[first.name] ?? 'acting';
}

/**
 * Baskin faaliyeti coz. Oncelik `hudState.ts`teki `sessionState()` ile
 * BIREBIR ayni sirayi izler (bu fonksiyon o mantigin yerini alir, sirasini
 * DEGISTIRMEZ): host yok > susturuldu > acik arac > Smith konusuyor >
 * isliyor > hat kapandi > dinliyor > baglaniyor. `micError` bu siranin ONUNE
 * eklendi (`noticeFor` ile ayni oncelik: cihaz arizasi en acil, en spesifik
 * olculen olgudur).
 *
 * `linkStalled` BILINCLI `error` DEGIL: `noticeFor()`teki karsiligi `info`
 * tonundadir (fault degil) cunku 12 saniyedir yanit gelmemesi KESIN bir ariza
 * kaniti degildir — panel bunu kirmizi ile "kesin bozuk" gibi gostermek,
 * kod tabaninin "UYDURMA YOK / asiri iddia yok" ilkesini panel-aksani
 * seviyesinde ihlal ederdi. Belirsiz kalan hat `waiting`e duser (asagidaki
 * varsayilan).
 */
export function resolveActivityState(v: ActivityInput): ActivityState {
  if (v.micError) return 'error';
  if (!v.hostReady) return 'idle';
  if (!v.capturing) return 'muted';
  const tool = toolActivity(v.tools);
  if (tool) return tool;
  if (v.assistantSpeaking) return 'speaking';
  if (v.thinking) return 'thinking';
  if (v.link === 'down') return 'error';
  if (v.link === 'up') return 'listening';
  return 'waiting';
}
