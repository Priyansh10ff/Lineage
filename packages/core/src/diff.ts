import { diffWordsWithSpace } from 'diff';
import { align } from './align.js';
import { normalizeText, similarity, splitSentences, truncate, unitKey } from './text.js';
import type { ArtifactKind, Doc, Hash, Unit } from './types.js';

export interface WordChange {
  op: 'equal' | 'added' | 'removed';
  text: string;
}

/** A sentence-level (prose) or line-level (code) change inside an edited unit. */
export type SegmentChange =
  | { op: 'equal'; text: string }
  | { op: 'added'; text: string }
  | { op: 'removed'; text: string }
  | { op: 'modified'; before: string; after: string; words: WordChange[] };

export type UnitChange =
  | { op: 'equal'; oldIndex: number; newIndex: number; unit: Unit }
  | { op: 'added'; newIndex: number; unit: Unit; section?: string }
  | { op: 'removed'; oldIndex: number; unit: Unit; section?: string }
  | {
      op: 'modified';
      oldIndex: number;
      newIndex: number;
      before: Unit;
      after: Unit;
      similarity: number;
      segments: SegmentChange[];
      section?: string;
    }
  | {
      op: 'moved';
      oldIndex: number;
      newIndex: number;
      before: Unit;
      after: Unit;
      /** 1 for a pure move; lower when the unit was also edited. */
      similarity: number;
      segments: SegmentChange[];
      section?: string;
    };

export interface DiffStats {
  unchanged: number;
  added: number;
  removed: number;
  modified: number;
  moved: number;
}

export interface DocDiff {
  kind: ArtifactKind;
  kindChanged?: { from: ArtifactKind; to: ArtifactKind };
  titleChanged?: { from?: string; to?: string };
  /** In new-document order, with removals placed where they were in the old document. */
  changes: UnitChange[];
  stats: DiffStats;
  /** Human-readable one-liners, e.g. `Rewrote paragraph in "Methods" (2 sentences changed)`. */
  summary: string[];
}

const EMPTY_DOC: Doc = { kind: 'prose', units: [] };

/** Units must share type, and chat turns must share role, to count as "the same unit, edited". */
function pairable(x: Unit, y: Unit): boolean {
  const textual = new Set(['paragraph', 'list', 'quote']);
  const sameFamily = x.type === y.type || (textual.has(x.type) && textual.has(y.type));
  return sameFamily && (x.meta?.['role'] ?? null) === (y.meta?.['role'] ?? null);
}

function isCodeLike(u: Unit): boolean {
  return u.type === 'code_block' || u.type === 'symbol' || u.type === 'line';
}

function splitLines(text: string): string[] {
  return text.split(/(?<=\n)/);
}

/** Diff two texts sentence by sentence (or line by line for code), with word-level detail for edited segments. */
export function diffSegments(before: string, after: string, code = false): SegmentChange[] {
  const sa = code ? splitLines(before) : splitSentences(before);
  const sb = code ? splitLines(after) : splitSentences(after);
  const ops = align(sa, sb, {
    key: (s) => normalizeText(s),
    text: (s) => s,
    similarity,
    modifyThreshold: 0.3,
    detectMoves: false,
  });
  return ops.map((o): SegmentChange => {
    switch (o.op) {
      case 'equal':
        return { op: 'equal', text: sb[o.b]! };
      case 'added':
        return { op: 'added', text: sb[o.b]! };
      case 'removed':
        return { op: 'removed', text: sa[o.a]! };
      default:
        return {
          op: 'modified',
          before: sa[o.a]!,
          after: sb[o.b]!,
          words: diffWords(sa[o.a]!, sb[o.b]!),
        };
    }
  });
}

export function diffWords(before: string, after: string): WordChange[] {
  return diffWordsWithSpace(before, after).map((p) => ({
    op: p.added ? 'added' : p.removed ? 'removed' : 'equal',
    text: p.value,
  }));
}

