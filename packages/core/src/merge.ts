import { diff3MergeRegions } from 'node-diff3';
import { normalizeText, splitSentences, unitKey } from './text.js';
import type { Doc, Unit } from './types.js';

export type MergeRegion =
  | { type: 'ok'; units: Unit[] }
  | { type: 'conflict'; id: string; base: Unit[]; ours: Unit[]; theirs: Unit[] };

export type ConflictReason = 'content' | 'delete-modify' | 'add-add';

export type FileMergeResult =
  | {
      status: 'clean';
      /** `null` means the merged result deletes the file. */
      doc: Doc | null;
      /** Units where both sides edited the same paragraph but different sentences, merged automatically. */
      autoResolved: number;
    }
  | {
      status: 'conflict';
      reason: ConflictReason;
      /** Present for delete-modify conflicts. */
      deletedBy?: 'ours' | 'theirs';
      /** Kind/title/meta for the merged doc; units come from the regions. */
      header: Omit<Doc, 'units'>;
      regions: MergeRegion[];
      autoResolved: number;
    };

/**
 * How to resolve one conflict region.
 * `ours-then-theirs` / `theirs-then-ours` keep both sides, e.g. when two people added different paragraphs.
 */
export type ConflictChoice =
  | 'ours'
  | 'theirs'
  | 'base'
  | 'ours-then-theirs'
  | 'theirs-then-ours'
  | { units: Unit[] };

const sameKeys = (x: Unit[], y: Unit[]) => x.length === y.length && x.every((u, i) => unitKey(u) === unitKey(y[i]!));

/** Classic 3-way rule for one slot: if only one side changed it, take that side. */
function pick<T>(base: T[], ours: T[], theirs: T[], eq: (x: T[], y: T[]) => boolean): T[] | null {
  if (eq(ours, theirs)) return ours;
  if (eq(base, ours)) return theirs;
  if (eq(base, theirs)) return ours;
  return null;
}

/**
 * 3-way merge of a paragraph's text at sentence level. Returns `null` if both sides changed
 * the same sentence. This is what lets two people edit different sentences of one paragraph
 * without a conflict.
 */
export function mergeText(base: string, ours: string, theirs: string): string | null {
  const o = splitSentences(base);
  const a = splitSentences(ours);
  const b = splitSentences(theirs);
  const key = (s: string) => normalizeText(s);
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((s, i) => key(s) === key(y[i]!));
  let out = '';
  // Sentences from different versions may not carry trailing whitespace; add a space at the seam.
  const append = (parts: string[]) => {
    for (const s of parts) {
      if (out && s && !/\s$/.test(out) && !/^\s/.test(s)) out += ' ';
      out += s;
    }
  };
  for (const r of diff3MergeRegions(a.map(key), o.map(key), b.map(key))) {
    if (r.stable) {
      const src = r.buffer === 'a' ? a : r.buffer === 'b' ? b : o;
      append(src.slice(r.bufferStart, r.bufferStart + r.bufferLength));
      continue;
    }
    const os = o.slice(r.oStart, r.oStart + r.oLength);
    const as = a.slice(r.aStart, r.aStart + r.aLength);
    const bs = b.slice(r.bStart, r.bStart + r.bLength);
    const chosen = pick(os, as, bs, eq);
    if (chosen) {
      append(chosen);
      continue;
    }
    // Adjacent edits land in one region; resolve slot by slot when the shapes line up.
    if (!os.length || os.length !== as.length || os.length !== bs.length) return null;
    for (let i = 0; i < os.length; i++) {
      const slot = pick([os[i]!], [as[i]!], [bs[i]!], eq);
      if (!slot) return null;
      append(slot);
    }
  }
  return out;
}

function mergeUnitPair(base: Unit, ours: Unit, theirs: Unit): Unit | null {
  if (ours.type !== theirs.type || ours.type !== base.type) return null;
  const text = mergeText(base.text, ours.text, theirs.text);
  if (text === null) return null;
  const meta = unitKey(ours) === unitKey(base) ? theirs.meta : ours.meta;
  return meta ? { type: ours.type, text, meta } : { type: ours.type, text };
}

/**
 * Try to resolve a conflicting region automatically: if all three sides have the same number
 * of units, merge slot by slot, falling back to sentence-level merge inside a slot.
 */
function digIn(base: Unit[], ours: Unit[], theirs: Unit[]): { units: Unit[]; auto: number } | null {
  if (!base.length || base.length !== ours.length || base.length !== theirs.length) return null;
  const units: Unit[] = [];
  let auto = 0;
  for (let i = 0; i < base.length; i++) {
    const slot = pick([base[i]!], [ours[i]!], [theirs[i]!], sameKeys);
    if (slot) {
      units.push(...slot);
      continue;
    }
    const merged = mergeUnitPair(base[i]!, ours[i]!, theirs[i]!);
    if (!merged) return null;
    units.push(merged);
    auto++;
  }
  return { units, auto };
}

