import { describe, expect, it } from 'vitest';

import {
  CARD_IDS,
  CARDS,
  clampOffset,
  defaultOffsets,
  FREE_MIN_WIDTH,
  isFreeLayout,
  MIN_VISIBLE_HEIGHT,
} from './controlLayout.js';

/** Başlık, dock ve araç çubuğundan sonra kalan çalışma alanı. */
const DEFAULT_WINDOW_FIELD = { width: 1048, height: 540 };
const LARGE_WINDOW_FIELD = { width: 1368, height: 740 };
/** 900x700 pencerede (en dar kullanim) calisma alani. */
const NARROW_WINDOW_FIELD = { width: 720, height: 540 };

describe('isFreeLayout', () => {
  it('varsayilan pencerede kartlar ızgaraya akar, geniş alanda sürükleme korunur', () => {
    expect(isFreeLayout(DEFAULT_WINDOW_FIELD)).toBe(false);
    expect(isFreeLayout(LARGE_WINDOW_FIELD)).toBe(true);
  });

  it('dar pencerede (900x700) akiskan izgaraya gecer', () => {
    expect(isFreeLayout(NARROW_WINDOW_FIELD)).toBe(false);
  });

  it('varsayilan iki kolon sigmiyorsa genislik siniri izgaraya cevirir', () => {
    expect(isFreeLayout({ width: FREE_MIN_WIDTH - 1, height: 900 })).toBe(false);
    expect(isFreeLayout({ width: FREE_MIN_WIDTH, height: 900 })).toBe(true);
  });

  it('alan cok alcaksa kartlar ust uste binmesin diye izgaraya gecer', () => {
    expect(isFreeLayout({ width: 1600, height: 400 })).toBe(false);
  });
});

describe('defaultOffsets', () => {
  it('kayit yoksa varsayilan konumlari verir', () => {
    expect(defaultOffsets().usage).toEqual({ x: CARDS.usage.x, y: CARDS.usage.y });
  });

  it('kayitli konumu kullanir, bilinmeyen karti yok sayar', () => {
    const offsets = defaultOffsets({ engines: { x: 96, y: 48 }, gecmisKart: { x: 1, y: 1 } });
    expect(offsets.engines).toEqual({ x: 96, y: 48 });
    expect(Object.keys(offsets).sort()).toEqual([...CARD_IDS].sort());
  });
});

describe('clampOffset', () => {
  it('varsayilan yerlesim yeterli alanda değişmeden kalır', () => {
    for (const id of CARD_IDS) {
      const { x, y } = CARDS[id];
      expect(clampOffset(id, { x, y }, LARGE_WINDOW_FIELD)).toEqual({ x, y });
    }
  });

  it('pencere kuculunce sagdan tasan kart alanin icine alinir', () => {
    const clamped = clampOffset('usage', { x: 900, y: 24 }, { width: 1100, height: 700 });
    expect(clamped.x + CARDS.usage.width).toBeLessThanOrEqual(1100);
  });

  it('negatif konum sifira cekilir', () => {
    expect(clampOffset('engines', { x: -50, y: -10 }, DEFAULT_WINDOW_FIELD)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it('dikeyde kartin en az MIN_VISIBLE_HEIGHT kismi gorunur kalir', () => {
    const field = { width: 1200, height: 600 };
    const clamped = clampOffset('pending', { x: 24, y: 5000 }, field);
    expect(field.height - clamped.y).toBe(MIN_VISIBLE_HEIGHT);
  });

  it('alan karttan darsa tasmak yerine sifira sabitlenir', () => {
    expect(clampOffset('usage', { x: 504, y: 24 }, { width: 300, height: 100 })).toEqual({
      x: 0,
      y: 0,
    });
  });
});
