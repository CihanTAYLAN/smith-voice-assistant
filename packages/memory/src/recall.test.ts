import { describe, expect, it } from 'vitest';

import { buildRecallBlock } from './recall.js';
import type { MemoryHit } from './repo.js';

function hit(content: string, similarity = 0.9): MemoryHit {
  return { id: 'mem_x', content, sourceType: 'message', sourceId: 's', similarity };
}

describe('recall block', () => {
  it('hic hit yoksa null (baglama gurultu eklenmez)', () => {
    expect(buildRecallBlock([])).toBeNull();
  });

  it('hitleri baglam blogu olarak bicimler', () => {
    const block = buildRecallBlock([hit('Kullanici React tercih ediyor')]);
    expect(block).toContain('React tercih ediyor');
    expect(block).toContain('ilgili notlar');
  });

  it('karakter butcesini asan hitler kesilir', () => {
    const long = 'x'.repeat(1000);
    const block = buildRecallBlock([hit(long), hit(long), hit(long)], { maxChars: 1500 });
    // 1000'lik iceriklerden yalniz biri sigar (baslik + bir satir).
    const count = (block?.match(/^- /gm) ?? []).length;
    expect(count).toBe(1);
  });

  it('ilk hit tek basina buyukse en ilgili kaydi butceye kirpar (baglam bos kalmaz)', () => {
    const block = buildRecallBlock([hit('x'.repeat(2_000)), hit('kisa')], { maxChars: 100 });
    const lines = (block ?? '').split('\n').filter((line) => line.startsWith('- '));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(100);
    expect(lines[0]?.endsWith('…')).toBe(true);
  });

  it('ilk hit butceye sigiyorsa kirpilmaz', () => {
    const block = buildRecallBlock([hit('React tercih ediyor')], { maxChars: 100 });
    expect(block).toContain('- React tercih ediyor');
    expect(block).not.toContain('…');
  });
});
