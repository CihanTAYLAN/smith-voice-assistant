import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLlmRouter, type LlmFallback } from './router.js';
import type { LlmRole, RoleConfig } from './types.js';

/** OpenAI SDK sahtesi: davranis baseURL'e gore ayrisir (birincil vs yedek). */
const { createByBase } = vi.hoisted(() => ({ createByBase: vi.fn() }));

vi.mock('openai', () => ({
  default: class {
    baseURL: string;
    chat = {
      completions: {
        create: (body: unknown, options?: unknown): unknown =>
          createByBase(this.baseURL, body, options),
      },
    };
    constructor(opts: { baseURL: string }) {
      this.baseURL = opts.baseURL;
    }
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

const PRIMARY = 'https://primary.example/v1';
const BACKUP = 'https://backup.example/v1';

const roles: Record<LlmRole, RoleConfig> = {
  chat: { provider: 'openai-compat', model: 'primary-model', maxOutputTokens: 100 },
  summarizer: { provider: 'openai-compat', model: 'primary-model', maxOutputTokens: 50 },
};

// Kurgu saglayici: JENERIK yedek mekanizmasini test eder; adi bilincli olarak
// notr (gercek bir saglayici vaat etmez — bkz. gun notu "llm-yedek-saglayici-karari").
const uzakYedek: LlmFallback = {
  label: 'yedek',
  baseUrl: BACKUP,
  apiKey: 'k',
  models: { chat: 'yedek-model', summarizer: 'yedek-model' },
};

function httpError(status: number): Error {
  return Object.assign(new Error(`${status} hata`), { status });
}

function okResponse(text: string) {
  return {
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

function streamResponse(text: string) {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] };
    },
  };
}

function makeRouter(extra: { attemptTimeoutMs?: number; onFallback?: () => void } = {}) {
  return createLlmRouter({
    roles,
    openAiCompatBaseUrl: PRIMARY,
    fallbacks: [uzakYedek],
    ...extra,
  });
}

beforeEach(() => {
  createByBase.mockReset();
});

describe('yedek zinciri', () => {
  it('bakimda 429 SDK tekrarini ve yedek zincirini durdurur', async () => {
    createByBase.mockRejectedValue(httpError(429));
    const router = makeRouter();
    await expect(
      router.streamChat('summarizer', [{ role: 'user', content: 'bakim' }], {
        singleAttempt: true,
      }),
    ).rejects.toThrow();
    expect(createByBase).toHaveBeenCalledTimes(1);
    expect(createByBase).toHaveBeenCalledWith(
      PRIMARY,
      expect.anything(),
      expect.objectContaining({ maxRetries: 0 }),
    );
  });
  it('429: birincil dusunce YEDEK saglayici kendi model adiyla devreye girer', async () => {
    createByBase.mockImplementation((base: string) => {
      if (base === PRIMARY) return Promise.reject(httpError(429));
      return Promise.resolve(okResponse('yedekten cevap'));
    });
    const fallbackLog: { from: string; to: string }[] = [];
    const router = createLlmRouter({
      roles,
      openAiCompatBaseUrl: PRIMARY,
      fallbacks: [uzakYedek],
      onFallback: (info) => fallbackLog.push({ from: info.from, to: info.to }),
    });

    const r = await router.generateWithTools('chat', [{ role: 'user', content: 'q' }], []);
    expect(r.text).toBe('yedekten cevap');
    expect(fallbackLog).toEqual([{ from: 'birincil', to: 'yedek' }]);

    // Yedege giden istekte MODEL ADI yedek saglayicininki olmali.
    const lastCall = createByBase.mock.calls.at(-1) as [string, { model: string }];
    expect(lastCall[0]).toBe(BACKUP);
    expect(lastCall[1].model).toBe('yedek-model');
  });

  it('400: kalici hata YEDEGE DUSMEZ, hemen patlar (bug maskelenmesin)', async () => {
    createByBase.mockImplementation((base: string) => {
      if (base === PRIMARY) return Promise.reject(httpError(400));
      return Promise.resolve(okResponse('yedek'));
    });
    const router = makeRouter();
    await expect(
      router.generateWithTools('chat', [{ role: 'user', content: 'q' }], []),
    ).rejects.toThrow();
    // Yedek HIC cagrilmamis olmali.
    expect(createByBase.mock.calls.every(([base]) => base === PRIMARY)).toBe(true);
  });

  it('STALL: yanit gelmezse zaman asimi devreye girer ve yedege gecilir', async () => {
    vi.useFakeTimers();
    try {
      createByBase.mockImplementation((base: string) => {
        // Birincil ASILIYOR: hic cozulmeyen promise (2026-08-25 sahada goruldu).
        if (base === PRIMARY) return new Promise(() => undefined);
        return Promise.resolve(okResponse('yedek kurtardi'));
      });
      const router = makeRouter({ attemptTimeoutMs: 1000 });
      const promise = router.generateWithTools('chat', [{ role: 'user', content: 'q' }], []);
      await vi.advanceTimersByTimeAsync(1100);
      await expect(promise).resolves.toMatchObject({ text: 'yedek kurtardi' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('zaman asimina ugrayan denemenin gec deltasini yedek cevaba karistirmaz', async () => {
    vi.useFakeTimers();
    try {
      createByBase.mockImplementation((base: string) => {
        if (base === PRIMARY) {
          return new Promise((resolve) =>
            setTimeout(() => resolve(streamResponse('terk-edilen')), 2_000),
          );
        }
        return Promise.resolve(streamResponse('yedek'));
      });
      const deltas: string[] = [];
      const router = makeRouter({ attemptTimeoutMs: 1_000 });
      const resultPromise = router.streamChat('chat', [{ role: 'user', content: 'q' }], {
        onDelta: (text) => deltas.push(text),
      });
      await vi.advanceTimersByTimeAsync(1_100);
      await expect(resultPromise).resolves.toMatchObject({ text: 'yedek' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(deltas).toEqual(['yedek']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tum halkalar duserse birlesik hata verir (hangi halka neden dustu)', async () => {
    createByBase.mockImplementation(() => Promise.reject(httpError(503)));
    const router = makeRouter();
    await expect(
      router.generateWithTools('chat', [{ role: 'user', content: 'q' }], []),
    ).rejects.toThrow(/Tum LLM saglayicilari basarisiz/);
  });

  it('kullanici iptali yedege DUSMEZ', async () => {
    const controller = new AbortController();
    createByBase.mockImplementation(() => {
      controller.abort();
      return Promise.reject(Object.assign(new Error('aborted'), { status: 503 }));
    });
    const router = makeRouter();
    await expect(
      router.generateWithTools('chat', [{ role: 'user', content: 'q' }], [], {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
    expect(createByBase).toHaveBeenCalledTimes(1);
  });

  // Gateway recall'inda iptal edilen tur `catch` ile yutulup LLM cagrisina zaten
  // iptal edilmis sinyalle geliyordu; `abort` olayi bir daha ateslenmedigi icin
  // cevap sonuna kadar akiyor ve "Dur" yok sayiliyordu.
  it.each(['streamChat', 'generateWithTools'] as const)(
    '%s: cagridan once iptal edilmis sinyalle saglayici HIC cagrilmaz',
    async (method) => {
      const controller = new AbortController();
      controller.abort();
      createByBase.mockImplementation(() => Promise.resolve(okResponse('cevap')));
      const router = makeRouter();
      const onDelta = vi.fn();
      const options = { signal: controller.signal, onDelta };
      const messages = [{ role: 'user' as const, content: 'q' }];

      const call =
        method === 'streamChat'
          ? router.streamChat('chat', messages, options)
          : router.generateWithTools('chat', messages, [], options);

      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      expect(createByBase).not.toHaveBeenCalled();
      expect(onDelta).not.toHaveBeenCalled();
    },
  );

  it('onceden iptal edilmis sinyalin nedeni (signal.reason) aynen yukari cikar', async () => {
    const controller = new AbortController();
    controller.abort(new Error('kullanici durdurdu'));
    const router = makeRouter();

    await expect(
      router.streamChat('chat', [{ role: 'user', content: 'q' }], { signal: controller.signal }),
    ).rejects.toThrow('kullanici durdurdu');
    expect(createByBase).not.toHaveBeenCalled();
  });

  it('yedek yoksa davranis eskisi gibi: hata aynen yukari cikar', async () => {
    createByBase.mockImplementation(() => Promise.reject(httpError(429)));
    const router = createLlmRouter({ roles, openAiCompatBaseUrl: PRIMARY });
    await expect(
      router.generateWithTools('chat', [{ role: 'user', content: 'q' }], []),
    ).rejects.toThrow();
    expect(createByBase).toHaveBeenCalledTimes(1);
  });
});
