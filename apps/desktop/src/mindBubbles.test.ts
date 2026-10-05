/**
 * Dusunce baloncugunun saf mantigi. DOM kutuphanesi yok (vitest node ortami),
 * bu yuzden bilesen degil TABLO + INDIRGEYICI sinaniyor.
 *
 * Bu dosyanin asil isi bir DAVRANIS degil bir SOZLESME korumak: baloncuga giren
 * her satir gercek bir Rust olayindan turemeli. Tablodan bir satir kaybolursa
 * ya da uydurma bir metin eklenirse burasi kirmizi olur.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_MIND_BUBBLES,
  MIND_TTL_MS,
  mindTextFor,
  pruneMindBubbles,
  pushMindBubble,
  type MindBubble,
  type MindEvent,
} from './mindBubbles.js';

function tool(ad: string, durum: string, sebep?: string): MindEvent {
  return { kind: 'tool', payload: sebep === undefined ? { ad, durum } : { ad, durum, sebep } };
}

/** Olaylari sirayla isler; her cagride kimlik ve zaman disaridan verilir. */
function feed(events: MindEvent[], now = 0, step = 0): MindBubble[] {
  let bubbles: MindBubble[] = [];
  events.forEach((e, i) => {
    bubbles = pushMindBubble(bubbles, e, { now: now + i * step, id: `t${i}` });
  });
  return bubbles;
}

function texts(bubbles: MindBubble[]): string[] {
  return bubbles.map((b) => b.text);
}

