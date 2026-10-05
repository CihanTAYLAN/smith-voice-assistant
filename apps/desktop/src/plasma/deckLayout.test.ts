import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearDeckLayout, loadDeckLayout, saveDeckOffset } from './deck.js';

const KEY = 'smith.deck.layout.v1';

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('kontrol karti yerlesim kaydi', () => {
  it('sonsuz, metin veya eksik konumlari yok sayar, gecerli olani korur', () => {
    // `1e999` JSON'da gecerli bir sayidir ama Infinity'ye ayrisir: kart ekran disina kacardi.
    store.set(
      KEY,
      '{"a":{"x":1e999,"y":5},"b":{"x":"3","y":4},"c":{"x":12,"y":34},"d":{"x":1},"e":null}',
    );
    expect(loadDeckLayout()).toEqual({ c: { x: 12, y: 34 } });
  });

  it('bozuk veya nesne olmayan kayit bos yerlesim verir', () => {
    store.set(KEY, '{bozuk');
    expect(loadDeckLayout()).toEqual({});
    store.set(KEY, '42');
    expect(loadDeckLayout()).toEqual({});
  });

  it('konumu yuvarlayarak yazar ve diger kartlari korur', () => {
    saveDeckOffset('engines', { x: 24.4, y: 48.6 });
    saveDeckOffset('usage', { x: 504, y: 24 });
    expect(loadDeckLayout()).toEqual({ engines: { x: 24, y: 49 }, usage: { x: 504, y: 24 } });
  });

  it('sifirlama kaydi siler', () => {
    saveDeckOffset('engines', { x: 1, y: 2 });
    clearDeckLayout();
    expect(store.has(KEY)).toBe(false);
    expect(loadDeckLayout()).toEqual({});
  });
});
