import { diffDocs, diffTreeEntries, type DocDiff, type FileChange } from './diff.js';
import { layoutGraph, type BranchGraph } from './graph.js';
import {
  InvalidRefNameError,
  LineageError,
  NothingToCommitError,
  ObjectNotFoundError,
  RefExistsError,
  RefNotFoundError,
  UnresolvedConflictsError,
} from './errors.js';
import { applyResolution, mergeDocs, type ConflictChoice, type FileMergeResult } from './merge.js';
import type { Store } from './store.js';
import type { Author, BlobObject, CommitObject, Doc, Hash, LineageObject, TreeObject } from './types.js';

const HEADS = 'refs/heads/';
const HASH_RE = /^[0-9a-f]{64}$/;

export interface CommitInput {
  branch: string;
  author: Author;
  message: string;
  /** path → new doc, or `null` to delete the file. Paths not listed are carried over. */
  changes: Record<string, Doc | null>;
  /**
   * The head this edit was based on. If the branch has moved since, the commit is rejected
   * with RefConflictError instead of silently overwriting someone else's work.
   */
  expectedHead?: Hash;
  allowEmpty?: boolean;
}

export interface LogEntry {
  hash: Hash;
  commit: CommitObject;
}

export interface FileDiff extends FileChange {
  diff: DocDiff;
}

export interface TreeDiff {
  from: Hash | null;
  to: Hash;
  files: FileDiff[];
}

export type ConflictedFile = Extract<FileMergeResult, { status: 'conflict' }>;

/** Everything needed to finish a conflicted merge. Plain data, so it can be sent to a UI and back. */
export interface MergeDraft {
  into: string;
  oursHead: Hash;
  theirsHead: Hash;
  base: Hash | null;
  message: string;
  /** Resolved entries (clean and auto-merged files), path → blob hash. */
  tree: Record<string, Hash>;
  conflicts: Record<string, ConflictedFile>;
  autoMerged: string[];
}

export type MergePreview =
  | { status: 'up-to-date'; head: Hash }
  | { status: 'ready'; draft: MergeDraft; canFastForward: boolean };

export type MergeOutcome =
  | { status: 'up-to-date'; head: Hash }
  | { status: 'fast-forward'; head: Hash }
  | { status: 'merged'; head: Hash; autoMerged: string[] }
  | { status: 'conflicts'; draft: MergeDraft };

export interface RepositoryOptions {
  now?: () => Date;
}

export function validateBranchName(name: string): void {
  if (
    !/^[A-Za-z0-9._/-]+$/.test(name) ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.includes('..') ||
    name.includes('//') ||
    HASH_RE.test(name)
  ) {
    throw new InvalidRefNameError(name);
  }
}

/**
 * A versioned research workspace: git's object model (blobs, trees, commits, branch refs)
 * over normalized research artifacts instead of raw bytes.
 */
export class Repository {
  private readonly now: () => Date;

