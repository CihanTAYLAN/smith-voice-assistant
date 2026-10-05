#!/usr/bin/env node
// Smith Live degerlendirme sondasi: sesli modelin (Gemini Live) yonergeye
// uyumunu ve arac davranisini OLCER. Tekrar kosulabilir; her yonerge degisikligi
// ve model karsilastirmasi bununla olculur.
//
// Calisma sekli: her senaryo icin AYRI bir WebSocket oturumu acilir, setup
// cercevesi gonderilir, `setupComplete` beklenir, metin turu gonderilir.
// Model yalniz AUDIO yanit verir; metin `outputAudioTranscription`dan toplanir.
// `toolCall` gelirse cagri kaydedilir ve sahte bir `toolResponse` ile
// yanitlanir ki tur tamamlansin. Sonuc kurallara gore puanlanir.
//
// Girdi: uretimin Rust setup fonksiyonundan JSON. Kaynak metnini ayrisan eski
// live_setup_dump yalniz main tabani icindir; yeni NON_BLOCKING icin kullanilmaz.
// Yeni setup (yalniz sabit yonerge; eski setup'in dinamik eki icin ayrica
// --baseline-setup old.json verilir, A/B):
//   node scripts/live-probe.mjs --export-setup new.json [--baseline-setup old.json]
// LIBCLANG_PATH / CARGO_TARGET_DIR ortamda ayarlanmalidir; yalniz bir Rust testi
// calisir, masaustu veya gercek araclar BASLATILMAZ.
//
// Kullanim:
//   SMITH_GEMINI_KEY=... node scripts/live-probe.mjs --setup setup.json \
//     --model gemini-3.8-live,gemini-3.1-flash-live-preview --repeat 2 --out rapor.json
//   --self-test  ag yok: cok turlu aktarim ve yeni kurallarin regresyon testleri
//   --dry     ag yok: senaryolari ve setup'i dogrular
//   --only a,c yalniz bu senaryo kimlikleri (onek eslesmesi)
//   --rescore rapor.json   ag yok: kayitli transkriptleri guncel kurallarla
//                          yeniden puanlar (kota harcamaz), --out ile yazar
//   --text-mode realtime|client   metin turu cercevesi (varsayilan realtime:
//                          realtimeInput.text; client: clientContent+turnComplete)
//   --bildirim-kipi realtime|client   senaryolardaki sistem bildirimi adimlarinin
//                          cercevesi (masaustu enjeksiyon bicimi olcumu)
//   --strip-behavior       arac bildirimlerinden `behavior` alanini siler (bir
//                          model bu alani reddederse)
//
// ANAHTAR: yalniz `process.env.SMITH_GEMINI_KEY`. Hicbir yere yazdirilmaz,
// loglanmaz; hata metinleri `maskele` ile gecer.
//
// Puanlama saf fonksiyonlardir (`skorla`, `ozetle`) ve `live-probe.test.mjs`
// ile sinanir. Turkce eslesme `norm` ile ASCII'ye katlanmis metin uzerinde
// yapilir: desenler ASCII yazilir ("yetenegim", "yapamam"). Kaynakta
// diakritik yalniz `norm` icindeki katlama tablosunda ve cumle ayirici
// siniflarinda bulunur.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  bekle,
  dogruMu,
  kotaSiniriMi,
  maskele,
  setupDosyasiUret,
  testKaresiJpeg,
  WS_TABAN,
} from './live-probe-common.mjs';

// ---------------------------------------------------------------- metin yardimcilari

const TR_KATLA = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

