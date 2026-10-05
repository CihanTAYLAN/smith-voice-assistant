import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatResult, RoleConfig } from '../types.js';

import { createAnthropicProvider } from './anthropic.js';
import { createOpenAiCompatProvider } from './openai-compat.js';

/**
 * ADR 0004 invariant testi — SAGLAYICIYA-OPAK BLOK SIZMAZ.
 *
 * Neden: saglayicilarin dondurdugu sifreli `thinking` bloklari oturum, kullanici
 * ve model arasi TASINABILIR ciphertext'tir; ayni saglayicinin zayif kardes
 * modeline replay edilip duz metne cevrilebiliyor (stolen-thoughts.com, 2026-08).
 * Yani o blok opak bir metadata DEGIL, herkese acik bir oracle'i olan sifreli
 * metindir — bir yere yazildiysa (log, trace, fixture, issue) duz metin
 * yazilmis sayilir. Ustelik olculen sizintilarin bir kismi YALNIZCA reasoning
 * blogunun icinde vardi, gorunur ciktida hic yoktu.
 *
 * Bugun iki saglayici da yapisal olarak bagisik: anthropic `text` disi bloklari
 * dusuruyor, openai-compat yalniz `delta.content` okuyor. Bu bagisiklik KAZA
 * ESERIDIR ve bu dosya onu niyete cevirir. Test kirilirsa mesaj sudur: birisi
 * cok turlu thinking icin "tum bloklari koru ve geri besle" duzeltmesini yapti
 * ve tasinabilir ciphertext'i kaliciliastirmaya basladi.
 */

/** `ChatResult` uzerinde izin verilen TUM alanlar. Buraya alan eklemek ADR kararidir. */
const IZINLI_SONUC_ALANLARI = ['text', 'usage'];
const IZINLI_USAGE_ALANLARI = ['inputTokens', 'outputTokens'];

/** Sizmasi yasak sentinel degerler — gercek bir imza/sir bloguna benzetildi. */
const SIFRELI_IMZA = 'ErUBCkYIBxgCKkBk9xSIGNATURE_ASLA_SIZMAZ==';
// Kasten anahtar BICIMINDE degil: scan-secrets.sh desenlerine yanlis pozitif
// olmasin. Testin isi bu degerin essiz olmasi, gercekci gorunmesi degil.
const REASONING_SIRRI = 'GIZLI-DEGER-YALNIZ-REASONING-BLOGUNDA';

// --- @anthropic-ai/sdk sahtesi -------------------------------------------------
let anthropicIstekleri: { messages: { role: string; content: unknown }[] }[] = [];
let anthropicFinalContent: unknown[] = [];

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = {
      stream: (body: { messages: { role: string; content: unknown }[] }) => {
        anthropicIstekleri.push(body);
        return {
          on: (event: string, cb: (delta: string) => void) => {
            // Gercek SDK yalniz text bloklari icin 'text' olayi yayar.
            if (event === 'text') {
              for (const block of anthropicFinalContent) {
                const b = block as { type: string; text?: string };
                if (b.type === 'text' && b.text) cb(b.text);
              }
            }
          },
          finalMessage: () =>
            Promise.resolve({
              content: anthropicFinalContent,
              usage: { input_tokens: 11, output_tokens: 22 },
            }),
        };
      },
    };
  },
}));

// --- openai sahtesi ------------------------------------------------------------
let openAiChunklari: unknown[] = [];

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = {
      completions: {
        // `for await` senkron iterable'i da kabul eder; async generator
        // kullanmamak lint'i (require-await) gereksiz yere zorlamamak icin.
        create: () =>
          Promise.resolve({
            *[Symbol.iterator]() {
              for (const chunk of openAiChunklari) yield chunk;
            },
          }),
      },
    };
  },
}));

const ANTHROPIC_ROL: RoleConfig = {
  provider: 'anthropic',
  model: 'claude-test',
  maxOutputTokens: 128,
};

const OLLAMA_ROL: RoleConfig = {
  provider: 'openai-compat',
  model: 'qwen-test',
  maxOutputTokens: 128,
};

/**
 * Invariant iddiasi: sonuc yalniz izinli alanlari tasir ve serilestirilmis
 * hicbir yerinde opak/gizli sentinel gecmez.
 */
function opakIcerikTasimiyor(sonuc: ChatResult): void {
  const fazlaAlanlar = Object.keys(sonuc).filter((k) => !IZINLI_SONUC_ALANLARI.includes(k));
  expect(fazlaAlanlar, 'ChatResult beklenmeyen alan tasiyor').toEqual([]);

  if (sonuc.usage) {
    const fazlaUsage = Object.keys(sonuc.usage).filter((k) => !IZINLI_USAGE_ALANLARI.includes(k));
    expect(fazlaUsage, 'ChatUsage beklenmeyen alan tasiyor').toEqual([]);
  }

  const seri = JSON.stringify(sonuc);
  expect(seri, 'sifreli imza sonuca sizdi').not.toContain(SIFRELI_IMZA);
  expect(seri, 'yalniz reasoning icinde olan sir sonuca sizdi').not.toContain(REASONING_SIRRI);
}

