import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { HUD_SURFACE } from './plasma/deck.js';
import { COMPACT_VIEWPORT_QUERY } from './useHudEnvironment.js';

/**
 * Ana pencere CSS'inin ERISILEBILIRLIK ve DUZEN sozlesmesi (styles.css, hud.css,
 * mind.css basliklarindaki liste): tiklama hedefi, odak halkasi, kisa pencerede
 * kirpilmama, daraltma esigi ve kucuk metin kontrasti. Piksel karsilastirmasi
 * DEGIL; sozlesme bozulursa (ornegin biri eski balonlara yine opacity verirse)
 * CI kirmizi olsun diye.
 *
 * Kontrast: pencere seffaf oldugu icin zemin kullanicinin masaustudur. Cam
 * dolgu alfa ile masaustune karisir; acik metin icin en kotu durum BEYAZ
 * masaustu, bu yuzden ikisinde de (beyaz ve siyah) kucuk metin 4.5:1 saglamali
 * (WCAG AA). Konusma balonu ve zihin dokumu dolgusunu CSS verir. Pano, bildirim
 * ve dusunce kabarcigi PLAZMA yuzeyidir: dolgusu `HUD_SURFACE`ten gelir ve
 * (WebGL'siz) plasma-ui fallback'inde satir ici stil olarak CSS cam dolgunun
 * ustune cikar; bu yuzden onlar o modelle sinanir.
 */

const read = (name: string): string =>
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const stylesCss = read('styles.css');
/** styles.css baslangicinda hud.css ve mind.css'i ice aktarir: etkin sira budur. */
const css = [read('hud.css'), read('mind.css'), stylesCss].join('\n');

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

/** Belge sirasindaki ILK blogun bildirimleri; `a, b { }` gibi bilesik secici listesi de eslesir. */
function rule(selector: string): Record<string, string> {
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
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

/** `:root` degiskenleri: `--ad: deger;` */
const tokens = Object.fromEntries(
  [
    ...(/:root\s*\{([^}]*)\}/.exec(stylesCss)?.[1] ?? '').matchAll(/--([a-z0-9-]+):\s*([^;]+);/g),
  ].map(([, name, value]) => [name, value?.trim()]),
) as Record<string, string>;

function parse(value: string | undefined): Rgba {
  const resolved = (value ?? '').replace(
    /var\(--([a-z0-9-]+)\)/g,
    (_, name: string) => tokens[name] ?? '',
  );
  const hex = /^#([0-9a-f]{6})$/i.exec(resolved);
  if (hex?.[1]) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(resolved);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) : 1];
  throw new Error(`renk cozumlenemedi: ${value}`);
}

const mix = (a: Rgb, b: Rgb, share: number): Rgb =>
  [0, 1, 2].map((i) => (a[i] ?? 0) * share + (b[i] ?? 0) * (1 - share)) as Rgb;

/** `top` rengi kendi alfasiyla `under` uzerine bindirilir. */
const over = (top: Rgba, under: Rgb): Rgb => mix([top[0], top[1], top[2]], under, top[3]);

function luminance(color: Rgb): number {
  const [r, g, b] = color.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const DESKTOPS: Array<[string, Rgb]> = [
  ['beyaz masaustu', [255, 255, 255]],
  ['siyah masaustu', [0, 0, 0]],
];

/**
 * Metin, alta alta `layers` (alttan uste cam dolgular) uzerinde her masaustunde
 * 4.5:1. `elementOpacity` tum yuzeyi (dolgu + metin) masaustune dogru soldurur.
 */
function expectReadable(text: Rgba, layers: Rgba[], label: string, elementOpacity = 1): void {
  for (const [desktop, color] of DESKTOPS) {
    const surface = layers.reduce<Rgb>((under, layer) => over(layer, under), color);
    const shown = mix(surface, color, elementOpacity);
    const ink = mix(over(text, surface), color, elementOpacity);
    expect(contrast(ink, shown), `${label} / ${desktop}`).toBeGreaterThanOrEqual(4.5);
  }
}

/**
 * plasma-ui 0.7.0 CSS fallback'i: dolgu = `tint` @ (`opacity` x 0.85) satir ici,
 * ustune beyaz gradyan (en acik ucu 0.14). Metin icin en kotu nokta o uctur.
 */
function plasmaLayers(tint: string, opacity: number): Rgba[] {
  const [r, g, b] = parse(tint);
  return [
    [r, g, b, Math.min(opacity, 1) * 0.85],
    [255, 255, 255, 0.14],
  ];
}

const pixels = (declared: Record<string, string>, property: string): number =>
  Number(/^(\d+)px$/.exec(declared[property] ?? '')?.[1] ?? 0);

describe('ana pencere: tiklama hedefleri ve odak halkasi', () => {
  it('ikon dugmesi, sinyal satiri, mixer dugmesi ve kaydirici en az 32 px', () => {
    expect(pixels(rule('.ic'), 'width')).toBeGreaterThanOrEqual(32);
    expect(pixels(rule('.ic'), 'height')).toBeGreaterThanOrEqual(32);
    expect(pixels(rule('.sig'), 'min-height')).toBeGreaterThanOrEqual(32);
    expect(pixels(rule('.mix-btn'), 'min-height')).toBeGreaterThanOrEqual(32);
    expect(pixels(rule('.mix-btn'), 'min-width')).toBeGreaterThanOrEqual(32);
    expect(pixels(rule('.mix-vol'), 'height')).toBeGreaterThanOrEqual(32);
  });

  it('birincil eylemler (dinleme ve zihin dokumu) en az 40 px', () => {
    expect(pixels(rule('.hud-mic'), 'min-height')).toBeGreaterThanOrEqual(40);
    expect(pixels(rule('.hud .hud-mind'), 'min-height')).toBeGreaterThanOrEqual(40);
  });

  it.each(['.hud :focus-visible', '.mind-cloud:focus-visible', '.mind-dump :focus-visible'])(
    '%s odak halkasi 2 px ve kontrastlidir',
    (selector) => {
      expect(rule(selector).outline).toBe('2px solid var(--cyan)');
    },
  );

  it('hicbir metin 11 px altina inmez', () => {
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(10);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11);
  });
});

