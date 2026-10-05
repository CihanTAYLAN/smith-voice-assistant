import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import { hookRunner, host, installHost, removeHost, settle } from './hookTestHost.js';
import { useHudCollapse, useLinkStall } from './useHudEnvironment.js';
import { type LiveLink } from './useLiveVoice.js';

const t = await vi.hoisted(() => import('./hookTestHost.js'));
vi.mock('react', async (original) => t.reactWithHost(await original<typeof React>()));
vi.mock('@tauri-apps/api/core', () => ({ invoke: t.host.invoke }));

const hook = hookRunner(useHudCollapse);
let stallInput: { capturing: boolean; link: LiveLink } = { capturing: true, link: 'unknown' };
const stallHook = hookRunner(() => useLinkStall(stallInput.capturing, stallInput.link));

/** `matchMedia` taklidi: pencere boyutu degisimini elle tetikler. */
function fakeViewport(compact: boolean): {
  resizeTo: (compact: boolean) => void;
  subscribers: () => number;
} {
  const listeners = new Set<() => void>();
  const media = {
    matches: compact,
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  };
  installHost({ matchMedia: () => media });
  return {
    resizeTo(next) {
      media.matches = next;
      listeners.forEach((listener) => listener());
    },
    subscribers: () => listeners.size,
  };
}

afterEach(() => {
  hook.unmount();
  stallHook.unmount();
  removeHost();
});

describe('useHudCollapse', () => {
  it('dar pencerede daraltilmis, genis pencerede acik baslar', async () => {
    fakeViewport(true);
    await hook.mount();
    expect(hook.render().collapsed).toBe(true);
    hook.unmount();

    fakeViewport(false);
    await hook.mount();
    expect(hook.render().collapsed).toBe(false);
  });

  it('kullanici secim yapana dek pencere boyutunu izler', async () => {
    const viewport = fakeViewport(false);
    await hook.mount();
    viewport.resizeTo(true);
    expect(hook.render().collapsed).toBe(true);
    viewport.resizeTo(false);
    expect(hook.render().collapsed).toBe(false);
  });

  it('acik secimi sonraki boyut degisimlerine tercih eder', async () => {
    const viewport = fakeViewport(true);
    await hook.mount();
    hook.render().toggle();
    expect(hook.render().collapsed).toBe(false);
    viewport.resizeTo(false);
    viewport.resizeTo(true);
    expect(hook.render().collapsed).toBe(false);
    hook.render().toggle();
    expect(hook.render().collapsed).toBe(true);
  });

  it('unmount olunca gorunum alanini dinlemeyi birakir', async () => {
    const viewport = fakeViewport(false);
    await hook.mount();
    expect(viewport.subscribers()).toBe(1);
    hook.unmount();
    expect(viewport.subscribers()).toBe(0);
  });
});

describe('useLinkStall', () => {
  it('ilk acilista Live durumunu sorar ve bilinen goruntude nobet baslatmaz', async () => {
    installHost();
    host.invoke.mockResolvedValue({ connected: false });
    stallInput = { capturing: true, link: 'unknown' };
    await stallHook.mount();
    await settle();
    expect(host.invoke).toHaveBeenCalledWith('live_status_get', {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stallHook.render()).toBe(false);
  });

  it('sessiz hatti yalniz dinlerken ve tolerans suresinden sonra isaretler', async () => {
    installHost();
    host.invoke.mockResolvedValue(undefined);
    stallInput = { capturing: true, link: 'unknown' };
    await stallHook.mount();
    expect(stallHook.render()).toBe(false);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(stallHook.render()).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(stallHook.render()).toBe(true);
  });

  it('durumu bilinen hatti ya da dinlemeyen oturumu asla isaretlemez', async () => {
    installHost();
    stallInput = { capturing: true, link: 'up' };
    await stallHook.mount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stallHook.render()).toBe(false);

    stallHook.unmount();
    stallInput = { capturing: false, link: 'unknown' };
    await stallHook.mount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stallHook.render()).toBe(false);
  });
});
