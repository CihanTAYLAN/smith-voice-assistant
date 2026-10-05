import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasScale, createCanvasLoop } from './canvasLoop.js';

/** Tarayici ortamini taklit eder: hareket tercihi, gorunurluk ve kare zamanlayicisi. */
function installEnvironment(options: { reducedMotion?: boolean; hidden?: boolean } = {}): {
  setHidden: (hidden: boolean) => void;
} {
  const mediaListeners = new Set<() => void>();
  const documentListeners = new Set<() => void>();
  const media = {
    matches: options.reducedMotion ?? false,
    addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
  };
  const page = {
    hidden: options.hidden ?? false,
    addEventListener: (_event: string, listener: () => void) => documentListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) =>
      documentListeners.delete(listener),
  };
  vi.stubGlobal('window', { matchMedia: () => media, setTimeout, clearTimeout });
  vi.stubGlobal('document', page);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  return {
    setHidden(hidden) {
      page.hidden = hidden;
      documentListeners.forEach((listener) => listener());
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createCanvasLoop', () => {
  it('hareket azaltmada yalniz gecersiz kilinca cizer, kapatilinca durur', async () => {
    installEnvironment({ reducedMotion: true });
    const draw = vi.fn();
    const loop = createCanvasLoop(draw, () => false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenLastCalledWith(expect.any(Number), true);
    loop.invalidate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(draw).toHaveBeenCalledTimes(2);
    loop.stop();
    loop.invalidate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('etkinken bostan daha sik cizer', async () => {
    installEnvironment();
    const idleDraw = vi.fn();
    const idle = createCanvasLoop(idleDraw, () => false);
    await vi.advanceTimersByTimeAsync(1000);
    idle.stop();

    const activeDraw = vi.fn();
    const active = createCanvasLoop(activeDraw, () => true);
    await vi.advanceTimersByTimeAsync(1000);
    active.stop();

    // Bosta ~12, etkinken ~30 kare/sn hedeflenir (rAF gecikmesi payi ile).
    expect(idleDraw.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(idleDraw.mock.calls.length).toBeLessThanOrEqual(12);
    expect(activeDraw.mock.calls.length).toBeGreaterThan(idleDraw.mock.calls.length);
    expect(activeDraw.mock.calls.length).toBeLessThanOrEqual(31);
    expect(activeDraw).toHaveBeenLastCalledWith(expect.any(Number), false);
  });

  it('sayfa gizliyken cizmez, gorunur olunca surdurur', async () => {
    const page = installEnvironment({ hidden: true });
    const draw = vi.fn();
    const loop = createCanvasLoop(draw, () => true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(draw).not.toHaveBeenCalled();
    page.setHidden(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(draw.mock.calls.length).toBeGreaterThan(0);
    page.setHidden(true);
    const drawn = draw.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(draw.mock.calls.length).toBe(drawn);
    loop.stop();
  });

  it('tekrarlanan gecersiz kilmalari tek cizime indirir', async () => {
    installEnvironment({ reducedMotion: true });
    const draw = vi.fn();
    const loop = createCanvasLoop(draw, () => false);
    await vi.advanceTimersByTimeAsync(100);
    draw.mockClear();
    for (let i = 0; i < 5; i++) loop.invalidate();
    await vi.advanceTimersByTimeAsync(100);
    expect(draw).toHaveBeenCalledTimes(1);
    loop.stop();
  });
});

describe('canvasScale', () => {
  it('piksel butcesi icinde yerel yuksek DPI yi korur', () => {
    expect(canvasScale(200, 200, 3)).toBe(3);
    expect(canvasScale(1000, 1000, 3)).toBe(1);
  });

  it('css pikseli basina bir cihaz pikselinin altina inmez, eksik orani yok sayar', () => {
    expect(canvasScale(4000, 4000, 2)).toBe(1);
    expect(canvasScale(300, 300, 0)).toBe(1);
  });

  it('tampon butceyi asacaksa olcegi sinirlar', () => {
    const scale = canvasScale(700, 700, 3);
    expect(scale).toBeGreaterThan(1);
    expect(700 * scale * 700 * scale).toBeLessThanOrEqual(1_000_000 + 1);
  });
});
