import { Server, type Document } from '@hocuspocus/server';
import { parseProse, renderDoc, type Repository } from '@lineage/core';
import {
  DRAFT_META,
  DRAFT_TEXT,
  draftPresenceUser,
  parseRoom,
  textPatch,
  workspaceRoom,
  type PresenceUser,
  type RefChange,
  type Room,
  type ServerMessage,
} from '@lineage/realtime';
import { verifyToken } from '@lineage/realtime/token';
import { WorkspaceRegistry } from '@lineage/store-fs';
import * as Y from 'yjs';
import { DraftFiles } from './drafts.js';
import { RefsWatcher } from './refs-watcher.js';

export interface CollabOptions {
  /** Same data directory the web app uses. */
  dataDir: string;
  /** Shared with the web app, which signs connection tokens. */
  secret: string;
  port?: number;
  address?: string;
  quiet?: boolean;
  /** Safety-net poll interval for branch changes, ms. */
  pollMs?: number;
  /** How long edits wait before being written to disk, ms. */
  debounce?: number;
}

export interface ConnectionContext {
  user: PresenceUser;
  room: Room;
}

type DraftRoom = Extract<Room, { type: 'draft' }>;

/** Text a new file starts with. */
export function newFileTemplate(path: string): string {
  const name = path.split('/').pop()!.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  const title = name ? name[0]!.toUpperCase() + name.slice(1) : 'Untitled';
  return `# ${title}\n\nWrite here.`;
}

/** The text a commit would store for this draft text, so formatting-only differences don't count as edits. */
const normalize = (text: string) => renderDoc(parseProse(text));

async function textAt(repo: Repository, rev: string, path: string): Promise<string | null> {
  try {
    const doc = await repo.readDoc(rev, path);
    if (!doc) return null;
    if (doc.kind !== 'prose') throw new NotEditableError(path);
    return renderDoc(doc);
  } catch (e) {
    if (e instanceof NotEditableError) throw e;
    return null;
  }
}

class NotEditableError extends Error {
  constructor(path: string) {
    super(`${path} is not a prose document; edit it where it came from and import it again.`);
  }
}

/**
 * The collaboration server. Two kinds of rooms:
 *
 * - `ws:<slug>`: presence (who is where) and branch updates for a workspace.
 * - `draft:<slug>:<branch>:<path>`: a shared working copy of one prose file. Seeded from the
 *   branch head, kept on disk while it holds uncommitted text, and fast-forwarded when the
 *   branch moves and the draft has no edits of its own.
 *
 * Commits stay in the web app: this server only ever reads the repository.
 */
