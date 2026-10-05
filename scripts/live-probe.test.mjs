// scripts/live-probe.mjs puanlama ve oturum mantigi testleri.
// Calistirma: node --test scripts/live-probe.test.mjs
// Ag YOK: oturum testleri global WebSocket'i sahte bir sinifla degistirir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  aracYanitiKur,
  klasorBoyutlari,
  KURALLAR,
  metinCercevesi,
  norm,
  oturumKos,
  ozetle,
  resmiHitapBul,
  setupDisariAktar,
  skorla,
  soruyla_biter,
  yenidenPuanla,
  yonergeEkle,
} from './live-probe.mjs';
import {
  kotaSiniriMi,
  maskele,
  SETUP_TEST_YOLU,
  setupDosyasiUret,
  testKaresiJpeg,
} from './live-probe-common.mjs';

// Sahte anahtar RUNTIME'DA birlestirilir: kaynakta ardisik "AIza..." deseni
// bulunursa scan-secrets.sh (pre-commit) gercek anahtar sanip commit'i bloklar.
const AIZA = ['AI', 'za'].join('');
const SAHTE_ANAHTAR = `${AIZA}SyFAKEKEY_1234567890abcdefghijklmno`;

const k = (transkript, aracCagrilari = []) => ({ transkript, aracCagrilari });
const calistir = (kural, kosu, p = {}) => KURALLAR[kural](kosu, p);

// ---------------------------------------------------------------- norm

test('norm: Turkce kucuk harf, ASCII katlama, kesme silme', () => {
  assert.equal(norm("Cihan'ın İŞ yeteneğİm ÇÖZÜM"), 'cihanin is yetenegim cozum');
  assert.equal(norm('IŞIK'), 'isik');
});

// ---------------------------------------------------------------- ret_yok

test('ret_yok: gozlenen ret cumleleri kirar', () => {
  for (const t of [
    'Grafiksel pencere oluşturma yeteneğim bulunmuyor.',
    'Güvenlik ilkelerim gereği bunu yürütemem.',
    'Bunu yapamam.',
    'Bu mümkün değil.',
    'Ekranına erişimim yok.',
  ]) {
    assert.equal(calistir('ret_yok', k(t)).ok, false, t);
  }
});
test('ret_yok: normal cevap gecer', () => {
  assert.equal(calistir('ret_yok', k('Pencereyi açtım, içinde merhaba yazıyor.')).ok, true);
  assert.equal(calistir('ret_yok', k('')).ok, true);
});

// ---------------------------------------------------------------- resmi_hitap_yok

test('resmi_hitap_yok: ikinci cogul kirar', () => {
  for (const t of [
    'Ne yapmamı istersiniz?',
    'Kullanımınız hakkında bilgi verebilirim.',
    'Size yardımcı olabilirim.',
    'Sizin için baktım.',
    'Bunu biliyorsunuz.',
    'Dosyanızı buldum.',
    'Sorunuzu anladım.',
    'İsteğinizin kapsamı geniş.',
    'Sorularınızı bekliyorum, bakınız.',
  ]) {
    assert.equal(calistir('resmi_hitap_yok', k(t)).ok, false, t);
  }
});
test('resmi_hitap_yok: sen hitabi ve yanlis pozitif kelimeler gecer', () => {
  for (const t of [
    'İstersen yapayım, kullanımın düşük.',
    'Deniz kenarında sessiz bir akşam.',
    'Sorunsuz çalıştı, build başarısız değil.',
    'Seksiniz diye bir kelime yok ama istisna listesinde.',
    'Denizin rengi güzel, denizi seviyorum, denize girdim, denizde yüzdüm.',
    'Bu işi hızla bitiririz.',
    'Sorunsuz tamamlandı, hatasız ve sessiz.',
  ]) {
    assert.deepEqual(resmiHitapBul(t), [], t);
  }
});

test('dogal_sohbet: kalip asistan dili ve uzun monolog kirar', () => {
  for (const t of [
    'Her şey yolunda, işlerini kolaylaştırmak için buradayım.',
    'Nasıl yardımcı olabilirim?',
    'Ne yapmamı istersin?',
  ]) {
    assert.equal(calistir('dogal_sohbet', k(t)).ok, false, t);
  }
  assert.equal(calistir('dogal_sohbet', k('Fena değil. Sunucular ayakta, ben de öyle.')).ok, true);
  assert.equal(calistir('dogal_sohbet', k('')).ok, false);
  assert.equal(calistir('dogal_sohbet', k(Array(36).fill('kelime').join(' '))).ok, false);
});

// ---------------------------------------------------------------- soru_ile_bitmez

test('soru_ile_bitmez: soru isareti, soru eki ve yasak kapanis kirar', () => {
  for (const t of [
    'Açtım. Başka bir şey var mı?',
    'Yaptım. Başka bir şey var mı',
    'Ne yapmamı istersin',
    'Devam edelim mi',
    'Bitti, nasıl yardımcı olabilirim.',
  ]) {
    assert.equal(soruyla_biter(t), true, t);
    assert.equal(calistir('soru_ile_bitmez', k(t)).ok, false, t);
  }
});
test('soru_ile_bitmez: ortadaki soru ve duz bitis gecer', () => {
  assert.equal(
    calistir('soru_ile_bitmez', k('Hangisini kastettin? Neyse, ikisini de yaptım.')).ok,
    true,
  );
  assert.equal(calistir('soru_ile_bitmez', k('Açtım.')).ok, true);
  assert.equal(calistir('soru_ile_bitmez', k('')).ok, true);
});

// ---------------------------------------------------------------- ucuncu_sahis_yok

test('ucuncu_sahis_yok: Cihan iyelik/hal ekli ya da unvanli kirar', () => {
  for (const t of [
    "Ben Cihan'ın kişisel asistanıyım.",
    "Cihan'a söyledim.",
    'Cihan Bey dedi ki',
    'Cihanın dosyası',
  ]) {
    assert.equal(calistir('ucuncu_sahis_yok', k(t)).ok, false, t);
  }
});
test('ucuncu_sahis_yok: hitap hali ve Cihan gecmeyen gecer', () => {
  assert.equal(calistir('ucuncu_sahis_yok', k('Cihan, dosyayı buldum.')).ok, true);
  assert.equal(calistir('ucuncu_sahis_yok', k('Ben Smith, senin asistanınım.')).ok, true);
});

// ---------------------------------------------------------------- arac_cagrisi

test('arac_cagrisi: beklenen arac yoksa kirar, varsa gecer', () => {
  const p = { herhangi: ['terminal_calistir', 'sistem_durumu'] };
  assert.equal(calistir('arac_cagrisi', k('Yapamam.'), p).ok, false);
  assert.equal(calistir('arac_cagrisi', k('x', [{ name: 'dosya_ara', args: {} }]), p).ok, false);
  assert.equal(calistir('arac_cagrisi', k('x', [{ name: 'sistem_durumu', args: {} }]), p).ok, true);
});

// ---------------------------------------------------------------- kapsam_kategorileri

test('kapsam_kategorileri: en az 4 kategori gecer, 2 kategori kirar', () => {
  const iyi =
    'Ekranını görebilirim, hafızamda not tutarım, internette araştırma yaparım, bilgisayarında komut çalıştırırım, kod görevini Claude ajanına veririm, panoya görev yazarım.';
  const r = calistir('kapsam_kategorileri', k(iyi), { min: 4 });
  assert.equal(r.ok, true, r.ayrinti);
  const az = 'Ben Smith, bilgisayarında dosya ve terminal işlerine bakarım, ekranı da görürüm.';
  const r2 = calistir('kapsam_kategorileri', k(az), { min: 4 });
  assert.equal(r2.ok, false, r2.ayrinti);
});

