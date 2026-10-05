import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { formatListenUrl, isLoopbackAddress, resolveRemoteAddress } from './network.js';

describe('isLoopbackAddress', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.2',
    '127.255.255.254',
    '::1',
    '::ffff:127.0.0.1',
    '::FFFF:127.0.0.1',
  ])('%s loopback sayilir', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each([
    '192.168.1.20',
    '10.0.0.5',
    '172.17.0.1',
    '0.0.0.0',
    '128.0.0.1',
    '::ffff:192.168.1.20',
    '2001:db8::1',
    'fe80::1',
    '127.0.0.1.evil.example',
    '127.0.0.256',
    'localhost',
    '',
  ])('%s loopback SAYILMAZ', (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });

  it('tanimsiz adres loopback sayilmaz (guvenli taraf)', () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('resolveRemoteAddress', () => {
  function soketli(remoteAddress: string) {
    return { incoming: { socket: { remoteAddress, remotePort: 51234, remoteFamily: 'IPv4' } } };
  }

  async function adresOku(env: unknown): Promise<string | undefined> {
    let okunan: string | undefined;
    const app = new Hono();
    app.get('/', (c) => {
      okunan = resolveRemoteAddress(c);
      return c.text('ok');
    });
    await app.request('/', undefined, env);
    return okunan;
  }

  it('Node soketinin uzak adresini okur', async () => {
    expect(await adresOku(soketli('192.168.1.20'))).toBe('192.168.1.20');
  });

  it('X-Forwarded-For gibi uydurulabilir basliklara BAKMAZ', async () => {
    let okunan: string | undefined;
    const app = new Hono();
    app.get('/', (c) => {
      okunan = resolveRemoteAddress(c);
      return c.text('ok');
    });
    await app.request(
      '/',
      { headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' } },
      soketli('203.0.113.7'),
    );
    expect(okunan).toBe('203.0.113.7');
  });

  it('soket yoksa (Node sunucusu disi) adres bilinmez', async () => {
    expect(await adresOku(undefined)).toBeUndefined();
  });
});

describe('formatListenUrl', () => {
  it('gercek baglanan IPv4 adresini yazar', () => {
    expect(formatListenUrl({ address: '127.0.0.1', family: 'IPv4', port: 4100 })).toBe(
      'http://127.0.0.1:4100',
    );
    expect(formatListenUrl({ address: '0.0.0.0', family: 'IPv4', port: 4100 })).toBe(
      'http://0.0.0.0:4100',
    );
  });

  it('IPv6 adresini koseli parantezle yazar', () => {
    expect(formatListenUrl({ address: '::1', family: 'IPv6', port: 4100 })).toBe(
      'http://[::1]:4100',
    );
  });
});
