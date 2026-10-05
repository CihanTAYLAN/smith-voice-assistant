import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { REDACTION, SECRET_TOKEN_PATTERNS, redactSecrets } from './redact.js';

/** Kaynakta secret gorunumlu literal birakmamak icin (pre-commit tarayicisi) parca parca kurulur. */
const fake = (prefix: string, length: number): string => `${prefix}${'A'.repeat(length)}`;

const TOKEN_SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['Anthropic', fake('sk-ant-', 24)],
  ['OpenAI', fake('sk-', 40)],
  ['OpenAI proje', fake('sk-proj-', 30)],
  ['GitHub PAT', fake('ghp_', 36)],
  ['GitHub OAuth', fake('gho_', 36)],
  ['GitHub kullanici', fake('ghu_', 36)],
  ['GitHub sunucu', fake('ghs_', 36)],
  ['GitHub yenileme', fake('ghr_', 36)],
  ['GitHub ince PAT', fake('github_pat_', 70)],
  ['AWS', fake('AKIA', 16)],
  ['Slack', fake('xoxb-', 20)],
  ['Google', fake('AIza', 35)],
  ['Stripe canli', fake('sk_live_', 24)],
  ['Stripe kisitli canli', fake('rk_live_', 24)],
  ['npm', fake('npm_', 36)],
  ['Hugging Face', fake('hf_', 34)],
];

describe('redactSecrets', () => {
  it.each(TOKEN_SAMPLES)('%s anahtarini yerelde maskeler', (_name, secret) => {
    const result = redactSecrets(`anahtarim ${secret}, bunu hatirla`);
    expect(result.text).toBe(`anahtarim ${REDACTION}, bunu hatirla`);
    expect(result.found).toBe(true);
    expect(result.secretOnly).toBe(false);
  });

  it('ozel anahtar blokunu govdesiyle maskeler; kesik yapistirmada metnin sonuna kadar', () => {
    const header = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
    const footer = ['-----END', 'RSA PRIVATE KEY-----'].join(' ');
    const body = 'TWFuIGlzIGRpc3Rpbmd1aXNoZWQ';

    expect(redactSecrets(`once ${header}\n${body}\n${footer} sonra`).text).toBe(
      `once ${REDACTION} sonra`,
    );
    const truncated = redactSecrets(`once ${header}\n${body}`);
    expect(truncated.text).toBe(`once ${REDACTION}`);
    expect(truncated.text).not.toContain(body);
  });

  it('Bearer basligini buyuk/kucuk harf fark etmeden maskeler', () => {
    expect(redactSecrets(`authorization: bearer ${'x'.repeat(32)}`).text).toBe(
      `authorization: ${REDACTION}`,
    );
  });

  it('etiketli parola degerini maskeler; sonraki satirlar kalir', () => {
    expect(redactSecrets('password: avci2\nve tema koyu').text).toBe(
      `password: ${REDACTION}\nve tema koyu`,
    );
  });

  it.each(['şifre: avci2', 'Şifre: avci2', 'ŞİFRE: avci2', 'sifre=avci2', 'parolam: avci2'])(
    'Turkce etiket %s maskelenir',
    (message) => {
      const result = redactSecrets(`${message}\ntamam mi`);
      expect(result.text).not.toContain('avci2');
      expect(result.text).toContain(REDACTION);
      expect(result.text.endsWith('\ntamam mi')).toBe(true);
    },
  );

  it('tirnakli cok sozcuklu degerin tamamini maskeler', () => {
    const result = redactSecrets('password: "mavi ata binmis" bitti');
    expect(result.text).toBe(`password: ${REDACTION} bitti`);
  });

  it('etiketi uzun bir sozcugun parcasi saymaz', () => {
    const message = 'bypass: gecildi, passport: AB123, token limit: 500';
    const result = redactSecrets(message);
    expect(result.text).toBe(message);
    expect(result.found).toBe(false);
  });

  it('tamami sir olan metni indekslenemez olarak isaretler', () => {
    expect(redactSecrets(`Bearer ${'x'.repeat(32)}`).secretOnly).toBe(true);
    expect(redactSecrets('parola=avci2').secretOnly).toBe(true);
    expect(redactSecrets('şifre: avci2, token=abc123def456').secretOnly).toBe(true);
  });

  it('secret bulunmayan metne dokunmaz', () => {
    const result = redactSecrets('tema koyu olsun, yarin toplanti var');
    expect(result).toEqual({
      text: 'tema koyu olsun, yarin toplanti var',
      found: false,
      secretOnly: false,
    });
  });
});

