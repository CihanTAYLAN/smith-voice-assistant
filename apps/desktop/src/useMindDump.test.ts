import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import { host, hookRunner, installHost, removeHost, settle } from './hookTestHost.js';
import { mindDumpFrom, useMindDump } from './useMindDump.js';

const t = await vi.hoisted(() => import('./hookTestHost.js'));
vi.mock('react', async (original) => t.reactWithHost(await original<typeof React>()));
vi.mock('@tauri-apps/api/core', () => ({ invoke: t.host.invoke }));

const hook = hookRunner(useMindDump);

/** Elle cozulen bir `zihin_dokumu` cevabi: yavas donen komutu taklit eder. */
function pendingDump(): { promise: Promise<string>; answer: (text: string) => void } {
  let answer: (text: string) => void = () => {};
  const promise = new Promise<string>((resolve) => {
    answer = resolve;
  });
  return { promise, answer };
}

beforeEach(() => {
  installHost();
  // Basarisiz komutlar maskeli olarak console'a yazilir; test ciktisini kirletmesin.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  hook.unmount();
  removeHost();
  vi.restoreAllMocks();
});

describe('mindDumpFrom', () => {
  it('bos metni bos, digerlerini hazir sayar', () => {
    expect(mindDumpFrom('')).toEqual({ status: 'empty' });
    expect(mindDumpFrom('  \n\t')).toEqual({ status: 'empty' });
    expect(mindDumpFrom('baglam')).toEqual({ status: 'ready', text: 'baglam' });
  });
});

describe('useMindDump', () => {
  it('komut yanit verene dek okunuyor kalir, sonra baglami gosterir', async () => {
    const first = pendingDump();
    host.invoke.mockReturnValueOnce(first.promise);
    await hook.mount();
    expect(hook.render().dump).toEqual({ status: 'loading' });
    first.answer('Oturum bağlamı');
    await settle();
    expect(hook.render().dump).toEqual({ status: 'ready', text: 'Oturum bağlamı' });
    expect(host.invoke).toHaveBeenCalledWith('zihin_dokumu', {});
  });

  it('bos cevabi bos gosterir, asla okunuyor degil', async () => {
    host.invoke.mockResolvedValueOnce('');
    await hook.mount();
    expect(hook.render().dump).toEqual({ status: 'empty' });
  });

  it('basarisiz komutu bildirir, yeniden denemede toparlanir', async () => {
    host.invoke.mockRejectedValueOnce(new Error('token=private'));
    await hook.mount();
    expect(hook.render().dump).toEqual({ status: 'error' });
    host.invoke.mockResolvedValueOnce('geri geldi');
    hook.render().retry();
    expect(hook.render().dump).toEqual({ status: 'loading' });
    await settle();
    expect(hook.render().dump).toEqual({ status: 'ready', text: 'geri geldi' });
  });

  it('yeniden denemeden sonra eski istegin gec cevabini yok sayar', async () => {
    const slow = pendingDump();
    host.invoke.mockReturnValueOnce(slow.promise);
    await hook.mount();
    host.invoke.mockResolvedValueOnce('yeni');
    hook.render().retry();
    await settle();
    expect(hook.render().dump).toEqual({ status: 'ready', text: 'yeni' });
    slow.answer('eski');
    await settle();
    expect(hook.render().dump).toEqual({ status: 'ready', text: 'yeni' });
  });

  it('dialog kapandiktan sonra gelen cevabi atar', async () => {
    const slow = pendingDump();
    host.invoke.mockReturnValueOnce(slow.promise);
    await hook.mount();
    hook.unmount();
    slow.answer('gec cevap');
    await settle();
    expect(hook.render().dump).toEqual({ status: 'loading' });
  });
});
