import { describe, expect, it } from 'vitest';

import {
  EnvValidationError,
  gatewayEnvSchema,
  LOCAL_DEFAULT_EMBED_MODEL,
  LOCAL_DEFAULT_MODEL,
  loadEnv,
  workerEnvSchema,
} from './index.js';

/**
 * Bu paketin tasarim karari "eksik veya bozuk config'i acilista yakala".
 * Testlerin varlik sebebi: 2026-08-15'e kadar `SMITH_LLM_*` alanlari semada
 * HIC YOKTU ve dogrudan `process.env`'den okunuyordu — yani Smith'in gercekten
 * kullandigi model yapilandirmasi bu sozlesmenin tamamen disindaydi. Yanlis
 * yapilandirma hata vermiyor, Smith sessizce yerel kucuk modele dusuyordu.
 * Bu sinif ariza belirti uretmez; kapiyi ancak test tutar.
 */

const SIRLI_ANAHTAR = 'sk-gercek-anahtar-asla-loglanmamali';

/** Sema disi alanlari etkilemeyen, gecerli bir taban. */
function tabanEnv(extra: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: 'postgresql://smith:smith@127.0.0.1:5433/smith',
    REDIS_URL: 'redis://127.0.0.1:6380',
    SESSION_SECRET: 'x'.repeat(32),
    ...extra,
  };
}

describe('gateway dinleme adresi', () => {
  it('SMITH_GATEWAY_HOST verilmezse loopback varsayilir (tum arayuzler degil)', () => {
    // Eskiden gateway hostname vermeden dinliyor, yani 0.0.0.0'da aciliyordu.
    const env = loadEnv(gatewayEnvSchema, tabanEnv());
    expect(env.SMITH_GATEWAY_HOST).toBe('127.0.0.1');
  });

  it('bos deger "verilmedi" sayilir ve loopback varsayilir', () => {
    const env = loadEnv(gatewayEnvSchema, tabanEnv({ SMITH_GATEWAY_HOST: '  ' }));
    expect(env.SMITH_GATEWAY_HOST).toBe('127.0.0.1');
  });

  it('konteyner 0.0.0.0 degerini acikca verebilir', () => {
    const env = loadEnv(gatewayEnvSchema, tabanEnv({ SMITH_GATEWAY_HOST: '0.0.0.0' }));
    expect(env.SMITH_GATEWAY_HOST).toBe('0.0.0.0');
  });
});

describe('baglam dislama env sozlesmesi', () => {
  it('gateway ve worker icin varsayilan bos, verilen CSV degismeden tasinir', () => {
    expect(loadEnv(gatewayEnvSchema, tabanEnv()).SMITH_CONTEXT_EXCLUDE).toBe('');
    expect(
      loadEnv(workerEnvSchema, tabanEnv({ SMITH_CONTEXT_EXCLUDE: 'obsidian:acme/*,kw:acme' }))
        .SMITH_CONTEXT_EXCLUDE,
    ).toBe('obsidian:acme/*,kw:acme');
  });
});

describe('yerel varsayilan', () => {
  it('hicbir LLM ayari verilmezse yerel modelde kalir ve uc secilmez', () => {
    const env = loadEnv(gatewayEnvSchema, tabanEnv());

    expect(env.SMITH_LLM_MODEL).toBe(LOCAL_DEFAULT_MODEL);
    expect(env.SMITH_LLM_BASE_URL).toBeUndefined();
    expect(env.SMITH_LLM_API_KEY).toBeUndefined();
    // Varsayilanin yerel kalmasi bir kolaylik degil gizlilik karari:
    // yapilandirmasiz kurulumda hicbir veri makineden cikmaz.
    expect(env.OLLAMA_BASE_URL).toBe('http://127.0.0.1:11434');
  });
});

