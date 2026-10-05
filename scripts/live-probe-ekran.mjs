#!/usr/bin/env node
// Gemini Live ekran goruntusu aktarim sondasi.
//
// Her kosu ayri bir WebSocket oturumudur. Uretim setup cercevesi --setup ile
// verilir; model ve ekrani_net_gor bildirimi dogrulanir. Sonda API anahtarini
// yalniz process.env.SMITH_GEMINI_KEY'den okur ve hicbir ciktiya yazmaz.
//
// Ornek:
//   node scripts/live-probe-ekran.mjs --setup setup.json --repeat 3
//   node scripts/live-probe-ekran.mjs --setup setup.json --only Y3 --jpeg ekran.jpg --parts 1,2 --repeat 3
//
// Varsayilan plan Y1,Y2,Y3,Y4 sirasi ile uc tur, toplam 12 kosudur. Kosular
// seridir ve aralarinda en az 3 saniye vardir. 429 veya WS 1011 tum plani
// hemen durdurur.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

import {
  bekle,
  dogruMu,
  FONT,
  kotaSiniriMi,
  maskele,
  setupDosyasiUret,
  WS_TABAN,
} from './live-probe-common.mjs';

const MODEL = 'gemini-3.8-live';
const ARAC = 'ekrani_net_gor';
const SORU = 'Ekranimda ne yaziyor?';
const TEST_METNI = 'KOD 4271 MAVI';
const MIME_TYPE = 'image/png';
const YONTEMLER = ['Y1', 'Y2', 'Y3', 'Y4'];

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngParcasi(ad, veri) {
  const tur = Buffer.from(ad, 'ascii');
  const uzunluk = Buffer.alloc(4);
  uzunluk.writeUInt32BE(veri.length);
  const toplam = Buffer.concat([tur, veri]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(toplam));
  return Buffer.concat([uzunluk, toplam, crc]);
}

