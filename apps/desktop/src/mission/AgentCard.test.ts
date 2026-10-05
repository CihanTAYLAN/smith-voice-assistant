import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import { AgentCard, type AgentCardProps } from './AgentCard.js';
import type { Agent, MissionResult } from './api.js';
import { button, control, findAll, fire, mount, settle, textOf } from '../hookTestHost.js';

vi.mock('react', async (original) =>
  (await import('../hookTestHost.js')).reactWithHost(await original<typeof React>()),
);

const modal = vi.hoisted(() => ({
  calls: [] as Array<{ open: boolean; onClose: () => void }>,
}));
vi.mock('../useModalDialog.js', () => ({
  useModalDialog: (open: boolean, onClose: () => void) => {
    modal.calls.push({ open, onClose });
    return { current: null };
  },
}));

const AGENT: Agent = {
  id: 'a1',
  slug: 'nova',
  displayName: 'Nova',
  role: 'Araştırma',
  soul: 'Dikkatli ve kanıtlı çalış.',
  model: null,
  parentId: null,
  device: 'wsl',
  workRoots: ['/work'],
  allowedTools: [],
  status: 'idle',
  lastSeenAt: null,
};

const done = (): Promise<MissionResult<null>> => Promise.resolve({ ok: true, value: null });
const refused = (error: string): Promise<MissionResult<null>> =>
  Promise.resolve({ ok: false, code: 'conflict', error });

function setup(overrides: Partial<AgentCardProps> = {}) {
  const props: AgentCardProps = {
    active: true,
    agent: AGENT,
    busy: false,
    fallbackFocus: { current: null },
    onSaveSoul: vi.fn(done),
    onSetStatus: vi.fn(done),
    onDelete: vi.fn(done),
    ...overrides,
  };
  const view = mount(() => AgentCard(props));
  let tree = view.render();
  view.flush();
  return {
    props,
    get tree() {
      return tree;
    },
    // Render sirasinda state ayarlayan bilesen (baseline) icin kararli olana dek iki tur.
    rerender: () => {
      view.render();
      tree = view.render();
      view.flush();
    },
    editSoul(value: string) {
      fire(control(tree, 'SOUL metni'), 'onChange', { target: { value } });
      this.rerender();
    },
  };
}

const alerts = (tree: unknown): string[] =>
  findAll(tree, (element) => element.props.role === 'alert').map(textOf);
const confirmOpen = (): boolean | undefined => modal.calls.at(-1)?.open;

beforeEach(() => {
  modal.calls.length = 0;
});

describe('SOUL duzenleme', () => {
  it('degisiklik yokken ve cok kisayken kaydet kapali, gecerli degisiklikte acik', () => {
    const card = setup();
    expect(button(card.tree, 'SOUL kaydet').props.disabled).toBe(true);

    card.editSoul('kisa');
    expect(button(card.tree, 'SOUL kaydet').props.disabled).toBe(true);

    card.editSoul('Yeni ve yeterince uzun bir SOUL metni.');
    expect(button(card.tree, 'SOUL kaydet').props.disabled).toBe(false);
  });

  it('yalniz bosluk farki degisiklik sayilmaz', () => {
    const card = setup();
    card.editSoul(`  ${AGENT.soul}  `);
    expect(button(card.tree, 'SOUL kaydet').props.disabled).toBe(true);
  });

  it('kayit basarisizsa metin ve hata kalir; basariliysa hata temizlenir', async () => {
    let calls = 0;
    const onSaveSoul = vi.fn(() => (calls++ === 0 ? refused('Kaydedilemedi.') : done()));
    const card = setup({ onSaveSoul });
    card.editSoul('  Yeni ve yeterince uzun bir SOUL metni.  ');

    fire(button(card.tree, 'SOUL kaydet'), 'onClick');
    await settle();
    card.rerender();
    expect(onSaveSoul).toHaveBeenCalledWith('a1', 'Yeni ve yeterince uzun bir SOUL metni.');
    expect(control(card.tree, 'SOUL metni').props.value).toBe(
      '  Yeni ve yeterince uzun bir SOUL metni.  ',
    );
    expect(alerts(card.tree)).toEqual(['Kaydedilemedi.']);

    fire(button(card.tree, 'SOUL kaydet'), 'onClick');
    await settle();
    card.rerender();
    expect(alerts(card.tree)).toHaveLength(0);
  });

  it('sunucudaki SOUL degisince temiz taslak yenisini alir', () => {
    const card = setup();
    card.props.agent = { ...AGENT, soul: 'Sunucuda guncellendi, yeni metin.' };
    card.rerender();
    expect(control(card.tree, 'SOUL metni').props.value).toBe('Sunucuda guncellendi, yeni metin.');
  });

  it('kullanici duzenlerken sunucudaki degisiklik taslagi EZMEZ', () => {
    const card = setup();
    card.editSoul('Benim yarim kalmis duzenlemem burada.');
    card.props.agent = { ...AGENT, soul: 'Sunucuda guncellendi, yeni metin.' };
    card.rerender();
    expect(control(card.tree, 'SOUL metni').props.value).toBe(
      'Benim yarim kalmis duzenlemem burada.',
    );
  });
});