describe('bos deger "verilmedi" demektir', () => {
  it('.env.example kopyalanip opsiyonel alanlar bos birakilirsa patlamaz', () => {
    const env = loadEnv(
      gatewayEnvSchema,
      tabanEnv({
        ANTHROPIC_API_KEY: '',
        SMITH_LLM_BASE_URL: '',
        SMITH_LLM_API_KEY: '',
        SMITH_LLM_MODEL: '',
        LANGFUSE_BASE_URL: '',
        LANGFUSE_PUBLIC_KEY: '',
        LANGFUSE_SECRET_KEY: '',
      }),
    );

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SMITH_LLM_BASE_URL).toBeUndefined();
    expect(env.LANGFUSE_BASE_URL).toBeUndefined();
    // Bos model adi varsayilana duser; "" diye bir model istenmez.
    expect(env.SMITH_LLM_MODEL).toBe(LOCAL_DEFAULT_MODEL);
  });

  it('yalniz bosluktan olusan deger de verilmemis sayilir', () => {
    const env = loadEnv(gatewayEnvSchema, tabanEnv({ SMITH_LLM_API_KEY: '   ' }));
    expect(env.SMITH_LLM_API_KEY).toBeUndefined();
  });
});

describe('uzak LLM ucunun capraz kurallari', () => {
  const UZAK_UC = 'https://generativelanguage.googleapis.com/v1beta/openai';

  it('uzak uc secilip anahtar verilmezse acilista durur', () => {
    // Gercek ariza: scripts/dev-secrets.local.ps1 kosmadiginda anahtar bos
    // kalir. Once bu, calisma aninda yetkisiz istek olarak ortaya cikiyordu.
    expect(() =>
      loadEnv(
        gatewayEnvSchema,
        tabanEnv({ SMITH_LLM_BASE_URL: UZAK_UC, SMITH_LLM_MODEL: 'gemini-3.5-flash' }),
      ),
    ).toThrow(EnvValidationError);
  });

  it('uzak uc secilip model yerel varsayilanda kalirsa acilista durur', () => {
    // Uzak saglayicida `gemma3:1b` diye bir model yok; istek 404 doner ve
    // "Smith aptallasti ama hata yok" diye teshis edilir.
    expect(() =>
      loadEnv(
        gatewayEnvSchema,
        tabanEnv({ SMITH_LLM_BASE_URL: UZAK_UC, SMITH_LLM_API_KEY: SIRLI_ANAHTAR }),
      ),
    ).toThrow(EnvValidationError);
  });

  it('uc, anahtar ve model birlikte verilirse gecer', () => {
    const env = loadEnv(
      gatewayEnvSchema,
      tabanEnv({
        SMITH_LLM_BASE_URL: UZAK_UC,
        SMITH_LLM_API_KEY: SIRLI_ANAHTAR,
        SMITH_LLM_MODEL: 'gemini-3.5-flash',
      }),
    );

    expect(env.SMITH_LLM_BASE_URL).toBe(UZAK_UC);
    expect(env.SMITH_LLM_MODEL).toBe('gemini-3.5-flash');
  });

  it('YEREL bir uc anahtar istemez — ikinci bir Ollama mesru kurulumdur', () => {
    const env = loadEnv(
      gatewayEnvSchema,
      tabanEnv({ SMITH_LLM_BASE_URL: 'http://127.0.0.1:11435/v1' }),
    );

    expect(env.SMITH_LLM_BASE_URL).toBe('http://127.0.0.1:11435/v1');
    expect(env.SMITH_LLM_MODEL).toBe(LOCAL_DEFAULT_MODEL);
  });

  it('localhost adiyla verilen uc de yerel sayilir', () => {
    expect(() =>
      loadEnv(gatewayEnvSchema, tabanEnv({ SMITH_LLM_BASE_URL: 'http://localhost:11434/v1' })),
    ).not.toThrow();
  });

  it('ayni kural WORKER icin de gecerlidir — kural gateway"e ozel degil', () => {
    // Worker'in kendi LLM yapilandirmasi vardi ve uc Ollama'ya sabitliydi;
    // model adi bulut modeliyken istek yerel uca gidiyordu. Kural her iki
    // surece de uygulanmazsa ayni ariza worker tarafinda geri doner.
    const workerTaban = {
      DATABASE_URL: 'postgresql://smith:smith@127.0.0.1:5433/smith',
      REDIS_URL: 'redis://127.0.0.1:6380',
    };

    expect(() => loadEnv(workerEnvSchema, { ...workerTaban, SMITH_LLM_BASE_URL: UZAK_UC })).toThrow(
      EnvValidationError,
    );

    const env = loadEnv(workerEnvSchema, {
      ...workerTaban,
      SMITH_LLM_BASE_URL: UZAK_UC,
      SMITH_LLM_API_KEY: SIRLI_ANAHTAR,
      SMITH_LLM_MODEL: 'gemini-3.5-flash',
    });
    expect(env.SMITH_LLM_MODEL).toBe('gemini-3.5-flash');
  });
});

