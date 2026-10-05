import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assignTask,
  createAgent,
  deleteAgent,
  fetchBoard,
  toMissionError,
  type MissionErrorCode,
  type MissionHostError,
} from './api.js';

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => core);

/** Rust'in `mission_call` hatasi (src-tauri/src/mission.rs `MissionHatasi`) birebir. */
const hostError = (
  code: MissionErrorCode,
  status: number | null,
  message = 'gateway sebebi',
): MissionHostError => ({ code, status, message });

describe('Mission hata katalogu', () => {
  it('404 gorev hatasini guvenli ve yapisal olarak siniflandirir', () => {
    const error = toMissionError(hostError('not-found', 404, 'gorev bulunamadi'));
    expect(error).toEqual({
      code: 'not-found',
      error: 'İstenen kayıt artık bulunamıyor.',
    });
  });

  it('ham gateway ayrintisini kullanici mesajina sizdirmaz', () => {
    const error = toMissionError(
      hostError('unavailable', null, 'token=super-secret ECONNREFUSED 127.0.0.1'),
    );
    expect(error.code).toBe('unavailable');
    expect(error.error).toBe('Mission Control bağlantısı kurulamadı. Lütfen yeniden dene.');
    expect(error.error).not.toContain('super-secret');
    expect(error.error).not.toContain('127.0.0.1');
  });

  it.each<[MissionErrorCode, number | null, string]>([
    ['not-found', 404, 'İstenen kayıt artık bulunamıyor.'],
    ['conflict', 409, 'Bu işlem mevcut görev veya ajan durumu nedeniyle tamamlanamadı.'],
    ['validation', 400, 'Girilen bilgiler geçerli değil. Alanları kontrol et.'],
    ['validation', 422, 'Girilen bilgiler geçerli değil. Alanları kontrol et.'],
    ['unauthorized', 401, 'Mission Control oturumu doğrulanamadı.'],
    ['unauthorized', 403, 'Mission Control oturumu doğrulanamadı.'],
    ['unavailable', null, 'Mission Control bağlantısı kurulamadı. Lütfen yeniden dene.'],
    ['unknown', 500, 'İşlem tamamlanamadı. Lütfen yeniden dene.'],
  ])('sinif %s (HTTP %s) sabit cumleye iner', (code, status, message) => {
    expect(toMissionError(hostError(code, status))).toEqual({ code, error: message });
  });

  it('sinifi metinden degil code alanindan okur: metin ve durum sinifi degistirmez', () => {
    // Eskiden "404/409/gateway" alt dizgisi siniflandirirdi; simdi yalniz `code` belirler.
    const yanilticiMetin = 'http status: 404 gateway login timeout 409 yetkisiz';
    expect(toMissionError(hostError('unknown', 500, yanilticiMetin)).code).toBe('unknown');
    expect(toMissionError(hostError('conflict', 404, 'bulunamadi')).code).toBe('conflict');
  });

  it('yapisal olmayan ve taninmayan her sey unknown olur (ham metin ayristirilmaz)', () => {
    const girdiler: [string, unknown][] = [
      ['gateway metni', '/v1/mission/tasks/t1 cagrisi basarisiz: http status: 404'],
      ['login metni', 'gateway login hatasi: token=super-secret ECONNREFUSED'],
      ['Error', new Error('http status: 409')],
      ['null', null],
      ['undefined', undefined],
      ['sayi', 42],
      ['bos nesne', {}],
      ['code yok', { status: 404, message: 'x' }],
      ['code sayi', { code: 404 }],
      ['prototip anahtari', { code: 'toString', status: 500, message: 'x' }],
      ['taninmayan sinif', { code: 'taninmayan-sinif', status: 409, message: 'x' }],
    ];
    for (const [ad, raw] of girdiler) {
      expect(toMissionError(raw), ad).toEqual({
        code: 'unknown',
        error: 'İşlem tamamlanamadı. Lütfen yeniden dene.',
      });
    }
  });

  it('mesajlar dogru Turkce yazilir ve hicbir sinifta ham metin tasimaz', () => {
    const kodlar: MissionErrorCode[] = [
      'not-found',
      'conflict',
      'validation',
      'unauthorized',
      'unavailable',
      'unknown',
    ];
    for (const code of kodlar) {
      const { error } = toMissionError(hostError(code, 400, 'sir=abc123 ECONNREFUSED /v1/mission'));
      expect(error).not.toMatch(/abc123|ECONN|gateway|\/v1\/|\d{3}/);
      expect(error).not.toMatch(/\bartik\b|\bgecerli\b|\bbaglanti\b|\bbasarisiz\b/);
      // Hitap birligi: Smith kullaniciya "sen" der, "siz" formu yok.
      expect(error).not.toMatch(/(?:edin|deneyin|seçin|bırakabilirsiniz|kaydedin)\b/);
    }
  });
});

