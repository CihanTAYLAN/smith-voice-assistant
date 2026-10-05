import { useCallback, useEffect, useRef, useState } from 'react';

import { logFailure } from './logFailure.js';
import { loadTauri, type TauriApi } from './tauriHost.js';

/**
 * Ses karistiricisi (mixer) kancasi: Rust'taki mixer durumunun UI izi.
 *
 * NEDEN VAR: tek "sustur" dugmesi TUM ses hattini kapatiyordu (mikrofon +
 * Gemini Live oturumu); kullanici bunlari AYRI yonetmek istedi ("mikrofonumu
 * kapatabilecegim, ses duzeyini yonetebilecegim bir karistirici"). Rust tarafi
 * KAYNAKTIR: durum `AudioState`te yasar (oturum kapansa da korunur) ve her
 * degisimde `audio://mixer` olayi yayinlar. Bu hook:
 *
 *  - acilista `audio_mixer_state` ile GERCEK durumu sorar (tahmin yok; frontend
 *    hot-reload olsa bile UI ile Rust ayrisamaz),
 *  - olayi dinleyip aynalar,
 *  - komutlari cagirir ve donen (otoriter) goruntuyu uygular; hata olursa
 *    durum DEGISMEZ, UI eski gercek degeri gosterir.
 *
 * Tauri disinda (tarayicida Vite dev) ya da komut yoksa (eski binary)
 * `ready: false` kalir; mixer bolumu cizilmez, sessiz "tamam" yok.
 *
 * KOMUT KURALLARI. Dugmeler (mikrofon/hoparlor sustur) TEK UCUSTUR: komut
 * ucundayken ikinci tiklama eklenmez (cift tiklama ayni durumu geri cevirirdi).
 * Ses duzeyi ise surekli bir kontroldur (kaydirici): "ilk istek kazanir"
 * kuralinda kullanicinin son birakti deger dusurulurdu, bu yuzden orada SON
 * ISTEK KAZANIR (bkz. `setOutputVolume`).
 */

export interface MixerSnapshot {
  micMuted: boolean;
  outputMuted: boolean;
  outputVolume: number;
}

const INITIAL: MixerSnapshot = { micMuted: false, outputMuted: false, outputVolume: 1 };

const COMMAND_ERROR = 'Ses ayarı değiştirilemedi. Yeniden dene.';

export function useMixer(): MixerSnapshot & {
  ready: boolean;
  /** Bir sustur komutu ucta; dugmeler beklerken kilitlenir (kaydirici kilitlenmez). */
  pending: boolean;
  error: string | null;
  setMicMuted: (muted: boolean) => void;
  setOutputMuted: (muted: boolean) => void;
  setOutputVolume: (volume: number) => void;
} {
  const [state, setState] = useState<MixerSnapshot>(INITIAL);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Kullanicinin kaydiriciyla istedigi son deger; Rust cevabi gelene kadar gosterilir. */
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const apiRef = useRef<TauriApi | null>(null);
  /** Rust'tan gelen her olay/ilk okuma ile artar; eski komut cevabi yeni durumu ezmesin. */
  const revision = useRef(0);
  /** Her mount yeni bir nesildir; eski nesil cevaplari atilir. */
  const generation = useRef(0);
  const busy = useRef(false);
  const volumeQueue = useRef<{ sending: boolean; latest: number | null }>({
    sending: false,
    latest: null,
  });

  useEffect(() => {
    let alive = true;
    const version = ++generation.current;
    let release: (() => void) | undefined;
    void (async () => {
      try {
        const api = await loadTauri();
        if (!alive || !api) return;
        apiRef.current = api;
        const before = revision.current;
        const handle = await api.listen<MixerSnapshot>('audio://mixer', (event) => {
          if (!alive) return;
          revision.current++;
          setState(event.payload);
          setReady(true);
        });
        if (!alive) {
          handle();
          return;
        }
        release = handle;
        const snapshot = await api.invoke<MixerSnapshot>('audio_mixer_state');
        if (alive && version === generation.current && before === revision.current) {
          setState(snapshot);
          setReady(true);
        }
      } catch (error) {
        logFailure('mixer init', error);
        if (alive) setError('Ses ayarları okunamadı. Pencereyi yeniden aç.');
      }
    })();
    return () => {
      alive = false;
      generation.current = version + 1;
      apiRef.current = null;
      release?.();
    };
  }, []);

  const send = useCallback((cmd: string, args: Record<string, unknown>) => {
    const api = apiRef.current;
    if (!api || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const before = revision.current;
    const version = generation.current;
    void api
      .invoke<MixerSnapshot>(cmd, args)
      .then((snapshot) => {
        if (version === generation.current && before === revision.current) setState(snapshot);
      })
      .catch((error: unknown) => {
        logFailure(`mixer ${cmd}`, error);
        if (version === generation.current) setError(COMMAND_ERROR);
      })
      .finally(() => {
        busy.current = false;
        if (version === generation.current) setPending(false);
      });
  }, []);

  /** Kuyrukta bekleyen en son ses duzeyini, ucta komut yokken gonderir. */
  const drainVolume = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    const queue = volumeQueue.current;
    if (!api || queue.sending) return;
    const version = generation.current;
    queue.sending = true;
    try {
      while (queue.latest !== null && version === generation.current) {
        const volume = queue.latest;
        queue.latest = null;
        const before = revision.current;
        try {
          const snapshot = await api.invoke<MixerSnapshot>('audio_set_output_volume', { volume });
          if (version === generation.current && before === revision.current) setState(snapshot);
        } catch (error) {
          logFailure('mixer audio_set_output_volume', error);
          if (version === generation.current) setError(COMMAND_ERROR);
        }
      }
    } finally {
      queue.sending = false;
      if (version === generation.current) setVolumeDraft(null);
    }
  }, []);

  const setMicMuted = useCallback(
    (muted: boolean) => send('audio_set_mic_muted', { muted }),
    [send],
  );
  const setOutputMuted = useCallback(
    (muted: boolean) => send('audio_set_output_muted', { muted }),
    [send],
  );
  /**
   * Kaydirici her harekette bir deger uretir. Ucta komut varken gelen degerler
   * dusurulmez: yalniz en sonuncusu tutulur ve ilk komut bitince gonderilir
   * (aradaki degerler birlestirilir). Kaydirici bu surede istenen degeri
   * gosterir; kuyruk bosalinca Rust'in otoriter degerine doner.
   */
  const setOutputVolume = useCallback(
    (volume: number) => {
      if (!apiRef.current) return;
      volumeQueue.current.latest = volume;
      setVolumeDraft(volume);
      setError(null);
      void drainVolume();
    },
    [drainVolume],
  );

  return {
    ready,
    pending,
    error,
    ...state,
    outputVolume: volumeDraft ?? state.outputVolume,
    setMicMuted,
    setOutputMuted,
    setOutputVolume,
  };
}