describe('mindTextFor — arac olaylari', () => {
  // Kaynak: Rust arac tablosu (`audio/live/tools.rs`; ad kumesini
  // `toolTable.test.ts` bekler). Her ad icin baslangic satiri BIREBIR sabit;
  // degisirse bilincli degismis olmali.
  const started: Array<[string, string]> = [
    ['hafizada_ara', 'hafızama bakıyorum…'],
    ['hafizaya_kaydet_ACIK_TALEP_ILE', 'bunu aklıma yazıyorum…'],
    ['hafizaya_kaydet', 'bunu aklıma yazıyorum…'],
    ['ekrani_net_gor', 'ekrana yakından bakıyorum…'],
    ['derin_dusun', 'bunu derinlemesine düşünüyorum…'],
    ['internette_ara', 'internete bakıyorum…'],
    ['web_sayfa_oku', 'sayfayı okuyorum…'],
    ['terminal_calistir', 'komutu çalıştırıyorum…'],
    ['dosya_ara', 'dosya arıyorum…'],
    ['dosya_oku', 'dosyayı okuyorum…'],
    ['sistem_durumu', 'sistemi yokluyorum…'],
    ['uygulama_ac', 'uygulamayı açıyorum…'],
    ['ses_kontrol', 'sesi ayarlıyorum…'],
    ['acik_uygulamalar', 'açık pencerelere bakıyorum…'],
    ['ajan_oturumlari', 'kod oturumlarına bakıyorum…'],
    ['kod_gorevi_ver', 'kendi kodumu düzenliyorum…'],
    ['ekran_akisi', 'ekran akışını ayarlıyorum…'],
    ['dinleme_modu', 'dinleme modunu ayarlıyorum…'],
    ['kod_gorevi_durum', 'kod görevinin durumuna bakıyorum…'],
    ['gorev_ver', 'panoya görev yazıyorum…'],
    ['pano_durumu', 'ekip panosuna bakıyorum…'],
    ['gorev_durum', 'görev durumunu değiştiriyorum…'],
    ['yorum_ekle', 'göreve not yazıyorum…'],
    ['ekip_listesi', 'ekibe bakıyorum…'],
    ['arka_plan_sonuc', 'arka plan sonucunu okuyorum…'],
    ['arka_plan_iptal', 'arka plan işini durduruyorum…'],
    ['hatirlatma_kur', 'hatırlatma kuruyorum…'],
    ['hatirlatmalari_listele', 'hatırlatmalara bakıyorum…'],
    ['hatirlatma_iptal', 'hatırlatmayı iptal ediyorum…'],
    ['profil_kaydet', 'profile yazıyorum…'],
    ['profil_sil', 'profilden siliyorum…'],
  ];

  it.each(started)('%s basladi -> "%s"', (ad, beklenen) => {
    expect(mindTextFor(tool(ad, 'basladi'))).toEqual({ text: beklenen, source: 'tool' });
  });

  it('bilinmeyen arac icin makul yedek uretir (useLiveVoice.toolLabel)', () => {
    // Tabloda yok ama `TOOL_LABELS`te var: mevcut etiket kullanilir.
    expect(mindTextFor(tool('hafizada_ara', 'basladi'))?.text).not.toBe('hafizada_ara');
    // Hicbir tabloda yok: teknik ad OLDUGU GIBI gosterilir, cokme yok.
    expect(mindTextFor(tool('yepyeni_arac', 'basladi'))).toEqual({
      text: 'yepyeni_arac',
      source: 'tool',
    });
  });

  it('bitis satiri YALNIZ hafizaya yazmada uretilir', () => {
    expect(mindTextFor(tool('hafizaya_kaydet', 'bitti'))).toEqual({
      text: 'bunu aklıma yazdım',
      source: 'memory',
    });
    expect(mindTextFor(tool('hafizaya_kaydet_ACIK_TALEP_ILE', 'bitti'))).toEqual({
      text: 'bunu aklıma yazdım',
      source: 'memory',
    });
    expect(mindTextFor(tool('hafizada_ara', 'bitti'))).toBeNull();
    expect(mindTextFor(tool('terminal_calistir', 'bitti'))).toBeNull();
  });

  it('hatirlatma ve profil araclari kendi bitis satirini uretir, iptal ve silme "yazdim" demez', () => {
    const done: Array<[string, string]> = [
      ['hatirlatma_kur', 'hatırlatmayı kurdum'],
      ['hatirlatma_iptal', 'hatırlatmayı iptal ettim'],
      ['profil_kaydet', 'profilime yazdım'],
      ['profil_sil', 'profilden sildim'],
    ];
    for (const [ad, text] of done) {
      expect(mindTextFor(tool(ad, 'bitti')), ad).toEqual({ text, source: 'memory' });
    }
    // Listeleme kalici bir sey degistirmez: bitis satiri yok.
    expect(mindTextFor(tool('hatirlatmalari_listele', 'bitti'))).toBeNull();
  });

  it('reddedilen hatirlatma ve profil yazmasi hafiza yazmasi gibi anlatilir', () => {
    for (const ad of ['hatirlatma_kur', 'hatirlatma_iptal', 'profil_kaydet', 'profil_sil']) {
      expect(mindTextFor(tool(ad, 'reddedildi', 'skor 0.2')), ad).toEqual({
        text: 'aklıma yazamadım, ses izi doğrulanmadı',
        source: 'gate',
      });
    }
    expect(mindTextFor(tool('hatirlatmalari_listele', 'reddedildi'))?.text).toBe(
      'bunu yapamam, ses izi doğrulanmadı',
    );
  });

  it('reddedilen cagri "yapilmadi" der ve hafiza yazmasini ayirir', () => {
    expect(mindTextFor(tool('terminal_calistir', 'reddedildi', 'ses izi yok'))).toEqual({
      text: 'bunu yapamam, ses izi doğrulanmadı',
      source: 'gate',
    });
    expect(mindTextFor(tool('hafizaya_kaydet', 'reddedildi', 'skor 0.31'))).toEqual({
      text: 'aklıma yazamadım, ses izi doğrulanmadı',
      source: 'gate',
    });
  });

  it('bilinmeyen durum satir uretmez (Rust yeni asama eklerse cokmez)', () => {
    expect(mindTextFor(tool('hafizada_ara', 'kuyrukta'))).toBeNull();
  });
});

