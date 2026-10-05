import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as React from 'react';

import type * as Api from './api.js';
import type { Agent, Board as BoardData, MissionResult, Task, TaskDetail } from './api.js';
import { AgentPanel, type AgentPanelProps } from './AgentPanel.js';
import { Board, type BoardProps } from './Board.js';
import { MissionControl } from './MissionControl.js';
import { OrgChart, type OrgChartProps } from './OrgChart.js';
import { TaskDrawer, type TaskDrawerProps } from './TaskDrawer.js';
import { button, control, find, findAll, fire, mount, settle, textOf } from '../hookTestHost.js';
import type { MissionData } from './useMissionData.js';

vi.mock('react', async (original) =>
  (await import('../hookTestHost.js')).reactWithHost(await original<typeof React>()),
);
vi.mock('@cruxgarden/plasma-ui', () => ({ Plasma: 'section' }));

const hook: { useMissionData: Mock; current: unknown } = vi.hoisted(() => ({
  useMissionData: vi.fn(),
  current: undefined,
}));
vi.mock('./useMissionData.js', () => ({
  useMissionData: (aktif: boolean) => {
    hook.useMissionData(aktif);
    return hook.current;
  },
}));

const calls = vi.hoisted(() => ({
  createTask: vi.fn(),
  deleteAgent: vi.fn(),
}));
vi.mock('./api.js', async (original) => ({
  ...(await original<typeof Api>()),
  createTask: calls.createTask,
  deleteAgent: calls.deleteAgent,
}));

function agent(id: string, slug: string, status = 'idle'): Agent {
  return {
    id,
    slug,
    displayName: slug.toUpperCase(),
    role: 'kod',
    soul: 'Kimlik ve kurallar.',
    model: null,
    parentId: null,
    device: 'wsl',
    workRoots: [],
    allowedTools: [],
    status,
    lastSeenAt: null,
  };
}

function task(id: string, status: string, assigneeId: string | null): Task {
  return {
    id,
    title: `Gorev ${id}`,
    detail: null,
    status,
    priority: 2,
    assigneeId,
    deliverable: null,
    artifactPath: null,
    createdBy: 'user',
    dueAt: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: '2026-10-03T09:00:00Z',
  };
}

const NOVA = agent('a1', 'nova', 'working');
const ATLAS = agent('a2', 'atlas');
const BOARD: BoardData = {
  agents: [NOVA, ATLAS],
  tasks: [
    task('t1', 'in_progress', 'a1'),
    task('t2', 'review', 'a2'),
    task('t3', 'blocked', null),
    task('t4', 'review', 'a1'),
  ],
  events: [
    {
      id: 'e1',
      taskId: null,
      agentId: null,
      kind: 'claim',
      detail: 'Nova üstlendi.',
      createdAt: '2026-10-03T09:00:00Z',
    },
  ],
  transitions: {},
};
const DETAIL: TaskDetail = { task: BOARD.tasks[0] as Task, comments: [], runs: [] };

const ok = (): Promise<MissionResult<null>> => Promise.resolve({ ok: true, value: null });
const refused = (error: string): Promise<MissionResult<null>> =>
  Promise.resolve({ ok: false, code: 'validation', error });

function fakeData(overrides: Partial<MissionData> = {}): MissionData {
  return {
    board: BOARD,
    boardState: 'ready',
    connectionError: null,
    notice: null,
    dismissNotice: vi.fn(),
    detail: null,
    detailState: 'ready',
    detailError: null,
    selectedTaskId: null,
    busy: false,
    refresh: vi.fn(() => Promise.resolve()),
    openTask: vi.fn(() => Promise.resolve()),
    closeTask: vi.fn(),
    retryDetail: vi.fn(() => Promise.resolve()),
    mutate: ((action: () => Promise<MissionResult<unknown>>) => action()) as MissionData['mutate'],
    ...overrides,
  };
}

function setup(data: MissionData, aktif?: boolean) {
  hook.current = data;
  const view = mount(() => MissionControl(aktif === undefined ? {} : { aktif }));
  let tree = view.render();
  view.flush();
  const props = <T>(component: unknown): T =>
    find(tree, (element) => element.type === component).props as unknown as T;
  return {
    get tree() {
      return tree;
    },
    rerender: () => {
      tree = view.render();
      view.flush();
    },
    board: () => props<BoardProps>(Board),
    org: () => props<OrgChartProps>(OrgChart),
    panel: () => props<AgentPanelProps>(AgentPanel),
    drawer: () => props<TaskDrawerProps>(TaskDrawer),
  };
}

const titles = (tasks: Task[]): string[] => tasks.map((item) => item.id);

beforeEach(() => {
  hook.useMissionData.mockClear();
  calls.createTask.mockReset().mockImplementation(ok);
  calls.deleteAgent.mockReset().mockImplementation(ok);
});

