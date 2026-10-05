import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

type Answer = () => unknown;

/** Rust'in catisma mesaji bu tireyi tasir; testte gercek metin birebir taklit edilir. */
const EM_DASH = String.fromCharCode(0x2014);

/** Komut cagrilari sirayla cevaplanir; log komutu (`dashboard_log`) her zaman basarilidir. */
function answerWith(...answers: Answer[]): void {
  invoke.mockImplementation((command: string) => {
    if (command === 'dashboard_log') return Promise.resolve();
    const next = answers.shift();
    return next ? Promise.resolve().then(next) : Promise.reject(new Error('cevap kalmadi'));
  });
}

const commandCalls = (): unknown[][] =>
  invoke.mock.calls.filter(([command]) => command !== 'dashboard_log');

const loggedMessages = (): string[] =>
  invoke.mock.calls
    .filter(([command]) => command === 'dashboard_log')
    .map(([, args]) => (args as { message: string }).message);

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const reject =
  (reason: unknown): Answer =>
  () => {
    throw reason;
  };

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('hafiza okumasi (grafik ve hafiza ortak)', () => {
  it('eszamanli okumalari tek istege indirir ve taze kopyayi yeniden kullanir', async () => {
    const { memoryList } = await import('./api.js');
    answerWith(() => ({ records: [] }));

    const first = memoryList();
    expect(memoryList()).toBe(first);
    await first;
    expect((await memoryList()).ok).toBe(true);

    expect(commandCalls()).toHaveLength(1);
  });

  it('yenile (refresh) taze kopyayi atlar', async () => {
    const { memoryList } = await import('./api.js');
    answerWith(
      () => ({ records: [] }),
      () => ({ records: [] }),
    );
    await memoryList();
    await memoryList(true);
    expect(commandCalls()).toHaveLength(2);
  });

  it('basarisiz yenilemeden sonra saglam kopyayi yeniden kullanmaz', async () => {
    const { memoryList } = await import('./api.js');
    answerWith(
      () => ({ records: [] }),
      reject('gateway unavailable'),
      reject('gateway still unavailable'),
    );
    expect((await memoryList()).ok).toBe(true);
    expect((await memoryList(true)).ok).toBe(false);
    expect((await memoryList()).ok).toBe(false);
    expect(commandCalls()).toHaveLength(3);
  });
});

describe('acik hafiza sorulari', () => {
  it('liste, cevap ve gec isteklerini Rust mission_call koprusunden yollar', async () => {
    const { answerMemoryGap, dismissMemoryGap, memoryGaps } = await import('./api.js');
    answerWith(
      () => ({ gaps: [] }),
      () => ({ ok: true, status: 'answered', memoryId: 'mem_1' }),
      () => ({ ok: true, status: 'dismissed' }),
    );

    await memoryGaps();
    await answerMemoryGap('gap_00000000000000000000', 'Istanbul');
    await dismissMemoryGap('gap_11111111111111111111');

    expect(commandCalls()).toEqual([
      ['mission_call', { method: 'GET', path: '/v1/memory/gaps?status=open', body: null }],
      [
        'mission_call',
        {
          method: 'POST',
          path: '/v1/memory/gaps/gap_00000000000000000000/answer',
          body: { answer: 'Istanbul' },
        },
      ],
      [
        'mission_call',
        {
          method: 'POST',
          path: '/v1/memory/gaps/gap_11111111111111111111/dismiss',
          body: {},
        },
      ],
    ]);
  });
});

/** Rust'in `mission_call` hatasi (src-tauri/src/mission.rs `MissionHatasi`) birebir. */
const hostError = (code: string, status: number | null, message = 'gateway sebebi') => ({
  code,
  status,
  message,
});

