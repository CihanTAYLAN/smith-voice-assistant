import { Loading } from '../dashboard/LoadView.js';

import type { Agent, SurfaceState } from './api.js';
import { agentStatusLabel, ellipsize, layoutOrg, ORG, relativeAgo } from './layout.js';

/**
 * Org semasi — ekibin kim-kime-bagli haritasi.
 *
 * NEDEN SVG: kutular arasindaki BAGLANTI cizgileri asil bilgi. DOM kutulariyla
 * cizmek ya mutlak konumlu pseudo-element hilesi ya da canvas ister; SVG ikisini
 * de gerektirmez ve olceklenir.
 *
 * Yerlesim kasten basit: x = derinlik girintisi, y = agac sirasinda satir
 * (`layoutOrg`, saf ve testli). Denge/agirlik hesabi yok: ekip 5-15 kisi
 * olacak, "guzel agac" algoritmasi bugun kanitlanmis bir ihtiyac degil.
 *
 * Nabiz: `status` + `lastSeenAt`. `working` olan halkasi kehribar ve nabiz atar;
 * bu, panonun "su an gercekten bir sey oluyor" isaretidir.
 *
 * ERISILEBILIRLIK: her kutu bir DUGMEDIR (`aria-pressed`): secmek panoyu o
 * ajana gore suzer ve acip kapanan bir durumdur. `tree` rolu ok tuslariyla
 * gezinme ister; burada yok, bu yuzden kullanilmaz. Metin kutuya sigmazsa
 * `ellipsize` ile kisalir, tam metin `aria-label` ve ipucunda durur.
 */

export interface OrgChartProps {
  agents: Agent[];
  selectedId: string | null;
  onSelect: (agentId: string | null) => void;
  /** Ekip bossa gosterilen eylem: ajan formunu acar. */
  onCreateAgent: () => void;
  status: SurfaceState;
  /** Ajan basina acik gorev sayisi — kutuda kucuk sayac. */
  loadByAgent: Record<string, number>;
}

const NAME_MAX = 17;
const ROLE_MAX = 23;

export function OrgChart({
  agents,
  loadByAgent,
  onCreateAgent,
  onSelect,
  selectedId,
  status,
}: OrgChartProps): React.JSX.Element {
  if (status === 'loading') {
    return <Loading text="Ekip yükleniyor…" />;
  }
  if (status === 'error') {
    return (
      <p className="org-empty surface-error" role="alert">
        Ekip bilgisi yüklenemedi.
      </p>
    );
  }
  if (agents.length === 0) {
    return (
      <div className="org-empty">
        <p>Ekip henüz boş. İlk çalışma arkadaşını doğrudan buradan ekle.</p>
        <button type="button" className="act" onClick={onCreateAgent}>
          Yeni ajan
        </button>
      </div>
    );
  }

  const { edges, height, nodes, width } = layoutOrg(agents);

  return (
    <svg
      className="org"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="group"
      aria-label="Ekip organizasyon şeması"
      aria-busy={status === 'stale'}
    >
      {edges.map((edge) => (
        <path key={edge.key} className="org-edge" d={edge.path} />
      ))}
      {nodes.map(({ agent, x, y }) => {
        const selected = agent.id === selectedId;
        const load = loadByAgent[agent.id] ?? 0;
        const toggle = (): void => onSelect(selected ? null : agent.id);
        return (
          <g
            key={agent.id}
            className="org-node"
            data-status={agent.status}
            data-selected={selected}
            transform={`translate(${x}, ${y})`}
            role="button"
            aria-pressed={selected}
            aria-label={`${agent.displayName}, @${agent.slug}, ${agent.role}, ${agent.device}, ${agentStatusLabel(agent.status)}${load > 0 ? `, ${load} açık görev` : ''}`}
            tabIndex={0}
            onClick={toggle}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
              }
            }}
          >
            <rect className="org-box" width={ORG.nodeWidth} height={ORG.nodeHeight} rx={8} />
            <circle className="org-dot" cx={14} cy={ORG.nodeHeight / 2} r={5} />
            <text className="org-name" x={28} y={19}>
              {ellipsize(`@${agent.slug}`, NAME_MAX)}
            </text>
            <text className="org-role" x={28} y={33}>
              {ellipsize(`${agent.role} · ${agent.device}`, ROLE_MAX)}
            </text>
            {load > 0 ? (
              <text className="org-load" x={ORG.nodeWidth - 10} y={19} textAnchor="end">
                {load}
              </text>
            ) : null}
            {/* React 19: <title> tek bir metin cocugu ister; dizi verilirse SSR bos yazar. */}
            <title>{`${agent.displayName} · ${agentStatusLabel(agent.status)} · son görülme ${relativeAgo(agent.lastSeenAt)}`}</title>
          </g>
        );
      })}
    </svg>
  );
}
