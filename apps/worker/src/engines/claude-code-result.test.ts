import { describe, expect, it } from 'vitest';

import { parseClaudeCodeResult } from './claude-code-result.js';

const SUCCESS = JSON.stringify({
  result: 'Testler gecti.',
  subtype: 'success',
  is_error: false,
  session_id: 'session-1',
  total_cost_usd: 0.001,
  usage: { input_tokens: 10, output_tokens: 20 },
});
const BASE = {
  stdout: SUCCESS,
  stderr: '',
  exitCode: 0,
  timedOut: false,
  timeoutSeconds: 60,
  logPath: 'engine.log',
};

describe('parseClaudeCodeResult', () => {
  it('yalniz basarili surecin dolu raporunu kabul eder ve olculen metadata tasir', () => {
    expect(parseClaudeCodeResult(BASE)).toEqual({
      ok: true,
      text: 'Testler gecti.',
      sessionId: 'session-1',
      costMicros: 1000,
      inputTokens: 10,
      outputTokens: 20,
      exitCode: 0,
      timedOut: false,
      logPath: 'engine.log',
    });
  });

  it.each([1, 124, 137, null])('basarili JSON olsa da exit %s sonucunu reddeder', (exitCode) => {
    expect(parseClaudeCodeResult({ ...BASE, exitCode }).ok).toBe(false);
  });

  it('dis zaman asimi exit 0 ve basarili JSON tarafindan ortulemez', () => {
    expect(parseClaudeCodeResult({ ...BASE, timedOut: true })).toMatchObject({
      ok: false,
      timedOut: true,
      text: 'Kosu 60 saniyede tamamlanmadi ve durduruldu.',
    });
  });

  it('timeout komutunun exit 124 sonucunu zaman asimi olarak tasir', () => {
    expect(parseClaudeCodeResult({ ...BASE, exitCode: 124 }).timedOut).toBe(true);
  });

  it.each([
    '',
    '   ',
    'null',
    '[]',
    '{}',
    '{"result":',
    '{"result":"yarim rapor"',
    '{"result":""}',
    '{"result":"  \\n "}',
    '{"result":23}',
    '{"result":{}}',
    '{"result":"rapor","is_error":"false"}',
    '{"result":"rapor","subtype":"error_max_turns"}',
    'uyari\n{"result":"yarim"',
  ])('bos veya bozuk ciktiyi reddeder: %s', (stdout) => {
    expect(parseClaudeCodeResult({ ...BASE, stdout }).ok).toBe(false);
  });

  it('motor hatasinin asil mesajini korur, subtype success olsa bile reddeder', () => {
    expect(
      parseClaudeCodeResult({
        ...BASE,
        stdout: JSON.stringify({ is_error: true, subtype: 'success', result: 'Not logged in' }),
      }),
    ).toMatchObject({ ok: false, text: 'Not logged in' });
  });

  it('exit != 0 ve stdout bos ise stderr in ilk 800 karakteri mesaja girer (neden yuzeye cikar)', () => {
    const result = parseClaudeCodeResult({
      ...BASE,
      stdout: '',
      stderr: `bash: line 1: claude: command not found\n${'x'.repeat(2_000)}`,
      exitCode: 127,
    });

    expect(result.ok).toBe(false);
    expect(result.text).toMatch(
      /^Motor basarisiz \(exit 127\)\. bash: line 1: claude: command not found/,
    );
    // Mesaj sinirli: prefix + en fazla 800 karakterlik stderr parcasi.
    expect(result.text.length).toBeLessThanOrEqual('Motor basarisiz (exit 127). '.length + 800);
  });

  it('exit != 0 ve motor mesaji varsa mesaj korunur, stderr onun yerine gecmez', () => {
    const result = parseClaudeCodeResult({
      ...BASE,
      stdout: JSON.stringify({ is_error: true, result: 'Not logged in' }),
      stderr: 'gurultu',
      exitCode: 1,
    });

    expect(result.text).toBe('Motor basarisiz (exit 1). Not logged in');
  });

  it('exit != 0 ama stderr de bossa eski kisa mesaji verir; sinyalle olen surec ayri soylenir', () => {
    expect(parseClaudeCodeResult({ ...BASE, stdout: '', exitCode: 2 }).text).toBe(
      'Motor basarisiz (exit 2).',
    );
    expect(
      parseClaudeCodeResult({ ...BASE, stdout: '', stderr: 'oldu', exitCode: null }).text,
    ).toBe('Motor basarisiz (surec sinyalle durdu). oldu');
  });

  it('uyari ardindaki son tam JSON satirini kabul eder', () => {
    expect(parseClaudeCodeResult({ ...BASE, stdout: `uyari\n${SUCCESS}\n` }).ok).toBe(true);
  });

  it('rapor sonrasinda kesilmis veri varsa onceki basariyi kullanmaz', () => {
    expect(parseClaudeCodeResult({ ...BASE, stdout: `${SUCCESS}\n{"result":` }).ok).toBe(false);
  });

  it('hatali opsiyonel metadata degerlerini rapora tasimaz', () => {
    expect(
      parseClaudeCodeResult({
        ...BASE,
        stdout: JSON.stringify({
          result: 'tamam',
          session_id: 123,
          total_cost_usd: -1,
          usage: { input_tokens: '10', output_tokens: -2 },
        }),
      }),
    ).toEqual({ ok: true, text: 'tamam', exitCode: 0, timedOut: false, logPath: 'engine.log' });
  });
});
