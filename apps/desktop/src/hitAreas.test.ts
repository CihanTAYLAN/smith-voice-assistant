import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createHitAreaSender } from './useHitAreas.js';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

beforeEach(() => {
  // Basarisiz komutlar maskeli olarak console'a yazilir; test ciktisini kirletmesin.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function stubTauriWindow(): void {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout });
}

it('ucustaki B den sonra, A onceki basarili geometri olsa bile A yi yeniden bildirir', async () => {
  stubTauriWindow();
  const a = [{ x: 1, y: 1, width: 100, height: 100 }];
  const b = [{ x: 0, y: 0, width: 900, height: 700 }];
  let areas = a;
  invoke.mockReset().mockResolvedValue(null);
  const sender = createHitAreaSender(() => areas);
  sender.send();
  await settle();
  let finish: (() => void) | undefined;
  invoke.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  areas = b;
  sender.send();
  await settle();
  areas = a;
  sender.send();
  finish?.();
  await settle();
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(invoke).toHaveBeenLastCalledWith('window_set_hit_areas', { areas: a });
  sender.close();
});

it('basarisiz ayni geometriyi yeniden dener, tekrari yalniz basarili teslimden sonra eler', async () => {
  vi.useFakeTimers();
  stubTauriWindow();
  invoke.mockReset().mockRejectedValueOnce(new Error('private')).mockResolvedValue(null);
  const sender = createHitAreaSender(() => []);
  sender.send();
  await settle();
  await vi.advanceTimersByTimeAsync(200);
  await settle();
  expect(invoke).toHaveBeenCalledTimes(2);
  sender.send();
  await settle();
  expect(invoke).toHaveBeenCalledTimes(2);
  sender.close();
});

it('uc basarisiz denemeden sonra durur, sonraki geometri istegiyle surdurur', async () => {
  vi.useFakeTimers();
  stubTauriWindow();
  invoke.mockReset().mockRejectedValue(new Error('private'));
  const sender = createHitAreaSender(() => []);
  sender.send();
  await settle();
  // Yeniden denemeler 150, 300 ve 450 ms sonra; dorduncu hata sonrasi vazgecilir.
  for (const wait of [150, 300, 450, 5_000]) {
    await vi.advanceTimersByTimeAsync(wait);
    await settle();
  }
  expect(invoke).toHaveBeenCalledTimes(4);
  invoke.mockResolvedValue(null);
  sender.send();
  await settle();
  expect(invoke).toHaveBeenCalledTimes(5);
  sender.close();
});

it('kapatildiktan sonra hicbir sey gondermez', async () => {
  stubTauriWindow();
  invoke.mockReset().mockResolvedValue(null);
  const sender = createHitAreaSender(() => []);
  sender.close();
  sender.send();
  await settle();
  expect(invoke).not.toHaveBeenCalled();
});
