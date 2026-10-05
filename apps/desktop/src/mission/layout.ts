import type { Agent, Board, SurfaceState, Task } from './api.js';

/**
 * Panonun SAF yerlesim mantigi. React'ten ayri tutuldu cunku iki islev de
 * sessizce yanlis olabilecek turden: org semasi bir dongude sonsuza gider,
 * kolon gruplama bilinmeyen bir durumu YUTAR ve gorev panodan kaybolur.
 * Ikisi de gorsel olarak "calisiyor" gibi gorunur — bu yuzden testlidir.
 *
 * Etiket, maliyet ve yuzey-durumu yardimcilari da burada: hepsi saf oldugu icin
 * tarayicisiz test edilir (bu pakette DOM test ortami yok).
 */

/** Kanban kolon sirasi. Sunucudaki durum kumesiyle ayni (status.ts). */
export const COLUMNS = ['inbox', 'assigned', 'in_progress', 'review', 'done', 'blocked'] as const;

export const COLUMN_LABELS: Record<string, string> = {
  inbox: 'Gelen',
  assigned: 'Atandı',
  in_progress: 'Sürüyor',
  review: 'İnceleme',
  done: 'Bitti',
  blocked: 'Engel',
};

export interface OrgNode {
  agent: Agent;
  children: OrgNode[];
  depth: number;
}

/**
 * Duz ajan listesinden org semasi agaci kurar.
 *
 * Uc savunma:
 *  - Bilinmeyen `parentId` (silinmis ust) → kok kabul edilir, ajan KAYBOLMAZ.
 *  - Dongu (a→b→a) → dongude kalanlar kok olarak cizilir; sonsuz ozyineleme yok.
 *    Sunucu tarafi kendi ustu olmayi reddediyor ama uzun zincirli dongu hala
 *    kurulabilir; pano buna dayanikli olmak zorunda.
 *  - Sira kararli: role, sonra slug.
 */
