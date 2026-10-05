import { useMemo, useRef, useState } from 'react';
import { Badge, Button, Group, ScrollArea, Select, Text, Textarea, TextInput } from '@mantine/core';

import {
  answerMemoryGap,
  dismissMemoryGap,
  memoryGaps,
  memoryList,
  memorySearch,
  type MemoryGap,
  type MemoryMatch,
  type MemoryRecord,
} from './api.js';
import { Empty, Fault, Loading, LoadView } from './LoadView.js';
import { dataOf, useGate, useLoadable } from './loadable.js';

/**
 * HAFIZA — son kayitlar + anlamsal arama (SALT OKUMA).
 *
 * Liste `useLoadable` ile yuklenir: ilk okuma "Kayit yok" diye gorunmez, hata
 * eski listeyi silmez (bayat uyarisiyla kalir). Arama son-cevap-kazanir: yavas
 * donen eski arama yeni sonucun ustune yazmaz. Bilgi grafigi ayni okumayi
 * paylasir (bkz. api.ts `memoryList`).
 */

type Search =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'done'; results: MemoryMatch[] }
  | { status: 'error'; error: string };

const IDLE: Search = { status: 'idle' };
const SNIPPET_LENGTH = 220;

const SOURCE_LABELS: Record<string, string> = {
  conversation: 'Sohbet',
  document: 'Belge',
  preference: 'Tercih',
};
const SENSITIVITY_LABELS: Record<string, string> = {
  public: 'Genel',
  private: 'Özel',
  secret: 'Hassas',
};

export function MemoryView(): React.JSX.Element {
  const list = useLoadable(memoryList);
  const records = useMemo(() => dataOf(list.state)?.records ?? [], [list.state]);
  const [sourceType, setSourceType] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search>(IDLE);
  const gate = useGate();
  const searching = useRef<string | null>(null);

  const sourceTypes = useMemo(
    () => [...new Set(records.map((record) => record.sourceType))].sort(),
    [records],
  );
  const detail = records.find((record) => record.id === selectedId) ?? null;

  const editQuery = (value: string): void => {
    gate.cancel();
    searching.current = null;
    setQuery(value);
    setSearch(IDLE);
  };

  const runSearch = async (): Promise<void> => {
    const text = query.trim();
    if (searching.current === text) return;
    const ticket = gate.next();
    if (!text) {
      searching.current = null;
      setSearch(IDLE);
      return;
    }
    searching.current = text;
    setSearch({ status: 'searching' });
    const result = await memorySearch(text);
    if (!gate.isCurrent(ticket)) return;
    searching.current = null;
    setSearch(
      result.ok
        ? { status: 'done', results: result.value.results }
        : { status: 'error', error: result.error },
    );
  };

  return (
    <div className="mem">
      <div className="mem-toolbar">
        <Group gap={8} align="flex-end" wrap="wrap">
          <TextInput
            size="sm"
            label="Hafızada ara"
            placeholder="Hatırlamak istediğin bilgiyi yaz…"
            value={query}
            onChange={(event) => editQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runSearch();
            }}
            style={{ flex: '1 1 220px' }}
          />
          <Select
            size="sm"
            label="Kaynak"
            placeholder="hepsi"
            data={sourceTypes.map((value) => ({ value, label: SOURCE_LABELS[value] ?? value }))}
            value={sourceType}
            onChange={setSourceType}
            clearable
            style={{ flex: '0 1 180px' }}
          />
          <Button
            size="sm"
            variant="light"
            loading={search.status === 'searching'}
            onClick={() => void runSearch()}
          >
            ara
          </Button>
          <Button
            size="sm"
            variant="subtle"
            loading={list.refreshing}
            onClick={() => void list.reload(true)}
          >
            yenile
          </Button>
        </Group>
      </div>

      <OpenQuestions />

      {search.status === 'error' ? (
        <Fault message={search.error} onRetry={() => void runSearch()} />
      ) : null}

      <div className="mem-body">
        <div className="mem-list">
          <ScrollArea h="100%" type="auto">
            {search.status === 'searching' ? (
              <Loading text="Aranıyor…" />
            ) : search.status === 'done' ? (
              <SearchResults results={search.results} />
            ) : (
              <LoadView
                state={list.state}
                loadingText="Hafıza yükleniyor…"
                onRetry={() => void list.reload(true)}
              >
                {(data) => (
                  <RecordList
                    records={data.records}
                    sourceType={sourceType}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />
                )}
              </LoadView>
            )}
          </ScrollArea>
        </div>
        <div className="mem-detail">
          {detail ? (
            <RecordDetail record={detail} />
          ) : (
            <Empty title="Bir kayıt seç">Soldan bir kayıt seç; tam içerik burada görünür.</Empty>
          )}
        </div>
      </div>
    </div>
  );
}

