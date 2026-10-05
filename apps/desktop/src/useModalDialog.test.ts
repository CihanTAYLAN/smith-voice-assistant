import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as React from 'react';

import { fakeDialog, mount } from './hookTestHost.js';
import { useModalDialog } from './useModalDialog.js';

vi.mock('react', async (original) =>
  (await import('./hookTestHost.js')).reactWithHost(await original<typeof React>()),
);

interface FakeElement {
  focus: ReturnType<typeof vi.fn>;
  isConnected: boolean;
}

const focusable = (isConnected = true): FakeElement => ({ focus: vi.fn(), isConnected });

const doc = { activeElement: null as FakeElement | null };

function setup(initialOpen: boolean, fallback?: FakeElement) {
  let open = initialOpen;
  let onClose: Mock<() => void> = vi.fn();
  const fallbackRef = fallback ? { current: fallback as unknown as HTMLElement } : undefined;
  const dialog = fakeDialog();
  const view = mount(() => useModalDialog(open, onClose, fallbackRef));
  const ref = view.render();
  ref.current = dialog as unknown as HTMLDialogElement;
  view.flush();
  return {
    dialog,
    get onClose() {
      return onClose;
    },
    setOpen: (next: boolean) => {
      open = next;
      view.render();
      view.flush();
    },
    setOnClose: (next: Mock<() => void>) => {
      onClose = next;
      view.render();
      view.flush();
    },
    /** Ayni gorevde kapat + yeniden ac (StrictMode'un efekt cift calistirmasi). */
    unmountAndRemount: () => {
      open = false;
      view.render();
      view.flush();
      open = true;
      view.render();
      view.flush();
    },
    unmount: view.unmount,
  };
}

beforeEach(() => {
  doc.activeElement = null;
  vi.stubGlobal('document', doc);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useModalDialog', () => {
  it('acikken showModal cagirir, kapaliyken cagirmaz', () => {
    const closed = setup(false);
    expect(closed.dialog.showModal).not.toHaveBeenCalled();

    const opened = setup(true);
    expect(opened.dialog.showModal).toHaveBeenCalledTimes(1);
    expect(opened.dialog.open).toBe(true);
  });

  it('zaten aciksa showModal tekrar cagrilmaz (InvalidStateError onlenir)', () => {
    const view = setup(false);
    view.dialog.open = true;
    view.setOpen(true);
    expect(view.dialog.showModal).not.toHaveBeenCalled();
  });

  it('acilinca ve kapaninca ayni odak ogesi geri alinir', () => {
    const opener = focusable();
    doc.activeElement = opener;
    const view = setup(true);
    expect(opener.focus).not.toHaveBeenCalled();

    view.setOpen(false);
    expect(view.dialog.close).toHaveBeenCalledTimes(1);
    expect(opener.focus).toHaveBeenCalledTimes(1);
  });

  it('acan oge DOM disina ciktiysa odak yedek ogeye gider', () => {
    const opener = focusable(false);
    const fallback = focusable();
    doc.activeElement = opener;
    const view = setup(true, fallback);
    view.setOpen(false);
    expect(opener.focus).not.toHaveBeenCalled();
    expect(fallback.focus).toHaveBeenCalledTimes(1);
  });

  it('yerel kapanis (Escape) en guncel onClose ile bildirilir', () => {
    const view = setup(true);
    const latest = vi.fn();
    view.setOnClose(latest);
    view.dialog.open = false; // tarayici once kapatir, `close` olayi sonra gelir
    view.dialog.emit('close');
    expect(latest).toHaveBeenCalledTimes(1);
    expect(view.onClose).toBe(latest);
  });

  it('StrictMode: kapat-hemen-yeniden-ac sirasindaki GECIKMIS close olayi yeni acilisi kapatmaz', () => {
    // React gelistirmede efekti kapatip hemen yeniden calistirir; ilk close() cagrisinin
    // olayi asenkron oldugu icin yeni dinleyiciye, dialog tekrar aciktan sonra ulasir.
    const view = setup(true);
    view.unmountAndRemount();
    expect(view.dialog.open).toBe(true);
    view.dialog.emit('close');
    expect(view.onClose).not.toHaveBeenCalled();
  });

  it('prop ile kapatinca olay dinleyicisi birakilir; ikinci bildirim olmaz', () => {
    const view = setup(true);
    expect(view.dialog.listenerCount('close')).toBe(1);
    view.setOpen(false);
    expect(view.dialog.listenerCount('close')).toBe(0);
    view.dialog.emit('close');
    expect(view.onClose).not.toHaveBeenCalled();
  });

  it('acikken bilesen kalkarsa dialog kapanir ve odak geri verilir', () => {
    const opener = focusable();
    doc.activeElement = opener;
    const view = setup(true);
    view.unmount();
    expect(view.dialog.close).toHaveBeenCalledTimes(1);
    expect(opener.focus).toHaveBeenCalledTimes(1);
  });
});
