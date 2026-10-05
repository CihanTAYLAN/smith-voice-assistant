import { useRef } from 'react';

import type { Agent, MutationOutcome, NewAgent } from './api.js';
import { AgentCard } from './AgentCard.js';
import { NewAgentDialog } from './NewAgentDialog.js';

/**
 * Ajan yonetimi: secili ajanin karti (`AgentCard`) ve yeni ajan formu
 * (`NewAgentDialog`). Form ac/kapa durumu ustte tutulur (`createOpen`): ekip
 * bossa org semasindaki eylem de formu acabilir.
 */

export interface AgentPanelProps {
  agents: Agent[];
  selected: Agent | null;
  busy: boolean;
  /** Pano gorunur mu; gizliyken kipli pencereler kapali tutulur (gorunmeyen modal sayfayi kilitler). */
  active: boolean;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  onCreate: (input: NewAgent) => MutationOutcome;
  onSaveSoul: (agentId: string, soul: string) => MutationOutcome;
  onSetStatus: (agentId: string, status: 'idle' | 'offline') => MutationOutcome;
  onDelete: (agentId: string) => MutationOutcome;
}

export function AgentPanel({
  active,
  agents,
  busy,
  createOpen,
  onCreate,
  onCreateOpenChange,
  onDelete,
  onSaveSoul,
  onSetStatus,
  selected,
}: AgentPanelProps): React.JSX.Element {
  // Kart silinince ya da bos ekip eylemi kaybolunca odak buraya doner.
  const createTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <section className="agent-panel" aria-label="Ajan yönetimi">
      {selected ? (
        <AgentCard
          key={selected.id}
          active={active}
          agent={selected}
          busy={busy}
          fallbackFocus={createTriggerRef}
          onSaveSoul={onSaveSoul}
          onSetStatus={onSetStatus}
          onDelete={onDelete}
        />
      ) : null}

      <button
        ref={createTriggerRef}
        type="button"
        className="clear agent-create"
        aria-haspopup="dialog"
        onClick={() => onCreateOpenChange(true)}
      >
        + Yeni ajan
      </button>

      <NewAgentDialog
        open={createOpen}
        agents={agents}
        busy={busy}
        fallbackFocus={createTriggerRef}
        onClose={() => onCreateOpenChange(false)}
        onCreate={onCreate}
      />
    </section>
  );
}
