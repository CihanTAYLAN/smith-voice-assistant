import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeError, logFailure, maskSecrets } from './logFailure.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maskSecrets', () => {
  it('anahtar=deger sirlarini ve bearer kimlik bilgilerini maskeler', () => {
    expect(maskSecrets('token=abc123 password: hunter2')).toBe('token=*** password=***');
    expect(maskSecrets('Authorization: Bearer abc.def')).toBe('Authorization=***');
    expect(maskSecrets('sent bearer qwerty')).toBe('sent bearer ***');
  });

  it('API anahtari gibi uzun opak dizileri maskeler', () => {
    const key = `AIza${'x'.repeat(35)}`;
    expect(maskSecrets(`istek basarisiz ${key}`)).toBe('istek basarisiz ***');
  });

  it('yol bicimini korur, kullanici adini atar', () => {
    expect(maskSecrets('C:\\Users\\alice\\AppData\\x.log')).toBe('C:\\Users\\***\\AppData\\x.log');
    expect(maskSecrets('/home/cihan/.config/a and /Users/cihan/b')).toBe(
      '/home/***/.config/a and /Users/***/b',
    );
  });

  it('siradan tanilari okunur birakir', () => {
    expect(maskSecrets("komut bulunamadi: 'audio_start'")).toBe("komut bulunamadi: 'audio_start'");
  });
});

describe('describeError', () => {
  it('hatalari, metinleri ve bilinmeyen degerleri tek maskeli satirda tanimlar', () => {
    expect(describeError(new TypeError('token=abc\nnext line'))).toBe(
      'TypeError: token=*** next line',
    );
    expect(describeError('Rust: dosya yok')).toBe('Rust: dosya yok');
    expect(describeError({ secret: 'x' })).toBe('bilinmeyen hata');
  });

  it('uzun ayrintilari kisaltir', () => {
    expect(describeError('a '.repeat(400)).length).toBe(300);
  });
});

describe('logFailure', () => {
  it('kapsami ve maskeli ayrintiyi console a yazar, ham hata nesnesini asla', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logFailure('mic', new Error('password=hunter2'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('[mic] Error: password=***');
  });
});
