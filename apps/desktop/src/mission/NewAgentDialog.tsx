import { useState } from 'react';

import {
  AGENT_DEVICES,
  AGENT_SLUG_PATTERN,
  FIELD_LIMITS,
  type Agent,
  type MutationOutcome,
  type NewAgent,
} from './api.js';
import { useModalDialog } from '../useModalDialog.js';
import { useSubmit } from './useSubmit.js';

/**
 * Yeni ajan formu: yerel `<dialog>` (kipli). Taslak BU bilesende, pencerenin
 * disinda tutulur: Escape ya da "Vazgeç" uzun bir SOUL metnini silmez; taslak
 * yalniz olusturma BASARILI olunca temizlenir. Hata (ornegin ayni kimlik) formun
 * icinde gosterilir, pencere acik kalir.
 */

export interface NewAgentDialogProps {
  open: boolean;
  agents: Agent[];
  busy: boolean;
  onClose: () => void;
  onCreate: (input: NewAgent) => MutationOutcome;
  /** Acan oge kaybolursa (bos ekip eylemi) odagin gidecegi yer. */
  fallbackFocus: React.RefObject<HTMLElement | null>;
}

interface Draft {
  slug: string;
  displayName: string;
  role: string;
  soul: string;
  device: string;
  workRoots: string;
  allowedTools: string;
  parentSlug: string;
}

const EMPTY_DRAFT: Draft = {
  slug: '',
  displayName: '',
  role: '',
  soul: '',
  device: AGENT_DEVICES[0],
  workRoots: '',
  allowedTools: '',
  parentSlug: '',
};

/**
 * Sunucu simdilik yalniz wsl ve windows ajanlarina is atar; uzak cihaz ajanlari
 * Faz 2. Secenekler gorunur ama pasif kalir: neden secilemedigi de gorunsun.
 */
const PHASE_TWO_DEVICES: ReadonlySet<string> = new Set(['m2', 'server']);

function toList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function NewAgentDialog({
  agents,
  busy,
  fallbackFocus,
  onClose,
  onCreate,
  open,
}: NewAgentDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const create = useSubmit();

  const close = (): void => {
    create.clearError();
    onClose();
  };
  const dialogRef = useModalDialog(open, close, fallbackFocus);
  const edit = (patch: Partial<Draft>): void => setDraft({ ...draft, ...patch });

  const slugValid = AGENT_SLUG_PATTERN.test(draft.slug);
  const valid =
    slugValid &&
    draft.displayName.trim().length > 0 &&
    draft.role.trim().length > 0 &&
    draft.soul.trim().length >= FIELD_LIMITS.soulMin;

  const submit = (): void => {
    if (!valid || busy) return;
    const parentSlug = draft.parentSlug.trim();
    void create
      .submit(() =>
        onCreate({
          slug: draft.slug,
          displayName: draft.displayName.trim(),
          role: draft.role.trim(),
          soul: draft.soul.trim(),
          device: draft.device,
          workRoots: toList(draft.workRoots),
          allowedTools: toList(draft.allowedTools),
          ...(parentSlug ? { parentSlug } : {}),
        }),
      )
      .then((ok) => {
        if (!ok) return;
        setDraft(EMPTY_DRAFT);
        close();
      });
  };

  return (
    <dialog ref={dialogRef} className="agent-dialog" aria-labelledby="agent-form-title">
      <form
        className="agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <header className="dialog-head field-wide">
          <h2 id="agent-form-title">Yeni ajan</h2>
          <button type="button" className="ic" aria-label="Ajan formunu kapat" onClick={close}>
            ×
          </button>
        </header>
        <div className="field-group">
          <label className="field">
            <span>Ajan kimliği</span>
            <input
              value={draft.slug}
              placeholder="nova"
              autoComplete="off"
              spellCheck={false}
              maxLength={32}
              aria-invalid={draft.slug.length > 0 && !slugValid}
              aria-describedby="agent-slug-hint"
              onChange={(event) => edit({ slug: event.target.value.toLowerCase() })}
            />
          </label>
          <small id="agent-slug-hint" className="hint">
            Küçük harfle başlar; küçük harf, rakam ve tire içerir (2-32 karakter).
          </small>
        </div>
        <label className="field">
          <span>Ajan adı</span>
          <input
            value={draft.displayName}
            placeholder="Nova"
            maxLength={FIELD_LIMITS.displayNameMax}
            onChange={(event) => edit({ displayName: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Rol</span>
          <input
            value={draft.role}
            placeholder="Araştırma"
            maxLength={FIELD_LIMITS.roleMax}
            onChange={(event) => edit({ role: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Cihaz</span>
          <select value={draft.device} onChange={(event) => edit({ device: event.target.value })}>
            {AGENT_DEVICES.map((device) => {
              const later = PHASE_TWO_DEVICES.has(device);
              return (
                <option key={device} value={device} disabled={later}>
                  {later ? `${device} (Faz 2)` : device}
                </option>
              );
            })}
          </select>
        </label>
        <label className="field">
          <span>Üst ajan</span>
          <select
            value={draft.parentSlug}
            onChange={(event) => edit({ parentSlug: event.target.value })}
          >
            <option value="">Üst yok</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.slug}>
                @{agent.slug}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Çalışma kökleri</span>
          <input
            value={draft.workRoots}
            placeholder="WSL yolları, virgülle ayır"
            spellCheck={false}
            onChange={(event) => edit({ workRoots: event.target.value })}
          />
        </label>
        <label className="field">
          <span>İzinli araçlar</span>
          <input
            value={draft.allowedTools}
            placeholder="Bash, Read, Write"
            spellCheck={false}
            onChange={(event) => edit({ allowedTools: event.target.value })}
          />
        </label>
        <div className="field-group field-wide">
          <label className="field">
            <span>SOUL metni</span>
            <textarea
              rows={4}
              value={draft.soul}
              placeholder="Kimliği ve çalışma kuralları"
              aria-describedby="agent-soul-hint"
              onChange={(event) => edit({ soul: event.target.value })}
            />
          </label>
          <small id="agent-soul-hint" className="hint">
            En az {FIELD_LIMITS.soulMin} karakter.
          </small>
        </div>
        {create.error ? (
          <p className="form-error field-wide" role="alert">
            {create.error}
          </p>
        ) : null}
        <div className="dialog-actions field-wide">
          <button type="button" className="act" onClick={close}>
            Vazgeç
          </button>
          <button type="submit" className="act act-primary" disabled={busy || !valid}>
            Ekibe kat
          </button>
        </div>
      </form>
    </dialog>
  );
}
