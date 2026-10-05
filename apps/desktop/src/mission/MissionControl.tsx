import { Loading } from '../dashboard/LoadView.js';
import { useMemo, useState } from 'react';
import { Plasma } from '@cruxgarden/plasma-ui';

import {
  assignTask,
  commentTask,
  createAgent,
  createTask,
  deleteAgent,
  FIELD_LIMITS,
  moveTask,
  updateAgent,
} from './api.js';
import { AgentPanel } from './AgentPanel.js';
import { Board } from './Board.js';
import { relativeTime, surfaceOf } from './layout.js';
import { OrgChart } from './OrgChart.js';
import { TaskDrawer } from './TaskDrawer.js';
import { useMissionData } from './useMissionData.js';
import { useSubmit } from './useSubmit.js';

/**
 * MISSION CONTROL: Smith'in ekip panosu (ADR 0007). Veri, yoklama ve yaris
 * koruma mantigi `useMissionData`'dadir; burasi yalniz yerlesim ve eylem baglari.
 *
 * `aktif`: Dashboard bolumleri mount'lu kalip CSS ile gizlendigi icin sayfa
 * gizliyken bile `document.hidden` false kalir. Dashboard, Mission bolumu
 * gorunurken `true` verir; `false` iken yoklama durur. Baglanti gelene dek
 * varsayilan `true`: bugunku davranis degismez.
 *
 * Pencere basligi (marka + surukleme + kapatma) SMITH DASHBOARD kabugundadir
 * (Dashboard.tsx); burada yalniz panonun KENDI araci kalir: hizli gorev ekleme
 * + yenileme.
 */

export interface MissionControlProps {
  aktif?: boolean;
}

