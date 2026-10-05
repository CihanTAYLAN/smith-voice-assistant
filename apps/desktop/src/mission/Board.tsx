import { Plasma } from '@cruxgarden/plasma-ui';

import { Loading } from '../dashboard/LoadView.js';

import type { Agent, SurfaceState, Task } from './api.js';
import { COLUMN_LABELS, COLUMNS, groupByStatus, relativeTime } from './layout.js';

/**
 * Kanban — panonun govdesi.
 *
 * Kolonlar ayrı plazma yüzeyleridir; kartlar bu yüzeylerin üzerinde kalır.
 * Dar alanda sütunlar aşağı akar, durum sırası korunur.
 *
 * SURUKLE-BIRAK YOK, BILINCLI: durum gecisleri sunucuda bir makineye tabi
 * (`in_progress → done` yasak). Surukleyerek her kolona birakmak, kullaniciya
 * sunucunun reddedecegi hareketleri ONERMEK olurdu. Karti tiklayip yalniz
 * GECERLI gecisleri dugme olarak gormek hem dogru hem daha az kod.
 *
 * DURUM: ilk yukleme "bos pano" gibi gorunmez (`loading`); veri yokken hata
 * kolonlarin yerine yazilir (`error`); `stale` iken son bilinen pano durur.
 */

export interface BoardProps {
  tasks: Task[];
  agents: Agent[];
  selectedTaskId: string | null;
  /** Detayi yuklenmekte olan gorev; kart mesgul gorunur. */
  pendingTaskId: string | null;
  status: SurfaceState;
  onSelectTask: (taskId: string) => void;
}

const PRIORITY_LABEL: Record<number, string> = { 1: 'yüksek', 2: 'normal', 3: 'düşük' };

export function Board({
  agents,
  onSelectTask,
  pendingTaskId,
  selectedTaskId,
  status,
  tasks,
}: BoardProps): React.JSX.Element {
  if (status === 'loading') {
    return <Loading text="Görevler yükleniyor…" />;
  }
  if (status === 'error') {
    return (
      <div className="surface-state surface-error" role="alert">
        Görev panosu yüklenemedi.
      </div>
    );
  }
  const columns = groupByStatus(tasks);
  const slugOf = new Map(agents.map((a) => [a.id, a.slug]));

  return (
    <div className="board" aria-busy={status === 'stale'} data-state={status}>
      {COLUMNS.map((name) => {
        const items = columns[name] ?? [];
        return (
          <Plasma
            as="section"
            className="col"
            key={name}
            data-col={name}
            aria-labelledby={`col-${name}`}
            lean={false}
            fuse={false}
            radius={14}
          >
            <header className="col-head">
              <h3 className="col-name" id={`col-${name}`}>
                {COLUMN_LABELS[name]}
              </h3>
              <span className="col-count">{items.length}</span>
            </header>
            <div className="col-body">
              {items.length === 0 ? <p className="col-empty">Görev yok</p> : null}
              {items.map((task) => (
                <button
                  type="button"
                  key={task.id}
                  className="card"
                  data-selected={task.id === selectedTaskId}
                  data-priority={task.priority}
                  aria-haspopup="dialog"
                  aria-busy={task.id === pendingTaskId}
                  onClick={() => onSelectTask(task.id)}
                >
                  <span className="card-title">{task.title}</span>
                  <span className="card-meta">
                    {task.assigneeId ? (
                      <em className="card-agent">@{slugOf.get(task.assigneeId) ?? '?'}</em>
                    ) : (
                      <em className="card-agent card-none">sahipsiz</em>
                    )}
                    <span className="card-pri">
                      {PRIORITY_LABEL[task.priority] ?? task.priority}
                    </span>
                    <span className="card-time">{relativeTime(task.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          </Plasma>
        );
      })}
    </div>
  );
}