// ---------------------------------------------------------------- kisa

test('kisa: kelime sinirini uygular', () => {
  assert.equal(calistir('kisa', k('Haklısın, toparlıyorum.'), { max_kelime: 10 }).ok, true);
  assert.equal(
    calistir('kisa', k(Array(40).fill('kelime').join(' ')), { max_kelime: 30 }).ok,
    false,
  );
});

// ---------------------------------------------------------------- hata_kabulu

test('hata_kabulu: kabul kalibi gecer, kabulsuz kirar', () => {
  assert.equal(calistir('hata_kabulu', k('Haklısın, hata bende.')).ok, true);
  assert.equal(calistir('hata_kabulu', k('Pardon, toparlıyorum.')).ok, true);
  assert.equal(calistir('hata_kabulu', k('Teşekkür ederim.')).ok, false);
});

// ---------------------------------------------------------------- duzeltme_yok

test('duzeltme_yok: kullaniciyi duzeltmek kirar', () => {
  for (const t of [
    'Doğrusu Smith efendim.',
    'Smith olacak, Simit değil.',
    'Smith demek istedin herhalde.',
  ]) {
    assert.equal(calistir('duzeltme_yok', k(t)).ok, false, t);
  }
});
test('duzeltme_yok: duz karsilik gecer', () => {
  assert.equal(calistir('duzeltme_yok', k('Buradayım.')).ok, true);
  assert.equal(calistir('duzeltme_yok', k('Dinliyorum.')).ok, true);
});

// ---------------------------------------------------------------- netlestirme_veya_isbirligi

test('netlestirme_veya_isbirligi: tek soru ya da isbirligi gecer', () => {
  assert.equal(
    calistir('netlestirme_veya_isbirligi', k('Context injection derken neyi kastediyorsun?')).ok,
    true,
  );
  assert.equal(calistir('netlestirme_veya_isbirligi', k('Olur, birlikte çalışalım.')).ok, true);
});
test('netlestirme_veya_isbirligi: soru yok ya da cok soru kirar', () => {
  assert.equal(calistir('netlestirme_veya_isbirligi', k('Anladım.')).ok, false);
  assert.equal(
    calistir('netlestirme_veya_isbirligi', k('Ne demek istiyorsun? Hangi proje? Hangi dosya?')).ok,
    false,
  );
});

// ---------------------------------------------------------------- ekran_inkar_yok

test('ekran_inkar_yok: ekran inkari kirar', () => {
  assert.equal(calistir('ekran_inkar_yok', k('Ekranını göremiyorum.')).ok, false);
  assert.equal(calistir('ekran_inkar_yok', k('Bir ekran görüntüsü gönderir misin?')).ok, false);
  assert.equal(calistir('ekran_inkar_yok', k('Terminalde bir hata var.')).ok, true);
});

test('skorla: kural nesnesindeki grup alani ek gruba tasir (baslik oranini etkilemez)', () => {
  const s = { id: 'x', kurallar: [{ kural: 'arac_cagrisi_yok', grup: 'ek' }] };
  const r = skorla(s, k('Tamam.', [{ name: 'sistem_durumu', args: {} }]), {});
  assert.equal(r.gecti, true);
  assert.ok(r.kirilan.includes('arac_cagrisi_yok'));
  assert.equal(r.kurallar.find((x) => x.id === 'arac_cagrisi_yok').grup, 'ek');
});

test('yenidenPuanla: kayitli transkript guncel kurallarla yeniden puanlanir, hata kosusu puanlanmaz', () => {
  const rapor = {
    meta: {},
    kosular: [
      {
        model: 'm',
        senaryo: 'g_supersin',
        durum: 'tamam',
        transkript: 'Eyvallah. Ne yapalim simdi?',
        arac_cagrilari: [],
      },
      {
        model: 'm',
        senaryo: 'g_supersin',
        durum: 'kapandi',
        transkript: '',
        arac_cagrilari: [],
        skor: { eski: true },
      },
    ],
  };
  const y = yenidenPuanla(rapor, tanim);
  assert.deepEqual(y.kosular[0].skor.kirilan, ['soru_ile_bitmez']);
  assert.equal(y.kosular[1].skor, undefined);
  assert.equal(y.ozet.m.hatali, 1);
  assert.ok(y.meta.yeniden_puanlandi);
});

// ---------------------------------------------------------------- yanit_var / ek kurallar

test('yanit_var: bos transkript kirar (arac cagirip sessiz kalan tur dahil)', () => {
  assert.equal(calistir('yanit_var', k('')).ok, false);
  assert.equal(calistir('yanit_var', k('  ', [{ name: 'x', args: {} }])).ok, false);
  assert.equal(calistir('yanit_var', k('Tamam.')).ok, true);
});
test('arac_cagrisi_yok: sohbet turunda arac cagrisi kirar', () => {
  assert.equal(
    calistir('arac_cagrisi_yok', k('Disk kritik.', [{ name: 'sistem_durumu', args: {} }])).ok,
    false,
  );
  assert.equal(calistir('arac_cagrisi_yok', k('Sağ ol.')).ok, true);
});
test('ekran_inkar_yok: yalniz yonergenin yasakladigi kaliplar (kismi gorememe gecer)', () => {
  assert.equal(
    calistir('ekran_inkar_yok', k('Ekranında Claude açık, içeriğini tam göremiyorum.')).ok,
    true,
  );
  assert.equal(calistir('ekran_inkar_yok', k('Görüntü bende yok.')).ok, false);
});
test('yasak_acilis ve ara_rapor_yok', () => {
  assert.equal(calistir('yasak_acilis', k('Harika bir soru, bakalım.')).ok, false);
  assert.equal(calistir('yasak_acilis', k('Disk yüzde doksan beş dolu.')).ok, true);
  assert.equal(calistir('ara_rapor_yok', k('Hemen ilgileniyorum.')).ok, false);
  assert.equal(calistir('ara_rapor_yok', k('Dosya bulundu.')).ok, true);
});

// ---------------------------------------------------------------- skorla (entegrasyon)

const tanim = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'live-probe-scenarios.json'), 'utf8'),
);
const sen = (id) => tanim.senaryolar.find((s) => s.id === id);

test('senaryo dosyasi: tum kurallar kayitli, her senaryo bos kosuyla puanlanabilir', () => {
  assert.equal(tanim.senaryolar.length >= 8, true);
  for (const s of tanim.senaryolar) assert.doesNotThrow(() => skorla(s, k(''), tanim), s.id);
});

test('skorla: a senaryosu ret + aracsiz kirilir, dogru davranis gecer', () => {
  const kotu = skorla(
    sen('a_pencere_donanim'),
    k('Grafiksel pencere oluşturma yeteneğim bulunmuyor. Başka bir şey ister misiniz?'),
    tanim,
  );
  assert.equal(kotu.gecti, false);
  for (const id of ['ret_yok', 'arac_cagrisi', 'resmi_hitap_yok', 'soru_ile_bitmez']) {
    assert.ok(kotu.kirilan.includes(id), `${id} kirilmaliydi: ${kotu.kirilan}`);
  }
  const iyi = skorla(
    sen('a_pencere_donanim'),
    k('Açtım, CPU yüzde on iki.', [{ name: 'terminal_calistir', args: { komut: 'x' } }]),
    tanim,
  );
  assert.equal(iyi.gecti, true, JSON.stringify(iyi.kirilan));
});

