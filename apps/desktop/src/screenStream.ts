/**
 * Surekli ekran akisi (Smith ekraninin periyodik karelerini buluta gonderme)
 * kontrolunun SAF mantigi. React yok: Tauri `invoke` disaridan verilir, boylece
 * dugmenin dogru komutu cagirdigi vitest'te (DOM'suz) sinanir.
 *
 * KAYNAK GERCEGI Rust'ta (`audio/screen.rs` akis_acik/akis_ayarla). UI iyimser
 * guncelleme YAPMAZ: yazma komutunun yaniti otoriterdir, hata olursa durum
 * degismemis sayilir. Ekran icerigi buluta gittigi icin acik durumun HUD'da
 * her an gorunur olmasi bir gizlilik gerekliligidir (bkz. Hud ekran satiri).
 *
 * Degisim kanallari:
 *  - `audio://screen-stream` {acik}: lib.rs, HUD/tepsi komutunda yayar; HUD ve tepsi buradan esitlenir.
 *  - `audio://tool` ad='ekran_akisi_durumu' sozde-araci: Live oturumunun ekran
 *    dongusu degisimi gorunce yayar (`audio/live.rs` EKRAN_AKISI_DURUMU).
 */

export const SCREEN_STREAM_GET = 'screen_stream_get';
export const SCREEN_STREAM_SET = 'screen_stream_set';
export const SCREEN_STREAM_EVENT = 'audio://screen-stream';

/** `audio/live.rs` EKRAN_AKISI_DURUMU / _ACIK / _KAPALI. */
export const SCREEN_TOOL_NAME = 'ekran_akisi_durumu';
const SCREEN_TOOL_ON = 'akis_acik';
const SCREEN_TOOL_OFF = 'akis_kapali';

/** `TauriApi`nin bu modulun kullandigi dilimi (test icin sahte verilebilir). */
export interface ScreenStreamApi {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

/** Komut hatasi veya bozuk yanit HUD'da gorunur; basari uydurulmaz. */
export async function readScreenStream(api: ScreenStreamApi): Promise<boolean> {
  return screenBoolean(await api.invoke<unknown>(SCREEN_STREAM_GET));
}

export async function writeScreenStream(api: ScreenStreamApi, acik: boolean): Promise<boolean> {
  return screenBoolean(await api.invoke<unknown>(SCREEN_STREAM_SET, { acik }));
}

function screenBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Gecersiz ekran akisi yaniti');
  return value;
}

/** HUD dugmesi: mevcut duruma gore tersini ister. */
export function toggleScreenStream(api: ScreenStreamApi, current: boolean): Promise<boolean> {
  return writeScreenStream(api, !current);
}

/** `audio://screen-stream` yukunden `acik`; bozuksa null. */
export function parseScreenStreamEvent(payload: unknown): boolean | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const acik = (payload as { acik?: unknown }).acik;
  return typeof acik === 'boolean' ? acik : null;
}

/** `audio://tool` yukunden ekran akisi degisimi; baska olay/durum icin null. */
export function parseScreenToolEvent(ev: { ad: string; durum: string }): boolean | null {
  if (ev.ad !== SCREEN_TOOL_NAME) return null;
  if (ev.durum === SCREEN_TOOL_ON) return true;
  if (ev.durum === SCREEN_TOOL_OFF) return false;
  return null;
}
