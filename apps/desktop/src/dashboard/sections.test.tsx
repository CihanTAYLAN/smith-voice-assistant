import { MantineProvider } from '@mantine/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { DeckProvider } from '../plasma/deck.js';
import type { FsEntry, FsTruncation } from './api.js';
import { Control } from './Control.js';
import { Files, TruncationNotice } from './Files.js';
import type { FileTreeModel } from './FileTree.js';
import { Graph } from './Graph.js';
import type { LoadState } from './loadable.js';
import { MemoryView } from './Memory.js';
import type { DiscardGuard } from './useLeaveGuard.js';

/**
 * Bolumlerin ILK CIZIMI (effect'ler calismadan): her veri yuzeyi "yukleniyor"
 * der, hicbiri bos/hata gibi gorunmez. SSR cizimi tam olarak bu ani yakalar.
 */

const render = (node: React.ReactNode): string =>
  renderToStaticMarkup(
    <MantineProvider>
      <DeckProvider mood="aurora">{node}</DeckProvider>
    </MantineProvider>,
  );

const guard = (guarded: boolean): DiscardGuard => ({
  dirty: false,
  guarded,
  setDirty: vi.fn(),
  confirmDiscard: () => Promise.resolve(true),
});

describe('Kontrol bolumu', () => {
  const html = render(<Control />);

  it('uc karti da yukleniyor durumunda gosterir', () => {
    expect(html.match(/Yükleniyor…/g)).toHaveLength(3);
  });

  it('veri gelmeden "kayit yok" veya hata demez', () => {
    expect(html).not.toMatch(/Motor kaydı yok|Kayıtlı koşu yok|okunamadı/);
  });

  it('olcum gelene dek akiskan izgara kipinde baslar (kesilen kart yok)', () => {
    expect(html).toContain('data-layout="grid"');
  });

  it('serbest kipe ozgu sifirlama dugmesini izgara kipinde gostermez', () => {
    expect(html).not.toContain('yerleşimi sıfırla');
  });
});

describe('Hafiza bolumu', () => {
  const html = render(<MemoryView />);

  it('ilk yuklemede "Kayit yok" degil "yukleniyor" der', () => {
    expect(html).toContain('Hafıza yükleniyor…');
    expect(html).not.toContain('Kayıt yok.');
  });

  it('arama ve kaynak alanlarinin kalici etiketi vardir', () => {
    expect(html).toContain('Hafızada ara');
    expect(html).toContain('Kaynak');
  });
});

describe('Bilgi grafigi bolumu', () => {
  const html = render(<Graph onOpenFile={vi.fn()} />);

  it('ilk yuklemede "veri yok" degil "yukleniyor" der', () => {
    expect(html).toContain('Grafik yükleniyor…');
    expect(html).not.toContain('Gösterilecek veri yok');
  });

  it('canvas disinda klavye yolu sunar: aranabilir liste, odaklanabilir canvas, yakinlastirma dugmeleri', () => {
    expect(html).toContain('aria-label="Grafik düğümleri"');
    expect(html).toContain('Düğüm ara');
    expect(html).toMatch(/<canvas[^>]*tabindex="0"/);
    expect(html).toContain('aria-label="Yakınlaştır"');
  });

  it('gorunurluk dugmeleri basili (aria-pressed) baslar', () => {
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
  });
});

describe('Dosyalar bolumu', () => {
  const pending = { pendingPath: null, onPendingConsumed: vi.fn() };

  it('kapatma korumasi hazirken yukleniyor der, duzenleme uyarisi gostermez', () => {
    const html = render(<Files {...pending} guard={guard(true)} />);
    expect(html).toContain('Dosyalar yükleniyor…');
    expect(html).toContain('Soldan bir dosya seç; Ctrl+S ile kaydet.');
    expect(html).not.toContain('Düzenleme kapalı');
  });

  it('ilk cizimde kesilme uyarisi yoktur (acik klasor yok)', () => {
    const html = render(<Files {...pending} guard={guard(true)} />);
    expect(html).not.toContain('giriş var');
  });

  it('koruma kurulamadiysa duzenlemenin neden kapali oldugunu soyler', () => {
    const html = render(<Files {...pending} guard={guard(false)} />);
    expect(html).toContain('Düzenleme kapalı');
  });

  it('dosya secilmeden kaydet dugmesi kapalidir', () => {
    const html = render(<Files {...pending} guard={guard(true)} />);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*kaydet \(Ctrl\+S\)/s);
  });
});