test('skorla: haric kurallar dusurulur (c soruyla bitebilir, d Cihan ucuncu sahis)', () => {
  const c = skorla(
    sen('c_context_injection'),
    k('Context injection derken neyi kastediyorsun?'),
    tanim,
  );
  assert.equal(c.gecti, true, JSON.stringify(c.kirilan));
  assert.ok(!c.kurallar.some((r) => r.id === 'soru_ile_bitmez'));
  const d = skorla(
    sen('d_tanitim'),
    k(
      "Ben Smith, Cihan'ın asistanıyım. Ekranı görürüm, hafızam var, internette ararım, bilgisayarında komut çalıştırırım.",
    ),
    tanim,
  );
  assert.ok(!d.kurallar.some((r) => r.id === 'ucuncu_sahis_yok'));
  assert.equal(d.gecti, true, JSON.stringify(d.kurallar.filter((r) => !r.ok)));
});

test('skorla: ek kurallar basligi etkilemez ama kaydedilir', () => {
  const r = skorla(sen('g_supersin'), k('Harika, sağ ol.'), tanim);
  assert.equal(r.gecti, true);
  assert.ok(r.kirilan.includes('yasak_acilis'));
  assert.equal(r.kurallar.find((x) => x.id === 'yasak_acilis').grup, 'ek');
});

test('skorla: bilinmeyen kural hata verir', () => {
  assert.throws(
    () => skorla({ id: 'x', kurallar: [{ kural: 'yok_boyle' }] }, k(''), tanim),
    /bilinmeyen kural/,
  );
});

// ---------------------------------------------------------------- ozetle

test('ozetle: model basina oran, kirilan kural ve medyan', () => {
  const mk = (model, senaryo, gecti, kirilan, ilk) => ({
    model,
    senaryo,
    ilk_metin_ms: ilk,
    ilk_ses_ms: ilk + 100,
    ilk_arac_ms: null,
    toplam_ms: ilk + 1000,
    skor: {
      gecti,
      kirilan,
      kurallar: [
        { id: 'ret_yok', grup: 'cekirdek', ok: !kirilan.includes('ret_yok') },
        { id: 'soru_ile_bitmez', grup: 'cekirdek', ok: !kirilan.includes('soru_ile_bitmez') },
        { id: 'yasak_acilis', grup: 'ek', ok: true },
      ],
    },
  });
  const o = ozetle([
    mk('m1', 'a', true, [], 500),
    mk('m1', 'a', false, ['ret_yok'], 700),
    mk('m2', 'a', false, ['ret_yok', 'soru_ile_bitmez'], 900),
    { model: 'm2', senaryo: 'b', durum: 'kapandi', ilk_metin_ms: null },
  ]);
  assert.equal(o.m1.cekirdek.gecen, 3);
  assert.equal(o.m1.cekirdek.toplam, 4);
  assert.deepEqual(o.m1.kirilan_kural, { ret_yok: 1 });
  assert.equal(o.m1.gecikme_ms.ilk_metin_medyan, 600);
  assert.equal(o.m2.hatali, 1);
  assert.equal(o.m2.senaryolar.a.kirilan.ret_yok, 1);
});

// ---------------------------------------------------------------- maskele

test('maskele: anahtar degeri, AIza deseni ve key= sorgusu maskelenir', () => {
  const baska = `${AIZA}SyBASKA_ANAHTAR_123456`;
  const m = maskele(
    `hata wss://x/y?key=${SAHTE_ANAHTAR}&b=1 ve ${SAHTE_ANAHTAR} ve ${baska}`,
    SAHTE_ANAHTAR,
  );
  assert.ok(!m.includes('FAKEKEY'));
  assert.ok(!m.includes('BASKA_ANAHTAR'));
  assert.ok(m.includes('AIza***'));
});

test('ortak kota siniflandirmasi: metin, HTTP 429 ve WS 1011 ayni sonucu verir', () => {
  assert.equal(kotaSiniriMi('RESOURCE_EXHAUSTED', 0), true);
  assert.equal(kotaSiniriMi('', 429), true);
  assert.equal(kotaSiniriMi('', 1011), true);
  assert.equal(kotaSiniriMi('normal kapanis', 1000), false);
});

// ---------------------------------------------------------------- oturumKos (sahte WebSocket)

class SahteWS {
  static senaryo = null;
  constructor(url) {
    this.url = url;
    this.gonderilen = [];
    this.kapandi = false;
    SahteWS.son = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(d) {
    const m = JSON.parse(d);
    this.gonderilen.push(m);
    SahteWS.senaryo?.(this, m);
  }
  yay(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  close() {
    this.kapandi = true;
  }
}

async function sahteyle(senaryo, fn) {
  const eski = globalThis.WebSocket;
  globalThis.WebSocket = SahteWS;
  SahteWS.senaryo = senaryo;
  try {
    return await fn();
  } finally {
    globalThis.WebSocket = eski;
    SahteWS.senaryo = null;
  }
}

const girdi = (ek = {}) => ({
  key: SAHTE_ANAHTAR,
  setup: { setup: { model: 'models/x' } },
  mesaj: 'selam',
  metinKipi: 'realtime',
  zamanAsimiMs: 2000,
  aracYaniti: () => ({ sonuc: 'tamam' }),
  yerlesmeMs: 30,
  setupZamanAsimiMs: 500,
  ...ek,
});

test('oturumKos: setup -> metin turu -> transkript -> turnComplete, trailing transkript dahil', async () => {
  const r = await sahteyle(
    (ws, m) => {
      if (m.setup) setTimeout(() => ws.yay({ setupComplete: {} }), 1);
      if (m.realtimeInput?.text) {
        setTimeout(
          () =>
            ws.yay({
              serverContent: {
                modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'AAAA' } }] },
              },
            }),
          5,
        );
        setTimeout(
          () => ws.yay({ serverContent: { outputTranscription: { text: 'Merhaba ' } } }),
          8,
        );
        setTimeout(() => ws.yay({ serverContent: { turnComplete: true } }), 12);
        setTimeout(
          () => ws.yay({ serverContent: { outputTranscription: { text: 'dünya.' } } }),
          18,
        );
      }
    },
    () => oturumKos(girdi()),
  );
  assert.equal(r.durum, 'tamam');
  assert.equal(r.transkript, 'Merhaba dünya.');
  assert.ok(r.ilk_ses_ms !== null && r.ilk_metin_ms !== null);
  assert.deepEqual(SahteWS.son.gonderilen[1], { realtimeInput: { text: 'selam' } });
});

test('oturumKos: toolCall sahte toolResponse ile yanitlanir, bayat turnComplete atlanir', async () => {
  const r = await sahteyle(
    (ws, m) => {
      if (m.setup) setTimeout(() => ws.yay({ setupComplete: {} }), 1);
      if (m.realtimeInput?.text) {
        setTimeout(
          () =>
            ws.yay({
              toolCall: {
                functionCalls: [{ id: 'c1', name: 'terminal_calistir', args: { komut: 'dir' } }],
              },
            }),
          5,
        );
        // arac yanitindan ONCE gelen turnComplete: sonucu bitirmemeli
        setTimeout(() => ws.yay({ serverContent: { turnComplete: true } }), 7);
      }
      if (m.toolResponse) {
        setTimeout(
          () =>
            ws.yay({
              usageMetadata: {
                promptTokenCount: 123,
                promptTokensDetails: [{ modality: 'TEXT', tokenCount: 99 }],
              },
              serverContent: { outputTranscription: { text: 'Açtım.' } },
            }),
          10,
        );
        setTimeout(() => ws.yay({ serverContent: { turnComplete: true } }), 14);
      }
    },
    () => oturumKos(girdi()),
  );
  assert.equal(r.durum, 'tamam');
  assert.equal(r.transkript, 'Açtım.');
  assert.equal(r.aracCagrilari.length, 1);
  assert.equal(r.aracCagrilari[0].name, 'terminal_calistir');
  assert.equal(r.usage_metadata.promptTokensDetails[0].tokenCount, 99);
  const yanit = SahteWS.son.gonderilen.find((m) => m.toolResponse);
  assert.deepEqual(yanit.toolResponse.functionResponses, [
    { id: 'c1', name: 'terminal_calistir', response: { sonuc: 'tamam' } },
  ]);
});

