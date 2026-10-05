import { expect, vi, type Mock } from 'vitest';
import type * as React from 'react';

/**
 * Hook ve bilesen testlerinin TEK node surucusu (yalniz `*.test` dosyalari ice
 * aktarir). Bu pakette jsdom, happy-dom ya da testing-library YOKTUR ve
 * eklenmez: hook'lar node ortaminda kendi state/effect surucusuyle calistirilir.
 * GERCEK olan: hook'un olay isleyicileri, komut akisi ve yaris korumalari.
 * SAHTE olan: React'in zamanlayicisi ile Tauri siniri (`invoke`/`listen`).
 *
 * Uc parca:
 *  1. Surucu: `mount(run)` + `reactWithHost`. Her ornegin KENDI slot dizisi
 *     vardir; `render()` hook'lari bu ornege baglar ve sonucu doner. Eslenik bir
 *     render dongusu YOKTUR: state degisince test `render()`i kendisi cagirir,
 *     efektler `flush()` ile kosar (bagimlilik karsilastirmasi ve temizleme dahil).
 *  2. Tauri siniri: `host.invoke`, `listen`, `emit`, `installHost`, `removeHost`
 *     ve bunlarin ustunde `hookRunner` (mount + tek hook).
 *  3. Eleman agaci yardimcilari: render sonucunu gezmek icin (`find`, `button`...)
 *     ve yerel `<dialog>` taklidi (`fakeDialog`).
 *
 * `react` bu dosyada DEGER olarak import EDILMEZ: mock fabrikasi bu dosyayi
 * yuklerken `react`e ihtiyac duyarsa dairesel bekleme olusur.
 *
 * Kullanim: `vi.mock` hoist edilir. React'i degistirmek icin fabrika icinde tembel
 * import yeterlidir:
 *
 *   vi.mock('react', async (original) =>
 *     (await import('./hookTestHost.js')).reactWithHost(await original<typeof React>()));
 *
 * Tauri sinirini da sahtelemek gerekiyorsa yardimci modul `vi.hoisted` ile
 * yuklenir ve fabrikalar ona SENKRON basvurur (tembel import yarisirsa ikinci
 * hook gercek `@tauri-apps/api` modulunu gorur):
 *
 *   const t = await vi.hoisted(() => import('./hookTestHost.js'));
 *   vi.mock('react', async (original) => t.reactWithHost(await original<typeof React>()));
 *   vi.mock('@tauri-apps/api/core', () => ({ invoke: t.host.invoke }));
 *   vi.mock('@tauri-apps/api/event', () => ({ listen: t.listen }));
 */

/* --- 1. surucu: state / efekt / bellek ------------------------------------- */

interface EffectSlot {
  deps: readonly unknown[] | undefined;
  cleanup: void | (() => void);
}

interface MemoSlot {
  deps: readonly unknown[] | undefined;
  value: unknown;
}

export interface Mounted<T> {
  /** Hook'lari bu ornege baglayarak `run`i bir kez kosar ve sonucunu doner. */
  render: () => T;
  /** Bekleyen efektleri (once eski temizleme, sonra yenisi) sirayla kosar. */
  flush: () => void;
  /** Tum efekt temizlemelerini kosar. */
  unmount: () => void;
}

interface Instance {
  slots: unknown[];
  cursor: number;
  pending: Array<() => void>;
  effects: EffectSlot[];
}

let active: Instance | null = null;

function current(): Instance {
  if (!active) throw new Error('hook, hookTestHost.mount() disinda cagrildi');
  return active;
}

function changed(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (!previous || !next) return true;
  return previous.length !== next.length || next.some((dep, i) => !Object.is(dep, previous[i]));
}

function hostState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
  const instance = current();
  const index = instance.cursor++;
  if (!(index in instance.slots)) {
    instance.slots[index] = {
      value: typeof initial === 'function' ? (initial as () => S)() : initial,
    };
  }
  const box = instance.slots[index] as { value: S };
  return [
    box.value,
    (next) => {
      box.value = typeof next === 'function' ? (next as (prev: S) => S)(box.value) : next;
    },
  ];
}

