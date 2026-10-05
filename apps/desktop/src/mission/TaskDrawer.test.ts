import { describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import type { Agent, AgentRun, MissionResult, TaskComment, TaskDetail } from './api.js';
import { TaskDrawer, type TaskDrawerProps } from './TaskDrawer.js';
import { button, control, find, findAll, fire, mount, settle, textOf } from '../hookTestHost.js';

vi.mock('react', async (original) =>
  (await import('../hookTestHost.js')).reactWithHost(await original<typeof React>()),
);
vi.mock('../useModalDialog.js', () => ({ useModalDialog: () => ({ current: null }) }));

const AGENT: Agent = {
  id: 'a1',
  slug: 'nova',
  displayName: 'Nova',
  role: 'Araştırma',
  soul: 'Dikkatli ve kanıtlı çalış.',
  model: null,
  parentId: null,
  device: 'wsl',
  workRoots: [],
  allowedTools: [],
  status: 'idle',
  lastSeenAt: null,
};

function run(id: string, startedAt: string, costMicros: number | null): AgentRun {
  return {
    id,
    status: 'ok',
    device: 'wsl',
    engine: 'claude-code',
    exitCode: 0,
    costMicros,
    inputTokens: null,
    outputTokens: null,
    logPath: null,
    startedAt,
    finishedAt: null,
  };
}

function comment(id: string, authorType: string, authorId: string): TaskComment {
  return {
    id,
    taskId: 't1',
    authorType,
    authorId,
    kind: 'comment',
    body: `govde ${id}`,
    mentions: [],
    createdAt: '2026-10-03T09:00:00Z',
  };
}

const DETAIL: TaskDetail = {
  task: {
    id: 't1',
    title: 'Kanıtı hazırla',
    detail: null,
    status: 'inbox',
    priority: 2,
    assigneeId: null,
    deliverable: null,
    artifactPath: null,
    createdBy: 'user',
    dueAt: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: '2026-10-03T09:00:00Z',
  },
  comments: [],
  runs: [],
};

const done = (): Promise<MissionResult<null>> => Promise.resolve({ ok: true, value: null });
const refused = (error: string): Promise<MissionResult<null>> =>
  Promise.resolve({ ok: false, code: 'validation', error });

function setup(overrides: Partial<TaskDrawerProps> = {}) {
  const props: TaskDrawerProps = {
    detail: DETAIL,
    agents: [AGENT],
    transitions: { inbox: ['assigned', 'blocked'] },
    busy: false,
    status: 'ready',
    error: null,
    onClose: vi.fn(),
    onRetry: vi.fn(),
    onMove: vi.fn(done),
    onAssign: vi.fn(done),
    onComment: vi.fn(done),
    ...overrides,
  };
  const view = mount(() => TaskDrawer(props));
  let tree = view.render();
  view.flush();
  return {
    props,
    get tree() {
      return tree;
    },
    rerender: () => {
      tree = view.render();
      view.flush();
    },
  };
}

const alerts = (tree: unknown): string[] =>
  findAll(tree, (element) => element.props.role === 'alert').map(textOf);

describe('yorum taslagi', () => {
  it('gonderme basarisizsa taslak korunur ve hata cekmecenin icinde gorunur', async () => {
    const drawer = setup({ onComment: vi.fn(() => refused('Yorum gönderilemedi.')) });
    fire(control(drawer.tree, 'Yorum'), 'onChange', { target: { value: '  uzun yorum  ' } });
    drawer.rerender();

    fire(button(drawer.tree, 'Yorumu gönder'), 'onClick');
    await settle();
    drawer.rerender();

    expect(drawer.props.onComment).toHaveBeenCalledWith('uzun yorum');
    expect(control(drawer.tree, 'Yorum').props.value).toBe('  uzun yorum  ');
    expect(alerts(drawer.tree)).toEqual(['Yorum gönderilemedi.']);
  });

  it('gonderme basarili olunca taslak temizlenir ve hata kalmaz', async () => {
    const onComment = vi.fn(refusedThenDone());
    const drawer = setup({ onComment });
    fire(control(drawer.tree, 'Yorum'), 'onChange', { target: { value: 'selam' } });
    drawer.rerender();
    fire(button(drawer.tree, 'Yorumu gönder'), 'onClick');
    await settle();
    drawer.rerender();
    expect(alerts(drawer.tree)).toHaveLength(1);

    fire(button(drawer.tree, 'Yorumu gönder'), 'onClick');
    await settle();
    drawer.rerender();
    expect(control(drawer.tree, 'Yorum').props.value).toBe('');
    expect(alerts(drawer.tree)).toHaveLength(0);
  });

  it('bos yorumda ve mesgulken gonder dugmesi kapalidir', () => {
    const idle = setup();
    expect(button(idle.tree, 'Yorumu gönder').props.disabled).toBe(true);

    const busy = setup({ busy: true });
    fire(control(busy.tree, 'Yorum'), 'onChange', { target: { value: 'dolu' } });
    busy.rerender();
    expect(button(busy.tree, 'Yorumu gönder').props.disabled).toBe(true);
  });

  it('yorum alani sunucu sinirini uygular', () => {
    expect(control(setup().tree, 'Yorum').props.maxLength).toBe(4000);
  });
});

function refusedThenDone(): () => Promise<MissionResult<null>> {
  let calls = 0;
  return () => (calls++ === 0 ? refused('Yorum gönderilemedi.') : done());
}

describe('atama', () => {
  it('ajan secilmeden atama kapalidir; motor varsayilani ilk secenektir', async () => {
    const drawer = setup();
    expect(button(drawer.tree, 'Ata ve çalıştır').props.disabled).toBe(true);

    fire(control(drawer.tree, 'Ajan'), 'onChange', { target: { value: 'nova' } });
    drawer.rerender();
    fire(button(drawer.tree, 'Ata ve çalıştır'), 'onClick');
    await settle();
    expect(drawer.props.onAssign).toHaveBeenCalledWith('nova', 'claude-code');
  });

  it('atama basarisizsa secim korunur, basarili olunca sifirlanir', async () => {
    let calls = 0;
    const onAssign = vi.fn(() => (calls++ === 0 ? refused('Atanamadı.') : done()));
    const drawer = setup({ onAssign });
    fire(control(drawer.tree, 'Ajan'), 'onChange', { target: { value: 'nova' } });
    drawer.rerender();

    fire(button(drawer.tree, 'Ata ve çalıştır'), 'onClick');
    await settle();
    drawer.rerender();
    expect(control(drawer.tree, 'Ajan').props.value).toBe('nova');
    expect(alerts(drawer.tree)).toEqual(['Atanamadı.']);

    fire(button(drawer.tree, 'Ata ve çalıştır'), 'onClick');
    await settle();
    drawer.rerender();
    expect(control(drawer.tree, 'Ajan').props.value).toBe('');
    expect(alerts(drawer.tree)).toHaveLength(0);
  });
});

describe('durum gecisi', () => {
  it('sunucunun verdigi gecisleri dugme olarak sunar ve hatayi gosterir', async () => {
    const drawer = setup({ onMove: vi.fn(() => refused('Geçiş reddedildi.')) });
    expect(findAll(drawer.tree, byTextIn('Atandı'))).toHaveLength(1);

    fire(button(drawer.tree, 'Atandı'), 'onClick');
    await settle();
    drawer.rerender();
    expect(drawer.props.onMove).toHaveBeenCalledWith('assigned');
    expect(alerts(drawer.tree)).toEqual(['Geçiş reddedildi.']);
  });

  it('baska mutasyon surerken (null) hata gostermez', async () => {
    const drawer = setup({ onMove: vi.fn(() => Promise.resolve(null)) });
    fire(button(drawer.tree, 'Atandı'), 'onClick');
    await settle();
    drawer.rerender();
    expect(alerts(drawer.tree)).toHaveLength(0);
  });

  it('gecis yoksa bunu soyler', () => {
    const drawer = setup({ transitions: { inbox: [] } });
    expect(textOf(drawer.tree)).toContain('Bu durumdan geçiş yok.');
  });
});

function byTextIn(
  text: string,
): (element: { type: unknown; props: Record<string, unknown> }) => boolean {
  return (element) => element.type === 'button' && textOf(element) === text;
}

describe('bayat ayrinti ve kapatma', () => {
  it('bayat iken sebep ve yeniden dene gosterilir; hazirken gosterilmez', () => {
    const stale = setup({ status: 'stale', error: 'Bağlantı koptu.' });
    expect(textOf(stale.tree)).toContain('Bağlantı koptu. Son bilinen ayrıntılar gösteriliyor.');
    fire(button(stale.tree, 'Yeniden dene'), 'onClick');
    expect(stale.props.onRetry).toHaveBeenCalledTimes(1);

    const ready = setup();
    expect(textOf(ready.tree)).not.toContain('Yeniden dene');
  });

  it('kapat dugmesi onClose cagirir ve erisilebilir adi vardir', () => {
    const drawer = setup();
    const close = find(
      drawer.tree,
      (element) => element.props['aria-label'] === 'Görev detayını kapat',
    );
    fire(close, 'onClick');
    expect(drawer.props.onClose).toHaveBeenCalledTimes(1);
  });

  it('dialog basligina baglidir', () => {
    const drawer = setup();
    const dialog = find(drawer.tree, (element) => element.type === 'dialog');
    expect(dialog.props['aria-labelledby']).toBe('task-drawer-title');
  });
});

describe('maliyet ve yorum yazari', () => {
  it('bugunku ve toplam maliyeti ayri gosterir', () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const drawer = setup({
      detail: { ...DETAIL, runs: [run('r1', now, 1_250_000), run('r2', old, 400_000)] },
    });
    expect(textOf(drawer.tree)).toContain('Bugün $1.2500 · toplam $1.6500');
  });

  it('kosu yoksa maliyet satiri yerine bos durum yazar', () => {
    const text = textOf(setup().tree);
    expect(text).toContain('Henüz koşu yok.');
    expect(text).not.toContain('toplam $');
  });

  it('yorum yazarini kullanici metniyle gosterir', () => {
    const drawer = setup({
      detail: {
        ...DETAIL,
        comments: [
          comment('c1', 'user', 'cihan'),
          comment('c2', 'agent', 'a1'),
          comment('c3', 'system', 'x'),
        ],
      },
    });
    const who = findAll(drawer.tree, (element) => element.props.className === 'thread-who').map(
      textOf,
    );
    expect(who).toEqual(['Sen', '@nova', 'Sistem']);
  });
});
