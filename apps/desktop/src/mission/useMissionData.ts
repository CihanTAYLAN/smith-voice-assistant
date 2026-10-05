import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchBoard,
  fetchTask,
  type Board,
  type MissionResult,
  type MutationResult,
  type SurfaceState,
  type TaskDetail,
} from './api.js';
import { createRequestGate, isBoardEmpty } from './layout.js';

/**
 * MISSION CONTROL VERI KATMANI (ADR 0007).
 *
 * TAZELEME POLLING, WS DEGIL: `@smith/protocol` sohbet sozlesmesidir ve pano
 * icin frame eklemek istemiyoruz (kirmizi cizgi: geriye donuk uyumluluk).
 * 4 saniyelik anket bir kanban icin fazlasiyla yeterli. Anket YALNIZ `aktif`
 * iken ve belge gorunurken calisir: Dashboard bolumleri mount'lu kalip CSS ile
 * gizlendigi icin `document.hidden` tek basina yetmez, bolumun gorunurlugu
 * disaridan gelir. Gizli pano arka planda bosa istek atmaz.
 *
 * YARIS KORUMASI: her istek monoton bir kapidan gecer; `aktif` kapanirsa ya da
 * daha yeni bir istek baslarsa eski cevap state'e yazilmaz. Pano yenilemesi
 * tek-ucustur (anket, gorunurluk olayi ve elle yenileme ayni istege katilir).
 * Mutasyondan sonraki yenileme ise (`fresh`) onceki ucustaki istegin cevabini
 * gecersiz kilar: yazmadan ONCE baslamis bir istegin bayat cevabi ekrana donmez.
 *
 * HATA GORUNUR: baglanti hatasi MEVCUT VERIYI SILMEZ (`stale`); elde veri yoksa
 * `error`. Mutasyon hatasi burada tutulmaz: `mutate` sonucu cagirana doner ve
 * eylemin yuzeyinde gosterilir (kipli pencere acikken sayfa bandi gorunmez).
 */

export const REFRESH_MS = 4000;

const TASK_GONE = 'Seçili görev artık bulunamıyor. Görev detayı kapatıldı.';

type DetailState = 'loading' | 'ready' | 'stale';

export interface MissionData {
  board: Board | null;
  boardState: SurfaceState;
  /** Son pano yenilemesinin hatasi; basarili yenilemede temizlenir. */
  connectionError: string | null;
  /** Sistem kaynakli bilgi (ornegin secili gorev kayboldu); kullanici kapatana dek kalir. */
  notice: string | null;
  dismissNotice: () => void;
  detail: TaskDetail | null;
  /** `loading`: secim yapildi, detay gelmedi; `stale`: son bilinen detay, yenileme basarisiz. */
  detailState: DetailState;
  detailError: string | null;
  selectedTaskId: string | null;
  /** Bir mutasyon suruyor; eylem dugmeleri bu sirada kapanir. */
  busy: boolean;
  refresh: () => Promise<void>;
  openTask: (taskId: string) => Promise<void>;
  closeTask: () => void;
  retryDetail: () => Promise<void>;
  /** Tek-ucustur: baska mutasyon suruyorsa `null`. Basarida panoyu taze ceker. */
  mutate: <T>(action: () => Promise<MissionResult<T>>) => Promise<MutationResult<T>>;
}