/** Section label for each unit: nearest preceding heading for prose, page for PDFs. */
function sections(doc: Doc): (string | undefined)[] {
  let current: string | undefined;
  return doc.units.map((u) => {
    if (u.type === 'heading') {
      current = u.text.replace(/^#+\s*/, '');
      return current;
    }
    const page = u.meta?.['page'];
    if (typeof page === 'number' && doc.kind === 'pdf') return current ? `${current}, p.${page}` : `p.${page}`;
    return current;
  });
}

/**
 * Semantic diff between two versions of an artifact. Works on units (paragraphs, turns,
 * symbols), pairs edited units by similarity, detects moves, and drills into edited
 * units at sentence/line and then word level.
 */
export function diffDocs(oldDoc: Doc | null, newDoc: Doc | null): DocDiff {
  const a = oldDoc ?? { ...EMPTY_DOC, kind: newDoc?.kind ?? 'prose' };
  const b = newDoc ?? { ...EMPTY_DOC, kind: a.kind };
  const ops = align(a.units, b.units, {
    key: unitKey,
    text: (u) => u.text,
    similarity,
    pairable,
  });
  const secA = sections(a);
  const secB = sections(b);
  const stats: DiffStats = { unchanged: 0, added: 0, removed: 0, modified: 0, moved: 0 };

  const changes: UnitChange[] = ops.map((o): UnitChange => {
    switch (o.op) {
      case 'equal':
        stats.unchanged++;
        return { op: 'equal', oldIndex: o.a, newIndex: o.b, unit: b.units[o.b]! };
      case 'added':
        stats.added++;
        return withSection({ op: 'added', newIndex: o.b, unit: b.units[o.b]! }, secB[o.b]);
      case 'removed':
        stats.removed++;
        return withSection({ op: 'removed', oldIndex: o.a, unit: a.units[o.a]! }, secA[o.a]);
      case 'modified':
      case 'moved': {
        stats[o.op]++;
        const before = a.units[o.a]!;
        const after = b.units[o.b]!;
        const segments =
          o.sim === 1 && normalizeText(before.text) === normalizeText(after.text)
            ? []
            : diffSegments(before.text, after.text, isCodeLike(after));
        return withSection(
          { op: o.op, oldIndex: o.a, newIndex: o.b, before, after, similarity: o.sim, segments },
          secB[o.b],
        );
      }
    }
  });

  const result: DocDiff = { kind: b.kind, changes, stats, summary: [] };
  if (oldDoc && newDoc && oldDoc.kind !== newDoc.kind) result.kindChanged = { from: oldDoc.kind, to: newDoc.kind };
  if ((oldDoc?.title ?? undefined) !== (newDoc?.title ?? undefined)) {
    result.titleChanged = {};
    if (oldDoc?.title !== undefined) result.titleChanged.from = oldDoc.title;
    if (newDoc?.title !== undefined) result.titleChanged.to = newDoc.title;
  }
  result.summary = summarize(result, b);
  return result;
}

function withSection<T extends UnitChange>(c: T, section: string | undefined): T {
  if (section !== undefined && c.op !== 'equal') (c as { section?: string }).section = section;
  return c;
}

function unitNoun(u: Unit): string {
  switch (u.type) {
    case 'turn': {
      const role = u.meta?.['role'];
      return role ? `${role} turn` : 'turn';
    }
    case 'symbol': {
      const kind = u.meta?.['symbolKind'];
      const name = u.meta?.['name'];
      return `${kind ?? 'symbol'}${name ? ` \`${name}\`` : ''}`;
    }
    case 'code_block':
      return 'code block';
    default:
      return u.type;
  }
}

function where(c: { section?: string }): string {
  return c.section ? ` in "${c.section}"` : '';
}

function countSegments(segments: SegmentChange[], code: boolean): string {
  const n = { added: 0, removed: 0, modified: 0 };
  for (const s of segments) if (s.op !== 'equal') n[s.op]++;
  const noun = code ? 'line' : 'sentence';
  const parts: string[] = [];
  if (n.modified) parts.push(`${n.modified} ${noun}${n.modified > 1 ? 's' : ''} changed`);
  if (n.added) parts.push(`${n.added} added`);
  if (n.removed) parts.push(`${n.removed} removed`);
  return parts.join(', ');
}

function summarize(d: DocDiff, newDoc: Doc): string[] {
  const out: string[] = [];
  if (d.kindChanged) out.push(`Artifact type changed from ${d.kindChanged.from} to ${d.kindChanged.to}`);
  if (d.titleChanged) out.push(`Title changed to "${d.titleChanged.to ?? ''}"`);
  for (const c of d.changes) {
    switch (c.op) {
      case 'equal':
        break;
      case 'added':
        out.push(`Added ${unitNoun(c.unit)}${where(c)}: "${truncate(c.unit.text)}"`);
        break;
      case 'removed':
        out.push(`Removed ${unitNoun(c.unit)}${where(c)}: "${truncate(c.unit.text)}"`);
        break;
      case 'modified': {
        const detail = countSegments(c.segments, isCodeLike(c.after));
        const verb = c.similarity < 0.6 ? 'Rewrote' : 'Edited';
        out.push(`${verb} ${unitNoun(c.after)}${where(c)}${detail ? ` (${detail})` : ''}`);
        break;
      }
      case 'moved': {
        const detail = c.similarity < 1 ? countSegments(c.segments, isCodeLike(c.after)) : '';
        out.push(
          `Moved ${unitNoun(c.after)} "${truncate(c.after.text, 40)}" from position ${c.oldIndex + 1} to ${
            c.newIndex + 1
          }${detail ? ` and edited it (${detail})` : ''}`,
        );
        break;
      }
    }
  }
  if (!out.length && newDoc.units.length) out.push('No content changes');
  return out;
}

export type FileStatus = 'added' | 'removed' | 'modified' | 'renamed';

export interface FileChange {
  path: string;
  status: FileStatus;
  oldPath?: string;
  oldHash?: Hash;
  newHash?: Hash;
}

/** Compare two tree snapshots. Identical content under a new path is reported as a rename. */
export function diffTreeEntries(oldEntries: Record<string, Hash>, newEntries: Record<string, Hash>): FileChange[] {
  const out: FileChange[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  for (const [path, hash] of Object.entries(oldEntries)) {
    const nh = newEntries[path];
    if (nh === undefined) removed.push(path);
    else if (nh !== hash) out.push({ path, status: 'modified', oldHash: hash, newHash: nh });
  }
  for (const path of Object.keys(newEntries)) if (!(path in oldEntries)) added.push(path);

  const removedByHash = new Map<Hash, string[]>();
  for (const p of removed) {
    const h = oldEntries[p]!;
    removedByHash.set(h, [...(removedByHash.get(h) ?? []), p]);
  }
  const renamedFrom = new Set<string>();
  for (const p of added) {
    const h = newEntries[p]!;
    const from = removedByHash.get(h)?.shift();
    if (from !== undefined) {
      renamedFrom.add(from);
      out.push({ path: p, status: 'renamed', oldPath: from, oldHash: h, newHash: h });
    } else out.push({ path: p, status: 'added', newHash: h });
  }
  for (const p of removed) if (!renamedFrom.has(p)) out.push({ path: p, status: 'removed', oldHash: oldEntries[p]! });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}
