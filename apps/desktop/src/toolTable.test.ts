import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { TOOL_CATEGORY } from './activityState.js';
import { TOOL_START } from './mindBubbles.js';
import { MEMORY_WRITE_TOOLS } from './useLiveVoice.js';

/**
 * Rust arac tablosu ile UI listelerinin AYRISMA kapisi. Tablo
 * (`src-tauri/src/audio/live/tools.rs`) tek kaynaktir; UI'da uc liste ondan
 * turer: faaliyet kategorisi (`TOOL_CATEGORY`), dusunce baloncugu metni
 * (`TOOL_START`) ve kalici yazma kumesi (`MEMORY_WRITE_TOOLS`). Yeni bir arac
 * tabloya eklenip bu listelerden biri unutulursa arac UI'da sinifsiz kalir
 * (ornegin hatirlatma iptali "kalici yazma" sayilmaz ve ses izi reddi yanlis
 * anlatilir). Liste de tablodan fazlasini tasimaz: silinen arac artik kalmaz.
 */

interface RustTool {
  name: string;
  sinif: string;
  aliases: string[];
}

const source = readFileSync(
  new URL('../src-tauri/src/audio/live/tools.rs', import.meta.url),
  'utf8',
);

/** `arac_tablosu! { ... }` bloku: satirlar `Varyant => ("ad", "etiket", Sinif, "DAVRANIS", [takma adlar], {sema})`. */
const table = (() => {
  const start = source.indexOf('arac_tablosu! {');
  const end = source.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('arac_tablosu! blogu bulunamadi');
  return source.slice(start, end);
})();

function rustTools(): RustTool[] {
  return [
    ...table.matchAll(/^\s+[A-Z]\w* => \("([^"]+)", "[^"]*", (\w+), "[A-Z_]+", \[([^\]]*)\]/gm),
  ].map(([, name = '', sinif = '', aliases = '']) => ({
    name,
    sinif,
    aliases: [...aliases.matchAll(/"([^"]+)"/g)].map(([, alias = '']) => alias),
  }));
}

const tools = rustTools();
/** Olayda `ad` olarak gelebilecek her ad: asil ad ve takma adlar. */
const everyName = tools.flatMap((tool) => [tool.name, ...tool.aliases]);

const sorted = (names: Iterable<string>): string[] => [...names].sort();

describe('Rust arac tablosu', () => {
  it('tum satirlari ayristirilir (kapi sessizce bos kalmaz)', () => {
    const rows = table.match(/^\s+[A-Z]\w* => \("/gm) ?? [];
    expect(tools.length).toBeGreaterThan(25);
    expect(tools).toHaveLength(rows.length);
  });
});

describe('UI listeleri tablo ile birebir ayni arac adlarini tasir', () => {
  it('faaliyet kategorisi: her arac siniflidir, tabloda olmayan arac kalmaz', () => {
    expect(sorted(Object.keys(TOOL_CATEGORY))).toEqual(sorted(everyName));
  });

  it('dusunce baloncugu: her arac icin baslangic metni vardir', () => {
    expect(sorted(Object.keys(TOOL_START))).toEqual(sorted(everyName));
  });

  it('baslangic metinleri uc nokta ile biter ve ham arac adi degildir', () => {
    for (const [name, text] of Object.entries(TOOL_START)) {
      expect(text, name).toMatch(/…$/);
      expect(text, name).not.toBe(name);
    }
  });

  it('kalici yazma kumesi tablonun Hafiza sinifiyla ayni', () => {
    const memory = tools
      .filter((tool) => tool.sinif === 'Hafiza')
      .flatMap((tool) => [tool.name, ...tool.aliases]);
    expect(memory).toEqual(
      expect.arrayContaining([
        'hafizaya_kaydet_ACIK_TALEP_ILE',
        'hatirlatma_kur',
        'hatirlatma_iptal',
        'profil_kaydet',
        'profil_sil',
      ]),
    );
    expect(sorted(MEMORY_WRITE_TOOLS)).toEqual(sorted(memory));
  });
});
