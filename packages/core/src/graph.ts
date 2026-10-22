import type { CommitObject, Hash } from './types.js';

/** One commit placed on the map. `column` is its position in time order, `row` its track. */
export interface GraphNode {
  hash: Hash;
  commit: CommitObject;
  column: number;
  row: number;
  lane: number;
  /** Branch names whose tip is this commit. */
  heads: string[];
}

export interface GraphLane {
  index: number;
  row: number;
  /** Branch name, or the branch name recovered from a merge message for deleted branches. */
  name: string;
  /** `active`: an existing branch with commits not on the primary line. `merged`: fully merged or deleted. */
  status: 'primary' | 'active' | 'merged';
  /** True if the branch still exists as a ref. */
  exists: boolean;
  firstColumn: number;
  lastColumn: number;
}

/** A connection from a parent to a child. `branch` leaves a track, `merge` joins one. */
export interface GraphEdge {
  from: Hash;
  to: Hash;
  kind: 'line' | 'branch' | 'merge';
}

export interface BranchGraph {
  nodes: GraphNode[];
  lanes: GraphLane[];
  edges: GraphEdge[];
  columns: number;
  rows: number;
}

/** Order commits so parents always come before children, ties broken by time then hash. */
function topoOrder(commits: Map<Hash, CommitObject>): Hash[] {
  const children = new Map<Hash, Hash[]>();
  const pending = new Map<Hash, number>();
  for (const [h, c] of commits) {
    const parents = c.parents.filter((p) => commits.has(p));
    pending.set(h, parents.length);
    for (const p of parents) children.set(p, [...(children.get(p) ?? []), h]);
  }
  const key = (h: Hash) => `${commits.get(h)!.timestamp}\u0000${h}`;
  const ready = [...pending].filter(([, n]) => n === 0).map(([h]) => h);
  const out: Hash[] = [];
  while (ready.length) {
    ready.sort((a, b) => (key(a) < key(b) ? -1 : 1));
    const h = ready.shift()!;
    out.push(h);
    for (const c of children.get(h) ?? []) {
      const n = pending.get(c)! - 1;
      pending.set(c, n);
      if (n === 0) ready.push(c);
    }
  }
  return out;
}

const MERGE_NAME = /^Merge (\S+)/;

/**
 * Lay out a commit graph as a transit map: the primary branch runs along row 0, every other
 * line of work gets its own track, and tracks whose lifetimes don't overlap share a row.
 * Branches that were merged and deleted are recovered from merge commits' second parents.
 */
export function layoutGraph(
  commits: Map<Hash, CommitObject>,
  branches: Record<string, Hash>,
  primary = 'main',
): BranchGraph {
  const order = topoOrder(commits);
  const column = new Map(order.map((h, i) => [h, i]));
  const laneOf = new Map<Hash, number>();
  const lanes: Omit<GraphLane, 'row' | 'firstColumn' | 'lastColumn'>[] = [];

  const claim = (tip: Hash, name: string, exists: boolean): void => {
    const owned: Hash[] = [];
    let h: Hash | undefined = tip;
    while (h && commits.has(h) && !laneOf.has(h)) {
      owned.push(h);
      h = commits.get(h)!.parents[0];
    }
    if (!owned.length) return;
    const index = lanes.length;
    for (const o of owned) laneOf.set(o, index);
    lanes.push({ index, name, status: index === 0 ? 'primary' : 'active', exists });
  };

  const names = Object.keys(branches);
  const ordered = [
    ...(primary in branches ? [primary] : []),
    ...names.filter((n) => n !== primary).sort((a, b) => (column.get(branches[a]!) ?? 0) - (column.get(branches[b]!) ?? 0)),
  ];
  for (const name of ordered) claim(branches[name]!, name, true);

  // Lines of work reachable only through merges (their branch was deleted).
  for (const h of [...order].reverse()) {
    const c = commits.get(h)!;
    for (const p of c.parents.slice(1)) {
      if (!laneOf.has(p) && commits.has(p)) {
        const name = MERGE_NAME.exec(c.message)?.[1] ?? 'merged line';
        claim(p, name, false);
      }
    }
  }
  for (const h of order) if (!laneOf.has(h)) claim(h, 'detached', false);

  // Which existing branches are fully merged into the primary line?
  const primaryTip = branches[primary];
  const onPrimary = new Set<Hash>();
  if (primaryTip) {
    const stack = [primaryTip];
    while (stack.length) {
      const h = stack.pop()!;
      if (onPrimary.has(h) || !commits.has(h)) continue;
      onPrimary.add(h);
      stack.push(...commits.get(h)!.parents);
    }
  }

  const edges: GraphEdge[] = [];
  const span = lanes.map(() => ({ first: Infinity, last: -Infinity }));
  for (const h of order) {
    const c = commits.get(h)!;
    const lane = laneOf.get(h)!;
    const col = column.get(h)!;
    span[lane]!.first = Math.min(span[lane]!.first, col);
    span[lane]!.last = Math.max(span[lane]!.last, col);
    c.parents.forEach((p, i) => {
      if (!commits.has(p)) return;
      const pl = laneOf.get(p)!;
      if (pl === lane) edges.push({ from: p, to: h, kind: 'line' });
      else if (i === 0) {
        edges.push({ from: p, to: h, kind: 'branch' });
        span[lane]!.first = Math.min(span[lane]!.first, column.get(p)!);
      } else {
        edges.push({ from: p, to: h, kind: 'merge' });
        span[pl]!.last = Math.max(span[pl]!.last, col);
      }
    });
  }

  // Pack lanes into rows: row 0 is the primary line; others take the first row they fit in.
  const rowSpans: { first: number; last: number }[][] = [];
  const laneRow = lanes.map((l) => {
    const s = span[l.index]!;
    let row = l.index === 0 ? 0 : 1;
    while ((rowSpans[row] ?? []).some((o) => !(s.last < o.first || s.first > o.last))) row++;
    (rowSpans[row] ??= []).push(s);
    return row;
  });

  const heads = new Map<Hash, string[]>();
  for (const [name, h] of Object.entries(branches)) heads.set(h, [...(heads.get(h) ?? []), name]);

  const nodes: GraphNode[] = order.map((h) => {
    const lane = laneOf.get(h)!;
    return { hash: h, commit: commits.get(h)!, column: column.get(h)!, row: laneRow[lane]!, lane, heads: heads.get(h) ?? [] };
  });

  const outLanes: GraphLane[] = lanes.map((l) => {
    const merged = l.index !== 0 && (!l.exists || (branches[l.name] !== undefined && onPrimary.has(branches[l.name]!)));
    return {
      ...l,
      status: l.index === 0 ? 'primary' : merged ? 'merged' : 'active',
      row: laneRow[l.index]!,
      firstColumn: span[l.index]!.first,
      lastColumn: span[l.index]!.last,
    };
  });

  return {
    nodes,
    lanes: outLanes,
    edges,
    columns: order.length,
    rows: Math.max(0, ...laneRow) + 1,
  };
}
