import { useState } from 'react';

import {
  ENGINE_OPTIONS,
  FIELD_LIMITS,
  type Agent,
  type MutationOutcome,
  type TaskDetail,
} from './api.js';
import {
  authorLabel,
  COLUMN_LABELS,
  formatCost,
  relativeAgo,
  sumCost,
  sumTodayCost,
} from './layout.js';
import { useModalDialog } from '../useModalDialog.js';
import { useSubmit } from './useSubmit.js';

/**
 * Gorev cekmecesi: yerel `<dialog>` (kipli): odak cekmecede kalir, Escape
 * kapatir, arka plan inert olur. `key={task.id}` ile (MissionControl) her gorev
 * temiz bir cekmece alir; baska gorevin taslagi sizamaz.
 *
 * Eylem hatalari cekmecenin KENDI icinde gosterilir (`useSubmit`): kipli pencere
 * acikken sayfa bandi karartmanin arkasinda kalir. Taslak (yorum, secilen ajan)
 * yalniz eylem BASARILI olunca temizlenir.
 */

export interface TaskDrawerProps {
  detail: TaskDetail;
  agents: Agent[];
  transitions: Record<string, string[]>;
  busy: boolean;
  /** `stale`: son bilinen detay gosteriliyor, yenileme basarisiz (`error` sebebi). */
  status: 'ready' | 'stale';
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
  onMove: (status: string) => MutationOutcome;
  onAssign: (assignee: string, engine: string) => MutationOutcome;
  onComment: (body: string) => MutationOutcome;
}

export function TaskDrawer({
  agents,
  busy,
  detail,
  error,
  onAssign,
  onClose,
  onComment,
  onMove,
  onRetry,
  status,
  transitions,
}: TaskDrawerProps): React.JSX.Element {
  const [comment, setComment] = useState('');
  const [assignee, setAssignee] = useState('');
  const [engine, setEngine] = useState<string>(ENGINE_OPTIONS[0].value);
  const action = useSubmit();
  const dialogRef = useModalDialog(true, onClose);
  const { comments, runs, task } = detail;
  const slugOf = new Map(agents.map((agent) => [agent.id, agent.slug]));
  const allowed = transitions[task.status] ?? [];

  const assign = (): void => {
    void action
      .submit(() => onAssign(assignee, engine))
      .then((ok) => {
        if (ok) setAssignee('');
      });
  };
  const sendComment = (): void => {
    const draft = comment.trim();
    void action
      .submit(() => onComment(draft))
      .then((ok) => {
        if (ok) setComment('');
      });
  };

  return (
    <dialog ref={dialogRef} className="drawer" aria-labelledby="task-drawer-title">
      <header className="drawer-head">
        <div>
          <span className="chip" data-col={task.status}>
            {COLUMN_LABELS[task.status] ?? task.status}
          </span>
          <h2 id="task-drawer-title">{task.title}</h2>
          <p className="drawer-sub">
            {task.assigneeId ? `@${slugOf.get(task.assigneeId) ?? '?'}` : 'Sahipsiz'} ·{' '}
            {task.createdBy === 'smith' ? 'Smith açtı' : 'Sen açtın'} ·{' '}
            {relativeAgo(task.updatedAt)}
          </p>
        </div>
        <button type="button" className="ic" onClick={onClose} aria-label="Görev detayını kapat">
          ×
        </button>
      </header>

      {status === 'stale' && error ? (
        <div className="drawer-warning" role="status">
          <span>{error} Son bilinen ayrıntılar gösteriliyor.</span>
          <button type="button" className="act" disabled={busy} onClick={onRetry}>
            Yeniden dene
          </button>
        </div>
      ) : null}

      {action.error ? (
        <p className="form-error" role="alert">
          {action.error}
        </p>
      ) : null}

      {task.detail ? <p className="drawer-detail">{task.detail}</p> : null}

      {task.deliverable ? (
        <section className="drawer-block">
          <h3>Teslim</h3>
          <p className="deliverable">{task.deliverable}</p>
          {task.artifactPath ? <code className="artifact">{task.artifactPath}</code> : null}
        </section>
      ) : null}

      <section className="drawer-block">
        <h3>Eylemler</h3>
        <div className="actions" role="group" aria-label="Görev durumunu değiştir">
          {allowed.length === 0 ? (
            <span className="muted">Bu durumdan geçiş yok.</span>
          ) : (
            <span className="muted">Durumu şuna taşı:</span>
          )}
          {allowed.map((nextStatus) => (
            <button
              type="button"
              key={nextStatus}
              className="act"
              disabled={busy}
              onClick={() => void action.submit(() => onMove(nextStatus))}
            >
              {COLUMN_LABELS[nextStatus] ?? nextStatus}
            </button>
          ))}
        </div>
        <div className="assign">
          <label className="field field-inline">
            <span>Ajan</span>
            <select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
              <option value="">Ajan seç…</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.slug}>
                  @{agent.slug} · {agent.role}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-inline">
            <span>Çalıştırma motoru</span>
            <select value={engine} onChange={(event) => setEngine(event.target.value)}>
              {ENGINE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="act act-primary"
            disabled={busy || !assignee}
            onClick={assign}
          >
            Ata ve çalıştır
          </button>
        </div>
      </section>

      <section className="drawer-block">
        <h3>Koşular</h3>
        {runs.length === 0 ? (
          <p className="muted">Henüz koşu yok.</p>
        ) : (
          <p className="runs-cost">
            Bugün ${formatCost(sumTodayCost(runs))} · toplam ${formatCost(sumCost(runs))}
          </p>
        )}
        <ul className="runs">
          {runs.map((runItem) => (
            <li key={runItem.id} data-status={runItem.status}>
              <span className="run-status">{runItem.status}</span>
              <span className="run-meta">
                {runItem.engine} @ {runItem.device}
                {runItem.exitCode === null ? '' : ` · exit ${runItem.exitCode}`} · $
                {formatCost(runItem.costMicros)}
                {runItem.inputTokens === null
                  ? ''
                  : ` · ${runItem.inputTokens}/${runItem.outputTokens ?? 0} token`}
              </span>
              {runItem.logPath ? <code className="run-log">{runItem.logPath}</code> : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="drawer-block">
        <h3>Yorumlar</h3>
        <ul className="thread">
          {comments.length === 0 ? <li className="muted">Henüz yorum yok.</li> : null}
          {comments.map((item) => (
            <li key={item.id} data-kind={item.kind}>
              <span className="thread-kind">{item.kind}</span>
              <span className="thread-who">
                {authorLabel(item.authorType, item.authorId, slugOf)}
              </span>
              <p>{item.body}</p>
            </li>
          ))}
        </ul>
        <div className="composer">
          <label className="field">
            <span>Yorum</span>
            <textarea
              value={comment}
              rows={3}
              maxLength={FIELD_LIMITS.commentMax}
              placeholder="@nova ile ajana seslenebilirsin"
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="act act-primary"
            disabled={busy || comment.trim().length === 0}
            onClick={sendComment}
          >
            Yorumu gönder
          </button>
        </div>
      </section>
    </dialog>
  );
}