function hostRef<T>(initial: T): { current: T } {
  const instance = current();
  const index = instance.cursor++;
  if (!(index in instance.slots)) instance.slots[index] = { current: initial };
  return instance.slots[index] as { current: T };
}

function hostMemo<T>(factory: () => T, deps?: readonly unknown[]): T {
  const instance = current();
  const index = instance.cursor++;
  const slot = instance.slots[index] as MemoSlot | undefined;
  if (slot && !changed(slot.deps, deps)) return slot.value as T;
  const value = factory();
  instance.slots[index] = { deps, value } satisfies MemoSlot;
  return value;
}

/** Kararli, ornege ozgu kimlik (`useId` yerine). */
function hostId(): string {
  const instance = current();
  const index = instance.cursor++;
  if (!(index in instance.slots)) instance.slots[index] = `:h${index}:`;
  return instance.slots[index] as string;
}

/** Abonelik yok: her render guncel anlik goruntuyu okur (state degisince test `render()` cagirir). */
function hostSyncStore<T>(
  _subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
): T {
  return getSnapshot();
}

function hostCallback<T>(callback: T, deps?: readonly unknown[]): T {
  return hostMemo(() => callback, deps);
}

function hostEffect(create: () => void | (() => void), deps?: readonly unknown[]): void {
  const instance = current();
  const index = instance.cursor++;
  const slot = (instance.slots[index] as EffectSlot | undefined) ?? {
    deps: undefined,
    cleanup: undefined,
  };
  const first = !(index in instance.slots);
  instance.slots[index] = slot;
  instance.effects.push(slot);
  if (!first && !changed(slot.deps, deps)) return;
  instance.pending.push(() => {
    if (typeof slot.cleanup === 'function') slot.cleanup();
    slot.deps = deps;
    slot.cleanup = create();
  });
}

export function mount<T>(run: () => T): Mounted<T> {
  const instance: Instance = { slots: [], cursor: 0, pending: [], effects: [] };
  return {
    render: () => {
      const previous = active;
      active = instance;
      instance.cursor = 0;
      instance.effects = [];
      try {
        return run();
      } finally {
        active = previous;
      }
    },
    flush: () => {
      const jobs = instance.pending.splice(0);
      for (const job of jobs) job();
    },
    unmount: () => {
      for (const slot of instance.effects) {
        if (typeof slot.cleanup === 'function') slot.cleanup();
        slot.cleanup = undefined;
      }
    },
  };
}

/** `react` modulunu surucuyle degistirilmis hook'larla doner (vi.mock fabrikasi icin). */
export function reactWithHost(original: typeof React): typeof React {
  return {
    ...original,
    useState: hostState,
    useRef: hostRef,
    useMemo: hostMemo,
    useCallback: hostCallback,
    useEffect: hostEffect,
    useId: hostId,
    useSyncExternalStore: hostSyncStore,
  } as typeof React;
}

/* --- 2. Tauri siniri -------------------------------------------------------- */

type Listener = (event: { payload: unknown }) => void;

interface Host {
  listeners: Map<string, Listener>;
  /** `@tauri-apps/api/core.invoke` taklidi: testler cevabini belirler. */
  invoke: Mock<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>;
}

export const host: Host = {
  listeners: new Map(),
  invoke: vi.fn(),
};

/** Dinleyiciyi kaydeder, birakma islevi doner (`@tauri-apps/api/event.listen` taklidi). */
export function defaultListen(name: string, listener: Listener): Promise<() => void> {
  host.listeners.set(name, listener);
  return Promise.resolve(() => {
    host.listeners.delete(name);
  });
}

/** Testler `mockImplementationOnce` ile belirli bir dinleyiciyi geciktirebilir ya da reddedebilir. */
export const listen = vi.fn(defaultListen);

/** Tauri'li pencere ortami: sahte zamanlayicilar, `__TAURI_INTERNALS__` ve temiz host durumu. */
export function installHost(extraWindow: Record<string, unknown> = {}): void {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    __TAURI_INTERNALS__: {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...extraWindow,
  });
  host.listeners.clear();
  host.invoke.mockReset();
  listen.mockReset();
  listen.mockImplementation(defaultListen);
}

