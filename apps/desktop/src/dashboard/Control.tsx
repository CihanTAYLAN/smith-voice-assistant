import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Badge, Group, Progress, Stack, Text } from '@mantine/core';
import { Plasma, type Offset } from '@cruxgarden/plasma-ui';

import { clearDeckLayout, loadDeckLayout, saveDeckOffset } from '../plasma/deck.js';
import {
  engines,
  missionSummary,
  runUsage,
  type EngineStatus,
  type EngineUsage,
  type MissionSummary,
  type RunUsageSummary,
} from './api.js';
import {
  CARDS,
  clampOffset,
  defaultOffsets,
  isFreeLayout,
  MIN_VISIBLE_HEIGHT,
  type CardId,
  type FieldSize,
} from './controlLayout.js';
import { COLUMN_LABELS } from '../mission/layout.js';
import { Empty, LoadView } from './LoadView.js';
import { useLoadable, type LoadState } from './loadable.js';

/**
 * KONTROL — is gucu, kullanim ve bekleyen is tek ekranda.
 *
 * Uc kart BAGIMSIZ yuklenir (yavas olan digerini bekletmez); her biri kendi
 * yukleniyor/hata/bayat durumunu gosterir. Yerlesim iki kipli: alan varsayilan
 * iki kolonu tasiyorsa kartlar SERBEST suruklenir (konum `localStorage`da,
 * alana sigdirilarak okunur); dar pencerede tek akiskan izgara — kesilen kart yok.
 */

const CARD_GAP_BELOW = 8;