describe('durum ve gorunum', () => {
  it('bosta ajan devre disi birakilir, kapali ajan devreye alinir', async () => {
    const idle = setup();
    fire(button(idle.tree, 'Devre dışı bırak'), 'onClick');
    await settle();
    expect(idle.props.onSetStatus).toHaveBeenCalledWith('a1', 'offline');

    const offline = setup({ agent: { ...AGENT, status: 'offline' } });
    fire(button(offline.tree, 'Devreye al'), 'onClick');
    await settle();
    expect(offline.props.onSetStatus).toHaveBeenCalledWith('a1', 'idle');
  });

  it('durumu ve son gorulmeyi Turkce gosterir', () => {
    const card = setup();
    const text = textOf(card.tree);
    expect(text).toContain('Boşta');
    expect(text).toContain('son görülme bilinmiyor');
    expect(text).not.toContain('idle');
  });

  it('mesgulken tum eylem dugmeleri kapali', () => {
    const card = setup({ busy: true });
    card.editSoul('Yeni ve yeterince uzun bir SOUL metni.');
    for (const label of ['SOUL kaydet', 'Devre dışı bırak', 'Sil']) {
      expect(button(card.tree, label).props.disabled).toBe(true);
    }
  });
});

describe('silme onayi', () => {
  it('Sil tek basina silmez; onay ajan adini tasir', () => {
    const card = setup();
    expect(confirmOpen()).toBe(false);
    fire(button(card.tree, 'Sil'), 'onClick');
    card.rerender();
    expect(confirmOpen()).toBe(true);
    expect(card.props.onDelete).not.toHaveBeenCalled();
    expect(textOf(card.tree)).toContain('Nova adlı ajanı sil');
  });

  it('onaylayinca siler; basarisizsa hata onayin icinde kalir ve pencere acik durur', async () => {
    const card = setup({ onDelete: vi.fn(() => refused('Koşu geçmişi olan ajan silinemez.')) });
    fire(button(card.tree, 'Sil'), 'onClick');
    card.rerender();

    fire(button(card.tree, 'Ajanı sil'), 'onClick');
    await settle();
    card.rerender();
    expect(card.props.onDelete).toHaveBeenCalledWith('a1');
    expect(alerts(card.tree)).toEqual(['Koşu geçmişi olan ajan silinemez.']);
    expect(confirmOpen()).toBe(true);
  });

  it('pano gizliyken onay penceresi acik kalmaz (gorunmeyen modal sayfayi kilitler)', () => {
    const card = setup({ active: false });
    fire(button(card.tree, 'Sil'), 'onClick');
    card.rerender();
    expect(confirmOpen()).toBe(false);

    card.props.active = true;
    card.rerender();
    expect(confirmOpen()).toBe(true);
  });

  it('basarili silme onayi kapatir', async () => {
    const card = setup();
    fire(button(card.tree, 'Sil'), 'onClick');
    card.rerender();
    fire(button(card.tree, 'Ajanı sil'), 'onClick');
    await settle();
    card.rerender();
    expect(confirmOpen()).toBe(false);
  });

  it('Vazgec ve Escape onayi kapatir ve hatayi temizler', async () => {
    const card = setup({ onDelete: vi.fn(() => refused('Hata.')) });
    fire(button(card.tree, 'Sil'), 'onClick');
    card.rerender();
    fire(button(card.tree, 'Ajanı sil'), 'onClick');
    await settle();
    card.rerender();
    expect(alerts(card.tree)).toHaveLength(1);

    fire(button(card.tree, 'Vazgeç'), 'onClick');
    card.rerender();
    expect(confirmOpen()).toBe(false);
    expect(alerts(card.tree)).toHaveLength(0);

    fire(button(card.tree, 'Sil'), 'onClick');
    card.rerender();
    modal.calls.at(-1)?.onClose();
    card.rerender();
    expect(confirmOpen()).toBe(false);
  });
});