  constructor(
    readonly store: Store,
    opts: RepositoryOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Create the root commit on `branch` if the branch doesn't exist yet. */
  static async init(
    store: Store,
    init: { author: Author; branch?: string; message?: string },
    opts?: RepositoryOptions,
  ): Promise<Repository> {
    const repo = new Repository(store, opts);
    const branch = init.branch ?? 'main';
    validateBranchName(branch);
    if (!(await store.getRef(HEADS + branch))) {
      const tree = await store.putObject({ type: 'tree', entries: {} });
      const commit = await store.putObject({
        type: 'commit',
        tree,
        parents: [],
        author: init.author,
        message: init.message ?? 'Initialize workspace',
        timestamp: repo.now().toISOString(),
      });
      await store.setRef(HEADS + branch, commit, null);
    }
    return repo;
  }

  // ---------------------------------------------------------------- objects

  private async get<T extends LineageObject['type']>(hash: Hash, type: T): Promise<Extract<LineageObject, { type: T }>> {
    const obj = await this.store.getObject(hash);
    if (!obj || obj.type !== type) throw new ObjectNotFoundError(hash);
    return obj as Extract<LineageObject, { type: T }>;
  }

  readCommit(hash: Hash): Promise<CommitObject> {
    return this.get(hash, 'commit');
  }

  readTree(hash: Hash): Promise<TreeObject> {
    return this.get(hash, 'tree');
  }

  async readBlob(hash: Hash): Promise<Doc> {
    return (await this.get(hash, 'blob')).doc;
  }

  async writeDoc(doc: Doc): Promise<Hash> {
    const blob: BlobObject = { type: 'blob', doc };
    return this.store.putObject(blob);
  }

  // ---------------------------------------------------------------- refs

  /**
   * Resolve a revision to a commit hash. Accepts a branch name, a full commit hash, or either
   * followed by `~N` (N first-parent steps back).
   */
  async resolve(rev: string): Promise<Hash> {
    const m = /^(.*?)(?:~(\d+))?$/.exec(rev)!;
    const name = m[1]!;
    let steps = m[2] ? Number(m[2]) : 0;
    let hash: Hash | undefined;
    if (HASH_RE.test(name)) {
      if (!(await this.store.hasObject(name))) throw new RefNotFoundError(rev);
      hash = name;
    } else {
      hash = await this.store.getRef(HEADS + name);
    }
    if (!hash) throw new RefNotFoundError(rev);
    while (steps-- > 0) {
      const parent: Hash | undefined = (await this.readCommit(hash)).parents[0];
      if (!parent) throw new RefNotFoundError(rev);
      hash = parent;
    }
    return hash;
  }

  async branches(): Promise<Record<string, Hash>> {
    const refs = await this.store.listRefs(HEADS);
    return Object.fromEntries(Object.entries(refs).map(([k, v]) => [k.slice(HEADS.length), v]));
  }

  /** Fork a new line of work from any revision. */
  async createBranch(name: string, from: string): Promise<Hash> {
    validateBranchName(name);
    const hash = await this.resolve(from);
    if (await this.store.getRef(HEADS + name)) throw new RefExistsError(name);
    await this.store.setRef(HEADS + name, hash, null);
    return hash;
  }

  async deleteBranch(name: string): Promise<void> {
    const hash = await this.store.getRef(HEADS + name);
    if (!hash) throw new RefNotFoundError(name);
    await this.store.deleteRef(HEADS + name, hash);
  }

  // ---------------------------------------------------------------- reading

  async getTree(rev: string): Promise<Record<string, Hash>> {
    const commit = await this.readCommit(await this.resolve(rev));
    return (await this.readTree(commit.tree)).entries;
  }

  async readDoc(rev: string, path: string): Promise<Doc | undefined> {
    const hash = (await this.getTree(rev))[path];
    return hash ? this.readBlob(hash) : undefined;
  }

  // ---------------------------------------------------------------- writing

  async commit(input: CommitInput): Promise<Hash> {
    validateBranchName(input.branch);
    const ref = HEADS + input.branch;
    const head = await this.store.getRef(ref);
    if (!head) throw new RefNotFoundError(input.branch);
    const base = input.expectedHead ?? head;

    const entries = { ...(await this.readTree((await this.readCommit(base)).tree)).entries };
    const before = JSON.stringify(entries);
    for (const [path, doc] of Object.entries(input.changes)) {
      if (!path || path.startsWith('/') || path.split('/').includes('..')) {
        throw new LineageError(`Invalid path: ${JSON.stringify(path)}`);
      }
      if (doc === null) delete entries[path];
      else entries[path] = await this.writeDoc(doc);
    }
    if (!input.allowEmpty && JSON.stringify(entries) === before) throw new NothingToCommitError();

    const tree = await this.store.putObject({ type: 'tree', entries: sortKeys(entries) });
    const commit = await this.store.putObject({
      type: 'commit',
      tree,
      parents: [base],
      author: input.author,
      message: input.message,
      timestamp: this.now().toISOString(),
    });
    // Compare-and-swap: fails if someone else committed to this branch after `base`.
    await this.store.setRef(ref, commit, base);
    return commit;
  }

  // ---------------------------------------------------------------- history

  /** Commits reachable from `rev`, newest first. With `path`, only commits that changed that file. */
  async log(rev: string, opts: { limit?: number; path?: string; exclude?: string } = {}): Promise<LogEntry[]> {
    const start = await this.resolve(rev);
    const hidden = opts.exclude ? await this.ancestors(await this.resolve(opts.exclude)) : new Set<Hash>();
    const out: LogEntry[] = [];
    const seen = new Set<Hash>([start]);
    const frontier: LogEntry[] = [{ hash: start, commit: await this.readCommit(start) }];
    const limit = opts.limit ?? Infinity;

    while (frontier.length && out.length < limit) {
      // Pop the newest commit (date order, like `git log`).
      let best = 0;
      for (let i = 1; i < frontier.length; i++) {
        if (newer(frontier[i]!, frontier[best]!)) best = i;
      }
      const entry = frontier.splice(best, 1)[0]!;
      if (hidden.has(entry.hash)) continue;
      if (!opts.path || (await this.touches(entry.commit, opts.path))) out.push(entry);
      for (const p of entry.commit.parents) {
        if (!seen.has(p)) {
          seen.add(p);
          frontier.push({ hash: p, commit: await this.readCommit(p) });
        }
      }
    }
    return out;
  }

  /** Commits on `to` that aren't on `from`: "what changed since I last looked". */
  commitsBetween(from: string, to: string): Promise<LogEntry[]> {
    return this.log(to, { exclude: from });
  }

  private async touches(commit: CommitObject, path: string): Promise<boolean> {
    const mine = (await this.readTree(commit.tree)).entries[path];
    if (!commit.parents.length) return mine !== undefined;
    for (const p of commit.parents) {
      const theirs = (await this.readTree((await this.readCommit(p)).tree)).entries[path];
      if (theirs === mine) return false;
    }
    return true;
  }

  private async ancestors(hash: Hash): Promise<Set<Hash>> {
    const seen = new Set<Hash>([hash]);
    const stack = [hash];
    while (stack.length) {
      for (const p of (await this.readCommit(stack.pop()!)).parents) {
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    return seen;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (await this.ancestors(await this.resolve(descendant))).has(await this.resolve(ancestor));
  }

  /**
   * Best common ancestor of two revisions: a common ancestor that isn't an ancestor of another
   * common ancestor. With criss-cross histories there can be several; the newest is used.
   */
  async mergeBase(a: string, b: string): Promise<Hash | null> {
    const ha = await this.resolve(a);
    const hb = await this.resolve(b);
    const ofA = await this.ancestors(ha);

    const candidates: Hash[] = [];
    const seen = new Set<Hash>([hb]);
    const queue = [hb];
    while (queue.length) {
      const h = queue.shift()!;
      if (ofA.has(h)) {
        candidates.push(h);
        continue; // its ancestors are common too, but not "best"
      }
      for (const p of (await this.readCommit(h)).parents) {
        if (!seen.has(p)) {
          seen.add(p);
          queue.push(p);
        }
      }
    }
    if (!candidates.length) return null;

    const best: LogEntry[] = [];
    for (const c of candidates) {
      let dominated = false;
      for (const other of candidates) {
        if (other !== c && (await this.ancestors(other)).has(c)) {
          dominated = true;
          break;
        }
      }
      if (!dominated) best.push({ hash: c, commit: await this.readCommit(c) });
    }
    best.sort((x, y) => (newer(x, y) ? -1 : 1));
    return best[0]!.hash;
  }

  /** Every commit reachable from any branch, laid out as a transit map. */
  async graph(primary = 'main'): Promise<BranchGraph> {
    const branches = await this.branches();
    const commits = new Map<Hash, CommitObject>();
    const stack = Object.values(branches);
    while (stack.length) {
      const h = stack.pop()!;
      if (commits.has(h)) continue;
      const c = await this.readCommit(h);
      commits.set(h, c);
      stack.push(...c.parents);
    }
    return layoutGraph(commits, branches, primary);
  }

  // ---------------------------------------------------------------- diff

  /** Semantic diff of every changed file between two revisions. `from = null` diffs against an empty tree. */
  async diff(from: string | null, to: string, opts: { paths?: string[] } = {}): Promise<TreeDiff> {
    const fromHash = from === null ? null : await this.resolve(from);
    const toHash = await this.resolve(to);
    const oldEntries = fromHash ? (await this.readTree((await this.readCommit(fromHash)).tree)).entries : {};
    const newEntries = (await this.readTree((await this.readCommit(toHash)).tree)).entries;

    let changes = diffTreeEntries(oldEntries, newEntries);
    if (opts.paths) {
      const want = new Set(opts.paths);
      changes = changes.filter((c) => want.has(c.path) || (c.oldPath !== undefined && want.has(c.oldPath)));
    }
    const files: FileDiff[] = [];
    for (const c of changes) {
      const oldDoc = c.oldHash ? await this.readBlob(c.oldHash) : null;
      const newDoc = c.newHash ? await this.readBlob(c.newHash) : null;
      files.push({ ...c, diff: diffDocs(oldDoc, newDoc) });
    }
    return { from: fromHash, to: toHash, files };
  }

  // ---------------------------------------------------------------- merge

  /**
   * Work out what merging `from` into branch `into` would do, without moving any ref.
   * Auto-merged blobs are written (content-addressed, so harmless if the merge is abandoned).
   */
  async previewMerge(input: { into: string; from: string; message?: string }): Promise<MergePreview> {
    const ours = await this.resolve(input.into);
    const theirs = await this.resolve(input.from);
    const message = input.message ?? `Merge ${input.from} into ${input.into}`;

    if (await this.isAncestor(theirs, ours)) return { status: 'up-to-date', head: ours };
    const canFastForward = await this.isAncestor(ours, theirs);

    const base = await this.mergeBase(ours, theirs);
    const baseEntries = base ? (await this.readTree((await this.readCommit(base)).tree)).entries : {};
    const oursEntries = (await this.readTree((await this.readCommit(ours)).tree)).entries;
    const theirsEntries = (await this.readTree((await this.readCommit(theirs)).tree)).entries;

    const tree: Record<string, Hash> = {};
    const conflicts: Record<string, ConflictedFile> = {};
    const autoMerged: string[] = [];
    const paths = new Set([...Object.keys(baseEntries), ...Object.keys(oursEntries), ...Object.keys(theirsEntries)]);

    for (const path of [...paths].sort()) {
      const b = baseEntries[path];
      const o = oursEntries[path];
      const t = theirsEntries[path];
      // Cheap cases decided by hash alone, no content loaded.
      if (o === t) {
        if (o) tree[path] = o;
        continue;
      }
      if (o === b) {
        if (t) tree[path] = t;
        continue;
      }
      if (t === b) {
        if (o) tree[path] = o;
        continue;
      }
      const result = mergeDocs(
        b ? await this.readBlob(b) : null,
        o ? await this.readBlob(o) : null,
        t ? await this.readBlob(t) : null,
      );
      if (result.status === 'clean') {
        if (result.doc) tree[path] = await this.writeDoc(result.doc);
        autoMerged.push(path);
      } else {
        conflicts[path] = result;
      }
    }

    const draft: MergeDraft = { into: input.into, oursHead: ours, theirsHead: theirs, base, message, tree, conflicts, autoMerged };
    return { status: 'ready', draft, canFastForward };
  }

  /**
   * Merge `from` into branch `into`. Fast-forwards when possible; otherwise does a 3-way merge
   * per file. Clean merges are committed immediately. Conflicts return a {@link MergeDraft}
   * to resolve with {@link completeMerge}.
   */
  async merge(input: {
    into: string;
    from: string;
    author: Author;
    message?: string;
    noFastForward?: boolean;
  }): Promise<MergeOutcome> {
    const preview = await this.previewMerge(input);
    if (preview.status === 'up-to-date') return preview;
    const { draft } = preview;
    if (preview.canFastForward && !input.noFastForward) {
      await this.store.setRef(HEADS + input.into, draft.theirsHead, draft.oursHead);
      return { status: 'fast-forward', head: draft.theirsHead };
    }
    if (Object.keys(draft.conflicts).length) return { status: 'conflicts', draft };
    const head = await this.writeMergeCommit(draft, draft.tree, input.author);
    return { status: 'merged', head, autoMerged: draft.autoMerged };
  }

  /** Move `into` forward to `draft.theirsHead` (only valid when the preview said it can fast-forward). */
  async fastForward(draft: MergeDraft): Promise<Hash> {
    await this.store.setRef(HEADS + draft.into, draft.theirsHead, draft.oursHead);
    return draft.theirsHead;
  }

  /**
   * Finish a conflicted merge. `resolutions[path]` maps each conflict id in that file to a choice,
   * or `{ doc }` to supply the whole merged file (`null` deletes it).
   */
  async completeMerge(
    draft: MergeDraft,
    resolutions: Record<string, Record<string, ConflictChoice> | { doc: Doc | null }>,
    author: Author,
    message?: string,
  ): Promise<Hash> {
    const tree = { ...draft.tree };
    const unresolved: { path: string; conflictIds: string[] }[] = [];
    for (const [path, file] of Object.entries(draft.conflicts)) {
      const r = resolutions[path];
      if (!r) {
        unresolved.push({ path, conflictIds: conflictIds(file) });
        continue;
      }
      let doc: Doc | null;
      if ('doc' in r && (r.doc === null || isDoc(r.doc))) {
        doc = r.doc;
      } else {
        const applied = applyResolution(file, r as Record<string, ConflictChoice>);
        if (applied.missing.length) {
          unresolved.push({ path, conflictIds: applied.missing });
          continue;
        }
        doc = applied.doc;
      }
      if (doc) tree[path] = await this.writeDoc(doc);
      else delete tree[path];
    }
    if (unresolved.length) throw new UnresolvedConflictsError(unresolved);
    return this.writeMergeCommit(message ? { ...draft, message } : draft, tree, author);
  }

  private async writeMergeCommit(draft: MergeDraft, entries: Record<string, Hash>, author: Author): Promise<Hash> {
    const tree = await this.store.putObject({ type: 'tree', entries: sortKeys(entries) });
    const commit = await this.store.putObject({
      type: 'commit',
      tree,
      parents: [draft.oursHead, draft.theirsHead],
      author,
      message: draft.message,
      timestamp: this.now().toISOString(),
    });
    // If the target branch moved while conflicts were being resolved, refuse rather than drop that work.
    await this.store.setRef(HEADS + draft.into, commit, draft.oursHead);
    return commit;
  }
}

function newer(x: LogEntry, y: LogEntry): boolean {
  if (x.commit.timestamp !== y.commit.timestamp) return x.commit.timestamp > y.commit.timestamp;
  return x.hash > y.hash;
}

function sortKeys(entries: Record<string, Hash>): Record<string, Hash> {
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function conflictIds(file: ConflictedFile): string[] {
  return file.regions.flatMap((r) => (r.type === 'conflict' ? [r.id] : []));
}

function isDoc(v: unknown): v is Doc {
  return typeof v === 'object' && v !== null && 'units' in v && Array.isArray((v as Doc).units);
}