describe('mindTextFor — ses izi, ekran, baglanti', () => {
  it('ses izi kararini oldugu gibi tasir', () => {
    expect(mindTextFor({ kind: 'speaker', payload: { karar: 'owner' } })?.text).toBe(
      'sesini tanıdım',
    );
    expect(mindTextFor({ kind: 'speaker', payload: { karar: 'foreign' } })?.text).toBe(
      'bu ses sana ait değil',
    );
    expect(mindTextFor({ kind: 'speaker', payload: { karar: 'unknown' } })?.text).toBe(
      'sesini çıkaramadım',
    );
    expect(mindTextFor({ kind: 'speaker', payload: { karar: 'bilinmeyen' } })).toBeNull();
  });

  it('ekran paylasimini bildirir', () => {
    expect(mindTextFor({ kind: 'screen', payload: { aktif: true, aralikMs: 2000 } })?.text).toBe(
      'ekranını görüyorum',
    );
    expect(mindTextFor({ kind: 'screen', payload: { aktif: false, aralikMs: 0 } })?.text).toBe(
      'ekrana artık bakmıyorum',
    );
  });

  it('baglanti kopmasini ve kurulmasini bildirir', () => {
    expect(mindTextFor({ kind: 'link', payload: { connected: false } })?.text).toBe(
      'bağlantım koptu, dönüyorum…',
    );
    expect(mindTextFor({ kind: 'link', payload: { connected: true } })?.text).toBe(
      'bağlantım kuruldu',
    );
  });
});

describe('mindTextFor — sozde-araclar (baglanti hatasi, ekran akisi)', () => {
  it('plansiz baglanti hatasini sinifina gore kisaca soyler', () => {
    const sebep =
      'kota veya yuk siniri (Gemini Live); kod=1011 sebep=quota exceeded; 30 sn sonra yeniden denenecek';
    expect(mindTextFor(tool('live_baglanti', 'hata', sebep))).toEqual({
      text: 'kota sınırı, 30 sn sonra deniyorum…',
      source: 'link',
    });
  });

  it('live_baglanti baska durumda satir uretmez', () => {
    expect(mindTextFor(tool('live_baglanti', 'basladi'))).toBeNull();
  });

  it('ekran akisi degisimi ekran paylasimiyla ayni cumleyi kullanir', () => {
    expect(mindTextFor(tool('ekran_akisi_durumu', 'akis_acik'))).toEqual({
      text: 'ekranını görüyorum',
      source: 'screen',
    });
    expect(mindTextFor(tool('ekran_akisi_durumu', 'akis_kapali'))?.text).toBe(
      'ekrana artık bakmıyorum',
    );
    expect(mindTextFor(tool('ekran_akisi_durumu', 'baska'))).toBeNull();
  });

  it('audio://screen ile ayni anda gelen ayni cumle tek kabarcik olur', () => {
    const bubbles = feed([
      tool('ekran_akisi_durumu', 'akis_acik'),
      { kind: 'screen', payload: { aktif: true, aralikMs: 2000 } },
    ]);
    expect(texts(bubbles)).toEqual(['ekranını görüyorum']);
  });
});

describe('mindTextFor — bos/eksik payload', () => {
  it('eksik alanlarda cokmez ve TAHMIN URETMEZ', () => {
    expect(mindTextFor({ kind: 'tool', payload: {} })).toBeNull();
    expect(mindTextFor({ kind: 'tool', payload: { ad: 'hafizada_ara' } })).toBeNull();
    expect(mindTextFor({ kind: 'tool', payload: { durum: 'basladi' } })).toBeNull();
    expect(mindTextFor({ kind: 'tool', payload: { ad: '', durum: 'basladi' } })).toBeNull();
    expect(mindTextFor({ kind: 'speaker', payload: {} })).toBeNull();
    expect(mindTextFor({ kind: 'screen', payload: {} })).toBeNull();
    expect(mindTextFor({ kind: 'link', payload: {} })).toBeNull();
  });

  it('karsiligi olmayan olay listeyi AYNEN birakir (gereksiz render yok)', () => {
    const before = feed([tool('hafizada_ara', 'basladi')]);
    const after = pushMindBubble(before, { kind: 'link', payload: {} }, { now: 1, id: 'x' });
    expect(after).toBe(before);
  });
});