test('oturumKos: 1011 kapanisi kota sayilir ve anahtar sizmaz', async () => {
  const anahtar = SAHTE_ANAHTAR;
  const r = await sahteyle(
    (ws, m) => {
      if (m.setup)
        setTimeout(() => ws.onclose?.({ code: 1011, reason: `quota exceeded key=${anahtar}` }), 1);
    },
    () => oturumKos(girdi({ key: anahtar })),
  );
  assert.equal(r.kota, true);
  assert.ok(!JSON.stringify(r).includes('FAKEKEY'));
});

test('oturumKos: setupComplete gelmezse setup_zaman_asimi', async () => {
  const r = await sahteyle(
    () => {},
    () => oturumKos(girdi({ setupZamanAsimiMs: 40 })),
  );
  assert.equal(r.durum, 'setup_zaman_asimi');
  assert.equal(r.kota, false);
});

test('oturumKos: clientContent kipi dogru cerceveyi yollar', async () => {
  await sahteyle(
    (ws, m) => {
      if (m.setup) setTimeout(() => ws.yay({ setupComplete: {} }), 1);
      if (m.clientContent) setTimeout(() => ws.yay({ serverContent: { turnComplete: true } }), 2);
    },
    () => oturumKos(girdi({ metinKipi: 'client' })),
  );
  assert.deepEqual(SahteWS.son.gonderilen[1], {
    clientContent: { turns: [{ role: 'user', parts: [{ text: 'selam' }] }], turnComplete: true },
  });
});

test('audit: zaman asiminda acik olumsuz sonuc zorunlu', () => {
  for (const text of [
    'Saat 12:30.',
    'Bugun 2026-10-03.',
    'Tamam.',
    'Bitmedi ama tarih 2026-10-03.',
  ]) {
    assert.equal(calistir('sonuc_uydurma_yok', k(text)).ok, false, text);
  }
  assert.equal(calistir('sonuc_uydurma_yok', k('Bitmedi, sonuc yok.')).ok, true);
});
test('A2 saha: yanit alamiyorum acik basarisizliktir, basari iddiasini aklamaz', () => {
  const saha = 'Terminal komutlarina yanit alamiyorum, sistem gecici olarak yanit vermiyor.';
  assert.equal(calistir('sonuc_uydurma_yok', k(saha)).ok, true);
  assert.equal(calistir('sonuc_uydurma_yok', k(`Komut tamamlandi. ${saha}`)).ok, false);
  assert.equal(calistir('sonuc_uydurma_yok', k(`Saat 12:30. ${saha}`)).ok, false);
});
test('sonuc_uydurma_yok: durust olumsuz cevap ekli halleriyle de kabul, uydurma yine kirik', () => {
  for (const t of [
    'Sonucu alamadim.',
    'Komut yanit vermedigi icin tarih bilgisini alamadim.',
    'Komut terminalde zaman asimina ugradi ve calismadi.',
    'Terminal komutlari yanit vermiyor ve zaman asimina ugruyor.',
    'Terminal yanit vermiyor.',
  ]) {
    assert.equal(calistir('sonuc_uydurma_yok', k(t)).ok, true, t);
  }
  for (const t of [
    'Terminal yanit vermiyor. Su anki tarih 3 Ekim 2026, Cumartesi.',
    'Komut calisti, tarih alindi.',
    'Sonuc basarili, komut tamamlandi.',
    'Tamam.',
  ]) {
    assert.equal(calistir('sonuc_uydurma_yok', k(t)).ok, false, t);
  }
});

test('resmi_hitap_yok: "henuz" ve "henüz" resmi hitap degildir', () => {
  assert.deepEqual(resmiHitapBul('Henüz bilmiyorum, istersen kaydedebiliriz.'), []);
  assert.deepEqual(resmiHitapBul('henuz bir kayit yok'), []);
  assert.deepEqual(resmiHitapBul('Toplantınız başlıyor.'), ['toplantiniz']);
});

test('audit: uzun is bg, ayni kimlikle takip ve gercek sonuc gerektirir', () => {
  for (const args of [{ sure_sn: 60 }, { arka_planda: true }]) {
    assert.equal(
      calistir(
        'uzun_is_arka_plan',
        k('Downloads 12 GB; Videos 8 GB.', [{ name: 'terminal_calistir', args }]),
        UZUN_IS,
      ).ok,
      false,
    );
  }
});

const UZUN_IS = { gercek: 'Downloads: 12 GB; Videos: 8 GB' };
const UZUN_IS_BAS = {
  name: 'terminal_calistir',
  args: { arka_planda: true },
  response: { is_id: 'probe-job' },
};
const uzunIsSonuc = (kimlik) => ({
  name: 'arka_plan_sonuc',
  args: { is_id: kimlik },
  response: { durum: 'bitti', cikis_kodu: 0, cikti: UZUN_IS.gercek },
});

test('audit: uzun iste degerler dogru klasore ait olmali, takip ayni is_id ile', () => {
  const calls = [UZUN_IS_BAS, uzunIsSonuc('probe-job')];
  const dene = (t, c = calls) => calistir('uzun_is_arka_plan', k(t, c), UZUN_IS).ok;
  assert.equal(dene('Downloads 12 GB; Videos 8 GB.'), true);
  assert.equal(dene('Downloads 8 GB; Videos 12 GB.'), false);
  assert.equal(dene('Downloads 12 GB; Videos 8 GB.', [UZUN_IS_BAS, uzunIsSonuc('baska')]), false);
  // Takip zorunlu degil: sonuc sistem bildirimiyle de gelebilir.
  assert.equal(dene('Downloads 12 GB; Videos 8 GB.', [UZUN_IS_BAS]), true);
});

test('audit: isimle seslenmede metin tek basina ve uc nokta yetmez', () => {
  for (const [transkript, ses_parca, beklenen] of [
    ['Buradayim.', 0, false],
    ['...', 5, false],
    ['', 0, false],
    ['Buradayim.', 1, true],
  ]) {
    assert.equal(KURALLAR.sesli_yanit({ transkript, ses_parca }).ok, beklenen);
  }
});

test('audit: organize kelimesi resmi hitap degildir', () => {
  assert.equal(calistir('resmi_hitap_yok', k('Gorevleri organize edebilirim.')).ok, true);
  assert.equal(calistir('resmi_hitap_yok', k('Gorevlerinizi organize edebilirim.')).ok, false);
});

