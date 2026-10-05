import { useCallback, useEffect, useRef, useState } from 'react';

import { callHost, hasTauri } from './tauriHost.js';

/**
 * Cercevesiz/seffaf pencerenin Rust komutlari (pet penceresi + Dashboard).
 * Kullanilan sozlesme:
 *
 *  - `window_state()`        {pet, framed, interactive, autoHit, ...}
 *  - `window_toggle_frame()` cerceveyi ac/kapa; YENI `framed` degerini doner.
 *  - `window_start_drag()`   pencereyi surukle (fare basiliyken).
 *  - `window_quit()`         uygulamayi kapat.
 *  - `mission_open()`        Dashboard penceresini ac ya da one getir.
 *
 * (`window_set_hit_areas` ve `window_set_interactive` tiklama gecirgenligidir:
 * useHitAreas.ts.)
 *
 * Her komut icin TEK UCUS: ucta olan komuta ikinci tiklama eklenmez. Bekleyen
 * komutlar `pending`de, basarisizlar `error`da gorunur; hata metni sabit kisa
 * Turkce mesajdir, teknik ayrinti `callHost` tarafindan maskeli gunluge yazilir.
 */

type WindowCommand =
  'window_state' | 'window_toggle_frame' | 'window_start_drag' | 'mission_open' | 'window_quit';

/** `run` ile dogrudan tetiklenebilen komutlar (surukleme ve durum okuma kendi yolundan gider). */
type RunnableCommand = Extract<WindowCommand, 'mission_open' | 'window_quit'>;

const ERRORS: Record<WindowCommand, string> = {
  window_state: 'Pencere durumu okunamadı. Çerçeve düğmesiyle yeniden dene.',
  window_toggle_frame: 'Pencere çerçevesi değiştirilemedi. Yeniden dene.',
  window_start_drag: 'Pencere taşınamadı. Çerçeveli görünümü dene.',
  mission_open: 'Dashboard açılamadı. Yeniden dene.',
  window_quit: 'Smith kapatılamadı. Sistem tepsisinden yeniden dene.',
};

export function useWindowCommands(): {
  /** Pencere cerceveli mi: Rust'tan OKUNUR, tahmin edilmez. */
  framed: boolean;
  pending: ReadonlySet<string>;
  error: string | null;
  run: (command: RunnableCommand) => void;
  toggleFrame: () => void;
  startDragging: (event: React.PointerEvent<HTMLElement>) => void;
} {
  const [framed, setFramed] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<WindowCommand>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(new Set<WindowCommand>());
  const failures = useRef(new Map<WindowCommand, string>());
  /** Her mount yeni bir nesildir; eski nesil cevaplari atilir (StrictMode, yeniden mount). */
  const generation = useRef(0);
  /** Son cerceve istegi. Daha yeni istek varken donen eski cevap `framed`i ezmez. */
  const frameRequest = useRef(0);

  const publishPending = useCallback(() => setPending(new Set(busy.current)), []);

  const report = useCallback((command: WindowCommand, ok: boolean) => {
    if (ok) failures.current.delete(command);
    else failures.current.set(command, ERRORS[command]);
    setError([...failures.current.values()].at(-1) ?? null);
  }, []);

  // Cerceve durumunu Rust'tan OKU (tahmin etme): dugmenin etiketi buna bagli.
  useEffect(() => {
    if (!hasTauri()) return;
    const mount = ++generation.current;
    const requestAtStart = frameRequest.current;
    busy.current.add('window_state');
    publishPending();
    void callHost<{ framed: boolean }>('window_state').then((response) => {
      if (generation.current !== mount) return;
      // Bu arada kullanici cerceveyi degistirdiyse bu okuma eskidir.
      if (requestAtStart === frameRequest.current) {
        if (response.ok) setFramed(response.value.framed);
        report('window_state', response.ok);
      }
      busy.current.delete('window_state');
      publishPending();
    });
    const commands = busy.current;
    return () => {
      generation.current = mount + 1;
      commands.clear();
    };
  }, [publishPending, report]);

  const execute = useCallback(
    (command: WindowCommand) => {
      if (busy.current.has(command)) return;
      busy.current.add(command);
      publishPending();
      const mount = generation.current;
      const request =
        command === 'window_toggle_frame' ? ++frameRequest.current : frameRequest.current;
      void callHost<boolean>(command)
        .then((response) => {
          if (mount !== generation.current) return;
          if (
            command === 'window_toggle_frame' &&
            response.ok &&
            request === frameRequest.current
          ) {
            setFramed(response.value);
            // Taze cevap, onceki durum okuma hatasini gecersiz kilar.
            failures.current.delete('window_state');
          }
          report(command, response.ok);
        })
        .finally(() => {
          if (mount !== generation.current) return;
          busy.current.delete(command);
          publishPending();
        });
    },
    [publishPending, report],
  );

  const toggleFrame = useCallback(() => execute('window_toggle_frame'), [execute]);

  /**
   * Pet ve panodaki tutamak: fare basiliyken pencereyi surukler.
   * `data-tauri-drag-region` KULLANILMAZ: o oznitelik `core:window:allow-start-dragging`
   * izni ister (`core:default` icermez, sessizce calismazdi) ve Tauri'nin
   * yerlesik isleyicisi CIFT TIKLAMADA pencereyi maximize eder; seffaf bir
   * pet'in ekrani kaplamasi kabul edilemez. Yerine kendi komutumuz.
   */
  const startDragging = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // Yalniz birincil (sol) dugme; sag tik ya da ikincil isaretci surukleMEZ.
      if (event.button !== 0 || !event.isPrimary) return;
      // Metin secimi / odak calmasi surukleme sirasinda istenmez.
      event.preventDefault();
      execute('window_start_drag');
    },
    [execute],
  );

  return { framed, pending, error, run: execute, toggleFrame, startDragging };
}