describe('parola sinifi etiketler: deger ne olursa olsun sirdir', () => {
  it.each([
    ['password: mavi', 'password: [GIZLI]'],
    ['sifre: mavi', 'sifre: [GIZLI]'],
    ['şifre: x', 'şifre: [GIZLI]'],
    ['parola=a', 'parola=[GIZLI]'],
    ['parolam: ab', 'parolam: [GIZLI]'],
    ['pwd: ab', 'pwd: [GIZLI]'],
  ])('%s maskelenir (deger kisa ya da siradan olsa da)', (message, masked) => {
    const result = redactSecrets(message);
    expect(result.text).toBe(masked);
    expect(result.found).toBe(true);
    expect(result.secretOnly).toBe(true);
  });
});

describe('belirsiz etiketler (anahtar, token, secret, api key): yalniz kimlik bilgisi seklindeki deger sirdir', () => {
  // Turkcede `anahtar` fiziksel anahtardir: bunlari secret saymak Smith'in
  // onlari Live'da hatirlamasini engellerdi.
  it.each([
    'ev anahtari: mavi cekmece',
    'anahtar: mavi',
    'anahtarim = kirmizi kutu',
    'token: mavi',
    'secret: kirmizi kutu',
    'api key: mavi cekmece',
    'anahtar: "mavi cekmece"',
    'anahtar: "abc123def456 kutuda"',
  ])('sir sayilmaz: %s', (message) => {
    expect(redactSecrets(message)).toEqual({ text: message, found: false, secretOnly: false });
  });

  it.each([
    ['api anahtarim: abc123def456', 'api anahtarim: [GIZLI]'],
    ['token: 9f8e7d6c5b4a3f2e1d0c', 'token: [GIZLI]'],
    ['api_key: "abc123def456"', 'api_key: [GIZLI]'],
    ['secret=ABCDEFGHIJKLMNOP', 'secret=[GIZLI]'],
    ['ev anahtari: abc123def456 cekmecede', 'ev anahtari: [GIZLI] cekmecede'],
  ])('sir sayilir: %s', (message, masked) => {
    const result = redactSecrets(message);
    expect(result.text).toBe(masked);
    expect(result.found).toBe(true);
  });

  it.each([
    ['abc12345', true, '8 karakter, harf + rakam'],
    ['abc1234', false, '7 karakter'],
    ['12345678', false, '8 karakter ama harf yok'],
    ['abcdefgh', false, '8 karakter ama rakam yok'],
    ['ABCDEFGHIJKLMNOP', true, '16 karakter, tek parca'],
    ['ABCDEFGHIJKLMNO', false, '15 karakter, rakam yok'],
    ['1234567890123456', true, '16 rakam, tek parca'],
  ])('sinir degeri %s -> sir mi: %s (%s)', (value, secret) => {
    const result = redactSecrets(`anahtar: ${value}`);
    expect(result.found).toBe(secret);
    expect(result.text).toBe(secret ? `anahtar: ${REDACTION}` : `anahtar: ${value}`);
  });

  it('belirsiz etiketle gelen saglayici anahtari yine desenle maskelenir', () => {
    expect(redactSecrets(`token: ${fake('sk-', 40)}`).text).toBe(`token: ${REDACTION}`);
  });

  it('parola sinifi ile birlikte gelen masum belirsiz etiket (sonraki satirda) metinde KALIR', () => {
    const result = redactSecrets('parola: avci2\nev anahtari: mavi cekmece');
    expect(result.text).toBe('parola: [GIZLI]\nev anahtari: mavi cekmece');
    expect(result.found).toBe(true);
    expect(result.secretOnly).toBe(false);
  });

  it('kimlik bilgisi seklinde olmayan belirsiz deger anlamli icerik sayilir (secretOnly degil)', () => {
    expect(redactSecrets('şifre: avci2\ntoken=abc123').secretOnly).toBe(false);
  });

  // Tanimlayici adli ama kimlik bilgisi OLMAYAN degerler: ayni ek (_KEY, _TOKEN)
  // masum kullanimlarda da gecer, kapi degerin seklidir.
  it.each([
    'PRIMARY_KEY=id',
    'SORT_KEY: name',
    'max_token: 4096',
    'token_limit: 500',
    'cache_key: user_id',
    'ev_anahtari: mavi cekmece',
  ])('masum tanimlayici sir sayilmaz: %s', (message) => {
    expect(redactSecrets(message)).toEqual({ text: message, found: false, secretOnly: false });
  });

  it.each(['bypass: gecildi', 'compass: kuzey', 'monkey: muz', 'turkey: hindi', 'secretary: Ayse'])(
    'etiketle biten ama etiket olmayan sozcuk sir sayilmaz: %s',
    (message) => {
      expect(redactSecrets(message)).toEqual({ text: message, found: false, secretOnly: false });
    },
  );
});

