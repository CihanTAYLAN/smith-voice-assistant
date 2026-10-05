import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { maskedErrorHandler } from './error-handler.js';

function appThatThrows(error: Error): Hono {
  const app = new Hono();
  app.onError(maskedErrorHandler);
  app.post('/v1/yanlis', () => {
    throw error;
  });
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maskedErrorHandler', () => {
  it('beklenmeyen hatada JSON 500 doner ve govde parcasini gunluge yazmaz', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Hono'nun varsayilan isleyicisi bu mesaji oldugu gibi console.error'a basardi.
    const parseError = new SyntaxError(
      'Unexpected token \'h\', ..."password":hunter2hun"... is not valid JSON',
    );

    const response = await appThatThrows(parseError).request('/v1/yanlis', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'Sunucu hatasi.' });
    expect(errorLog).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).toContain('SyntaxError');
    expect(logged).toContain('/v1/yanlis');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('password');
  });

  it('hata nesnesinin kendisini (yigin izi dahil) console.error a gecirmez', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await appThatThrows(new Error('gizli ayrinti')).request('/v1/yanlis', { method: 'POST' });

    for (const call of errorLog.mock.calls) {
      for (const argument of call) expect(typeof argument).toBe('string');
    }
  });

  it('HTTPException kendi yanitini korur', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = new Hono();
    app.onError(maskedErrorHandler);
    app.get('/v1/yasak', () => {
      throw new HTTPException(418, { message: 'demlik' });
    });

    const response = await app.request('/v1/yasak');

    expect(response.status).toBe(418);
    expect(await response.text()).toBe('demlik');
  });
});
