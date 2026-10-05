import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WS_TABAN =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const KOTA_METNI = /quota|exceeded|resource_exhausted|rate.?limit|\b429\b/i;

export const bekle = (ms) => new Promise((tamamla) => setTimeout(tamamla, ms));

/** Metindeki anahtari (verilen deger + AIza deseni + key= sorgusu) maskeler. */
export function maskele(metin, anahtar) {
  let sonuc = String(metin ?? '');
  if (anahtar) sonuc = sonuc.split(anahtar).join('AIza***');
  return sonuc
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza***')
    .replace(/([?&]key=)[^&\s"']+/g, '$1***');
}

export function kotaSiniriMi(metin, kod) {
  return Number(kod) === 429 || Number(kod) === 1011 || KOTA_METNI.test(String(metin ?? ''));
}

/**
 * Uretim setup testinin cargo yolu (`setup.rs` icindeki `mod tests`). Modul
 * yapisi degisirse `--exact` filtresi hicbir testle eslesmez: cargo yine 0 doner
 * ve dosya uretilmez. `setupDosyasiUret` bunu acik hata sayar; yolun kaynakla
 * uyumunu `live-probe.test.mjs` sabitler.
 */
export const SETUP_TEST_YOLU = 'audio::live::setup::tests::sonda_setup_uretimi';

/**
 * Uretim Rust setup testini iki probe icin ayni arguman ve ortamla calistirir.
 * `baseline` (eski setup dosyasi) verilirse onun dinamik eki aynen tasinir;
 * verilmezse yalniz sabit yonerge uretilir.
 * Cikti dosyasi onceden silinir ve sonunda var ve dolu olmalidir: aksi halde
 * (filtre eslesmedi, test sessizce dondu) eski ya da bos bir dosya yesil sayilirdi.
 * `calistir` yalniz testlerde degisir.
 */
export function setupDosyasiUret(cikis, baseline, calistir = spawnSync) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const hedef = resolve(cikis);
  rmSync(hedef, { force: true });
  const env = { ...process.env, SMITH_LIVE_PROBE_OUT: hedef };
  delete env.SMITH_LIVE_PROBE_BASELINE;
  if (baseline) env.SMITH_LIVE_PROBE_BASELINE = resolve(baseline);
  const sonuc = calistir('cargo', ['test', '--lib', SETUP_TEST_YOLU, '--', '--exact'], {
    cwd: join(repo, 'apps', 'desktop', 'src-tauri'),
    env,
    stdio: 'inherit',
  });
  if (sonuc.error) throw sonuc.error;
  const kod = sonuc.status ?? 2;
  if (kod !== 0) return kod;
  if (!existsSync(hedef) || statSync(hedef).size === 0) {
    throw new Error(
      `setup dosyasi uretilmedi (${hedef}): cargo 0 dondu ama cikti yok ya da bos; ` +
        `test yolu hicbir testle eslesmemis olabilir (${SETUP_TEST_YOLU})`,
    );
  }
  return 0;
}

// ---------------------------------------------------------------- sentetik ekran karesi

/** Sentetik ekran karelerinin 5x7 nokta matrisi (yalniz gereken karakterler). */
export const FONT = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
};

