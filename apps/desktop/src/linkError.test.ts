/**
 * Baglanti hatasi gorunurlugunun saf mantigi. Wire sozlesmesi: Rust
 * (`live.rs` `hata_ozeti`) plansiz Live kapanisinda `audio://tool` olayini
 * ad='live_baglanti', durum='hata', sebep=<metin> ile yayar. Burasi o metnin
 * gercek bicimiyle sinanir; Rust metni degisirse kirmizi olur.
 */
import { describe, expect, it } from 'vitest';

import {
  LIVE_BAGLANTI,
  eventBridgeError,
  linkErrorAfterStatus,
  linkErrorBubble,
  linkErrorFromTool,
  linkErrorText,
  parseLinkError,
} from './linkError.js';

// `live.rs::hata_ozeti` ciktilarinin birebir bicimi.
const AG = 'ag hatasi (Gemini Live); kod=yok sebep=yok; 2 sn sonra yeniden denenecek';
const KOTA =
  'kota veya yuk siniri (Gemini Live); kod=1011 sebep=quota exceeded; 30 sn sonra yeniden denenecek';
const KALICI =
  'kalici hata: API anahtari, izin veya istek kontrol edilmeli (Gemini Live); kod=1008 sebep=policy; 300 sn sonra yeniden denenecek';

describe('parseLinkError', () => {
  it('sinifi ve bekleme suresini Rust metninden okur', () => {
    expect(parseLinkError(AG)).toMatchObject({ kind: 'ag', retrySec: 2 });
    expect(parseLinkError(KOTA)).toMatchObject({ kind: 'kota', retrySec: 30 });
    expect(parseLinkError(KALICI)).toMatchObject({ kind: 'kalici', retrySec: 300 });
  });

  it('ham metni teshis icin saklar', () => {
    expect(parseLinkError(KOTA).raw).toBe(KOTA);
  });

  it('tanimsiz ya da bos metinde cokmez, bilinmiyor doner', () => {
    expect(parseLinkError(undefined)).toMatchObject({ kind: 'bilinmiyor', retrySec: null });
    expect(parseLinkError('')).toMatchObject({ kind: 'bilinmiyor', retrySec: null });
    expect(parseLinkError('baska bir sey')).toMatchObject({ kind: 'bilinmiyor', retrySec: null });
  });
});

describe('linkErrorText: kullaniciya ne yapacagini soyler', () => {
  it('ag hatasi: sinif + bekleme + internet kontrolu', () => {
    const t = linkErrorText(parseLinkError(AG));
    expect(t).toContain('ağ hatası');
    expect(t).toContain('2 sn sonra');
    expect(t).toContain('İnternet');
  });

  it('kota/yuk: bekleme + ne yapilacagi', () => {
    const t = linkErrorText(parseLinkError(KOTA));
    expect(t).toContain('kota');
    expect(t).toContain('30 sn sonra');
    expect(t).toMatch(/bekle|azalt/);
  });

  it('kalici: anahtar ve izin kontrolu, uzun bekleme dakikaya cevrilir', () => {
    const t = linkErrorText(parseLinkError(KALICI));
    expect(t).toContain('API anahtarını');
    expect(t).toContain('5 dk sonra');
  });

  it('bekleme bilinmiyorsa sure uydurmaz', () => {
    const t = linkErrorText(parseLinkError('ag hatasi (Gemini Live); kod=yok sebep=yok'));
    expect(t).not.toMatch(/\d+ (sn|dk) sonra/);
  });

  it('em dash icermez', () => {
    for (const s of [AG, KOTA, KALICI, '']) {
      expect(linkErrorText(parseLinkError(s))).not.toContain('—');
      expect(linkErrorBubble(parseLinkError(s))).not.toContain('—');
    }
  });
});

describe('linkErrorBubble: kisa dusunce satiri', () => {
  it('sinifa gore kisa metin uretir', () => {
    expect(linkErrorBubble(parseLinkError(AG))).toBe('bağlantı koptu, 2 sn sonra deniyorum…');
    expect(linkErrorBubble(parseLinkError(KOTA))).toBe('kota sınırı, 30 sn sonra deniyorum…');
    expect(linkErrorBubble(parseLinkError(KALICI))).toBe(
      'bağlantı kurulamıyor, anahtar ve izinler kontrol edilmeli',
    );
  });
});

describe('summary: HUD satiri', () => {
  it('sinif adini ve varsa bekleme suresini yazar', () => {
    expect(parseLinkError(AG).summary).toBe('Ağ hatası: 2 sn sonra tekrar');
    expect(parseLinkError(KOTA).summary).toBe('Kota / yük sınırı: 30 sn sonra tekrar');
    expect(parseLinkError(KALICI).summary).toBe('Kalıcı hata: 300 sn sonra tekrar');
    expect(parseLinkError('').summary).toBe('Bağlantı hatası');
  });
});

describe('eventBridgeError: olay koprusu kurulamadi', () => {
  it('Live baglantisi hakkinda iddia tasimaz, yerel sorunu soyler', () => {
    const e = eventBridgeError();
    expect(e).toMatchObject({ kind: 'olaylar', retrySec: null, raw: '' });
    expect(e.text).toContain('Pencereyi yeniden aç');
    expect(e.text).not.toContain('Gemini');
    expect(e.summary).toBe('Olay köprüsü hatası');
    expect(e.bubble).toContain('olayları dinleyemiyorum');
  });

  it('Rust metninden asla bu sinifa cozumlenmez', () => {
    expect(parseLinkError('olay koprusu').kind).toBe('bilinmiyor');
  });
});

describe('linkErrorFromTool', () => {
  it('yalniz live_baglanti + hata olayindan hata uretir', () => {
    const e = linkErrorFromTool({ ad: LIVE_BAGLANTI, durum: 'hata', sebep: KOTA });
    expect(e).toMatchObject({ kind: 'kota', retrySec: 30 });
  });

  it('baska arac ya da baska durum yok sayilir', () => {
    expect(linkErrorFromTool({ ad: 'hafizada_ara', durum: 'hata', sebep: KOTA })).toBeNull();
    expect(linkErrorFromTool({ ad: LIVE_BAGLANTI, durum: 'basladi' })).toBeNull();
    expect(linkErrorFromTool({ ad: LIVE_BAGLANTI, durum: 'reddedildi' })).toBeNull();
  });

  it('sebepsiz hata olayi da gorunur (bilinmiyor)', () => {
    expect(linkErrorFromTool({ ad: LIVE_BAGLANTI, durum: 'hata' })).toMatchObject({
      kind: 'bilinmiyor',
    });
  });
});

describe('linkErrorAfterStatus: temizlenme', () => {
  const hata = parseLinkError(KOTA);

  it('basarili baglanti (connected=true) hatayi temizler', () => {
    expect(linkErrorAfterStatus(hata, true)).toBeNull();
  });

  it('oturum kapandi (connected=false) hatayi korur', () => {
    expect(linkErrorAfterStatus(hata, false)).toBe(hata);
  });

  it('hata yokken null kalir', () => {
    expect(linkErrorAfterStatus(null, true)).toBeNull();
    expect(linkErrorAfterStatus(null, false)).toBeNull();
  });
});
