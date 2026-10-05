import { describe, expect, it } from 'vitest';

import { parseCodexResult, unwrapMessage } from './codex-result.js';

/**
 * Bu testteki ciktilar GERCEK kosulardan alindi (codex-cli 0.153.4,
 * 2026-09-18, ChatGPT aboneligiyle). Uydurma JSON semasi test etmek, motorun
 * sahada gordugu sekli degil testi yazanin hayalini dogrular.
 */

/** Basarili kosu: "ok" cevabi + token kullanim raporu. */
const SUCCESS = [
  '{"type":"thread.started","thread_id":"01a0b1bf-9b60-7ff1-b6b4-0adb8542eefd"}',
  '{"type":"turn.started"}',
  // stderr'den stdout'a karisan MCP gurultusu — JSON degil, ATLANMALI.
  '2026-09-17T23:42:00.464078Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":23037,"cached_input_tokens":12416,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join('\n');

const BASE = {
  stdout: SUCCESS,
  stderr: '',
  exitCode: 0,
  timedOut: false,
  timeoutSeconds: 600,
  logPath: 'engine.log',
};

describe('parseCodexResult', () => {
  it('basarili kosuyu metin, oturum ve token kullanimiyla tasir', () => {
    expect(parseCodexResult(BASE)).toEqual({
      ok: true,
      text: 'ok',
      sessionId: '01a0b1bf-9b60-7ff1-b6b4-0adb8542eefd',
      inputTokens: 23037,
      outputTokens: 5,
      exitCode: 0,
      timedOut: false,
      logPath: 'engine.log',
    });
  });

  /**
   * OLCULDU: `codex exec` basarisiz turda bile exit 0 donduruyor. Yalniz exit
   * koduna bakan bir motor, yapilmamis isi "basarili" sayardi.
   */
  it('exit 0 olsa bile turn.failed sonucunu basarisiz sayar', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'gpt-5.3-codex-spark\' model is not supported when using Codex with a ChatGPT account.\\"}}"}}',
    ].join('\n');
    expect(parseCodexResult({ ...BASE, stdout })).toMatchObject({
      ok: false,
      text: "Codex hatasi: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
    });
  });

  it('ust seviye error olayini hata sebebi sayar', () => {
    const stdout = '{"type":"error","message":"{\\"error\\":{\\"message\\":\\"kota doldu\\"}}"}\n';
    expect(parseCodexResult({ ...BASE, stdout })).toMatchObject({
      ok: false,
      text: 'Codex hatasi: kota doldu',
    });
  });

  it('dis zaman asimini tur tamamlanmis olsa bile kabul etmez', () => {
    expect(parseCodexResult({ ...BASE, timedOut: true })).toMatchObject({
      ok: false,
      timedOut: true,
      text: 'Kosu 600 saniyede tamamlanmadi ve durduruldu.',
    });
  });

  it('timeout komutunun exit 124 sonucunu zaman asimi olarak tasir', () => {
    expect(parseCodexResult({ ...BASE, exitCode: 124 }).timedOut).toBe(true);
  });

  it.each([1, 2, 137, null])('exit %s sonucunu reddeder', (exitCode) => {
    expect(parseCodexResult({ ...BASE, exitCode }).ok).toBe(false);
  });

  it('hic terminal olay yoksa basarisiz sayar', () => {
    expect(parseCodexResult({ ...BASE, stdout: '{"type":"turn.started"}\n' })).toMatchObject({
      ok: false,
      text: 'Codex sonuc bildirmedi (tur tamamlanmadi veya bos cevap dondu).',
    });
    expect(parseCodexResult({ ...BASE, stdout: '' }).ok).toBe(false);
    expect(parseCodexResult({ ...BASE, stdout: 'uyari\n{"type":"turn.started"}\n' }).ok).toBe(
      false,
    );
  });

  it('bos veya bosluk ajan mesajini cevap saymaz', () => {
    const stdout = [
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"   "}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}',
    ].join('\n');
    expect(parseCodexResult({ ...BASE, stdout }).ok).toBe(false);
  });

  /**
   * OLCULDU: `--ignore-user-config` verilmeden once donen "Model metadata not
   * found" uyarisi bir ITEM'dir, tur hatasi degil. Gercek hata ayri olayda
   * gelir; uyariyi fatal saymak saglikli kosulari bosa harcardi.
   */
  it('item seviyesindeki uyariyi fatal saymaz', () => {
    const stdout = [
      '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `x` not found. Defaulting to fallback metadata."}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"is bitti"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":7}}',
    ].join('\n');
    expect(parseCodexResult({ ...BASE, stdout })).toMatchObject({
      ok: true,
      text: 'is bitti',
      inputTokens: 100,
      outputTokens: 7,
    });
  });

  it('son ajan mesajini nihai cevap sayar', () => {
    const stdout = [
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"arastiriyorum"}}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"nihai cevap"}}',
      '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":5}}',
    ].join('\n');
    expect(parseCodexResult({ ...BASE, stdout }).text).toBe('nihai cevap');
  });

  it('bozuk token degerlerini sonuca tasimaz', () => {
    const stdout = [
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"tamam"}}',
      '{"type":"turn.completed","usage":{"input_tokens":"23037","output_tokens":-5}}',
    ].join('\n');
    expect(parseCodexResult({ ...BASE, stdout })).toEqual({
      ok: true,
      text: 'tamam',
      exitCode: 0,
      timedOut: false,
      logPath: 'engine.log',
    });
  });

  it('bozuk ve kesik satirlari sessizce atlar', () => {
    const stdout = `{"type":"turn.started"}\n{"type":"item.comple`;
    expect(parseCodexResult({ ...BASE, stdout })).toMatchObject({ ok: false });
  });
});

describe('unwrapMessage', () => {
  it('JSON-icinde-JSON hata metnini insan okunur hale getirir', () => {
    expect(
      unwrapMessage(
        '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"model desteklenmiyor"}}',
      ),
    ).toBe('model desteklenmiyor');
  });

  it('duz metni oldugu gibi birakir', () => {
    expect(unwrapMessage('  oturum acilmamis  ')).toBe('oturum acilmamis');
  });

  it('icinde mesaj olmayan JSON`u ham birakir', () => {
    expect(unwrapMessage('{"status":500}')).toBe('{"status":500}');
    expect(unwrapMessage('{"error":{"message":"   "}}')).toBe('{"error":{"message":"   "}}');
  });
});
