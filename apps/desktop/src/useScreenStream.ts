import { useCallback, useEffect, useRef, useState } from 'react';

import {
  SCREEN_STREAM_EVENT,
  parseScreenStreamEvent,
  readScreenStream,
  toggleScreenStream,
} from './screenStream.js';
import { logFailure } from './logFailure.js';
import { loadTauri, type TauriApi } from './tauriHost.js';

export interface ScreenState {
  aktif: boolean;
  /** Ilk Live baglantisi bildirilene kadar aralik bilinmez. */
  aralikMs: number | null;
}

export interface ScreenStreamControl {
  ready: boolean;
  pending: boolean;
  error: string | null;
  toggle: () => void;
}

/** Komut, tepsi ve Live olaylari ayni ekran durumuna yazilir. */
export function useScreenStream(): ScreenStreamControl & {
  screen: ScreenState | null;
  apply: (aktif: boolean, aralikMs?: number) => void;
} {
  const [screen, setScreen] = useState<ScreenState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apiRef = useRef<TauriApi | null>(null);
  const current = useRef<boolean | null>(null);
  const revision = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(false);

  const apply = useCallback((aktif: boolean, aralikMs?: number): void => {
    revision.current++;
    current.current = aktif;
    setError(null);
    setScreen((prev) => ({ aktif, aralikMs: aralikMs ?? prev?.aralikMs ?? null }));
  }, []);

  useEffect(() => {
    let alive = true;
    mounted.current = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const api = await loadTauri();
        if (!alive || !api) return;
        apiRef.current = api;
        const handle = await api.listen<unknown>(SCREEN_STREAM_EVENT, (e) => {
          const value = parseScreenStreamEvent(e.payload);
          if (alive && value !== null) apply(value);
        });
        if (!alive) {
          handle();
          return;
        }
        unlisten = handle;
        const before = revision.current;
        const value = await readScreenStream(api);
        // Gec gelen ilk okuma, daha yeni bir olayin ustune yazamaz.
        if (alive && before === revision.current) apply(value);
      } catch (error) {
        logFailure('screen-stream read', error);
        if (alive) setError('Ekran akışı durumu okunamadı. Tepsiden kontrol et.');
      }
    })();
    return () => {
      alive = false;
      mounted.current = false;
      apiRef.current = null;
      unlisten?.();
    };
  }, [apply]);

  const toggle = useCallback(() => {
    const api = apiRef.current;
    if (!api || current.current === null || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const before = revision.current;
    void toggleScreenStream(api, current.current)
      .then((value) => {
        if (mounted.current && before === revision.current) apply(value);
      })
      .catch((error: unknown) => {
        logFailure('screen-stream set', error);
        if (mounted.current) setError('Ekran akışı değiştirilemedi. Tepsiden kontrol et.');
      })
      .finally(() => {
        busy.current = false;
        if (mounted.current) setPending(false);
      });
  }, [apply]);

  return { screen, apply, ready: screen !== null, pending, error, toggle };
}