/** Kimlik bilgisi seklinde (18 karakter, harf + rakam) sahte deger. */
const VALUE = 'q7Zk29LmPx83VbNc41';

describe('tanimlayici adli atamalar (.env, YAML)', () => {
  it.each([
    [`GEMINI_API_KEY=${VALUE}`, 'GEMINI_API_KEY=[GIZLI]'],
    [`SMITH_LLM_API_KEY=${VALUE}`, 'SMITH_LLM_API_KEY=[GIZLI]'],
    [`SESSION_SECRET=${VALUE}`, 'SESSION_SECRET=[GIZLI]'],
    [`LANGFUSE_SECRET_KEY=${VALUE}`, 'LANGFUSE_SECRET_KEY=[GIZLI]'],
    [`aws_secret_access_key = ${VALUE}`, 'aws_secret_access_key = [GIZLI]'],
    [`X_AUTH_TOKEN=${VALUE}`, 'X_AUTH_TOKEN=[GIZLI]'],
    [`ENCRYPTION_KEY=${VALUE}`, 'ENCRYPTION_KEY=[GIZLI]'],
    [`x-api-key: ${VALUE}`, 'x-api-key: [GIZLI]'],
    [`DB_PASSWORD=${VALUE}`, 'DB_PASSWORD=[GIZLI]'],
    [`POSTGRES_PASSWORD: ${VALUE}`, 'POSTGRES_PASSWORD: [GIZLI]'],
    [`PGPASSWORD=${VALUE}`, 'PGPASSWORD=[GIZLI]'],
    [`DB_PASSWD=${VALUE}`, 'DB_PASSWD=[GIZLI]'],
    [`my_password = ${VALUE}`, 'my_password = [GIZLI]'],
    [`export DB_PASSWORD="${VALUE}"`, 'export DB_PASSWORD=[GIZLI]'],
  ])('%s maskelenir, ad kalir', (message, masked) => {
    const result = redactSecrets(message);
    expect(result.text).toBe(masked);
    expect(result.found).toBe(true);
  });

  it('parola sinifi adlarda kisa deger de sirdir (DB_PASSWORD=x)', () => {
    expect(redactSecrets('DB_PASSWORD=x').text).toBe('DB_PASSWORD=[GIZLI]');
  });

  it('belirsiz sinif adlarda yalniz kimlik bilgisi seklindeki deger sirdir', () => {
    expect(redactSecrets('SESSION_SECRET=dev').found).toBe(false);
    expect(redactSecrets('GITHUB_TOKEN=abc123def456').found).toBe(true);
  });

  it('bosluklu etiket (api key) de maskeli atama sayilir: secretOnly korunur', () => {
    expect(redactSecrets(`API KEY: ${VALUE}`)).toEqual({
      text: 'API KEY: [GIZLI]',
      found: true,
      secretOnly: true,
    });
  });

  it('yalniz maskeli atamalardan olusan .env dokumu indekslenemez, baska icerik varsa indekslenir', () => {
    expect(redactSecrets(`DB_PASSWORD=hunter2\nGEMINI_API_KEY=${VALUE}`).secretOnly).toBe(true);
    expect(redactSecrets('PORT=4100\nDB_PASSWORD=hunter2').secretOnly).toBe(false);
  });
});