test('audit: uzun iste basari etiketi yeterli degil, gercek sonucun degerleri gerekir', () => {
  const kosuyla = (t) =>
    calistir('uzun_is_arka_plan', k(t, [UZUN_IS_BAS, uzunIsSonuc('probe-job')]), UZUN_IS).ok;
  assert.equal(kosuyla('Tamam, basariyla bitti.'), false);
  assert.equal(kosuyla('Downloads 13 GB; Videos 4 GB.'), false, 'uydurma sayi');
  assert.equal(kosuyla('Downloads 12 GB; Videos 8 GB.'), true);
  // Beklenen sonuc tanimsizsa (senaryo hatasi) hicbir anlatim gecmez.
  assert.equal(
    calistir('uzun_is_arka_plan', k('Downloads 12 GB; Videos 8 GB.', [UZUN_IS_BAS])).ok,
    false,
  );
});

test('audit: kirik sonda ve kota sifir exit uretemez', async () => {
  const { sondaCikisKodu } = await import('./live-probe.mjs');
  assert.equal(sondaCikisKodu([{ durum: 'tamam', skor: { gecti: true } }]), 0);
  assert.equal(sondaCikisKodu([{ durum: 'tamam', skor: { gecti: false } }]), 1);
  assert.equal(sondaCikisKodu([{ durum: 'zaman_asimi', skor: { gecti: true } }]), 1);
  assert.equal(sondaCikisKodu([], true), 3);
  assert.equal(sondaCikisKodu([]), 1);
});

// ---------------------------------------------------------------- faz 0: sonda araci onarimi

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUST_SRC = join(REPO, 'apps', 'desktop', 'src-tauri', 'src');
const rust = (yol) => readFileSync(join(RUST_SRC, yol), 'utf8');

test('setup uretimi: cargo 0 dondurup dosya birakmazsa (eski dosya dahil) acik hata verir', () => {
  const dizin = mkdtempSync(join(tmpdir(), 'smith-probe-setup-test-'));
  try {
    const cikis = join(dizin, 'yeni.json');
    const taban = join(dizin, 'eski.json');
    let cagri = null;
    const hicbirSey = (...a) => ((cagri = a), { status: 0 });
    assert.throws(() => setupDosyasiUret(cikis, taban, hicbirSey), /setup dosyasi uretilmedi/);
    assert.deepEqual(cagri[1], ['test', '--lib', SETUP_TEST_YOLU, '--', '--exact']);
    assert.equal(cagri[2].env.SMITH_LIVE_PROBE_OUT, cikis);
    assert.equal(cagri[2].env.SMITH_LIVE_PROBE_BASELINE, taban);
    // Taban verilmezse ortamdan sizan eski deger de tasinmaz: yalniz sabit yonerge.
    process.env.SMITH_LIVE_PROBE_BASELINE = 'sizan-deger';
    try {
      assert.throws(() => setupDosyasiUret(cikis, undefined, hicbirSey), /uretilmedi/);
      assert.equal('SMITH_LIVE_PROBE_BASELINE' in cagri[2].env, false);
    } finally {
      delete process.env.SMITH_LIVE_PROBE_BASELINE;
    }
    // Onceki kosudan kalan dosya yanlis yesil uretemez.
    writeFileSync(cikis, '{"eski":1}');
    assert.throws(() => setupDosyasiUret(cikis, taban, hicbirSey), /setup dosyasi uretilmedi/);
    const bos = () => (writeFileSync(cikis, ''), { status: 0 });
    assert.throws(() => setupDosyasiUret(cikis, taban, bos), /cikti yok ya da bos/);
    const iyi = () => (writeFileSync(cikis, '{"setup":{}}'), { status: 0 });
    assert.equal(setupDosyasiUret(cikis, taban, iyi), 0);
    // cargo hata kodu aynen doner.
    assert.equal(
      setupDosyasiUret(cikis, taban, () => ({ status: 101 })),
      101,
    );
    assert.equal(
      setupDosyasiUret(cikis, taban, () => ({ status: null })),
      2,
    );
  } finally {
    rmSync(dizin, { recursive: true, force: true });
  }
});

test('--export-setup: taban istege bagli, fazla ya da eksik arguman hata', () => {
  const kayit = [];
  const uret = (...a) => (kayit.push(a), 0);
  assert.equal(setupDisariAktar(['--export-setup', 'yeni.json'], uret), 0);
  assert.equal(
    setupDisariAktar(['--export-setup', 'yeni.json', '--baseline-setup', 'eski.json'], uret),
    0,
  );
  assert.deepEqual(kayit, [
    ['yeni.json', undefined],
    ['yeni.json', 'eski.json'],
  ]);
  for (const kotu of [
    ['--export-setup'],
    ['--export-setup', 'a', 'b'],
    ['--export-setup', 'a', '--baseline-setup'],
  ]) {
    assert.throws(() => setupDisariAktar(kotu, uret), /gerekli/);
  }
});

test('SETUP_TEST_YOLU Rust kaynak yapisiyla uyumlu (modul tasinirsa burada kirilir)', () => {
  assert.match(
    rust('audio/live/setup.rs'),
    /#\[cfg\(test\)\]\s*mod tests \{[\s\S]*#\[test\]\s*fn sonda_setup_uretimi\(\)/,
  );
  assert.match(rust('audio/live/mod.rs'), /^mod setup;$/m);
  assert.match(rust('audio/mod.rs'), /^mod live;$/m);
  assert.match(rust('lib.rs'), /^pub mod audio;$/m);
  assert.equal(SETUP_TEST_YOLU, 'audio::live::setup::tests::sonda_setup_uretimi');
});

test('klasor boyutlari: Turkce gorunen adlar ve sayi-ad sirasi serbest, degerler karismaz', () => {
  const gercek = 'Downloads: 12 GB; Videos: 8 GB';
  assert.deepEqual(klasorBoyutlari(gercek), { downloads: [12], videos: [8] });
  for (const t of [
    'Downloads 12 GB, Videos 8 GB.',
    'Indirilenler 12 GB ve Videolar 8 GB.',
    'En buyukleri sirasiyla 12 GB ile İndirilenler ve 8 GB ile Videolar.',
    'Baslatiyorum, bitince soylerim.Klasörlerin boyutu İndirilenler 12 GB, Videolar 8 GB.',
  ]) {
    assert.deepEqual(klasorBoyutlari(t), { downloads: [12], videos: [8] }, t);
  }
  assert.deepEqual(klasorBoyutlari('Belgeler 3,5 GB, Resimler 2 GB, Masaüstü 1 GB, Müzik 4 GB.'), {
    documents: [3.5],
    pictures: [2],
    desktop: [1],
    music: [4],
  });
  // Yer degistirmis degerler ya da eksik klasor ayni degildir.
  assert.notDeepEqual(
    klasorBoyutlari('İndirilenler 8 GB, Videolar 12 GB.'),
    klasorBoyutlari(gercek),
  );
  assert.notDeepEqual(klasorBoyutlari('İndirilenler 12 GB.'), klasorBoyutlari(gercek));
});

test('uzun is: Turkce klasor adlari ve ters sira kabul, yer degistirmis deger ret', () => {
  const dene = (t) => calistir('uzun_is_arka_plan', k(t, [UZUN_IS_BAS]), UZUN_IS).ok;
  // Sahada gorulen gercek transkript (sondaki tek kirik): rakam onde, Turkce ad.
  const saha =
    'Baslatıyorum, bitince soylerim.Kullanici klasöründeki en büyük klasörler sirasiyla 12 GB ile İndirilenler ve 8 GB ile Videolar.';
  assert.equal(dene(saha), true);
  assert.equal(dene('İndirilenler 8 GB, Videolar 12 GB.'), false);
  assert.equal(dene('Tamam, bitti.'), false);
});

