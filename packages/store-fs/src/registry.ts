import { randomBytes } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Repository, type Author, type Hash, type RepositoryOptions } from '@lineage/core';
import { FileStore, withLock, writeAtomic } from './file-store.js';

export interface WorkspaceMeta {
  slug: string;
  name: string;
  description?: string;
  createdAt: string;
  createdBy: Author;
  /** userId → branch → commit the user last caught up to. Powers "what changed since I last looked". */
  lastSeen: Record<string, Record<string, Hash>>;
}

export interface Workspace {
  meta: WorkspaceMeta;
  store: FileStore;
  repo: Repository;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'workspace'
  );
}

/**
 * Workspaces under one root directory, each a folder with its own FileStore:
 *
 * ```
 * <root>/<slug>/meta.json
 * <root>/<slug>/refs.json
 * <root>/<slug>/objects/…
 * <root>/<slug>/staging/<id>.json   (uploads waiting to be committed)
 * ```
 */
export class WorkspaceRegistry {
  constructor(
    readonly root: string,
    private readonly repoOptions: RepositoryOptions = {},
  ) {}

  private dir(slug: string): string {
    if (!SLUG_RE.test(slug)) throw new Error(`Invalid workspace: ${slug}`);
    return join(this.root, slug);
  }

  async list(): Promise<WorkspaceMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return [];
    }
    const metas: WorkspaceMeta[] = [];
    for (const e of entries) {
      if (!SLUG_RE.test(e)) continue;
      const meta = await this.readMeta(e);
      if (meta) metas.push(meta);
    }
    return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async readMeta(slug: string): Promise<WorkspaceMeta | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir(slug), 'meta.json'), 'utf8')) as WorkspaceMeta;
    } catch {
      return undefined;
    }
  }

  async create(input: { name: string; description?: string; author: Author; slug?: string }): Promise<Workspace> {
    const base = input.slug ?? slugify(input.name);
    const taken = new Set((await this.list()).map((m) => m.slug));
    let slug = base;
    for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;

    const meta: WorkspaceMeta = {
      slug,
      name: input.name.trim() || slug,
      createdAt: new Date().toISOString(),
      createdBy: input.author,
      lastSeen: {},
    };
    if (input.description) meta.description = input.description;
    await writeAtomic(join(this.dir(slug), 'meta.json'), JSON.stringify(meta, null, 2));
    const store = new FileStore(this.dir(slug));
    const repo = await Repository.init(store, { author: input.author }, this.repoOptions);
    return { meta, store, repo };
  }

  async get(slug: string): Promise<Workspace | undefined> {
    if (!SLUG_RE.test(slug)) return undefined;
    const meta = await this.readMeta(slug);
    if (!meta) return undefined;
    const store = new FileStore(this.dir(slug));
    return { meta, store, repo: new Repository(store, this.repoOptions) };
  }

  async remove(slug: string): Promise<void> {
    await rm(this.dir(slug), { recursive: true, force: true });
  }

  /** Update meta under a lock (read-modify-write). */
  async updateMeta(slug: string, fn: (meta: WorkspaceMeta) => void): Promise<WorkspaceMeta> {
    const path = join(this.dir(slug), 'meta.json');
    return withLock(path, async () => {
      const meta = await this.readMeta(slug);
      if (!meta) throw new Error(`Workspace not found: ${slug}`);
      fn(meta);
      await writeAtomic(path, JSON.stringify(meta, null, 2));
      return meta;
    });
  }

  async markSeen(slug: string, userId: string, branch: string, hash: Hash): Promise<void> {
    await this.updateMeta(slug, (m) => {
      (m.lastSeen[userId] ??= {})[branch] = hash;
    });
  }

  // ------------------------------------------------------------ staging

  async stage<T>(slug: string, data: T): Promise<string> {
    const id = randomBytes(8).toString('hex');
    await writeAtomic(join(this.dir(slug), 'staging', `${id}.json`), JSON.stringify(data));
    return id;
  }

  async readStage<T>(slug: string, id: string): Promise<T | undefined> {
    if (!/^[0-9a-f]{16}$/.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(join(this.dir(slug), 'staging', `${id}.json`), 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  async dropStage(slug: string, id: string): Promise<void> {
    if (!/^[0-9a-f]{16}$/.test(id)) return;
    await rm(join(this.dir(slug), 'staging', `${id}.json`), { force: true });
  }
}
