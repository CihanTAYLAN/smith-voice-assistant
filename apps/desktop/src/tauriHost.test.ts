import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callHost, hasTauri, loadTauri } from './tauriHost.js';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

beforeEach(() => {
  invoke.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Tauri host yokken (tarayici onizlemesi)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
  });

  it('host yok der, api yuklemez, komut asla cagirmaz', async () => {
    expect(hasTauri()).toBe(false);
    expect(await loadTauri()).toBeNull();
    expect(await callHost('window_state')).toEqual({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('Tauri host varken', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  });

  it('komut degerini doner, argumani bos nesneye varsayar', async () => {
    invoke.mockResolvedValueOnce({ framed: true });
    expect(await callHost('window_state')).toEqual({ ok: true, value: { framed: true } });
    expect(invoke).toHaveBeenCalledWith('window_state', {});
  });

  it('hatayi { ok: false } yapar ve sir maskeli gunluge yazar', async () => {
    invoke.mockRejectedValueOnce(new Error('token=abc123 failed'));
    expect(await callHost('zihin_dokumu')).toEqual({ ok: false });
    expect(console.error).toHaveBeenCalledWith('[host zihin_dokumu] Error: token=*** failed');
  });

  it('moduller yuklenince invoke ve listen sunar', async () => {
    const api = await loadTauri();
    expect(api?.invoke).toBe(invoke);
    expect(typeof api?.listen).toBe('function');
  });
});