test('sentetik kare: gecerli, kucuk, 8 kat boyutlu baseline JPEG', () => {
  const jpeg = testKaresiJpeg();
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9]);
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.equal(jpeg.readUInt16BE(sof + 5), 168); // yukseklik
  assert.equal(jpeg.readUInt16BE(sof + 7), 408); // genislik
  assert.ok(jpeg.length < 4096, `kare buyuk: ${jpeg.length}`);
  assert.deepEqual(testKaresiJpeg(), jpeg);
});

test('aracYanitiKur: goruntu anahtari yanittan cikar, parts.inlineData olur', () => {
  assert.deepEqual(aracYanitiKur({ sonuc: 'tamam' }), { response: { sonuc: 'tamam' } });
  const kareli = aracYanitiKur({ durum: 'net kare gonderildi', goruntu: 'ekran_kodu' });
  assert.deepEqual(kareli.response, { durum: 'net kare gonderildi' });
  assert.equal(kareli.parts.length, 1);
  assert.equal(kareli.parts[0].inlineData.mimeType, 'image/jpeg');
  assert.deepEqual(
    [...Buffer.from(kareli.parts[0].inlineData.data, 'base64').subarray(0, 2)],
    [0xff, 0xd8],
  );
  assert.throws(() => aracYanitiKur({ goruntu: 'yok' }), /bilinmeyen sentetik goruntu/);
  assert.deepEqual(aracYanitiKur('metin'), { response: { sonuc: 'metin' } });
});

test('oturumKos: ekrani_net_gor yaniti uretimdeki gibi parts icinde karedir', async () => {
  const yanit = tanim.arac_yanitlari.ekrani_net_gor;
  const r = await sahteyle(
    (ws, m) => {
      if (m.setup) setTimeout(() => ws.yay({ setupComplete: {} }), 1);
      if (m.realtimeInput?.text)
        setTimeout(
          () =>
            ws.yay({
              toolCall: { functionCalls: [{ id: 'e1', name: 'ekrani_net_gor', args: {} }] },
            }),
          3,
        );
      if (m.toolResponse) {
        setTimeout(
          () =>
            ws.yay({
              serverContent: { outputTranscription: { text: 'KOD 4271 MAVI yaziyor.' } },
            }),
          3,
        );
        setTimeout(() => ws.yay({ serverContent: { turnComplete: true } }), 6);
      }
    },
    () => oturumKos(girdi({ aracYaniti: () => yanit })),
  );
  assert.equal(r.durum, 'tamam');
  const gonderilen = SahteWS.son.gonderilen.find((m) => m.toolResponse).toolResponse
    .functionResponses[0];
  assert.equal(gonderilen.response.goruntu, undefined);
  assert.equal(gonderilen.response.durum, 'net kare gonderildi');
  assert.equal(gonderilen.parts[0].inlineData.mimeType, 'image/jpeg');
  assert.equal(r.aracCagrilari[0].response.goruntu, undefined);
});

test('h_ekran: karedeki metni aktaran gecer, goremedim diyen kirilir', () => {
  const iyi = skorla(
    sen('h_ekran'),
    k('Ekranında KOD 4271 MAVİ yazıyor.', [{ name: 'ekrani_net_gor', args: {} }]),
    tanim,
  );
  assert.equal(iyi.gecti, true, JSON.stringify(iyi.kirilan));
  const kotu = skorla(
    sen('h_ekran'),
    k('Maalesef ekran görüntüsüne ulaşamıyorum, tekrar dener misin?', [
      { name: 'ekrani_net_gor', args: {} },
    ]),
    tanim,
  );
  assert.equal(kotu.gecti, false);
  assert.ok(kotu.kirilan.includes('ekran_metni_okundu'));
});

test('sahte ekrani_net_gor yaniti uretimin net_kare_yaniti metnini tasir', () => {
  const kaynak = rust('audio/live/screen_stream.rs');
  const yanit = tanim.arac_yanitlari.ekrani_net_gor;
  assert.ok(kaynak.includes(`"durum": "${yanit.durum}"`), 'durum metni kaynaktan ayrilmis');
  assert.ok(
    kaynak.includes(`"yonlendirme": "${yanit.yonlendirme}"`),
    'yonlendirme metni kaynaktan ayrilmis',
  );
  assert.equal(yanit.goruntu, 'ekran_kodu');
});

// ---------------------------------------------------------------- faz 1: sistem bildirimi senaryolari

/** Sahte sunucu: setup'tan sonra her `realtimeInput.text`/`clientContent` girdisine `cevap(metin)` ile yanit verir. */
function sohbetSunucusu(cevap, ek = () => {}) {
  return (ws, m) => {
    if (m.setup) setTimeout(() => ws.yay({ setupComplete: {} }), 1);
    const metin = m.realtimeInput?.text ?? m.clientContent?.turns?.at(-1)?.parts?.[0]?.text;
    if (metin !== undefined && !(m.clientContent && m.clientContent.turnComplete === false)) {
      const c = cevap(metin);
      if (c.arac) {
        setTimeout(() => ws.yay({ toolCall: { functionCalls: [c.arac] } }), 3);
      } else {
        setTimeout(() => ws.yay({ serverContent: { outputTranscription: { text: c.metin } } }), 3);
        setTimeout(() => ws.yay({ serverContent: { turnComplete: true } }), 6);
      }
    }
    ek(ws, m);
  };
}

const BILDIRIM = '[Sistem bildirimi] Hatirlatma: toplanti 15 dakika sonra basliyor.';

test('oturumKos: sonraki adimlar sirayla gider, her adimin transkripti ayri tutulur', async () => {
  const r = await sahteyle(
    sohbetSunucusu((metin) => ({
      metin: metin.startsWith('[Sistem')
        ? 'Toplanti baslıyor.'
        : metin === 'selam'
          ? 'Selam.'
          : 'Dort.',
    })),
    () =>
      oturumKos(
        girdi({
          sonrakiAdimlar: [
            { ad: 'bildirim', tur: 'bildirim', metin: BILDIRIM },
            { ad: 'devam', tur: 'kullanici', mesaj: 'iki kere iki?' },
          ],
        }),
      ),
  );
  assert.equal(r.durum, 'tamam');
  assert.deepEqual(
    r.adimlar.map((a) => [a.ad, a.tur, a.transkript]),
    [
      ['kullanici', 'kullanici', 'Selam.'],
      ['bildirim', 'bildirim', 'Toplanti baslıyor.'],
      ['devam', 'kullanici', 'Dort.'],
    ],
  );
  // Adim sinirinda satir sonu: cumle kurallari son cumleyi yapismis metinde aramaz.
  assert.equal(r.transkript, 'Selam.\nToplanti baslıyor.\nDort.');
  assert.equal(r.adimlar[1].metin, BILDIRIM);
  // Kullanici turu realtime kipinde, bildirim varsayilan realtime cercevesiyle gider.
  const metinler = SahteWS.son.gonderilen
    .filter((m) => m.realtimeInput)
    .map((m) => m.realtimeInput.text);
  assert.deepEqual(metinler, ['selam', BILDIRIM, 'iki kere iki?']);
  assert.ok(r.adimlar.every((a) => a.gonderim_ms !== null));
});

