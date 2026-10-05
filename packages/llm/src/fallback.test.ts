import { describe, expect, it } from 'vitest';

import { extractStatus, isRetryableLlmError } from './fallback.js';
import { LlmError } from './types.js';

/** Saglayici hatalarinin gercek sekli: LlmError -> cause -> SDK hatasi. */
function wrapped(status: number): LlmError {
  const sdkError = Object.assign(new Error(`${status} status code`), { status });
  return new LlmError('OpenAI-uyumlu tool istegi basarisiz', 'openai-compat', { cause: sdkError });
}

describe('isRetryableLlmError', () => {
  it('kota/yuk/ag hatalari GECICI sayilir (yedege gec)', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableLlmError(wrapped(status)), `status ${status}`).toBe(true);
    }
  });

  it('istek/yetki hatalari KALICI sayilir (fail-loud, yedek arizayi maskelemesin)', () => {
    // 400: thought_signature bug'i tam olarak buydu — yedege dusulseydi
    // "Gemini calismiyor" diye yanlis teshise gomulurduk.
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableLlmError(wrapped(status)), `status ${status}`).toBe(false);
    }
  });

  it('ag hatasi kodlari (status yok) gecici sayilir', () => {
    const netError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(isRetryableLlmError(new LlmError('x', 'openai-compat', { cause: netError }))).toBe(true);
  });

  it('OpenAI SDK baglanti hatasi adiyla taninir', () => {
    const connError = Object.assign(new Error('Connection error'), {
      name: 'APIConnectionError',
    });
    expect(isRetryableLlmError(connError)).toBe(true);
  });

  it('bilinmeyen hata KALICI sayilir — sessizce yedege dusup bug gizlenmez', () => {
    expect(isRetryableLlmError(new Error('beklenmedik'))).toBe(false);
    expect(isRetryableLlmError(undefined)).toBe(false);
  });

  it('extractStatus cause zincirinden durumu cikarir', () => {
    expect(extractStatus(wrapped(429))).toBe(429);
    expect(extractStatus(new Error('yok'))).toBeUndefined();
  });
});