export function buildOrg(agents: Agent[]): OrgNode[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const sorted = [...agents].sort(
    (a, b) => a.role.localeCompare(b.role) || a.slug.localeCompare(b.slug),
  );

  /** Bu ajanin ustu, gercekten koke ulasan bir zincirde mi? */
  const rootReachable = (agent: Agent): boolean => {
    const seen = new Set<string>([agent.id]);
    let current = agent.parentId ? byId.get(agent.parentId) : undefined;
    while (current) {
      if (seen.has(current.id)) return false; // dongu
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return true;
  };

  const nodes = new Map<string, OrgNode>(
    sorted.map((agent) => [agent.id, { agent, children: [], depth: 0 }]),
  );
  const roots: OrgNode[] = [];

  for (const agent of sorted) {
    const node = nodes.get(agent.id);
    if (!node) continue;
    const parent = agent.parentId ? nodes.get(agent.parentId) : undefined;
    if (!parent || !rootReachable(agent)) {
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  const setDepth = (node: OrgNode, depth: number): void => {
    node.depth = depth;
    for (const child of node.children) setDepth(child, depth + 1);
  };
  for (const root of roots) setDepth(root, 0);
  return roots;
}

/** Agaci yukaridan asagiya duz listeye acar (SVG cizimi icin). */
export function flattenOrg(roots: OrgNode[]): OrgNode[] {
  const out: OrgNode[] = [];
  const walk = (node: OrgNode): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

/**
 * Org semasi olculeri (px). Derinlik YATAYDA kucuk bir girintiyle gosterilir:
 * her seviyeye tam kutu genisligi ayirmak sema yan paneli tasirir ve ast
 * ajanlari gorunur alanin disina iter (olculdu: 3 seviye = 588 px, panel 250 px).
 */
export const ORG = { nodeWidth: 176, nodeHeight: 44, row: 54, indent: 24, pad: 8 } as const;

export interface OrgLayout {
  width: number;
  height: number;
  nodes: Array<{ agent: Agent; x: number; y: number }>;
  /** Ust ile ast arasinda dirsek cizgi: asagi in, sonra saga git. */
  edges: Array<{ key: string; path: string }>;
}

/** Ajan listesinden SVG yerlesimini uretir: x = derinlik girintisi, y = agac sirasinda satir. */
export function layoutOrg(agents: Agent[]): OrgLayout {
  const flat = flattenOrg(buildOrg(agents));
  const rowOf = new Map(flat.map((node, index) => [node.agent.id, index]));
  const place = (node: OrgNode): { x: number; y: number } => ({
    x: ORG.pad + node.depth * ORG.indent,
    y: ORG.pad + (rowOf.get(node.agent.id) ?? 0) * ORG.row,
  });
  const maxDepth = flat.reduce((max, node) => Math.max(max, node.depth), 0);

  return {
    width: ORG.pad * 2 + ORG.nodeWidth + maxDepth * ORG.indent,
    height: ORG.pad * 2 + Math.max(flat.length - 1, 0) * ORG.row + ORG.nodeHeight,
    nodes: flat.map((node) => ({ agent: node.agent, ...place(node) })),
    edges: flat.flatMap((parent) =>
      parent.children.map((child) => {
        const from = place(parent);
        const to = place(child);
        return {
          key: `${parent.agent.id}-${child.agent.id}`,
          path: `M ${from.x + 14} ${from.y + ORG.nodeHeight} V ${to.y + ORG.nodeHeight / 2} H ${to.x}`,
        };
      }),
    ),
  };
}

/**
 * Gorevleri kolonlara dagitir.
 *
 * BILINMEYEN DURUM YUTULMAZ: tanimli kolona girmeyen gorev `blocked` kolonuna
 * dusurulur ve boylece ekranda gorunur kalir. Sessizce kaybolmasi, panonun
 * "her sey yolunda" yalani soylemesi olurdu.
 */
export function groupByStatus(tasks: Task[]): Record<string, Task[]> {
  const columns: Record<string, Task[]> = {};
  for (const name of COLUMNS) columns[name] = [];
  for (const task of tasks) {
    const bucket = columns[task.status] ?? columns.blocked;
    bucket?.push(task);
  }
  for (const name of COLUMNS) {
    columns[name]?.sort(
      (a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  return columns;
}

/** Toplam kosu maliyeti (micros → USD metni). */
export function formatCost(micros: number | null | undefined): string {
  if (!micros) return '0.0000';
  return (micros / 1_000_000).toFixed(4);
}

/** "3 dk once" gibi kisa bagil zaman; akis ve nabiz gostergesi kullanir. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds} sn`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} dk`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} sa`;
  return `${Math.round(hours / 24)} gün`;
}

/** Uzun metni `max` karaktere indirir (SVG metni kirpmaz, kutunun disina tasar). */
export function ellipsize(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(max - 1, 0)).trimEnd()}…`;
}

/** "3 dk once" metni; zaman bilinmiyorsa "bilinmiyor". */
export function relativeAgo(iso: string | null, now: number = Date.now()): string {
  const text = relativeTime(iso, now);
  return text === relativeTime(null) ? 'bilinmiyor' : `${text} önce`;
}

/** Kosularin toplam maliyeti (micros). */
export function sumCost(runs: Array<{ costMicros: number | null }>): number {
  return runs.reduce((total, run) => total + (run.costMicros ?? 0), 0);
}

/** Yerel takvim gununde baslayan kosularin maliyeti (micros). */
export function sumTodayCost(
  runs: Array<{ startedAt: string; costMicros: number | null }>,
  now: number = Date.now(),
): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return sumCost(
    runs.filter((run) => {
      const startedAt = new Date(run.startedAt).getTime();
      return (
        Number.isFinite(startedAt) && startedAt >= start.getTime() && startedAt < end.getTime()
      );
    }),
  );
}

const AGENT_STATUS_LABELS: Record<string, string> = {
  idle: 'Boşta',
  working: 'Çalışıyor',
  offline: 'Devre dışı',
};

/** Ajan durumunun kullanici metni; bilinmeyen deger oldugu gibi gosterilir. */
export function agentStatusLabel(status: string): string {
  return AGENT_STATUS_LABELS[status] ?? status;
}

/** Yorum yazarinin kullanici metni (`authorType`: user | agent | system). */
export function authorLabel(
  authorType: string,
  authorId: string,
  slugOf: ReadonlyMap<string, string>,
): string {
  if (authorType === 'agent') return `@${slugOf.get(authorId) ?? 'ajan'}`;
  if (authorType === 'user') return 'Sen';
  if (authorType === 'system') return 'Sistem';
  return authorType;
}

/** Pano verisinde ne ekip ne gorev ne olay var mi? (gercek bos durum) */
export function isBoardEmpty(board: Board): boolean {
  return board.agents.length === 0 && board.tasks.length === 0 && board.events.length === 0;
}

/**
 * Pano durumunu alt yuzeye indirger. Veri gelmisse (`ready`/`empty`) ayrimi alt
 * yuzeyin kendi icerigi belirler; `loading`/`stale`/`error` oldugu gibi gecer.
 */
export function surfaceOf(state: SurfaceState, empty: boolean): SurfaceState {
  if (state === 'ready' || state === 'empty') return empty ? 'empty' : 'ready';
  return state;
}

/** Eski async cevaplarin daha yeni state'i ezmesini engelleyen monoton kapi. */
export function createRequestGate(): {
  next: () => number;
  invalidate: () => void;
  isCurrent: (requestId: number) => boolean;
} {
  let current = 0;
  return {
    next: () => ++current,
    invalidate: () => {
      current += 1;
    },
    isCurrent: (requestId) => requestId === current,
  };
}