test('oturumKos: bildirim kipi client ise clientContent + turnComplete, kullanici turu etkilenmez', async () => {
  await sahteyle(
    sohbetSunucusu(() => ({ metin: 'Tamam.' })),
    () =>
      oturumKos(
        girdi({
          bildirimKipi: 'client',
          sonrakiAdimlar: [{ ad: 'bildirim', tur: 'bildirim', metin: BILDIRIM }],
        }),
      ),
  );
  const gonderilen = SahteWS.son.gonderilen;
  assert.deepEqual(gonderilen[1], { realtimeInput: { text: 'selam' } });
  assert.deepEqual(gonderilen[2], {
    clientContent: { turns: [{ role: 'user', parts: [{ text: BILDIRIM }] }], turnComplete: true },
  });
  assert.deepEqual(metinCercevesi('x', 'realtime'), { realtimeInput: { text: 'x' } });
});

test('oturumKos: bekle=ilk_ses adimi model konusurken gider, kesinti adima islenir', async () => {
  const r = await sahteyle(
    (ws, m) => {
      if (m.setup) setTimeout(() => ws.yay({ setupComplete: {} }), 1);
      if (m.realtimeInput?.text === 'selam') {
        const ses = { inlineData: { mimeType: 'audio/pcm', data: 'AAAA' } };
        setTimeout(() => ws.yay({ serverContent: { modelTurn: { parts: [ses] } } }), 3);
        // Bildirim gelmeden tur bitmez: konusma suruyor.
        setTimeout(
          () => ws.yay({ serverContent: { outputTranscription: { text: 'Uzun anlatim ' } } }),
          5,
        );
      }
      if (m.realtimeInput?.text === BILDIRIM) {
        setTimeout(() => ws.yay({ serverContent: { interrupted: true } }), 2);
        setTimeout(
          () => ws.yay({ serverContent: { outputTranscription: { text: 'Fatura.' } } }),
          4,
        );
        setTimeout(() => ws.yay({ serverContent: { turnComplete: true } }), 6);
      }
    },
    () =>
      oturumKos(
        girdi({
          sonrakiAdimlar: [
            { ad: 'bildirim', tur: 'bildirim', bekle: 'ilk_ses', gecikme_ms: 5, metin: BILDIRIM },
          ],
        }),
      ),
  );
  assert.equal(r.durum, 'tamam');
  assert.deepEqual(
    r.adimlar.map((a) => [a.ad, a.kesildi]),
    [
      ['kullanici', false],
      ['bildirim', true],
    ],
  );
  assert.equal(r.adimlar[0].ses_parca, 1);
  assert.equal(r.adimlar[0].transkript, 'Uzun anlatim ');
  assert.equal(r.adimlar[1].transkript, 'Fatura.');
  assert.deepEqual(
    skorla(
      { id: 'x', kurallar: [{ kural: 'konusma_kesilmedi' }], haric: [] },
      { transkript: r.transkript, aracCagrilari: [], adimlar: r.adimlar },
      tanim,
    ).kirilan.filter((id) => id === 'konusma_kesilmedi'),
    ['konusma_kesilmedi'],
  );
});

test('oturumKos: arac yaniti bildirimden once/sonra ayrilir (is hala suruyor -> bitti)', async () => {
  const gorulen = [];
  await sahteyle(
    sohbetSunucusu(
      (metin) =>
        metin.startsWith('[Sistem')
          ? { metin: 'Bitti.' }
          : { arac: { id: 'c1', name: 'arka_plan_sonuc', args: { is_id: 'j' } } },
      (ws, m) => {
        if (m.toolResponse) {
          setTimeout(
            () => ws.yay({ serverContent: { outputTranscription: { text: 'Suruyor.' } } }),
            2,
          );
          setTimeout(() => ws.yay({ serverContent: { turnComplete: true } }), 4);
        }
      },
    ),
    () =>
      oturumKos(
        girdi({
          aracYaniti: (ad, _args, bildirimGitti) => (gorulen.push(bildirimGitti), { durum: 'x' }),
          sonrakiAdimlar: [{ ad: 'bildirim', tur: 'bildirim', metin: BILDIRIM }],
        }),
      ),
  );
  assert.deepEqual(gorulen, [false]);
});

test('adim kurallari: adim_metni icerir/icermez/kelime, konusma_kesilmedi, hatirlatma_kuruldu', () => {
  const adimlar = [
    { ad: 'bildirim', transkript: 'Toplantı 15 dakika sonra başlıyor.', kesildi: false },
    { ad: 'devam', transkript: 'Dört.', kesildi: false },
  ];
  const kosu = { transkript: '', aracCagrilari: [], adimlar };
  const adim = (p) => KURALLAR.adim_metni(kosu, p);
  assert.equal(adim({ adim: 'bildirim', icerir: ['toplanti'], max_kelime: 25 }).ok, true);
  assert.equal(adim({ adim: 'bildirim', icerir: ['fatura'] }).ok, false);
  assert.equal(adim({ adim: 'bildirim', icerir: ['toplanti'], max_kelime: 3 }).ok, false);
  assert.equal(adim({ adim: 'devam', icerir: [['dort', '4']], icermez: ['toplanti'] }).ok, true);
  assert.equal(adim({ adim: 'bildirim', icermez: ['dakika'] }).ok, false);
  assert.equal(adim({ adim: 'yok' }).ok, false);
  assert.equal(KURALLAR.adim_metni({ transkript: '', aracCagrilari: [] }, { adim: 'x' }).ok, false);
  assert.equal(KURALLAR.konusma_kesilmedi(kosu).ok, true);
  adimlar[1].kesildi = true;
  assert.equal(KURALLAR.konusma_kesilmedi(kosu).ok, false);

  const kur = (zaman, metin = 'toplantiyi') => ({
    transkript: '',
    aracCagrilari: [{ name: 'hatirlatma_kur', args: { zaman, metin } }],
  });
  const p = { zaman: '2026-10-04T09:00:00+03:00', metin: 'toplanti' };
  assert.equal(KURALLAR.hatirlatma_kuruldu(kur('2026-10-04T09:00:00+03:00'), p).ok, true);
  assert.equal(KURALLAR.hatirlatma_kuruldu(kur('2026-10-04T06:00:00Z'), p).ok, true, 'ayni an');
  assert.equal(KURALLAR.hatirlatma_kuruldu(kur('2026-10-04T10:00:00+03:00'), p).ok, false);
  assert.equal(KURALLAR.hatirlatma_kuruldu(kur('2026-10-04T09:00:00'), p).ok, false, 'ofsetsiz');
  assert.equal(KURALLAR.hatirlatma_kuruldu(kur('yarin 9'), p).ok, false);
  assert.equal(KURALLAR.hatirlatma_kuruldu(kur('2026-10-04T09:00:00+03:00', 'su'), p).ok, false);
  assert.equal(KURALLAR.hatirlatma_kuruldu({ transkript: '', aracCagrilari: [] }, p).ok, false);
});

test('senaryo dosyasi: bildirim adimlari uretim onegiyle baslar, adim adlari benzersiz', () => {
  const onek = rust('audio/live/bildirim.rs').match(/const ONEK: &str = "([^"]+)";/)?.[1];
  assert.equal(onek, '[Sistem bildirimi]');
  let bildirimli = 0;
  for (const s of tanim.senaryolar) {
    const adlar = ['kullanici', ...(s.sonraki ?? []).map((a) => a.ad)];
    assert.equal(new Set(adlar).size, adlar.length, `${s.id}: adim adlari benzersiz degil`);
    for (const a of s.sonraki ?? []) {
      assert.ok(['bildirim', 'kullanici'].includes(a.tur), `${s.id}/${a.ad}: tur`);
      if (a.tur !== 'bildirim') continue;
      bildirimli++;
      assert.ok(a.metin.startsWith(`${onek} `), `${s.id}: ${a.metin}`);
    }
    for (const r of s.kurallar ?? []) {
      if (r.adim) assert.ok(adlar.includes(r.adim), `${s.id}: kural adimi ${r.adim} yok`);
    }
  }
  assert.ok(bildirimli >= 3, 'j, p ve q bildirim adimi tasimali');
});

