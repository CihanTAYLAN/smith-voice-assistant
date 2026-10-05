import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentTurnIncompleteError } from './agent/run-turn.js';
import { createAuthRoutes } from './routes/auth.js';
import { WS_TICKET_POLICY } from './routes/attempt-limiter.js';
import { TurnInProgressError } from './turn.js';

const SESSION = 'ses_abc123def456ghi789jk';
const NEW_SESSION = 'ses_new123def456ghi789jk';
const MESSAGE = 'msg_abc123def456ghi789jk';
const SECOND_MESSAGE = 'msg_def456ghi789jkl012mn';

const scope = {
  workspaceId: 'ws_0123456789abcdefghij',
  actorId: 'act_0123456789abcdefghij',
  role: 'owner',
  system: false,
} as const;

const state = vi.hoisted(() => ({
  fetch: undefined as undefined | ((request: Request) => Response | Promise<Response>),
  wsFactory: undefined as
    undefined | ((context: unknown) => Record<string, (...args: never[]) => unknown>),
  wsOptions: { maxPayload: 100 * 1024 * 1024 },
  createSession: vi.fn(),
  findSession: vi.fn(),
  registerDevice: vi.fn(),
  runChatTurn: vi.fn(),
  queueAdd: vi.fn().mockResolvedValue(undefined),
  dbQuery: vi.fn(),
  redis: { status: 'ready', ping: vi.fn() },
  prependListener: vi.fn(),
  injectWebSocket: vi.fn(),
}));

vi.mock('@hono/node-server', () => ({
  serve: vi.fn((options: { fetch: (request: Request) => Response | Promise<Response> }) => {
    state.fetch = options.fetch;
    return { prependListener: state.prependListener };
  }),
}));

vi.mock('@hono/node-ws', () => ({
  createNodeWebSocket: vi.fn(() => ({
    wss: { options: state.wsOptions },
    upgradeWebSocket: vi.fn((factory: typeof state.wsFactory) => {
      state.wsFactory = factory;
      return () => new Response(null, { status: 200 });
    }),
    injectWebSocket: state.injectWebSocket,
  })),
}));

vi.mock('@smith/env', () => ({
  gatewayEnvSchema: {},
  loadEnv: () => ({
    DATABASE_URL: 'postgres://test',
    REDIS_URL: 'redis://test',
    SESSION_SECRET: 'test-secret-en-az-otuz-iki-karakter',
    LANGFUSE_BASE_URL: undefined,
    LANGFUSE_PUBLIC_KEY: undefined,
    LANGFUSE_SECRET_KEY: undefined,
    SMITH_LLM_BASE_URL: undefined,
    OLLAMA_BASE_URL: 'http://localhost:11434',
    SMITH_AGENT_LOOP: false,
    CORS_ORIGINS: [],
    NODE_ENV: 'test',
    PORT: 0,
    SMITH_GATEWAY_HOST: '127.0.0.1',
  }),
}));

vi.mock('@smith/auth', () => {
  class TestAuthError extends Error {}
  return {
    AuthError: TestAuthError,
    verifyAccessToken: vi.fn((_secret: string, token: string) => {
      if (token !== 'valid-token') throw new TestAuthError('Gecersiz token.');
      return scope;
    }),
  };
});

vi.mock('@smith/db', () => ({
  createDb: () => ({ prisma: {}, pool: { query: state.dbQuery } }),
  withScope: (_prisma: unknown, _scope: unknown, fn: (tx: unknown) => unknown) => fn({}),
  createSession: state.createSession,
  findSession: state.findSession,
  registerDevice: state.registerDevice,
}));

vi.mock('@smith/llm', () => ({
  createLlmRouterFromEnv: () => ({}),
  describeChain: () => 'test',
}));

