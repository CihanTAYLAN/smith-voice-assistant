import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import {
  defaultListen,
  emit,
  host,
  installHost,
  listen,
  mount,
  removeHost,
  settle,
} from './hookTestHost.js';
import { MIND_SWEEP_MS, MIND_TTL_MS } from './mindBubbles.js';
import { useMindStream } from './useMindStream.js';

const t = await vi.hoisted(() => import('./hookTestHost.js'));
vi.mock('react', async (original) => t.reactWithHost(await original<typeof React>()));
vi.mock('@tauri-apps/api/core', () => ({ invoke: t.host.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: t.listen }));

/** Kabarcik hook'u; efektler `flush` ile kosar (sonme suepurgesi bir efekttir). */
async function start() {
  const view = mount(useMindStream);
  view.render();
  view.flush();
  await settle();
  return {
    bubbles: () => view.render().map((bubble) => bubble.text),
    refresh: () => {
      view.render();
      view.flush();
    },
    unmount: view.unmount,
  };
}

beforeEach(() => {
  installHost();
  // Basarisiz abonelikler maskeli olarak console'a yazilir; test ciktisini kirletmesin.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  host.invoke.mockResolvedValue({});
});
afterEach(() => {
  removeHost();
  vi.restoreAllMocks();
});

describe('useMindStream', () => {
  it('gercek bir Rust olayini dusunce kabarcigina cevirir', async () => {
    const mind = await start();
    expect(mind.bubbles()).toEqual([]);
    emit('audio://tool', { ad: 'hafizada_ara', durum: 'basladi' });
    emit('audio://speaker', { karar: 'owner' });
    expect(mind.bubbles()).toEqual(['hafızama bakıyorum…', 'sesini tanıdım']);
    mind.unmount();
  });

  it('etiketler gec gelirse ham arac adi olan kabarcigi yeniler', async () => {
    let finish: (labels: Record<string, string>) => void = () => {};
    host.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const mind = await start();
    emit('audio://tool', { ad: 'gec_etiketli_arac', durum: 'basladi' });
    expect(mind.bubbles()).toEqual(['gec_etiketli_arac']);
    finish({ gec_etiketli_arac: 'gec etiketli arac calisiyor…' });
    await settle();
    expect(mind.bubbles()).toEqual(['gec etiketli arac calisiyor…']);
    mind.unmount();
  });

  it('dinleyicilerden biri kurulamazsa kurulanlari birakir ve cokmez', async () => {
    listen.mockImplementation((name, listener) =>
      name === 'audio://screen'
        ? Promise.reject(new Error('token=private'))
        : defaultListen(name, listener),
    );
    const mind = await start();
    expect(host.listeners.size).toBe(0);
    expect(mind.bubbles()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith('[events subscribe] Error: token=***');
    mind.unmount();
  });

  it('sonen kabarcigi suepurur, liste bosalinca zamanlayici durur', async () => {
    const mind = await start();
    emit('audio://screen', { aktif: true });
    mind.refresh();
    expect(mind.bubbles()).toEqual(['ekranını görüyorum']);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    vi.advanceTimersByTime(MIND_TTL_MS + MIND_SWEEP_MS);
    expect(mind.bubbles()).toEqual([]);
    mind.refresh();
    expect(vi.getTimerCount()).toBe(0);
    mind.unmount();
  });

  it('bilesen sokulunce tum dinleyicileri birakir', async () => {
    const mind = await start();
    mind.unmount();
    expect(host.listeners.size).toBe(0);
  });
});
