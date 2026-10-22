import type { BranchGraph, GraphEdge, GraphNode } from '@lineage/core';
import Link from 'next/link';
import { short, truncate } from '@/lib/format';
import { isAgentBranch, laneColor } from '@/lib/lanes';
import { ScrollToEnd } from './ScrollToEnd';

const COL = 136;
const ROW = 76;
const PAD_X = 76;
const TOP = 64;
const RADIUS = 16;
const STROKE = 8;

interface Props {
  graph: BranchGraph;
  /** Link target for a station; receives the commit hash. */
  hrefFor: (hash: string) => string;
  /** Tip of the branch being viewed: drawn as the "you are here" station. */
  current?: string;
  selected?: string;
  compact?: boolean;
}

/**
 * The commit graph drawn as a subway map: one track per line of work, stations for commits,
 * interchanges for merges. Scrolls horizontally and starts scrolled to the newest end.
 */
export function TransitMap({ graph, hrefFor, current, selected, compact }: Props) {
  const rowH = compact ? 60 : ROW;
  const pos = new Map(graph.nodes.map((n) => [n.hash, { x: PAD_X + n.column * COL, y: TOP + n.row * rowH, node: n }]));
  const width = PAD_X * 2 + Math.max(0, graph.columns - 1) * COL;
  const height = TOP + (graph.rows - 1) * rowH + (graph.rows > 1 ? 64 : 34);
  const laneByIndex = new Map(graph.lanes.map((l) => [l.index, l]));

  const edgeStyle = (e: GraphEdge) => {
    const child = pos.get(e.to)!.node;
    const parent = pos.get(e.from)!.node;
    const lane = laneByIndex.get(e.kind === 'merge' ? parent.lane : child.lane)!;
    return { color: laneColor(lane), dotted: isAgentBranch(lane.name) && lane.status !== 'merged' };
  };

  const path = (e: GraphEdge): string => {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    if (a.y === b.y) return `M ${a.x} ${a.y} H ${b.x}`;
    const dir = b.y > a.y ? 1 : -1;
    if (e.kind === 'merge') {
      // Run along the side track, then turn into the target line.
      return `M ${a.x} ${a.y} H ${b.x - RADIUS} Q ${b.x} ${a.y} ${b.x} ${a.y + dir * RADIUS} V ${b.y}`;
    }
    // Leave the parent's line vertically, then run along the new track.
    return `M ${a.x} ${a.y} V ${b.y - dir * RADIUS} Q ${a.x} ${b.y} ${a.x + RADIUS} ${b.y} H ${b.x}`;
  };

  // Merge commits become interchanges spanning the rows they join.
  const interchange = (n: GraphNode) => {
    if (n.commit.parents.length < 2) return null;
    const rows = n.commit.parents.map((p) => pos.get(p)?.node.row).filter((r): r is number => r !== undefined);
    const lo = Math.min(n.row, ...rows);
    const hi = Math.max(n.row, ...rows);
    return { top: TOP + lo * rowH, bottom: TOP + hi * rowH };
  };

  return (
    <ScrollToEnd className="overflow-x-auto">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Branch map: ${graph.nodes.length} commits on ${graph.lanes.length} lines`}
        className="block"
      >
        {graph.edges.map((e) => {
          const s = edgeStyle(e);
          return (
            <path
              key={`${e.from}-${e.to}`}
              d={path(e)}
              fill="none"
              stroke={s.color}
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={s.dotted ? '1 13' : undefined}
            />
          );
        })}

        {graph.nodes.map((n) => {
          const p = pos.get(n.hash)!;
          const ic = interchange(n);
          const isCurrent = n.hash === current;
          const isSelected = n.hash === selected;
          const above = n.row === 0;
          const labelY = above ? p.y - 38 : p.y + 30;
          return (
            <Link key={n.hash} href={hrefFor(n.hash)} aria-label={`${n.commit.message} (${short(n.hash)})`}>
              <title>{`${n.commit.message}\n${n.commit.author.name} · ${short(n.hash)}`}</title>
              {isSelected && (
                <circle cx={p.x} cy={p.y} r={20} fill="none" stroke="#F08A24" strokeWidth={4} />
              )}
              {ic ? (
                <rect
                  x={p.x - 13}
                  y={ic.top - 13}
                  width={26}
                  height={ic.bottom - ic.top + 26}
                  rx={13}
                  fill={isCurrent ? '#17181C' : '#FAFAF7'}
                  stroke="#17181C"
                  strokeWidth={4}
                />
              ) : isCurrent ? (
                <>
                  <circle cx={p.x} cy={p.y} r={14} fill="#17181C" />
                  <circle cx={p.x} cy={p.y} r={8} fill="#17181C" stroke="#FAFAF7" strokeWidth={4} />
                </>
              ) : (
                <circle cx={p.x} cy={p.y} r={9} fill="#FAFAF7" stroke="#17181C" strokeWidth={4} />
              )}
              <text
                x={p.x}
                y={labelY}
                textAnchor="middle"
                className="fill-ink"
                style={{ fontSize: 12, fontWeight: isCurrent ? 800 : 700 }}
              >
                {truncate(n.commit.message, 20)}
              </text>
              <text
                x={p.x}
                y={labelY + 15}
                textAnchor="middle"
                className="fill-muted"
                style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}
              >
                {isCurrent ? `${short(n.hash)} · here` : `${short(n.hash)} · ${n.commit.author.name}`}
              </text>
            </Link>
          );
        })}
      </svg>
    </ScrollToEnd>
  );
}

/** Legend chips for the lines on the map. */
export function LineLegend({ graph }: { graph: BranchGraph }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-2" aria-label="Lines">
      {graph.lanes.map((l) => (
        <li key={l.index} className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-0 w-6"
            style={{
              borderTop: `6px ${isAgentBranch(l.name) && l.status !== 'merged' ? 'dotted' : 'solid'} ${laneColor(l)}`,
              borderRadius: 3,
            }}
          />
          <span className="font-semibold">{l.name}</span>
          {l.status === 'merged' && <span className="text-muted">(merged{l.exists ? '' : ', deleted'})</span>}
        </li>
      ))}
    </ul>
  );
}