describe('hata siniflamasi', () => {
  it.each([
    [`dosya diskte degisti ${EM_DASH} once yeniden yukle, sonra kaydet`, 'conflict'],
    ['dosya cok buyuk (600 KB > 512 KB)', 'too-large'],
    ['ikili dosya (metin degil)', 'binary'],
    ['vault koku yok: C:\\Users\\x\\ObsidianVaults', 'no-vault'],
    ['dosya yok: os error 2', 'not-found'],
    ['izin verilmeyen yol (izinli koklerin disinda): C:\\Windows\\a.txt', 'denied'],
    ['`.git` icine yazilamaz', 'denied'],
    ['beklenmeyen bir durum', 'failed'],
    // Gateway metni artik dosya komutlarindan gelmez: metinle siniflanmaz.
    ['/v1/tools/memory/list cagrisi basarisiz: http status: 403', 'failed'],
    ['gateway login hatasi: baglanti reddedildi', 'failed'],
  ])('%s -> %s', async (raw, code) => {
    const { fsRead } = await import('./api.js');
    answerWith(reject(raw));
    const result = await fsRead('x');
    expect(result).toMatchObject({ ok: false, code });
    // Kullaniciya katalog mesaji gider; ham Rust/gateway metni (yol, komut, durum) asla.
    if (!result.ok) {
      expect(result.error).not.toMatch(/C:\\|\/v1\/|http status|os error|Connection/);
      expect(result.error.length).toBeGreaterThan(10);
    }
  });

  /** `mission_call` hatalari YAPISAL gelir: sinif code alanindan okunur, metinden degil. */
  it.each([
    [hostError('not-found', 404), 'not-found'],
    [hostError('conflict', 409), 'conflict'],
    [hostError('unauthorized', 403), 'denied'],
    [hostError('unauthorized', 401), 'denied'],
    [hostError('unavailable', null), 'offline'],
    [hostError('validation', 400), 'failed'],
    [hostError('unknown', 500), 'failed'],
    [hostError('taninmayan-sinif', 409), 'failed'],
    [hostError('toString', 500), 'failed'],
    // Yanilticiliga ragmen sinif metne bakmaz:
    [hostError('unknown', 500, 'conflict 404 baglanti diskte degisti'), 'failed'],
  ])('mission_call hatasi %j -> %s', async (hata, code) => {
    const { runUsage } = await import('./api.js');
    answerWith(reject(hata));
    const result = await runUsage();
    expect(result).toMatchObject({ ok: false, code });
    if (!result.ok) {
      // Katalog cumlesi gider; gateway mesaji (host hatasinin `message` alani) asla.
      expect(result.error).not.toContain(hata.message);
      expect(result.error.length).toBeGreaterThan(10);
    }
  });

  it('mission_call hatasinin maskeli ayrintisi Rust log satirina sinif ve durumla gider', async () => {
    const { runUsage } = await import('./api.js');
    answerWith(reject(hostError('conflict', 409, 'Gecersiz gorev gecisi token=secret-value')));
    await runUsage();
    await settle();
    const [line] = loggedMessages();
    expect(line).toContain('conflict');
    expect(line).toContain('409');
    expect(line).toContain('Gecersiz gorev gecisi');
    expect(line).not.toContain('secret-value');
  });

  it('Tauri koprusu yoksa komut cagirmadan unavailable doner', async () => {
    vi.stubGlobal('window', {});
    const { engines } = await import('./api.js');
    const result = await engines();
    expect(result).toMatchObject({ ok: false, code: 'unavailable' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('catisma anlamini korur ve ozel ayrintiyi gostermez', async () => {
    const { fsWrite } = await import('./api.js');
    answerWith(reject('C:\\private\\a.md diskte degisti token=secret-value'));
    const result = await fsWrite('path', 'text', 1);
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    expect(JSON.stringify(result)).not.toMatch(/private|secret-value/);
  });
});

describe('teknik kayit (reportDashboardError)', () => {
  it('Rust log satiri maskelidir: yol, token, Bearer ve uzun gizli degerler gorunmez', async () => {
    const { reportDashboardError } = await import('./api.js');
    answerWith();
    const raw = `C:\\Users\\cihan\\gizli\\a.md token=secret-value Authorization: Bearer abcdef0123456789 ${'x'.repeat(40)} /home/cihan/.ssh/key`;
    reportDashboardError('fs.read', raw);
    await settle();

    const [line] = loggedMessages();
    expect(line).toContain('fs.read');
    expect(line).not.toMatch(/cihan|secret-value|abcdef0123456789|x{32}/);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/cihan|secret-value/);
  });

  it('Error nesnesinde yigin izi loglanir ama yol maskelenir', async () => {
    const { reportDashboardError } = await import('./api.js');
    answerWith();
    const error = new Error('C:\\Users\\cihan\\a.md okunamadi');
    reportDashboardError('render', error);
    await settle();
    expect(loggedMessages()[0]).toContain('render');
    expect(loggedMessages()[0]).not.toContain('cihan');
  });

  it('log komutunun kendi hatasi tekrar loglanmaz (sonsuz dongu yok)', async () => {
    const { dashboardLog } = await import('./api.js');
    invoke.mockRejectedValue(new Error('komut yok'));
    dashboardLog('merhaba');
    await settle();
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('dizin listesi (fsList)', () => {
  const entry = (name: string) => ({
    name,
    path: `/kok/${name}`,
    kind: 'file',
    size: 1,
    mtimeMs: 1,
  });

  it('sinir asilmadiysa duz dizi gibi doner, kesilme bilgisi tasimaz', async () => {
    const { fsList } = await import('./api.js');
    const entries = [entry('a.md'), entry('b.md')];
    answerWith(() => ({ entries, truncated: false, total: 2, limit: 3000 }));

    const result = await fsList('/kok');

    expect(result).toEqual({ ok: true, value: entries });
    expect(result.ok && result.value.truncation).toBeUndefined();
    expect(commandCalls()).toEqual([['dashboard_fs_list', { path: '/kok' }]]);
  });

  it('kesilmis dizini toplam ve limitle isaretler, girisleri aynen korur', async () => {
    const { fsList } = await import('./api.js');
    const entries = [entry('a.md'), entry('b.md')];
    // Tauri her cagrida taze nesne verir; sahte cevap da kopya doner (bilgi diziye eklenir).
    answerWith(() => ({ entries: [...entries], truncated: true, total: 4210, limit: 3000 }));

    const result = await fsList('/kok');

    expect(result.ok && result.value.truncation).toEqual({ total: 4210, limit: 3000 });
    expect(result.ok && [...result.value]).toEqual(entries);
  });

  it('kesilme bilgisi, listeyi FsEntry[] olarak saklayan tuketiciye de ulasir', async () => {
    // Dosya agaci listeyi `FsEntry[]` olarak saklar ve degistirmez; ayni nesne Files bolumune ulasir.
    const { fsList } = await import('./api.js');
    answerWith(() => ({ entries: [entry('a.md')], truncated: true, total: 9, limit: 1 }));
    const result = await fsList('/kok');
    const saklanan: { name: string }[] | undefined = result.ok ? result.value : undefined;
    expect(saklanan).toHaveLength(1);
    expect(result.ok && 'truncation' in result.value).toBe(true);
  });

  it('hata katalog mesajiyla tasinir', async () => {
    const { fsList } = await import('./api.js');
    answerWith(reject('izin verilmeyen yol (izinli koklerin disinda): /gizli/dizin'));
    const result = await fsList('/gizli/dizin');
    expect(result).toMatchObject({ ok: false, code: 'denied' });
    expect(JSON.stringify(result)).not.toContain('gizli');
  });
});
