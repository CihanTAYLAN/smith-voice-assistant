import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import { emit, host, hookRunner, installHost, removeHost, settle } from './hookTestHost.js';
import { useMixer, type MixerSnapshot } from './useMixer.js';

const t = await vi.hoisted(() => import('./hookTestHost.js'));
vi.mock('react', async (original) => t.reactWithHost(await original<typeof React>()));
vi.mock('@tauri-apps/api/core', () => ({ invoke: t.host.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: t.listen }));

const hook = hookRunner(useMixer);
const SNAPSHOT: MixerSnapshot = { micMuted: false, outputMuted: false, outputVolume: 1 };

/** `audio_set_output_volume` cagrilarinin istenen duzeyleri, gonderim sirasiyla. */
function sentVolumes(): number[] {
  return host.invoke.mock.calls
    .filter(([cmd]) => cmd === 'audio_set_output_volume')
    .map(([, args]) => (args as { volume: number }).volume);
}

beforeEach(async () => {
  installHost();
  // Basarisiz komutlar maskeli olarak console'a yazilir; test ciktisini kirletmesin.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  host.invoke.mockResolvedValue(SNAPSHOT);
  await hook.mount();
});
afterEach(() => {
  hook.unmount();
  removeHost();
  vi.restoreAllMocks();
});

describe('mixer komut durumu', () => {
  it('gec komut yaniti daha yeni olayi ezmez', async () => {
    let finish: ((value: MixerSnapshot) => void) | undefined;
    host.invoke.mockImplementationOnce(
      () =>
        new Promise<MixerSnapshot>((resolve) => {
          finish = resolve;
        }),
    );
    hook.render().setMicMuted(true);
    hook.render().setMicMuted(true);
    expect(host.invoke.mock.calls.filter(([cmd]) => cmd === 'audio_set_mic_muted')).toHaveLength(1);
    expect(hook.render().pending).toBe(true);
    emit('audio://mixer', { micMuted: false, outputMuted: true, outputVolume: 0.5 });
    finish?.({ micMuted: true, outputMuted: false, outputVolume: 1 });
    await settle();
    expect(hook.render()).toMatchObject({ micMuted: false, outputMuted: true, outputVolume: 0.5 });
    expect(hook.render().pending).toBe(false);
  });

  it('basarisiz komuttan sonra guvenli mesaj bildirir', async () => {
    host.invoke.mockRejectedValueOnce(new Error('token=private'));
    hook.render().setOutputMuted(true);
    await settle();
    expect(hook.render().error).toBe('Ses ayarı değiştirilemedi. Yeniden dene.');
    expect(hook.render().outputMuted).toBe(false);
  });
});

describe('cikis ses duzeyi kaydiricisi', () => {
  it('komut ucundayken son degeri tutar ve sonra gonderir', async () => {
    let finishFirst: ((value: MixerSnapshot) => void) | undefined;
    host.invoke.mockImplementationOnce(
      () =>
        new Promise<MixerSnapshot>((resolve) => {
          finishFirst = resolve;
        }),
    );
    hook.render().setOutputVolume(0.7);
    hook.render().setOutputVolume(0.8);
    hook.render().setOutputVolume(0.95);
    // Kaydirici beklerken kullanicinin istedigi degeri gosterir, eski degere donmez.
    expect(hook.render().outputVolume).toBe(0.95);
    expect(sentVolumes()).toEqual([0.7]);
    // Kaydirici komut sirasinda kilitlenmez (devre disi girdi suruklemeyi keserdi).
    expect(hook.render().pending).toBe(false);

    host.invoke.mockResolvedValueOnce({ ...SNAPSHOT, outputVolume: 0.95 });
    finishFirst?.({ ...SNAPSHOT, outputVolume: 0.7 });
    await settle();
    // Aradaki 0.8 birlestirildi; son istek gonderildi ve Rust'in degerine donuldu.
    expect(sentVolumes()).toEqual([0.7, 0.95]);
    expect(hook.render().outputVolume).toBe(0.95);
  });

  it('otoriter degere doner ve basarisiz ses duzeyi komutunu bildirir', async () => {
    host.invoke.mockRejectedValueOnce(new Error('private'));
    hook.render().setOutputVolume(0.3);
    expect(hook.render().outputVolume).toBe(0.3);
    await settle();
    expect(hook.render().outputVolume).toBe(1);
    expect(hook.render().error).toBe('Ses ayarı değiştirilemedi. Yeniden dene.');
  });

  it('host hazir olmadan kaydirici girdisini yok sayar', async () => {
    hook.unmount();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    await hook.mount();
    hook.render().setOutputVolume(0.4);
    await settle();
    expect(sentVolumes()).toEqual([]);
    expect(hook.render().outputVolume).toBe(1);
  });
});