beforeEach(() => {
  anthropicIstekleri = [];
  anthropicFinalContent = [];
  openAiChunklari = [];
});

describe('anthropic — opak blok sizmaz', () => {
  it('thinking / redacted_thinking / tool_use bloklarini dusurur, yalniz text birlestirir', async () => {
    anthropicFinalContent = [
      {
        type: 'thinking',
        thinking: `Kullanicinin anahtari ${REASONING_SIRRI} — bunu kullanmaliyim.`,
        signature: SIFRELI_IMZA,
      },
      { type: 'text', text: 'Merhaba' },
      { type: 'redacted_thinking', data: SIFRELI_IMZA },
      { type: 'text', text: ' efendim.' },
      { type: 'tool_use', id: 'tu_1', name: 'shell', input: { cmd: 'ls' } },
    ];

    const provider = createAnthropicProvider('test-key');
    const sonuc = await provider.streamChat(ANTHROPIC_ROL, [{ role: 'user', content: 'selam' }]);

    expect(sonuc.text).toBe('Merhaba efendim.');
    expect(sonuc.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    opakIcerikTasimiyor(sonuc);
  });

  it('onDelta yalniz text bloklarini yayar — muhakeme tuketiciye akmaz', async () => {
    anthropicFinalContent = [
      { type: 'thinking', thinking: REASONING_SIRRI, signature: SIFRELI_IMZA },
      { type: 'text', text: 'cevap' },
    ];

    const deltalar: string[] = [];
    const provider = createAnthropicProvider('test-key');
    await provider.streamChat(ANTHROPIC_ROL, [{ role: 'user', content: 'selam' }], {
      onDelta: (d) => deltalar.push(d),
    });

    expect(deltalar).toEqual(['cevap']);
    expect(deltalar.join('')).not.toContain(REASONING_SIRRI);
  });

  it('istege giden her turun content alani duz string — blok dizisi geri beslenmez', async () => {
    anthropicFinalContent = [{ type: 'text', text: 'ok' }];

    const provider = createAnthropicProvider('test-key');
    await provider.streamChat(ANTHROPIC_ROL, [
      { role: 'system', content: 'sistem' },
      { role: 'user', content: 'soru' },
      // Onceki asistan turu: gecmise yalniz duz metin yazildigi icin burada da
      // duz metindir. Blok dizisi olsaydi tasinabilir ciphertext geri giderdi.
      { role: 'assistant', content: 'onceki cevap' },
      { role: 'user', content: 'devam' },
    ]);

    const istek = anthropicIstekleri[0];
    expect(istek).toBeDefined();
    for (const tur of istek!.messages) {
      expect(typeof tur.content, `${tur.role} turu duz string olmali`).toBe('string');
    }
  });
});

describe('openai-compat — opak blok sizmaz', () => {
  it('reasoning_content / reasoning alanlarini yok sayar, yalniz content birlestirir', async () => {
    openAiChunklari = [
      {
        choices: [
          {
            delta: {
              content: 'Merhaba',
              // DeepSeek/Ollama tarzi endpoint'ler muhakemeyi ayri alanda yayar.
              reasoning_content: `anahtar ${REASONING_SIRRI}`,
              reasoning: SIFRELI_IMZA,
            },
          },
        ],
      },
      { choices: [{ delta: { content: ' efendim.' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 7 },
      },
    ];

    const provider = createOpenAiCompatProvider({ baseUrl: 'http://localhost:11434/v1' });
    const sonuc = await provider.streamChat(OLLAMA_ROL, [{ role: 'user', content: 'selam' }]);

    expect(sonuc.text).toBe('Merhaba efendim.');
    expect(sonuc.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    opakIcerikTasimiyor(sonuc);
  });

  it('saglayici usage bildirmezse usage alani hic olusmaz — uydurulmaz', async () => {
    openAiChunklari = [{ choices: [{ delta: { content: 'kisa' }, finish_reason: 'stop' }] }];

    const provider = createOpenAiCompatProvider({ baseUrl: 'http://localhost:11434/v1' });
    const sonuc = await provider.streamChat(OLLAMA_ROL, [{ role: 'user', content: 'selam' }]);

    expect(sonuc).toEqual({ text: 'kisa' });
    expect('usage' in sonuc).toBe(false);
    opakIcerikTasimiyor(sonuc);
  });
});