describe('ana pencere: pencere olcegi', () => {
  it('kisa pencerede pano kirpilmaz, kendi icinde kayar', () => {
    const hud = rule('.hud');
    expect(hud['overflow-y']).toBe('auto');
    expect(hud['max-height']).toBe('calc(100dvh - 2 * var(--edge))');
  });

  it('dar pencere esigi useHudCollapse ile ayni', () => {
    expect(stylesCss).toContain(`@media ${COMPACT_VIEWPORT_QUERY} {`);
  });

  it('zihin dokumu kapaliyken gorunmez (display yalniz [open]) ve arka plani karartir', () => {
    expect(rule('.mind-dump')).not.toHaveProperty('display');
    expect(rule('.mind-dump[open]').display).toBe('flex');
    expect(rule('.mind-dump::backdrop')).toHaveProperty('background');
  });
});

describe('ana pencere: kucuk metin kontrasti (WCAG AA 4.5:1, en kotu masaustunde)', () => {
  it.each([
    ['.notice', HUD_SURFACE.tint],
    [".notice[data-kind='fault']", HUD_SURFACE.fault],
    [".notice[data-kind='gate']", HUD_SURFACE.gate],
  ])('%s metni plazma dolgusunda okunur', (selector, tint) => {
    const color = { ...rule('.notice'), ...rule(selector) }.color;
    expectReadable(parse(color), plasmaLayers(tint, HUD_SURFACE.opacity), selector);
  });

  it('pano metinleri plazma dolgusunda okunur', () => {
    const panel = plasmaLayers(HUD_SURFACE.tint, HUD_SURFACE.opacity);
    for (const selector of ['.hud-state', '.hud-link-error', '.mix-label', '.sig-detail p']) {
      expectReadable(parse(rule(selector).color), panel, selector);
    }
    const warn = rule(".sig[data-tone='warn']");
    expectReadable(parse(warn.color), [...panel, parse(warn.background)], 'uyari satiri');
  });

  it.each([0, 1, 2, 3])('konusma balonu, basamak %i: kesilmis olsa bile okunur', (depth) => {
    const glass = parse(rule('.bubble').background);
    const said = depth === 0 ? rule('.said') : rule(`.bubble[data-depth='${depth}'] .said`);
    const text = parse(said.color);
    const interrupted = Number(rule(".bubble[data-interrupted='true'] .said").opacity);
    expectReadable(text, [glass], `balon ${depth}`);
    expectReadable([text[0], text[1], text[2], text[3] * interrupted], [glass], `kesik ${depth}`);
  });

  it('eski balonlar eleman opacity ile degil metin alfasiyla geri cekilir', () => {
    // Eleman opacity'si cam dolguyu da soldurur: beyaz masaustunde metin 2.65:1'e inmisti.
    expect(css).not.toMatch(/\.bubble\[data-depth='\d'\]\s*\{[^}]*opacity/);
  });

  it.each([0, 1, 2])('dusunce kabarcigi, basamak %i: okunur', (depth) => {
    const declared = {
      ...rule('.mind-thought'),
      ...(depth === 0 ? {} : rule(`.mind-thought[data-depth='${depth}']`)),
    };
    expectReadable(
      parse(declared.color),
      plasmaLayers(HUD_SURFACE.tint, HUD_SURFACE.opacity),
      `dusunce ${depth}`,
    );
  });

  it('eski dusunce kabarciklari eleman opacity ile degil metin alfasiyla geri cekilir', () => {
    expect(css).not.toMatch(/.mind-thought[data-depth='d']s*{[^}]*opacity/);
  });

  it('zihin dokumu govdesi opak zeminde okunur', () => {
    expectReadable(
      parse(rule('.mind-dump-body').color),
      [parse(rule('.mind-dump[open]').background)],
      'dokum govdesi',
    );
  });
});
