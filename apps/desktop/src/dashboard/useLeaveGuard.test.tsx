import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import { button, fakeDialog, find, fire, mount, settle, textOf } from '../hookTestHost.js';
import { windowCmd } from './api.js';
import { useLeaveGuard } from './useLeaveGuard.js';

vi.mock('react', async (original) =>
  (await import('../hookTestHost.js')).reactWithHost(await original<typeof React>()),
);
// Pencere ve komut katmani Tauri'ye baglanir; onay kutusu sozlesmesi onlari bilmez.
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({}) }));
vi.mock('./api.js', () => ({
  hasTauri: () => false,
  reportDashboardError: vi.fn(),
  windowCmd: vi.fn(() => Promise.resolve({ ok: true, value: undefined })),
}));

const doc = { activeElement: null };

/** Kancayi kurar ve gercek bir `<dialog>` yerine taklidi baglar (useModalDialog.test.ts ile ayni desen). */
function setup() {
  const view = mount(() => useLeaveGuard());
  let current = view.render();
  const dialog = fakeDialog();
  (
    find(current.dialog, (element) => element.type === 'dialog').props.ref as { current: unknown }
  ).current = dialog;
  view.flush();
  return {
    dialog,
    get guard() {
      return current;
    },
    /** Durum degisti: yeniden cizer ve bekleyen efektleri kosar. */
    refresh() {
      current = view.render();
      view.flush();
    },
    unmount: view.unmount,
  };
}

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', doc);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useLeaveGuard onay kutusu', () => {
  it('pano kapatma kirliyken bile onay acmadan Rust gizleme komutuna gider', async () => {
    const view = setup();
    view.guard.setDirty(true);
    await view.guard.requestClose();
    view.refresh();
    expect(windowCmd).toHaveBeenCalledWith('mission_close');
    expect(view.dialog.showModal).not.toHaveBeenCalled();
    expect(view.guard.dirty).toBe(true);
  });

  it('temizken sormaz, kirliyken yerel modal olarak acar', async () => {
    const view = setup();
    expect(await view.guard.confirmDiscard()).toBe(true);
    expect(view.dialog.showModal).not.toHaveBeenCalled();

    view.guard.setDirty(true);
    const answer = view.guard.confirmDiscard();
    view.refresh();
    expect(view.dialog.showModal).toHaveBeenCalledTimes(1);
    expect(view.dialog.open).toBe(true);
    fire(button(view.guard.dialog, 'Düzenlemeye dön'), 'onClick');
    expect(await answer).toBe(false);
  });

  it('"Kaydetmeden devam et" true, "Düzenlemeye dön" false doner ve kutuyu kapatir', async () => {
    for (const [label, expected] of [
      ['Kaydetmeden devam et', true],
      ['Düzenlemeye dön', false],
    ] as const) {
      const view = setup();
      view.guard.setDirty(true);
      const answer = view.guard.confirmDiscard();
      view.refresh();
      fire(button(view.guard.dialog, label), 'onClick');
      view.refresh();
      expect(await answer).toBe(expected);
      expect(view.dialog.close).toHaveBeenCalledTimes(1);
      expect(view.dialog.open).toBe(false);
    }
  });

  it('Escape ile yerel kapanis "kal" sayilir ve ikinci kez cozulmez', async () => {
    const view = setup();
    view.guard.setDirty(true);
    const answer = view.guard.confirmDiscard();
    view.refresh();
    view.dialog.open = false; // tarayici once kapatir, `close` olayi sonra gelir
    view.dialog.emit('close');
    expect(await answer).toBe(false);
    view.refresh();
    expect(view.dialog.listenerCount('close')).toBe(0);
  });

  it('pano kapanirken acik soru "kal" sayilir; hicbir cagiran asili kalmaz', async () => {
    const view = setup();
    view.guard.setDirty(true);
    const answer = view.guard.confirmDiscard();
    view.refresh();
    view.unmount();
    await settle();
    expect(await answer).toBe(false);
  });

  it('uyari metni sen bicimindedir', () => {
    const view = setup();
    expect(textOf(view.guard.dialog)).toContain('Devam edersen');
  });
});
