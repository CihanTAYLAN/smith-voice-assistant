import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import { host, hookRunner, installHost, removeHost, settle } from './hookTestHost.js';
import { useWindowCommands } from './useWindowCommands.js';

const t = await vi.hoisted(() => import('./hookTestHost.js'));
vi.mock('react', async (original) => t.reactWithHost(await original<typeof React>()));
vi.mock('@tauri-apps/api/core', () => ({ invoke: t.host.invoke }));

const hook = hookRunner(useWindowCommands);

/** Sentetik pointerdown: yalniz hook'un okudugu alanlar. */
function pointerDown(
  button: number,
  preventDefault: () => void = vi.fn(),
): React.PointerEvent<HTMLElement> {
  return { button, isPrimary: true, preventDefault } as unknown as React.PointerEvent<HTMLElement>;
}

beforeEach(async () => {
  installHost();
  // `callHost` basarisiz komutlari maskeli olarak console'a yazar; test ciktisini kirletmesin.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  host.invoke.mockResolvedValue({ framed: false });
  await hook.mount();
});
afterEach(() => {
  hook.unmount();
  removeHost();
  vi.restoreAllMocks();
});

describe('pencere komutlari', () => {
  it('cerceve gecisleri tek ucustur, hatalar ayrinti sizdirmadan bildirilir', async () => {
    let finish: ((value: boolean) => void) | undefined;
    host.invoke.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    hook.render().toggleFrame();
    hook.render().toggleFrame();
    await settle();
    expect(host.invoke.mock.calls.filter(([cmd]) => cmd === 'window_toggle_frame')).toHaveLength(1);
    expect(hook.render().pending.has('window_toggle_frame')).toBe(true);
    finish?.(true);
    await settle();
    expect(hook.render().framed).toBe(true);
    expect(hook.render().pending.has('window_toggle_frame')).toBe(false);
    host.invoke.mockRejectedValueOnce(new Error('token=secret C:/private'));
    hook.render().run('mission_open');
    await settle();
    expect(hook.render().error).toBe('Dashboard açılamadı. Yeniden dene.');
  });

  it('gec gelen durum okumasi daha yeni cerceve gecisini ezmez', async () => {
    hook.unmount();
    let finishRead: (value: { framed: boolean }) => void = () => {};
    host.invoke.mockImplementation((cmd: string) =>
      cmd === 'window_state'
        ? new Promise((resolve) => {
            finishRead = resolve;
          })
        : Promise.resolve(true),
    );
    await hook.mount();
    hook.render().toggleFrame();
    await settle();
    expect(hook.render().framed).toBe(true);
    finishRead({ framed: false });
    await settle();
    expect(hook.render().framed).toBe(true);
  });

  it('okunamayan durumu bildirir, basarili gecisten sonra mesaji temizler', async () => {
    hook.unmount();
    host.invoke.mockImplementation((cmd: string) =>
      cmd === 'window_state' ? Promise.reject(new Error('read failed')) : Promise.resolve(true),
    );
    await hook.mount();
    expect(hook.render().error).toBe('Pencere durumu okunamadı. Çerçeve düğmesiyle yeniden dene.');
    hook.render().toggleFrame();
    await settle();
    expect(hook.render().error).toBeNull();
    expect(hook.render().framed).toBe(true);
  });

  it('suruklemeyi yalniz birincil dugmeyle baslatir, tek surukleme ucustur', async () => {
    const preventSecondary = vi.fn();
    hook.render().startDragging(pointerDown(2, preventSecondary));
    expect(preventSecondary).not.toHaveBeenCalled();
    expect(host.invoke).not.toHaveBeenCalledWith('window_start_drag', {});

    const preventPrimary = vi.fn();
    hook.render().startDragging(pointerDown(0, preventPrimary));
    hook.render().startDragging(pointerDown(0));
    await settle();
    expect(preventPrimary).toHaveBeenCalledTimes(1);
    expect(host.invoke.mock.calls.filter(([cmd]) => cmd === 'window_start_drag')).toHaveLength(1);
  });
});