describe('tirnakli anahtarlar ve camelCase adlar (JSON, YAML)', () => {
  it.each([
    [`"password": "${VALUE}"`, '"password": [GIZLI]'],
    [`{"apiKey":"${VALUE}"}`, '{"apiKey":[GIZLI]}'],
    [`{'token': '${VALUE}'}`, "{'token': [GIZLI]}"],
    [`{"db_password": "x", "host": "db"}`, '{"db_password": [GIZLI], "host": "db"}'],
    [`clientSecret: ${VALUE}`, 'clientSecret: [GIZLI]'],
    [`accessToken=${VALUE}`, 'accessToken=[GIZLI]'],
    [`secretAccessKey: ${VALUE}`, 'secretAccessKey: [GIZLI]'],
    [`dbPassword: ${VALUE}`, 'dbPassword: [GIZLI]'],
  ])('%s maskelenir', (message, masked) => {
    const result = redactSecrets(message);
    expect(result.text).toBe(masked);
    expect(result.found).toBe(true);
  });

  it('yalniz maskeli JSON atamasi indekslenemez', () => {
    expect(redactSecrets(`{"apiKey":"${VALUE}"}`).secretOnly).toBe(true);
  });

  // JSON dizgesi `\"` icerebilir: kacisi tanimayan desen degeri ilk ic tirnakta
  // keser ve kuyrugu acikta birakirdi.
  it.each([
    [
      String.raw`{"password": "pa\"ss-tail9", "role": "admin"}`,
      '{"password": [GIZLI], "role": "admin"}',
    ],
    [
      String.raw`{"apiKey": "abc\"def123456789xyz", "role": "x"}`,
      '{"apiKey": [GIZLI], "role": "x"}',
    ],
    [String.raw`password: 'it\'s secret tail', sonra`, 'password: [GIZLI], sonra'],
  ])('kacisli tirnak degerin kuyrugunu acikta birakmaz: %s', (message, masked) => {
    expect(redactSecrets(message).text).toBe(masked);
  });
});

describe('parola sinifi tirnaksiz deger satir sonuna kadar maskelenir', () => {
  it('cok sozcuklu parola (kalan sozcuk sizmaz)', () => {
    const result = redactSecrets('sifre: mavi kus ucuyor 1923');
    expect(result.text).toBe('sifre: [GIZLI]');
    expect(result.secretOnly).toBe(true);
  });

  it('sonraki satir ve satir sonu bosluklari korunur', () => {
    expect(redactSecrets('sifre: mavi kus ucuyor 1923\nyarin toplanti var').text).toBe(
      'sifre: [GIZLI]\nyarin toplanti var',
    );
    expect(redactSecrets('password: a b  \r\nsonraki').text).toBe('password: [GIZLI]  \r\nsonraki');
  });

  it('.env tarzi bosluklu deger de satirin sonuna kadar gider', () => {
    expect(redactSecrets('DB_PASSWORD=abc def ghi').text).toBe('DB_PASSWORD=[GIZLI]');
  });

  it('deger bir sonraki satirda gelirse yine maskelenir', () => {
    expect(redactSecrets('password:\nhunter two').text).toBe('password:\n[GIZLI]');
  });

  it('etiketten sonra deger yoksa metne dokunmaz', () => {
    expect(redactSecrets('password:')).toEqual({
      text: 'password:',
      found: false,
      secretOnly: false,
    });
  });
});

describe('URL parolasi, JWT ve Basic yetkilendirme', () => {
  it.each([
    [
      'DATABASE_URL=postgresql://smith:Xy12abCDef@10.0.0.5:5432/smith',
      'DATABASE_URL=postgresql://smith:[GIZLI]@10.0.0.5:5432/smith',
    ],
    ['redis://:S3cretPassw0rd@127.0.0.1:6380', 'redis://:[GIZLI]@127.0.0.1:6380'],
    [
      'mongodb+srv://u:p%40ss@cluster0.example.net/db',
      'mongodb+srv://u:[GIZLI]@cluster0.example.net/db',
    ],
    ['https://oauth2:abc@gitlab.com/x.git', 'https://oauth2:[GIZLI]@gitlab.com/x.git'],
  ])('URL userinfo parolasi maskelenir: %s', (message, masked) => {
    const result = redactSecrets(message);
    expect(result.text).toBe(masked);
    expect(result.found).toBe(true);
  });

  it.each([
    'http://localhost:3000/api',
    'https://user@example.com/x',
    'postgresql://smith@127.0.0.1/db',
    'bkz https://example.com:8080 ve me@example.org',
  ])('parolasi olmayan URL ve adres degismez: %s', (message) => {
    expect(redactSecrets(message)).toEqual({ text: message, found: false, secretOnly: false });
  });

  // Kaynakta JWT gorunumlu literal birakmamak icin parca parca kurulur.
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c3JfMSJ9', 'abcDEF123_-xyz'].join('.');

  it('JWT maskelenir (basliksiz, etiketsiz da)', () => {
    expect(redactSecrets(`oturum ${jwt} bitti`).text).toBe(`oturum ${REDACTION} bitti`);
    expect(redactSecrets(`access_token=${jwt}`).text).toBe(`access_token=${REDACTION}`);
  });

  it('imzasi bos (alg none) JWT de maskelenir', () => {
    const unsigned = `${jwt.split('.').slice(0, 2).join('.')}.`;
    expect(redactSecrets(`jeton ${unsigned}`).text).toBe(`jeton ${REDACTION}`);
  });

  it('Authorization: Basic degerini maskeler, duz "Basic" sozcugune dokunmaz', () => {
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==').text).toBe(
      `Authorization: ${REDACTION}`,
    );
    expect(redactSecrets('curl -H "authorization: basic dXNlcjpwYXNzd29yZA=="').text).toBe(
      `curl -H "authorization: ${REDACTION}"`,
    );
    const prose = 'Basic infrastructure is ready, Authorization: Basic abc';
    expect(redactSecrets(prose)).toEqual({ text: prose, found: false, secretOnly: false });
  });
});