describe('gomme (embedding) ucunun capraz kurallari', () => {
  const UZAK_GOMME = 'https://generativelanguage.googleapis.com/v1beta/openai';
  const workerTaban = {
    DATABASE_URL: 'postgresql://smith:smith@127.0.0.1:5433/smith',
    REDIS_URL: 'redis://127.0.0.1:6380',
  };

  function rapor(yukle: () => unknown): string {
    try {
      yukle();
    } catch (error) {
      const hata = error as EnvValidationError;
      return [hata.message, ...hata.issues].join('\n');
    }
    return '';
  }

  it('uzak gomme ucu secilip anahtar verilmezse acilista durur (gateway ve worker)', () => {
    // LLM ucundaki ayni ariza: anahtarsiz istek calisma aninda yetkisiz doner ve
    // tum hafiza isleri 3 denemeden sonra sessizce kaybolur.
    const env = { SMITH_EMBED_BASE_URL: UZAK_GOMME, SMITH_EMBED_MODEL: 'gemini-embedding-001' };

    expect(rapor(() => loadEnv(gatewayEnvSchema, tabanEnv(env)))).toContain('SMITH_EMBED_API_KEY');
    expect(rapor(() => loadEnv(workerEnvSchema, { ...workerTaban, ...env }))).toContain(
      'SMITH_EMBED_API_KEY',
    );
  });

  it('uc, anahtar ve model birlikte verilirse gecer', () => {
    const env = loadEnv(
      workerEnvSchema,
      tabanEnv({
        SMITH_EMBED_BASE_URL: UZAK_GOMME,
        SMITH_EMBED_API_KEY: SIRLI_ANAHTAR,
        SMITH_EMBED_MODEL: 'gemini-embedding-001',
        SMITH_EMBED_DIMENSIONS: '768',
      }),
    );

    expect(env.SMITH_EMBED_BASE_URL).toBe(UZAK_GOMME);
    expect(env.SMITH_EMBED_MODEL).toBe('gemini-embedding-001');
  });

  it('gomme ucu bos birakilip model yerel varsayilandan farkliysa acilista durur', () => {
    // compose.prod.yml bugun ucu bos, modeli `gemini-embedding-001` varsayilanlar:
    // istek yerel Ollama'ya o adla gider ve her gomme cagrisi calisma aninda duser.
    const mesaj = rapor(() =>
      loadEnv(workerEnvSchema, tabanEnv({ SMITH_EMBED_MODEL: 'gemini-embedding-001' })),
    );

    expect(mesaj).toContain('SMITH_EMBED_MODEL');
    expect(mesaj).toContain(LOCAL_DEFAULT_EMBED_MODEL);
    expect(
      rapor(() =>
        loadEnv(gatewayEnvSchema, tabanEnv({ SMITH_EMBED_MODEL: 'gemini-embedding-001' })),
      ),
    ).toContain('SMITH_EMBED_MODEL');
  });

  it('hicbir gomme ayari verilmezse yerel varsayilan gecer', () => {
    const env = loadEnv(workerEnvSchema, tabanEnv({ SMITH_EMBED_MODEL: '' }));

    expect(env.SMITH_EMBED_BASE_URL).toBeUndefined();
    expect(env.SMITH_EMBED_MODEL).toBe(LOCAL_DEFAULT_EMBED_MODEL);
  });

  it('YEREL gomme ucu anahtar istemez ve yerel varsayilandan farkli model kabul eder', () => {
    const env = loadEnv(
      workerEnvSchema,
      tabanEnv({
        SMITH_EMBED_BASE_URL: 'http://127.0.0.1:11434/v1',
        SMITH_EMBED_MODEL: 'bge-base',
      }),
    );

    expect(env.SMITH_EMBED_MODEL).toBe('bge-base');
  });
});