describe('Mission cagri katmani', () => {
  beforeEach(() => {
    core.invoke.mockReset();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Tauri koprusu yoksa istek atmadan acik bir mesajla basarisiz olur', async () => {
    vi.stubGlobal('window', {});
    const result = await fetchBoard();
    expect(result).toEqual({
      ok: false,
      code: 'unavailable',
      error: 'Mission Control bağlantısı yalnızca Smith masaüstü uygulamasında kullanılabilir.',
    });
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it('mission_call komutuna yol ve govdeyle gider', async () => {
    core.invoke.mockResolvedValue({ agents: [], tasks: [], events: [], transitions: {} });
    const result = await fetchBoard();
    expect(result.ok).toBe(true);
    expect(core.invoke).toHaveBeenCalledWith('mission_call', {
      method: 'GET',
      path: '/v1/mission/board',
      body: null,
    });
  });

  it('atamada motor yalniz verildiyse govdeye girer', async () => {
    core.invoke.mockResolvedValue({});
    await assignTask('t1', 'nova');
    await assignTask('t1', 'nova', 'codex');
    expect(core.invoke.mock.calls.map(([, args]) => (args as { body: unknown }).body)).toEqual([
      { assignee: 'nova' },
      { assignee: 'nova', engine: 'codex' },
    ]);
  });

  it('hata halinde konsola yalniz kod ve durum yazar, ham metni degil', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.invoke.mockRejectedValue(
      hostError('unavailable', null, 'token=super-secret ECONNREFUSED 127.0.0.1'),
    );
    const result = await fetchBoard();
    expect(result.ok).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('unavailable');
    expect(String(log.mock.calls[0]?.[0])).not.toContain('super-secret');
    expect(String(log.mock.calls[0]?.[0])).not.toContain('127.0.0.1');
  });

  it('gateway durumu varsa konsol satirina HTTP durumu eklenir', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.invoke.mockRejectedValue(hostError('conflict', 409, 'Gecersiz gorev gecisi'));
    await fetchBoard();
    expect(String(log.mock.calls[0]?.[0])).toBe(
      '[MissionControl] mission_call başarısız (conflict, HTTP 409)',
    );
    expect(String(log.mock.calls[0]?.[0])).not.toContain('Gecersiz');
  });

  it('yapisal olmayan reddetme unknown olur, ham metin siniflandirmaya girmez', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.invoke.mockRejectedValue('gateway token=super-secret ECONNREFUSED http status: 404');
    const result = await fetchBoard();
    expect(result).toEqual({
      ok: false,
      code: 'unknown',
      error: 'İşlem tamamlanamadı. Lütfen yeniden dene.',
    });
  });

  it('ayni kimlikle ajan olusturmada eyleme donuk 409 mesaji verir', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.invoke.mockRejectedValue(hostError('conflict', 409, 'Bu slug zaten kullanimda: nova'));
    const result = await createAgent({
      slug: 'nova',
      displayName: 'Nova',
      role: 'x',
      soul: 'yeterince uzun metin',
    });
    expect(result).toEqual({
      ok: false,
      code: 'conflict',
      error: 'Bu ajan kimliği zaten kullanımda. Başka bir kimlik seç.',
    });
  });

  it('kosu gecmisi olan ajan silinemez mesaji devre disi birakmayi onerir', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.invoke.mockRejectedValue(hostError('conflict', 409));
    const result = await deleteAgent('a1');
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    expect(!result.ok && result.error).toBe(
      'Koşu geçmişi olan ajan silinemez. Bunun yerine devre dışı bırakabilirsin.',
    );
  });

  it('ozel 409 mesaji baska hata siniflarini degistirmez', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.invoke.mockRejectedValue(hostError('not-found', 404));
    const result = await deleteAgent('a1');
    expect(!result.ok && result.code).toBe('not-found');
    expect(!result.ok && result.error).toBe('İstenen kayıt artık bulunamıyor.');
  });
});
