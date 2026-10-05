/**
 * Zamana-uyarlanan aksan temasi — saf saat -> tema esleyicisi
 * (UI_IMPLEMENTATION_PLAN.md §7.1). CSS tarafi `styles.css`teki
 * `:root[data-time-theme]` bloklaridir; bu dosya yalniz HANGI temanin aktif
 * olmasi gerektigine karar verir, DOM'a dokunmaz (useHudEnvironment.ts `useTimeTheme`).
 *
 * Yalniz CIHAZ SAATI kullanilir (plan §7.1: "local device time"); sunucu
 * saati ya da konum bazli gun-dogumu YOK — bu bir sonraki, kanitlanmamis
 * bir varsayim olurdu.
 */

export type TimeTheme = 'morning' | 'day' | 'sunset' | 'night';

/** Saat (0-23) -> tema. Sinirlar plan §7.1 ile birebir: 06/11/17/21. */
export function resolveTimeTheme(hour: number): TimeTheme {
  if (hour >= 6 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'day';
  if (hour >= 17 && hour < 21) return 'sunset';
  return 'night';
}

/** `now` disaridan verilebilir (test edilebilirlik); varsayilan gercek saat. */
export function currentTimeTheme(now: Date = new Date()): TimeTheme {
  return resolveTimeTheme(now.getHours());
}