export function useMissionData(aktif: boolean): MissionData {
  const [board, setBoard] = useState<Board | null>(null);
  const [boardState, setBoardState] = useState<SurfaceState>('loading');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailState, setDetailState] = useState<DetailState>('loading');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Async kod, render'dan bagimsiz EN GUNCEL degeri ref'ten okur; state yalniz cizim icin.
  const live = useRef(false);
  const boardRef = useRef<Board | null>(null);
  const detailRef = useRef<TaskDetail | null>(null);
  const selectedRef = useRef<string | null>(null);
  const boardGate = useRef(createRequestGate());
  const detailGate = useRef(createRequestGate());
  const boardInFlight = useRef<Promise<void> | null>(null);
  const mutating = useRef(false);

  const select = useCallback((taskId: string | null): void => {
    selectedRef.current = taskId;
    setSelectedTaskId(taskId);
  }, []);

  const showDetail = useCallback((next: TaskDetail | null): void => {
    detailRef.current = next;
    setDetail(next);
  }, []);

  /** Secimi ve cekmeceyi birakir; `message` varsa kullaniciya sebep gosterilir. */
  const clearSelection = useCallback(
    (message: string | null): void => {
      detailGate.current.invalidate();
      select(null);
      showDetail(null);
      setDetailError(null);
      if (message) setNotice(message);
    },
    [select, showDetail],
  );

  const refreshDetail = useCallback(
    async (taskId: string): Promise<void> => {
      const requestId = detailGate.current.next();
      const result = await fetchTask(taskId);
      if (
        !live.current ||
        !detailGate.current.isCurrent(requestId) ||
        selectedRef.current !== taskId
      ) {
        return;
      }
      if (result.ok) {
        showDetail(result.value);
        setDetailState('ready');
        setDetailError(null);
        return;
      }
      if (result.code === 'not-found') {
        clearSelection(TASK_GONE);
        return;
      }
      if (!detailRef.current) {
        // Acilis hic tamamlanmadi: cekmece yok, bekleyen secimi birak.
        clearSelection(result.error);
        return;
      }
      setDetailError(result.error);
      setDetailState('stale');
    },
    [clearSelection, showDetail],
  );

  const load = useCallback(
    (fresh = false): Promise<void> => {
      if (!live.current) return Promise.resolve();
      if (boardInFlight.current && !fresh) return boardInFlight.current;

      const requestId = boardGate.current.next();
      if (!boardRef.current) setBoardState((state) => (state === 'error' ? state : 'loading'));

      const request = (async (): Promise<void> => {
        const result = await fetchBoard();
        if (!live.current || !boardGate.current.isCurrent(requestId)) return;

        if (!result.ok) {
          setConnectionError(result.error);
          setBoardState(boardRef.current ? 'stale' : 'error');
          if (detailRef.current) {
            setDetailError(result.error);
            setDetailState('stale');
          }
          return;
        }

        boardRef.current = result.value;
        setBoard(result.value);
        setConnectionError(null);
        setBoardState(isBoardEmpty(result.value) ? 'empty' : 'ready');

        const taskId = selectedRef.current;
        if (!taskId) return;
        if (!result.value.tasks.some((task) => task.id === taskId)) {
          clearSelection(TASK_GONE);
          return;
        }
        await refreshDetail(taskId);
      })();

      boardInFlight.current = request;
      void request.finally(() => {
        if (boardInFlight.current === request) boardInFlight.current = null;
      });
      return request;
    },
    [clearSelection, refreshDetail],
  );

  useEffect(() => {
    if (!aktif) {
      // Gizli bolumde kipli cekmece acik KALAMAZ: gorunmeyen bir modal dialog sayfanin
      // geri kalanini inert tutar.
      clearSelection(null);
      return;
    }
    live.current = true;
    void load();

    const tick = (): void => {
      if (!document.hidden) void load();
    };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);

    return () => {
      // `live` kapaninca bekleyen cevaplar yazilmaz; tek-ucus kaydi da birakilir ki
      // yeniden acilista bayat bir istege katilmak yerine taze istek atilsin.
      live.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      boardInFlight.current = null;
    };
  }, [aktif, clearSelection, load]);

  const openTask = useCallback(
    async (taskId: string): Promise<void> => {
      if (!live.current) return;
      setNotice(null);
      setDetailError(null);
      setDetailState('loading');
      select(taskId);

      const requestId = detailGate.current.next();
      const result = await fetchTask(taskId);
      if (!live.current || !detailGate.current.isCurrent(requestId)) return;
      if (result.ok) {
        showDetail(result.value);
        setDetailState('ready');
        return;
      }
      clearSelection(result.error);
    },
    [clearSelection, select, showDetail],
  );

  const closeTask = useCallback((): void => clearSelection(null), [clearSelection]);

  const retryDetail = useCallback(async (): Promise<void> => {
    const taskId = selectedRef.current;
    if (taskId) await refreshDetail(taskId);
  }, [refreshDetail]);

  const mutate = useCallback(
    async <T>(action: () => Promise<MissionResult<T>>): Promise<MutationResult<T>> => {
      if (mutating.current) return null;
      mutating.current = true;
      setBusy(true);
      try {
        const result = await action();
        if (result.ok) await load(true);
        return result;
      } finally {
        mutating.current = false;
        setBusy(false);
      }
    },
    [load],
  );

  const refresh = useCallback((): Promise<void> => load(), [load]);
  const dismissNotice = useCallback((): void => setNotice(null), []);

  return {
    board,
    boardState,
    connectionError,
    notice,
    dismissNotice,
    detail,
    detailState,
    detailError,
    selectedTaskId,
    busy,
    refresh,
    openTask,
    closeTask,
    retryDetail,
    mutate,
  };
}