describe('Dosyalar bolumu: kesilme uyarisi', () => {
  /** `fsList`in verdigi bicim: duz `FsEntry` dizisi + (kesildiyse) `truncation`. */
  const liste = (truncation?: FsTruncation): LoadState<FsEntry[]> => {
    const entries: FsEntry[] = [];
    return {
      status: 'ready',
      data: truncation ? Object.assign(entries, { truncation }) : entries,
      at: 0,
    };
  };

  const uyari = (listing: FileTreeModel['listing'], open: string[]): string =>
    renderToStaticMarkup(<TruncationNotice listing={listing} open={new Set(open)} />);

  it('kesilen klasor yoksa hicbir sey cizmez', () => {
    expect(uyari({ '/kok/a': liste(), '/kok/b': liste() }, ['/kok/a', '/kok/b'])).toBe('');
    expect(uyari({}, [])).toBe('');
  });

  it('kesilen ACIK klasor icin klasor adiyla TEK satirlik uyari verir', () => {
    const html = uyari({ '/kok/buyuk': liste({ total: 4210, limit: 3000 }) }, ['/kok/buyuk']);
    expect(html).toContain('buyuk klasöründe 4210 giriş var; ilk 3000 tanesi gösteriliyor.');
    expect(html).toContain('role="status"');
    expect(html.match(/<p /g)).toHaveLength(1);
  });

  it('Windows yolunun son parcasini klasor adi yapar', () => {
    const yol = 'C:\\Users\\biri\\proje';
    const html = uyari({ [yol]: liste({ total: 3001, limit: 3000 }) }, [yol]);
    expect(html).toContain('proje klasöründe 3001 giriş var');
    expect(html).not.toContain('Users');
  });

  it('kapali (acik olmayan) klasorun uyarisi gosterilmez', () => {
    expect(uyari({ '/kok/buyuk': liste({ total: 4210, limit: 3000 }) }, [])).toBe('');
  });

  it('birden cok kesik klasoru yine tek satirda ozetler', () => {
    const html = uyari(
      {
        '/kok/a': liste({ total: 3500, limit: 3000 }),
        '/kok/b': liste({ total: 9000, limit: 3000 }),
        '/kok/c': liste(),
      },
      ['/kok/a', '/kok/b', '/kok/c'],
    );
    expect(html).toContain('2 klasörde giriş sayısı 3000 sınırını aşıyor');
    expect(html.match(/<p /g)).toHaveLength(1);
  });

  it('yukleniyor, hata ve henuz okunmamis klasorlerde uyari uydurmaz', () => {
    const html = uyari(
      {
        '/kok/yukleniyor': { status: 'loading' },
        '/kok/hata': { status: 'error', error: 'okunamadi' },
      },
      ['/kok/yukleniyor', '/kok/hata', '/kok/okunmamis'],
    );
    expect(html).toBe('');
  });

  it('bayat (yenilenemeyen) ama kesik veriyi de uyarir: eksik liste ekranda duruyor', () => {
    const veri = liste({ total: 5000, limit: 3000 });
    const bayat: LoadState<FsEntry[]> =
      veri.status === 'ready'
        ? { status: 'stale', data: veri.data, at: 0, error: 'yenilenemedi' }
        : veri;
    expect(uyari({ '/kok/x': bayat }, ['/kok/x'])).toContain('x klasöründe 5000 giriş var');
  });

  it('metin "siz" hitabi tasimaz', () => {
    const html = uyari({ '/kok/a': liste({ total: 4000, limit: 3000 }) }, ['/kok/a']);
    expect(html).not.toMatch(/(?:edin|ediniz|seçin|inizi)\b/);
  });
});
