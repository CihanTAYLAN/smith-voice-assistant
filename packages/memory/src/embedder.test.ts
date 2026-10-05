import { beforeEach, describe, expect, it, vi } from 'vitest';

const { create, clientOptions } = vi.hoisted(() => ({ create: vi.fn(), clientOptions: vi.fn() }));

vi.mock('openai', () => ({
  default: class {
    embeddings = { create };
    constructor(options: unknown) {
      clientOptions(options);
    }
  },
}));

import { createEmbedder, EMBED_TIMEOUT_MS, EMBEDDING_DIMENSIONS } from './embedder.js';

const vector = (): number[] => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);

describe('createEmbedder istemci zaman asimi', () => {
  it('istemciye 30 sn zaman asimi ve tek yeniden deneme verir (SDK varsayilani 10 dk x 3)', () => {
    clientOptions.mockClear();

    createEmbedder({ baseUrl: 'https://uzak.example/v1', apiKey: 'k' });

    expect(EMBED_TIMEOUT_MS).toBe(30_000);
    expect(clientOptions).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: EMBED_TIMEOUT_MS, maxRetries: 1 }),
    );
  });
});

describe('createEmbedder iptal sinyali', () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue({ data: [{ embedding: vector() }] });
  });

  it('sinyali uzak embedding istegine kadar tasir (iptal edilen tur istegi surdurmez)', async () => {
    const controller = new AbortController();
    const embedder = createEmbedder({ baseUrl: 'http://localhost:11434/v1' });

    await embedder.embed('merhaba', { signal: controller.signal });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ input: ['merhaba'] }), {
      signal: controller.signal,
    });
  });

  it('embedBatch de ayni sinyali tasir', async () => {
    create.mockResolvedValue({ data: [{ embedding: vector() }, { embedding: vector() }] });
    const controller = new AbortController();
    const embedder = createEmbedder({ baseUrl: 'http://localhost:11434/v1' });

    await embedder.embedBatch(['a', 'b'], { signal: controller.signal });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ input: ['a', 'b'] }), {
      signal: controller.signal,
    });
  });

  it('sinyal verilmezse istek secenegi gondermez', async () => {
    await createEmbedder({ baseUrl: 'http://localhost:11434/v1' }).embed('merhaba');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ input: ['merhaba'] }), undefined);
  });

  it('bakim cagrisi SDK tekrarini kapatir', async () => {
    await createEmbedder({ baseUrl: 'http://localhost:11434/v1' }).embed('bakim', {
      singleAttempt: true,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ input: ['bakim'] }), {
      maxRetries: 0,
    });
  });

  it('iptal edilen istek EmbeddingError olarak yukari cikar', async () => {
    create.mockRejectedValue(new Error('Request was aborted.'));
    const controller = new AbortController();
    controller.abort();
    await expect(
      createEmbedder({ baseUrl: 'http://localhost:11434/v1' }).embed('x', {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'EmbeddingError' });
  });
});
