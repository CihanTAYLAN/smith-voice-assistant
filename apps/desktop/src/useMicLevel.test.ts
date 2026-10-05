import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import { host, hookRunner, installHost, listen, removeHost, settle } from './hookTestHost.js';
import { useMicLevel } from './useMicLevel.js';

const t = await vi.hoisted(() => import('./hookTestHost.js'));
vi.mock('react', async (original) => t.reactWithHost(await original<typeof React>()));
vi.mock('@tauri-apps/api/core', () => ({ invoke: t.host.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: t.listen }));
vi.mock('tauri-plugin-macos-permissions-api', () => ({
  checkMicrophonePermission: () => Promise.resolve(true),
}));

const hook = hookRunner(useMicLevel);

beforeEach(async () => {
  installHost();
  // Basarisiz komutlar maskeli olarak console'a yazilir; test ciktisini kirletmesin.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  host.invoke.mockResolvedValue(['Mic']);
  await hook.mount();
});
afterEach(() => {
  hook.unmount();
  removeHost();
  vi.restoreAllMocks();
});

describe('mikrofon host durumu', () => {
  it('hazirlik bitince hazir host bildirir', () => {
    expect(hook.render()).toMatchObject({ status: 'ready', pending: false, available: true });
  });

  it('host yanit verene dek "host yok" demek yerine hazirlaniyor kalir', async () => {
    hook.unmount();
    let finish: (devices: string[]) => void = () => {};
    host.invoke.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    );
    await hook.mount();
    expect(hook.render()).toMatchObject({ status: 'initializing', available: false, error: null });
    finish(['Mic']);
    await settle();
    expect(hook.render()).toMatchObject({ status: 'ready', available: true, devices: ['Mic'] });
  });

  it('tarayicida kullanilamaz, host basarisiz olunca hata bildirir', async () => {
    hook.unmount();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    await hook.mount();
    expect(hook.render()).toMatchObject({ status: 'unavailable', available: false, error: null });

    hook.unmount();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout });
    host.invoke.mockRejectedValue(new Error('token=private'));
    await hook.mount();
    expect(hook.render()).toMatchObject({
      status: 'error',
      available: false,
      error: 'Mikrofon hazırlanamadı. Pencereyi yeniden aç.',
    });
  });
});

describe('mikrofon yasam dongusu', () => {
  it('baslat ve durdur tek ucustur, basarisiz durdurmadan sonra dinleme surer', async () => {
    let finish: (() => void) | undefined;
    host.invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    hook.render().start();
    hook.render().start();
    hook.render().stop();
    await settle();
    expect(host.invoke.mock.calls.filter(([cmd]) => cmd === 'audio_start')).toHaveLength(1);
    expect(hook.render().pending).toBe(true);
    finish?.();
    await settle();
    expect(hook.render().capturing).toBe(true);
    host.invoke.mockRejectedValueOnce(new Error('secret-token path'));
    hook.render().stop();
    await settle();
    expect(hook.render().capturing).toBe(true);
    expect(hook.render().error).toBe('Dinleme durdurulamadı. Yeniden dene.');
    expect(hook.render().pending).toBe(false);
  });

  it('unmount sonrasi cozulen dinleyiciyi birakir', async () => {
    hook.unmount();
    let finish: ((value: () => void) => void) | undefined;
    listen.mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          finish = resolve;
        }),
    );
    await hook.mount();
    hook.unmount();
    const release = vi.fn();
    finish?.(release);
    await settle();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