vi.mock('@smith/memory', () => ({
  createEmbedderFromEnv: () => ({ model: 'test' }),
  GAP_STATUSES: ['open', 'asked', 'answered', 'dismissed'],
}));
vi.mock('@smith/observability', () => ({
  initTracing: () => ({ enabled: false, reason: 'test' }),
  observe: (_name: string, _metadata: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@smith/queue', () => ({
  QueueName: { MEMORY_INDEX: 'memory', AGENT_RUN: 'agent', SESSION_SUMMARY: 'summary' },
  createQueueConnection: () => state.redis,
  createQueue: () => ({ add: state.queueAdd }),
}));

vi.mock('./agent/llm-loop-model.js', () => ({ createLlmLoopModel: () => ({}) }));
vi.mock('./agent/device-bridge.js', () => ({
  createDeviceBridge: () => ({}),
  resolveDeviceResult: vi.fn(),
}));
vi.mock('./agent/run-turn.js', () => ({
  runAgentChatTurn: vi.fn(),
  AgentTurnIncompleteError: class AgentTurnIncompleteError extends Error {
    constructor(readonly stopReason: 'error' | 'cancelled' | 'max_steps') {
      super(stopReason);
    }
  },
}));
vi.mock('./agent/tools.js', () => ({ buildAgentRegistry: () => ({}) }));
vi.mock('./turn.js', () => ({
  IdempotencyConflictError: class IdempotencyConflictError extends Error {},
  TurnInProgressError: class TurnInProgressError extends Error {
    constructor(readonly retryAfterMs = 0) {
      super('mesgul');
    }
  },
  runChatTurn: state.runChatTurn,
}));
vi.mock('./session-summary-scheduler.js', () => ({ createSessionSummaryScheduler: () => ({}) }));

vi.mock('./routes/auth.js', () => ({
  createAuthRoutes: vi.fn(() => {
    const app = new Hono();
    app.post('/probe', async (c) => c.json(await c.req.json()));
    return app;
  }),
}));
vi.mock('./routes/conversation.js', () => ({
  createConversationRoutes: () => new Hono(),
  resolveIdleHours: () => 24,
}));
vi.mock('./routes/dev-login.js', () => ({ createDevLoginRoutes: () => new Hono() }));
vi.mock('./routes/mission.js', () => ({ createMissionRoutes: () => new Hono() }));
vi.mock('./routes/tools.js', () => ({ createToolRoutes: () => new Hono() }));

type WsEvents = {
  onOpen(event: unknown, ws: FakeWs): void;
  onMessage(event: { data: unknown }, ws: FakeWs): void;
};

class FakeWs {
  readonly frames: unknown[] = [];
  readonly close = vi.fn();

  send(data: string): void {
    this.frames.push(JSON.parse(data));
  }
}

function connect(query: Record<string, string> = { token: 'valid-token' }) {
  if (!state.wsFactory) throw new Error('WS factory capture edilmedi');
  const events = state.wsFactory({
    req: { query: (name: string) => query[name] },
  }) as unknown as WsEvents;
  const ws = new FakeWs();
  events.onOpen({}, ws);
  return { events, ws };
}

async function send(events: WsEvents, ws: FakeWs, frame: unknown): Promise<void> {
  events.onMessage({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) }, ws);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function hello(events: WsEvents, ws: FakeWs, resumeSessionId?: string): Promise<void> {
  await send(events, ws, {
    type: 'hello',
    protocolVersion: 1,
    surface: 'windows',
    clientVersion: 'test',
    ...(resumeSessionId ? { resumeSessionId } : {}),
  });
}

function prompt(messageId = MESSAGE, content: unknown[] = [{ kind: 'text', text: 'merhaba' }]) {
  return { type: 'prompt', sessionId: SESSION, messageId, content };
}

beforeAll(async () => {
  await import('./index.js');
});

beforeEach(() => {
  state.dbQuery.mockReset().mockResolvedValue({ rows: [{ '?column?': 1 }] });
  state.redis.status = 'ready';
  state.redis.ping.mockReset().mockResolvedValue('PONG');
  state.createSession.mockReset().mockResolvedValue({ id: NEW_SESSION, actorId: scope.actorId });
  state.findSession.mockReset().mockResolvedValue({ id: SESSION, actorId: scope.actorId });
  state.registerDevice.mockReset().mockResolvedValue(undefined);
  state.runChatTurn.mockReset().mockResolvedValue({ text: 'cevap' });
  state.queueAdd.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('transport sinirlari', () => {
  it('WebSocket transport maxPayload degerini 1 MiB yapar', () => {
    expect(state.wsOptions.maxPayload).toBe(1024 * 1024);
  });

  it('1 MiB uzeri HTTP govdesini route JSON parse etmeden 413 ile reddeder', async () => {
    if (!state.fetch) throw new Error('HTTP fetch capture edilmedi');
    const body = JSON.stringify({ value: 'x'.repeat(1024 * 1024) });
    const response = await state.fetch(
      new Request('http://localhost/v1/auth/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        body,
      }),
    );

    expect(response.status).toBe(413);
  });

  it('Content-Length olmayan parcalanmis HTTP govdesinin gercek byte sayisini sinirlar', async () => {
    if (!state.fetch) throw new Error('HTTP fetch capture edilmedi');
    const body = new TextEncoder().encode(JSON.stringify({ value: 'x'.repeat(1024 * 1024) }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.slice(0, 256 * 1024));
        controller.enqueue(body.slice(256 * 1024));
        controller.close();
      },
    });
    const response = await state.fetch(
      new Request('http://localhost/v1/auth/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      }),
    );

    expect(response.status).toBe(413);
  });

  it('dusuk gosterilmis Content-Length degerine guvenmeden gercek govdeyi sinirlar', async () => {
    if (!state.fetch) throw new Error('HTTP fetch capture edilmedi');
    const body = JSON.stringify({ value: 'x'.repeat(1024 * 1024) });
    const response = await state.fetch(
      new Request('http://localhost/v1/auth/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '2' },
        body,
      }),
    );

    expect(response.status).toBe(413);
  });

  it('1 MiB uzeri WS frameini JSON parse etmeden 1009 ile kapatir', async () => {
    const { events, ws } = connect();
    await send(events, ws, ' '.repeat(1024 * 1024 + 1));

    expect(ws.close).toHaveBeenCalledWith(1009, expect.any(String));
  });
});