export function removeHost(): void {
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

/** Bekleyen dinamik import ve promise zincirlerinin bitmesini bekler. */
export async function settle(rounds = 100): Promise<void> {
  await vi.dynamicImportSettled();
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Kayitli dinleyiciye Rust olayi gonderir; dinleyici yoksa test kirilir. */
export function emit(name: string, payload: unknown): void {
  const listener = host.listeners.get(name);
  expect(listener, name).toBeDefined();
  listener?.({ payload });
}

export interface HookRunner<T> {
  /** Hook'u yeniden calistirir ve guncel degeri doner (React'in render'i gibi). */
  render: () => T;
  /** Temiz durumdan mount eder: efektleri calistirir ve promise'lerin bitmesini bekler. */
  mount: () => Promise<void>;
  /** Mount'tan kalan efekt temizleyicilerini calistirir. */
  unmount: () => void;
}

export function hookRunner<T>(hookUnderTest: () => T): HookRunner<T> {
  let view: Mounted<T> | null = null;
  const mounted = (): Mounted<T> => {
    if (!view) throw new Error('hook henuz mount edilmedi');
    return view;
  };
  return {
    render: () => mounted().render(),
    async mount() {
      view = mount(hookUnderTest);
      view.render();
      view.flush();
      await settle();
    },
    unmount() {
      view?.unmount();
    },
  };
}

/* --- 3. eleman agaci yardimcilari (render sonucunu gezmek icin) --------------- */

/** Yerel `<dialog>` taklidi: `ref.current`e atanir, `close` olayini testler `emit` ile tetikler. */
export function fakeDialog() {
  const listeners = new Map<string, Array<() => void>>();
  const dialog = {
    open: false,
    showModal: vi.fn(() => {
      dialog.open = true;
    }),
    // Tarayici `close` olayini kapanistan SONRA ve asenkron ateser; test emit ile taklit eder.
    close: vi.fn(() => {
      dialog.open = false;
    }),
    addEventListener: (type: string, callback: () => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), callback]);
    },
    removeEventListener: (type: string, callback: () => void) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((item) => item !== callback),
      );
    },
    emit: (type: string) => (listeners.get(type) ?? []).forEach((callback) => callback()),
    listenerCount: (type: string) => (listeners.get(type) ?? []).length,
  };
  return dialog;
}

export interface TreeElement {
  type: unknown;
  props: Record<string, unknown>;
}

function isElement(node: unknown): node is TreeElement {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

/** Agaci (dizi, fragment, cocuklar) gezip `predicate`e uyan elemanlari doner. */
export function findAll(
  node: unknown,
  predicate: (element: TreeElement) => boolean,
): TreeElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
  if (!isElement(node)) return [];
  const own = predicate(node) ? [node] : [];
  return [...own, ...findAll(node.props.children, predicate)];
}

export function find(node: unknown, predicate: (element: TreeElement) => boolean): TreeElement {
  const [first] = findAll(node, predicate);
  if (!first) throw new Error('eleman bulunamadi');
  return first;
}

/** Elemanin altindaki duz metin (dizi ve sayilar birlestirilir). */
export function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isElement(node)) return textOf(node.props.children);
  return '';
}

/** `type` ve (varsa) metne gore bul: ornegin button + "Yorumu gönder". */
export function byText(type: string, text: string): (element: TreeElement) => boolean {
  return (element) => element.type === type && textOf(element).includes(text);
}

/** Etiket metniyle bulunan alan (`<label><span>Etiket</span><input/></label>`): input/select/textarea. */
export function control(tree: unknown, labelText: string): TreeElement {
  const label = find(tree, byText('label', labelText));
  return find(label, (element) => ['input', 'select', 'textarea'].includes(String(element.type)));
}

/** Metne gore dugme; bulunamazsa hata (testin yanlis dugmeye basmasini onler). */
export function button(tree: unknown, text: string): TreeElement {
  return find(tree, byText('button', text));
}

/** Bir elemanin olay isleyicisini cagirir (React'in sentetik olayini taklit eder). */
export function fire(element: TreeElement, handler: string, event: unknown = {}): void {
  const fn = element.props[handler];
  if (typeof fn !== 'function') throw new Error(`${handler} isleyicisi yok`);
  (fn as (event: unknown) => void)(event);
}