function turkceKatla(metin) {
  return String(metin ?? '')
    .toLocaleLowerCase('tr')
    .replace(
      /[çğıöşüâîû]/g,
      (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' })[c],
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Model sentetik karedeki "KOD 4271 MAVI" metnini aktardi mi (rakam ya da sesli sayi). */
export function dogruMu(metin) {
  const n = turkceKatla(metin);
  const sayi = /\b4271\b/.test(n) || /dort bin(?:\s+iki yuz)?\s+yetmis bir/.test(n);
  return n.includes('kod') && sayi && n.includes('mavi');
}

// Standart JPEG DC Huffman tablosu (luminance): kategori 0..11, kod uzunluklari
// (bits) ve her kategorinin (kod, uzunluk) cifti.
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_KODLARI = [
  [0b00, 2],
  [0b010, 3],
  [0b011, 3],
  [0b100, 3],
  [0b101, 3],
  [0b110, 3],
  [0b1110, 4],
  [0b11110, 5],
  [0b111110, 6],
  [0b1111110, 7],
  [0b11111110, 8],
  [0b111111110, 9],
];

function jpegBolumu(isaret, veri) {
  const uzunluk = Buffer.alloc(2);
  uzunluk.writeUInt16BE(veri.length + 2);
  return Buffer.concat([Buffer.from([0xff, isaret]), uzunluk, Buffer.from(veri)]);
}

/**
 * Gri tonlu, yalniz DC katsayili baseline JPEG: her 8x8 blok DUZ renk (AC yok).
 * Kutuphane eklemeden gercek `image/jpeg` uretir; blok sinirina oturan nokta
 * matrisli yazi kayipsiz okunur. `bloklar[satir][sutun]` = 0..255 gri deger.
 */
export function duzBlokJpeg(bloklar) {
  const yukseklik = bloklar.length;
  const genislik = bloklar[0].length;
  const boyut = Buffer.alloc(4);
  boyut.writeUInt16BE(yukseklik * 8, 0);
  boyut.writeUInt16BE(genislik * 8, 2);
  const bitler = [];
  let birikim = 0;
  let sayac = 0;
  const yaz = (deger, uzunluk) => {
    for (let i = uzunluk - 1; i >= 0; i--) {
      birikim = (birikim << 1) | ((deger >> i) & 1);
      if (++sayac < 8) continue;
      bitler.push(birikim);
      if (birikim === 0xff) bitler.push(0x00); // JPEG bayt doldurma
      birikim = 0;
      sayac = 0;
    }
  };
  // DC kuantizasyonu 8: katsayi = gri - 128, blok basina fark kodlanir.
  let onceki = 0;
  for (const satir of bloklar) {
    for (const gri of satir) {
      const fark = gri - 128 - onceki;
      onceki = gri - 128;
      const kategori = fark === 0 ? 0 : 32 - Math.clz32(Math.abs(fark));
      yaz(...DC_KODLARI[kategori]);
      if (kategori) yaz(fark >= 0 ? fark : fark + (1 << kategori) - 1, kategori);
      yaz(0, 1); // AC tablosundaki tek sembol (EOB): kod "0"
    }
  }
  if (sayac) yaz(0xff, 8 - sayac);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegBolumu(0xdb, [0x00, 8, ...Array(63).fill(1)]),
    jpegBolumu(0xc0, [8, ...boyut, 1, 1, 0x11, 0]),
    jpegBolumu(0xc4, [0x00, ...DC_BITS, ...DC_KODLARI.keys()]),
    jpegBolumu(0xc4, [0x10, 1, ...Array(15).fill(0), 0x00]),
    jpegBolumu(0xda, [1, 1, 0x00, 0, 63, 0]),
    Buffer.from(bitler),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** Uretimin `ekrani_net_gor` karesi gibi kucuk bir JPEG: iki satir "KOD 4271" / "MAVI". */
export function testKaresiJpeg() {
  const satirlar = ['KOD 4271', 'MAVI'];
  const kenar = 2;
  const genislik = Math.max(...satirlar.map((s) => s.length * 6 - 1)) + 2 * kenar;
  const yukseklik = satirlar.length * 7 + (satirlar.length - 1) * 3 + 2 * kenar;
  const bloklar = Array.from({ length: yukseklik }, () => Array(genislik).fill(232));
  satirlar.forEach((metin, s) => {
    [...metin].forEach((karakter, k) => {
      FONT[karakter].forEach((satir, y) => {
        [...satir].forEach((nokta, x) => {
          if (nokta === '1') bloklar[kenar + s * 10 + y][kenar + k * 6 + x] = 24;
        });
      });
    });
  });
  return duzBlokJpeg(bloklar);
}
