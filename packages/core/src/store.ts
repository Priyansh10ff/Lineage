import { RefConflictError } from './errors.js';
import { hashObject } from './hash.js';
import type { Hash, LineageObject } from './types.js';

/**
 * Immutable content-addressed object storage. Writing the same object twice is a no-op,
 * which is what makes unchanged files free across commits.
 */
export interface ObjectStore {
  getObject(hash: Hash): Promise<LineageObject | undefined>;
  putObject(obj: LineageObject): Promise<Hash>;
  hasObject(hash: Hash): Promise<boolean>;
}

/** Mutable named pointers to commits. Updates are compare-and-swap so concurrent commits can't clobber each other. */
export interface RefStore {
  getRef(name: string): Promise<Hash | undefined>;
  /**
   * Set `name` to `hash` only if it currently equals `expected`
   * (`null` = must not exist, `undefined` = unconditional). Throws {@link RefConflictError} otherwise.
   */
  setRef(name: string, hash: Hash, expected?: Hash | null): Promise<void>;
  deleteRef(name: string, expected?: Hash): Promise<void>;
  listRefs(prefix?: string): Promise<Record<string, Hash>>;
}

export type Store = ObjectStore & RefStore;

/** In-memory store for tests, the CLI and client-side previews. Postgres implements the same interfaces. */
export class MemoryStore implements Store {
  private readonly objects = new Map<Hash, string>();
  private readonly refs = new Map<string, Hash>();

  async getObject(hash: Hash): Promise<LineageObject | undefined> {
    const raw = this.objects.get(hash);
    // Stored serialized so callers can't mutate stored objects through a shared reference.
    return raw === undefined ? undefined : (JSON.parse(raw) as LineageObject);
  }

  async putObject(obj: LineageObject): Promise<Hash> {
    const hash = hashObject(obj);
    if (!this.objects.has(hash)) this.objects.set(hash, JSON.stringify(obj));
    return hash;
  }

  async hasObject(hash: Hash): Promise<boolean> {
    return this.objects.has(hash);
  }

  async getRef(name: string): Promise<Hash | undefined> {
    return this.refs.get(name);
  }

  async setRef(name: string, hash: Hash, expected?: Hash | null): Promise<void> {
    if (expected !== undefined) {
      const actual = this.refs.get(name) ?? null;
      if (actual !== expected) throw new RefConflictError(name, expected, actual);
    }
    this.refs.set(name, hash);
  }

  async deleteRef(name: string, expected?: Hash): Promise<void> {
    if (expected !== undefined) {
      const actual = this.refs.get(name) ?? null;
      if (actual !== expected) throw new RefConflictError(name, expected, actual);
    }
    this.refs.delete(name);
  }

  async listRefs(prefix = ''): Promise<Record<string, Hash>> {
    const out: Record<string, Hash> = {};
    for (const [k, v] of [...this.refs].sort(([a], [b]) => a.localeCompare(b))) {
      if (k.startsWith(prefix)) out[k] = v;
    }
    return out;
  }

  get objectCount(): number {
    return this.objects.size;
  }
}
