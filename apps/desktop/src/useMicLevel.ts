import { useCallback, useEffect, useRef, useState } from 'react';

import { logFailure } from './logFailure.js';
import { loadTauri, type TauriApi } from './tauriHost.js';

/**
 * Mikrofon seviye kancasi (Faz 0). Tauri host'undaki ses alt sistemini
 * surer: audio_start/audio_stop komutlarini cagirir, 'audio://level'
 * olaylarini dinler.
 *
 * Tauri disinda (tarayicida Vite dev) zarifce devre disi kalir: ses yalniz
 * masaustu uygulamasinda calisir.
 */

export interface MicState {
  /**
   * `initializing` host sorgulaniyor, `ready` hazir, `unavailable` Tauri host'u
   * yok (tarayici modu), `error` host var ama hazirlanamadi. "Host yok" mesaji
   * yalniz `unavailable`da dogrudur; acilista kisa sure yanlis parlamasin diye
   * `initializing` ayri tutulur.
   */
  status: 'initializing' | 'ready' | 'unavailable' | 'error';
  /** `audio_start`/`audio_stop` komutu ucta; ikinci tiklama bekler. */
  pending: boolean;
  /** Tauri host'u hazir (`status === 'ready'`). */
  available: boolean;
  capturing: boolean;
  rms: number;
  peak: number;
  error: string | null;
  devices: string[];
}

type MicSnapshot = Omit<MicState, 'available'>;

export function useMicLevel(): MicState & {
  start: (device?: string) => void;
  stop: () => void;
} {
  const [state, setState] = useState<MicSnapshot>({
    status: 'initializing',
    pending: false,
    capturing: false,
    rms: 0,
    peak: 0,
    error: null,
    devices: [],
  });
  const apiRef = useRef<TauriApi | null>(null);
  const busy = useRef(false);
  /** `state.capturing`in senkron aynasi: komut ucundayken tekrar karar vermek icin. */
  const capturing = useRef(false);
  /** Her mount yeni bir nesildir; eski nesil cevaplari atilir (StrictMode, yeniden mount). */
  const generation = useRef(0);

  useEffect(() => {
    const version = ++generation.current;
    let alive = true;
    let release: (() => void) | undefined;
    void (async () => {
      try {
        const api = await loadTauri();
        if (!alive) return;
        if (!api) {
          setState((s) => ({ ...s, status: 'unavailable' }));
          return;
        }
        const handle = await api.listen<{ rms: number; peak: number }>('audio://level', (e) => {
          if (alive) setState((s) => ({ ...s, rms: e.payload.rms, peak: e.payload.peak }));
        });
        // Dinleyici kurulurken bilesen soktuyse tutamaci hemen birak.
        if (!alive) {
          handle();
          return;
        }
        release = handle;
        const devices = await api.invoke<string[]>('audio_devices');
        if (!alive || version !== generation.current) return;
        apiRef.current = api;
        setState((s) => ({ ...s, status: 'ready', devices }));
      } catch (error) {
        logFailure('mic init', error);
        if (alive)
          setState((s) => ({
            ...s,
            status: 'error',
            error: 'Mikrofon hazırlanamadı. Pencereyi yeniden aç.',
          }));
      }
    })();
    return () => {
      alive = false;
      generation.current = version + 1;
      apiRef.current = null;
      release?.();
    };
  }, []);

  const changeCapture = useCallback((start: boolean, device?: string) => {
    const api = apiRef.current;
    if (!api || busy.current || capturing.current === start) return;
    busy.current = true;
    const version = generation.current;
    setState((s) => ({ ...s, pending: true, error: null }));
    void (async () => {
      try {
        if (start && /Mac/.test(navigator.platform)) {
          const perms = await import('tauri-plugin-macos-permissions-api');
          if (!(await perms.checkMicrophonePermission())) await perms.requestMicrophonePermission();
          if (!(await perms.checkMicrophonePermission())) {
            if (version === generation.current)
              setState((s) => ({
                ...s,
                error: 'Mikrofon izni verilmedi. Sistem Ayarları → Gizlilik → Mikrofon.',
              }));
            return;
          }
        }
        if (version !== generation.current) return;
        await api.invoke(start ? 'audio_start' : 'audio_stop', start && device ? { device } : {});
        if (version !== generation.current) return;
        capturing.current = start;
        setState((s) => ({ ...s, capturing: start, rms: 0, peak: 0, error: null }));
      } catch (error) {
        logFailure(start ? 'mic start' : 'mic stop', error);
        if (version === generation.current)
          setState((s) => ({
            ...s,
            error: start
              ? 'Dinleme başlatılamadı. Mikrofonu kontrol edip yeniden dene.'
              : 'Dinleme durdurulamadı. Yeniden dene.',
          }));
      } finally {
        busy.current = false;
        if (version === generation.current) setState((s) => ({ ...s, pending: false }));
      }
    })();
  }, []);
  const start = useCallback((device?: string) => changeCapture(true, device), [changeCapture]);
  const stop = useCallback(() => changeCapture(false), [changeCapture]);
  return { ...state, available: state.status === 'ready', start, stop };
}
