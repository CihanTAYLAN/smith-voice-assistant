import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { HudErrorBoundary } from './HudErrorBoundary.js';

beforeEach(() => {
  // Yakalanan hata maskeli olarak console'a yazilir; test ciktisini kirletmesin.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('HudErrorBoundary', () => {
  it('render hatasini basarisiz duruma cevirir', () => {
    expect(HudErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it('render basarisiz olana dek cocuklarini cizer', () => {
    const boundary = new HudErrorBoundary({ children: 'icerik' });
    expect(boundary.render()).toBe('icerik');
  });

  it('hatadan sonra pencereyi gorunur ve geri alinabilir bir aciklamayla degistirir', () => {
    const boundary = new HudErrorBoundary({ children: 'icerik' });
    boundary.state = { failed: true };
    const html = renderToStaticMarkup(boundary.render() as ReactElement);
    expect(html).toContain('hud-fallback');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Smith arayüzü açılamadı');
    expect(html).toContain('Yeniden yükle');
    expect(html).not.toContain('icerik');
  });

  it('hatayi sirlar maskeli gunluge yazar, kullaniciya asla gostermez', () => {
    const boundary = new HudErrorBoundary({ children: null });
    boundary.componentDidCatch(new Error('token=abc123'));
    expect(console.error).toHaveBeenCalledWith('[hud render] Error: token=***');
    boundary.state = { failed: true };
    expect(renderToStaticMarkup(boundary.render() as ReactElement)).not.toContain('abc123');
  });
});