/** Gizli bolum 0x0 olcer; o durumda son bilinen boyut korunur. */
function useFieldSize(ref: React.RefObject<HTMLDivElement | null>): FieldSize | null {
  const [size, setSize] = useState<FieldSize | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = (): void => {
      const { clientWidth: width, clientHeight: height } = node;
      if (width === 0 || height === 0) return;
      setSize((previous) =>
        previous?.width === width && previous.height === height ? previous : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function lastRead(states: LoadState<unknown>[]): number | null {
  const times = states.flatMap((state) =>
    state.status === 'ready' || state.status === 'stale' ? [state.at] : [],
  );
  return times.length > 0 ? Math.max(...times) : null;
}

export function Control(): React.JSX.Element {
  const engineList = useLoadable(engines);
  const usage = useLoadable(runUsage);
  const summary = useLoadable(missionSummary);
  const sources = [engineList, usage, summary];
  const refreshing = sources.some((source) => source.refreshing);
  const readAt = lastRead(sources.map((source) => source.state));

  const fieldRef = useRef<HTMLDivElement>(null);
  const field = useFieldSize(fieldRef);
  const free = field !== null && isFreeLayout(field);
  const [saved, setSaved] = useState(() => defaultOffsets(loadDeckLayout()));

  const moveCard = (id: CardId, offset: Offset): void => {
    saveDeckOffset(id, offset);
    setSaved((previous) => ({ ...previous, [id]: offset }));
  };
  const resetLayout = (): void => {
    clearDeckLayout();
    setSaved(defaultOffsets());
  };

  const freeLayout = free && field ? { bounds: fieldRef, field, saved, onMove: moveCard } : null;

  return (
    <div className="wk">
      <Plasma as="header" fuse={false} lean={false} radius={12} className="wk-bar">
        <span className="wk-title">Çalışma özeti</span>
        {readAt ? (
          <span className="wk-meta">son okuma {new Date(readAt).toLocaleTimeString('tr-TR')}</span>
        ) : null}
        <span className="wk-spacer" />
        <button
          type="button"
          className="db-btn"
          disabled={refreshing}
          onClick={() => sources.forEach((source) => void source.reload(true))}
        >
          {refreshing ? 'okunuyor…' : 'yenile'}
        </button>
        {free ? (
          <button
            type="button"
            className="db-btn"
            onClick={resetLayout}
            title="Kartları varsayılan düzene getir"
          >
            yerleşimi sıfırla
          </button>
        ) : null}
      </Plasma>

      <div className="wk-field" ref={fieldRef} data-layout={free ? 'free' : 'grid'}>
        <WorkspaceCard
          id="engines"
          layout={freeLayout}
          title="İş gücü"
          hint="Bu cihazdaki motorlar ve bağlantı durumları."
        >
          <LoadView state={engineList.state} onRetry={() => void engineList.reload(true)}>
            {(list) => <EnginesBody list={list} />}
          </LoadView>
        </WorkspaceCard>

        <WorkspaceCard
          id="usage"
          layout={freeLayout}
          title="Kullanım"
          hint={
            usage.state.status === 'ready' || usage.state.status === 'stale'
              ? `Son ${usage.state.data.sampled} koşunun çalışma özeti.`
              : 'Motor başına koşu, sonuç ve token kullanımı.'
          }
        >
          <LoadView state={usage.state} onRetry={() => void usage.reload(true)}>
            {(data) => <UsageBody usage={data} />}
          </LoadView>
        </WorkspaceCard>

        <WorkspaceCard
          id="pending"
          layout={freeLayout}
          title="Görev durumu"
          hint="Panondaki işler ve dikkat bekleyen görevler."
        >
          <LoadView state={summary.state} onRetry={() => void summary.reload(true)}>
            {(data) => <PendingBody summary={data} />}
          </LoadView>
        </WorkspaceCard>
      </div>
    </div>
  );
}

interface FreeLayout {
  bounds: React.RefObject<HTMLDivElement | null>;
  field: FieldSize;
  saved: Record<CardId, Offset>;
  onMove: (id: CardId, offset: Offset) => void;
}

/**
 * Plazma karti. `layout` varsa SERBEST kip: kontrollu `offset` (pencere
 * degisince yeni konuma yaylanir, yeniden mount edilmez) ve surukleme; yoksa
 * izgara hucresi. Kip degisince `key` karti temiz mount eder.
 */
function WorkspaceCard({
  id,
  layout,
  title,
  hint,
  children,
}: {
  id: CardId;
  layout: FreeLayout | null;
  title: string;
  hint: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const titleId = useId();
  const offset = layout ? clampOffset(id, layout.saved[id], layout.field) : null;
  const freeProps =
    layout && offset
      ? {
          draggable: true,
          bounds: layout.bounds,
          offset,
          style: {
            width: CARDS[id].width,
            maxHeight: Math.max(
              MIN_VISIBLE_HEIGHT,
              layout.field.height - offset.y - CARD_GAP_BELOW,
            ),
          },
        }
      : {};
  return (
    <Plasma
      key={`${id}-${layout ? 'free' : 'grid'}`}
      as="section"
      aria-labelledby={titleId}
      data-card={id}
      {...freeProps}
      onDragEnd={(settled) => layout?.onMove(id, settled)}
      fuse={false}
      radius={18}
      elevation={0.4}
      className="wk-card"
    >
      <header className="wk-card-head">
        <h3 id={titleId}>{title}</h3>
        <p>{hint}</p>
      </header>
      {/* Govde surukleme DISI: metin secimi ve kaydirma calisir; kart yalniz
          basligindan (ve kenar bosluklarindan) tasinir. plasma-ui NO_DRAG. */}
      <div className="wk-card-body" data-plasma-nodrag>
        {children}
      </div>
    </Plasma>
  );
}

function EnginesBody({ list }: { list: EngineStatus[] }): React.JSX.Element {
  if (list.length === 0) return <Empty title="Motor kaydı yok." />;
  return (
    <Stack gap="xs">
      {list.map((item) => (
        <EngineRow key={`${item.id}-${item.host}`} status={item} />
      ))}
    </Stack>
  );
}

function UsageBody({ usage }: { usage: RunUsageSummary }): React.JSX.Element {
  if (usage.totals.runs === 0) {
    return <Empty title="Kayıtlı koşu yok.">Bir görevi bir ajana ata; koşu burada birikir.</Empty>;
  }
  return (
    <Stack gap="sm">
      <div className="wk-metrics">
        <Stat label="koşu" value={String(usage.totals.runs)} />
        <Stat label="başarılı" value={String(usage.totals.ok)} />
        <Stat label="başarısız" value={String(usage.totals.failed)} />
        <Stat
          label="token"
          value={formatTokens(usage.totals.inputTokens + usage.totals.outputTokens)}
        />
      </div>
      <hr className="wk-rule" />
      {usage.engines.map((item) => (
        <UsageRow key={item.engine} usage={item} total={usage.totals.runs} />
      ))}
      <Text size="xs" c="dimmed">
        {usage.totals.costMicros > 0
          ? `Motorların bildirdiği toplam maliyet: ${formatCost(usage.totals.costMicros)} (abonelikle koşan işler maliyet bildirmez; token sayılır, para değil)`
          : 'Maliyet bildirimi yok: abonelikle koşan motorlar token bildirir, para bildirmez.'}
      </Text>
    </Stack>
  );
}

function PendingBody({ summary }: { summary: MissionSummary }): React.JSX.Element {
  return (
    <Stack gap="sm">
      <div className="wk-counts">
        {Object.entries(summary.counts).map(([status, count]) => (
          <div key={status} className="wk-count">
            <span>{COLUMN_LABELS[status] ?? status}</span>
            <strong>{count}</strong>
          </div>
        ))}
      </div>
      <Text size="xs" c="dimmed">
        Ekipte {summary.squadSize} ajan
      </Text>
      <hr className="wk-rule" />
      <Text size="xs" c="dimmed">
        çalışan ajanlar:{' '}
        {summary.working.length > 0 ? summary.working.map((agent) => agent.slug).join(', ') : 'yok'}
      </Text>
      <Text size="xs" c="dimmed">
        inceleme bekleyen: {summary.review.length} · engelli: {summary.blocked.length}
      </Text>
      {summary.blocked.length > 0 ? (
        <Stack gap={2}>
          {summary.blocked.slice(0, 5).map((task) => (
            <Text key={task.id} size="xs" c="red">
              ⛔ {task.title}
            </Text>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <Stack gap={4} className="wk-stat">
      <span className="wk-stat-value">{value}</span>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Stack>
  );
}

function EngineRow({ status }: { status: EngineStatus }): React.JSX.Element {
  const detail = [status.version, status.identity]
    .filter((value) => value !== null && value !== '')
    .join(' · ');
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start" className="wk-engine">
      <span className="wk-engine-state" data-ready={status.available}>
        {status.available ? 'Hazır' : 'Yok'}
      </span>
      <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
        <Text size="sm" fw={500}>
          {status.label}{' '}
          <Text span size="xs" c="dimmed">
            ({status.host})
          </Text>
        </Text>
        {detail ? (
          <Text size="xs" c="dimmed" truncate>
            {detail}
          </Text>
        ) : null}
        {/* `note` Rust'ta YAZILMIS durum metnidir (yapilacak is / olculen sinir), hata
            govdesi degil: gizlenirse "kullanilamiyor" sebebi ve kurulum adimi kaybolur. */}
        {status.note ? (
          <Text size="xs" c={status.available ? 'dimmed' : 'orange'}>
            {status.note}
          </Text>
        ) : null}
      </Stack>
    </Group>
  );
}

function UsageRow({ usage, total }: { usage: EngineUsage; total: number }): React.JSX.Element {
  const share = total > 0 ? Math.round((usage.runs / total) * 100) : 0;
  const failedShare = usage.runs > 0 ? Math.round((usage.failed / usage.runs) * 100) : 0;
  return (
    <Stack gap={8} className="wk-usage-row">
      <Group justify="space-between" align="baseline">
        <Text size="sm" fw={500}>
          {usage.engine}
        </Text>
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            {usage.runs} koşu ({share}%)
          </Text>
          <Badge size="md" variant="light" color={failedShare > 0 ? 'orange' : 'teal'}>
            %{100 - failedShare} başarı
          </Badge>
        </Group>
      </Group>
      <Progress value={share} size="sm" aria-label={`${usage.engine} koşu payı`} />
      <Text size="xs" c="dimmed">
        {usage.ok} başarılı · {usage.failed} başarısız · {usage.cancelled} iptal
        {usage.pending > 0 ? ` · ${usage.pending} devam ediyor` : ''}
      </Text>
      <Text size="xs" c="dimmed">
        token: {formatTokens(usage.inputTokens + usage.outputTokens)} (giriş{' '}
        {formatTokens(usage.inputTokens)} / çıkış {formatTokens(usage.outputTokens)})
        {usage.costMicros > 0 ? ` · ${formatCost(usage.costMicros)}` : ''}
      </Text>
    </Stack>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/** Motorlar maliyeti mikro-dolar bildirir (USD * 1e6). */
function formatCost(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}
