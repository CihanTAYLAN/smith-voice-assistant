import { describe, expect, it, vi } from 'vitest';

import { fetchWsTicket, toHttpBase } from './ticket.js';

/** Kaynakta token gorunumlu literal birakmamak icin (pre-commit tarayicisi) kurulur. */
const TOKEN = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('toHttpBase', () => {
  it.each([
    ['ws://127.0.0.1:4100', 'http://127.0.0.1:4100'],
    ['wss://smith.example.com', 'https://smith.example.com'],
    ['ws://127.0.0.1:4100/', 'http://127.0.0.1:4100'],
    ['wss://smith.example.com/api/', 'https://smith.example.com/api'],
  ])('%s -> %s', (wsUrl, expected) => {
    expect(toHttpBase(wsUrl)).toBe(expected);
  });

  it.each(['http://127.0.0.1:4100', 'ftp://x', 'degil-bir-url'])(
    '%s ws/wss olmadigi icin reddedilir',
    (wsUrl) => {
      expect(() => toHttpBase(wsUrl)).toThrow(/ws:\/\/ veya wss:\/\//);
    },
  );
});

describe('fetchWsTicket', () => {
  it('bileti Authorization basligiyla ister; token URL e girmez', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(201, { ticket: 'bilet-degeri', expiresInMs: 60_000 })),
    );

    const ticket = await fetchWsTicket({ wsUrl: 'ws://127.0.0.1:4100', token: TOKEN, fetchImpl });

    expect(ticket).toBe('bilet-degeri');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    // Tam esitlik: token (ya da baska bir sorgu parametresi) URL e giremez.
    expect(url).toBe('http://127.0.0.1:4100/v1/ws/ticket');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('401 yanitinda sunucu mesajini ve durumu bildirir, token i sizdirmaz', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(401, { error: 'Kimlik doğrulanamadı.' })),
    );

    const failure = await fetchWsTicket({
      wsUrl: 'ws://127.0.0.1:4100',
      token: TOKEN,
      fetchImpl,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('401');
    expect((failure as Error).message).toContain('Kimlik doğrulanamadı.');
    expect((failure as Error).message).not.toContain(TOKEN);
  });

  it('429 yanitinda bekleme suresini soyler', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse(429, { error: 'Cok fazla bilet istegi.' }, { 'retry-after': '12' }),
      ),
    );

    const failure = await fetchWsTicket({
      wsUrl: 'ws://127.0.0.1:4100',
      token: TOKEN,
      fetchImpl,
    }).catch((error: unknown) => error);

    expect((failure as Error).message).toContain('429');
    expect((failure as Error).message).toContain('12 sn');
  });

  it('govdesi JSON olmayan hata yanitinda da anlasilir mesaj verir', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 })),
    );

    const failure = await fetchWsTicket({
      wsUrl: 'ws://127.0.0.1:4100',
      token: TOKEN,
      fetchImpl,
    }).catch((error: unknown) => error);

    expect((failure as Error).message).toContain('502');
    expect((failure as Error).message).not.toContain('<html>');
  });

  it('ag hatasinda hedefi soyler ama token i ve ayrintiyi sizdirmaz', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));

    const failure = await fetchWsTicket({
      wsUrl: 'ws://127.0.0.1:4100',
      token: TOKEN,
      fetchImpl,
    }).catch((error: unknown) => error);

    expect((failure as Error).message).toContain('http://127.0.0.1:4100');
    expect((failure as Error).message).not.toContain(TOKEN);
  });

  it('beklenmeyen basarili govdede (bilet yok) hata verir', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(201, { x: 1 })));

    await expect(
      fetchWsTicket({ wsUrl: 'ws://127.0.0.1:4100', token: TOKEN, fetchImpl }),
    ).rejects.toThrow(/bilet/);
  });

  it('istegi zaman asimiyla sinirlar', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(201, { ticket: 't' })),
    );

    await fetchWsTicket({ wsUrl: 'ws://127.0.0.1:4100', token: TOKEN, fetchImpl });

    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
