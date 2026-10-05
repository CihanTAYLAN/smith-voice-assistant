import { describe, expect, it, vi } from 'vitest';

import { CLOSE_FAILED, createLeaveGuard, type LeaveGuardPorts } from './leaveGuard.js';
import { deferred } from './testing.js';

function setup(overrides: Partial<LeaveGuardPorts> = {}) {
  const question = deferred<boolean>();
  const watch = { request: () => {}, release: vi.fn() };
  const ports = {
    askDiscard: vi.fn(() => question.promise),
    hideWindow: vi.fn(() => Promise.resolve()),
    watchNativeClose: vi.fn((onRequest: () => void) => {
      watch.request = onRequest;
      return Promise.resolve(watch.release);
    }),
    report: vi.fn(),
    ...overrides,
  } satisfies LeaveGuardPorts;
  const guard = createLeaveGuard(ports);
  return { guard, ports, question, watch };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function started(guard: ReturnType<typeof setup>['guard']): Promise<() => void> {
  const stop = guard.start();
  await flush();
  return stop;
}

describe('confirmDiscard', () => {
  it('temizken sormadan devam eder', async () => {
    const { guard, ports } = setup();
    expect(await guard.confirmDiscard()).toBe(true);
    expect(ports.askDiscard).not.toHaveBeenCalled();
  });

  it('kirliyken kullanicinin kararini dondurur', async () => {
    const { guard, question } = setup();
    guard.setDirty(true);
    const answer = guard.confirmDiscard();
    question.resolve(false);
    expect(await answer).toBe(false);
  });

  it('soru acikken ikinci soru acmaz', async () => {
    const { guard, ports, question } = setup();
    guard.setDirty(true);
    const first = guard.confirmDiscard();
    expect(await guard.confirmDiscard()).toBe(false);
    question.resolve(true);
    expect(await first).toBe(true);
    expect(ports.askDiscard).toHaveBeenCalledTimes(1);
  });
});

describe('kapatma gizlemedir', () => {
  it('kirli icerikte onay sormadan ayni pencereyi gizler', async () => {
    const { guard, ports } = setup();
    await started(guard);
    guard.setDirty(true);
    await guard.requestClose();
    expect(ports.askDiscard).not.toHaveBeenCalled();
    expect(ports.hideWindow).toHaveBeenCalledTimes(1);
    expect(guard.getSnapshot().dirty).toBe(true);
  });

  it('yerel X veya Alt+F4 ayni gizleme yolunu kullanir', async () => {
    const { guard, ports, watch } = setup();
    await started(guard);
    guard.setDirty(true);
    watch.request();
    await flush();
    expect(ports.askDiscard).not.toHaveBeenCalled();
    expect(ports.hideWindow).toHaveBeenCalledTimes(1);
    expect(guard.getSnapshot().dirty).toBe(true);
  });

  it('ayni anda tek gizleme cagrisi yurur', async () => {
    const pending = deferred<void>();
    const { guard, ports } = setup({ hideWindow: vi.fn(() => pending.promise) });
    const first = guard.requestClose();
    await guard.requestClose();
    expect(ports.hideWindow).toHaveBeenCalledTimes(1);
    pending.resolve();
    await first;
  });

  it('gizleme hatasinda ham ayrintiyi state e sizdirmaz', async () => {
    const { guard, ports } = setup({
      hideWindow: vi.fn(() => Promise.reject(new Error('C:\\private token=secret'))),
    });
    await guard.requestClose();
    expect(guard.getSnapshot().closeError).toBe(CLOSE_FAILED);
    expect(ports.report).toHaveBeenCalledWith('close', expect.any(Error));
    expect(JSON.stringify(guard.getSnapshot())).not.toContain('private');
  });
});

describe('dinleyici kurulumu', () => {
  it('kurulunca guarded olur, birakilinca kapanir', async () => {
    const { guard, watch } = setup();
    const stop = await started(guard);
    expect(guard.getSnapshot().guarded).toBe(true);
    stop();
    expect(watch.release).toHaveBeenCalledTimes(1);
    expect(guard.getSnapshot().guarded).toBe(false);
  });

  it('kurulum hatasini raporlar ama Rust gizleme guvenlik agini bozmaz', async () => {
    const { guard, ports } = setup({
      watchNativeClose: vi.fn(() => Promise.reject(new Error('izin yok'))),
    });
    await started(guard);
    expect(guard.getSnapshot().guarded).toBe(false);
    expect(ports.report).toHaveBeenCalledWith('close-guard', expect.any(Error));
    await guard.requestClose();
    expect(ports.hideWindow).toHaveBeenCalledTimes(1);
  });

  it('kurulum bitmeden birakilirsa gelen dinleyiciyi hemen salar', async () => {
    const pending = deferred<() => void>();
    const release = vi.fn();
    const { guard } = setup({ watchNativeClose: vi.fn(() => pending.promise) });
    const stop = guard.start();
    stop();
    pending.resolve(release);
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
    expect(guard.getSnapshot().guarded).toBe(false);
  });
});

describe('abonelik', () => {
  it('ayni degeri yazmak aboneleri uyandirmaz', () => {
    const { guard } = setup();
    const listener = vi.fn();
    guard.subscribe(listener);
    guard.setDirty(false);
    expect(listener).not.toHaveBeenCalled();
    guard.setDirty(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
