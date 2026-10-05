import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createSubscriptions } from './useTauriSubscriptions.js';

beforeEach(() => {
  // Reddedilme nedeni maskeli olarak console'a yazilir; test ciktisini kirletmesin.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('kismi basariyi ve gec gelen tutamaklari tam bir kez birakir', async () => {
  const group = createSubscriptions();
  const early = vi.fn();
  const late = vi.fn();
  let finish: ((release: () => void) => void) | undefined;
  const pending = new Promise<() => void>((resolve) => {
    finish = resolve;
  });
  const result = group.connect([
    Promise.resolve(early),
    Promise.reject(new Error('private')),
    pending,
  ]);
  await Promise.resolve();
  group.close();
  expect(early).toHaveBeenCalledTimes(1);
  finish?.(late);
  expect(await result).toBe(false);
  expect(late).toHaveBeenCalledTimes(1);
  group.close();
  expect(early).toHaveBeenCalledTimes(1);
});

it('herhangi bir abonelik basarisiz olunca basarili tutamaklari kapatir', async () => {
  const group = createSubscriptions();
  const release = vi.fn();
  expect(
    await group.connect([Promise.resolve(release), Promise.reject(new Error('private'))]),
  ).toBe(false);
  expect(release).toHaveBeenCalledTimes(1);
});

it('her red nedenini sir maskeli gunluge yazar', async () => {
  const group = createSubscriptions();
  await group.connect([Promise.reject(new Error('token=abc123'))]);
  expect(console.error).toHaveBeenCalledWith('[events subscribe] Error: token=***');
});

it('basariyi yalniz her tutamak saklandiysa bildirir', async () => {
  const group = createSubscriptions();
  expect(await group.connect([Promise.resolve(vi.fn()), Promise.resolve(vi.fn())])).toBe(true);
});