/** Unit-level diff3 with automatic sentence-level resolution. Adjacent ok regions are coalesced. */
export function mergeUnits(
  base: Unit[],
  ours: Unit[],
  theirs: Unit[],
): { regions: MergeRegion[]; conflicts: number; autoResolved: number } {
  const regions: MergeRegion[] = [];
  let conflicts = 0;
  let autoResolved = 0;
  const pushOk = (units: Unit[]) => {
    if (!units.length) return;
    const last = regions[regions.length - 1];
    if (last?.type === 'ok') last.units.push(...units);
    else regions.push({ type: 'ok', units: [...units] });
  };

  for (const r of diff3MergeRegions(ours.map(unitKey), base.map(unitKey), theirs.map(unitKey))) {
    if (r.stable) {
      const src = r.buffer === 'a' ? ours : r.buffer === 'b' ? theirs : base;
      pushOk(src.slice(r.bufferStart, r.bufferStart + r.bufferLength));
      continue;
    }
    const o = base.slice(r.oStart, r.oStart + r.oLength);
    const a = ours.slice(r.aStart, r.aStart + r.aLength);
    const b = theirs.slice(r.bStart, r.bStart + r.bLength);
    const chosen = pick(o, a, b, sameKeys);
    if (chosen) {
      pushOk(chosen);
      continue;
    }
    const dug = digIn(o, a, b);
    if (dug) {
      autoResolved += dug.auto;
      pushOk(dug.units);
      continue;
    }
    conflicts++;
    regions.push({ type: 'conflict', id: `c${conflicts}`, base: o, ours: a, theirs: b });
  }
  return { regions, conflicts, autoResolved };
}

function mergeHeader(base: Doc | null, ours: Doc, theirs: Doc): Omit<Doc, 'units'> {
  const field = <K extends 'kind' | 'title' | 'meta'>(k: K): Doc[K] => {
    const enc = (d: Doc | null) => JSON.stringify(d?.[k] ?? null);
    // Ours wins on genuinely conflicting metadata; content conflicts are what matter.
    return enc(ours) === enc(base) ? theirs[k] : ours[k];
  };
  const header: Omit<Doc, 'units'> = { kind: field('kind') };
  const title = field('title');
  const meta = field('meta');
  if (title !== undefined) header.title = title;
  if (meta !== undefined) header.meta = meta;
  return header;
}

/**
 * 3-way merge of one file. Any side may be `null` (file absent on that side).
 * Callers should short-circuit identical hashes before calling this.
 */
export function mergeDocs(base: Doc | null, ours: Doc | null, theirs: Doc | null): FileMergeResult {
  if (!ours && !theirs) return { status: 'clean', doc: null, autoResolved: 0 };

  if (!ours || !theirs) {
    const present = (ours ?? theirs)!;
    // Added on one side only.
    if (!base) return { status: 'clean', doc: present, autoResolved: 0 };
    // Deleted on one side; clean only if the other side didn't touch it.
    if (sameKeys(base.units, present.units)) return { status: 'clean', doc: null, autoResolved: 0 };
    return {
      status: 'conflict',
      reason: 'delete-modify',
      deletedBy: ours ? 'theirs' : 'ours',
      header: mergeHeader(base, present, present),
      regions: [
        { type: 'conflict', id: 'c1', base: base.units, ours: ours?.units ?? [], theirs: theirs?.units ?? [] },
      ],
      autoResolved: 0,
    };
  }

  const header = mergeHeader(base, ours, theirs);
  const { regions, conflicts, autoResolved } = mergeUnits(base?.units ?? [], ours.units, theirs.units);
  if (!conflicts) {
    const units = regions.flatMap((r) => (r.type === 'ok' ? r.units : []));
    return { status: 'clean', doc: { ...header, units }, autoResolved };
  }
  return { status: 'conflict', reason: base ? 'content' : 'add-add', header, regions, autoResolved };
}

/** Units chosen for one conflict region. */
export function resolveRegion(
  region: Extract<MergeRegion, { type: 'conflict' }>,
  choice: ConflictChoice,
): Unit[] {
  if (typeof choice === 'object') return choice.units;
  switch (choice) {
    case 'ours':
      return region.ours;
    case 'theirs':
      return region.theirs;
    case 'base':
      return region.base;
    case 'ours-then-theirs':
      return [...region.ours, ...region.theirs];
    case 'theirs-then-ours':
      return [...region.theirs, ...region.ours];
  }
}

/**
 * Apply choices to a conflicted file. Returns `null` when the resolution deletes the file
 * (choosing the deleting side of a delete-modify conflict). Throws if a region has no choice.
 */
export function applyResolution(
  file: Extract<FileMergeResult, { status: 'conflict' }>,
  choices: Record<string, ConflictChoice>,
): { doc: Doc | null; missing: string[] } {
  const missing = file.regions.flatMap((r) => (r.type === 'conflict' && !(r.id in choices) ? [r.id] : []));
  if (missing.length) return { doc: null, missing };

  if (file.reason === 'delete-modify') {
    const choice = choices['c1']!;
    if (choice === file.deletedBy) return { doc: null, missing: [] };
  }
  const units = file.regions.flatMap((r) => (r.type === 'ok' ? r.units : resolveRegion(r, choices[r.id]!)));
  return { doc: { ...file.header, units }, missing: [] };
}