export function testGoruntusu() {
  const genislik = 640;
  const yukseklik = 240;
  const piksel = Buffer.alloc(genislik * yukseklik * 4, 255);
  const boya = (x, y, w, h, [r, g, b]) => {
    for (let yy = Math.max(0, y); yy < Math.min(yukseklik, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(genislik, x + w); xx++) {
        const i = (yy * genislik + xx) * 4;
        piksel[i] = r;
        piksel[i + 1] = g;
        piksel[i + 2] = b;
      }
    }
  };
  boya(20, 20, 600, 200, [19, 79, 156]);
  boya(32, 32, 576, 176, [235, 244, 255]);

  const yaz = (metin, x, y, olcek) => {
    for (const karakter of metin) {
      const glif = FONT[karakter];
      if (!glif) throw new Error(`fontta olmayan karakter: ${karakter}`);
      for (let satir = 0; satir < glif.length; satir++) {
        for (let sutun = 0; sutun < glif[satir].length; sutun++) {
          if (glif[satir][sutun] === '1')
            boya(x + sutun * olcek, y + satir * olcek, olcek, olcek, [8, 25, 52]);
        }
      }
      x += 6 * olcek;
    }
  };
  yaz('KOD 4271', 80, 48, 10);
  yaz('MAVI', 200, 135, 10);

  const tarama = Buffer.alloc((genislik * 4 + 1) * yukseklik);
  for (let y = 0; y < yukseklik; y++) {
    const hedef = y * (genislik * 4 + 1);
    tarama[hedef] = 0;
    piksel.copy(tarama, hedef + 1, y * genislik * 4, (y + 1) * genislik * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(genislik, 0);
  ihdr.writeUInt32BE(yukseklik, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const imza = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    imza,
    pngParcasi('IHDR', ihdr),
    pngParcasi('IDAT', deflateSync(tarama, { level: 9 })),
    pngParcasi('IEND', Buffer.alloc(0)),
  ]);
}

function aracBildirimi() {
  return {
    name: ARAC,
    description:
      'Kullanicinin baktigi ekranin net ve guncel karesini getirir. Ekrani okumak icin hemen cagir.',
    behavior: 'NON_BLOCKING',
    parameters: {
      type: 'OBJECT',
      properties: {
        ekran: {
          type: 'STRING',
          description: "Bos veya 'odak' kullanicinin baktigi ekrani secer.",
        },
      },
    },
  };
}

export function setupHazirla(ham, model = MODEL) {
  const cerceve = structuredClone(ham);
  const setup = cerceve.setup ?? cerceve;
  setup.model = model.startsWith('models/') ? model : `models/${model}`;
  setup.tools ??= [];
  let bildirimler = setup.tools.flatMap((arac) => arac.functionDeclarations ?? []);
  if (!bildirimler.some((bildirim) => bildirim.name === ARAC)) {
    let islevAraci = setup.tools.find((arac) => Array.isArray(arac.functionDeclarations));
    if (!islevAraci) {
      islevAraci = { functionDeclarations: [] };
      setup.tools.push(islevAraci);
    }
    islevAraci.functionDeclarations.push(aracBildirimi());
    bildirimler = setup.tools.flatMap((arac) => arac.functionDeclarations ?? []);
  }
  if (!bildirimler.some((bildirim) => bildirim.name === ARAC))
    throw new Error(`${ARAC} bildirimi setup'a eklenemedi`);
  return cerceve.setup ? cerceve : { setup: cerceve };
}

function aracYaniti(cagri, goruntulu) {
  const temel = {
    id: cagri.id,
    name: cagri.name,
    response:
      cagri.name === ARAC
        ? {
            durum: 'net kare gonderildi',
            ekranlar: goruntulu ? goruntulu.map((_, i) => `test ekrani ${i + 1}`) : ['test ekrani'],
            yonlendirme: goruntulu
              ? 'Bu yanittaki karelere bak (sirayla her ekran bir kare) ve simdi cevap ver; araci TEKRAR CAGIRMA.'
              : 'Simdi gelen yeni kareye bak ve metni oku.',
          }
        : { hata: `sonda ${cagri.name} aracini calistirmiyor` },
  };
  if (goruntulu && cagri.name === ARAC) {
    temel.parts = goruntulu.map((inlineData) => ({ inlineData }));
  }
  return temel;
}

export function yontemMesajlari(yontem, cagrilar, inlineData) {
  const kareler = Array.isArray(inlineData) ? inlineData : [inlineData];
  const ekranVar = cagrilar.some((cagri) => cagri.name === ARAC);
  const normalYanit = {
    toolResponse: { functionResponses: cagrilar.map((cagri) => aracYaniti(cagri)) },
  };
  const videolar = kareler.map((kare) => ({
    etiket: 'realtimeInput.video',
    govde: { realtimeInput: { video: kare } },
  }));
  if (yontem === 'Y1')
    return ekranVar
      ? [...videolar, { etiket: 'toolResponse', govde: normalYanit }]
      : [{ etiket: 'toolResponse', govde: normalYanit }];
  if (yontem === 'Y2')
    return ekranVar
      ? [{ etiket: 'toolResponse', govde: normalYanit }, ...videolar]
      : [{ etiket: 'toolResponse', govde: normalYanit }];
  if (yontem === 'Y3')
    return [
      {
        etiket: 'toolResponse.parts.inlineData',
        govde: {
          toolResponse: {
            functionResponses: cagrilar.map((cagri) => aracYaniti(cagri, kareler)),
          },
        },
      },
    ];
  if (yontem === 'Y4') {
    const sonuc = [{ etiket: 'toolResponse', govde: normalYanit }];
    if (ekranVar)
      sonuc.push({
        etiket: 'clientContent.inlineData',
        govde: {
          clientContent: {
            turns: [
              {
                role: 'user',
                parts: [
                  ...kareler.map((kare) => ({ inlineData: kare })),
                  { text: 'ekran goruntusu' },
                ],
              },
            ],
            turnComplete: true,
          },
        },
      });
    return sonuc;
  }
  throw new Error(`bilinmeyen yontem: ${yontem}`);
}

function usageOzeti(usage) {
  const sonuc = {};
  for (const [anahtar, deger] of Object.entries(usage ?? {})) sonuc[anahtar] = deger;
  return sonuc;
}

function modalityToken(usage, modality) {
  const ayrinti = usage?.promptTokensDetails;
  if (!Array.isArray(ayrinti)) return null;
  return ayrinti
    .filter((satir) => satir.modality === modality && Number.isFinite(satir.tokenCount))
    .reduce((toplam, satir) => toplam + satir.tokenCount, 0);
}

export function tokenKaniti(metadata, ilkYontemSunucuSirasi) {
  const sayaclar = metadata.filter((u) => Number.isFinite(u.usage.promptTokenCount));
  const once = sayaclar.filter((u) => u.sunucu_sirasi <= ilkYontemSunucuSirasi);
  const sonra = sayaclar.filter((u) => u.sunucu_sirasi > ilkYontemSunucuSirasi);
  let onceKaydi = once.at(-1);
  let sonraKaydi = sonra.at(-1);

  // Live bazen arac cagrisinin usage snapshot'ini ancak cevap yollandiktan
  // sonra yollar. Ilk snapshot'ta IMAGE yok, sonraki snapshot'ta varsa bu iki
  // deger semantik olarak goruntu oncesi ve sonrasidir.
  if (!onceKaydi && sayaclar.length >= 2) {
    const ilk = sayaclar[0];
    const son = sayaclar.at(-1);
    if (
      (modalityToken(ilk.usage, 'IMAGE') ?? 0) === 0 &&
      (modalityToken(son.usage, 'IMAGE') ?? 0) > 0
    ) {
      onceKaydi = ilk;
      sonraKaydi = son;
    }
  }
  const onceSayac = onceKaydi?.usage.promptTokenCount;
  const sonraSayac = sonraKaydi?.usage.promptTokenCount;
  return {
    once: onceSayac ?? null,
    sonra: sonraSayac ?? null,
    artis:
      Number.isFinite(onceSayac) && Number.isFinite(sonraSayac) ? sonraSayac - onceSayac : null,
    imageToken: sayaclar.length ? (modalityToken(sayaclar.at(-1).usage, 'IMAGE') ?? 0) : null,
  };
}

function tekKosu({ key, setup, yontem, tekrar, goruntu, mimeType, parts, zamanAsimiMs }) {
  return new Promise((resolve) => {
    const baslangic = Date.now();
    const inlineData = Array.from({ length: parts }, () => ({
      mimeType,
      data: goruntu.toString('base64'),
    }));
    const sonuc = {
      yontem,
      tekrar,
      parts,
      goruntu_bayt: goruntu.length,
      durum: 'baslamadi',
      dogru: false,
      transkript: '',
      model_metni: '',
      arac_cagrilari: [],
      mesaj_sirasi: [],
      usage_metadata: [],
      prompt_token_once: null,
      prompt_token_sonra: null,
      prompt_token_artisi: null,
      prompt_image_token_son: null,
      ilk_arac_ms: null,
      ilk_cevap_ms: null,
      arac_sonrasi_ilk_cevap_ms: null,
      toplam_ms: null,
      ses_parca: 0,
      sunucu_hatasi: null,
      kapanis: null,
      zaman_asimi: false,
      kota: false,
    };
    let ws;
    let bitti = false;
    let promptAni = null;
    let ilkYontemAni = null;
    let ilkYontemSunucuSirasi = null;
    let sunucuSirasi = 0;
    let yerlesme;
    let setupZamani;
    let genelZaman;
    let kapanisZamani;

    const gecen = () => (promptAni === null ? null : Date.now() - promptAni);
    const gonder = (etiket, govde) => {
      const metin = JSON.stringify(govde);
      sonuc.mesaj_sirasi.push({ etiket, ms: gecen(), bayt: Buffer.byteLength(metin) });
      ws.send(metin);
    };
    const tokenleriHesapla = () => {
      if (ilkYontemSunucuSirasi === null) return;
      const kanit = tokenKaniti(sonuc.usage_metadata, ilkYontemSunucuSirasi);
      sonuc.prompt_token_once = kanit.once;
      sonuc.prompt_token_sonra = kanit.sonra;
      sonuc.prompt_token_artisi = kanit.artis;
      sonuc.prompt_image_token_son = kanit.imageToken;
    };
    const bitir = (durum) => {
      if (bitti) return;
      bitti = true;
      clearTimeout(yerlesme);
      clearTimeout(setupZamani);
      clearTimeout(genelZaman);
      sonuc.durum = durum;
      sonuc.toplam_ms = promptAni === null ? Date.now() - baslangic : Date.now() - promptAni;
      sonuc.transkript = sonuc.transkript.trim();
      sonuc.model_metni = sonuc.model_metni.trim();
      sonuc.dogru = dogruMu(`${sonuc.transkript} ${sonuc.model_metni}`);
      tokenleriHesapla();
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        resolve(sonuc);
        return;
      }
      // Rapor gercek kapanis olayini bekler; istenen 1000 kodunu kanit saymaz.
      kapanisZamani = setTimeout(() => resolve(sonuc), 3000);
      try {
        ws.close(1000);
      } catch {
        // Baglanti zaten kapanmis olabilir.
      }
    };
    const yerlesmeyiPlanla = () => {
      clearTimeout(yerlesme);
      const cevapVar = sonuc.ilk_cevap_ms !== null;
      // usageMetadata ses/transkript bittikten birkac saniye sonra gelebiliyor.
      // Erken kapatma Y3/Y4'te goruntu basarisini gorup token kanitini kacirir.
      const bekleme = cevapVar ? 8000 : sonuc.arac_cagrilari.length ? 8000 : 2000;
      yerlesme = setTimeout(() => bitir(cevapVar ? 'tamam' : 'sessiz'), bekleme);
    };
    const hataMetni = (deger) =>
      maskele(typeof deger === 'string' ? deger : JSON.stringify(deger), key);

    try {
      ws = new WebSocket(`${WS_TABAN}?key=${encodeURIComponent(key)}`);
    } catch (error) {
      sonuc.sunucu_hatasi = hataMetni(error?.message ?? error);
      bitir('baglanti_hatasi');
      return;
    }
    ws.binaryType = 'arraybuffer';
    setupZamani = setTimeout(() => {
      sonuc.zaman_asimi = true;
      bitir('setup_zaman_asimi');
    }, 12000);
    genelZaman = setTimeout(() => {
      sonuc.zaman_asimi = true;
      bitir('zaman_asimi');
    }, zamanAsimiMs);
    ws.onopen = () => ws.send(JSON.stringify(setup));
    ws.onerror = (olay) => {
      if (!sonuc.sunucu_hatasi)
        sonuc.sunucu_hatasi = hataMetni(
          olay?.message ?? olay?.error?.message ?? 'websocket hatasi',
        );
    };
    ws.onclose = (olay) => {
      clearTimeout(kapanisZamani);
      const sebep = maskele(olay.reason ?? '', key);
      sonuc.kapanis = { kod: olay.code, sebep };
      sonuc.kota ||= kotaSiniriMi(sebep, olay.code);
      if (bitti) {
        if (olay.code !== 1000) sonuc.durum = 'kapandi';
        resolve(sonuc);
      } else bitir('kapandi');
    };
    ws.onmessage = (olay) => {
      if (bitti) return;
      sunucuSirasi++;
      let mesaj;
      try {
        const govde =
          typeof olay.data === 'string' ? olay.data : new TextDecoder().decode(olay.data);
        mesaj = JSON.parse(govde);
      } catch {
        return;
      }
      if (mesaj.usageMetadata && typeof mesaj.usageMetadata === 'object') {
        sonuc.usage_metadata.push({
          sunucu_sirasi: sunucuSirasi,
          ms: gecen(),
          usage: usageOzeti(mesaj.usageMetadata),
        });
      }
      if (mesaj.error) {
        sonuc.sunucu_hatasi = hataMetni(mesaj.error);
        const kod = mesaj.error.code ?? mesaj.error.status;
        sonuc.kota = kotaSiniriMi(sonuc.sunucu_hatasi, kod);
        bitir('sunucu_hatasi');
        return;
      }
      if (mesaj.setupComplete !== undefined) {
        clearTimeout(setupZamani);
        promptAni = Date.now();
        sonuc.durum = 'setup_tamam';
        gonder('realtimeInput.text', { realtimeInput: { text: SORU } });
        return;
      }
      if (promptAni === null) return;

      const cagrilar = mesaj.toolCall?.functionCalls;
      if (Array.isArray(cagrilar) && cagrilar.length) {
        clearTimeout(yerlesme);
        if (sonuc.ilk_arac_ms === null) sonuc.ilk_arac_ms = gecen();
        for (const cagri of cagrilar) {
          sonuc.arac_cagrilari.push({
            id: cagri.id,
            name: cagri.name,
            args: cagri.args ?? {},
            ms: gecen(),
          });
        }
        if (sonuc.arac_cagrilari.length > 6) {
          bitir('arac_dongusu');
          return;
        }
        if (cagrilar.some((cagri) => cagri.name === ARAC) && ilkYontemAni === null) {
          ilkYontemAni = Date.now();
          ilkYontemSunucuSirasi = sunucuSirasi;
        }
        for (const { etiket, govde } of yontemMesajlari(yontem, cagrilar, inlineData))
          gonder(etiket, govde);
        return;
      }

      const icerik = mesaj.serverContent;
      if (icerik) {
        for (const parca of icerik.modelTurn?.parts ?? []) {
          if (parca.inlineData) {
            sonuc.ses_parca++;
            if (sonuc.ilk_cevap_ms === null) sonuc.ilk_cevap_ms = gecen();
          } else if (typeof parca.text === 'string' && !parca.thought) {
            sonuc.model_metni += parca.text;
            if (sonuc.ilk_cevap_ms === null) sonuc.ilk_cevap_ms = gecen();
          }
        }
        const transkript = icerik.outputTranscription?.text;
        if (typeof transkript === 'string' && transkript) {
          sonuc.transkript += transkript;
          if (sonuc.ilk_cevap_ms === null) sonuc.ilk_cevap_ms = gecen();
        }
        if (
          ilkYontemAni !== null &&
          sonuc.ilk_cevap_ms !== null &&
          sonuc.arac_sonrasi_ilk_cevap_ms === null
        )
          sonuc.arac_sonrasi_ilk_cevap_ms = Date.now() - ilkYontemAni;
        if (icerik.turnComplete === true || icerik.generationComplete === true) yerlesmeyiPlanla();
      }
      if (mesaj.interactionStatus === 'IDLE') yerlesmeyiPlanla();
    };
  });
}