describe('WS kimligi ve oturum izolasyonu', () => {
  it('60 saniyelik bileti yalniz bir kez kabul eder', async () => {
    if (!state.fetch) throw new Error('HTTP fetch capture edilmedi');
    const response = await state.fetch(
      new Request('http://localhost/v1/ws/ticket', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }),
    );
    expect(response.status).toBe(201);
    const { ticket, expiresInMs } = (await response.json()) as {
      ticket: string;
      expiresInMs: number;
    };
    expect(expiresInMs).toBe(60_000);

    const first = connect({ ticket });
    expect(first.ws.close).not.toHaveBeenCalled();
    const second = connect({ ticket });
    expect(second.ws.close).toHaveBeenCalled();
  });

  it('60 saniyeyi gecen bileti ve ticket varken legacy downgrade yolunu reddeder', async () => {
    if (!state.fetch) throw new Error('HTTP fetch capture edilmedi');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const response = await state.fetch(
      new Request('http://localhost/v1/ws/ticket', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }),
    );
    const { ticket } = (await response.json()) as { ticket: string };
    now.mockReturnValue(61_001);

    const expired = connect({ ticket, token: 'valid-token' });
    expect(expired.ws.close).toHaveBeenCalled();
    const invalid = connect({ ticket: 'gecersiz', token: 'valid-token' });
    expect(invalid.ws.close).toHaveBeenCalled();
  });

  it('legacy token yolunu secretsiz uyariyla gecici olarak kabul eder', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ws } = connect();

    expect(ws.close).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.not.stringContaining('valid-token'));
  });

  it('legacy token yolu bayrakla kapatilir; bilet yolu etkilenmez', async () => {
    vi.stubEnv('SMITH_WS_DISABLE_LEGACY_TOKEN', '1');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const legacy = connect({ token: 'valid-token' });
    expect(legacy.ws.close).toHaveBeenCalled();
    expect(legacy.ws.frames).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'unauthenticated' }),
    );
    expect(JSON.stringify(legacy.ws.frames)).not.toContain('valid-token');
    expect(warning).not.toHaveBeenCalled();

    if (!state.fetch) throw new Error('HTTP fetch capture edilmedi');
    const response = await state.fetch(
      new Request('http://localhost/v1/ws/ticket', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }),
    );
    const { ticket } = (await response.json()) as { ticket: string };
    expect(connect({ ticket }).ws.close).not.toHaveBeenCalled();
  });

  it('legacy token uyarisi bayragi ve gecis yolunu soyler', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    connect();

    expect(warning).toHaveBeenCalledWith(expect.stringContaining('SMITH_WS_DISABLE_LEGACY_TOKEN'));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('/v1/ws/ticket'));
  });

  it('ayni workspace icindeki baska actor sessionini resume etmez', async () => {
    state.findSession.mockResolvedValue({
      id: SESSION,
      actorId: 'act_other123456789abcdefgh',
    });
    const { events, ws } = connect();
    await hello(events, ws, SESSION);

    expect(state.createSession).toHaveBeenCalledOnce();
    expect(ws.frames).toContainEqual(
      expect.objectContaining({ type: 'ready', sessionId: NEW_SESSION }),
    );
  });
});

