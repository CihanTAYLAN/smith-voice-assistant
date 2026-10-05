import { describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import { button, find, fire, mount } from '../hookTestHost.js';
import { MissionControl } from '../mission/MissionControl.js';
import { Dashboard } from './Dashboard.js';

vi.mock('react', async (original) =>
  (await import('../hookTestHost.js')).reactWithHost(await original<typeof React>()),
);
// Terk korumasi Tauri pencere API'sine baglanir; kabuk testi onu bilmez.
vi.mock('./useLeaveGuard.js', () => ({
  useLeaveGuard: () => ({
    dirty: false,
    guarded: true,
    closeError: null,
    setDirty: () => {},
    confirmDiscard: () => Promise.resolve(true),
    requestClose: () => Promise.resolve(),
    dialog: null,
  }),
}));

/** Kabugu kurar; `aktif`, Gorevler bolumunun pano yoklamasina verilen izindir. */
function shell() {
  const view = mount(() => Dashboard());
  let tree = view.render();
  return {
    get aktif() {
      return find(tree, (element) => element.type === MissionControl).props.aktif;
    },
    open(label: string) {
      fire(button(tree, label), 'onClick');
      tree = view.render();
    },
  };
}

describe('Dashboard kabugu: Mission Control anketi', () => {
  it('acilista Gorevler gorunmez, anket kapalidir', () => {
    expect(shell().aktif).toBe(false);
  });

  it('anket yalniz Gorevler bolumu gorunurken calisir, baska bolume gecince durur', () => {
    const dashboard = shell();
    dashboard.open('görevler');
    expect(dashboard.aktif).toBe(true);
    dashboard.open('dosyalar');
    expect(dashboard.aktif).toBe(false);
    dashboard.open('görevler');
    expect(dashboard.aktif).toBe(true);
    dashboard.open('kontrol');
    expect(dashboard.aktif).toBe(false);
  });
});
