import { describe, expect, it } from 'vitest';

import { contextExcluded, parseContextExclude, turkishCaseFold } from './context-exclude.js';

describe('context exclusion', () => {
  it('bos kurali no-op sayar ve CSV bosluklarini temizler', () => {
    expect(parseContextExclude(' ,  ,')).toEqual({ sourceGlobs: [], keywords: [] });
    expect(parseContextExclude(' obsidian:acme/*, kw:acme ,kw: ')).toEqual({
      sourceGlobs: ['obsidian:acme/*'],
      keywords: ['acme'],
    });
  });

  it('sourceId globunu tam eslesme, yildiz ve soru isaretiyle uygular', () => {
    const rules = parseContextExclude('obsidian:acme/*,code:_workshop-smoke/??');

    expect(
      contextExcluded({ sourceId: 'obsidian:ACME/plan/not.md', content: 'ilgili degil' }, rules),
    ).toBe(true);
    expect(contextExcluded({ sourceId: 'code:_workshop-smoke/ab', content: '' }, rules)).toBe(true);
    expect(contextExcluded({ sourceId: 'code:_workshop-smoke/abc', content: '' }, rules)).toBe(
      false,
    );
    expect(contextExcluded({ sourceId: 'xobsidian:acme/a', content: '' }, rules)).toBe(false);
  });

  it('keywordu literal alt dize ve Turkce i varyantlariyla eslestirir', () => {
    const rules = parseContextExclude('kw:ISTANBUL,kw:a.b');

    expect(contextExcluded({ sourceId: 'note:1', content: 'istanbul bilgisi' }, rules)).toBe(true);
    expect(contextExcluded({ sourceId: 'note:2', content: 'ISTANBUL bilgisi' }, rules)).toBe(true);
    expect(contextExcluded({ sourceId: 'note:3', content: 'a.b ifadesi' }, rules)).toBe(true);
    expect(contextExcluded({ sourceId: 'note:4', content: 'axb ifadesi' }, rules)).toBe(false);
    expect(turkishCaseFold('Iİiı')).toBe('iiii');
  });

  it('sourceId veya icerikten biri eslesince kaydi dislar', () => {
    const rules = parseContextExclude('obsidian:acme/*,kw:acme');

    expect(contextExcluded({ sourceId: 'note:1', content: 'Acme karari' }, rules)).toBe(true);
    expect(contextExcluded({ sourceId: 'obsidian:acme/a.md', content: 'baska metin' }, rules)).toBe(
      true,
    );
    expect(contextExcluded({ sourceId: 'obsidian:globex/a.md', content: 'Smith' }, rules)).toBe(
      false,
    );
  });
});
