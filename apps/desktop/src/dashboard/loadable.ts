import { useEffect, useState, useSyncExternalStore } from 'react';

import type { Result } from './api.js';

/**
 * Bir veri yuzeyinin ACIK durumu. Ilk yukleme hicbir zaman "bos" gibi
 * gorunmez; "bos" ise verinin kendisidir (hazir + bos liste) ve tuketiciye aittir.
 *
 *  - loading : ilk okuma suruyor, elde veri yok
 *  - ready   : son okuma basarili
 *  - error   : okuma basarisiz ve elde gosterilecek veri yok
 *  - stale   : yenileme basarisiz; eski veri korunur ve BAYAT diye isaretlenir
 */
export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T; at: number }
  | { status: 'error'; error: string }
  | { status: 'stale'; data: T; at: number; error: string };

/** Gosterilebilir veri varsa (hazir veya bayat) onu, yoksa undefined doner. */
export function dataOf<T>(state: LoadState<T>): T | undefined {
  return state.status === 'ready' || state.status === 'stale' ? state.data : undefined;
}

export function nextLoadState<T>(
  previous: LoadState<T>,
  result: Result<T>,
  now: number = Date.now(),
): LoadState<T> {
  if (result.ok) return { status: 'ready', data: result.value, at: now };
  if (previous.status === 'ready' || previous.status === 'stale') {
    return { status: 'stale', data: previous.data, at: previous.at, error: result.error };
  }
  return { status: 'error', error: result.error };
}

/**
 * Monoton bilet: yalniz EN SON alinan bilet gecerlidir. Gec kalan eski cevap
 * `isCurrent` ile elenir; `cancel` bekleyen butun biletleri eskitir (unmount).
 */
export interface Gate {
  next: () => number;
  isCurrent: (ticket: number) => boolean;
  cancel: () => void;
}

export function createGate(): Gate {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (ticket) => ticket === current,
    cancel: () => {
      current++;
    },
  };
}

export function useGate(): Gate {
  return useState(createGate)[0];
}

export interface LoadableSnapshot<T> {
  state: LoadState<T>;
  /** Bir istek ucuyor (ilk okuma dahil); yenile dugmesi buna bakar. */
  refreshing: boolean;
}

export interface Loadable<T> {
  getSnapshot: () => LoadableSnapshot<T>;
  subscribe: (listener: () => void) => () => void;
  /** Tek-ucus: istek surerken yeni istek acmaz, surmekte olana katilir. */
  reload: (refresh?: boolean) => Promise<void>;
}

/**
 * Cerceve-bagimsiz yukleme deposu: TEK-UCUS (ayni anda tek istek; eski cevabin
 * yeni veriyi ezmesi mumkun degil) + bayat durum. Depo bilesenden uzun yasar:
 * unmount sonrasi gelen cevap yalniz depoyu gunceller, kimseyi tetiklemez.
 * `load` HICBIR ZAMAN reddetmez (api.ts sozlesmesi: `Result` doner).
 */
export function createLoadable<T>(
  load: (refresh: boolean) => Promise<Result<T>>,
  clock: () => number = Date.now,
): Loadable<T> {
  let snapshot: LoadableSnapshot<T> = { state: { status: 'loading' }, refreshing: false };
  let flight: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: LoadableSnapshot<T>): void => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reload: (refresh = false) => {
      if (flight) return flight;
      publish({ ...snapshot, refreshing: true });
      flight = load(refresh).then((result) => {
        flight = null;
        publish({ state: nextLoadState(snapshot.state, result, clock()), refreshing: false });
      });
      return flight;
    },
  };
}

export interface LoadableView<T> extends LoadableSnapshot<T> {
  reload: (refresh?: boolean) => Promise<void>;
}

/**
 * `createLoadable`in React baglantisi: mount'ta okur (StrictMode'un cift effect'i
 * de tek istege iner). `load` modul duzeyinde SABIT bir fonksiyon olmalidir.
 */
export function useLoadable<T>(load: (refresh: boolean) => Promise<Result<T>>): LoadableView<T> {
  const [loadable] = useState(() => createLoadable(load));
  const snapshot = useSyncExternalStore(
    loadable.subscribe,
    loadable.getSnapshot,
    loadable.getSnapshot,
  );
  useEffect(() => {
    void loadable.reload();
  }, [loadable]);
  return { ...snapshot, reload: loadable.reload };
}
