import { logFailure } from './logFailure.js';

/**
 * Tauri host siniri: bu penceredeki TEK `invoke`/`listen` kapisi.
 *
 * Tarayicida (Vite onizleme) `__TAURI_INTERNALS__` yoktur: ses ve pencere
 * komutlari yalniz masaustu uygulamasinda calisir, tarayicida hicbir sey
 * cagirilmaz ve arayuz cokmez.
 */

export interface TauriApi {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void>;
}

export function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

let apiLoad: Promise<TauriApi> | null = null;

/**
 * Tauri 2 runtime feature-detect. Yoksa null: tarayici modu. Acilista birden
 * cok kanca ayni anda ister: modul yukleme TEK ucusta paylasilir; basarisiz
 * yukleme onbellekte KALMAZ, sonraki cagri yeniden dener.
 */
export async function loadTauri(): Promise<TauriApi | null> {
  if (!hasTauri()) return null;
  apiLoad ??= Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]).then(
    ([core, event]) => ({ invoke: core.invoke, listen: event.listen }),
    (error: unknown) => {
      apiLoad = null;
      throw error;
    },
  );
  return apiLoad;
}

export type HostResult<T> = { ok: true; value: T } | { ok: false };

/**
 * Tek komut cagrisi. Hata YUTULMAZ: cagirana `{ ok: false }` doner (kullaniciya
 * kisa mesaj orada uretilir) ve teknik ayrinti maskelenerek gunluge yazilir.
 */
export async function callHost<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<HostResult<T>> {
  if (!hasTauri()) return { ok: false };
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return { ok: true, value: await invoke<T>(cmd, args ?? {}) };
  } catch (error) {
    logFailure(`host ${cmd}`, error);
    return { ok: false };
  }
}