function argumanlar(argv) {
  const sonuc = {
    setup: null,
    model: MODEL,
    repeat: 3,
    delayMs: 3000,
    timeoutMs: 45000,
    only: YONTEMLER,
    selfTest: false,
    jpeg: null,
    parts: '1',
  };
  const alanlar = {
    '--setup': 'setup',
    '--jpeg': 'jpeg',
    '--parts': 'parts',
    '--model': 'model',
    '--repeat': 'repeat',
    '--delay-ms': 'delayMs',
    '--timeout-ms': 'timeoutMs',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--self-test') sonuc.selfTest = true;
    else if (arg === '--only') sonuc.only = argv[++i].split(',').map((x) => x.trim().toUpperCase());
    else if (arg in alanlar) sonuc[alanlar[arg]] = argv[++i];
    else throw new Error(`bilinmeyen arguman: ${arg}`);
  }
  for (const ad of ['repeat', 'delayMs', 'timeoutMs']) sonuc[ad] = Number(sonuc[ad]);
  if (!sonuc.only.length || sonuc.only.some((x) => !YONTEMLER.includes(x)))
    throw new Error(`--only yalniz ${YONTEMLER.join(',')} degerlerini kabul eder`);
  if (!Number.isInteger(sonuc.repeat) || sonuc.repeat < 1)
    throw new Error('--repeat pozitif tamsayi olmali');
  if (sonuc.delayMs < 3000) throw new Error('--delay-ms en az 3000 olmali');
  sonuc.parts = String(sonuc.parts).split(',').map(Number);
  if (!sonuc.parts.length || sonuc.parts.some((n) => !Number.isInteger(n) || n < 1 || n > 3))
    throw new Error('--parts 1,2,3 listesinden olmali');
  if (
    (sonuc.jpeg || sonuc.parts.some((n) => n > 1)) &&
    (sonuc.only.length !== 1 || sonuc.only[0] !== 'Y3')
  )
    throw new Error('JPEG/cok-parts boyut denemesi yalniz --only Y3 ile kosulur');
  const toplam = sonuc.repeat * sonuc.only.length * sonuc.parts.length;
  if ((sonuc.jpeg || sonuc.parts.some((n) => n > 1)) && toplam > 6)
    throw new Error('boyut denemesi en fazla 6 kosu olabilir');
  if (toplam > 16) throw new Error("toplam kosu 16'yi gecemez");
  return sonuc;
}

