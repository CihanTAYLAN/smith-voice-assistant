import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import { find, fire, mount, settle, textOf } from '../hookTestHost.js';
import { OpenQuestions } from './Memory.js';

const api = vi.hoisted(() => ({
  memoryGaps: vi.fn(),
  answerMemoryGap: vi.fn(),
  dismissMemoryGap: vi.fn(),
  memoryList: vi.fn(),
  memorySearch: vi.fn(),
}));

vi.mock('react', async (original) =>
  (await import('../hookTestHost.js')).reactWithHost(await original<typeof React>()),
);
vi.mock('./api.js', () => api);

const gap = {
  id: 'gap_00000000000000000000',
  question: 'Hangi şehirde yaşıyorsun?',
  reason: 'Şehir bilgisi bilinmiyor.',
  status: 'open',
  createdAt: '2026-10-03T08:00:00.000Z',
  askedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.memoryGaps.mockResolvedValue({ ok: true, value: { gaps: [gap] } });
  api.answerMemoryGap.mockResolvedValue({
    ok: true,
    value: { ok: true, status: 'answered', memoryId: 'mem_1' },
  });
  api.dismissMemoryGap.mockResolvedValue({
    ok: true,
    value: { ok: true, status: 'dismissed' },
  });
});

describe('Acik sorular bolumu', () => {
  it('cevap kaydedilince soruyu listeden dusurur', async () => {
    const view = mount(() => OpenQuestions());
    let tree = view.render();
    view.flush();
    await settle();
    tree = view.render();
    expect(textOf(tree)).toContain(gap.question);

    const input = find(tree, (element) => element.props.label === 'Cevap');
    fire(input, 'onChange', { currentTarget: { value: 'İstanbul' } });
    tree = view.render();
    const save = find(
      tree,
      (element) => textOf(element) === 'Kaydet' && typeof element.props.onClick === 'function',
    );
    fire(save, 'onClick');
    await settle();
    tree = view.render();

    expect(api.answerMemoryGap).toHaveBeenCalledWith(gap.id, 'İstanbul');
    expect(textOf(tree)).not.toContain(gap.question);
    expect(textOf(tree)).toContain('Açık soru yok.');
  });
});