export function OpenQuestions(): React.JSX.Element {
  const list = useLoadable(memoryGaps);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gaps = (dataOf(list.state)?.gaps ?? []).filter((gap) => !resolved.has(gap.id));

  const finish = async (gap: MemoryGap, action: 'answer' | 'dismiss'): Promise<void> => {
    const answer = answers[gap.id]?.trim() ?? '';
    if (action === 'answer' && !answer) return;
    setBusy(gap.id);
    setError(null);
    const result =
      action === 'answer' ? await answerMemoryGap(gap.id, answer) : await dismissMemoryGap(gap.id);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setResolved((current) => new Set(current).add(gap.id));
    setAnswers((current) => {
      const next = { ...current };
      delete next[gap.id];
      return next;
    });
    void list.reload(true);
  };

  return (
    <section className="mem-questions" aria-labelledby="mem-questions-title">
      <div className="mem-questions-head">
        <h2 id="mem-questions-title">Açık sorular</h2>
        {gaps.length > 0 ? <Badge variant="light">{gaps.length}</Badge> : null}
      </div>
      {list.state.status === 'loading' ? (
        <Loading text="Sorular yükleniyor…" />
      ) : list.state.status === 'error' ? (
        <Fault message={list.state.error} onRetry={() => void list.reload(true)} />
      ) : gaps.length === 0 ? (
        <Text size="sm" c="dimmed">
          Açık soru yok.
        </Text>
      ) : (
        <div className="mem-question-list">
          {gaps.map((gap) => (
            <article key={gap.id} className="mem-question">
              <Text size="sm" fw={600}>
                {gap.question}
              </Text>
              <Text size="xs" c="dimmed">
                {gap.reason}
              </Text>
              <Textarea
                size="sm"
                label="Cevap"
                placeholder="Cevabı yaz…"
                value={answers[gap.id] ?? ''}
                onChange={(event) =>
                  setAnswers((current) => ({ ...current, [gap.id]: event.currentTarget.value }))
                }
                autosize
                minRows={2}
                maxRows={4}
              />
              <Group gap={8} justify="flex-end">
                <Button
                  size="xs"
                  variant="subtle"
                  loading={busy === gap.id}
                  onClick={() => void finish(gap, 'dismiss')}
                >
                  Geç
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  disabled={!answers[gap.id]?.trim()}
                  loading={busy === gap.id}
                  onClick={() => void finish(gap, 'answer')}
                >
                  Kaydet
                </Button>
              </Group>
            </article>
          ))}
        </div>
      )}
      {error ? (
        <Text size="sm" c="red" role="alert">
          {error}
        </Text>
      ) : null}
    </section>
  );
}

function SearchResults({ results }: { results: MemoryMatch[] }): React.JSX.Element {
  return (
    <>
      {results.length === 0 ? (
        <Empty title="Arama sonucu yok.">Farklı bir sözcük veya daha kısa bir cümle dene.</Empty>
      ) : (
        <h2 className="mem-list-heading">Arama sonuçları · {results.length}</h2>
      )}
      {results.map((result, index) => (
        <div key={`${index}-${result.content.slice(0, 24)}`} className="mem-row">
          <Badge size="md" variant="light">
            benzerlik {result.similarity.toFixed(2)}
          </Badge>
          <p className="mem-snippet">{result.content.slice(0, SNIPPET_LENGTH)}</p>
        </div>
      ))}
    </>
  );
}

function RecordList({
  records,
  sourceType,
  selectedId,
  onSelect,
}: {
  records: MemoryRecord[];
  sourceType: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const shown = records.filter((record) => !sourceType || record.sourceType === sourceType);
  return (
    <>
      {shown.length === 0 ? (
        <Empty title="Kayıt yok.">Yeni kayıtlar geldiğinde burada görünür.</Empty>
      ) : (
        <h2 className="mem-list-heading">Son kayıtlar · {shown.length}</h2>
      )}
      {shown.map((record) => (
        <button
          key={record.id}
          type="button"
          className="mem-row mem-row-btn"
          data-active={record.id === selectedId}
          aria-pressed={record.id === selectedId}
          onClick={() => onSelect(record.id)}
        >
          <div className="mem-meta">
            <RecordBadges record={record} />
            <time dateTime={record.createdAt}>
              {new Date(record.createdAt).toLocaleDateString('tr-TR')}
            </time>
          </div>
          <p className="mem-snippet">{record.content.slice(0, SNIPPET_LENGTH)}</p>
        </button>
      ))}
    </>
  );
}

function RecordBadges({ record }: { record: MemoryRecord }): React.JSX.Element {
  return (
    <>
      <Badge size="md" variant="light">
        {SOURCE_LABELS[record.sourceType] ?? record.sourceType}
      </Badge>
      <Badge size="md" variant="outline" color={record.sensitivity === 'secret' ? 'red' : 'gray'}>
        {SENSITIVITY_LABELS[record.sensitivity] ?? record.sensitivity}
      </Badge>
    </>
  );
}

function RecordDetail({ record }: { record: MemoryRecord }): React.JSX.Element {
  return (
    <>
      <h2>Kayıt ayrıntısı</h2>
      <Group gap={8}>
        <RecordBadges record={record} />
        <Text size="xs" c="dimmed">
          {new Date(record.createdAt).toLocaleString('tr-TR')}
        </Text>
      </Group>
      <Text size="xs" c="dimmed" mt={4} className="mem-src">
        Kaynak: {record.sourceId}
      </Text>
      <pre className="mem-full">{record.content}</pre>
    </>
  );
}
