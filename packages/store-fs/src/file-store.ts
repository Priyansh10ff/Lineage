import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RefConflictError, hashObject, type Hash, type LineageObject, type Store } from '@lineage/core';

const HASH_RE = /^[0-9a-f]{64}$/;

/** Write a file atomically: write a temp file next to it, then rename over the target. */
export async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Serializes async critical sections per key (one Node process). */
const queues = new Map<string, Promise<unknown>>();
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * A Lineage store on the local filesystem.
 *
 * - Objects: `objects/ab/cdef….json`, sharded by the first two hex chars, written once.
 * - Refs: one `refs.json`, updated read-modify-write under a per-directory lock with an
 *   atomic rename, so compare-and-swap holds within a process.
 *
 * Meant for local use and development. Several processes writing the same directory at once
 * are not coordinated; the Postgres store is the multi-user option.
 */
export class FileStore implements Store {
  constructor(readonly dir: string) {}

  private objectPath(hash: Hash): string {
    if (!HASH_RE.test(hash)) throw new Error(`Invalid object hash: ${hash}`);
    return join(this.dir, 'objects', hash.slice(0, 2), `${hash.slice(2)}.json`);
  }

  private get refsPath(): string {
    return join(this.dir, 'refs.json');
  }

  async getObject(hash: Hash): Promise<LineageObject | undefined> {
    if (!HASH_RE.test(hash)) return undefined;
    try {
      return JSON.parse(await readFile(this.objectPath(hash), 'utf8')) as LineageObject;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  async putObject(obj: LineageObject): Promise<Hash> {
    const hash = hashObject(obj);
    const path = this.objectPath(hash);
    if (!(await exists(path))) await writeAtomic(path, JSON.stringify(obj));
    return hash;
  }

  async hasObject(hash: Hash): Promise<boolean> {
    return HASH_RE.test(hash) && exists(this.objectPath(hash));
  }

  private async readRefs(): Promise<Record<string, Hash>> {
    try {
      return JSON.parse(await readFile(this.refsPath, 'utf8')) as Record<string, Hash>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
  }

  async getRef(name: string): Promise<Hash | undefined> {
    return (await this.readRefs())[name];
  }

  setRef(name: string, hash: Hash, expected?: Hash | null): Promise<void> {
    return withLock(this.refsPath, async () => {
      const refs = await this.readRefs();
      if (expected !== undefined) {
        const actual = refs[name] ?? null;
        if (actual !== expected) throw new RefConflictError(name, expected, actual);
      }
      refs[name] = hash;
      await writeAtomic(this.refsPath, JSON.stringify(sortObject(refs), null, 2));
    });
  }

  deleteRef(name: string, expected?: Hash): Promise<void> {
    return withLock(this.refsPath, async () => {
      const refs = await this.readRefs();
      if (expected !== undefined) {
        const actual = refs[name] ?? null;
        if (actual !== expected) throw new RefConflictError(name, expected, actual);
      }
      delete refs[name];
      await writeAtomic(this.refsPath, JSON.stringify(sortObject(refs), null, 2));
    });
  }

  async listRefs(prefix = ''): Promise<Record<string, Hash>> {
    const refs = await this.readRefs();
    return sortObject(Object.fromEntries(Object.entries(refs).filter(([k]) => k.startsWith(prefix))));
  }

  /** Number of stored objects (walks the directory; for tests and stats). */
  async objectCount(): Promise<number> {
    let n = 0;
    try {
      for (const shard of await readdir(join(this.dir, 'objects'))) {
        n += (await readdir(join(this.dir, 'objects', shard))).filter((f) => f.endsWith('.json')).length;
      }
    } catch {
      return 0;
    }
    return n;
  }
}

function sortObject<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