function kendiTesti() {
  const png = testGoruntusu();
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.length < 200 * 1024, `test goruntusu cok buyuk: ${png.length}`);
  assert.equal(dogruMu('Ekranda KOD 4271 MAVİ yazıyor.'), true);
  assert.equal(dogruMu('Kod dört bin iki yüz yetmiş bir, mavi.'), true);
  assert.equal(dogruMu('KOD 4272 MAVI'), false);
  const inlineData = { mimeType: MIME_TYPE, data: 'AA==' };
  const cagri = [{ id: 'x', name: ARAC, args: {} }];
  assert.deepEqual(
    yontemMesajlari('Y1', cagri, inlineData).map((x) => x.etiket),
    ['realtimeInput.video', 'toolResponse'],
  );
  assert.deepEqual(
    yontemMesajlari('Y2', cagri, inlineData).map((x) => x.etiket),
    ['toolResponse', 'realtimeInput.video'],
  );
  assert.deepEqual(
    yontemMesajlari('Y3', cagri, inlineData)[0].govde.toolResponse.functionResponses[0].parts,
    [{ inlineData }],
  );
  assert.equal(yontemMesajlari('Y4', cagri, inlineData)[1].govde.clientContent.turnComplete, true);
  const jpegler = [
    { mimeType: 'image/jpeg', data: '/9gB/9k=' },
    { mimeType: 'image/jpeg', data: '/9gC/9k=' },
  ];
  const mesajlar = yontemMesajlari('Y3', cagri, jpegler);
  assert.equal(mesajlar.length, 1);
  assert.equal(mesajlar[0].govde.realtimeInput, undefined);
  const yanit = mesajlar[0].govde.toolResponse.functionResponses[0];
  assert.deepEqual(
    yanit.parts,
    jpegler.map((inlineData) => ({ inlineData })),
  );
  assert.deepEqual(yanit.response.ekranlar, ['test ekrani 1', 'test ekrani 2']);
  assert.equal(typeof yanit.response, 'object');
  const diger = yontemMesajlari('Y3', [{ id: 'd', name: 'diger' }], jpegler);
  assert.equal(diger[0].govde.toolResponse.functionResponses[0].parts, undefined);
  assert.deepEqual(argumanlar(['--only', 'Y3', '--jpeg', 'x.jpg', '--parts', '1,2']).parts, [1, 2]);
  assert.throws(
    () => argumanlar(['--only', 'Y3', '--jpeg', 'x.jpg', '--parts', '1,2', '--repeat', '4']),
    /6 kosu/,
  );

  assert.deepEqual(
    tokenKaniti(
      [
        {
          sunucu_sirasi: 8,
          usage: {
            promptTokenCount: 7382,
            promptTokensDetails: [{ modality: 'TEXT', tokenCount: 6463 }],
          },
        },
        {
          sunucu_sirasi: 36,
          usage: {
            promptTokenCount: 7739,
            promptTokensDetails: [{ modality: 'IMAGE', tokenCount: 270 }],
          },
        },
      ],
      5,
    ),
    { once: 7382, sonra: 7739, artis: 357, imageToken: 270 },
  );
  const setup = setupHazirla({ setup: { tools: [] } });
  assert.equal(setup.setup.tools[0].functionDeclarations[0].name, ARAC);
  console.log(`self-test: gecti, PNG ${png.length} bayt`);
}