describe('pushMindBubble — tekrar bastirma ve tavan', () => {
  it('ayni olay arka arkaya gelince kabarcik COGALMAZ', () => {
    const bubbles = feed([
      tool('hafizada_ara', 'basladi'),
      tool('hafizada_ara', 'basladi'),
      tool('hafizada_ara', 'basladi'),
    ]);
    expect(texts(bubbles)).toEqual(['hafızama bakıyorum…']);
  });

  it('tekrar, araya baska olay girse bile cogaltmaz ve satiri yerinde tazeler', () => {
    let bubbles = feed([tool('hafizada_ara', 'basladi'), tool('derin_dusun', 'basladi')]);
    expect(texts(bubbles)).toEqual(['hafızama bakıyorum…', 'bunu derinlemesine düşünüyorum…']);

    bubbles = pushMindBubble(bubbles, tool('hafizada_ara', 'basladi'), { now: 500, id: 'z' });
    // Sira ilk gorunme sirasidir: satir sona TASINMAZ, yalniz zamani tazelenir.
    expect(texts(bubbles)).toEqual(['hafızama bakıyorum…', 'bunu derinlemesine düşünüyorum…']);
    expect(bubbles[0]?.at).toBe(500);
    expect(bubbles[0]?.id).toBe('t0');
  });

  it('ayni araci iki fazi ayri satir uretir (baslangic ve yazma bitisi)', () => {
    const bubbles = feed([tool('hafizaya_kaydet', 'basladi'), tool('hafizaya_kaydet', 'bitti')]);
    expect(texts(bubbles)).toEqual(['bunu aklıma yazıyorum…', 'bunu aklıma yazdım']);
  });

  it('kabarcik sayisi tavani asilmaz; en eski dusar', () => {
    const bubbles = feed([
      tool('hafizada_ara', 'basladi'),
      tool('derin_dusun', 'basladi'),
      tool('internette_ara', 'basladi'),
      tool('dosya_oku', 'basladi'),
      tool('terminal_calistir', 'basladi'),
    ]);
    expect(bubbles).toHaveLength(MAX_MIND_BUBBLES);
    expect(texts(bubbles)).toEqual([
      'internete bakıyorum…',
      'dosyayı okuyorum…',
      'komutu çalıştırıyorum…',
    ]);
  });

  it('tavan cagri basina asilamayacak sekilde uygulanir (max=1)', () => {
    let bubbles: MindBubble[] = [];
    bubbles = pushMindBubble(bubbles, tool('hafizada_ara', 'basladi'), { now: 0, id: 'a', max: 1 });
    bubbles = pushMindBubble(bubbles, tool('derin_dusun', 'basladi'), { now: 1, id: 'b', max: 1 });
    expect(texts(bubbles)).toEqual(['bunu derinlemesine düşünüyorum…']);
  });
});

describe('sonme', () => {
  it('TTL dolan kabarcik push sirasinda dusurulur', () => {
    let bubbles = feed([tool('hafizada_ara', 'basladi')]);
    bubbles = pushMindBubble(bubbles, tool('derin_dusun', 'basladi'), {
      now: MIND_TTL_MS + 1,
      id: 'b',
    });
    expect(texts(bubbles)).toEqual(['bunu derinlemesine düşünüyorum…']);
  });

  it('tazelenen kabarcik erken sonmez', () => {
    let bubbles = feed([tool('hafizada_ara', 'basladi')]);
    bubbles = pushMindBubble(bubbles, tool('hafizada_ara', 'basladi'), {
      now: MIND_TTL_MS - 1,
      id: 'b',
    });
    expect(pruneMindBubbles(bubbles, MIND_TTL_MS + 1)).toHaveLength(1);
    expect(pruneMindBubbles(bubbles, 2 * MIND_TTL_MS)).toHaveLength(0);
  });

  it('hicbir sey sonmediyse AYNI dizi doner', () => {
    const bubbles = feed([tool('hafizada_ara', 'basladi')]);
    expect(pruneMindBubbles(bubbles, 10)).toBe(bubbles);
  });
});
