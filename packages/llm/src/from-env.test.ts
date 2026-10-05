import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLlmRouterFromEnv } from './from-env.js';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

function streamResponse(text: string) {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] };
    },
  };
}

const env = {
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  SMITH_LLM_BASE_URL: 'https://llm.example/v1',
  SMITH_LLM_API_KEY: 'k',
  SMITH_LLM_MODEL: 'gemini-flash-latest',
};

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue(streamResponse('- madde'));
});

describe('createLlmRouterFromEnv summarizer butcesi', () => {
  // Olcum (2026-10-03, gemini-flash-latest, 26 turluk oturum, ayni istek):
  // dusunme ~1000 belirtec + gorunen ozet ~140. `max_tokens` dusunmeyi de
  // kapsadigi icin 512 butcede metin BOS kaliyordu (finish_reason: length) ve
  // ozet isi her denemede dusuyordu.
  it('ozet istegi dusunen modelin dusunme belirteclerini de karsilayacak butceyle gider', async () => {
    await createLlmRouterFromEnv(env).streamChat('summarizer', [{ role: 'user', content: 'x' }]);

    const body = create.mock.calls[0]?.[0] as { max_tokens: number };
    expect(body.max_tokens).toBeGreaterThanOrEqual(2048);
  });
});
