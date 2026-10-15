import type { FloorPointView } from '@firesafety/shared';
import { CATEGORY_LABELS_HE } from '@firesafety/shared';

const SYMBOL: Record<string, string> = { fire: '▲', prealarm: '△', fault: '■', supervisory: '●', disabled: '⊘', test: '◆', normal: '•' };

interface Props {
  planFileId: string;
  points: FloorPointView[];
  highlightId?: string | null;
  selectedId?: string | null;
  /** Editor mode: clicking the plan reports relative coordinates. */
  onPick?: (x: number, y: number) => void;
  summary: string;
}

/**
 * Plan image with point markers. Coordinates are relative (0..1) to the image, so they are
 * physical left/top even in RTL. The visual map is decorative for assistive tech: the
 * accompanying table is the accessible equivalent, and the figure exposes a text summary.
 */
export function FloorMap({ planFileId, points, highlightId, selectedId, onPick, summary }: Props) {
  const placed = points.filter((p) => p.x !== null && p.y !== null);
  return (
    <figure className="floor-map" role="img" aria-label={summary}>
      <div
        className={`floor-map-canvas${onPick ? ' pickable' : ''}`}
        onClick={(e) => {
          if (!onPick) return;
          const r = e.currentTarget.getBoundingClientRect();
          onPick(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
        }}
      >
        <img src={`/api/files/${planFileId}`} alt="" draggable={false} />
        {placed.map((p) => {
          const active = p.category !== 'normal';
          const cls = [
            'marker',
            `marker-${p.category}`,
            active && !p.acked ? 'marker-unacked' : '',
            p.id === highlightId ? 'marker-highlight' : '',
            p.id === selectedId ? 'marker-selected' : '',
          ].join(' ');
          return (
            <span key={p.id} className={cls} style={{ left: `${p.x! * 100}%`, top: `${p.y! * 100}%` }} aria-hidden="true" title={`${p.label}: ${CATEGORY_LABELS_HE[p.category]}`}>
              <span className="marker-symbol">{SYMBOL[p.category]}</span>
              {(active || p.id === highlightId || p.id === selectedId) && <span className="marker-label">{p.label}</span>}
            </span>
          );
        })}
      </div>
    </figure>
  );
}

export function floorSummary(name: string, points: FloorPointView[]): string {
  const counts = new Map<string, number>();
  for (const p of points) if (p.category !== 'normal') counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const parts = [...counts].map(([c, n]) => `${n} ${CATEGORY_LABELS_HE[c as keyof typeof CATEGORY_LABELS_HE]}`);
  return `מפת ${name}: ${parts.length ? parts.join(', ') : 'אין אירועים פעילים'}. פירוט מלא בטבלה שלהלן.`;
}
