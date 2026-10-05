import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Empty, faultText, Loading, LoadView } from './LoadView.js';
import type { LoadState } from './loadable.js';

const render = (state: LoadState<string[]>, onRetry?: () => void): string =>
  renderToStaticMarkup(
    <LoadView state={state} {...(onRetry ? { onRetry } : {})}>
      {(items) => (items.length === 0 ? <p>Bos liste</p> : <ul>{items.join(',')}</ul>)}
    </LoadView>,
  );

describe('LoadView', () => {
  it('iskelet yalnız bir durum duyurur; dekoratif çizgiler okunmaz', () => {
    const html = renderToStaticMarkup(<Loading text="Görevler yükleniyor…" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/Görevler yükleniyor…/g)).toHaveLength(1);
  });

  it('boş durum başlığı ve sonraki adım birlikte görünür', () => {
    const html = renderToStaticMarkup(<Empty title="Kayıt yok">Bir görev ekle.</Empty>);
    expect(html).toContain('Kayıt yok');
    expect(html).toContain('Bir görev ekle.');
    expect(html).not.toContain('role="alert"');
  });
  it('ilk yukleme "bos" degil "yukleniyor" der', () => {
    const html = render({ status: 'loading' });
    expect(html).toContain('Yükleniyor…');
    expect(html).not.toContain('Bos liste');
  });

  it('hazir ve bos veri GERCEK bos durumdur (cocuk cizer)', () => {
    expect(render({ status: 'ready', data: [], at: 1 })).toContain('Bos liste');
  });

  it('veri yokken hata, hata olarak gorunur ve icerik cizilmez', () => {
    const html = render({ status: 'error', error: 'Sunucuya ulaşılamıyor.' }, () => {});
    expect(html).toContain('role="alert"');
    expect(html).toContain('Veri okunamadı. Sunucuya ulaşılamıyor.');
    expect(html).toContain('Yeniden dene');
    expect(html).not.toContain('Bos liste');
  });

  it('bayat veri uyariyla birlikte ESKI veriyi korur', () => {
    const html = render({
      status: 'stale',
      data: ['a', 'b'],
      at: Date.now(),
      error: 'Zaman aşımı.',
    });
    expect(html).toContain('Veri bayat');
    expect(html).toContain('Zaman aşımı.');
    expect(html).toContain('a,b');
  });
});

describe('faultText', () => {
  it('hazir ve yukleniyor icin null, kaynak adini cumleye koyar', () => {
    expect(faultText({ status: 'loading' })).toBeNull();
    expect(faultText({ status: 'ready', data: 1, at: 0 })).toBeNull();
    expect(faultText({ status: 'error', error: 'x' }, 'Vault')).toBe('Vault okunamadı. x');
  });
});
