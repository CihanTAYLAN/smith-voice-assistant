/**
 * KAYDEDILMEMIS ICERIK ICIN TEK KARAR NOKTASI (Dashboard, P0 veri kaybi).
 *
 * Dosya degistirme ve gercek sayfa terkinde `confirmDiscard` veri kaybini
 * engeller. Pano kapatma ise artik terk DEGILDIR: Rust webview'i yok etmek
 * yerine gizler, bu nedenle X / Alt+F4 / "Paneli kapat" onay sormaz ve editor
 * durumu aynen korunur.
 *
 * YEREL KAPATMA: Tauri 2'de pencerede JS `close-requested` dinleyicisi varsa
 * Rust kapatmayi engeller ve pencereyi gizler. JS dinleyicisi de ayni gizleme
 * komutunu cagirir; capability eksik olsa bile Rust katmani durumu korur.
 */

export const CLOSE_FAILED = 'Panel gizlenemedi. Değişikliklerin korunuyor.';

export interface LeaveGuardPorts {
  /** Onay kutusunu gosterir; true = degisiklikleri at ve devam et. */
  askDiscard: () => Promise<boolean>;
  /** Rust komutu pencereyi yok etmeden gizler. */
  hideWindow: () => Promise<void>;
  /** Yerel kapatma istegini yakalar; dinleyiciyi birakan fonksiyonu doner. */
  watchNativeClose: (onRequest: () => void) => Promise<() => void>;
  report: (operation: string, error: unknown) => void;
}

export interface LeaveGuardSnapshot {
  dirty: boolean;
  /** Yerel kapatma dinleyicisi kurulu. */
  guarded: boolean;
  closeError: string | null;
}

export interface LeaveGuardController {
  getSnapshot: () => LeaveGuardSnapshot;
  subscribe: (listener: () => void) => () => void;
  setDirty: (dirty: boolean) => void;
  /** Kirliyse sorar; devam edilebilirse true. Ayni anda tek soru sorulur. */
  confirmDiscard: () => Promise<boolean>;
  requestClose: () => Promise<void>;
  /** Yerel kapatma dinleyicisini kurar; birakan fonksiyonu doner. */
  start: () => () => void;
}

export function createLeaveGuard(ports: LeaveGuardPorts): LeaveGuardController {
  let snapshot: LeaveGuardSnapshot = { dirty: false, guarded: false, closeError: null };
  let asking = false;
  let closing = false;
  let watchTicket = 0;
  let unwatch: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const publish = (patch: Partial<LeaveGuardSnapshot>): void => {
    const next = { ...snapshot, ...patch };
    const same =
      next.dirty === snapshot.dirty &&
      next.guarded === snapshot.guarded &&
      next.closeError === snapshot.closeError;
    if (same) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const stop = (): void => {
    watchTicket++;
    unwatch?.();
    unwatch = null;
    publish({ guarded: false });
  };

  const confirmDiscard = async (): Promise<boolean> => {
    if (!snapshot.dirty) return true;
    if (asking) return false;
    asking = true;
    try {
      return await ports.askDiscard();
    } finally {
      asking = false;
    }
  };

  const install = async (ticket: number): Promise<void> => {
    try {
      const release = await ports.watchNativeClose(() => {
        void requestClose();
      });
      if (ticket !== watchTicket) release();
      else {
        unwatch = release;
        publish({ guarded: true });
      }
    } catch (error) {
      if (ticket === watchTicket) ports.report('close-guard', error);
    }
  };

  const start = (): (() => void) => {
    void install(++watchTicket);
    return stop;
  };

  const requestClose = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    publish({ closeError: null });
    try {
      await ports.hideWindow();
    } catch (error) {
      ports.report('close', error);
      publish({ closeError: CLOSE_FAILED });
    } finally {
      closing = false;
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDirty: (dirty) => publish({ dirty }),
    confirmDiscard,
    requestClose,
    start,
  };
}
