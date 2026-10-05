import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./mission.css', import.meta.url), 'utf8');

type Rgba = [number, number, number, number];

/** `:root` degiskenleri: `--ad: deger;` */
function tokens(): Record<string, string> {
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  return Object.fromEntries(
    [...root.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [
      name,
      value?.trim(),
    ]),
  ) as Record<string, string>;
}

const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Belge sirasindaki ILK blogun bildirimleri; `a, b { }` gibi bilesik secici listesi de eslesir. */
function rule(selector: string): Record<string, string> {
  for (const [, selectors, body] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors?.split(',').some((part) => part.trim() === selector)) continue;
    return Object.fromEntries(
      [...(body ?? '').matchAll(/([a-z-]+):\s*([^;]+);/g)].map(([, property, value]) => [
        property,
        value?.trim(),
      ]),
    ) as Record<string, string>;
  }
  throw new Error(`css kurali bulunamadi: ${selector}`);
}

function parse(value: string, vars: Record<string, string>): Rgba {
  const resolved = value.replace(
    /var\(--([a-z0-9-]+)\)/g,
    (_, name: string) => vars[name] ?? value,
  );
  const hex = /^#([0-9a-f]{6})$/i.exec(resolved);
  if (hex?.[1]) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*(\d+)%)?\s*\)$/.exec(resolved);
  if (rgb)
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) / 100 : 1];
  throw new Error(`renk cozumlenemedi: ${value}`);
}

/** `top`, `under` uzerine alfa ile bindirilir. */
function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2]
    .map((i) => Math.round((top[i] ?? 0) * a + (under[i] ?? 0) * (1 - a)))
    .concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

describe('Mission responsive ve erisilebilir CSS sozlesmesi', () => {
  it('viewport yerine kendi kullanilabilir genisligini izler', () => {
    expect(css).toContain('container-type: inline-size');
    expect(css).toMatch(/@container[^{]+{/);
  });

  it('dar ekranda olay akisini gizlemez', () => {
    expect(css).not.toMatch(/\.panel-feed\s*\{[^}]*display:\s*none/s);
    expect(css).toMatch(/\.feed\s*\{[^}]*overflow:\s*auto/s);
  });

  it('pano satırları içeriği ezecek kadar küçülmez', () => {
    expect(rule('.board')['grid-auto-rows']).toBe('max-content');
    expect(rule('.grid')['grid-template-rows']).toBe('max-content 280px');
  });

  it('hata rengi ortak durum yüzeyinden sonra gelir', () => {
    expect(css.lastIndexOf('.surface-error {')).toBeGreaterThan(css.indexOf('.db-state,'));
  });

  it('odak halkasi ve kontrol hedefleri yeterince buyuktur', () => {
    expect(css).toContain('outline: 2px solid var(--cyan)');
    expect(css).toMatch(/\.ic\s*\{[^}]*min-width:\s*40px[^}]*min-height:\s*40px/s);
    expect(rule('.act')['min-height']).toBe('36px');
    expect(rule('.act-primary')['min-height']).toBe('40px');
  });

  it('dort satirli grid degismezi: banner kapsayicisi gizlenmez, satirlar acikca yerlestirilir', () => {
    // Bos banner kapsayicisini display:none yapmak footer'i gorunur alanin disina itiyordu.
    expect(css).not.toMatch(/\.mc-banners:empty/);
    expect(rule('.mc')['grid-template-rows']).toBe('auto auto minmax(0, 1fr) auto');
    expect(rule('.mc-toolbar')['grid-row']).toBe('1');
    expect(rule('.mc-banners')['grid-row']).toBe('2');
    expect(rule('.grid')['grid-row']).toBe('3');
    expect(rule('.foot')['grid-row']).toBe('4');
  });

  it('pano dar alanda yatay kaymaz; kolonlar akar, ekip tek kaydirma bolgesidir', () => {
    expect(rule('.board')['min-width']).toBe('0');
    expect(rule('.board')['grid-template-columns']).toBe('repeat(3, minmax(0, 1fr))');
    expect(css).toMatch(/@container \(width <= 760px\)[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
    expect(rule('.panel-board').overflow).toBe('visible');
    expect(rule('.panel-org').overflow).toBe('hidden');
    expect(rule('.org-body').overflow).toBe('auto');
    // Opak zeminli yapiskan baslik plazma yuzeyinde koyu bant olusturuyordu.
    expect(css).not.toMatch(/position:\s*sticky/);
  });

  it('siralama: cok genis alanda pano solda, ekip ve akis sag seritte', () => {
    expect(css).toMatch(
      /@container \(width >= 1300px\)\s*\{[\s\S]*?\.grid\s*\{[^}]*'board org'[^}]*'board feed'/,
    );
  });

  it('organizasyon semasinin SVG kutusu odakta kalin cizgi alir (outline cizilmez)', () => {
    expect(css).toMatch(/\.org-node:focus-visible \.org-box\s*\{[^}]*stroke-width:\s*3/s);
  });
});

describe('Mission renk kontrasti (WCAG AA, kucuk metin 4.5:1)', () => {
  const vars = tokens();
  const base = parse('var(--bg-0)', vars);
  const surface = over(parse('var(--surface)', vars), base);
  const surface2 = over(parse('var(--surface-2)', vars), surface);
  const backdrops: Array<[string, Rgba]> = [
    ['bg-0', base],
    ['bg-1', parse('var(--bg-1)', vars)],
    ['surface', surface],
    ['surface-2', surface2],
  ];

  it.each(['ink', 'ink-dim', 'ink-muted', 'cyan', 'amber', 'alarm'])(
    '--%s metin rengi tum zeminlerde 4.5:1 saglar',
    (name) => {
      for (const [label, backdrop] of backdrops) {
        expect(
          contrast(parse(`var(--${name})`, vars), backdrop),
          `${name} / ${label}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(['.banner', '.drawer-warning', '.form-error', '.act-danger'])(
    '%s kendi renkli zemininde 4.5:1 saglar',
    (selector) => {
      const declared = rule(selector);
      const text = parse(declared.color ?? 'var(--ink)', vars);
      const background = over(parse(declared.background ?? 'var(--surface)', vars), surface);
      expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
    },
  );
});
