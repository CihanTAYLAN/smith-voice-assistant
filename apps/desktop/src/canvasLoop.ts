/**
 * Canvas cizim dongusu (Face ve Visualizer ortak): React render'indan bagimsiz,
 * pil dostu.
 *
 * ESKI HAL: iki canvas gorunurken surekli `requestAnimationFrame` (60 kare/sn)
 * calisiyordu; hareket azaltma tercihi gercek cizim maliyetini durdurmuyordu ve
 * DPR 2'ye sabitlenmisti. Her zaman ustte duran bir pencerede bu, bosa pil
 * tuketimi ve yuksek DPI'da bulanik cizim demekti.
 *
 * SIMDI: etkinken 30, bostayken 12 kare/sn; gizli pencerede hic; hareket azaltma
 * tercihinde surekli zamanlayici YOK, canvas yalniz girdi degisince (durum,
 * seviye, boyut) bir kez cizilir.
 */

const ACTIVE_FPS = 30;
const IDLE_FPS = 12;

/** Arka plan tamponunun piksel butcesi: yuksek DPI keskin kalsin ama bellek sismesin. */
const PIXEL_BUDGET = 1_000_000;

/** Yerel DPR'yi korur, tamponu `PIXEL_BUDGET` ile sinirlar; asla 1'in altina inmez. */
export function canvasScale(width: number, height: number, native: number): number {
  const budgetScale = Math.sqrt(PIXEL_BUDGET / Math.max(1, width * height));
  return Math.max(1, Math.min(native || 1, budgetScale));
}

/**
 * `draw(now, reduced)` her karede cagrilir. `active()` o anki kare hizini secer.
 * `invalidate()` bekleyen bir cizim yoksa bir tane ister (girdi degistiginde).
 */
export function createCanvasLoop(
  draw: (now: number, reduced: boolean) => void,
  active: () => boolean,
): { invalidate: () => void; stop: () => void } {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false;
  let frame = 0;
  let timer = 0;

  const cancel = (): void => {
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    frame = 0;
    timer = 0;
  };

  const tick = (now: number): void => {
    frame = 0;
    if (disposed || document.hidden) return;
    draw(now, reducedMotion.matches);
    if (reducedMotion.matches) return;
    timer = window.setTimeout(
      () => {
        timer = 0;
        invalidate();
      },
      1000 / (active() ? ACTIVE_FPS : IDLE_FPS),
    );
  };

  const invalidate = (): void => {
    if (disposed || document.hidden || frame || timer) return;
    frame = requestAnimationFrame(tick);
  };

  /** Gorunurluk ya da hareket tercihi degisti: bekleyen her sey iptal, yeniden basla. */
  const restart = (): void => {
    cancel();
    invalidate();
  };

  document.addEventListener('visibilitychange', restart);
  reducedMotion.addEventListener('change', restart);
  invalidate();

  return {
    invalidate,
    stop() {
      disposed = true;
      cancel();
      document.removeEventListener('visibilitychange', restart);
      reducedMotion.removeEventListener('change', restart);
    },
  };
}