describe('WS tur guvenligi', () => {
  it('ayni session icin ikinci eszamanli turu mesgul hatasiyla reddeder', async () => {
    let finishFirst: (() => void) | undefined;
    state.runChatTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve({ text: 'cevap' });
        }),
    );
    const first = connect();
    const second = connect();
    await hello(first.events, first.ws, SESSION);
    await hello(second.events, second.ws, SESSION);

    first.events.onMessage({ data: JSON.stringify(prompt()) }, first.ws);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await send(second.events, second.ws, prompt(SECOND_MESSAGE));

    expect(state.runChatTurn).toHaveBeenCalledTimes(1);
    expect(second.ws.frames).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'rate_limited' }),
    );
    finishFirst?.();
  });

  it('image veya file parcasini sessizce metne dusurmez', async () => {
    const { events, ws } = connect();
    await hello(events, ws, SESSION);
    await send(
      events,
      ws,
      prompt(MESSAGE, [{ kind: 'image', mediaType: 'image/png', blobRef: 'b' }]),
    );

    expect(state.runChatTurn).not.toHaveBeenCalled();
    expect(ws.frames).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'protocol_mismatch' }),
    );
  });

  it('protocol vaadi geregi messageId degerini kanonik idempotency anahtari yapar', async () => {
    const { events, ws } = connect();
    await hello(events, ws, SESSION);
    await send(events, ws, { ...prompt(), idempotencyKey: 'farkli-anahtar' });

    expect(state.runChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: MESSAGE }),
    );
  });

  it('baska yurutmenin claim i icin kalan sureyi retryAfterMs olarak bildirir', async () => {
    state.runChatTurn.mockRejectedValue(new TurnInProgressError(4_200));
    const { events, ws } = connect();
    await hello(events, ws, SESSION);

    await send(events, ws, prompt());

    expect(ws.frames).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'rate_limited', retryAfterMs: 4_200 }),
    );
  });

  it.each([
    ['error', 'upstream_unavailable'],
    ['max_steps', 'internal'],
  ] as const)(
    'ajan turu %s ile bitince istemciye %s kodlu error frame i gider (done degil)',
    async (stopReason, code) => {
      state.runChatTurn.mockRejectedValue(new AgentTurnIncompleteError(stopReason));
      const { events, ws } = connect();
      await hello(events, ws, SESSION);

      await send(events, ws, prompt());

      expect(ws.frames).toContainEqual(
        expect.objectContaining({ type: 'error', code, messageId: MESSAGE }),
      );
      expect(ws.frames).not.toContainEqual(expect.objectContaining({ type: 'done' }));
    },
  );

  it('iptal edilen tur done:cancelled gonderir (error frame i degil)', async () => {
    let rejectTurn: (reason: Error) => void = () => undefined;
    state.runChatTurn.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectTurn = reject;
        }),
    );
    const { events, ws } = connect();
    await hello(events, ws, SESSION);

    events.onMessage({ data: JSON.stringify(prompt()) }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));
    events.onMessage(
      { data: JSON.stringify({ type: 'cancel', sessionId: SESSION, messageId: MESSAGE }) },
      ws,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    rejectTurn(new AgentTurnIncompleteError('cancelled'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.frames).toContainEqual(
      expect.objectContaining({ type: 'done', stopReason: 'cancelled' }),
    );
    expect(ws.frames).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  it('dispatch rejectionini yakalayip guvenli hata frameine cevirir', async () => {
    state.findSession.mockRejectedValue(new Error('db secret detail'));
    const { events, ws } = connect();
    await hello(events, ws, SESSION);

    expect(ws.frames).toContainEqual(expect.objectContaining({ type: 'error', code: 'internal' }));
    expect(JSON.stringify(ws.frames)).not.toContain('db secret detail');
  });
});

