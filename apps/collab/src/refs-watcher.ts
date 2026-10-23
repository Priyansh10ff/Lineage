import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { RefChange } from '@lineage/realtime';
import type { WorkspaceRegistry } from '@lineage/store-fs';

type Listener = (slug: string, changes: RefChange[]) => void;

interface Entry {
  users: number;
  last: Record<string, string>;
  watcher?: FSWatcher;
  poll: NodeJS.Timeout;
  debounce?: NodeJS.Timeout;
  checking: Promise<void>;
}

/**
 * Notices when a workspace's branches move, whoever moved them (the web app commits, merges and
 * imports in its own process). Watches `refs.json` and polls as a safety net, since file
 * watching is best-effort on some filesystems.
 *
 * With a hosted database this becomes a LISTEN/NOTIFY or change-feed subscription; the
 * listener contract stays the same.
 */
export class RefsWatcher {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly root: string,
    private readonly registry: WorkspaceRegistry,
    private readonly listener: Listener,
    private readonly pollMs = 2000,
  ) {}

  async acquire(slug: string): Promise<void> {
    const existing = this.entries.get(slug);
    if (existing) {
      existing.users++;
      return;
    }
    const entry: Entry = {
      users: 1,
      last: await this.read(slug),
      poll: setInterval(() => this.schedule(slug, 0), this.pollMs),
      checking: Promise.resolve(),
    };
    entry.poll.unref();
    this.entries.set(slug, entry);
    try {
      entry.watcher = watch(join(this.root, slug), (_event, file) => {
        if (!file || file.toString() === 'refs.json') this.schedule(slug, 25);
      });
      entry.watcher.on('error', () => entry.watcher?.close());
    } catch {
      // Polling still covers it.
    }
  }

  release(slug: string): void {
    const entry = this.entries.get(slug);
    if (!entry || --entry.users > 0) return;
    clearInterval(entry.poll);
    clearTimeout(entry.debounce);
    entry.watcher?.close();
    this.entries.delete(slug);
  }

  /** Check now (tests, and callers that know something changed). */
  async check(slug: string): Promise<void> {
    const entry = this.entries.get(slug);
    if (!entry) return;
    entry.checking = entry.checking.then(() => this.diff(slug, entry)).catch(() => undefined);
    await entry.checking;
  }

  close(): void {
    for (const slug of [...this.entries.keys()]) {
      const e = this.entries.get(slug)!;
      e.users = 1;
      this.release(slug);
    }
  }

  private schedule(slug: string, delay: number): void {
    const entry = this.entries.get(slug);
    if (!entry) return;
    clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => void this.check(slug), delay);
  }

  private async read(slug: string): Promise<Record<string, string>> {
    const ws = await this.registry.get(slug);
    return ws ? ws.repo.branches() : {};
  }

  private async diff(slug: string, entry: Entry): Promise<void> {
    const next = await this.read(slug);
    const prev = entry.last;
    const changes: RefChange[] = [];
    for (const branch of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      const from = prev[branch] ?? null;
      const to = next[branch] ?? null;
      if (from !== to) changes.push({ branch, from, to });
    }
    entry.last = next;
    if (!changes.length || !this.entries.has(slug)) return;
    const ws = await this.registry.get(slug);
    if (ws) {
      for (const c of changes) {
        if (!c.to) continue;
        try {
          const commit = await ws.repo.readCommit(c.to);
          c.message = commit.message;
          c.author = commit.author.name;
        } catch {
          // A ref pointing at a missing commit is reported without details.
        }
      }
    }
    this.listener(slug, changes);
  }
}
