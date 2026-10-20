import { diffArrays } from 'diff';

/**
 * One step of aligning an old sequence `a` against a new sequence `b`.
 * `sim` is the text similarity in [0, 1] for paired items.
 */
export type AlignOp =
  | { op: 'equal'; a: number; b: number }
  | { op: 'modified'; a: number; b: number; sim: number }
  | { op: 'removed'; a: number }
  | { op: 'added'; b: number }
  | { op: 'moved'; a: number; b: number; sim: number };

export interface AlignOptions<T> {
  key: (item: T) => string;
  text: (item: T) => string;
  similarity: (a: string, b: string) => number;
  /** Only items for which this returns true may be paired as modified/moved (e.g. same chat role). */
  pairable?: (a: T, b: T) => boolean;
  /** Minimum similarity to treat a removed+added pair in the same gap as one edited item. */
  modifyThreshold?: number;
  /** Detect items that changed position. */
  detectMoves?: boolean;
  /** Minimum similarity for an edited item that also moved. Exact moves are always detected. */
  moveThreshold?: number;
}

const MAX_DP_CELLS = 40_000;
const MAX_MOVE_COMPARISONS = 250_000;

/**
 * Align two sequences in three passes:
 * 1. LCS on exact keys gives the unchanged backbone.
 * 2. Inside each gap between backbone items, removed/added items are paired by similarity
 *    with an order-preserving DP, so a rewritten paragraph shows as "modified", not delete+insert.
 * 3. Leftover removals and additions anywhere in the document are matched as moves.
 */
export function align<T>(a: T[], b: T[], opts: AlignOptions<T>): AlignOp[] {
  const {
    key,
    text,
    similarity,
    pairable = () => true,
    modifyThreshold = 0.4,
    detectMoves = true,
    moveThreshold = 0.75,
  } = opts;

  const ka = a.map(key);
  const kb = b.map(key);

  // Pass 1: exact LCS.
  const raw: AlignOp[] = [];
  let i = 0;
  let j = 0;
  for (const part of diffArrays(ka, kb)) {
    const n = part.count ?? part.value.length;
    for (let k = 0; k < n; k++) {
      if (part.added) raw.push({ op: 'added', b: j++ });
      else if (part.removed) raw.push({ op: 'removed', a: i++ });
      else raw.push({ op: 'equal', a: i++, b: j++ });
    }
  }

  // Pass 2: pair within gaps.
  const ops: AlignOp[] = [];
  let p = 0;
  while (p < raw.length) {
    const cur = raw[p]!;
    if (cur.op === 'equal') {
      ops.push(cur);
      p++;
      continue;
    }
    const removed: number[] = [];
    const added: number[] = [];
    while (p < raw.length && raw[p]!.op !== 'equal') {
      const r = raw[p]!;
      if (r.op === 'removed') removed.push(r.a);
      else if (r.op === 'added') added.push(r.b);
      p++;
    }
    ops.push(...pairGap(removed, added, a, b, text, similarity, pairable, modifyThreshold));
  }

  if (!detectMoves) return ops;
  return detectMoved(ops, a, b, ka, kb, text, similarity, pairable, moveThreshold);
}