/** Turkce kucuk harf + ASCII katlama + kesme isaretlerini silme. */
export function norm(s) {
  return String(s ?? '')
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşüâîû]/g, (c) => TR_KATLA[c])
    .replace(/[’‘'`´]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cumlelere boler (. ! ? ... ve satir sonu). */
export function cumleler(t) {
  return String(t ?? '')
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const SORU_EKLERI = new Set([
  'mi',
  'mu',
  'misin',
  'musun',
  'miyim',
  'miyiz',
  'misiniz',
  'musunuz',
  'midir',
  'mudur',
  'miydi',
  'muydu',
  'miymis',
]);

const KAPANIS_KALIPLARI = [
  'ne yapmami istersin',
  'baska bir sey var mi',
  'baska bir konu',
  'nasil yardimci olabilirim',
  'yardimci olabilecegim',
  'yardimci olabilir miyim',
];

/** Bir cumle soru mu: '?' ile biter ya da son kelime soru eki. */
export function soruCumlesi(c) {
  const s = String(c ?? '')
    .trim()
    .replace(/["'”’)\]\s]+$/, '');
  if (!s) return false;
  if (s.endsWith('?')) return true;
  const kelimeler = norm(s)
    .replace(/[^a-z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/);
  return SORU_EKLERI.has(kelimeler[kelimeler.length - 1]);
}

/** Cevap soruyla mi bitiyor (son cumle soru ya da yasak kapanis kalibi). */
export function soruyla_biter(t) {
  const c = cumleler(t);
  if (!c.length) return false;
  const son = c[c.length - 1];
  if (soruCumlesi(son)) return true;
  const n = norm(son);
  return KAPANIS_KALIPLARI.some((k) => n.includes(k));
}

export function kelimeSayisi(t) {
  const s = String(t ?? '').trim();
  return s ? s.split(/\s+/).length : 0;
}

/** Rakamlari ve sesli Turkce sayilari ayni bicimde okur (47,4 / kirk yedi virgul dort). */
export function sayilariBul(metin) {
  const birler = {
    sifir: 0,
    bir: 1,
    iki: 2,
    uc: 3,
    dort: 4,
    bes: 5,
    alti: 6,
    yedi: 7,
    sekiz: 8,
    dokuz: 9,
  };
  const onlar = {
    on: 10,
    yirmi: 20,
    otuz: 30,
    kirk: 40,
    elli: 50,
    altmis: 60,
    yetmis: 70,
    seksen: 80,
    doksan: 90,
  };
  const sozluk = { ...birler, ...onlar };
  const n = norm(metin);
  const degerler = [...n.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(',', '.')));
  const kelimeler = n.replace(/\d+(?:[.,]\d+)?/g, '#').split(/[^a-z#]+/);
  for (let i = 0; i < kelimeler.length; i++) {
    if (!(kelimeler[i] in sozluk) && kelimeler[i] !== 'yuz' && kelimeler[i] !== 'bin') continue;
    let toplam = 0,
      parca = 0;
    for (; i < kelimeler.length; i++) {
      const w = kelimeler[i];
      if (w in sozluk) parca += sozluk[w];
      else if (w === 'yuz') parca = (parca || 1) * 100;
      else if (w === 'bin') {
        toplam += (parca || 1) * 1000;
        parca = 0;
      } else break;
    }
    let sayi = toplam + parca;
    if (kelimeler[i] === 'virgul' || kelimeler[i] === 'nokta') {
      let ondalik = '';
      while (kelimeler[i + 1] in birler) ondalik += birler[kelimeler[++i]];
      if (ondalik) sayi += Number(`0.${ondalik}`);
    }
    // 'bir ...' artikeli tek basina sayi kaniti sayilmaz.
    if (sayi !== 1 || /^(gb|gigabayt)$/.test(kelimeler[i] ?? ''))
      degerler.push(Number(sayi.toFixed(6)));
  }
  return degerler;
}

/** Senaryo gecmisi gercek clientContent turns olur; yonergeye gomulmez. */
export function gecmisTurlari(gecmis = []) {
  if (!Array.isArray(gecmis)) throw new Error('gecmis dizi olmali');
  return gecmis.map((t) => {
    const role = t.role === 'assistant' ? 'model' : t.role;
    if (!['user', 'model'].includes(role) || typeof t.text !== 'string' || !t.text.trim()) {
      throw new Error('gecmis turu role=user|assistant|model ve text gerektirir');
    }
    return { role, parts: [{ text: t.text }] };
  });
}

function yanitNesnesi(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : { sonuc: v };
}

/** Senaryo dosyasinin `goruntu` anahtarinin karsiligi: adi verilen sentetik kare. */
export const SENTETIK_GORUNTULER = {
  ekran_kodu: () => ({
    mimeType: 'image/jpeg',
    data: testKaresiJpeg().toString('base64'),
  }),
};

/**
 * Senaryo yaniti -> tel yaniti. `goruntu` anahtari yanit nesnesinden cikar ve
 * uretimdeki gibi `FunctionResponse.parts[].inlineData` olur (`net_kare_cercevesi`);
 * model karenin adini degil yalniz kareyi gorur.
 */
export function aracYanitiKur(ham) {
  const { goruntu, ...response } = yanitNesnesi(ham);
  if (goruntu === undefined) return { response };
  const kare = SENTETIK_GORUNTULER[goruntu];
  if (!kare) throw new Error(`bilinmeyen sentetik goruntu: ${goruntu}`);
  return { response, parts: [{ inlineData: kare() }] };
}

// ---------------------------------------------------------------- kural kutuphanesi

// Ret kaliplari (norm edilmis metinde). Gozlenen kusurlar: "grafiksel pencere
// olusturma yetenegim bulunmuyor", "guvenlik ilkelerim geregi yurutemem".
const RET_KALIPLARI = [
  /\byetenegim (bulunmuyor|yok)\b/,
  /\byeteneg\w* sahip degil/,
  /\byetkim yok\b/,
  /\byapamam\b/,
  /\byapamiyorum\b/,
  /\byapamayacagim\b/,
  /\byapamayiz\b/,
  /\byurutemem\b/,
  /\byurutemiyorum\b/,
  /\byurutemeyecegim\b/,
  /\bmumkun degil\b/,
  /\bmumkun olmuyor\b/,
  /\berisimim (yok|bulunmuyor)\b/,
  /\berisemem\b/,
  /\berisemiyorum\b/,
  /\bguvenlik (ilke|politika|kural)\w*/,
  /\bkapsam(i|im)? disinda\b/,
  /\bimkanim yok\b/,
  /\bimkansiz\b/,
  /\bdesteklemiyorum\b/,
  /\byardimci olamam\b/,
  /\byardimci olamiyorum\b/,
];

// Resmi ikinci cogul hitap. norm edilmis metin (i/u katlamali): "-siniz/-sunuz"
// fiil ekleri, "-iniz/-unuz" iyelik/emir ekleri, ayri "siz" kelimeleri.
// Yanlis pozitif savunmasi: kelime SONU capasi + kucuk istisna listesi.
// "-siz" EKI tasiyan sozcukler (sessiz, sorunsuz, basarisiz) ve "deniz"
// eslesmez, cunku desen "siz" ile biten degil ayri "siz" kelimesini ve
// "iniz/unuz/siniz/sunuz" sonlarini arar. KNOWN LIMIT: "-iniz/-unuz" ile biten
// hitap disi sozcuk varsa (listede olmayan) yanlis pozitif verir.
const RESMI_KELIMELER = /\b(siz|sizi|size|sizin|sizden|sizde|sizle|sizinle|sizce|sizler)\b/;
// Fiil eki (-siniz/-sunuz), iyelik (-iniz/-unuz, unluyle biten govdede -niz/-nuz)
// ve hal ekli halleri (dosyanizi, sorunuza, isteginizin). "deniz" ailesi
// ("deniz", "denizi", "denizde") govde+niz oldugu icin ayrica elenir.
const RESMI_EKLER =
  /\b[a-z]{2,}(?:siniz|sunuz|iniz|unuz|niz|nuz)(?:in|un|da|de|dan|den|la|le|[aeiu])?\b/g;
const RESMI_ISTISNA = ['seksiniz', 'deniz', 'henuz'];

export function resmiHitapBul(t) {
  const n = norm(t);
  const bulunan = [];
  const k = n.match(RESMI_KELIMELER);
  if (k) bulunan.push(k[0]);
  for (const m of n.matchAll(RESMI_EKLER)) {
    if (m[0] !== 'organize' && !RESMI_ISTISNA.some((i) => m[0].startsWith(i))) bulunan.push(m[0]);
  }
  return bulunan;
}

// Cihan'dan UCUNCU SAHIS olarak soz: iyelik/hal ekli ("Cihan'in") ya da unvanli
// ("Cihan Bey"). Hitap hali ("Cihan, ...") serbest.
const UCUNCU_SAHIS =
  /\bcihan(in|un|a|e|i|u|da|de|dan|den|la|le|ya|ye)\b|\bcihan (bey|taylan|hanim|abi)\b/;

// Windows'un Ingilizce ve Turkce gorunen bilinen klasor adlari (norm edilmis).
// Model "Downloads"u "Indirilenler" diye Turkcelestirebilir; ikisi de dogrudur.
const KLASOR_ADLARI = {
  downloads: ['downloads', 'indirilenler'],
  videos: ['videos', 'videolar'],
  documents: ['documents', 'belgeler'],
  pictures: ['pictures', 'resimler'],
  desktop: ['desktop', 'masaustu'],
  music: ['music', 'muzik'],
};
const KLASOR_DESENI = new RegExp(`(${Object.values(KLASOR_ADLARI).flat().join('|')})`, 'g');
// Cumlecik ayiricilari: noktalama (ondalik nokta/virgul haric) ve "ve".
const CUMLECIK_AYIRACI = /[;\n]|(?<!\d)[.,]|[.,](?!\d)|\bve\b/;

/**
 * Metindeki klasor -> boyut(lar). Sayi, ayni cumlecikteki klasore baglanir; sira
 * onemsizdir: "12 GB ile Indirilenler ve 8 GB ile Videolar" ile "Downloads: 12 GB;
 * Videos: 8 GB" ayni sonucu verir. Klasoru belirsiz (hic ya da birden cok) cumlecik
 * hicbir klasore sayi baglamaz.
 */
export function klasorBoyutlari(metin) {
  const sonuc = {};
  for (const parca of norm(metin).split(CUMLECIK_AYIRACI)) {
    const adlar = new Set(
      [...parca.matchAll(KLASOR_DESENI)].map((m) =>
        Object.keys(KLASOR_ADLARI).find((ad) => KLASOR_ADLARI[ad].includes(m[1])),
      ),
    );
    if (adlar.size !== 1) continue;
    (sonuc[[...adlar][0]] ??= []).push(...sayilariBul(parca));
  }
  return sonuc;
}

const KAPSAM_KATEGORILERI = {
  ekran: /\bekran|\bgoruntu/,
  hafiza: /\bhafiza|\bhatirla|\bhatir\b|\bnot al|\bkaydet|\bunutma/,
  internet_web: /\binternet|\bweb\b|\barastir|\bhaber|\bsite\b/,
  bilgisayar_terminal_dosya:
    /\bbilgisayar|\bterminal|\bdosya|\bpowershell|\buygulama|\bkomut|\bsistem/,
  kod_claude_ajan: /\bkod|\bclaude|\bajan|\bcodex|\byazilim/,
  pano_gorev: /\bpano|\bgorevler|\bgorev (ver|yaz|ata|ekle|takip)|\bekip|\bmission/,
};

const ISBIRLIGI =
  /\b(calisalim|calisabiliriz|calisiriz|baslayalim|baslayabiliriz|birlikte|hazirim|olur\b|dinliyorum|anlat|bakalim|yapalim|konusalim|uzerinde calis|uzerine)/;

const HATA_KABULU =
  /\b(hata|yanlis|yanil|hakli|ozur|pardon|kusur|kacirdim|toparla|duzelt|eksik|dikkat)/;

const DUZELTME = [
  /\bdogrusu\b/,
  /\bsimit degil\b/,
  /\bsmith (olacak|olmali|demek|diye)\b/,
  /\b(ad|isim)(im|i)m? smith\b/,
  /\bdemek istedin\b/,
];

// Yalniz yonergenin acikca yasakladigi kaliplar. Genis "goremiyorum" ARANMAZ:
// sonda ekran karesi (video) AKITMAZ, model icerik icin durust olarak "tam
// goremiyorum" diyebilir; bu probun bir yapayligidir, model kusuru degil.
const EKRAN_INKAR = /\bekran\w* goremiyorum|\bgoruntu bende yok|\bekran goruntusu\b.*\bgonder/;

const YASAK_ACILIS = /^(harika|super|mukemmel|kesinlikle|elbette|tabii ki|memnuniyetle|ne guzel)\b/;
const ARA_RAPOR = /\b(bakiyorum|kontrol ediyorum|hemen ilgileniyorum)\b/;

const ok = (ayrinti = '') => ({ ok: true, ayrinti });
const kirik = (ayrinti) => ({ ok: false, ayrinti });

/**
 * Kural tanimlari. Her kural: ({ transkript, aracCagrilari }, parametreler) ->
 * { ok, ayrinti }. `grup`: 'cekirdek' (baslik orani) | 'ek' (bilgi).
 */
export const KURALLAR = {
  turkce_konus: (k) => {
    // Kod/ozel ad tek basina ihlal degil; Ingilizce cumle iskeleti aranir.
    const m = norm(k.transkript.replace(/```[\s\S]*?```|`[^`]*`/g, '')).match(
      /\b(?:i (?:need|will|can|cannot|cant|have|am|should|dont)|let me|you (?:can|need|should|have|are)|(?:the|this|that) [a-z ]{0,45}\b(?:is|are|was|will|has)|here (?:is|are))\b/,
    );
    return m ? kirik(`Ingilizce cumle: ${m[0]}`) : ok();
  },
  sayi_sadakati: (k) => {
    const sayilar = sayilariBul(k.transkript);
    // Bu senaryo yalniz bos alani sorar; toplam alani bos diye aktarmak da kirilir.
    const yanlis = sayilar.filter((n) => ![47, 47.4].includes(n));
    return sayilar.some((n) => n === 47 || n === 47.4) && !yanlis.length
      ? ok(`sayilar: ${sayilar.join(', ')}`)
      : kirik(`47.4 GB bos alan bekleniyor; sayilar: ${sayilar.join(', ') || '(yok)'}`);
  },
  sesli_yanit: (k) =>
    k.ses_parca > 0 && !/^[\s.\u2026]*$/.test(k.transkript)
      ? ok()
      : kirik('sesli ve anlamli cevap zorunlu'),
  // Uzun is: arka planda baslatilir (is_id doner), model takip ederse AYNI is_id ile,
  // sonuc ise sistem bildirimi ya da arac yoluyla gelir; anlatilan degerler `gercek`
  // (bildirimdeki ve arac ciktisindaki metin) ile eslesmeli, hatirlamaya guvenilmez.
  uzun_is_arka_plan: (k, p) => {
    const calls = k.aracCagrilari ?? [];
    const bas = calls.find(
      (c) => c.name === 'terminal_calistir' && c.args?.arka_planda === true && c.response?.is_id,
    );
    if (!bas) return kirik('terminal_calistir arka_planda=true ile baslatilmali (is_id donmeli)');
    if (calls.some((c) => c.name === 'arka_plan_sonuc' && c.args?.is_id !== bas.response.is_id)) {
      return kirik('arka_plan_sonuc baska bir is_id ile cagrildi');
    }
    const gercek = klasorBoyutlari(p.gercek ?? '');
    const anlatilan = klasorBoyutlari(k.transkript);
    const adlar = Object.keys(gercek);
    return adlar.length > 0 &&
      adlar.every(
        (ad) =>
          gercek[ad].length === 1 &&
          anlatilan[ad]?.length === 1 &&
          gercek[ad][0] === anlatilan[ad][0],
      )
      ? ok()
      : kirik('klasor boyutlari gercek sonucla eslesmeli');
  },
  // Cok adimli senaryoda bir adimin (`sonraki[].ad`) transkripti: `icerir` her giris
  // (dizi ise herhangi biri) gecmeli, `icermez` hicbiri gecmemeli, `max_kelime` asilmamali.
  adim_metni: (k, p) => {
    const adim = (k.adimlar ?? []).find((a) => a.ad === p.adim);
    if (!adim) return kirik(`adim yok: ${p.adim}`);
    const n = norm(adim.transkript);
    const gecer = (g) => [g].flat().some((x) => n.includes(norm(x)));
    const adlandir = (g) => [g].flat().join('|');
    const eksik = (p.icerir ?? []).filter((g) => !gecer(g));
    if (eksik.length) return kirik(`${p.adim}: eksik ${eksik.map(adlandir).join(', ')}`);
    const fazla = (p.icermez ?? []).filter(gecer);
    if (fazla.length) return kirik(`${p.adim}: istenmeyen ${fazla.map(adlandir).join(', ')}`);
    const w = kelimeSayisi(adim.transkript);
    return w <= (p.max_kelime ?? Infinity)
      ? ok(`${w} kelime`)
      : kirik(`${p.adim}: ${w} kelime (en fazla ${p.max_kelime})`);
  },
  // `hatirlatma_kur` cagrisi: ofsetli ISO zaman, beklenen ani `tolerans_dk` icinde
  // (modelin "yarin 9'da"yi acilis baglamindaki saate gore cevirmesi), metin eslesmesi.
  hatirlatma_kuruldu: (k, p) => {
    const c = (k.aracCagrilari ?? []).find((x) => x.name === 'hatirlatma_kur');
    if (!c) return kirik('hatirlatma_kur cagrilmadi');
    const zaman = String(c.args?.zaman ?? '');
    if (!/(?:Z|[+-]\d\d:\d\d)$/.test(zaman) || !Number.isFinite(Date.parse(zaman))) {
      return kirik(`zaman ofsetli ISO 8601 degil: ${zaman || '(yok)'}`);
    }
    const fark = Math.abs(Date.parse(zaman) - Date.parse(p.zaman)) / 60000;
    if (fark > (p.tolerans_dk ?? 2)) {
      return kirik(`zaman ${zaman}, beklenen ${p.zaman} (fark ${Math.round(fark)} dk)`);
    }
    if (p.metin && !norm(c.args?.metin).includes(norm(p.metin))) {
      return kirik(`metin '${c.args?.metin}' '${p.metin}' icermiyor`);
    }
    return ok(zaman);
  },
  // Arac cagrisinin argumani: `esit` alanlar birebir (norm), `icerir` alanlar verilen
  // metni (dizi ise herhangi birini) icermeli. Cagri yoksa kirik.
  arac_arguman: (k, p) => {
    const cagri = (k.aracCagrilari ?? []).find((c) => c.name === p.arac);
    if (!cagri) return kirik(`${p.arac} cagrilmadi`);
    const deger = (alan) => norm(String(cagri.args?.[alan] ?? ''));
    for (const [alan, beklenen] of Object.entries(p.esit ?? {})) {
      if (deger(alan) !== norm(beklenen)) {
        return kirik(`${p.arac}.${alan}='${cagri.args?.[alan]}' beklenen '${beklenen}'`);
      }
    }
    for (const [alan, beklenen] of Object.entries(p.icerir ?? {})) {
      if (![beklenen].flat().some((b) => deger(alan).includes(norm(b)))) {
        return kirik(`${p.arac}.${alan}='${cagri.args?.[alan]}' '${[beklenen].flat()}' icermiyor`);
      }
    }
    return ok();
  },
  arac_cagrilmadi: (k, p) => {
    const yasak = (k.aracCagrilari ?? []).filter((c) => p.yok.includes(c.name)).map((c) => c.name);
    return yasak.length ? kirik(`yasak arac cagrildi: ${yasak.join(', ')}`) : ok();
  },
  konusma_kesilmedi: (k) => {
    const kesilen = (k.adimlar ?? []).filter((a) => a.kesildi).map((a) => a.ad);
    return kesilen.length ? kirik(`konusma kesildi: ${kesilen.join(', ')}`) : ok();
  },
  // Sentetik kare uretimdeki gibi arac yanitinin parts'inda gider; model kareyi
  // okuduysa transkriptte kare metni gecer (ekran probunun `dogruMu` olcusu).
  ekran_metni_okundu: (k) =>
    dogruMu(k.transkript) ? ok() : kirik('karedeki "KOD 4271 MAVI" metni aktarilmadi'),
  sonuc_uydurma_yok: (k) => {
    const n = norm(k.transkript);
    const iddialar = [...n.matchAll(/\b(basarili|sorunsuz|tamamlandi|gecti)\b/g)].filter(
      (m) =>
        !/^\s+(?:degil|olmadi|olmadig|oldugunu soyleyem|diyem)/.test(
          n.slice(m.index + m[0].length),
        ),
    );
    if (iddialar.length) return kirik(`kanitsiz basari: ${iddialar.map((m) => m[0]).join(', ')}`);
    if (
      /\b\d{1,4}[-/:.]\d{1,2}(?:[-/:.]\d{1,4})?\b|\b(?:pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar|ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)\b/.test(
        n,
      )
    )
      return kirik('sonuc yokken tarih veya saat aktarildi');
    // Ekli halleri de kabul eder ("sonucu alamadim", "tarih bilgisini alamadim", "zaman
    // asimina ugradi"): durust olumsuz cevap ek yuzunden kirilmasin.
    return /\b(?:bitmedi|basarisiz|basarili degil|tamamlanmadi|sonuc\w* (?:yok|alinamadi|alamadim|alamiyorum)|(?:yanit|tarih\w*|bilgi\w*) (?:alamiyorum|alamadim|alinamadi|alinamiyor)|yanit vermiyor|zaman asimi\w*|iptal edildi)\b/.test(
      n,
    )
      ? ok()
      : kirik('bitmedi/basarisiz/sonuc yok acikca soylenmeli');
  },
  agir_kod_gorevi: (k) => {
    const c = k.aracCagrilari ?? [];
    if (c.some((a) => a.name === 'terminal_calistir'))
      return kirik('agir kod isi terminale verildi');
    return c.some((a) => a.name === 'kod_gorevi_ver') ||
      /(?:claude|kod (?:gorevi|ajani)|ozellik|kod_gorevi_ver).{0,70}(?:acik degil|aktif degil|kapali|etkin degil|etkinlestirilmemis)/.test(
        norm(k.transkript),
      )
      ? ok()
      : kirik('kod_gorevi_ver veya ozelligin kapali oldugunu bildirme bekleniyor');
  },
  ret_yok: (k) => {
    const n = norm(k.transkript);
    const bulunan = RET_KALIPLARI.map((r) => n.match(r)?.[0]).filter(Boolean);
    return bulunan.length ? kirik(`ret: ${bulunan.join(' | ')}`) : ok();
  },
  resmi_hitap_yok: (k) => {
    const b = resmiHitapBul(k.transkript);
    return b.length ? kirik(`resmi hitap: ${[...new Set(b)].join(', ')}`) : ok();
  },
  dogal_sohbet: (k) => {
    const n = norm(k.transkript);
    if (!n) return kirik('gundelik sohbete yanit yok');
    const bos = [
      'her sey yolunda',
      'islerini kolaylastirmak icin buradayim',
      'yardimci olmak icin buradayim',
      'nasil yardimci olabilirim',
      'ne yapmami istersin',
    ].find((kalip) => n.includes(kalip));
    if (bos) return kirik(`kalip asistan dili: ${bos}`);
    const kelime = kelimeSayisi(k.transkript);
    return kelime <= 35 ? ok(`${kelime} kelime`) : kirik(`gundelik yanit cok uzun: ${kelime}`);
  },
  soru_ile_bitmez: (k) => {
    if (!String(k.transkript).trim()) return ok('yanit yok');
    return soruyla_biter(k.transkript) ? kirik(`soruyla bitti: "${sonParca(k.transkript)}"`) : ok();
  },
  ucuncu_sahis_yok: (k) => {
    const m = norm(k.transkript).match(UCUNCU_SAHIS);
    return m ? kirik(`ucuncu sahis: ${m[0]}`) : ok();
  },
  arac_cagrisi: (k, p) => {
    const ad = (k.aracCagrilari ?? []).map((c) => c.name);
    const hedef = p.herhangi ?? [];
    const uygun = (k.aracCagrilari ?? []).some(
      (c) =>
        hedef.includes(c.name) ||
        (c.name === 'uygulama_ac' &&
          (p.uygulama_adlari ?? []).includes(norm(c.args?.ad).replace(/\.exe$/, ''))),
    );
    return uygun
      ? ok(`cagrilan: ${ad.join(', ')}`)
      : kirik(`beklenen ${hedef.join('|')}, cagrilan: ${ad.length ? ad.join(', ') : '(yok)'}`);
  },
  // Konusulmus (transkriptli) yanit sart: arac cagirip sessiz kalan tur
  // "yanit verdi" sayilmaz (kullanici hicbir sey duymaz).
  yanit_var: (k) => (kelimeSayisi(k.transkript) > 0 ? ok() : kirik('transkript bos (sessiz tur)')),
  arac_cagrisi_yok: (k) => {
    const ad = (k.aracCagrilari ?? []).map((c) => c.name);
    return ad.length ? kirik(`gereksiz arac: ${ad.join(', ')}`) : ok();
  },
  kapsam_kategorileri: (k, p) => {
    const n = norm(k.transkript);
    const gecen = Object.entries(KAPSAM_KATEGORILERI)
      .filter(([, r]) => r.test(n))
      .map(([ad]) => ad);
    const min = p.min ?? 4;
    return gecen.length >= min
      ? ok(`${gecen.length}/6: ${gecen.join(', ')}`)
      : kirik(`${gecen.length}/6 (en az ${min}): ${gecen.join(', ') || '(yok)'}`);
  },
  kisa: (k, p) => {
    const w = kelimeSayisi(k.transkript);
    return w <= (p.max_kelime ?? 30)
      ? ok(`${w} kelime`)
      : kirik(`${w} kelime (en fazla ${p.max_kelime ?? 30})`);
  },
  hata_kabulu: (k) => {
    const m = norm(k.transkript).match(HATA_KABULU);
    return m ? ok(m[0]) : kirik('hata kabulu kalibi yok');
  },
  duzeltme_yok: (k) => {
    const n = norm(k.transkript);
    const m = DUZELTME.map((r) => n.match(r)?.[0]).filter(Boolean);
    return m.length ? kirik(`kullaniciyi duzeltti: ${m.join(' | ')}`) : ok();
  },
  netlestirme_veya_isbirligi: (k) => {
    const sorular = cumleler(k.transkript).filter(soruCumlesi).length;
    const isbirligi = ISBIRLIGI.test(norm(k.transkript));
    if (sorular === 1 || isbirligi) return ok(`soru=${sorular} isbirligi=${isbirligi}`);
    return kirik(
      `soru=${sorular} isbirligi=${isbirligi} (tek netlestirici soru ya da isbirligi bekleniyordu)`,
    );
  },
  ekran_inkar_yok: (k) => {
    const m = norm(k.transkript).match(EKRAN_INKAR);
    return m ? kirik(`ekran inkari: ${m[0]}`) : ok();
  },
  yasak_acilis: (k) => {
    const m = norm(k.transkript).match(YASAK_ACILIS);
    return m ? kirik(`yasak acilis: ${m[0]}`) : ok();
  },
  ara_rapor_yok: (k) => {
    const m = norm(k.transkript).match(ARA_RAPOR);
    return m ? kirik(`ara rapor: ${m[0]}`) : ok();
  },
};

const EK_KURALLAR_VARSAYILAN = ['yasak_acilis', 'ara_rapor_yok'];

function sonParca(t) {
  const s = String(t).trim();
  return s.length > 70 ? `...${s.slice(-70)}` : s;
}

/**
 * Bir kosuyu senaryonun kurallariyla puanlar. Genel kurallar `haric` ile
 * dusurulebilir. `kosu`: { transkript, aracCagrilari: [{name,args}] }.
 */
export function skorla(senaryo, kosu, tanim = {}) {
  const genel = tanim.genel_kurallar ?? [
    'ret_yok',
    'resmi_hitap_yok',
    'soru_ile_bitmez',
    'ucuncu_sahis_yok',
  ];
  const ek = tanim.ek_kurallar ?? EK_KURALLAR_VARSAYILAN;
  const haric = new Set(senaryo.haric ?? []);
  const liste = [
    ...genel.filter((id) => !haric.has(id)).map((id) => ({ id, p: {}, grup: 'cekirdek' })),
    ...(senaryo.kurallar ?? []).map((r) => ({ id: r.kural, p: r, grup: r.grup ?? 'cekirdek' })),
    ...ek.filter((id) => !haric.has(id)).map((id) => ({ id, p: {}, grup: 'ek' })),
  ];
  const kurallar = liste.map(({ id, p, grup }) => {
    const fn = KURALLAR[id];
    if (!fn) throw new Error(`bilinmeyen kural: ${id}`);
    return { id, grup, ...fn(kosu, p) };
  });
  const cekirdek = kurallar.filter((r) => r.grup === 'cekirdek');
  return {
    kurallar,
    gecti: cekirdek.every((r) => r.ok),
    kirilan: kurallar.filter((r) => !r.ok).map((r) => r.id),
  };
}

// ---------------------------------------------------------------- ozet

function medyan(a) {
  const x = a.filter((v) => Number.isFinite(v)).sort((p, q) => p - q);
  if (!x.length) return null;
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : Math.round((x[m - 1] + x[m]) / 2);
}

/** Kosu listesinden model basina ozet. Hata/zaman asimi kosulari ayri sayilir. */
export function ozetle(kosular) {
  const modeller = [...new Set(kosular.map((k) => k.model))];
  const sonuc = {};
  for (const model of modeller) {
    const mk = kosular.filter((k) => k.model === model);
    const puanli = mk.filter((k) => k.skor);
    const sayac = (grup) => {
      let toplam = 0,
        gecen = 0;
      for (const k of puanli) {
        for (const r of k.skor.kurallar.filter((x) => x.grup === grup)) {
          toplam++;
          if (r.ok) gecen++;
        }
      }
      return { toplam, gecen, oran: toplam ? gecen / toplam : null };
    };
    const kirilanSayi = {};
    for (const k of puanli) {
      for (const r of k.skor.kurallar.filter((x) => !x.ok)) {
        kirilanSayi[r.id] = (kirilanSayi[r.id] ?? 0) + 1;
      }
    }
    const senaryolar = {};
    for (const k of puanli) {
      const s = (senaryolar[k.senaryo] ??= { kosu: 0, gecen: 0, kirilan: {} });
      s.kosu++;
      if (k.skor.gecti) s.gecen++;
      for (const id of k.skor.kirilan) s.kirilan[id] = (s.kirilan[id] ?? 0) + 1;
    }
    sonuc[model] = {
      kosu: mk.length,
      puanlanan: puanli.length,
      hatali: mk.length - puanli.length,
      zaman_asimi: mk.filter((k) => k.zaman_asimi).length,
      cekirdek: sayac('cekirdek'),
      ek: sayac('ek'),
      senaryo_gecme: { toplam: puanli.length, gecen: puanli.filter((k) => k.skor.gecti).length },
      kirilan_kural: kirilanSayi,
      senaryolar,
      gecikme_ms: {
        ilk_metin_medyan: medyan(mk.map((k) => k.ilk_metin_ms)),
        ilk_ses_medyan: medyan(mk.map((k) => k.ilk_ses_ms)),
        ilk_arac_medyan: medyan(mk.map((k) => k.ilk_arac_ms)),
        toplam_medyan: medyan(mk.map((k) => k.toplam_ms)),
      },
    };
  }
  return sonuc;
}

// ---------------------------------------------------------------- oturum

/** Metin girdisi cercevesi: `realtime` = realtimeInput.text, `client` = clientContent + turnComplete. */
export function metinCercevesi(metin, kip) {
  return kip === 'client'
    ? { clientContent: { turns: [{ role: 'user', parts: [{ text: metin }] }], turnComplete: true } }
    : { realtimeInput: { text: metin } };
}

/**
 * Tek oturum: setup -> setupComplete -> metin turu -> (toolCall -> toolResponse)* ->
 * turnComplete -> kisa bekleme -> (sonraki adim | kapat). ASLA reject etmez;
 * `durum` alanini doldurur.
 *
 * `sonrakiAdimlar`: ilk turdan sonra sirayla gonderilen adimlar. `tur: 'bildirim'`
 * masaustunun enjekte ettigi sistem bildirimidir (`bildirimKipi` cercevesiyle),
 * `tur: 'kullanici'` normal kullanici turu. `bekle: 'ilk_ses'` adimi onceki turun
 * ILK ses parcasindan `gecikme_ms` sonra, yani model konusurken gonderir; varsayilan
 * onceki turun bitisidir. `aracYaniti(ad, args, bildirimGitti)`.
 */
export function oturumKos({
  key,
  setup,
  mesaj,
  gecmis = [],
  metinKipi,
  zamanAsimiMs,
  aracYaniti,
  sonrakiAdimlar = [],
  bildirimKipi = 'realtime',
  yerlesmeMs = 1500,
  setupZamanAsimiMs = 10000,
}) {
  return new Promise((coz) => {
    const s = {
      durum: 'baslamadi',
      setup_kabul: false,
      transkript: '',
      aracCagrilari: [],
      model_metni: '',
      ilk_metin_ms: null,
      ilk_ses_ms: null,
      ilk_arac_ms: null,
      toplam_ms: null,
      ses_parca: 0,
      zaman_asimi: false,
      kota: false,
      usage_metadata: null,
      kapanis: null,
      hata: null,
    };
    const adimlar = [
      { ad: 'kullanici', tur: 'kullanici', metin: mesaj },
      ...sonrakiAdimlar.map((a) => ({ ...a, metin: a.tur === 'bildirim' ? a.metin : a.mesaj })),
    ];
    s.adimlar = adimlar.map(({ ad, tur, metin }) => ({
      ad,
      tur,
      metin,
      transkript: '',
      ses_parca: 0,
      kesildi: false,
      gonderim_ms: null,
      ilk_ses_ms: null,
    }));
    let ai = 0;
    let bildirimGitti = false;
    let ws;
    let t0 = null;
    let bitti = false;
    let turnTamam = false;
    let aracSonrasiSessiz = false;
    let sonMesajMs = 0;
    let yerlesme = null;
    let genelZaman = null;
    let setupZaman = null;
    const onceki = gecmisTurlari(gecmis);

    const bitir = (durum, ek = {}) => {
      if (bitti) return;
      bitti = true;
      clearTimeout(yerlesme);
      clearTimeout(genelZaman);
      clearTimeout(setupZaman);
      s.durum = durum;
      Object.assign(s, ek);
      if (t0 !== null && s.toplam_ms === null) s.toplam_ms = (sonMesajMs || Date.now()) - t0;
      try {
        ws?.close(1000);
      } catch {
        /* kapali */
      }
      coz(s);
    };
    const hataIleBitir = (durum, metin) => {
      const m = maskele(metin, key);
      bitir(durum, { hata: m, kota: kotaSiniriMi(m) });
    };

    try {
      ws = new WebSocket(`${WS_TABAN}?key=${encodeURIComponent(key)}`);
    } catch (e) {
      hataIleBitir('baglanti_hatasi', String(e?.message ?? e));
      return;
    }
    ws.binaryType = 'arraybuffer';

    setupZaman = setTimeout(
      () =>
        hataIleBitir('setup_zaman_asimi', `setupComplete ${setupZamanAsimiMs} ms icinde gelmedi`),
      setupZamanAsimiMs,
    );
    genelZaman = setTimeout(() => {
      s.zaman_asimi = true;
      bitir('zaman_asimi');
    }, zamanAsimiMs);

    ws.onopen = () => ws.send(JSON.stringify(setup));
    ws.onerror = (ev) =>
      hataIleBitir('ws_hatasi', ev?.message ?? ev?.error?.message ?? 'websocket hatasi');
    ws.onclose = (ev) => {
      if (bitti) return;
      const sebep = maskele(ev.reason ?? '', key);
      s.kapanis = { kod: ev.code, sebep };
      const kota = kotaSiniriMi(sebep, ev.code);
      bitir(
        s.ilk_ses_ms !== null || s.transkript || s.aracCagrilari.length
          ? 'erken_kapandi'
          : 'kapandi',
        { kota },
      );
    };

    const adimGonder = (i) => {
      ai = i;
      turnTamam = false;
      aracSonrasiSessiz = false;
      clearTimeout(yerlesme);
      const a = adimlar[i];
      s.adimlar[i].gonderim_ms = Date.now() - t0;
      // Adim transkriptleri bosluksuz yapismasin: cumle kurallari son cumleyi arar.
      if (i > 0 && s.transkript) s.transkript += '\n';
      if (a.tur === 'bildirim') bildirimGitti = true;
      const kip = a.tur === 'bildirim' ? bildirimKipi : onceki.length ? 'client' : metinKipi;
      ws.send(JSON.stringify(metinCercevesi(a.metin, kip)));
    };

    const turuGonder = () => {
      t0 = Date.now();
      if (onceki.length) {
        ws.send(JSON.stringify({ clientContent: { turns: onceki, turnComplete: false } }));
      }
      adimGonder(0);
    };

    const planla = () => {
      clearTimeout(yerlesme);
      if (!turnTamam) return;
      // transkript turnComplete'ten sonra da gelebilir: son mesajdan itibaren bekle.
      // Arac yanitindan sonra HIC cikti gelmeden gelen turnComplete bayat olabilir:
      // daha uzun bekle (model yanit uretecekse gelir, uretmeyecekse tur biter).
      yerlesme = setTimeout(
        () => (ai < adimlar.length - 1 ? adimGonder(ai + 1) : bitir('tamam')),
        aracSonrasiSessiz ? Math.max(yerlesmeMs, 6000) : yerlesmeMs,
      );
    };

    ws.onmessage = (ev) => {
      let v;
      try {
        const govde = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
        v = JSON.parse(govde);
      } catch {
        return;
      }
      const simdi = Date.now();
      if (v.usageMetadata && typeof v.usageMetadata === 'object') {
        s.usage_metadata = v.usageMetadata;
      }
      if (v.setupComplete !== undefined) {
        s.setup_kabul = true;
        clearTimeout(setupZaman);
        s.durum = 'setup_tamam';
        turuGonder();
        return;
      }
      if (t0 === null) return; // setup oncesi baska mesaj
      sonMesajMs = simdi;
      const gecen = simdi - t0;

      const cagrilar = v.toolCall?.functionCalls;
      if (Array.isArray(cagrilar)) {
        turnTamam = false;
        clearTimeout(yerlesme);
        if (s.ilk_arac_ms === null) s.ilk_arac_ms = gecen;
        for (const c of cagrilar)
          s.aracCagrilari.push({ id: c.id, name: c.name, args: c.args ?? {}, ms: gecen });
        if (s.aracCagrilari.length > 6) {
          bitir('arac_dongusu');
          return;
        }
        const yanitlar = cagrilar.map((c) => {
          const { response, parts } = aracYanitiKur(
            aracYaniti(c.name, c.args ?? {}, bildirimGitti),
          );
          return {
            id: c.id,
            name: c.name,
            response,
            ...(parts ? { parts } : {}),
            ...(setup.setup?.tools?.some((t) =>
              t.functionDeclarations?.some(
                (d) => d.name === c.name && d.behavior === 'NON_BLOCKING',
              ),
            )
              ? { scheduling: 'WHEN_IDLE' }
              : {}),
          };
        });
        for (const yanit of yanitlar) {
          const cagri = s.aracCagrilari.findLast((c) => c.id === yanit.id);
          if (cagri) cagri.response = yanit.response;
        }
        ws.send(JSON.stringify({ toolResponse: { functionResponses: yanitlar } }));
        aracSonrasiSessiz = true; // yanit sonrasi cikti gelmeden gelen turnComplete bayat sayilir
        return;
      }

      const sc = v.serverContent;
      if (!sc) return;
      const parcalar = sc.modelTurn?.parts ?? [];
      for (const p of parcalar) {
        if (p.inlineData?.mimeType?.startsWith('audio/') && p.inlineData.data) {
          s.ses_parca++;
          s.adimlar[ai].ses_parca++;
          if (s.ilk_ses_ms === null) s.ilk_ses_ms = gecen;
          if (s.adimlar[ai].ilk_ses_ms === null) {
            s.adimlar[ai].ilk_ses_ms = gecen;
            const hedef = ai + 1;
            if (adimlar[hedef]?.bekle === 'ilk_ses') {
              setTimeout(
                () => !bitti && ai === hedef - 1 && adimGonder(hedef),
                adimlar[hedef].gecikme_ms ?? 0,
              );
            }
          }
          aracSonrasiSessiz = false;
        } else if (typeof p.text === 'string' && !p.thought) {
          s.model_metni += p.text;
        }
      }
      const cikti = sc.outputTranscription?.text;
      if (typeof cikti === 'string' && cikti) {
        if (s.ilk_metin_ms === null) s.ilk_metin_ms = gecen;
        s.transkript += cikti;
        s.adimlar[ai].transkript += cikti;
        aracSonrasiSessiz = false;
      }
      if (sc.interrupted === true) s.adimlar[ai].kesildi = true;
      if (sc.turnComplete === true) turnTamam = true;
      planla();
    };
  });
}

// ---------------------------------------------------------------- calistirma

export function modelAdi(m) {
  return m.startsWith('models/') ? m : `models/${m}`;
}

function setupHazirla(setup, model, { davranisiSil }) {
  const kopya = structuredClone(setup);
  const alan = kopya.setup ?? kopya;
  if (model) alan.model = modelAdi(model);
  if (davranisiSil) {
    for (const t of alan.tools ?? []) {
      for (const d of t.functionDeclarations ?? []) delete d.behavior;
    }
  }
  return kopya;
}

/**
 * Senaryonun `yonerge_eki`: uretimin dinamik kuyrugu gibi (`sistem_yonergesi`:
 * sabit yonerge + bosluk + ek) yonergenin sonuna eklenir, ornegin acilis
 * baglamindaki saat. Girdi setup'a dokunulmaz.
 */
export function yonergeEkle(setup, ek) {
  const kopya = structuredClone(setup);
  const parca = (kopya.setup ?? kopya).systemInstruction.parts[0];
  parca.text = `${parca.text} ${ek.trim()}`;
  return kopya;
}

function argumanlar(argv) {
  const a = {
    setup: null,
    model: null,
    scenarios: join(dirname(fileURLToPath(import.meta.url)), 'live-probe-scenarios.json'),
    repeat: 1,
    out: null,
    only: null,
    delayMs: 2000,
    timeoutMs: 40000,
    textMode: 'realtime',
    bildirimKipi: 'realtime',
    dry: false,
    davranisiSil: false,
    rescore: null,
  };
  const bayrak = {
    '--rescore': 'rescore',
    '--setup': 'setup',
    '--model': 'model',
    '--scenarios': 'scenarios',
    '--repeat': 'repeat',
    '--out': 'out',
    '--only': 'only',
    '--delay-ms': 'delayMs',
    '--timeout-ms': 'timeoutMs',
    '--text-mode': 'textMode',
    '--bildirim-kipi': 'bildirimKipi',
  };
  for (let i = 0; i < argv.length; i++) {
    const g = argv[i];
    if (g === '--dry') a.dry = true;
    else if (g === '--strip-behavior') a.davranisiSil = true;
    else if (g in bayrak) a[bayrak[g]] = argv[++i];
    else throw new Error(`bilinmeyen arguman: ${g}`);
  }
  for (const k of ['repeat', 'delayMs', 'timeoutMs']) a[k] = Number(a[k]);
  if (!['realtime', 'client'].includes(a.textMode)) throw new Error('--text-mode realtime|client');
  if (!['realtime', 'client'].includes(a.bildirimKipi)) {
    throw new Error('--bildirim-kipi realtime|client');
  }
  return a;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}
const yuzde = (o) => (o === null ? '-' : `${(o * 100).toFixed(0)}%`);
const ms = (v) => (v === null || v === undefined ? '-' : `${v}`);

export function ozetYaz(ozet, yaz = console.log) {
  for (const [model, o] of Object.entries(ozet)) {
    yaz('');
    yaz(`MODEL ${model}`);
    yaz(
      `  kosu ${o.kosu} (puanlanan ${o.puanlanan}, hatali ${o.hatali}, zaman asimi ${o.zaman_asimi})`,
    );
    yaz(
      `  cekirdek kural gecme : ${o.cekirdek.gecen}/${o.cekirdek.toplam} (${yuzde(o.cekirdek.oran)})`,
    );
    yaz(`  ek kural gecme       : ${o.ek.gecen}/${o.ek.toplam} (${yuzde(o.ek.oran)})`);
    yaz(`  senaryo tam gecme    : ${o.senaryo_gecme.gecen}/${o.senaryo_gecme.toplam}`);
    yaz(
      `  gecikme (medyan ms)  : ilk metin ${ms(o.gecikme_ms.ilk_metin_medyan)} | ilk ses ${ms(o.gecikme_ms.ilk_ses_medyan)} | ilk arac ${ms(o.gecikme_ms.ilk_arac_medyan)} | toplam ${ms(o.gecikme_ms.toplam_medyan)}`,
    );
    yaz('  senaryo                    gecen  kirilan kurallar');
    for (const [id, s] of Object.entries(o.senaryolar)) {
      const kirik =
        Object.entries(s.kirilan)
          .map(([k, n]) => `${k}x${n}`)
          .join(', ') || '-';
      yaz(`  ${pad(id, 26)} ${pad(`${s.gecen}/${s.kosu}`, 6)} ${kirik}`);
    }
    const sirali = Object.entries(o.kirilan_kural).sort((p, q) => q[1] - p[1]);
    yaz(`  en cok kirilan kural : ${sirali.map(([k, n]) => `${k}x${n}`).join(', ') || '-'}`);
  }
}

const PUANLANABILIR = new Set(['tamam', 'zaman_asimi', 'arac_dongusu']);

/**
 * Kayitli rapordaki transkriptleri GUNCEL kurallarla yeniden puanlar (ag yok,
 * kota harcamaz). Kural/esik ayari ve eski raporu yeni kurallarla okumak icin.
 */
export function yenidenPuanla(rapor, tanim) {
  const sen = new Map(tanim.senaryolar.map((s) => [s.id, s]));
  for (const kosu of rapor.kosular) {
    delete kosu.skor;
    const s = sen.get(kosu.senaryo);
    if (s && PUANLANABILIR.has(kosu.durum)) {
      kosu.skor = skorla(
        s,
        {
          transkript: kosu.transkript,
          aracCagrilari: kosu.arac_cagrilari,
          ses_parca: kosu.ses_parca,
          adimlar: kosu.adimlar,
        },
        tanim,
      );
    }
  }
  rapor.ozet = ozetle(rapor.kosular);
  rapor.meta = { ...rapor.meta, yeniden_puanlandi: new Date().toISOString() };
  return rapor;
}

/** Yeni prob kurallari ve WS cerceveleri; izinli dosya kapsami icinde test girisi. */
async function probeTestleri() {
  const { default: assert } = await import('node:assert/strict');
  let adet = 0;
  const dene = async (ad, fn) => {
    await fn();
    adet++;
    console.log(`ok ${adet} - ${ad}`);
  };
  const kosu = (transkript, aracCagrilari = []) => ({ transkript, aracCagrilari });
  await dene('sayi: rakam, Turkce ses, yanlis sayi ve bos yanit', () => {
    for (const t of ['47,4 GB bos.', 'Kirk yedi virgul dort gigabayt bos.', '47.4 gigabayt bos.']) {
      assert.equal(KURALLAR.sayi_sadakati(kosu(t)).ok, true, t);
    }
    for (const t of [
      '',
      '29,4 GB bos.',
      'Kirk yedi virgul dort GB, yirmi dokuz virgul dort GB bos.',
      '930,5 GB bos, 47,4 GB toplam.',
      'Bir gigabayt bos.',
    ]) {
      assert.equal(KURALLAR.sayi_sadakati(kosu(t)).ok, false, t);
    }
  });
  await dene('uzun is: bg, kimlik, gercek sonuc birlikte zorunlu', () => {
    const p = { gercek: 'Downloads: 12 GB; Videos: 8 GB' };
    const bas = {
      name: 'terminal_calistir',
      args: { arka_planda: true },
      response: { is_id: 'probe-job' },
    };
    const sonuc = (kimlik) => ({ name: 'arka_plan_sonuc', args: { is_id: kimlik }, response: {} });
    const iyi = kosu('Downloads 12 GB, Videos 8 GB.', [bas]);
    assert.equal(KURALLAR.uzun_is_arka_plan(iyi, p).ok, true);
    assert.equal(KURALLAR.uzun_is_arka_plan(kosu('Tamam.', [bas]), p).ok, false);
    assert.equal(
      KURALLAR.uzun_is_arka_plan(kosu('Downloads 12 GB, Videos 8 GB.', []), p).ok,
      false,
    );
    assert.equal(
      KURALLAR.uzun_is_arka_plan(
        kosu('Downloads 12 GB, Videos 8 GB.', [bas, sonuc('probe-job')]),
        p,
      ).ok,
      true,
    );
    assert.equal(
      KURALLAR.uzun_is_arka_plan(kosu('Downloads 12 GB, Videos 8 GB.', [bas, sonuc('yanlis')]), p)
        .ok,
      false,
    );
  });
  await dene('zaman asimi: basari iddiasi kirilir, olumsuz cevap korunur', () => {
    for (const t of [
      'Testler basarili.',
      'Sorunsuz tamamlandi.',
      'Kontroller gecti.',
      'Testler basarili ama derleme bitmedi.',
    ]) {
      assert.equal(KURALLAR.sonuc_uydurma_yok(kosu(t)).ok, false, t);
    }
    for (const t of [
      'Bitmedi; arka planda tekrar deneyecegim.',
      'Basarili degil.',
      'Tamamlanmadi, sonuc alamadim.',
    ]) {
      assert.equal(KURALLAR.sonuc_uydurma_yok(kosu(t)).ok, true, t);
    }
  });
  await dene('agir kod: terminal kirilir, kod araci veya kapali bilgisi gecer', () => {
    assert.equal(KURALLAR.agir_kod_gorevi(kosu('', [{ name: 'terminal_calistir' }])).ok, false);
    assert.equal(KURALLAR.agir_kod_gorevi(kosu('', [{ name: 'kod_gorevi_ver' }])).ok, true);
    assert.equal(KURALLAR.agir_kod_gorevi(kosu('Kod gorevi ozelligi acik degil.')).ok, true);
  });
  await dene('dil: Ingilizce cumle kirilir, kod ve ozel ad korunur', () => {
    assert.equal(
      KURALLAR.turkce_konus(kosu('I need to check the current screen to see the AI menu options.'))
        .ok,
      false,
    );
    assert.equal(
      KURALLAR.turkce_konus(kosu('PowerShell ile Claude Code durumuna baktim.')).ok,
      true,
    );
    assert.equal(KURALLAR.turkce_konus(kosu('Kod: `let message = "I need help"`.')).ok, true);
  });
  await dene('taskmgr kabul, baska uygulama ve ret kabul degil', () => {
    const p = { herhangi: ['terminal_calistir', 'sistem_durumu'], uygulama_adlari: ['taskmgr'] };
    assert.equal(
      KURALLAR.arac_cagrisi(kosu('', [{ name: 'uygulama_ac', args: { ad: 'taskmgr.exe' } }]), p).ok,
      true,
    );
    assert.equal(
      KURALLAR.arac_cagrisi(kosu('', [{ name: 'uygulama_ac', args: { ad: 'notepad' } }]), p).ok,
      false,
    );
    assert.equal(KURALLAR.ret_yok(kosu('Bunu yapamam.')).ok, false);
  });
  await dene('kapali kod araci durust reddedilebilir, aracsiz genel ret kirilir', () => {
    const tanim = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), 'live-probe-scenarios.json'),
        'utf8',
      ),
    );
    const sen = tanim.senaryolar.find((s) => s.id === 'n_kod_tabani');
    assert.equal(
      skorla(
        sen,
        kosu('Kod gorevi ozelligi aktif degil, tarama yapamiyorum.', [{ name: 'kod_gorevi_ver' }]),
        tanim,
      ).gecti,
      true,
    );
    assert.equal(skorla(sen, kosu('Bunu yapamam.'), tanim).gecti, false);
  });
  await dene('gecmis rolleri dogrulanir', () => {
    assert.deepEqual(gecmisTurlari([{ role: 'assistant', text: 'selam' }]), [
      { role: 'model', parts: [{ text: 'selam' }] },
    ]);
    assert.throws(() => gecmisTurlari([{ role: 'system', text: 'x' }]));
  });
  await dene('WS: gecmis once, test turu sonra, yanit nesnesi ve WHEN_IDLE', async () => {
    const asilWS = globalThis.WebSocket;
    const gonderilen = [];
    globalThis.WebSocket = class {
      constructor() {
        queueMicrotask(() => this.onopen());
      }
      close() {}
      send(raw) {
        const m = JSON.parse(raw);
        gonderilen.push(m);
        const yay = (v) => queueMicrotask(() => this.onmessage({ data: JSON.stringify(v) }));
        if (m.setup) yay({ setupComplete: {} });
        if (m.clientContent?.turnComplete)
          yay({ toolCall: { functionCalls: [{ id: 'x', name: 'derin_dusun' }] } });
        if (m.toolResponse)
          yay({ serverContent: { outputTranscription: { text: 'Bitmedi.' }, turnComplete: true } });
      }
    };
    try {
      const r = await oturumKos({
        key: 'fake',
        setup: {
          setup: {
            tools: [{ functionDeclarations: [{ name: 'derin_dusun', behavior: 'NON_BLOCKING' }] }],
          },
        },
        mesaj: 'test',
        gecmis: [
          { role: 'user', text: 'once' },
          { role: 'assistant', text: 'eski cevap' },
        ],
        metinKipi: 'realtime',
        zamanAsimiMs: 1000,
        yerlesmeMs: 1,
        aracYaniti: () => 'bitmedi',
      });
      assert.equal(r.transkript, 'Bitmedi.');
      assert.deepEqual(gonderilen[1], {
        clientContent: {
          turns: [
            { role: 'user', parts: [{ text: 'once' }] },
            { role: 'model', parts: [{ text: 'eski cevap' }] },
          ],
          turnComplete: false,
        },
      });
      assert.deepEqual(gonderilen[2], {
        clientContent: { turns: [{ role: 'user', parts: [{ text: 'test' }] }], turnComplete: true },
      });
      assert.deepEqual(gonderilen[3].toolResponse.functionResponses[0], {
        id: 'x',
        name: 'derin_dusun',
        response: { sonuc: 'bitmedi' },
        scheduling: 'WHEN_IDLE',
      });
    } finally {
      globalThis.WebSocket = asilWS;
    }
  });
  console.log(`${adet} test gecti`);
  return 0;
}

export function setupDisariAktar(argv, uret = setupDosyasiUret) {
  const taban = argv.length === 4 && argv[2] === '--baseline-setup';
  if (!(argv.length === 2 || taban)) {
    throw new Error('--export-setup <yeni.json> [--baseline-setup <eski.json>] gerekli');
  }
  return uret(argv[1], taban ? argv[3] : undefined);
}

export function sondaCikisKodu(kosular, durduruldu = false) {
  if (durduruldu) return 3;
  return kosular.length > 0 && kosular.every((k) => k.durum === 'tamam' && k.skor?.gecti) ? 0 : 1;
}

export async function main(argv) {
  if (argv[0] === '--export-setup') return setupDisariAktar(argv);
  if (argv.length === 1 && argv[0] === '--self-test') return probeTestleri();
  const a = argumanlar(argv);
  if (a.rescore) {
    const rapor = yenidenPuanla(
      JSON.parse(readFileSync(a.rescore, 'utf8')),
      JSON.parse(readFileSync(a.scenarios, 'utf8')),
    );
    ozetYaz(rapor.ozet);
    if (a.out) {
      writeFileSync(a.out, JSON.stringify(rapor, null, 2));
      console.log(`\nrapor: ${a.out}`);
    }
    return sondaCikisKodu(rapor.kosular, Boolean(rapor.meta.durduruldu));
  }
  if (!a.setup) throw new Error('--setup <dosya> gerekli');
  const tanim = JSON.parse(readFileSync(a.scenarios, 'utf8'));
  const setupHam = JSON.parse(readFileSync(a.setup, 'utf8'));
  let senaryolar = tanim.senaryolar;
  if (a.only) {
    const on = a.only.split(',');
    senaryolar = senaryolar.filter((s) => on.some((o) => s.id.startsWith(o)));
  }
  const varsayilanModel = (setupHam.setup ?? setupHam).model;
  const modeller = a.model
    ? a.model
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    : [varsayilanModel];
  const aracYaniti = (ad) =>
    tanim.arac_yanitlari?.[ad] ?? tanim.arac_yanitlari?.varsayilan ?? { sonuc: 'tamam' };
  // `arac_yanitlari_once`: bildirim gelmeden onceki durum (is hala suruyor).
  const senaryoYaniti = (sen, ad, bildirimGitti) =>
    (bildirimGitti ? undefined : sen.arac_yanitlari_once?.[ad]) ??
    sen.arac_yanitlari?.[ad] ??
    aracYaniti(ad);

  // senaryo kurallari gecerli mi (ag olmadan yakalanir)
  for (const s of senaryolar) {
    gecmisTurlari(s.gecmis);
    skorla(s, { transkript: '', aracCagrilari: [] }, tanim);
  }

  if (a.dry) {
    const alan = setupHam.setup ?? setupHam;
    console.log(
      `dry: ${senaryolar.length} senaryo, modeller ${modeller.join(', ')}, setup arac=${alan.tools?.[0]?.functionDeclarations?.length ?? 0}, yonerge=${alan.systemInstruction?.parts?.[0]?.text?.length ?? 0} karakter`,
    );
    for (const s of senaryolar) console.log(`  ${s.id}: ${s.mesaj}`);
    return 0;
  }

  const key = process.env.SMITH_GEMINI_KEY;
  if (!key) throw new Error('SMITH_GEMINI_KEY ortam degiskeni yok');

  const kosular = [];
  let durduruldu = null;
  const toplam = a.repeat * modeller.length * senaryolar.length;
  let n = 0;
  dis: for (let tekrar = 1; tekrar <= a.repeat; tekrar++) {
    for (const model of modeller) {
      const setup = setupHazirla(setupHam, model, a);
      for (const sen of senaryolar) {
        n++;
        const r = await oturumKos({
          key,
          setup: sen.yonerge_eki ? yonergeEkle(setup, sen.yonerge_eki) : setup,
          mesaj: sen.mesaj,
          gecmis: sen.gecmis,
          metinKipi: a.textMode,
          zamanAsimiMs: sen.zaman_asimi_ms ?? a.timeoutMs,
          aracYaniti: (ad, _args, bildirimGitti) => senaryoYaniti(sen, ad, bildirimGitti),
          sonrakiAdimlar: sen.sonraki,
          bildirimKipi: a.bildirimKipi,
        });
        const kayit = {
          model,
          senaryo: sen.id,
          tekrar,
          mesaj: sen.mesaj,
          gecmis: sen.gecmis ?? [],
          durum: r.durum,
          zaman_asimi: r.zaman_asimi,
          transkript: r.transkript.trim(),
          arac_cagrilari: r.aracCagrilari.map(({ name, args, response, ms: t }) => ({
            name,
            args,
            response,
            ms: t,
          })),
          setup_kabul: r.setup_kabul,
          ilk_metin_ms: r.ilk_metin_ms,
          ilk_ses_ms: r.ilk_ses_ms,
          ilk_arac_ms: r.ilk_arac_ms,
          toplam_ms: r.toplam_ms,
          ses_parca: r.ses_parca,
          adimlar: r.adimlar,
          kapanis: r.kapanis,
          hata: r.hata,
          usage_metadata: r.usage_metadata,
        };
        if (r.model_metni) kayit.model_metni = r.model_metni;
        if (PUANLANABILIR.has(r.durum)) {
          kayit.skor = skorla(
            sen,
            {
              transkript: kayit.transkript,
              aracCagrilari: kayit.arac_cagrilari,
              ses_parca: kayit.ses_parca,
              adimlar: kayit.adimlar,
            },
            tanim,
          );
        }
        kosular.push(kayit);
        const etiket = kayit.skor
          ? kayit.skor.gecti
            ? 'GECTI'
            : `KIRIK ${kayit.skor.kirilan.join(',')}`
          : `HATA ${r.durum}${r.hata ? ` ${r.hata}` : ''}${r.kapanis ? ` kod=${r.kapanis.kod} ${r.kapanis.sebep}` : ''}`;
        console.log(`[${n}/${toplam}] ${pad(model, 30)} ${pad(sen.id, 22)} #${tekrar} ${etiket}`);
        if (r.kota) {
          durduruldu = `kota/1011 hatasi: ${model} ${sen.id} #${tekrar} (${r.hata ?? `kod=${r.kapanis?.kod} ${r.kapanis?.sebep}`})`;
          console.log(`DURDU: ${durduruldu}`);
          break dis;
        }
        if (n < toplam) await bekle(a.delayMs);
      }
    }
  }

  const ozet = ozetle(kosular);
  ozetYaz(ozet);
  if (a.out) {
    const alan = setupHam.setup ?? setupHam;
    const rapor = {
      meta: {
        zaman: new Date().toISOString(),
        modeller,
        tekrar: a.repeat,
        metin_kipi: a.textMode,
        bildirim_kipi: a.bildirimKipi,
        setup_dosyasi: a.setup,
        automatic_activity_detection: alan.realtimeInputConfig?.automaticActivityDetection,
        yonerge_karakter: alan.systemInstruction?.parts?.[0]?.text?.length ?? null,
        arac_sayisi: alan.tools?.[0]?.functionDeclarations?.length ?? null,
        senaryo_sayisi: senaryolar.length,
        planlanan_oturum: toplam,
        yapilan_oturum: kosular.length,
        durduruldu,
      },
      ozet,
      kosular,
    };
    writeFileSync(a.out, JSON.stringify(rapor, null, 2));
    console.log(`\nrapor: ${a.out}`);
  }
  return sondaCikisKodu(kosular, Boolean(durduruldu));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (kod) => process.exit(kod),
    (e) => {
      console.error(`HATA: ${maskele(e?.message ?? e, process.env.SMITH_GEMINI_KEY)}`);
      process.exit(2);
    },
  );
}
