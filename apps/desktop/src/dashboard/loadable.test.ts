import { describe, expect, it, vi } from 'vitest';

import type { Result } from './api.js';
import { createGate, createLoadable, nextLoadState, type LoadState } from './loadable.js';
import { deferred } from './testing.js';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, code: 'failed', error });

describe('nextLoadState', () => {
  const loading: LoadState<string> = { status: 'loading' };

  it('ilk basarili okuma hazir olur', () => {
    expect(nextLoadState(loading, ok('a'), 10)).toEqual({ status: 'ready', data: 'a', at: 10 });
  });

  it('veri yokken hata, hata olarak kalir (bos gibi gorunmez)', () => {
    expect(nextLoadState(loading, fail('x'))).toEqual({ status: 'error', error: 'x' });
  });

  it('yenileme basarisiz olunca eski veri korunur ve bayat olur', () => {
    const ready = nextLoadState(loading, ok('a'), 10);
    expect(nextLoadState(ready, fail('x'), 20)).toEqual({
      status: 'stale',
      data: 'a',
      at: 10,
      error: 'x',
    });
  });

  it('bayat veri tekrar basarili okumayla temizlenir', () => {
    const stale = nextLoadState(nextLoadState(loading, ok('a'), 10), fail('x'), 20);
    expect(nextLoadState(stale, ok('b'), 30)).toEqual({ status: 'ready', data: 'b', at: 30 });
  });
});

describe('createGate', () => {
  it('yalniz en son bilet gecerlidir', () => {
    const gate = createGate();
    const first = gate.next();
    const second = gate.next();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it('cancel bekleyen biletleri eskitir', () => {
    const gate = createGate();
    const ticket = gate.next();
    gate.cancel();
    expect(gate.isCurrent(ticket)).toBe(false);
  });
});

describe('createLoadable', () => {
  it('ilk durum yukleniyor; sonuc gelince hazir ve zaman damgali', async () => {
    const pending = deferred<Result<string>>();
    const loadable = createLoadable(
      () => pending.promise,
      () => 42,
    );
    expect(loadable.getSnapshot()).toEqual({ state: { status: 'loading' }, refreshing: false });

    const done = loadable.reload();
    expect(loadable.getSnapshot().refreshing).toBe(true);
    expect(loadable.getSnapshot().state.status).toBe('loading');

    pending.resolve(ok('veri'));
    await done;
    expect(loadable.getSnapshot()).toEqual({
      state: { status: 'ready', data: 'veri', at: 42 },
      refreshing: false,
    });
  });

  it('tek-ucus: istek surerken ikinci istek acilmaz, ayni sonuca katilir', async () => {
    const pending = deferred<Result<string>>();
    const load = vi.fn(() => pending.promise);
    const loadable = createLoadable(load);

    const first = loadable.reload();
    const second = loadable.reload(true);
    expect(second).toBe(first);
    pending.resolve(ok('a'));
    await first;
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('yenileme bayragini yukleyiciye iletir', async () => {
    const load = vi.fn(() => Promise.resolve(ok('a')));
    const loadable = createLoadable(load);
    await loadable.reload();
    await loadable.reload(true);
    expect(load.mock.calls).toEqual([[false], [true]]);
  });

  it('basarisiz yenileme eski veriyi bayat olarak tutar, yenile dugmesi acilir', async () => {
    const results = [ok('a'), fail('sunucu yok')];
    const loadable = createLoadable(
      () => Promise.resolve(results.shift() ?? fail('bos')),
      () => 7,
    );
    await loadable.reload();
    await loadable.reload(true);
    expect(loadable.getSnapshot()).toEqual({
      state: { status: 'stale', data: 'a', at: 7, error: 'sunucu yok' },
      refreshing: false,
    });
  });

  it('aboneleri her yayinda haberdar eder; abonelik birakilabilir', async () => {
    const loadable = createLoadable(() => Promise.resolve(ok('a')));
    const listener = vi.fn();
    const unsubscribe = loadable.subscribe(listener);

    await loadable.reload();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await loadable.reload(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