function pairGap<T>(
  removed: number[],
  added: number[],
  a: T[],
  b: T[],
  text: (t: T) => string,
  similarity: (x: string, y: string) => number,
  pairable: (x: T, y: T) => boolean,
  threshold: number,
): AlignOp[] {
  const R = removed.length;
  const A = added.length;
  if (!R || !A) {
    return [
      ...removed.map((ai): AlignOp => ({ op: 'removed', a: ai })),
      ...added.map((bi): AlignOp => ({ op: 'added', b: bi })),
    ];
  }

  const sim = (r: number, c: number): number => {
    const x = a[removed[r]!]!;
    const y = b[added[c]!]!;
    if (!pairable(x, y)) return 0;
    const s = similarity(text(x), text(y));
    return s >= threshold ? s : 0;
  };

  const pairs: [number, number, number][] = [];
  if ((R + 1) * (A + 1) <= MAX_DP_CELLS) {
    // Max-weight order-preserving matching (weighted LCS).
    const W = A + 1;
    const dp = new Float64Array((R + 1) * W);
    const s = new Float64Array(R * A);
    for (let r = 0; r < R; r++) for (let c = 0; c < A; c++) s[r * A + c] = sim(r, c);
    for (let r = R - 1; r >= 0; r--) {
      for (let c = A - 1; c >= 0; c--) {
        const take = s[r * A + c]! > 0 ? s[r * A + c]! + dp[(r + 1) * W + c + 1]! : 0;
        dp[r * W + c] = Math.max(take, dp[(r + 1) * W + c]!, dp[r * W + c + 1]!);
      }
    }
    let r = 0;
    let c = 0;
    while (r < R && c < A) {
      const sv = s[r * A + c]!;
      if (sv > 0 && dp[r * W + c] === sv + dp[(r + 1) * W + c + 1]!) {
        pairs.push([r, c, sv]);
        r++;
        c++;
      } else if (dp[r * W + c] === dp[(r + 1) * W + c]!) r++;
      else c++;
    }
  } else {
    // Large gap: greedy forward scan with a bounded lookahead.
    let c0 = 0;
    for (let r = 0; r < R && c0 < A; r++) {
      let best = -1;
      let bestS = 0;
      for (let c = c0; c < Math.min(A, c0 + 50); c++) {
        const sv = sim(r, c);
        if (sv > bestS) {
          bestS = sv;
          best = c;
        }
      }
      if (best >= 0) {
        pairs.push([r, best, bestS]);
        c0 = best + 1;
      }
    }
  }

  const out: AlignOp[] = [];
  let r = 0;
  let c = 0;
  for (const [pr, pc, sv] of pairs) {
    while (r < pr) out.push({ op: 'removed', a: removed[r++]! });
    while (c < pc) out.push({ op: 'added', b: added[c++]! });
    out.push({ op: 'modified', a: removed[r++]!, b: added[c++]!, sim: sv });
  }
  while (r < R) out.push({ op: 'removed', a: removed[r++]! });
  while (c < A) out.push({ op: 'added', b: added[c++]! });
  return out;
}

function detectMoved<T>(
  ops: AlignOp[],
  a: T[],
  b: T[],
  ka: string[],
  kb: string[],
  text: (t: T) => string,
  similarity: (x: string, y: string) => number,
  pairable: (x: T, y: T) => boolean,
  threshold: number,
): AlignOp[] {
  const removedAt = new Map<number, number>(); // a index -> op index
  const addedAt = new Map<number, number>(); // b index -> op index
  ops.forEach((o, idx) => {
    if (o.op === 'removed') removedAt.set(o.a, idx);
    else if (o.op === 'added') addedAt.set(o.b, idx);
  });
  if (!removedAt.size || !addedAt.size) return ops;

  const replace = new Map<number, AlignOp | null>();
  const usedA = new Set<number>();
  const usedB = new Set<number>();

  // Exact moves first.
  const byKey = new Map<string, number[]>();
  for (const ai of removedAt.keys()) {
    const list = byKey.get(ka[ai]!) ?? [];
    list.push(ai);
    byKey.set(ka[ai]!, list);
  }
  for (const bi of [...addedAt.keys()].sort((x, y) => x - y)) {
    const list = byKey.get(kb[bi]!);
    const ai = list?.shift();
    if (ai === undefined) continue;
    usedA.add(ai);
    usedB.add(bi);
    replace.set(removedAt.get(ai)!, null);
    replace.set(addedAt.get(bi)!, { op: 'moved', a: ai, b: bi, sim: 1 });
  }

  // Then moved-and-edited, greedily by best similarity.
  const ra = [...removedAt.keys()].filter((x) => !usedA.has(x));
  const rb = [...addedAt.keys()].filter((x) => !usedB.has(x));
  if (ra.length && rb.length && ra.length * rb.length <= MAX_MOVE_COMPARISONS) {
    const cands: [number, number, number][] = [];
    for (const ai of ra) {
      for (const bi of rb) {
        if (!pairable(a[ai]!, b[bi]!)) continue;
        const s = similarity(text(a[ai]!), text(b[bi]!));
        if (s >= threshold) cands.push([ai, bi, s]);
      }
    }
    cands.sort((x, y) => y[2] - x[2] || x[1] - y[1]);
    for (const [ai, bi, s] of cands) {
      if (usedA.has(ai) || usedB.has(bi)) continue;
      usedA.add(ai);
      usedB.add(bi);
      replace.set(removedAt.get(ai)!, null);
      replace.set(addedAt.get(bi)!, { op: 'moved', a: ai, b: bi, sim: s });
    }
  }

  if (!replace.size) return ops;
  const out: AlignOp[] = [];
  ops.forEach((o, idx) => {
    if (!replace.has(idx)) out.push(o);
    else {
      const r = replace.get(idx);
      if (r) out.push(r);
    }
  });
  return out;
}
