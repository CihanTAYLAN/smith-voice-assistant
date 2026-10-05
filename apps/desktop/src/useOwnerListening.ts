import { useCallback, useEffect, useRef, useState } from 'react';

import { logFailure } from './logFailure.js';
import { loadTauri, type TauriApi } from './tauriHost.js';

export type ListeningMode = 'herkes' | 'yalniz_beni' | 'isimle';

export function isListeningMode(value: unknown): value is ListeningMode {
  return value === 'herkes' || value === 'yalniz_beni' || value === 'isimle';
}

export interface ListeningModeState {
  kip: ListeningMode;
  warning: string | null;
}

export interface ListeningModeControl {
  ready: boolean;
  pending: boolean;
  error: string | null;
  setMode: (kip: ListeningMode) => void;
}

/** Komut, tepsi ve Live olaylari ayni dinleme durumuna yazilir. */
export function useListeningMode(): ListeningModeControl & {
  owner: ListeningModeState | null;
  apply: (kip: ListeningMode, warning?: string) => void;
} {
  const [owner, setOwner] = useState<ListeningModeState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apiRef = useRef<TauriApi | null>(null);
  const current = useRef<ListeningMode | null>(null);
  const revision = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(false);

  const apply = useCallback((kip: ListeningMode, warning?: string): void => {
    revision.current++;
    current.current = kip;
    setError(null);
    setOwner({ kip, warning: kip === 'herkes' ? null : (warning ?? null) });
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
        const handle = await api.listen<unknown>('audio://listen-mode', (e) => {
          const value = parseListeningEvent(e.payload);
          if (alive && value !== null) apply(value);
        });
        if (!alive) {
          handle();
          return;
        }
        unlisten = handle;
        const before = revision.current;
        const value = await api.invoke<unknown>('listen_mode_get');
        // Gec gelen ilk okuma, daha yeni bir olayin ustune yazamaz.
        if (!isListeningMode(value)) throw new Error('Gecersiz dinleme durumu');
        if (alive && before === revision.current) apply(value);
      } catch (error) {
        logFailure('listen-mode read', error);
        if (alive) setError('Dinleme modu durumu okunamadı. Tepsiden kontrol et.');
      }
    })();
    return () => {
      alive = false;
      mounted.current = false;
      apiRef.current = null;
      unlisten?.();
    };
  }, [apply]);

  const setMode = useCallback(
    (kip: ListeningMode) => {
      const api = apiRef.current;
      if (!api || current.current === null || busy.current) return;
      busy.current = true;
      setPending(true);
      setError(null);
      const before = revision.current;
      void api
        .invoke<unknown>('listen_mode_set', { kip })
        .then((value) => {
          if (!isListeningMode(value)) throw new Error('Gecersiz dinleme durumu');
          if (mounted.current && before === revision.current) apply(value);
        })
        .catch((error: unknown) => {
          logFailure('listen-mode set', error);
          if (mounted.current) setError('Dinleme modu değiştirilemedi. Tepsiden kontrol et.');
        })
        .finally(() => {
          busy.current = false;
          if (mounted.current) setPending(false);
        });
    },
    [apply],
  );

  return { owner, apply, ready: owner !== null, pending, error, setMode };
}

export function parseListeningEvent(value: unknown): ListeningMode | null {
  if (typeof value !== 'object' || value === null || !('kip' in value)) return null;
  return isListeningMode(value.kip) ? value.kip : null;
}

export function parseListeningTool(
  value: unknown,
): { kip: ListeningMode; warning?: string } | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('ad' in value) ||
    value.ad !== 'dinleme_modu_durumu' ||
    !('durum' in value) ||
    !isListeningMode(value.durum)
  )
    return null;
  const warning = 'sebep' in value && typeof value.sebep === 'string' ? value.sebep : undefined;
  return { kip: value.durum, ...(warning ? { warning } : {}) };
}