test('senaryo dosyasi: uzun is bildirimi, arac yanitlari ve beklenen sonuc ayni degeri tasir', () => {
  const j = sen('j_uzun_is');
  const gercek = j.kurallar.find((r) => r.kural === 'uzun_is_arka_plan').gercek;
  assert.equal(j.arac_yanitlari.arka_plan_sonuc.cikti, gercek);
  assert.ok(j.sonraki[0].metin.includes(gercek));
  assert.ok(j.sonraki[0].metin.includes(j.arac_yanitlari.terminal_calistir.is_id));
  // Bildirimden once is hala suruyor: erken sorgu "bitti" gormez, sonuc yalniz bildirimle gelir.
  assert.equal(j.arac_yanitlari_once.arka_plan_sonuc.durum, 'calisiyor');
  assert.equal(j.arac_yanitlari_once.arka_plan_sonuc.cikti, '');
});

test('senaryo dosyasi: is bitti bildirimi uretimin sablonuyla birebir ayni bicimde', () => {
  const sablon = rust('system_tools.rs').match(
    /"(Arka plan isi \{is_id\} bitti: \{durum\}, \{\}\. Sonucu Cihan'a bildir\.)",/,
  )?.[1];
  assert.ok(sablon, 'system_tools.rs bitis bildirimi sablonu bulunamadi');
  const j = sen('j_uzun_is');
  const gercek = j.kurallar.find((r) => r.kural === 'uzun_is_arka_plan').gercek;
  const beklenen = sablon
    .replace('{is_id}', j.arac_yanitlari.terminal_calistir.is_id)
    .replace('{durum}', 'basarili')
    .replace('{}', gercek);
  assert.equal(j.sonraki[0].metin, `[Sistem bildirimi] ${beklenen}`);
});

test('senaryo dosyasi: saatli senaryolarin yonerge eki uretimin ZAMAN satiri bicimindedir', () => {
  const kaynak = rust('boot_context.rs');
  assert.ok(kaynak.includes('"{gun} {:04}-{:02}-{:02} {:02}:{:02} (yerel saat)"'));
  const saatli = tanim.senaryolar.filter((s) => s.yonerge_eki?.startsWith('[ACILIS BAGLAMI]'));
  assert.ok(saatli.length >= 3);
  for (const s of saatli) {
    assert.match(
      s.yonerge_eki,
      /\nZAMAN: (Pazar|Pazartesi|Sali|Carsamba|Persembe|Cuma|Cumartesi) \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(yerel saat\)/,
      s.id,
    );
  }
});

test('yonergeEkle: sabit yonergeye bosluk + ek, girdi setup degismez', () => {
  const setup = { setup: { systemInstruction: { parts: [{ text: 'SABIT' }] } } };
  const yeni = yonergeEkle(setup, '  ek metin \n');
  assert.equal(yeni.setup.systemInstruction.parts[0].text, 'SABIT ek metin');
  assert.equal(setup.setup.systemInstruction.parts[0].text, 'SABIT');
});

test('arac_arguman ve arac_cagrilmadi: argumanlar norm edilerek sinanir', () => {
  const kur = (args) => k('', [{ name: 'profil_kaydet', args }]);
  const p = { arac: 'profil_kaydet', icerir: { anahtar: ['sehir'], deger: ['izmir'] } };
  assert.equal(KURALLAR.arac_arguman(kur({ anahtar: 'sehir', deger: 'İzmir' }), p).ok, true);
  assert.equal(
    KURALLAR.arac_arguman(kur({ anahtar: 'yasadigi_sehir', deger: 'Izmir' }), p).ok,
    true,
  );
  assert.equal(KURALLAR.arac_arguman(kur({ anahtar: 'ev', deger: 'Izmir' }), p).ok, false);
  assert.equal(KURALLAR.arac_arguman(kur({ anahtar: 'sehir', deger: 'Ankara' }), p).ok, false);
  assert.equal(KURALLAR.arac_arguman(k(''), p).ok, false, 'cagri yoksa kirik');
  const esit = { arac: 'profil_kaydet', esit: { anahtar: 'sehir' } };
  assert.equal(KURALLAR.arac_arguman(kur({ anahtar: 'Sehir' }), esit).ok, true);
  assert.equal(KURALLAR.arac_arguman(kur({ anahtar: 'sehir_adi' }), esit).ok, false);
  const yok = { yok: ['profil_kaydet'] };
  assert.equal(KURALLAR.arac_cagrilmadi(kur({}), yok).ok, false);
  assert.equal(KURALLAR.arac_cagrilmadi(k('', [{ name: 'hafizaya_kaydet' }]), yok).ok, true);
  assert.equal(KURALLAR.arac_cagrilmadi(k(''), yok).ok, true);
});

test('profil senaryolari: yonerge eki uretimin baslik metniyle, kural adlari kayitli', () => {
  const baslik = rust('audio/live/profil.rs').match(/const BASLIK: &str =\s*"([^"]+)";/)?.[1];
  assert.match(baslik, /^CIHAN PROFILI \(/);
  const v = sen('v_profil_bilinen');
  assert.ok(v.yonerge_eki.startsWith(`${baslik}\n- `), 'blok baslikla baslamali');
  assert.ok(v.yonerge_eki.includes('\nSaat dilimi: '));
  // Bilinmeyen senaryoda profil blogu YOK (u_) ve kaydet teklifi soru olarak biter.
  assert.equal(sen('u_profil_bilinmiyor').yonerge_eki, undefined);
  assert.deepEqual(sen('u_profil_bilinmiyor').haric, ['soru_ile_bitmez']);
  const adimli = (t) => ({
    transkript: t,
    aracCagrilari: [],
    adimlar: [{ ad: 'kullanici', transkript: t, kesildi: false }],
  });
  const iyi = skorla(
    sen('u_profil_bilinmiyor'),
    adimli('Sehrini bilmiyorum, istersen kaydedeyim, soyler misin?'),
    tanim,
  );
  assert.equal(iyi.gecti, true, JSON.stringify(iyi.kirilan));
  const uydurma = skorla(sen('u_profil_bilinmiyor'), adimli('Istanbul de yasiyoruz.'), tanim);
  assert.equal(uydurma.gecti, false);
  const bilen = skorla(sen('v_profil_bilinen'), adimli('Istanbul.'), tanim);
  assert.equal(bilen.gecti, true, JSON.stringify(bilen.kirilan));
});

test('yenidenPuanla: adimlar kayitli rapordan puanlamaya tasinir', () => {
  const rapor = {
    meta: {},
    kosular: [
      {
        model: 'm',
        senaryo: 'p_bildirim_bosta',
        durum: 'tamam',
        transkript: 'Iyiyim.Toplanti baslıyor.Dort.',
        arac_cagrilari: [],
        adimlar: [
          { ad: 'kullanici', transkript: 'Iyiyim.', kesildi: false },
          { ad: 'bildirim', transkript: 'Toplanti baslıyor.', kesildi: false },
          { ad: 'devam', transkript: 'Dort.', kesildi: false },
        ],
      },
    ],
  };
  const y = yenidenPuanla(rapor, tanim);
  assert.equal(y.kosular[0].skor.gecti, true, JSON.stringify(y.kosular[0].skor.kirilan));
});
