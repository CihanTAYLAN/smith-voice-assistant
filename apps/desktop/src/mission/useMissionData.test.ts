import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import type * as Api from './api.js';
import type { Board, MissionResult, Task, TaskDetail } from './api.js';
import { mount, settle } from '../hookTestHost.js';
import { REFRESH_MS, useMissionData } from './useMissionData.js';

vi.mock('react', async (original) =>
  (await import('../hookTestHost.js')).reactWithHost(await original<typeof React>()),
);

const api = vi.hoisted(() => ({ fetchBoard: vi.fn(), fetchTask: vi.fn() }));
vi.mock('./api.js', async (original) => ({
  ...(await original<typeof Api>()),
  fetchBoard: api.fetchBoard,
  fetchTask: api.fetchTask,
}));

function task(id: string, status = 'inbox'): Task {
  return {
    id,
    title: `Gorev ${id}`,
    detail: null,
    status,
    priority: 2,
    assigneeId: null,
    deliverable: null,
    artifactPath: null,
    createdBy: 'user',
    dueAt: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: '2026-10-03T09:00:00Z',
  };
}

const board = (...ids: string[]): Board => ({
  agents: [],
  tasks: ids.map((id) => task(id)),
  events: [],
  transitions: {},
});
const detail = (id: string): TaskDetail => ({ task: task(id), comments: [], runs: [] });
const ok = <T>(value: T): MissionResult<T> => ({ ok: true, value });
const fail = (
  code: 'not-found' | 'unavailable' | 'validation',
  error = 'hata',
): MissionResult<never> => ({
  ok: false,
  code,
  error,
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const listeners = new Map<string, Array<() => void>>();
const doc = {
  hidden: false,
  addEventListener: (type: string, callback: () => void) => {
    listeners.set(type, [...(listeners.get(type) ?? []), callback]);
  },
  removeEventListener: (type: string, callback: () => void) => {
    listeners.set(
      type,
      (listeners.get(type) ?? []).filter((item) => item !== callback),
    );
  },
};

/** Hook'u surucuyle kurar; `data` her `rerender()`da taze degerleri verir. */
function mountData(aktif: boolean) {
  let flag = aktif;
  const view = mount(() => useMissionData(flag));
  let data = view.render();
  view.flush();
  return {
    get data() {
      return data;
    },
    rerender: () => {
      data = view.render();
      view.flush();
    },
    setAktif: (next: boolean) => {
      flag = next;
      data = view.render();
      view.flush();
    },
    unmount: view.unmount,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', doc);
  doc.hidden = false;
  listeners.clear();
  api.fetchBoard.mockReset().mockResolvedValue(ok(board('t1')));
  api.fetchTask.mockReset().mockImplementation((id: string) => Promise.resolve(ok(detail(id))));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('yoklama: aktif ve gorunurluk', () => {
  it('aktif degilken istek atmaz ve zamanlayici kurmaz', async () => {
    const view = mountData(false);
    await settle();
    vi.advanceTimersByTime(REFRESH_MS * 3);
    await settle();
    expect(api.fetchBoard).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
  });

  it('aktifken hemen yukler, sonra her 4 sn tek istek atar', async () => {
    const view = mountData(true);
    await settle();
    expect(api.fetchBoard).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REFRESH_MS);
    await settle();
    expect(api.fetchBoard).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(REFRESH_MS);
    await settle();
    expect(api.fetchBoard).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it('belge gizliyken yoklama atlanir, gorunur olunca hemen yenilenir', async () => {
    const view = mountData(true);
    await settle();
    doc.hidden = true;
    vi.advanceTimersByTime(REFRESH_MS * 2);
    await settle();
    expect(api.fetchBoard).toHaveBeenCalledTimes(1);

    doc.hidden = false;
    (listeners.get('visibilitychange') ?? []).forEach((callback) => callback());
    await settle();
    expect(api.fetchBoard).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('aktif kapaninca yoklama durur, yeniden acilinca hemen yenilenir', async () => {
    const view = mountData(true);
    await settle();
    view.setAktif(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(REFRESH_MS * 3);
    await settle();
    expect(api.fetchBoard).toHaveBeenCalledTimes(1);

    view.setAktif(true);
    await settle();
    expect(api.fetchBoard).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});

describe('yaris korumasi', () => {
  it('ust uste yenileme istekleri tek istekte birlesir', async () => {
    const slow = deferred<MissionResult<Board>>();
    api.fetchBoard.mockReturnValueOnce(slow.promise);
    const view = mountData(true);
    await settle();
    void view.data.refresh();
    void view.data.refresh();
    vi.advanceTimersByTime(REFRESH_MS);
    expect(api.fetchBoard).toHaveBeenCalledTimes(1);

    slow.resolve(ok(board('t1')));
    await settle();
    void view.data.refresh();
    expect(api.fetchBoard).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('aktif kapaninca bekleyen cevap state yazmaz', async () => {
    const slow = deferred<MissionResult<Board>>();
    api.fetchBoard.mockReturnValueOnce(slow.promise);
    const view = mountData(true);
    await settle();
    view.setAktif(false);
    slow.resolve(ok(board('t1', 't2')));
    await settle();
    view.rerender();
    expect(view.data.board).toBeNull();
    view.unmount();
  });

  it('yeniden acilista bayat bir istege katilmaz, taze istek atar', async () => {
    const slow = deferred<MissionResult<Board>>();
    api.fetchBoard.mockReturnValueOnce(slow.promise);
    const view = mountData(true);
    await settle();
    view.setAktif(false);
    view.setAktif(true);
    await settle();
    expect(api.fetchBoard).toHaveBeenCalledTimes(2);

    slow.resolve(ok(board('eski')));
    await settle();
    view.rerender();
    expect(view.data.board?.tasks.map((item) => item.id)).toEqual(['t1']);
    view.unmount();
  });

  it.each([
    ['bayat cevap SON gelirse', 'stale-last'],
    ['bayat cevap ONCE gelirse', 'stale-first'],
  ])('mutasyon sonrasi taze pano kazanir: %s', async (_name, order) => {
    const stale = deferred<MissionResult<Board>>();
    const fresh = deferred<MissionResult<Board>>();
    api.fetchBoard.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const view = mountData(true);
    await settle();

    const mutation = view.data.mutate(() => Promise.resolve(ok('yazildi')));
    await settle();
    expect(api.fetchBoard).toHaveBeenCalledTimes(2);

    const resolveStale = (): void => stale.resolve(ok(board('eski')));
    const resolveFresh = (): void => fresh.resolve(ok(board('yeni')));
    if (order === 'stale-last') {
      resolveFresh();
      await settle();
      resolveStale();
    } else {
      resolveStale();
      await settle();
      resolveFresh();
    }
    await mutation;
    await settle();
    view.rerender();
    expect(view.data.board?.tasks.map((item) => item.id)).toEqual(['yeni']);
    view.unmount();
  });
});

describe('mutasyon', () => {
  it('basarili mutasyon sonucu doner ve panoyu taze ceker', async () => {
    const view = mountData(true);
    await settle();
    api.fetchBoard.mockResolvedValueOnce(ok(board('t1', 't2')));
    const result = await view.data.mutate(() => Promise.resolve(ok('x')));
    expect(result).toEqual({ ok: true, value: 'x' });
    view.rerender();
    expect(view.data.board?.tasks).toHaveLength(2);
    view.unmount();
  });

  it('basarisiz mutasyon panoyu yenilemez; hata sonucu cagirana doner', async () => {
    const view = mountData(true);
    await settle();
    api.fetchBoard.mockClear();
    const result = await view.data.mutate(() => Promise.resolve(fail('validation', 'gecersiz')));
    expect(result).toEqual({ ok: false, code: 'validation', error: 'gecersiz' });
    expect(api.fetchBoard).not.toHaveBeenCalled();
    view.unmount();
  });

  it('mutasyon surerken ikinci cagri null doner ve busy tum sure true kalir', async () => {
    const view = mountData(true);
    await settle();
    const slow = deferred<MissionResult<string>>();
    const first = view.data.mutate(() => slow.promise);
    const second = await view.data.mutate(() => Promise.resolve(ok('ikinci')));
    expect(second).toBeNull();
    view.rerender();
    expect(view.data.busy).toBe(true);

    slow.resolve(ok('birinci'));
    await expect(first).resolves.toEqual({ ok: true, value: 'birinci' });
    view.rerender();
    expect(view.data.busy).toBe(false);
    view.unmount();
  });
});

describe('yuzey durumlari', () => {
  it('ilk yukleme loading, gelince ready, gercek bos pano empty', async () => {
    const slow = deferred<MissionResult<Board>>();
    api.fetchBoard.mockReturnValueOnce(slow.promise);
    const view = mountData(true);
    expect(view.data.boardState).toBe('loading');

    slow.resolve(ok(board('t1')));
    await settle();
    view.rerender();
    expect(view.data.boardState).toBe('ready');

    api.fetchBoard.mockResolvedValueOnce(
      ok({ agents: [], tasks: [], events: [], transitions: {} }),
    );
    await view.data.refresh();
    view.rerender();
    expect(view.data.boardState).toBe('empty');
    view.unmount();
  });

  it('ilk yukleme hatasi error olur; sonraki basari hatayi temizler', async () => {
    api.fetchBoard.mockResolvedValueOnce(fail('unavailable', 'baglanti yok'));
    const view = mountData(true);
    await settle();
    view.rerender();
    expect(view.data.boardState).toBe('error');
    expect(view.data.connectionError).toBe('baglanti yok');

    await view.data.refresh();
    view.rerender();
    expect(view.data.boardState).toBe('ready');
    expect(view.data.connectionError).toBeNull();
    view.unmount();
  });

  it('hata durumunda yeniden deneme error ile loading arasinda yanip sonmez', async () => {
    api.fetchBoard.mockResolvedValueOnce(fail('unavailable'));
    const view = mountData(true);
    await settle();
    const retry = deferred<MissionResult<Board>>();
    api.fetchBoard.mockReturnValueOnce(retry.promise);
    void view.data.refresh();
    view.rerender();
    expect(view.data.boardState).toBe('error');
    retry.resolve(ok(board('t1')));
    await settle();
    view.unmount();
  });

  it('veri varken baglanti kopar: stale olur ve pano silinmez', async () => {
    const view = mountData(true);
    await settle();
    api.fetchBoard.mockResolvedValueOnce(fail('unavailable', 'koptu'));
    await view.data.refresh();
    view.rerender();
    expect(view.data.boardState).toBe('stale');
    expect(view.data.connectionError).toBe('koptu');
    expect(view.data.board?.tasks).toHaveLength(1);
    view.unmount();
  });
});

describe('secili gorev', () => {
  it('openTask detayi yukler; yuklenirken secim var ama detay yok', async () => {
    const view = mountData(true);
    await settle();
    const slow = deferred<MissionResult<TaskDetail>>();
    api.fetchTask.mockReturnValueOnce(slow.promise);
    const opening = view.data.openTask('t1');
    view.rerender();
    expect(view.data.selectedTaskId).toBe('t1');
    expect(view.data.detail).toBeNull();
    expect(view.data.detailState).toBe('loading');

    slow.resolve(ok(detail('t1')));
    await opening;
    view.rerender();
    expect(view.data.detail?.task.id).toBe('t1');
    expect(view.data.detailState).toBe('ready');
    view.unmount();
  });

  it('son tiklanan gorev kazanir; yavas eski cevap yok sayilir', async () => {
    api.fetchBoard.mockResolvedValue(ok(board('a', 'b')));
    const view = mountData(true);
    await settle();
    const slowA = deferred<MissionResult<TaskDetail>>();
    api.fetchTask.mockReturnValueOnce(slowA.promise);
    void view.data.openTask('a');
    await view.data.openTask('b');
    slowA.resolve(ok(detail('a')));
    await settle();
    view.rerender();
    expect(view.data.selectedTaskId).toBe('b');
    expect(view.data.detail?.task.id).toBe('b');
    view.unmount();
  });

  it('openTask hatasi secimi birakir ve bildirim verir', async () => {
    const view = mountData(true);
    await settle();
    api.fetchTask.mockResolvedValueOnce(fail('unavailable', 'kurulamadi'));
    await view.data.openTask('t1');
    view.rerender();
    expect(view.data.selectedTaskId).toBeNull();
    expect(view.data.detail).toBeNull();
    expect(view.data.notice).toBe('kurulamadi');
    view.unmount();
  });

  it('yoklamada detay hatasi stale yapar, yeniden dene basarili olunca ready olur', async () => {
    const view = mountData(true);
    await settle();
    await view.data.openTask('t1');
    api.fetchTask.mockResolvedValueOnce(fail('unavailable', 'detay koptu'));
    await view.data.refresh();
    view.rerender();
    expect(view.data.detailState).toBe('stale');
    expect(view.data.detailError).toBe('detay koptu');
    expect(view.data.detail?.task.id).toBe('t1');

    await view.data.retryDetail();
    view.rerender();
    expect(view.data.detailState).toBe('ready');
    expect(view.data.detailError).toBeNull();
    view.unmount();
  });

  it('acilis bitmeden yoklama detayi da getiremezse bekleyen secim birakilir', async () => {
    const view = mountData(true);
    await settle();
    const slow = deferred<MissionResult<TaskDetail>>();
    api.fetchTask
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(fail('unavailable', 'detay yok'));
    const opening = view.data.openTask('t1');
    await view.data.refresh();
    view.rerender();
    expect(view.data.selectedTaskId).toBeNull();
    expect(view.data.notice).toBe('detay yok');

    slow.resolve(ok(detail('t1')));
    await opening;
    view.rerender();
    expect(view.data.detail).toBeNull();
    view.unmount();
  });

  it('yoklamada 404 gelirse cekmece kapanir ve bildirim gelir', async () => {
    const view = mountData(true);
    await settle();
    await view.data.openTask('t1');
    api.fetchTask.mockResolvedValueOnce(fail('not-found'));
    await view.data.refresh();
    view.rerender();
    expect(view.data.selectedTaskId).toBeNull();
    expect(view.data.detail).toBeNull();
    expect(view.data.notice).toContain('bulunamıyor');
    view.unmount();
  });

  it('gorev panodan kaybolursa cekmece kapanir ve bildirim gelir', async () => {
    const view = mountData(true);
    await settle();
    await view.data.openTask('t1');
    api.fetchBoard.mockResolvedValueOnce(ok(board('baska')));
    await view.data.refresh();
    view.rerender();
    expect(view.data.selectedTaskId).toBeNull();
    expect(view.data.notice).toContain('bulunamıyor');
    view.unmount();
  });

  it('closeTask bekleyen detay cevabini gecersiz kilar', async () => {
    const view = mountData(true);
    await settle();
    const slow = deferred<MissionResult<TaskDetail>>();
    api.fetchTask.mockReturnValueOnce(slow.promise);
    const opening = view.data.openTask('t1');
    view.data.closeTask();
    slow.resolve(ok(detail('t1')));
    await opening;
    view.rerender();
    expect(view.data.detail).toBeNull();
    expect(view.data.selectedTaskId).toBeNull();
    view.unmount();
  });

  it('pano gizlenirse acik cekmece birakilir (gorunmeyen modal sayfayi kilitler)', async () => {
    const view = mountData(true);
    await settle();
    await view.data.openTask('t1');
    view.rerender();
    expect(view.data.detail?.task.id).toBe('t1');

    view.setAktif(false);
    view.rerender();
    expect(view.data.selectedTaskId).toBeNull();
    expect(view.data.detail).toBeNull();
    view.unmount();
  });

  it('bildirim kapatilabilir', async () => {
    const view = mountData(true);
    await settle();
    api.fetchTask.mockResolvedValueOnce(fail('not-found'));
    await view.data.openTask('t1');
    view.rerender();
    expect(view.data.notice).not.toBeNull();
    view.data.dismissNotice();
    view.rerender();
    expect(view.data.notice).toBeNull();
    view.unmount();
  });
});