describe('aktif baglantisi', () => {
  it('aktif prop veri katmanina iletilir; varsayilan true', () => {
    setup(fakeData());
    expect(hook.useMissionData).toHaveBeenLastCalledWith(true);
    setup(fakeData(), false);
    expect(hook.useMissionData).toHaveBeenLastCalledWith(false);
  });

  it('pasifken yenile dugmesi kapali; aktifken veri katmanini cagirir', () => {
    const inactive = setup(fakeData(), false);
    const refreshButton = find(
      inactive.tree,
      (element) => element.props['aria-label'] === 'Mission Control verilerini yenile',
    );
    expect(refreshButton.props.disabled).toBe(true);

    const data = fakeData();
    const active = setup(data, true);
    fire(
      find(
        active.tree,
        (element) => element.props['aria-label'] === 'Mission Control verilerini yenile',
      ),
      'onClick',
    );
    expect(data.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('bantlar', () => {
  it('baglanti hatasini ve bildirimi gosterir; bildirim kapatilabilir', () => {
    const data = fakeData({ connectionError: 'Bağlantı koptu.', notice: 'Görev kapandı.' });
    const view = setup(data);
    const text = textOf(view.tree);
    expect(text).toContain('Bağlantı koptu.');
    expect(text).toContain('Görev kapandı.');
    fire(button(view.tree, 'Kapat'), 'onClick');
    expect(data.dismissNotice).toHaveBeenCalledTimes(1);
  });

  it('banner kapsayicisi bos olsa da DOM da kalir (grid satirlari ve canli bolge)', () => {
    const view = setup(fakeData());
    const banners = find(view.tree, (element) => element.props.className === 'mc-banners');
    expect(banners.props['aria-live']).toBe('polite');
  });
});

describe('hizli gorev ekleme', () => {
  function type(view: ReturnType<typeof setup>, value: string): void {
    fire(control(view.tree, 'Yeni görev'), 'onChange', { target: { value } });
    view.rerender();
  }
  const submit = (view: ReturnType<typeof setup>): void =>
    fire(
      find(view.tree, (element) => element.props.className === 'quick'),
      'onSubmit',
      {
        preventDefault: vi.fn(),
      },
    );

  it('3 karakterden kisa baslikla istek atmaz ve dugme kapali', async () => {
    const view = setup(fakeData());
    type(view, 'ab');
    expect(button(view.tree, 'Görev ekle').props.disabled).toBe(true);
    submit(view);
    await settle();
    expect(calls.createTask).not.toHaveBeenCalled();
  });

  it('atama secilirse ajan kimligiyle gonderir; basarili olunca alanlari temizler', async () => {
    const view = setup(fakeData());
    type(view, '  Yeni görev başlığı  ');
    fire(control(view.tree, 'Atama'), 'onChange', { target: { value: 'nova' } });
    view.rerender();
    submit(view);
    await settle();
    view.rerender();

    expect(calls.createTask).toHaveBeenCalledWith({
      title: 'Yeni görev başlığı',
      assignee: 'nova',
    });
    expect(control(view.tree, 'Yeni görev').props.value).toBe('');
    expect(control(view.tree, 'Atama').props.value).toBe('');
  });

  it('basarisizsa baslik korunur ve hata bantta gorunur', async () => {
    calls.createTask.mockImplementation(() => refused('Girilen bilgiler geçerli değil.'));
    const view = setup(fakeData());
    type(view, 'Uzun bir görev başlığı');
    submit(view);
    await settle();
    view.rerender();

    expect(control(view.tree, 'Yeni görev').props.value).toBe('Uzun bir görev başlığı');
    const alert = findAll(view.tree, (element) => element.props.role === 'alert').map(textOf);
    expect(alert.join(' ')).toContain('Girilen bilgiler geçerli değil.');
  });

  it('baslik alani sunucu sinirini uygular', () => {
    expect(control(setup(fakeData()).tree, 'Yeni görev').props.maxLength).toBe(200);
  });
});

describe('ajan filtresi', () => {
  it('org semasinda secilen ajanin gorevlerini gosterir; kaldirinca hepsi doner', () => {
    const view = setup(fakeData());
    expect(titles(view.board().tasks)).toEqual(['t1', 't2', 't3', 't4']);

    view.org().onSelect('a1');
    view.rerender();
    expect(titles(view.board().tasks)).toEqual(['t1', 't4']);
    expect(view.org().selectedId).toBe('a1');
    expect(view.panel().selected?.id).toBe('a1');

    fire(button(view.tree, 'Filtreyi kaldır'), 'onClick');
    view.rerender();
    expect(titles(view.board().tasks)).toHaveLength(4);
  });

  it('suzulen ajan panodan kaybolursa filtre sessizce duser', () => {
    const view = setup(fakeData());
    view.org().onSelect('a1');
    view.rerender();

    hook.current = fakeData({ board: { ...BOARD, agents: [ATLAS] } });
    view.rerender();
    expect(titles(view.board().tasks)).toHaveLength(4);
    expect(view.org().selectedId).toBeNull();
    expect(textOf(view.tree)).not.toContain('Filtreyi kaldır');
  });

  it('basarili silme filtreyi temizler, basarisiz silme korur', async () => {
    const view = setup(fakeData());
    view.org().onSelect('a1');
    view.rerender();

    calls.deleteAgent.mockImplementationOnce(() => refused('Silinemedi.'));
    const failed = await view.panel().onDelete('a1');
    view.rerender();
    expect(failed).toEqual({ ok: false, code: 'validation', error: 'Silinemedi.' });
    expect(view.org().selectedId).toBe('a1');

    await view.panel().onDelete('a1');
    view.rerender();
    expect(view.org().selectedId).toBeNull();
  });
});

describe('ajan formu ve yuzey durumlari', () => {
  it('pano gizliyken ajan formu ve onay pencereleri kapali tutulur', () => {
    const view = setup(fakeData(), false);
    view.org().onCreateAgent();
    view.rerender();
    expect(view.panel().active).toBe(false);
    expect(view.panel().createOpen).toBe(false);

    const visible = setup(fakeData(), true);
    expect(visible.panel().active).toBe(true);
  });

  it('bos ekip eylemi ajan formunu acar; form kapatilabilir', () => {
    const view = setup(fakeData());
    expect(view.panel().createOpen).toBe(false);
    view.org().onCreateAgent();
    view.rerender();
    expect(view.panel().createOpen).toBe(true);
    view.panel().onCreateOpenChange(false);
    view.rerender();
    expect(view.panel().createOpen).toBe(false);
  });

  it('ilk yukleme tum yuzeylerde loading, hata hata, gercek bos empty', () => {
    const loading = setup(fakeData({ board: null, boardState: 'loading' }));
    expect([loading.board().status, loading.org().status]).toEqual(['loading', 'loading']);
    expect(
      find(loading.tree, (element) => element.props.className === 'mc').props['aria-busy'],
    ).toBe(true);

    const failed = setup(fakeData({ board: null, boardState: 'error' }));
    expect([failed.board().status, failed.org().status]).toEqual(['error', 'error']);

    const empty = setup(
      fakeData({
        board: { agents: [], tasks: [], events: [], transitions: {} },
        boardState: 'empty',
      }),
    );
    expect([empty.board().status, empty.org().status]).toEqual(['empty', 'empty']);
    expect(textOf(empty.tree)).toContain('Henüz olay yok.');
  });

  it('veri varken baglanti koparsa yuzeyler bayat gosterilir ve veri durur', () => {
    const view = setup(fakeData({ boardState: 'stale', connectionError: 'Koptu.' }));
    expect(view.board().status).toBe('stale');
    expect(titles(view.board().tasks)).toHaveLength(4);
  });

  it('pano gelmeden footer sayilari 0 degil bilinmiyor gosterilir', () => {
    const view = setup(fakeData({ board: null, boardState: 'loading' }));
    const footer = textOf(find(view.tree, (element) => element.type === 'footer'));
    expect(footer).toBe('Ekip -Koşan -İnceleme -Engel -Görev -');
  });

  it('footer toplamlari ekip, kosan, inceleme, engel ve gorev sayisini verir', () => {
    const footer = textOf(find(setup(fakeData()).tree, (element) => element.type === 'footer'));
    expect(footer).toBe('Ekip 2Koşan 1İnceleme 2Engel 1Görev 4');
  });
});

describe('gorev cekmecesi baglantisi', () => {
  it('detay yokken cekmece yok; secili gorev yukleniyorsa kart mesgul isaretlenir', () => {
    const view = setup(fakeData({ selectedTaskId: 't1', detail: null }));
    expect(findAll(view.tree, (element) => element.type === TaskDrawer)).toHaveLength(0);
    expect(view.board().pendingTaskId).toBe('t1');
  });

  it('detay gelince cekmece gorev kimligiyle anahtarlanir (baska gorevin taslagi sizmaz)', () => {
    const view = setup(fakeData({ selectedTaskId: 't1', detail: DETAIL }));
    const drawer = find(view.tree, (element) => element.type === TaskDrawer) as unknown as {
      key: string;
    };
    expect(drawer.key).toBe('t1');
    expect(view.board().pendingTaskId).toBeNull();
    expect(view.drawer().status).toBe('ready');
  });

  it('bayat detay cekmeceye sebebiyle iletilir ve yeniden dene veri katmanina gider', () => {
    const data = fakeData({
      selectedTaskId: 't1',
      detail: DETAIL,
      detailState: 'stale',
      detailError: 'Koptu.',
    });
    const view = setup(data);
    expect(view.drawer().status).toBe('stale');
    expect(view.drawer().error).toBe('Koptu.');
    view.drawer().onRetry();
    expect(data.retryDetail).toHaveBeenCalledTimes(1);
    view.drawer().onClose();
    expect(data.closeTask).toHaveBeenCalledTimes(1);
  });
});
