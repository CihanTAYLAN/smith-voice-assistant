import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { useModalDialog } from '../useModalDialog.js';
import { hasTauri, reportDashboardError, windowCmd } from './api.js';
import { createLeaveGuard, type LeaveGuardSnapshot } from './leaveGuard.js';

export interface LeaveGuard extends LeaveGuardSnapshot {
  setDirty: (dirty: boolean) => void;
  confirmDiscard: () => Promise<boolean>;
  requestClose: () => Promise<void>;
  /** Onay kutusu; Dashboard kabugu bir kez yerlestirir. */
  dialog: React.JSX.Element;
}

/** Kirli icerik sahibinin (Dosyalar) kabuktan ihtiyac duydugu dar yuzey. */
export type DiscardGuard = Pick<LeaveGuard, 'dirty' | 'guarded' | 'setDirty' | 'confirmDiscard'>;

/**
 * Terk korumasinin React baglantisi. Karar mantigi `leaveGuard.ts`dedir; burada
 * yalniz uc sey baglanir: yerel `<dialog>` onay kutusu (`useModalDialog`: odak
 * tuzagi, Escape, inert arka plan ve odagi geri verme hazir gelir), Tauri pencere
 * API'si ve tarayici `beforeunload` (yeniden yukleme). Pencere kapatma terk
 * degildir: Rust pencereyi gizler, onay yalniz gercek veri kaybi yolunda acilir.
 */
export function useLeaveGuard(): LeaveGuard {
  const [asking, setAsking] = useState(false);
  const answer = useRef<((discard: boolean) => void) | null>(null);
  const titleId = useId();
  const bodyId = useId();

  const [guard] = useState(() =>
    createLeaveGuard({
      askDiscard: () =>
        new Promise<boolean>((resolve) => {
          answer.current = resolve;
          setAsking(true);
        }),
      hideWindow: async () => {
        const result = await windowCmd('mission_close');
        if (!result.ok) throw new Error(result.error);
      },
      watchNativeClose: (onRequest) =>
        getCurrentWindow().onCloseRequested((event) => {
          event.preventDefault();
          onRequest();
        }),
      report: reportDashboardError,
    }),
  );
  const snapshot = useSyncExternalStore(guard.subscribe, guard.getSnapshot, guard.getSnapshot);

  // Soruyu kapatan her yol (dugme, Escape, yerel kapanis) buradan gecer.
  const settle = useCallback((discard: boolean): void => {
    setAsking(false);
    const resolve = answer.current;
    answer.current = null;
    resolve?.(discard);
  }, []);
  const dialogRef = useModalDialog(asking, () => settle(false));

  useEffect(() => (hasTauri() ? guard.start() : undefined), [guard]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (guard.getSnapshot().dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [guard]);

  // Pano kapanirken acik soru "kal" sayilir; hicbir cagiran asili kalmaz.
  useEffect(
    () => () => {
      answer.current?.(false);
      answer.current = null;
    },
    [],
  );

  const dialog = (
    <dialog
      ref={dialogRef}
      className="db-dialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
    >
      <h2 id={titleId}>Kaydedilmemiş değişiklikler var</h2>
      <p id={bodyId}>Devam edersen bu dosyadaki değişiklikler kaybolur.</p>
      <div className="db-dialog-actions">
        <button
          type="button"
          className="db-btn db-btn-primary"
          autoFocus
          onClick={() => settle(false)}
        >
          Düzenlemeye dön
        </button>
        <button type="button" className="db-btn" onClick={() => settle(true)}>
          Kaydetmeden devam et
        </button>
      </div>
    </dialog>
  );

  return {
    ...snapshot,
    setDirty: guard.setDirty,
    confirmDiscard: guard.confirmDiscard,
    requestClose: guard.requestClose,
    dialog,
  };
}
