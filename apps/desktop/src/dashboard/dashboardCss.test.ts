import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Dashboard CSS'inin ERISILEBILIRLIK sozlesmesi (dashboard.css basligindaki
 * liste): metin boyutu, tiklama hedefi, odak halkasi, kontrast. Piksel
 * karsilastirmasi DEGIL; sozlesme bozulursa (ornegin biri 10 px metin ekler)
 * CI kirmizi olsun diye.
 */

const css = readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');
const palette = readFileSync(new URL('../mission/mission.css', import.meta.url), 'utf8');

/** Tek secicili `selector { ... }` kuralinin govdesi. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  if (!match) throw new Error(`kural bulunamadi: ${selector}`);
  return match[1] ?? '';
}

const pixels = (body: string, property: string): number =>
  Number(new RegExp(`${property}:\\s*(\\d+)px`).exec(body)?.[1] ?? 0);

function token(name: string): string {
  const value = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(palette)?.[1];
  if (!value) throw new Error(`palet degiskeni yok: ${name}`);
  return value;
}

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5]
    .map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [light = 0, dark = 0] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (light + 0.05) / (dark + 0.05);
}

describe('dashboard.css erisilebilirlik sozlesmesi', () => {
  it('hicbir metin 12 px altinda degil', () => {
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(10);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
  });

  it.each([
    ['.db-btn', 40],
    ['.db-ic', 40],
    ['.db-navlink', 40],
    ['.db-mood', 32],
    ['.db-link', 32],
    ['.fs-row', 32],
  ])('%s tiklama hedefi en az %i px yuksekliktedir', (selector, minimum) => {
    expect(pixels(rule(selector), 'min-height')).toBeGreaterThanOrEqual(minimum);
  });

  it('ikon dugmesi ve mood dugmesi en az 32 px genisliktedir', () => {
    expect(pixels(rule('.db-ic'), 'min-width')).toBeGreaterThanOrEqual(32);
    expect(pixels(rule('.db-mood'), 'min-width')).toBeGreaterThanOrEqual(32);
  });

  it('odak halkasi 2 px ve kabuktaki etkilesimli ogelerin hepsinde gorunur', () => {
    expect(css).toMatch(/\.db-shell :is\(button, input, select, textarea, canvas\):focus-visible/);
    expect(css).toMatch(/:focus-visible[^{]*\{[^}]*outline:\s*2px solid/);
  });

  it('onay kutusuna display verilmez (kapali <dialog> gorunur kalmasin)', () => {
    expect(rule('.db-dialog')).not.toMatch(/display\s*:/);
  });

  it('onay kutusu arka plani karartir (::backdrop)', () => {
    expect(css).toMatch(/\.db-dialog::backdrop\s*\{[^}]*background/);
  });

  it('serbest kipte kartlar mutlak, izgara kipinde akiskan konumlanir', () => {
    expect(css).toMatch(/\[data-layout='free'\] \.wk-card\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\[data-layout='grid'\]\s*\{[^}]*display:\s*grid/);
  });
});

describe('palet kontrasti (WCAG AA, kucuk metin 4.5:1)', () => {
  const backgrounds = ['--bg-0', '--bg-1'].map(token);

  it.each(['--ink', '--ink-dim', '--cyan'])('%s koyu yuzeylerde en az 4.5:1', (name) => {
    for (const background of backgrounds) {
      expect(contrast(token(name), background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