export async function main(argv) {
  if (argv[0] === '--export-setup') {
    if (argv.length !== 2) throw new Error('--export-setup <dosya> gerekli');
    return setupDosyasiUret(argv[1]);
  }
  const ayar = argumanlar(argv);
  if (ayar.selfTest) {
    kendiTesti();
    return 0;
  }
  if (!ayar.setup) throw new Error('--setup <dosya> gerekli');
  const key = process.env.SMITH_GEMINI_KEY;
  if (!key) throw new Error('SMITH_GEMINI_KEY ortam degiskeni yok');
  const setup = setupHazirla(JSON.parse(readFileSync(ayar.setup, 'utf8')), ayar.model);
  const goruntu = ayar.jpeg ? readFileSync(ayar.jpeg) : testGoruntusu();
  const mimeType = ayar.jpeg ? 'image/jpeg' : MIME_TYPE;
  if (
    ayar.jpeg &&
    (goruntu[0] !== 0xff ||
      goruntu[1] !== 0xd8 ||
      goruntu.at(-2) !== 0xff ||
      goruntu.at(-1) !== 0xd9)
  )
    throw new Error('--jpeg gecerli JPEG baslangic/bitis isaretleri tasimali');
  if (!ayar.jpeg && goruntu.length >= 200 * 1024)
    throw new Error(`goruntu 200 KB sinirini asti: ${goruntu.length}`);

  const plan = [];
  for (let tekrar = 1; tekrar <= ayar.repeat; tekrar++)
    for (const yontem of ayar.only)
      for (const parts of ayar.parts) plan.push({ yontem, tekrar, parts });
  const kosular = [];
  let durduruldu = null;
  for (let i = 0; i < plan.length; i++) {
    const girdi = plan[i];
    const kosu = await tekKosu({
      key,
      setup,
      ...girdi,
      goruntu,
      mimeType,
      zamanAsimiMs: ayar.timeoutMs,
    });
    kosular.push(kosu);
    console.log(
      `[${i + 1}/${plan.length}] ${girdi.yontem} #${girdi.tekrar} ` +
        `parts=${kosu.parts} durum=${kosu.durum} dogru=${kosu.dogru} arac=${kosu.arac_cagrilari.length} ` +
        `ilk_cevap_ms=${kosu.ilk_cevap_ms ?? '-'} prompt_delta=${kosu.prompt_token_artisi ?? '-'}`,
    );
    if (kosu.kota) {
      durduruldu = `${girdi.yontem} #${girdi.tekrar}: 429 veya WS 1011`;
      break;
    }
    if (i + 1 < plan.length) await bekle(ayar.delayMs);
  }
  const rapor = {
    meta: {
      zaman: new Date().toISOString(),
      model: ayar.model,
      soru: SORU,
      test_metni: TEST_METNI,
      mime_type: mimeType,
      goruntu_bayt: goruntu.length,
      planlanan_kosu: plan.length,
      yapilan_kosu: kosular.length,
      kosular_arasi_bekleme_ms: ayar.delayMs,
      durduruldu,
    },
    kosular,
  };
  console.log('HAM_RAPOR_BASLANGIC');
  console.log(JSON.stringify(rapor, null, 2));
  console.log('HAM_RAPOR_BITIS');
  return durduruldu ? 3 : kosular.every((k) => k.durum === 'tamam' && k.dogru) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (kod) => process.exit(kod),
    (error) => {
      console.error(`HATA: ${maskele(error?.message ?? error, process.env.SMITH_GEMINI_KEY)}`);
      process.exit(2);
    },
  );
}