describe('baslangic yapilandirmasi', () => {
  it('upgrade hedef korumasi node-ws dinleyicisinden ONCE kurulur', () => {
    expect(state.prependListener).toHaveBeenCalledWith('upgrade', expect.any(Function));
    const guardOrder = state.prependListener.mock.invocationCallOrder[0] ?? Infinity;
    const injectOrder = state.injectWebSocket.mock.invocationCallOrder[0] ?? 0;
    expect(guardOrder).toBeLessThan(injectOrder);
  });

  it('acik kayit varsayilan KAPALI baglanir', () => {
    expect(createAuthRoutes).toHaveBeenCalledWith(
      expect.objectContaining({ allowRegistration: false }),
    );
  });
});

describe('hata isleyici', () => {
  it('bozuk JSON govdesi JSON 500 doner ve parola parcasini loga yazmaz', async () => {
    if (!state.fetch) throw new Error('HTTP fetch capture edilmedi');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await state.fetch(
      new Request('http://localhost/v1/auth/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"email":"a@b.com","password":hunter2hunter2}',
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Sunucu hatasi.' });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('hunter2');
  });
});

describe('saglik ucu', () => {
  const health = () => {
    if (!state.fetch) throw new Error('HTTP fetch capture edilmedi');
    return state.fetch(new Request('http://localhost/v1/health'));
  };

  it('DB ve Redis yanit verirse 200 ve eski sozlesmeyi korur', async () => {
    const response = await health();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: true, redis: true, protocolVersion: 1 });
    expect(state.dbQuery).toHaveBeenCalledWith('SELECT 1');
    expect(state.redis.ping).toHaveBeenCalledOnce();
  });

  it('DB dusunce 503 ve db:false', async () => {
    state.dbQuery.mockRejectedValue(new Error('Connection terminated due to connection timeout'));

    const response = await health();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, db: false, redis: true });
  });

  it('Redis hazir degilse PING kuyruga girmeden 503 ve redis:false', async () => {
    state.redis.status = 'reconnecting';

    const response = await health();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, db: true, redis: false });
    expect(state.redis.ping).not.toHaveBeenCalled();
  });
});

/**
 * DOSYANIN SON describe'i olmali: kota actor basina bellekte tutulur ve bu test
 * onu doldurur; sonrasindaki bilet isteyen testler 429 alirdi.
 */
describe('bilet ucu kotasi', () => {
  const ticket = (token: string) => {
    if (!state.fetch) throw new Error('HTTP fetch capture edilmedi');
    return state.fetch(
      new Request('http://localhost/v1/ws/ticket', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  };

  it('gecersiz token kota tuketmez: gecerli sahibin bileti engellenmez', async () => {
    for (let i = 0; i < WS_TICKET_POLICY.threshold + 5; i += 1) {
      expect((await ticket('sahte-token')).status).toBe(401);
    }

    expect((await ticket('valid-token')).status).toBe(201);
  });

  it('dogrulanmis actor icin esikten sonra 429 + Retry-After doner', async () => {
    let blocked: Response | undefined;
    for (let i = 0; i < WS_TICKET_POLICY.threshold + 1 && !blocked; i += 1) {
      const response = await ticket('valid-token');
      if (response.status === 429) blocked = response;
    }

    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