describe('saglayici anahtari sinirlari', () => {
  it('tanimlanan uzunlugun otesindeki govdeyi de maskeler (kuyruk sizmaz)', () => {
    expect(redactSecrets(`x ${fake('ghp_', 40)} y`).text).toBe(`x ${REDACTION} y`);
    expect(redactSecrets(`x ${fake('npm_', 50)} y`).text).toBe(`x ${REDACTION} y`);
  });

  it('kisa govdeli benzer sozcuk anahtar sayilmaz', () => {
    const message = 'ghx_kisa, npm_install, hf_hub, sk_live_ab';
    expect(redactSecrets(message)).toEqual({ text: message, found: false, secretOnly: false });
  });
});

describe('buyuk zararli girdilerde dogrusal sure (ReDoS yok)', () => {
  const SIZE = 200_000;
  const adversarial: ReadonlyArray<readonly [string, string]> = [
    ['harf kosusu', 'a'.repeat(SIZE)],
    ['bosluk kosusu', `token${' '.repeat(SIZE)}`],
    ['password + bosluk', `password:${' '.repeat(SIZE)}`],
    ['tekrarlayan etiket', 'password: '.repeat(SIZE / 10)],
    ['kapanmayan tirnak', `password: "${'x'.repeat(SIZE)}`],
    ['tek tirnak tekrari', "api key: '".repeat(SIZE / 10)],
    ['tanimlayici kosusu + maske', `AKIA${'A'.repeat(16)} ${'a'.repeat(SIZE)}`],
    ['maske + bosluk', `${fake('AIza', 35)} ${' '.repeat(SIZE)}`],
    ['eyJ tekrari', 'eyJ'.repeat(SIZE / 3)],
    ['sema tekrari', 'http://'.repeat(SIZE / 7)],
    ['url + uzun kullanici', `http://${'u'.repeat(SIZE)}`],
    ['authorization + bosluk', `authorization${' '.repeat(SIZE)}`],
  ];

  it.each(adversarial)('%s', (_name, input) => {
    const startedAt = performance.now();
    redactSecrets(input);
    expect(performance.now() - startedAt).toBeLessThan(1500);
  });
});

describe('scripts/scan-secrets.sh ile desen esitligi', () => {
  const script = readFileSync(new URL('../../../scripts/scan-secrets.sh', import.meta.url), 'utf8');
  const scannerPatterns = [...script.matchAll(/^ {2}'([^']+)'$/gm)].map((match) => match[1] ?? '');

  it('tarayicidaki her desen maskeleyicide de var (tarayici one gecemez)', () => {
    expect(scannerPatterns.length).toBeGreaterThanOrEqual(7);
    for (const pattern of scannerPatterns) {
      const covered = SECRET_TOKEN_PATTERNS.some((source) => source.startsWith(pattern));
      expect(covered, `scan-secrets.sh deseni redact.ts'te yok: ${pattern}`).toBe(true);
    }
  });

  // Maskeleyiciye eklenen her saglayici deseni commit kapisinda da durmali;
  // aksi halde repoya girebilir. Belgeli tek istisna: sk-proj- (tarayicida yok,
  // eski bir acik is).
  it('maskeleyicideki her saglayici deseni tarayicida da var (istisna: sk-proj-)', () => {
    const redactorOnly = ['sk-proj-'];
    for (const source of SECRET_TOKEN_PATTERNS) {
      if (redactorOnly.some((prefix) => source.startsWith(prefix))) continue;
      const covered = scannerPatterns.some((pattern) => source.startsWith(pattern));
      expect(covered, `redact.ts deseni scan-secrets.sh'te yok: ${source}`).toBe(true);
    }
  });
});