export function MissionControl({ aktif = true }: MissionControlProps): React.JSX.Element {
  const data = useMissionData(aktif);
  const { board, boardState, busy, detail, mutate } = data;
  const [agentFilterId, setAgentFilterId] = useState<string | null>(null);
  const [agentFormOpen, setAgentFormOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const quickAdd = useSubmit();

  // `board?.x ?? []` her render'da YENI bir dizi uretir ve asagidaki useMemo'lari
  // her seferinde yeniden hesaplatir; referansi board'a bagliyoruz.
  const agents = useMemo(() => board?.agents ?? [], [board]);
  const tasks = useMemo(() => board?.tasks ?? [], [board]);
  const events = useMemo(() => board?.events ?? [], [board]);

  // Suzulen ajan baska yerden silinirse filtre sessizce duser (bos pano gostermez).
  const filterAgent = useMemo(
    () => agents.find((agent) => agent.id === agentFilterId) ?? null,
    [agents, agentFilterId],
  );
  const visibleTasks = useMemo(
    () => (filterAgent ? tasks.filter((task) => task.assigneeId === filterAgent.id) : tasks),
    [filterAgent, tasks],
  );
  const loadByAgent = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of tasks) {
      if (!task.assigneeId || task.status === 'done') continue;
      counts[task.assigneeId] = (counts[task.assigneeId] ?? 0) + 1;
    }
    return counts;
  }, [tasks]);
  const totals = useMemo(
    () => ({
      working: agents.filter((agent) => agent.status === 'working').length,
      review: tasks.filter((task) => task.status === 'review').length,
      blocked: tasks.filter((task) => task.status === 'blocked').length,
    }),
    [agents, tasks],
  );

  const agentState = surfaceOf(boardState, agents.length === 0);
  const taskState = surfaceOf(boardState, visibleTasks.length === 0);
  const eventState = surfaceOf(boardState, events.length === 0);
  // Pano henuz gelmediyse sayilar 0 degil BILINMIYOR: ilk yukleme "bos ekip" gibi gorunmez.
  const count = (value: number): number | string => (board ? value : '-');

  return (
    <div className="mc" aria-busy={boardState === 'loading'}>
      <div className="mc-toolbar">
        <form
          className="quick"
          onSubmit={(event) => {
            event.preventDefault();
            const title = newTitle.trim();
            if (title.length < FIELD_LIMITS.taskTitleMin || busy) return;
            void quickAdd
              .submit(() =>
                mutate(() =>
                  createTask({ title, ...(newAssignee ? { assignee: newAssignee } : {}) }),
                ),
              )
              .then((ok) => {
                if (!ok) return;
                setNewTitle('');
                setNewAssignee('');
              });
          }}
        >
          <label className="field quick-title">
            <span>Yeni görev</span>
            <input
              value={newTitle}
              placeholder="Görev başlığı"
              maxLength={FIELD_LIMITS.taskTitleMax}
              onChange={(event) => setNewTitle(event.target.value)}
            />
          </label>
          <label className="field field-inline">
            <span>Atama</span>
            <select value={newAssignee} onChange={(event) => setNewAssignee(event.target.value)}>
              <option value="">Atamasız</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.slug}>
                  @{agent.slug}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="act act-primary"
            disabled={busy || newTitle.trim().length < FIELD_LIMITS.taskTitleMin}
          >
            Görev ekle
          </button>
        </form>

        <div className="bar-tools">
          <button
            type="button"
            className="ic"
            onClick={() => void data.refresh()}
            disabled={!aktif || boardState === 'loading'}
            aria-label="Mission Control verilerini yenile"
            title="Yenile"
          >
            ⟳
          </button>
        </div>
      </div>

      {/*
        Banner'lar TEK ve HEP MEVCUT kapsayicida: `.mc` grid'i `auto auto 1fr auto`
        dort sabit satir ister. Kapsayici bos oldugunda gizlenirse (display:none)
        grid kalan ogeleri bir satir yukari kaydirir, pano `auto` satira, footer
        `1fr` satira duser ve footer gorunur alanin disina tasar (olculdu). Ayni
        kapsayici canli bolge de oldugu icin DOM'da kalmasi duyuru icin de dogru.
      */}
      <div className="mc-banners" aria-live="polite">
        {data.connectionError ? <p className="banner">{data.connectionError}</p> : null}
        {data.notice ? (
          <div className="banner banner-action">
            <span>{data.notice}</span>
            <button type="button" className="banner-dismiss" onClick={data.dismissNotice}>
              Kapat
            </button>
          </div>
        ) : null}
        {quickAdd.error ? (
          <div className="banner banner-action" role="alert">
            <span>{quickAdd.error}</span>
            <button type="button" className="banner-dismiss" onClick={quickAdd.clearError}>
              Kapat
            </button>
          </div>
        ) : null}
      </div>

      <div className="grid">
        <section className="panel panel-board" aria-label="Görev panosu">
          <Board
            tasks={visibleTasks}
            agents={agents}
            selectedTaskId={data.selectedTaskId}
            pendingTaskId={detail ? null : data.selectedTaskId}
            status={taskState}
            onSelectTask={(id) => void data.openTask(id)}
          />
        </section>

        <Plasma
          as="section"
          className="panel panel-org"
          fuse={false}
          aria-labelledby="mc-org-title"
          lean={false}
          radius={16}
        >
          <h2>
            <span id="mc-org-title">Ekip</span>
            {filterAgent ? (
              <button type="button" className="clear" onClick={() => setAgentFilterId(null)}>
                Filtreyi kaldır
              </button>
            ) : null}
          </h2>
          <div className="org-body">
            <OrgChart
              agents={agents}
              selectedId={filterAgent?.id ?? null}
              onSelect={setAgentFilterId}
              onCreateAgent={() => setAgentFormOpen(true)}
              loadByAgent={loadByAgent}
              status={agentState}
            />
            <AgentPanel
              agents={agents}
              selected={filterAgent}
              busy={busy}
              active={aktif}
              createOpen={agentFormOpen && aktif}
              onCreateOpenChange={setAgentFormOpen}
              onCreate={(input) => mutate(() => createAgent(input))}
              onSaveSoul={(id, soul) => mutate(() => updateAgent(id, { soul }))}
              onSetStatus={(id, status) => mutate(() => updateAgent(id, { status }))}
              onDelete={async (id) => {
                const result = await mutate(() => deleteAgent(id));
                if (result?.ok) setAgentFilterId(null);
                return result;
              }}
            />
          </div>
        </Plasma>

        <Plasma
          as="section"
          className="panel panel-feed"
          fuse={false}
          aria-labelledby="mc-feed-title"
          lean={false}
          radius={16}
        >
          <h2 id="mc-feed-title">Olay akışı</h2>
          {eventState === 'loading' ? (
            <Loading text="Olaylar yükleniyor…" />
          ) : eventState === 'error' ? (
            <p className="surface-state surface-error" role="alert">
              Olay akışı yüklenemedi.
            </p>
          ) : events.length === 0 ? (
            <p className="surface-state">Henüz olay yok.</p>
          ) : (
            <ul className="feed" aria-busy={eventState === 'stale'}>
              {events.map((item) => (
                <li key={item.id} data-kind={item.kind}>
                  <span className="feed-kind">{item.kind}</span>
                  <span className="feed-time">{relativeTime(item.createdAt)}</span>
                  <p>{item.detail ?? 'Ayrıntı yok.'}</p>
                </li>
              ))}
            </ul>
          )}
        </Plasma>
      </div>

      {detail ? (
        <TaskDrawer
          key={detail.task.id}
          detail={detail}
          agents={agents}
          transitions={board?.transitions ?? {}}
          busy={busy}
          status={data.detailState === 'stale' ? 'stale' : 'ready'}
          error={data.detailError}
          onClose={data.closeTask}
          onRetry={() => void data.retryDetail()}
          onMove={(status) => mutate(() => moveTask(detail.task.id, status))}
          onAssign={(assignee, engine) =>
            mutate(() => assignTask(detail.task.id, assignee, engine))
          }
          onComment={(body) => mutate(() => commentTask(detail.task.id, body))}
        />
      ) : null}

      <footer className="foot">
        <span>Ekip {count(agents.length)}</span>
        <span data-on={totals.working > 0}>Koşan {count(totals.working)}</span>
        <span data-warn={totals.review > 0}>İnceleme {count(totals.review)}</span>
        <span data-warn={totals.blocked > 0}>Engel {count(totals.blocked)}</span>
        <span>Görev {count(tasks.length)}</span>
      </footer>
    </div>
  );
}
