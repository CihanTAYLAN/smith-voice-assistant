import { useEffect, useRef, useState } from 'react';

import { FIELD_LIMITS, type Agent, type MutationOutcome } from './api.js';
import { agentStatusLabel, relativeAgo } from './layout.js';
import { useModalDialog } from '../useModalDialog.js';
import { useSubmit } from './useSubmit.js';

/**
 * Secili ajanin karti: SOUL duzenleme, devre disi birakma ve silme (onayli).
 * `key={agent.id}` ile (AgentPanel) ajan degisince taslak ve onay durumu sifirlanir.
 *
 * Eylem hatalari eylemin yuzeyinde gosterilir (kart / silme onayi); SOUL taslagi
 * yalniz kayit BASARILI olunca "temiz" sayilir, hata halinde metin kaybolmaz.
 */

export interface AgentCardProps {
  active: boolean;
  agent: Agent;
  busy: boolean;
  /** Silme onayinin acildigi oge kaybolursa (ajan silindi) odagin gidecegi yer. */
  fallbackFocus: React.RefObject<HTMLElement | null>;
  onSaveSoul: (agentId: string, soul: string) => MutationOutcome;
  onSetStatus: (agentId: string, status: 'idle' | 'offline') => MutationOutcome;
  onDelete: (agentId: string) => MutationOutcome;
}

export function AgentCard({
  active,
  agent,
  busy,
  fallbackFocus,
  onDelete,
  onSaveSoul,
  onSetStatus,
}: AgentCardProps): React.JSX.Element {
  const [soul, setSoul] = useState(agent.soul);
  const [baseline, setBaseline] = useState(agent.soul);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const edit = useSubmit();
  const removal = useSubmit();
  const cardRef = useRef<HTMLDivElement>(null);

  // Kart ekip panelinin kaydirilabilir govdesinde, semanin altinda acilir; secimden sonra
  // gorunur alanin disinda kalmasin.
  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  // Sunucudaki SOUL baska yerden degisirse (kayit sonrasi ya da sesli arac), taslak
  // temizse yenisini al; kullanici duzenliyorsa onun metnine DOKUNMA.
  if (agent.soul !== baseline) {
    setBaseline(agent.soul);
    if (soul === baseline) setSoul(agent.soul);
  }

  const closeConfirm = (): void => {
    removal.clearError();
    setConfirmOpen(false);
  };
  const confirmRef = useModalDialog(confirmOpen && active, closeConfirm, fallbackFocus);

  const trimmed = soul.trim();
  const canSave = trimmed.length >= FIELD_LIMITS.soulMin && trimmed !== agent.soul.trim();
  const offline = agent.status === 'offline';

  return (
    <div ref={cardRef} className="agent-card">
      <header>
        <span className="agent-slug">@{agent.slug}</span>
        <span className="agent-meta">
          {agent.role} · {agent.device} · {agentStatusLabel(agent.status)} · son görülme{' '}
          {relativeAgo(agent.lastSeenAt)}
        </span>
      </header>
      {agent.workRoots.length > 0 ? (
        <code className="agent-roots">{agent.workRoots.join(', ')}</code>
      ) : (
        <span className="muted">Çalışma kökü yok, dosya işi verilemez.</span>
      )}
      <label className="field">
        <span>SOUL metni</span>
        <textarea
          className="agent-soul"
          rows={5}
          value={soul}
          onChange={(event) => setSoul(event.target.value)}
        />
      </label>
      {edit.error ? (
        <p className="form-error" role="alert">
          {edit.error}
        </p>
      ) : null}
      <div className="agent-actions">
        <button
          type="button"
          className="act"
          disabled={busy || !canSave}
          onClick={() => void edit.submit(() => onSaveSoul(agent.id, trimmed))}
        >
          SOUL kaydet
        </button>
        <button
          type="button"
          className="act"
          disabled={busy}
          onClick={() =>
            void edit.submit(() => onSetStatus(agent.id, offline ? 'idle' : 'offline'))
          }
        >
          {offline ? 'Devreye al' : 'Devre dışı bırak'}
        </button>
        <button
          type="button"
          className="act act-danger"
          disabled={busy}
          aria-haspopup="dialog"
          onClick={() => setConfirmOpen(true)}
        >
          Sil
        </button>
      </div>

      <dialog ref={confirmRef} className="confirm-dialog" aria-labelledby="delete-agent-title">
        <h2 id="delete-agent-title">{agent.displayName} adlı ajanı sil</h2>
        <p>
          Bu işlem geri alınamaz. Koşu geçmişi olan ajan silinemez; onu devre dışı bırakabilirsin.
        </p>
        {removal.error ? (
          <p className="form-error" role="alert">
            {removal.error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="act" onClick={closeConfirm}>
            Vazgeç
          </button>
          <button
            type="button"
            className="act act-danger"
            disabled={busy}
            onClick={() =>
              void removal
                .submit(() => onDelete(agent.id))
                .then((ok) => {
                  if (ok) setConfirmOpen(false);
                })
            }
          >
            Ajanı sil
          </button>
        </div>
      </dialog>
    </div>
  );
}