describe('hata raporu', () => {
  it('bozuk uc URL"sini yakalar', () => {
    expect(() =>
      loadEnv(gatewayEnvSchema, tabanEnv({ SMITH_LLM_BASE_URL: 'bu-bir-url-degil' })),
    ).toThrow(EnvValidationError);
  });

  it('sir degerini hata ciktisinda ham gostermez', () => {
    // Anahtar gecerli ama BASKA bir alan bozuk: rapor uretilir ve icinde
    // anahtarin kendisi gecmemelidir.
    let hata: EnvValidationError | undefined;
    try {
      loadEnv(
        gatewayEnvSchema,
        tabanEnv({
          SESSION_SECRET: 'kisa',
          SMITH_LLM_API_KEY: SIRLI_ANAHTAR,
          SMITH_LLM_BASE_URL: 'https://uzak.example.com/v1',
          SMITH_LLM_MODEL: 'bir-model',
        }),
      );
    } catch (error) {
      hata = error as EnvValidationError;
    }

    expect(hata).toBeInstanceOf(EnvValidationError);
    const rapor = [hata?.message, ...(hata?.issues ?? [])].join('\n');
    expect(rapor).not.toContain(SIRLI_ANAHTAR);
    expect(rapor).toContain('SESSION_SECRET');
  });

  it('birden fazla sorunu tek raporda toplar', () => {
    let hata: EnvValidationError | undefined;
    try {
      loadEnv(gatewayEnvSchema, { SESSION_SECRET: 'kisa' });
    } catch (error) {
      hata = error as EnvValidationError;
    }

    // DATABASE_URL, REDIS_URL ve SESSION_SECRET birlikte raporlanir; ilk
    // hatada durup kullaniciyi tek tek dolastirmak pahalidir.
    expect(hata?.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('embedding boyutu', () => {
  it('DB vector(768) ile uyusmayan boyutu acilista reddeder', () => {
    expect(() => loadEnv(workerEnvSchema, tabanEnv({ SMITH_EMBED_DIMENSIONS: '1024' }))).toThrow(
      EnvValidationError,
    );
  });

  it('768 degerini number olarak kabul eder', () => {
    const env = loadEnv(workerEnvSchema, tabanEnv({ SMITH_EMBED_DIMENSIONS: '768' }));
    expect(env.SMITH_EMBED_DIMENSIONS).toBe(768);
  });

  it('bos birakilan deger (.env.example kopyasi) verilmemis sayilir', () => {
    const env = loadEnv(workerEnvSchema, tabanEnv({ SMITH_EMBED_DIMENSIONS: '' }));
    expect(env.SMITH_EMBED_DIMENSIONS).toBeUndefined();
  });

  it.each(['abc', '0', '-768', '768.5'])('%s gecerli bir boyut degildir', (deger) => {
    expect(() => loadEnv(workerEnvSchema, tabanEnv({ SMITH_EMBED_DIMENSIONS: deger }))).toThrow(
      EnvValidationError,
    );
  });
});
