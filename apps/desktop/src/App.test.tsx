import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { App } from './App.js';

/**
 * Ana pencere kabugunun ILK CIZIMI (efektler calismadan, Tauri host'u yok):
 * ayri kancalara bolunmus App'in dort adayi ve panoyu hala bir araya getirdigini
 * ve ilk anda yalan soylemedigini korur. Hit-alani sozlesmesi icin siniflar
 * (`.pet`, `.hud`) Rust gozcusunun olctugu seciciler oldugundan degismez.
 *
 * App render sirasinda iki tarayici API'si okur (dar pencere sorgusu ve belge
 * gorunurlugu); node'da yoklar, bu yuzden yalniz onlar sahtelenir. Plazma
 * yuzeyleri WebGL'siz fallback yoluyla cizilir (bkz. plasma/deck.smoke.test.tsx).
 */

beforeEach(() => {
  // Render sirasinda okunan tarayici API'leri: dar pencere sorgusu ve gorunurluk.
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal('document', { hidden: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App ilk cizimi', () => {
  const html = (): string => renderToStaticMarkup(<App />);

  it('pet ve kose panosu hit-alani siniflariyla gelir', () => {
    const markup = html();
    expect(markup).toContain('class="stage"');
    expect(markup).toContain('class="pet"');
    expect(markup).toMatch(/class="[^"]*\bhud\b[^"]*"/);
    expect(markup).toContain('aria-label="Smith durum panosu"');
  });

  it('host sorgulanirken "host yok" demez, hazirlaniyor der', () => {
    const markup = html();
    expect(markup).toContain('Mikrofon hazırlanıyor…');
    expect(markup).not.toContain('masaüstü host yok');
    expect(markup).not.toContain('tarayıcı önizlemesinde mikrofon yoktur');
  });

  it('olay yokken dusunce baloncugu ve konusma balonlari cizilmez', () => {
    const markup = html();
    expect(markup).not.toContain('class="mind"');
    expect(markup).not.toContain('class="bubble');
    expect(markup).not.toContain('<dialog');
  });
});
