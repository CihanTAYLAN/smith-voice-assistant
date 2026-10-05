import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  guardUpgradeTarget,
  installUnhandledRejectionLogger,
  isParseableUpgradeTarget,
} from './process-guards.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isParseableUpgradeTarget', () => {
  it.each(['/', '/v1/ws', '/v1/ws?ticket=abc', '/v1/ws?token=a.b.c', undefined])(
    '%s cozumlenebilir',
    (target) => {
      expect(isParseableUpgradeTarget(target)).toBe(true);
    },
  );

  // node-ws'in `new URL` cagrisi bu hedeflerde TypeError firlatir (olculdu).
  it.each(['//[', '//%', '//x:99999', 'http://['])('%s cozumlenemez', (target) => {
    expect(isParseableUpgradeTarget(target)).toBe(false);
  });
});

describe('guardUpgradeTarget (gercek node-ws ile)', () => {
  const closers: Array<() => void> = [];

  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  async function startServer(): Promise<number> {
    const app = new Hono();
    const nodeWs = createNodeWebSocket({ app });
    app.get(
      '/ws',
      nodeWs.upgradeWebSocket(() => ({})),
    );
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.on('listening', resolve));
    guardUpgradeTarget(server);
    nodeWs.injectWebSocket(server);
    closers.push(() => server.close());
    return (server.address() as AddressInfo).port;
  }

  /** Ham TCP: tarayici/ws istemcisi gecersiz hedefi hic gondermez. */
  function upgradeRequest(port: number, target: string): Promise<string> {
    return new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      let received = '';
      socket.on('data', (chunk) => (received += chunk.toString('latin1')));
      socket.on('close', () => resolve(received.split('\r\n')[0] ?? ''));
      socket.on('error', () => undefined);
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n` +
          'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
      setTimeout(() => socket.destroy(), 300);
    });
  }

  it('gecersiz upgrade hedefi yakalanmamis red uretmez, soketi keser', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const port = await startServer();

      const status = await upgradeRequest(port, '//[');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(status).toBe('');
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('gecerli upgrade hedefi korumadan etkilenmez (101)', async () => {
    const port = await startServer();

    expect(await upgradeRequest(port, '/ws')).toBe('HTTP/1.1 101 Switching Protocols');
  });
});

describe('installUnhandledRejectionLogger', () => {
  it('reddi hata ADIYLA loglar, mesaji ve yigini yazmaz; surec olay sayesinde dusmez', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const source = new EventEmitter();
    installUnhandledRejectionLogger(source);

    source.emit('unhandledRejection', new TypeError('parola: hunter2 ile ilgili ayrinti'));
    source.emit('unhandledRejection', 'duz dizge');

    expect(errorLog).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).toContain('TypeError');
    expect(logged).toContain('unknown');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('duz dizge');
  });

  it('uncaughtException davranisina dokunmaz', () => {
    const source = new EventEmitter();
    installUnhandledRejectionLogger(source);

    expect(source.listenerCount('uncaughtException')).toBe(0);
    expect(source.listenerCount('unhandledRejection')).toBe(1);
  });
});
