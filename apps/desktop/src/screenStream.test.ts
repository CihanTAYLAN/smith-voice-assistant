/**
 * Surekli ekran akisi dugmesinin saf mantigi. `invoke` sahte: dugme gercekten
 * dogru Tauri komutunu dogru argumanla cagiriyor mu, hata yutuluyor mu.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  SCREEN_STREAM_EVENT,
  SCREEN_STREAM_GET,
  SCREEN_STREAM_SET,
  parseScreenStreamEvent,
  parseScreenToolEvent,
  readScreenStream,
  toggleScreenStream,
  writeScreenStream,
  type ScreenStreamApi,
} from './screenStream.js';

function fakeApi(result: unknown): {
  api: ScreenStreamApi;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  return { api: { invoke } as unknown as ScreenStreamApi, invoke };
}

describe('komut adlari (Rust sozlesmesi)', () => {
  it('lib.rs invoke_handler ile ayni', () => {
    expect(SCREEN_STREAM_GET).toBe('screen_stream_get');
    expect(SCREEN_STREAM_SET).toBe('screen_stream_set');
    expect(SCREEN_STREAM_EVENT).toBe('audio://screen-stream');
  });
});

describe('readScreenStream', () => {
  it('screen_stream_get cagirir ve boolean dondurur', async () => {
    const { api, invoke } = fakeApi(true);
    await expect(readScreenStream(api)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('screen_stream_get');
  });

  it('komut yoksa hata bildirilir: durum uydurulmaz', async () => {
    const { api } = fakeApi(new Error('command screen_stream_get not found'));
    await expect(readScreenStream(api)).rejects.toThrow();
  });
});

describe('writeScreenStream', () => {
  it('screen_stream_set {acik} cagirir, Rust yanitini (otoriter) dondurur', async () => {
    const { api, invoke } = fakeApi(true);
    await expect(writeScreenStream(api, true)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('screen_stream_set', { acik: true });
  });

  it('Rust farkli deger dondururse onu kullanir (iyimser guncelleme yok)', async () => {
    const { api } = fakeApi(false);
    await expect(writeScreenStream(api, true)).resolves.toBe(false);
  });

  it('komut hatasi gorunur kilinmak uzere aktarilir', async () => {
    const { api } = fakeApi(new Error('boom'));
    await expect(writeScreenStream(api, true)).rejects.toThrow();
  });

  it('boolean olmayan yanit hata sayilir', async () => {
    const { api } = fakeApi({ acik: true });
    await expect(writeScreenStream(api, true)).rejects.toThrow();
  });
});

describe('toggleScreenStream (HUD dugmesi)', () => {
  it('aciksa kapatma, kapaliysa acma komutunu gonderir', async () => {
    const a = fakeApi(false);
    await toggleScreenStream(a.api, true);
    expect(a.invoke).toHaveBeenCalledWith('screen_stream_set', { acik: false });

    const b = fakeApi(true);
    await toggleScreenStream(b.api, false);
    expect(b.invoke).toHaveBeenCalledWith('screen_stream_set', { acik: true });
  });
});

describe('parseScreenStreamEvent', () => {
  it('Rust yukunden acik alanini okur', () => {
    expect(parseScreenStreamEvent({ acik: true })).toBe(true);
    expect(parseScreenStreamEvent({ acik: false })).toBe(false);
  });
  it('bozuk yuk null', () => {
    expect(parseScreenStreamEvent(null)).toBeNull();
    expect(parseScreenStreamEvent({})).toBeNull();
    expect(parseScreenStreamEvent({ acik: 'evet' })).toBeNull();
  });
});

describe('parseScreenToolEvent (audio://tool sozde-arac)', () => {
  it('ekran_akisi_durumu + akis_acik/akis_kapali', () => {
    expect(parseScreenToolEvent({ ad: 'ekran_akisi_durumu', durum: 'akis_acik' })).toBe(true);
    expect(parseScreenToolEvent({ ad: 'ekran_akisi_durumu', durum: 'akis_kapali' })).toBe(false);
  });
  it('baska arac ya da bilinmeyen durum null', () => {
    expect(parseScreenToolEvent({ ad: 'hafizada_ara', durum: 'akis_acik' })).toBeNull();
    expect(parseScreenToolEvent({ ad: 'ekran_akisi_durumu', durum: 'baska' })).toBeNull();
  });
});