export function createCollabServer(opts: CollabOptions) {
  const registry = new WorkspaceRegistry(opts.dataDir);
  const drafts = new DraftFiles(opts.dataDir);
  /** Draft room → serialized reconcile runs, so two branch moves can't interleave. */
  const queues = new Map<string, Promise<void>>();

  /** Runs `fn` after earlier work on the same room. The returned promise rejects if `fn` does. */
  const enqueue = (name: string, fn: () => Promise<void>): Promise<void> => {
    const run = (queues.get(name) ?? Promise.resolve()).then(fn);
    queues.set(
      name,
      run.catch((e) => {
        if (!opts.quiet) console.error(`[collab] ${name}:`, e);
      }),
    );
    return run;
  };

  const repoFor = async (slug: string) => {
    const ws = await registry.get(slug);
    if (!ws) throw new Error(`Workspace not found: ${slug}`);
    return ws.repo;
  };

  /**
   * Bring a draft in line with its branch. Seeds an empty draft; when the branch moved, adopts
   * the new head if the draft had no edits of its own, and otherwise just records the new head
   * so editors see that committing will merge.
   */
  async function reconcile(document: Y.Doc, room: DraftRoom): Promise<void> {
    const repo = await repoFor(room.slug);
    const meta = document.getMap<unknown>(DRAFT_META);
    const text = document.getText(DRAFT_TEXT);
    const head = (await repo.branches())[room.branch];

    if (!head) {
      if (meta.get('gone') !== true) document.transact(() => meta.set('gone', true));
      return;
    }

    const base = meta.get('base') as string | undefined;
    if (!base) {
      const seeded = await textAt(repo, head, room.path);
      document.transact(() => {
        if (text.length) text.delete(0, text.length);
        text.insert(0, seeded ?? newFileTemplate(room.path));
        meta.set('base', head);
        meta.set('head', head);
        meta.set('isNew', seeded === null);
        meta.set('gone', false);
      });
      return;
    }

    if (base === head && meta.get('head') === head && meta.get('gone') !== true) return;

    const current = text.toString();
    const headText = await textAt(repo, head, room.path);
    if (headText !== null && normalize(current) === headText) {
      // Already says what the branch says (typically: we just committed it).
      document.transact(() => {
        meta.set('base', head);
        meta.set('head', head);
        meta.set('isNew', false);
        meta.set('gone', false);
      });
      return;
    }

    const baseText = (await textAt(repo, base, room.path)) ?? newFileTemplate(room.path);
    const clean = normalize(current) === normalize(baseText);
    document.transact(() => {
      if (clean && headText !== null) {
        const p = textPatch(current, headText);
        if (p) {
          if (p.remove) text.delete(p.index, p.remove);
          if (p.insert) text.insert(p.index, p.insert);
        }
        meta.set('base', head);
        meta.set('isNew', false);
      }
      meta.set('head', head);
      meta.set('gone', false);
    });
  }

  /** Whether a draft says exactly what its branch says, so there's nothing worth keeping on disk. */
  async function isClean(document: Y.Doc, room: DraftRoom): Promise<boolean> {
    const meta = document.getMap<unknown>(DRAFT_META);
    const base = meta.get('base') as string | undefined;
    if (!base || meta.get('isNew') || meta.get('head') !== base) return false;
    const repo = await repoFor(room.slug);
    const committed = await textAt(repo, base, room.path);
    return committed !== null && normalize(document.getText(DRAFT_TEXT).toString()) === committed;
  }

  function onRefs(slug: string, changes: RefChange[]) {
    const docs = server.hocuspocus.documents;
    const message: ServerMessage = { type: 'refs', changes };
    docs.get(workspaceRoom(slug))?.broadcastStateless(JSON.stringify(message));
    const moved = new Set(changes.map((c) => c.branch));
    for (const [name, doc] of docs) {
      const room = parseRoom(name);
      if (room?.type === 'draft' && room.slug === slug && moved.has(room.branch)) {
        enqueue(name, () => reconcile(doc, room)).catch(() => undefined);
      }
    }
  }

  const watcher = new RefsWatcher(opts.dataDir, registry, onRefs, opts.pollMs);

  const server = new Server<ConnectionContext>({
    name: 'lineage-collab',
    port: opts.port ?? 1234,
    ...(opts.address ? { address: opts.address } : {}),
    quiet: opts.quiet ?? false,
    stopOnSignals: false,
    debounce: opts.debounce ?? 800,
    maxDebounce: 5000,

    async onRequest({ request, response }) {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true, documents: server.hocuspocus.getDocumentsCount() }));
        // An empty rejection stops the default response.
        throw null;
      }
    },

    async onAuthenticate({ token, documentName }) {
      const room = parseRoom(documentName);
      if (!room) throw new Error('Unknown room');
      const claims = verifyToken(token, opts.secret);
      if (!claims || claims.ws !== room.slug) throw new Error('Not allowed in this workspace');
      if (!(await registry.get(room.slug))) throw new Error('Workspace not found');
      return { user: claims.user, room } satisfies ConnectionContext;
    },

    async onLoadDocument({ document, documentName }) {
      const room = parseRoom(documentName);
      if (!room) throw new Error('Unknown room');
      await watcher.acquire(room.slug);
      if (room.type !== 'draft') return;
      try {
        const stored = await drafts.read(room.slug, room.branch, room.path);
        if (stored) Y.applyUpdate(document, stored);
        await enqueue(documentName, () => reconcile(document, room));
      } catch (e) {
        // A failed load is never unloaded, so give the watcher back here.
        watcher.release(room.slug);
        queues.delete(documentName);
        throw e;
      }
    },

    async onStoreDocument({ document, documentName }) {
      const room = parseRoom(documentName);
      if (room?.type !== 'draft') return;
      await enqueue(documentName, async () => {
        if (await isClean(document, room)) await drafts.remove(room.slug, room.branch, room.path);
        else await drafts.write(room.slug, room.branch, room.path, Y.encodeStateAsUpdate(document));
      });
    },

    async afterUnloadDocument({ documentName }) {
      const room = parseRoom(documentName);
      if (!room) return;
      watcher.release(room.slug);
      queues.delete(documentName);
    },

    // Presence carries the identity from the signed token, whatever the client claims.
    async beforeHandleAwareness({ context, states }) {
      if (!context?.user) return;
      for (const state of states.values()) {
        if (state && typeof state === 'object') {
          state['user'] = context.room.type === 'draft' ? draftPresenceUser(context.user) : context.user;
        }
      }
    },
  });

  return {
    server,
    watcher,
    async listen(): Promise<number> {
      await server.listen();
      return server.address.port;
    },
    async close(): Promise<void> {
      watcher.close();
      await server.destroy();
    },
  };
}

export type CollabServer = ReturnType<typeof createCollabServer>;
export type { Document };
