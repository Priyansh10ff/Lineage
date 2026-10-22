import type { BranchGraph } from '@lineage/core';
import { isAgentBranch, laneColor } from '@/lib/lanes';

/** A label-free thumbnail of a workspace's map for cards. */
export function MiniMap({ graph, width = 360, height = 112 }: { graph: BranchGraph; width?: number; height?: number }) {
  const pad = 24;
  const cols = Math.max(1, graph.columns - 1);
  const rowH = Math.min(30, (height - 2 * pad) / Math.max(1, graph.rows - 1));
  const x = (c: number) => pad + (c / cols) * (width - 2 * pad);
  const y = (r: number) => pad + 6 + r * rowH;
  const pos = new Map(graph.nodes.map((n) => [n.hash, n]));
  const lane = new Map(graph.lanes.map((l) => [l.index, l]));
  const tip = graph.nodes.find((n) => n.heads.includes('main'));
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" aria-hidden className="block">
      {graph.edges.map((e) => {
        const a = pos.get(e.from)!;
        const b = pos.get(e.to)!;
        const l = lane.get(e.kind === 'merge' ? a.lane : b.lane)!;
        const d =
          a.row === b.row
            ? `M ${x(a.column)} ${y(a.row)} H ${x(b.column)}`
            : e.kind === 'merge'
              ? `M ${x(a.column)} ${y(a.row)} H ${x(b.column)} V ${y(b.row)}`
              : `M ${x(a.column)} ${y(a.row)} V ${y(b.row)} H ${x(b.column)}`;
        return (
          <path
            key={`${e.from}-${e.to}`}
            d={d}
            fill="none"
            stroke={laneColor(l)}
            strokeWidth={6}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={isAgentBranch(l.name) && l.status !== 'merged' ? '1 9' : undefined}
          />
        );
      })}
      {graph.nodes
        .filter((n) => n !== tip)
        .map((n) => (
          <circle key={n.hash} cx={x(n.column)} cy={y(n.row)} r={4.5} fill="#FFFFFF" stroke="#17181C" strokeWidth={2.5} />
        ))}
      {tip && <circle cx={x(tip.column)} cy={y(tip.row)} r={9} fill="#17181C" stroke="#E9EFFD" strokeWidth={4} />}
    </svg>
  );
}
